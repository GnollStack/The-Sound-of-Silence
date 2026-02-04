// looping-sound.js
import { advancedFade, equalPowerCrossfade } from "./audio-fader.js";
import { maybeLoopPlaylist } from "./playlist-loop.js";
import { performCrossfade } from "./cross-fade.js";
import { Silence } from "./silence.js";
import { Flags } from "./flag-service.js";
import { MODULE_ID, toSec, debug, waitForMedia, formatTime, logFeature, LogSymbols, safeStop, safeCancelTimer } from "./utils.js";
import { State } from "./state-manager.js";

const AudioTimeout = foundry.audio.AudioTimeout;

// Constants for hardwired numbers, get these in the right spots
const POSITION_CHECK_TOLERANCE = 0.5;  // seconds
const POSITION_CHECK_REQUIRED = 3;     // consecutive stable reads
const POSITION_CHECK_INTERVAL = 50;    // ms between checks
const PRELOAD_WINDOW = 0.5;            // seconds before crossfade
const HANDOFF_BUFFER = 50;             // ms buffer after crossfade



export class LoopingSound {
  constructor(playlistSound, config) {
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

    this.mainSchedule = null;
    this.handoffTimer = null;
    this.loopCrossfadeTimer = null;

    this.wasRestarted = false; // track if we used stop/play
  }

  get activeSound() {
    return this.isA_Active ? this.soundA : this.soundB;
  }

  get targetSound() {
    return this.isA_Active ? this.soundB : this.soundA;
  }


  async start() {
    debug(`[LoopingSound] Initializing for "${this.ps.name}" with ${this.config.segments.length} segments.`);

    try {
      this.soundA = await waitForMedia(this.ps);
      if (!this.soundA) throw new Error("Could not get initial sound object.");

      debug(`[LoopingSound] Deferring soundB pre-load until needed (memory optimization).`);

      if (this.isDestroyed) {
        safeStop(this.soundA, "LoopingSound initialization aborted");
        return;
      }
    } catch (err) {
      console.error(`[${MODULE_ID}] Failed to load sound for looping:`, err);
      return;
    }

    // Handle skipping intro to first segment
    if (!this.config.startFromBeginning && this.config.segments.length > 0) {
      const firstSeg = this.config.segments[0];
      debug(`[LoopingSound] Skipping intro. Seeking to first segment at ${firstSeg.startSec}s.`);

      const playlist = this.ps.parent;
      const fadeInMs = Flags.getPlaylistFlag(playlist, "fadeIn");
      const startVolume = (fadeInMs > 0) ? 0 : this.ps.volume;

      try {
        const oldSound = this.soundA;
        const newSound = new foundry.audio.Sound(this.ps.path, {
          context: oldSound.context
        });
        await newSound.load();

        if (this.isDestroyed) {
          newSound.stop();
          return;
        }

        await newSound.play({
          offset: firstSeg.startSec,
          volume: startVolume,
          _fromLoop: true,
        });

        if (this.isDestroyed) {
          debug(`[LoopingSound] Destroyed during play(), aborting startup`);
          safeStop(newSound, "startup abort after play");
          return;
        }

        newSound.addEventListener("end", this.ps._onEnd.bind(this.ps), { once: true });

        this.soundA = newSound;
        this.ps.sound = newSound;
        this.wasRestarted = true;

        try {
          await oldSound.stop();
        } catch (err) { /* Ignore if already stopped */ }

        // Apply fade-in on the new sound, using the correct volume from the sound document.
        if (fadeInMs > 0 && startVolume === 0) {
          const soundDocumentVolume = this.ps.volume;
          debug(`[LoopingSound] Fading in to ${(soundDocumentVolume * 100).toFixed(0)}% over ${fadeInMs}ms`);
          advancedFade(newSound, { targetVol: soundDocumentVolume, duration: fadeInMs });
        }

        const waitForStablePosition = () => {
          return new Promise((resolve) => {
            const targetPos = firstSeg.startSec;
            let stableCount = 0;

            const checkPosition = () => {
              if (this.isDestroyed) return resolve(false);
              if (!this.soundA.playing) {
                debug(`[LoopingSound] Sound paused during position check, aborting`);
                return resolve(false);
              }

              const currentTime = this.soundA.currentTime;
              if (Math.abs(currentTime - targetPos) < POSITION_CHECK_TOLERANCE) {
                stableCount++;
                // Only log when position is stable, not each check
                if (stableCount >= POSITION_CHECK_REQUIRED) {
                  logFeature(LogSymbols.LOOP, 'Loop', `Position stable @ ${currentTime.toFixed(2)}s`);
                }
                if (stableCount >= POSITION_CHECK_REQUIRED) {
                  debug(`[LoopingSound] Position stable at ${currentTime.toFixed(2)}s`);
                  return resolve(true);
                }
              } else {
                if (stableCount > 0) debug(`[LoopingSound] Position unstable, resetting check`);
                stableCount = 0;
              }
              AudioTimeout.wait(POSITION_CHECK_INTERVAL).then(checkPosition);
            };
            checkPosition();
          });
        };

        const isStable = await waitForStablePosition();

        if (!this.isDestroyed && isStable) {
          debug(`[LoopingSound] Sound repositioned and stable, triggering loop.`);
          this._handleLoopTrigger(firstSeg);
        } else if (!this.isDestroyed) {
          debug(`[LoopingSound] Position did not stabilize, aborting skip-intro.`);
          this._armNextTimer();
        }
      } catch (err) {
        console.error(`[${MODULE_ID}] Failed to seek to first segment:`, err);
        this._armNextTimer();
      }

      return;
    }

    this._armNextTimer();
  }

  /**
   * Creates a fresh, playable Sound instance for the upcoming crossfade.
   * This is critical for long, streaming sounds that get unloaded on stop.
   * @returns {Promise<Sound|null>} A newly loaded Sound object or null if destroyed.
   */
  async _prepareTargetSound() {
    if (this.isDestroyed) return null;

    const bufferName = this.isA_Active ? "soundB" : "soundA";
    let existingSound = this.isA_Active ? this.soundB : this.soundA;

    // For long sounds, element is destroyed on stop but can be quickly recreated
    if (existingSound && !existingSound.failed) {
      // Reload the sound if it was unloaded (happens for long streaming sounds)
      if (!existingSound.loaded) {
        await existingSound.load();
      }
      debug(`[LoopingSound] ♻️ Reusing existing ${bufferName} (performance optimization)`);
      return existingSound;
    }

    // Create new Sound only if none exists
    debug(`[LoopingSound] Creating fresh ${bufferName} instance...`);

    try {
      const newSound = new foundry.audio.Sound(this.ps.path);
      await newSound.load();

      newSound.addEventListener("end", this.ps._onEnd.bind(this.ps), { once: true });

      if (this.isA_Active) {
        this.soundB = newSound;
      } else {
        this.soundA = newSound;
      }

      debug(`[LoopingSound] ${bufferName} is ready.`);
      return newSound;

    } catch (err) {
      console.error(`[${MODULE_ID}] Failed to prepare target sound:`, err);
      return null;
    }
  }

  /**
 * Schedules a fade-out for the current active sound to play at the end of the track.
 * Called when the looper retires and the track should play to its natural end.
 */
  _scheduleFinalFadeOut() {
    this.isFadingOut = true;
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
        sound.schedule(() => {
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
        sound.schedule(() => {
          if (!sound.playing) return;
          debug(`[LoopingSound] Starting final exponential fade-out for "${this.ps.name}"`);
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
    if (this.loopingDisabled) return; // Don't schedule if looping is disabled
    if (this.isDestroyed || !this.activeSound || this.isCrossfading) return;
    this.mainSchedule?.timeout?.cancel();

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
      this.isDestroyed = true;

      // Clear all sound references - the active sound will continue playing via ps.sound
      this.soundA = null;
      this.soundB = null;

      return;
    }

    const fireAt = nextSegment.startSec;
    debug(`[LoopingSound] Arming timer for segment at ${nextSegment.start} for "${this.ps.name}". Will fire at ${fireAt.toFixed(2)}s.`);
    this.mainSchedule = this.activeSound.schedule(() => this._handleLoopTrigger(nextSegment), fireAt);
  }

  _handleLoopTrigger(segment) {
    if (this.isDestroyed || !this.ps?.playing) return;

    debug(`[LoopingSound] Triggered loop for segment starting at ${segment.start}.`);
    this.activeLoopSegment = segment;
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

    // Start the first crossfade loop immediately.
    this._armCrossfadeLoop();
  }


  _armCrossfadeLoop() {
    if (this.loopingDisabled) return; // Don't schedule if looping is disabled
    if (!this.activeLoopSegment || this.isDestroyed) return;

    const { startSec, endSec, crossfadeMs } = this.activeLoopSegment;
    const segmentDur = endSec - startSec;
    const crossfadeSec = crossfadeMs / 1000;

    const currentTime = Number(this.activeSound.currentTime);

    if (!Number.isFinite(currentTime)) {
      debug(`[LoopingSound] ❌ Invalid currentTime, retrying in 100ms`);
      AudioTimeout.wait(100).then(() => this._armCrossfadeLoop());
      return;
    }

    const timeToEnd = segmentDur - (currentTime - startSec);
    const untilFade = timeToEnd - crossfadeSec;

    logFeature(LogSymbols.LOOP, 'Loop',
      `Arm crossfade: ${this.ps.name} [${formatTime(startSec)}-${formatTime(endSec)}]`,
      { untilFade: untilFade.toFixed(2) + 's' }
    );


    // If we are already past the point where the fade should have started, trigger it immediately.
    if (untilFade <= 0) {
      debug(`[LoopingSound] Already past loop point, triggering immediately.`);
      this._performCrossfadeLoop();
      return;
    }

    // --- HYBRID SCHEDULING LOGIC ---

    // This block handles the special case for the first loop after a "skip intro" restart.
    if (this.wasRestarted) {
      // Clear the flag immediately. This ensures this special logic only runs ONCE.
      // All subsequent loops for this sound will use the high-precision path directly.
      this.wasRestarted = false;

      const settleDelayMs = 1000; // Use a short, 1-second delay to let the audio engine stabilize.
      debug(`  Hybrid scheduling active. Waiting ${settleDelayMs}ms before using precise timer.`);

      // Use AudioTimeout for the initial short delay (immune to browser tab throttling).
      const settleTimer = new AudioTimeout(settleDelayMs);
      this.loopCrossfadeTimer = settleTimer;

      settleTimer.complete.then(() => {
        if (this.isDestroyed) {
          debug(`[LoopingSound] Destroyed during settle delay, aborting timer setup`);
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
          this._performCrossfadeLoop();
        } else {
          // Schedule the crossfade for the remaining time using the high-precision audio clock.
          const fireAt = stableCurrentTime + remainingUntilFade;
          debug(`  ⏰ Settle delay complete. Scheduling precise crossfade at ${formatTime(fireAt)}.`);
          this.loopCrossfadeTimer = this.activeSound.schedule(() => {
            debug(`[LoopingSound] 🔥 Crossfade fired! (post-hybrid)`);
            this._performCrossfadeLoop();
          }, fireAt);
        }
      });

    } else {
      // This is the normal, high-precision path for all standard loops.
      const fireAt = currentTime + untilFade;
      debug(`  ⏰ Scheduling precise crossfade at ${formatTime(fireAt)} via audio context.`);

      this.loopCrossfadeTimer = this.activeSound.schedule(() => {
        debug(`[LoopingSound] 🔥 Crossfade fired!`);
        this._performCrossfadeLoop();
      }, fireAt);

      // Add a fallback in case the precise schedule fails for any reason.
      this.loopCrossfadeTimer.catch?.(err => {
        debug(`  ⚠️ Precise schedule failed, falling back to AudioTimeout: ${err.message}`);
        const crossfadeDelayMs = untilFade * 1000;
        AudioTimeout.wait(crossfadeDelayMs).then(() => { if (!this.isDestroyed) this._performCrossfadeLoop(); });
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
    State.recordLoopEnd();

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
      debug(`[LoopingSound] Skipping to next segment at ${nextSegment.start}`);
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
   * @returns {Promise<boolean>} True if the handoff was successful, false otherwise.
   * @private
   */
  async _executeCrossfadeAndHandoff({ sourceSound, targetSound, targetOffset, crossfadeMs }) {
    if (this.isDestroyed || !sourceSound || !targetSound) {
      debug(`[LoopingSound] Crossfade aborted: destroyed=${this.isDestroyed}, sourceSound=${!!sourceSound}, targetSound=${!!targetSound}`);
      return false;
    }

    this.isCrossfading = true;
    targetSound._manager = this.ps;

    try {
      await targetSound.play({ offset: targetOffset, volume: 0, _fromLoop: true });
    } catch (err) {
      if (err.name === 'AbortError') {
        debug(`[LoopingSound] Crossfade play was aborted.`);
      } else {
        console.error(`[${MODULE_ID}] Failed to start target sound for crossfade:`, err);
      }
      this.isCrossfading = false;
      return false;
    }

    // Check again before starting crossfade
    if (this.isDestroyed) {
      debug(`[LoopingSound] Destroyed before crossfade could start`);
      safeStop(targetSound, "abort cleanup");
      this.isCrossfading = false;
      return false;
    }

    equalPowerCrossfade(sourceSound, targetSound, crossfadeMs);

    // Force volume after a short delay in case the crossfade fails to ramp up.
    // Uses AudioTimeout to avoid browser throttling in background tabs.
    AudioTimeout.wait(crossfadeMs / 2).then(() => {
      if (!this.isDestroyed && targetSound?.playing && targetSound.volume < this.ps.volume / 2) {
        debug(`[LoopingSound] Crossfade may have stalled, forcing volume to target`);
        targetSound.volume = this.ps.volume;
      }
    });

    this.handoffTimer?.cancel();
    this.handoffTimer = new AudioTimeout(crossfadeMs + HANDOFF_BUFFER);

    await this.handoffTimer.complete;

    if (this.isDestroyed) {
      // If destroyed during handoff, ensure target sound is stopped.
      safeStop(targetSound, "abort cleanup");
      return false;
    }

    safeStop(sourceSound, "handoff cleanup");

    this.isA_Active = !this.isA_Active;
    this.ps.sound = this.activeSound;
    this.activeSound._manager = this.ps;
    this.isCrossfading = false;

    debug(`[LoopingSound] Handoff complete. Active sound is now: ${this.activeSound.id}, playing: ${this.activeSound.playing}`);
    return true;
  }

  /**
   * Seeks to a specific segment using equal-power crossfade.
   * @param {object} nextSegment The segment to jump to
   */
  async _skipToSegment(nextSegment) {
    if (this.isDestroyed) return;

    this.loopCrossfadeTimer?.timeout?.cancel();
    this.handoffTimer?.cancel();

    const sourceSound = this.activeSound;
    const crossfadeMs = this.activeLoopSegment?.crossfadeMs || 1000;

    debug(`[LoopingSound] Crossfading to next segment at ${nextSegment.startSec}s over ${crossfadeMs}ms`);

    const targetSound = await this._prepareTargetSound();
    if (!targetSound) {
      debug(`[LoopingSound] Aborting segment skip, target sound could not be prepared.`);
      this._endCurrentLoopSegment();
      return;
    }

    const wasSuccessful = await this._executeCrossfadeAndHandoff({
      sourceSound,
      targetSound,
      targetOffset: nextSegment.startSec,
      crossfadeMs
    });

    if (this.isDestroyed) return;

    if (wasSuccessful) {
      // Handoff was successful, now update the internal state to track the NEW segment.
      debug(`[LoopingSound] Handoff to new segment complete. Now tracking segment at ${nextSegment.start}`);
      this.activeLoopSegment = nextSegment;
      this.loopsCompleted = 0; // Reset the loop counter for the new segment

      this._armCrossfadeLoop(); // Arm the timer for the *next* iteration of the *new* loop
    } else {
      // Crossfade failed or was aborted, gracefully stop and look for the next event.
      debug(`[LoopingSound] Segment skip crossfade failed.`);
      this._endCurrentLoopSegment();
    }
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
    this.isDestroyed = true;

    const isCrossfadeEnabled = Flags.getPlaybackMode(playlist).crossfade;

    if (isCrossfadeEnabled) {
      // This part is correct and remains the same.
      debug(`[LoopingSound] Crossfade enabled. Delegating to performCrossfade for "${this.ps.name}".`);
      performCrossfade(playlist, this.ps);

    } else {
      // --- ROBUST LOGIC FOR SILENCE/DEFAULT MODES ---
      const { fadeOutAndStop } = await import("./audio-fader.js");
      const fadeMs = Number(playlist?.fade) || 500;

      debug(`[LoopingSound] Fading out over ${fadeMs}ms...`);
      // First, fade out and stop the current sound.
      await fadeOutAndStop(this.activeSound, fadeMs);

      // Now, decide what to do next. Only the GM should control this.
      if (!game.user.isGM) return;

      const isSilenceEnabled = Flags.getPlaybackMode(playlist).silence;

      // This is the logic that finds the next track or loops the playlist.
      // We define it here so we can call it after the silence, or immediately.
      const playNextOrLoop = () => {
        const order = playlist.playbackOrder;
        const currentIndex = order.indexOf(this.ps.id);
        const nextId = order[currentIndex + 1];

        if (nextId) {
          const nextSound = playlist.sounds.get(nextId);
          if (nextSound) {
            debug(`[LoopingSound] Advancing to next track: "${nextSound.name}"`);
            playlist.playSound(nextSound);
          }
        } else {
          // End of playlist - check for playlist looping
          if (!maybeLoopPlaylist(playlist)) {
            playlist.stopAll();
          }
        }
      };

      if (isSilenceEnabled) {
        debug(`[LoopingSound] Silence is enabled. Injecting silent gap.`);
        // Manually trigger the silent gap. The `playSilence` function returns a
        // promise that resolves to `true` if cancelled, `false` otherwise.
        const wasCancelled = await Silence.playSilence(playlist);
        if (!wasCancelled) {
          playNextOrLoop();
        }
      } else {
        // If silence is not enabled, just play the next track after a short buffer.
        debug(`[LoopingSound] Silence is disabled. Advancing to next track immediately.`);
        AudioTimeout.wait(100).then(() => playNextOrLoop());
      }
    }
  }

  async _performCrossfadeLoop() {
    if (this.isDestroyed || !this.activeLoopSegment) return;

    const maxLoops = this.activeLoopSegment.loopCount;

    if (maxLoops > 0 && this.loopsCompleted >= maxLoops - 1) {
      debug(`[LoopingSound] Reached ${maxLoops} play(s). Checking skipToNext...`);
      await this._handleSegmentCompletion();
      return;
    }

    this.loopsCompleted++;
    if (maxLoops > 0) debug(`[LoopingSound] Starting loop repeat ${this.loopsCompleted} of ${maxLoops}.`);
    else debug(`[LoopingSound] Starting loop repeat ${this.loopsCompleted} (infinite).`);

    // Emit loop iteration event
    Hooks.callAll('the-sound-of-silence.loopIteration', {
      sound: this.ps,
      segment: this.activeLoopSegment,
      iteration: this.loopsCompleted,
      maxLoops: maxLoops || Infinity
    });
    State.recordLoopIteration();

    const targetSound = await this._prepareTargetSound();
    if (!targetSound) {
      debug(`[LoopingSound] Aborting crossfade, target sound could not be prepared.`);
      return;
    }

    const { startSec, crossfadeMs } = this.activeLoopSegment;
    const sourceSound = this.activeSound;

    const wasSuccessful = await this._executeCrossfadeAndHandoff({
      sourceSound,
      targetSound,
      targetOffset: startSec,
      crossfadeMs
    });

    if (this.isDestroyed) return;

    if (wasSuccessful) {
      // If the handoff succeeded, arm the timer for the next loop.
      this._armCrossfadeLoop();
    } else {
      // If the handoff failed for any reason, gracefully exit the loop.
      debug(`[LoopingSound] Loop crossfade failed. Breaking loop.`);
      this._endCurrentLoopSegment();
    }
  }

  _endCurrentLoopSegment() {
    this.activeLoopSegment = null;
    this.isCrossfading = false;
    this.loopsCompleted = 0;
    // Arm the timer for the *next segment* in the sequence
    this._armNextTimer();
  }

  breakLoop() {
    if (this.isDestroyed) return;
    debug(`[LoopingSound] Break loop requested for "${this.ps.name}".`);

    // If a crossfade is happening, abort it gracefully
    if (this.isCrossfading) {
      this.handoffTimer?.cancel();
      this.handoffTimer = null;
      const sourceSound = this.activeSound;
      const targetSound = this.targetSound;
      safeStop(targetSound, "abort cleanup");
      advancedFade(sourceSound, { targetVol: this.ps.volume, duration: 250 });
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

    // Mark as disabled so no more timers are armed
    this.loopingDisabled = true;

    // Cancel all active timers
    safeCancelTimer(this.mainSchedule, `disableLooping main schedule for "${this.ps?.name}"`);
    safeCancelTimer(this.loopCrossfadeTimer, `disableLooping crossfade timer for "${this.ps?.name}"`);
    safeCancelTimer(this.handoffTimer, `disableLooping handoff timer for "${this.ps?.name}"`);

    // If crossfading, abort it gracefully and restore volume
    if (this.isCrossfading) {
      const sourceSound = this.activeSound;
      const targetSound = this.targetSound;
      safeStop(targetSound, "disableLooping abort crossfade");
      advancedFade(sourceSound, { targetVol: this.ps.volume, duration: 250 });
    }

    // Clear the active segment
    this.activeLoopSegment = null;
    this.isCrossfading = false;
    this.loopsCompleted = 0;

    // Schedule a final fade out for the end of the track
    this._scheduleFinalFadeOut();
  }

  /**
   * Skips to the next segment in the sequence.
   * Wraps around to the first segment if at the end.
   */
  skipToNextSegment() {
    if (this.isDestroyed || !this.activeLoopSegment) {
      debug(`[LoopingSound] Cannot skip to next segment: no active segment.`);
      return;
    }

    if (this.config.segments.length <= 1) {
      debug(`[LoopingSound] Cannot skip: only one segment configured.`);
      return;
    }

    const currentIndex = this.config.segments.findIndex(
      seg => seg.start === this.activeLoopSegment.start
    );

    if (currentIndex === -1) {
      debug(`[LoopingSound] Cannot find current segment in config.`);
      return;
    }

    const nextIndex = (currentIndex + 1) % this.config.segments.length;
    const nextSegment = this.config.segments[nextIndex];



    debug(`[LoopingSound] Skipping to next segment: "${nextSegment.label}" at ${nextSegment.start}`);
    this._skipToSegment(nextSegment);
  }

  /**
   * Skips to the previous segment in the sequence.
   * Wraps around to the last segment if at the beginning.
   */
  skipToPreviousSegment() {
    if (this.isDestroyed || !this.activeLoopSegment) {
      debug(`[LoopingSound] Cannot skip to previous segment: no active segment.`);
      return;
    }

    if (this.config.segments.length <= 1) {
      debug(`[LoopingSound] Cannot skip: only one segment configured.`);
      return;
    }

    const currentIndex = this.config.segments.findIndex(
      seg => seg.start === this.activeLoopSegment.start
    );

    if (currentIndex === -1) {
      debug(`[LoopingSound] Cannot find current segment in config.`);
      return;
    }

    const prevIndex = (currentIndex - 1 + this.config.segments.length) % this.config.segments.length;
    const prevSegment = this.config.segments[prevIndex];

    debug(`[LoopingSound] Skipping to previous segment: "${prevSegment.label}" at ${prevSegment.start}`);
    this._skipToSegment(prevSegment);
  }

  /**
   * Skips to a specific segment by its index in the config array.
   * Used by the replication system to sync segment skips across clients.
   * @param {number} index The index of the segment to skip to
   */
  skipToSegmentByIndex(index) {
    if (this.isDestroyed) return;

    const targetSegment = this.config.segments[index];
    if (!targetSegment) {
      debug(`[LoopingSound] Invalid segment index ${index} for "${this.ps.name}".`);
      return;
    }

    debug(`[LoopingSound] Skipping to segment index ${index} at ${targetSegment.start}`);
    this._skipToSegment(targetSegment);
  }

  destroy(allowFadeOut = false) {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    safeCancelTimer(this.mainSchedule, `LoopingSound main schedule for "${this.ps?.name}"`);
    safeCancelTimer(this.loopCrossfadeTimer, `LoopingSound crossfade timer for "${this.ps?.name}"`);
    safeCancelTimer(this.handoffTimer, `LoopingSound handoff timer for "${this.ps?.name}"`);

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
    this.soundA = null;
    this.soundB = null;
  }

  pause() {
    this.mainSchedule?.timeout?.cancel();
    this.loopCrossfadeTimer?.timeout?.cancel();
    // We don't need to cancel handoffTimer as it's very short-lived
  }

  resume() {
    if (this.isCrossfading || this.isDestroyed) return;

    if (this.activeLoopSegment) {
      // If we were in the middle of a loop, re-arm the crossfade
      this._armCrossfadeLoop();
    } else {
      // Otherwise, look for the next segment in the sequence
      this._armNextTimer();
    }
  }

}