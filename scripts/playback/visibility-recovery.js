/**
 * @file visibility-recovery.js
 * @description Browser visibility recovery and safety checks.
 */
import { isFadeTokenStale } from "../audio-fader.js";
import { scheduleCrossfade } from "../cross-fade.js";
import { Flags } from "../flag-service.js";
import { State } from "../state-manager.js";
import { debug, ensureAudioContext } from "../utils.js";
import { runPlaybackRecoveryWatchdog } from "../playback-recovery.js";

export function registerVisibilityRecovery() {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;

    debug("[Visibility] Tab regained focus. Validating module state...");

    ensureAudioContext();
    runPlaybackRecoveryWatchdog("visibility");

    for (const playlist of game.playlists) {
      if (!playlist.playing) continue;

      const crossfadeSession = State.getCrossfadeSession(playlist);
      if (
        State.isPlaylistCrossfading(playlist) &&
        !State.getCrossfadeTimer(playlist) &&
        !crossfadeSession
      ) {
        debug(`[Visibility] Clearing stale crossfading flag for "${playlist.name}"`);
        State.clearPlaylistCrossfading(playlist);
      }

      for (const ps of playlist.sounds) {
        if (!ps.sound) continue;
        // Every fade passes through near-silent and near-full gain, so the
        // level cannot tell a live curve from an abandoned token. A token is
        // stale only once its own duration plus a generous grace has elapsed.
        const token = State.getFadeToken(ps.sound);
        if (token && isFadeTokenStale(token)) {
          const ageMs = Date.now() - Number(token.startedAt);
          debug(`[Visibility] Clearing stale fading lock for "${ps.name}" (${token.type ?? "fade"} started ${ageMs}ms ago)`);
          State.clearFadingSound(ps.sound, token);
        }
      }

      const mode = Flags.getPlaybackMode(playlist);
      if (
        mode.crossfade &&
        !State.getCrossfadeTimer(playlist) &&
        !State.getCrossfadeSession(playlist) &&
        !State.isPlaylistCrossfading(playlist)
      ) {
        const currentlyPlaying = playlist.sounds.find((s) =>
          s.playing && !Flags.getSoundFlag(s, "isSilenceGap")
        );
        if (currentlyPlaying) {
          const looper = State.getActiveLooper(currentlyPlaying);
          const loopConfig = Flags.getLoopConfig(currentlyPlaying);
          if ((looper && !looper.isDestroyed) || Flags.isLoopConfigActive(loopConfig)) {
            debug(`[Visibility] Skipping crossfade re-arm for "${currentlyPlaying.name}" - internal loop owns playback.`);
          } else {
            debug(`[Visibility] Re-arming crossfade timer for "${currentlyPlaying.name}"`);
            scheduleCrossfade(playlist, currentlyPlaying);
          }
        }
      }

      const normEnabled = Flags.getPlaylistFlag(playlist, "volumeNormalizationEnabled");
      if (normEnabled) {
        for (const ps of playlist.sounds) {
          if (!ps.playing || !ps.sound) continue;
          if (Flags.getSoundFlag(ps, "isSilenceGap")) continue;
          if (Flags.getSoundFlag(ps, "allowVolumeOverride")) continue;

          const expectedVolume = Flags.resolveTargetVolume(ps);
          const currentGain = ps.sound.gain?.value;
          if (
            currentGain !== undefined &&
            Math.abs(currentGain - expectedVolume) > 0.01 &&
            !State.isSoundFading(ps.sound)
          ) {
            debug(`[Visibility] Volume correction for "${ps.name}": gain=${currentGain.toFixed(3)} -> expected=${expectedVolume.toFixed(3)}`);
            ps.sound.volume = expectedVolume;
          }
        }
      }
    }
  });
}
