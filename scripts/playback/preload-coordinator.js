/**
 * @file preload-coordinator.js
 * @description Adds early next-track loading only when a crossfade starts
 * before Foundry's native playlist preload window.
 */
import { Flags } from "../flag-service.js";
import { getPlayableSoundsInOrder } from "../playlist/playable-order.js";
import { debug, safeCancelTimer } from "../utils.js";

const DEFAULT_NATIVE_LEAD_SEC = 20;
const DEFAULT_SAFETY_LEAD_SEC = 5;
const activePreloads = new WeakMap();
const diagnosticSnapshots = new Map();

export function planCrossfadePreload({
  durationSec,
  currentTimeSec = 0,
  fadeMs,
  nativeLeadSec = DEFAULT_NATIVE_LEAD_SEC,
  safetyLeadSec = DEFAULT_SAFETY_LEAD_SEC,
}) {
  const duration = Number(durationSec);
  const currentTime = Math.max(0, Number(currentTimeSec) || 0);
  const fadeSec = Math.max(0, Number(fadeMs) || 0) / 1000;
  const nativeLead = Math.max(0, Number(nativeLeadSec) || 0);
  const safetyLead = Math.max(0, Number(safetyLeadSec) || 0);

  if (!Number.isFinite(duration) || duration <= 0 || fadeSec <= 0) {
    return { needed: false, status: "invalid-timing" };
  }

  const crossfadeAtSec = Math.max(0, duration - fadeSec);
  const desiredAtSec = Math.max(0, crossfadeAtSec - safetyLead);
  const nativeAtSec = Math.max(0, duration - nativeLead);

  if (nativeAtSec <= desiredAtSec) {
    return {
      needed: false,
      status: "native-sufficient",
      crossfadeAtSec,
      desiredAtSec,
      nativeAtSec,
    };
  }

  return {
    needed: true,
    status: currentTime >= desiredAtSec ? "load-now" : "schedule",
    crossfadeAtSec,
    desiredAtSec,
    nativeAtSec,
  };
}

export function resolveNextCrossfadeSound(playlist, currentSound) {
  if (!playlist || !currentSound) return null;
  const order = getPlayableSoundsInOrder(playlist);
  const index = order.findIndex((sound) => sound.id === currentSound.id);
  let next = index >= 0 ? order[index + 1] : null;
  if (!next && Flags.getPlaylistFlag(playlist, "loopPlaylist")) {
    next = order[0] ?? null;
  }
  if (!next || next.id === currentSound.id) return null;
  return next;
}

function updateDiagnostics(entry, updates = {}) {
  Object.assign(entry, updates, { updatedAt: Date.now() });
  if (entry.playlistId) {
    diagnosticSnapshots.set(entry.playlistId, {
      playlistId: entry.playlistId,
      playlistName: entry.playlistName,
      sourceSoundId: entry.sourceSoundId,
      sourceSoundName: entry.sourceSoundName,
      targetSoundId: entry.targetSoundId,
      targetSoundName: entry.targetSoundName,
      status: entry.status,
      crossfadeAtSec: entry.crossfadeAtSec ?? null,
      desiredAtSec: entry.desiredAtSec ?? null,
      nativeAtSec: entry.nativeAtSec ?? null,
      loadStartedAt: entry.loadStartedAt ?? null,
      loadCompletedAt: entry.loadCompletedAt ?? null,
      loadLatencyMs: entry.loadLatencyMs ?? null,
      error: entry.error ?? null,
      updatedAt: entry.updatedAt,
    });
  }
}

async function loadTarget(entry) {
  if (!entry || activePreloads.get(entry.playlist) !== entry) return null;
  if (entry.loadPromise) return entry.loadPromise;

  entry.timer = null;
  updateDiagnostics(entry, {
    status: "loading",
    loadStartedAt: Date.now(),
    error: null,
  });

  entry.loadPromise = Promise.resolve()
    .then(() => entry.targetSound.load())
    .then((result) => {
      if (activePreloads.get(entry.playlist) === entry) {
        const completedAt = Date.now();
        updateDiagnostics(entry, {
          status: "ready",
          loadCompletedAt: completedAt,
          loadLatencyMs: completedAt - entry.loadStartedAt,
        });
      }
      return result;
    })
    .catch((err) => {
      if (activePreloads.get(entry.playlist) === entry) {
        updateDiagnostics(entry, {
          status: "failed",
          error: err?.message ?? String(err),
        });
      }
      debug("[Preload] Failed to load next crossfade track:", err?.message ?? err);
      return null;
    });
  return entry.loadPromise;
}

export function cancelCrossfadePreload(playlist, { sourceSoundId = null, reason = "cancelled" } = {}) {
  const entry = activePreloads.get(playlist);
  if (!entry) return false;
  if (sourceSoundId && entry.sourceSoundId !== sourceSoundId) return false;

  safeCancelTimer(entry.timer, "crossfade preload");
  entry.timer = null;
  activePreloads.delete(playlist);
  updateDiagnostics(entry, { status: reason });
  return true;
}

export function scheduleCrossfadePreload(playlist, currentSound, {
  safetyLeadSec = DEFAULT_SAFETY_LEAD_SEC,
} = {}) {
  if (!playlist || !currentSound?.sound) return null;
  if (!Flags.getPlaybackMode(playlist).crossfade) {
    cancelCrossfadePreload(playlist, { reason: "crossfade-disabled" });
    return null;
  }

  const targetSound = resolveNextCrossfadeSound(playlist, currentSound);
  if (!targetSound || typeof targetSound.load !== "function") {
    cancelCrossfadePreload(playlist, { reason: "no-target" });
    return null;
  }

  const existing = activePreloads.get(playlist);
  if (
    existing?.sourceSoundId === currentSound.id &&
    existing?.targetSoundId === targetSound.id &&
    ["scheduled", "loading", "ready", "native-sufficient"].includes(existing.status)
  ) {
    return existing;
  }
  if (existing) cancelCrossfadePreload(playlist, { reason: "replaced" });

  const media = currentSound.sound;
  const nativeLeadSec = Number(CONFIG.Playlist?.autoPreloadSeconds);
  const plan = planCrossfadePreload({
    durationSec: media.duration,
    currentTimeSec: media.currentTime,
    fadeMs: Flags.getCrossfadeDuration(playlist),
    nativeLeadSec: Number.isFinite(nativeLeadSec)
      ? nativeLeadSec
      : DEFAULT_NATIVE_LEAD_SEC,
    safetyLeadSec,
  });

  const entry = {
    playlist,
    playlistId: playlist.id,
    playlistName: playlist.name,
    sourceSoundId: currentSound.id,
    sourceSoundName: currentSound.name,
    targetSound,
    targetSoundId: targetSound.id,
    targetSoundName: targetSound.name,
    timer: null,
    loadPromise: null,
    ...plan,
  };
  activePreloads.set(playlist, entry);

  if (targetSound.sound?.loaded) {
    updateDiagnostics(entry, { status: "ready", loadLatencyMs: 0 });
    return entry;
  }

  if (!plan.needed) {
    updateDiagnostics(entry);
    return entry;
  }

  if (plan.status === "load-now") {
    updateDiagnostics(entry);
    loadTarget(entry);
    return entry;
  }

  const handle = media.schedule(() => loadTarget(entry), plan.desiredAtSec);
  entry.timer = handle;
  updateDiagnostics(entry, { status: "scheduled" });
  debug(
    "[Preload] Scheduled " + targetSound.name + " at " +
    plan.desiredAtSec.toFixed(2) + "s for crossfade from " + currentSound.name + "."
  );
  return entry;
}

export function getCrossfadePreloadDiagnostics(playlist = null) {
  if (playlist) return diagnosticSnapshots.get(playlist.id) ?? null;
  return Array.from(diagnosticSnapshots.values());
}

export function registerCrossfadePreloadHooks() {
  Hooks.on("updatePlaylistSound", (sound, changes) => {
    if (Object.prototype.hasOwnProperty.call(changes ?? {}, "playing") && !sound.playing) {
      cancelCrossfadePreload(sound.parent, {
        sourceSoundId: sound.id,
        reason: Number.isFinite(Number(sound.pausedTime)) && sound.pausedTime !== null
          ? "paused"
          : "stopped",
      });
    }
  });
  Hooks.on("deletePlaylistSound", (sound) => {
    const entry = activePreloads.get(sound.parent);
    if (entry && [entry.sourceSoundId, entry.targetSoundId].includes(sound.id)) {
      cancelCrossfadePreload(sound.parent, { reason: "sound-deleted" });
    }
  });
  Hooks.on("deletePlaylist", (playlist) => {
    cancelCrossfadePreload(playlist, { reason: "playlist-deleted" });
    diagnosticSnapshots.delete(playlist.id);
  });
}
