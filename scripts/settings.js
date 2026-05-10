/**
 * @file settings.js
 * @description Registers The Sound of Silence module settings.
 */
import { AdvancedShuffle, SHUFFLE_PATTERNS } from "./advanced-shuffle.js";
import { debug, MODULE_ID } from "./utils.js";

export function registerSettings({
  applyPersonalPlaylistVolumesToActiveSounds,
} = {}) {
  const applyPersonalMix = () => {
    applyPersonalPlaylistVolumesToActiveSounds?.();
  };

  game.settings.register(MODULE_ID, "debug", {
    name: "Enable Debug Logging",
    hint: "Log silence timing and playlist actions to the console.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "debugCurrentlyPlayingTimestamps", {
    name: "Trace Currently Playing Timers",
    hint: "Log detailed Currently Playing timer sources and DOM writes on every client. Enable only while diagnosing timer flicker or duration drift.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "personalPlaylistVolumeEnabled", {
    name: "Use Personal Audio Mix",
    hint: "For players, replace shared volume controls with client-local Track and Playlist Volume controls.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      applyPersonalMix();
      ui.playlists?.render({ parts: ["playing"] });
    },
  });

  game.settings.register(MODULE_ID, "personalPlaylistVolumes", {
    name: "Personal Playlist Volumes",
    hint: "Client-local per-playlist Sound of Silence volume slider values.",
    scope: "client",
    config: false,
    type: Object,
    default: {},
    onChange: applyPersonalMix,
  });

  game.settings.register(MODULE_ID, "personalTrackVolumes", {
    name: "Personal Track Volumes",
    hint: "Client-local per-track Sound of Silence volume slider values.",
    scope: "client",
    config: false,
    type: Object,
    default: {},
    onChange: applyPersonalMix,
  });

  game.settings.register(MODULE_ID, "shufflePattern", {
    name: "Advanced Shuffle Pattern",
    hint: "Choose how shuffle mode works. Exhaustive ensures all tracks play once before repeating. Weighted Random favors tracks that haven't played recently. Round-Robin ensures even distribution across all tracks over time.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      [SHUFFLE_PATTERNS.FOUNDRY_DEFAULT]:
        "Foundry Default (Random with possible repeats)",
      [SHUFFLE_PATTERNS.EXHAUSTIVE]:
        "Exhaustive (No repeats until all tracks played)",
      [SHUFFLE_PATTERNS.WEIGHTED_RANDOM]:
        "Weighted Random (Favor less-recently-played tracks)",
      [SHUFFLE_PATTERNS.ROUND_ROBIN]:
        "Round-Robin (Strictly even distribution)",
    },
    default: SHUFFLE_PATTERNS.FOUNDRY_DEFAULT,
    onChange: () => {
      // Clear all shuffle states when pattern changes globally.
      game.playlists.forEach((playlist) => {
        if (playlist.mode === CONST.PLAYLIST_MODES.SHUFFLE) {
          AdvancedShuffle.reset(playlist);
          debug(
            `[Shuffle] Reset state for "${playlist.name}" due to pattern change`
          );
        }
      });
      ui.notifications.info(
        "Advanced Shuffle pattern changed. All shuffle playlists have been reset."
      );
    },
  });

  game.settings.register(MODULE_ID, "fadeInCurveType", {
    name: "Fade-In Curve Type",
    hint: "Controls the volume curve shape for fade-ins. Logarithmic (default) sounds perceptually linear. Linear is a straight volume ramp. S-Curve eases in and out smoothly. Steep front-loads the volume change for a more dramatic effect.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "logarithmic": "Logarithmic (Default)",
      "linear": "Linear",
      "s-curve": "S-Curve (Smooth ease in/out)",
      "steep": "Steep (Fast attack)",
    },
    default: "logarithmic",
  });

  game.settings.register(MODULE_ID, "fadeOutCurveType", {
    name: "Fade-Out Curve Type",
    hint: "Controls the volume curve shape for fade-outs. Logarithmic (default) sounds perceptually linear. Linear is a straight volume ramp. S-Curve eases in and out smoothly. Steep front-loads the volume change for a more dramatic effect.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "logarithmic": "Logarithmic (Default)",
      "linear": "Linear",
      "s-curve": "S-Curve (Smooth ease in/out)",
      "steep": "Steep (Fast attack)",
    },
    default: "logarithmic",
  });
}
