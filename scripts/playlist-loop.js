/**
 * @file playlist-loop.js
 * @description Provides the logic to automatically restart a playlist when it reaches its natural end,
 * if the "Loop Entire Playlist" flag is enabled.
 */
import { Flags } from "./flag-service.js";
import {
    getPlayableSoundsInOrder,
    hasSilenceGapDocuments,
} from "./playlist/playable-order.js";
import { MODULE_ID, PlaylistActionAuthority } from "./utils.js";
import { cancelCrossfade } from "./cross-fade.js";
import { debug } from "./utils.js";

const PM = CONST.PLAYLIST_MODES;

/**
 * Checks if a playlist should be looped and, if so, restarts it.
 * This function is intended to run only on the GM client to prevent multiple restarts.
 * It is triggered when a playlist naturally concludes (i.e., its last track finishes).
 *
 * @param {Playlist} playlist The playlist document to potentially loop.
 * @returns {boolean|Promise<unknown>} The restart result when triggered, otherwise false.
 */
export function maybeLoopPlaylist(playlist) {
    if (!playlist) return false;

    // Automatic restarts are authored by one deterministic active GM.
    if (!playlist.isOwner || !PlaylistActionAuthority.isAuthorizedGM()) return false;

    // Check if the playlist mode is one that supports looping.
    const ALLOWED = [PM.SEQUENTIAL, PM.SHUFFLE, PM.SIMULTANEOUS];
    if (!ALLOWED.includes(playlist.mode)) return false;

    const playableSounds = getPlayableSoundsInOrder(playlist);

    // In SIMULTANEOUS mode, only loop if no real playlist sound is still playing.
    if (playlist.mode === PM.SIMULTANEOUS && playableSounds.some(s => s.playing)) return false;

    // Check if the loop flag is enabled for this playlist.
    if (!playlist.getFlag(MODULE_ID, "loopPlaylist")) return false;

    // Do not let a temporary gap make an otherwise empty playlist loopable.
    if (!playableSounds.length) return false;

    debug(`[LP] 🔁 Restarting playlist "${playlist.name}"`);

    // Clear any stale cross-fade timer from the previous playback cycle.
    cancelCrossfade(playlist);

    // A persisted silence gap must remain until the real restart commits, but
    // Foundry's playAll() can select that temporary document from playbackOrder.
    // Start the first real track explicitly whenever a gap is present.
    if ([PM.SEQUENTIAL, PM.SHUFFLE].includes(playlist.mode)) {
        const firstSound = playableSounds[0];
        if (hasSilenceGapDocuments(playlist)) return playlist.playSound(firstSound);
    }

    if (playlist.mode === PM.SIMULTANEOUS && hasSilenceGapDocuments(playlist)) {
        return playlist.update({
            playing: true,
            sounds: Array.from(playlist.sounds ?? []).map((sound) => ({
                _id: sound.id,
                playing: !Flags.getSoundFlag(sound, "isSilenceGap"),
                pausedTime: null,
            })),
        });
    }

    // With no temporary documents, retain Foundry's native mode behavior.
    return playlist.playAll();
}
