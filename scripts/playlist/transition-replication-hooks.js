/**
 * @file transition-replication-hooks.js
 * @description Replicates playlist skip, stop, and crossfade transitions to non-owner clients.
 */
import {
  describeCrossfadeAudioGraph,
  prepareIncomingCrossfadeMedia,
} from "../cross-fade.js";
import {
  advancedFade,
  cancelActiveFade,
  equalPowerCrossfade,
} from "../audio-fader.js";
import { Flags } from "../flag-service.js";
import { cancelLoopWithin } from "../internal-loop.js";
import {
  activateCrossfadeSession,
  createCrossfadeSession,
  isCurrentCrossfadeSession,
} from "../playback/transition-session.js";
import { State, cleanupPlaylistState } from "../state-manager.js";
import {
  debug,
  MODULE_ID,
  safeStop,
  shouldProcessAction,
  waitForMedia,
} from "../utils.js";

const AudioTimeout = foundry.audio.AudioTimeout;

function hasModuleFlagChange(changes, key) {
  if (!changes || !key) return false;

  const flatKey = `flags.${MODULE_ID}.${key}`;
  if (Object.prototype.hasOwnProperty.call(changes, flatKey)) return true;
  if (foundry.utils.hasProperty(changes, flatKey)) return true;

  const moduleFlags = changes?.flags?.[MODULE_ID];
  return !!moduleFlags && Object.prototype.hasOwnProperty.call(moduleFlags, key);
}

export function registerTransitionReplicationHooks() {
  Hooks.on("updatePlaylist", async (pl, changes) => {
    if (!hasModuleFlagChange(changes, "skipTransition")) return;
    const next = pl.getFlag(MODULE_ID, "skipTransition");
    if (!next) return;

    const { fromSoundId, fadeMs, seq, gmId } = next;
    if (!fromSoundId || !Number.isFinite(fadeMs) || !Number.isFinite(seq)) return;

    if (gmId === game.user.id) {
      debug("[Skip-Sync] Skipping self-triggered action");
      return;
    }

    if (!shouldProcessAction(pl.id, seq)) {
      debug(`[Skip-Sync] Ignoring duplicate or out-of-order skip (seq ${seq})`);
      return;
    }

    debug(`[Skip-Sync] Processing skip from GM ${gmId}, seq ${seq}`);

    for (const s of pl.sounds) {
      cancelLoopWithin(s, { restorePlaybackHandlers: false });
    }

    const ps = pl.sounds.get(fromSoundId);
    if (!ps) return;
    const media = await waitForMedia(ps);
    if (!media) return;

    try {
      cancelActiveFade(media);
    } catch (_) { }
    advancedFade(media, { targetVol: 0, duration: Number(fadeMs) || 0 });
  });

  Hooks.on("updatePlaylist", async (pl, changes) => {
    if (!hasModuleFlagChange(changes, "stopTransition")) return;
    const stop = pl.getFlag(MODULE_ID, "stopTransition");
    if (!stop) return;

    const { soundIds, fadeMs, seq, gmId } = stop;
    if (!Array.isArray(soundIds) || !Number.isFinite(seq)) return;

    if (gmId === game.user.id) return;

    if (!shouldProcessAction(pl.id, seq)) {
      debug(`[Stop-Sync] Ignoring duplicate or out-of-order stop (seq ${seq})`);
      return;
    }

    debug(`[Stop-Sync] Processing stop from GM ${gmId}, seq ${seq}`);

    State.markPlaylistAsStopping(pl);
    await cleanupPlaylistState(pl, {
      cleanSilence: true,
      cleanCrossfade: true,
      cleanLoopers: true,
      allowFadeOut: true,
    });

    const dur = Number(fadeMs) || 0;
    for (const sid of soundIds) {
      const ps = pl.sounds.get(sid);
      if (!ps) continue;

      const pendingFade = State.getEndOfTrackFade(ps);
      if (pendingFade) {
        pendingFade.cancel();
        State.clearEndOfTrackFade(ps);
      }

      const media = await waitForMedia(ps);
      if (!media) continue;

      try {
        cancelActiveFade(media);
      } catch (_) { }
      if (dur > 0) {
        debug(
          `[Stop-Client] Fading out "${ps.name}" over ${dur}ms (replicated).`
        );
        const token = advancedFade(media, { targetVol: 0, duration: dur });
        AudioTimeout.wait(dur + 10).then(() => {
          if (token && !State.isCurrentFadeToken(media, token)) return;
          try {
            media.stop();
          } catch (_) { }
          if (token) State.clearFadingSound(media, token);
        }).catch(() => { });
      } else {
        try {
          media.stop();
        } catch (_) { }
      }
    }
  });

  Hooks.on("updatePlaylist", async (playlist, changes) => {
    if (!hasModuleFlagChange(changes, "crossfadeTransition")) return;
    const cf = playlist.getFlag(MODULE_ID, "crossfadeTransition");
    if (!cf) return;

    const { incomingSoundId, outgoingSoundId, fadeMs, targetVolIn, seq, gmId } = cf;

    if (gmId === game.user.id) return;

    if (!shouldProcessAction(playlist.id, seq)) {
      debug(`[Crossfade-Sync] Ignoring duplicate/out-of-order (seq ${seq})`);
      return;
    }

    let transitionSession = null;
    try {
      const psOut = playlist.sounds.get(outgoingSoundId);
      const psIn = playlist.sounds.get(incomingSoundId);
      if (!psIn) return;
      const sharedTargetVolIn = Number.isFinite(Number(targetVolIn))
        ? Number(targetVolIn)
        : Flags.resolveSharedTargetVolume(psIn);
      const localTargetVolIn = Flags.resolveTargetVolume(psIn, { sharedVolume: sharedTargetVolIn });
      transitionSession = createCrossfadeSession({
        playlist,
        outgoingDocument: psOut,
        incomingDocument: psIn,
        outgoingSound: psOut?.sound ?? null,
        durationMs: Number(fadeMs) || 0,
        outgoingTargetVolume: psOut ? Flags.resolveTargetVolume(psOut) : 1,
        source: "replicated",
      });

      const [soundOut, soundIn] = await Promise.all([
        psOut ? waitForMedia(psOut) : Promise.resolve(null),
        prepareIncomingCrossfadeMedia(psIn),
      ]);
      if (!isCurrentCrossfadeSession(transitionSession)) {
        if (soundIn?.playing) safeStop(soundIn, "stale replicated incoming media");
        return;
      }
      transitionSession.outgoingSound = soundOut;
      transitionSession.incomingSound = soundIn;
      transitionSession.incomingTargetVolume = localTargetVolIn;

      debug(`[Crossfade-Sync] Audio graph snapshot before replicated crossfade.`, {
        outgoing: describeCrossfadeAudioGraph(soundOut),
        incoming: describeCrossfadeAudioGraph(soundIn),
      });

      if (!soundIn) {
        debug(`[Crossfade-Sync] Incoming sound "${psIn.name}" did not start; falling back to native sync after transition.`);
        await transitionSession.settle({ mode: "cancel", reason: "incoming media unavailable" });
        AudioTimeout.wait((Number(fadeMs) || 0) + 250).then(() => {
          try {
            psIn.sync?.();
          } catch (err) {
            debug(`[Crossfade-Sync] Native sync fallback failed for "${psIn.name}":`, err?.message ?? err);
          }
        }).catch(() => { });
        return;
      }

      if (!soundOut?.playing) {
        debug(`[Crossfade-Sync] Outgoing sound already stopped; snapping "${psIn.name}" to target volume.`);
        await transitionSession.settle({ mode: "complete", reason: "outgoing media already stopped" });
        return;
      }

      debug(`[Crossfade-Sync] Applying equal-power crossfade "${psOut?.name}" -> "${psIn.name}" (${fadeMs}ms)`);

      const canEqualPowerCrossfade = !!(
        soundOut?.playing &&
        soundOut?.gain &&
        soundOut?.context &&
        soundIn?.gain &&
        soundIn?.context
      );
      let fadeTokens = null;

      if (canEqualPowerCrossfade) {
        fadeTokens = equalPowerCrossfade(soundOut, soundIn, fadeMs, { targetVolIn: localTargetVolIn });
      } else {
        debug(`[Crossfade-Sync] Audio graph unavailable; snapping "${psIn.name}" to target volume and fading outgoing where possible.`, {
          outgoing: describeCrossfadeAudioGraph(soundOut),
          incoming: describeCrossfadeAudioGraph(soundIn),
        });
        soundIn.volume = localTargetVolIn;

        const fadeDuration = Number(fadeMs) || 0;
        if (soundOut?.playing && fadeDuration > 0 && soundOut.gain && soundOut.context) {
          const outToken = advancedFade(soundOut, { targetVol: 0, duration: fadeDuration });
          fadeTokens = outToken ? { outToken, inToken: null } : null;
        }
      }

      activateCrossfadeSession(transitionSession, {
        outgoingSound: soundOut,
        incomingSound: soundIn,
        incomingTargetVolume: localTargetVolIn,
        fadeTokens,
      });
    } catch (err) {
      debug(`[Crossfade-Sync] Failed to apply replicated crossfade:`, err?.message ?? err);
      await transitionSession?.settle({ mode: "cancel", reason: "replicated crossfade error" });
    }
  });
}
