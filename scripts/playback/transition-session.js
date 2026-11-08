/**
 * @file transition-session.js
 * @description Owns the local media lifecycle of an active playlist crossfade.
 */
import { cancelActiveFade, fadeOutAndStop } from "../audio-fader.js";
import { Flags } from "../flag-service.js";
import { State } from "../state-manager.js";
import { debug, MODULE_ID, safeCancelTimer, safeStop } from "../utils.js";

const AudioTimeout = foundry.audio.AudioTimeout;
const latestSessions = new WeakMap();

/** Short tail given to the outgoing media when a newer transition takes over mid-fade. */
export const HANDOFF_TAIL_MS = 250;

/**
 * Settlement modes:
 * - `complete`: commit the incoming target volume and stop the outgoing media.
 * - `pause`: stop both local participants; the incoming document stays the paused track.
 * - `cancel`: discard the incoming media and restore the outgoing target volume.
 * - `handoff`: a newer transition takes over. The incoming media stays live at its
 *   current gain and becomes that transition's outgoing participant; the old outgoing
 *   media gets a short tail. A session that never started fading keeps its outgoing
 *   media untouched and only discards its unstarted incoming media.
 * - `stop`: Stop All owns both participants. Gains are held where they are so the
 *   stop path can fade every live media from its current level.
 */
export const SETTLEMENT_MODES = Object.freeze(["complete", "pause", "cancel", "handoff", "stop"]);
const SETTLED_STATUSES = Object.freeze(["completed", "paused", "cancelled", "handed-off", "stopped"]);

function makeSessionId() {
  return foundry.utils?.randomID?.() ?? Math.random().toString(36).slice(2);
}

function resolveIncomingTargetVolume(session) {
  // A document volume, normalization or personal-mix change made while the
  // fade ran was deferred by the fade guards. Re-resolve at settlement instead
  // of committing the target captured when the fade was scheduled.
  const document = session.incomingDocument;
  if (document) {
    try {
      const resolved = Number(Flags.resolveTargetVolume(document));
      if (Number.isFinite(resolved)) return resolved;
    } catch (err) {
      debug("[Crossfade Session] Could not re-resolve incoming target volume:", err?.message ?? err);
    }
  }
  return session.incomingTargetVolume;
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
    // The newer transition inherits the previous incoming track as its
    // outgoing participant. Keep that media live instead of cancelling the
    // playlist back to the track that was already fading out.
    previous.settle({ mode: "handoff", reason: "replaced by newer transition" });
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
    !SETTLED_STATUSES.includes(session.status);
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

  const timerContext = outgoingSound?.context ?? incomingSound?.context ?? undefined;
  const timer = new AudioTimeout(session.durationMs + 50, timerContext ? { context: timerContext } : undefined);
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
  if (session.status === "settling" || SETTLED_STATUSES.includes(session.status)) return false;
  if (!SETTLEMENT_MODES.includes(mode)) mode = "cancel";

  const wasActive = session.status === "active";
  session.settlementMode = mode;
  session.status = "settling";
  safeCancelTimer(session.completionTimer, "crossfade session completion");
  session.completionTimer = null;

  // Hold both gains where they are. Each mode decides below what happens next;
  // none of them may leave a scheduled curve behind on media it no longer owns.
  if (session.outgoingSound) cancelActiveFade(session.outgoingSound);
  if (session.incomingSound) cancelActiveFade(session.incomingSound);

  if (State.getCrossfadeSession(playlist) === session) {
    State.clearCrossfadeSession(playlist, session);
  }

  if (mode === "complete") {
    if (session.incomingSound) session.incomingSound.volume = resolveIncomingTargetVolume(session);
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
  } else if (mode === "handoff") {
    if (!wasActive) {
      // Nothing has faded yet: the outgoing media is still the audible track
      // and the replacement transition will fade it. Only the unstarted
      // incoming media is discarded.
      await safeStop(session.incomingSound, "crossfade session handoff before activation");
    } else if (session.outgoingSound?.playing) {
      fadeOutAndStop(session.outgoingSound, HANDOFF_TAIL_MS).catch((err) =>
        debug("[Crossfade Session] Handoff tail failed:", err?.message ?? err)
      );
    }
    session.status = "handed-off";
  } else if (mode === "stop") {
    session.status = "stopped";
  } else {
    await safeStop(session.incomingSound, "crossfade session cancellation incoming");
    if (session.outgoingSound) session.outgoingSound.volume = session.outgoingTargetVolume;
    session.status = "cancelled";
  }

  debug("[Crossfade Session] " + session.id + " settled as " + session.status + " (" + reason + ").");
  Hooks.callAll(`${MODULE_ID}.playbackTransitionSettled`, { playlist, mode });
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
