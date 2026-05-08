// soundscape-previewer.js

import { advancedFade, fadeOutAndStop } from "./audio-fader.js";
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

const AudioTimeout = foundry.audio.AudioTimeout;
const RETRY_BACKOFF_MS = 250;
const DEFAULT_FADE_MS = 500;

function _getOverrideFlag(configOverrides, key) {
    if (!configOverrides?.flags) return undefined;
    return foundry.utils.getProperty(configOverrides.flags, key);
}

function _resolveFadeOutMs(playlist, configOverrides = null) {
    const fade = Number(configOverrides?.fade ?? playlist?.fade);
    return Number.isFinite(fade) && fade >= 0 ? fade : DEFAULT_FADE_MS;
}

function _resolveFadeInMs(playlist, configOverrides = null) {
    if (!playlist) return DEFAULT_FADE_MS;
    const customFadeIn = Number(
        _getOverrideFlag(configOverrides, "fadeIn") ?? Flags.getPlaylistFlag(playlist, "fadeIn") ?? 0
    );
    if (Number.isFinite(customFadeIn) && customFadeIn > 0) return customFadeIn;
    return _resolveFadeOutMs(playlist, configOverrides);
}

function _hasPreviewableSoundscapeContent(playlist) {
    return Array.from(playlist?.sounds ?? []).some((sound) => {
        return !Flags.getSoundFlag(sound, "isSilenceGap");
    });
}

function _hasProceduralSound(playlist) {
    return Array.from(playlist?.sounds ?? []).some((sound) => {
        return !Flags.getSoundFlag(sound, "isSilenceGap")
            && Flags.getSoundFlag(sound, "isProcedural");
    });
}

function _isSoundscapePreviewEligible(playlist, { forceSoundscapeMode = false } = {}) {
    if (!game.user.isGM || !playlist) return false;
    if (!_hasPreviewableSoundscapeContent(playlist)) return false;
    return forceSoundscapeMode || !!Flags.getPlaylistFlag(playlist, "soundscapeMode") || _hasProceduralSound(playlist);
}

function _isLivePlaylistPlaying(playlist) {
    return !!(playlist?.playing || State.hasSoundscapeEngine(playlist));
}

class SoundscapePreviewSession {
    constructor(playlist, { configOverrides = null } = {}) {
        this.playlist = playlist;
        this.playlistId = playlist.id;
        this.configOverrides = configOverrides;
        this.isDestroyed = false;
        this.isStarted = false;

        this.bedSounds = new Set();
        this.activeOneShots = new Set();
        this.oneShotTimers = new Map();
        this.panners = new WeakMap();
        this.previewProceduralIds = [];

        this.pendingOneShotTotal = 0;
        this.pendingOneShotCounts = new Map();
    }

    get maxPolyphony() {
        return this._getPlaylistFlag("soundscapeMaxPolyphony") ?? 4;
    }

    _getPlaylistFlag(key) {
        const override = _getOverrideFlag(this.configOverrides, key);
        return override !== null && typeof override !== "undefined"
            ? override
            : Flags.getPlaylistFlag(this.playlist, key);
    }

    _resolveProceduralField(ps, key) {
        const raw = ps?.getFlag?.(MODULE_ID, key);
        if (raw !== null && typeof raw !== "undefined") return Flags.resolveProceduralField(ps, key);

        const defaults = this._getPlaylistFlag("soundscapeDefaults") ?? {};
        const override = defaults[key];
        return override !== null && typeof override !== "undefined"
            ? override
            : Flags.resolveProceduralField(ps, key);
    }

    _resolveTargetVolume(ps) {
        const normEnabled = this._getPlaylistFlag("volumeNormalizationEnabled");
        const hasOverride = Flags.getSoundFlag(ps, "allowVolumeOverride");

        if (normEnabled && !hasOverride) {
            const normalizedVolume = this._getPlaylistFlag("normalizedVolume");
            return foundry.audio.AudioHelper.inputToVolume(normalizedVolume);
        }
        return ps.volume;
    }

    async start() {
        if (this.isStarted || this.isDestroyed) return;
        this.isStarted = true;

        if (game.audio?.locked) await game.audio.unlock;
        if (this.isDestroyed) return;
        ensureAudioContext();

        const beds = [];
        const procedurals = [];
        for (const ps of this.playlist.sounds) {
            if (Flags.getSoundFlag(ps, "isSilenceGap")) continue;
            if (Flags.getSoundFlag(ps, "isProcedural")) procedurals.push(ps);
            else beds.push(ps);
        }

        this.previewProceduralIds = procedurals.map((ps) => ps.id);
        debug(
            `[SoundscapePreview] Starting "${this.playlist.name}" - ` +
            `${beds.length} bed(s), ${procedurals.length} procedural(s)`
        );

        await Promise.all(beds.map((ps) => this._startBed(ps)));
        if (this.isDestroyed) return;

        for (const ps of procedurals) {
            this._armOneShot(ps, { initial: true });
        }
    }

    async _startBed(ps) {
        if (this.isDestroyed) return false;

        let sound;
        try {
            sound = new foundry.audio.Sound(ps.path, {
                context: ps.sound?.context ?? ps.context,
            });
            await sound.load();
        } catch (err) {
            warn(`[SoundscapePreview] Failed to load bed "${ps.name}":`, err?.message);
            return false;
        }

        if (this.isDestroyed) {
            safeStop(sound, "soundscape preview bed stale load");
            return false;
        }

        const targetVol = this._resolveTargetVolume(ps);
        const fadeInMs = _resolveFadeInMs(this.playlist, this.configOverrides);
        const useFadeIn = fadeInMs > 0;

        this.bedSounds.add(sound);
        sound._sosSoundscapePreviewBed = true;

        const cleanup = () => {
            this.bedSounds.delete(sound);
        };
        try {
            sound.addEventListener("end", cleanup, { once: true });
            sound.addEventListener("stop", cleanup, { once: true });
        } catch (_err) {
            // Duration fallback is unnecessary for beds; stop/destroy cleanup owns them.
        }

        try {
            await sound.play({
                loop: !!ps.repeat,
                volume: useFadeIn ? 0 : targetVol,
                _sosProceduralOneShot: true,
            });
            if (this.isDestroyed) {
                safeStop(sound, "soundscape preview bed stale play");
                return false;
            }
            if (useFadeIn) {
                advancedFade(sound, { targetVol, duration: fadeInMs });
            }
            return true;
        } catch (err) {
            this.bedSounds.delete(sound);
            warn(`[SoundscapePreview] Failed to play bed "${ps.name}":`, err?.message);
            safeStop(sound, "soundscape preview bed play failed");
            return false;
        }
    }

    _armOneShot(ps, { minimumDelayMs = 0, initial = false } = {}) {
        if (this.isDestroyed) return;

        const existing = this.oneShotTimers.get(ps.id);
        if (existing?.timer) safeCancelTimer(existing.timer, `preview rearm ${ps.name}`);

        const delayMs = Math.max(minimumDelayMs, this._pickDelayMs(ps, { initial }));
        const eta = Date.now() + delayMs;
        const timer = new AudioTimeout(delayMs);

        this.oneShotTimers.set(ps.id, { timer, eta });
        timer.complete.then(() => {
            if (this.isDestroyed) return;
            this._fireOneShot(ps).catch((err) => {
                warn(`[SoundscapePreview] Fire failed for "${ps.name}":`, err?.message);
                if (!this.isDestroyed) this._armOneShot(ps, { minimumDelayMs: RETRY_BACKOFF_MS });
            });
        }).catch(() => {
            // Timer cancelled.
        });
    }

    _pickDelayMs(ps, { initial = false } = {}) {
        const { min, max } = this._resolveDelayWindow(ps);
        const mode = this._resolveProceduralField(ps, "timingMode");
        let seconds;

        switch (mode) {
            case "fixed":
                seconds = min;
                break;
            case "natural":
                seconds = min + ((Math.random() + Math.random()) / 2) * (max - min);
                break;
            case "uniform":
            default:
                seconds = min + Math.random() * (max - min);
                break;
        }

        let delayMs = Math.max(0, seconds * 1000);
        if (initial) delayMs = this._applyInitialFireMode(ps, delayMs, { min, max });
        return delayMs;
    }

    _resolveDelayWindow(ps) {
        let min = this._resolveProceduralField(ps, "minDelay") ?? 15;
        let max = this._resolveProceduralField(ps, "maxDelay") ?? 60;
        if (max < min) [min, max] = [max, min];
        return { min, max };
    }

    _getAverageDelayMs(ps, { min, max } = {}) {
        const delayMin = Number.isFinite(min) ? min : this._resolveDelayWindow(ps).min;
        const delayMax = Number.isFinite(max) ? max : this._resolveDelayWindow(ps).max;
        const mode = this._resolveProceduralField(ps, "timingMode");
        const avgSec = mode === "fixed" ? delayMin : (delayMin + delayMax) / 2;
        return Math.max(0, avgSec * 1000);
    }

    _applyInitialFireMode(ps, baseDelayMs, { min, max }) {
        const mode = this._resolveProceduralField(ps, "initialFireMode");
        if (mode === "immediate") return 0;
        if (mode !== "staggered") return baseDelayMs;
        if (this.previewProceduralIds.length < 2) return baseDelayMs;

        const index = this.previewProceduralIds.indexOf(ps.id);
        if (index < 0) return baseDelayMs;

        const startupWindowMs = Math.max(1000, this._getAverageDelayMs(ps, { min, max }));
        const staggerFloor =
            ((index + 1) / (this.previewProceduralIds.length + 1)) * startupWindowMs;
        return Math.max(baseDelayMs, staggerFloor);
    }

    async _fireOneShot(ps) {
        if (this.isDestroyed) return false;
        this.oneShotTimers.delete(ps.id);

        if (this._getOccupiedPolyphony() >= this.maxPolyphony) {
            debug(`[SoundscapePreview] Polyphony cap reached, skipping "${ps.name}"`);
            if (!this.isDestroyed) this._armOneShot(ps, { minimumDelayMs: RETRY_BACKOFF_MS });
            return false;
        }

        const effectiveChance = this._resolveEffectivePlayChance(ps);
        if (effectiveChance < 100 && (Math.random() * 100) >= effectiveChance) {
            if (!this.isDestroyed) this._armOneShot(ps, { minimumDelayMs: RETRY_BACKOFF_MS });
            return false;
        }

        this._reserveOneShot(ps.id);
        let reservationActive = true;
        const releaseReservation = () => {
            if (!reservationActive) return;
            reservationActive = false;
            this._releaseOneShotReservation(ps.id);
        };

        let sound;
        try {
            sound = new foundry.audio.Sound(ps.path, {
                context: ps.sound?.context ?? ps.context,
            });
            await sound.load();
        } catch (err) {
            releaseReservation();
            warn(`[SoundscapePreview] Failed to load one-shot "${ps.name}":`, err?.message);
            if (!this.isDestroyed) this._armOneShot(ps, { minimumDelayMs: RETRY_BACKOFF_MS });
            return false;
        }

        if (this.isDestroyed) {
            releaseReservation();
            safeStop(sound, "soundscape preview one-shot stale load");
            return false;
        }

        const targetVol = this._rollTargetVolume(ps);
        const randomPan = this._resolveProceduralField(ps, "randomPan");
        if (randomPan) this._attachPanner(sound, Math.random() * 2 - 1);

        this.activeOneShots.add(sound);
        sound._sosSoundscapePreviewOneShot = true;
        releaseReservation();

        let cleanedUp = false;
        const cleanup = () => {
            if (cleanedUp) return;
            cleanedUp = true;
            this.activeOneShots.delete(sound);
            this._detachPanner(sound);
            if (sound.playing) safeStop(sound, "soundscape preview one-shot cleanup");
            if (!this.isDestroyed) {
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
        } catch (_err) {
            const waitMs = Number.isFinite(sound.duration)
                ? sound.duration * 1000 + 100
                : 3000;
            AudioTimeout.wait(waitMs).then(cleanup);
        }

        const fadeInMs = _resolveFadeInMs(this.playlist, this.configOverrides);
        const useFadeIn = fadeInMs > 0;
        try {
            await sound.play({
                loop: false,
                volume: useFadeIn ? 0 : targetVol,
                _sosProceduralOneShot: true,
            });
            if (this.isDestroyed) {
                safeStop(sound, "soundscape preview one-shot stale play");
                return false;
            }
            if (useFadeIn) {
                const maxFade = Number.isFinite(sound.duration) && sound.duration > 0
                    ? Math.max(50, sound.duration * 500)
                    : fadeInMs;
                advancedFade(sound, {
                    targetVol,
                    duration: Math.min(fadeInMs, maxFade),
                });
            }
            return true;
        } catch (err) {
            this.activeOneShots.delete(sound);
            this._detachPanner(sound);
            warn(`[SoundscapePreview] Failed to play one-shot "${ps.name}":`, err?.message);
            if (!this.isDestroyed) this._armOneShot(ps, { minimumDelayMs: RETRY_BACKOFF_MS });
            return false;
        }
    }

    _rollTargetVolume(ps) {
        const baseVol = this._resolveTargetVolume(ps);
        const variancePct = this._resolveProceduralField(ps, "volumeVariance") ?? 0;
        if (variancePct <= 0) return baseVol;
        const offset = (Math.random() * 2 - 1) * variancePct;
        return Math.max(0, Math.min(1, baseVol * (1 + offset)));
    }

    _resolveEffectivePlayChance(ps) {
        const base = this._resolveProceduralField(ps, "playChance") ?? 100;
        const scaling = this._getPlaylistFlag("soundscapePlayChanceScaling");
        if (!["scaled", "soft"].includes(scaling)) return base;
        const max = this.maxPolyphony || 1;
        const headroomFrac = Math.max(0, 1 - this._getOccupiedPolyphony() / max);
        const attenuation = scaling === "soft" ? Math.sqrt(headroomFrac) : headroomFrac;
        return Math.max(0, Math.min(100, base * attenuation));
    }

    _getOccupiedPolyphony() {
        return this.activeOneShots.size + this.pendingOneShotTotal;
    }

    _reserveOneShot(soundId) {
        this.pendingOneShotTotal += 1;
        this.pendingOneShotCounts.set(soundId, (this.pendingOneShotCounts.get(soundId) ?? 0) + 1);
    }

    _releaseOneShotReservation(soundId) {
        this.pendingOneShotTotal = Math.max(0, this.pendingOneShotTotal - 1);
        const current = this.pendingOneShotCounts.get(soundId) ?? 0;
        if (current <= 1) this.pendingOneShotCounts.delete(soundId);
        else this.pendingOneShotCounts.set(soundId, current - 1);
    }

    _attachPanner(sound, panValue) {
        try {
            const ctx = sound.context;
            if (!ctx?.createStereoPanner) {
                warn("[SoundscapePreview] Stereo panning is not available in this audio context.");
                return;
            }
            const panner = ctx.createStereoPanner();
            panner.pan.value = Math.max(-1, Math.min(1, panValue));
            sound.applyEffects([...(sound.effects ?? []), panner]);
            this.panners.set(sound, panner);
        } catch (err) {
            warn("[SoundscapePreview] Failed to attach panner:", err?.message);
        }
    }

    _detachPanner(sound) {
        const panner = this.panners.get(sound);
        if (!panner) return;
        try {
            const remaining = (sound.effects ?? []).filter((effect) => effect !== panner);
            if (typeof sound.applyEffects === "function") sound.applyEffects(remaining);
            else sound.effects = remaining;
        } catch (_err) {
            // Sound may already be torn down.
        }
        try {
            panner.disconnect();
        } catch (_err) {
            // Already disconnected.
        }
        this.panners.delete(sound);
    }

    stop() {
        if (this.isDestroyed) return;
        this.isDestroyed = true;

        for (const [, entry] of this.oneShotTimers) {
            safeCancelTimer(entry.timer, "soundscape preview stop");
        }
        this.oneShotTimers.clear();
        this.pendingOneShotTotal = 0;
        this.pendingOneShotCounts.clear();

        const fadeMs = _resolveFadeOutMs(this.playlist, this.configOverrides);
        const stopSound = (sound, context) => {
            if (fadeMs > 0) {
                fadeOutAndStop(sound, fadeMs)
                    .catch(() => safeStop(sound, `${context} fade fallback`))
                    .finally(() => this._detachPanner(sound));
            } else {
                this._detachPanner(sound);
                safeStop(sound, context);
            }
        };

        for (const sound of Array.from(this.bedSounds)) {
            stopSound(sound, "soundscape preview bed stop");
        }
        for (const sound of Array.from(this.activeOneShots)) {
            stopSound(sound, "soundscape preview one-shot stop");
        }
        this.bedSounds.clear();
        this.activeOneShots.clear();
        debug(`[SoundscapePreview] Stopped "${this.playlist.name}"`);
    }
}

const _sessions = new Map();

export const SoundscapePreviewer = {
    async start(playlist, { forceSoundscapeMode = false, configOverrides = null } = {}) {
        if (!_isSoundscapePreviewEligible(playlist, { forceSoundscapeMode })) return false;
        if (_isLivePlaylistPlaying(playlist)) {
            ui.notifications?.warn(`Stop "${playlist.name}" before previewing its soundscape.`);
            return false;
        }

        this.stopAll({ notify: false });
        const session = new SoundscapePreviewSession(playlist, { configOverrides });
        _sessions.set(playlist.id, session);
        try {
            await session.start();
            ui.notifications?.info(`Previewing soundscape: ${playlist.name}`);
            return true;
        } catch (err) {
            _sessions.delete(playlist.id);
            session.stop();
            error(`[SoundscapePreview] Failed to start "${playlist.name}":`, err);
            ui.notifications?.error(`Failed to preview soundscape: ${playlist.name}`);
            return false;
        }
    },

    stop(playlist, { notify = true } = {}) {
        const session = playlist ? _sessions.get(playlist.id) : null;
        if (!session) return false;
        session.stop();
        _sessions.delete(playlist.id);
        if (notify) ui.notifications?.info(`Stopped soundscape preview: ${playlist.name}`);
        return true;
    },

    stopAll({ notify = false } = {}) {
        for (const [playlistId, session] of Array.from(_sessions.entries())) {
            session.stop();
            _sessions.delete(playlistId);
        }
        if (notify) ui.notifications?.info("Stopped all soundscape previews.");
    },

    isPreviewing(playlist) {
        return !!(playlist && _sessions.has(playlist.id));
    },
};

Hooks.on("updatePlaylist", (playlist) => {
    if (playlist?.playing && SoundscapePreviewer.isPreviewing(playlist)) {
        SoundscapePreviewer.stop(playlist, { notify: false });
    }
});

Hooks.on("deletePlaylist", (playlist) => {
    SoundscapePreviewer.stop(playlist, { notify: false });
});
