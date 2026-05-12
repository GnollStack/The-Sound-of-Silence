// cross-fade.js - Automatic cross-fading for Foundry VTT playlists

import { MODULE_ID, debug, waitForMedia, logFeature, LogSymbols, safeStop, getNextSequence, error } from "./utils.js";
import { equalPowerCrossfade, fadeOutAndStop } from "./audio-fader.js";
import { Flags } from "./flag-service.js";
import { PlaybackClock } from "./playback-clock.js";
import { State } from "./state-manager.js";

const AudioTimeout = foundry.audio.AudioTimeout;
const PM = CONST.PLAYLIST_MODES;

async function loadCrossfadeMedia(ps) {
  if (!ps) return null;

  if (!ps.sound && typeof ps.load === "function") {
    try {
      await ps.load();
    } catch (err) {
      debug(`[CF] Failed to load media for "${ps.name}":`, err?.message ?? err);
    }
  }

  return waitForMedia(ps);
}

export async function prepareIncomingCrossfadeMedia(ps) {
  const sound = await loadCrossfadeMedia(ps);
  if (!sound) return null;

  if (!sound.playing) {
    sound.volume = 0;
    await sound.play({ _fromCrossfade: true });
  } else if (!State.isSoundFading(sound)) {
    sound.volume = 0;
  }

  if (!sound.gain) {
    await AudioTimeout.wait(200);
  }

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
 */
export async function performCrossfade(playlist, soundToFade, { recovery = false, incomingSound = null, reason = "auto" } = {}) {
  const soundOut = soundToFade?.sound;
  if (!playlist || !soundToFade) return;

  // Only the owner (GM) should execute playlist updates
  if (!playlist.isOwner) {
    debug(`[CF] Non-owner skipping crossfade execution for "${soundToFade.name}".`);
    return;
  }

  if (State.isPlaylistCrossfading(playlist)) {
    debug(`[CF] Skipping ${reason} crossfade for "${soundToFade.name}" because another crossfade is already active.`);
    return;
  }

  if (!soundToFade.playing || (!soundOut?.playing && !recovery)) {
    debug(`[CF] Skipping crossfade for "${soundToFade.name}" because it is no longer actively playing.`);
    cancelCrossfade(playlist);
    return;
  }
  if (recovery && !soundOut?.playing) {
    debug(`[CF] Recovery crossfade proceeding for "${soundToFade.name}" without live outgoing media (${reason}).`);
  }

  const fadeMs = Flags.getCrossfadeDuration(playlist);
  if (fadeMs <= 0) return;

  cancelCrossfade(playlist);

  debug(`[CF] ${recovery ? "Recovery" : reason} crossfade triggered for "${soundToFade.name}". Fading out over ${fadeMs}ms.`);

  // 1. Find the next track to play.
  const order = playlist.playbackOrder;
  const currentIndex = order.indexOf(soundToFade.id);
  const nextId = order[currentIndex + 1];
  let soundToPlay = incomingSound instanceof PlaylistSound ? incomingSound : (nextId ? playlist.sounds.get(nextId) : null);

  if (soundToPlay?.id === soundToFade.id) {
    debug(`[CF] Skipping crossfade because incoming and outgoing sound are the same.`);
    return;
  }

  if (!soundToPlay && !incomingSound) {
    if (Flags.getPlaylistFlag(playlist, "loopPlaylist") && order.length > 0) {
      debug('[CF] Reached end of playlist; looping back to the start.');
      soundToPlay = playlist.sounds.get(order[0]);
    }
  }

  if (!soundToPlay) {
    debug(`[CF] No next track found. Fading out "${soundToFade.name}" and stopping.`);
    if (soundOut?.playing) {
      fadeOutAndStop(soundOut, fadeMs);
      AudioTimeout.wait(fadeMs).then(() => { if (playlist.playing) playlist.stopAll(); });
    } else if (playlist.playing) {
      playlist.stopAll();
    }
    return;
  }

  // 2. Start playing the next track directly, bypassing Foundry's "stop current first" behavior.
  //    We manually update the document state and play the audio ourselves.
  State.markPlaylistAsCrossfading(playlist);

  let crossfadeSuccessful = false;

  try {
    // Update the document to reflect the new playing state without triggering stopSound
    await soundToPlay.update({ playing: true, pausedTime: null }, { render: false });

    const sharedTargetVolIn = Flags.resolveSharedTargetVolume(soundToPlay);
    const targetVolIn = Flags.resolveTargetVolume(soundToPlay, { sharedVolume: sharedTargetVolIn });

    // Directly load and play the audio, bypassing native sync/autoplay.
    const soundIn = await prepareIncomingCrossfadeMedia(soundToPlay);
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

    AudioTimeout.wait(fadeMs + 50).then(() => {
      State.clearPlaylistCrossfading(playlist);

      if (soundIn && fadeTokens?.inToken) State.clearFadingSound(soundIn, fadeTokens.inToken);

      // Only stop if this crossfade still owns the outgoing sound.
      if (soundOut?.playing && (!fadeTokens?.outToken || State.isCurrentFadeToken(soundOut, fadeTokens.outToken))) {
        safeStop(soundOut, "crossfade completion");
      }
      if (soundOut && fadeTokens?.outToken) State.clearFadingSound(soundOut, fadeTokens.outToken);

      debug(`[CF] Crossfade complete: "${soundToFade.name}" -> "${soundToPlay.name}"`);

      // Emit crossfade complete event
      Hooks.callAll('the-sound-of-silence.crossfadeComplete', {
        playlist,
        fromSound: soundToFade,
        toSound: soundToPlay
      });
    }).catch(() => { });

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

    // 5. Immediately update the outgoing sound's document state for UI purposes.
    //    The audio continues playing/fading, but the UI shows the new track as current.
    //    Omit render: false so Foundry re-renders the playlist UI on ALL clients.
    await soundToFade.update({ playing: false, pausedTime: null });

    crossfadeSuccessful = true;

  } catch (err) {
    error("[Crossfade] Error:", err);
    State.clearPlaylistCrossfading(playlist);
  } finally {
    // If the crossfade didn't complete successfully, clear the flag immediately
    if (!crossfadeSuccessful) {
      State.clearPlaylistCrossfading(playlist);
    }
    // If successful, the AudioTimeout will clear it when the audio fade finishes
  }
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
  if (!playlist?.isOwner || !ps) return;
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
