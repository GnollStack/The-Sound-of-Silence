// state-manager.js
/**
 * @file state-manager.js
 * @description Centralized runtime state management for all module features.
 * This manages TEMPORARY state (in-memory), not persistent configuration.
 * For persistent configuration, see flag-service.js
 */

import { debug, MODULE_ID, logFeature, LogSymbols } from "./utils.js";

/**
 * Manages all runtime state for the module.
 * State is stored in WeakMaps/WeakSets for automatic garbage collection.
 */
class StateManager {
    constructor() {

        /**
         * Tracks playlists that are currently executing an automatic crossfade.
         * @type {WeakSet<Playlist>}
         */
        this._crossfadingPlaylists = new WeakSet();

        // ============================================
        // Audio Control State
        // ============================================
        /**
         * Tracks scheduled end-of-track fade-out timers for sounds.
         * @type {WeakMap<PlaylistSound, AudioTimeout>}
         */
        this._endOfTrackFades = new WeakMap();

        // ============================================
        // Silence Feature State
        // ============================================
        /**
         * Tracks currently active silent gaps
         * @type {WeakMap<Playlist, {timer: AudioTimeout, gap: PlaylistSound, resolve: Function, cancelled: boolean, sourceSound: PlaylistSound}>}
         */
        this._silentGaps = new WeakMap();

        /**
         * Tracks silent gaps that were cancelled to prevent _onEnd logic
         * @type {WeakSet<PlaylistSound>}
         */
        this._cancelledGaps = new WeakSet();

        // ============================================
        // Crossfade Feature State
        // ============================================
        /**
         * Tracks scheduled crossfade timers
         * @type {WeakMap<Playlist, {timeout: AudioTimeout}>}
         */
        this._crossfadeTimers = new WeakMap();

        /**
         * Tracks pending play event listeners for crossfade scheduling
         * @type {WeakMap<Playlist, {sound: Sound, onPlay: Function}>}
         */
        this._playWaiters = new WeakMap();

        /**
         * Debounce flag to prevent multiple simultaneous crossfades on the same sound
         * @type {WeakSet<Sound>}
         */
        this._fadingSounds = new WeakSet();

        // ============================================
        // Loop Feature State
        // ============================================
        /**
         * Tracks active LoopingSound instances
         * @type {WeakMap<PlaylistSound, LoopingSound>}
         */
        this._activeLoopers = new WeakMap();

        // ============================================
        // Performance Metrics
        // ============================================
        /**
         * Performance tracking data
         * @type {Object}
         */
        this._metrics = {
            crossfades: {
                total: 0,
                durations: [], // Last 100 crossfade durations
                averageDuration: 0
            },
            loops: {
                totalIterations: 0,
                activeSessions: 0,
                completedSessions: 0
            },
            silence: {
                totalGaps: 0,
                totalDuration: 0,
                cancelled: 0
            },
            startTime: Date.now()
        };

        // ============================================
        // Playback Control State
        // ============================================
        /**
         * Tracks playlists that are currently in the process of stopping.
         * This helps prevent race conditions with async operations.
         * @type {WeakSet<Playlist>}
         */
        this._stoppingPlaylists = new WeakSet();

        // ============================================
        // Advanced Shuffle State
        // ============================================
        /**
         * Tracks shuffle state for advanced shuffle patterns
         * @type {WeakMap<Playlist, Object>}
         */
        this._shuffleStates = new WeakMap();
    }

    // ============================================
    // Performance Metrics Methods
    // ============================================

    /**
     * Record a crossfade event
     * @param {number} durationMs - Duration of the crossfade
     */
    recordCrossfade(durationMs) {
        this._metrics.crossfades.total++;
        this._metrics.crossfades.durations.push(durationMs);

        // Keep only last 100 for average calculation
        if (this._metrics.crossfades.durations.length > 100) {
            this._metrics.crossfades.durations.shift();
        }

        // Recalculate average
        const sum = this._metrics.crossfades.durations.reduce((a, b) => a + b, 0);
        this._metrics.crossfades.averageDuration = Math.round(sum / this._metrics.crossfades.durations.length);
    }

    /**
     * Record a loop iteration
     */
    recordLoopIteration() {
        this._metrics.loops.totalIterations++;
    }

    /**
     * Record a loop session start
     */
    recordLoopStart() {
        this._metrics.loops.activeSessions++;
    }

    /**
     * Record a loop session end
     */
    recordLoopEnd() {
        this._metrics.loops.activeSessions = Math.max(0, this._metrics.loops.activeSessions - 1);
        this._metrics.loops.completedSessions++;
    }

    /**
     * Record a silence gap
     * @param {number} durationMs - Duration of the gap
     * @param {boolean} cancelled - Whether it was cancelled
     */
    recordSilence(durationMs, cancelled = false) {
        this._metrics.silence.totalGaps++;
        if (!cancelled) {
            this._metrics.silence.totalDuration += durationMs;
        } else {
            this._metrics.silence.cancelled++;
        }
    }

    /**
     * Get performance metrics
     * @returns {Object} Performance data
     */
    getMetrics() {
        const uptime = Date.now() - this._metrics.startTime;
        const uptimeHours = (uptime / (1000 * 60 * 60)).toFixed(2);

        return {
            uptime: {
                ms: uptime,
                hours: parseFloat(uptimeHours),
                formatted: this._formatUptime(uptime)
            },
            crossfades: {
                total: this._metrics.crossfades.total,
                averageDuration: this._metrics.crossfades.averageDuration,
                recentDurations: this._metrics.crossfades.durations.slice(-10) // Last 10
            },
            loops: {
                totalIterations: this._metrics.loops.totalIterations,
                activeSessions: this._metrics.loops.activeSessions,
                completedSessions: this._metrics.loops.completedSessions
            },
            silence: {
                totalGaps: this._metrics.silence.totalGaps,
                totalDuration: this._metrics.silence.totalDuration,
                cancelled: this._metrics.silence.cancelled,
                averageDuration: this._metrics.silence.totalGaps > 0
                    ? Math.round(this._metrics.silence.totalDuration / (this._metrics.silence.totalGaps - this._metrics.silence.cancelled))
                    : 0
            }
        };
    }

    /**
     * Reset all metrics
     */
    resetMetrics() {
        this._metrics = {
            crossfades: {
                total: 0,
                durations: [],
                averageDuration: 0
            },
            loops: {
                totalIterations: 0,
                activeSessions: 0,
                completedSessions: 0
            },
            silence: {
                totalGaps: 0,
                totalDuration: 0,
                cancelled: 0
            },
            startTime: Date.now()
        };
    }

    /**
     * Format uptime into human-readable string
     * @private
     */
    _formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }


    // ============================================
    // Silence State Methods
    // ============================================

    /**
     * Get the current silent gap state for a playlist
     * @param {Playlist} playlist
     * @returns {Object|undefined} The silence state or undefined if none exists
     */
    getSilenceState(playlist) {
        return this._silentGaps.get(playlist);
    }

    /**
     * Set the silent gap state for a playlist
     * @param {Playlist} playlist
     * @param {Object} state - The state object containing {timer, gap, resolve, cancelled}
     */
    setSilenceState(playlist, state) {
        this._silentGaps.set(playlist, state);
        debug(`[State] Set silence state for "${playlist.name}"`);
    }

    /**
     * Clear the silent gap state for a playlist
     * @param {Playlist} playlist
     */
    clearSilenceState(playlist) {
        const had = this._silentGaps.has(playlist);
        this._silentGaps.delete(playlist);
        if (had) debug(`[State] Cleared silence state for "${playlist.name}"`);
    }

    /**
     * Check if a playlist has an active silent gap
     * @param {Playlist} playlist
     * @returns {boolean}
     */
    hasSilenceState(playlist) {
        return this._silentGaps.has(playlist);
    }

    /**
     * Mark a silent gap as cancelled to prevent its _onEnd handler from firing
     * @param {PlaylistSound} gap
     */
    markGapAsCancelled(gap) {
        this._cancelledGaps.add(gap);
        debug(`[State] Marked gap "${gap?.name}" as cancelled`);
    }

    /**
     * Check if a gap was cancelled
     * @param {PlaylistSound} gap
     * @returns {boolean}
     */
    isGapCancelled(gap) {
        return this._cancelledGaps.has(gap);
    }

    /**
     * Clear the cancelled marker for a gap
     * @param {PlaylistSound} gap
     */
    clearCancelledGap(gap) {
        this._cancelledGaps.delete(gap);
    }

    // ============================================
    // Crossfade State Methods
    // ============================================

    /**
     * Get the scheduled crossfade timer for a playlist
     * @param {Playlist} playlist
     * @returns {Object|undefined} The timer handle or undefined
     */
    getCrossfadeTimer(playlist) {
        return this._crossfadeTimers.get(playlist);
    }

    /**
     * Set a crossfade timer for a playlist
     * @param {Playlist} playlist
     * @param {Object} handle - The scheduled timer handle
     */
    setCrossfadeTimer(playlist, handle) {
        this._crossfadeTimers.set(playlist, handle);
        debug(`[State] Set crossfade timer for "${playlist.name}"`);
    }

    /**
     * Clear the crossfade timer for a playlist
     * @param {Playlist} playlist
     */
    clearCrossfadeTimer(playlist) {
        const had = this._crossfadeTimers.has(playlist);
        this._crossfadeTimers.delete(playlist);
        if (had) debug(`[State] Cleared crossfade timer for "${playlist.name}"`);
    }

    /**
     * Check if a playlist has a scheduled crossfade
     * @param {Playlist} playlist
     * @returns {boolean}
     */
    hasCrossfadeTimer(playlist) {
        return this._crossfadeTimers.has(playlist);
    }

    /**
     * Get the play waiter for a playlist (used when scheduling crossfades for paused sounds)
     * @param {Playlist} playlist
     * @returns {Object|undefined}
     */
    getPlayWaiter(playlist) {
        return this._playWaiters.get(playlist);
    }

    /**
     * Set a play waiter for a playlist
     * @param {Playlist} playlist
     * @param {Object} waiter - {sound: Sound, onPlay: Function}
     */
    setPlayWaiter(playlist, waiter) {
        this._emitStateChange()
        this._playWaiters.set(playlist, waiter);
        debug(`[State] Set play waiter for "${playlist.name}"`);
    }

    /**
     * Clear the play waiter for a playlist
     * @param {Playlist} playlist
     */
    clearPlayWaiter(playlist) {
        this._emitStateChange()
        this._playWaiters.delete(playlist);
    }

    /**
         * Mark a sound as currently fading (for debouncing)
         * Returns false if already fading (atomic check-and-set)
         * @param {Sound} sound
         * @returns {boolean} - true if successfully marked, false if already fading
         */
    markSoundAsFading(sound) {
        if (this._fadingSounds.has(sound)) {
            debug(`[State] Sound already marked as fading (debounce rejected)`);
            return false;
        }
        this._fadingSounds.add(sound);
        debug(`[State] Marked sound as fading (debounce active)`);
        return true;
    }

    /**
     * Check if a sound is currently fading
     * @param {Sound} sound
     * @returns {boolean}
     */
    isSoundFading(sound) {
        return this._fadingSounds.has(sound);
    }

    /**
     * Clear the fading marker for a sound
     * @param {Sound} sound
     */
    clearFadingSound(sound) {
        this._fadingSounds.delete(sound);
    }

    // ============================================
    // Loop State Methods
    // ============================================

    /**
     * Get the active LoopingSound instance for a sound
     * @param {PlaylistSound} sound
     * @returns {LoopingSound|undefined}
     */
    getActiveLooper(sound) {
        return this._activeLoopers.get(sound);
    }

    /**
     * Set the active LoopingSound instance for a sound
     * @param {PlaylistSound} sound
     * @param {LoopingSound} looper
     */
    setActiveLooper(sound, looper) {
        this._activeLoopers.set(sound, looper);
        debug(`[State] Set active looper for "${sound.name}"`);
    }

    /**
     * Clear the active looper for a sound
     * @param {PlaylistSound} sound
     */
    clearActiveLooper(sound) {
        const had = this._activeLoopers.has(sound);
        this._activeLoopers.delete(sound);
        if (had) debug(`[State] Cleared active looper for "${sound.name}"`);
    }

    /**
     * Check if a sound has an active looper
     * @param {PlaylistSound} sound
     * @returns {boolean}
     */
    hasActiveLooper(sound) {
        return this._activeLoopers.has(sound);
    }

    // ============================================
    // Coordinated Cleanup
    // ============================================

    /**
     * Clean up all module state for a playlist in the correct order.
     * This is the ONLY safe way to clean up state - it ensures proper sequencing.
     * 
     * @param {Playlist} playlist - The playlist to clean up
     * @param {Object} options - Cleanup options
     * @param {boolean} [options.cleanSilence=true] - Cancel silent gaps
     * @param {boolean} [options.cleanCrossfade=true] - Cancel pending crossfades
     * @param {boolean} [options.cleanLoopers=true] - Destroy loop instances
     * @param {PlaylistSound} [options.onlySound=null] - If provided, only clean this sound's looper
     * @param {boolean} [options.allowFadeOut=false] - Allow sounds to fade out naturally instead of stopping immediately
     * @returns {Promise<void>}
     */
    async cleanup(playlist, options = {}) {
        const {
            cleanSilence = true,
            cleanCrossfade = true,
            cleanLoopers = true,
            onlySound = null,
            allowFadeOut = false
        } = options;

        debug(`[State] Cleanup requested for "${playlist?.name}"`, options);
        if (!playlist) return;

        // 1. Clean Crossfade (no changes needed here)
        if (cleanCrossfade) {
            try {
                const timer = this.getCrossfadeTimer(playlist);
                if (timer?.timeout?.cancel) {
                    timer.timeout.cancel();
                } else if (timer?.cancel) {
                    timer.cancel();
                }
                this.clearCrossfadeTimer(playlist);

                const waiter = this.getPlayWaiter(playlist);
                if (waiter?.sound) {
                    try {
                        waiter.sound.removeEventListener("play", waiter.onPlay);
                    } catch (listenerErr) {
                        debug('[State] Failed to remove play listener:', listenerErr.message);
                    }
                }
                this.clearPlayWaiter(playlist);
            } catch (err) {
                console.warn(`[State] Error during crossfade cleanup for "${playlist?.name}":`, err);
            }
        }

        // 2. Clean Silence
        if (cleanSilence) {
            try {
                const silenceState = this.getSilenceState(playlist);
                if (silenceState) {
                    debug(`[State] Cleaning up active silent gap for "${playlist.name}"`);
                    silenceState.cancelled = true;
                    if (silenceState.timer) silenceState.timer.cancel();

                    const gap = silenceState.gap;
                    if (gap) {
                        this.markGapAsCancelled(gap);
                        if (gap.id && game.user.isGM) {
                            // No need to await, let it delete in the background
                            gap.delete().catch(err => {
                                debug(`[State] Failed to delete silent gap "${gap?.name}":`, err.message);
                            });
                        }
                    }

                    if (silenceState.resolve) {
                        const gapMs = gap?.getFlag?.('the-sound-of-silence', 'gapDuration') || 0;
                        Hooks.callAll('the-sound-of-silence.silenceEnd', {
                            playlist,
                            duration: gapMs,
                            completed: false,
                            cancelled: true
                        });
                        this.recordSilence(gapMs, true);
                        silenceState.resolve(true); // Resolve the promise immediately
                    }
                    this.clearSilenceState(playlist); // Clean up the state
                }
            } catch (err) {
                console.warn(`[State] Error during silence cleanup for "${playlist?.name}":`, err);
            }
        }

        // 3. Clean Loopers (no changes needed here)
        if (cleanLoopers) {
            try {
                const soundsToClean = onlySound ? [onlySound] : Array.from(playlist.sounds);
                for (const sound of soundsToClean) {
                    const looper = this.getActiveLooper(sound);
                    if (looper) {
                        looper.isAborted = true;
                        looper.destroy(allowFadeOut);
                        this.clearActiveLooper(sound);
                    }
                }
            } catch (err) {
                console.warn(`[State] Error during looper cleanup for "${playlist?.name}":`, err);
            }
        }

        debug(`[State] Cleanup complete for "${playlist.name}"`);
    }

    // ============================================
    // Introspection / Debugging
    // ============================================

    /**
     * Get a complete snapshot of all active state for a playlist.
     * Useful for debugging and API consumers.
     * 
     * @param {Playlist} playlist
     * @returns {Object} Detailed state snapshot
     */
    inspectPlaylist(playlist) {
        if (!playlist) return null;

        const silenceState = this.getSilenceState(playlist);
        const crossfadeTimer = this.getCrossfadeTimer(playlist);
        let hasScheduledSilenceFade = false;

        const activeLoops = [];
        for (const sound of playlist.sounds) {
            const looper = this.getActiveLooper(sound);
            if (looper) {
                activeLoops.push({
                    soundName: sound.name,
                    soundId: sound.id,
                    activeSegment: looper.activeLoopSegment,
                    loopsCompleted: looper.loopsCompleted,
                    isCrossfading: looper.isCrossfading,
                    isDestroyed: looper.isDestroyed
                });
            }
            // Also, check if any sound in this playlist has a scheduled silence fade
            if (this.getEndOfTrackFade(sound)) {
                hasScheduledSilenceFade = true;
            }
        }

        return {
            playlistName: playlist.name,
            playlistId: playlist.id,
            features: {
                silence: silenceState ? {
                    active: true,
                    cancelled: silenceState.cancelled,
                    gapName: silenceState.gap?.name,
                } : null,

                scheduledSilenceFade: hasScheduledSilenceFade,

                crossfade: crossfadeTimer ? {
                    scheduled: true,
                } : null,

                loops: activeLoops.length > 0 ? activeLoops : null
            }
        };
    }

    /**
     * Get a summary of all state across all playlists.
     * Useful for global debugging.
     * 
     * @returns {Object} Summary across all playlists
     */
    inspectAll() {
        const summary = {
            playlists: [],
            totalActiveLoopers: 0,
            totalCrossfades: 0,
            totalSilentGaps: 0,
            metrics: this.getMetrics()
        };

        for (const playlist of game.playlists) {
            const inspection = this.inspectPlaylist(playlist);

            if (!inspection) continue;

            if (inspection.features.silence) summary.totalSilentGaps++;
            if (inspection.features.crossfade) summary.totalCrossfades++;
            if (inspection.features.loops) {
                summary.totalActiveLoopers += inspection.features.loops.length;
            }

            // Only include playlists with active features
            const hasFeatures = inspection.features.silence ||
                inspection.features.crossfade ||
                inspection.features.loops;
            if (hasFeatures) {
                summary.playlists.push(inspection);
            }
        }

        return summary;
    }

    /**
     * Marks a playlist as being in the process of stopping.
     * @param {Playlist} playlist
     */
    markPlaylistAsStopping(playlist) {
        if (!playlist) return;
        this._stoppingPlaylists.add(playlist);
        debug(`[State] Marked playlist "${playlist.name}" as stopping.`);
    }

    /**
     * Checks if a playlist is currently marked as stopping.
     * @param {Playlist} playlist
     * @returns {boolean}
     */
    isPlaylistStopping(playlist) {
        return this._stoppingPlaylists.has(playlist);
    }

    /**
     * Clears the "stopping" flag for a playlist, usually when playback begins.
     * @param {Playlist} playlist
     */
    clearStoppingFlag(playlist) {
        if (this._stoppingPlaylists.delete(playlist)) {
            debug(`[State] Cleared stopping flag for playlist "${playlist.name}".`);
        }
    }


    /**
     * Stores a reference to a sound's scheduled end-of-track fade timer.
     * @param {PlaylistSound} sound The PlaylistSound document.
     * @param {AudioTimeout} timer The AudioTimeout handle returned by sound.schedule().
     */
    setEndOfTrackFade(sound, timer) {
        this._endOfTrackFades.set(sound, timer);
    }

    /**
     * Retrieves the scheduled end-of-track fade timer for a sound.
     * @param {PlaylistSound} sound The PlaylistSound document.
     * @returns {AudioTimeout|undefined}
     */
    getEndOfTrackFade(sound) {
        return this._endOfTrackFades.get(sound);
    }

    /**
     * Clears the stored end-of-track fade timer for a sound.
     * @param {PlaylistSound} sound The PlaylistSound document.
     */
    clearEndOfTrackFade(sound) {
        this._endOfTrackFades.delete(sound);
    }

    /**
 * Emits a generic hook to notify listeners that the module's state has changed.
 * @private
 */
    _emitStateChange() {
        // Use a debounce to prevent spamming renders during rapid changes (like a crossfade)
        if (this._emitTimeout) return;
        this._emitTimeout = setTimeout(() => {
            Hooks.callAll(`${MODULE_ID}.stateChanged`);
            this._emitTimeout = null;
        }, 50); // A 50ms debounce is a good starting point
    }

    // Now, call this new method from all of your state mutation functions.
    // Here are a few examples:

    setSilenceState(playlist, state) {
        this._silentGaps.set(playlist, state);
        debug(`[State] Set silence state for "${playlist.name}"`);
        this._emitStateChange();
    }

    clearSilenceState(playlist) {
        const had = this._silentGaps.has(playlist);
        this._silentGaps.delete(playlist);
        if (had) {
            debug(`[State] Cleared silence state for "${playlist.name}"`);
            this._emitStateChange();
        }
    }

    setCrossfadeTimer(playlist, handle) {
        this._crossfadeTimers.set(playlist, handle);
        debug(`[State] Set crossfade timer for "${playlist.name}"`);
        this._emitStateChange();
    }

    clearCrossfadeTimer(playlist) {
        const had = this._crossfadeTimers.has(playlist);
        this._crossfadeTimers.delete(playlist);
        if (had) {
            debug(`[State] Cleared crossfade timer for "${playlist.name}"`);
            this._emitStateChange();
        }
    }

    setActiveLooper(sound, looper) {
        this._activeLoopers.set(sound, looper);
        debug(`[State] Set active looper for "${sound.name}"`);
        this._emitStateChange();
    }

    clearActiveLooper(sound) {
        const had = this._activeLoopers.has(sound);
        this._activeLoopers.delete(sound);
        if (had) {
            debug(`[State] Cleared active looper for "${sound.name}"`);
            this._emitStateChange();
        }
    }

    // ============================================
    // Advanced Shuffle State Methods
    // ============================================

    /**
     * Get shuffle state for a playlist
     * @param {Playlist} playlist
     * @returns {Object|undefined}
     */
    getShuffleState(playlist) {
        return this._shuffleStates.get(playlist);
    }

    /**
     * Set shuffle state for a playlist
     * @param {Playlist} playlist
     * @param {Object} state
     */
    setShuffleState(playlist, state) {
        this._shuffleStates.set(playlist, state);
        debug(`[State] Set shuffle state for "${playlist.name}"`);
        this._emitStateChange();
    }

    /**
     * Clear shuffle state for a playlist
     * @param {Playlist} playlist
     */
    clearShuffleState(playlist) {
        const had = this._shuffleStates.has(playlist);
        this._shuffleStates.delete(playlist);
        if (had) {
            debug(`[State] Cleared shuffle state for "${playlist.name}"`);
            this._emitStateChange();
        }
    }

    markPlaylistAsCrossfading(playlist) {
        if (!playlist) return;
        this._crossfadingPlaylists.add(playlist);
        debug(`[State] Marked playlist "${playlist.name}" as crossfading.`);
    }

    isPlaylistCrossfading(playlist) {
        return this._crossfadingPlaylists.has(playlist);
    }

    clearPlaylistCrossfading(playlist) {
        if (this._crossfadingPlaylists.delete(playlist)) {
            debug(`[State] Cleared crossfading flag for playlist "${playlist.name}".`);
        }
    }

}

/**
 * Log a summary of a complex operation
 * @param {string} operation - Operation name
 * @param {Object} details - Key details to log
 */
export function logSummary(operation, details) {
    const icon = operation === 'cleanup' ? LogSymbols.CLEANUP :
        operation === 'crossfade' ? LogSymbols.CROSSFADE :
            operation === 'loop-start' ? LogSymbols.LOOP :
                LogSymbols.STATE;

    const parts = [];
    for (const [key, value] of Object.entries(details)) {
        if (value !== undefined && value !== null) {
            parts.push(`${key}:${value}`);
        }
    }

    logFeature(icon, operation.toUpperCase(), parts.join(' | '));
}

// Export singleton instance
export const State = new StateManager();