/**
 * @file flag-service.js
 * @description A centralized service for getting, setting, and validating all module flags.
 * This service is the single source of truth for module configuration on documents.
 */
import { MODULE_ID, toSec } from "./utils.js";
import { debug } from "./utils.js";

/**
 * Defines the schema for all module flags, including type, defaults, and validation rules.
 * This structure is used by the FlagService to ensure data integrity.
 */
const FlagSchemas = {
    PLAYLIST: {
        silenceEnabled: { type: Boolean, default: false },
        silenceMode: { type: String, default: "static", enum: ["static", "random"] },
        silenceDuration: { type: Number, default: 0, min: 0 },
        minDelay: { type: Number, default: 0, min: 0 },
        maxDelay: { type: Number, default: 0, min: 0 },
        crossfade: { type: Boolean, default: false },
        useCustomAutoFade: { type: Boolean, default: false },
        customAutoFadeMs: { type: Number, default: 1000, min: 0 },
        fadeIn: { type: Number, default: 0, min: 0 },
        loopPlaylist: { type: Boolean, default: false },
        volumeNormalizationEnabled: { type: Boolean, default: false },
        normalizedVolume: { type: Number, default: 0.5, min: 0, max: 1.0 },
    },
    PLAYLIST_SOUND: {
        isSilenceGap: { type: Boolean, default: false },
        allowVolumeOverride: { type: Boolean, default: false },
        loopWithin: {
            type: Object,
            default: {},
            schema: {
                enabled: { type: Boolean, default: false },
                active: { type: Boolean, default: true },
                startFromBeginning: { type: Boolean, default: true },
                segments: { type: Array, default: [] },
                // Legacy properties for migration, not for direct use
                start: { type: String, default: "00:00" },
                end: { type: String, default: "00:00" },
                crossfadeMs: { type: Number, default: 1000, min: 0 },
                skipCount: { type: Number, default: 0, min: 0 },
                loopCount: { type: Number, default: 0, min: 0 },
            },
        },
    },
};

class FlagService {
    constructor() {
        // Cache for validated flags to avoid re-validation on every access
        this._playlistCache = new WeakMap(); // playlist -> { flags, timestamp }
        this._soundCache = new WeakMap();    // sound -> { flags, timestamp }
        this._cacheTimeout = 1000; // 1 second cache TTL
    }

    // ============================================
    // Cache Management
    // ============================================

    /**
     * Clear cache for a specific document
     * @private
     */
    _clearCache(doc) {
        if (doc instanceof Playlist) {
            this._playlistCache.delete(doc);
        } else if (doc instanceof PlaylistSound) {
            this._soundCache.delete(doc);
        }
    }

    /**
     * Get cached flags if still valid
     * @private
     */
    _getCached(doc) {
        const cache = doc instanceof Playlist ? this._playlistCache : this._soundCache;
        const cached = cache.get(doc);

        if (!cached) return null;

        const now = Date.now();
        if (now - cached.timestamp > this._cacheTimeout) {
            cache.delete(doc);
            return null;
        }

        return cached.flags;
    }

    /**
     * Store flags in cache
     * @private
     */
    _setCache(doc, flags) {
        const cache = doc instanceof Playlist ? this._playlistCache : this._soundCache;
        cache.set(doc, {
            flags,
            timestamp: Date.now()
        });
    }

    // ============================================
    // Core Getters & Setters
    // ============================================

    /**
         * Gets a validated flag value for a Playlist document.
         * @param {Playlist} playlist The playlist document.
         * @param {string} key The flag key to retrieve.
         * @returns {any} The validated flag value, or its default if invalid.
         */
    getPlaylistFlag(playlist, key) {
        const schema = FlagSchemas.PLAYLIST[key];
        if (!schema) {
            console.warn(`[${MODULE_ID}] Unknown playlist flag key: ${key}`);
            return undefined;
        }

        // Try cache first
        const cached = this._getCached(playlist);
        if (cached) return cached[key];

        // Cache miss - validate all flags at once
        const flags = {};
        for (const flagKey in FlagSchemas.PLAYLIST) {
            const flagSchema = FlagSchemas.PLAYLIST[flagKey];
            const rawValue = playlist.getFlag(MODULE_ID, flagKey);
            flags[flagKey] = this._validate(rawValue, flagSchema);
        }

        this._setCache(playlist, flags);
        return flags[key];
    }

    /**
         * Gets a validated flag value for a PlaylistSound document.
         * @param {PlaylistSound} sound The sound document.
         * @param {string} key The flag key to retrieve.
         * @returns {any} The validated flag value, or its default if invalid.
         */
    getSoundFlag(sound, key) {
        const schema = FlagSchemas.PLAYLIST_SOUND[key];
        if (!schema) {
            console.warn(`[${MODULE_ID}] Unknown sound flag key: ${key}`);
            return undefined;
        }

        // Try cache first
        const cached = this._getCached(sound);
        if (cached) return cached[key];

        // Cache miss - validate all flags at once
        const flags = {};
        for (const flagKey in FlagSchemas.PLAYLIST_SOUND) {
            const flagSchema = FlagSchemas.PLAYLIST_SOUND[flagKey];
            const rawValue = sound.getFlag(MODULE_ID, flagKey);
            flags[flagKey] = this._validate(rawValue, flagSchema);
        }

        this._setCache(sound, flags);
        return flags[key];
    }

    /**
         * Retrieves all validated flags for a given playlist.
         * @param {Playlist} playlist The playlist document.
         * @returns {object} An object containing all validated flags.
         */
    getPlaylistFlags(playlist) {
        // Try cache first
        const cached = this._getCached(playlist);
        if (cached) return foundry.utils.duplicate(cached);

        // Cache miss - validate all flags
        const flags = {};
        for (const key in FlagSchemas.PLAYLIST) {
            const schema = FlagSchemas.PLAYLIST[key];
            const rawValue = playlist.getFlag(MODULE_ID, key);
            flags[key] = this._validate(rawValue, schema);
        }

        this._setCache(playlist, flags);
        return foundry.utils.duplicate(flags);
    }


    /**
         * Sets a flag value on a document after validation.
         * @param {Playlist | PlaylistSound} doc The document to update.
         * @param {string} key The flag key to set.
         * @param {any} value The value to set.
         * @returns {Promise<Document>} The updated document.
         */
    async setFlag(doc, key, value) {
        const schema = (doc.documentName === "Playlist")
            ? FlagSchemas.PLAYLIST[key]
            : FlagSchemas.PLAYLIST_SOUND[key];

        if (!schema) {
            throw new Error(`[${MODULE_ID}] Unknown flag key "${key}" for document type ${doc.documentName}`);
        }

        // Invalidate cache before updating
        this._clearCache(doc);

        return doc.setFlag(MODULE_ID, key, value);
    }

    // ============================================
    // Specialized & Computed Logic
    // ============================================

    /**
     * Gets the fully processed and migrated loop configuration for a sound.
     * This is the definitive method for retrieving loop data.
     * @param {PlaylistSound} sound The sound document.
     * @returns {object} The complete, validated, and migrated loop configuration.
     */
    getLoopConfig(sound) {
        const rawFlags = sound.getFlag(MODULE_ID, "loopWithin") ?? {};
        const migrated = this._migrateLegacyLoopFlags(rawFlags);
        const validatedConfig = this._validate(migrated, FlagSchemas.PLAYLIST_SOUND.loopWithin);

        // Validate each segment individually
        validatedConfig.segments = (validatedConfig.segments || []).map(seg => {
            const validated = {
                start: seg.start || "00:00",
                end: seg.end || "00:00",
                crossfadeMs: this._validateNumber(seg.crossfadeMs, 1000, 0), // min: 0
                loopCount: this._validateNumber(seg.loopCount, 0, 0), // min: 0
                skipToNext: typeof seg.skipToNext === "boolean" ? seg.skipToNext : false
            };
            
            // Add runtime-processed values for convenience
            validated.startSec = toSec(validated.start);
            validated.endSec = toSec(validated.end);
            
            return validated;
        });

        return validatedConfig;
    }

    /**
     * Computes the effective playback mode for a playlist.
     * Enforces the business rule: Crossfade overrides Silence.
     * @param {Playlist} playlist The playlist document.
     * @returns {{crossfade: boolean, silence: boolean, loopPlaylist: boolean}}
     */
    getPlaybackMode(playlist) {
        const crossfade = this.getPlaylistFlag(playlist, "crossfade");
        const silence = this.getPlaylistFlag(playlist, "silenceEnabled");
        const loopPlaylist = this.getPlaylistFlag(playlist, "loopPlaylist");
        return {
            crossfade,
            silence: crossfade ? false : silence, // Critical business logic
            loopPlaylist,
        };
    }

    /**
     * Gets the correct crossfade duration for a playlist based on its settings.
     * @param {Playlist} playlist The playlist document.
     * @returns {number} The crossfade duration in milliseconds.
     */
    getCrossfadeDuration(playlist) {
        const useCustom = this.getPlaylistFlag(playlist, "useCustomAutoFade");
        if (useCustom) {
            return this.getPlaylistFlag(playlist, "customAutoFadeMs");
        }
        return Number(playlist.fade) || 0;
    }

    /**
     * Gets the correct silence duration, accounting for static vs. random mode.
     * @param {Playlist} playlist The playlist document.
     * @returns {number} The silence duration in milliseconds.
     */
    getSilenceDuration(playlist) {
        const mode = this.getPlaylistFlag(playlist, "silenceMode");
        const staticDuration = this.getPlaylistFlag(playlist, "silenceDuration");

        if (mode === "random") {
            const min = this.getPlaylistFlag(playlist, "minDelay");
            const max = Math.max(min, this.getPlaylistFlag(playlist, "maxDelay"));

            if (min >= max) return min;

            const step = 100;
            const minStep = Math.ceil(min / step);
            const maxStep = Math.floor(max / step);
            const numSteps = maxStep - minStep + 1;

            if (numSteps <= 0) return min;

            const stepIndex = Math.floor(Math.random() * numSteps);
            return (minStep + stepIndex) * step;
        }

        return staticDuration;
    }

    /**
     * Checks if a sound's internal loop is configured to be active.
     * @param {PlaylistSound} sound The sound document.
     * @returns {boolean} True if the loop is both enabled and active.
     */
    isLoopActive(sound) {
        const config = this.getLoopConfig(sound);
        return config.enabled && config.active;
    }


    // ============================================
    // Private Helpers
    // ============================================

    /**
     * Validates a numeric value with optional min/max constraints
     * @private
     * @param {any} value - Value to validate
     * @param {number} defaultValue - Default if invalid
     * @param {number} [min] - Minimum allowed value
     * @param {number} [max] - Maximum allowed value
     * @returns {number} Validated number
     */
    _validateNumber(value, defaultValue, min, max) {
        const num = Number(value);
        if (!Number.isFinite(num)) return defaultValue;
        if (typeof min === "number" && num < min) return min;
        if (typeof max === "number" && num > max) return max;
        return num;
    }

    /**
     * Validates a value against a schema definition.
     * @private
     */
    _validate(value, schema) {
        if (value === null || typeof value === "undefined") {
            return foundry.utils.deepClone(schema.default);
        }

        switch (schema.type) {
            case Boolean:
                return typeof value === "boolean" ? value : schema.default;
            case Number: {
                const num = Number(value);
                if (!Number.isFinite(num)) return schema.default;
                if (typeof schema.min === "number" && num < schema.min) return schema.min;
                if (typeof schema.max === "number" && num > schema.max) return schema.max;
                return num;
            }
            case String: {
                const str = String(value);
                if (schema.enum && !schema.enum.includes(str)) return schema.default;
                return str;
            }
            case Array:
                return Array.isArray(value) ? value : foundry.utils.deepClone(schema.default);
            case Object: {
                if (typeof value !== "object" || Array.isArray(value)) {
                    return foundry.utils.deepClone(schema.default);
                }
                if (schema.schema) {
                    const validatedObj = {};
                    const defaultObj = this._validate(undefined, schema);
                    const merged = foundry.utils.mergeObject(defaultObj, value);

                    for (const key in schema.schema) {
                        validatedObj[key] = this._validate(merged[key], schema.schema[key]);
                    }
                    return validatedObj;
                }
                return value;
            }
            default:
                return value;
        }
    }

    /**
     * Migrates legacy flat loop format to the new segment-based structure.
     * @private
     */
    _migrateLegacyLoopFlags(rawFlags) {
        const flags = foundry.utils.duplicate(rawFlags ?? {});
        let segments = flags.segments;

        if (segments && !Array.isArray(segments)) {
            segments = Object.values(segments);
        }

        if ((!Array.isArray(segments) || segments.length === 0) && flags.end && flags.end !== "00:00") {
            debug("[FlagService] Migrating legacy loop format to segment structure.");
            segments = [{
                start: flags.start ?? "00:00",
                end: flags.end,
                // Preserve explicit 0 values, only default to 1000 if undefined/null
                crossfadeMs: flags.crossfadeMs !== undefined && flags.crossfadeMs !== null ? flags.crossfadeMs : 1000,
                loopCount: flags.loopCount ?? 0,
                skipToNext: false
            }];
        }

        flags.segments = segments || [];

        delete flags.start;
        delete flags.end;
        delete flags.crossfadeMs;
        delete flags.loopCount;

        return flags;
    }

    /**
     * Resolves the effective target volume for a PlaylistSound, accounting for
     * playlist-level volume normalization. This is the single source of truth for
     * "what volume should this sound be playing at?"
     * @param {PlaylistSound} ps The playlist sound document.
     * @returns {number} The target volume (0-1, logarithmic/converted scale).
     */
    resolveTargetVolume(ps) {
        const playlist = ps?.parent;
        if (!playlist) return ps?.volume ?? 1;

        const normEnabled = this.getPlaylistFlag(playlist, "volumeNormalizationEnabled");
        const hasOverride = this.getSoundFlag(ps, "allowVolumeOverride");

        if (normEnabled && !hasOverride) {
            const normalizedVolume = this.getPlaylistFlag(playlist, "normalizedVolume");
            return foundry.audio.AudioHelper.inputToVolume(normalizedVolume);
        }
        return ps.volume;
    }
}

/**
 * The singleton instance of the FlagService, exported for use throughout the module.
 */
export const Flags = new FlagService();

// Auto-invalidate cache when documents are updated
Hooks.on("updatePlaylist", (playlist) => {
    Flags._clearCache(playlist);
});

Hooks.on("updatePlaylistSound", (sound) => {
    Flags._clearCache(sound);
});