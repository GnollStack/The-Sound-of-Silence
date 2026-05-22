/**
 * @file flag-service.js
 * @description A centralized service for getting, setting, and validating all module flags.
 * This service is the single source of truth for module configuration on documents.
 */
import { MODULE_ID, toSec, debug, warn } from "./utils.js";

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
        soundscapeMode: { type: Boolean, default: false },
        soundscapeMaxPolyphony: { type: Number, default: 4, min: 1, max: 16 },
        soundscapePlayChanceScaling: { type: String, default: "independent", enum: ["independent", "scaled", "soft"] },
        soundscapeDefaults: {
            type: Object,
            default: {},
            schema: {
                minDelay: { type: Number, default: 15, min: 0, max: 3600 },
                maxDelay: { type: Number, default: 60, min: 0, max: 3600 },
                timingMode: { type: String, default: "uniform", enum: ["uniform", "fixed", "natural"] },
                initialFireMode: { type: String, default: "normal", enum: ["normal", "staggered", "immediate"] },
                volumeVariance: { type: Number, default: 0, min: 0, max: 1 },
                playChance: { type: Number, default: 100, min: 0, max: 100 },
                randomPan: { type: Boolean, default: false },
            },
        },
    },
    PLAYLIST_SOUND: {
        isSilenceGap: { type: Boolean, default: false },
        allowVolumeOverride: { type: Boolean, default: false },
        normalizedVolumeOverride: { type: Number, default: null, min: 0, max: 1 },
        isProcedural: { type: Boolean, default: false },
        minDelay: { type: Number, default: 15, min: 0, max: 3600 },
        maxDelay: { type: Number, default: 60, min: 0, max: 3600 },
        timingMode: { type: String, default: "uniform", enum: ["uniform", "fixed", "natural"] },
        initialFireMode: { type: String, default: "normal", enum: ["normal", "staggered", "immediate"] },
        volumeVariance: { type: Number, default: 0, min: 0, max: 1 },
        randomPan: { type: Boolean, default: false },
        playChance: { type: Number, default: 100, min: 0, max: 100 },
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
            warn(`[Flags] Unknown playlist flag key: ${key}`);
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
            warn(`[Flags] Unknown sound flag key: ${key}`);
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
        return this.validateLoopConfig(rawFlags);
    }

    /**
     * Validate playlist flags without reading or writing a Foundry document.
     * Used by diagnostics and tests.
     * @param {object} input Candidate flag data
     * @returns {object} Complete sanitized playlist flags
     */
    validatePlaylistFlags(input = {}) {
        const source = (input && typeof input === "object" && !Array.isArray(input)) ? input : {};
        const flags = {};
        for (const key in FlagSchemas.PLAYLIST) {
            flags[key] = this._validate(source[key], FlagSchemas.PLAYLIST[key]);
        }
        return foundry.utils.duplicate(flags);
    }

    /**
     * Validate playlist sound flags without reading or writing a Foundry document.
     * Used by diagnostics and tests.
     * @param {object} input Candidate flag data
     * @returns {object} Complete sanitized PlaylistSound flags
     */
    validateSoundFlags(input = {}) {
        const source = (input && typeof input === "object" && !Array.isArray(input)) ? input : {};
        const flags = {};
        for (const key in FlagSchemas.PLAYLIST_SOUND) {
            if (key === "loopWithin") {
                flags[key] = this.validateLoopConfig(source[key] ?? {});
            } else {
                flags[key] = this._validate(source[key], FlagSchemas.PLAYLIST_SOUND[key]);
            }
        }
        return foundry.utils.duplicate(flags);
    }

    /**
     * Validate loop configuration without reading or writing a Foundry document.
     * @param {object} input Candidate loopWithin data
     * @returns {object} Complete sanitized loop config with startSec/endSec
     */
    validateLoopConfig(input = {}) {
        const source = (input && typeof input === "object" && !Array.isArray(input)) ? input : {};
        const migrated = this._migrateLegacyLoopFlags(source);
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

        return foundry.utils.duplicate(validatedConfig);
    }

    getPlaylistFlagKeys() {
        return Object.keys(FlagSchemas.PLAYLIST);
    }

    getSoundFlagKeys() {
        return Object.keys(FlagSchemas.PLAYLIST_SOUND);
    }

    getLoopConfigKeys() {
        return Object.keys(FlagSchemas.PLAYLIST_SOUND.loopWithin.schema);
    }

    /**
     * Computes the effective playback mode for a playlist.
     * Enforces mutual exclusivity: Soundscape > Crossfade > Silence > Sequential.
     * @param {Playlist} playlist The playlist document.
     * @returns {{soundscape: boolean, crossfade: boolean, silence: boolean, loopPlaylist: boolean, effective: string}}
     */
    getPlaybackMode(playlist) {
        const soundscapeAllowed = playlist?.mode === CONST.PLAYLIST_MODES.DISABLED;
        const soundscape = soundscapeAllowed && this.getPlaylistFlag(playlist, "soundscapeMode");
        const crossfade = this.getPlaylistFlag(playlist, "crossfade");
        const silence = this.getPlaylistFlag(playlist, "silenceEnabled");
        const loopPlaylist = this.getPlaylistFlag(playlist, "loopPlaylist");

        // Higher-priority modes suppress lower ones.
        const effectiveCrossfade = soundscape ? false : crossfade;
        const effectiveSilence = (soundscape || effectiveCrossfade) ? false : silence;

        let effective = "sequential";
        if (soundscape) effective = "soundscape";
        else if (effectiveCrossfade) effective = "crossfade";
        else if (effectiveSilence) effective = "silence";

        return {
            soundscape,
            crossfade: effectiveCrossfade,
            silence: effectiveSilence,
            loopPlaylist,
            effective,
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
     * Resolve a procedural one-shot field with fallback:
     *   per-sound flag -> playlist soundscapeDefaults -> schema default.
     * Only defined for procedural fields (minDelay, maxDelay, timingMode,
     * initialFireMode, volumeVariance, playChance, randomPan) on PlaylistSound documents.
     * @param {PlaylistSound} ps
     * @param {"minDelay"|"maxDelay"|"timingMode"|"initialFireMode"|"volumeVariance"|"playChance"|"randomPan"} key
     * @returns {any}
     */
    resolveProceduralField(ps, key) {
        const soundSchema = FlagSchemas.PLAYLIST_SOUND[key];
        if (!soundSchema) return undefined;

        // Per-sound explicit value wins (read raw; getSoundFlag returns defaults).
        const raw = ps?.getFlag?.(MODULE_ID, key);
        if (raw !== null && typeof raw !== "undefined") {
            return this._validate(raw, soundSchema);
        }

        // Fall back to playlist defaults object.
        const playlist = ps?.parent;
        if (playlist) {
            const defaults = this.getPlaylistFlag(playlist, "soundscapeDefaults") ?? {};
            const override = defaults[key];
            if (override !== null && typeof override !== "undefined") {
                return this._validate(override, soundSchema);
            }
        }

        // Finally, schema default.
        return foundry.utils.deepClone(soundSchema.default);
    }

    /**
     * Resolves the shared GM mix target volume for a PlaylistSound, accounting
     * for playlist-level volume normalization but not client-local attenuation.
     * @param {PlaylistSound} ps The playlist sound document.
     * @returns {number} The target volume (0-1, logarithmic/converted scale).
     */
    resolveSharedTargetVolume(ps) {
        const playlist = ps?.parent;
        if (!playlist) return ps?.volume ?? 1;

        const normEnabled = this.getPlaylistFlag(playlist, "volumeNormalizationEnabled");
        const hasOverride = this.getSoundFlag(ps, "allowVolumeOverride");

        if (normEnabled && !hasOverride) {
            const normalizedVolume = this.getPlaylistFlag(playlist, "normalizedVolume");
            const overrideSnapshot = this.getSoundFlag(ps, "normalizedVolumeOverride");
            if (
                overrideSnapshot !== null &&
                typeof overrideSnapshot !== "undefined" &&
                Number.isFinite(Number(overrideSnapshot)) &&
                Math.abs(Number(overrideSnapshot) - Number(normalizedVolume)) < 0.0001
            ) {
                return ps.volume;
            }
            return foundry.audio.AudioHelper.inputToVolume(normalizedVolume);
        }
        return ps.volume;
    }

    /**
     * Clamp a numeric value into the 0-1 volume range.
     * @private
     */
    _clampVolume(value, fallback = 0) {
        const num = Number(value);
        if (!Number.isFinite(num)) return fallback;
        return Math.max(0, Math.min(1, num));
    }

    /**
     * Whether this non-GM client is using the opt-in personal audio mix.
     * GMs always remain on the shared authoritative mix.
     * @returns {boolean}
     */
    isPersonalAudioMixEnabled() {
        try {
            return !game.user?.isGM && !!game.settings?.get(MODULE_ID, "personalPlaylistVolumeEnabled");
        } catch (err) {
            return false;
        }
    }

    /**
     * Backwards-compatible alias for the original setting helper name.
     * @returns {boolean}
     */
    isPersonalPlaylistVolumeEnabled() {
        return this.isPersonalAudioMixEnabled();
    }

    /**
     * Get all stored personal playlist volume values for this client.
     * @returns {Object<string, number>}
     */
    getPersonalPlaylistVolumes() {
        try {
            const values = game.settings?.get(MODULE_ID, "personalPlaylistVolumes");
            return values && typeof values === "object" && !Array.isArray(values) ? values : {};
        } catch (err) {
            return {};
        }
    }

    /**
     * Whether this client has an explicit personal playlist value saved.
     * @param {Playlist|string} playlist Playlist document or id.
     * @returns {boolean}
     */
    hasPersonalPlaylistVolume(playlist) {
        const playlistId = typeof playlist === "string" ? playlist : playlist?.id;
        if (!playlistId) return false;
        return Object.prototype.hasOwnProperty.call(this.getPersonalPlaylistVolumes(), playlistId);
    }

    /**
     * Get this client's local playlist volume slider value.
     * @param {Playlist|string} playlist Playlist document or id.
     * @param {object} [options]
     * @param {number} [options.override] Transient slider value to apply before persistence.
     * @param {PlaylistSound} [options.fallbackSound] Sound used to derive the shared fallback slider value.
     * @param {boolean} [options.fallbackToShared=false] Return the shared slider value if no playlist value exists.
     * @returns {number} 0-1 slider/input value.
     */
    getPersonalPlaylistVolume(playlist, { override, fallbackSound, fallbackToShared = false } = {}) {
        if (!this.isPersonalAudioMixEnabled()) return 1;
        if (Number.isFinite(Number(override))) return this._clampVolume(override, 1);

        const playlistId = typeof playlist === "string" ? playlist : playlist?.id;
        if (!playlistId) return 1;

        const values = this.getPersonalPlaylistVolumes();
        const value = Number(values[playlistId]);
        if (Number.isFinite(value)) return this._clampVolume(value, 1);
        if (fallbackToShared && fallbackSound) {
            const shared = this.resolveSharedTargetVolume(fallbackSound);
            const input = foundry.audio.AudioHelper.volumeToInput(shared);
            return this._clampVolume(Number.isFinite(input) ? input : shared, 1);
        }
        return 1;
    }

    /**
     * Persist this client's local playlist volume slider value.
     * @param {Playlist|string} playlist Playlist document or id.
     * @param {number} value 0-1 slider/input value.
     * @returns {Promise<Object<string, number>>}
     */
    async setPersonalPlaylistVolume(playlist, value) {
        const playlistId = typeof playlist === "string" ? playlist : playlist?.id;
        if (!playlistId) return this.getPersonalPlaylistVolumes();

        const volumes = { ...this.getPersonalPlaylistVolumes() };
        if (!Number.isFinite(Number(value))) {
            delete volumes[playlistId];
        } else {
            volumes[playlistId] = this._clampVolume(value, 1);
        }

        await game.settings.set(MODULE_ID, "personalPlaylistVolumes", volumes);
        return volumes;
    }

    /**
     * Get all stored personal track slider values for this client.
     * @returns {Object<string, number>}
     */
    getPersonalTrackVolumes() {
        try {
            const values = game.settings?.get(MODULE_ID, "personalTrackVolumes");
            return values && typeof values === "object" && !Array.isArray(values) ? values : {};
        } catch (err) {
            return {};
        }
    }

    /**
     * Resolve the storage key for a personal track override.
     * @param {PlaylistSound|string} sound PlaylistSound document or UUID.
     * @returns {string|null}
     */
    getPersonalTrackVolumeKey(sound) {
        if (typeof sound === "string") return sound || null;
        return sound?.uuid ?? null;
    }

    /**
     * Whether this client has an explicit personal value saved for this track.
     * @param {PlaylistSound|string} sound PlaylistSound document or UUID.
     * @returns {boolean}
     */
    hasPersonalTrackVolume(sound) {
        const key = this.getPersonalTrackVolumeKey(sound);
        if (!key) return false;
        return Object.prototype.hasOwnProperty.call(this.getPersonalTrackVolumes(), key);
    }

    /**
     * Get the local track slider value. Missing entries fall back to the current
     * shared GM mix value so enabling personal audio does not jump volume.
     * @param {PlaylistSound} ps The playlist sound document.
     * @param {object} [options]
     * @param {number} [options.override] Transient slider value to apply before persistence.
     * @param {boolean} [options.fallbackToShared=true] Return the shared slider value if no override exists.
     * @returns {number|null} 0-1 slider/input value.
     */
    getPersonalTrackVolumeInput(ps, { override, fallbackToShared = true } = {}) {
        if (Number.isFinite(Number(override))) return this._clampVolume(override, 1);

        const key = this.getPersonalTrackVolumeKey(ps);
        const values = this.getPersonalTrackVolumes();
        const value = key ? Number(values[key]) : NaN;
        if (Number.isFinite(value)) return this._clampVolume(value, 1);
        if (!fallbackToShared) return null;

        if (ps?.parent && this.hasPersonalPlaylistVolume(ps.parent)) {
            return this.getPersonalPlaylistVolume(ps.parent);
        }

        const shared = this.resolveSharedTargetVolume(ps);
        const input = foundry.audio.AudioHelper.volumeToInput(shared);
        return this._clampVolume(Number.isFinite(input) ? input : shared, 1);
    }

    /**
     * Persist this client's local track slider value.
     * @param {PlaylistSound|string} sound PlaylistSound document or UUID.
     * @param {number} value 0-1 slider/input value.
     * @returns {Promise<Object<string, number>>}
     */
    async setPersonalTrackVolume(sound, value) {
        const key = this.getPersonalTrackVolumeKey(sound);
        if (!key) return this.getPersonalTrackVolumes();

        const num = Number(value);
        if (!Number.isFinite(num)) return this.getPersonalTrackVolumes();

        const volumes = { ...this.getPersonalTrackVolumes(), [key]: this._clampVolume(num, 1) };
        await game.settings.set(MODULE_ID, "personalTrackVolumes", volumes);
        return volumes;
    }

    /**
     * Persist one local track slider value for every sound in a playlist.
     * @param {Playlist} playlist Playlist document.
     * @param {number} value 0-1 slider/input value.
     * @returns {Promise<Object<string, number>>}
     */
    async setPersonalTrackVolumesForPlaylist(playlist, value) {
        if (!playlist?.sounds) return this.getPersonalTrackVolumes();

        const num = Number(value);
        if (!Number.isFinite(num)) return this.getPersonalTrackVolumes();

        const nextValue = this._clampVolume(num, 1);
        const volumes = { ...this.getPersonalTrackVolumes() };
        for (const sound of playlist.sounds) {
            const key = this.getPersonalTrackVolumeKey(sound);
            if (key) volumes[key] = nextValue;
        }

        await game.settings.set(MODULE_ID, "personalTrackVolumes", volumes);
        return volumes;
    }

    /**
     * Clear all local track-specific values for a playlist so those tracks
     * fall back to the client's personal playlist volume.
     * @param {Playlist} playlist Playlist document.
     * @returns {Promise<Object<string, number>>}
     */
    async clearPersonalTrackVolumesForPlaylist(playlist) {
        if (!playlist?.sounds) return this.getPersonalTrackVolumes();

        const volumes = { ...this.getPersonalTrackVolumes() };
        let changed = false;
        for (const sound of playlist.sounds) {
            const key = this.getPersonalTrackVolumeKey(sound);
            if (!key || !Object.prototype.hasOwnProperty.call(volumes, key)) continue;
            delete volumes[key];
            changed = true;
        }

        if (changed) await game.settings.set(MODULE_ID, "personalTrackVolumes", volumes);
        return volumes;
    }

    /**
     * Apply this client's local playlist volume to a volume. This helper is
     * retained for callers that only have a Playlist, not a PlaylistSound.
     * @param {Playlist} playlist
     * @param {number} volume
     * @param {object} [options]
     * @param {number} [options.playlistVolume] Transient playlist slider value.
     * @returns {number}
     */
    applyPersonalPlaylistVolume(playlist, volume, { playlistVolume } = {}) {
        const clamped = this._clampVolume(volume, 0);
        if (!this.isPersonalAudioMixEnabled()) return clamped;
        if (!Number.isFinite(Number(playlistVolume)) && !this.hasPersonalPlaylistVolume(playlist)) return clamped;

        const input = this.getPersonalPlaylistVolume(playlist, { override: playlistVolume });
        const localVolume = foundry.audio.AudioHelper.inputToVolume(input);
        return this._clampVolume(Number.isFinite(localVolume) ? localVolume : clamped, 0);
    }

    /**
     * Resolves the effective target volume for live playback on this client.
     * @param {PlaylistSound} ps The playlist sound document.
     * @param {object} [options]
     * @param {number} [options.sharedVolume] Shared GM target to use instead of recomputing.
     * @param {number} [options.trackInput] Transient local track slider value.
     * @param {number} [options.playlistVolume] Transient local playlist slider value.
     * @returns {number} The target volume (0-1, logarithmic/converted scale).
     */
    resolveTargetVolume(ps, { sharedVolume, trackInput, playlistVolume } = {}) {
        const shared = Number.isFinite(Number(sharedVolume))
            ? this._clampVolume(sharedVolume, 0)
            : this._clampVolume(this.resolveSharedTargetVolume(ps), 0);

        if (!this.isPersonalAudioMixEnabled()) return shared;

        const hasPlaylistInput = Number.isFinite(Number(playlistVolume));
        const hasPlaylistOverride = hasPlaylistInput || this.hasPersonalPlaylistVolume(ps?.parent);
        const hasTrackInput = Number.isFinite(Number(trackInput));
        const hasTrackOverride = hasTrackInput || this.hasPersonalTrackVolume(ps);
        if (!hasPlaylistOverride && !hasTrackOverride) return shared;

        const input = hasPlaylistInput
            ? this.getPersonalPlaylistVolume(ps?.parent, { override: playlistVolume })
            : (hasTrackOverride
                ? this.getPersonalTrackVolumeInput(ps, {
                    override: trackInput,
                    fallbackToShared: true,
                })
                : this.getPersonalPlaylistVolume(ps?.parent));
        let localTrackVolume = foundry.audio.AudioHelper.inputToVolume(input);
        if (!Number.isFinite(localTrackVolume)) localTrackVolume = shared;

        if (Number.isFinite(Number(sharedVolume))) {
            const sharedBase = this._clampVolume(this.resolveSharedTargetVolume(ps), 0);
            const varianceFactor = sharedBase > 0 ? shared / sharedBase : 1;
            if (Number.isFinite(varianceFactor)) localTrackVolume *= varianceFactor;
        }

        return this._clampVolume(localTrackVolume, 0);
    }
}

/**
 * The singleton instance of the FlagService, exported for use throughout the module.
 */
export const Flags = new FlagService();
let hooksRegistered = false;

export function registerFlagServiceHooks() {
    if (hooksRegistered) return;
    hooksRegistered = true;

    // Auto-invalidate cache when documents are updated.
    Hooks.on("updatePlaylist", (playlist) => {
        Flags._clearCache(playlist);
    });

    Hooks.on("updatePlaylistSound", (sound) => {
        Flags._clearCache(sound);
    });
}
