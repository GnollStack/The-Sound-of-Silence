// utils.js
// A collection of utility functions used throughout the module.

import { State } from "./state-manager.js";

const AudioTimeout = foundry.audio.AudioTimeout;

// Module identifier for flag storage and settings as well as debug logging.
export const MODULE_ID = "the-sound-of-silence";

// colored segments for both the loop segement timeline and handlebar colors and their correspinding loop segment titles
export const SEGMENT_COLORS = [
    "#ff6400", // Foundry Orange
    "#449fdb", // Foundry Blue
    "#4f9d9d", // Teal
    "#5a9c42", // Green
    "#a762d9", // Purple
    "#d957a8", // Magenta
    "#d6a21e", // Gold
    "#82c91e", // Lime
    "#36c2f0", // Sky Blue
    "#e04f64", // Rose Pink
    "#9d7bed", // Lavender
    "#f08c36", // Amber
    "#20c997", // Sea Green
    "#6741d9", // Indigo
    "#bf3636", // Muted Crimson
    "#f7ce46",  // Bright Yellow
];


const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3
};

/**
 * Enhanced logging with levels and consistent formatting
 * @param {number} level Log level (use LOG_LEVELS enum)
 * @param {...any} args The data to log
 */
export function log(level, ...args) {
    // Guard: Check if game and settings are ready
    if (!game?.settings) return;

    try {
        const debugEnabled = game.settings.get(MODULE_ID, "debug");
        if (!debugEnabled && level > LOG_LEVELS.WARN) return;

        const prefix = `[${MODULE_ID}]`;
        const levelColors = {
            [LOG_LEVELS.ERROR]: "color: red; font-weight: bold",
            [LOG_LEVELS.WARN]: "color: yellow; font-weight: bold",
            [LOG_LEVELS.INFO]: "color: blue; font-weight: bold",
            [LOG_LEVELS.DEBUG]: "color: orange; font-weight: normal"
        };

        const levelNames = {
            [LOG_LEVELS.ERROR]: "ERROR",
            [LOG_LEVELS.WARN]: "WARN",
            [LOG_LEVELS.INFO]: "INFO",
            [LOG_LEVELS.DEBUG]: "DEBUG"
        };

        console.log(
            `%c${prefix} ${levelNames[level]}`,
            levelColors[level] || levelColors[LOG_LEVELS.DEBUG],
            ...args
        );
    } catch (err) {
        // Setting not registered yet - silently ignore
    }
}

/**
 * Logs to the console only if the user has enabled debug logging in the module settings.
 * Safe to call before settings are registered (will not log during initialization).
 * @param {...any} args The data to log.
 */
// Keep backward compatibility
export function debug(...args) {
    log(LOG_LEVELS.DEBUG, ...args);
}

// Export log levels for use in other files
export { LOG_LEVELS };



/**
 * A robust, non-polling utility to get the Howler.js Sound object
 * from a PlaylistSound, which may not be immediately available.
 * @param {PlaylistSound} ps The playlist sound.
 * @returns {Promise<Sound|null>} A promise that resolves with the Sound object or null if it times out.
 */
export function waitForMedia(ps) {
    // If media is already available, return it immediately.
    if (ps?.sound) return Promise.resolve(ps.sound);

    // Otherwise, wait for it with a timeout.
    return new Promise((resolve) => {
        if (!ps) return resolve(null);

        let checkCount = 0;
        const interval = 50; // Check every 50ms
        const maxChecks = 100; // For a total timeout of ~5 seconds

        const check = () => {
            if (ps.sound) {
                debug(`[waitForMedia] ✅ Media found for "${ps.name}"`);
                return resolve(ps.sound);
            }
            if (++checkCount > maxChecks) {
                debug(`[waitForMedia] ⌛ Timed out waiting for media for "${ps.name}"`);
                return resolve(null);
            }
            AudioTimeout.wait(interval).then(check);
        };

        debug(`[waitForMedia] ⏳ Waiting for media on "${ps.name}"...`);
        check();
    });
}

/**
 * WeakMap cache for Sound -> PlaylistSound lookups
 * Automatically garbage collected when Sound objects are destroyed
 * @type {WeakMap<Sound, PlaylistSound>}
 */
const _soundLookupCache = new WeakMap();

/**
 * Finds the PlaylistSound document associated with a Sound object.
 * Uses multiple strategies for robust lookup with caching.
 * @param {Sound} sound The Sound object to find the document for
 * @returns {PlaylistSound|null} The associated PlaylistSound or null
 */
export function findPlaylistSoundForSound(sound) {
    if (!sound) return null;

    // Check cache first
    const cached = _soundLookupCache.get(sound);
    if (cached) {
        // Verify cached result is still valid
        if (cached.sound === sound) {
            return cached;
        }
        // Cache is stale, clear it
        _soundLookupCache.delete(sound);
    }

    let result = null;

    // Strategy 1: Direct manager reference (fastest)
    if (sound._manager instanceof PlaylistSound) {
        result = sound._manager;
    }

    // Strategy 2: Use stored IDs if available
    else if (sound.playlistId && sound.playlistSoundId) {
        const playlist = game.playlists.get(sound.playlistId);
        result = playlist?.sounds.get(sound.playlistSoundId) || null;
    }

    // Strategy 3: Search all playing sounds (slowest but most reliable)
    else {
        for (const playlist of game.playlists) {
            if (!playlist.playing) continue;
            const found = playlist.sounds.find(s => s.sound === sound);
            if (found) {
                result = found;
                break;
            }
        }
    }

    // Cache the result for next time
    if (result) {
        _soundLookupCache.set(sound, result);
    }

    return result;
}

/**
 * Converts a "MM:SS" or "MM:SS.mmm" time string into a total number of seconds.
 * @param {string} mmss The time string to convert.
 * @returns {number} The total time in seconds (with millisecond precision).
 */
export const toSec = (mmss) => {
    if (typeof mmss !== 'string') return 0;

    const parts = mmss.split(":");
    if (parts.length !== 2) return 0;

    const minutes = parseInt(parts[0], 10) || 0;
    const secondsPart = parts[1];

    // Handle seconds with optional milliseconds (SS or SS.mmm)
    let seconds = 0;
    if (secondsPart.includes('.')) {
        seconds = parseFloat(secondsPart) || 0;
    } else {
        seconds = parseInt(secondsPart, 10) || 0;
    }

    return Math.max(0, (minutes * 60) + seconds);
};

/**
 * Converts a total number of seconds into a "MM:SS.mmm" time string.
 * @param {number} sec The total time in seconds.
 * @param {boolean} showMilliseconds Whether to include milliseconds (default: true).
 * @returns {string} The formatted time string.
 */
export const formatTime = (sec, showMilliseconds = true) => {
    const s = Math.max(0, sec || 0);
    const minutes = String(Math.floor(s / 60)).padStart(2, '0');
    const wholeSeconds = Math.floor(s % 60);

    if (showMilliseconds) {
        const milliseconds = Math.round((s % 1) * 1000);
        const secondsStr = String(wholeSeconds).padStart(2, '0');
        const millisecondsStr = String(milliseconds).padStart(3, '0');
        return `${minutes}:${secondsStr}.${millisecondsStr}`;
    } else {
        const secondsStr = String(wholeSeconds).padStart(2, '0');
        return `${minutes}:${secondsStr}`;
    }
};


/**
 * Centralized cleanup coordinator for all module state.
 * Ensures cleanup happens in the correct order without race conditions.
 * 
 * Now delegates to State.cleanup() for proper coordination
 * 
 * @param {Playlist} playlist The playlist to clean up
 * @param {object} options Cleanup options
 * @param {boolean} options.cleanSilence Whether to cancel silent gaps
 * @param {boolean} options.cleanCrossfade Whether to cancel crossfades
 * @param {boolean} options.cleanLoopers Whether to cancel all track loopers
 * @param {PlaylistSound} options.onlySound If provided, only clean this specific sound's looper
 * @param {boolean} options.allowFadeOut Whether to allow sounds to fade out naturally
 * @returns {Promise<void>}
 */

export async function cleanupPlaylistState(playlist, options = {}) {
    debug(`[Cleanup] Delegating to State manager for "${playlist?.name}"`);
    return State.cleanup(playlist, options);
}

export class PlaylistActionAuthority {
    static isAuthorizedGM() {
        if (!game.user.isGM) return false;
        const gms = game.users.filter(u => u.isGM && u.active);
        return gms[0]?.id === game.user.id; // Lowest ID wins
    }
}

// Sequence tracking with automatic cleanup
const ACTION_SEQUENCES = new Map(); // playlistId -> { seq, timestamp }
const SEQUENCE_CLEANUP_INTERVAL = 60000; // Clean every minute
const SEQUENCE_MAX_AGE = 300000; // Keep sequences for 5 minutes
const SEQUENCE_MAX_SIZE = 100; // Hard limit on map size

/**
 * Cleans up old sequence numbers to prevent memory leak
 */
function cleanupOldSequences() {
    const now = Date.now();
    const entriesToDelete = [];

    for (const [playlistId, data] of ACTION_SEQUENCES.entries()) {
        if (now - data.timestamp > SEQUENCE_MAX_AGE) {
            entriesToDelete.push(playlistId);
        }
    }

    for (const id of entriesToDelete) {
        ACTION_SEQUENCES.delete(id);
    }

    if (entriesToDelete.length > 0) {
        debug(`[Sequence Cleanup] Removed ${entriesToDelete.length} old sequences`);
    }

    // Hard limit: if map is still too large, remove oldest entries
    if (ACTION_SEQUENCES.size > SEQUENCE_MAX_SIZE) {
        const entries = Array.from(ACTION_SEQUENCES.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp);

        const toRemove = entries.slice(0, ACTION_SEQUENCES.size - SEQUENCE_MAX_SIZE);
        for (const [id] of toRemove) {
            ACTION_SEQUENCES.delete(id);
        }

        debug(`[Sequence Cleanup] Hard limit: removed ${toRemove.length} oldest sequences`);
    }
}

// Start cleanup interval when module initializes
if (typeof window !== 'undefined') {
    setInterval(cleanupOldSequences, SEQUENCE_CLEANUP_INTERVAL);
}

export function getNextSequence(playlistId) {
    const current = ACTION_SEQUENCES.get(playlistId)?.seq || 0;
    const next = current + 1;
    ACTION_SEQUENCES.set(playlistId, { seq: next, timestamp: Date.now() });
    return next;
}

export function shouldProcessAction(playlistId, seq) {
    const data = ACTION_SEQUENCES.get(playlistId);
    const lastSeen = data?.seq || 0;

    if (seq <= lastSeen) return false; // Already processed

    ACTION_SEQUENCES.set(playlistId, { seq, timestamp: Date.now() });
    return true;
}

// Clean up when playlists are deleted
Hooks.on("deletePlaylist", (playlist) => {
    ACTION_SEQUENCES.delete(playlist.id);
    debug(`[Sequence Cleanup] Cleared sequences for deleted playlist: ${playlist.name}`);
});

/**
 * Feature-specific logging with consistent emoji prefixes
 */
export const LogSymbols = {
    // Playback control
    PLAY: '▶️',
    PAUSE: '⏸️',
    STOP: '⏹️',

    // Crossfade
    CROSSFADE: '🎭',
    CROSSFADE_SCHEDULE: '⏰',
    CROSSFADE_CANCEL: '❌',
    CROSSFADE_FIRE: '🔥',

    // Fade
    FADE_IN: '📈',
    FADE_OUT: '📉',

    // Loop
    LOOP: '🔄',
    LOOP_SEGMENT: '🎵',
    LOOP_SKIP: '⏭️',

    // Silence
    SILENCE: '🤫',
    SILENCE_END: '✅',

    // Playlist
    PLAYLIST_LOOP: '🔁',

    // System
    INIT: '🚀',
    CLEANUP: '🧹',
    ERROR: '⚠️',
    STATE: '💾',
    REUSE: '♻️'
};

/**
 * Compact feature logging
 * @param {string} symbol - Emoji symbol from LogSymbols
 * @param {string} feature - Feature name (e.g., "CF", "Loop", "Fade")
 * @param {string} message - Concise message
 * @param {any} [data] - Optional data object (will be logged separately)
 */
export function logFeature(symbol, feature, message, data) {
    if (!game?.settings) return;

    try {
        if (!game.settings.get(MODULE_ID, "debug")) return;

        const logMsg = `${symbol} [${feature}] ${message}`;

        if (data !== undefined) {
            console.log(`%c[${MODULE_ID}]`, "color: orange; font-weight: bold", logMsg, data);
        } else {
            console.log(`%c[${MODULE_ID}]`, "color: orange; font-weight: bold", logMsg);
        }
    } catch (err) {
        // Setting not registered yet
    }
}

/**
 * Safely stop a sound with proper error logging
 * @param {Sound} sound - The sound to stop
 * @param {string} context - Context description for debugging
 */
export function safeStop(sound, context = "unknown") {
    if (!sound) return;

    try {
        sound.stop();
    } catch (err) {
        debug(`[Safe Stop] Failed to stop sound in context: ${context}`, err.message);
    }
}

/**
 * Safely cancel a timer with proper error logging
 * @param {AudioTimeout|Object} timer - Timer or timer object to cancel
 * @param {string} context - Context description for debugging
 */
export function safeCancelTimer(timer, context = "unknown") {
    if (!timer) return;

    try {
        if (timer.timeout?.cancel) {
            timer.timeout.cancel();
        } else if (timer.cancel) {
            timer.cancel();
        }
    } catch (err) {
        debug(`[Safe Cancel] Failed to cancel timer in context: ${context}`, err.message);
    }
}

export class SoundOfSilenceDiagnostics extends FormApplication {
    constructor(options = {}) {
        super(options);
        this.hookId = null;
    }

    static get defaultOptions() {
        return mergeObject(super.defaultOptions, {
            id: "sos-diagnostics",
            title: "Sound of Silence - Diagnostics",
            template: `modules/${MODULE_ID}/templates/diagnostics.hbs`,
            width: 350,
            height: "auto",
            resizable: true,
            classes: ["sos-diagnostics-window"],
        });
    }

    getData() {
        return game.modules.get(MODULE_ID).api.inspectAll();
    }

    // OVERRIDE THE RENDER METHOD TO REGISTER THE HOOK
    async render(force = false, options = {}) {
        await super.render(force, options);

        // If the hook isn't already registered for this window, register it.
        if (this.hookId === null) {
            this.hookId = Hooks.on(`${MODULE_ID}.stateChanged`, () => {
                // When the state changes, simply re-render the window,
                // but ONLY if it's currently rendered and not in the process
                // of closing. This is the corrected condition.
                if (this._state === Application.RENDER_STATES.RENDERED) {
                    this.render(false);
                }
            });
            debug('[Diagnostics] Registered stateChanged hook.');
        }
        return this;
    }

    // OVERRIDE THE CLOSE METHOD TO UNREGISTER THE HOOK
    async close(options = {}) {
        if (this.hookId !== null) {
            Hooks.off(`${MODULE_ID}.stateChanged`, this.hookId);
            this.hookId = null;
            debug('[Diagnostics] Unregistered stateChanged hook.');
        }
        return super.close(options);
    }

    async _updateObject(event, formData) {
        // This window is read-only, so this does nothing.
    }
}