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
import { Integrations } from "./integrations.js";

// =========================================================================
// Double-click protection (survives DOM re-renders)
// =========================================================================
const _disabledActions = new Set();
const _timestampProxyWarnings = new Set();

const SOUNDSCAPE_MODE_ICON = { icon: "fa-solid fa-dice-d20", label: "Soundscape" };

function _getSyntheticPlaylistMode(playlist) {
    if (
        playlist?.mode === CONST.PLAYLIST_MODES.DISABLED &&
        Flags.getPlaylistFlag(playlist, "soundscapeMode")
    ) {
        return SOUNDSCAPE_MODE_ICON;
    }
    return foundry.applications.sidebar.tabs.PlaylistDirectory.PLAYLIST_MODES[playlist?.mode];
}

// =========================================================================
// Initialization
// =========================================================================

/**
 * Register the custom Currently Playing templates and libWrapper patches.
 * Called from main.js during the `ready` hook.
 */
export function registerCurrentlyPlaying() {
    const sosTemplate = `modules/${MODULE_ID}/templates/currently-playing.hbs`;
    const sosPartials = [`modules/${MODULE_ID}/templates/sos-sound-partial.hbs`];

    // Patch PARTS.playing on the ACTUAL CONFIG.ui.playlists class.
    // When third-party modules (Monks, Playlist Enchantment) replace
    // CONFIG.ui.playlists with a subclass, that subclass defines its own
    // static PARTS which shadow the base PlaylistDirectory.PARTS.
    // The integrations layer patches the correct class.
    Integrations.patchPlayingParts(sosTemplate, sosPartials);

    // Wrap _preparePlayingContext to enrich with module state.
    // This targets the base class prototype — subclasses that call
    // super._preparePlayingContext() will trigger this wrapper.
    libWrapper.register(
        MODULE_ID,
        "foundry.applications.sidebar.tabs.PlaylistDirectory.prototype._preparePlayingContext",
        _wrapPreparePlayingContext,
        "WRAPPER"
    );

    // Foundry's updateTimestamps() assumes every currently-playing row has a
    // `.pause` control. Our procedural card intentionally replaces the normal
    // transport row, so we add a compatibility guard before the core updater runs.
    libWrapper.register(
        MODULE_ID,
        "foundry.applications.sidebar.tabs.PlaylistDirectory.prototype.updateTimestamps",
        _wrapUpdateTimestamps,
        "WRAPPER"
    );

    // Overlay the synthetic Soundscape icon in the sidebar playlist row when a
    // playlist is in the Disabled + soundscapeMode-flag state.
    libWrapper.register(
        MODULE_ID,
        "foundry.applications.sidebar.tabs.PlaylistDirectory.prototype._preparePlaylistContext",
        _wrapPreparePlaylistContext,
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
    if (Integrations.hasConflictingModules) {
        debug(
            `[CurrentlyPlaying] Patched through integration layer ` +
            `(actual class: ${CONFIG.ui.playlists?.name || "unknown"})`
        );
    }
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

    const soundContexts = Array.from(context.currentlyPlaying.sounds);
    const seen = new Set(soundContexts.map((soundCtx) => `${soundCtx.playlistId}:${soundCtx.id}`));
    const playlistOrder = new Map();

    for (const soundCtx of soundContexts) {
        if (!playlistOrder.has(soundCtx.playlistId)) {
            playlistOrder.set(soundCtx.playlistId, playlistOrder.size);
        }
    }

    // Inject synthetic entries for armed procedural tracks that Foundry's
    // native list missed. Only procedurals with playing: true (user-armed)
    // belong here — idle procedurals stay out of Currently Playing.
    for (const playlist of game.playlists) {
        const playbackMode = Flags.getPlaybackMode(playlist);
        const soundscapeActive = playbackMode.soundscape;
        const engine = State.getSoundscapeEngine(playlist);
        if (!soundscapeActive || !engine) continue;
        if (!playlistOrder.has(playlist.id)) {
            playlistOrder.set(playlist.id, playlistOrder.size);
        }

        for (const soundId of playlist.playbackOrder) {
            const ps = playlist.sounds.get(soundId);
            if (!ps || !Flags.getSoundFlag(ps, "isProcedural")) continue;
            if (!ps.playing) continue;

            const key = `${playlist.id}:${ps.id}`;
            if (seen.has(key)) continue;

            soundContexts.push({
                id: ps.id,
                uuid: ps.uuid,
                isOwner: ps.isOwner,
                name: ps.name,
                playing: false,
                repeat: ps.repeat,
                playlistId: playlist.id,
                css: "",
                play: {
                    icon: "fa-solid fa-play",
                    label: "PLAYLIST.SoundPlay",
                },
            });
            seen.add(key);
        }
    }

    // Enrich each sound context with module state.
    const playlistPolyphony = new Map();
    for (const soundCtx of soundContexts) {
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

        const playbackMode = Flags.getPlaybackMode(playlist);
        const silenceEnabled = playbackMode.silence;
        const crossfadeEnabled = playbackMode.crossfade;
        const soundscapeActive = playbackMode.soundscape;
        const isProcedural = !!Flags.getSoundFlag(ps, "isProcedural");
        const showTrackNavigation = [
            CONST.PLAYLIST_MODES.SEQUENTIAL,
            CONST.PLAYLIST_MODES.SHUFFLE,
        ].includes(playlist.mode);

        // Procedural countdown readout (local clock, so each client sees its own ETA).
        let proceduralEta = "";
        let proceduralArmed = false;
        let proceduralPlayChance = null;
        let soundscapePolyphony = null;
        if (soundscapeActive && isProcedural) {
            const engine = State.getSoundscapeEngine(playlist);
            if (engine?.isOneShotActive?.(ps.id)) {
                proceduralEta = "Playing";
            } else if (!ps.playing) {
                proceduralEta = "Idle";
            } else {
                const etaMs = engine?.getNextFireEtaMs?.(ps.id);
                if (Number.isFinite(etaMs)) {
                    proceduralEta = `Next in ~${Math.max(1, Math.ceil(etaMs / 1000))}s…`;
                    proceduralArmed = true;
                } else if (engine) {
                    proceduralEta = "Armed";
                    proceduralArmed = true;
                } else {
                    proceduralEta = "Idle";
                }
            }
            const chance = Flags.resolveProceduralField(ps, "playChance");
            if (Number.isFinite(chance) && chance < 100) proceduralPlayChance = Math.round(chance);
            if (engine?.getPolyphony) {
                soundscapePolyphony = engine.getPolyphony();
                playlistPolyphony.set(playlist.id, soundscapePolyphony);
            }
        }

        soundCtx.sos = {
            // Playlist identity
            playlistName: playlist.name,

            // Playlist-level toggles
            silenceEnabled,
            crossfadeEnabled,
            soundscapeActive,
            showTrackNavigation,

            // Loop state
            loopEnabled: loopConfig.enabled,
            loopActive: loopConfig.active,
            showLoopControls: !!(
                loopConfig.enabled &&
                loopConfig.active &&
                loopConfig.segments?.length &&
                looper &&
                !looper.loopingDisabled
            ),
            ...(() => {
                const activeStart = looper?.activeLoopSegment?.start;
                const hasActiveSegment = activeStart != null;
                const canUseLoopMenu = !!looper && !looper.isCrossfading && !looper.loopingDisabled;
                const canUseActiveSegment =
                    canUseLoopMenu &&
                    hasActiveSegment &&
                    !looper.isDestroyed;
                return {
                    canSkipPrev: canUseLoopMenu && looper?.getSkippableSegmentIndex?.(-1) != null,
                    canSkipNext: canUseLoopMenu && looper?.getSkippableSegmentIndex?.(1) != null,
                    canBreakLoop: canUseActiveSegment,
                    canDisableLoops: !!looper && !looper.loopingDisabled,
                };
            })(),

            // Procedural one-shot state
            isProcedural,
            isBedTrack: soundscapeActive && ps.repeat && !isProcedural,
            showProceduralCard: soundscapeActive && isProcedural,
            proceduralEta,
            proceduralArmed,
            proceduralPlayChance,
            soundscapePolyphony,

            // Normalization
            playlistNormalizationEnabled: !!normEnabled,
            normalizationEnabled: !!(normEnabled && !hasOverride),
            normalizedVolume,
            isGM: game.user.isGM,

            // Playlist mode
            isShuffleMode: playlist.mode === CONST.PLAYLIST_MODES.SHUFFLE,
            playlistMode: _getSyntheticPlaylistMode(playlist),
        };

        // Disable native volume slider if managed by normalization
        if (soundCtx.sos.normalizationEnabled && soundCtx.volume) {
            soundCtx.volume.managed = true;
        }
    }

    _sortCurrentlyPlayingContexts(soundContexts, playlistOrder);

    let lastPlaylistId = null;
    for (const soundCtx of soundContexts) {
        const isPlaylistGroupStart = soundCtx.playlistId !== lastPlaylistId;
        const groupPolyphony =
            playlistPolyphony.get(soundCtx.playlistId) ?? soundCtx.sos.soundscapePolyphony ?? null;
        if (groupPolyphony) {
            soundCtx.sos.soundscapePolyphony = groupPolyphony;
        }
        soundCtx.sos.showPlaylistHeader = isPlaylistGroupStart;
        soundCtx.sos.isPlaylistGroupStart = isPlaylistGroupStart;
        soundCtx.sos.showPlaylistVolumeRow = isPlaylistGroupStart && soundCtx.sos.playlistNormalizationEnabled;
        soundCtx.sos.showSoundscapePolyphony = isPlaylistGroupStart && !!groupPolyphony;
        lastPlaylistId = soundCtx.playlistId;
    }

    context.currentlyPlaying.sounds = soundContexts;
}

function _sortCurrentlyPlayingContexts(soundContexts, playlistOrder) {
    const soundOrderCache = new Map();
    const getSoundOrder = (playlistId, soundId) => {
        let order = soundOrderCache.get(playlistId);
        if (!order) {
            const playlist = game.playlists.get(playlistId);
            order = new Map((playlist?.playbackOrder ?? []).map((id, index) => [id, index]));
            soundOrderCache.set(playlistId, order);
        }
        return order.get(soundId) ?? Number.MAX_SAFE_INTEGER;
    };

    soundContexts.sort((a, b) => {
        const playlistDelta =
            (playlistOrder.get(a.playlistId) ?? Number.MAX_SAFE_INTEGER) -
            (playlistOrder.get(b.playlistId) ?? Number.MAX_SAFE_INTEGER);
        if (playlistDelta) return playlistDelta;

        const proceduralDelta =
            Number(!!a.sos?.showProceduralCard) - Number(!!b.sos?.showProceduralCard);
        if (proceduralDelta) return proceduralDelta;

        const soundDelta = getSoundOrder(a.playlistId, a.id) - getSoundOrder(b.playlistId, b.id);
        if (soundDelta) return soundDelta;

        return a.name.localeCompare(b.name);
    });
}

/**
 * Ensure custom currently-playing rows still satisfy Foundry's DOM assumptions
 * before PlaylistDirectory.updateTimestamps() runs.
 */
function _wrapUpdateTimestamps(wrapped, ...args) {
    _ensureTimestampCompatibility(this);
    return wrapped.call(this, ...args);
}

/**
 * Replace the mode icon for Soundscape playlists with the dice-d20 entry so
 * the sidebar cycle icon matches the Currently Playing cycle button.
 */
function _wrapPreparePlaylistContext(wrapped, root, playlist) {
    const ctx = wrapped.call(this, root, playlist);
    if (
        playlist?.mode === CONST.PLAYLIST_MODES.DISABLED &&
        Flags.getPlaylistFlag(playlist, "soundscapeMode")
    ) {
        ctx.mode = SOUNDSCAPE_MODE_ICON;
    }
    return ctx;
}

function _ensureTimestampCompatibility(app) {
    const sections = document.querySelectorAll(".playlists-sidebar .currently-playing");
    if (!sections.length || !app?._playing?.sounds?.length) return;

    for (const section of sections) {
        for (const sound of app._playing.sounds) {
            const row = section.querySelector(`.sound[data-sound-uuid="${sound.uuid}"]`);
            if (!row || row.querySelector(".pause")) continue;

            const proxy = document.createElement("i");
            proxy.className = "pause fa-solid fa-pause sos-timestamp-proxy";
            proxy.hidden = true;
            proxy.setAttribute("aria-hidden", "true");
            row.append(proxy);

            if (_timestampProxyWarnings.has(sound.uuid)) continue;
            const soundType = Flags.getSoundFlag(sound, "isProcedural") ? "procedural" : "standard";
            debug(
                `[CurrentlyPlaying] Added timestamp pause proxy for ` +
                `"${sound.name}" in "${sound.parent?.name}" (${soundType}).`
            );
            _timestampProxyWarnings.add(sound.uuid);
        }
    }
}

function _syncCurrentlyPlayingVisibility(app, cp) {
    const hasRenderedRows = !!cp.querySelector(".sound");
    const nativeCount = app?._playing?.sounds?.length ?? 0;
    const shouldShow = hasRenderedRows || nativeCount > 0;
    if (cp.hidden === !shouldShow) return;

    cp.hidden = !shouldShow;
    debug(
        `[CurrentlyPlaying] ${shouldShow ? "Showing" : "Hiding"} widget ` +
        `(rows=${hasRenderedRows ? "yes" : "no"}, native=${nativeCount})`
    );
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

    _syncCurrentlyPlayingVisibility(app, cp);

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
    if (actionEl.disabled || actionEl.classList.contains("disabled")) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

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
            if (!game.user.isGM) return;
            const sound = findSoundById(soundId);
            if (!sound) return;
            const currentActive = Flags.getLoopConfig(sound).active;
            await sound.setFlag(MODULE_ID, "loopWithin.active", !currentActive);
            break;
        }

        case "prevTrack": {
            const playlist = game.playlists.get(playlistId);
            if (!playlist || !game.user.isGM) return;
            await playlist.playNext(soundId, { direction: -1 });
            break;
        }

        case "nextTrack": {
            const playlist = game.playlists.get(playlistId);
            if (!playlist || !game.user.isGM) return;
            await playlist.playNext(soundId, { direction: 1 });
            break;
        }

        case "soundscapeFireNow": {
            if (!game.user.isGM) return;
            const playlist = game.playlists.get(playlistId);
            const engine = playlist ? State.getSoundscapeEngine(playlist) : null;
            if (!engine?.fireOneShotNow) return;
            await engine.fireOneShotNow(soundId);
            break;
        }

        case "loopPrev": {
            if (!game.user.isGM) return;
            const sound = findSoundById(soundId);
            if (sound) await previousSegmentWithin(sound);
            break;
        }

        case "loopNext": {
            if (!game.user.isGM) return;
            const sound = findSoundById(soundId);
            if (sound) await nextSegmentWithin(sound);
            break;
        }

        case "loopBreak": {
            if (!game.user.isGM) return;
            const sound = findSoundById(soundId);
            if (sound) await breakLoopWithin(sound);
            break;
        }

        case "loopDisable": {
            if (!game.user.isGM) return;
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

        case "soundscapeStopAll": {
            if (!game.user.isGM) return;
            const playlist = game.playlists.get(playlistId);
            if (!playlist) return;
            await playlist.stopAll();
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
}, 100);
