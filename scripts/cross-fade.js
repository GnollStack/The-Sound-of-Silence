// cross-fade.js - Automatic cross-fading for Foundry VTT playlists

import { MODULE_ID, debug, waitForMedia, logFeature, LogSymbols, safeStop } from "./utils.js";
import { equalPowerCrossfade, fadeOutAndStop } from "./audio-fader.js";
import { Flags } from "./flag-service.js";
import { State } from "./state-manager.js";

const PM = CONST.PLAYLIST_MODES;

/**
 * Contains the core logic for performing a crossfade.
 * This can be called manually for a skip, or automatically by the scheduler.
 * @param {Playlist} playlist The playlist document.
 * @param {PlaylistSound} soundToFade The sound that needs to be faded out.
 */
export async function performCrossfade(playlist, soundToFade) {
  const soundOut = soundToFade?.sound;
  if (!playlist || !soundToFade?.sound) return;

  // Only the owner (GM) should execute playlist updates
  if (!playlist.isOwner) {
    debug(`[CF] Non-owner skipping crossfade execution for "${soundToFade.name}".`);
    return;
  }

  const fadeMs = Flags.getCrossfadeDuration(playlist);
  if (fadeMs <= 0) return;

  // Atomic check-and-set: returns false if already fading
  if (!State.markSoundAsFading(soundToFade.sound)) {
    debug(`[CF] (debounce) Crossfade already in progress for "${soundToFade.name}".`);
    return;
  }

  setTimeout(() => {
    if (soundToFade?.sound) {
      State.clearFadingSound(soundToFade.sound);
      debug(`[CF] (debounce) Released lock for "${soundToFade.name}".`);
    }
  }, fadeMs + 500);

  cancelCrossfade(playlist);

  debug(`[CF] Automatic crossfade triggered for "${soundToFade.name}". Fading out over ${fadeMs}ms.`);

  // 1. Find the next track to play.
  const order = playlist.playbackOrder;
  const currentIndex = order.indexOf(soundToFade.id);
  const nextId = order[currentIndex + 1];
  let soundToPlay = nextId ? playlist.sounds.get(nextId) : null;

  if (!soundToPlay) {
    if (Flags.getPlaylistFlag(playlist, "loopPlaylist") && order.length > 0) {
      debug('[CF] Reached end of playlist; looping back to the start.');
      soundToPlay = playlist.sounds.get(order[0]);
    }
  }

  if (!soundToPlay) {
    debug(`[CF] No next track found. Fading out "${soundToFade.name}" and stopping.`);
    fadeOutAndStop(soundToFade.sound, fadeMs);
    setTimeout(() => { if (playlist.playing) playlist.stopAll(); }, fadeMs);
    return;
  }

  // 2. Start playing the next track and wait for it to be ready.
  State.markPlaylistAsCrossfading(playlist);
  try {
    await playlist.playSound(soundToPlay);
  } finally {
    State.clearPlaylistCrossfading(playlist);
  }
  const soundIn = await waitForMedia(soundToPlay);

  if (!soundIn || !soundOut.playing || !soundOut.gain) {
    debug(`[CF] Outgoing sound was stopped prematurely. Aborting equal-power crossfade and falling back.`);
    return;
  }

  // Emit crossfade start event
  Hooks.callAll('the-sound-of-silence.crossfadeStart', {
    playlist,
    fromSound: soundToFade,
    toSound: soundToPlay,
    duration: fadeMs
  });

  State.recordCrossfade(fadeMs);

  // 3. Perform the equal-power crossfade.
  debug(`[CF] Crossfading from "${soundToFade.name}" to "${soundToPlay.name}".`);
  equalPowerCrossfade(soundOut, soundIn, fadeMs);

  // 4. After the fade, stop the original sound completely.
  setTimeout(() => {
    safeStop(soundOut, "crossfade completion");

    // Emit crossfade complete event
    Hooks.callAll('the-sound-of-silence.crossfadeComplete', {
      playlist,
      fromSound: soundToFade,
      toSound: soundToPlay
    });
  }, fadeMs + 50);
}

/**
 * Clears any pending cross-fade timeout for the given playlist. Also cleans up
 * any one-shot "play" event listeners that haven't fired yet.
 * @param {Playlist} playlist The playlist for which to cancel the crossfade.
 */
export function cancelCrossfade(playlist) {
  //  Use State manager to get timer
  const handle = State.getCrossfadeTimer(playlist);
  if (handle) {
    logFeature(LogSymbols.CROSSFADE_CANCEL, 'CF', `Cancel: ${playlist.name}`);

    // The handle from sound.schedule() is a promise with a .timeout property
    if (handle.timeout) {
      handle.timeout.cancel();
    }

  }
  State.clearCrossfadeTimer(playlist);  //  Use State manager

  //  Use State manager to get play waiter
  const waiter = State.getPlayWaiter(playlist);
  if (waiter) {
    try {
      waiter.sound?.removeEventListener?.("play", waiter.onPlay);
    } catch (_) { /* no-op */ }
    State.clearPlayWaiter(playlist);  //  Use State manager
  }
}

/**
 * Arms a timer that will trigger `performCrossfade` at the correct time for a given sound.
 * This is scheduled so the fade-out of the current track finishes as the track itself ends.
 * @param {Playlist} playlist The parent playlist document.
 * @param {PlaylistSound} ps The PlaylistSound that was just started and needs a crossfade scheduled.
 */
export async function scheduleCrossfade(playlist, ps) {
  if (!playlist?.isOwner || !ps) return;
  if (![PM.SEQUENTIAL, PM.SHUFFLE].includes(playlist.mode)) return;
  if (!Flags.getPlaybackMode(playlist).crossfade) return;

  // Use the same logic as performCrossfade to get the fade duration
  const fadeMs = Flags.getCrossfadeDuration(playlist);

  if (fadeMs <= 0) return;
  if (ps.repeat) return;

  cancelCrossfade(playlist);

  const sound = await waitForMedia(ps);
  if (!sound) return;

  function armTimer() {
    State.clearPlayWaiter(playlist);  //  Use State manager

    const dur = Number(sound.duration);

    if (!Number.isFinite(dur) || dur <= 0) {
      debug(`[CF] Skipping auto crossfade – invalid duration for "${ps.name}".`);
      return;
    }

    const fireAt = Math.max(0, dur - (fadeMs / 1000)); // Now uses correct fadeMs

    if ((sound.currentTime ?? 0) >= fireAt) {
      debug(`[CF] Skipping auto crossfade - track already past fade point for "${ps.name}"`);
      return;
    }

    logFeature(LogSymbols.CROSSFADE_SCHEDULE, 'CF', `Schedule: ${ps.name} @ ${fireAt.toFixed(2)}s (${fadeMs}ms)`);

    const handle = sound.schedule(() => {
      debug(`[CF] 🔥 Automatic timer fired!`);
      performCrossfade(playlist, ps);
    }, fireAt);

    State.setCrossfadeTimer(playlist, handle);  //  Use State manager
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