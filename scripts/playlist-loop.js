/**
 * @file playlist-loop.js
 * @description Provides the logic to automatically restart a playlist when it reaches its natural end,
 * if the "Loop Entire Playlist" flag is enabled.
 */
import { MODULE_ID } from "./utils.js";
import { cancelCrossfade } from "./cross-fade.js";
import { debug } from "./utils.js";

const PM = CONST.PLAYLIST_MODES;

/**
 * Checks if a playlist should be looped and, if so, restarts it.
 * This function is intended to run only on the GM client to prevent multiple restarts.
 * It is triggered when a playlist naturally concludes (i.e., its last track finishes).
 *
 * @param {Playlist} playlist The playlist document to potentially loop.
 * @returns {boolean} Returns `true` if the playlist restart was triggered, otherwise `false`.
 */
export function maybeLoopPlaylist(playlist) {
    if (!playlist) return false;

    // Only the GM (or the playlist's owner) should control the restart action.
    if (!game.user.isGM && !playlist.isOwner) return false;

    // Check if the playlist mode is one that supports looping.
    const ALLOWED = [PM.SEQUENTIAL, PM.SHUFFLE, PM.SIMULTANEOUS];
    if (!ALLOWED.includes(playlist.mode)) return false;

    // In SIMULTANEOUS mode, only loop if NOTHING is still playing.
    if (playlist.mode === PM.SIMULTANEOUS && playlist.sounds.some(s => s.playing)) return false;

    // Check if the loop flag is enabled for this playlist.
    if (!playlist.getFlag(MODULE_ID, "loopPlaylist")) return false;

    // Do not attempt to loop an empty playlist.
    if (!playlist.sounds?.size) return false;

    debug(`[LP] 🔁 Restarting playlist "${playlist.name}"`);

    // Clear any stale cross-fade timer from the previous playback cycle.
    cancelCrossfade(playlist);

    // `playAll()` handles all modes correctly and regenerates the playback order for Shuffle mode.
    playlist.playAll();
    return true;
}