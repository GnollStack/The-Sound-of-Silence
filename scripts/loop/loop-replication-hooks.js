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

export function registerLoopReplicationHooks() {
  Hooks.on("updatePlaylistSound", (soundDoc, changes) => {
    const moduleFlags = changes?.flags?.[MODULE_ID];
    if (!moduleFlags) return;

    const loopFlags = moduleFlags.loopWithin;
    if (loopFlags) {
      if (loopFlags.hasOwnProperty("active")) {
        const isActive = loopFlags.active;
        if (isActive) {
          scheduleLoopWithin(soundDoc);
        } else {
          cancelLoopWithin(soundDoc);
        }
      }

      if (loopFlags.hasOwnProperty("enabled")) {
        ui.playlists?.render();
        if (!loopFlags.enabled) {
          cancelLoopWithin(soundDoc);
        }
      }
    }

    if (moduleFlags.segmentSkip) {
      const segmentSkip = soundDoc.getFlag(MODULE_ID, "segmentSkip") ?? {};
      const { targetIndex, seq } = segmentSkip;

      if (typeof targetIndex !== "number" || !Number.isFinite(seq)) return;

      if (!shouldProcessAction(soundDoc.id, seq, "snd")) {
        debug(`[Segment-Sync] Ignoring duplicate segment skip (seq ${seq}) for "${soundDoc.name}"`);
        return;
      }

      debug(`[Segment-Sync] Executing segment skip to index ${targetIndex} for "${soundDoc.name}"`);
      executeSegmentSkip(soundDoc, targetIndex);
    }

    if (moduleFlags.loopBreak) {
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

    if (moduleFlags.loopDisable) {
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
