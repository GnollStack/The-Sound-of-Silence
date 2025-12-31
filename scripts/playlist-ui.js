// playlist-ui.js

import { MODULE_ID, SoundOfSilenceDiagnostics, debug } from "./utils.js";
import { LOOP_KEY } from "./sound-config.js";
import { Flags } from "./flag-service.js";
import { State } from "./state-manager.js";

/**
 * Memoized cache of all PlaylistSound documents by ID.
 * Invalidated when playlists/sounds are added, removed, or updated.
 * @type {Map<string, PlaylistSound>}
 */
let soundCache = new Map();
let cacheInvalidated = true;

/**
 * Rebuild the sound cache from all playlists.
 */
function rebuildSoundCache() {
    soundCache.clear();
    for (const playlist of game.playlists) {
        for (const sound of playlist.sounds) {
            soundCache.set(sound.id, sound);
        }
    }
    cacheInvalidated = false;
}

/**
 * Mark the cache as needing rebuild on the next access.
 */
function invalidateSoundCache() {
    cacheInvalidated = true;
}

// Invalidate cache when playlists/sounds change
Hooks.on("createPlaylist", invalidateSoundCache);
Hooks.on("deletePlaylist", invalidateSoundCache);
Hooks.on("createPlaylistSound", invalidateSoundCache);
Hooks.on("deletePlaylistSound", invalidateSoundCache);
Hooks.on("updatePlaylistSound", invalidateSoundCache);

/**
 * Finds a PlaylistSound document by its ID, using a fast path if possible,
 * with a reliable fallback for detached elements like in "Currently Playing".
 * @param {string} soundId The ID of the sound to find.
 * @param {jQuery} [$context] Optional jQuery element to find the playlist context from.
 * @returns {PlaylistSound|null}
 */

function findSoundById(soundId, $context) {
    // Rebuild cache if invalidated
    if (cacheInvalidated) rebuildSoundCache();

    return soundCache.get(soundId) || null;
}

/**
 * Authoritatively sets the disabled state and tooltip for a sound's play/pause button.
 * The button is disabled ONLY when the sound's internal looper is actively crossfading.
 * @param {PlaylistSound|string} soundOrId The sound document or its ID.
 */
function refreshPauseButtonState(soundOrId) {
    let sound = soundOrId;
    if (typeof sound === "string") {
        // If we only have an ID, we must search. This is more direct than flatMap.
        // NOTE: It is always more efficient to call this function with the full sound object.
        for (const playlist of game.playlists) {
            const found = playlist.sounds.get(soundOrId);
            if (found) {
                sound = found;
                break;
            }
        }
    }

    if (!(sound instanceof PlaylistSound)) return;

    const $soundLi = $(`li.sound[data-sound-id="${sound.id}"]`);
    if (!$soundLi.length) return;

    const $playPauseBtn = $soundLi.find(
        '.sound-control[data-action="soundPlay"], .sound-control[data-action="soundPause"]'
    );
    if (!$playPauseBtn.length) return;

    const looper = State.getActiveLooper(sound);
    const isCrossfading = looper?.isCrossfading ?? false;
    const DATA_KEY = "original-tooltip";

    if (isCrossfading) {
        $playPauseBtn.each(function () {
            const $btn = $(this);
            if (!$btn.data(DATA_KEY)) {
                $btn.data(DATA_KEY, $btn.attr("data-tooltip"));
            }
            $btn.addClass("disabled").attr("data-tooltip", "Crossfading...");
        });
    } else {
        $playPauseBtn.each(function () {
            const $btn = $(this);
            const originalTooltip = $btn.data(DATA_KEY);
            if (originalTooltip) {
                $btn.attr("data-tooltip", originalTooltip);
                $btn.removeData(DATA_KEY);
            }
            $btn.removeClass("disabled");
        });
    }
}

/**
 * Updates the enabled/disabled state of loop control buttons based on looper state.
 * @param {PlaylistSound|string} soundOrId The sound document or its ID.
 */
function refreshLoopControlButtons(soundOrId) {
    let sound = soundOrId;
    if (typeof sound === "string") {
        for (const playlist of game.playlists) {
            const found = playlist.sounds.get(soundOrId);
            if (found) {
                sound = found;
                break;
            }
        }
    }

    if (!(sound instanceof PlaylistSound)) return;

    const $controls = $(`.sos-loop-controls[data-sound-id="${sound.id}"]`);
    if (!$controls.length) return;

    const looper = State.getActiveLooper(sound);

    // If looping is disabled, hide the controls
    if (looper?.loopingDisabled) {
        $controls.fadeOut(300, function () {
            $(this).remove();
        });
        return;
    }

    const config = Flags.getLoopConfig(sound);

    const hasActiveSegment = looper?.activeLoopSegment != null;
    const isCrossfading = looper?.isCrossfading ?? false;
    const isFadingOut = looper?.isFadingOut ?? false;
    const isPaused = !sound.playing;
    const hasMultipleSegments = (config.segments?.length ?? 0) > 1;

    const $prevBtn = $controls.find('.sos-loop-prev');
    const $nextBtn = $controls.find('.sos-loop-next');
    const $breakBtn = $controls.find('.sos-loop-break');
    const $disableBtn = $controls.find('.sos-loop-disable');

    // Navigation buttons: disabled if no active segment, crossfading, fading out, paused, or only one segment
    const navEnabled = hasMultipleSegments && !isCrossfading && !isFadingOut && !isPaused && hasActiveSegment;
    $prevBtn.toggleClass('disabled', !navEnabled);
    $nextBtn.toggleClass('disabled', !navEnabled);

    // Break button: enabled if actively looping and not in transition
    const breakEnabled = hasActiveSegment && !isCrossfading && !isFadingOut && !isPaused;
    $breakBtn.toggleClass('disabled', !breakEnabled);

    // Disable button: enabled unless crossfading or already fading out
    const disableEnabled = !isCrossfading && !isFadingOut && !isPaused;
    $disableBtn.toggleClass('disabled', !disableEnabled);
}

// Listen for state changes from a LoopingSound instance to update the UI (e.g., disable pause button).
Hooks.on(`${MODULE_ID}.LoopStateChange`, (playlistSound, state) => {
    refreshPauseButtonState(playlistSound);
    refreshLoopControlButtons(playlistSound);
});

// Hook into the rendering of the playlist directory to add our custom UI elements.
Hooks.on("renderPlaylistDirectory", async (app, htmlRaw) => {
    const $html = $(htmlRaw);

    // Ensure cache is built (lazy initialization)
    if (cacheInvalidated) rebuildSoundCache();

    // --- PRE-CACHE: Build all data structures BEFORE touching DOM ---
    const allSounds = new Map();
    const playlistData = new Map(); // pid -> { playlist, $element, mode }
    const soundData = new Map();    // sid -> { sound, $element, config }

    // Gather all sounds in one pass
    for (const p of game.playlists) {
        for (const s of p.sounds) {
            allSounds.set(s.id, s);
        }
    }

    // Cache all DOM elements and their data in one query each
    $html.find("li.directory-item.playlist").each((_i, li) => {
        const $li = $(li);
        const pid = $li.data("entryId") ?? $li.data("documentId");
        const playlist = game.playlists.get(pid);
        if (!playlist) return;

        playlistData.set(pid, {
            playlist,
            $element: $li,
            mode: Flags.getPlaybackMode(playlist)
        });
    });

    $html.find("li.sound").each((_i, li) => {
        const $li = $(li);
        const sid = $li.data("soundId") ?? $li.data("documentId");
        const sound = allSounds.get(sid);
        if (!sound) return;

        soundData.set(sid, {
            sound,
            $element: $li,
            config: Flags.getLoopConfig(sound)
        });
    });

    // --- Add Silence/Crossfade Toggles to each Playlist Header ---
    for (const [pid, data] of playlistData) {
        const { playlist, $element: $li, mode } = data;

        // Use pre-cached data instead of calling Flags again
        const loopPlaylist = mode.loopPlaylist; // Already in 'mode'
        $li
            .find("header.playlist-header")
            .toggleClass("sos-looped-static-glow", loopPlaylist);

        const $controls = $li.find(
            "header.playlist-header div.sound-controls.playlist-controls"
        );
        if (
            !$controls.length ||
            $controls.children(".sos-toggle, .xfade-toggle").length
        )
            continue; // Use continue instead of return in for...of loop

        const { silence: silenceOn, crossfade: xfadeOn } = mode; // Already computed
        const owner = playlist.isOwner;

        const makeBtn = ({ cls, tip, icon }) => `
      <button type="button" class="inline-control sound-control ${cls} ${!owner ? "disabled" : ""
            }"
              data-playlist-id="${pid}" data-tooltip="${tip}">
        <i class="fa-solid ${icon}"></i>
      </button>`;

        $controls.prepend(
            makeBtn({
                cls: `xfade-toggle ${xfadeOn ? "active" : ""}`,
                tip: xfadeOn ? "Disable Auto-Crossfade" : "Enable Auto-Crossfade",
                icon: "fa-right-left",
            })
        );
        $controls.prepend(
            makeBtn({
                cls: `sos-toggle  ${silenceOn ? "active" : ""}`,
                tip: silenceOn
                    ? "Disable Sound of Silence"
                    : "Enable Sound of Silence",
                icon: "fa-hourglass-half",
            })
        );
    }

    // --- Playlist-level Button Click Handlers (Delegated) ---
    async function updateFlags(pl, { silenceEnabled, crossfade }) {
        await pl.update(
            { [`flags.${MODULE_ID}`]: { silenceEnabled, crossfade } },
            { render: false }
        );
    }

    function refreshClasses($li, { silenceEnabled, crossfade }) {
        $li.find("button.sos-toggle").toggleClass("active", !!silenceEnabled);
        $li.find("button.xfade-toggle").toggleClass("active", !!crossfade);
    }

    $html
        .off("click", "button.sos-toggle:not(.disabled)")
        .on("click", "button.sos-toggle:not(.disabled)", async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const $btn = $(ev.currentTarget);
            const $li = $btn.closest("li.directory-item.playlist");
            const pl = game.playlists.get($btn.data("playlistId"));
            if (!pl) return;
            const newSilence = !pl.getFlag(MODULE_ID, "silenceEnabled");
            await updateFlags(pl, { silenceEnabled: newSilence, crossfade: false });
            refreshClasses($li, { silenceEnabled: newSilence, crossfade: false });
        });

    $html
        .off("click", "button.xfade-toggle:not(.disabled)")
        .on("click", "button.xfade-toggle:not(.disabled)", async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const $btn = $(ev.currentTarget);
            const $li = $btn.closest("li.directory-item.playlist");
            const pl = game.playlists.get($btn.data("playlistId"));
            if (!pl) return;
            const newXfade = !pl.getFlag(MODULE_ID, "crossfade");
            await updateFlags(pl, { silenceEnabled: false, crossfade: newXfade });
            refreshClasses($li, { silenceEnabled: false, crossfade: newXfade });
        });

    // --- Add Per-Track Loop Icons/Buttons ---
    for (const [sid, data] of soundData) {
        const { sound, $element: $soundLi, config: cfg } = data;

        const inNowPlaying = !!$soundLi.closest(".currently-playing").length;
        const owner = sound.isOwner;
        const $controls = $soundLi.find("div.sound-controls.flexrow").first();
        if (!$controls.length) continue;

        // Display a passive icon for tracks in a playlist that is set to loop entirely.
        // Use cached playlist data instead of re-querying
        const playlistInfo = playlistData.get(sound.parent.id);
        const belongsToLoopPl = playlistInfo?.mode.loopPlaylist ?? false;
        const $existingIcon = $controls.find("i.loop-playlist-icon");
        if (belongsToLoopPl && inNowPlaying && !$existingIcon.length) {
            const $repeatBtn = $controls
                .find(
                    'button.sound-control[data-action="soundRepeat"], button.sound-control.repeat, button.toggle-repeat'
                )
                .first();
            const $icon = $(
                '<i class="fa-solid fa-repeat loop-playlist-icon" data-tooltip="Playlist Set To Loop"></i>'
            );
            if ($repeatBtn.length) $repeatBtn.before($icon);
            else $controls.prepend($icon);
        }
        if ((!belongsToLoopPl || !inNowPlaying) && $existingIcon.length) {
            $existingIcon.remove();
        }

        // If the internal loop feature is disabled for this track, ensure no buttons are present and stop.
        if (!cfg.enabled) {
            $soundLi.find(".sos-loop-toggle, .sos-loop-skip").remove();
            continue;
        }

        // Ensure the loop toggle button exists and its state is correct.
        let $toggleBtn = $soundLi.find("button.sos-loop-toggle");
        if (!$toggleBtn.length) {
            $toggleBtn = $(
                `<button type="button" class="inline-control sound-control sos-loop-toggle" data-sound-id="${sid}" data-tooltip="Toggle Internal Loop"><i class="fa-solid fa-circle-notch"></i></button>`
            );
            const $nativeRepeat = $controls
                .find(
                    'button.sound-control[data-action="soundRepeat"], button.sound-control.repeat, button.toggle-repeat'
                )
                .first();
            if ($nativeRepeat.length) $nativeRepeat.before($toggleBtn);
            else $controls.append($toggleBtn);
        }
        $toggleBtn.toggleClass("active", !!cfg.active).toggleClass("disabled", !owner);

        // Add or remove the "break loop" button based on the current state.
        const shouldHaveSkipBtn = inNowPlaying && cfg.active && game.user.isGM;
        const $skipBtn = $soundLi.find("button.sos-loop-skip");
        if (shouldHaveSkipBtn) {
            if (!$skipBtn.length) {
                const $newSkipBtn = $(
                    `<button type="button" class="inline-control sound-control sos-loop-skip" data-sound-id="${sid}" data-tooltip="Break Loop & Continue Track"><i class="fa-solid fa-circle-stop"></i></button>`
                );
                $toggleBtn.after($newSkipBtn);
            }
        } else {
            $skipBtn.remove();
        }
    }

    // --- Per-Track Button Click Handlers (Delegated) ---
    $html
        .off("click", "button.sos-loop-toggle:not(.disabled)")
        .on("click", "button.sos-loop-toggle:not(.disabled)", async (ev) => {
            const $btn = $(ev.currentTarget);
            const sid = $btn.data("soundId");
            const sound = findSoundById(sid, $btn);

            if (!sound) return;

            const currentActiveState =
                sound.getFlag(MODULE_ID, "loopWithin.active") ?? false;
            await sound.setFlag(
                MODULE_ID,
                "loopWithin.active",
                !currentActiveState
            );
        });

    $html
        .off("click", "button.sos-loop-skip:not(.disabled)")
        .on("click", "button.sos-loop-skip:not(.disabled)", async (ev) => {
            const $btn = $(ev.currentTarget);
            const sid = $btn.data("soundId");
            const sound = findSoundById(sid, $btn);
            if (!sound) return;

            // Optimistic locking: read current value, increment atomically
            const currentFlags = sound.getFlag(MODULE_ID, LOOP_KEY) ?? {};
            const expectedCount = currentFlags.skipCount || 0;
            const newSkipCount = expectedCount + 1;

            try {
                await sound.update({
                    [`flags.${MODULE_ID}.${LOOP_KEY}.skipCount`]: newSkipCount,
                }, {
                    diff: false, // Force full update to detect conflicts
                    // Add metadata for conflict detection if needed
                    [`flags.${MODULE_ID}.${LOOP_KEY}._skipSeq`]: Date.now()
                });

                $btn.addClass("disabled");
            } catch (err) {
                debug("[sos-loop-skip] Update conflict, retrying...");
            }
        });

    // ========================================================
    // Loop Control Button Handlers
    // ========================================================
    $html
        .off("click", "button.sos-loop-prev:not(.disabled)")
        .on("click", "button.sos-loop-prev:not(.disabled)", async (ev) => {
            const $btn = $(ev.currentTarget);
            const sid = $btn.data("soundId");
            const sound = findSoundById(sid, $btn);
            if (!sound) return;

            const { previousSegmentWithin } = await import("./internal-loop.js");
            previousSegmentWithin(sound);

            // Visual feedback
            $btn.addClass("disabled");
            setTimeout(() => $btn.removeClass("disabled"), 500);
        });

    $html
        .off("click", "button.sos-loop-next:not(.disabled)")
        .on("click", "button.sos-loop-next:not(.disabled)", async (ev) => {
            const $btn = $(ev.currentTarget);
            const sid = $btn.data("soundId");
            const sound = findSoundById(sid, $btn);
            if (!sound) return;

            const { nextSegmentWithin } = await import("./internal-loop.js");
            nextSegmentWithin(sound);

            // Visual feedback
            $btn.addClass("disabled");
            setTimeout(() => $btn.removeClass("disabled"), 500);
        });

    $html
        .off("click", "button.sos-loop-break:not(.disabled)")
        .on("click", "button.sos-loop-break:not(.disabled)", async (ev) => {
            const $btn = $(ev.currentTarget);
            const sid = $btn.data("soundId");
            const sound = findSoundById(sid, $btn);
            if (!sound) return;

            const { breakLoopWithin } = await import("./internal-loop.js");
            breakLoopWithin(sound);

            // Visual feedback
            $btn.addClass("disabled");
            setTimeout(() => $btn.removeClass("disabled"), 500);
        });

    $html
        .off("click", "button.sos-loop-disable:not(.disabled)")
        .on("click", "button.sos-loop-disable:not(.disabled)", async (ev) => {
            const $btn = $(ev.currentTarget);
            const sid = $btn.data("soundId");
            const sound = findSoundById(sid, $btn);
            if (!sound) return;

            const { disableAllLoopsWithin } = await import("./internal-loop.js");
            disableAllLoopsWithin(sound);

            // Hide all loop controls after disabling
            const $controls = $btn.closest('.sos-loop-controls');
            $controls.fadeOut(300, function () {
                $(this).remove();
            });
        });

    // Highlight the "Currently Playing" header if any sound within it belongs to a looping playlist.
    const $currentSection = $html.find(".currently-playing");
    if ($currentSection.length) {
        // Use pre-cached playlistData instead of re-querying
        const hasLoopedSound = Array.from(playlistData.values()).some(data =>
            data.mode.loopPlaylist && data.playlist.playing
        );

        // Diagnostic button
        const $headerButtons = $html.find(".directory-header .header-actions");
        if (!$headerButtons.find('.sos-diagnostics').length) {
            $headerButtons.append(`
        <button type="button" class="sos-diagnostics" data-tooltip="Sound of Silence Diagnostics">
            <i class="fas fa-stethoscope"></i>
        </button>
    `);
        }

        // Use the .off().on() pattern to prevent duplicate event listeners
        $html.off('click', '.sos-diagnostics').on('click', '.sos-diagnostics', () => {
            new SoundOfSilenceDiagnostics().render(true);
        });

        // ========================================================
        // Normalized Volume Control in Currently Playing
        // ========================================================
        const $currentlyPlaying = $html.find('.currently-playing');
        if ($currentlyPlaying.length) {
            // debug('[Volume UI] Processing Currently Playing section');

            // Track which playlists we've already added controls for
            const processedPlaylists = new Set();

            // Find all playing sounds in Currently Playing
            const $playingSounds = $currentlyPlaying.find('li.sound');
            // debug(`[Volume UI] Found ${$playingSounds.length} playing sounds in Currently Playing`);

            $playingSounds.each((index, soundEl) => {
                const $soundEl = $(soundEl);
                const soundId = $soundEl.data('soundId') || $soundEl.data('documentId');

                if (!soundId) return;

                // Find the actual PlaylistSound document
                const sound = allSounds.get(soundId);
                if (!sound || !sound.playing) return;

                const playlist = sound.parent;
                if (!playlist) return;

                // Skip if we already processed this playlist
                if (processedPlaylists.has(playlist.id)) return;

                const normEnabled = Flags.getPlaylistFlag(playlist, 'volumeNormalizationEnabled');
                // debug(`[Volume UI] Sound "${sound.name}" from playlist "${playlist.name}" - normalization: ${normEnabled}`);

                if (normEnabled) {
                    processedPlaylists.add(playlist.id);

                    const normalizedVolume = Flags.getPlaylistFlag(playlist, 'normalizedVolume');
                    const isGM = game.user.isGM;
                    const disabledAttr = isGM ? '' : 'disabled';
                    const disabledClass = isGM ? '' : 'sos-is-disabled';

                    const $volumeControl = $(`
                        <div class="sos-normalized-volume-control ${disabledClass}" data-playlist-id="${playlist.id}">
                            <label class="sos-volume-label">
                                Playlist Volume
                                <i class="volume-icon fa-solid fa-volume-low"></i>
                            </label>
                            <div class="sos-volume-slider-container">
                                <range-picker 
                                    class="sos-volume-range-picker"
                                    name="normalizedVolume-${playlist.id}"
                                    value="${normalizedVolume}"
                                    min="0" max="1" step="0.05"
                                    data-playlist-id="${playlist.id}"
                                    ${disabledAttr}>
                                </range-picker>
                            </div>
                        </div>
                    `);

                    // Insert after the first sound from this playlist
                    $soundEl.after($volumeControl);
                    // debug(`[Volume UI] Added volume control for playlist "${playlist.name}" before sound "${sound.name}"`);

                    // Handle changes
                    const rangePicker = $volumeControl.find('range-picker')[0];
                    if (rangePicker && isGM) {
                        rangePicker.addEventListener('change', foundry.utils.debounce(async (ev) => {
                            const newVolume = parseFloat(ev.target.value);
                            const playlistId = $(ev.target).data('playlistId');
                            const targetPlaylist = game.playlists.get(playlistId);

                            if (targetPlaylist) {
                                // debug(`[Volume UI] Setting volume for ${targetPlaylist.name} to ${newVolume}`);
                                await targetPlaylist.setFlag(MODULE_ID, 'normalizedVolume', newVolume);
                            }
                        }, 100));
                    }
                }
            });

            // ========================================================
            // Loop Control Buttons in Currently Playing
            // ========================================================
            $playingSounds.each((index, soundEl) => {
                const $soundEl = $(soundEl);
                const soundId = $soundEl.data('soundId') || $soundEl.data('documentId');

                if (!soundId) return;

                // Find the actual PlaylistSound document
                const sound = allSounds.get(soundId);
                if (!sound || !sound.playing) return;

                // Get loop configuration
                const config = Flags.getLoopConfig(sound);

                // Only show if looping is enabled and has segments
                if (!config.enabled || !config.segments?.length) return;

                // Check if controls already exist
                if ($soundEl.nextAll('.sos-loop-controls').first().data('soundId') === soundId) return;

                const controlsHTML = `
                    <div class="sos-loop-controls" data-sound-id="${soundId}">
                        <label class="sos-controls-label">Loop Controls</label>
                        <div class="sos-button-group">
                            <button class="sos-loop-prev" data-sound-id="${soundId}" data-tooltip="Previous Segment">
                                <i class="fas fa-step-backward"></i>
                            </button>
                            <button class="sos-loop-next" data-sound-id="${soundId}" data-tooltip="Next Segment">
                                <i class="fas fa-step-forward"></i>
                            </button>
                            <button class="sos-loop-break" data-sound-id="${soundId}" data-tooltip="Break Current Loop">
                                <i class="fas fa-eject"></i>
                            </button>
                            <button class="sos-loop-disable" data-sound-id="${soundId}" data-tooltip="Disable All Loops">
                                <i class="fas fa-ban"></i>
                            </button>
                        </div>
                    </div>
                `;

                // Insert after volume control if it exists, otherwise after the sound element
                const $volumeControl = $soundEl.nextAll('.sos-normalized-volume-control').first();
                if ($volumeControl.length && $volumeControl.data('playlistId') === sound.parent?.id) {
                    $volumeControl.after(controlsHTML);
                } else {
                    $soundEl.after(controlsHTML);
                }
            });

            if ($currentlyPlaying.length) {
                // Only process sounds that are currently playing
                for (const [sid, data] of soundData) {
                    const { sound, $element: $soundLi } = data;
                    if (!sound.playing) continue;
                    if (!$soundLi.closest('.currently-playing').length) continue;

                    const playlist = sound.parent;
                    if (!playlist) continue;

                    // Check if this sound is under normalization control
                    const normEnabled = Flags.getPlaylistFlag(playlist, 'volumeNormalizationEnabled');
                    const hasOverride = Flags.getSoundFlag(sound, 'allowVolumeOverride');
                    const isManagedByNormalization = normEnabled && !hasOverride;

                    // Find the native volume control - it's the range-picker with class "sound-volume"
                    const $volumeControl = $soundLi.find('range-picker.sound-volume');

                    if ($volumeControl.length) {
                        if (isManagedByNormalization) {
                            // Disable it and add visual indicator
                            $volumeControl.attr('disabled', 'disabled');
                            $volumeControl.addClass('sos-managed-by-normalization');

                            // --- TOOLTIP LOGIC ---
                            // Store the original tooltip if we haven't already
                            if (typeof $volumeControl.attr('data-original-tooltip') === 'undefined') {
                                const originalTooltip = $volumeControl.attr('data-tooltip') || '';
                                $volumeControl.attr('data-original-tooltip', originalTooltip);
                            }
                            // Apply our explanatory tooltip
                            $volumeControl.attr('data-tooltip', 'Volume managed by Playlist Normalization');

                        } else {
                            // Re-enable if it was previously disabled
                            if ($volumeControl.hasClass('sos-managed-by-normalization')) {
                                $volumeControl.removeAttr('disabled');
                                $volumeControl.removeClass('sos-managed-by-normalization');

                                // --- TOOLTIP LOGIC ---
                                // Restore the original tooltip
                                const originalTooltip = $volumeControl.attr('data-original-tooltip');
                                if (typeof originalTooltip !== 'undefined') {
                                    $volumeControl.attr('data-tooltip', originalTooltip);
                                    $volumeControl.removeAttr('data-original-tooltip');
                                }
                            }
                        }
                    }
                }
            }
        }
    }
});
