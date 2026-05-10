/**
 * @file visibility-recovery.js
 * @description Browser visibility recovery and safety checks.
 */
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

      if (State.isPlaylistCrossfading(playlist) && !State.getCrossfadeTimer(playlist)) {
        debug(`[Visibility] Clearing stale crossfading flag for "${playlist.name}"`);
        State.clearPlaylistCrossfading(playlist);
      }

      for (const ps of playlist.sounds) {
        if (ps.sound && State.isSoundFading(ps.sound)) {
          const gain = ps.sound.gain?.value;
          if (gain !== undefined && (gain < 0.01 || gain > 0.95)) {
            debug(`[Visibility] Clearing stale fading lock for "${ps.name}" (gain=${gain.toFixed(3)})`);
            State.clearFadingSound(ps.sound);
          }
        }
      }

      const mode = Flags.getPlaybackMode(playlist);
      if (mode.crossfade && !State.getCrossfadeTimer(playlist)) {
        const currentlyPlaying = playlist.sounds.find((s) =>
          s.playing && !Flags.getSoundFlag(s, "isSilenceGap")
        );
        if (currentlyPlaying) {
          debug(`[Visibility] Re-arming crossfade timer for "${currentlyPlaying.name}"`);
          scheduleCrossfade(playlist, currentlyPlaying);
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
