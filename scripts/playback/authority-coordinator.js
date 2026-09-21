import { debug, MODULE_ID, PlaylistActionAuthority } from "../utils.js";
import { cancelCrossfade, scheduleCrossfade } from "../cross-fade.js";
import { runPlaybackRecoveryWatchdog } from "../playback-recovery.js";
import { State } from "../state-manager.js";
import { clearPendingLoopCompletion, reconcilePendingLoopCompletions } from "./loop-completion.js";

let registered = false;
let queued = false;
let notified = null;
const reasons = new Set();

export function queuePlaybackAuthorityReconcile(reason = "policy changed") {
  // Observe synchronously so even a coalesced A -> B -> A invalidates old work.
  PlaylistActionAuthority.getSelection();
  reasons.add(reason);
  if (queued) return;
  queued = true;
  globalThis.setTimeout(() => {
    queued = false;
    const next = PlaylistActionAuthority.getSelection();
    const eventReason = [...reasons].join(", ");
    reasons.clear();
    if (notified?.generation === next.generation) return;
    const previous = notified;
    notified = next;
    debug("[Playback Controller] Selection changed", {
      previousUserId: previous?.userId ?? null, userId: next.userId,
      reason: next.reason, event: eventReason,
    });
    Hooks.callAll(`${MODULE_ID}.playbackAuthorityChanged`, {
      previousUserId: previous?.userId ?? null, userId: next.userId,
      generation: next.generation, reason: eventReason,
    });
  }, 0);
}

export async function reconcileControllerPlayback(playlist = null) {
  const token = PlaylistActionAuthority.capture();
  if (!token) return;
  for (const pl of playlist ? [playlist] : Array.from(game.playlists ?? [])) {
    if (!PlaylistActionAuthority.isCurrent(token)) return;
    // Active transitions own their participants until their settlement hook.
    if (!pl.playing || State.isPlaylistCrossfading(pl)) continue;
    const real = Array.from(pl.sounds ?? []).filter(sound =>
      sound.playing && !sound.getFlag?.(MODULE_ID, "isSilenceGap")
    );
    if (real.length === 1) await scheduleCrossfade(pl, real[0]);
  }
  if (PlaylistActionAuthority.isCurrent(token)) runPlaybackRecoveryWatchdog("controller handoff");
}

export function registerPlaybackAuthorityHooks() {
  if (registered) return;
  registered = true;
  Hooks.on(`${MODULE_ID}.playbackControllerPolicyChanged`, () => queuePlaybackAuthorityReconcile("settings changed"));
  for (const event of ["userConnected", "createUser", "deleteUser"]) {
    Hooks.on(event, () => queuePlaybackAuthorityReconcile(event));
  }
  Hooks.on("updateUser", (_user, changes) => {
    if (Object.prototype.hasOwnProperty.call(changes ?? {}, "role")) queuePlaybackAuthorityReconcile("role changed");
  });
  const rearm = playlist => reconcileControllerPlayback(playlist).catch(error =>
    debug("[Playback Controller] Playback reconciliation failed", error?.message ?? error)
  );
  Hooks.on(`${MODULE_ID}.playbackAuthorityChanged`, () => {
    for (const playlist of game.playlists ?? []) cancelCrossfade(playlist);
    void reconcilePendingLoopCompletions();
    void rearm();
  });
  Hooks.on(`${MODULE_ID}.playbackTransitionSettled`, ({ playlist, mode }) => {
    if (mode === "complete") void rearm(playlist);
  });
  Hooks.on("updatePlaylistSound", (sound, changes) => {
    if (Object.prototype.hasOwnProperty.call(changes ?? {}, "playing")) {
      clearPendingLoopCompletion(sound);
      void rearm(sound.parent);
    }
  });
  Hooks.on("updatePlaylist", (playlist, changes) => {
    if (changes?.sounds || changes?.playing === false) {
      for (const sound of playlist.sounds ?? []) {
        if (!sound.playing || !playlist.playing) clearPendingLoopCompletion(sound);
      }
    }
    if (changes?.sounds || Object.prototype.hasOwnProperty.call(changes ?? {}, "playing")) void rearm(playlist);
  });
  Hooks.on("deletePlaylistSound", clearPendingLoopCompletion);
  Hooks.on("deletePlaylist", playlist => {
    for (const sound of playlist.sounds ?? []) clearPendingLoopCompletion(sound);
  });
  queuePlaybackAuthorityReconcile("ready");
}
