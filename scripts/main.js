/**
 * @file main.js
 * @description The core entry point for the module. This file sets up all hooks,
 * libWrapper patches, and event listeners that orchestrate the module's features,
 * including silence injection, crossfading, internal looping, and playlist looping.
 */
import { registerPlaylistSheetWrappers } from "./playlist-config.js";
import { Silence } from "./silence.js";
import { scheduleCrossfade, cancelCrossfade, performCrossfade } from "./cross-fade.js";
import { applyFadeIn } from "./fade-in.js";
import { registerSoundConfigWrappers } from "./sound-config.js";
import {
  scheduleLoopWithin,
  cancelLoopWithin,
  breakLoopWithin,
  executeLoopBreak,
  pauseLoopWithin,
  resumeLoopWithin,
  nextSegmentWithin,
  previousSegmentWithin,
  executeSegmentSkip,
  disableAllLoopsWithin,
  executeLoopDisable,
} from "./internal-loop.js";
import { maybeLoopPlaylist } from "./playlist-loop.js";
import {
  advancedFade,
  scheduleEndOfTrackFade,
  cancelActiveFade,
  fadeOutAndStop,
  equalPowerCrossfade,
} from "./audio-fader.js";
import {
  debug,
  info,
  MODULE_ID,
  waitForMedia,
  cleanupPlaylistState,
  PlaylistActionAuthority,
  getNextSequence,
  shouldProcessAction,
  findPlaylistSoundForSound,
  logFeature,
  LogSymbols,
  safeStop,
  ensureAudioContext,
} from "./utils.js";
import { Flags } from "./flag-service.js";
import { PlaybackClock } from "./playback-clock.js";
import { State } from "./state-manager.js";
import { API } from "./api.js";
import { AdvancedShuffle, SHUFFLE_PATTERNS } from "./advanced-shuffle.js";
import { registerCurrentlyPlaying } from "./currently-playing.js";
import { Integrations } from "./integrations.js";
import {
  startSoundscape,
  stopSoundscape,
} from "./procedural-ambience.js";

const AudioTimeout = foundry.audio.AudioTimeout;
const PLAYBACK_RECOVERY_IN_FLIGHT = new Set();
const PLAYBACK_RECOVERY_SEEN = new Map();
let playbackRecoveryWatchdog = null;

// =========================================================================
// Constants & State
// =========================================================================

export async function cancelSilentGap(playlist) {
  // Delegate to the centralized cleanup utility, specifically targeting only the silence feature.
  return cleanupPlaylistState(playlist, {
    cleanSilence: true,
    cleanCrossfade: false, // Don't touch crossfades
    cleanLoopers: false, // Don't touch loopers
  });
}

// =========================================================================
// Helpers
// =========================================================================

function isFreshPlaybackStart(playlistSound) {
  return !Number(playlistSound?.pausedTime);
}

function _describeActivePlaylists() {
  try {
    return game.playlists
      .filter((playlist) => playlist.playing)
      .map((playlist) => {
        const mode = Flags.getPlaybackMode(playlist).effective;
        const sounds = playlist.sounds
          .filter((sound) => sound.playing && !Flags.getSoundFlag(sound, "isSilenceGap"))
          .map((sound) => {
            const media = sound.sound;
            const audioState = media
              ? `audio=${media.playing ? "on" : "off"} vol=${Number(media.volume ?? 0).toFixed(3)} gain=${Number(media.gain?.value ?? 0).toFixed(3)}`
              : "audio=none";
            return `${sound.name} (${audioState})`;
          });
        return `${playlist.name} [${mode}: ${sounds.join(", ") || "no sounds"}]`;
      })
      .join(" | ") || "none";
  } catch (err) {
    return `unavailable (${err?.message ?? err})`;
  }
}

function _describeSoundAudio(soundDoc) {
  const media = soundDoc?.sound;
  if (!media) return { audio: "none" };
  return {
    audio: media.playing ? "on" : "off",
    loaded: !!media.loaded,
    volume: Number(media.volume ?? 0),
    gain: Number(media.gain?.value ?? 0),
    currentTime: Number(media.currentTime ?? 0),
    duration: Number(media.duration ?? 0),
    fading: State.isSoundFading(media),
  };
}

function _isSequentialOrShuffle(playlist) {
  return [
    CONST.PLAYLIST_MODES.SEQUENTIAL,
    CONST.PLAYLIST_MODES.SHUFFLE,
  ].includes(playlist?.mode);
}

function _getRecoverablePlayingSound(playlist) {
  if (!playlist?.playing || !_isSequentialOrShuffle(playlist)) return null;
  if (Flags.getPlaybackMode(playlist).soundscape) return null;
  return playlist.sounds.find((sound) =>
    sound.playing &&
    !sound.repeat &&
    !Flags.getSoundFlag(sound, "isSilenceGap")
  ) ?? null;
}

function _getNextSoundInPlaybackOrder(playlist, sourceSound) {
  const order = playlist?.playbackOrder ?? [];
  const idx = order.indexOf(sourceSound?.id);
  if (idx < 0) return null;
  return playlist.sounds.get(order[idx + 1]) ?? null;
}

function _markClockRecovered(playlist, clock) {
  if (!playlist?.id || !Number.isFinite(Number(clock?.clockSeq))) return;
  PLAYBACK_RECOVERY_SEEN.set(playlist.id, Number(clock.clockSeq));
}

function _wasClockRecovered(playlist, clock) {
  if (!playlist?.id || !Number.isFinite(Number(clock?.clockSeq))) return false;
  return PLAYBACK_RECOVERY_SEEN.get(playlist.id) === Number(clock.clockSeq);
}

async function _advanceAfterTrack(playlist, sourceSound, reason = "clock recovery") {
  const pendingFade = State.getEndOfTrackFade(sourceSound);
  if (pendingFade) {
    pendingFade.cancel?.();
    State.clearEndOfTrackFade(sourceSound);
  }

  const next = _getNextSoundInPlaybackOrder(playlist, sourceSound);
  debug(`[ClockRecovery] Advancing "${playlist.name}" after "${sourceSound.name}" (${reason}).`);
  if (next) {
    await playlist.playSound(next);
  } else if (!maybeLoopPlaylist(playlist)) {
    await playlist.stopAll();
  }
}

async function _bootstrapPlaybackClock(playlist, activeSound, reason) {
  if (!activeSound) {
    debug(`[ClockRecovery] No active sound available to bootstrap "${playlist.name}".`);
    return false;
  }

  const clock = await PlaybackClock.record(playlist, activeSound, activeSound.sound, {
    reason,
    force: true,
  });
  return !!clock;
}

function _queuePlaybackClockRecord(soundDoc, reason = "document playing", { force = false } = {}) {
  const playlist = soundDoc?.parent;
  if (!PlaylistActionAuthority.isAuthorizedGM()) return;
  if (!playlist?.isOwner || !soundDoc?.playing) return;
  if (!_isSequentialOrShuffle(playlist)) return;
  if (Flags.getPlaybackMode(playlist).soundscape) return;
  if (Flags.getSoundFlag(soundDoc, "isSilenceGap")) return;
  if (soundDoc.repeat) return;

  const attempt = async (label) => {
    if (!soundDoc.playing || PlaybackClock.get(playlist)?.soundId === soundDoc.id) return;

    const recorded = await PlaybackClock.record(playlist, soundDoc, soundDoc.sound, {
      reason: `${reason}:${label}`,
      force,
    });
    if (recorded) return;

    const media = await waitForMedia(soundDoc);
    await PlaybackClock.record(playlist, soundDoc, media, {
      reason: `${reason}:${label}:media`,
      force,
    });
  };

  globalThis.setTimeout?.(() => {
    attempt("settled").catch((err) =>
      debug(`[Clock] Failed document clock record for "${soundDoc.name}":`, err?.message ?? err)
    );
  }, 0);

  globalThis.setTimeout?.(() => {
    attempt("late").catch((err) =>
      debug(`[Clock] Failed late document clock record for "${soundDoc.name}":`, err?.message ?? err)
    );
  }, 300);
}

async function _recoverOverdueSilenceGap(playlist, reason) {
  const state = State.getSilenceState(playlist);
  if (!state || state.cancelled || state.completed) return false;

  const expectedEndAt = Number(state.expectedEndAt);
  if (!Number.isFinite(expectedEndAt) || Date.now() <= expectedEndAt + PlaybackClock.RECOVERY_GRACE_MS) {
    return false;
  }

  debug(`[ClockRecovery] Completing overdue silent gap in "${playlist.name}" (${reason}).`);
  return Silence.completeGap(playlist, state, { reason: `clock:${reason}` });
}

async function _recoverOverduePlaylist(playlist, reason = "watchdog") {
  if (!PlaylistActionAuthority.isAuthorizedGM()) return false;
  if (!playlist?.isOwner || !playlist.playing) return false;
  if (!_isSequentialOrShuffle(playlist)) return false;
  if (Flags.getPlaybackMode(playlist).soundscape) return false;

  const key = playlist.id;
  if (PLAYBACK_RECOVERY_IN_FLIGHT.has(key)) return false;

  PLAYBACK_RECOVERY_IN_FLIGHT.add(key);
  try {
    if (await _recoverOverdueSilenceGap(playlist, reason)) return true;

    const activeSound = _getRecoverablePlayingSound(playlist);
    if (!activeSound) return false;

    if (State.hasActiveLooper(activeSound)) {
      debug(`[ClockRecovery] Skipping "${activeSound.name}" - internal loop is active.`);
      return false;
    }

    let clock = PlaybackClock.get(playlist);
    if (!clock || clock.soundId !== activeSound.id) {
      await _bootstrapPlaybackClock(playlist, activeSound, `bootstrap:${reason}`);
      return false;
    }

    if (_wasClockRecovered(playlist, clock)) return false;
    if (!PlaybackClock.isOverdue(playlist, clock)) return false;

    const mode = Flags.getPlaybackMode(playlist);
    _markClockRecovered(playlist, clock);

    if (mode.crossfade) {
      if (State.isPlaylistCrossfading(playlist)) {
        debug(`[ClockRecovery] "${playlist.name}" is already crossfading; skipping overdue recovery.`);
        return false;
      }
      debug(`[ClockRecovery] Triggering overdue crossfade for "${activeSound.name}" in "${playlist.name}".`);
      await performCrossfade(playlist, activeSound, { recovery: true, reason });
      return true;
    }

    if (mode.silence) {
      debug(`[ClockRecovery] Starting overdue silent gap after "${activeSound.name}" in "${playlist.name}".`);
      const pendingFade = State.getEndOfTrackFade(activeSound);
      if (pendingFade) {
        pendingFade.cancel?.();
        State.clearEndOfTrackFade(activeSound);
      }
      Silence.playSilence(playlist, activeSound);
      return true;
    }

    await _advanceAfterTrack(playlist, activeSound, reason);
    return true;
  } catch (err) {
    debug(`[ClockRecovery] Failed recovery for "${playlist?.name}":`, err?.message ?? err);
    return false;
  } finally {
    PLAYBACK_RECOVERY_IN_FLIGHT.delete(key);
  }
}

function _runPlaybackRecoveryWatchdog(reason = "watchdog") {
  if (!PlaylistActionAuthority.isAuthorizedGM()) return;
  for (const playlist of game.playlists ?? []) {
    _recoverOverduePlaylist(playlist, reason);
  }
}

function _startPlaybackRecoveryWatchdog() {
  if (playbackRecoveryWatchdog || !globalThis.setInterval) return;
  playbackRecoveryWatchdog = globalThis.setInterval(
    () => _runPlaybackRecoveryWatchdog("interval"),
    PlaybackClock.WATCHDOG_INTERVAL_MS
  );
  globalThis.addEventListener?.("beforeunload", () => {
    if (playbackRecoveryWatchdog) globalThis.clearInterval(playbackRecoveryWatchdog);
    playbackRecoveryWatchdog = null;
  }, { once: true });
}

function _debugPlaybackTrace(message, playlist = null, extra = {}) {
  const playlistPart = playlist ? ` playlist="${playlist.name}"` : "";
  debug(`[PlaybackTrace] ${message}${playlistPart}`, {
    active: _describeActivePlaylists(),
    ...extra,
  });
}

function _cssAttrSelector(attribute, value) {
  const text = String(value ?? "");
  const escaped = globalThis.CSS?.escape
    ? CSS.escape(text)
    : text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[${attribute}="${escaped}"]`;
}

function _soundVolumeInputValue(soundDoc) {
  const volume = Number(soundDoc?.volume);
  if (!Number.isFinite(volume)) return null;
  const converted = foundry.audio.AudioHelper.volumeToInput(volume);
  return Number.isFinite(converted) ? converted : volume;
}

function _personalTrackVolumeInputValue(soundDoc) {
  const value = Number(Flags.getPersonalTrackVolumeInput(soundDoc));
  return Number.isFinite(value) ? value : null;
}

function _setRangePickerValue(rangePicker, value) {
  if (!rangePicker || !Number.isFinite(value)) return false;

  let changed = false;
  if (Number(rangePicker.value) !== value) {
    rangePicker.value = value;
    changed = true;
  }
  if (rangePicker.getAttribute?.("value") !== String(value)) {
    rangePicker.setAttribute?.("value", String(value));
    changed = true;
  }

  for (const input of rangePicker.querySelectorAll?.('input[type="range"], input[type="number"]') ?? []) {
    if (Number(input.value) === value) continue;
    input.value = String(value);
    changed = true;
  }

  return changed;
}

function _syncSoundVolumeControls(soundDoc, reason = "volume update") {
  const value = _soundVolumeInputValue(soundDoc);
  if (!Number.isFinite(value)) return;

  const selectors = [
    `.sound${_cssAttrSelector("data-sound-id", soundDoc.id)}`,
    `.sound${_cssAttrSelector("data-document-id", soundDoc.id)}`,
    `.sound${_cssAttrSelector("data-entry-id", soundDoc.id)}`,
  ];

  let updated = 0;
  const rows = document.querySelectorAll(selectors.join(","));
  for (const row of rows) {
    for (const control of row.querySelectorAll("range-picker.sound-volume, input.sound-volume")) {
      if (_setRangePickerValue(control, value)) updated += 1;
    }
  }

  if (updated) {
    debug(`[Volume] Synced ${updated} visible volume control(s) for "${soundDoc.name}" (${reason}).`);
  }
}

function _syncPersonalTrackVolumeControls(soundDoc, reason = "volume update", { force = false } = {}) {
  if (!Flags.isPersonalAudioMixEnabled()) return;
  if (!force && Flags.hasPersonalTrackVolume(soundDoc)) return;

  const value = _personalTrackVolumeInputValue(soundDoc);
  if (!Number.isFinite(value)) return;

  const selectors = [
    `.sound${_cssAttrSelector("data-sound-id", soundDoc.id)}`,
    `.sound${_cssAttrSelector("data-document-id", soundDoc.id)}`,
    `.sound${_cssAttrSelector("data-entry-id", soundDoc.id)}`,
  ];

  let updated = 0;
  const rows = document.querySelectorAll(selectors.join(","));
  for (const row of rows) {
    for (const control of row.querySelectorAll(".sos-personal-track-volume-slider")) {
      if (_setRangePickerValue(control, value)) updated += 1;
    }
  }

  if (updated) {
    debug(`[Volume] Synced ${updated} personal track control(s) for "${soundDoc.name}" (${reason}).`);
  }
}

function _syncPersonalTrackVolumeControlsForPlaylist(playlist, reason = "playlist volume update") {
  if (!playlist?.sounds) return;
  for (const soundDoc of playlist.sounds) {
    _syncPersonalTrackVolumeControls(soundDoc, reason);
  }
}

function _syncEmbeddedSoundVolumeControls(playlist, changes, reason = "embedded volume update") {
  if (!Array.isArray(changes?.sounds)) return;

  for (const soundChange of changes.sounds) {
    if (!Object.prototype.hasOwnProperty.call(soundChange ?? {}, "volume")) continue;
    const soundDoc = playlist?.sounds?.get(soundChange._id);
    if (soundDoc) {
      _syncSoundVolumeControls(soundDoc, reason);
      _syncPersonalTrackVolumeControls(soundDoc, reason);
    }
  }

  _applyPersonalAudioMixToActiveSounds(playlist);
}

function _syncPlaylistVolumeControls(playlist, reason = "playlist volume update") {
  const value = Number(Flags.getPlaylistFlag(playlist, "normalizedVolume"));
  if (!Number.isFinite(value)) return;

  const playlistSelector = _cssAttrSelector("data-playlist-id", playlist.id);
  const selectors = [
    `.sos-playlist-volume-slider${playlistSelector}`,
    `.sos-playlist-volume-col${playlistSelector} .sos-playlist-volume-slider`,
  ];

  let updated = 0;
  for (const control of document.querySelectorAll(selectors.join(","))) {
    if (_setRangePickerValue(control, value)) updated += 1;
  }

  if (updated) {
    debug(`[Volume] Synced ${updated} visible playlist volume control(s) for "${playlist.name}" (${reason}).`);
  }
}

function _applyPersonalAudioMixToActiveSound(ps, options = {}) {
  const sound = ps?.sound;
  if (!sound?.playing) return;
  if (State.isSoundFading(sound)) return;
  sound.volume = Flags.resolveTargetVolume(ps, options);
}

function _applyPersonalAudioMixToActiveSounds(playlist, options = {}) {
  if (!playlist) return;

  for (const ps of playlist.sounds ?? []) {
    _applyPersonalAudioMixToActiveSound(ps, options);
  }

  const engine = State.getSoundscapeEngine(playlist);
  if (engine?.applyPersonalAudioMix) engine.applyPersonalAudioMix(options);
  else engine?.applyPersonalPlaylistVolume?.(options);
}

function _applyPersonalPlaylistVolumeToActiveSounds(playlist) {
  _applyPersonalAudioMixToActiveSounds(playlist);
}

function _applyPersonalPlaylistVolumesToActiveSounds() {
  for (const playlist of game.playlists ?? []) {
    _applyPersonalAudioMixToActiveSounds(playlist);
  }
}

function _getActiveSoundscapeSounds(playlist) {
  if (!playlist?.sounds) return [];
  return playlist.sounds.filter(
    (sound) => sound.playing && !Flags.getSoundFlag(sound, "isSilenceGap")
  );
}

function _shouldRunSoundscapeEngine(playlist) {
  if (!playlist || !Flags.getPlaybackMode(playlist).soundscape) return false;
  return !!playlist.playing || _getActiveSoundscapeSounds(playlist).length > 0;
}

async function _reconcileSoundscapeEngine(playlist, reason = "unknown") {
  if (!playlist) return;

  const engine = State.getSoundscapeEngine(playlist);
  const shouldRun = _shouldRunSoundscapeEngine(playlist);

  if (shouldRun) {
    if (!engine || engine.isDestroyed) {
      debug(`[Soundscape] Reconcile starting engine for "${playlist.name}" (${reason}).`);
      const startedEngine = await startSoundscape(playlist);
      startedEngine?.syncProceduralSounds?.();
      return;
    }

    engine.syncProceduralSounds?.();
    return;
  }

  if (engine && !engine.isDestroyed) {
    debug(`[Soundscape] Reconcile stopping engine for "${playlist.name}" (${reason}).`);
    stopSoundscape(playlist, { stopBeds: false });
  }
}

function _scheduleSoundscapeReconcile(playlist, reason = "unknown") {
  const run = () => {
    _reconcileSoundscapeEngine(playlist, reason).catch((err) =>
      debug(`[Soundscape] Reconcile failed for "${playlist?.name ?? "unknown"}":`, err?.message)
    );
  };

  // Embedded PlaylistSound updates can settle just after updatePlaylist fires.
  // Deferring one task gives every client the same repaired local engine state.
  if (globalThis.setTimeout) {
    setTimeout(run, 0);
  } else {
    globalThis.queueMicrotask?.(run);
  }
}

// =========================================================================
// Foundry Hooks
// =========================================================================

Hooks.once("init", () => {
  info("Initializing...");

  // Detect conflicting playlist modules (informational — SoS still activates)
  Integrations.detect();

  game.settings.register(MODULE_ID, "debug", {
    name: "Enable Debug Logging",
    hint: "Log silence timing and playlist actions to the console.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "personalPlaylistVolumeEnabled", {
    name: "Use Personal Audio Mix",
    hint: "For players, replace shared volume controls with client-local Track and Playlist Volume controls.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      _applyPersonalPlaylistVolumesToActiveSounds();
      ui.playlists?.render({ parts: ["playing"] });
    },
  });

  game.settings.register(MODULE_ID, "personalPlaylistVolumes", {
    name: "Personal Playlist Volumes",
    hint: "Client-local per-playlist Sound of Silence volume slider values.",
    scope: "client",
    config: false,
    type: Object,
    default: {},
    onChange: () => _applyPersonalPlaylistVolumesToActiveSounds(),
  });

  game.settings.register(MODULE_ID, "personalTrackVolumes", {
    name: "Personal Track Volumes",
    hint: "Client-local per-track Sound of Silence volume slider values.",
    scope: "client",
    config: false,
    type: Object,
    default: {},
    onChange: () => _applyPersonalPlaylistVolumesToActiveSounds(),
  });

  game.settings.register(MODULE_ID, "shufflePattern", {
    name: "Advanced Shuffle Pattern",
    hint: "Choose how shuffle mode works. Exhaustive ensures all tracks play once before repeating. Weighted Random favors tracks that haven't played recently. Round-Robin ensures even distribution across all tracks over time.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      [SHUFFLE_PATTERNS.FOUNDRY_DEFAULT]:
        "Foundry Default (Random with possible repeats)",
      [SHUFFLE_PATTERNS.EXHAUSTIVE]:
        "Exhaustive (No repeats until all tracks played)",
      [SHUFFLE_PATTERNS.WEIGHTED_RANDOM]:
        "Weighted Random (Favor less-recently-played tracks)",
      [SHUFFLE_PATTERNS.ROUND_ROBIN]:
        "Round-Robin (Strictly even distribution)",
    },
    default: SHUFFLE_PATTERNS.FOUNDRY_DEFAULT,
    onChange: () => {
      // Clear all shuffle states when pattern changes globally
      game.playlists.forEach((playlist) => {
        if (playlist.mode === CONST.PLAYLIST_MODES.SHUFFLE) {
          AdvancedShuffle.reset(playlist);
          debug(
            `[Shuffle] Reset state for "${playlist.name}" due to pattern change`
          );
        }
      });
      ui.notifications.info(
        "Advanced Shuffle pattern changed. All shuffle playlists have been reset."
      );
    },
  });

  game.settings.register(MODULE_ID, "fadeInCurveType", {
    name: "Fade-In Curve Type",
    hint: "Controls the volume curve shape for fade-ins. Logarithmic (default) sounds perceptually linear. Linear is a straight volume ramp. S-Curve eases in and out smoothly. Steep front-loads the volume change for a more dramatic effect.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "logarithmic": "Logarithmic (Default)",
      "linear": "Linear",
      "s-curve": "S-Curve (Smooth ease in/out)",
      "steep": "Steep (Fast attack)",
    },
    default: "logarithmic",
  });

  game.settings.register(MODULE_ID, "fadeOutCurveType", {
    name: "Fade-Out Curve Type",
    hint: "Controls the volume curve shape for fade-outs. Logarithmic (default) sounds perceptually linear. Linear is a straight volume ramp. S-Curve eases in and out smoothly. Steep front-loads the volume change for a more dramatic effect.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "logarithmic": "Logarithmic (Default)",
      "linear": "Linear",
      "s-curve": "S-Curve (Smooth ease in/out)",
      "steep": "Steep (Fast attack)",
    },
    default: "logarithmic",
  });
});

Hooks.once("ready", () => {
  if (!game.modules.get("lib-wrapper")?.active) {
    ui.notifications.error(`${MODULE_ID} requires the libWrapper module.`);
    return;
  }

  // Initialize and expose the public API
  API._initialize();
  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = API;
  }

  // Register socket listener for remote diagnostics
  game.socket.on(`module.${MODULE_ID}`, (data) => API._handleSocketMessage(data));

  // Register audio guards before UI setup (protects our fade curves
  // from being destroyed by other playlist modules calling Sound.fade())
  Integrations.registerAudioGuards();

  registerPlaylistSheetWrappers();
  registerSoundConfigWrappers();
  registerCurrentlyPlaying();
  _startPlaybackRecoveryWatchdog();

  Hooks.on("updatePlaylist", (playlist, changes, options, userId) => {
    const soundUpdates = Array.isArray(changes?.sounds)
      ? changes.sounds.map((sound) => ({
          id: sound._id,
          playing: sound.playing,
          pausedTime: sound.pausedTime,
        }))
      : undefined;
    const relevant =
      Object.prototype.hasOwnProperty.call(changes ?? {}, "playing") ||
      Object.prototype.hasOwnProperty.call(changes ?? {}, "mode") ||
      Object.prototype.hasOwnProperty.call(changes ?? {}, "sounds") ||
      foundry.utils.hasProperty(changes ?? {}, `flags.${MODULE_ID}.normalizedVolume`) ||
      foundry.utils.hasProperty(changes ?? {}, `flags.${MODULE_ID}.soundscapeMode`) ||
      foundry.utils.hasProperty(changes ?? {}, `flags.${MODULE_ID}.${PlaybackClock.FLAG_KEY}`);
    if (!relevant) return;

    _debugPlaybackTrace("updatePlaylist", playlist, {
      user: game.users.get(userId)?.name ?? userId,
      playing: changes.playing,
      mode: changes.mode,
      soundscapeFlag: foundry.utils.getProperty(changes, `flags.${MODULE_ID}.soundscapeMode`),
      sounds: soundUpdates,
      options,
    });
    _syncEmbeddedSoundVolumeControls(playlist, changes, "playlist embedded volume update");
    if (foundry.utils.hasProperty(changes ?? {}, `flags.${MODULE_ID}.normalizedVolume`)) {
      _syncPlaylistVolumeControls(playlist, "playlist document volume update");
      _syncPersonalTrackVolumeControlsForPlaylist(playlist, "playlist document volume update");
      _applyPersonalAudioMixToActiveSounds(playlist);
    }
    if (foundry.utils.hasProperty(changes ?? {}, `flags.${MODULE_ID}.${PlaybackClock.FLAG_KEY}`)) {
      ui.playlists?.render({ parts: ["playing"] });
    }
    if (Array.isArray(changes?.sounds) && game.user?.isGM && playlist.isOwner) {
      for (const soundChange of changes.sounds) {
        if (soundChange?.playing !== true) continue;
        const soundDoc = playlist.sounds.get(soundChange._id);
        _queuePlaybackClockRecord(soundDoc, "playlist update");
      }
    }
    if (changes.playing === false && game.user?.isGM && playlist.isOwner) {
      PlaybackClock.clear(playlist, "playlist stopped").catch((err) =>
        debug(`[Clock] Failed to clear stopped playlist clock:`, err?.message ?? err)
      );
    }
  });

  Hooks.on("updatePlaylistSound", (soundDoc, changes, options, userId) => {
    if (!Object.prototype.hasOwnProperty.call(changes ?? {}, "playing")) return;
    _debugPlaybackTrace("updatePlaylistSound", soundDoc.parent, {
      sound: soundDoc.name,
      user: game.users.get(userId)?.name ?? userId,
      playing: changes.playing,
      pausedTime: changes.pausedTime,
      audio: _describeSoundAudio(soundDoc),
      options,
    });
    if (
      game.user?.isGM &&
      soundDoc.parent?.isOwner &&
      changes.playing === false &&
      PlaybackClock.get(soundDoc.parent)?.soundId === soundDoc.id
    ) {
      PlaybackClock.clear(soundDoc.parent, "sound stopped").catch((err) =>
        debug(`[Clock] Failed to clear stopped sound clock:`, err?.message ?? err)
      );
    }
    if (changes.playing === true) {
      _queuePlaybackClockRecord(soundDoc, "sound update");
    }
  });

  Hooks.on("updatePlaylistSound", (soundDoc, changes) => {
    if (!Object.prototype.hasOwnProperty.call(changes ?? {}, "volume")) return;
    _syncSoundVolumeControls(soundDoc, "document volume update");
    _syncPersonalTrackVolumeControls(soundDoc, "document volume update");
    _applyPersonalAudioMixToActiveSounds(soundDoc.parent);
  });

  // If a client joins or reloads while a soundscape playlist is already live,
  // bootstrap the local engine from the replicated playlist state.
  for (const playlist of game.playlists) {
    if (!_shouldRunSoundscapeEngine(playlist)) continue;
    _scheduleSoundscapeReconcile(playlist, "ready bootstrap");
  }

  // --- Visibility Recovery (Safety Net) ---
  // When the browser tab regains focus, validate and recover module state.
  // Browser throttling can cause setTimeout-based cleanup to be delayed or missed.
  // This listener catches any stale state left behind.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return; // Only act when tab comes BACK to focus

    debug("[Visibility] Tab regained focus. Validating module state...");

    // Resume any AudioContexts that the browser suspended while backgrounded
    ensureAudioContext();
    _runPlaybackRecoveryWatchdog("visibility");

    for (const playlist of game.playlists) {
      if (!playlist.playing) continue;

      // 1. Clear stale crossfade locks
      if (State.isPlaylistCrossfading(playlist) && !State.getCrossfadeTimer(playlist)) {
        debug(`[Visibility] Clearing stale crossfading flag for "${playlist.name}"`);
        State.clearPlaylistCrossfading(playlist);
      }

      // 2. Clear stale fading sound locks
      for (const ps of playlist.sounds) {
        if (ps.sound && State.isSoundFading(ps.sound)) {
          const gain = ps.sound.gain?.value;
          if (gain !== undefined && (gain < 0.01 || gain > 0.95)) {
            debug(`[Visibility] Clearing stale fading lock for "${ps.name}" (gain=${gain.toFixed(3)})`);
            State.clearFadingSound(ps.sound);
          }
        }
      }

      // 3. Re-validate crossfade scheduling for playing playlists
      const mode = Flags.getPlaybackMode(playlist);
      if (mode.crossfade && !State.getCrossfadeTimer(playlist)) {
        const currentlyPlaying = playlist.sounds.find(s => s.playing && !Flags.getSoundFlag(s, "isSilenceGap"));
        if (currentlyPlaying) {
          debug(`[Visibility] Re-arming crossfade timer for "${currentlyPlaying.name}"`);
          scheduleCrossfade(playlist, currentlyPlaying);
        }
      }

      // 4. Verify and correct volumes on normalized playlists.
      //    If a song started while the tab was hidden, its volume may not have
      //    been set correctly due to browser throttling or async race conditions.
      const normEnabled = Flags.getPlaylistFlag(playlist, "volumeNormalizationEnabled");
      if (normEnabled) {
        for (const ps of playlist.sounds) {
          if (!ps.playing || !ps.sound) continue;
          if (Flags.getSoundFlag(ps, "isSilenceGap")) continue;
          if (Flags.getSoundFlag(ps, "allowVolumeOverride")) continue;

          const expectedVolume = Flags.resolveTargetVolume(ps);
          const currentGain = ps.sound.gain?.value;
          if (currentGain !== undefined && Math.abs(currentGain - expectedVolume) > 0.01 && !State.isSoundFading(ps.sound)) {
            debug(`[Visibility] Volume correction for "${ps.name}": gain=${currentGain.toFixed(3)} -> expected=${expectedVolume.toFixed(3)}`);
            ps.sound.volume = expectedVolume;
          }
        }
      }
    }
  });

  // This hook reacts to flag changes caused by UI interactions or other clients.
  Hooks.on("updatePlaylistSound", (soundDoc, changes) => {
    const moduleFlags = changes?.flags?.[MODULE_ID];
    if (!moduleFlags) return;

    // --- Handle loopWithin sub-flags ---
    const loopFlags = moduleFlags.loopWithin;
    if (loopFlags) {
      // Handle loop activation/deactivation from the toggle button
      if (loopFlags.hasOwnProperty("active")) {
        const isActive = loopFlags.active;
        if (isActive) {
          scheduleLoopWithin(soundDoc);
        } else {
          cancelLoopWithin(soundDoc);
        }
      }

      // Handle enabling/disabling the feature entirely from the config
      if (loopFlags.hasOwnProperty("enabled")) {
        ui.playlists?.render();
        if (!loopFlags.enabled) {
          cancelLoopWithin(soundDoc);
        }
      }
    }

    // --- Handle segment skip replication ---
    if (moduleFlags.segmentSkip) {
      const segmentSkip = soundDoc.getFlag(MODULE_ID, "segmentSkip") ?? {};
      const { targetIndex, seq } = segmentSkip;

      // Validate the data
      if (typeof targetIndex !== 'number' || !Number.isFinite(seq)) return;

      // Deduplicate using sequence tracking
      if (!shouldProcessAction(soundDoc.id, seq, "snd")) {
        debug(`[Segment-Sync] Ignoring duplicate segment skip (seq ${seq}) for "${soundDoc.name}"`);
        return;
      }

      debug(`[Segment-Sync] Executing segment skip to index ${targetIndex} for "${soundDoc.name}"`);
      executeSegmentSkip(soundDoc, targetIndex);
    }

    // --- Handle loop break replication ---
    if (moduleFlags.loopBreak) {
      const loopBreak = soundDoc.getFlag(MODULE_ID, "loopBreak") ?? {};
      const { seq } = loopBreak;

      if (!Number.isFinite(seq)) return;

      // Deduplicate using sequence tracking
      if (!shouldProcessAction(soundDoc.id, seq, "snd")) {
        debug(`[LoopBreak-Sync] Ignoring duplicate loop break (seq ${seq}) for "${soundDoc.name}"`);
        return;
      }

      debug(`[LoopBreak-Sync] Executing loop break for "${soundDoc.name}"`);
      executeLoopBreak(soundDoc);
    }

    // --- Handle loop disable replication ---
    if (moduleFlags.loopDisable) {
      const loopDisable = soundDoc.getFlag(MODULE_ID, "loopDisable") ?? {};
      const { seq } = loopDisable;

      if (!Number.isFinite(seq)) return;

      // Deduplicate using sequence tracking
      if (!shouldProcessAction(soundDoc.id, seq, "snd")) {
        debug(`[LoopDisable-Sync] Ignoring duplicate loop disable (seq ${seq}) for "${soundDoc.name}"`);
        return;
      }

      debug(`[LoopDisable-Sync] Executing loop disable for "${soundDoc.name}"`);
      executeLoopDisable(soundDoc);
    }
  });

  // Foundry pauses playlist sounds by storing pausedTime and stopping the
  // underlying Sound, which cancels Sound.schedule() callbacks. Clear our
  // matching handle so resume can arm a fresh crossfade timer.
  Hooks.on("updatePlaylistSound", (soundDoc, changes) => {
    if (!Object.prototype.hasOwnProperty.call(changes, "playing")) return;
    if (changes.playing !== false) return;
    if (!Number.isFinite(soundDoc.pausedTime)) return;

    const playlist = soundDoc.parent;
    if (!playlist || !Flags.getPlaybackMode(playlist).crossfade) return;

    const timer = State.getCrossfadeTimer(playlist);
    if (!timer) return;

    debug(`[CF] Cancelling crossfade timer for paused sound "${soundDoc.name}".`);
    cancelCrossfade(playlist);
  });

  // Arm or disarm a procedural sound's timer when its `playing` state flips.
  // Runs on every client so local RNG timers stay aligned with document state.
  Hooks.on("updatePlaylistSound", (soundDoc, changes) => {
    if (!Object.prototype.hasOwnProperty.call(changes, "playing")) return;

    const playlist = soundDoc.parent;
    if (!playlist || !Flags.getPlaybackMode(playlist).soundscape) return;
    _scheduleSoundscapeReconcile(
      playlist,
      `sound update: ${soundDoc.name} playing=${Boolean(changes.playing)}`
    );
  });

  // Auto-stop a Soundscape playlist when its last playing sound goes idle.
  // Individual stops accumulate until no sound is left, then the playlist
  // itself flips to stopped — which tears down the engine via the existing
  // updatePlaylist hook. GM-only so only one client writes.
  Hooks.on("updatePlaylistSound", async (soundDoc, changes) => {
    if (!game.user.isGM) return;
    if (!Object.prototype.hasOwnProperty.call(changes, "playing")) return;
    if (changes.playing) return;

    const playlist = soundDoc.parent;
    if (!playlist || !Flags.getPlaybackMode(playlist).soundscape) return;
    if (!playlist.playing) return;
    if (State.isPlaylistStopping(playlist)) return;

    const stillPlaying = playlist.sounds.some(
      (s) => s.playing && !Flags.getSoundFlag(s, "isSilenceGap")
    );
    if (stillPlaying) return;

    debug(`[Soundscape] Last sound stopped in "${playlist.name}"; stopping playlist.`);
    await playlist.update({ playing: false });
  });

  // 1. Create a new helper function
  async function handleTrackCompletion(playlistSound) {
    const playlist = playlistSound.parent;
    // The track has ended. Its scheduled end-of-track fade is now irrelevant.
    const pendingFade = State.getEndOfTrackFade(playlistSound);
    if (pendingFade) {
      pendingFade.cancel();
      State.clearEndOfTrackFade(playlistSound);
    }
    const mode = Flags.getPlaybackMode(playlist);

    // If crossfade is active, the crossfade scheduler is responsible. Do nothing here.
    if (mode.crossfade) {
      return;
    }

    // If silence is enabled, inject the gap.
    // Crucially, we do NOT await this. We fire-and-forget.
    // The advancement to the next track will be handled when the gap itself ends.
    if (mode.silence) {
      debug(
        `Injecting silent gap after "${playlistSound.name}" in "${playlist.name}".`
      );
      Silence.playSilence(playlist, playlistSound);
    }
  }

  libWrapper.register(
    MODULE_ID,
    "PlaylistSound.prototype._onEnd",
    function (wrapped, ...args) {
      const playlist = this.parent;

      // A silent gap's 100ms audio file has finished. We must stop all further
      // execution to let the real timer in silence.js take control.
      if (Flags.getSoundFlag(this, "isSilenceGap")) {
        return;
      }

      // Bail out if an automatic crossfade is already managing this transition.
      if (State.isPlaylistCrossfading(playlist)) {
        debug(`_onEnd: Bailing because an automatic crossfade is in progress.`);
        return;
      }

      // Handle playlist looping for "Simultaneous" mode.
      if (
        playlist.mode === CONST.PLAYLIST_MODES.SIMULTANEOUS &&
        Flags.getPlaylistFlag(playlist, "loopPlaylist")
      ) {
        debug(
          `[LP] 🔁 Restarting "${this.name}" inside simultaneous playlist "${playlist.name}"`
        );
        const endResult = wrapped(...args);
        if (game.user.isGM) playlist.playSound(this);
        return endResult;
      }

      const mode = Flags.getPlaybackMode(playlist);

      // If neither of our features are active for this playlist,
      // just run the original Foundry function and we're done.
      if (!mode.crossfade && !mode.silence) {
        return wrapped(...args);
      }

      // Otherwise, one of our features IS active. Let our dedicated helper
      // function handle all the complex logic. Do NOT call wrapped().
      handleTrackCompletion(this);
    },
    "MIXED"
  );

  // In sequential and shuffle modes, escalate a per-track stop to a full playlist stop for consistency.
  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.stopSound",
    function (wrapped, sound, ...args) {
      const playlist = this;
      _debugPlaybackTrace("stopSound called", playlist, {
        sound: sound?.name,
        mode: Flags.getPlaybackMode(playlist).effective,
        args,
      });

      if (!sound) {
        return wrapped.call(this, sound, ...args);
      }

      const isSeqOrShuffle = [
        CONST.PLAYLIST_MODES.SEQUENTIAL,
        CONST.PLAYLIST_MODES.SHUFFLE,
      ].includes(playlist.mode);
      if (isSeqOrShuffle && playlist.playing) {
        logFeature(
          LogSymbols.STOP,
          "Stop",
          `Track → Playlist: ${sound.name}. Escalating to stop the entire playlist.`
        );
        playlist.stopAll();
        return;
      }

      return wrapped.call(this, sound, ...args);
    },
    "MIXED"
  );

  // Override stopAll to provide a more robust implementation that handles all module features gracefully.
  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.stopAll",
    async function () {
      _debugPlaybackTrace("stopAll called", this, {
        mode: Flags.getPlaybackMode(this).effective,
      });
      logFeature(LogSymbols.STOP, "Stop", `Playlist: ${this.name}`);
      State.markPlaylistAsStopping(this);
      await PlaybackClock.clear(this, "stopAll");
      const fadeDuration = Number(this.fade) || 0;

      // --- Step 1: Identify all sounds that need to be stopped ---
      // This includes sounds currently marked as playing AND the sound that may have triggered a now-active silent gap.
      const playingSounds = this.sounds.filter(
        (s) => s.playing && !Flags.getSoundFlag(s, "isSilenceGap")
      );
      const silenceState = State.getSilenceState(this);
      const sourceSound = silenceState?.sourceSound;

      // Use a Set to gather unique sounds to stop.
      const soundsToStopSet = new Set(playingSounds);
      if (sourceSound) {
        soundsToStopSet.add(sourceSound);
      }
      const soundsToStop = Array.from(soundsToStopSet);
      const soundIdsToStop = soundsToStop.map((s) => s.id);

      // --- Step 2: Clean up all active module features (timers, gaps, loops) ---
      // This is critical to prevent timers from firing after we've issued the stop command.
      await cleanupPlaylistState(this, {
        cleanSilence: true,
        cleanCrossfade: true,
        cleanLoopers: true,
        allowFadeOut: fadeDuration > 0,
      });

      // --- Step 3: Update the database to reflect the new "stopped" state ---
      // We do this before the audio fades so the UI is immediately responsive.
      const updates = soundIdsToStop.map((id) => ({
        _id: id,
        playing: false,
        pausedTime: null,
      }));
      if (updates.length > 0) {
        await this.updateEmbeddedDocuments("PlaylistSound", updates, {
          noHook: true,
        });
      }
      if (this.playing) {
        await this.update({ playing: false }, { noHook: true });
      }

      // --- Step 4: Replicate the action to all clients ---
      // This ensures other players' audio also fades out correctly. Only one GM should do this.
      if (PlaylistActionAuthority.isAuthorizedGM()) {
        try {
          await this.setFlag(MODULE_ID, "stopTransition", {
            soundIds: soundIdsToStop,
            fadeMs: fadeDuration,
            seq: getNextSequence(this.id),
            ts: Date.now(),
            gmId: game.user.id,
          });
        } catch (err) {
          debug("[Stop] Failed to set replication flag", err);
        }
      }

      // --- Step 5: Perform the client-side audio fade-out ---
      // This uses our superior exponential fader for a smoother effect.
      for (const sound of soundsToStop) {
        if (!sound.sound) continue;

        // Cancel any scheduled end-of-track fades to prevent them from interfering.
        const pendingFade = State.getEndOfTrackFade(sound);
        if (pendingFade) {
          pendingFade.cancel();
          State.clearEndOfTrackFade(sound);
        }

        if (fadeDuration > 0) {
          fadeOutAndStop(sound.sound, fadeDuration);
        } else {
          safeStop(sound.sound, "playlist stopAll");
        }
      }

      // Finally, re-render the UI now that all state changes are complete.
      ui.playlists.render();
    },
    "OVERRIDE"
  );

  // Wrap playSound to handle manual track skips with crossfading.
  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.playSound",
    async function (wrapped, soundToPlay, ...args) {
      const playlist = this;
      _debugPlaybackTrace("playSound called", playlist, {
        sound: soundToPlay?.name,
        mode: Flags.getPlaybackMode(playlist).effective,
        args,
      });

      // If our automatic crossfader is running, do not treat this as a manual skip.
      if (State.isPlaylistCrossfading(playlist)) {
        return await wrapped.call(playlist, soundToPlay, ...args);
      }

      // Soundscape mode: bed tracks are routed directly to Foundry. Skip the
      // crossfade-on-skip path entirely — procedural ambience has its own
      // layering model and doesn't participate in track-to-track transitions.
      // The engine itself is started by the updatePlaylist hook when the
      // playlist's `playing` flag flips true, and individual procedural arm/
      // disarm is handled by the updatePlaylistSound hook.
      if (Flags.getPlaybackMode(playlist).soundscape) {
        return await wrapped.call(playlist, soundToPlay, ...args);
      }

      const useCrossfade = Flags.getPlaybackMode(playlist).crossfade;
      const fadeMs = Flags.getCrossfadeDuration(playlist);
      const isSequentialOrShuffle = [
        CONST.PLAYLIST_MODES.SEQUENTIAL,
        CONST.PLAYLIST_MODES.SHUFFLE,
      ].includes(playlist.mode);

      // If crossfade is on and another track is playing, this is a manual skip.
      // We must initiate a crossfade from the old track to the new one.
      if (useCrossfade && fadeMs > 0 && isSequentialOrShuffle) {
        const currentlyPlaying = playlist.sounds.find(
          (s) => s.playing && s.id !== soundToPlay.id
        );
        if (currentlyPlaying?.sound) {
          debug(
            `[CF-Skip] Detected skip from "${currentlyPlaying.name}" to "${soundToPlay.name}".`
          );
          cancelActiveFade(currentlyPlaying.sound);
          advancedFade(currentlyPlaying.sound, {
            targetVol: 0,
            duration: fadeMs,
          });
          cancelCrossfade(playlist); // Cancel the pending automatic crossfade for the old track.
        }
      }

      // Only cancel the gap if the incoming sound is NOT a gap itself.
      if (
        State.hasSilenceState(playlist) &&
        !soundToPlay.getFlag(MODULE_ID, "isSilenceGap")
      ) {
        await cancelSilentGap(playlist);
      }

      return await wrapped.call(playlist, soundToPlay, ...args);
    },
    "WRAPPER"
  );



  // This hook listens for the 'skipTransition' flag to mirror GM "Next" actions on all clients.
  // NOTE: We no longer need _lastSkipSeen - using sequence system instead

  // Use the centralized sequence system instead of timestamp deduplication
  Hooks.on("updatePlaylist", async (pl, changes) => {
    if (!changes?.flags?.[MODULE_ID]?.skipTransition) return;
    const next = pl.getFlag(MODULE_ID, "skipTransition");
    if (!next) return;

    const { fromSoundId, fadeMs, seq, ts, gmId } = next;
    if (!fromSoundId || !Number.isFinite(fadeMs) || !Number.isFinite(seq))
      return;

    // Already using shouldProcessAction which has cleanup built-in
    if (!shouldProcessAction(pl.id, seq)) {
      debug(`[Skip-Sync] Ignoring duplicate or out-of-order skip (seq ${seq})`);
      return;
    }

    if (gmId === game.user.id) {
      debug(`[Skip-Sync] Skipping self-triggered action`);
      return;
    }

    debug(`[Skip-Sync] Processing skip from GM ${gmId}, seq ${seq}`);

    for (const s of pl.sounds) {
      cancelLoopWithin(s, { restorePlaybackHandlers: false });
    }

    const ps = pl.sounds.get(fromSoundId);
    if (!ps) return;
    const media = await waitForMedia(ps);
    if (!media) return;

    try {
      cancelActiveFade(media);
    } catch (_) { }
    advancedFade(media, { targetVol: 0, duration: Number(fadeMs) || 0 });
  });

  // This hook listens for the 'stopTransition' flag to mirror GM "Stop All" actions on all clients.
  // NOTE: Deduplication handled by shouldProcessAction - no local Map needed
  Hooks.on("updatePlaylist", async (pl, changes) => {
    if (!changes?.flags?.[MODULE_ID]?.stopTransition) return;
    const stop = pl.getFlag(MODULE_ID, "stopTransition");
    if (!stop) return;

    const { soundIds, fadeMs, seq, gmId } = stop;
    if (!Array.isArray(soundIds) || !Number.isFinite(seq)) return;

    if (!shouldProcessAction(pl.id, seq)) {
      debug(`[Stop-Sync] Ignoring duplicate or out-of-order stop (seq ${seq})`);
      return;
    }

    if (gmId === game.user.id) return; // Skip self

    debug(`[Stop-Sync] Processing stop from GM ${gmId}, seq ${seq}`);

    // shouldProcessAction already handled deduplication above
    if (pl.isOwner) return; // GM already handled their own fades.

    // Mirror the GM stop lifecycle locally before any awaits so loop/crossfade
    // timers cannot fire while the replicated fade-out is starting.
    State.markPlaylistAsStopping(pl);
    await cleanupPlaylistState(pl, {
      cleanSilence: true,
      cleanCrossfade: true,
      cleanLoopers: true,
      allowFadeOut: true,
    });

    const dur = Number(fadeMs) || 0;
    for (const sid of soundIds) {
      const ps = pl.sounds.get(sid);
      if (!ps) continue;

      const pendingFade = State.getEndOfTrackFade(ps);
      if (pendingFade) {
        pendingFade.cancel();
        State.clearEndOfTrackFade(ps);
      }

      const media = await waitForMedia(ps);
      if (!media) continue;
      try {
        cancelActiveFade(media);
      } catch (_) { }
      if (dur > 0) {
        debug(
          `[Stop-Client] Fading out "${ps.name}" over ${dur}ms (replicated).`
        );
        advancedFade(media, { targetVol: 0, duration: dur });
        AudioTimeout.wait(dur + 10).then(() => {
          try {
            media.stop();
          } catch (_) { }
        }).catch(() => { });
      } else {
        try {
          media.stop();
        } catch (_) { }
      }
    }
  });

  // Replicates the equal-power crossfade to non-GM players.
  // The GM sets the "crossfadeTransition" flag right before marking the outgoing sound
  // as stopped, so players can apply the matching curve while both sounds are still playing.
  Hooks.on("updatePlaylist", async (playlist, changes) => {
    // Foundry only sends the diff in `changes`, so if fadeMs/targetVolIn didn't change
    // they won't appear in the diff. Always read the full flag from the document.
    if (!changes?.flags?.[MODULE_ID]?.crossfadeTransition) return;
    const cf = playlist.getFlag(MODULE_ID, "crossfadeTransition");
    if (!cf) return;

    const { incomingSoundId, outgoingSoundId, fadeMs, targetVolIn, seq, gmId } = cf;

    if (!shouldProcessAction(playlist.id, seq)) {
      debug(`[Crossfade-Sync] Ignoring duplicate/out-of-order (seq ${seq})`);
      return;
    }
    if (gmId === game.user.id) return;  // GM already applied it locally
    if (playlist.isOwner) return;       // Safety: owners skip

    // Mark crossfading IMMEDIATELY (before any await) so any in-flight applyFadeIn
    // sees the flag and exits early at the State.isPlaylistCrossfading() check.
    State.markPlaylistAsCrossfading(playlist);

    const psOut = playlist.sounds.get(outgoingSoundId);
    const psIn  = playlist.sounds.get(incomingSoundId);
    if (!psIn) {
      State.clearPlaylistCrossfading(playlist);
      return;
    }
    const sharedTargetVolIn = Number.isFinite(Number(targetVolIn))
      ? Number(targetVolIn)
      : Flags.resolveSharedTargetVolume(psIn);
    const localTargetVolIn = Flags.resolveTargetVolume(psIn, { sharedVolume: sharedTargetVolIn });

    const [soundOut, soundIn] = await Promise.all([
      psOut ? waitForMedia(psOut) : Promise.resolve(null),
      waitForMedia(psIn),
    ]);

    if (!soundIn) {
      State.clearPlaylistCrossfading(playlist);
      return;
    }

    // Protect both sounds from sync() and the volume safety net during crossfade
    State.markSoundAsFading(soundIn);
    if (soundOut) State.markSoundAsFading(soundOut);

    // Graceful fallback: outgoing already stopped (network reorder) — snap incoming to target
    if (!soundOut?.playing) {
      debug(`[Crossfade-Sync] Outgoing sound already stopped; snapping "${psIn.name}" to target volume.`);
      soundIn.volume = localTargetVolIn;
      State.clearFadingSound(soundIn);
      State.clearPlaylistCrossfading(playlist);
      return;
    }

    debug(`[Crossfade-Sync] Applying equal-power crossfade "${psOut?.name}" → "${psIn.name}" (${fadeMs}ms)`);

    // equalPowerCrossfade internally cancels any pending S-curve from applyFadeIn
    equalPowerCrossfade(soundOut, soundIn, fadeMs, { targetVolIn: localTargetVolIn });

    AudioTimeout.wait(fadeMs + 50).then(() => {
      State.clearFadingSound(soundIn);
      if (soundOut) State.clearFadingSound(soundOut);
      State.clearPlaylistCrossfading(playlist);
    });
  });

  // Wrap playNext to clean up loopers, handle crossfading, and manage advanced shuffle state.
  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.playNext",
    async function (wrapped, ...args) {
      const playlist = this;
      debug(`[playNext WRAPPER] Advancing playlist "${playlist.name}".`);

      // Soundscape mode: "next track" is meaningless for procedural ambience.
      // Swallow the call so a misfired Next button doesn't tear the engine down.
      if (Flags.getPlaybackMode(playlist).soundscape) {
        debug(`[Soundscape] playNext no-op for "${playlist.name}".`);
        return;
      }

      // Use centralized cleanup for other module features.
      await cleanupPlaylistState(this, {
        cleanSilence: false,
        cleanCrossfade: true,
        cleanLoopers: true,
        cleanSoundscape: false,
        allowFadeOut: true,
      });

      const useCrossfade = Flags.getPlaybackMode(this).crossfade;
      const fadeMs = Flags.getCrossfadeDuration(this);
      const isSequentialOrShuffle = [
        CONST.PLAYLIST_MODES.SEQUENTIAL,
        CONST.PLAYLIST_MODES.SHUFFLE,
      ].includes(this.mode);

      // Replicate skip to all clients and fade out the current track.
      if (useCrossfade && fadeMs > 0 && isSequentialOrShuffle) {
        const currentForFlag = this.sounds.find((s) => s.playing);
        if (currentForFlag) {
          if (PlaylistActionAuthority.isAuthorizedGM()) {
            const payload = {
              fromSoundId: currentForFlag.id,
              fadeMs,
              seq: getNextSequence(this.id),
              ts: Date.now(),
              gmId: game.user.id,
            };
            try {
              await this.setFlag(MODULE_ID, "skipTransition", payload);
            } catch (_) { }
          }
          if (currentForFlag.sound) {
            const pendingFade = State.getEndOfTrackFade(currentForFlag);
            if (pendingFade) {
              pendingFade.cancel();
              State.clearEndOfTrackFade(currentForFlag);
            }
            debug(
              `[CF-Next] Fading out "${currentForFlag.name}" over ${fadeMs}ms (manual Next).`
            );
            cancelActiveFade(currentForFlag.sound);
            advancedFade(currentForFlag.sound, {
              targetVol: 0,
              duration: fadeMs,
            });
          }
        }
      }

      // Finally, call the original function to proceed to the next track.
      return await wrapped(...args);
    },
    "WRAPPER"
  );

  // Wrap playAll to schedule the first crossfade or loop when a playlist starts.
  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.playAll",
    async function (wrapped, ...args) {
      _debugPlaybackTrace("playAll called", this, {
        mode: Flags.getPlaybackMode(this).effective,
        args,
      });
      // Playback is starting, so clear any lingering "stopping" state.
      State.clearStoppingFlag(this);
      // Soundscape in Soundboard mode needs custom play-all behavior because
      // Foundry's disabled-mode playAll is otherwise a no-op.
      if (Flags.getPlaybackMode(this).soundscape) {
        // Match simultaneous-mode "play all" semantics for real tracks while
        // still letting the soundscape engine own procedural playback timing.
        const soundUpdates = this.sounds.map((sound) => {
          const isSilenceGap = Flags.getSoundFlag(sound, "isSilenceGap");
          const shouldPlay = !isSilenceGap;
          return {
            _id: sound.id,
            playing: shouldPlay,
            pausedTime: null,
          };
        });

        const hasSessionTracks = soundUpdates.some((update) => update.playing);
        if (!hasSessionTracks) {
          debug(
            `[Soundscape] Play All ignored for "${this.name}" - ` +
            `no playable soundscape tracks are configured.`
          );
          return this;
        }

        const result = await this.update({
          playing: true,
          sounds: soundUpdates,
        });

        if (game.user.isGM) {
          startSoundscape(this)
            .then((engine) => engine?.syncProceduralSounds?.())
            .catch((err) =>
              debug(`[Soundscape] startSoundscape failed for "${this.name}":`, err?.message)
            );
        }
        return result;
      }

      const result = await wrapped.call(this, ...args);

      // After playAll starts, find the first track and arm its features.
      AudioTimeout.wait(0).then(() => {
        let first = this.sounds.find((s) => s.playing);
        if (Array.isArray(first)) first = first.pop();
        if (first) {
          scheduleCrossfade(this, first);
          scheduleLoopWithin(first);
        }
      });
      return result;
    },
    "MIXED"
  );

  // Cycle the playlist through 5 modes: Disabled → Sequential → Shuffle →
  // Simultaneous → Soundscape → Disabled. Storage stays {mode: -1,
  // soundscapeMode flag}; writing both keys atomically self-heals stale state.
  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.cycleMode",
    async function () {
      const inSoundscape =
        this.mode === CONST.PLAYLIST_MODES.DISABLED &&
        !!this.getFlag(MODULE_ID, "soundscapeMode");
      const key = inSoundscape ? "soundscape" : this.mode;
      const transitions = {
        [CONST.PLAYLIST_MODES.DISABLED]: { mode: CONST.PLAYLIST_MODES.SEQUENTIAL, soundscape: false },
        [CONST.PLAYLIST_MODES.SEQUENTIAL]: { mode: CONST.PLAYLIST_MODES.SHUFFLE, soundscape: false },
        [CONST.PLAYLIST_MODES.SHUFFLE]: { mode: CONST.PLAYLIST_MODES.SIMULTANEOUS, soundscape: false },
        [CONST.PLAYLIST_MODES.SIMULTANEOUS]: { mode: CONST.PLAYLIST_MODES.DISABLED, soundscape: true },
        soundscape: { mode: CONST.PLAYLIST_MODES.DISABLED, soundscape: false },
      };
      const next = transitions[key] ?? transitions[CONST.PLAYLIST_MODES.DISABLED];
      const soundUpdates = this.sounds.map((sound) => ({
        _id: sound.id,
        playing: false,
        pausedTime: null,
      }));
      return this.update({
        sounds: soundUpdates,
        mode: next.mode,
        [`flags.${MODULE_ID}.soundscapeMode`]: next.soundscape,
      });
    },
    "OVERRIDE"
  );

  // Global wrapper on Sound.play to manage all module features at the audio level.
  libWrapper.register(
    MODULE_ID,
    "foundry.audio.Sound.prototype.play",
    async function (wrapped, options = {}) {
      // 0. Ensure AudioContext is running (browser may suspend it in background tabs)
      ensureAudioContext();

      // 1. Initial checks and setup
      if (options?._fromLoop || options?._sosProceduralOneShot) {
        return wrapped.call(this, options);
      }
      const ps = findPlaylistSoundForSound(this);
      if (!(ps instanceof PlaylistSound)) {
        return wrapped.call(this, options);
      }

      // 2. Handle shuffle state
      _handleShuffleOnPlay(ps);

      // 3. Determine target volume and pre-mute for fade-in.
      //    Skip when called from crossfade — equalPowerCrossfade() manages the volume curve.
      if (!options?._fromCrossfade) {
        const targetVolume = Flags.resolveTargetVolume(ps);
        const fadeInMs = Flags.getPlaylistFlag(ps.parent, "fadeIn");
        const isFreshPlay = isFreshPlaybackStart(ps);
        const preMuteVolume = (fadeInMs > 0 && isFreshPlay) ? 0 : targetVolume;
        _applyPreMute(this, ps, fadeInMs, targetVolume);

        // 4. Override options.volume so Foundry's internal play() uses our
        //    normalized/pre-muted value instead of the raw document volume.
        //    Fresh plays also force offset 0 so a reused loop-managed Sound
        //    cannot resume from its previous loop position after stop/replay.
        const playOffset = (isFreshPlay && options?.offset == null) ? 0 : options?.offset;
        options = { ...options, volume: preMuteVolume, offset: playOffset };
      }

      // 5. Play the sound
      const result = await wrapped.call(this, options);

      // 6. Schedule all post-play actions (fade-in, loops, crossfade timers).
      //    Volume safety net is inside _schedulePostPlayActions, AFTER scheduling,
      //    so it doesn't destroy fade curves that were just set up.
      _schedulePostPlayActions(ps, this, { fromCrossfade: !!options?._fromCrossfade });

      return result;
    },
    "WRAPPER"
  );

  // Global wrapper on Sound.pause to correctly pause the internal loop timer.
  libWrapper.register(
    MODULE_ID,
    "foundry.audio.Sound.prototype.pause",
    function (wrapped, options = {}) {
      const ps = findPlaylistSoundForSound(this);

      if (ps instanceof PlaylistSound) {
        pauseLoopWithin(ps);
      }
      return wrapped.call(this, options);
    },
    "WRAPPER"
  );

  // Intercept volume changes on PlaylistSound documents to handle normalization
  libWrapper.register(
    MODULE_ID,
    "PlaylistSound.prototype.update",
    async function (wrapped, data, options = {}) {
      // Check if this update includes a volume change
      const hasVolumeChange = data.hasOwnProperty("volume");

      if (hasVolumeChange) {
        const playlist = this.parent;

        // Check if normalization is active for this playlist
        const normEnabled = Flags.getPlaylistFlag(
          playlist,
          "volumeNormalizationEnabled"
        );
        const hasOverride = Flags.getSoundFlag(this, "allowVolumeOverride");

        // If normalization is active and this sound doesn't have override permission
        if (normEnabled && !hasOverride) {
          // Check if this is a user-initiated change (not from our own normalization system)
          const isFromNormalization = options._fromNormalization;

          if (!isFromNormalization) {
            debug(
              `[Volume] Blocking manual volume change on "${this.name}" - normalization active`
            );

            // Apply the volume change to the audio element only while no fade owns it.
            if (this.sound && !State.isSoundFading(this.sound)) {
              this.sound.volume = data.volume;
            } else if (this.sound) {
              debug(
                `[Volume] Skipping temporary volume preview for "${this.name}" - fade active`
              );
            }

            // Remove volume from the update data
            const newData = { ...data };
            delete newData.volume;

            // If there's nothing left to update, skip the database call entirely
            // but still return the document to satisfy expectations
            if (Object.keys(newData).length === 0) {
              debug(
                `[Volume] Only volume changed (blocked), no database update needed`
              );
              // Return without updating - the audio element already has the new volume
              return this;
            }

            // Update other properties without the volume change
            return wrapped.call(this, newData, options);
          }
        }
      }

      // Normal update (either no volume change, or override is allowed, or from normalization)
      return wrapped.call(this, data, options);
    },
    "MIXED" // ← CHANGE FROM "WRAPPER" TO "MIXED"
  );

  /**
   * Override playbackOrder to inject advanced shuffle patterns.
   * This only activates when:
   * 1. Playlist is in SHUFFLE mode
   * 2. Advanced shuffle pattern is not "foundry-default"
   */
  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.playbackOrder",
    function (wrapped) {
      const playlist = this;

      // Only override for shuffle mode
      if (playlist.mode !== CONST.PLAYLIST_MODES.SHUFFLE) {
        return wrapped.call(this);
      }

      // Try to get custom order from our advanced shuffle system
      const customOrder = AdvancedShuffle.generateOrder(playlist);

      if (customOrder) {
        // Check if a silent gap is currently the active (playing) sound
        const playingGap = playlist.sounds.find(
          (s) => s.playing && s.getFlag(MODULE_ID, "isSilenceGap")
        );

        // If a gap is active, we must prepend it to the generated order.
        // This ensures Foundry's UI renders the gap as the currently playing track.
        // The core shuffle logic remains unaffected.
        if (playingGap) {
          // Create a new array with the gap ID at the front.
          // Avoid including it twice if it's somehow already in the list.
          const finalOrder = [
            playingGap.id,
            ...customOrder.filter((id) => id !== playingGap.id),
          ];
          return finalOrder;
        }

        // Only log if this is the actively playing playlist
        if (playlist.playing) {
          const pattern =
            game.settings.get(MODULE_ID, "shufflePattern") || "unknown";
          debug(
            `[Shuffle] Using advanced shuffle (${pattern}) for "${playlist.name}"`
          );
        }
        return customOrder;
      }

      // Fall back to Foundry's default shuffle
      return wrapped.call(this);
    },
    "MIXED"
  );

  // Guard: Prevent Foundry's sync() from stopping sounds mid-crossfade.
  // When performCrossfade updates the outgoing sound's document to { playing: false },
  // Foundry calls _onUpdate() → sync(). sync() sees !this.playing and calls
  // sound.stop({fade, volume: 0}), which runs cancelScheduledValues() + _disconnectPipeline(),
  // destroying our active setValueCurveAtTime crossfade curves.
  // Similarly, sync() calls sound.fade(volume, 500) for already-playing sounds to re-sync
  // volume, which also destroys curves via cancelScheduledValues().
  // This wrapper skips sync entirely when the sound has an active SoS fade curve.
  libWrapper.register(
    MODULE_ID,
    "PlaylistSound.prototype.sync",
    function (wrapped) {
      if (
        Flags.getPlaybackMode(this.parent).soundscape &&
        Flags.getSoundFlag(this, "isProcedural")
      ) {
        if (this.sound?.playing) {
          safeStop(this.sound, "soundscape procedural sync guard");
        }
        return;
      }
      if (this.sound && State.isSoundFading(this.sound)) {
        debug(`[Sync Guard] Blocked sync() for "${this.name}" — SoS fade curve active`);
        return;
      }
      const result = wrapped();
      if (this.sound?.playing && !State.isSoundFading(this.sound)) {
        this.sound.volume = Flags.resolveTargetVolume(this);
      }
      return result;
    },
    "MIXED"
  );

  /**
   * Handle track additions - update shuffle state to include new tracks
   */
  Hooks.on("createPlaylistSound", (sound, options, userId) => {
    const playlist = sound.parent;
    if (playlist?.mode === CONST.PLAYLIST_MODES.SHUFFLE) {
      // Do not update the shuffle state for temporary silent gaps.
      if (sound.getFlag(MODULE_ID, "isSilenceGap")) {
        debug(
          `[Shuffle] Ignoring creation of temporary gap in "${playlist.name}"`
        );
        return;
      }
      AdvancedShuffle.handleTracksChanged(playlist);
      debug(
        `[Shuffle] Track added to "${playlist.name}", updated shuffle state`
      );
    }
  });

  /**
   * Handle track deletions - update shuffle state to remove deleted tracks
   */
  Hooks.on("deletePlaylistSound", (sound, options, userId) => {
    // --- Looper cleanup ---
    debug(
      `[Manager] Sound document "${sound.name}" was deleted. Ensuring its looper is cancelled.`
    );
    cancelLoopWithin(sound, { quiet: true, preservePlayback: false });

    // --- Shuffle state update ---
    const playlist = sound.parent;
    if (playlist?.mode === CONST.PLAYLIST_MODES.SHUFFLE) {
      // Do not update the shuffle state when temporary silent gaps are deleted.
      if (sound.getFlag(MODULE_ID, "isSilenceGap")) {
        debug(
          `[Shuffle] Ignoring deletion of temporary gap in "${playlist.name}"`
        );
        return;
      }
      AdvancedShuffle.handleTracksChanged(playlist);
      debug(
        `[Shuffle] Track removed from "${playlist.name}", updated shuffle state`
      );
    }
  });

  /**
   * Optional: Reset shuffle state when playlist stops
   * Uncomment for shuffle to start fresh each time playlist plays
   */
  Hooks.on("stopPlaylist", (playlist) => {
    PlaybackClock.clear(playlist, "stopPlaylist").catch((err) =>
      debug(`[Clock] Failed to clear stopped playlist clock:`, err?.message ?? err)
    );
    if (playlist.mode === CONST.PLAYLIST_MODES.SHUFFLE) {
      AdvancedShuffle.reset(playlist);
      debug(`[Shuffle] Reset state for "${playlist.name}" on stop`);
    }
  });

  // Keep every client's local soundscape engine aligned with replicated
  // playlist state. This covers initial playback, live flag toggles, and late
  // join/reload cases where only the document state is available locally.
  Hooks.on("updatePlaylist", (playlist, changes) => {
    const soundscapeChanged = foundry.utils.hasProperty(
      changes,
      `flags.${MODULE_ID}.soundscapeMode`
    );
    const playingChanged = Object.prototype.hasOwnProperty.call(changes, "playing");
    const modeChanged = Object.prototype.hasOwnProperty.call(changes, "mode");
    const soundStatesChanged = Array.isArray(changes?.sounds);
    if (!soundscapeChanged && !playingChanged && !modeChanged && !soundStatesChanged) return;

    _scheduleSoundscapeReconcile(playlist, "playlist update");
  });

  // Soundscape is only valid in Soundboard mode. If the GM changes the
  // playlist mode away from Soundboard Only, clear the persisted flag so the UI
  // doesn't carry stale state.
  Hooks.on("updatePlaylist", async (playlist, changes, options, userId) => {
    if (!Object.prototype.hasOwnProperty.call(changes, "mode")) return;
    if (!game.user.isGM || game.user.id !== userId) return;
    if (playlist.mode === CONST.PLAYLIST_MODES.DISABLED) return;
    if (!playlist.getFlag(MODULE_ID, "soundscapeMode")) return;

    await playlist.update({
      [`flags.${MODULE_ID}.soundscapeMode`]: false,
    }, { render: false });
  });

  Hooks.on("updatePlaylist", async (playlist, changes, options, userId) => {
    const soundscapeChanged = foundry.utils.hasProperty(
      changes,
      `flags.${MODULE_ID}.soundscapeMode`
    );
    const modeChanged = Object.prototype.hasOwnProperty.call(changes, "mode");
    if (!soundscapeChanged && !modeChanged) return;
    if (!game.user.isGM || game.user.id !== userId) return;
    if (Flags.getPlaybackMode(playlist).soundscape) return;

    const proceduralUpdates = playlist.sounds
      .filter((sound) =>
        sound.playing &&
        !Flags.getSoundFlag(sound, "isSilenceGap") &&
        Flags.getSoundFlag(sound, "isProcedural")
      )
      .map((sound) => ({
        _id: sound.id,
        playing: false,
        pausedTime: null,
      }));

    if (!proceduralUpdates.length) return;

    await playlist.updateEmbeddedDocuments("PlaylistSound", proceduralUpdates, {
      render: false,
    });
  });

  Hooks.on("updatePlaylist", async (playlist, changes, options, userId) => {
    // Only the GM who initiated the change should perform the update.
    if (game.user.id !== userId || !game.user.isGM) return;

    const flagPath = `flags.${MODULE_ID}`;
    const normalizationToggled = foundry.utils.hasProperty(
      changes,
      `${flagPath}.volumeNormalizationEnabled`
    );
    const volumeChanged = foundry.utils.hasProperty(
      changes,
      `${flagPath}.normalizedVolume`
    );

    // Exit if normalization isn't enabled or if the relevant flags haven't changed.
    const normFlags = Flags.getPlaylistFlags(playlist);
    if (
      !normFlags.volumeNormalizationEnabled ||
      (!normalizationToggled && !volumeChanged)
    ) {
      return;
    }

    const targetVolume = normFlags.normalizedVolume;
    const updates = [];

    // Convert the linear slider value to the logarithmic value the audio engine needs
    const convertedVolume =
      foundry.audio.AudioHelper.inputToVolume(targetVolume);

    for (const sound of playlist.sounds) {
      // Compare against the converted value
      if (
        !Flags.getSoundFlag(sound, "allowVolumeOverride") &&
        sound.volume !== convertedVolume
      ) {
        // Push the converted value in the update
        updates.push({ _id: sound.id, volume: convertedVolume });
      }
    }

    if (updates.length > 0) {
      debug(
        `[Volume] Normalizing ${updates.length} sounds to ${(
          targetVolume * 100
        ).toFixed(0)}% in "${playlist.name}"`
      );

      await playlist.updateEmbeddedDocuments("PlaylistSound", updates, {
        _fromNormalization: true,
        render: false,
      });

      // Find the playlist element in the UI
      const playlistElement = document.querySelector(
        `.playlist[data-entry-id="${playlist.id}"], .playlist[data-document-id="${playlist.id}"]`
      );
      if (playlistElement) {
        for (const update of updates) {
          // Find the specific sound's <li> element
          const soundElement = playlistElement.querySelector(
            `.sound[data-sound-id="${update._id}"]`
          );
          if (soundElement) {
            // Find the volume slider for that sound
            const rangePicker = soundElement.querySelector(
              "range-picker.sound-volume"
            );
            if (rangePicker) {
              // Directly set its value. This does not cause a re-render.
              rangePicker.value = targetVolume; // Use the 0-1 value, not the converted one
            }
          }
        }
      }
      // Also update the "Currently Playing" section if it exists
      const currentlyPlaying = document.querySelector(".currently-playing");
      if (currentlyPlaying) {
        for (const update of updates) {
          const soundElement = currentlyPlaying.querySelector(
            `.sound[data-sound-id="${update._id}"]`
          );
          if (soundElement) {
            const rangePicker = soundElement.querySelector(
              "range-picker.sound-volume"
            );
            if (rangePicker) {
              rangePicker.value = targetVolume;
            }
          }
        }
      }
    }
  });

  /**
   * Marks a track as played for advanced shuffle patterns.
   */
  function _handleShuffleOnPlay(ps) {
    if (ps.parent?.mode === CONST.PLAYLIST_MODES.SHUFFLE && !ps.pausedTime) {
      debug(
        `[Shuffle] Marking track as played via Sound.play wrapper: "${ps.name}"`
      );
      AdvancedShuffle.markTrackPlayed(ps.parent, ps);
    }
  }

  /**
   * Sets the initial volume of a sound object before playback.
   * Mutes the sound if a fade-in is required, otherwise sets it to its target volume.
   */
  function _applyPreMute(sound, ps, fadeInMs, targetVolume) {
    if (fadeInMs > 0 && isFreshPlaybackStart(ps)) {
      sound.volume = 0; // Start at 0 for fade-in
    } else {
      sound.volume = targetVolume; // Not fading in, set correct volume immediately
    }
  }

  /**
   * Schedules all module features that must run after a sound begins playback.
   * This includes loops, fades, and crossfade timers.
   */
  function _schedulePostPlayActions(ps, sound, { fromCrossfade = false } = {}) {
    const playlist = ps.parent;
    const isResume = Number.isFinite(ps.pausedTime);

    PlaybackClock.record(playlist, ps, sound, {
      reason: fromCrossfade ? "crossfade playback" : (isResume ? "resume" : "play"),
      force: isResume,
    }).catch((err) => {
      debug(`[Clock] Failed to record playback clock for "${ps.name}":`, err?.message ?? err);
    });

    // Resume or schedule new loop
    if (isResume) {
      debug(`[Sound.play WRAPPER] Resuming loop for "${ps.name}".`);
      resumeLoopWithin(ps);
    } else {
      debug(`[Sound.play WRAPPER] Scheduling new loop for "${ps.name}".`);
      cancelLoopWithin(ps, { quiet: true, restorePlaybackHandlers: false });
      scheduleLoopWithin(ps);
    }

    // Apply fade-in, passing the normalized target volume directly to avoid
    // race conditions (applyFadeIn is async but not awaited here).
    const fadeInMs = Flags.getPlaylistFlag(playlist, "fadeIn");
    if (fadeInMs > 0 && !ps?.getFlag(MODULE_ID, "isSilenceGap") && !fromCrossfade) {
      const targetVolume = Flags.resolveTargetVolume(ps);
      applyFadeIn(playlist, ps, { targetVolume }).catch(err => {
        debug(`[FadeIn] Error during fade-in for "${ps.name}":`, err.message);
      });
    }

    // Re-arm automatic crossfade timer
    if (Flags.getPlaylistFlag(playlist, "crossfade")) {
      scheduleCrossfade(playlist, ps, { force: isResume });

      // Cancel Foundry's built-in _scheduleFadeOut. When third-party modules
      // (e.g. Playlist Enchantment) force a non-zero playlist.fade, Foundry's
      // _onStart() schedules an independent fade-out that competes with our
      // crossfade timer and can destroy our setValueCurveAtTime curves.
      if (typeof ps._cancelFadeOut === "function") {
        ps._cancelFadeOut();
        debug(`[PostPlay] Cancelled Foundry _scheduleFadeOut for "${ps.name}" — SoS crossfade active.`);
      }
    }

    // Schedule end-of-track fade if no other feature is handling the transition
    const loopConfig = Flags.getLoopConfig(ps);
    const playbackMode = Flags.getPlaybackMode(playlist);

    if (!loopConfig?.enabled && !playbackMode.crossfade && !ps.repeat) {
      // For both Silence and standard Sequential/Shuffle modes, we want a fade-out
      // at the end of the track. Our new utility handles this perfectly.
      // Skip if the sound is set to repeat (native loop) to avoid NaN gain issues.
      scheduleEndOfTrackFade(ps);
    }

    // Post-schedule volume safety net (for background tabs).
    // Runs AFTER all scheduling so it doesn't destroy fade curves that were just set up.
    if ((fadeInMs <= 0 || !isFreshPlaybackStart(ps)) && !State.isSoundFading(sound) && !fromCrossfade) {
      const target = Flags.resolveTargetVolume(ps);
      if (Math.abs(sound.volume - target) > 0.001) {
        debug(`[Sound.play] Post-schedule volume correction: ${sound.volume.toFixed(3)} -> ${target.toFixed(3)} for "${ps.name}"`);
        sound.volume = target;
      }
    }
  }
});
