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
let _playlistScrollPreservationRegistered = false;
let _currentlyPlayingTicker = null;
const CURRENTLY_PLAYING_TICK_MS = 500;
const _playlistDirectoryScrollMemory = new WeakMap();
const PLAYLIST_SCROLL_TARGETS = Object.freeze({
    root: ":scope",
    directoryPart: '[data-application-part="directory"]',
    directoryList: ".directory-list",
    currentlyPlaying: ".currently-playing",
    playingList: ".currently-playing .playlist-sounds.plain",
});

const SOUNDSCAPE_MODE_ICON = { icon: "fa-solid fa-dice-d20", label: "Soundscape" };

function _getScrollElement(root, selector) {
    if (!root) return null;
    if (selector === ":scope") return root;
    return root.querySelector?.(selector) ?? null;
}

function _readScrollPosition(root, selector) {
    const element = _getScrollElement(root, selector);
    if (!element) return null;
    return {
        scrollTop: element.scrollTop,
        scrollLeft: element.scrollLeft,
        scrollHeight: element.scrollHeight,
        scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight,
        clientWidth: element.clientWidth,
    };
}

function _capturePlaylistScrollPositions(appOrElement) {
    const element = appOrElement?.element ?? appOrElement;
    if (!element) return null;

    const targets = {};
    for (const [key, selector] of Object.entries(PLAYLIST_SCROLL_TARGETS)) {
        targets[key] = _readScrollPosition(element, selector);
    }

    return {
        appId: appOrElement?.id ?? element.id ?? null,
        capturedAt: Date.now(),
        targets,
    };
}

function _hasScrollablePosition(snapshot) {
    if (!snapshot?.targets) return false;
    return Object.values(snapshot.targets).some((target) => {
        if (!target) return false;
        return target.scrollTop > 0 ||
            target.scrollLeft > 0 ||
            target.scrollHeight > target.clientHeight + 1 ||
            target.scrollWidth > target.clientWidth + 1;
    });
}

function _rememberPlaylistDirectoryScroll(app) {
    const snapshot = _capturePlaylistScrollPositions(app);
    if (!snapshot || !_hasScrollablePosition(snapshot)) return null;
    _playlistDirectoryScrollMemory.set(app, snapshot);
    return snapshot;
}

function _restoreScrollTarget(root, selector, saved) {
    const element = _getScrollElement(root, selector);
    if (!element || !saved) return false;

    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const maxLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    const nextTop = Math.max(0, Math.min(saved.scrollTop ?? 0, maxTop));
    const nextLeft = Math.max(0, Math.min(saved.scrollLeft ?? 0, maxLeft));
    const beforeTop = element.scrollTop;
    const beforeLeft = element.scrollLeft;

    element.scrollTop = nextTop;
    element.scrollLeft = nextLeft;

    return element.scrollTop !== beforeTop ||
        element.scrollLeft !== beforeLeft ||
        (beforeTop !== nextTop || beforeLeft !== nextLeft);
}

function _restorePlaylistDirectoryScroll(app, label) {
    const snapshot = _playlistDirectoryScrollMemory.get(app);
    const element = app?.element;
    if (!snapshot || !element) return false;

    let changed = false;
    for (const [key, selector] of Object.entries(PLAYLIST_SCROLL_TARGETS)) {
        changed = _restoreScrollTarget(element, selector, snapshot.targets[key]) || changed;
    }
    return changed;
}

function _schedulePlaylistDirectoryScrollRestore(app, label) {
    if (!app || !_playlistDirectoryScrollMemory.has(app)) return;
    _restorePlaylistDirectoryScroll(app, label);
    globalThis.queueMicrotask?.(() => _restorePlaylistDirectoryScroll(app, `${label}:microtask`));
    globalThis.requestAnimationFrame?.(() => _restorePlaylistDirectoryScroll(app, `${label}:raf`));
    setTimeout(() => _restorePlaylistDirectoryScroll(app, `${label}:timeout`), 50);
}

function _clampPercent(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value));
}

function _getSoundPlaybackPosition(ps) {
    const media = ps?.sound;
    const duration = Number(media?.duration);
    const hasDuration = Number.isFinite(duration) && duration > 0;

    const liveTime = Number(media?.currentTime);
    const pausedTime = Number(ps?.pausedTime);
    const rawTime = ps?.playing && Number.isFinite(liveTime)
        ? liveTime
        : pausedTime;
    const currentTime = Number.isFinite(rawTime)
        ? rawTime
        : (Number.isFinite(liveTime) ? liveTime : 0);

    return {
        currentTime: Math.max(0, currentTime),
        duration: hasDuration ? duration : 0,
        progressPct: hasDuration ? _clampPercent((currentTime / duration) * 100) : 0,
    };
}

function _getSoundProgressPct(ps) {
    return _getSoundPlaybackPosition(ps).progressPct;
}

function _formatCurrentlyPlayingTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = String(total % 60).padStart(2, "0");

    if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${secs}`;
    return `${minutes}:${secs}`;
}

function _formatFadeDuration(ms) {
    const value = Math.max(0, Math.round(Number(ms) || 0));
    return `${value}ms`;
}

function _getSoundFadeZones(playlist, ps, durationSeconds) {
    const durationMs = Number(durationSeconds) * 1000;
    const hasDuration = Number.isFinite(durationMs) && durationMs > 0;
    const fadeInMs = Math.max(0, Number(Flags.getPlaylistFlag(playlist, "fadeIn") ?? 0) || 0);
    const fadeOutMs = Math.max(0, Number(playlist?.fade ?? 0) || 0);

    const fadeInPct = hasDuration ? _clampPercent((fadeInMs / durationMs) * 100) : 0;
    const fadeOutPct = hasDuration ? _clampPercent((fadeOutMs / durationMs) * 100) : 0;
    const showFadeInZone = hasDuration && fadeInMs > 0 && fadeInPct > 0;
    const showFadeOutZone = hasDuration && fadeOutMs > 0 && fadeOutPct > 0 && !ps?.repeat;

    return {
        showFadeInZone,
        showFadeOutZone,
        fadeInPct: fadeInPct.toFixed(2),
        fadeOutPct: fadeOutPct.toFixed(2),
        fadeOutStartPct: (100 - fadeOutPct).toFixed(2),
        fadeInLabel: showFadeInZone ? `Fade In: ${_formatFadeDuration(fadeInMs)}` : "",
        fadeOutLabel: showFadeOutZone ? `Fade Out: ${_formatFadeDuration(fadeOutMs)}` : "",
    };
}

function _getSoundscapeProceduralStatus(playlist, ps) {
    const engine = State.getSoundscapeEngine(playlist);
    if (engine?.isOneShotActive?.(ps.id)) return { eta: "Playing", etaMs: null, armed: false };
    if (!ps?.playing) return { eta: "Idle", etaMs: null, armed: false };
    if (engine?.isOneShotPending?.(ps.id)) return { eta: "Loading", etaMs: null, armed: false };

    const etaMs = engine?.getNextFireEtaMs?.(ps.id);
    if (Number.isFinite(etaMs)) {
        const displayEtaMs = Math.max(1000, etaMs);
        return {
            eta: `Next in ~${Math.ceil(displayEtaMs / 1000)}s\u2026`,
            etaMs: displayEtaMs,
            armed: true,
        };
    }
    if (engine) return { eta: "Armed", etaMs: null, armed: true };
    return { eta: "Idle", etaMs: null, armed: false };
}

function _formatSoundscapeEta(etaMs) {
    if (!Number.isFinite(etaMs)) return "";
    return `~${Math.max(1, Math.ceil(etaMs / 1000))}s`;
}

function _getNextProceduralEtaMs(procs) {
    let minMs = Infinity;
    for (const proc of procs) {
        const etaMs = proc?.sos?.proceduralEtaMs;
        if (Number.isFinite(etaMs)) minMs = Math.min(minMs, etaMs);
    }
    return Number.isFinite(minMs) ? minMs : null;
}

function _pluralize(count, singular, plural = `${singular}s`) {
    return count === 1 ? singular : plural;
}

function _buildSoundscapeSummary(beds, procs) {
    const bedsCount = beds.length;
    const procsCount = procs.length;
    const nextEta = _formatSoundscapeEta(_getNextProceduralEtaMs(procs));
    return {
        bedsCount,
        procsCount,
        bedsLabel: `${bedsCount} ${_pluralize(bedsCount, "bed")} playing`,
        procsLabel: `${procsCount} ambient ${_pluralize(procsCount, "sound")} armed`,
        nextEta,
        nextMeta: nextEta ? `next ${nextEta}` : "",
    };
}

function _buildCurrentlyPlayingGroups(soundContexts) {
    const groups = [];
    let currentGroup = null;

    for (const soundCtx of soundContexts) {
        const playlist = game.playlists.get(soundCtx.playlistId);
        const isSoundscape = !!soundCtx.sos?.soundscapeActive;

        if (!currentGroup || currentGroup.playlistId !== soundCtx.playlistId) {
            const collapsed = !!(playlist && game.user.getFlag(MODULE_ID, `cp-collapsed.${playlist.id}`));
            currentGroup = {
                playlistId: soundCtx.playlistId,
                playlistName: playlist?.name ?? soundCtx.sos?.playlistName ?? "",
                isSoundscape,
                polyphony: soundCtx.sos?.soundscapePolyphony ?? null,
                isGM: game.user.isGM,
                collapsed,
                ariaExpanded: collapsed ? "false" : "true",
                caretIcon: collapsed ? "fa-caret-right" : "fa-caret-down",
                toggleTooltip: collapsed ? "Expand Soundscape" : "Collapse Soundscape",
                beds: [],
                procs: [],
                sounds: [],
                stopAllAvailable: isSoundscape && game.user.isGM,
                procCountLabel: "",
                summary: null,
            };
            groups.push(currentGroup);
        }

        currentGroup.sounds.push(soundCtx);
        if (!currentGroup.isSoundscape) continue;

        if (soundCtx.sos?.showProceduralCard) currentGroup.procs.push(soundCtx);
        else currentGroup.beds.push(soundCtx);

        currentGroup.polyphony = currentGroup.polyphony ?? soundCtx.sos?.soundscapePolyphony ?? null;
    }

    for (const group of groups) {
        if (!group.isSoundscape) continue;
        group.summary = _buildSoundscapeSummary(group.beds, group.procs);
        group.procCountLabel = `${group.procs.length}`;
    }

    return groups;
}

function _getCurrentlyPlayingSections(root = ui.playlists?.element ?? document) {
    const element = root?.element ?? root;
    if (!element?.querySelectorAll) return [];
    if (element.matches?.(".currently-playing")) return [element];
    return Array.from(element.querySelectorAll(".currently-playing"));
}

function _soundscapeStateCanUpdateInPlace(context) {
    return context?.soundscapeOnly === true;
}

function _mergeUiStateContexts(current, next = {}) {
    const normalizedNext = {
        ...next,
        soundscapeOnly: next.soundscapeOnly === true,
    };
    if (!current) return normalizedNext;

    const reasons = new Set([
        ...(Array.isArray(current.reasons) ? current.reasons : []),
        current.reason,
        ...(Array.isArray(normalizedNext.reasons) ? normalizedNext.reasons : []),
        normalizedNext.reason,
    ].filter(Boolean));

    return {
        ...current,
        ...normalizedNext,
        soundscapeOnly: current.soundscapeOnly === true && normalizedNext.soundscapeOnly === true,
        reason: Array.from(reasons).join(",") || undefined,
        reasons: Array.from(reasons),
    };
}

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
    const sosPartials = [
        `modules/${MODULE_ID}/templates/sos-sound-partial.hbs`,
        `modules/${MODULE_ID}/templates/sos-sound-content.hbs`,
        `modules/${MODULE_ID}/templates/sos-soundscape-group.hbs`,
    ];

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

    _registerPlaylistScrollPreservation();

    // Listen for state changes to trigger re-renders
    let pendingRenderContext = null;
    const debouncedRender = foundry.utils.debounce(() => {
        const context = pendingRenderContext ?? {};
        pendingRenderContext = null;

        if (_soundscapeStateCanUpdateInPlace(context)) {
            const updated = _updateSoundscapeReadouts(ui.playlists);
            if (updated) return;
        }

        ui.playlists?.render({ parts: ["playing"] });
    }, 50);
    Hooks.on(`${MODULE_ID}.stateChanged`, (context = {}) => {
        pendingRenderContext = _mergeUiStateContexts(pendingRenderContext, context);
        debouncedRender();
    });

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
        const playbackPosition = _getSoundPlaybackPosition(ps);
        const progressPct = playbackPosition.progressPct;
        const fadeZones = _getSoundFadeZones(playlist, ps, playbackPosition.duration);

        // Procedural countdown readout (local clock, so each client sees its own ETA).
        let proceduralEta = "";
        let proceduralEtaMs = null;
        let proceduralArmed = false;
        let proceduralPlayChance = null;
        let showProceduralPlayChance = false;
        let soundscapePolyphony = null;
        if (soundscapeActive && isProcedural) {
            const proceduralStatus = _getSoundscapeProceduralStatus(playlist, ps);
            proceduralEta = proceduralStatus.eta;
            proceduralEtaMs = proceduralStatus.etaMs;
            proceduralArmed = proceduralStatus.armed;

            const engine = State.getSoundscapeEngine(playlist);
            const chance = Flags.resolveProceduralField(ps, "playChance");
            if (Number.isFinite(chance) && chance < 100) {
                proceduralPlayChance = Math.round(chance);
                showProceduralPlayChance = true;
            }
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
                !looper.isDestroyed &&
                !looper.loopingDisabled
            ),
            ...(() => {
                const activeStart = looper?.activeLoopSegment?.start;
                const hasActiveSegment = activeStart != null;
                const canUseLoopMenu = !!looper && !looper.isDestroyed && !looper.isCrossfading && !looper.loopingDisabled;
                const canUseActiveSegment =
                    canUseLoopMenu &&
                    hasActiveSegment &&
                    !looper.isDestroyed;
                return {
                    canSkipPrev: canUseLoopMenu && looper?.getSkippableSegmentIndex?.(-1) != null,
                    canSkipNext: canUseLoopMenu && looper?.getSkippableSegmentIndex?.(1) != null,
                    canBreakLoop: canUseActiveSegment,
                    canDisableLoops: !!looper && !looper.isDestroyed && !looper.loopingDisabled,
                };
            })(),

            // Procedural one-shot state
            isProcedural,
            isBedTrack: soundscapeActive && ps.repeat && !isProcedural,
            showProceduralCard: soundscapeActive && isProcedural,
            showProgressCard: !isProcedural,
            showGroupBedCard: soundscapeActive && !isProcedural,
            proceduralEta,
            proceduralEtaMs,
            proceduralArmed,
            proceduralPlayChance,
            showProceduralPlayChance,
            soundscapePolyphony,

            // Normalization
            playlistNormalizationEnabled: !!normEnabled,
            normalizationEnabled: !!(normEnabled && !hasOverride),
            normalizedVolume,
            progressPct: progressPct.toFixed(2),
            ...fadeZones,
            isGM: game.user.isGM,

            // Playlist mode
            isShuffleMode: playlist.mode === CONST.PLAYLIST_MODES.SHUFFLE,
            playlistMode: _getSyntheticPlaylistMode(playlist),
        };

        // Disable native volume slider if managed by normalization
        if (soundCtx.sos.normalizationEnabled && soundCtx.volume) {
            soundCtx.volume.managed = true;
            soundCtx.volume.disabled = true;
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
        soundCtx.sos.showPlaylistVolumeRow = !!(
            soundCtx.sos.playlistNormalizationEnabled &&
            !soundCtx.sos.showProceduralCard &&
            (!soundCtx.sos.soundscapeActive || isPlaylistGroupStart)
        );
        soundCtx.sos.showSoundscapePolyphony = isPlaylistGroupStart && !!groupPolyphony;
        lastPlaylistId = soundCtx.playlistId;
    }

    context.currentlyPlaying.sounds = soundContexts;
    context.currentlyPlaying.groups = _buildCurrentlyPlayingGroups(soundContexts);
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

function _hasCurrentlyPlayingReadouts(app = ui.playlists) {
    return _getCurrentlyPlayingSections(app).some((section) =>
        !!section.querySelector(".sos-progress-fill, .sos-procedural-eta, .sos-soundscape-strip")
    );
}

function _startCurrentlyPlayingTicker() {
    if (_currentlyPlayingTicker) return;
    _currentlyPlayingTicker = globalThis.setInterval(
        _tickCurrentlyPlayingReadouts,
        CURRENTLY_PLAYING_TICK_MS
    );
}

function _stopCurrentlyPlayingTicker() {
    if (!_currentlyPlayingTicker) return;
    globalThis.clearInterval(_currentlyPlayingTicker);
    _currentlyPlayingTicker = null;
}

function _syncCurrentlyPlayingTicker(app = ui.playlists, { immediate = true } = {}) {
    if (_hasCurrentlyPlayingReadouts(app)) {
        _startCurrentlyPlayingTicker();
        if (immediate) _tickCurrentlyPlayingReadouts(app);
    } else {
        _stopCurrentlyPlayingTicker();
    }
}

function _tickCurrentlyPlayingReadouts(app = ui.playlists) {
    _updateProgressBars(app);
    _updateSoundscapeReadouts(app);
    if (!_hasCurrentlyPlayingReadouts(app)) _stopCurrentlyPlayingTicker();
}

/**
 * Ensure custom currently-playing rows still satisfy Foundry's DOM assumptions
 * before PlaylistDirectory.updateTimestamps() runs.
 */
function _wrapUpdateTimestamps(wrapped, ...args) {
    _ensureTimestampCompatibility(this);
    const result = wrapped.call(this, ...args);
    _updateProgressBars(this);
    _updateSoundscapeReadouts(this);
    _syncCurrentlyPlayingTicker(this, { immediate: false });
    return result;
}

function _registerPlaylistScrollPreservation() {
    if (_playlistScrollPreservationRegistered) return;
    _playlistScrollPreservationRegistered = true;

    try {
        libWrapper.register(
            MODULE_ID,
            "foundry.applications.sidebar.tabs.PlaylistDirectory.prototype._preSyncPartState",
            function (wrapped, partId, newElement, priorElement, state) {
                const shouldTrack = ["playing", "directory"].includes(partId);
                if (shouldTrack) {
                    _rememberPlaylistDirectoryScroll(this);
                }
                return wrapped.call(this, partId, newElement, priorElement, state);
            },
            "WRAPPER"
        );

        libWrapper.register(
            MODULE_ID,
            "foundry.applications.sidebar.tabs.PlaylistDirectory.prototype._syncPartState",
            function (wrapped, partId, newElement, priorElement, state) {
                const shouldTrack = ["playing", "directory"].includes(partId);
                const result = wrapped.call(this, partId, newElement, priorElement, state);
                if (shouldTrack) {
                    _schedulePlaylistDirectoryScrollRestore(this, `_syncPartState:${partId}`);
                }
                return result;
            },
            "WRAPPER"
        );
    } catch (err) {
        debug(`[CurrentlyPlaying] Failed to register playlist scroll preservation: ${err?.message}`);
    }
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

function _updateProgressBars(app) {
    const sections = _getCurrentlyPlayingSections(app);
    if (!sections.length) return false;

    let foundProgressRow = false;
    for (const section of sections) {
        const rows = section.querySelectorAll(".sound[data-playlist-id][data-sound-id]");
        for (const row of rows) {
            const fill = row.querySelector(".sos-progress-fill");
            if (!fill) continue;

            const playlist = game.playlists.get(row.dataset.playlistId);
            const sound = playlist?.sounds.get(row.dataset.soundId);
            if (!sound) continue;

            foundProgressRow = true;
            const position = _getSoundPlaybackPosition(sound);
            fill.style.width = `${position.progressPct.toFixed(2)}%`;

            const fadeZones = _getSoundFadeZones(playlist, sound, position.duration);
            _updateProgressFadeZone(row.querySelector(".sos-progress-fade-in"), {
                show: fadeZones.showFadeInZone,
                widthPct: fadeZones.fadeInPct,
                label: fadeZones.fadeInLabel,
            });
            _updateProgressFadeZone(row.querySelector(".sos-progress-fade-out"), {
                show: fadeZones.showFadeOutZone,
                leftPct: fadeZones.fadeOutStartPct,
                widthPct: fadeZones.fadeOutPct,
                label: fadeZones.fadeOutLabel,
            });

            const currentEl = row.querySelector(".sound-timer .current");
            if (currentEl) currentEl.textContent = _formatCurrentlyPlayingTime(position.currentTime);

            const durationEl = row.querySelector(".sound-timer .duration");
            if (durationEl && position.duration > 0) {
                durationEl.textContent = _formatCurrentlyPlayingTime(position.duration);
            }
        }
    }

    return foundProgressRow;
}

function _updateProgressFadeZone(element, { show, leftPct = "0.00", widthPct = "0.00", label = "" } = {}) {
    if (!element) return;
    element.hidden = !show;
    if (!show) {
        element.style.left = "0%";
        element.style.width = "0%";
        element.removeAttribute("data-tooltip");
        return;
    }

    element.style.left = `${leftPct}%`;
    element.style.width = `${widthPct}%`;
    element.dataset.tooltip = label;
}

function _dataSelector(attribute, value) {
    const text = String(value ?? "");
    const escaped = globalThis.CSS?.escape
        ? CSS.escape(text)
        : text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `[${attribute}="${escaped}"]`;
}

function _setTextAndVisibility(element, text) {
    if (!element) return false;
    const nextText = text ?? "";
    const wasHidden = element.hidden;
    let changed = false;

    if (element.textContent !== nextText) {
        element.textContent = nextText;
        changed = true;
    }
    element.hidden = !nextText;
    return changed || element.hidden !== wasHidden;
}

function _updateSoundscapeReadouts(app) {
    const sections = _getCurrentlyPlayingSections(app);
    if (!sections.length) return false;

    let updated = false;
    for (const playlist of game.playlists ?? []) {
        const playbackMode = Flags.getPlaybackMode(playlist);
        const engine = State.getSoundscapeEngine(playlist);
        if (!playbackMode.soundscape && !engine) continue;

        const playlistSelector = _dataSelector("data-playlist-id", playlist.id);
        const polyphony = engine?.getPolyphony?.();
        if (polyphony) {
            for (const section of sections) {
                const valueEl = section.querySelector(`${playlistSelector} .sos-polyphony-value`);
                if (!valueEl) continue;
                const nextText = `${polyphony.active}/${polyphony.max}`;
                if (valueEl.textContent !== nextText) valueEl.textContent = nextText;
                updated = true;
            }
        }

        const proceduralStatuses = [];
        for (const soundId of playlist.playbackOrder ?? []) {
            const ps = playlist.sounds.get(soundId);
            if (!ps || !Flags.getSoundFlag(ps, "isProcedural")) continue;

            const status = playbackMode.soundscape
                ? _getSoundscapeProceduralStatus(playlist, ps)
                : { eta: "Idle", etaMs: null, armed: false };
            proceduralStatuses.push({ sos: { proceduralEtaMs: status.etaMs } });
            const rowSelector = `.sound${playlistSelector}${_dataSelector("data-sound-id", ps.id)}`;

            for (const section of sections) {
                const row = section.querySelector(rowSelector);
                if (!row) continue;

                const etaEl = row.querySelector(".sos-procedural-eta");
                if (etaEl && etaEl.textContent !== status.eta) {
                    etaEl.textContent = status.eta;
                }

                const fireButton = row.querySelector('.sos-procedural-fire-btn[data-sos-action="soundscapeFireNow"]');
                if (fireButton) {
                    fireButton.disabled = !status.armed || !game.user?.isGM;
                }

                updated = true;
            }
        }

        const nextMeta = (() => {
            const nextEta = _formatSoundscapeEta(_getNextProceduralEtaMs(proceduralStatuses));
            return nextEta ? `next ${nextEta}` : "";
        })();

        for (const section of sections) {
            const groupSelector = `.sos-soundscape-strip${playlistSelector}`;
            const summaryMeta = section.querySelector(`${groupSelector} .sos-summary-row.proc .meta`);
            const sectionNext = section.querySelector(`${groupSelector} .sos-proc-section-header .next`);
            updated = _setTextAndVisibility(summaryMeta, nextMeta) || updated;
            updated = _setTextAndVisibility(sectionNext, nextMeta) || updated;
        }
    }

    return updated;
}

function _syncCurrentlyPlayingVisibility(app, cp) {
    const hasRenderedRows = !!cp.querySelector(".sound, .sos-soundscape-strip");
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
function _onRenderPlaylistDirectory(app, html, context, options) {
    const el = html instanceof jQuery ? html[0] : html;
    _schedulePlaylistDirectoryScrollRestore(app, "renderPlaylistDirectory");
    _attachPlaylistDirectoryWheelGuard(el);

    const cp = el.querySelector?.(".currently-playing") ?? el.closest?.(".currently-playing");
    if (!cp) return;

    _syncCurrentlyPlayingVisibility(app, cp);
    _syncCurrentlyPlayingTicker(app);

    // Delegated click handler for all module-specific actions
    cp.removeEventListener("click", _handleSosClick);
    cp.addEventListener("click", _handleSosClick);

    cp.removeEventListener("keydown", _handleSosKeydown);
    cp.addEventListener("keydown", _handleSosKeydown);

    // Delegated change handler for playlist volume sliders
    cp.removeEventListener("change", _handlePlaylistVolumeChange);
    cp.addEventListener("change", _handlePlaylistVolumeChange);

    // Keep wheel scrolling pinned to the combined Currently Playing list even
    // when the pointer is over a card control or another module captures the sidebar.
    cp.removeEventListener("wheel", _handleCurrentlyPlayingWheel);
    cp.addEventListener("wheel", _handleCurrentlyPlayingWheel, { passive: false });
}

/**
 * Handle click events on elements with data-sos-action attributes.
 */
async function _handleSosClick(event) {
    const actionEl = event.target.closest("[data-sos-action]");
    await _handleSosAction(event, actionEl);
}

async function _handleSosKeydown(event) {
    if (!["Enter", " "].includes(event.key)) return;
    if (event.target.closest?.("button, input, select, textarea, a[href]")) return;
    const actionEl = event.target.closest('[data-sos-action="toggleSoundscapeGroup"]');
    await _handleSosAction(event, actionEl);
}

async function _handleSosAction(event, actionEl) {
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

        case "toggleSoundscapeGroup": {
            const playlist = game.playlists.get(playlistId);
            if (!playlist) return;
            const flagPath = `cp-collapsed.${playlist.id}`;
            const current = !!game.user.getFlag(MODULE_ID, flagPath);
            await game.user.setFlag(MODULE_ID, flagPath, !current);
            ui.playlists?.render({ parts: ["playing"] });
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

function _attachPlaylistDirectoryWheelGuard(root) {
    const directoryList = root?.querySelector?.(PLAYLIST_SCROLL_TARGETS.directoryList);
    if (!directoryList) return;
    directoryList.removeEventListener("wheel", _handlePlaylistDirectoryWheel);
    directoryList.addEventListener("wheel", _handlePlaylistDirectoryWheel, { passive: false });
}

function _isVolumeWheelTarget(target) {
    if (!target?.closest) return false;
    return !!target.closest([
        ".sos-volume-col",
        ".sos-volume-row",
        "range-picker",
        'input[type="range"]',
        'input[type="number"]',
        ".sound-volume",
        ".sos-playlist-volume-slider",
    ].join(","));
}

function _pinWheelToScrollElement(event, scrollElement) {
    if (_isVolumeWheelTarget(event.target)) return;
    if (!scrollElement) return;

    const maxScroll = scrollElement.scrollHeight - scrollElement.clientHeight;
    if (maxScroll <= 1) return;

    let delta = Number(event.deltaY) || 0;
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= scrollElement.clientHeight;
    if (!delta) return;

    const before = scrollElement.scrollTop;
    scrollElement.scrollTop = Math.max(0, Math.min(maxScroll, before + delta));

    event.stopPropagation();
    if (scrollElement.scrollTop !== before) {
        event.preventDefault();
        _rememberPlaylistDirectoryScroll(ui.playlists);
    }
}

function _handlePlaylistDirectoryWheel(event) {
    _pinWheelToScrollElement(event, event.currentTarget);
}

function _handleCurrentlyPlayingWheel(event) {
    const cp = event.currentTarget;
    const list = cp?.querySelector?.(":scope > .playlist-sounds.plain")
        ?? cp?.querySelector?.(".playlist-sounds.plain");
    _pinWheelToScrollElement(event, list);
}
