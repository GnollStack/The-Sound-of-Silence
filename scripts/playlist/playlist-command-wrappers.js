/**
 * @file playlist-command-wrappers.js
 * @description Foundry Playlist and PlaylistSound command wrappers.
 */
import {
  fadeOutAndStop,
} from "../audio-fader.js";
import { performCrossfade, scheduleCrossfade } from "../cross-fade.js";
import { Flags } from "../flag-service.js";
import { scheduleLoopWithin } from "../internal-loop.js";
import { PlaybackClock } from "../playback-clock.js";
import { startSoundscape } from "../procedural-ambience.js";
import { Silence } from "../silence.js";
import { State, cleanupPlaylistState } from "../state-manager.js";
import {
  debug,
  getNextSequence,
  logFeature,
  LogSymbols,
  MODULE_ID,
  PlaylistActionAuthority,
  safeStop,
} from "../utils.js";
import { debugPlaybackTrace } from "../playback-recovery.js";
import { cancelSilentGap } from "./playlist-actions.js";

const AudioTimeout = foundry.audio.AudioTimeout;

async function handleTrackCompletion(playlistSound) {
  const playlist = playlistSound.parent;
  const pendingFade = State.getEndOfTrackFade(playlistSound);
  if (pendingFade) {
    pendingFade.cancel();
    State.clearEndOfTrackFade(playlistSound);
  }
  const mode = Flags.getPlaybackMode(playlist);

  if (mode.crossfade) {
    return;
  }

  if (mode.silence) {
    debug(`Injecting silent gap after "${playlistSound.name}" in "${playlist.name}".`);
    Silence.playSilence(playlist, playlistSound);
  }
}

function isSequentialOrShuffle(playlist) {
  return [
    CONST.PLAYLIST_MODES.SEQUENTIAL,
    CONST.PLAYLIST_MODES.SHUFFLE,
  ].includes(playlist?.mode);
}

function getCurrentCrossfadeSource(playlist, incomingSound = null) {
  return playlist?.sounds?.find((s) =>
    s.playing &&
    s.id !== incomingSound?.id &&
    !Flags.getSoundFlag(s, "isSilenceGap")
  );
}

function getManualCrossfadeTarget(playlist, currentSound, soundId, direction) {
  const currentId = soundId || currentSound?.id || null;
  if (!currentId) return null;

  const target = direction === -1
    ? playlist._getPreviousSound(currentId)
    : playlist._getNextSound(currentId);

  if (!target || target.id === currentSound?.id) return null;
  if (Flags.getSoundFlag(target, "isSilenceGap")) return null;
  return target;
}

async function executeManualCrossfade(playlist, currentSound, incomingSound, reason) {
  const pendingFade = State.getEndOfTrackFade(currentSound);
  if (pendingFade) {
    pendingFade.cancel();
    State.clearEndOfTrackFade(currentSound);
  }

  await cleanupPlaylistState(playlist, {
    cleanSilence: false,
    cleanCrossfade: true,
    cleanLoopers: true,
    cleanSoundscape: false,
    onlySound: currentSound,
    allowFadeOut: true,
  });

  return performCrossfade(playlist, currentSound, {
    incomingSound,
    reason,
  });
}

export function registerPlaylistCommandWrappers() {
  libWrapper.register(
    MODULE_ID,
    "PlaylistSound.prototype._onEnd",
    function (wrapped, ...args) {
      const playlist = this.parent;

      if (Flags.getSoundFlag(this, "isSilenceGap")) {
        return;
      }

      if (State.isPlaylistCrossfading(playlist)) {
        debug("_onEnd: Bailing because an automatic crossfade is in progress.");
        return;
      }

      if (
        playlist.mode === CONST.PLAYLIST_MODES.SIMULTANEOUS &&
        Flags.getPlaylistFlag(playlist, "loopPlaylist")
      ) {
        debug(`[LP] Restarting "${this.name}" inside simultaneous playlist "${playlist.name}"`);
        const endResult = wrapped(...args);
        if (game.user.isGM) playlist.playSound(this);
        return endResult;
      }

      const mode = Flags.getPlaybackMode(playlist);

      if (!mode.crossfade && !mode.silence) {
        return wrapped(...args);
      }

      handleTrackCompletion(this);
    },
    "MIXED"
  );

  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.stopSound",
    function (wrapped, sound, ...args) {
      const playlist = this;
      debugPlaybackTrace("stopSound called", playlist, {
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
          `Track -> Playlist: ${sound.name}. Escalating to stop the entire playlist.`
        );
        playlist.stopAll();
        return;
      }

      return wrapped.call(this, sound, ...args);
    },
    "MIXED"
  );

  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.stopAll",
    async function () {
      debugPlaybackTrace("stopAll called", this, {
        mode: Flags.getPlaybackMode(this).effective,
      });
      logFeature(LogSymbols.STOP, "Stop", `Playlist: ${this.name}`);
      State.markPlaylistAsStopping(this);
      await PlaybackClock.clear(this, "stopAll");
      const fadeDuration = Number(this.fade) || 0;

      const playingSounds = this.sounds.filter(
        (s) => s.playing && !Flags.getSoundFlag(s, "isSilenceGap")
      );
      const silenceState = State.getSilenceState(this);
      const sourceSound = silenceState?.sourceSound;

      const soundsToStopSet = new Set(playingSounds);
      if (sourceSound) {
        soundsToStopSet.add(sourceSound);
      }
      const soundsToStop = Array.from(soundsToStopSet);
      const soundIdsToStop = soundsToStop.map((s) => s.id);

      await cleanupPlaylistState(this, {
        cleanSilence: true,
        cleanCrossfade: true,
        cleanLoopers: true,
        allowFadeOut: fadeDuration > 0,
      });

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

      for (const sound of soundsToStop) {
        if (!sound.sound) continue;

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

      ui.playlists.render();
    },
    "OVERRIDE"
  );

  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.playSound",
    async function (wrapped, soundToPlay, ...args) {
      const playlist = this;
      debugPlaybackTrace("playSound called", playlist, {
        sound: soundToPlay?.name,
        mode: Flags.getPlaybackMode(playlist).effective,
        args,
      });

      if (State.isPlaylistCrossfading(playlist)) {
        return await wrapped.call(playlist, soundToPlay, ...args);
      }

      if (Flags.getPlaybackMode(playlist).soundscape) {
        return await wrapped.call(playlist, soundToPlay, ...args);
      }

      if (
        State.hasSilenceState(playlist) &&
        !soundToPlay.getFlag(MODULE_ID, "isSilenceGap")
      ) {
        await cancelSilentGap(playlist);
      }

      const useCrossfade = Flags.getPlaybackMode(playlist).crossfade;
      const fadeMs = Flags.getCrossfadeDuration(playlist);

      if (playlist.isOwner && useCrossfade && fadeMs > 0 && isSequentialOrShuffle(playlist)) {
        const currentlyPlaying = getCurrentCrossfadeSource(playlist, soundToPlay);
        if (currentlyPlaying?.sound) {
          debug(
            `[CF-Skip] Targeted crossfade from "${currentlyPlaying.name}" to "${soundToPlay.name}".`
          );
          return await executeManualCrossfade(playlist, currentlyPlaying, soundToPlay, "manual-select");
        }
      }

      return await wrapped.call(playlist, soundToPlay, ...args);
    },
    "MIXED"
  );
}

export function registerPlaylistAdvanceWrappers() {
  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.playNext",
    async function (wrapped, ...args) {
      const playlist = this;
      debug(`[playNext MIXED] Advancing playlist "${playlist.name}".`);

      if (Flags.getPlaybackMode(playlist).soundscape) {
        debug(`[Soundscape] playNext no-op for "${playlist.name}".`);
        return;
      }

      const useCrossfade = Flags.getPlaybackMode(this).crossfade;
      const fadeMs = Flags.getCrossfadeDuration(this);

      if (this.isOwner && useCrossfade && fadeMs > 0 && isSequentialOrShuffle(this)) {
        const [soundId = null, options = {}] = args;
        const direction = Number(options?.direction) === -1 ? -1 : 1;
        const currentForCrossfade = getCurrentCrossfadeSource(this);
        if (currentForCrossfade?.sound) {
          const incomingSound = getManualCrossfadeTarget(
            this,
            currentForCrossfade,
            soundId,
            direction
          );
          const label = direction === -1 ? "prev" : "next";

          if (incomingSound) {
            debug(
              `[CF-${label}] Manual ${label} true crossfade from "${currentForCrossfade.name}" to "${incomingSound.name}".`
            );
            return await executeManualCrossfade(
              this,
              currentForCrossfade,
              incomingSound,
              `manual-${label}`
            );
          }

          debug(
            `[CF-${label}] No distinct ${label} crossfade target for "${currentForCrossfade.name}"; falling back to native playNext.`
          );
        }
      }

      await cleanupPlaylistState(this, {
        cleanSilence: false,
        cleanCrossfade: true,
        cleanLoopers: true,
        cleanSoundscape: false,
        allowFadeOut: true,
      });

      return await wrapped(...args);
    },
    "MIXED"
  );

  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.playAll",
    async function (wrapped, ...args) {
      debugPlaybackTrace("playAll called", this, {
        mode: Flags.getPlaybackMode(this).effective,
        args,
      });
      State.clearStoppingFlag(this);
      if (Flags.getPlaybackMode(this).soundscape) {
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
            "no playable soundscape tracks are configured."
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

      AudioTimeout.wait(0).then(() => {
        let first = this.sounds.find((s) => s.playing);
        if (Array.isArray(first)) first = first.pop();
        if (first) {
          const loopScheduled = scheduleLoopWithin(first);
          if (!loopScheduled) scheduleCrossfade(this, first);
        }
      });
      return result;
    },
    "MIXED"
  );

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
}
