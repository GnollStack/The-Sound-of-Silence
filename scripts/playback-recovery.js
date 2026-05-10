/**
 * @file playback-recovery.js
 * @description Playback clock tracing, sparse clock recording, and owner-side overdue recovery.
 */
import { performCrossfade } from "./cross-fade.js";
import { Flags } from "./flag-service.js";
import { PlaybackClock } from "./playback-clock.js";
import { maybeLoopPlaylist } from "./playlist-loop.js";
import { Silence } from "./silence.js";
import { State } from "./state-manager.js";
import { debug, PlaylistActionAuthority, waitForMedia } from "./utils.js";

const PLAYBACK_RECOVERY_IN_FLIGHT = new Set();
const PLAYBACK_RECOVERY_SEEN = new Map();
let playbackRecoveryWatchdog = null;

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

export function describeSoundAudio(soundDoc) {
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

export function queuePlaybackClockRecord(soundDoc, reason = "document playing", { force = false } = {}) {
  const playlist = soundDoc?.parent;
  if (!PlaylistActionAuthority.isAuthorizedGM()) return;
  if (!playlist?.isOwner || !soundDoc?.playing) return;
  if (!_isSequentialOrShuffle(playlist)) return;
  if (Flags.getPlaybackMode(playlist).soundscape) return;
  if (Flags.getSoundFlag(soundDoc, "isSilenceGap")) return;
  if (soundDoc.repeat) return;

  const attempt = async (label) => {
    if (!soundDoc.playing || PlaybackClock.get(playlist)?.soundId === soundDoc.id) return;

    const pausedOffset = soundDoc.pausedTime == null ? null : Number(soundDoc.pausedTime);
    const offsetSec = Number.isFinite(pausedOffset) && pausedOffset > 0 ? pausedOffset : null;

    const recorded = await PlaybackClock.record(playlist, soundDoc, soundDoc.sound, {
      reason: `${reason}:${label}`,
      offsetSec,
      force,
    });
    if (recorded) return;

    const media = await waitForMedia(soundDoc);
    await PlaybackClock.record(playlist, soundDoc, media, {
      reason: `${reason}:${label}:media`,
      offsetSec,
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

export function runPlaybackRecoveryWatchdog(reason = "watchdog") {
  if (!PlaylistActionAuthority.isAuthorizedGM()) return;
  for (const playlist of game.playlists ?? []) {
    _recoverOverduePlaylist(playlist, reason);
  }
}

export function startPlaybackRecoveryWatchdog() {
  if (playbackRecoveryWatchdog || !globalThis.setInterval) return;
  playbackRecoveryWatchdog = globalThis.setInterval(
    () => runPlaybackRecoveryWatchdog("interval"),
    PlaybackClock.WATCHDOG_INTERVAL_MS
  );
  globalThis.addEventListener?.("beforeunload", () => {
    if (playbackRecoveryWatchdog) globalThis.clearInterval(playbackRecoveryWatchdog);
    playbackRecoveryWatchdog = null;
  }, { once: true });
}

export function debugPlaybackTrace(message, playlist = null, extra = {}) {
  const playlistPart = playlist ? ` playlist="${playlist.name}"` : "";
  debug(`[PlaybackTrace] ${message}${playlistPart}`, {
    active: _describeActivePlaylists(),
    ...extra,
  });
}
