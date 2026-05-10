/**
 * @file playlist-actions.js
 * @description Small shared playlist action helpers.
 */
import { cleanupPlaylistState } from "../state-manager.js";

export async function cancelSilentGap(playlist) {
  return cleanupPlaylistState(playlist, {
    cleanSilence: true,
    cleanCrossfade: false,
    cleanLoopers: false,
  });
}
