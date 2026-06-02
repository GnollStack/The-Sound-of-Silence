// api.js
/**
 * @file api.js
 * @description Public API for The Sound of Silence module.
 * All external integrations (macros, other modules) should use this interface.
 * 
 * Access via: game.modules.get('the-sound-of-silence').api
 */

import { Flags } from "./flag-service.js";
import { PlaybackClock } from "./playback-clock.js";
import { advancedFade, equalPowerCrossfade, fadeOutAndStop } from "./audio-fader.js";
import { scheduleCrossfade, performCrossfade, cancelCrossfade } from "./cross-fade.js";
import { scheduleLoopWithin, cancelLoopWithin, breakLoopWithin } from "./internal-loop.js";
import {
    startSoundscape,
    stopSoundscape,
    isSoundscapeActive,
    handleSoundscapeProceduralFire,
    isSoundscapeProceduralSyncEnabled,
} from "./procedural-ambience.js";
import { Silence } from "./silence.js";
import { createSoundOfSilenceDiagnostics } from "./diagnostics.js";
import { toSec, formatTime, info, debug, getSequenceSnapshot, MODULE_ID } from "./utils.js";
import { State, cleanupPlaylistState } from "./state-manager.js";
import { Integrations } from "./integrations.js";

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

        /**
         * Safe MCP-facing diagnostics surface.
         * @type {{version: number, actions: object, getAvailability: Function}}
         */
        this.diagnostics = createSoundOfSilenceDiagnostics(this);
    }

    /**
     * Initialize the API. Called automatically by the module.
     * @private
     */
    _initialize() {
        if (this._initialized) return;
        this._initialized = true;

        info("[API] Initialized. Access via game.modules.get('the-sound-of-silence').api");
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

    // ============================================
    // Soundscape Mode API
    // ============================================

    /**
     * Start the procedural ambience engine for a playlist. Normally triggered
     * automatically by `playlist.playAll()` when `soundscapeMode=true`, but
     * exposed here for macros that want to start it on demand.
     * @param {Playlist} playlist
     * @returns {Promise<void>}
     */
    async startSoundscape(playlist) {
        if (!(playlist instanceof Playlist)) {
            throw new TypeError("Expected Playlist document");
        }
        await startSoundscape(playlist);
    }

    /**
     * Stop the procedural ambience engine for a playlist.
     * @param {Playlist} playlist
     * @param {{stopBeds?: boolean}} [options] - When true (default), bed tracks are stopped too.
     * @returns {void}
     */
    stopSoundscape(playlist, options = {}) {
        if (!(playlist instanceof Playlist)) {
            throw new TypeError("Expected Playlist document");
        }
        stopSoundscape(playlist, options);
    }

    /**
     * Check whether a soundscape engine is currently live for a playlist.
     * @param {Playlist} playlist
     * @returns {boolean}
     */
    isSoundscapeActive(playlist) {
        if (!(playlist instanceof Playlist)) {
            throw new TypeError("Expected Playlist document");
        }
        return isSoundscapeActive(playlist);
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
        cancelLoopWithin(sound, { restorePlaybackHandlers: false });

        await fadeOutAndStop(sound.sound, fadeOut);

        // Ensure the document state is updated after the fade.
        if (sound.playing) {
            await sound.update({ playing: false, pausedTime: null });
        }
    }

    // ============================================
    // Audio Control API
    // ============================================

    /**
     * Apply the configured fade curve to a sound
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
        const integrations = Integrations.diagnostics();
        const isGM = Boolean(game.user?.isGM);
        const activeGMs = game.users ? game.users.filter(u => u.isGM && u.active) : [];
        const authorizedGM = isGM && activeGMs[0]?.id === game.user?.id;

        return {
            ...State.inspectAll(),
            debug: {
                enabled: Boolean(game.settings?.get(this.ID, "debug")),
                currentlyPlayingTimestamps: Boolean(game.settings?.get(this.ID, "debugCurrentlyPlayingTimestamps")),
                isGM,
                authorizedGM,
                roleLabel: isGM ? "GM" : "Player",
                authorityLabel: authorizedGM ? "Primary GM" : (isGM ? "Secondary GM" : "Not GM")
            },
            integrations
        };
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

        const hookName = `the-sound-of-silence.${event}`;
        const hookId = Hooks.on(hookName, callback);
        return { hookName, hookId };
    }

    /**
     * Remove a registered callback
     * @param {Object|number} hook - Hook object returned from on(), or legacy hook ID
     * @param {string} [hook.hookName] - The full hook name
     * @param {number} [hook.hookId] - The hook ID
     * @example
     * const hook = api.on('crossfadeStart', cb);
     * api.off(hook);
     */
    off(hook) {
        if (typeof hook === 'object' && hook.hookName && hook.hookId != null) {
            Hooks.off(hook.hookName, hook.hookId);
        } else if (typeof hook === 'number') {
            // Legacy fallback — caller must have tracked the name themselves.
            // Can't unregister without the hook name, so warn.
            console.warn(`[${this.ID}] api.off() called with just a number. Use the object returned by api.on() instead.`);
        }
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
    // ============================================
    // Remote Diagnostics API
    // ============================================

    /**
     * Gather a complete diagnostic snapshot of this client's audio state.
     * Extends inspectAll() with per-sound gain/fade data and AudioContext states.
     * @returns {Object} Full diagnostic payload for this client
     * @private
     */
    _getCoreAudioVolumes() {
        const keys = [
            "globalPlaylistVolume",
            "globalMusicVolume",
            "globalAmbientVolume",
            "globalInterfaceVolume",
        ];
        const volumes = {};
        for (const key of keys) {
            try {
                const value = game.settings?.get("core", key);
                if (Number.isFinite(Number(value))) volumes[key] = Number(value);
            } catch (_) { }
        }
        return volumes;
    }

    _getClientInstanceId() {
        if (!this._clientInstanceId) {
            this._clientInstanceId = foundry.utils?.randomID?.(16) ?? String(Date.now());
        }
        return this._clientInstanceId;
    }

    _getSocketId() {
        return game.socket?.id ?? game.socket?.socket?.id ?? null;
    }

    _isDiagnosticsRequestIdValid(requestId) {
        return typeof requestId === "string" &&
            /^[A-Za-z0-9_-]{8,128}$/.test(requestId.trim());
    }

    _isRemoteDiagnosticsGateOpen() {
        try {
            return Boolean(game.settings?.get(this.ID, "debug")) &&
                Boolean(game.settings?.get(this.ID, "enableMcpDiagnostics"));
        } catch (_) {
            return false;
        }
    }

    _resolveActiveGMSocketSender(senderId) {
        if (typeof senderId !== "string" || !senderId.trim()) return null;
        const sender = game.users?.get?.(senderId.trim());
        if (!sender?.isGM || sender.active === false) return null;
        return sender;
    }

    _getAudioPreflight() {
        const audio = game.audio ?? null;
        const contexts = {};
        for (const name of ["music", "environment", "interface"]) {
            const ctx = audio?.[name];
            contexts[name] = {
                available: Boolean(ctx),
                state: typeof ctx?.state === "string" ? ctx.state : null,
                sampleRate: Number.isFinite(Number(ctx?.sampleRate)) ? Number(ctx.sampleRate) : null,
                currentTime: Number.isFinite(Number(ctx?.currentTime)) ? Number(ctx.currentTime) : null,
            };
        }

        return {
            available: Boolean(audio),
            locked: typeof audio?.locked === "boolean" ? audio.locked : null,
            unlocked: typeof audio?.unlocked === "boolean" ? audio.unlocked : null,
            contexts,
        };
    }

    _getPlaylistDocumentSnapshots({ playlistIds = null } = {}) {
        const ids = Array.isArray(playlistIds) ? new Set(playlistIds.map((id) => String(id))) : null;
        if (ids && ids.size === 0) return [];

        return Array.from(game.playlists ?? [])
            .filter((playlist) => !ids || ids.has(String(playlist.id)))
            .map((playlist) => ({
                id: playlist.id,
                name: playlist.name,
                mode: playlist.mode,
                playing: Boolean(playlist.playing),
                sounds: Array.from(playlist.sounds ?? []).map((sound) => ({
                    id: sound.id,
                    name: sound.name,
                    playing: Boolean(sound.playing),
                    pausedTime: Number.isFinite(Number(sound.pausedTime)) ? Number(sound.pausedTime) : null,
                    repeat: Boolean(sound.repeat),
                    volume: Number.isFinite(Number(sound.volume)) ? Number(sound.volume) : null,
                    hasMedia: Boolean(sound.sound),
                    mediaPlaying: Boolean(sound.sound?.playing),
                    isSilenceGap: Boolean(Flags.getSoundFlag(sound, "isSilenceGap")),
                    isProcedural: Boolean(Flags.getSoundFlag(sound, "isProcedural")),
                    hasLoopWithin: Boolean(Flags.getLoopConfig(sound)?.enabled),
                })),
            }));
    }

    _gatherLocalDiagnostics(options = {}) {
        const base = this.inspectAll();

        // Per-playing-sound audio state — the critical data inspectAll() doesn't include
        const playingSounds = [];
        let soundDocumentsWithMedia = 0;
        let playingMediaObjects = 0;
        for (const playlist of game.playlists) {
            for (const ps of playlist.sounds) {
                if (ps.sound) soundDocumentsWithMedia += 1;
                if (ps.sound?.playing) playingMediaObjects += 1;
                if (!ps.sound?.playing) continue;
                const sound = ps.sound;
                playingSounds.push({
                    playlistName: playlist.name,
                    playlistId: playlist.id,
                    soundName: ps.name,
                    soundId: ps.id,
                    playing: sound.playing,
                    gainValue: sound.gain?.value ?? null,
                    volume: sound.volume,
                    isFading: State.isSoundFading(sound),
                    currentTime: sound.currentTime,
                    duration: sound.duration,
                    currentTimeFinite: Number.isFinite(Number(sound.currentTime)),
                    durationFinite: Number.isFinite(Number(sound.duration)) && Number(sound.duration) > 0,
                    contextState: sound.context?.state ?? "unknown",
                    playbackClock: PlaybackClock.get(playlist)?.soundId === ps.id
                        ? PlaybackClock.summarizePlaylist(playlist)
                        : null,
                });
            }
        }

        // AudioContext states for all three Foundry channels
        const audioContexts = {};
        for (const name of ["music", "environment", "interface"]) {
            const ctx = game.audio?.[name];
            audioContexts[name] = ctx ? ctx.state : "unavailable";
        }
        const coreAudioVolumes = this._getCoreAudioVolumes();

        const playbackClocks = [];
        for (const playlist of game.playlists) {
            const clock = PlaybackClock.summarizePlaylist(playlist);
            if (clock) {
                playbackClocks.push({
                    playlistName: playlist.name,
                    playlistId: playlist.id,
                    ...clock,
                });
            }
        }

        // Soundscape engine state per playlist — procedural fires are client-local
        // so each client's snapshot will differ, which is the whole point.
        const soundscapes = [];
        for (const playlist of game.playlists) {
            const engine = State.getSoundscapeEngine(playlist);
            if (!engine) continue;
            soundscapes.push({
                playlistName: playlist.name,
                playlistId: playlist.id,
                ...engine.getDiagnostics(),
            });
        }

        const personalPlaylistVolumeEnabled = Flags.isPersonalAudioMixEnabled();
        const personalPlaylistVolumes = Flags.getPersonalPlaylistVolumes();
        const personalTrackVolumes = Flags.getPersonalTrackVolumes();
        const audio = {
            ...this._getAudioPreflight(),
            soundDocumentsWithMedia,
            playingMediaObjects,
        };

        return {
            ...base,
            playingSounds,
            audio,
            playlistDocuments: this._getPlaylistDocumentSnapshots({ playlistIds: options.playlistIds }),
            audioContexts,
            coreAudioVolumes,
            playbackClocks,
            soundscapes,
            soundscapeProceduralSyncEnabled: isSoundscapeProceduralSyncEnabled(),
            personalAudioMix: {
                enabled: personalPlaylistVolumeEnabled,
                playlistVolumes: personalPlaylistVolumes,
                trackVolumes: personalTrackVolumes,
                trackOverrideCount: Object.keys(personalTrackVolumes).length,
            },
            personalPlaylistVolume: {
                enabled: personalPlaylistVolumeEnabled,
                volumes: personalPlaylistVolumes,
            },
            sequences: getSequenceSnapshot(),
            client: {
                userId: game.user.id,
                userName: game.user.name,
                isGM: game.user.isGM,
                clientInstanceId: this._getClientInstanceId(),
                socketId: this._getSocketId(),
                timestamp: Date.now(),
            },
        };
    }

    _normalizeClientDiagnosticsOptions({ timeoutMs = 3000, includeSelf = true, playlistIds = null } = {}) {
        const timeout = Number(timeoutMs);
        const normalizedPlaylistIds = Array.isArray(playlistIds)
            ? playlistIds.map((id) => String(id)).filter(Boolean)
            : null;
        return {
            timeoutMs: Number.isFinite(timeout)
                ? Math.max(500, Math.min(Math.floor(timeout), 10000))
                : 3000,
            includeSelf: includeSelf !== false,
            playlistIds: normalizedPlaylistIds,
        };
    }

    _filterCollectedDiagnostics(diagnostics, playlistIds = null) {
        if (!diagnostics || !Array.isArray(playlistIds)) return diagnostics;

        const ids = new Set(playlistIds.map((id) => String(id)));
        const filterPlaylists = (playlists) => {
            if (!Array.isArray(playlists)) return playlists;
            if (ids.size === 0) return [];
            return playlists.filter((playlist) => ids.has(String(playlist?.id)));
        };
        const filterPlaylistVolumeMap = (volumes) => {
            if (!volumes || typeof volumes !== "object") return volumes;
            if (ids.size === 0) return {};
            return Object.fromEntries(Object.entries(volumes)
                .filter(([playlistId]) => ids.has(String(playlistId))));
        };
        const filterTrackVolumeMap = (volumes) => {
            if (!volumes || typeof volumes !== "object") return volumes;
            if (ids.size === 0) return {};
            return Object.fromEntries(Object.entries(volumes)
                .filter(([key]) => {
                    const match = String(key).match(/^Playlist\.([^.]+)\./);
                    return match ? ids.has(match[1]) : false;
                }));
        };

        const filteredPlaylistDocuments = filterPlaylists(diagnostics.playlistDocuments);
        const filtered = {
            ...diagnostics,
            playlistDocuments: filteredPlaylistDocuments,
        };

        if (diagnostics.documents && Array.isArray(diagnostics.documents.playlists)) {
            filtered.documents = {
                ...diagnostics.documents,
                playlists: filterPlaylists(diagnostics.documents.playlists),
            };
        }

        if (diagnostics.personalAudioMix) {
            const trackVolumes = filterTrackVolumeMap(diagnostics.personalAudioMix.trackVolumes);
            filtered.personalAudioMix = {
                ...diagnostics.personalAudioMix,
                playlistVolumes: filterPlaylistVolumeMap(diagnostics.personalAudioMix.playlistVolumes),
                trackVolumes,
                trackOverrideCount: trackVolumes && typeof trackVolumes === "object"
                    ? Object.keys(trackVolumes).length
                    : diagnostics.personalAudioMix.trackOverrideCount,
            };
        }

        if (diagnostics.personalPlaylistVolume) {
            filtered.personalPlaylistVolume = {
                ...diagnostics.personalPlaylistVolume,
                volumes: filterPlaylistVolumeMap(diagnostics.personalPlaylistVolume.volumes),
            };
        }

        if (Array.isArray(diagnostics.soundscapes)) {
            filtered.soundscapes = ids.size === 0
                ? []
                : diagnostics.soundscapes.filter((snapshot) => ids.has(String(snapshot?.playlistId)));
        }

        if (diagnostics.sequences && typeof diagnostics.sequences === "object") {
            const allowedSequenceKeys = new Set();
            for (const playlistId of ids) allowedSequenceKeys.add(`pl:${playlistId}`);
            for (const playlist of filteredPlaylistDocuments ?? []) {
                for (const sound of playlist.sounds ?? []) {
                    if (sound?.id) allowedSequenceKeys.add(`snd:${sound.id}`);
                }
            }
            filtered.sequences = Object.fromEntries(Object.entries(diagnostics.sequences)
                .filter(([key]) => allowedSequenceKeys.has(String(key))));
        }

        return filtered;
    }

    _summarizeCollectedClients(clients) {
        return clients.map((diagnostics) => ({
            userId: diagnostics.client?.userId ?? null,
            userName: diagnostics.client?.userName ?? null,
            isGM: Boolean(diagnostics.client?.isGM),
            clientInstanceId: diagnostics.client?.clientInstanceId ?? null,
            socketId: diagnostics.client?.socketId ?? null,
            audioLocked: diagnostics.audio?.locked ?? null,
            runningAudioContexts: Object.values(diagnostics.audio?.contexts ?? {})
                .filter((context) => context?.state === "running").length,
            playingMediaObjects: Number(diagnostics.audio?.playingMediaObjects ?? diagnostics.playingSounds?.length ?? 0),
            playingSounds: Number(diagnostics.playingSounds?.length ?? 0),
        }));
    }

    /**
     * Collect diagnostic snapshots from connected clients and return JSON.
     * GM-only. Sockets are used for diagnostics collection only.
     * @param {{timeoutMs?: number, includeSelf?: boolean}} [options]
     * @returns {Promise<Object>} JSON-safe collection result
     */
    async collectClientDiagnostics(options = {}) {
        if (!game.user.isGM) {
            throw new Error("Only the GM can collect client diagnostics.");
        }

        const { timeoutMs, includeSelf, playlistIds } = this._normalizeClientDiagnosticsOptions(options);
        const requestId = foundry.utils.randomID();
        const senderClientId = this._getClientInstanceId();
        const clients = [];
        const seenClients = new Set();

        const addDiagnostics = (diagnostics) => {
            if (!diagnostics?.client) return;
            const filteredDiagnostics = this._filterCollectedDiagnostics(diagnostics, playlistIds);
            const key = filteredDiagnostics.client.clientInstanceId ||
                filteredDiagnostics.client.socketId ||
                `${filteredDiagnostics.client.userId ?? "unknown"}:${filteredDiagnostics.client.timestamp ?? clients.length}`;
            if (seenClients.has(key)) return;
            seenClients.add(key);
            clients.push(filteredDiagnostics);
        };

        if (includeSelf) addDiagnostics(this._gatherLocalDiagnostics({ playlistIds }));

        const handler = (data) => {
            if (data?.action !== "diagnostics-response" || data.requestId !== requestId) return;
            addDiagnostics(data.diagnostics);
        };

        game.socket.on(`module.${this.ID}`, handler);
        game.socket.emit(`module.${this.ID}`, {
            action: "diagnostics-request",
            requestId,
            senderId: game.user.id,
            senderClientId,
            options: {
                playlistIds,
            },
        });

        debug(`[Remote Diagnostics] Request ${requestId} sent, waiting ${timeoutMs}ms for responses...`);

        try {
            await new Promise(r => setTimeout(r, timeoutMs));
        } finally {
            game.socket.off(`module.${this.ID}`, handler);
        }

        const activeUsers = Array.from(game.users ?? []).filter((user) => user.active).map((user) => ({
            id: user.id,
            name: user.name,
            isGM: Boolean(user.isGM),
        }));
        const activeNonGmUsers = activeUsers.filter((user) => !user.isGM);
        const respondedUserIds = new Set(clients.map((client) => client.client?.userId).filter(Boolean));
        const missingActiveUsers = activeUsers.filter((user) => !respondedUserIds.has(user.id));

        debug(`[Remote Diagnostics] Received ${clients.length} response(s) for ${requestId}`);

        return {
            success: true,
            requestId,
            timeoutMs,
            includeSelf,
            playlistIds,
            responded: clients.length,
            activeUsers,
            activeNonGmUsers,
            missingActiveUsers,
            clientSummary: this._summarizeCollectedClients(clients),
            clients,
        };
    }

    /**
     * Request diagnostic snapshots from all connected clients.
     * GM-only. Broadcasts a socket request, waits 3 seconds for responses,
     * then renders a dialog comparing all clients side-by-side.
     * @returns {Promise<void>}
     * @example
     * game.modules.get('the-sound-of-silence').api.requestClientDiagnostics()
     */
    async requestClientDiagnostics() {
        if (!game.user.isGM) {
            ui.notifications.warn("Only the GM can request client diagnostics.");
            return;
        }

        const result = await this.collectClientDiagnostics({ timeoutMs: 3000, includeSelf: true });
        this._renderRemoteDiagnostics(result.clients);
        return result;
    }

    /**
     * Handle incoming socket messages for the module.
     * Currently supports diagnostics-request for remote state queries.
     * @param {Object} data - The socket message payload
     * @private
     */
    _handleSocketMessage(data) {
        if (data.action === "soundscape-procedural-fire") {
            if (data.senderSocketId && data.senderSocketId === this._getSocketId()) {
                return;
            }
            handleSoundscapeProceduralFire(data).catch((err) => {
                debug("[Soundscape Sync] Failed to process procedural fire:", err?.message);
            });
            return;
        }

        if (data.action === "diagnostics-client-setting-request") {
            this._handleDiagnosticsClientSettingRequest(data).catch((err) => {
                debug("[Remote Diagnostics] Failed to apply client setting request:", err?.message);
            });
            return;
        }

        if (data.action === "diagnostics-request") {
            if (data.senderClientId && data.senderClientId === this._getClientInstanceId()) {
                return;
            }
            if (!this._isDiagnosticsRequestIdValid(data.requestId)) return;
            if (!this._isRemoteDiagnosticsGateOpen()) return;
            if (!this._resolveActiveGMSocketSender(data.senderId)) return;

            debug("[Remote Diagnostics] Received request, sending local state...");
            game.socket.emit(`module.${this.ID}`, {
                action: "diagnostics-response",
                requestId: data.requestId,
                diagnostics: this._gatherLocalDiagnostics(data.options ?? {}),
            });
        }
    }

    async _handleDiagnosticsClientSettingRequest(data) {
        const sender = game.users?.get?.(data.senderUserId);
        const requestId = data.requestId;
        const targetUserId = data.targetUserId ? String(data.targetUserId) : null;
        if (!sender?.isGM || sender.active === false) return;
        if (targetUserId && targetUserId !== String(game.user?.id)) return;

        const diagnosticsEnabled = Boolean(game.settings?.get(this.ID, "enableMcpDiagnostics"));
        const allowed = data.key === "soundscapeProceduralSyncEnabled" && typeof data.value === "boolean";
        let success = false;
        let errorMessage = null;
        let value = null;

        try {
            if (!diagnosticsEnabled) {
                throw new Error("diagnostics automation gates are closed");
            }
            if (!allowed) {
                throw new Error("client setting request is not allowlisted");
            }
            await game.settings.set(this.ID, data.key, data.value);
            value = game.settings.get(this.ID, data.key);
            success = true;
        } catch (err) {
            errorMessage = err?.message ?? String(err);
        }

        game.socket?.emit(`module.${this.ID}`, {
            action: "diagnostics-client-setting-response",
            requestId,
            userId: game.user?.id ?? null,
            userName: game.user?.name ?? null,
            clientInstanceId: this._getClientInstanceId(),
            key: data.key ?? null,
            value,
            success,
            error: errorMessage,
        });
    }

    /**
     * Render the multi-client diagnostics dialog.
     * @param {Array<Object>} responses - Array of client diagnostic payloads
     * @private
     */
    async _renderRemoteDiagnostics(responses) {
        // Pre-process for template: add problem flags for visual indicators
        for (const client of responses) {
            for (const sound of client.playingSounds) {
                sound._gainZero = sound.gainValue !== null && sound.gainValue < 0.001 && !sound.isFading;
                sound._contextSuspended = sound.contextState !== "running";
                sound._invalidMediaTime = !sound.currentTimeFinite || !sound.durationFinite;
                // Round numeric values for display
                if (Number.isFinite(Number(sound.gainValue))) sound.gainValue = Math.round(sound.gainValue * 1000) / 1000;
                if (Number.isFinite(Number(sound.volume))) sound.volume = Math.round(sound.volume * 1000) / 1000;
                if (Number.isFinite(Number(sound.currentTime))) sound.currentTime = Math.round(sound.currentTime * 10) / 10;
                if (Number.isFinite(Number(sound.duration))) sound.duration = Math.round(sound.duration * 10) / 10;
            }
            client._anyContextSuspended = Object.values(client.audioContexts).some(s => s !== "running" && s !== "unavailable");
            client._contextEntries = Object.entries(client.audioContexts).map(([name, state]) => ({
                name,
                state,
                isOk: state === "running",
            }));
            client._coreAudioVolumeEntries = Object.entries(client.coreAudioVolumes || {}).map(([name, value]) => ({
                name,
                value: Math.round(Number(value) * 100),
                muted: Number(value) <= 0,
            }));
            client._playbackClockEntries = (client.playbackClocks || []).map((clock) => ({
                ...clock,
                startedAgo: Number.isFinite(Number(clock.startedAt))
                    ? Math.max(0, Math.round((Date.now() - Number(clock.startedAt)) / 1000))
                    : null,
                overdueSec: Number.isFinite(Number(clock.overdueMs))
                    ? Math.round(Number(clock.overdueMs) / 1000)
                    : 0,
            }));
            client._sequenceEntries = Object.entries(client.sequences || {}).map(([key, val]) => ({
                key,
                seq: val.seq,
                age: Math.round((Date.now() - val.timestamp) / 1000),
            }));
            const activePersonalPlaylistVolumes = client.personalAudioMix?.enabled
                ? (client.personalAudioMix?.playlistVolumes || client.personalPlaylistVolume?.volumes || {})
                : {};
            client._personalPlaylistVolumeEntries = Object.entries(activePersonalPlaylistVolumes)
                .map(([playlistId, value]) => ({
                    playlistId,
                    playlistName: game.playlists.get(playlistId)?.name ?? playlistId,
                    value: Math.round(Number(value) * 100),
                }))
                .filter((entry) => Number.isFinite(entry.value) && entry.value < 100);
            client._personalTrackVolumeCount = client.personalAudioMix?.enabled
                ? (Number(client.personalAudioMix?.trackOverrideCount ?? 0) || 0)
                : 0;
        }

        const html = await foundry.applications.handlebars.renderTemplate(
            `modules/${this.ID}/templates/remote-diagnostics.hbs`,
            { clients: responses, timestamp: new Date().toLocaleTimeString() }
        );

        await foundry.applications.api.DialogV2.prompt({
            window: {
                title: "Sound of Silence — Remote Diagnostics",
                resizable: true,
                contentClasses: ["sos-diagnostics-window", "sos-remote-diagnostics"],
            },
            position: { width: 700 },
            content: html,
            ok: {
                icon: "fas fa-times",
                label: "Close",
            },
            rejectClose: false,
        });
    }
}

// Export singleton instance
export const API = new SoundOfSilenceAPI();
