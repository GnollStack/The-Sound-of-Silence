/**
 * @file currently-playing.js
 * @description Manages the overhauled "Currently Playing" section of the playlist sidebar.
 * Replaces Foundry's default playing.hbs and sound-partial.hbs with custom templates,
 * enriches the render context with module state (loops, normalization, crossfade),
 * and handles module-specific event delegation.
 */
import { MODULE_ID, debug } from "./utils.js";
import { Flags } from "./flag-service.js";
import { State } from "./state-manager.js";
import { findSoundById } from "./sound-cache.js";
import {
    breakLoopWithin,
    nextSegmentWithin,
    previousSegmentWithin,
    disableAllLoopsWithin,
} from "./internal-loop.js";

// =========================================================================
// Double-click protection (survives DOM re-renders)
// =========================================================================
const _disabledActions = new Set();

// =========================================================================
// Initialization
// =========================================================================

/**
 * Register the custom Currently Playing templates and libWrapper patches.
 * Called from main.js during the `ready` hook.
 */
export function registerCurrentlyPlaying() {
    // Override the PARTS definition to use our custom templates
    foundry.applications.sidebar.tabs.PlaylistDirectory.PARTS.playing = {
        template: `modules/${MODULE_ID}/templates/currently-playing.hbs`,
        templates: [`modules/${MODULE_ID}/templates/sos-sound-partial.hbs`],
    };

    // Wrap _preparePlayingContext to enrich with module state
    libWrapper.register(
        MODULE_ID,
        "foundry.applications.sidebar.tabs.PlaylistDirectory.prototype._preparePlayingContext",
        _wrapPreparePlayingContext,
        "WRAPPER"
    );

    // Listen for state changes to trigger re-renders
    const debouncedRender = foundry.utils.debounce(() => {
        ui.playlists?.render({ parts: ["playing"] });
    }, 50);
    Hooks.on(`${MODULE_ID}.stateChanged`, debouncedRender);

    // Hook into renderPlaylistDirectory to attach event delegation
    Hooks.on("renderPlaylistDirectory", _onRenderPlaylistDirectory);

    debug("[CurrentlyPlaying] Registered custom templates and wrappers.");
}

// =========================================================================
// Context Enrichment
// =========================================================================

/**
 * libWrapper WRAPPER for PlaylistDirectory._preparePlayingContext.
 * Adds module-specific data to the template context.
 */
async function _wrapPreparePlayingContext(wrapped, context, options) {
    await wrapped.call(this, context, options);

    if (!context.currentlyPlaying) return;

    // Enrich each sound context with module state
    for (const soundCtx of context.currentlyPlaying.sounds) {
        const playlist = game.playlists.get(soundCtx.playlistId);
        const ps = playlist?.sounds.get(soundCtx.id);
        if (!ps) {
            soundCtx.sos = {};
            continue;
        }

        const loopConfig = Flags.getLoopConfig(ps);
        const looper = State.getActiveLooper(ps);
        const normEnabled = Flags.getPlaylistFlag(playlist, "volumeNormalizationEnabled");
        const hasOverride = Flags.getSoundFlag(ps, "allowVolumeOverride");
        const normalizedVolume = Flags.getPlaylistFlag(playlist, "normalizedVolume") ?? 0.5;

        const silenceEnabled = !!Flags.getPlaylistFlag(playlist, "silenceEnabled");
        const crossfadeEnabled = !!Flags.getPlaylistFlag(playlist, "crossfade");

        soundCtx.sos = {
            // Playlist identity
            playlistName: playlist.name,

            // Playlist-level toggles
            silenceEnabled,
            crossfadeEnabled,

            // Loop state
            loopEnabled: loopConfig.enabled,
            loopActive: loopConfig.active,
            showLoopControls: !!(loopConfig.enabled && loopConfig.active && loopConfig.segments?.length),

            // Normalization
            normalizationEnabled: !!(normEnabled && !hasOverride),
            normalizedVolume,
            normalizedVolumeDisplay: normalizedVolume.toFixed(2),
            isGM: game.user.isGM,

            // Playlist mode
            isShuffleMode: playlist.mode === CONST.PLAYLIST_MODES.SHUFFLE,
            playlistMode: foundry.applications.sidebar.tabs.PlaylistDirectory.PLAYLIST_MODES[playlist.mode],
        };

        // Disable native volume slider if managed by normalization
        if (soundCtx.sos.normalizationEnabled && soundCtx.volume) {
            soundCtx.volume.managed = true;
        }
    }
}

// =========================================================================
// Event Delegation
// =========================================================================

/**
 * Attach delegated event listeners to the Currently Playing section.
 * Called on every renderPlaylistDirectory.
 */
function _onRenderPlaylistDirectory(app, html) {
    const el = html instanceof jQuery ? html[0] : html;
    const cp = el.querySelector?.(".currently-playing") ?? el.closest?.(".currently-playing");
    if (!cp) return;

    // Delegated click handler for all module-specific actions
    cp.removeEventListener("click", _handleSosClick);
    cp.addEventListener("click", _handleSosClick);

    // Delegated change handler for playlist volume sliders
    cp.removeEventListener("change", _handlePlaylistVolumeChange);
    cp.addEventListener("change", _handlePlaylistVolumeChange);
}

/**
 * Handle click events on elements with data-sos-action attributes.
 */
async function _handleSosClick(event) {
    const actionEl = event.target.closest("[data-sos-action]");
    if (!actionEl) return;

    const action = actionEl.dataset.sosAction;
    const soundId = actionEl.dataset.soundId;
    const playlistId = actionEl.dataset.playlistId;

    // Re-render-safe double-click protection
    const actionKey = `${action}-${soundId || playlistId}`;
    if (_disabledActions.has(actionKey)) return;
    _disabledActions.add(actionKey);
    setTimeout(() => _disabledActions.delete(actionKey), 500);

    // Visual feedback on current DOM element
    actionEl.classList.add("disabled");

    switch (action) {
        case "toggleLoop": {
            const sound = findSoundById(soundId);
            if (!sound) return;
            const currentActive = sound.getFlag(MODULE_ID, "loopWithin.active") ?? false;
            await sound.setFlag(MODULE_ID, "loopWithin.active", !currentActive);
            break;
        }

        case "prevTrack": {
            const playlist = game.playlists.get(playlistId);
            if (!playlist || !game.user.isGM) return;
            // Play previous — Foundry doesn't have a native "previous" so we use playbackOrder
            const order = playlist.playbackOrder;
            const currentIdx = order.findIndex(id => {
                const s = playlist.sounds.get(id);
                return s?.playing;
            });
            if (currentIdx > 0) {
                const prevSoundId = order[currentIdx - 1];
                const prevSound = playlist.sounds.get(prevSoundId);
                if (prevSound) await playlist.playSound(prevSound);
            }
            break;
        }

        case "nextTrack": {
            const playlist = game.playlists.get(playlistId);
            if (!playlist || !game.user.isGM) return;
            await playlist.playNext(undefined, { direction: 1 });
            break;
        }

        case "loopPrev": {
            const sound = findSoundById(soundId);
            if (sound) await previousSegmentWithin(sound);
            break;
        }

        case "loopNext": {
            const sound = findSoundById(soundId);
            if (sound) await nextSegmentWithin(sound);
            break;
        }

        case "loopBreak": {
            const sound = findSoundById(soundId);
            if (sound) await breakLoopWithin(sound);
            break;
        }

        case "loopDisable": {
            const sound = findSoundById(soundId);
            if (sound) await disableAllLoopsWithin(sound);
            break;
        }

        case "cyclePlaylistMode": {
            const playlist = game.playlists.get(playlistId);
            if (!playlist || !playlist.isOwner) return;
            await playlist.cycleMode();
            break;
        }
    }
}

/**
 * Handle change events on the playlist volume slider.
 */
const _handlePlaylistVolumeChange = foundry.utils.debounce(async (event) => {
    const slider = event.target.closest(".sos-playlist-volume-slider");
    if (!slider) return;

    const playlistId = slider.dataset.playlistId;
    const playlist = game.playlists.get(playlistId);
    if (!playlist || !game.user.isGM) return;

    const newVolume = parseFloat(slider.value);
    debug(`[CurrentlyPlaying] Setting normalized volume for "${playlist.name}" to ${newVolume}`);
    await playlist.setFlag(MODULE_ID, "normalizedVolume", newVolume);

    // Update the readout display
    const row = slider.closest(".sos-playlist-volume-row");
    const readout = row?.querySelector(".sos-vol-readout");
    if (readout) readout.textContent = newVolume.toFixed(2);
}, 100);
