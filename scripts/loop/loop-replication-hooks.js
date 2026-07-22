/**
 * @file loop-replication-hooks.js
 * @description Internal-loop update hooks and replicated loop actions.
 */
import { cancelCrossfade } from "../cross-fade.js";
import { Flags } from "../flag-service.js";
import {
  cancelLoopWithin,
  executeLoopBreak,
  executeLoopDisable,
  executeSegmentSkip,
  scheduleLoopWithin,
} from "../internal-loop.js";
import { State } from "../state-manager.js";
import { debug, MODULE_ID, shouldProcessAction } from "../utils.js";

const SEGMENT_SKIP_RETRY_MS = 100;
const SEGMENT_SKIP_MAX_ATTEMPTS = 8;
const pendingSegmentSkipRetries = new Map();

function hasNestedPath(root, path) {
  if (!root || !path) return false;
  let current = root;
  for (const part of path.split(".")) {
    if (!current || !Object.prototype.hasOwnProperty.call(current, part)) return false;
    current = current[part];
  }
  return true;
}

function getNestedPath(root, path) {
  if (!hasNestedPath(root, path)) return undefined;
  let current = root;
  for (const part of path.split(".")) {
    current = current[part];
  }
  return current;
}

function hasModuleFlagChange(changes, path) {
  if (!changes || !path) return false;

  const flatKey = `flags.${MODULE_ID}.${path}`;
  if (Object.prototype.hasOwnProperty.call(changes, flatKey)) return true;
  if (foundry.utils.hasProperty(changes, flatKey)) return true;

  return hasNestedPath(changes?.flags?.[MODULE_ID], path);
}

function getModuleFlagChange(changes, path) {
  const flatKey = `flags.${MODULE_ID}.${path}`;
  if (Object.prototype.hasOwnProperty.call(changes ?? {}, flatKey)) {
    return changes[flatKey];
  }
  return getNestedPath(changes?.flags?.[MODULE_ID], path);
}

function segmentSkipRetryKey(soundDoc, seq) {
  return `${soundDoc.uuid ?? soundDoc.id}:${seq}`;
}

function executeSegmentSkipWithRetry(soundDoc, targetIndex, seq, attempt = 1) {
  if (executeSegmentSkip(soundDoc, targetIndex)) {
    pendingSegmentSkipRetries.delete(segmentSkipRetryKey(soundDoc, seq));
    return;
  }

  if (attempt >= SEGMENT_SKIP_MAX_ATTEMPTS) {
    pendingSegmentSkipRetries.delete(segmentSkipRetryKey(soundDoc, seq));
    debug(`[Segment-Sync] Gave up segment skip to index ${targetIndex} for "${soundDoc.name}" after ${attempt} attempt(s).`);
    return;
  }

  const key = segmentSkipRetryKey(soundDoc, seq);
  pendingSegmentSkipRetries.set(key, attempt);

  if (soundDoc.playing && !State.getActiveLooper(soundDoc)) {
    scheduleLoopWithin(soundDoc);
  }

  const wait = foundry.audio.AudioTimeout?.wait?.bind(foundry.audio.AudioTimeout);
  const delay = wait ? wait(SEGMENT_SKIP_RETRY_MS) : new Promise((resolve) => setTimeout(resolve, SEGMENT_SKIP_RETRY_MS));
  delay.then(() => {
    if (pendingSegmentSkipRetries.get(key) !== attempt) return;
    const liveSoundDoc = soundDoc.parent?.sounds?.get(soundDoc.id) ?? soundDoc;
    executeSegmentSkipWithRetry(liveSoundDoc, targetIndex, seq, attempt + 1);
  }).catch((err) => {
    if (pendingSegmentSkipRetries.get(key) === attempt) pendingSegmentSkipRetries.delete(key);
    debug(`[Segment-Sync] Retry timer failed for "${soundDoc.name}":`, err?.message ?? err);
  });
}

export function registerLoopReplicationHooks() {
  Hooks.on("updatePlaylistSound", (soundDoc, changes) => {
    const loopWithinPatch = getModuleFlagChange(changes, "loopWithin");
    const loopWithinPatchObject = loopWithinPatch && typeof loopWithinPatch === "object"
      ? loopWithinPatch
      : null;
    const hasLoopActiveChange =
      hasModuleFlagChange(changes, "loopWithin.active") ||
      Object.prototype.hasOwnProperty.call(loopWithinPatchObject ?? {}, "active");
    const hasLoopEnabledChange =
      hasModuleFlagChange(changes, "loopWithin.enabled") ||
      Object.prototype.hasOwnProperty.call(loopWithinPatchObject ?? {}, "enabled");

    if (
      hasModuleFlagChange(changes, "loopWithin") ||
      hasLoopActiveChange ||
      hasLoopEnabledChange
    ) {
      if (hasLoopActiveChange) {
        const isActive = hasModuleFlagChange(changes, "loopWithin.active")
          ? getModuleFlagChange(changes, "loopWithin.active")
          : loopWithinPatchObject?.active;
        if (isActive) {
          scheduleLoopWithin(soundDoc);
        } else {
          cancelLoopWithin(soundDoc);
        }
      }

      if (hasLoopEnabledChange) {
        const isEnabled = hasModuleFlagChange(changes, "loopWithin.enabled")
          ? getModuleFlagChange(changes, "loopWithin.enabled")
          : loopWithinPatchObject?.enabled;
        ui.playlists?.render();
        if (!isEnabled) {
          cancelLoopWithin(soundDoc);
        }
      }
    }

    if (hasModuleFlagChange(changes, "segmentSkip")) {
      const segmentSkip = soundDoc.getFlag(MODULE_ID, "segmentSkip") ?? {};
      const { targetIndex, seq } = segmentSkip;

      if (typeof targetIndex !== "number" || !Number.isFinite(seq)) return;

      if (!shouldProcessAction(soundDoc.id, seq, "snd")) {
        debug(`[Segment-Sync] Ignoring duplicate segment skip (seq ${seq}) for "${soundDoc.name}"`);
        return;
      }

      debug(`[Segment-Sync] Executing segment skip to index ${targetIndex} for "${soundDoc.name}"`);
      executeSegmentSkipWithRetry(soundDoc, targetIndex, seq);
    }

    if (hasModuleFlagChange(changes, "loopBreak")) {
      const loopBreak = soundDoc.getFlag(MODULE_ID, "loopBreak") ?? {};
      const { seq } = loopBreak;

      if (!Number.isFinite(seq)) return;

      if (!shouldProcessAction(soundDoc.id, seq, "snd")) {
        debug(`[LoopBreak-Sync] Ignoring duplicate loop break (seq ${seq}) for "${soundDoc.name}"`);
        return;
      }

      debug(`[LoopBreak-Sync] Executing loop break for "${soundDoc.name}"`);
      executeLoopBreak(soundDoc);
    }

    if (hasModuleFlagChange(changes, "loopDisable")) {
      const loopDisable = soundDoc.getFlag(MODULE_ID, "loopDisable") ?? {};
      const { seq } = loopDisable;

      if (!Number.isFinite(seq)) return;

      if (!shouldProcessAction(soundDoc.id, seq, "snd")) {
        debug(`[LoopDisable-Sync] Ignoring duplicate loop disable (seq ${seq}) for "${soundDoc.name}"`);
        return;
      }

      debug(`[LoopDisable-Sync] Executing loop disable for "${soundDoc.name}"`);
      executeLoopDisable(soundDoc);
    }
  });

  Hooks.on("updatePlaylistSound", (soundDoc, changes) => {
    if (!Object.prototype.hasOwnProperty.call(changes, "playing")) return;
    if (changes.playing !== false) return;
    if (!Number.isFinite(soundDoc.pausedTime)) return;

    const playlist = soundDoc.parent;
    if (!playlist || !Flags.getPlaybackMode(playlist).crossfade) return;

    const timer = State.getCrossfadeTimer(playlist);
    if (!timer) return;

    debug(`[CF] Cancelling crossfade timer for paused sound "${soundDoc.name}".`);
    cancelCrossfade(playlist);
  });
}
