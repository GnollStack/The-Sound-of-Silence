/**
 * @file document-hooks.js
 * @description Playlist and sound document update hooks for tracing, clocks, and visible volume sync.
 */
import { MODULE_ID, debug } from "../utils.js";
import { Flags } from "../flag-service.js";
import { PlaybackClock } from "../playback-clock.js";
import { State } from "../state-manager.js";
import {
  debugPlaybackTrace,
  describeSoundAudio,
  queuePlaybackClockRecord,
} from "../playback-recovery.js";
import {
  applyPersonalAudioMixToActiveSounds,
  syncEmbeddedSoundVolumeControls,
  syncPersonalTrackVolumeControls,
  syncPersonalTrackVolumeControlsForPlaylist,
  syncPlaylistVolumeControls,
  syncSoundVolumeControls,
} from "../personal-audio-mix.js";

function cancelExternallyStoppedSilenceGap(playlist, soundId) {
  const silenceState = State.getSilenceState(playlist);
  if (
    !silenceState ||
    silenceState.cancelled ||
    silenceState.gap?.id !== soundId ||
    silenceState.completionAttempt ||
    silenceState.deletingForCompletion
  ) return;

  State.cleanup(playlist, {
    cleanSilence: true,
    cleanCrossfade: false,
    cleanLoopers: false,
    cleanSoundscape: false,
  }).catch((err) =>
    debug(`[Silence] Failed to cancel externally stopped gap "${silenceState.gap?.name}":`, err?.message ?? err)
  );
}

export function registerPlaybackDocumentHooks() {
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

    if (Array.isArray(changes?.sounds)) {
      for (const soundChange of changes.sounds) {
        if (soundChange?.playing !== false) continue;
        const soundDoc = playlist.sounds.get(soundChange._id);
        if (!soundDoc || !Flags.getSoundFlag(soundDoc, "isSilenceGap")) continue;
        cancelExternallyStoppedSilenceGap(playlist, soundDoc.id);
      }
    }

    if (changes.playing === true || changes.sounds?.some?.((sound) => sound?.playing === true)) {
      State.clearStoppingFlag(playlist);
    }

    const flatSoundscapeFlagKey = `flags.${MODULE_ID}.soundscapeMode`;
    const soundscapeFlag = Object.prototype.hasOwnProperty.call(changes ?? {}, flatSoundscapeFlagKey)
      ? changes[flatSoundscapeFlagKey]
      : changes?.flags?.[MODULE_ID]?.soundscapeMode;

    debugPlaybackTrace("updatePlaylist", playlist, {
      user: game.users.get(userId)?.name ?? userId,
      playing: changes.playing,
      mode: changes.mode,
      soundscapeFlag,
      sounds: soundUpdates,
      options,
    });
    syncEmbeddedSoundVolumeControls(playlist, changes, "playlist embedded volume update");
    if (foundry.utils.hasProperty(changes ?? {}, `flags.${MODULE_ID}.normalizedVolume`)) {
      syncPlaylistVolumeControls(playlist, "playlist document volume update");
      syncPersonalTrackVolumeControlsForPlaylist(playlist, "playlist document volume update");
      applyPersonalAudioMixToActiveSounds(playlist);
    }
    if (foundry.utils.hasProperty(changes ?? {}, `flags.${MODULE_ID}.${PlaybackClock.FLAG_KEY}`)) {
      ui.playlists?.render({ parts: ["playing"] });
    }
    if (Array.isArray(changes?.sounds) && game.user?.isGM && playlist.isOwner) {
      for (const soundChange of changes.sounds) {
        if (soundChange?.playing !== true) continue;
        const soundDoc = playlist.sounds.get(soundChange._id);
        queuePlaybackClockRecord(soundDoc, "playlist update");
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
    if (
      changes.playing === false &&
      Flags.getSoundFlag(soundDoc, "isSilenceGap")
    ) {
      // Native pause writes directly to the embedded sound and bypasses the
      // playlist command wrappers. Treat it as cancellation immediately so
      // the old wall-clock timer cannot later advance or resume a 100ms file
      // at a synthetic multi-second offset.
      cancelExternallyStoppedSilenceGap(soundDoc.parent, soundDoc.id);
    }
    if (changes.playing === true) State.clearStoppingFlag(soundDoc.parent);
    debugPlaybackTrace("updatePlaylistSound", soundDoc.parent, {
      sound: soundDoc.name,
      user: game.users.get(userId)?.name ?? userId,
      playing: changes.playing,
      pausedTime: changes.pausedTime,
      audio: describeSoundAudio(soundDoc),
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
      queuePlaybackClockRecord(soundDoc, "sound update");
    }
  });

  Hooks.on("updatePlaylistSound", (soundDoc, changes) => {
    if (!Object.prototype.hasOwnProperty.call(changes ?? {}, "volume")) return;
    syncSoundVolumeControls(soundDoc, "document volume update");
    syncPersonalTrackVolumeControls(soundDoc, "document volume update");
    applyPersonalAudioMixToActiveSounds(soundDoc.parent);
  });
}
