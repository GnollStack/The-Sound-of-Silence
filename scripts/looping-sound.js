// looping-sound.js
import { advancedFade, cancelActiveFade, equalPowerCrossfade, fadeOutAndStop } from "./audio-fader.js";
import { normalizeNonNegativeNumber } from "./core-helpers.js";
import { maybeLoopPlaylist } from "./playlist-loop.js";
import { performCrossfade } from "./cross-fade.js";
import { Silence } from "./silence.js";
import { Flags } from "./flag-service.js";
import { MODULE_ID, toSec, debug, waitForMedia, formatTime, logFeature, LogSymbols, PlaylistActionAuthority, safeStop, safeCancelTimer, error } from "./utils.js";
import { State } from "./state-manager.js";
import { getPlayableSoundsInOrder } from "./playlist/playable-order.js";

const AudioTimeout = foundry.audio.AudioTimeout;

// Constants for hardwired numbers, get these in the right spots
const POSITION_CHECK_INTERVAL = 50;    // ms between checks
const POSITION_CHECK_MAX_ATTEMPTS = 40;
const SEGMENT_POSITION_EPSILON = 0.01;
const PRELOAD_WINDOW = 0.5;            // seconds before crossfade
const HANDOFF_BUFFER = 50;             // ms buffer after crossfade

function getSegmentLabel(segment, index = 0) {
  const safeIndex = Number(index);
  const fallback = `Loop Segment ${Number.isFinite(safeIndex) && safeIndex >= 0 ? safeIndex + 1 : 1}`;
  const text = String(segment?.label ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}



export class LoopingSound {
  constructor(playlistSound, config, { initialLoopStart = null } = {}) {
    this.ps = playlistSound;
    // The config is now guaranteed to be clean, validated, and migrated.
    this.config = config;

    this.soundA = null;
    this.soundB = null;
    this.isA_Active = true;

    this.isDestroyed = false;
    this.isCrossfading = false;
    this.activeLoopSegment = null;
    this.loopsCompleted = 0;
    this._metricsLoopActive = false;

    this.mainSchedule = null;
    this.handoffTimer = null;
    this.loopCrossfadeTimer = null;
    this.finalTransitionTimer = null;
    this.pausedSnapshot = null;
    this._preservePlaybackOnAbort = false;
    this._handoffGeneration = 0;
    this._activeLoopOperation = null;
    this.initialLoopStart = initialLoopStart;

    this.wasRestarted = false; // track whether the initial offset needs a short scheduling settle
  }

  _setActiveLoopSegment(segment) {
    if (this.activeLoopSegment === segment) return;
    this.activeLoopSegment = segment;
    State.notifyStateChanged();
  }

  _setCrossfading(isCrossfading) {
    if (this.isCrossfading === isCrossfading) return;
    this.isCrossfading = isCrossfading;
    State.notifyStateChanged();
  }

  _recordLoopSessionEnd({ completed = true } = {}) {
    if (!this._metricsLoopActive) return;
    State.recordLoopEnd({ completed });
    this._metricsLoopActive = false;
  }

  _unregisterIfCurrent() {
    if (State.getActiveLooper(this.ps) === this) {
      State.clearActiveLooper(this.ps);
    }
  }

  _beginLoopOperation(reason) {
    const previousOperation = this._activeLoopOperation;
    if (previousOperation) previousOperation.superseded = true;

    const operation = {
      generation: ++this._handoffGeneration,
      reason,
      targetSound: null,
      supersededTargetSound: previousOperation?.targetSound ?? null,
      superseded: false,
    };
    this._activeLoopOperation = operation;
    return operation;
  }

  _ownsLoopOperation(operation) {
    return Boolean(
      operation &&
      !operation.superseded &&
      this._activeLoopOperation === operation &&
      this._handoffGeneration === operation.generation
    );
  }

  _completeLoopOperation(operation) {
    if (!this._ownsLoopOperation(operation)) return false;
    operation.completed = true;
    this._activeLoopOperation = null;
    return true;
  }

  _invalidateLoopOperation() {
    if (this._activeLoopOperation) this._activeLoopOperation.superseded = true;
    this._activeLoopOperation = null;
    this._handoffGeneration++;
  }

  _stopLoopOperationTarget(operation, targetSound, context) {
    if (!targetSound) return false;

    const currentOperation = this._activeLoopOperation;
    if (
      currentOperation &&
      currentOperation !== operation &&
      this._ownsLoopOperation(currentOperation) &&
      currentOperation.targetSound === targetSound
    ) return false;

    // A replacement operation may already have promoted a shared target and
    // completed before an older await resumes. Never stop the live buffer.
    if (
      !this._ownsLoopOperation(operation) &&
      this.activeSound === targetSound &&
      this.ps?.sound === targetSound
    ) return false;

    safeStop(targetSound, context);
    return true;
  }

  get activeSound() {
    return this.isA_Active ? this.soundA : this.soundB;
  }

  get targetSound() {
    return this.isA_Active ? this.soundB : this.soundA;
  }

  _findSegmentAtPosition(position) {
    const currentTime = Number(position);
    if (!Number.isFinite(currentTime)) return null;
    return this.config.segments.find((segment) =>
      currentTime >= Number(segment.startSec) - SEGMENT_POSITION_EPSILON &&
      currentTime < Number(segment.endSec)
    ) ?? null;
  }

  _armFromCurrentPosition() {
    const segment = this._findSegmentAtPosition(this.activeSound?.currentTime);
    if (segment) {
      debug(
        `[LoopingSound] Adopting live position ${Number(this.activeSound.currentTime).toFixed(2)}s inside "${getSegmentLabel(segment, this.config.segments.indexOf(segment))}".`
      );
      this._handleLoopTrigger(segment);
      return true;
    }

    this._armNextTimer();
    return false;
  }


  async start() {
    debug(`[LoopingSound] Initializing for "${this.ps.name}" with ${this.config.segments.length} segments.`);

    try {
      this.soundA = await waitForMedia(this.ps);
      if (!this.soundA) throw new Error("Could not get initial sound object.");

      debug(`[LoopingSound] Deferring soundB pre-load until needed (memory optimization).`);

      if (this.isDestroyed) {
        if (!this._preservePlaybackOnAbort) {
          safeStop(this.soundA, "LoopingSound initialization aborted");
        }
        this.soundA = null;
        this._unregisterIfCurrent();
        return false;
      }
    } catch (err) {
      error("[LoopingSound] Failed to load sound for looping:", err);
      // A failed start must relinquish runtime ownership so playback recovery
      // and a later retry are not blocked by a zombie looper entry.
      this.isDestroyed = true;
      this._unregisterIfCurrent();
      return false;
    }

    // When the intro is skipped, the Sound.play wrapper starts the original
    // media at the first segment. Adopt that Sound instead of starting a
    // second full-volume instance and hard-stopping the first one.
    if (!this.config.startFromBeginning && this.config.segments.length > 0) {
      const firstSeg = this.config.segments[0];
      const initialLoopStart = this.initialLoopStart;
      this.initialLoopStart = null;
      const descriptorMatches = Boolean(
        initialLoopStart &&
        initialLoopStart.sound === this.soundA &&
        Number(initialLoopStart.segmentIndex) === 0 &&
        Math.abs(Number(initialLoopStart.offset) - Number(firstSeg.startSec)) <= SEGMENT_POSITION_EPSILON
      );

      if (!descriptorMatches) {
        debug(
          `[LoopingSound] No matching skip-intro startup descriptor; preserving the caller's live position.`
        );
        this._armFromCurrentPosition();
        return !this.isDestroyed;
      }

      debug(`[LoopingSound] Adopting initial sound at first segment ${firstSeg.startSec}s.`);

      const waitForSegmentPosition = () => new Promise((resolve) => {
        let attempts = 0;

        const checkPosition = () => {
          if (this.isDestroyed) return resolve(false);
          if (!this.soundA?.playing) {
            debug(`[LoopingSound] Sound paused during position check, aborting`);
            return resolve(false);
          }

          const currentTime = Number(this.soundA.currentTime);
          if (this._findSegmentAtPosition(currentTime) === firstSeg) {
            logFeature(LogSymbols.LOOP, 'Loop', `Position ready @ ${currentTime.toFixed(2)}s`);
            debug(`[LoopingSound] Position ready at ${currentTime.toFixed(2)}s`);
            return resolve(true);
          }
          if (Number.isFinite(currentTime) && currentTime >= Number(firstSeg.endSec)) return resolve(false);
          if (++attempts >= POSITION_CHECK_MAX_ATTEMPTS) return resolve(false);

          AudioTimeout.wait(POSITION_CHECK_INTERVAL).then(checkPosition).catch(() => resolve(false));
        };
        checkPosition();
      });

      const positionReady = await waitForSegmentPosition();
      if (!this.isDestroyed && positionReady) {
        debug(`[LoopingSound] Initial segment position is ready, triggering loop.`);
        this.wasRestarted = true;
        this._handleLoopTrigger(firstSeg);
      } else if (!this.isDestroyed) {
        debug(`[LoopingSound] Initial segment position was not observed; arming from the live position.`);
        this._armFromCurrentPosition();
      }

      return !this.isDestroyed;
    }

    // Playback may already be inside a segment when delayed startup gets the
    // media. Adopt that segment without rewinding the intro or reviving one
    // whose end has passed; otherwise arm the next future segment.
    this._armFromCurrentPosition();
    return !this.isDestroyed;
  }

  /**
   * Creates a fresh, playable Sound instance for the upcoming crossfade.
   * This is critical for long, streaming sounds that get unloaded on stop.
   * @returns {Promise<Sound|null>} A newly loaded Sound object or null if destroyed.
   */
  async _prepareTargetSound(operation = this._activeLoopOperation) {
    if (this.isDestroyed || !this._ownsLoopOperation(operation)) return null;

    const activeWasA = this.isA_Active;
    const bufferName = activeWasA ? "soundB" : "soundA";
    const existingSound = activeWasA ? this.soundB : this.soundA;

    // Do not let two overlapping play/load operations share an incoming
    // buffer. The older operation must be free to stop its own stale target
    // without interrupting the replacement operation.
    if (
      existingSound &&
      !existingSound.failed &&
      existingSound !== operation.supersededTargetSound
    ) {
      operation.targetSound = existingSound;
      try {
        // Reload the sound if it was unloaded (happens for long streaming sounds)
        if (!existingSound.loaded) await existingSound.load();
      } catch (err) {
        if (this._ownsLoopOperation(operation)) {
          error("[LoopingSound] Failed to reload target sound:", err);
        }
        this._stopLoopOperationTarget(operation, existingSound, "failed target reload cleanup");
        return null;
      }

      if (!this._ownsLoopOperation(operation)) {
        this._stopLoopOperationTarget(operation, existingSound, "superseded target reload cleanup");
        return null;
      }

      debug(`[LoopingSound] ♻️ Reusing existing ${bufferName} (performance optimization)`);
      return existingSound;
    }

    // Create new Sound if there is no reusable buffer, or if that buffer is
    // still owned by the operation we just superseded.
    debug(`[LoopingSound] Creating fresh ${bufferName} instance...`);
    let newSound = null;

    try {
      newSound = new foundry.audio.Sound(this.ps.path);
      operation.targetSound = newSound;
      await newSound.load();

      if (!this._ownsLoopOperation(operation)) {
        this._stopLoopOperationTarget(operation, newSound, "superseded target load cleanup");
        return null;
      }

      newSound.addEventListener("end", this.ps._onEnd.bind(this.ps), { once: true });

      if (activeWasA) this.soundB = newSound;
      else this.soundA = newSound;

      debug(`[LoopingSound] ${bufferName} is ready.`);
      return newSound;

    } catch (err) {
      if (this._ownsLoopOperation(operation)) {
        error("[LoopingSound] Failed to prepare target sound:", err);
      }
      this._stopLoopOperationTarget(operation, newSound, "failed target preparation cleanup");
      return null;
    }
  }

  /**
 * Schedules a fade-out for the current active sound to play at the end of the track.
 * Called when the looper retires and the track should play to its natural end.
 */
  _scheduleFinalFadeOut() {
    this.isFadingOut = true;
    safeCancelTimer(this.finalTransitionTimer, `LoopingSound final transition timer for "${this.ps?.name}"`);
    this.finalTransitionTimer = null;
    const sound = this.activeSound;
    if (!sound || !sound.playing) return;

    const playlist = this.ps.parent;
    if (!playlist) return;

    // Use our centralized utility to get the true playback mode
    const mode = Flags.getPlaybackMode(playlist);
    const duration = sound.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;

    const currentTime = sound.currentTime;

    if (mode.crossfade) {
      let fadeMs = Flags.getCrossfadeDuration(playlist);

      if (fadeMs <= 0) return;

      const fadeStartTime = Math.max(0, duration - (fadeMs / 1000));

      if (currentTime < fadeStartTime) {
        debug(`[LoopingSound] Retiring: Scheduling final CROSSFADE at ${fadeStartTime.toFixed(2)}s for "${this.ps.name}"`);
        this.finalTransitionTimer = sound.schedule(() => {
          this.finalTransitionTimer = null;
          if (!sound.playing) return;
          debug(`[LoopingSound] 🔥 Triggering automatic crossfade for "${this.ps.name}"`);
          // Directly call the master crossfade function
          performCrossfade(playlist, this.ps);
        }, fadeStartTime);
      }

    } else {
      // This is the original logic for Silence or Default fade-out, which is still correct.
      let fadeMs = Number(playlist.fade) || 0;
      if (!mode.silence) {
        debug(`[LoopingSound] Using default fade-out: ${fadeMs}ms`);
      } else {
        debug(`[LoopingSound] Using Silence mode fade-out: ${fadeMs}ms`);
      }

      if (fadeMs <= 0) return;

      const fadeStartTime = Math.max(0, duration - (fadeMs / 1000));

      if (currentTime < fadeStartTime) {
        debug(`[LoopingSound] Retiring: Scheduling final FADE-OUT at ${fadeStartTime.toFixed(2)}s for "${this.ps.name}"`);
        this.finalTransitionTimer = sound.schedule(() => {
          this.finalTransitionTimer = null;
          if (!sound.playing) return;
          debug(`[LoopingSound] Starting final configured fade-out for "${this.ps.name}"`);
          advancedFade(sound, { targetVol: 0, duration: fadeMs });
        }, fadeStartTime);
      } else {
        const remainingTime = duration - currentTime;
        const adjustedFadeMs = Math.max(100, remainingTime * 1000);
        debug(`[LoopingSound] Starting immediate fade-out over ${adjustedFadeMs}ms (already past fade point)`);
        advancedFade(sound, { targetVol: 0, duration: adjustedFadeMs });
      }
    }
  }

  _armNextTimer() {
    if (this.loopingDisabled || this.pausedSnapshot) return; // Don't schedule while disabled or paused
    if (this.isDestroyed || !this.activeSound || this.isCrossfading) return;
    safeCancelTimer(this.mainSchedule, `LoopingSound main schedule for "${this.ps?.name}"`);

    const ct = Number(this.activeSound.currentTime);
    if (!Number.isFinite(ct)) {
      AudioTimeout.wait(100).then(() => this._armNextTimer());
      return;
    }

    // Find the next segment whose start time is after our current time
    const EPSILON = 0.01;
    const nextSegment = this.config.segments.find(seg => seg.startSec > ct + EPSILON);

    if (!nextSegment) {
      // No more segments to schedule - gracefully retire this looper
      debug(`[LoopingSound] No more loop segments. Retiring looper, allowing natural track end.`);
      this._invalidateLoopOperation();

      // Cancel all pending timers
      safeCancelTimer(this.mainSchedule, `LoopingSound main schedule (retire) for "${this.ps?.name}"`);
      safeCancelTimer(this.loopCrossfadeTimer, `LoopingSound crossfade timer (retire) for "${this.ps?.name}"`);
      safeCancelTimer(this.handoffTimer, `LoopingSound handoff timer (retire) for "${this.ps?.name}"`);

      // Stop the inactive buffer
      const inactiveSound = this.isA_Active ? this.soundB : this.soundA;
      safeStop(inactiveSound, `retire inactive buffer for "${this.ps?.name}"`);

      // Schedule fade-out BEFORE clearing references
      this._scheduleFinalFadeOut();

      // Mark as destroyed so no further operations occur
      this._setActiveLoopSegment(null);
      this.isDestroyed = true;
      this._unregisterIfCurrent();
      State.notifyStateChanged();

      // Clear all sound references - the active sound will continue playing via ps.sound
      this.soundA = null;
      this.soundB = null;

      return;
    }

    const fireAt = nextSegment.startSec;
    const segmentLabel = getSegmentLabel(nextSegment, this.config.segments.indexOf(nextSegment));
    debug(`[LoopingSound] Arming timer for "${segmentLabel}" at ${nextSegment.start} for "${this.ps.name}". Will fire at ${fireAt.toFixed(2)}s.`);
    let scheduleHandle = null;
    scheduleHandle = this.activeSound.schedule(() => {
      if (this.mainSchedule !== scheduleHandle) return;
      this.mainSchedule = null;
      this._handleLoopTrigger(nextSegment);
    }, fireAt);
    this.mainSchedule = scheduleHandle;
    scheduleHandle.catch?.(() => {
      if (this.mainSchedule === scheduleHandle) this.mainSchedule = null;
    });
  }

  _handleLoopTrigger(segment) {
    if (this.isDestroyed || this.pausedSnapshot || this.loopingDisabled || !this.ps?.playing) return;

    debug(`[LoopingSound] Triggered loop for "${getSegmentLabel(segment, this.config.segments.indexOf(segment))}" starting at ${segment.start}.`);
    this._setActiveLoopSegment(segment);
    this.loopsCompleted = 0;

    this.loopingDisabled = false;
    this.isFadingOut = false;

    // Emit loop start event
    Hooks.callAll('the-sound-of-silence.loopStart', {
      sound: this.ps,
      segment: segment,
      segmentIndex: this.config.segments.indexOf(segment)
    });
    State.recordLoopStart();
    this._metricsLoopActive = true;

    // Start the first crossfade loop immediately.
    this._armCrossfadeLoop();
  }


  _armCrossfadeLoop() {
    if (this.loopingDisabled || this.pausedSnapshot) return; // Don't schedule while disabled or paused
    if (!this.activeLoopSegment || this.isDestroyed) return;

    const scheduledSegment = this.activeLoopSegment;
    const { startSec, endSec, crossfadeMs } = scheduledSegment;
    const segmentDur = endSec - startSec;
    const crossfadeSec = crossfadeMs / 1000;
    const ownsScheduledSegment = () =>
      !this.isDestroyed &&
      !this.pausedSnapshot &&
      !this.loopingDisabled &&
      this.activeLoopSegment === scheduledSegment;

    const armFallback = (failedTimer, delayMs, err) => {
      if (this.loopCrossfadeTimer !== failedTimer || !ownsScheduledSegment()) return;
      debug(`  Precise schedule failed, falling back to AudioTimeout: ${err?.message ?? err}`);
      const fallbackTimer = new AudioTimeout(Math.max(0, delayMs));
      this.loopCrossfadeTimer = fallbackTimer;
      fallbackTimer.complete.then(() => {
        if (
          fallbackTimer.cancelled ||
          this.loopCrossfadeTimer !== fallbackTimer ||
          !ownsScheduledSegment()
        ) return;
        this.loopCrossfadeTimer = null;
        this._performCrossfadeLoop();
      }).catch(() => {
        // Foundry v13 rejects intentionally cancelled AudioTimeout instances.
      });
    };

    const currentTime = Number(this.activeSound.currentTime);

    if (!Number.isFinite(currentTime)) {
      debug(`[LoopingSound] ❌ Invalid currentTime, retrying in 100ms`);
      AudioTimeout.wait(100).then(() => this._armCrossfadeLoop());
      return;
    }

    const timeToEnd = segmentDur - (currentTime - startSec);
    const untilFade = timeToEnd - crossfadeSec;

    logFeature(LogSymbols.LOOP, 'Loop',
      `Arm crossfade: ${this.ps.name} ${getSegmentLabel(this.activeLoopSegment, this.config.segments.indexOf(this.activeLoopSegment))} [${formatTime(startSec)}-${formatTime(endSec)}]`,
      { untilFade: untilFade.toFixed(2) + 's' }
    );


    // Consume this one-shot before any immediate branch so a late first
    // segment cannot accidentally delay a later loop generation.
    const needsInitialSettle = this.wasRestarted;
    this.wasRestarted = false;

    // If we are already past the point where the fade should have started, trigger it immediately.
    if (untilFade <= 0) {
      debug(`[LoopingSound] Already past loop point, triggering immediately.`);
      this._performCrossfadeLoop();
      return;
    }

    // --- HYBRID SCHEDULING LOGIC ---

    // This block handles the special case for the first loop after a "skip intro" restart.
    if (needsInitialSettle) {
      const settleDelayMs = 1000; // Use a short, 1-second delay to let the audio engine stabilize.
      debug(`  Hybrid scheduling active. Waiting ${settleDelayMs}ms before using precise timer.`);

      // Use AudioTimeout for the initial short delay (immune to browser tab throttling).
      const settleTimer = new AudioTimeout(settleDelayMs);
      this.loopCrossfadeTimer = settleTimer;

      settleTimer.complete.then(() => {
        if (
          settleTimer.cancelled ||
          this.loopCrossfadeTimer !== settleTimer ||
          !ownsScheduledSegment()
        ) {
          debug(`[LoopingSound] Settle delay no longer owns this loop; aborting timer setup`);
          return;
        }

        // Verify the sound is still valid and playing
        if (!this.activeSound || !this.activeSound.playing) {
          debug(`[LoopingSound] Active sound no longer playing during settle delay`);
          return;
        }

        // After 1 second, the sound has been playing and is stable. We can now use the precise scheduler.
        const stableCurrentTime = Number(this.activeSound.currentTime);
        const stableTimeToEnd = segmentDur - (stableCurrentTime - startSec);
        const remainingUntilFade = stableTimeToEnd - crossfadeSec;

        if (remainingUntilFade <= 0) {
          // If the fade point passed during our 1-second wait, fire immediately.
          debug(`[LoopingSound] 🔥 Crossfade point reached during settle delay. Firing now.`);
          this.loopCrossfadeTimer = null;
          this._performCrossfadeLoop();
        } else {
          // Schedule the crossfade for the remaining time using the high-precision audio clock.
          const fireAt = stableCurrentTime + remainingUntilFade;
          debug(`  ⏰ Settle delay complete. Scheduling precise crossfade at ${formatTime(fireAt)}.`);
          let preciseTimer = null;
          preciseTimer = this.activeSound.schedule(() => {
            if (this.loopCrossfadeTimer !== preciseTimer || !ownsScheduledSegment()) return;
            this.loopCrossfadeTimer = null;
            debug(`[LoopingSound] 🔥 Crossfade fired! (post-hybrid)`);
            this._performCrossfadeLoop();
          }, fireAt);
          this.loopCrossfadeTimer = preciseTimer;
          preciseTimer.catch?.((err) => {
            armFallback(preciseTimer, remainingUntilFade * 1000, err);
          });
        }
      }).catch(() => {
        // Foundry v13 rejects intentionally cancelled AudioTimeout instances.
      });

    } else {
      // This is the normal, high-precision path for all standard loops.
      const fireAt = currentTime + untilFade;
      debug(`  ⏰ Scheduling precise crossfade at ${formatTime(fireAt)} via audio context.`);

      let preciseTimer = null;
      preciseTimer = this.activeSound.schedule(() => {
        if (this.loopCrossfadeTimer !== preciseTimer || !ownsScheduledSegment()) return;
        this.loopCrossfadeTimer = null;
        debug(`[LoopingSound] 🔥 Crossfade fired!`);
        this._performCrossfadeLoop();
      }, fireAt);
      this.loopCrossfadeTimer = preciseTimer;

      // Add a fallback in case the precise schedule fails for any reason.
      preciseTimer.catch?.(err => {
        armFallback(preciseTimer, untilFade * 1000, err);
      });
    }
  }

  /**
   * Handles the transition after a segment completes its loops.
   * If skipToNext is enabled, jumps to the next segment or fades out.
   * Otherwise, continues playing naturally.
   */
  async _handleSegmentCompletion() {
    if (this.isDestroyed || !this.activeLoopSegment) return;

    const currentSegment = this.activeLoopSegment;
    const shouldSkip = currentSegment.skipToNext ?? false;

    // Find the next segment in the array
    const currentIndex = this.config.segments.indexOf(currentSegment);
    const nextSegment = this.config.segments[currentIndex + 1];
    const isLastSegment = !nextSegment;

    debug(`[LoopingSound] Segment "${currentSegment.start}-${currentSegment.end}" completed. skipToNext=${shouldSkip}, isLast=${isLastSegment}`);

    // Emit loop end event
    Hooks.callAll('the-sound-of-silence.loopEnd', {
      sound: this.ps,
      segment: currentSegment,
      totalIterations: this.loopsCompleted,
      hasNextSegment: !isLastSegment
    });
    this._recordLoopSessionEnd({ completed: true });

    if (!shouldSkip) {
      // If this was the final loop segment, the looper's job is over. It will now retire and
      // schedule a final fade-out, letting the track play to its natural conclusion.
      if (isLastSegment) {
        debug(`[LoopingSound] Last segment with skipToNext=false. Letting track play to natural end.`);
        this._armNextTimer(); // This will find no next segment and trigger the retirement logic.
      } else {
        // There is another segment later in the track. Continue playing normally until then.
        debug(`[LoopingSound] Continuing to next segment naturally.`);
        this._endCurrentLoopSegment(); // This cleans up the current segment and arms the timer for the *next* one.
      }
      return;
    }

    // skipToNext is ON
    if (nextSegment) {
      // Skip directly to the next segment
      debug(`[LoopingSound] Skipping to next segment "${getSegmentLabel(nextSegment, this.config.segments.indexOf(nextSegment))}" at ${nextSegment.start}`);
      await this._skipToSegment(nextSegment);
    } else {
      // This is the last segment and skipToNext is ON - fade out and advance
      debug(`[LoopingSound] Last segment with skipToNext=true. Fading out and advancing track.`);
      await this._fadeOutAndAdvance();
    }
  }

  /**
   * Executes the core crossfade and handoff logic between two sound buffers.
   * This is the single source of truth for all internal crossfades.
   * @param {object} options
   * @param {Sound} options.sourceSound The sound to fade out.
   * @param {Sound} options.targetSound The sound to fade in.
   * @param {number} options.targetOffset The time (in seconds) where the target sound should start playing.
   * @param {number} options.crossfadeMs The duration of the crossfade in milliseconds.
   * @param {object} [options.operation] The operation which prepared the target buffer.
   * @returns {Promise<boolean>} True if the handoff was successful, false otherwise.
   * @private
   */
  async _executeCrossfadeAndHandoff({ sourceSound, targetSound, targetOffset, crossfadeMs, operation = null }) {
    const createdOperation = !operation;
    if (!operation) operation = this._beginLoopOperation("direct handoff");

    if (
      this.isDestroyed ||
      !sourceSound ||
      !targetSound ||
      !this._ownsLoopOperation(operation)
    ) {
      debug(`[LoopingSound] Crossfade aborted: destroyed=${this.isDestroyed}, sourceSound=${!!sourceSound}, targetSound=${!!targetSound}`);
      return false;
    }

    operation.targetSound ??= targetSound;
    const ownsHandoff = () => this._ownsLoopOperation(operation);
    const finishDirectOperation = () => {
      if (createdOperation) this._completeLoopOperation(operation);
    };
    this._setCrossfading(true);
    targetSound._manager = this.ps;

    try {
      await targetSound.play({ offset: targetOffset, volume: 0, _fromLoop: true });
    } catch (err) {
      if (err.name === 'AbortError') {
        debug(`[LoopingSound] Crossfade play was aborted.`);
      } else {
        error("[LoopingSound] Failed to start target sound for crossfade:", err);
      }
      if (ownsHandoff()) this._setCrossfading(false);
      this._stopLoopOperationTarget(operation, targetSound, "failed target play cleanup");
      finishDirectOperation();
      return false;
    }

    // Check again before starting crossfade. Pause, break, and disable may run
    // while targetSound.play() is pending without destroying the looper.
    if (
      this.isDestroyed ||
      this.pausedSnapshot ||
      this.loopingDisabled ||
      !this.activeLoopSegment ||
      !ownsHandoff() ||
      !this.isCrossfading
    ) {
      debug(`[LoopingSound] Playback lifecycle changed before crossfade could start`);
      this._stopLoopOperationTarget(operation, targetSound, "abort cleanup");
      if (ownsHandoff() && this.isCrossfading) this._setCrossfading(false);
      finishDirectOperation();
      return false;
    }

    const targetVolIn = Flags.resolveTargetVolume(this.ps);
    equalPowerCrossfade(sourceSound, targetSound, crossfadeMs, { targetVolIn });

    safeCancelTimer(this.handoffTimer, `replace handoff timer for "${this.ps?.name}"`);
    const handoffTimer = new AudioTimeout(crossfadeMs + HANDOFF_BUFFER);
    this.handoffTimer = handoffTimer;

    try {
      await handoffTimer.complete;
    } catch (err) {
      debug(`[LoopingSound] Handoff timer cancelled for "${this.ps.name}".`);
      // Foundry v13 rejects a cancelled AudioTimeout. A superseded timer no
      // longer owns the shared transition state, so it must not clear a newer
      // handoff's ownership when its rejection arrives. Its own target buffer
      // is still stale and must be stopped.
      if (ownsHandoff() && this.handoffTimer === handoffTimer) {
        this.handoffTimer = null;
        this._setCrossfading(false);
      }
      this._stopLoopOperationTarget(operation, targetSound, "handoff timer cancelled");
      finishDirectOperation();
      return false;
    }

    // Foundry v14 resolves AudioTimeout.complete when cancel() is called. Timer
    // identity, rather than rejection, therefore owns the handoff. A pause,
    // break, disable, destroy, or replacement transition invalidates this
    // timer and must never promote the stopped incoming buffer.
    if (!ownsHandoff() || this.handoffTimer !== handoffTimer || !this.isCrossfading) {
      debug(`[LoopingSound] Ignoring cancelled or superseded handoff for "${this.ps.name}".`);
      this._stopLoopOperationTarget(operation, targetSound, "cancelled or superseded handoff");
      finishDirectOperation();
      return false;
    }
    this.handoffTimer = null;

    if (this.isDestroyed) {
      // If destroyed during handoff, ensure target sound is stopped.
      this._stopLoopOperationTarget(operation, targetSound, "abort cleanup");
      this._setCrossfading(false);
      finishDirectOperation();
      return false;
    }

    safeStop(sourceSound, "handoff cleanup");

    this.isA_Active = !this.isA_Active;
    this.ps.sound = this.activeSound;
    this.activeSound._manager = this.ps;
    this._setCrossfading(false);
    finishDirectOperation();

    debug(`[LoopingSound] Handoff complete. Active sound is now: ${this.activeSound.id}, playing: ${this.activeSound.playing}`);
    return true;
  }

  /**
   * Seeks to a specific segment using equal-power crossfade.
   * @param {object} nextSegment The segment to jump to
   */
  async _skipToSegment(nextSegment) {
    if (this.isDestroyed) return false;

    const operation = this._beginLoopOperation("segment skip");

    safeCancelTimer(this.mainSchedule, `skipToSegment main schedule for "${this.ps?.name}"`);
    safeCancelTimer(this.loopCrossfadeTimer, `skipToSegment crossfade timer for "${this.ps?.name}"`);
    this.mainSchedule = null;
    this.loopCrossfadeTimer = null;
    safeCancelTimer(this.handoffTimer, `skipToSegment handoff timer for "${this.ps?.name}"`);
    this.handoffTimer = null;

    const sourceSound = this.activeSound;
    const crossfadeMs = normalizeNonNegativeNumber(this.activeLoopSegment?.crossfadeMs, 1000);

    debug(`[LoopingSound] Crossfading to next segment at ${nextSegment.startSec}s over ${crossfadeMs}ms`);

    const targetSound = await this._prepareTargetSound(operation);
    if (!this._ownsLoopOperation(operation)) return false;

    if (!targetSound) {
      debug(`[LoopingSound] Aborting segment skip, target sound could not be prepared.`);
      this._completeLoopOperation(operation);
      this._endCurrentLoopSegment();
      return false;
    }
    operation.targetSound ??= targetSound;

    const wasSuccessful = await this._executeCrossfadeAndHandoff({
      sourceSound,
      targetSound,
      targetOffset: nextSegment.startSec,
      crossfadeMs,
      operation,
    });

    if (!this._ownsLoopOperation(operation)) return false;
    if (this.isDestroyed || this.pausedSnapshot || this.loopingDisabled || !this.activeLoopSegment) {
      this._completeLoopOperation(operation);
      return false;
    }

    // A concurrent seek/loop may have replaced the handoff while this caller
    // was awaiting Foundry's AudioTimeout. The stale caller must not tear down
    // the newer transition's shared loop state.
    if (!wasSuccessful && this.handoffTimer && this.isCrossfading) {
      debug(`[LoopingSound] Segment skip was superseded by a newer handoff.`);
      this._completeLoopOperation(operation);
      return false;
    }

    if (wasSuccessful) {
      // Handoff was successful, now update the internal state to track the NEW segment.
      debug(`[LoopingSound] Handoff to new segment complete. Now tracking segment at ${nextSegment.start}`);
      this._completeLoopOperation(operation);
      this._setActiveLoopSegment(nextSegment);
      this.loopsCompleted = 0; // Reset the loop counter for the new segment

      this._armCrossfadeLoop(); // Arm the timer for the *next* iteration of the *new* loop
    } else {
      // Crossfade failed or was aborted, gracefully stop and look for the next event.
      debug(`[LoopingSound] Segment skip crossfade failed.`);
      this._completeLoopOperation(operation);
      this._endCurrentLoopSegment();
    }
    return wasSuccessful;
  }

  /**
   * Fades out the current sound and signals to advance to the next track.
   * This function now checks if crossfade is active on the playlist.
   */
  async _fadeOutAndAdvance() {
    if (this.isDestroyed) return;

    const playlist = this.ps.parent;
    if (!playlist) return;

    // Mark as destroyed immediately to prevent any further loop scheduling
    this._invalidateLoopOperation();
    this._setActiveLoopSegment(null);
    this.isDestroyed = true;
    this._unregisterIfCurrent();
    State.notifyStateChanged();

    const isCrossfadeEnabled = Flags.getPlaybackMode(playlist).crossfade;

    if (isCrossfadeEnabled) {
      // This part is correct and remains the same.
      debug(`[LoopingSound] Crossfade enabled. Delegating to performCrossfade for "${this.ps.name}".`);
      await performCrossfade(playlist, this.ps);

    } else {
      // --- ROBUST LOGIC FOR SILENCE/DEFAULT MODES ---
      const fadeMs = normalizeNonNegativeNumber(playlist?.fade, 500);

      debug(`[LoopingSound] Fading out over ${fadeMs}ms...`);
      // First, fade out and stop the current sound.
      await fadeOutAndStop(this.activeSound, fadeMs);

      // Now, decide what to do next. Only the GM should control this.
      if (!PlaylistActionAuthority.isAuthorizedGM()) return;

      const isSilenceEnabled = Flags.getPlaybackMode(playlist).silence;

      // This is the logic that finds the next track or loops the playlist.
      // We define it here so we can call it after the silence, or immediately.
      const playNextOrLoop = async () => {
        const order = getPlayableSoundsInOrder(playlist);
        const currentIndex = order.findIndex((sound) => sound.id === this.ps.id);
        const nextSound = currentIndex >= 0 ? order[currentIndex + 1] : null;

        if (nextSound) {
          debug(`[LoopingSound] Advancing to next track: "${nextSound.name}"`);
          await playlist.playSound(nextSound);
        } else {
          // End of playlist - check for playlist looping
          const loopRestart = maybeLoopPlaylist(playlist);
          if (loopRestart) await loopRestart;
          else await playlist.stopAll();
        }
      };

      if (isSilenceEnabled) {
        debug(`[LoopingSound] Silence is enabled. Injecting silent gap.`);
        const transition = await Silence.startGap(playlist, this.ps);
        if (!transition.started) await playNextOrLoop();
      } else {
        // If silence is not enabled, just play the next track after a short buffer.
        debug(`[LoopingSound] Silence is disabled. Advancing to next track immediately.`);
        try {
          await AudioTimeout.wait(100);
        } catch (_) {
          // A rejected audio timer must not prevent document advancement.
        }
        await playNextOrLoop();
      }
    }
  }

  async _performCrossfadeLoop() {
    if (this.isDestroyed || !this.activeLoopSegment) return;

    const segment = this.activeLoopSegment;
    const maxLoops = segment.loopCount;

    if (maxLoops > 0 && this.loopsCompleted >= maxLoops - 1) {
      debug(`[LoopingSound] Reached ${maxLoops} play(s). Checking skipToNext...`);
      await this._handleSegmentCompletion();
      return;
    }

    const operation = this._beginLoopOperation("loop repeat");
    safeCancelTimer(this.handoffTimer, `replace pending loop handoff for "${this.ps?.name}"`);
    this.handoffTimer = null;
    const sourceSound = this.activeSound;

    this.loopsCompleted++;
    if (maxLoops > 0) debug(`[LoopingSound] Starting loop repeat ${this.loopsCompleted} of ${maxLoops}.`);
    else debug(`[LoopingSound] Starting loop repeat ${this.loopsCompleted} (infinite).`);

    // Emit loop iteration event
    Hooks.callAll('the-sound-of-silence.loopIteration', {
      sound: this.ps,
      segment,
      iteration: this.loopsCompleted,
      maxLoops: maxLoops || Infinity
    });
    State.recordLoopIteration();

    const targetSound = await this._prepareTargetSound(operation);
    if (!this._ownsLoopOperation(operation)) return false;

    if (!targetSound) {
      debug(`[LoopingSound] Aborting crossfade, target sound could not be prepared.`);
      if (this.isCrossfading) this._setCrossfading(false);
      this._completeLoopOperation(operation);
      return false;
    }
    operation.targetSound ??= targetSound;

    const { startSec, crossfadeMs } = segment;

    const wasSuccessful = await this._executeCrossfadeAndHandoff({
      sourceSound,
      targetSound,
      targetOffset: startSec,
      crossfadeMs,
      operation,
    });

    if (!this._ownsLoopOperation(operation)) return false;
    if (this.isDestroyed || this.pausedSnapshot || this.loopingDisabled || this.activeLoopSegment !== segment) {
      this._completeLoopOperation(operation);
      return false;
    }

    // A concurrent loop/seek may now own a different handoff timer. Preserve
    // that newer transition instead of treating this stale result as an
    // ordinary failure and clearing the shared segment/crossfade state.
    if (!wasSuccessful && this.handoffTimer && this.isCrossfading) {
      debug(`[LoopingSound] Loop crossfade was superseded by a newer handoff.`);
      this._completeLoopOperation(operation);
      return false;
    }

    if (wasSuccessful) {
      // If the handoff succeeded, arm the timer for the next loop.
      this._completeLoopOperation(operation);
      this._armCrossfadeLoop();
    } else {
      // If the handoff failed for any reason, gracefully exit the loop.
      debug(`[LoopingSound] Loop crossfade failed. Breaking loop.`);
      this._completeLoopOperation(operation);
      this._endCurrentLoopSegment();
    }
    return wasSuccessful;
  }

  _endCurrentLoopSegment() {
    this._invalidateLoopOperation();
    this._recordLoopSessionEnd({ completed: false });
    this._setActiveLoopSegment(null);
    this._setCrossfading(false);
    this.loopsCompleted = 0;
    // Arm the timer for the *next segment* in the sequence
    this._armNextTimer();
  }

  breakLoop() {
    if (this.isDestroyed) return;
    debug(`[LoopingSound] Break loop requested for "${this.ps.name}".`);

    safeCancelTimer(this.loopCrossfadeTimer, `breakLoop crossfade timer for "${this.ps?.name}"`);
    this.loopCrossfadeTimer = null;

    // If a crossfade is happening, abort it gracefully
    if (this.isCrossfading) {
      safeCancelTimer(this.handoffTimer, `breakLoop handoff timer for "${this.ps?.name}"`);
      this.handoffTimer = null;
      const sourceSound = this.activeSound;
      const targetSound = this.targetSound;
      safeStop(targetSound, "abort cleanup");
      advancedFade(sourceSound, { targetVol: Flags.resolveTargetVolume(this.ps), duration: 250 });
    }

    // Disengage from the current loop and immediately look for the next one
    this._endCurrentLoopSegment();
  }

  /**
   * Disables all looping for this sound and lets it play through naturally.
   * The looper remains active but won't schedule any more segments.
   */
  disableLooping() {
    if (this.isDestroyed) return;
    debug(`[LoopingSound] Disabling all loops for "${this.ps.name}". Will play through naturally.`);
    this._invalidateLoopOperation();

    // Mark as disabled so no more timers are armed
    this.loopingDisabled = true;
    State.notifyStateChanged();

    // Cancel all active timers
    safeCancelTimer(this.mainSchedule, `disableLooping main schedule for "${this.ps?.name}"`);
    safeCancelTimer(this.loopCrossfadeTimer, `disableLooping crossfade timer for "${this.ps?.name}"`);
    safeCancelTimer(this.handoffTimer, `disableLooping handoff timer for "${this.ps?.name}"`);
    safeCancelTimer(this.finalTransitionTimer, `disableLooping final transition for "${this.ps?.name}"`);
    this.mainSchedule = null;
    this.loopCrossfadeTimer = null;
    this.handoffTimer = null;
    this.finalTransitionTimer = null;

    // If crossfading, abort it gracefully and restore volume
    if (this.isCrossfading) {
      const sourceSound = this.activeSound;
      const targetSound = this.targetSound;
      safeStop(targetSound, "disableLooping abort crossfade");
      advancedFade(sourceSound, { targetVol: Flags.resolveTargetVolume(this.ps), duration: 250 });
    }

    // Clear the active segment
    this._recordLoopSessionEnd({ completed: false });
    this._setActiveLoopSegment(null);
    this._setCrossfading(false);
    this.loopsCompleted = 0;

    // Schedule a final fade out for the end of the track
    this._scheduleFinalFadeOut();
  }

  /**
   * Finds the next/previous segment index available from the current loop or playback position.
   */
  getSkippableSegmentIndex(direction = 1) {
    if (this.loopingDisabled || this.isCrossfading) return null;
    if (!Array.isArray(this.config.segments) || !this.config.segments.length) return null;

    const step = direction < 0 ? -1 : 1;
    if (this.activeLoopSegment) {
      const currentIndex = this.config.segments.findIndex(
        seg => seg.start === this.activeLoopSegment.start
      );
      if (currentIndex === -1) return null;

      const targetIndex = currentIndex + step;
      return targetIndex >= 0 && targetIndex < this.config.segments.length ? targetIndex : null;
    }

    const currentTime = Number(this.activeSound?.currentTime ?? this.ps?.sound?.currentTime);
    if (!Number.isFinite(currentTime)) return null;

    const EPSILON = 0.01;
    if (step > 0) {
      const index = this.config.segments.findIndex(seg => seg.startSec > currentTime + EPSILON);
      return index >= 0 ? index : null;
    }

    for (let index = this.config.segments.length - 1; index >= 0; index--) {
      if (this.config.segments[index].startSec < currentTime - EPSILON) return index;
    }
    return null;
  }

  skipToNextSegment() {
    if (this.isDestroyed) {
      debug(`[LoopingSound] Cannot skip to next segment: looper is destroyed.`);
      return;
    }
    const nextIndex = this.getSkippableSegmentIndex(1);
    if (nextIndex == null) {
      debug(`[LoopingSound] Cannot skip to next segment: no later segment available.`);
      return;
    }

    const nextSegment = this.config.segments[nextIndex];
    debug(`[LoopingSound] Skipping to next segment: "${getSegmentLabel(nextSegment, nextIndex)}" at ${nextSegment.start}`);
    this._skipToSegment(nextSegment);
  }

  /**
   * Skips to the previous segment in the sequence.
   */
  skipToPreviousSegment() {
    if (this.isDestroyed) {
      debug(`[LoopingSound] Cannot skip to previous segment: looper is destroyed.`);
      return;
    }
    const prevIndex = this.getSkippableSegmentIndex(-1);
    if (prevIndex == null) {
      debug(`[LoopingSound] Cannot skip to previous segment: no earlier segment available.`);
      return;
    }

    const prevSegment = this.config.segments[prevIndex];
    debug(`[LoopingSound] Skipping to previous segment: "${getSegmentLabel(prevSegment, prevIndex)}" at ${prevSegment.start}`);
    this._skipToSegment(prevSegment);
  }

  /**
   * Skips to a specific segment by its index in the config array.
   * Used by the replication system to sync segment skips across clients.
   * @param {number} index The index of the segment to skip to
   */
  skipToSegmentByIndex(index) {
    if (this.isDestroyed) return;
    if (this.loopingDisabled) {
      debug(`[LoopingSound] Cannot skip to segment index ${index} for "${this.ps.name}" - looping is disabled.`);
      return;
    }
    if (this.isCrossfading) {
      debug(`[LoopingSound] Cannot skip to segment index ${index} for "${this.ps.name}" - transition already in progress.`);
      return;
    }

    const targetSegment = this.config.segments[index];
    if (!targetSegment) {
      debug(`[LoopingSound] Invalid segment index ${index} for "${this.ps.name}".`);
      return;
    }

    debug(`[LoopingSound] Skipping to segment index ${index} "${getSegmentLabel(targetSegment, index)}" at ${targetSegment.start}`);
    this._skipToSegment(targetSegment);
  }

  retire() {
    if (this.isDestroyed) return;

    // If startup is still waiting for PlaylistSound.sound, the eventual media
    // belongs to ordinary playback and must survive this looper retirement.
    this._preservePlaybackOnAbort = true;
    this._invalidateLoopOperation();

    const activeSound = this.activeSound;
    const inactiveSound = this.targetSound;

    safeCancelTimer(this.mainSchedule, `LoopingSound main schedule for "${this.ps?.name}"`);
    safeCancelTimer(this.loopCrossfadeTimer, `LoopingSound crossfade timer for "${this.ps?.name}"`);
    safeCancelTimer(this.handoffTimer, `LoopingSound handoff timer for "${this.ps?.name}"`);
    safeCancelTimer(this.finalTransitionTimer, `LoopingSound final transition timer for "${this.ps?.name}"`);

    if (this.isCrossfading) {
      safeStop(inactiveSound, `retire abort crossfade for "${this.ps?.name}"`);
      if (activeSound) {
        advancedFade(activeSound, {
          targetVol: Flags.resolveTargetVolume(this.ps),
          duration: 250
        });
      }
    } else {
      safeStop(inactiveSound, `retire inactive sound for "${this.ps?.name}"`);
    }

    if (activeSound) {
      activeSound._manager = this.ps;
      this.ps.sound = activeSound;
    }

    if (this.soundA && this.soundA !== activeSound) this.soundA._manager = null;
    if (this.soundB && this.soundB !== activeSound) this.soundB._manager = null;

    this._recordLoopSessionEnd({ completed: false });
    this._setActiveLoopSegment(null);
    this._setCrossfading(false);
    this.loopsCompleted = 0;
    this.loopingDisabled = true;
    this.wasRestarted = false;
    this.mainSchedule = null;
    this.loopCrossfadeTimer = null;
    this.handoffTimer = null;
    this.finalTransitionTimer = null;
    this.pausedSnapshot = null;
    this.isDestroyed = true;
    this._unregisterIfCurrent();
    this.soundA = null;
    this.soundB = null;

    debug(`[LoopingSound] Retired looper for "${this.ps.name}" and preserved active playback.`);
  }

  destroy(allowFadeOut = false) {
    if (this.isDestroyed) return;
    this._preservePlaybackOnAbort = Boolean(allowFadeOut);
    this._invalidateLoopOperation();
    this.isDestroyed = true;
    this._unregisterIfCurrent();

    safeCancelTimer(this.mainSchedule, `LoopingSound main schedule for "${this.ps?.name}"`);
    safeCancelTimer(this.loopCrossfadeTimer, `LoopingSound crossfade timer for "${this.ps?.name}"`);
    safeCancelTimer(this.handoffTimer, `LoopingSound handoff timer for "${this.ps?.name}"`);
    safeCancelTimer(this.finalTransitionTimer, `LoopingSound final transition timer for "${this.ps?.name}"`);

    if (!allowFadeOut) {
      // Clean up sounds if they exist
      safeStop(this.soundA, `destroy soundA for "${this.ps?.name}"`);
      safeStop(this.soundB, `destroy soundB for "${this.ps?.name}"`);
    } else {
      // Only stop the inactive sound, let the active one fade out
      const inactiveSound = this.isA_Active ? this.soundB : this.soundA;
      safeStop(inactiveSound, `destroy inactive sound for "${this.ps?.name}"`);
      debug(`[LoopingSound] Allowing active sound to fade out naturally for "${this.ps.name}".`);
    }

    // --- Explicitly break references ---
    if (this.soundA) this.soundA._manager = null;
    if (this.soundB) this.soundB._manager = null;
    this._recordLoopSessionEnd({ completed: false });
    this._setActiveLoopSegment(null);
    this.finalTransitionTimer = null;
    this.pausedSnapshot = null;
    this.soundA = null;
    this.soundB = null;
  }

  pause() {
    if (this.isDestroyed || this.pausedSnapshot) return;
    this._invalidateLoopOperation();

    const activeSound = this.activeSound;
    const targetSound = this.targetSound;
    const activeOffset = Number(activeSound?.currentTime);
    this.pausedSnapshot = {
      activeOffset: Number.isFinite(activeOffset) ? activeOffset : 0,
      activeSegmentIndex: this.config.segments.indexOf(this.activeLoopSegment),
      loopsCompleted: this.loopsCompleted,
      loopingDisabled: this.loopingDisabled,
      activeWasA: this.isA_Active,
    };

    safeCancelTimer(this.mainSchedule, `pause main schedule for "${this.ps?.name}"`);
    safeCancelTimer(this.loopCrossfadeTimer, `pause crossfade timer for "${this.ps?.name}"`);
    safeCancelTimer(this.handoffTimer, `pause handoff timer for "${this.ps?.name}"`);
    safeCancelTimer(this.finalTransitionTimer, `pause final transition timer for "${this.ps?.name}"`);
    this.mainSchedule = null;
    this.loopCrossfadeTimer = null;
    this.handoffTimer = null;
    this.finalTransitionTimer = null;

    if (activeSound) cancelActiveFade(activeSound);
    if (targetSound) cancelActiveFade(targetSound);
    if (targetSound && targetSound !== activeSound) {
      safeStop(targetSound, `pause inactive loop buffer for "${this.ps?.name}"`);
    }

    if (activeSound) {
      activeSound._manager = this.ps;
      this.ps.sound = activeSound;
    }
    this._setCrossfading(false);
  }

  resume() {
    if (this.isDestroyed) return;

    const snapshot = this.pausedSnapshot;
    if (snapshot) {
      const resumedSound = this.ps.sound;
      this.isA_Active = snapshot.activeWasA;
      if (this.isA_Active) this.soundA = resumedSound;
      else this.soundB = resumedSound;

      const inactiveSound = this.targetSound;
      if (inactiveSound && inactiveSound !== resumedSound) {
        cancelActiveFade(inactiveSound);
        safeStop(inactiveSound, `resume stale loop buffer for "${this.ps?.name}"`);
      }

      this.loopsCompleted = snapshot.loopsCompleted;
      this.loopingDisabled = snapshot.loopingDisabled;
      const segment = snapshot.activeSegmentIndex >= 0
        ? this.config.segments[snapshot.activeSegmentIndex] ?? null
        : null;
      this._setActiveLoopSegment(segment);
      this._setCrossfading(false);
      this.pausedSnapshot = null;
    }

    if (this.isCrossfading) return;

    if (this.loopingDisabled) {
      this._scheduleFinalFadeOut();
      return;
    }

    if (this.activeLoopSegment) {
      // If we were in the middle of a loop, re-arm the crossfade
      this._armCrossfadeLoop();
    } else {
      // Otherwise, look for the next segment in the sequence
      this._armNextTimer();
    }
  }

}
