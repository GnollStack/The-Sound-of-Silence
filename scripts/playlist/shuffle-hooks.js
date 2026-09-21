/**
 * @file shuffle-hooks.js
 * @description Advanced shuffle playback-order wrapper and shuffle state hooks.
 */
import { AdvancedShuffle } from "../advanced-shuffle.js";
import { cancelLoopWithin } from "../internal-loop.js";
import { PlaybackClock } from "../playback-clock.js";
import { debug, MODULE_ID, PlaylistActionAuthority } from "../utils.js";

let lastShuffleAuthorityId = null;

export function registerShuffleHooks() {
  lastShuffleAuthorityId = PlaylistActionAuthority.getAuthorizedGMId();
  libWrapper.register(
    MODULE_ID,
    "Playlist.prototype.playbackOrder",
    function (wrapped) {
      const playlist = this;

      if (playlist.mode !== CONST.PLAYLIST_MODES.SHUFFLE) {
        return wrapped.call(this);
      }

      const customOrder = AdvancedShuffle.generateOrder(playlist);

      if (customOrder) {
        const playingGap = playlist.sounds.find(
          (s) => s.playing && s.getFlag(MODULE_ID, "isSilenceGap")
        );

        if (playingGap) {
          return [
            playingGap.id,
            ...customOrder.filter((id) => id !== playingGap.id),
          ];
        }

        if (playlist.playing) {
          const pattern =
            game.settings.get(MODULE_ID, "shufflePattern") || "unknown";
          debug(
            `[Shuffle] Using advanced shuffle (${pattern}) for "${playlist.name}"`
          );
        }
        return customOrder;
      }

      return wrapped.call(this);
    },
    "MIXED"
  );

  Hooks.on("createPlaylistSound", (sound) => {
    const playlist = sound.parent;
    if (playlist?.mode === CONST.PLAYLIST_MODES.SHUFFLE) {
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

  Hooks.on("deletePlaylistSound", (sound) => {
    debug(
      `[Manager] Sound document "${sound.name}" was deleted. Ensuring its looper is cancelled.`
    );
    cancelLoopWithin(sound, { quiet: true, preservePlayback: false });

    const playlist = sound.parent;
    if (playlist?.mode === CONST.PLAYLIST_MODES.SHUFFLE) {
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

  Hooks.on("updatePlaylist", (playlist, changes) => {
    const nestedFlags = changes?.flags?.[MODULE_ID];
    const hasStopTransition = Object.prototype.hasOwnProperty.call(
      changes ?? {},
      `flags.${MODULE_ID}.stopTransition`
    ) || Object.prototype.hasOwnProperty.call(nestedFlags ?? {}, "stopTransition");
    const stopped = changes?.playing === false || hasStopTransition;
    if (!stopped) return;

    PlaybackClock.clear(playlist, "playlist stopped").catch((err) =>
      debug(`[Clock] Failed to clear stopped playlist clock:`, err?.message ?? err)
    );
    if (playlist.mode === CONST.PLAYLIST_MODES.SHUFFLE) {
      AdvancedShuffle.reset(playlist);
      debug(`[Shuffle] Reset state for "${playlist.name}" on stop`);
    }
  });

  const reconcileShuffleAuthority = () => {
    const nextAuthorityId = PlaylistActionAuthority.getAuthorizedGMId();
    if (nextAuthorityId === lastShuffleAuthorityId) return;
    const previousAuthorityId = lastShuffleAuthorityId;
    lastShuffleAuthorityId = nextAuthorityId;

    // A newly elected primary GM may inherit playback mid-cycle. Reset every
    // client's local cache to the same deterministic cycle before it advances.
    if (!AdvancedShuffle.isEnabled()) return;
    for (const playlist of Array.from(game.playlists ?? [])) {
      if (playlist.mode !== CONST.PLAYLIST_MODES.SHUFFLE) continue;
      AdvancedShuffle.reset(playlist);
    }
    debug(`[Shuffle] Reset local cycles after authority changed ${previousAuthorityId ?? "none"} -> ${nextAuthorityId ?? "none"}.`);
  };

  Hooks.on(`${MODULE_ID}.playbackAuthorityChanged`, reconcileShuffleAuthority);
}
