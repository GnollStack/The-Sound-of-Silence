/**
 * @file advanced-shuffle.js
 * @description Advanced shuffle patterns for Foundry VTT playlists, including:
 * - Exhaustive shuffle (no repeats until all tracks played)
 * - Weighted random (favor less-recently played tracks)
 * - Round-robin with memory (tracks cycle through evenly)
 */

import { MODULE_ID, debug, logFeature, LogSymbols } from "./utils.js";
import { State } from "./state-manager.js";

// =========================================================================
// Shuffle Pattern Types
// =========================================================================

export const SHUFFLE_PATTERNS = {
    FOUNDRY_DEFAULT: "foundry-default",    // Use Foundry's built-in shuffle
    EXHAUSTIVE: "exhaustive",              // Play all tracks once before reshuffling
    WEIGHTED_RANDOM: "weighted-random",    // Favor tracks that haven't played recently
    ROUND_ROBIN: "round-robin"             // Even distribution with memory
};

// =========================================================================
// Shuffle State Management
// =========================================================================

/**
 * Tracks shuffle state for each playlist across all patterns.
 * Stored in State manager for proper cleanup and memory management.
 */
class ShuffleStateManager {
    /**
     * Get or initialize shuffle state for a playlist
     * @param {Playlist} playlist
     * @returns {Object} Shuffle state
     */
    static getState(playlist) {
        let state = State.getShuffleState(playlist);

        if (!state) {
            state = {
                pattern: this.getActivePattern(),
                currentCycle: [],           // Current shuffled order
                playedThisCycle: new Set(), // Track IDs played in current cycle
                cycleNumber: 0,             // Which cycle we're on
                playHistory: [],            // Last N plays for weighted random
                lastShuffleTime: Date.now(),
                trackWeights: new Map()     // Track ID -> weight for weighted random
            };
            State.setShuffleState(playlist, state);
            debug(`[Shuffle] Initialized state for "${playlist.name}" with pattern: ${state.pattern}`);
        }

        return state;
    }

    /**
     * Clear shuffle state for a playlist
     * @param {Playlist} playlist
     */
    static clearState(playlist) {
        State.clearShuffleState(playlist);
        debug(`[Shuffle] Cleared state for "${playlist.name}"`);
    }

    /**
     * Get the currently active shuffle pattern from settings
     * @returns {string}
     */
    static getActivePattern() {
        try {
            return game.settings.get(MODULE_ID, "shufflePattern") || SHUFFLE_PATTERNS.FOUNDRY_DEFAULT;
        } catch {
            return SHUFFLE_PATTERNS.FOUNDRY_DEFAULT;
        }
    }

    /**
     * Check if advanced shuffle is enabled
     * @returns {boolean}
     */
    static isEnabled() {
        return this.getActivePattern() !== SHUFFLE_PATTERNS.FOUNDRY_DEFAULT;
    }
}

// =========================================================================
// Shuffle Algorithms
// =========================================================================

/**
 * Fisher-Yates shuffle implementation
 * @param {Array} array Array to shuffle (modified in place)
 * @returns {Array} The shuffled array
 */
function fisherYatesShuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

/**
 * EXHAUSTIVE SHUFFLE PATTERN
 * Plays all tracks exactly once before reshuffling.
 * No repeats until the entire playlist has been played through.
 */
class ExhaustiveShuffle {
    /**
     * Generate next track order using exhaustive shuffle
     * @param {Playlist} playlist
     * @param {Object} state Current shuffle state
     * @returns {Array<string>} Track IDs in play order
     */
    static generate(playlist, state) {
        //  Filter Out Silent Gap Sounds
        const allTrackIds = Array.from(playlist.sounds.values())
            .filter(s => !s.getFlag(MODULE_ID, "isSilenceGap"))
            .map(s => s.id);

        // If we haven't started or completed a cycle, generate new shuffle
        if (state.currentCycle.length === 0 || state.playedThisCycle.size >= allTrackIds.length) {
            logFeature(LogSymbols.LOOP, 'Shuffle', `Exhaustive: New cycle for "${playlist.name}" (Cycle #${state.cycleNumber + 1})`);

            state.currentCycle = fisherYatesShuffle([...allTrackIds]);
            state.playedThisCycle.clear();
            state.cycleNumber++;
            state.lastShuffleTime = Date.now();
        }

        return state.currentCycle;
    }

    /**
     * Mark a track as played
     * @param {Playlist} playlist
     * @param {string} trackId
     * @param {Object} state
     */
    static markPlayed(playlist, trackId, state) {
        state.playedThisCycle.add(trackId);

        const total = playlist.sounds.size;
        const played = state.playedThisCycle.size;
        debug(`[Shuffle] Exhaustive: ${played}/${total} tracks played in cycle #${state.cycleNumber}`);

        // Check if the cycle is complete
        if (state.playedThisCycle.size >= total) {
            debug(`[Shuffle] Exhaustive: Cycle #${state.cycleNumber} complete! Will reshuffle next.`);

            // Invalidate our module's cache AND Foundry's cache to force a new cycle.
            state.currentCycle = [];
            delete playlist._playbackOrder;
        }
    }
}

/**
 * WEIGHTED RANDOM SHUFFLE PATTERN
 * Tracks that haven't been played recently are more likely to be selected.
 * Uses a history-based weighting system.
 */
class WeightedRandomShuffle {
    static HISTORY_SIZE = 20; // Remember last 20 plays
    static MIN_WEIGHT = 0.1;  // Minimum weight for recently played tracks
    static MAX_WEIGHT = 1.0;  // Maximum weight for long-unplayed tracks

    /**
     * Generate next track order using weighted random selection
     * @param {Playlist} playlist
     * @param {Object} state
     * @returns {Array<string>}
     */
    static generate(playlist, state) {
        const allTrackIds = Array.from(playlist.sounds.values())
            .filter(s => !s.getFlag(MODULE_ID, "isSilenceGap"))
            .map(s => s.id);

        // Initialize weights if needed
        if (state.trackWeights.size === 0) {
            allTrackIds.forEach(id => state.trackWeights.set(id, this.MAX_WEIGHT));
        }

        // Check if we need to regenerate a new cycle.
        // This happens when the current order is exhausted.
        if (state.currentCycle.length === 0) {
            //Force-clear the played set to guarantee a clean start for the new cycle.
            // This fixes the stale state bug.
            if (state.playedThisCycle) state.playedThisCycle.clear();

            // Generate weighted shuffle
            const order = [];
            const availableTracks = [...allTrackIds];

            while (availableTracks.length > 0) {
                const selected = this._selectWeightedRandom(availableTracks, state.trackWeights);
                order.push(selected);
                availableTracks.splice(availableTracks.indexOf(selected), 1);
            }

            state.currentCycle = order;
            logFeature(LogSymbols.LOOP, 'Shuffle', `Weighted Random: Generated order for "${playlist.name}"`);
        }

        return state.currentCycle;
    }

    /**
     * Select a random track based on weights
     * @private
     */
    static _selectWeightedRandom(tracks, weights) {
        const totalWeight = tracks.reduce((sum, id) => sum + (weights.get(id) || this.MAX_WEIGHT), 0);
        let random = Math.random() * totalWeight;

        for (const trackId of tracks) {
            const weight = weights.get(trackId) || this.MAX_WEIGHT;
            random -= weight;
            if (random <= 0) {
                return trackId;
            }
        }

        return tracks[tracks.length - 1]; // Fallback
    }

    /**
     * Mark a track as played and update weights
     * @param {Playlist} playlist
     * @param {string} trackId
     * @param {Object} state
     */
    static markPlayed(playlist, trackId, state) {
        // Add to history for weighting
        state.playHistory.push({ trackId, timestamp: Date.now() });
        if (state.playHistory.length > this.HISTORY_SIZE) {
            state.playHistory.shift();
        }

        // Add to the set that tracks the current cycle
        if (!state.playedThisCycle) {
            state.playedThisCycle = new Set();
        }
        state.playedThisCycle.add(trackId);

        // CAPTURE the correct count BEFORE the set is potentially cleared.
        const playedCount = state.playedThisCycle.size;

        const allTrackIds = Array.from(playlist.sounds.values())
            .filter(s => !s.getFlag(MODULE_ID, "isSilenceGap"))
            .map(s => s.id);
        const totalTracks = allTrackIds.length;

        // Recalculate weights based on history
        this._updateWeights(playlist, state);

        const soundName = playlist.sounds.get(trackId)?.name || "Unknown Track";
        debug(`[Shuffle] Weighted Random: Played "${soundName}" (${playedCount}/${totalTracks} in cycle)`);

        // Check for cycle completion AFTER logging the correct count.
        if (playedCount >= totalTracks) {
            debug(`[Shuffle] Weighted Random: Cycle complete (${totalTracks}/${totalTracks}), will reshuffle on next access`);
            state.currentCycle = []; // Invalidate order to force regeneration
            state.playedThisCycle.clear(); // Clear set for the next cycle
        }
    }

    /**
     * Update track weights based on play history
     * @private
     */
    static _updateWeights(playlist, state) {
        //  Filter Out Silent Gap Sounds
        const allTrackIds = Array.from(playlist.sounds.values())
            .filter(s => !s.getFlag(MODULE_ID, "isSilenceGap"))
            .map(s => s.id);
        const now = Date.now();

        allTrackIds.forEach(trackId => {
            // Find last time this track played
            const lastPlay = state.playHistory.slice().reverse().find(h => h.trackId === trackId);

            if (!lastPlay) {
                // Never played or not in recent history - max weight
                state.trackWeights.set(trackId, this.MAX_WEIGHT);
            } else {
                // Calculate weight based on recency and frequency
                const timeSincePlay = now - lastPlay.timestamp;
                const playCount = state.playHistory.filter(h => h.trackId === trackId).length;

                // Weight increases with time and decreases with frequency
                const timeWeight = Math.min(1.0, timeSincePlay / (5 * 60 * 1000)); // 5 min to full weight
                const freqWeight = Math.max(0.1, 1.0 - (playCount / this.HISTORY_SIZE));

                const weight = Math.max(this.MIN_WEIGHT, timeWeight * freqWeight);
                state.trackWeights.set(trackId, weight);
            }
        });
    }
}

/**
 * ROUND-ROBIN SHUFFLE PATTERN
 * Ensures even distribution of plays across all tracks.
 * Similar to exhaustive but maintains stricter rotation discipline.
 */
class RoundRobinShuffle {
    /**
     * Generate next track order using round-robin
     * @param {Playlist} playlist
     * @param {Object} state
     * @returns {Array<string>}
     */
    static generate(playlist, state) {
        //  Filter Out Silent Gap Sounds
        const allTrackIds = Array.from(playlist.sounds.values())
            .filter(s => !s.getFlag(MODULE_ID, "isSilenceGap"))
            .map(s => s.id);

        // Track play counts
        if (!state.roundRobinCounts) {
            state.roundRobinCounts = new Map();
            allTrackIds.forEach(id => state.roundRobinCounts.set(id, 0));
        }

        // Regenerate order when starting or when all tracks have same count (new cycle)
        const counts = Array.from(state.roundRobinCounts.values());
        const allSameCount = counts.length > 0 && counts.every(c => c === counts[0]);

        if (state.currentCycle.length === 0 || allSameCount) {
            // Sort tracks by play count (ascending), then randomize within same count
            const groups = new Map();
            allTrackIds.forEach(id => {
                const count = state.roundRobinCounts.get(id) || 0;
                if (!groups.has(count)) groups.set(count, []);
                groups.get(count).push(id);
            });

            // Build order: least played first, randomized within each group
            const order = [];
            const sortedCounts = Array.from(groups.keys()).sort((a, b) => a - b);

            sortedCounts.forEach(count => {
                const group = groups.get(count);
                fisherYatesShuffle(group);
                order.push(...group);
            });

            state.currentCycle = order;
            logFeature(LogSymbols.LOOP, 'Shuffle', `Round-Robin: Generated order for "${playlist.name}"`);
        }

        return state.currentCycle;
    }

    /**
     * Mark a track as played and increment its count
     * @param {Playlist} playlist
     * @param {string} trackId
     * @param {Object} state
     */
    static markPlayed(playlist, trackId, state) {
        if (!state.roundRobinCounts) {
            state.roundRobinCounts = new Map();
        }

        const currentCount = state.roundRobinCounts.get(trackId) || 0;
        state.roundRobinCounts.set(trackId, currentCount + 1);

        // Track plays in current cycle
        if (!state.playedThisCycle) {
            state.playedThisCycle = new Set();
        }
        state.playedThisCycle.add(trackId);

        const totalTracks = playlist.sounds.size;
        debug(`[Shuffle] Round-Robin: "${playlist.sounds.get(trackId)?.name}" played ${currentCount + 1} times total (${state.playedThisCycle.size}/${totalTracks} in cycle)`);

        // Check if cycle complete - force reshuffle
        if (state.playedThisCycle.size >= totalTracks) {
            debug(`[Shuffle] Round-Robin: Cycle complete! Clearing cache to force reshuffle.`);
            state.currentCycle = []; // Clear to force regeneration
            state.playedThisCycle.clear();
        }
    }
}

// =========================================================================
// Main Shuffle Controller
// =========================================================================

export class AdvancedShuffle {
    /**
     * Generate shuffle order for a playlist based on current pattern
     * @param {Playlist} playlist
     * @returns {Array<string>} Array of track IDs in play order
     */
    static generateOrder(playlist) {
        if (!ShuffleStateManager.isEnabled()) {
            return null; // Let Foundry handle it
        }

        const pattern = ShuffleStateManager.getActivePattern();
        const state = ShuffleStateManager.getState(playlist);

        // Update pattern if it changed
        if (state.pattern !== pattern) {
            debug(`[Shuffle] Pattern changed from ${state.pattern} to ${pattern} for "${playlist.name}"`);
            state.pattern = pattern;
            state.currentCycle = [];
            state.playedThisCycle.clear();
        }

        // CRITICAL: Return cached order if it exists and is still valid
        if (state.currentCycle && state.currentCycle.length > 0) {
            // Verify cached order matches current tracks (in case tracks were added/removed)
            const currentTrackIds = new Set(playlist.sounds.keys());
            const cacheValid = state.currentCycle.every(id => currentTrackIds.has(id)) &&
                state.currentCycle.length === currentTrackIds.size;

            if (cacheValid) {
                return state.currentCycle; // Use cached order
            }
        }

        // Generate new order only when needed
        debug(`[Shuffle] Generating new order for "${playlist.name}"`);
        let order;
        switch (pattern) {
            case SHUFFLE_PATTERNS.EXHAUSTIVE:
                order = ExhaustiveShuffle.generate(playlist, state);
                break;
            case SHUFFLE_PATTERNS.WEIGHTED_RANDOM:
                order = WeightedRandomShuffle.generate(playlist, state);
                break;
            case SHUFFLE_PATTERNS.ROUND_ROBIN:
                order = RoundRobinShuffle.generate(playlist, state);
                break;
            default:
                return null;
        }

        return order;
    }

    /**
     * Mark a track as played (called after track starts playing)
     * @param {Playlist} playlist
     * @param {PlaylistSound} soundDoc
     */
    static markTrackPlayed(playlist, soundDoc) {
        if (!ShuffleStateManager.isEnabled()) return;

        // If the track is a temporary silent gap, do not update the shuffle state at all.
        // This allows it to play without corrupting the cycle count or play history.
        if (soundDoc.getFlag(MODULE_ID, "isSilenceGap")) {
            debug(`[Shuffle] Ignoring state update for temporary Silent Gap.`);
            return;
        }

        const pattern = ShuffleStateManager.getActivePattern();
        const state = ShuffleStateManager.getState(playlist);

        switch (pattern) {
            case SHUFFLE_PATTERNS.EXHAUSTIVE:
                ExhaustiveShuffle.markPlayed(playlist, soundDoc.id, state);
                break;
            case SHUFFLE_PATTERNS.WEIGHTED_RANDOM:
                WeightedRandomShuffle.markPlayed(playlist, soundDoc.id, state);
                break;
            case SHUFFLE_PATTERNS.ROUND_ROBIN:
                RoundRobinShuffle.markPlayed(playlist, soundDoc.id, state);
                break;
        }
    }

    /**
     * Reset shuffle state for a playlist (called when playlist is restarted or tracks change)
     * @param {Playlist} playlist
     */
    static reset(playlist) {
        ShuffleStateManager.clearState(playlist);
        logFeature(LogSymbols.CLEANUP, 'Shuffle', `Reset state for "${playlist.name}"`);
    }

    /**
     * Handle track addition/removal
     * @param {Playlist} playlist
     */
    static handleTracksChanged(playlist) {
        const state = ShuffleStateManager.getState(playlist);

        // Remove deleted tracks from state
        const currentTrackIds = new Set(playlist.sounds.keys());
        state.playedThisCycle = new Set([...state.playedThisCycle].filter(id => currentTrackIds.has(id)));
        state.currentCycle = state.currentCycle.filter(id => currentTrackIds.has(id));

        // For weighted and round-robin, update data structures
        if (state.trackWeights) {
            state.trackWeights = new Map([...state.trackWeights].filter(([id]) => currentTrackIds.has(id)));
        }
        if (state.roundRobinCounts) {
            state.roundRobinCounts = new Map([...state.roundRobinCounts].filter(([id]) => currentTrackIds.has(id)));
        }

        debug(`[Shuffle] Updated state for track changes in "${playlist.name}"`);
    }

    /**
     * Get the currently active shuffle pattern (convenience wrapper)
     * @returns {string}
     */
    static getActivePattern() {
        return ShuffleStateManager.getActivePattern();
    }

    /**
     * Check if advanced shuffle is enabled (convenience wrapper)
     * @returns {boolean}
     */
    static isEnabled() {
        return ShuffleStateManager.isEnabled();
    }
}