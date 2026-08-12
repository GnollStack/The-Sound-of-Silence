/**
 * @file transition-session.js
 * @description Owns the local media lifecycle of an active playlist crossfade.
 */
import { cancelActiveFade } from "../audio-fader.js";
import { State } from "../state-manager.js";
import { debug, safeCancelTimer, safeStop } from "../utils.js";

const AudioTimeout = foundry.audio.AudioTimeout;
const latestSessions = new WeakMap();

function makeSessionId() {
  return foundry.utils?.randomID?.() ?? Math.random().toString(36).slice(2);
}

export function createCrossfadeSession({
  playlist,
  outgoingDocument,
  incomingDocument,
  outgoingSound = null,
  durationMs = 0,
  outgoingTargetVolume = 1,
  source = "crossfade",
  onComplete = null,
}) {
  if (!playlist) return null;

  const previous = State.getCrossfadeSession(playlist);
  if (previous?.settle) {
    previous.settle({ mode: "cancel", reason: "replaced by newer transition" });
  }

  const session = {
    id: makeSessionId(),
    playlist,
    outgoingDocument,
    incomingDocument,
    outgoingSound,
    incomingSound: null,
    durationMs: Math.max(0, Number(durationMs) || 0),
    outgoingTargetVolume: Number.isFinite(Number(outgoingTargetVolume))
      ? Number(outgoingTargetVolume)
      : 1,
    incomingTargetVolume: 1,
    source,
    status: "preparing",
    settlementMode: null,
    startedAt: null,
    completionTimer: null,
    fadeTokens: null,
    onComplete,
  };

  session.settle = (options = {}) =>
    settleCrossfadeSession(playlist, { session, ...options });

  State.setCrossfadeSession(playlist, session);
  latestSessions.set(playlist, session);
  return session;
}

export function isCurrentCrossfadeSession(session) {
  return !!session &&
    State.getCrossfadeSession(session.playlist) === session &&
    !["completed", "paused", "cancelled"].includes(session.status);
}

export function isLatestCrossfadeSession(session) {
  return !!session && latestSessions.get(session.playlist) === session;
}

export function activateCrossfadeSession(session, {
  outgoingSound = session?.outgoingSound,
  incomingSound = session?.incomingSound,
  incomingTargetVolume = session?.incomingTargetVolume ?? 1,
  fadeTokens = null,
} = {}) {
  if (!isCurrentCrossfadeSession(session)) return false;

  session.outgoingSound = outgoingSound ?? null;
  session.incomingSound = incomingSound ?? null;
  session.incomingTargetVolume = Number.isFinite(Number(incomingTargetVolume))
    ? Number(incomingTargetVolume)
    : 1;
  session.fadeTokens = fadeTokens;
  session.status = "active";
  session.startedAt = Date.now();

  const timer = new AudioTimeout(session.durationMs + 50);
  session.completionTimer = timer;
  timer.complete
    .then(() => {
      // Foundry v14 resolves AudioTimeout.complete after cancellation. Only the
      // timer that still owns this active session may complete the crossfade.
      if (timer.cancelled || session.completionTimer !== timer || !isCurrentCrossfadeSession(session)) {
        return false;
      }
      return session.settle({ mode: "complete", reason: "fade timer completed" });
    })
    .catch((err) => {
      debug("[Crossfade Session] Completion timer failed:", err?.message ?? err);
      if (timer.cancelled || session.completionTimer !== timer || !isCurrentCrossfadeSession(session)) {
        return false;
      }
      return session.settle({ mode: "complete", reason: "fade timer failed" });
    });
  return true;
}

export async function settleCrossfadeSession(playlist, {
  session = State.getCrossfadeSession(playlist),
  mode = "cancel",
  reason = "requested",
} = {}) {
  if (!session || session.playlist !== playlist) return false;
  if (["settling", "completed", "paused", "cancelled"].includes(session.status)) return false;

  session.settlementMode = mode;
  session.status = "settling";
  safeCancelTimer(session.completionTimer, "crossfade session completion");
  session.completionTimer = null;

  if (session.outgoingSound) cancelActiveFade(session.outgoingSound);
  if (session.incomingSound) cancelActiveFade(session.incomingSound);

  if (State.getCrossfadeSession(playlist) === session) {
    State.clearCrossfadeSession(playlist, session);
  }

  if (mode === "complete") {
    if (session.incomingSound) session.incomingSound.volume = session.incomingTargetVolume;
    await safeStop(session.outgoingSound, "crossfade session completion");
    session.status = "completed";
    try {
      await session.onComplete?.(session);
    } catch (err) {
      debug("[Crossfade Session] Completion callback failed:", err?.message ?? err);
    }
  } else if (mode === "pause") {
    await Promise.all([
      safeStop(session.outgoingSound, "crossfade session pause outgoing"),
      safeStop(session.incomingSound, "crossfade session pause incoming"),
    ]);
    session.status = "paused";
  } else {
    await safeStop(session.incomingSound, "crossfade session cancellation incoming");
    if (session.outgoingSound) session.outgoingSound.volume = session.outgoingTargetVolume;
    session.status = "cancelled";
  }

  debug("[Crossfade Session] " + session.id + " settled as " + session.status + " (" + reason + ").");
  return true;
}

export function summarizeCrossfadeSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    status: session.status,
    source: session.source,
    outgoingSoundId: session.outgoingDocument?.id ?? null,
    incomingSoundId: session.incomingDocument?.id ?? null,
    durationMs: session.durationMs,
    startedAt: session.startedAt,
  };
}
