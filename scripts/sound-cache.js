// sound-cache.js
/**
 * @file sound-cache.js
 * @description Shared memoized cache of all PlaylistSound documents by ID.
 * Invalidated when playlists/sounds are added, removed, or updated.
 * Used by both playlist-ui.js and currently-playing.js.
 */

/** @type {Map<string, PlaylistSound>} */
let soundCache = new Map();
let cacheInvalidated = true;

function rebuildSoundCache() {
    soundCache.clear();
    for (const playlist of game.playlists) {
        for (const sound of playlist.sounds) {
            soundCache.set(sound.id, sound);
        }
    }
    cacheInvalidated = false;
}

export function invalidateSoundCache() {
    cacheInvalidated = true;
}

/**
 * Finds a PlaylistSound document by its ID using a fast cached lookup.
 * @param {string} soundId The ID of the sound to find.
 * @returns {PlaylistSound|null}
 */
export function findSoundById(soundId) {
    if (cacheInvalidated) rebuildSoundCache();
    return soundCache.get(soundId) || null;
}

/**
 * Ensures the cache is fresh. Call before batch lookups.
 */
export function ensureCacheReady() {
    if (cacheInvalidated) rebuildSoundCache();
}

// Invalidate cache when playlists/sounds change
Hooks.on("createPlaylist", invalidateSoundCache);
Hooks.on("deletePlaylist", invalidateSoundCache);
Hooks.on("createPlaylistSound", invalidateSoundCache);
Hooks.on("deletePlaylistSound", invalidateSoundCache);
Hooks.on("updatePlaylistSound", invalidateSoundCache);
