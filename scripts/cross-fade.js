// cross-fade.js - Automatic cross-fading for Foundry VTT playlists

import {
  MODULE_ID,
  debug,
  waitForMedia,
  waitForAudioOrBrowserDelay,
  isAudioUnlocked,
  logFeature,
  LogSymbols,
  safeStop,
  getNextSequence,
  error,
  PlaylistActionAuthority,
} from "./utils.js";
import { cancelActiveFade, equalPowerCrossfade, fadeOutAndStop } from "./audio-fader.js";
import { Flags } from "./flag-service.js";
import { PlaybackClock } from "./playback-clock.js";
import {
  activateCrossfadeSession,
  createCrossfadeSession,
  isCurrentCrossfadeSession,
  isLatestCrossfadeSession,
} from "./playback/transition-session.js";
import { State } from "./state-manager.js";

const AudioTimeout = foundry.audio.AudioTimeout;
const PM = CONST.PLAYLIST_MODES;

function internalLoopOwnsPlayback(ps) {
  const looper = State.getActiveLooper(ps);
  if (looper && !looper.isDestroyed) return true;

  const config = Flags.getLoopConfig(ps);
  return Flags.isLoopConfigActive(config);
}

async function loadCrossfadeMedia(ps) {
  if (!ps) return null;
  if (!isAudioUnlocked()) {
    debug(`[CF] Skipping media load for "${ps.name}" until Foundry audio is unlocked.`);
    return null;
  }

  if (!ps.sound && typeof ps.load === "function") {
    try {
      await ps.load();
    } catch (err) {
      debug(`[CF] Failed to load media for "${ps.name}":`, err?.message ?? err);
      if (!isAudioUnlocked()) return null;
    }
  }

  return waitForMedia(ps);
}

export function describeCrossfadeAudioGraph(sound) {
  if (!sound) {
    return {
      hasSound: false,
      playing: false,
      hasGain: false,
      hasContext: false,
    };
  }

  const gainValue = Number(sound.gain?.value);
  const volume = Number(sound.volume);
  const currentTime = Number(sound.currentTime);
  const duration = Number(sound.duration);

  return {
    hasSound: true,
    playing: Boolean(sound.playing),
    hasGain: Boolean(sound.gain),
    hasContext: Boolean(sound.context),
    contextState: sound.context?.state ?? null,
    gainValue: Number.isFinite(gainValue) ? Number(gainValue.toFixed(3)) : null,
    volume: Number.isFinite(volume) ? Number(volume.toFixed(3)) : null,
    currentTime: Number.isFinite(currentTime) ? Number(currentTime.toFixed(3)) : null,
    duration: Number.isFinite(duration) ? Number(duration.toFixed(3)) : null,
  };
}

async function waitForCrossfadeAudioGraph(sound, ps, timeoutMs = 1000) {
  const timeout = Math.max(0, Number(timeoutMs) || 0);
  const startedAt = Date.now();
  let loggedWait = false;

  while (Date.now() - startedAt <= timeout) {
    if (sound?.playing && sound.gain && sound.context) {
      if (loggedWait) {
        debug(`[CF] Audio graph became ready for "${ps?.name ?? "unknown"}".`, describeCrossfadeAudioGraph(sound));
      }
      return true;
    }

    if (!loggedWait) {
      loggedWait = true;
      debug(`[CF] Waiting for audio graph for "${ps?.name ?? "unknown"}".`, describeCrossfadeAudioGraph(sound));
    }

    await waitForAudioOrBrowserDelay(50);
  }

  debug(`[CF] Audio graph not ready for "${ps?.name ?? "unknown"}" after ${timeout}ms.`, describeCrossfadeAudioGraph(sound));
  return false;
}

export async function prepareIncomingCrossfadeMedia(ps) {
  const sound = await loadCrossfadeMedia(ps);
  if (!sound) return null;

  if (!sound.playing) {
    try {
      cancelActiveFade(sound);
      sound.volume = 0;
      await sound.play({ _fromCrossfade: true });
    } catch (err) {
      debug(`[CF] Failed to start incoming crossfade media for "${ps.name}":`, err?.message ?? err);
      return null;
    }
  } else if (!State.isSoundFading(sound)) {
    try {
      cancelActiveFade(sound);
      sound.volume = 0;
    } catch (err) {
      debug(`[CF] Failed to prepare already-playing crossfade media for "${ps.name}":`, err?.message ?? err);
      return null;
    }
  }

  if (!sound.gain) {
    await waitForCrossfadeAudioGraph(sound, ps);
  }

  debug(`[CF] Incoming crossfade media prepared for "${ps.name}".`, describeCrossfadeAudioGraph(sound));

  return sound;
}

/**
 * Contains the core logic for performing a crossfade.
 * This can be called manually for a skip, or automatically by the scheduler.
 * @param {Playlist} playlist The playlist document.
 * @param {PlaylistSound} soundToFade The sound that needs to be faded out.
 * @param {object} [options]
 * @param {boolean} [options.recovery=false] Allow document advancement even if the owner media clock stalled.
 * @param {PlaylistSound} [options.incomingSound=null] Explicit incoming sound for manual targeted crossfades.
 * @param {string} [options.reason="auto"] Diagnostic reason for the transition.
 * @returns {Promise<boolean>} Whether a transition or terminal stop was successfully committed.
 */
export async function performCrossfade(playlist, soundToFade, { recovery = false, incomingSound = null, reason = "auto" } = {}) {
  const soundOut = soundToFade?.sound;
  if (!playlist || !soundToFade) return false;

  // Automatic transitions are authored by one deterministic GM. Explicit
  // user actions remain available to any GM who owns the playlist.
  const automatic = recovery || reason === "auto";
  if (!playlist.isOwner || !game.user?.isGM || (automatic && !PlaylistActionAuthority.isAuthorizedGM())) {
    debug(`[CF] Non-authority client skipping crossfade execution for "${soundToFade.name}".`);
    return false;
  }

  if (State.isPlaylistCrossfading(playlist)) {
    debug(`[CF] Skipping ${reason} crossfade for "${soundToFade.name}" because another crossfade is already active.`);
    return false;
  }

  if (!soundToFade.playing || (!soundOut?.playing && !recovery)) {
    debug(`[CF] Skipping crossfade for "${soundToFade.name}" because it is no longer actively playing.`);
    cancelCrossfade(playlist);
    return false;
  }
  if (recovery && !soundOut?.playing) {
    debug(`[CF] Recovery crossfade proceeding for "${soundToFade.name}" without live outgoing media (${reason}).`);
  }

  const fadeMs = Flags.getCrossfadeDuration(playlist);
  if (fadeMs <= 0) return false;

  cancelCrossfade(playlist);

  debug(`[CF] ${recovery ? "Recovery" : reason} crossfade triggered for "${soundToFade.name}". Fading out over ${fadeMs}ms.`);

  // 1. Find the next track to play.
  const order = playlist.playbackOrder;
  const currentIndex = order.indexOf(soundToFade.id);
  const nextId = order[currentIndex + 1];
  let soundToPlay = incomingSound instanceof PlaylistSound ? incomingSound : (nextId ? playlist.sounds.get(nextId) : null);

  if (soundToPlay?.id === soundToFade.id) {
    debug(`[CF] Skipping crossfade because incoming and outgoing sound are the same.`);
    return false;
  }

  if (!soundToPlay && !incomingSound) {
    if (Flags.getPlaylistFlag(playlist, "loopPlaylist") && order.length > 0) {
      debug('[CF] Reached end of playlist; looping back to the start.');
      soundToPlay = playlist.sounds.get(order[0]);
    }
  }

  if (!soundToPlay) {
    debug(`[CF] No next track found. Fading out "${soundToFade.name}" and stopping.`);
    const stopPlaylist = () => {
      // The terminal fade is delayed. A manual play during that window owns
      // the playlist now and must not be stopped by this stale completion.
      const hasReplacement = playlist.sounds.some((sound) =>
        sound.id !== soundToFade.id &&
        sound.playing &&
        !Flags.getSoundFlag(sound, "isSilenceGap")
      );
      if (!playlist.playing || hasReplacement) return;
      Promise.resolve(playlist.stopAll()).catch((err) =>
        debug(`[CF] Failed to stop "${playlist.name}" at playlist end:`, err?.message ?? err)
      );
    };
    if (soundOut?.playing) {
      fadeOutAndStop(soundOut, fadeMs).catch((err) =>
        debug(`[CF] Final fade failed for "${soundToFade.name}":`, err?.message ?? err)
      );
      AudioTimeout.wait(fadeMs).then(stopPlaylist).catch(stopPlaylist);
    } else if (playlist.playing) {
      stopPlaylist();
    }
    return true;
  }

  // 2. Start playing the next track directly, bypassing Foundry's "stop current first" behavior.
  //    Register the transition before any await so pause/stop can settle it safely.
  const sharedTargetVolIn = Flags.resolveSharedTargetVolume(soundToPlay);
  const targetVolIn = Flags.resolveTargetVolume(soundToPlay, { sharedVolume: sharedTargetVolIn });
  const transitionSession = createCrossfadeSession({
    playlist,
    outgoingDocument: soundToFade,
    incomingDocument: soundToPlay,
    outgoingSound: soundOut,
    durationMs: fadeMs,
    outgoingTargetVolume: Flags.resolveTargetVolume(soundToFade),
    source: recovery ? "recovery:" + reason : reason,
    onComplete: () => {
      debug(`[CF] Crossfade complete: "${soundToFade.name}" -> "${soundToPlay.name}"`);
      Hooks.callAll("the-sound-of-silence.crossfadeComplete", {
        playlist,
        fromSound: soundToFade,
        toSound: soundToPlay,
      });
    },
  });
  let crossfadeSuccessful = false;
  const incomingWasPlaying = soundToPlay.playing === true;
  let incomingDocumentCommitted = false;
  let outgoingDocumentCommitted = false;

  try {
    // Update the document to reflect the new playing state without triggering stopSound
    await soundToPlay.update({ playing: true, pausedTime: null }, { render: false });
    incomingDocumentCommitted = true;

    // Directly load and play the audio, bypassing native sync/autoplay.
    const soundIn = await prepareIncomingCrossfadeMedia(soundToPlay);
    if (!isCurrentCrossfadeSession(transitionSession)) {
      if (soundIn?.playing) safeStop(soundIn, "stale incoming crossfade media");
      return false;
    }
    transitionSession.incomingSound = soundIn;
    transitionSession.incomingTargetVolume = targetVolIn;
    if (!soundIn) {
      debug(`[CF] Failed to load incoming sound "${soundToPlay.name}". Publishing document-only transition.`);
    } else {
      PlaybackClock.record(playlist, soundToPlay, soundIn, {
        reason: recovery ? `crossfade recovery:${reason}` : "crossfade",
      }).catch((err) => debug(`[CF] Failed to record incoming playback clock:`, err?.message ?? err));
    }

    // Cancel Foundry's built-in _scheduleFadeOut on both sounds.
    // When third-party modules force a non-zero playlist.fade, _onStart() schedules
    // an independent fade-out near the end of the track that competes with our
    // crossfade timer and can destroy our setValueCurveAtTime curves.
    if (typeof soundToFade._cancelFadeOut === "function") {
      soundToFade._cancelFadeOut();
    }
    if (typeof soundToPlay._cancelFadeOut === "function") {
      soundToPlay._cancelFadeOut();
    }

    // Emit crossfade start event
    Hooks.callAll('the-sound-of-silence.crossfadeStart', {
      playlist,
      fromSound: soundToFade,
      toSound: soundToPlay,
      duration: fadeMs
    });

    State.recordCrossfade(fadeMs);

    // 3. Perform the equal-power crossfade, passing the normalized target volume
    //    explicitly so it doesn't rely on _manager.volume (which may be stale).
    debug(`[CF] Crossfading from "${soundToFade.name}" to "${soundToPlay.name}" (targetVol=${targetVolIn.toFixed(3)}).`);
    const canLocalCrossfade = !!(soundOut?.playing && soundOut?.gain && soundIn?.gain);
    let fadeTokens = null;
    if (canLocalCrossfade) {
      fadeTokens = equalPowerCrossfade(soundOut, soundIn, fadeMs, { targetVolIn });
    } else if (soundIn) {
      debug(`[CF] Local equal-power crossfade unavailable; snapping "${soundToPlay.name}" to target volume.`);
      soundIn.volume = targetVolIn;
    } else {
      debug(`[CF] Local incoming media unavailable; clients will use the replicated transition.`);
    }

    if (!activateCrossfadeSession(transitionSession, {
      outgoingSound: soundOut,
      incomingSound: soundIn,
      incomingTargetVolume: targetVolIn,
      fadeTokens,
    })) {
      if (soundIn?.playing) safeStop(soundIn, "cancelled crossfade activation");
      return false;
    }

    // 4. Replicate the crossfade to non-GM clients BEFORE marking the outgoing sound
    //    as stopped — ensures clients receive the instruction while the outgoing sound
    //    is still playing so they can apply the equal-power curves.
    await playlist.setFlag(MODULE_ID, "crossfadeTransition", {
      incomingSoundId: soundToPlay.id,
      outgoingSoundId: soundToFade.id,
      fadeMs,
      targetVolIn: sharedTargetVolIn,
      seq: getNextSequence(playlist.id),
      gmId: game.user.id,
    });

    // Pause/stop or a replacement transition may settle this session while
    // the replication document update is in flight. A normally completed
    // zero-duration session may still finish the outgoing document commit.
    const currentSession = State.getCrossfadeSession(playlist);
    const completedWithoutReplacement =
      !currentSession &&
      isLatestCrossfadeSession(transitionSession) &&
      transitionSession.settlementMode === "complete" &&
      ["settling", "completed"].includes(transitionSession.status);
    if (!isCurrentCrossfadeSession(transitionSession) && !completedWithoutReplacement) {
      return false;
    }

    // 5. Immediately update the outgoing sound's document state for UI purposes.
    //    The audio continues playing/fading, but the UI shows the new track as current.
    //    Omit render: false so Foundry re-renders the playlist UI on ALL clients.
    await soundToFade.update({ playing: false, pausedTime: null });
    outgoingDocumentCommitted = true;

    crossfadeSuccessful = true;

  } catch (err) {
    error("[Crossfade] Error:", err);
    await transitionSession?.settle({ mode: "cancel", reason: "crossfade error" });
  } finally {
    if (!crossfadeSuccessful) {
      await transitionSession?.settle({ mode: "cancel", reason: "crossfade did not commit" });
      if (
        incomingDocumentCommitted &&
        !incomingWasPlaying &&
        !outgoingDocumentCommitted &&
        isLatestCrossfadeSession(transitionSession) &&
        transitionSession.settlementMode !== "complete" &&
        soundToPlay.playing === true &&
        soundToFade.playing === true
      ) {
        try {
          await soundToPlay.update(
            { playing: false, pausedTime: null },
            { render: false, _sosCrossfadeRollback: true }
          );
          debug(`[CF] Rolled back incoming document "${soundToPlay.name}" after unsuccessful commit.`);
        } catch (rollbackError) {
          error(`[Crossfade] Failed to roll back incoming document "${soundToPlay.name}":`, rollbackError);
        }
      }
    }
  }
  return crossfadeSuccessful;
}

/**
 * Clears any pending cross-fade timeout for the given playlist. Also cleans up
 * any one-shot "play" event listeners that haven't fired yet.
 * @param {Playlist} playlist The playlist for which to cancel the crossfade.
 */
export function cancelCrossfade(playlist) {
  const handle = State.getCrossfadeTimer(playlist);
  if (handle) {
    logFeature(LogSymbols.CROSSFADE_CANCEL, 'CF', `Cancel: ${playlist.name}`);

    // The handle from sound.schedule() is a promise with a .timeout property
    if (handle.timeout) {
      handle.timeout.cancel();
    }
  }
  State.clearCrossfadeTimer(playlist);

  const waiter = State.getPlayWaiter(playlist);
  if (waiter) {
    try {
      waiter.sound?.removeEventListener?.("play", waiter.onPlay);
    } catch (_) { /* no-op */ }
    State.clearPlayWaiter(playlist);
  }
}

/**
 * Arms a timer that will trigger `performCrossfade` at the correct time for a given sound.
 * This is scheduled so the fade-out of the current track finishes as the track itself ends.
 * @param {Playlist} playlist The parent playlist document.
 * @param {PlaylistSound} ps The PlaylistSound that was just started and needs a crossfade scheduled.
 * @param {object} [options]
 * @param {boolean} [options.force=false] Cancel and replace an existing timer for the same sound.
 */
export async function scheduleCrossfade(playlist, ps, { force = false } = {}) {
  if (!playlist?.isOwner || !PlaylistActionAuthority.isAuthorizedGM() || !ps) return;
  if (![PM.SEQUENTIAL, PM.SHUFFLE].includes(playlist.mode)) return;
  if (!Flags.getPlaybackMode(playlist).crossfade) return;

  // Guard: Skip if we already have a timer scheduled for this exact sound
  const existingTimer = State.getCrossfadeTimer(playlist);
  if (existingTimer?.soundId === ps.id) {
    const isCancelled = !!existingTimer.timeout?.cancelled;
    if (!force && !isCancelled) {
      debug(`[CF] Timer already scheduled for "${ps.name}", skipping duplicate.`);
      return;
    }
    debug(`[CF] Re-arming ${isCancelled ? "cancelled " : ""}timer for "${ps.name}".`);
  }

  // Use the same logic as performCrossfade to get the fade duration
  const fadeMs = Flags.getCrossfadeDuration(playlist);

  if (fadeMs <= 0) return;
  if (ps.repeat) return;
  if (internalLoopOwnsPlayback(ps)) {
    debug(`[CF] Skipping auto crossfade schedule for "${ps.name}" because internal loop owns playback.`);
    return;
  }

  cancelCrossfade(playlist);

  const sound = await waitForMedia(ps);
  if (!sound) return;

  function armTimer() {
    State.clearPlayWaiter(playlist);  //  Use State manager

    if (!ps.playing || !sound.playing) {
      debug(`[CF] Skipping auto crossfade - "${ps.name}" is not actively playing.`);
      return;
    }

    const dur = Number(sound.duration);

    if (!Number.isFinite(dur) || dur <= 0) {
      debug(`[CF] Skipping auto crossfade – invalid duration for "${ps.name}".`);
      return;
    }

    const fireAt = Math.max(0, dur - (fadeMs / 1000)); // Now uses correct fadeMs
    const currentTime = Number(sound.currentTime);

    if (!Number.isFinite(currentTime)) {
      debug(`[CF] Skipping auto crossfade - invalid currentTime for "${ps.name}".`);
      return;
    }

    if (currentTime >= fireAt) {
      debug(`[CF] Skipping auto crossfade - track already past fade point for "${ps.name}"`);
      return;
    }

    logFeature(LogSymbols.CROSSFADE_SCHEDULE, 'CF', `Schedule: ${ps.name} @ ${fireAt.toFixed(2)}s (${fadeMs}ms)`);

    const handle = sound.schedule(() => {
      debug(`[CF] 🔥 Automatic timer fired!`);
      performCrossfade(playlist, ps);
    }, fireAt);

    State.setCrossfadeTimer(playlist, { ...handle, soundId: ps.id }); //  Use State manager
  }

  if (sound.playing) {
    armTimer();
  } else {
    const onPlay = () => armTimer();
    try {
      sound.addEventListener("play", onPlay, { once: true });
      State.setPlayWaiter(playlist, { sound, onPlay });  //  Use State manager
    } catch {
      armTimer();
    }
  }
}
