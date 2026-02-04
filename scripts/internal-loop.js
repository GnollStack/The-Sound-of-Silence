/**
 * @file internal-loop.js
 * @description Manages the lifecycle of LoopingSound instances. This file acts as the
 * public API for creating, canceling, pausing, and resuming per-track internal loops.
 * 
 */
import { MODULE_ID, debug, getNextSequence, shouldProcessAction } from "./utils.js";
import { LoopingSound } from "./looping-sound.js";
import { cancelCrossfade } from "./cross-fade.js";
import { Flags } from "./flag-service.js";
import { State } from "./state-manager.js";  //  Import State manager

const AudioTimeout = foundry.audio.AudioTimeout;

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

  // Start the looper with a small delay to avoid race conditions with Foundry's audio system.
  // Uses AudioTimeout to avoid browser throttling in background tabs.
  AudioTimeout.wait(50).then(() => {
    if (!looper.isDestroyed) {
      looper.start();
    }
  });
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
 * Handles the "break loop" command for a sound. GM executes locally and
 * uses flag-based replication to sync across all other clients.
 * @param {PlaylistSound} ps The PlaylistSound to break the loop for.
 */
export async function breakLoopWithin(ps) {
  // Only GM should initiate this action
  if (!game.user.isGM) return;

  const looper = State.getActiveLooper(ps);
  if (!looper || looper.isDestroyed) {
    debug(`[Manager] Cannot break loop for "${ps.name}" - no active looper.`);
    return;
  }

  // 1. Execute locally on GM first
  debug(`[Manager] Executing local loop break for "${ps.name}".`);
  looper.breakLoop();

  // 2. Then set flag to replicate to other clients
  debug(`[Manager] Replicating loop break for "${ps.name}" to other clients.`);
  await ps.setFlag(MODULE_ID, 'loopBreak', {
    seq: getNextSequence(ps.id),
    gmId: game.user.id
  });
}

/**
 * Directly executes a loop break on the local looper.
 * Called by the replication hook on non-GM clients.
 * @param {PlaylistSound} ps The PlaylistSound
 */
export function executeLoopBreak(ps) {
  const looper = State.getActiveLooper(ps);
  if (!looper || looper.isDestroyed) {
    debug(`[Manager] Cannot execute loop break for "${ps.name}" - no active looper.`);
    return;
  }

  debug(`[Manager] Executing replicated loop break for "${ps.name}".`);
  looper.breakLoop();
}

/**
 * Finds the active looper for a sound and tells it to skip to the next segment.
 * GM executes locally and uses flag-based replication for other clients.
 * @param {PlaylistSound} ps The PlaylistSound whose loop should advance.
 */
export async function nextSegmentWithin(ps) {
  // Only GM should initiate this action
  if (!game.user.isGM) return;

  const looper = State.getActiveLooper(ps);
  if (!looper || looper.isDestroyed || !looper.activeLoopSegment) {
    debug(`[Manager] Cannot skip to next segment for "${ps.name}" - no active segment.`);
    return;
  }

  const config = Flags.getLoopConfig(ps);
  if (config.segments.length <= 1) {
    debug(`[Manager] Cannot skip: only one segment configured for "${ps.name}".`);
    return;
  }

  const currentIndex = config.segments.findIndex(
    seg => seg.start === looper.activeLoopSegment.start
  );

  if (currentIndex === -1) {
    debug(`[Manager] Cannot find current segment in config for "${ps.name}".`);
    return;
  }

  const nextIndex = (currentIndex + 1) % config.segments.length;

  // 1. Execute locally on GM first
  debug(`[Manager] Executing local skip to segment ${nextIndex} for "${ps.name}".`);
  looper.skipToSegmentByIndex(nextIndex);

  // 2. Then set flag to replicate to other clients
  debug(`[Manager] Replicating segment skip to index ${nextIndex} for "${ps.name}".`);
  await ps.setFlag(MODULE_ID, 'segmentSkip', {
    targetIndex: nextIndex,
    seq: getNextSequence(ps.id),
    gmId: game.user.id
  });
}

/**
 * Finds the active looper for a sound and tells it to skip to the previous segment.
 * GM executes locally and uses flag-based replication for other clients.
 * @param {PlaylistSound} ps The PlaylistSound whose loop should go back.
 */
export async function previousSegmentWithin(ps) {
  // Only GM should initiate this action
  if (!game.user.isGM) return;

  const looper = State.getActiveLooper(ps);
  if (!looper || looper.isDestroyed || !looper.activeLoopSegment) {
    debug(`[Manager] Cannot skip to previous segment for "${ps.name}" - no active segment.`);
    return;
  }

  const config = Flags.getLoopConfig(ps);
  if (config.segments.length <= 1) {
    debug(`[Manager] Cannot skip: only one segment configured for "${ps.name}".`);
    return;
  }

  const currentIndex = config.segments.findIndex(
    seg => seg.start === looper.activeLoopSegment.start
  );

  if (currentIndex === -1) {
    debug(`[Manager] Cannot find current segment in config for "${ps.name}".`);
    return;
  }

  const prevIndex = (currentIndex - 1 + config.segments.length) % config.segments.length;

  // 1. Execute locally on GM first
  debug(`[Manager] Executing local skip to segment ${prevIndex} for "${ps.name}".`);
  looper.skipToSegmentByIndex(prevIndex);

  // 2. Then set flag to replicate to other clients
  debug(`[Manager] Replicating segment skip to index ${prevIndex} for "${ps.name}".`);
  await ps.setFlag(MODULE_ID, 'segmentSkip', {
    targetIndex: prevIndex,
    seq: getNextSequence(ps.id),
    gmId: game.user.id
  });
}

/**
 * Directly tells the local looper to skip to a specific segment index.
 * Called by the replication hook on non-GM clients.
 * @param {PlaylistSound} ps The PlaylistSound
 * @param {number} targetIndex The segment index to skip to
 */
export function executeSegmentSkip(ps, targetIndex) {
  const looper = State.getActiveLooper(ps);
  if (!looper || looper.isDestroyed) {
    debug(`[Manager] Cannot execute skip to segment ${targetIndex} for "${ps.name}" - no active looper.`);
    return;
  }

  debug(`[Manager] Executing replicated skip to segment ${targetIndex} for "${ps.name}".`);
  looper.skipToSegmentByIndex(targetIndex);
}

/**
 * Disables all looping for a sound and lets it play through naturally.
 * GM executes locally and uses flag-based replication for other clients.
 * @param {PlaylistSound} ps The PlaylistSound whose looping should be disabled.
 */
export async function disableAllLoopsWithin(ps) {
  // Only GM should initiate this action
  if (!game.user.isGM) return;

  const looper = State.getActiveLooper(ps);
  if (!looper || looper.isDestroyed) {
    debug(`[Manager] Cannot disable loops for "${ps.name}" - no active looper.`);
    return;
  }

  // 1. Execute locally on GM first
  debug(`[Manager] Executing local loop disable for "${ps.name}".`);
  looper.disableLooping();

  // 2. Then set flag to replicate to other clients
  debug(`[Manager] Replicating loop disable for "${ps.name}".`);
  await ps.setFlag(MODULE_ID, 'loopDisable', {
    seq: getNextSequence(ps.id),
    gmId: game.user.id
  });
}

/**
 * Directly executes loop disabling on the local looper.
 * Called by the replication hook on non-GM clients.
 * @param {PlaylistSound} ps The PlaylistSound
 */
export function executeLoopDisable(ps) {
  const looper = State.getActiveLooper(ps);
  if (!looper || looper.isDestroyed) {
    debug(`[Manager] Cannot execute loop disable for "${ps.name}" - no active looper.`);
    return;
  }

  debug(`[Manager] Executing replicated loop disable for "${ps.name}".`);
  looper.disableLooping();
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