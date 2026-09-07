// state-manager.js
/**
 * @file state-manager.js
 * @description Centralized runtime state management for all module features.
 * This manages TEMPORARY state (in-memory), not persistent configuration.
 * For persistent configuration, see flag-service.js
 */

import {
    debug,
    MODULE_ID,
    logFeature,
    LogSymbols,
    PlaylistActionAuthority,
    safeCancelTimer,
    safeStop,
    warn,
} from "./utils.js";

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
         * Tracks the local media participants and completion timer for an active crossfade.
         * @type {WeakMap<Playlist, object>}
         */
        this._crossfadeSessions = new WeakMap();

        /**
         * Tracks pending play event listeners for crossfade scheduling
         * @type {WeakMap<Playlist, {sound: Sound, onPlay: Function}>}
         */
        this._playWaiters = new WeakMap();

        /**
         * Tracks active SoS-owned fade/crossfade gain curves.
         * @type {WeakMap<Sound, object>}
         */
        this._fadingSounds = new WeakMap();

        // ============================================
        // Loop Feature State
        // ============================================
        /**
         * Tracks active LoopingSound instances
         * @type {WeakMap<PlaylistSound, LoopingSound>}
         */
        this._activeLoopers = new WeakMap();
        this._activeLoopersByKey = new Map();

        // ============================================
        // Soundscape Feature State
        // ============================================
        /**
         * Tracks active SoundscapeEngine instances (one per playing soundscape playlist).
         * @type {WeakMap<Playlist, SoundscapeEngine>}
         */
        this._soundscapeEngines = new WeakMap();

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
    recordLoopEnd({ completed = true } = {}) {
        this._metrics.loops.activeSessions = Math.max(0, this._metrics.loops.activeSessions - 1);
        if (completed) this._metrics.loops.completedSessions++;
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
                averageDuration: (this._metrics.silence.totalGaps - this._metrics.silence.cancelled) > 0
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
        this._emitStateChange();
    }

    /**
     * Clear the silent gap state for a playlist
     * @param {Playlist} playlist
     */
    clearSilenceState(playlist, expectedState = null) {
        if (expectedState && this._silentGaps.get(playlist) !== expectedState) return false;
        const had = this._silentGaps.has(playlist);
        this._silentGaps.delete(playlist);
        if (had) {
            debug(`[State] Cleared silence state for "${playlist.name}"`);
            this._emitStateChange();
        }
        return had;
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
        this._emitStateChange(true);
    }

    /**
     * Clear the crossfade timer for a playlist
     * @param {Playlist} playlist
     */
    clearCrossfadeTimer(playlist) {
        const had = this._crossfadeTimers.has(playlist);
        this._crossfadeTimers.delete(playlist);
        if (had) {
            debug(`[State] Cleared crossfade timer for "${playlist.name}"`);
            this._emitStateChange(true);
        }
    }

    /**
     * Check if a playlist has a scheduled crossfade
     * @param {Playlist} playlist
     * @returns {boolean}
     */
    hasCrossfadeTimer(playlist) {
        return this._crossfadeTimers.has(playlist);
    }

    getCrossfadeSession(playlist) {
        return this._crossfadeSessions.get(playlist);
    }

    setCrossfadeSession(playlist, session) {
        if (!playlist || !session) return;
        this._crossfadeSessions.set(playlist, session);
        this.markPlaylistAsCrossfading(playlist);
        this._emitStateChange(true);
    }

    clearCrossfadeSession(playlist, session = null) {
        if (!playlist) return false;
        if (session && this._crossfadeSessions.get(playlist) !== session) return false;
        const had = this._crossfadeSessions.delete(playlist);
        this.clearPlaylistCrossfading(playlist);
        if (had) this._emitStateChange(true);
        return had;
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
        this._playWaiters.set(playlist, waiter);
        this._emitStateChange(true);
        debug(`[State] Set play waiter for "${playlist.name}"`);
    }

    /**
     * Clear the play waiter for a playlist
     * @param {Playlist} playlist
     */
    clearPlayWaiter(playlist) {
        this._playWaiters.delete(playlist);
        this._emitStateChange(true);
    }

    /**
     * Start tracking an SoS-owned fade and return its ownership token.
     * @param {Sound} sound
     * @param {object} [metadata]
     * @returns {object|null}
     */
    startFade(sound, metadata = {}) {
        if (!sound) return null;
        const token = {
            ...metadata,
            id: Symbol("sosFade"),
            startedAt: Date.now(),
        };
        this._fadingSounds.set(sound, token);
        debug(`[State] Started fade token (${token.type ?? "fade"})`);
        return token;
    }

    /**
     * Atomically replace one fade owner with another. This is used to hand a
     * pre-play startup reservation to the real audio-thread curve without an
     * interval where unrelated volume writers can claim the sound.
     * @param {Sound} sound
     * @param {object} expectedToken
     * @param {object} [metadata]
     * @returns {object|null}
     */
    replaceFade(sound, expectedToken, metadata = {}) {
        if (!sound || !expectedToken || this._fadingSounds.get(sound) !== expectedToken) {
            return null;
        }
        return this.startFade(sound, metadata);
    }

    /**
     * Mark a sound as currently fading only if it is not already owned by a fade.
     * Returns false if already fading; otherwise returns the new token.
     * @param {Sound} sound
     * @param {object} [metadata]
     * @returns {object|false}
     */
    markSoundAsFading(sound, metadata = {}) {
        if (this._fadingSounds.has(sound)) {
            debug(`[State] Sound already marked as fading (debounce rejected)`);
            return false;
        }
        return this.startFade(sound, metadata);
    }

    /**
     * Get the current fade token for a sound.
     * @param {Sound} sound
     * @returns {object|undefined}
     */
    getFadeToken(sound) {
        return this._fadingSounds.get(sound);
    }

    /**
     * Check whether a token still owns the sound's active fade.
     * @param {Sound} sound
     * @param {object} token
     * @returns {boolean}
     */
    isCurrentFadeToken(sound, token) {
        return !!token && this._fadingSounds.get(sound) === token;
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
    clearFadingSound(sound, token = null) {
        if (token && this._fadingSounds.get(sound) !== token) return false;
        return this._fadingSounds.delete(sound);
    }

    // ============================================
    // Loop State Methods
    // ============================================

    _soundStateKey(sound) {
        const playlistId = sound?.parent?.id ?? sound?.playlistId;
        const soundId = sound?.id;
        return playlistId && soundId ? `${playlistId}:${soundId}` : null;
    }

    /**
     * Get the active LoopingSound instance for a sound
     * @param {PlaylistSound} sound
     * @returns {LoopingSound|undefined}
     */
    getActiveLooper(sound) {
        return this._activeLoopers.get(sound) ?? this._activeLoopersByKey.get(this._soundStateKey(sound));
    }

    /**
     * Set the active LoopingSound instance for a sound
     * @param {PlaylistSound} sound
     * @param {LoopingSound} looper
     */
    setActiveLooper(sound, looper) {
        this._activeLoopers.set(sound, looper);
        const key = this._soundStateKey(sound);
        if (key) this._activeLoopersByKey.set(key, looper);
        debug(`[State] Set active looper for "${sound.name}"`);
        this._emitStateChange();
    }

    /**
     * Clear the active looper for a sound
     * @param {PlaylistSound} sound
     */
    clearActiveLooper(sound) {
        const key = this._soundStateKey(sound);
        const had = this._activeLoopers.has(sound) || (key ? this._activeLoopersByKey.has(key) : false);
        this._activeLoopers.delete(sound);
        if (key) this._activeLoopersByKey.delete(key);
        if (had) {
            debug(`[State] Cleared active looper for "${sound.name}"`);
            this._emitStateChange();
        }
    }

    /**
     * Check if a sound has an active looper
     * @param {PlaylistSound} sound
     * @returns {boolean}
     */
    hasActiveLooper(sound) {
        const looper = this.getActiveLooper(sound);
        return !!looper && !looper.isDestroyed && !looper.loopingDisabled;
    }

    // ============================================
    // Soundscape State Methods
    // ============================================

    /**
     * Get the active SoundscapeEngine for a playlist.
     * @param {Playlist} playlist
     * @returns {SoundscapeEngine|undefined}
     */
    getSoundscapeEngine(playlist) {
        return this._soundscapeEngines.get(playlist);
    }

    /**
     * Store a SoundscapeEngine for a playlist.
     * @param {Playlist} playlist
     * @param {SoundscapeEngine} engine
     */
    setSoundscapeEngine(playlist, engine) {
        this._soundscapeEngines.set(playlist, engine);
        debug(`[State] Set soundscape engine for "${playlist.name}"`);
        this._emitStateChange();
    }

    /**
     * Clear the SoundscapeEngine for a playlist.
     * @param {Playlist} playlist
     */
    clearSoundscapeEngine(playlist) {
        const had = this._soundscapeEngines.has(playlist);
        this._soundscapeEngines.delete(playlist);
        if (had) {
            debug(`[State] Cleared soundscape engine for "${playlist.name}"`);
            this._emitStateChange();
        }
    }

    /**
     * Check whether a playlist has an active soundscape engine.
     * @param {Playlist} playlist
     * @returns {boolean}
     */
    hasSoundscapeEngine(playlist) {
        return this._soundscapeEngines.has(playlist);
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
     * @param {boolean} [options.cleanSoundscape=true] - Destroy soundscape engine
     * @param {PlaylistSound} [options.onlySound=null] - If provided, only clean this sound's looper
     * @param {boolean} [options.allowFadeOut=false] - Allow sounds to fade out naturally instead of stopping immediately
     * @param {boolean} [options.final=false] - Permanently discard all remaining local state for a deleted playlist
     * @returns {Promise<void>}
     */
    async cleanup(playlist, options = {}) {
        const {
            cleanSilence = true,
            cleanCrossfade = true,
            cleanLoopers = true,
            cleanSoundscape = true,
            onlySound = null,
            allowFadeOut = false,
            final = false
        } = options;

        debug(`[State] Cleanup requested for "${playlist?.name}"`, options);
        if (!playlist) return;

        // 1. Clean Crossfade
        if (cleanCrossfade) {
            try {
                const session = this.getCrossfadeSession(playlist);
                const timer = this.getCrossfadeTimer(playlist);
                const waiter = this.getPlayWaiter(playlist);
                if (session?.settle) {
                    await session.settle({ mode: "cancel", reason: "playlist cleanup" });
                }

                safeCancelTimer(timer, `crossfade cleanup for "${playlist?.name}"`);
                if (this.getCrossfadeTimer(playlist) === timer) {
                    this.clearCrossfadeTimer(playlist);
                }

                if (waiter?.sound) {
                    try {
                        waiter.sound.removeEventListener("play", waiter.onPlay);
                    } catch (listenerErr) {
                        debug('[State] Failed to remove play listener:', listenerErr.message);
                    }
                }
                if (this.getPlayWaiter(playlist) === waiter) {
                    this.clearPlayWaiter(playlist);
                }
                // settle() already compare-clears its own session. Keep this
                // identity guard for malformed legacy sessions without ever
                // deleting a replacement installed while async cleanup ran.
                if (session) this.clearCrossfadeSession(playlist, session);
            } catch (err) {
                warn(`[State] Error during crossfade cleanup for "${playlist?.name}":`, err);
            }
        }

        // 2. Clean Silence
        if (cleanSilence) {
            try {
                const silenceState = this.getSilenceState(playlist);
                if (silenceState) {
                    const naturalCompletionOwnsState =
                        silenceState.terminalOutcome === "natural" ||
                        (silenceState.advancementComplete && !silenceState.cancelled) ||
                        silenceState.deletingForCompletion;
                    if (naturalCompletionOwnsState && final) {
                        silenceState.terminalOutcome = "natural";
                        safeCancelTimer(silenceState.timer, `final silence cleanup for "${playlist.name}"`);
                        if (!silenceState.terminalEventEmitted) {
                            silenceState.terminalEventEmitted = true;
                            const gapMs = silenceState.gap?.getFlag?.('the-sound-of-silence', 'gapDuration') || 0;
                            Hooks.callAll('the-sound-of-silence.silenceEnd', {
                                playlist,
                                duration: gapMs,
                                completed: true
                            });
                            this.recordSilence(gapMs, false);
                            silenceState.resolve?.(false);
                        }
                        this.clearSilenceState(playlist, silenceState);
                    } else if (naturalCompletionOwnsState) {
                        // The next real-track (or terminal stop) update already
                        // committed. Let that completion own marker deletion;
                        // this cleanup request applies to the new playlist state.
                        silenceState.terminalOutcome = "natural";
                        debug(`[State] Preserving naturally completed silent gap for "${playlist.name}" until marker cleanup finishes`);
                    } else {
                    debug(`[State] Cleaning up active silent gap for "${playlist.name}"`);
                    if (!silenceState.terminalOutcome) silenceState.terminalOutcome = "cancelled";
                    silenceState.cancelled = true;
                    safeCancelTimer(silenceState.timer, `silence cleanup for "${playlist.name}"`);

                    // A document update already sent by natural completion
                    // cannot be cancelled. Drain it before the caller applies
                    // its Stop/Play/Next selection, so it cannot overwrite that
                    // newer command afterward. Claim cancellation first so
                    // completion neither reports success nor restores/retries
                    // the gap if its pending update fails.
                    if (!final && silenceState.completionAttempt) {
                        try {
                            await silenceState.completionAttempt;
                        } catch (err) {
                            debug(`[State] Pending silence completion ended during cancellation:`, err?.message ?? err);
                        }
                    }

                    const gap = silenceState.gap;
                    let gapSettled = true;
                    if (gap) {
                        this.markGapAsCancelled(gap);
                        if (!final && gap.id && PlaylistActionAuthority.isAuthorizedGM()) {
                            try {
                                await gap.delete();
                            } catch (err) {
                                debug(`[State] Failed to delete silent gap "${gap?.name}":`, err.message);
                            }

                            // Deletion can be rejected by a wrapper, hook, or
                            // transient database failure. Before releasing
                            // local ownership, force any surviving marker to
                            // an inactive document state so reload recovery
                            // cannot resurrect a cancelled gap.
                            if (playlist.sounds?.has?.(gap.id)) {
                                try {
                                    if (typeof gap.update === "function") {
                                        await gap.update({ playing: false, pausedTime: null }, { noHook: true });
                                    } else {
                                        await playlist.updateEmbeddedDocuments(
                                            "PlaylistSound",
                                            [{ _id: gap.id, playing: false, pausedTime: null }],
                                            { noHook: true }
                                        );
                                    }
                                } catch (stopErr) {
                                    warn(`[State] Failed to stop surviving silent gap "${gap?.name}":`, stopErr);
                                }
                            }
                        }
                        if (gap.sound?.playing) await safeStop(gap.sound, "cancel silent gap");
                        gapSettled = final || !playlist.sounds?.has?.(gap.id) || gap.playing !== true;
                    }

                    if (gapSettled && !silenceState.terminalEventEmitted) {
                        // Claim the one public terminal notification before
                        // hooks run, since they may synchronously re-enter.
                        silenceState.terminalEventEmitted = true;
                        const gapMs = gap?.getFlag?.('the-sound-of-silence', 'gapDuration') || 0;
                        Hooks.callAll('the-sound-of-silence.silenceEnd', {
                            playlist,
                            duration: gapMs,
                            completed: false,
                            cancelled: true
                        });
                        this.recordSilence(gapMs, true);
                        silenceState.resolve?.(true); // Resolve the promise immediately
                    }
                    if (gapSettled) {
                        this.clearSilenceState(playlist, silenceState); // Clean up only the state we cancelled
                    } else if (!silenceState.cleanupRetryScheduled) {
                        // Preserve the cancelled generation until the
                        // persistent document is safely stopped or removed.
                        // This keeps authority recovery from claiming it as
                        // live work after a transient double failure.
                        silenceState.cleanupRetryScheduled = true;
                        globalThis.setTimeout?.(() => {
                            if (this.getSilenceState(playlist) !== silenceState) return;
                            silenceState.cleanupRetryScheduled = false;
                            this.cleanup(playlist, {
                                cleanSilence: true,
                                cleanCrossfade: false,
                                cleanLoopers: false,
                                cleanSoundscape: false,
                            }).catch((retryErr) =>
                                warn(`[State] Silent-gap cleanup retry failed for "${playlist?.name}":`, retryErr)
                            );
                        }, 1000);
                    }
                    }
                }
            } catch (err) {
                warn(`[State] Error during silence cleanup for "${playlist?.name}":`, err);
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
                warn(`[State] Error during looper cleanup for "${playlist?.name}":`, err);
            }
        }

        // 4. Clean Soundscape engine
        if (cleanSoundscape) {
            try {
                const engine = this.getSoundscapeEngine(playlist);
                if (engine) {
                    // A deleted playlist can no longer receive a follow-up
                    // document update, so final cleanup must stay local-only.
                    engine.destroy({ stopBeds: final ? false : !allowFadeOut });
                    this.clearSoundscapeEngine(playlist);
                }
            } catch (err) {
                warn(`[State] Error during soundscape cleanup for "${playlist?.name}":`, err);
            }
        }

        if (final) {
            for (const sound of Array.from(playlist.sounds ?? [])) {
                const pendingFade = this.getEndOfTrackFade(sound);
                pendingFade?.cancel?.();
                this.clearEndOfTrackFade(sound);
            }
            this.clearStoppingFlag(playlist);
            this.clearShuffleState(playlist);
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
        const crossfadeSession = this.getCrossfadeSession(playlist);
        const soundscapeEngine = this.getSoundscapeEngine(playlist);
        let hasScheduledSilenceFade = false;

        const activeLoops = [];
        for (const sound of playlist.sounds) {
            const looper = this.getActiveLooper(sound);
            if (looper && !looper.isDestroyed) {
                activeLoops.push({
                    soundName: sound.name,
                    soundId: sound.id,
                    activeSegment: looper.activeLoopSegment,
                    loopsCompleted: looper.loopsCompleted,
                    isCrossfading: looper.isCrossfading,
                    loopingDisabled: !!looper.loopingDisabled,
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

                crossfade: (crossfadeTimer || crossfadeSession) ? {
                    scheduled: !!crossfadeTimer,
                    active: !!crossfadeSession,
                    session: crossfadeSession ? {
                        id: crossfadeSession.id,
                        status: crossfadeSession.status,
                        source: crossfadeSession.source,
                        outgoingSoundId: crossfadeSession.outgoingDocument?.id ?? null,
                        incomingSoundId: crossfadeSession.incomingDocument?.id ?? null,
                        durationMs: crossfadeSession.durationMs,
                    } : null,
                } : null,

                loops: activeLoops.length > 0 ? activeLoops : null,

                soundscape: soundscapeEngine && !soundscapeEngine.isDestroyed ? {
                    active: true,
                    started: Boolean(soundscapeEngine.isStarted),
                    syncMode: soundscapeEngine.syncMode ?? null,
                    armedProcedurals: Number(soundscapeEngine.oneShotTimers?.size ?? 0),
                    activeOneShots: Number(soundscapeEngine.activeOneShots?.size ?? 0),
                    pendingOneShots: Number(soundscapeEngine.pendingOneShotTotal ?? 0),
                } : null
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
            totalActiveSoundscapes: 0,
            metrics: this.getMetrics()
        };

        for (const playlist of game.playlists) {
            const inspection = this.inspectPlaylist(playlist);

            if (!inspection) continue;

            if (inspection.features.silence) summary.totalSilentGaps++;
            if (inspection.features.crossfade) summary.totalCrossfades++;
            if (inspection.features.soundscape) summary.totalActiveSoundscapes++;
            if (inspection.features.loops) {
                summary.totalActiveLoopers += inspection.features.loops.length;
            }

            // Only include playlists with active features
            const hasFeatures = inspection.features.silence ||
                inspection.features.crossfade ||
                inspection.features.loops ||
                inspection.features.soundscape;
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
     * Public bridge for notifying UI listeners about runtime state updates.
     * @param {boolean|Object} [options=false]
     * @param {boolean} [options.silent=false]
     * @param {boolean} [options.soundscapeOnly=false] True when existing soundscape UI can update in place.
     */
    notifyStateChanged(options = false) {
        const { silent, context } = this._normalizeStateChangeOptions(options);
        this._emitStateChange(silent, context);
    }

    _normalizeStateChangeOptions(options = false) {
        if (typeof options === "boolean") return { silent: options, context: {} };
        if (!options || typeof options !== "object") return { silent: false, context: {} };

        const { silent = false, context = null, ...rest } = options;
        return {
            silent: !!silent,
            context: context && typeof context === "object" ? context : rest,
        };
    }

    _mergeStateChangeContexts(current, next = {}) {
        const normalizedNext = {
            ...next,
            soundscapeOnly: next.soundscapeOnly === true,
        };
        if (!current) return normalizedNext;

        // Once reasons have been normalized, do not feed their comma-joined
        // display string back into the next merge. Repeated state changes in a
        // single debounce window would otherwise grow that string exponentially.
        const currentReasons = Array.isArray(current.reasons)
            ? current.reasons
            : [current.reason];
        const nextReasons = Array.isArray(normalizedNext.reasons)
            ? normalizedNext.reasons
            : [normalizedNext.reason];
        const reasons = new Set([...currentReasons, ...nextReasons].filter(Boolean));

        const samePlaylist = current.playlistId && current.playlistId === normalizedNext.playlistId;
        const sameSound = current.soundId && current.soundId === normalizedNext.soundId;

        return {
            ...current,
            ...normalizedNext,
            soundscapeOnly: current.soundscapeOnly === true && normalizedNext.soundscapeOnly === true,
            reason: Array.from(reasons).join(",") || undefined,
            reasons: Array.from(reasons),
            playlistId: samePlaylist ? current.playlistId : null,
            soundId: sameSound ? current.soundId : null,
        };
    }

    /**
     * Emits a generic hook to notify listeners that the module's state has changed.
     * @private
     */
    _emitStateChange(silent = false, context = {}) {
        // Silent emissions are for internal audio-engine bookkeeping (crossfade timers,
        // play waiters) that have no visual representation in the UI.
        if (silent) return;
        this._pendingStateChangeContext = this._mergeStateChangeContexts(
            this._pendingStateChangeContext,
            context
        );
        // Use a debounce to prevent spamming renders during rapid changes (like a crossfade).
        // Uses AudioTimeout instead of setTimeout for consistency with background-tab behavior.
        if (this._emitPending) return;
        this._emitPending = true;
        const flush = () => {
            const pendingContext = this._pendingStateChangeContext ?? {};
            this._pendingStateChangeContext = null;
            this._emitPending = false;
            Hooks.callAll(`${MODULE_ID}.stateChanged`, pendingContext);
        };

        if (game.audio?.locked || !game.audio?.music) {
            setTimeout(flush, 150);
            return;
        }

        foundry.audio.AudioTimeout.wait(150).then(flush).catch(() => {
            this._pendingStateChangeContext = null;
            this._emitPending = false;
        });
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
            this._emitStateChange();
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

/**
 * Centralized cleanup coordinator for all module state.
 * Ensures cleanup happens in the correct order without race conditions.
 * @param {Playlist} playlist The playlist to clean up.
 * @param {object} options Cleanup options.
 * @returns {Promise<void>}
 */
export async function cleanupPlaylistState(playlist, options = {}) {
    debug(`[Cleanup] Delegating to State manager for "${playlist?.name}"`);
    return State.cleanup(playlist, options);
}
