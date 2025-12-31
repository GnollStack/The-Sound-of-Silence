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
  pauseLoopWithin,
  resumeLoopWithin,
} from "./internal-loop.js";
import { maybeLoopPlaylist } from "./playlist-loop.js";
import {
  advancedFade,
  scheduleEndOfTrackFade,
  cancelActiveFade,
  fadeOutAndStop,
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
} from "./utils.js";
import { Flags } from "./flag-service.js";
import { State } from "./state-manager.js";
import { API } from "./api.js";
import { AdvancedShuffle, SHUFFLE_PATTERNS } from "./advanced-shuffle.js";

// =========================================================================
// Constants & State
// =========================================================================

const FLAG_ENABLED = "silenceEnabled";

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

/**
 * A simple helper to check if the "Sound of Silence" feature is enabled for a playlist.
 * @param {Playlist} playlist The playlist to check.
 * @returns {boolean} True if silence is enabled, false otherwise.
 */
function silenceIsEnabled(playlist) {
  return playlist.getFlag(MODULE_ID, FLAG_ENABLED) ?? false;
}

// =========================================================================
// Foundry Hooks
// =========================================================================

Hooks.once("init", () => {
  console.log(`[${MODULE_ID}] Initializing…`);

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

  registerPlaylistSheetWrappers();
  registerSoundConfigWrappers();

  // This hook reacts to flag changes caused by UI interactions or other clients.
  Hooks.on("updatePlaylistSound", (soundDoc, changes) => {
    const loopFlags = changes?.flags?.[MODULE_ID]?.loopWithin;
    if (!loopFlags) return;

    // --- Handle loop activation/deactivation from the toggle button ---
    if (loopFlags.hasOwnProperty("active")) {
      const isActive = loopFlags.active;
      if (isActive) {
        scheduleLoopWithin(soundDoc);
      } else {
        cancelLoopWithin(soundDoc);
      }
    }

    // --- Handle enabling/disabling the feature entirely from the config ---
    if (loopFlags.hasOwnProperty("enabled")) {
      ui.playlists?.render();
      if (!loopFlags.enabled) {
        cancelLoopWithin(soundDoc);
      }
    }

    // --- Handle the "break loop" event ---
    if (loopFlags.hasOwnProperty("skipCount")) {
      debug(`[Main] Skip-loop event received for "${soundDoc.name}".`);
      breakLoopWithin(soundDoc);
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

  // When a sound document is deleted, ensure any associated looper is destroyed.
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

  // This hook listens for the 'skipTransition' flag to mirror GM "Next" actions on all clients.
  // NOTE: We no longer need _lastSkipSeen - using sequence system instead

  // Use the centralized sequence system instead of timestamp deduplication
  Hooks.on("updatePlaylist", async (pl, changes) => {
    const next = changes?.flags?.[MODULE_ID]?.skipTransition;
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
    } catch (_) {}
    advancedFade(media, { targetVol: 0, duration: Number(fadeMs) || 0 });
  });

  // This hook listens for the 'stopTransition' flag to mirror GM "Stop All" actions on all clients.
  // NOTE: Deduplication handled by shouldProcessAction - no local Map needed
  Hooks.on("updatePlaylist", async (pl, changes) => {
    const stop = changes?.flags?.[MODULE_ID]?.stopTransition;
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
      } catch (_) {}
      if (dur > 0) {
        debug(
          `[Stop-Client] Fading out "${ps.name}" over ${dur}ms (replicated).`
        );
        advancedFade(media, { targetVol: 0, duration: dur });
        setTimeout(() => {
          try {
            media.stop();
          } catch (_) {}
        }, dur + 10);
      } else {
        try {
          media.stop();
        } catch (_) {}
      }
    }
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
            } catch (_) {}
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
      setTimeout(() => {
        let first = this.sounds.find((s) => s.playing);
        if (Array.isArray(first)) first = first.pop();
        if (first) {
          scheduleCrossfade(this, first);
          scheduleLoopWithin(first);
        }
      }, 0);
      return result;
    },
    "WRAPPER"
  );

  // Global wrapper on Sound.play to manage all module features at the audio level.
  libWrapper.register(
    MODULE_ID,
    "foundry.audio.Sound.prototype.play",
    async function (wrapped, options = {}) {
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

      // 3. Determine target volume and pre-mute for fade-in
      const targetVolume = _determineTargetVolume(ps);
      const fadeInMs = Flags.getPlaylistFlag(ps.parent, "fadeIn");
      _applyPreMute(this, ps, fadeInMs, targetVolume);

      // 4. Play the sound
      const result = await wrapped.call(this, options);

      // 5. Schedule all post-play actions
      _schedulePostPlayActions(ps, this);

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
   * Determines the correct target volume for a sound, accounting for volume normalization.
   * @returns {number} The calculated target volume (0-1).
   */
  function _determineTargetVolume(ps) {
    const playlist = ps.parent;
    const normEnabled = Flags.getPlaylistFlag(
      playlist,
      "volumeNormalizationEnabled"
    );
    const hasOverride = Flags.getSoundFlag(ps, "allowVolumeOverride");

    if (normEnabled && !hasOverride) {
      const normalizedVolume = Flags.getPlaylistFlag(
        playlist,
        "normalizedVolume"
      );
      debug(
        `[Volume] Will use normalized volume ${(normalizedVolume * 100).toFixed(
          0
        )}% for "${ps.name}"`
      );
      return foundry.audio.AudioHelper.inputToVolume(normalizedVolume);
    }
    return ps.volume;
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
  function _schedulePostPlayActions(ps, sound) {
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

    // Apply fade-in
    const fadeInMs = Flags.getPlaylistFlag(playlist, "fadeIn");
    if (fadeInMs > 0 && !ps?.getFlag(MODULE_ID, "isSilenceGap")) {
      // We need to determine the target volume again here for the fade logic
      const targetVolume = _determineTargetVolume(ps);
      const originalDocVolume = ps.volume;
      ps.volume = targetVolume; // Temporarily set for fade logic
      applyFadeIn(playlist, ps);
      ps.volume = originalDocVolume; // Restore
    }

    // Re-arm automatic crossfade timer
    if (Flags.getPlaylistFlag(playlist, "crossfade")) {
      scheduleCrossfade(playlist, ps);
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
  }
});
