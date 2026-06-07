/**
 * @file transition-replication-hooks.js
 * @description Replicates playlist skip, stop, and crossfade transitions to non-owner clients.
 */
import {
  prepareIncomingCrossfadeMedia,
} from "../cross-fade.js";
import {
  advancedFade,
  cancelActiveFade,
  equalPowerCrossfade,
} from "../audio-fader.js";
import { Flags } from "../flag-service.js";
import { cancelLoopWithin } from "../internal-loop.js";
import { State, cleanupPlaylistState } from "../state-manager.js";
import {
  debug,
  MODULE_ID,
  safeStop,
  shouldProcessAction,
  waitForMedia,
} from "../utils.js";

const AudioTimeout = foundry.audio.AudioTimeout;

export function registerTransitionReplicationHooks() {
  Hooks.on("updatePlaylist", async (pl, changes) => {
    if (!changes?.flags?.[MODULE_ID]?.skipTransition) return;
    const next = pl.getFlag(MODULE_ID, "skipTransition");
    if (!next) return;

    const { fromSoundId, fadeMs, seq, gmId } = next;
    if (!fromSoundId || !Number.isFinite(fadeMs) || !Number.isFinite(seq)) return;

    if (gmId === game.user.id || pl.isOwner) {
      debug("[Skip-Sync] Skipping self/owner-triggered action");
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
    if (!changes?.flags?.[MODULE_ID]?.stopTransition) return;
    const stop = pl.getFlag(MODULE_ID, "stopTransition");
    if (!stop) return;

    const { soundIds, fadeMs, seq, gmId } = stop;
    if (!Array.isArray(soundIds) || !Number.isFinite(seq)) return;

    if (gmId === game.user.id || pl.isOwner) return;

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
    if (!changes?.flags?.[MODULE_ID]?.crossfadeTransition) return;
    const cf = playlist.getFlag(MODULE_ID, "crossfadeTransition");
    if (!cf) return;

    const { incomingSoundId, outgoingSoundId, fadeMs, targetVolIn, seq, gmId } = cf;

    if (gmId === game.user.id || playlist.isOwner) return;

    if (!shouldProcessAction(playlist.id, seq)) {
      debug(`[Crossfade-Sync] Ignoring duplicate/out-of-order (seq ${seq})`);
      return;
    }

    State.markPlaylistAsCrossfading(playlist);

    try {
      const psOut = playlist.sounds.get(outgoingSoundId);
      const psIn = playlist.sounds.get(incomingSoundId);
      if (!psIn) {
        State.clearPlaylistCrossfading(playlist);
        return;
      }
      const sharedTargetVolIn = Number.isFinite(Number(targetVolIn))
        ? Number(targetVolIn)
        : Flags.resolveSharedTargetVolume(psIn);
      const localTargetVolIn = Flags.resolveTargetVolume(psIn, { sharedVolume: sharedTargetVolIn });

      const [soundOut, soundIn] = await Promise.all([
        psOut ? waitForMedia(psOut) : Promise.resolve(null),
        prepareIncomingCrossfadeMedia(psIn),
      ]);

      if (!soundIn) {
        debug(`[Crossfade-Sync] Incoming sound "${psIn.name}" did not start; falling back to native sync after transition.`);
        State.clearPlaylistCrossfading(playlist);
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
        soundIn.volume = localTargetVolIn;
        State.clearPlaylistCrossfading(playlist);
        return;
      }

      debug(`[Crossfade-Sync] Applying equal-power crossfade "${psOut?.name}" -> "${psIn.name}" (${fadeMs}ms)`);

      const fadeTokens = equalPowerCrossfade(soundOut, soundIn, fadeMs, { targetVolIn: localTargetVolIn });

      AudioTimeout.wait(fadeMs + 50).then(() => {
        if (soundIn && fadeTokens?.inToken) State.clearFadingSound(soundIn, fadeTokens.inToken);
        if (soundOut?.playing && (!fadeTokens?.outToken || State.isCurrentFadeToken(soundOut, fadeTokens.outToken))) {
          safeStop(soundOut, "replicated crossfade completion");
        }
        if (soundOut && fadeTokens?.outToken) State.clearFadingSound(soundOut, fadeTokens.outToken);
        State.clearPlaylistCrossfading(playlist);
      });
    } catch (err) {
      debug(`[Crossfade-Sync] Failed to apply replicated crossfade:`, err?.message ?? err);
      State.clearPlaylistCrossfading(playlist);
    }
  });
}
