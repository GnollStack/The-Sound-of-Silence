// procedural-ambience.js
/**
 * @file procedural-ambience.js
 * @description Soundscape Mode engine. Treats a playlist as two layers:
 *   - Bed tracks (repeat=true) can be started and stopped manually as background.
 *   - Procedural one-shots (isProcedural=true) fire on local, randomized timers
 *     with optional volume variance, stereo pan, and play-chance.
 *
 * Procedural one-shot fires are GM-authored and socket-synced by default.
 * Players may opt out client-side; opted-out clients keep the older local RNG
 * behavior while still following replicated playlist/sound document state.
 */

import { Flags } from "./flag-service.js";
import { State } from "./state-manager.js";
import {
    MODULE_ID,
    debug,
    warn,
    error,
    ensureAudioContext,
    safeStop,
    safeCancelTimer,
} from "./utils.js";
import { advancedFade, fadeOutAndStop } from "./audio-fader.js";

const AudioTimeout = foundry.audio.AudioTimeout;
const RETRY_BACKOFF_MS = 250;
const DEFAULT_FADE_MS = 500;
const SYNCED_FIRE_ACTION = "soundscape-procedural-fire";
const SYNCED_FIRE_LEAD_MS = 600;
const SYNCED_FIRE_LATE_MS = 1000;
const SYNCED_EVENT_HISTORY_LIMIT = 20;

export function isSoundscapeProceduralSyncEnabled() {
    try {
        return game.settings?.get(MODULE_ID, "soundscapeProceduralSyncEnabled") !== false;
    } catch (_) {
        return true;
    }
}

function _getSocketId() {
    return game.socket?.id ?? game.socket?.socket?.id ?? null;
}

function _clamp01(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

function _mapToObject(map) {
    return Object.fromEntries(Array.from(map ?? []));
}

function _limitHistory(list) {
    while (list.length > SYNCED_EVENT_HISTORY_LIMIT) list.shift();
}

function _notifySoundscapeUi(playlist, reason, soundId = null) {
    State.notifyStateChanged({
        soundscapeOnly: true,
        reason,
        playlistId: playlist?.id ?? null,
        soundId,
    });
}

function _resolveFadeOutMs(playlist) {
    const fade = Number(playlist?.fade);
    return Number.isFinite(fade) && fade >= 0 ? fade : DEFAULT_FADE_MS;
}

function _resolveFadeInMs(playlist) {
    // Per-playlist custom fade-in flag wins (matches fade-in.js semantics for
    // normal first-play). Falls back to the playlist's native fade duration.
    const customFadeIn = Number(Flags.getPlaylistFlag(playlist, "fadeIn") ?? 0);
    if (Number.isFinite(customFadeIn) && customFadeIn > 0) return customFadeIn;
    return _resolveFadeOutMs(playlist);
}

/**
 * Engine managing a single playlist's procedural ambience session.
 * One instance per playing soundscape playlist, stored in State._soundscapeEngines.
 */
export class SoundscapeEngine {
    /**
     * @param {Playlist} playlist
     */
    constructor(playlist) {
        this.playlist = playlist;
        this.playlistId = playlist.id;

        this.isDestroyed = false;
        this.isStarted = false;

        /** @type {Map<string, {timer: AudioTimeout, eta: number}>} soundId -> armed timer */
        this.oneShotTimers = new Map();

        /** @type {Set<foundry.audio.Sound>} currently audible one-shot Sound instances */
        this.activeOneShots = new Set();

        /** @type {number} one-shot fires that passed the cap check but are still loading */
        this.pendingOneShotTotal = 0;

        /** @type {Map<string, number>} soundId -> pending load/play reservation count */
        this.pendingOneShotCounts = new Map();

        /** @type {Map<string, number>} soundId -> active instance count */
        this.activeOneShotCounts = new Map();

        /** @type {WeakMap<foundry.audio.Sound, {soundId: string, varianceFactor: number}>} active one-shot volume metadata */
        this.oneShotSharedTargetVolumes = new WeakMap();

        /** @type {WeakMap<foundry.audio.Sound, {panner: StereoPannerNode, panValue: number}>} */
        this.panners = new WeakMap();

        /** @type {Set<string>} ids of configured bed sounds in this playlist */
        this.bedSoundIds = new Set();

        this.syncedFireSeq = 0;
        this.processedSyncedEventIds = new Set();
        this.lastSyncedSeqBySound = new Map();
        this.recentSyncedEvents = [];
        this.missedSyncedEvents = [];
    }

    /**
     * Resolve per-playlist max polyphony with safe clamp.
     * @returns {number}
     */
    get maxPolyphony() {
        return Flags.getPlaylistFlag(this.playlist, "soundscapeMaxPolyphony") ?? 4;
    }

    get soundscapeSyncEnabled() {
        return isSoundscapeProceduralSyncEnabled();
    }

    get syncMode() {
        if (!this.soundscapeSyncEnabled) return "local";
        return game.user?.isGM ? "authority" : "synced";
    }

    _shouldArmLocalProcedurals() {
        return this.syncMode !== "synced";
    }

    _shouldEmitSyncedFires() {
        return this.syncMode === "authority";
    }

    /**
     * Start the soundscape. Record eligible bed tracks and arm procedural timers.
     * Safe to call once per engine instance.
     */
    async start() {
        if (this.isStarted || this.isDestroyed) return;
        this.isStarted = true;

        ensureAudioContext();

        const beds = [];
        const procedurals = [];
        for (const ps of this.playlist.sounds) {
            if (Flags.getSoundFlag(ps, "isSilenceGap")) continue;
            if (Flags.getSoundFlag(ps, "isProcedural")) {
                procedurals.push(ps);
            } else {
                // Any non-gap, non-procedural sound is a bed: it may be started
                // by playAll or manually via the soundboard. Tracking it here
                // ensures destroy({stopBeds:true}) stops manually-started beds too.
                beds.push(ps);
            }
        }

        debug(
            `[Soundscape] Starting "${this.playlist.name}" — ` +
            `${beds.length} bed(s), ${procedurals.length} procedural(s)`
        );

        for (const bed of beds) {
            this.bedSoundIds.add(bed.id);
        }

        // AudioTimeout needs a live Foundry audio context, which only exists
        // after the client's first unlock gesture.
        if (procedurals.length && game.audio?.locked) {
            await game.audio.unlock;
            if (this.isDestroyed) return;
            ensureAudioContext();
        }

        // Every client arms its own procedural timers with local RNG.
        // Only arm procedurals whose document is currently marked playing —
        // playAll flips them all on, individual playSound leaves them off.
        // Users add/remove procedurals later via the per-sound play/stop buttons.
        if (this._shouldArmLocalProcedurals()) {
            for (const ps of procedurals) {
                if (ps.playing) this._armOneShot(ps, { initial: true });
            }
        }

        Hooks.callAll(`${MODULE_ID}.soundscapeStart`, {
            playlist: this.playlist,
            bedCount: beds.length,
            proceduralCount: procedurals.length,
        });
    }

    /**
     * Arm (or re-arm) the next fire timer for a procedural sound.
     * @param {PlaylistSound} ps
     * @param {{minimumDelayMs?: number, initial?: boolean}} [options]
     */
    _armOneShot(ps, { minimumDelayMs = 0, initial = false } = {}) {
        if (this.isDestroyed) return;
        // Only arm for procedurals the user has marked active on the document.
        // Covers the updatePlaylistSound disarm path and all internal re-arms.
        if (!ps.playing) return;

        // Cancel any existing timer for this sound (defensive).
        const existing = this.oneShotTimers.get(ps.id);
        if (existing?.timer) safeCancelTimer(existing.timer, `arm rearm ${ps.name}`);

        const delayMs = Math.max(minimumDelayMs, this._pickDelayMs(ps, { initial }));
        const eta = Date.now() + delayMs;

        const timer = new AudioTimeout(delayMs);
        this.oneShotTimers.set(ps.id, { timer, eta });
        _notifySoundscapeUi(this.playlist, "soundscape-one-shot-armed", ps.id);

        debug(
            `[Soundscape] Armed "${ps.name}" for ${(delayMs / 1000).toFixed(1)}s ` +
            `(occupied ${this._getOccupiedPolyphony()}/${this.maxPolyphony})`
        );

        timer.complete.then(() => {
            if (this.isDestroyed) return;
            this._fireOneShot(ps).catch((err) => {
                warn(`[Soundscape] Fire failed for "${ps.name}":`, err?.message);
                if (!this.isDestroyed && ps.playing) this._armOneShot(ps, { minimumDelayMs: RETRY_BACKOFF_MS });
            });
        }).catch(() => {
            // Timer cancelled — intentional, nothing to do.
        });
    }

    /**
     * Pick a delay for a procedural sound using its configured cadence mode.
     * Delays are the gap after the previous playback attempt settles.
     * @param {PlaylistSound} ps
     * @param {{initial?: boolean}} [options]
     * @returns {number} milliseconds
     */
    _pickDelayMs(ps, { initial = false } = {}) {
        const { min, max } = this._resolveDelayWindow(ps);
        const mode = Flags.resolveProceduralField(ps, "timingMode");
        let seconds;

        switch (mode) {
            case "fixed":
                seconds = min;
                break;

            case "natural": {
                // Triangular distribution centered on the midpoint. This feels
                // less synthetic than a flat uniform roll while still honoring
                // the configured min/max window.
                const roll = (Math.random() + Math.random()) / 2;
                seconds = min + roll * (max - min);
                break;
            }

            case "uniform":
            default:
                seconds = min + Math.random() * (max - min);
                break;
        }

        let delayMs = Math.max(0, seconds * 1000);
        if (initial) {
            delayMs = this._applyInitialFireMode(ps, delayMs, { min, max });
        }
        return delayMs;
    }

    /**
     * Resolve a procedural sound's delay window, swapping min/max if needed.
     * @param {PlaylistSound} ps
     * @returns {{min: number, max: number}}
     */
    _resolveDelayWindow(ps) {
        let min = Flags.resolveProceduralField(ps, "minDelay") ?? 15;
        let max = Flags.resolveProceduralField(ps, "maxDelay") ?? 60;
        if (max < min) [min, max] = [max, min];
        return { min, max };
    }

    /**
     * Average cadence gap in milliseconds for a procedural sound.
     * @param {PlaylistSound} ps
     * @param {{min?: number, max?: number}} [window]
     * @returns {number}
     */
    _getAverageDelayMs(ps, { min, max } = {}) {
        const delayMin = Number.isFinite(min) ? min : this._resolveDelayWindow(ps).min;
        const delayMax = Number.isFinite(max) ? max : this._resolveDelayWindow(ps).max;
        const mode = Flags.resolveProceduralField(ps, "timingMode");
        const avgSec = mode === "fixed" ? delayMin : (delayMin + delayMax) / 2;
        return Math.max(0, avgSec * 1000);
    }

    /**
     * Apply first-fire startup behavior on initial arm.
     * @param {PlaylistSound} ps
     * @param {number} baseDelayMs
     * @param {{min: number, max: number}} window
     * @returns {number}
     */
    _applyInitialFireMode(ps, baseDelayMs, { min, max }) {
        const mode = Flags.resolveProceduralField(ps, "initialFireMode");
        if (mode === "immediate") return 0;
        if (mode !== "staggered") return baseDelayMs;

        const activeProceduralIds = this.playlist.playbackOrder.filter((soundId) => {
            const sound = this.playlist.sounds.get(soundId);
            return sound?.playing && Flags.getSoundFlag(sound, "isProcedural");
        });
        if (activeProceduralIds.length < 2) return baseDelayMs;

        const index = activeProceduralIds.indexOf(ps.id);
        if (index < 0) return baseDelayMs;

        const startupWindowMs = Math.max(1000, this._getAverageDelayMs(ps, { min, max }));
        const staggerFloor =
            ((index + 1) / (activeProceduralIds.length + 1)) * startupWindowMs;
        return Math.max(baseDelayMs, staggerFloor);
    }

    /**
     * Fire a single procedural one-shot. Checks polyphony cap and playChance first.
     * The next randomized timer begins only after this playback attempt fully settles.
     * @param {PlaylistSound} ps
     * @param {{bypassChance?: boolean}} [options]
     * @returns {Promise<boolean>} true when playback was started
     */
    async _fireOneShot(ps, { bypassChance = false } = {}) {
        if (this.isDestroyed) return false;
        this.oneShotTimers.delete(ps.id);
        _notifySoundscapeUi(this.playlist, "soundscape-one-shot-timer", ps.id);

        if (!ps.playing) {
            debug(`[Soundscape] Skipping "${ps.name}" because it is no longer active`);
            return false;
        }

        // Polyphony cap — if saturated, skip this fire and re-arm.
        if (this._getOccupiedPolyphony() >= this.maxPolyphony) {
            debug(`[Soundscape] Polyphony cap reached (${this._getOccupiedPolyphony()}), skipping "${ps.name}"`);
            if (!this.isDestroyed) this._armOneShot(ps, { minimumDelayMs: RETRY_BACKOFF_MS });
            return false;
        }

        // Play chance — probabilistic skip (optionally scaled by active polyphony).
        const effectiveChance = this._resolveEffectivePlayChance(ps);
        if (!bypassChance && effectiveChance < 100 && (Math.random() * 100) >= effectiveChance) {
            debug(`[Soundscape] playChance skip for "${ps.name}" (${effectiveChance.toFixed(0)}%)`);
            if (!this.isDestroyed) this._armOneShot(ps, { minimumDelayMs: RETRY_BACKOFF_MS });
            return false;
        }

        const synced = this._shouldEmitSyncedFires();
        const recipe = this._createFireRecipe(ps, { synced });
        if (synced) this._emitSyncedFire(recipe);
        return this._playOneShotRecipe(ps, recipe, {
            rearmAfter: true,
            source: synced ? "authority" : "local",
        });
    }

    _createFireRecipe(ps, { synced = false } = {}) {
        const baseVol = Flags.resolveSharedTargetVolume(ps);
        const variancePct = Flags.resolveProceduralField(ps, "volumeVariance") ?? 0;
        let sharedTargetVol = baseVol;
        if (variancePct > 0) {
            const offset = (Math.random() * 2 - 1) * variancePct;
            sharedTargetVol = _clamp01(baseVol * (1 + offset), baseVol);
        }
        const varianceFactor = baseVol > 0 ? sharedTargetVol / baseVol : 1;
        const randomPan = Flags.resolveProceduralField(ps, "randomPan");
        const panValue = randomPan ? Math.max(-1, Math.min(1, Math.random() * 2 - 1)) : null;
        const now = Date.now();
        const seq = synced ? this.syncedFireSeq + 1 : null;
        if (synced) this.syncedFireSeq = seq;

        return {
            action: SYNCED_FIRE_ACTION,
            playlistId: this.playlist.id,
            soundId: ps.id,
            seq,
            eventId: synced ? `${this.playlist.id}:${ps.id}:${seq}:${game.user?.id ?? "gm"}:${now}` : null,
            startAtMs: synced ? now + SYNCED_FIRE_LEAD_MS : now,
            leadMs: synced ? SYNCED_FIRE_LEAD_MS : 0,
            sharedTargetVol,
            varianceFactor: Number.isFinite(varianceFactor) ? varianceFactor : 1,
            panValue,
            fadeInMs: _resolveFadeInMs(this.playlist),
            gmId: game.user?.id ?? null,
        };
    }

    _normalizeFireRecipe(recipe, ps) {
        const baseVol = Flags.resolveSharedTargetVolume(ps);
        const sharedTargetVol = _clamp01(recipe?.sharedTargetVol, baseVol);
        const variance = Number(recipe?.varianceFactor);
        const startAt = Number(recipe?.startAtMs);
        const lead = Number(recipe?.leadMs);
        const seq = Number(recipe?.seq);
        const pan = Number(recipe?.panValue);
        const fadeIn = Number(recipe?.fadeInMs);
        return {
            action: SYNCED_FIRE_ACTION,
            playlistId: recipe?.playlistId ?? this.playlist.id,
            soundId: recipe?.soundId ?? ps.id,
            seq: Number.isFinite(seq) ? seq : null,
            eventId: recipe?.eventId ? String(recipe.eventId) : null,
            startAtMs: Number.isFinite(startAt) ? startAt : Date.now(),
            leadMs: Number.isFinite(lead) ? lead : 0,
            sharedTargetVol,
            varianceFactor: Number.isFinite(variance)
                ? variance
                : (baseVol > 0 ? sharedTargetVol / baseVol : 1),
            panValue: Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : null,
            fadeInMs: Number.isFinite(fadeIn) ? Math.max(0, fadeIn) : _resolveFadeInMs(this.playlist),
            gmId: recipe?.gmId ?? null,
        };
    }

    _summarizeFireRecipe(recipe, extra = {}) {
        const startAtMs = Number(recipe?.startAtMs);
        const now = Date.now();
        return {
            timeMs: now,
            playlistId: recipe?.playlistId ?? this.playlist.id,
            soundId: recipe?.soundId ?? null,
            seq: Number.isFinite(Number(recipe?.seq)) ? Number(recipe.seq) : null,
            eventId: recipe?.eventId ?? null,
            startAtMs: Number.isFinite(startAtMs) ? startAtMs : null,
            receivedDeltaMs: Number.isFinite(startAtMs) ? now - startAtMs : null,
            leadMs: Number.isFinite(Number(recipe?.leadMs)) ? Number(recipe.leadMs) : null,
            sharedTargetVol: Number.isFinite(Number(recipe?.sharedTargetVol)) ? Number(recipe.sharedTargetVol) : null,
            varianceFactor: Number.isFinite(Number(recipe?.varianceFactor)) ? Number(recipe.varianceFactor) : null,
            panValue: Number.isFinite(Number(recipe?.panValue)) ? Number(recipe.panValue) : null,
            fadeInMs: Number.isFinite(Number(recipe?.fadeInMs)) ? Number(recipe.fadeInMs) : null,
            gmId: recipe?.gmId ?? null,
            ...extra,
        };
    }

    _recordSyncedEvent(recipe, extra = {}) {
        const entry = this._summarizeFireRecipe(recipe, extra);
        if (entry.eventId) {
            const index = this.recentSyncedEvents.findIndex((event) => event.eventId === entry.eventId);
            if (index >= 0) {
                this.recentSyncedEvents[index] = {
                    ...this.recentSyncedEvents[index],
                    ...entry,
                };
            } else {
                this.recentSyncedEvents.push(entry);
            }
        } else {
            this.recentSyncedEvents.push(entry);
        }
        _limitHistory(this.recentSyncedEvents);
    }

    _recordMissedSyncedEvent(recipe, reason, extra = {}) {
        this.missedSyncedEvents.push(this._summarizeFireRecipe(recipe, {
            reason,
            ...extra,
        }));
        _limitHistory(this.missedSyncedEvents);
    }

    _rememberSyncedEvent(recipe) {
        if (!recipe?.eventId) return;
        this.processedSyncedEventIds.add(recipe.eventId);
        while (this.processedSyncedEventIds.size > SYNCED_EVENT_HISTORY_LIMIT * 4) {
            const first = this.processedSyncedEventIds.values().next().value;
            this.processedSyncedEventIds.delete(first);
        }
        if (Number.isFinite(Number(recipe.seq))) {
            const previous = this.lastSyncedSeqBySound.get(recipe.soundId) ?? 0;
            this.lastSyncedSeqBySound.set(recipe.soundId, Math.max(previous, Number(recipe.seq)));
        }
    }

    _emitSyncedFire(recipe) {
        if (!recipe?.eventId) return;
        this._recordSyncedEvent(recipe, { source: "authority", status: "emitted" });
        game.socket?.emit(`module.${MODULE_ID}`, {
            ...recipe,
            senderSocketId: _getSocketId(),
        });
    }

    _isAudioLockedForSyncedFire() {
        const audio = game.audio ?? null;
        if (!audio) return "no-audio";
        if (audio.locked === true || audio.unlocked === false) return "audio-locked";
        const ctx = audio.environment ?? audio.music ?? audio.interface ?? null;
        if (!ctx) return "no-audio-context";
        if (ctx.state === "closed") return "audio-context-closed";
        return null;
    }

    async executeSyncedFire(recipe = {}) {
        if (this.isDestroyed) return false;
        if (!this.soundscapeSyncEnabled) return false;
        if (String(recipe.playlistId ?? "") !== String(this.playlist.id)) return false;

        const ps = this.playlist.sounds.get(recipe.soundId);
        if (!ps || !Flags.getSoundFlag(ps, "isProcedural")) return false;

        const normalized = this._normalizeFireRecipe(recipe, ps);
        if (!normalized.eventId) {
            this._recordMissedSyncedEvent(normalized, "missing-event-id");
            return false;
        }
        if (this.processedSyncedEventIds.has(normalized.eventId)) return false;

        const previousSeq = this.lastSyncedSeqBySound.get(normalized.soundId) ?? 0;
        if (Number.isFinite(Number(normalized.seq)) && normalized.seq <= previousSeq) {
            this._recordMissedSyncedEvent(normalized, "stale-sequence");
            return false;
        }
        this._rememberSyncedEvent(normalized);

        if (!ps.playing) {
            this._recordMissedSyncedEvent(normalized, "inactive-document");
            return false;
        }

        const lateByMs = Date.now() - normalized.startAtMs;
        if (lateByMs > SYNCED_FIRE_LATE_MS) {
            this._recordMissedSyncedEvent(normalized, "late", { lateByMs });
            return false;
        }

        this._recordSyncedEvent(normalized, { source: "synced", status: "received" });
        return this._playOneShotRecipe(ps, normalized, {
            rearmAfter: false,
            source: "synced",
        });
    }

    async _playOneShotRecipe(ps, recipe = {}, { rearmAfter = true, source = "local" } = {}) {
        const normalized = this._normalizeFireRecipe(recipe, ps);
        const isSyncedEvent = Boolean(normalized.eventId);
        const canRearm = () => rearmAfter && this._shouldArmLocalProcedurals();

        if (this._getOccupiedPolyphony() >= this.maxPolyphony) {
            if (isSyncedEvent) this._recordMissedSyncedEvent(normalized, "polyphony");
            if (canRearm() && !this.isDestroyed && ps.playing) {
                this._armOneShot(ps, { minimumDelayMs: RETRY_BACKOFF_MS });
            }
            return false;
        }

        let reservationActive = true;
        this._reserveOneShot(ps.id);
        const releaseReservation = () => {
            if (!reservationActive) return;
            reservationActive = false;
            this._releaseOneShotReservation(ps.id);
        };

        const waitMs = Math.max(0, normalized.startAtMs - Date.now());
        if (waitMs > 0) await AudioTimeout.wait(waitMs);

        if (this.isDestroyed || !ps.playing) {
            releaseReservation();
            if (isSyncedEvent) this._recordMissedSyncedEvent(normalized, "aborted-before-load");
            return false;
        }

        if (isSyncedEvent && Date.now() - normalized.startAtMs > SYNCED_FIRE_LATE_MS) {
            releaseReservation();
            this._recordMissedSyncedEvent(normalized, "late-after-wait", {
                lateByMs: Date.now() - normalized.startAtMs,
            });
            return false;
        }

        const audioBlocker = source === "synced" ? this._isAudioLockedForSyncedFire() : null;
        if (audioBlocker) {
            releaseReservation();
            this._recordMissedSyncedEvent(normalized, audioBlocker);
            return false;
        }

        ensureAudioContext();
        const targetVol = Flags.resolveTargetVolume(ps, {
            sharedVolume: normalized.sharedTargetVol,
        });

        let sound;
        try {
            sound = new foundry.audio.Sound(ps.path, {
                context: ps.sound?.context ?? ps.context,
            });
            await sound.load();
        } catch (err) {
            releaseReservation();
            if (isSyncedEvent) this._recordMissedSyncedEvent(normalized, "load-failed", {
                message: err?.message ?? null,
            });
            error(`[Soundscape] Failed to load "${ps.name}":`, err);
            if (canRearm() && !this.isDestroyed && ps.playing) {
                this._armOneShot(ps, { minimumDelayMs: RETRY_BACKOFF_MS });
            }
            return false;
        }

        if (this.isDestroyed || !ps.playing) {
            releaseReservation();
            safeStop(sound, "soundscape fire aborted");
            if (isSyncedEvent) this._recordMissedSyncedEvent(normalized, "aborted-after-load");
            return false;
        }

        if (Number.isFinite(normalized.panValue)) {
            this._attachPanner(sound, normalized.panValue);
        }

        sound._sosProceduralId = ps.id;
        sound._sosProceduralEventId = normalized.eventId;
        this.activeOneShots.add(sound);
        this.oneShotSharedTargetVolumes.set(sound, {
            soundId: ps.id,
            varianceFactor: normalized.varianceFactor,
            eventId: normalized.eventId,
        });
        this._incrementActiveCount(ps.id);
        releaseReservation();
        _notifySoundscapeUi(this.playlist, "soundscape-one-shot-active", ps.id);

        const useFadeIn = normalized.fadeInMs > 0;
        try {
            await sound.play({
                loop: false,
                volume: useFadeIn ? 0 : targetVol,
                _sosProceduralOneShot: true,
            });
            if (useFadeIn) {
                const maxFade = Number.isFinite(sound.duration) && sound.duration > 0
                    ? Math.max(50, sound.duration * 500)
                    : normalized.fadeInMs;
                advancedFade(sound, {
                    targetVol,
                    duration: Math.min(normalized.fadeInMs, maxFade),
                });
            }
        } catch (err) {
            warn(`[Soundscape] Play failed for "${ps.name}":`, err?.message);
            this.activeOneShots.delete(sound);
            this.oneShotSharedTargetVolumes.delete(sound);
            this._decrementActiveCount(ps.id);
            this._detachPanner(sound);
            _notifySoundscapeUi(this.playlist, "soundscape-one-shot-play-failed", ps.id);
            if (isSyncedEvent) this._recordMissedSyncedEvent(normalized, "play-failed", {
                message: err?.message ?? null,
            });
            if (canRearm() && !this.isDestroyed && ps.playing) {
                this._armOneShot(ps, { minimumDelayMs: RETRY_BACKOFF_MS });
            }
            return false;
        }

        if (this.isDestroyed || !ps.playing) {
            safeStop(sound, "soundscape fire aborted post-play");
            this.activeOneShots.delete(sound);
            this.oneShotSharedTargetVolumes.delete(sound);
            this._decrementActiveCount(ps.id);
            this._detachPanner(sound);
            _notifySoundscapeUi(this.playlist, "soundscape-one-shot-aborted", ps.id);
            if (isSyncedEvent) this._recordMissedSyncedEvent(normalized, "aborted-after-play");
            return false;
        }

        if (isSyncedEvent) {
            this._recordSyncedEvent(normalized, {
                source,
                status: "played",
                targetVolume: Number(targetVol.toFixed(3)),
            });
        }

        let cleanedUp = false;
        const cleanup = () => {
            if (cleanedUp) return;
            cleanedUp = true;
            this.activeOneShots.delete(sound);
            this.oneShotSharedTargetVolumes.delete(sound);
            this._decrementActiveCount(ps.id);
            this._detachPanner(sound);
            if (sound.playing) safeStop(sound, "soundscape fire cleanup");
            _notifySoundscapeUi(this.playlist, "soundscape-one-shot-cleanup", ps.id);
            if (canRearm() && !this.isDestroyed && ps.playing) {
                const safeMinimumDelayMs =
                    Number.isFinite(sound.duration) && sound.duration > 0.05
                        ? 0
                        : RETRY_BACKOFF_MS;
                this._armOneShot(ps, { minimumDelayMs: safeMinimumDelayMs });
            }
        };

        try {
            sound.addEventListener("end", cleanup, { once: true });
            sound.addEventListener("stop", cleanup, { once: true });
        } catch (err) {
            const waitForEndMs = Number.isFinite(sound.duration)
                ? sound.duration * 1000 + 100
                : 3000;
            AudioTimeout.wait(waitForEndMs).then(cleanup);
        }

        debug(`[Soundscape] Fired "${ps.name}"`, {
            source,
            eventId: normalized.eventId,
            targetVolume: Number(targetVol.toFixed(3)),
            panValue: normalized.panValue,
            varianceFactor: Number(normalized.varianceFactor.toFixed(3)),
            playing: !!sound.playing,
            loaded: !!sound.loaded,
            volume: Number((sound.volume ?? 0).toFixed(3)),
            gain: Number((sound.gain?.value ?? 0).toFixed(3)),
            currentTime: Number((sound.currentTime ?? 0).toFixed(3)),
            duration: Number((sound.duration ?? 0).toFixed(3)),
        });

        Hooks.callAll(`${MODULE_ID}.oneShotFire`, {
            playlist: this.playlist,
            sound: ps,
            volume: targetVol,
            recipe: normalized,
            source,
        });
        return true;
    }

    /**
     * Resolve the effective play chance for a procedural sound, applying
     * optional polyphony-based scaling when the playlist opts in.
     * @param {PlaylistSound} ps
     * @returns {number} 0-100
     */
    _resolveEffectivePlayChance(ps) {
        const base = Flags.resolveProceduralField(ps, "playChance") ?? 100;
        const scaling = Flags.getPlaylistFlag(this.playlist, "soundscapePlayChanceScaling");
        if (!["scaled", "soft"].includes(scaling)) return base;
        const max = this.maxPolyphony || 1;
        const headroomFrac = Math.max(0, 1 - this._getOccupiedPolyphony() / max);
        const attenuation =
            scaling === "soft"
                ? Math.sqrt(headroomFrac)
                : headroomFrac;
        return Math.max(0, Math.min(100, base * attenuation));
    }

    _getOccupiedPolyphony() {
        return this.activeOneShots.size + this.pendingOneShotTotal;
    }

    _reserveOneShot(soundId) {
        this.pendingOneShotTotal += 1;
        const next = (this.pendingOneShotCounts.get(soundId) ?? 0) + 1;
        this.pendingOneShotCounts.set(soundId, next);
        _notifySoundscapeUi(this.playlist, "soundscape-one-shot-pending", soundId);
    }

    _releaseOneShotReservation(soundId) {
        this.pendingOneShotTotal = Math.max(0, this.pendingOneShotTotal - 1);
        const current = this.pendingOneShotCounts.get(soundId) ?? 0;
        if (current <= 1) {
            this.pendingOneShotCounts.delete(soundId);
            _notifySoundscapeUi(this.playlist, "soundscape-one-shot-pending", soundId);
            return;
        }
        this.pendingOneShotCounts.set(soundId, current - 1);
        _notifySoundscapeUi(this.playlist, "soundscape-one-shot-pending", soundId);
    }

    _incrementActiveCount(soundId) {
        const next = (this.activeOneShotCounts.get(soundId) ?? 0) + 1;
        this.activeOneShotCounts.set(soundId, next);
    }

    _decrementActiveCount(soundId) {
        const current = this.activeOneShotCounts.get(soundId) ?? 0;
        if (current <= 1) {
            this.activeOneShotCounts.delete(soundId);
            return;
        }
        this.activeOneShotCounts.set(soundId, current - 1);
    }

    getActiveOneShotCount(soundId) {
        return this.activeOneShotCounts.get(soundId) ?? 0;
    }

    isOneShotActive(soundId) {
        return this.getActiveOneShotCount(soundId) > 0;
    }

    getPendingOneShotCount(soundId) {
        return this.pendingOneShotCounts.get(soundId) ?? 0;
    }

    isOneShotPending(soundId) {
        return this.getPendingOneShotCount(soundId) > 0;
    }

    /**
     * Register a StereoPannerNode in Foundry's built-in effects pipeline.
     * @param {foundry.audio.Sound} sound
     * @param {number} panValue -1..+1
     */
    _attachPanner(sound, panValue) {
        try {
            const ctx = sound.context;
            if (!ctx?.createStereoPanner) {
                warn(`[Soundscape] Stereo panning is not available in this audio context.`);
                return;
            }

            const clampedPan = Math.max(-1, Math.min(1, panValue));
            const panner = ctx.createStereoPanner();
            panner.pan.value = clampedPan;

            sound.applyEffects([...(sound.effects ?? []), panner]);
            this.panners.set(sound, { panner, panValue: clampedPan });
        } catch (err) {
            warn(`[Soundscape] Failed to attach panner:`, err?.message);
        }
    }

    /**
     * Remove the StereoPannerNode from the effect chain.
     * Rebuilds the chain via applyEffects() so Foundry rewires connections.
     * @param {foundry.audio.Sound} sound
     */
    _detachPanner(sound) {
        const entry = this.panners.get(sound);
        if (!entry) return;
        this.panners.delete(sound);
        try {
            const remaining = (sound.effects ?? []).filter((effect) => effect !== entry.panner);
            if (typeof sound.applyEffects === "function") {
                sound.applyEffects(remaining);
            } else {
                sound.effects = remaining;
            }
        } catch (err) {
            // Sound may already be torn down — fall through to disconnect.
        }
        try {
            entry.panner.disconnect?.();
        } catch (err) {
            // Already disconnected — ignore.
        }
    }

    /**
     * Estimate milliseconds until the next fire for a given sound id, or null if not armed.
     * Used by the Currently Playing UI for the "Next in ~Ns" readout.
     * @param {string} soundId
     * @returns {number|null}
     */
    getNextFireEtaMs(soundId) {
        const entry = this.oneShotTimers.get(soundId);
        if (!entry) return null;
        return Math.max(0, entry.eta - Date.now());
    }

    /**
     * Current polyphony snapshot for UI meters.
     * @returns {{active: number, audible: number, pending: number, max: number}}
     */
    getPolyphony() {
        return {
            active: this._getOccupiedPolyphony(),
            audible: this.activeOneShots.size,
            pending: this.pendingOneShotTotal,
            max: this.maxPolyphony,
        };
    }

    /**
     * Re-apply this client's personal audio mix to active one-shots.
     * Shared per-fire variance is preserved; only local controls change.
     */
    applyPersonalAudioMix(options = {}) {
        if (this.isDestroyed) return;

        for (const sound of this.activeOneShots) {
            if (!sound?.playing) continue;
            const volumeData = this.oneShotSharedTargetVolumes.get(sound);
            const ps = volumeData?.soundId ? this.playlist.sounds.get(volumeData.soundId) : null;
            const sharedBase = ps ? Flags.resolveSharedTargetVolume(ps) : null;
            const varianceFactor = Number(volumeData?.varianceFactor);
            const sharedTarget = Number.isFinite(sharedBase)
                ? Math.max(0, Math.min(1, sharedBase * (Number.isFinite(varianceFactor) ? varianceFactor : 1)))
                : null;
            if (!Number.isFinite(sharedTarget)) continue;
            sound.volume = Flags.resolveTargetVolume(ps, {
                sharedVolume: sharedTarget,
                playlistVolume: options.playlistVolume,
            });
        }
    }

    applyPersonalPlaylistVolume(options = {}) {
        this.applyPersonalAudioMix(options);
    }

    /**
     * Fire a procedural one-shot immediately, cancelling any armed timer.
     * When procedural sync is enabled on the GM this emits the same recipe to
     * synced clients; opted-out clients continue their local timers.
     * @param {string} soundId
     * @returns {Promise<boolean>} true if a fire was initiated
     */
    async fireOneShotNow(soundId) {
        if (this.isDestroyed) return false;
        const ps = this.playlist.sounds.get(soundId);
        if (!ps || !Flags.getSoundFlag(ps, "isProcedural")) return false;

        // Cancel any armed timer so cleanup path re-arms cleanly.
        const existing = this.oneShotTimers.get(soundId);
        if (existing?.timer) safeCancelTimer(existing.timer, `fireNow "${ps.name}"`);
        this.oneShotTimers.delete(soundId);

        try {
            return await this._fireOneShot(ps, { bypassChance: true });
        } catch (err) {
            warn(`[Soundscape] fireOneShotNow failed for "${ps.name}":`, err?.message);
            if (!this.isDestroyed && ps.playing) this._armOneShot(ps, { minimumDelayMs: RETRY_BACKOFF_MS });
            return false;
        }
    }

    /**
     * Arm a procedural sound's timer. Safe to call when already armed — the
     * existing timer is preserved. Called when a procedural PlaylistSound
     * flips to playing: true (either via Play All or individual play click).
     * @param {PlaylistSound} ps
     */
    armProceduralSound(ps) {
        if (this.isDestroyed || !this.isStarted) return;
        if (!ps || !Flags.getSoundFlag(ps, "isProcedural")) return;
        if (!this._shouldArmLocalProcedurals()) return;
        if (this.oneShotTimers.has(ps.id)) return;
        this._armOneShot(ps, { initial: true });
    }

    /**
     * Reconcile armed timers with the current PlaylistSound document state.
     * This repairs client-side startup races where a playlist update arrives
     * before embedded sound playing flags have settled locally.
     */
    syncProceduralSounds() {
        if (this.isDestroyed || !this.isStarted) return;

        for (const ps of this.playlist.sounds) {
            if (!Flags.getSoundFlag(ps, "isProcedural")) continue;

            const hasRuntimeState =
                this.oneShotTimers.has(ps.id) ||
                this.isOneShotActive(ps.id) ||
                this.isOneShotPending(ps.id);

            if (ps.playing) {
                if (this._shouldArmLocalProcedurals()) {
                    this.armProceduralSound(ps);
                } else if (hasRuntimeState) {
                    this.disarmProceduralSound(ps);
                }
                continue;
            }

            if (hasRuntimeState) this.disarmProceduralSound(ps);
        }
    }

    /**
     * Disarm a procedural sound's timer and stop any currently-playing fires
     * of it. Called when a procedural PlaylistSound flips to playing: false.
     * @param {PlaylistSound} ps
     */
    disarmProceduralSound(ps) {
        if (this.isDestroyed) return;
        if (!ps || !Flags.getSoundFlag(ps, "isProcedural")) return;

        const existing = this.oneShotTimers.get(ps.id);
        if (existing?.timer) safeCancelTimer(existing.timer, `disarm "${ps.name}"`);
        this.oneShotTimers.delete(ps.id);

        // Fade out and stop any in-flight fires for this procedural.
        // Removal from activeOneShots/panner happens after the fade so concurrent
        // fires of the same procedural all get the fade treatment.
        const fadeMs = _resolveFadeOutMs(this.playlist);
        for (const sound of Array.from(this.activeOneShots)) {
            if (sound?._sosProceduralId !== ps.id) continue;
            if (fadeMs > 0) {
                fadeOutAndStop(sound, fadeMs)
                    .catch(() => safeStop(sound, `disarm fade fallback "${ps.name}"`))
                    .finally(() => this._detachPanner(sound));
            } else {
                safeStop(sound, `disarm active "${ps.name}"`);
                this._detachPanner(sound);
            }
        }
        _notifySoundscapeUi(this.playlist, "soundscape-one-shot-disarmed", ps.id);
    }

    /**
     * Diagnostics snapshot.
     * @returns {{active: boolean, bedCount: number, armedOneShots: number, activeOneShots: number, pendingOneShots: number}}
     */
    getDiagnostics() {
        return {
            active: this.isStarted && !this.isDestroyed,
            soundscapeSyncEnabled: this.soundscapeSyncEnabled,
            syncMode: this.syncMode,
            bedCount: this.bedSoundIds.size,
            bedSoundIds: Array.from(this.bedSoundIds),
            armedOneShots: this.oneShotTimers.size,
            armedOneShotIds: Array.from(this.oneShotTimers.keys()),
            activeOneShots: this.activeOneShots.size,
            activeOneShotCounts: _mapToObject(this.activeOneShotCounts),
            pendingOneShots: this.pendingOneShotTotal,
            pendingOneShotCounts: _mapToObject(this.pendingOneShotCounts),
            recentSyncedEvents: this.recentSyncedEvents.slice(-SYNCED_EVENT_HISTORY_LIMIT),
            missedSyncedEvents: this.missedSyncedEvents.slice(-SYNCED_EVENT_HISTORY_LIMIT),
            polyphony: this.getPolyphony(),
        };
    }

    /**
     * Tear down the engine. Cancels all pending timers, stops active one-shots,
     * and (by default) stops bed tracks via GM-authoritative document updates.
     * @param {{stopBeds?: boolean}} options
     */
    destroy({ stopBeds = true } = {}) {
        if (this.isDestroyed) return;
        this.isDestroyed = true;

        debug(
            `[Soundscape] Destroying engine for "${this.playlist.name}" ` +
            `(${this.oneShotTimers.size} armed, ${this.activeOneShots.size} active, ${this.pendingOneShotTotal} pending)`
        );

        // Cancel all armed timers.
        for (const [, entry] of this.oneShotTimers) {
            safeCancelTimer(entry.timer, "soundscape destroy");
        }
        this.oneShotTimers.clear();

        // Fade out and stop any currently audible one-shots. Uses playlist fade
        // ms so stopping the soundscape feels as smooth as bed-track fadeout.
        const destroyFadeMs = _resolveFadeOutMs(this.playlist);
        for (const sound of this.activeOneShots) {
            const panner = sound;
            if (destroyFadeMs > 0) {
                fadeOutAndStop(sound, destroyFadeMs)
                    .catch(() => safeStop(sound, "soundscape destroy fade fallback"))
                    .finally(() => this._detachPanner(panner));
            } else {
                this._detachPanner(sound);
                safeStop(sound, "soundscape destroy active");
            }
        }
        this.activeOneShots.clear();
        this.activeOneShotCounts.clear();
        this.pendingOneShotTotal = 0;
        this.pendingOneShotCounts.clear();

        // GM stops beds via normal Foundry mechanism (replicates to clients).
        if (stopBeds && game.user.isGM) {
            const updates = [];
            for (const bedId of this.bedSoundIds) {
                const bed = this.playlist.sounds.get(bedId);
                if (bed?.playing) {
                    updates.push({ _id: bed.id, playing: false, pausedTime: null });
                }
            }

            if (updates.length) {
                this.playlist.updateEmbeddedDocuments("PlaylistSound", updates).catch((err) => {
                    debug(`[Soundscape] Failed to stop bed layer for "${this.playlist.name}":`, err?.message);
                });
            }
        }
        this.bedSoundIds.clear();
        _notifySoundscapeUi(this.playlist, "soundscape-engine-destroyed");

        Hooks.callAll(`${MODULE_ID}.soundscapeEnd`, { playlist: this.playlist });
    }
}

// =========================================================================
// Registry helpers - single entry points used by bootstrap/lifecycle.js and api.js
// =========================================================================

/**
 * Start the soundscape for a playlist. Creates an engine if none exists.
 * Idempotent: calling twice returns the existing engine.
 * @param {Playlist} playlist
 * @returns {Promise<SoundscapeEngine>}
 */
export async function startSoundscape(playlist) {
    if (!playlist) return null;

    const existing = State.getSoundscapeEngine(playlist);
    if (existing && !existing.isDestroyed) return existing;

    const engine = new SoundscapeEngine(playlist);
    State.setSoundscapeEngine(playlist, engine);
    await engine.start();
    return engine;
}

/**
 * Stop the soundscape for a playlist. Safe to call if none exists.
 * @param {Playlist} playlist
 * @param {{stopBeds?: boolean}} options
 */
export function stopSoundscape(playlist, { stopBeds = true } = {}) {
    if (!playlist) return;

    const engine = State.getSoundscapeEngine(playlist);
    if (!engine) return;

    engine.destroy({ stopBeds });
    State.clearSoundscapeEngine(playlist);
}

/**
 * Check if a playlist currently has a live soundscape engine.
 * @param {Playlist} playlist
 * @returns {boolean}
 */
export function isSoundscapeActive(playlist) {
    if (!playlist) return false;
    const engine = State.getSoundscapeEngine(playlist);
    return !!(engine && engine.isStarted && !engine.isDestroyed);
}

/**
 * Handle a transient GM-authored procedural fire recipe received over the
 * module socket. This is intentionally not persisted to world documents.
 * @param {Object} data
 * @returns {Promise<boolean>}
 */
export async function handleSoundscapeProceduralFire(data = {}) {
    if (!isSoundscapeProceduralSyncEnabled()) return false;
    const playlist = game.playlists?.get?.(data.playlistId);
    if (!playlist || !Flags.getPlaybackMode(playlist).soundscape) return false;

    let engine = State.getSoundscapeEngine(playlist);
    if (!engine || engine.isDestroyed) {
        engine = await startSoundscape(playlist);
    }
    return engine?.executeSyncedFire?.(data) ?? false;
}
