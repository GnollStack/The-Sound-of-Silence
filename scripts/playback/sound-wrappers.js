/**
 * @file sound-wrappers.js
 * @description Audio-level Foundry wrappers for playback, pause, sync, and volume updates.
 */
import {
  cancelActiveFade,
  releaseFadeInReservation,
  reserveFadeIn,
  scheduleEndOfTrackFade,
} from "../audio-fader.js";
import { cancelCrossfade, scheduleCrossfade } from "../cross-fade.js";
import { applyFadeIn } from "../fade-in.js";
import { Flags } from "../flag-service.js";
import {
  cancelLoopWithin,
  pauseLoopWithin,
  resumeLoopWithin,
  scheduleLoopWithin,
} from "../internal-loop.js";
import { PlaybackClock } from "../playback-clock.js";
import {
  cancelCrossfadePreload,
  scheduleCrossfadePreload,
} from "./preload-coordinator.js";
import { settleCrossfadeSession } from "./transition-session.js";
import { State } from "../state-manager.js";
import { AdvancedShuffle } from "../advanced-shuffle.js";
import { patchSilenceGapMediaClock } from "../silence.js";
import {
  debug,
  ensureAudioContext,
  findPlaylistSoundForSound,
  MODULE_ID,
  safeStop,
} from "../utils.js";

const SKIP_INTRO_DECLICK_MS = 10;

function getPlaybackStartState(playlistSound, sound) {
  const rawMediaPausedTime = sound?.pausedTime;
  const mediaPausedTime = Number(rawMediaPausedTime);
  if (
    rawMediaPausedTime !== null &&
    rawMediaPausedTime !== undefined &&
    Number.isFinite(mediaPausedTime) &&
    mediaPausedTime >= 0
  ) {
    return { isResume: true, offset: mediaPausedTime, useNativeMediaOffset: true };
  }

  const rawDocumentPausedTime = playlistSound?.pausedTime;
  const documentPausedTime = Number(rawDocumentPausedTime);
  if (Number.isFinite(documentPausedTime) && documentPausedTime > 0) {
    return { isResume: true, offset: documentPausedTime, useNativeMediaOffset: false };
  }

  const pausedLooper = State.getActiveLooper(playlistSound);
  if (pausedLooper?.pausedSnapshot) {
    const snapshotOffset = Number(pausedLooper.pausedSnapshot.activeOffset);
    const offset = rawDocumentPausedTime !== null &&
      rawDocumentPausedTime !== undefined &&
      Number.isFinite(documentPausedTime) &&
      documentPausedTime >= 0
      ? documentPausedTime
      : (Number.isFinite(snapshotOffset) && snapshotOffset >= 0 ? snapshotOffset : 0);
    return { isResume: true, offset, useNativeMediaOffset: false };
  }

  return { isResume: false, offset: null, useNativeMediaOffset: false };
}

function getInitialLoopPlaybackOffset(playlistSound, options = {}, { isResume = false } = {}) {
  if (isResume) return null;
  if (options?.offset !== undefined && options?.offset !== null) return null;

  const loopConfig = Flags.getLoopConfig(playlistSound);
  if (!Flags.isLoopConfigActive(loopConfig) || loopConfig.startFromBeginning !== false) {
    return null;
  }

  const offset = Number(loopConfig.segments?.[0]?.startSec);
  return Number.isFinite(offset) && offset >= 0 ? offset : null;
}

function getStartedPlaybackOffset(sound, fallbackOffset) {
  const contextTime = sound?.context?.currentTime;
  const startTime = sound?.startTime;
  // Check the raw numbers: null clock fields must not become a zero start.
  if (!Number.isFinite(contextTime) || !Number.isFinite(startTime)) return fallbackOffset;
  const offset = contextTime - startTime;
  return Number.isFinite(offset) && offset >= 0 ? offset : fallbackOffset;
}

function _handleShuffleOnPlay(ps, sound, { isResume = false } = {}) {
  if (Flags.getSoundFlag(ps, "isSilenceGap")) {
    patchSilenceGapMediaClock(ps, sound);
    return;
  }
  if (ps.parent?.mode === CONST.PLAYLIST_MODES.SHUFFLE && !isResume) {
    debug(
      `[Shuffle] Marking track as played via Sound.play wrapper: "${ps.name}"`
    );
    AdvancedShuffle.markTrackPlayed(ps.parent, ps);
  }
}

function _consumeFadeInDuration(ps) {
  const fadeOverride = ps?._sos_fadeInOverride;
  if (typeof fadeOverride !== "undefined") delete ps._sos_fadeInOverride;

  const configured = typeof fadeOverride === "number"
    ? fadeOverride
    : Flags.getPlaylistFlag(ps?.parent, "fadeIn");
  const duration = Number(configured);
  // Same half-track cap Foundry applies to its own fades, so a fade-in cannot
  // still be rising when the end-of-track fade or crossfade starts.
  return Flags.getEffectiveFadeDuration(Number.isFinite(duration) ? Math.max(0, duration) : 0, ps);
}

function _getStartupFadeDuration(ps, configuredFadeInMs, {
  fromCrossfade = false,
  initialLoopStart = null,
  isResume = false,
} = {}) {
  if (
    fromCrossfade ||
    isResume ||
    Flags.getSoundFlag(ps, "isSilenceGap")
  ) return 0;

  if (configuredFadeInMs > 0) return configuredFadeInMs;
  return Number(initialLoopStart?.offset) > 0 ? SKIP_INTRO_DECLICK_MS : 0;
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
  // A fade on another track does not block this document's sync: sync() only
  // touches this document's own media, and the wrapper below already defers
  // while that media is fading.
  if (!ps.playing || ps.sound?.playing) return false;

  return playlist.sounds.some((sound) =>
    sound.id !== ps.id &&
    sound.playing &&
    !Flags.getSoundFlag(sound, "isSilenceGap")
  );
}

function _preparePauseSync(ps) {
  const pausedTime = Number(ps?.pausedTime);
  const isPausedUpdate =
    ps?.playing === false &&
    ps?.pausedTime !== null &&
    Number.isFinite(pausedTime);
  if (!isPausedUpdate) return false;

  pauseLoopWithin(ps);
  cancelCrossfade(ps.parent);
  cancelCrossfadePreload(ps.parent, {
    sourceSoundId: ps.id,
    reason: "paused",
  });

  const pendingFade = State.getEndOfTrackFade(ps);
  if (pendingFade) {
    pendingFade.cancel?.();
    State.clearEndOfTrackFade(ps);
  }

  if (ps.sound) cancelActiveFade(ps.sound);
  settleCrossfadeSession(ps.parent, {
    mode: "pause",
    reason: "document pause:" + ps.id,
  }).catch((err) => {
    debug(`[Pause] Failed to settle crossfade for "${ps.name}":`, err?.message ?? err);
  });
  return true;
}

function _prepareStopSync(ps) {
  const isStopUpdate =
    ps?.playing === false &&
    (ps?.pausedTime === null || ps?.pausedTime === undefined);
  if (!isStopUpdate) return false;

  const looper = State.getActiveLooper(ps);
  if (!looper) return false;

  // A plain document stop (direct selection of another track, Play All, a
  // Simultaneous single-track stop, or their replication) reaches native
  // sync without any playlist command cleaning up loop state. The looper
  // must not promote a pending handoff buffer under the newly selected track.
  debug(`[Sync] Cancelling internal loop for stopped "${ps.name}".`);
  cancelLoopWithin(ps, { quiet: true, preservePlayback: false, allowFadeOut: true });

  // Release this media's fade ownership so native sync stops it with
  // Foundry's own fade instead of the fade guard leaving it running.
  if (ps.sound && !State.isPlaylistStopping(ps.parent)) cancelActiveFade(ps.sound);
  return true;
}

function _schedulePostPlayActions(ps, sound, {
  fadeInMs = 0,
  fromCrossfade = false,
  initialLoopStart = null,
  isResume = false,
  playbackOffset = null,
  startupFadeToken = null,
  targetVolume = null,
} = {}) {
  const playlist = ps.parent;
  const tokenWasOvertaken = startupFadeToken &&
    !State.isCurrentFadeToken(sound, startupFadeToken);
  const lifecycleWasOvertaken =
    State.isPlaylistStopping(playlist) ||
    State.isPlaylistCrossfading(playlist);
  if (!fromCrossfade && (
    lifecycleWasOvertaken ||
    ps?.playing !== true ||
    ps?.sound !== sound ||
    sound?.playing !== true
  )) {
    releaseFadeInReservation(sound, startupFadeToken);
    const pendingFade = State.getEndOfTrackFade(ps);
    if (pendingFade) {
      pendingFade.cancel?.();
      State.clearEndOfTrackFade(ps);
    }
    if (sound?.playing) safeStop(sound, "stale document post-play");
    debug(`[PostPlay] Skipping post-play actions for "${ps.name}" because its playback generation is no longer current.`);
    return;
  }

  if (!fromCrossfade && tokenWasOvertaken) {
    // A newer fade may legitimately have claimed the same live Sound while
    // native play was pending. Do not stop it or schedule the stale startup
    // curve; retain ordinary clock/loop work and let the newer owner control
    // gain until its own token clears.
    releaseFadeInReservation(sound, startupFadeToken);
    startupFadeToken = null;
    fadeInMs = 0;
    debug(`[PostPlay] Startup fade for "${ps.name}" was superseded by a newer fade owner.`);
  }

  // The temporary silence document is a wall-clock marker, not a real
  // playlist track. Its lifecycle is owned entirely by silence.js.
  if (Flags.getSoundFlag(ps, "isSilenceGap")) {
    releaseFadeInReservation(sound, startupFadeToken);
    return;
  }

  if (fadeInMs > 0 && !isResume && !fromCrossfade) {
    applyFadeIn(playlist, ps, {
      durationMs: fadeInMs,
      sound,
      startupToken: startupFadeToken,
      targetVolume,
    }).catch((err) => {
      debug(`[FadeIn] Error during fade-in for "${ps.name}":`, err?.message ?? err);
    });
  } else {
    releaseFadeInReservation(sound, startupFadeToken);
  }

  const loopConfig = Flags.getLoopConfig(ps);
  const playbackMode = Flags.getPlaybackMode(playlist);
  let loopScheduled = false;

  PlaybackClock.record(playlist, ps, sound, {
    reason: fromCrossfade ? "crossfade playback" : (isResume ? "resume" : "play"),
    offsetSec: playbackOffset,
    force: isResume,
  }).catch((err) => {
    debug(`[Clock] Failed to record playback clock for "${ps.name}":`, err?.message ?? err);
  });

  if (isResume) {
    debug(`[Sound.play WRAPPER] Resuming loop for "${ps.name}".`);
    resumeLoopWithin(ps);
  } else {
    cancelLoopWithin(ps, { quiet: true, restorePlaybackHandlers: false });
    loopScheduled = scheduleLoopWithin(ps, { initialLoopStart });
  }

  // On resume, a looper that already retired (all segments finished) no
  // longer owns the end of the track even though its config is still active;
  // the normal crossfade or end-of-track fade must be re-armed for it.
  const resumedLooper = isResume ? State.getActiveLooper(ps) : null;
  const loopOwnsPlayback = isResume
    ? !!resumedLooper && !resumedLooper.isDestroyed
    : (loopScheduled || Flags.isLoopConfigActive(loopConfig));

  if (playbackMode.crossfade) {
    if (loopOwnsPlayback) {
      debug(`[PostPlay] Skipping playlist crossfade schedule for "${ps.name}" - internal loop owns playback.`);
    } else {
      scheduleCrossfade(playlist, ps, { force: isResume });
      scheduleCrossfadePreload(playlist, ps);
    }

    if (typeof ps._cancelFadeOut === "function") {
      ps._cancelFadeOut();
      debug(`[PostPlay] Cancelled Foundry _scheduleFadeOut for "${ps.name}" - SoS crossfade active.`);
    }
  }

  if (!loopOwnsPlayback && !playbackMode.crossfade && !ps.repeat) {
    scheduleEndOfTrackFade(ps);
  }

  if ((fadeInMs <= 0 || isResume) && !State.isSoundFading(sound) && !fromCrossfade) {
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
    "foundry.audio.Sound.prototype.stop",
    function (wrapped, ...args) {
      if (this?.gain || State.isSoundFading(this)) {
        try {
          cancelActiveFade(this);
        } catch (err) {
          debug(`[Sound.stop WRAPPER] Failed to cancel active fade before stop:`, err?.message ?? err);
        }
      }
      return wrapped.call(this, ...args);
    },
    "WRAPPER"
  );

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

      const fromCrossfade = !!options?._fromCrossfade;
      // Native load({autoplay:true}) may finish after a Stop update. Reject
      // that delayed first start before Foundry creates an audible pipeline.
      if (!fromCrossfade && ps.playing !== true) {
        if (this.playing) await safeStop(this, "stopped document before native play");
        return this;
      }

      const playbackStart = getPlaybackStartState(ps, this);
      _handleShuffleOnPlay(ps, this, playbackStart);
      const configuredFadeInMs = _consumeFadeInDuration(ps);

      const initialLoopOffset = getInitialLoopPlaybackOffset(ps, options, playbackStart);
      const initialLoopStart = initialLoopOffset === null ? null : {
        sound: this,
        offset: initialLoopOffset,
        segmentIndex: 0,
      };
      if (initialLoopStart) {
        debug(
          `[Sound.play WRAPPER] Starting "${ps.name}" at its first internal-loop segment (${initialLoopOffset.toFixed(3)}s).`
        );
        options = { ...options, offset: initialLoopOffset };
      }

      let fadeInMs = 0;
      let startupFadeToken = null;
      let targetVolume = null;
      if (!fromCrossfade) {
        targetVolume = Flags.resolveTargetVolume(ps);
        fadeInMs = _getStartupFadeDuration(ps, configuredFadeInMs, {
          fromCrossfade,
          initialLoopStart,
          isResume: playbackStart.isResume,
        });
        if (fadeInMs > 0) {
          startupFadeToken = reserveFadeIn(this, {
            duration: fadeInMs,
            targetVol: targetVolume,
          });
          if (!startupFadeToken) {
            debug(`[FadeIn] Startup ownership unavailable for "${ps.name}"; leaving the active fade owner unchanged.`);
            fadeInMs = 0;
          }
        }

        if (!startupFadeToken && !State.isSoundFading(this)) {
          this.volume = targetVolume;
        }

        const playOffset = options?.offset ?? (
          playbackStart.isResume
            ? (playbackStart.useNativeMediaOffset ? undefined : playbackStart.offset)
            : 0
        );
        options = {
          ...options,
          ...(startupFadeToken ? { volume: 0 } : {}),
          ...(!startupFadeToken && !State.isSoundFading(this) ? { volume: targetVolume } : {}),
          offset: playOffset,
        };
      }

      // Retain the classified position for Sound implementations which do
      // not expose the native start clock after playback begins.
      const fallbackPlaybackOffset = options?.offset ?? playbackStart.offset;
      let result;
      try {
        result = await wrapped.call(this, options);
      } catch (err) {
        releaseFadeInReservation(this, startupFadeToken);
        throw err;
      }

      try {
        // Native v14 adds finite pausedTime even to an explicit offset and
        // can clamp the result to its playback bounds. Its startTime records
        // that effective position; use it without changing native options or
        // trusting a streamed media currentTime which may still report zero.
        const playbackOffset = getStartedPlaybackOffset(this, fallbackPlaybackOffset);
        _schedulePostPlayActions(ps, this, {
          fadeInMs,
          fromCrossfade,
          initialLoopStart,
          isResume: playbackStart.isResume,
          playbackOffset,
          startupFadeToken,
          targetVolume,
        });
      } catch (err) {
        releaseFadeInReservation(this, startupFadeToken);
        throw err;
      }

      return result;
    },
    // Stale autoplay is intentionally suppressed without calling wrapped.
    // WRAPPER requires unconditional chaining and unregisters violations.
    "MIXED"
  );

  libWrapper.register(
    MODULE_ID,
    "foundry.audio.Sound.prototype.pause",
    function (wrapped, options = {}) {
      const ps = findPlaylistSoundForSound(this);

      if (ps instanceof PlaylistSound) {
        pauseLoopWithin(ps);
        cancelCrossfade(ps.parent);
        cancelCrossfadePreload(ps.parent, {
          sourceSoundId: ps.id,
          reason: "paused",
        });
        cancelActiveFade(this);
      }
      const result = wrapped.call(this, options);
      if (ps instanceof PlaylistSound) {
        settleCrossfadeSession(ps.parent, {
          mode: "pause",
          reason: "direct media pause:" + ps.id,
        }).catch((err) => {
          debug(`[Pause] Failed to settle direct crossfade pause for "${ps.name}":`, err?.message ?? err);
        });
      }
      return result;
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
          // Normalization itself writes through updateEmbeddedDocuments, which
          // never reaches this instance wrapper, so every volume change seen
          // here is a manual one.
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

      return wrapped.call(this, data, options);
    },
    "MIXED"
  );

  libWrapper.register(
    MODULE_ID,
    "PlaylistSound.prototype.sync",
    function (wrapped) {
      _preparePauseSync(this);
      _prepareStopSync(this);
      if (
        Flags.getPlaybackMode(this.parent).soundscape &&
        Flags.getSoundFlag(this, "isProcedural")
      ) {
        if (this.sound?.playing) {
          safeStop(this.sound, "soundscape procedural sync guard");
        }
        return;
      }
      const startupFadeToken = State.getFadeToken(this.sound);
      if (this.playing === false && startupFadeToken?.type === "fade-in-start") {
        cancelActiveFade(this.sound);
      }
      if (_shouldDeferSyncForCrossfade(this)) {
        debug(`[Sync Guard] Blocked sync() for "${this.name}" - SoS crossfade owns playback`);
        return;
      }
      if (this.sound && State.isSoundFading(this.sound)) {
        debug(`[Sync Guard] Blocked sync() for "${this.name}" - SoS fade curve active`);
        return;
      }
      const wasPlayingBeforeSync = this.sound?.playing === true;
      const result = wrapped();
      if (wasPlayingBeforeSync && this.sound?.playing && !State.isSoundFading(this.sound)) {
        this.sound.volume = Flags.resolveTargetVolume(this);
      }
      return result;
    },
    "MIXED"
  );
}
