// fade-in.js - Applies a fade-in effect to playlist sounds when they start playing

import { MODULE_ID, logFeature, LogSymbols } from "./utils.js";
import { Silence } from "./silence.js";
import { advancedFade, releaseFadeInReservation } from "./audio-fader.js";
import { debug, waitForMedia } from "./utils.js";
import { State } from "./state-manager.js";

const STREAM_START_READY_TIMEOUT_MS = 2000;

function _isStreamReady(element) {
    return element?.seeking !== true &&
        Number(element?.readyState) >= 3 &&
        element?.paused !== true;
}

/**
 * Keep streamed media muted until its non-zero seek has usable data. Foundry
 * does not await HTMLMediaElement.play(), so Sound.play() may resolve before
 * the element is actually producing audio.
 */
function _waitForStreamStart(sound, timeoutMs = STREAM_START_READY_TIMEOUT_MS) {
    const element = sound?.element;
    if (!element || _isStreamReady(element)) {
        return Promise.resolve("ready");
    }
    if (typeof element.addEventListener !== "function") {
        return Promise.resolve("unsupported");
    }

    return new Promise((resolve) => {
        let settled = false;
        let timeoutId = null;
        const readinessEvents = ["playing", "seeked", "canplay"];
        const terminalEvents = ["error", "abort", "emptied"];

        const cleanup = () => {
            for (const eventName of [...readinessEvents, ...terminalEvents]) {
                element.removeEventListener?.(eventName, onEvent);
            }
            if (timeoutId !== null) globalThis.clearTimeout?.(timeoutId);
        };
        const finish = (outcome) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(outcome);
        };
        const onEvent = (event) => {
            if (terminalEvents.includes(event?.type)) return finish("terminal");
            if (_isStreamReady(element)) finish("ready");
        };

        for (const eventName of [...readinessEvents, ...terminalEvents]) {
            element.addEventListener(eventName, onEvent);
        }
        if (_isStreamReady(element)) return finish("ready");

        timeoutId = globalThis.setTimeout?.(
            () => finish("timeout"),
            Math.max(0, Number(timeoutMs) || 0)
        ) ?? null;
        if (timeoutId === null) finish("unsupported");
    });
}

// =========================================================================
// Fade-In Logic
// =========================================================================

/**
 * Applies a logarithmic fade-in to a sound when it starts playing.
 * It retrieves the configured fade duration from the playlist flags and
 * uses the advanced fader to smoothly transition the sound's volume.
 * @param {Playlist} playlist The parent playlist document.
 * @param {PlaylistSound} ps The playlist sound to fade in.
 * @param {object} [options] Optional configuration.
 * @param {number} [options.targetVolume] Explicit target volume for the fade-in.
 *   If provided, overrides ps.volume. This avoids race conditions when ps.volume
 *   may not reflect the normalized value.
 * @param {number} [options.durationMs] Explicit duration already resolved by
 *   the Sound.play wrapper.
 * @param {Sound} [options.sound] Exact Sound generation being started.
 * @param {object} [options.startupToken] Provisional pre-play fade owner.
 */
export async function applyFadeIn(playlist, ps, {
    targetVolume,
    durationMs,
    sound: expectedSound = null,
    startupToken = null,
} = {}) {
    // Check for an API override first, fall back to the playlist flag.
    const fadeOverride = ps._sos_fadeInOverride;
    const fadeTotal = Number.isFinite(Number(durationMs))
        ? Math.max(0, Number(durationMs))
        : (typeof fadeOverride === 'number'
            ? Math.max(0, fadeOverride)
            : Math.max(0, Number(playlist?.getFlag(MODULE_ID, "fadeIn") ?? 0) || 0));

    // Clean up the temporary override property after we've read it.
    if (typeof fadeOverride !== 'undefined') delete ps._sos_fadeInOverride;

    try {
        if (fadeTotal <= 0) return null;

        // If a crossfade is in progress, it handles the fade-in. Do nothing here.
        if (State.isPlaylistCrossfading(playlist) || State.isPlaylistStopping(playlist)) {
            debug(`[FadeIn] Skipping standard fade-in for "${ps.name}" because another transition owns the playlist.`);
            return null;
        }

        // Skip fade-in for our silent gap tracks.
        if (!ps || ps.getFlag(MODULE_ID, Silence.FLAG_KEY)) return null;

        // The wrapped startup path already knows the exact Sound. Avoid an
        // unconditional await here so decoded buffers transfer ownership to
        // their real curve before any later post-play work runs.
        const media = expectedSound ?? ps.sound ?? await waitForMedia(ps);
        if (!media) return null;
        if (expectedSound && media !== expectedSound) return null;
        if (ps.sound !== media || ps.playing !== true || media.playing !== true) return null;
        if (startupToken && !State.isCurrentFadeToken(media, startupToken)) return null;

        if (startupToken && media.element) {
            const readiness = await _waitForStreamStart(media);
            if (readiness === "terminal") return null;
            if (ps.sound !== media || ps.playing !== true || media.playing !== true) return null;
            if (!State.isCurrentFadeToken(media, startupToken)) return null;
            if (State.isPlaylistCrossfading(playlist) || State.isPlaylistStopping(playlist)) return null;
            if (readiness === "timeout") {
                debug(`[FadeIn] Stream readiness timed out for "${ps.name}"; applying the bounded fail-open ramp.`);
            }
        }

        // Use explicit target volume if provided, otherwise fall back to document volume.
        const targetVol = (typeof targetVolume === 'number') ? targetVolume : (ps.volume ?? 1);

        logFeature(LogSymbols.FADE_IN, 'Fade', `${ps.name} (${fadeTotal}ms)`);
        const token = advancedFade(media, {
            targetVol,
            duration: fadeTotal,
            startVol: startupToken ? 0 : undefined,
            replaceToken: startupToken,
        });

        // A successful native play should always expose a GainNode. Fail open
        // if a custom Sound implementation does not, rather than leaving it
        // permanently muted behind the provisional token.
        if (!token && (!startupToken || State.isCurrentFadeToken(media, startupToken))) {
            releaseFadeInReservation(media, startupToken);
            media.volume = targetVol;
        }
        return token;
    } finally {
        releaseFadeInReservation(expectedSound, startupToken);
    }
}
