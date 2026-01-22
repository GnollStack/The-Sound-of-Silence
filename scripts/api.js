// api.js
/**
 * @file api.js
 * @description Public API for The Sound of Silence module.
 * All external integrations (macros, other modules) should use this interface.
 * 
 * Access via: game.modules.get('the-sound-of-silence').api
 */

import { Flags } from "./flag-service.js";
import { advancedFade, equalPowerCrossfade, fadeOutAndStop } from "./audio-fader.js";
import { scheduleCrossfade, performCrossfade, cancelCrossfade } from "./cross-fade.js";
import { scheduleLoopWithin, cancelLoopWithin, breakLoopWithin } from "./internal-loop.js";
import { Silence } from "./silence.js";
import { cleanupPlaylistState, toSec, formatTime } from "./utils.js";
import { State } from "./state-manager.js";

/**
 * Public API for The Sound of Silence module
 */
class SoundOfSilenceAPI {
    constructor() {
        this._initialized = false;

        /**
         * The module's ID string.
         * @type {string}
         */
        this.ID = 'the-sound-of-silence';

        /**
         * Converts a "MM:SS.mmm" time string to seconds.
         * @param {string} timeString - The time string to convert.
         * @returns {number}
         */
        this.toSeconds = toSec;

        /**
         * Converts seconds to a "MM:SS.mmm" time string.
         * @param {number} seconds - The seconds to convert.
         * @param {boolean} [showMilliseconds=true] - Whether to include milliseconds.
         * @returns {string}
         */
        this.formatTime = formatTime;
    }

    /**
     * Initialize the API. Called automatically by the module.
     * @private
     */
    _initialize() {
        if (this._initialized) return;
        this._initialized = true;

        console.log(`[SoS API] Initialized. Access via game.modules.get('the-sound-of-silence').api`);
    }

    // ============================================
    // Configuration API
    // ============================================

    /**
     * Get validated playlist configuration
     * @param {Playlist} playlist - The playlist document
     * @returns {Object} Validated configuration object
     * @example
     * const config = api.getPlaylistConfig(playlist);
     * console.log(config.crossfade, config.silenceEnabled, config.fadeIn);
     */
    getPlaylistConfig(playlist) {
        if (!(playlist instanceof Playlist)) {
            throw new TypeError("Expected Playlist document");
        }
        return Flags.getPlaylistFlags(playlist);
    }

    /**
     * Update playlist configuration
     * @param {Playlist} playlist - The playlist document
     * @param {Object} updates - Configuration updates
     * @returns {Promise<Playlist>} Updated playlist
     * @example
     * await api.updatePlaylistConfig(playlist, {
     *   crossfade: true,
     *   fadeIn: 2000
     * });
     */
    async updatePlaylistConfig(playlist, updates) {
        if (!(playlist instanceof Playlist)) {
            throw new TypeError("Expected Playlist document");
        }

        const validKeys = Object.keys(Flags.getPlaylistFlags(playlist));
        const invalidKeys = Object.keys(updates).filter(k => !validKeys.includes(k));
        if (invalidKeys.length) {
            throw new Error(`Invalid config keys: ${invalidKeys.join(', ')}`);
        }

        return playlist.update({
            [`flags.the-sound-of-silence`]: updates
        });
    }

    /**
     * Get sound loop configuration
     * @param {PlaylistSound} sound - The sound document
     * @returns {Object} Loop configuration with segments
     * @example
     * const loop = api.getLoopConfig(sound);
     * console.log(loop.enabled, loop.segments);
     */
    getLoopConfig(sound) {
        if (!(sound instanceof PlaylistSound)) {
            throw new TypeError("Expected PlaylistSound document");
        }
        return Flags.getLoopConfig(sound);
    }

    /**
     * Get the effective playback mode for a playlist
     * @param {Playlist} playlist - The playlist
     * @returns {Object} {crossfade: boolean, silence: boolean, loopPlaylist: boolean}
     * @example
     * const mode = api.getPlaybackMode(playlist);
     * if (mode.crossfade) console.log('Crossfade is active');
     */
    getPlaybackMode(playlist) {
        if (!(playlist instanceof Playlist)) {
            throw new TypeError("Expected Playlist document");
        }
        return Flags.getPlaybackMode(playlist);
    }

    /**
     * Updates the internal loop configuration for a sound.
     * @param {PlaylistSound} sound - The sound document to update.
     * @param {object} loopConfig - A complete, new loop configuration object.
     * @returns {Promise<PlaylistSound>} The updated sound document.
     * @example
     * const newLoop = {
     *   enabled: true,
     *   active: true,
     *   startFromBeginning: false,
     *   segments: [{ start: '00:10.000', end: '01:20.500', crossfadeMs: 1500, loopCount: 0 }]
     * };
     * await api.updateLoopConfig(sound, newLoop);
     */
    async updateLoopConfig(sound, loopConfig) {
        if (!(sound instanceof PlaylistSound)) {
            throw new TypeError("Expected PlaylistSound document");
        }
        return sound.setFlag('the-sound-of-silence', 'loopWithin', loopConfig);
    }

    // ============================================
    // Playback Control API
    // ============================================

    /**
     * Trigger a crossfade from the current sound to the next.
     * If no sound is currently playing in the playlist, this function
     * will throw an error. This is intended for skipping an active track.
     * @param {Playlist} playlist - The playlist document.
     * @param {PlaylistSound} [fromSound] - The sound to fade from. If not provided,
     * the API will automatically find the currently playing sound in the playlist.
     * @returns {Promise<void>}
     * @throws {Error} If no sound is currently playing to fade from.
     * @example
     * // Skip to next track with crossfade
     * await api.crossfadeToNext(playlist);
     */
    async crossfadeToNext(playlist, fromSound = null) {
        if (!(playlist instanceof Playlist)) {
            throw new TypeError("Expected Playlist document");
        }

        const current = fromSound || playlist.sounds.find(s => s.playing);
        if (!current) {
            throw new Error("No sound currently playing");
        }

        return performCrossfade(playlist, current);
    }

    /**
     * Start an internal loop for a sound
     * @param {PlaylistSound} sound - The sound to loop
     * @returns {void}
     * @example
     * api.startLoop(sound);
     */
    startLoop(sound) {
        if (!(sound instanceof PlaylistSound)) {
            throw new TypeError("Expected PlaylistSound document");
        }
        scheduleLoopWithin(sound);
    }

    /**
     * Stop an internal loop for a sound
     * @param {PlaylistSound} sound - The sound to stop looping
     * @param {Object} [options]
     * @param {boolean} [options.allowFadeOut=false] - Fade out instead of stopping immediately
     * @returns {void}
     * @example
     * api.stopLoop(sound, { allowFadeOut: true });
     */
    stopLoop(sound, options = {}) {
        if (!(sound instanceof PlaylistSound)) {
            throw new TypeError("Expected PlaylistSound document");
        }
        cancelLoopWithin(sound, options);
    }

    /**
     * Break out of current loop iteration and continue track
     * @param {PlaylistSound} sound - The sound to break loop for
     * @returns {void}
     * @example
     * api.breakLoop(sound);
     */
    breakLoop(sound) {
        if (!(sound instanceof PlaylistSound)) {
            throw new TypeError("Expected PlaylistSound document");
        }
        breakLoopWithin(sound);
    }

    /**
     * Plays a sound and applies the playlist's configured fade-in, with an optional override.
     * @param {PlaylistSound} sound - The sound to play.
     * @param {number} [overrideFadeInMs] - Optionally override the playlist's fade-in duration.
     * @returns {Promise<void>}
     * @example
     * const sound = api.findSounds('Dramatic Entrance')[0];
     * if (sound) await api.playSoundWithFadeIn(sound, 3000);
     */
    async playSoundWithFadeIn(sound, overrideFadeInMs) {
        if (!(sound instanceof PlaylistSound)) {
            throw new TypeError("Expected PlaylistSound document");
        }
        const playlist = sound.parent;

        // This temporary property will be detected by the applyFadeIn function.
        if (typeof overrideFadeInMs === 'number') {
            sound._sos_fadeInOverride = overrideFadeInMs;
        }

        await playlist.playSound(sound);
    }

    /**
     * Stops a sound using the playlist's configured fade-out duration, with an optional override.
     * @param {PlaylistSound} sound - The sound to stop.
     * @param {number} [overrideFadeOutMs] - Optionally override the playlist's fade-out duration.
     * @returns {Promise<void>}
     * @example
     * await api.stopSoundWithFadeOut(sound, 5000);
     */
    async stopSoundWithFadeOut(sound, overrideFadeOutMs) {
        if (!(sound instanceof PlaylistSound)) {
            throw new TypeError("Expected PlaylistSound document");
        }
        if (!sound.playing || !sound.sound) return;

        const fadeOut = overrideFadeOutMs ?? (Number(sound.parent.fade) || 0);

        // Clean up any active loopers on the sound.
        cancelLoopWithin(sound, { allowFadeOut: true });

        await fadeOutAndStop(sound.sound, fadeOut);

        // Ensure the document state is updated after the fade.
        if (sound.playing) {
            await sound.update({ playing: false, pausedTime: 0 });
        }
    }

    // ============================================
    // Audio Control API
    // ============================================

    /**
     * Apply an exponential fade to a sound
     * @param {Sound} sound - The Foundry Sound object
     * @param {number} targetVolume - Target volume (0-1)
     * @param {number} durationMs - Fade duration in milliseconds
     * @returns {void}
     * @example
     * // Fade to 50% over 2 seconds
     * api.fade(sound, 0.5, 2000);
     */
    fade(sound, targetVolume, durationMs) {
        if (!sound?.gain) {
            throw new TypeError("Expected valid Sound object");
        }
        if (typeof targetVolume !== 'number' || targetVolume < 0 || targetVolume > 1) {
            throw new RangeError("targetVolume must be between 0 and 1");
        }
        if (typeof durationMs !== 'number' || durationMs < 0) {
            throw new RangeError("durationMs must be non-negative");
        }

        advancedFade(sound, { targetVol: targetVolume, duration: durationMs });
    }

    /**
     * Crossfade between two sounds using equal-power curve
     * @param {Sound} soundOut - Sound to fade out
     * @param {Sound} soundIn - Sound to fade in
     * @param {number} durationMs - Crossfade duration
     * @returns {void}
     * @example
     * api.crossfade(oldSound, newSound, 1000);
     */
    crossfade(soundOut, soundIn, durationMs) {
        if (!soundOut?.gain || !soundIn?.gain) {
            throw new TypeError("Expected valid Sound objects");
        }
        equalPowerCrossfade(soundOut, soundIn, durationMs);
    }

    // ============================================
    // State Query API
    // ============================================

    /**
     * Check if a sound has an active internal loop
     * @param {PlaylistSound} sound - The sound to check
     * @returns {boolean}
     */
    isLooping(sound) {
        if (!(sound instanceof PlaylistSound)) {
            throw new TypeError("Expected PlaylistSound document");
        }
        return State.hasActiveLooper(sound);
    }

    /**
     * Checks if a crossfade is currently scheduled for the given playlist.
     * @param {Playlist} playlist - The playlist to check.
     * @returns {boolean} True if a crossfade timer is armed.
     */
    isCrossfadeScheduled(playlist) {
        if (!(playlist instanceof Playlist)) {
            throw new TypeError("Expected Playlist document");
        }
        return State.hasCrossfadeTimer(playlist);
    }

    /**
     * Checks if a silent gap is currently playing in a playlist.
     * @param {Playlist} playlist - The playlist to check.
     * @returns {boolean} True if a silent gap is active.
     */
    isSilenceActive(playlist) {
        if (!(playlist instanceof Playlist)) {
            throw new TypeError("Expected Playlist document");
        }
        return State.hasSilenceState(playlist);
    }

    /**
     * Gets the currently active loop segment for a sound, if any.
     * @param {PlaylistSound} sound - The sound document.
     * @returns {object|null} The active segment object or null if not looping.
     */
    getCurrentLoopSegment(sound) {
        if (!(sound instanceof PlaylistSound)) {
            throw new TypeError("Expected PlaylistSound document");
        }
        return State.getActiveLooper(sound)?.activeLoopSegment ?? null;
    }

    /**
     * Get complete status of all features for a playlist
     * @param {Playlist} playlist - The playlist to inspect
     * @returns {Object} Detailed state snapshot
     */
    inspectPlaylist(playlist) {
        if (!(playlist instanceof Playlist)) {
            throw new TypeError("Expected Playlist document");
        }
        return State.inspectPlaylist(playlist);
    }

    /**
     * Get a global summary of all module activity
     * @returns {Object} Summary across all playlists
     */
    inspectAll() {
        return State.inspectAll();
    }

    // ============================================
    // Utility API
    // ============================================

    /**
     * Clean up all state for a playlist
     * @param {Playlist} playlist - The playlist to clean
     * @param {Object} [options] - Cleanup options
     * @param {boolean} [options.cleanSilence=true] - Cancel silent gaps
     * @param {boolean} [options.cleanCrossfade=true] - Cancel crossfades
     * @param {boolean} [options.cleanLoopers=true] - Cancel loopers
     * @param {boolean} [options.allowFadeOut=false] - Allow fade out
     * @returns {Promise<void>}
     * @example
     * await api.cleanup(playlist, { allowFadeOut: true });
     */
    async cleanup(playlist, options = {}) {
        if (!(playlist instanceof Playlist)) {
            throw new TypeError("Expected Playlist document");
        }
        return cleanupPlaylistState(playlist, options);
    }

    // ============================================
    // Hook Registration API
    // ============================================

    /**
     * Register a callback for module events
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     * @returns {number} Hook ID for removal
     * @example
     * const hookId = api.on('crossfadeStart', (playlist, fromSound, toSound) => {
     *   console.log('Crossfade started!');
     * });
     * 
     * // Later, to remove:
     * api.off(hookId);
     */
    on(event, callback) {
        const validEvents = [
            'crossfadeStart',
            'crossfadeComplete',
            'loopStart',
            'loopIteration',
            'loopEnd',
            'silenceStart',
            'silenceEnd'
        ];

        if (!validEvents.includes(event)) {
            throw new Error(`Unknown event: ${event}. Valid events: ${validEvents.join(', ')}`);
        }

        return Hooks.on(`the-sound-of-silence.${event}`, callback);
    }

    /**
     * Remove a registered callback
     * @param {number} hookId - Hook ID returned from on()
     * @example
     * api.off(hookId);
     */
    off(hookId) {
        Hooks.off(hookId);
    }

    // ============================================
    // Extended Utility API
    // ============================================

    /**
     * Get all currently looping sounds across all playlists
     * @returns {Array<{sound: PlaylistSound, playlist: Playlist, looper: LoopingSound}>}
     * @example
     * const loopingSounds = api.getAllLoopingSounds();
     * loopingSounds.forEach(({sound, playlist}) => {
     *   console.log(`${sound.name} in ${playlist.name}`);
     * });
     */
    getAllLoopingSounds() {
        const result = [];
        for (const playlist of game.playlists) {
            for (const sound of playlist.sounds) {
                if (State.hasActiveLooper(sound)) {
                    result.push({
                        sound: sound,
                        playlist: playlist,
                        looper: State.getActiveLooper(sound)
                    });
                }
            }
        }
        return result;
    }

    /**
     * Pause all active loopers in a playlist
     * @param {Playlist} playlist - The playlist whose loopers should be paused
     * @returns {number} Number of loopers paused
     * @example
     * const paused = api.pauseAllLoopers(playlist);
     * console.log(`Paused ${paused} loopers`);
     */
    pauseAllLoopers(playlist) {
        if (!(playlist instanceof Playlist)) {
            throw new TypeError("Expected Playlist document");
        }

        let count = 0;
        for (const sound of playlist.sounds) {
            if (State.hasActiveLooper(sound)) {
                const looper = State.getActiveLooper(sound);
                if (looper && !looper.isDestroyed) {
                    looper.pause();
                    count++;
                }
            }
        }
        return count;
    }

    /**
     * Resume all paused loopers in a playlist
     * @param {Playlist} playlist - The playlist whose loopers should be resumed
     * @returns {number} Number of loopers resumed
     * @example
     * const resumed = api.resumeAllLoopers(playlist);
     * console.log(`Resumed ${resumed} loopers`);
     */
    resumeAllLoopers(playlist) {
        if (!(playlist instanceof Playlist)) {
            throw new TypeError("Expected Playlist document");
        }

        let count = 0;
        for (const sound of playlist.sounds) {
            if (State.hasActiveLooper(sound)) {
                const looper = State.getActiveLooper(sound);
                if (looper && !looper.isDestroyed) {
                    looper.resume();
                    count++;
                }
            }
        }
        return count;
    }

    /**
     * Get all playlists with active features
     * @returns {Array<{playlist: Playlist, features: Object}>}
     * @example
     * const active = api.getActivePlaylists();
     * active.forEach(({playlist, features}) => {
     *   console.log(playlist.name, features);
     * });
     */
    getActivePlaylists() {
        const result = [];
        for (const playlist of game.playlists) {
            const inspection = State.inspectPlaylist(playlist);
            const hasFeatures = inspection.features.silence ||
                inspection.features.crossfade ||
                inspection.features.loops;
            if (hasFeatures) {
                result.push({
                    playlist: playlist,
                    features: inspection.features
                });
            }
        }
        return result;
    }

    /**
     * Enable a feature on a playlist
     * @param {Playlist} playlist - The playlist to modify
     * @param {'crossfade'|'silence'|'loopPlaylist'} feature - Feature to enable
     * @returns {Promise<Playlist>}
     * @example
     * await api.enableFeature(playlist, 'crossfade');
     */
    async enableFeature(playlist, feature) {
        if (!(playlist instanceof Playlist)) {
            throw new TypeError("Expected Playlist document");
        }

        const validFeatures = ['crossfade', 'silence', 'loopPlaylist'];
        if (!validFeatures.includes(feature)) {
            throw new Error(`Invalid feature: ${feature}. Valid: ${validFeatures.join(', ')}`);
        }

        const updates = {};

        if (feature === 'crossfade') {
            updates.crossfade = true;
            updates.silenceEnabled = false; // Crossfade overrides silence
        } else if (feature === 'silence') {
            updates.silenceEnabled = true;
            updates.crossfade = false; // Silence can't coexist with crossfade
        } else if (feature === 'loopPlaylist') {
            updates.loopPlaylist = true;
        }

        return this.updatePlaylistConfig(playlist, updates);
    }

    /**
     * Disable a feature on a playlist
     * @param {Playlist} playlist - The playlist to modify
     * @param {'crossfade'|'silence'|'loopPlaylist'} feature - Feature to disable
     * @returns {Promise<Playlist>}
     * @example
     * await api.disableFeature(playlist, 'crossfade');
     */
    async disableFeature(playlist, feature) {
        if (!(playlist instanceof Playlist)) {
            throw new TypeError("Expected Playlist document");
        }

        const validFeatures = ['crossfade', 'silence', 'loopPlaylist'];
        if (!validFeatures.includes(feature)) {
            throw new Error(`Invalid feature: ${feature}. Valid: ${validFeatures.join(', ')}`);
        }

        const updates = {};

        if (feature === 'crossfade') {
            updates.crossfade = false;
        } else if (feature === 'silence') {
            updates.silenceEnabled = false;
        } else if (feature === 'loopPlaylist') {
            updates.loopPlaylist = false;
        }

        return this.updatePlaylistConfig(playlist, updates);
    }

    /**
     * Get the active looper instance for a sound (advanced usage)
     * @param {PlaylistSound} sound - The sound to check
     * @returns {LoopingSound|null}
     * @example
     * const looper = api.getLooper(sound);
     * if (looper) {
     *   console.log('Active segment:', looper.activeLoopSegment);
     *   console.log('Loops completed:', looper.loopsCompleted);
     * }
     */
    getLooper(sound) {
        if (!(sound instanceof PlaylistSound)) {
            throw new TypeError("Expected PlaylistSound document");
        }
        return State.getActiveLooper(sound);
    }

    /**
     * Find sounds by name across all playlists
     * @param {string} name - Name to search for (partial match)
     * @returns {Array<PlaylistSound>}
     * @example
     * const sounds = api.findSounds('battle');
     * sounds.forEach(s => console.log(s.name));
     */
    findSounds(name) {
        if (typeof name !== 'string') {
            throw new TypeError("Expected string for name parameter");
        }

        const results = [];
        const searchTerm = name.toLowerCase();

        for (const playlist of game.playlists) {
            for (const sound of playlist.sounds) {
                if (sound.name.toLowerCase().includes(searchTerm)) {
                    results.push(sound);
                }
            }
        }

        return results;
    }

    /**
   * Get performance metrics for the module
   * @returns {Object} Performance data including uptime, crossfades, loops, and silence stats
   * @example
   * const metrics = api.getMetrics();
   * console.log(`Uptime: ${metrics.uptime.formatted}`);
   * console.log(`Total crossfades: ${metrics.crossfades.total}`);
   * console.log(`Average crossfade: ${metrics.crossfades.averageDuration}ms`);
   */
    getMetrics() {
        return State.getMetrics();
    }

    /**
     * Reset all performance metrics
     * @example
     * api.resetMetrics();
     * console.log('Metrics reset!');
     */
    resetMetrics() {
        State.resetMetrics();
    }
}

// Export singleton instance
export const API = new SoundOfSilenceAPI();