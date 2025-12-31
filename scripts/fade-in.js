// fade-in.js - Applies a fade-in effect to playlist sounds when they start playing

import { MODULE_ID, logFeature, LogSymbols } from "./utils.js";
import { Silence } from "./silence.js";
import { advancedFade } from "./audio-fader.js";
import { debug, waitForMedia } from "./utils.js";
import { State } from "./state-manager.js";

// =========================================================================
// Fade-In Logic
// =========================================================================

/**
 * Applies a logarithmic fade-in to a sound when it starts playing.
 * It retrieves the configured fade duration from the playlist flags and
 * uses the advanced fader to smoothly transition the sound's volume.
 * @param {Playlist} playlist The parent playlist document.
 * @param {PlaylistSound} ps The playlist sound to fade in.
 */
export async function applyFadeIn(playlist, ps) {
    // Check for an API override first, fall back to the playlist flag.
    const fadeOverride = ps._sos_fadeInOverride;
    const fadeTotal = typeof fadeOverride === 'number'
        ? fadeOverride
        : (Number(playlist?.getFlag(MODULE_ID, "fadeIn") ?? 0));

    // Clean up the temporary override property after we've read it.
    if (typeof fadeOverride !== 'undefined') delete ps._sos_fadeInOverride;

    if (fadeTotal <= 0) return;

    // If a crossfade is in progress, it handles the fade-in. Do nothing here.
    if (State.isPlaylistCrossfading(playlist)) {
        debug(`[FadeIn] Skipping standard fade-in for "${ps.name}" because a crossfade is active.`);
        return;
    }

    // Defer fade-in to LoopingSound if skipping intro ---
    const loopConfig = ps.getFlag(MODULE_ID, "loopWithin");
    if (loopConfig?.enabled && !loopConfig.startFromBeginning && (loopConfig.segments?.length ?? 0) > 0) {
        debug(`[FadeIn] Deferring fade-in for "${ps.name}" to LoopingSound due to "skip intro" setting.`);
        return;
    }

    // Skip fade-in for our silent gap tracks
    if (!ps || ps.getFlag(MODULE_ID, Silence.FLAG_KEY)) return;

    const media = await waitForMedia(ps);
    if (!media) return;

    // Get the sound's intended final volume from the document
    const targetVol = ps.volume ?? 1;

    // In our main.js wrapper, we will pre-mute the sound before it plays,
    // so the fade will correctly start from an actual volume of 0.
    logFeature(LogSymbols.FADE_IN, 'Fade', `${ps.name} (${fadeTotal}ms)`);
    advancedFade(media, { targetVol, duration: fadeTotal });
}