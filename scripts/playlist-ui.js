// playlist-ui.js

import { MODULE_ID, SoundOfSilenceDiagnostics, debug } from "./utils.js";
import { LOOP_KEY } from "./sound-config.js";
import { Flags } from "./flag-service.js";
import { findSoundById, ensureCacheReady } from "./sound-cache.js";

import { breakLoopWithin } from "./internal-loop.js";

// Hook into the rendering of the playlist directory to add our custom UI elements.
Hooks.on("renderPlaylistDirectory", async (app, htmlRaw) => {
    const $html = $(htmlRaw);

    // Ensure cache is built (lazy initialization)
    ensureCacheReady();

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

    function refreshClasses($li, { silenceEnabled, crossfade, playlistId }) {
        // Update buttons within the clicked context (sidebar playlist <li>)
        $li.find("button.sos-toggle").toggleClass("active", !!silenceEnabled);
        $li.find("button.xfade-toggle").toggleClass("active", !!crossfade);
        // Sync ALL toggle buttons for this playlist across the entire sidebar
        // (covers both directory listing and Currently Playing section)
        if (playlistId) {
            $html.find(`button.sos-toggle[data-playlist-id="${playlistId}"]`)
                .toggleClass("active", !!silenceEnabled);
            $html.find(`button.xfade-toggle[data-playlist-id="${playlistId}"]`)
                .toggleClass("active", !!crossfade);
        }
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
            const pid = $btn.data("playlistId");
            const newSilence = !pl.getFlag(MODULE_ID, "silenceEnabled");
            await updateFlags(pl, { silenceEnabled: newSilence, crossfade: false });
            refreshClasses($li, { silenceEnabled: newSilence, crossfade: false, playlistId: pid });
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
            const pid = $btn.data("playlistId");
            const newXfade = !pl.getFlag(MODULE_ID, "crossfade");
            await updateFlags(pl, { silenceEnabled: false, crossfade: newXfade });
            refreshClasses($li, { silenceEnabled: false, crossfade: newXfade, playlistId: pid });
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

            // Use the new synchronized breakLoopWithin function
            $btn.addClass("disabled");
            await breakLoopWithin(sound);

            // Re-enable after a short delay
            setTimeout(() => $btn.removeClass("disabled"), 500);
        });

    // Diagnostic button
    const $headerButtons = $html.find(".directory-header .header-actions");
    if (!$headerButtons.find('.sos-diagnostics').length) {
        $headerButtons.append(`
        <button type="button" class="sos-diagnostics" data-tooltip="Sound of Silence Diagnostics">
            <i class="fas fa-stethoscope"></i>
        </button>
        `);
    }

    $html.off('click', '.sos-diagnostics').on('click', '.sos-diagnostics', () => {
        new SoundOfSilenceDiagnostics().render(true);
    });
});
