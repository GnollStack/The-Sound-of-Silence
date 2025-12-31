/**
 * @file internal-loop.js
 * @description Manages the lifecycle of LoopingSound instances. This file acts as the
 * public API for creating, canceling, pausing, and resuming per-track internal loops.
 * 
 */
import { MODULE_ID } from "./utils.js";
import { LoopingSound } from "./looping-sound.js";
import { debug } from "./utils.js";
import { cancelCrossfade } from "./cross-fade.js";
import { Flags } from "./flag-service.js";
import { State } from "./state-manager.js";  //  Import State manager

/**
 * Creates and starts a new LoopingSound instance for a given PlaylistSound.
 * This function is idempotent; it will cancel any existing looper for the sound before creating a new one.
 * @param {PlaylistSound} ps The PlaylistSound document to create a loop for.
 */
export function scheduleLoopWithin(ps) {
  // A looper can only be scheduled for a sound that is currently playing.
  if (!ps?.playing) {
    debug(`[Manager] Skipping loop schedule for "${ps.name}" because it is not playing.`);
    return;
  }

  const cfg = Flags.getLoopConfig(ps);
  const isActive = cfg.enabled && cfg.active; // undefined defaults to true

  // Cancel any existing looper for this sound to prevent duplicates.
  cancelLoopWithin(ps, { quiet: true });

  if (!cfg.enabled || !isActive) {
    return;
  }

  // If we are about to create a looper, it becomes the authority for this
  // sound's lifecycle. Cancel any playlist-level crossfade timer.
  if (Flags.getPlaybackMode(ps.parent).crossfade) {
    debug(`[Manager] LoopingSound is taking control. Cancelling scheduled crossfade for "${ps.name}".`);
    cancelCrossfade(ps.parent);
  }

  debug(`[Manager] Scheduling a new LoopingSound for "${ps.name}".`);
  // This next line is important. We pass the already-validated `cfg` object.
  const looper = new LoopingSound(ps, cfg);
  State.setActiveLooper(ps, looper);  //  Use State manager

  // Start the looper with a small delay to avoid race conditions with Foundry's audio system
  setTimeout(() => {
    if (!looper.isDestroyed) {
      looper.start();
    }
  }, 50); // 50ms delay to let Foundry's audio system settle
}

/**
 * Finds and destroys the active LoopingSound instance for a given PlaylistSound.
 * @param {PlaylistSound} ps The PlaylistSound document whose loop should be cancelled.
 * @param {object} [options]
 * @param {boolean} [options.quiet=false] - Suppress debug logs.
 * @param {boolean} [options.allowFadeOut=false] - Allow active sound to fade out naturally.
 */
export function cancelLoopWithin(ps, { quiet = false, allowFadeOut = false } = {}) {
  const looper = State.getActiveLooper(ps);  //  Use State manager
  if (looper) {
    if (!quiet) debug(`[Manager] Cancelling LoopingSound for "${ps.name}". (skip/stop)`);
    looper.isAborted = true;
    looper.destroy(allowFadeOut);
    State.clearActiveLooper(ps);  //  Use State manager
  }
}

/**
 * Handles the "break loop" command for a sound. It tells the active looper to stop
 * its current loop segment and continue playback normally.
 * @param {PlaylistSound} ps The PlaylistSound to break the loop for.
 */
export function breakLoopWithin(ps) {
  const looper = State.getActiveLooper(ps);  //  Use State manager
  if (looper) {
    debug(`[Manager] Telling LoopingSound for "${ps.name}" to break its current loop segment.`);
    looper.breakLoop();
    // The new engine is smart enough to continue playback and find the next loop.
    // No need to manually add an 'end' event listener anymore.
  }
}

/**
 * Finds the active looper for a sound and tells it to skip to the next segment.
 * @param {PlaylistSound} ps The PlaylistSound whose loop should advance.
 */
export function nextSegmentWithin(ps) {
  const looper = State.getActiveLooper(ps);
  if (looper && !looper.isDestroyed) {
    debug(`[Manager] Skipping to next segment for "${ps.name}".`);
    looper.skipToNextSegment();
  }
}

/**
 * Finds the active looper for a sound and tells it to skip to the previous segment.
 * @param {PlaylistSound} ps The PlaylistSound whose loop should go back.
 */
export function previousSegmentWithin(ps) {
  const looper = State.getActiveLooper(ps);
  if (looper && !looper.isDestroyed) {
    debug(`[Manager] Skipping to previous segment for "${ps.name}".`);
    looper.skipToPreviousSegment();
  }
}

/**
 * Disables all looping for a sound and lets it play through naturally.
 * @param {PlaylistSound} ps The PlaylistSound whose looping should be disabled.
 */
export function disableAllLoopsWithin(ps) {
  const looper = State.getActiveLooper(ps);
  if (looper && !looper.isDestroyed) {
    debug(`[Manager] Disabling all loops for "${ps.name}".`);
    looper.disableLooping();
  }
}

/**
 * Finds the active looper for a sound and tells it to pause its timers.
 * @param {PlaylistSound} ps The PlaylistSound whose loop should be paused.
 */
export function pauseLoopWithin(ps) {
  const looper = State.getActiveLooper(ps);  //  Use State manager
  if (looper) {
    debug(`[Manager] Pausing looper for "${ps.name}".`);
    looper.pause();
  }
}

/**
 * Finds the active looper for a sound and tells it to re-arm its timers from the current position.
 * @param {PlaylistSound} ps The PlaylistSound whose loop should be resumed.
 */
export function resumeLoopWithin(ps) {
  const looper = State.getActiveLooper(ps);  //  Use State manager
  if (looper && !looper.isDestroyed) {
    debug(`[Manager] Resuming looper for "${ps.name}".`);
    looper.resume();
  }
}