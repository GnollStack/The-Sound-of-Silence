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
import { MODULE_ID, debug } from "./utils.js";
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
            console.log(
                `[${MODULE_ID}] Detected: Monks Sound Enhancements (${KNOWN_MODULES.MONKS})`
            );
        }
        if (_detected.enchantment) {
            console.log(
                `[${MODULE_ID}] Detected: Playlist Enchantment (${KNOWN_MODULES.ENCHANTMENT})`
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
        if (ActualClass?.PARTS) {
            ActualClass.PARTS.playing = { template, templates };
            debug(`[Integrations] Patched PARTS.playing on ${className}`);
        }

        // 2. Also patch the base class (belt-and-suspenders for any code that
        //    reads from the base prototype directly)
        const BaseClass = foundry.applications.sidebar.tabs.PlaylistDirectory;
        if (BaseClass?.PARTS && BaseClass !== ActualClass) {
            BaseClass.PARTS.playing = { template, templates };
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

        debug("[Integrations] Audio fade guard registered on Sound.prototype.fade");
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
        return {
            detectedModules: { ..._detected },
            hasConflictingModules: this.hasConflictingModules,
            actualPlaylistDirectoryClass: ActualClass?.name || "unknown",
            partsPlayingTemplate: ActualClass?.PARTS?.playing?.template || "unknown",
            audioGuardsActive: this.hasConflictingModules,
        };
    },
};
