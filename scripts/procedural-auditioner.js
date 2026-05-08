// procedural-auditioner.js

import { advancedFade } from "./audio-fader.js";
import { Flags } from "./flag-service.js";
import {
    MODULE_ID,
    debug,
    warn,
    error,
    ensureAudioContext,
    safeStop,
} from "./utils.js";

const AudioTimeout = foundry.audio.AudioTimeout;
const DEFAULT_FADE_MS = 500;

function _clamp01(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

function _resolveFadeOutMs(playlist) {
    const fade = Number(playlist?.fade);
    return Number.isFinite(fade) && fade >= 0 ? fade : DEFAULT_FADE_MS;
}

function _resolveFadeInMs(playlist) {
    if (!playlist) return DEFAULT_FADE_MS;
    const customFadeIn = Number(Flags.getPlaylistFlag(playlist, "fadeIn") ?? 0);
    if (Number.isFinite(customFadeIn) && customFadeIn > 0) return customFadeIn;
    return _resolveFadeOutMs(playlist);
}

/**
 * Local-only preview helper for one procedural PlaylistSound config sheet.
 * This does not update documents, arm timers, or start a SoundscapeEngine.
 */
export class ProceduralAuditioner {
    constructor(app, html, data) {
        this.app = app;
        this.html = html;
        this.data = data;
        this.sound = null;
        this.panners = new WeakMap();
        this.generation = 0;
        this.isLoading = false;
        this.isDestroyed = false;
    }

    init() {
        if (!game.user.isGM) return false;

        this.$panel = this.html.find(".sos-proc-audition");
        if (!this.$panel.length) return false;

        this.$fireBtn = this.$panel.find(".sos-proc-audition-fire");
        this.$stopBtn = this.$panel.find(".sos-proc-audition-stop");
        this.$volumeSlider = this.$panel.find(".sos-proc-audition-volume");
        this.$status = this.$panel.find(".sos-proc-audition-status");

        this.$fireBtn.on("click.auditioner", (event) => {
            event.preventDefault();
            this.firePreview();
        });
        this.$stopBtn.on("click.auditioner", (event) => {
            event.preventDefault();
            this.stopAll();
        });
        this.$volumeSlider.on("input.auditioner change.auditioner", () => {
            this._applyPreviewVolume();
        });

        this._setStatus("Ready", "ready");
        this._syncButtons();
        return true;
    }

    async firePreview() {
        if (this.isDestroyed || this.isLoading) return false;
        const ps = this.app.document;
        if (!ps?.path) return false;

        this._stopCurrentSound();
        const token = ++this.generation;
        this.isLoading = true;
        this._setStatus("Loading", "loading");
        this._syncButtons();

        try {
            if (game.audio?.locked) await game.audio.unlock;
            if (!this._isCurrent(token)) return false;
            ensureAudioContext();

            const targetVol = this._rollTargetVolume();
            const sound = new foundry.audio.Sound(ps.path, {
                context: ps.sound?.context ?? ps.context,
            });

            await sound.load();
            if (!this._isCurrent(token)) {
                safeStop(sound, "procedural audition stale load");
                return false;
            }

            if (this._readRandomPan()) {
                this._attachPanner(sound, Math.random() * 2 - 1);
            }

            this.sound = sound;
            sound._sosProceduralAudition = true;

            const cleanup = () => {
                if (this.sound !== sound) return;
                this._detachPanner(sound);
                this.sound = null;
                this._setStatus("Stopped", "stopped");
                this._syncButtons();
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

            const fadeInMs = _resolveFadeInMs(ps.parent);
            const useFadeIn = fadeInMs > 0;
            await sound.play({
                loop: false,
                volume: useFadeIn ? 0 : targetVol,
                _sosProceduralOneShot: true,
            });
            if (!this._isCurrent(token)) {
                safeStop(sound, "procedural audition stale play");
                return false;
            }

            this.isLoading = false;
            this._setStatus("Playing", "playing");
            this._syncButtons();

            if (useFadeIn) {
                const maxFade = Number.isFinite(sound.duration) && sound.duration > 0
                    ? Math.max(50, sound.duration * 500)
                    : fadeInMs;
                advancedFade(sound, {
                    targetVol,
                    duration: Math.min(fadeInMs, maxFade),
                });
            }

            debug(`[Auditioner] Preview fired for "${ps.name}"`, {
                targetVolume: Number(targetVol.toFixed(3)),
                randomPan: this._readRandomPan(),
            });
            return true;
        } catch (err) {
            error(`[Auditioner] Failed to preview "${ps.name}":`, err);
            this._setStatus("Failed", "failed");
            this._stopCurrentSound();
            return false;
        } finally {
            if (this._isCurrent(token)) {
                this.isLoading = false;
                this._syncButtons();
            }
        }
    }

    stopAll() {
        if (this.isDestroyed) return;
        ++this.generation;
        this.isLoading = false;
        this._stopCurrentSound();
        this._setStatus("Stopped", "stopped");
        this._syncButtons();
    }

    destroy() {
        if (this.isDestroyed) return;
        this.$fireBtn?.off(".auditioner");
        this.$stopBtn?.off(".auditioner");
        this.$volumeSlider?.off(".auditioner");
        this.stopAll();
        this.isDestroyed = true;
    }

    _isCurrent(token) {
        return !this.isDestroyed && token === this.generation;
    }

    _stopCurrentSound() {
        const sound = this.sound;
        if (!sound) return;
        this.sound = null;
        this._detachPanner(sound);
        safeStop(sound, "procedural audition stop");
    }

    _getPreviewVolume() {
        const rawValue = this.$volumeSlider?.[0]?.value ?? this.$volumeSlider?.attr?.("value");
        return _clamp01(rawValue, _clamp01(this.data?.document?.volume, 1));
    }

    _applyPreviewVolume() {
        if (!this.sound) return;
        try {
            this.sound.volume = this._getPreviewVolume();
        } catch (err) {
            warn(`[Auditioner] Failed to apply preview volume:`, err?.message);
        }
    }

    _rollTargetVolume() {
        const baseVol = this._getPreviewVolume();
        const variance = _clamp01(this.html.find(".sos-proc-variance").val(), 0);
        if (variance <= 0) return baseVol;
        const offset = (Math.random() * 2 - 1) * variance;
        return _clamp01(baseVol * (1 + offset), baseVol);
    }

    _readRandomPan() {
        return !!this.html.find(`input[name="flags.${MODULE_ID}.randomPan"]`).is(":checked");
    }

    _attachPanner(sound, panValue) {
        try {
            const ctx = sound.context;
            if (!ctx?.createStereoPanner) {
                warn("[Auditioner] Stereo panning is not available in this audio context.");
                return;
            }

            const panner = ctx.createStereoPanner();
            panner.pan.value = Math.max(-1, Math.min(1, panValue));
            sound.applyEffects([...(sound.effects ?? []), panner]);
            this.panners.set(sound, panner);
        } catch (err) {
            warn("[Auditioner] Failed to attach preview panner:", err?.message);
        }
    }

    _detachPanner(sound) {
        const panner = this.panners.get(sound);
        if (!panner) return;
        try {
            panner.disconnect();
        } catch (_err) {
            // Already disconnected.
        }
        this.panners.delete(sound);
    }

    _setStatus(label, state) {
        if (!this.$status?.length) return;
        this.$status.text(label);
        this.$panel
            ?.removeClass("is-ready is-loading is-playing is-stopped is-failed")
            .addClass(`is-${state}`);
    }

    _syncButtons() {
        const busy = this.isLoading;
        this.$fireBtn?.prop("disabled", busy);
        this.$stopBtn?.prop("disabled", busy ? false : !this.sound);
    }
}
