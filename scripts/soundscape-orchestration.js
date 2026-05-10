/**
 * @file soundscape-orchestration.js
 * @description Keeps local Soundscape engines aligned with replicated playlist document state.
 */
import { Flags } from "./flag-service.js";
import { startSoundscape, stopSoundscape } from "./procedural-ambience.js";
import { State } from "./state-manager.js";
import { debug, MODULE_ID } from "./utils.js";

let soundHooksRegistered = false;
let playlistHooksRegistered = false;

function _getActiveSoundscapeSounds(playlist) {
  if (!playlist?.sounds) return [];
  return playlist.sounds.filter(
    (sound) => sound.playing && !Flags.getSoundFlag(sound, "isSilenceGap")
  );
}

export function shouldRunSoundscapeEngine(playlist) {
  if (!playlist || !Flags.getPlaybackMode(playlist).soundscape) return false;
  return !!playlist.playing || _getActiveSoundscapeSounds(playlist).length > 0;
}

async function _reconcileSoundscapeEngine(playlist, reason = "unknown") {
  if (!playlist) return;

  const engine = State.getSoundscapeEngine(playlist);
  const shouldRun = shouldRunSoundscapeEngine(playlist);

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

export function scheduleSoundscapeReconcile(playlist, reason = "unknown") {
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

export function bootstrapSoundscapeEngines() {
  // If a client joins or reloads while a soundscape playlist is already live,
  // bootstrap the local engine from the replicated playlist state.
  for (const playlist of game.playlists) {
    if (!shouldRunSoundscapeEngine(playlist)) continue;
    scheduleSoundscapeReconcile(playlist, "ready bootstrap");
  }
}

export function registerSoundscapeSoundHooks() {
  if (soundHooksRegistered) return;
  soundHooksRegistered = true;

  // Arm or disarm a procedural sound's timer when its `playing` state flips.
  // Runs on every client so local RNG timers stay aligned with document state.
  Hooks.on("updatePlaylistSound", (soundDoc, changes) => {
    if (!Object.prototype.hasOwnProperty.call(changes, "playing")) return;

    const playlist = soundDoc.parent;
    if (!playlist || !Flags.getPlaybackMode(playlist).soundscape) return;
    scheduleSoundscapeReconcile(
      playlist,
      `sound update: ${soundDoc.name} playing=${Boolean(changes.playing)}`
    );
  });

  // Auto-stop a Soundscape playlist when its last playing sound goes idle.
  // Individual stops accumulate until no sound is left, then the playlist
  // itself flips to stopped, which tears down the engine via updatePlaylist.
  Hooks.on("updatePlaylistSound", async (soundDoc, changes) => {
    if (!game.user.isGM) return;
    if (!Object.prototype.hasOwnProperty.call(changes, "playing")) return;
    if (changes.playing) return;

    const playlist = soundDoc.parent;
    if (!playlist || !Flags.getPlaybackMode(playlist).soundscape) return;
    if (!playlist.playing) return;
    if (State.isPlaylistStopping(playlist)) return;

    const stillPlaying = playlist.sounds.some(
      (sound) => sound.playing && !Flags.getSoundFlag(sound, "isSilenceGap")
    );
    if (stillPlaying) return;

    debug(`[Soundscape] Last sound stopped in "${playlist.name}"; stopping playlist.`);
    await playlist.update({ playing: false });
  });
}

export function registerSoundscapePlaylistHooks() {
  if (playlistHooksRegistered) return;
  playlistHooksRegistered = true;

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

    scheduleSoundscapeReconcile(playlist, "playlist update");
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
}
