/**
 * @file sound-wrappers.js
 * @description Audio-level Foundry wrappers for playback, pause, sync, and volume updates.
 */
import {
  scheduleEndOfTrackFade,
} from "../audio-fader.js";
import { scheduleCrossfade } from "../cross-fade.js";
import { applyFadeIn } from "../fade-in.js";
import { Flags } from "../flag-service.js";
import {
  cancelLoopWithin,
  pauseLoopWithin,
  resumeLoopWithin,
  scheduleLoopWithin,
} from "../internal-loop.js";
import { PlaybackClock } from "../playback-clock.js";
import { State } from "../state-manager.js";
import { AdvancedShuffle } from "../advanced-shuffle.js";
import {
  debug,
  ensureAudioContext,
  findPlaylistSoundForSound,
  MODULE_ID,
  safeStop,
} from "../utils.js";

function isFreshPlaybackStart(playlistSound) {
  return !Number(playlistSound?.pausedTime);
}

function _handleShuffleOnPlay(ps) {
  if (ps.parent?.mode === CONST.PLAYLIST_MODES.SHUFFLE && !ps.pausedTime) {
    debug(
      `[Shuffle] Marking track as played via Sound.play wrapper: "${ps.name}"`
    );
    AdvancedShuffle.markTrackPlayed(ps.parent, ps);
  }
}

function _applyPreMute(sound, ps, fadeInMs, targetVolume) {
  if (fadeInMs > 0 && isFreshPlaybackStart(ps)) {
    sound.volume = 0;
  } else {
    sound.volume = targetVolume;
  }
}

function _isSequentialOrShuffle(playlist) {
  return [
    CONST.PLAYLIST_MODES.SEQUENTIAL,
    CONST.PLAYLIST_MODES.SHUFFLE,
  ].includes(playlist?.mode);
}

function _shouldDeferSyncForCrossfade(ps) {
  const playlist = ps?.parent;
  if (!playlist || !_isSequentialOrShuffle(playlist)) return false;
  if (!Flags.getPlaybackMode(playlist).crossfade) return false;
  if (State.isPlaylistCrossfading(playlist)) return true;
  if (!ps.playing || ps.sound?.playing) return false;

  return playlist.sounds.some((sound) =>
    sound.id !== ps.id &&
    sound.playing &&
    !Flags.getSoundFlag(sound, "isSilenceGap")
  );
}

function _schedulePostPlayActions(ps, sound, { fromCrossfade = false } = {}) {
  const playlist = ps.parent;
  const isResume = Number.isFinite(ps.pausedTime);
  const resumeOffset = isResume ? Number(ps.pausedTime) : null;
  const loopConfig = Flags.getLoopConfig(ps);
  const playbackMode = Flags.getPlaybackMode(playlist);
  let loopScheduled = false;

  PlaybackClock.record(playlist, ps, sound, {
    reason: fromCrossfade ? "crossfade playback" : (isResume ? "resume" : "play"),
    offsetSec: resumeOffset,
    force: isResume,
  }).catch((err) => {
    debug(`[Clock] Failed to record playback clock for "${ps.name}":`, err?.message ?? err);
  });

  if (isResume) {
    debug(`[Sound.play WRAPPER] Resuming loop for "${ps.name}".`);
    resumeLoopWithin(ps);
  } else {
    cancelLoopWithin(ps, { quiet: true, restorePlaybackHandlers: false });
    loopScheduled = scheduleLoopWithin(ps);
  }

  const fadeInOverride = typeof ps?._sos_fadeInOverride === "number" ? ps._sos_fadeInOverride : null;
  const fadeInMs = fadeInOverride ?? Flags.getPlaylistFlag(playlist, "fadeIn");
  if (fadeInMs > 0 && !ps?.getFlag(MODULE_ID, "isSilenceGap") && !fromCrossfade) {
    const targetVolume = Flags.resolveTargetVolume(ps);
    applyFadeIn(playlist, ps, { targetVolume }).catch((err) => {
      debug(`[FadeIn] Error during fade-in for "${ps.name}":`, err.message);
    });
  }

  if (playbackMode.crossfade) {
    if (loopScheduled || Flags.isLoopConfigActive(loopConfig)) {
      debug(`[PostPlay] Skipping playlist crossfade schedule for "${ps.name}" - internal loop owns playback.`);
    } else {
      scheduleCrossfade(playlist, ps, { force: isResume });
    }

    if (typeof ps._cancelFadeOut === "function") {
      ps._cancelFadeOut();
      debug(`[PostPlay] Cancelled Foundry _scheduleFadeOut for "${ps.name}" - SoS crossfade active.`);
    }
  }

  if (!Flags.isLoopConfigActive(loopConfig) && !playbackMode.crossfade && !ps.repeat) {
    scheduleEndOfTrackFade(ps);
  }

  if ((fadeInMs <= 0 || !isFreshPlaybackStart(ps)) && !State.isSoundFading(sound) && !fromCrossfade) {
    const target = Flags.resolveTargetVolume(ps);
    if (Math.abs(sound.volume - target) > 0.001) {
      debug(`[Sound.play] Post-schedule volume correction: ${sound.volume.toFixed(3)} -> ${target.toFixed(3)} for "${ps.name}"`);
      sound.volume = target;
    }
  }
}

export function registerSoundPlaybackWrappers() {
  libWrapper.register(
    MODULE_ID,
    "foundry.audio.Sound.prototype.play",
    async function (wrapped, options = {}) {
      ensureAudioContext();

      if (options?._fromLoop || options?._sosProceduralOneShot) {
        return wrapped.call(this, options);
      }
      const ps = findPlaylistSoundForSound(this);
      if (!(ps instanceof PlaylistSound)) {
        return wrapped.call(this, options);
      }

      _handleShuffleOnPlay(ps);

      if (!options?._fromCrossfade) {
        const targetVolume = Flags.resolveTargetVolume(ps);
        const fadeInMs = Flags.getPlaylistFlag(ps.parent, "fadeIn");
        const isFreshPlay = isFreshPlaybackStart(ps);
        const resumeOffset = !isFreshPlay && Number.isFinite(Number(ps.pausedTime))
          ? Number(ps.pausedTime)
          : null;
        const preMuteVolume = (fadeInMs > 0 && isFreshPlay) ? 0 : targetVolume;
        _applyPreMute(this, ps, fadeInMs, targetVolume);

        const playOffset = options?.offset ?? (isFreshPlay ? 0 : (resumeOffset ?? undefined));
        options = { ...options, volume: preMuteVolume, offset: playOffset };
      }

      const result = await wrapped.call(this, options);

      _schedulePostPlayActions(ps, this, { fromCrossfade: !!options?._fromCrossfade });

      return result;
    },
    "WRAPPER"
  );

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

  libWrapper.register(
    MODULE_ID,
    "PlaylistSound.prototype.update",
    async function (wrapped, data, options = {}) {
      const hasVolumeChange = data.hasOwnProperty("volume");
      const allowOverridePath = `flags.${MODULE_ID}.allowVolumeOverride`;
      const temporaryOverridePath = `flags.${MODULE_ID}.normalizedVolumeOverride`;
      const hasFlatAllowOverrideChange = Object.prototype.hasOwnProperty.call(
        data,
        allowOverridePath
      );
      const hasNestedAllowOverrideChange = foundry.utils.hasProperty(
        data,
        allowOverridePath
      );
      const hasAllowOverrideChange =
        hasFlatAllowOverrideChange || hasNestedAllowOverrideChange;
      const nestedModuleFlags = data?.flags?.[MODULE_ID];
      const nextAllowOverride = hasAllowOverrideChange
        ? Boolean(
            hasFlatAllowOverrideChange
              ? data[allowOverridePath]
              : nestedModuleFlags?.allowVolumeOverride
          )
        : null;

      if (hasAllowOverrideChange) {
        data = {
          ...data,
          [temporaryOverridePath]: null,
        };
      }

      if (hasVolumeChange) {
        const playlist = this.parent;

        const normEnabled = Flags.getPlaylistFlag(
          playlist,
          "volumeNormalizationEnabled"
        );
        const hasOverride = Flags.getSoundFlag(this, "allowVolumeOverride");
        const nextHasOverride = hasAllowOverrideChange
          ? nextAllowOverride
          : hasOverride;

        if (normEnabled && !nextHasOverride) {
          const isFromNormalization = options._fromNormalization;

          if (!isFromNormalization) {
            if (game.user?.isGM && playlist?.isOwner) {
              const normalizedVolume = Flags.getPlaylistFlag(
                playlist,
                "normalizedVolume"
              );
              debug(
                `[Volume] Saving temporary normalized track volume for "${this.name}" until playlist volume changes`
              );

              return wrapped.call(
                this,
                {
                  ...data,
                  [temporaryOverridePath]: normalizedVolume,
                },
                options
              );
            }

            debug(
              `[Volume] Blocking manual volume change on "${this.name}" - normalization active`
            );

            if (this.sound && !State.isSoundFading(this.sound)) {
              this.sound.volume = data.volume;
            } else if (this.sound) {
              debug(
                `[Volume] Skipping temporary volume preview for "${this.name}" - fade active`
              );
            }

            const newData = { ...data };
            delete newData.volume;

            if (Object.keys(newData).length === 0) {
              debug(
                "[Volume] Only volume changed (blocked), no database update needed"
              );
              return this;
            }

            return wrapped.call(this, newData, options);
          }
        }
      }

      return wrapped.call(this, data, options);
    },
    "MIXED"
  );

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
      if (_shouldDeferSyncForCrossfade(this)) {
        debug(`[Sync Guard] Blocked sync() for "${this.name}" - SoS crossfade owns playback`);
        return;
      }
      if (this.sound && State.isSoundFading(this.sound)) {
        debug(`[Sync Guard] Blocked sync() for "${this.name}" - SoS fade curve active`);
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
}
