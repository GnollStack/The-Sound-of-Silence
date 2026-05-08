/**
 * @file integrations.js
 * @description Detects and manages compatibility with third-party playlist modules.
 *
 * Modules like Monks Sound Enhancements and Playlist Enchantment replace
 * CONFIG.ui.playlists with their own subclass and define static PARTS that shadow
 * the base PlaylistDirectory. Our patches to the base class never take effect.
 *
 * This integration layer:
 * 1. Detects conflicting modules at init time
 * 2. Patches PARTS.playing on the ACTUAL running class (not just the base)
 * 3. Guards our audio pipeline (setValueCurveAtTime curves) from external fade() calls
 *
 * The sync() wrapper in main.js prevents Foundry's sync() from stopping sounds
 * mid-crossfade — that is the critical companion to the guards registered here.
 */
import { MODULE_ID, debug, warn } from "./utils.js";
import { State } from "./state-manager.js";

// =========================================================================
// Module Detection Registry
// =========================================================================

const KNOWN_MODULES = Object.freeze({
    MONKS: "monks-sound-enhancements",
    ENCHANTMENT: "playlistenchantment",
});

const _detected = {
    monks: false,
    enchantment: false,
};

let _audioGuardsRegistered = false;
let _playingPartsPatched = false;
let _playlistEnchantmentHotbarPatched = false;
let _playlistEnchantmentHotbarPatchedClass = null;

// =========================================================================
// Public API
// =========================================================================

export const Integrations = {
    /** @returns {{ monks: boolean, enchantment: boolean }} */
    get detected() {
        return { ..._detected };
    },

    /** @returns {boolean} True if any conflicting playlist module is active */
    get hasConflictingModules() {
        return _detected.monks || _detected.enchantment;
    },

    // =====================================================================
    // Lifecycle — called from main.js
    // =====================================================================

    /**
     * Detect active conflicting modules. Call during `init`.
     * This is informational only — SoS continues to activate regardless.
     */
    detect() {
        _detected.monks = !!game.modules.get(KNOWN_MODULES.MONKS)?.active;
        _detected.enchantment = !!game.modules.get(KNOWN_MODULES.ENCHANTMENT)?.active;

        if (_detected.monks) {
            warn(
                `Detected: Monks Sound Enhancements (${KNOWN_MODULES.MONKS})`
            );
        }
        if (_detected.enchantment) {
            warn(
                `Detected: Playlist Enchantment (${KNOWN_MODULES.ENCHANTMENT})`
            );
        }
        if (!this.hasConflictingModules) {
            debug("[Integrations] No conflicting playlist modules detected.");
        }
    },

    // =====================================================================
    // PARTS Patching
    // =====================================================================

    /**
     * Override PARTS.playing on the actual CONFIG.ui.playlists class so our
     * Currently Playing templates render regardless of which subclass is active.
     *
     * Other modules' extra PARTS (e.g. Monks' "soundeffects" panel,
     * Enchantment's custom controls) are left untouched.
     *
     * @param {string} template   — path to our currently-playing.hbs
     * @param {string[]} templates — sub-template paths (sos-sound-partial.hbs)
     */
    patchPlayingParts(template, templates) {
        const ActualClass = CONFIG.ui.playlists;
        const className = ActualClass?.name || "PlaylistDirectory";

        // 1. Patch the actual running class
        const playingPart = { template, templates, scrollable: [".playlist-sounds.plain"] };

        if (ActualClass?.PARTS) {
            ActualClass.PARTS.playing = playingPart;
            _playingPartsPatched = true;
            debug(`[Integrations] Patched PARTS.playing on ${className}`);
        }

        // 2. Also patch the base class (belt-and-suspenders for any code that
        //    reads from the base prototype directly)
        const BaseClass = foundry.applications.sidebar.tabs.PlaylistDirectory;
        if (BaseClass?.PARTS && BaseClass !== ActualClass) {
            BaseClass.PARTS.playing = playingPart;
        }
    },

    // =====================================================================
    // Audio Pipeline Guards
    // =====================================================================

    /**
     * Register a libWrapper guard on Sound.prototype.fade that prevents
     * other modules from destroying our active setValueCurveAtTime curves.
     *
     * Only registered when conflicting modules are detected.
     */
    registerAudioGuards() {
        this.patchPlaylistEnchantmentHotbar();

        if (!this.hasConflictingModules) {
            debug("[Integrations] No conflicting modules — audio guards skipped.");
            return;
        }

        // Guard: Sound.prototype.fade
        libWrapper.register(
            MODULE_ID,
            "foundry.audio.Sound.prototype.fade",
            function (wrapped, volume, options = {}) {
                // If SoS has an active setValueCurveAtTime curve on this sound,
                // block the external fade to prevent cancelScheduledValues()
                // from destroying it.
                if (State.isSoundFading(this)) {
                    debug(
                        `[Integrations] Blocked external fade() on "${this.src}" — ` +
                            `SoS fade curve active`
                    );
                    return Promise.resolve();
                }
                return wrapped(volume, options);
            },
            "MIXED"
        );

        _audioGuardsRegistered = true;
        debug("[Integrations] Audio fade guard registered on Sound.prototype.fade");
    },

    /**
     * Playlist Enchantment's hotbar macro path stops every currently playing
     * playlist before starting the requested one. SoS supports layered playback,
     * especially Soundscape plus normal music, so delegate those starts to the
     * normal SoS/Foundry play methods without stopping unrelated playlists.
     */
    patchPlaylistEnchantmentHotbar() {
        const ActualClass = CONFIG.ui.playlists;
        if (!ActualClass) return;
        if (_playlistEnchantmentHotbarPatchedClass === ActualClass) return;

        const hasPlaylistEnchantmentShape =
            _detected.enchantment ||
            typeof ActualClass.hotbarPlaylist === "function" ||
            typeof ActualClass.crossFade === "function";
        if (!hasPlaylistEnchantmentShape) return;

        const playFromUuid = async (uuid) => {
            const doc = await fromUuid(uuid);
            let playlist = null;
            let sound = null;

            if (doc instanceof Playlist) {
                playlist = doc;
            } else if (doc instanceof PlaylistSound) {
                sound = doc;
                playlist = sound.parent;
            } else if (doc instanceof Folder && doc.type === "Playlist") {
                const playlists = doc.contents;
                playlist = playlists[Math.floor(Math.random() * playlists.length)] ?? null;
            }

            if (!playlist) {
                ui.notifications?.error?.("Can't start Playlist - not found");
                return null;
            }
            if (!sound && playlist.playing) return playlist;

            debug(
                `[Integrations] Playlist Enchantment hotbar start delegated to SoS for "${playlist.name}".`
            );
            return sound ? playlist.playSound(sound) : playlist.playAll();
        };

        ActualClass.hotbarPlaylist = playFromUuid;
        ActualClass.crossFade = playFromUuid;
        _playlistEnchantmentHotbarPatched = true;
        _playlistEnchantmentHotbarPatchedClass = ActualClass;
        debug("[Integrations] Patched Playlist Enchantment hotbar playback to allow layered playlists.");
    },

    // =====================================================================
    // Diagnostics
    // =====================================================================

    /**
     * Return a summary object for the diagnostics panel / API.
     * @returns {object}
     */
    diagnostics() {
        const ActualClass = CONFIG.ui.playlists;
        const detectedModuleLabels = [];
        if (_detected.monks) detectedModuleLabels.push("Monks Sound Enhancements");
        if (_detected.enchantment) detectedModuleLabels.push("Playlist Enchantment");
        return {
            detectedModules: { ..._detected },
            detectedModuleLabels,
            hasConflictingModules: this.hasConflictingModules,
            actualPlaylistDirectoryClass: ActualClass?.name || "unknown",
            partsPlayingTemplate: ActualClass?.PARTS?.playing?.template || "unknown",
            playingPartsPatched: _playingPartsPatched,
            audioGuardsActive: _audioGuardsRegistered,
            playlistEnchantmentHotbarPatched: _playlistEnchantmentHotbarPatched,
        };
    },
};
