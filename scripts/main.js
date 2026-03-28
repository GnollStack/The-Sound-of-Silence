/**
 * @file main.js
 * @description The core entry point for the module. This file sets up all hooks,
 * libWrapper patches, and event listeners that orchestrate the module's features,
 * including silence injection, crossfading, internal looping, and playlist looping.
 */
import { registerPlaylistSheetWrappers } from "./playlist-config.js";
import { Silence } from "./silence.js";
import { scheduleCrossfade, cancelCrossfade } from "./cross-fade.js";
import { applyFadeIn } from "./fade-in.js";
import { registerSoundConfigWrappers } from "./sound-config.js";
import {
  scheduleLoopWithin,
  cancelLoopWithin,
  breakLoopWithin,
  executeLoopBreak,
  pauseLoopWithin,
  resumeLoopWithin,
  nextSegmentWithin,
  previousSegmentWithin,
  executeSegmentSkip,
  disableAllLoopsWithin,
  executeLoopDisable,
} from "./internal-loop.js";
import { maybeLoopPlaylist } from "./playlist-loop.js";
import {
  advancedFade,
  scheduleEndOfTrackFade,
  cancelActiveFade,
  fadeOutAndStop,
  equalPowerCrossfade,
} from "./audio-fader.js";
import {
  debug,
  MODULE_ID,
  waitForMedia,
  cleanupPlaylistState,
  PlaylistActionAuthority,
  getNextSequence,
  shouldProcessAction,
  findPlaylistSoundForSound,
  logFeature,
  LogSymbols,
  safeStop,
  ensureAudioContext,
} from "./utils.js";
import { Flags } from "./flag-service.js";
import { State } from "./state-manager.js";
import { API } from "./api.js";
import { AdvancedShuffle, SHUFFLE_PATTERNS } from "./advanced-shuffle.js";
import { registerCurrentlyPlaying } from "./currently-playing.js";
import { Integrations } from "./integrations.js";

const AudioTimeout = foundry.audio.AudioTimeout;

// =========================================================================
// Constants & State
// =========================================================================

export async function cancelSilentGap(playlist) {
  // Delegate to the centralized cleanup utility, specifically targeting only the silence feature.
  return cleanupPlaylistState(playlist, {
    cleanSilence: true,
    cleanCrossfade: false, // Don't touch crossfades
    cleanLoopers: false, // Don't touch loopers
  });
}

// =========================================================================
// Helpers
// =========================================================================

// =========================================================================
// Foundry Hooks
// =========================================================================

Hooks.once("init", () => {
  console.log(`[${MODULE_ID}] Initializing…`);

  // Detect conflicting playlist modules (informational — SoS still activates)
  Integrations.detect();

  game.settings.register(MODULE_ID, "debug", {
    name: "Enable Debug Logging",
    hint: "Log silence timing and playlist actions to the console.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "shufflePattern", {
    name: "Advanced Shuffle Pattern",
    hint: "Choose how shuffle mode works. Exhaustive ensures all tracks play once before repeating. Weighted Random favors tracks that haven't played recently. Round-Robin ensures even distribution across all tracks over time.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      [SHUFFLE_PATTERNS.FOUNDRY_DEFAULT]:
        "Foundry Default (Random with possible repeats)",
      [SHUFFLE_PATTERNS.EXHAUSTIVE]:
        "Exhaustive (No repeats until all tracks played)",
      [SHUFFLE_PATTERNS.WEIGHTED_RANDOM]:
        "Weighted Random (Favor less-recently-played tracks)",
      [SHUFFLE_PATTERNS.ROUND_ROBIN]:
        "Round-Robin (Strictly even distribution)",
    },
    default: SHUFFLE_PATTERNS.FOUNDRY_DEFAULT,
    onChange: () => {
      // Clear all shuffle states when pattern changes globally
      game.playlists.forEach((playlist) => {
        if (playlist.mode === CONST.PLAYLIST_MODES.SHUFFLE) {
          AdvancedShuffle.reset(playlist);
          debug(
            `[Shuffle] Reset state for "${playlist.name}" due to pattern change`
          );
        }
      });
      ui.notifications.info(
        "Advanced Shuffle pattern changed. All shuffle playlists have been reset."
      );
    },
  });

  game.settings.register(MODULE_ID, "fadeInCurveType", {
    name: "Fade-In Curve Type",
    hint: "Controls the volume curve shape for fade-ins. Logarithmic (default) sounds perceptually linear. Linear is a straight volume ramp. S-Curve eases in and out smoothly. Steep front-loads the volume change for a more dramatic effect.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "logarithmic": "Logarithmic (Default)",
      "linear": "Linear",
      "s-curve": "S-Curve (Smooth ease in/out)",
      "steep": "Steep (Fast attack)",
    },
    default: "logarithmic",
  });

  game.settings.register(MODULE_ID, "fadeOutCurveType", {
    name: "Fade-Out Curve Type",
    hint: "Controls the volume curve shape for fade-outs. Logarithmic (default) sounds perceptually linear. Linear is a straight volume ramp. S-Curve eases in and out smoothly. Steep front-loads the volume change for a more dramatic effect.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "logarithmic": "Logarithmic (Default)",
      "linear": "Linear",
      "s-curve": "S-Curve (Smooth ease in/out)",
      "steep": "Steep (Fast attack)",
    },
    default: "logarithmic",
  });
});

Hooks.once("ready", () => {
  if (!game.modules.get("lib-wrapper")?.active) {
    ui.notifications.error(`${MODULE_ID} requires the libWrapper module.`);
    return;
  }

  // Initialize and expose the public API
  API._initialize();
  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = API;
  }

  // Register audio guards before UI setup (protects our fade curves
  // from being destroyed by other playlist modules calling Sound.fade())
  Integrations.registerAudioGuards();

  registerPlaylistSheetWrappers();
  registerSoundConfigWrappers();
  registerCurrentlyPlaying();

  // --- Visibility Recovery (Safety Net) ---
  // When the browser tab regains focus, validate and recover module state.
  // Browser throttling can cause setTimeout-based cleanup to be delayed or missed.
  // This listener catches any stale state left behind.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return; // Only act when tab comes BACK to focus

    debug("[Visibility] Tab regained focus. Validating module state...");

    // Resume any AudioContexts that the browser suspended while backgrounded
    ensureAudioContext();

    for (const playlist of game.playlists) {
      if (!playlist.playing) continue;

      // 1. Clear stale crossfade locks
      if (State.isPlaylistCrossfading(playlist) && !State.getCrossfadeTimer(playlist)) {
        debug(`[Visibility] Clearing stale crossfading flag for "${playlist.name}"`);
        State.clearPlaylistCrossfading(playlist);
      }

      // 2. Clear stale fading sound locks
      for (const ps of playlist.sounds) {
        if (ps.sound && State.isSoundFading(ps.sound)) {
          const gain = ps.sound.gain?.value;
          if (gain !== undefined && (gain < 0.01 || gain > 0.95)) {
            debug(`[Visibility] Clearing stale fading lock for "${ps.name}" (gain=${gain.toFixed(3)})`);
            State.clearFadingSound(ps.sound);
          }
        }
      }

      // 3. Re-validate crossfade scheduling for playing playlists
      const mode = Flags.getPlaybackMode(playlist);
      if (mode.crossfade && !State.getCrossfadeTimer(playlist)) {
        const currentlyPlaying = playlist.sounds.find(s => s.playing && !Flags.getSoundFlag(s, "isSilenceGap"));
        if (currentlyPlaying) {
          debug(`[Visibility] Re-arming crossfade timer for "${currentlyPlaying.name}"`);
          scheduleCrossfade(playlist, currentlyPlaying);
        }
      }

      // 4. Verify and correct volumes on normalized playlists.
      //    If a song started while the tab was hidden, its volume may not have
      //    been set correctly due to browser throttling or async race conditions.
      const normEnabled = Flags.getPlaylistFlag(playlist, "volumeNormalizationEnabled");
      if (normEnabled) {
        const normalizedVolume = Flags.getPlaylistFlag(playlist, "normalizedVolume");
        const expectedVolume = foundry.audio.AudioHelper.inputToVolume(normalizedVolume);

        for (const ps of playlist.sounds) {
          if (!ps.playing || !ps.sound) continue;
          if (Flags.getSoundFlag(ps, "isSilenceGap")) continue;
          if (Flags.getSoundFlag(ps, "allowVolumeOverride")) continue;

          const currentGain = ps.sound.gain?.value;
          if (currentGain !== undefined && Math.abs(currentGain - expectedVolume) > 0.01 && !State.isSoundFading(ps.sound)) {
            debug(`[Visibility] Volume correction for "${ps.name}": gain=${currentGain.toFixed(3)} -> expected=${expectedVolume.toFixed(3)}`);
            ps.sound.volume = expectedVolume;
          }
        }
      }
    }
  });

  // This hook reacts to flag changes caused by UI interactions or other clients.
  Hooks.on("updatePlaylistSound", (soundDoc, changes) => {
    const moduleFlags = changes?.flags?.[MODULE_ID];
    if (!moduleFlags) return;

    // --- Handle loopWithin sub-flags ---
    const loopFlags = moduleFlags.loopWithin;
    if (loopFlags) {
      // Handle loop activation/deactivation from the toggle button
      if (loopFlags.hasOwnProperty("active")) {
        const isActive = loopFlags.active;
        if (isActive) {
          scheduleLoopWithin(soundDoc);
        } else {
          cancelLoopWithin(soundDoc);
        }
      }

      // Handle enabling/disabling the feature entirely from the config
      if (loopFlags.hasOwnProperty("enabled")) {
        ui.playlists?.render();
        if (!loopFlags.enabled) {
          cancelLoopWithin(soundDoc);
        }
      }
    }

    // --- Handle segment skip replication ---
    const segmentSkip = moduleFlags.segmentSkip;
    if (segmentSkip) {
      const { targetIndex, seq } = segmentSkip;

      // Validate the data
      if (typeof targetIndex !== 'number' || !Number.isFinite(seq)) return;

      // Deduplicate using sequence tracking
      if (!shouldProcessAction(soundDoc.id, seq)) {
        debug(`[Segment-Sync] Ignoring duplicate segment skip (seq ${seq}) for "${soundDoc.name}"`);
        return;
      }

      debug(`[Segment-Sync] Executing segment skip to index ${targetIndex} for "${soundDoc.name}"`);
      executeSegmentSkip(soundDoc, targetIndex);
    }

    // --- Handle loop break replication ---
    const loopBreak = moduleFlags.loopBreak;
    if (loopBreak) {
      const { seq } = loopBreak;

      if (!Number.isFinite(seq)) return;

      // Deduplicate using sequence tracking
      if (!shouldProcessAction(soundDoc.id, seq)) {
        debug(`[LoopBreak-Sync] Ignoring duplicate loop break (seq ${seq}) for "${soundDoc.name}"`);
        return;
      }

      debug(`[LoopBreak-Sync] Executing loop break for "${soundDoc.name}"`);
      executeLoopBreak(soundDoc);
    }

    // --- Handle loop disable replication ---
    const loopDisable = moduleFlags.loopDisable;
    if (loopDisable) {
      const { seq } = loopDisable;

      if (!Number.isFinite(seq)) return;

      // Deduplicate using sequence tracking
      if (!shouldProcessAction(soundDoc.id, seq)) {
        debug(`[LoopDisable-Sync] Ignoring duplicate loop disable (seq ${seq}) for "${soundDoc.name}"`);
        return;
      }

      debug(`[LoopDisable-Sync] Executing loop disable for "${soundDoc.name}"`);
      executeLoopDisable(soundDoc);
    }
  });

  // 1. Create a new helper function
  async function handleTrackCompletion(playlistSound) {
    const playlist = playlistSound.parent;
    // The track has ended. Its scheduled end-of-track fade is now irrelevant.
    const pendingFade = State.getEndOfTrackFade(playlistSound);
    if (pendingFade) {
      pendingFade.cancel();
      State.clearEndOfTrackFade(playlistSound);
    }
    const mode = Flags.getPlaybackMode(playlist);

    // If crossfade is active, the crossfade scheduler is responsible. Do nothing here.
    if (mode.crossfade) {
      return;
    }

    // If silence is enabled, inject the gap.
    // Crucially, we do NOT await this. We fire-and-forget.
    // The advancement to the next track will be handled when the gap itself ends.
    if (mode.silence) {
      debug(
        `Injecting silent gap after "${playlistSound.name}" in "${playlist.name}".`
      );
      Silence.playSilence(playlist, playlistSound);
    }
  }

  libWrapper.register(
    MODULE_ID,
    "PlaylistSound.prototype._onEnd",
    function (wrapped, ...args) {
      const playlist = this.parent;

      // A silent gap's 100ms audio file has finished. We must stop all further
      // execution to let the real timer in silence.js take control.
      if (Flags.getSoundFlag(this, "isSilenceGap")) {
        return;
      }

      // Bail out if an automatic crossfade is already managing this transition.
      if (State.isPlaylistCrossfading(playlist)) {
        debug(`_onEnd: Bailing because an automatic crossfade is in progress.`);
        return;
      }

      // Handle playlist looping for "Simultaneous" mode.
      if (
        playlist.mode === CONST.PLAYLIST_MODES.SIMULTANEOUS &&
        Flags.getPlaylistFlag(playlist, "loopPlaylist")
      ) {
        debug(
          `[LP] 🔁 Restarting "${this.name}" inside simultaneous playlist "${playlist.name}"`
        );
        const endResult = wrapped(...args);
        if (game.user.isGM) playlist.playSound(this);
        return endResult;
      }

      const mode = Flags.getPlaybackMode(playlist);

      // If neither of our features are active for this playlist,
      // just run the original Foundry function and we're done.
      if (!mode.crossfade && !mode.silence) {
        return wrapped(...args);
      }

      // Otherwise, one of our features IS active. Let our dedicated helper
      // function handle all the complex logic. Do NOT call wrapped().
      handleTrackCompletion(this);
    },
    "MIXED"
  );

  // In sequential/shuffle playlists, escalate a per-track stop to a full playlist stop for consistency.
  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.stopSound",
    function (wrapped, sound, ...args) {
      const playlist = this;

      if (!sound) {
        return wrapped.call(this, sound, ...args);
      }

      const isSeqOrShuffle = [
        CONST.PLAYLIST_MODES.SEQUENTIAL,
        CONST.PLAYLIST_MODES.SHUFFLE,
      ].includes(playlist.mode);

      if (isSeqOrShuffle && playlist.playing) {
        logFeature(
          LogSymbols.STOP,
          "Stop",
          `Track → Playlist: ${sound.name}. Escalating to stop the entire playlist.`
        );
        playlist.stopAll();
        return;
      }

      return wrapped.call(this, sound, ...args);
    },
    "MIXED"
  );

  // Override stopAll to provide a more robust implementation that handles all module features gracefully.
  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.stopAll",
    async function () {
      logFeature(LogSymbols.STOP, "Stop", `Playlist: ${this.name}`);
      State.markPlaylistAsStopping(this);
      const fadeDuration = Number(this.fade) || 0;

      // --- Step 1: Identify all sounds that need to be stopped ---
      // This includes sounds currently marked as playing AND the sound that may have triggered a now-active silent gap.
      const playingSounds = this.sounds.filter(
        (s) => s.playing && !Flags.getSoundFlag(s, "isSilenceGap")
      );
      const silenceState = State.getSilenceState(this);
      const sourceSound = silenceState?.sourceSound;

      // Use a Set to gather unique sounds to stop.
      const soundsToStopSet = new Set(playingSounds);
      if (sourceSound) {
        soundsToStopSet.add(sourceSound);
      }
      const soundsToStop = Array.from(soundsToStopSet);
      const soundIdsToStop = soundsToStop.map((s) => s.id);

      // --- Step 2: Clean up all active module features (timers, gaps, loops) ---
      // This is critical to prevent timers from firing after we've issued the stop command.
      await cleanupPlaylistState(this, {
        cleanSilence: true,
        cleanCrossfade: true,
        cleanLoopers: true,
        allowFadeOut: fadeDuration > 0,
      });

      // --- Step 3: Update the database to reflect the new "stopped" state ---
      // We do this before the audio fades so the UI is immediately responsive.
      const updates = soundIdsToStop.map((id) => ({
        _id: id,
        playing: false,
        pausedTime: 0,
      }));
      if (updates.length > 0) {
        await this.updateEmbeddedDocuments("PlaylistSound", updates, {
          noHook: true,
        });
      }
      if (this.playing) {
        await this.update({ playing: false }, { noHook: true });
      }

      // --- Step 4: Replicate the action to all clients ---
      // This ensures other players' audio also fades out correctly. Only one GM should do this.
      if (PlaylistActionAuthority.isAuthorizedGM()) {
        try {
          await this.setFlag(MODULE_ID, "stopTransition", {
            soundIds: soundIdsToStop,
            fadeMs: fadeDuration,
            seq: getNextSequence(this.id),
            ts: Date.now(),
            gmId: game.user.id,
          });
        } catch (err) {
          debug("[Stop] Failed to set replication flag", err);
        }
      }

      // --- Step 5: Perform the client-side audio fade-out ---
      // This uses our superior exponential fader for a smoother effect.
      for (const sound of soundsToStop) {
        if (!sound.sound) continue;

        // Cancel any scheduled end-of-track fades to prevent them from interfering.
        const pendingFade = State.getEndOfTrackFade(sound);
        if (pendingFade) {
          pendingFade.cancel();
          State.clearEndOfTrackFade(sound);
        }

        if (fadeDuration > 0) {
          fadeOutAndStop(sound.sound, fadeDuration);
        } else {
          safeStop(sound.sound, "playlist stopAll");
        }
      }

      // Finally, re-render the UI now that all state changes are complete.
      ui.playlists.render();
    },
    "OVERRIDE"
  );

  // Wrap playSound to handle manual track skips with crossfading.
  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.playSound",
    async function (wrapped, soundToPlay, ...args) {
      const playlist = this;

      // If our automatic crossfader is running, do not treat this as a manual skip.
      if (State.isPlaylistCrossfading(playlist)) {
        return await wrapped.call(playlist, soundToPlay, ...args);
      }

      const useCrossfade = Flags.getPlaybackMode(playlist).crossfade;
      const fadeMs = Number(playlist.fade) || 0;
      const isSequentialOrShuffle = [
        CONST.PLAYLIST_MODES.SEQUENTIAL,
        CONST.PLAYLIST_MODES.SHUFFLE,
      ].includes(playlist.mode);

      // If crossfade is on and another track is playing, this is a manual skip.
      // We must initiate a crossfade from the old track to the new one.
      if (useCrossfade && fadeMs > 0 && isSequentialOrShuffle) {
        const currentlyPlaying = playlist.sounds.find(
          (s) => s.playing && s.id !== soundToPlay.id
        );
        if (currentlyPlaying?.sound) {
          debug(
            `[CF-Skip] Detected skip from "${currentlyPlaying.name}" to "${soundToPlay.name}".`
          );
          cancelActiveFade(currentlyPlaying.sound);
          advancedFade(currentlyPlaying.sound, {
            targetVol: 0,
            duration: fadeMs,
          });
          cancelCrossfade(playlist); // Cancel the pending automatic crossfade for the old track.
        }
      }

      // Only cancel the gap if the incoming sound is NOT a gap itself.
      if (
        State.hasSilenceState(playlist) &&
        !soundToPlay.getFlag(MODULE_ID, "isSilenceGap")
      ) {
        await cancelSilentGap(playlist);
      }

      return await wrapped.call(playlist, soundToPlay, ...args);
    },
    "WRAPPER"
  );



  // This hook listens for the 'skipTransition' flag to mirror GM "Next" actions on all clients.
  // NOTE: We no longer need _lastSkipSeen - using sequence system instead

  // Use the centralized sequence system instead of timestamp deduplication
  Hooks.on("updatePlaylist", async (pl, changes) => {
    if (!changes?.flags?.[MODULE_ID]?.skipTransition) return;
    const next = pl.getFlag(MODULE_ID, "skipTransition");
    if (!next) return;

    const { fromSoundId, fadeMs, seq, ts, gmId } = next;
    if (!fromSoundId || !Number.isFinite(fadeMs) || !Number.isFinite(seq))
      return;

    // Already using shouldProcessAction which has cleanup built-in
    if (!shouldProcessAction(pl.id, seq)) {
      debug(`[Skip-Sync] Ignoring duplicate or out-of-order skip (seq ${seq})`);
      return;
    }

    if (gmId === game.user.id) {
      debug(`[Skip-Sync] Skipping self-triggered action`);
      return;
    }

    debug(`[Skip-Sync] Processing skip from GM ${gmId}, seq ${seq}`);

    for (const s of pl.sounds) cancelLoopWithin(s);

    const ps = pl.sounds.get(fromSoundId);
    if (!ps) return;
    const media = await waitForMedia(ps);
    if (!media) return;

    try {
      cancelActiveFade(media);
    } catch (_) { }
    advancedFade(media, { targetVol: 0, duration: Number(fadeMs) || 0 });
  });

  // This hook listens for the 'stopTransition' flag to mirror GM "Stop All" actions on all clients.
  // NOTE: Deduplication handled by shouldProcessAction - no local Map needed
  Hooks.on("updatePlaylist", async (pl, changes) => {
    if (!changes?.flags?.[MODULE_ID]?.stopTransition) return;
    const stop = pl.getFlag(MODULE_ID, "stopTransition");
    if (!stop) return;

    const { soundIds, fadeMs, seq, gmId } = stop;
    if (!Array.isArray(soundIds) || !Number.isFinite(seq)) return;

    if (!shouldProcessAction(pl.id, seq)) {
      debug(`[Stop-Sync] Ignoring duplicate or out-of-order stop (seq ${seq})`);
      return;
    }

    if (gmId === game.user.id) return; // Skip self

    debug(`[Stop-Sync] Processing stop from GM ${gmId}, seq ${seq}`);

    // shouldProcessAction already handled deduplication above

    if (pl.isOwner) return; // GM already handled their own fades.

    const dur = Number(fadeMs) || 0;
    for (const sid of soundIds) {
      const ps = pl.sounds.get(sid);
      if (!ps) continue;
      const media = await waitForMedia(ps);
      if (!media) continue;
      try {
        cancelActiveFade(media);
      } catch (_) { }
      if (dur > 0) {
        debug(
          `[Stop-Client] Fading out "${ps.name}" over ${dur}ms (replicated).`
        );
        advancedFade(media, { targetVol: 0, duration: dur });
        AudioTimeout.wait(dur + 10).then(() => {
          try {
            media.stop();
          } catch (_) { }
        }).catch(() => { });
      } else {
        try {
          media.stop();
        } catch (_) { }
      }
    }
  });

  // Replicates the equal-power crossfade to non-GM players.
  // The GM sets the "crossfadeTransition" flag right before marking the outgoing sound
  // as stopped, so players can apply the matching curve while both sounds are still playing.
  Hooks.on("updatePlaylist", async (playlist, changes) => {
    // Foundry only sends the diff in `changes`, so if fadeMs/targetVolIn didn't change
    // they won't appear in the diff. Always read the full flag from the document.
    if (!changes?.flags?.[MODULE_ID]?.crossfadeTransition) return;
    const cf = playlist.getFlag(MODULE_ID, "crossfadeTransition");
    if (!cf) return;

    const { incomingSoundId, outgoingSoundId, fadeMs, targetVolIn, seq, gmId } = cf;

    if (!shouldProcessAction(playlist.id, seq)) {
      debug(`[Crossfade-Sync] Ignoring duplicate/out-of-order (seq ${seq})`);
      return;
    }
    if (gmId === game.user.id) return;  // GM already applied it locally
    if (playlist.isOwner) return;       // Safety: owners skip

    // Mark crossfading IMMEDIATELY (before any await) so any in-flight applyFadeIn
    // sees the flag and exits early at the State.isPlaylistCrossfading() check.
    State.markPlaylistAsCrossfading(playlist);

    const psOut = playlist.sounds.get(outgoingSoundId);
    const psIn  = playlist.sounds.get(incomingSoundId);
    if (!psIn) {
      State.clearPlaylistCrossfading(playlist);
      return;
    }

    const [soundOut, soundIn] = await Promise.all([
      psOut ? waitForMedia(psOut) : Promise.resolve(null),
      waitForMedia(psIn),
    ]);

    if (!soundIn) {
      State.clearPlaylistCrossfading(playlist);
      return;
    }

    // Protect both sounds from sync() and the volume safety net during crossfade
    State.markSoundAsFading(soundIn);
    if (soundOut) State.markSoundAsFading(soundOut);

    // Graceful fallback: outgoing already stopped (network reorder) — snap incoming to target
    if (!soundOut?.playing) {
      debug(`[Crossfade-Sync] Outgoing sound already stopped; snapping "${psIn.name}" to target volume.`);
      soundIn.volume = targetVolIn;
      State.clearFadingSound(soundIn);
      State.clearPlaylistCrossfading(playlist);
      return;
    }

    debug(`[Crossfade-Sync] Applying equal-power crossfade "${psOut?.name}" → "${psIn.name}" (${fadeMs}ms)`);

    // equalPowerCrossfade internally cancels any pending S-curve from applyFadeIn
    equalPowerCrossfade(soundOut, soundIn, fadeMs, { targetVolIn });

    AudioTimeout.wait(fadeMs + 50).then(() => {
      State.clearFadingSound(soundIn);
      if (soundOut) State.clearFadingSound(soundOut);
      State.clearPlaylistCrossfading(playlist);
    });
  });

  // Wrap playNext to clean up loopers, handle crossfading, and manage advanced shuffle state.
  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.playNext",
    async function (wrapped, ...args) {
      const playlist = this;
      debug(`[playNext WRAPPER] Advancing playlist "${playlist.name}".`);

      // Use centralized cleanup for other module features.
      await cleanupPlaylistState(this, {
        cleanSilence: false,
        cleanCrossfade: true,
        cleanLoopers: true,
        allowFadeOut: true,
      });

      const useCrossfade = this.getFlag(MODULE_ID, "crossfade");
      const fadeMs = Number(this.fade) || 0;
      const isSequentialOrShuffle = [
        CONST.PLAYLIST_MODES.SEQUENTIAL,
        CONST.PLAYLIST_MODES.SHUFFLE,
      ].includes(this.mode);

      // Replicate skip to all clients and fade out the current track.
      if (useCrossfade && fadeMs > 0 && isSequentialOrShuffle) {
        const currentForFlag = this.sounds.find((s) => s.playing);
        if (currentForFlag) {
          if (PlaylistActionAuthority.isAuthorizedGM()) {
            const payload = {
              fromSoundId: currentForFlag.id,
              fadeMs,
              seq: getNextSequence(this.id),
              ts: Date.now(),
              gmId: game.user.id,
            };
            try {
              await this.setFlag(MODULE_ID, "skipTransition", payload);
            } catch (_) { }
          }
          if (currentForFlag.sound) {
            const pendingFade = State.getEndOfTrackFade(currentForFlag);
            if (pendingFade) {
              pendingFade.cancel();
              State.clearEndOfTrackFade(currentForFlag);
            }
            debug(
              `[CF-Next] Fading out "${currentForFlag.name}" over ${fadeMs}ms (manual Next).`
            );
            cancelActiveFade(currentForFlag.sound);
            advancedFade(currentForFlag.sound, {
              targetVol: 0,
              duration: fadeMs,
            });
          }
        }
      }

      // Finally, call the original function to proceed to the next track.
      return await wrapped(...args);
    },
    "WRAPPER"
  );

  // Wrap playAll to schedule the first crossfade or loop when a playlist starts.
  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.playAll",
    async function (wrapped, ...args) {
      // Playback is starting, so clear any lingering "stopping" state.
      State.clearStoppingFlag(this);
      const result = await wrapped.call(this, ...args);

      // After playAll starts, find the first track and arm its features.
      AudioTimeout.wait(0).then(() => {
        let first = this.sounds.find((s) => s.playing);
        if (Array.isArray(first)) first = first.pop();
        if (first) {
          scheduleCrossfade(this, first);
          scheduleLoopWithin(first);
        }
      });
      return result;
    },
    "WRAPPER"
  );

  // Global wrapper on Sound.play to manage all module features at the audio level.
  libWrapper.register(
    MODULE_ID,
    "foundry.audio.Sound.prototype.play",
    async function (wrapped, options = {}) {
      // 0. Ensure AudioContext is running (browser may suspend it in background tabs)
      ensureAudioContext();

      // 1. Initial checks and setup
      if (options?._fromLoop) {
        return wrapped.call(this, options);
      }
      const ps = findPlaylistSoundForSound(this);
      if (!(ps instanceof PlaylistSound)) {
        return wrapped.call(this, options);
      }

      // 2. Handle shuffle state
      _handleShuffleOnPlay(ps);

      // 3. Determine target volume and pre-mute for fade-in.
      //    Skip when called from crossfade — equalPowerCrossfade() manages the volume curve.
      if (!options?._fromCrossfade) {
        const targetVolume = Flags.resolveTargetVolume(ps);
        const fadeInMs = Flags.getPlaylistFlag(ps.parent, "fadeIn");
        const preMuteVolume = (fadeInMs > 0 && ps?.pausedTime === 0) ? 0 : targetVolume;
        _applyPreMute(this, ps, fadeInMs, targetVolume);

        // 4. Override options.volume so Foundry's internal play() uses our
        //    normalized/pre-muted value instead of the raw document volume.
        options = { ...options, volume: preMuteVolume };
      }

      // 5. Play the sound
      const result = await wrapped.call(this, options);

      // 6. Schedule all post-play actions (fade-in, loops, crossfade timers).
      //    Volume safety net is inside _schedulePostPlayActions, AFTER scheduling,
      //    so it doesn't destroy fade curves that were just set up.
      _schedulePostPlayActions(ps, this, { fromCrossfade: !!options?._fromCrossfade });

      return result;
    },
    "WRAPPER"
  );

  // Global wrapper on Sound.pause to correctly pause the internal loop timer.
  libWrapper.register(
    MODULE_ID,
    "foundry.audio.Sound.prototype.pause",
    function (wrapped, options = {}) {
      const ps = findPlaylistSoundForSound(this);

      if (ps instanceof PlaylistSound) {
        pauseLoopWithin(ps);
      }
      return wrapped.call(this, options);
    },
    "WRAPPER"
  );

  // Intercept volume changes on PlaylistSound documents to handle normalization
  libWrapper.register(
    MODULE_ID,
    "PlaylistSound.prototype.update",
    async function (wrapped, data, options = {}) {
      // Check if this update includes a volume change
      const hasVolumeChange = data.hasOwnProperty("volume");

      if (hasVolumeChange) {
        const playlist = this.parent;

        // Check if normalization is active for this playlist
        const normEnabled = Flags.getPlaylistFlag(
          playlist,
          "volumeNormalizationEnabled"
        );
        const hasOverride = Flags.getSoundFlag(this, "allowVolumeOverride");

        // If normalization is active and this sound doesn't have override permission
        if (normEnabled && !hasOverride) {
          // Check if this is a user-initiated change (not from our own normalization system)
          const isFromNormalization = options._fromNormalization;

          if (!isFromNormalization) {
            debug(
              `[Volume] Blocking manual volume change on "${this.name}" - normalization active`
            );

            // Apply the volume change to the audio element ONLY (temporary)
            if (this.sound) {
              this.sound.volume = data.volume;
            }

            // Remove volume from the update data
            const newData = { ...data };
            delete newData.volume;

            // If there's nothing left to update, skip the database call entirely
            // but still return the document to satisfy expectations
            if (Object.keys(newData).length === 0) {
              debug(
                `[Volume] Only volume changed (blocked), no database update needed`
              );
              // Return without updating - the audio element already has the new volume
              return this;
            }

            // Update other properties without the volume change
            return wrapped.call(this, newData, options);
          }
        }
      }

      // Normal update (either no volume change, or override is allowed, or from normalization)
      return wrapped.call(this, data, options);
    },
    "MIXED" // ← CHANGE FROM "WRAPPER" TO "MIXED"
  );

  /**
   * Override playbackOrder to inject advanced shuffle patterns.
   * This only activates when:
   * 1. Playlist is in SHUFFLE mode
   * 2. Advanced shuffle pattern is not "foundry-default"
   */
  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.playbackOrder",
    function (wrapped) {
      const playlist = this;

      // Only override for shuffle mode
      if (playlist.mode !== CONST.PLAYLIST_MODES.SHUFFLE) {
        return wrapped.call(this);
      }

      // Try to get custom order from our advanced shuffle system
      const customOrder = AdvancedShuffle.generateOrder(playlist);

      if (customOrder) {
        // Check if a silent gap is currently the active (playing) sound
        const playingGap = playlist.sounds.find(
          (s) => s.playing && s.getFlag(MODULE_ID, "isSilenceGap")
        );

        // If a gap is active, we must prepend it to the generated order.
        // This ensures Foundry's UI renders the gap as the currently playing track.
        // The core shuffle logic remains unaffected.
        if (playingGap) {
          // Create a new array with the gap ID at the front.
          // Avoid including it twice if it's somehow already in the list.
          const finalOrder = [
            playingGap.id,
            ...customOrder.filter((id) => id !== playingGap.id),
          ];
          return finalOrder;
        }

        // Only log if this is the actively playing playlist
        if (playlist.playing) {
          const pattern =
            game.settings.get(MODULE_ID, "shufflePattern") || "unknown";
          debug(
            `[Shuffle] Using advanced shuffle (${pattern}) for "${playlist.name}"`
          );
        }
        return customOrder;
      }

      // Fall back to Foundry's default shuffle
      return wrapped.call(this);
    },
    "MIXED"
  );

  // Guard: Prevent Foundry's sync() from stopping sounds mid-crossfade.
  // When performCrossfade updates the outgoing sound's document to { playing: false },
  // Foundry calls _onUpdate() → sync(). sync() sees !this.playing and calls
  // sound.stop({fade, volume: 0}), which runs cancelScheduledValues() + _disconnectPipeline(),
  // destroying our active setValueCurveAtTime crossfade curves.
  // Similarly, sync() calls sound.fade(volume, 500) for already-playing sounds to re-sync
  // volume, which also destroys curves via cancelScheduledValues().
  // This wrapper skips sync entirely when the sound has an active SoS fade curve.
  libWrapper.register(
    MODULE_ID,
    "PlaylistSound.prototype.sync",
    function (wrapped) {
      if (this.sound && State.isSoundFading(this.sound)) {
        debug(`[Sync Guard] Blocked sync() for "${this.name}" — SoS fade curve active`);
        return;
      }
      return wrapped();
    },
    "MIXED"
  );

  /**
   * Handle track additions - update shuffle state to include new tracks
   */
  Hooks.on("createPlaylistSound", (sound, options, userId) => {
    const playlist = sound.parent;
    if (playlist?.mode === CONST.PLAYLIST_MODES.SHUFFLE) {
      // Do not update the shuffle state for temporary silent gaps.
      if (sound.getFlag(MODULE_ID, "isSilenceGap")) {
        debug(
          `[Shuffle] Ignoring creation of temporary gap in "${playlist.name}"`
        );
        return;
      }
      AdvancedShuffle.handleTracksChanged(playlist);
      debug(
        `[Shuffle] Track added to "${playlist.name}", updated shuffle state`
      );
    }
  });

  /**
   * Handle track deletions - update shuffle state to remove deleted tracks
   */
  Hooks.on("deletePlaylistSound", (sound, options, userId) => {
    // --- Looper cleanup ---
    debug(
      `[Manager] Sound document "${sound.name}" was deleted. Ensuring its looper is cancelled.`
    );
    cancelLoopWithin(sound, { quiet: true });

    // --- Shuffle state update ---
    const playlist = sound.parent;
    if (playlist?.mode === CONST.PLAYLIST_MODES.SHUFFLE) {
      // Do not update the shuffle state when temporary silent gaps are deleted.
      if (sound.getFlag(MODULE_ID, "isSilenceGap")) {
        debug(
          `[Shuffle] Ignoring deletion of temporary gap in "${playlist.name}"`
        );
        return;
      }
      AdvancedShuffle.handleTracksChanged(playlist);
      debug(
        `[Shuffle] Track removed from "${playlist.name}", updated shuffle state`
      );
    }
  });

  /**
   * Optional: Reset shuffle state when playlist stops
   * Uncomment for shuffle to start fresh each time playlist plays
   */
  Hooks.on("stopPlaylist", (playlist) => {
    if (playlist.mode === CONST.PLAYLIST_MODES.SHUFFLE) {
      AdvancedShuffle.reset(playlist);
      debug(`[Shuffle] Reset state for "${playlist.name}" on stop`);
    }
  });

  Hooks.on("updatePlaylist", async (playlist, changes, options, userId) => {
    // Only the GM who initiated the change should perform the update.
    if (game.user.id !== userId || !game.user.isGM) return;

    const flagPath = `flags.${MODULE_ID}`;
    const normalizationToggled = foundry.utils.hasProperty(
      changes,
      `${flagPath}.volumeNormalizationEnabled`
    );
    const volumeChanged = foundry.utils.hasProperty(
      changes,
      `${flagPath}.normalizedVolume`
    );

    // Exit if normalization isn't enabled or if the relevant flags haven't changed.
    const normFlags = Flags.getPlaylistFlags(playlist);
    if (
      !normFlags.volumeNormalizationEnabled ||
      (!normalizationToggled && !volumeChanged)
    ) {
      return;
    }

    const targetVolume = normFlags.normalizedVolume;
    const updates = [];

    // Convert the linear slider value to the logarithmic value the audio engine needs
    const convertedVolume =
      foundry.audio.AudioHelper.inputToVolume(targetVolume);

    for (const sound of playlist.sounds) {
      // Compare against the converted value
      if (
        !Flags.getSoundFlag(sound, "allowVolumeOverride") &&
        sound.volume !== convertedVolume
      ) {
        // Push the converted value in the update
        updates.push({ _id: sound.id, volume: convertedVolume });
      }
    }

    if (updates.length > 0) {
      debug(
        `[Volume] Normalizing ${updates.length} sounds to ${(
          targetVolume * 100
        ).toFixed(0)}% in "${playlist.name}"`
      );

      await playlist.updateEmbeddedDocuments("PlaylistSound", updates, {
        _fromNormalization: true,
        render: false,
      });

      // Find the playlist element in the UI
      const playlistElement = document.querySelector(
        `.playlist[data-document-id="${playlist.id}"]`
      );
      if (playlistElement) {
        for (const update of updates) {
          // Find the specific sound's <li> element
          const soundElement = playlistElement.querySelector(
            `.sound[data-sound-id="${update._id}"]`
          );
          if (soundElement) {
            // Find the volume slider for that sound
            const rangePicker = soundElement.querySelector(
              "range-picker.sound-volume"
            );
            if (rangePicker) {
              // Directly set its value. This does not cause a re-render.
              rangePicker.value = targetVolume; // Use the 0-1 value, not the converted one
            }
          }
        }
      }
      // Also update the "Currently Playing" section if it exists
      const currentlyPlaying = document.querySelector(".currently-playing");
      if (currentlyPlaying) {
        for (const update of updates) {
          const soundElement = currentlyPlaying.querySelector(
            `.sound[data-sound-id="${update._id}"]`
          );
          if (soundElement) {
            const rangePicker = soundElement.querySelector(
              "range-picker.sound-volume"
            );
            if (rangePicker) {
              rangePicker.value = targetVolume;
            }
          }
        }
      }
    }
  });

  /**
   * Marks a track as played for advanced shuffle patterns.
   */
  function _handleShuffleOnPlay(ps) {
    if (ps.parent?.mode === CONST.PLAYLIST_MODES.SHUFFLE && !ps.pausedTime) {
      debug(
        `[Shuffle] Marking track as played via Sound.play wrapper: "${ps.name}"`
      );
      AdvancedShuffle.markTrackPlayed(ps.parent, ps);
    }
  }

  /**
   * Sets the initial volume of a sound object before playback.
   * Mutes the sound if a fade-in is required, otherwise sets it to its target volume.
   */
  function _applyPreMute(sound, ps, fadeInMs, targetVolume) {
    if (fadeInMs > 0 && ps?.pausedTime === 0) {
      sound.volume = 0; // Start at 0 for fade-in
    } else {
      sound.volume = targetVolume; // Not fading in, set correct volume immediately
    }
  }

  /**
   * Schedules all module features that must run after a sound begins playback.
   * This includes loops, fades, and crossfade timers.
   */
  function _schedulePostPlayActions(ps, sound, { fromCrossfade = false } = {}) {
    const playlist = ps.parent;

    // Resume or schedule new loop
    if (ps.pausedTime > 0) {
      debug(`[Sound.play WRAPPER] Resuming loop for "${ps.name}".`);
      resumeLoopWithin(ps);
    } else {
      debug(`[Sound.play WRAPPER] Scheduling new loop for "${ps.name}".`);
      cancelLoopWithin(ps, { quiet: true });
      scheduleLoopWithin(ps);
    }

    // Apply fade-in, passing the normalized target volume directly to avoid
    // race conditions (applyFadeIn is async but not awaited here).
    const fadeInMs = Flags.getPlaylistFlag(playlist, "fadeIn");
    if (fadeInMs > 0 && !ps?.getFlag(MODULE_ID, "isSilenceGap") && !fromCrossfade) {
      const targetVolume = Flags.resolveTargetVolume(ps);
      applyFadeIn(playlist, ps, { targetVolume }).catch(err => {
        debug(`[FadeIn] Error during fade-in for "${ps.name}":`, err.message);
      });
    }

    // Re-arm automatic crossfade timer
    if (Flags.getPlaylistFlag(playlist, "crossfade")) {
      scheduleCrossfade(playlist, ps);

      // Cancel Foundry's built-in _scheduleFadeOut. When third-party modules
      // (e.g. Playlist Enchantment) force a non-zero playlist.fade, Foundry's
      // _onStart() schedules an independent fade-out that competes with our
      // crossfade timer and can destroy our setValueCurveAtTime curves.
      if (typeof ps._cancelFadeOut === "function") {
        ps._cancelFadeOut();
        debug(`[PostPlay] Cancelled Foundry _scheduleFadeOut for "${ps.name}" — SoS crossfade active.`);
      }
    }

    // Schedule end-of-track fade if no other feature is handling the transition
    const loopConfig = Flags.getLoopConfig(ps);
    const playbackMode = Flags.getPlaybackMode(playlist);

    if (!loopConfig?.enabled && !playbackMode.crossfade && !ps.repeat) {
      // For both Silence and standard Sequential/Shuffle modes, we want a fade-out
      // at the end of the track. Our new utility handles this perfectly.
      // Skip if the sound is set to repeat (native loop) to avoid NaN gain issues.
      scheduleEndOfTrackFade(ps);
    }

    // Post-schedule volume safety net (for background tabs).
    // Runs AFTER all scheduling so it doesn't destroy fade curves that were just set up.
    if ((fadeInMs <= 0 || ps?.pausedTime > 0) && !State.isSoundFading(sound) && !fromCrossfade) {
      const target = Flags.resolveTargetVolume(ps);
      if (Math.abs(sound.volume - target) > 0.001) {
        debug(`[Sound.play] Post-schedule volume correction: ${sound.volume.toFixed(3)} -> ${target.toFixed(3)} for "${ps.name}"`);
        sound.volume = target;
      }
    }
  }
});
