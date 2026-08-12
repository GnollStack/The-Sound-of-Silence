// silence.js

/**
 * @file silence.js
 * @description Manages the "Sound of Silence" feature by creating, playing,
 * and cleaning up temporary silent audio tracks to serve as gaps between playlist sounds.
 */
import {
  debug,
  waitForMedia,
  MODULE_ID,
  logFeature,
  LogSymbols,
  PlaylistActionAuthority,
  warn,
} from "./utils.js";
import { Flags } from "./flag-service.js";
import { State } from "./state-manager.js";
import { maybeLoopPlaylist } from "./playlist-loop.js";

// Make Foundry's AudioTimeout class available in this file.
const AudioTimeout = foundry.audio.AudioTimeout;

const FLAG_KEY = "isSilenceGap";
const SOURCE_FLAG_KEY = "gapSourceSoundId";
const GAP_VOLUME = 0.01;
const GAP_NAME = "Silent Gap";
let recoveryHooksRegistered = false;
let recoveryQueue = Promise.resolve();

// ============================================
// Helper Functions
// ============================================


// A minimal 100ms silent WAV file - only 8.8 KB after base64 encoding
// This is a constant tiny file we'll reuse for all gaps
const MINIMAL_SILENT_WAV = (function generateMinimalSilence() {
  const sampleRate = 44100;
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const durationSec = 0.1; // 100ms

  const numSamples = Math.ceil(durationSec * sampleRate);
  const dataSize = numSamples * numChannels * bytesPerSample;
  const fileSize = 44 + dataSize;

  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);

  // WAV Header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, fileSize - 8, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Convert to base64
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return 'data:audio/wav;base64,' + btoa(binary);
})();

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Creates and plays a temporary, near-silent PlaylistSound document to serve as a gap.
 * It also patches the underlying Sound object's duration and currentTime properties
 * to make the Foundry UI timer reflect the gap's countdown.
 * @param {Playlist} playlist The parent playlist.
 * @param {number} durationMs The duration of the silent gap in milliseconds.
 * @param {PlaylistSound} sourceSound The sound which completed before this gap.
 * @param {object} state The pending state which owns this creation attempt.
 * @returns {Promise<PlaylistSound>} The created gap sound document.
 */
async function createAndPlayGap(playlist, durationMs, sourceSound, state) {
  const now = state.startedAt;

  // OPTIMIZATION: Use a tiny 100ms silent file instead of generating full-length audio
  // The actual duration is controlled by AudioTimeout, not the audio file itself
  const silentAudio = MINIMAL_SILENT_WAV;

  let gap;
  try {
    const [created] = await playlist.createEmbeddedDocuments("PlaylistSound", [{
      name: GAP_NAME,
      path: silentAudio,

      playing: true,

      volume: GAP_VOLUME,
      repeat: false,
      flags: {
        [MODULE_ID]: {
          [FLAG_KEY]: true,
          gapDuration: durationMs,
          gapStarted: now,
          [SOURCE_FLAG_KEY]: sourceSound?.id ?? null
        }
      }
    }]); // Ensure the noHook option is still removed from here
    gap = created;
    state.gap = gap;
  } catch (err) {
    warn("[Silence] Failed to create silent gap document:", err);
    debug(`[${MODULE_ID}] Silent gap creation failed, playlist will continue without gap.`);
    return null;
  }

  if (!isCurrentSilenceState(playlist, state)) {
    if (!state.abandoned) await discardGap(gap, "stale gap creation");
    return null;
  }

  try {
    await playlist.playSound(gap);
  } catch (err) {
    warn("[Silence] Failed to play silent gap:", err);
    if (!state.abandoned) {
      try {
        await gap.delete({ noHook: true });
      } catch (_) { }
    }
    return null;
  }

  if (!isCurrentSilenceState(playlist, state)) {
    if (!state.abandoned) await discardGap(gap, "stale gap playback");
    return null;
  }

  const sound = await waitForMedia(gap);

  if (!isCurrentSilenceState(playlist, state)) {
    if (!state.abandoned) await discardGap(gap, "stale gap media load");
    return null;
  }

  if (!sound) {
    debug(`[${MODULE_ID}] Failed to get sound object for silent gap.`);
    return gap;
  }

  patchGapMediaClock(sound, durationMs, now);

  ui.playlists?.render(true);
  logFeature(LogSymbols.SILENCE, 'Silence', `${playlist.name} (${durationMs}ms)`);
  return gap;
}

function isCurrentSilenceState(playlist, state) {
  return State.getSilenceState(playlist) === state &&
    !state?.cancelled &&
    !state?.completed &&
    PlaylistActionAuthority.isAuthorizedGM();
}

function patchGapMediaClock(sound, durationMs, startedAt) {
  if (!sound) return;
  const durSec = Math.max(0, Number(durationMs) || 0) / 1000;
  try {
    Object.defineProperty(sound, "duration", {
      configurable: true,
      get: () => durSec
    });
    Object.defineProperty(sound, "currentTime", {
      configurable: true,
      get: () => Math.min(Math.max(0, Date.now() - startedAt) / 1000, durSec)
    });
  } catch (err) {
    debug(`[${MODULE_ID}] Failed to patch silent-gap media clock:`, err?.message ?? err);
  }
}

async function discardGap(gap, reason) {
  if (!gap?.id || !gap.parent?.sounds?.has?.(gap.id)) return;
  try {
    await gap.delete();
  } catch (err) {
    debug(`[${MODULE_ID}] Failed to discard ${reason}:`, err?.message ?? err);
  }
}

function createSilenceState({ gap = null, sourceSound = null, gapMs, startedAt, recovered = false }) {
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  return {
    gap,
    cancelled: false,
    completed: false,
    abandoned: false,
    advancementComplete: false,
    completionAttempt: null,
    completionRetryCount: 0,
    deletingForCompletion: false,
    recovered,
    timer: null,
    resolve: resolveCompletion,
    completion,
    sourceSound,
    sourceSoundId: sourceSound?.id ?? gap?.getFlag?.(MODULE_ID, SOURCE_FLAG_KEY) ?? null,
    gapMs,
    startedAt,
    expectedEndAt: startedAt + gapMs
  };
}

function scheduleSilenceTimer(playlist, state, { delayMs = null, reason = null } = {}) {
  if (!isCurrentSilenceState(playlist, state)) return false;
  const remainingMs = delayMs === null
    ? Math.max(0, state.expectedEndAt - Date.now())
    : Math.max(0, Number(delayMs) || 0);
  let timer;
  try {
    timer = new AudioTimeout(remainingMs);
  } catch (err) {
    warn("[Silence] Failed to create audio-clock gap timer; using browser timer:", err);
    let timerId = null;
    let cancelled = false;
    const complete = new Promise((resolve) => {
      timerId = globalThis.setTimeout?.(resolve, remainingMs);
    });
    timer = {
      complete,
      cancel() {
        cancelled = true;
        if (timerId !== null) globalThis.clearTimeout?.(timerId);
        timerId = null;
      },
      get cancelled() {
        return cancelled;
      }
    };
  }

  state.timer = timer;
  timer.complete
    .then(() => {
      // Foundry resolves AudioTimeout.complete after cancellation, so the
      // explicit cancelled/current-state guards are required here.
      if (timer.cancelled || !isCurrentSilenceState(playlist, state)) return false;
      return completeSilenceGap(playlist, state, {
        reason: reason ?? (state.recovered ? "recovered-timer" : "timer")
      });
    })
    .catch((err) => {
      if (timer.cancelled || !isCurrentSilenceState(playlist, state)) return false;
      warn("[Silence] Gap timer failed; completing through the recovery path:", err);
      return completeSilenceGap(playlist, state, { reason: "timer-error" });
    });
  return true;
}

function scheduleSilenceCompletionRetry(playlist, state) {
  if (!isCurrentSilenceState(playlist, state)) return false;
  state.completionRetryCount = Math.max(0, Number(state.completionRetryCount) || 0) + 1;
  const delayMs = Math.min(1000 * (2 ** (state.completionRetryCount - 1)), 30000);
  debug(`[Silence] Retrying completion for "${playlist.name}" in ${delayMs} ms.`);
  return scheduleSilenceTimer(playlist, state, { delayMs, reason: "completion-retry" });
}

function abandonLocalSilenceState(playlist, state, reason) {
  if (!state) return;
  state.abandoned = true;
  state.cancelled = true;
  try {
    state.timer?.cancel?.();
  } catch (_) { }
  State.clearSilenceState(playlist, state);
  // The local operation did not complete naturally. The persisted document
  // remains available for the new authority, while this caller observes a
  // cancellation under the public playSilence contract.
  state.resolve?.(true);
  debug(`[Silence] Relinquished local gap state for "${playlist.name}" (${reason}).`);
}


/**
 * Cleans up a silent gap by clearing its timer, deleting the associated
 * PlaylistSound document, and removing its state from the global tracker.
 * @param {Playlist} playlist The parent playlist.
 * @param {object} state The state object for the silent gap from SOS_STATE.
 */
async function teardownGap(playlist, state) {
  // Delete the gap document first, then clear state to avoid race conditions
  // where another system checks hasSilenceState between clear and delete
  if (state.gap && playlist.sounds.has(state.gap.id)) {
    try {
      await state.gap.delete();
      debug(`[${MODULE_ID}] 🧹 Deleted silent gap "${state.gap.name}"`);
    } catch (err) {
      // A document hook can observe and remove the document before a wrapper
      // rejects. If the gap is already gone, cleanup still reached its goal.
      if (!playlist.sounds.has(state.gap.id)) {
        State.clearSilenceState(playlist, state);
        return true;
      }
      warn("[Silence] Failed to delete gap:", err);
      return false;
    }
  }

  State.clearSilenceState(playlist, state);
  return true;
}

async function restoreGapAfterFailedAdvancement(playlist, state) {
  if (!PlaylistActionAuthority.isAuthorizedGM() || State.getSilenceState(playlist) !== state) {
    if (State.getSilenceState(playlist) === state) {
      abandonLocalSilenceState(playlist, state, "authority changed during completion");
    }
    return false;
  }

  const gap = state.gap;
  if (!gap?.id || !playlist.sounds.has(gap.id)) return false;

  try {
    // A failed playSound can have stopped the gap before rejecting. Replaying
    // the persisted document keeps the transition recoverable for a retry or
    // an authority handoff.
    await playlist.playSound(gap);
    return true;
  } catch (err) {
    warn(`[Silence] Failed to restore the gap in "${playlist.name}" after advancement failed:`, err);
    return false;
  }
}

async function runSilenceCompletion(playlist, state, reason) {
  if (reason !== "timer") {
    try {
      state.timer?.cancel?.();
    } catch (_) { }
  }

  const gapMs = Number(state.gapMs ?? state.gap?.getFlag?.(MODULE_ID, "gapDuration")) || 0;
  const sourceSound = state.sourceSound ?? playlist.sounds.get(state.sourceSoundId);
  if (state.wasPlayingAtCompletion === undefined) {
    state.wasPlayingAtCompletion = Boolean(playlist.playing);
  }

  try {
    // Advance while the persisted gap still exists. If authority changes or a
    // document update fails, the gap remains a durable handoff/retry marker.
    if (!state.advancementComplete && state.wasPlayingAtCompletion && sourceSound) {
      if (!PlaylistActionAuthority.isAuthorizedGM()) {
        abandonLocalSilenceState(playlist, state, "authority changed before advancement");
        return false;
      }
      const order = playlist.playbackOrder;
      const sourceIndex = order.indexOf(sourceSound.id);
      const next = sourceIndex >= 0 ? playlist.sounds.get(order[sourceIndex + 1]) : null;

      if (next) {
        await playlist.playSound(next);
      } else {
        const loopRestart = maybeLoopPlaylist(playlist);
        if (loopRestart) await loopRestart;
        else await playlist.stopAll();
      }
      state.advancementComplete = true;
    } else if (!state.advancementComplete && state.wasPlayingAtCompletion && !sourceSound) {
      if (!PlaylistActionAuthority.isAuthorizedGM()) {
        abandonLocalSilenceState(playlist, state, "authority changed before safe stop");
        return false;
      }
      // Legacy gaps did not persist their source sound. Stopping is safer than
      // guessing a next track and potentially replaying or skipping content.
      debug(`[Silence] Recovered gap in "${playlist.name}" has no source sound; stopping safely.`);
      await playlist.stopAll();
      state.advancementComplete = true;
    } else if (!state.advancementComplete) {
      state.advancementComplete = true;
    }
  } catch (err) {
    warn(`[Silence] Failed to advance "${playlist.name}" after its gap:`, err);
    await restoreGapAfterFailedAdvancement(playlist, state);
    scheduleSilenceCompletionRetry(playlist, state);
    return false;
  }

  if (State.getSilenceState(playlist) !== state || state.cancelled) return false;
  if (!PlaylistActionAuthority.isAuthorizedGM()) {
    abandonLocalSilenceState(playlist, state, "authority changed before gap cleanup");
    return false;
  }

  // The deletion hook can run before delete() resolves. This narrow marker
  // lets it distinguish natural cleanup from an external early deletion.
  state.deletingForCompletion = true;
  const deleted = await teardownGap(playlist, state);
  state.deletingForCompletion = false;
  if (!deleted) {
    if (!PlaylistActionAuthority.isAuthorizedGM() && State.getSilenceState(playlist) === state) {
      abandonLocalSilenceState(playlist, state, "authority changed after gap deletion failed");
    }
    scheduleSilenceCompletionRetry(playlist, state);
    return false;
  }

  state.completed = true;
  debug(`[${MODULE_ID}] Silent gap of ${gapMs} ms completed for "${playlist.name}" (${reason})`);
  Hooks.callAll('the-sound-of-silence.silenceEnd', {
    playlist,
    duration: gapMs,
    completed: true
  });
  State.recordSilence(gapMs, false);
  state.resolve?.(false);
  return true;
}

export async function completeSilenceGap(playlist, state = State.getSilenceState(playlist), { reason = "timer" } = {}) {
  if (!playlist || !state || State.getSilenceState(playlist) !== state) return false;
  if (state.cancelled || state.completed) return false;
  if (!PlaylistActionAuthority.isAuthorizedGM()) return false;
  if (state.completionAttempt) return state.completionAttempt;

  const attempt = runSilenceCompletion(playlist, state, reason);
  state.completionAttempt = attempt;
  try {
    return await attempt;
  } finally {
    if (state.completionAttempt === attempt) state.completionAttempt = null;
  }
}


// ============================================
// Public API
// ============================================

/**
 * Attempt to start a silent gap without changing the public playSilence result contract.
 * @param {Playlist} playlist
 * @param {PlaylistSound} sourceSound
 * @returns {Promise<{started: boolean, completion: Promise<boolean>, reason: string, gapMs: number}>}
 */
export async function startSilenceGap(playlist, sourceSound) {
  if (!PlaylistActionAuthority.isAuthorizedGM()) {
    return { started: false, completion: Promise.resolve(false), reason: "not-authority", gapMs: 0 };
  }

  const gapMs = Flags.getSilenceDuration(playlist);
  if (playlist.mode === CONST.PLAYLIST_MODES.SIMULTANEOUS) {
    debug(`[${MODULE_ID}] Simultaneous mode - skipping silence.`);
    return { started: false, completion: Promise.resolve(false), reason: "simultaneous", gapMs };
  }
  if (gapMs <= 0) {
    debug("Gap skipped (duration is zero).");
    return { started: false, completion: Promise.resolve(false), reason: "zero-duration", gapMs };
  }

  const existing = State.getSilenceState(playlist);
  if (existing && !existing.cancelled && !existing.completed) {
    return {
      started: true,
      completion: existing.completion ?? Promise.resolve(false),
      reason: "already-active",
      gapMs: existing.gapMs ?? gapMs
    };
  }
  if (existing) State.clearSilenceState(playlist, existing);

  const state = createSilenceState({
    sourceSound,
    gapMs,
    startedAt: Date.now()
  });
  // Install pending ownership before the first await. Stop, duplicate _onEnd,
  // and watchdog recovery can now cancel or reuse this exact attempt.
  State.setSilenceState(playlist, state);

  debug(`Gap of ${gapMs}ms will be created.`);
  const gap = await createAndPlayGap(playlist, gapMs, sourceSound, state);
  if (!gap) {
    const reason = state.abandoned
      ? "authority-changed"
      : (state.cancelled || State.getSilenceState(playlist) !== state ? "cancelled" : "creation-failed");
    State.clearSilenceState(playlist, state);
    state.resolve?.(false);
    debug(`[${MODULE_ID}] Gap creation failed; native advancement may continue.`);
    return { started: false, completion: state.completion, reason, gapMs };
  }

  Hooks.callAll('the-sound-of-silence.silenceStart', { playlist, duration: gapMs });
  scheduleSilenceTimer(playlist, state);

  return { started: true, completion: state.completion, reason: "started", gapMs };
}

async function reconcilePersistedSilenceGaps(reason) {
  const playlists = Array.from(game.playlists ?? []);
  if (!PlaylistActionAuthority.isAuthorizedGM()) {
    for (const playlist of playlists) {
      const state = State.getSilenceState(playlist);
      if (state) abandonLocalSilenceState(playlist, state, reason);
    }
    return false;
  }

  let recoveredAny = false;
  for (const playlist of playlists) {
    const gaps = Array.from(playlist.sounds ?? [])
      .filter((sound) => Flags.getSoundFlag(sound, FLAG_KEY))
      .sort((left, right) => {
        if (Boolean(left.playing) !== Boolean(right.playing)) return left.playing ? -1 : 1;
        const leftStarted = Number(left.getFlag(MODULE_ID, "gapStarted")) || 0;
        const rightStarted = Number(right.getFlag(MODULE_ID, "gapStarted")) || 0;
        return rightStarted - leftStarted;
      });

    if (!gaps.length) {
      const staleState = State.getSilenceState(playlist);
      if (staleState?.recovered) abandonLocalSilenceState(playlist, staleState, "gap document missing");
      continue;
    }

    const gap = gaps[0];

    // A persisted document is recoverable only while it is the playlist's
    // active sound. Stopped gap documents are leftovers, not resumable work.
    if (!gap.playing || !playlist.playing) {
      for (const orphan of gaps) {
        await discardGap(orphan, `inactive persisted gap in "${playlist.name}"`);
      }
      const staleState = State.getSilenceState(playlist);
      if (staleState) abandonLocalSilenceState(playlist, staleState, "inactive gap document");
      continue;
    }

    for (const duplicate of gaps.slice(1)) {
      await discardGap(duplicate, `duplicate recovered gap in "${playlist.name}"`);
    }

    const current = State.getSilenceState(playlist);
    if (current && current.gap?.id === gap.id && !current.cancelled && !current.completed) {
      continue;
    }
    if (current) abandonLocalSilenceState(playlist, current, "replaced by persisted gap");

    const gapMs = Math.max(0, Number(gap.getFlag(MODULE_ID, "gapDuration")) || 0);
    const persistedStartedAt = Number(gap.getFlag(MODULE_ID, "gapStarted"));
    const startedAt = Number.isFinite(persistedStartedAt) && persistedStartedAt > 0
      ? persistedStartedAt
      : Date.now();
    const sourceSoundId = gap.getFlag(MODULE_ID, SOURCE_FLAG_KEY) ?? null;
    const sourceSound = sourceSoundId ? playlist.sounds.get(sourceSoundId) : null;
    const state = createSilenceState({
      gap,
      sourceSound,
      gapMs,
      startedAt,
      recovered: true
    });
    state.sourceSoundId = sourceSoundId;
    State.setSilenceState(playlist, state);
    patchGapMediaClock(gap.sound, gapMs, startedAt);

    debug(`[Silence] Recovered persisted gap in "${playlist.name}" (${reason}).`);
    recoveredAny = true;
    if (Date.now() >= state.expectedEndAt) {
      await completeSilenceGap(playlist, state, { reason: `recovered:${reason}` });
    } else {
      scheduleSilenceTimer(playlist, state);
    }
  }
  return recoveredAny;
}

/**
 * Reconcile persisted gap documents with the single currently-authorized GM.
 * Calls are serialized because ready and user-presence hooks can occur together.
 */
export function recoverPersistedSilenceGaps(reason = "manual") {
  recoveryQueue = recoveryQueue
    .catch(() => false)
    .then(() => reconcilePersistedSilenceGaps(reason));
  return recoveryQueue;
}

export function registerSilenceRecoveryHooks() {
  if (recoveryHooksRegistered) return;
  recoveryHooksRegistered = true;

  const queueAuthorityRecovery = (reason) => {
    globalThis.setTimeout?.(() => {
      recoverPersistedSilenceGaps(reason).catch((err) =>
        warn("[Silence] Failed to reconcile gap authority:", err)
      );
    }, 0);
  };

  Hooks.on("updateUser", () => queueAuthorityRecovery("user authority change"));
  Hooks.on("userConnected", () => queueAuthorityRecovery("user connection change"));

  Hooks.on("createPlaylistSound", (sound) => {
    if (!Flags.getSoundFlag(sound, FLAG_KEY)) return;
    queueAuthorityRecovery("silence gap document created");
  });

  Hooks.on("deletePlaylistSound", (sound) => {
    if (!Flags.getSoundFlag(sound, FLAG_KEY)) return;
    const playlist = sound.parent;
    const state = State.getSilenceState(playlist);
    if (state?.gap?.id !== sound.id) return;
    const naturalCompletion = state.completed || state.deletingForCompletion;
    if (!naturalCompletion) {
      state.cancelled = true;
      state.resolve?.(true);
    }
    state.timer?.cancel?.();
    State.clearSilenceState(playlist, state);
    // Natural completion resolves only after delete() itself succeeds and the
    // completion event/stat bookkeeping has been committed.
  });
}

export function bootstrapSilenceGapRecovery() {
  registerSilenceRecoveryHooks();
  return recoverPersistedSilenceGaps("ready");
}

export const Silence = {
  FLAG_KEY,
  SOURCE_FLAG_KEY,
  completeGap: completeSilenceGap,
  startGap: startSilenceGap,

  /**
   * Injects a silent track into the given playlist. This is the main entry point for the feature.
   * Returns a Promise that resolves to `true` if the silence is cancelled prematurely,
   * or `false` if it completes naturally.
   * @param {Playlist} playlist The playlist to play silence in.
   * @returns {Promise<boolean>} A promise resolving to true if cancelled, false otherwise.
   */
  async playSilence(playlist, sourceSound) {
    const transition = await startSilenceGap(playlist, sourceSound);
    return transition.completion;
  }
};
