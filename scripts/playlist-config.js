/**
 * @file playlist-config.js
 * @description This file manages the integration of module settings into the PlaylistConfig sheet.
 * It uses libWrapper to inject data and handle form submission for playlist-level flags,
 * and a hook to render the custom form fields.
 */
import { MODULE_ID } from "./utils.js";
import { debug } from "./utils.js";
import { Flags } from "./flag-service.js";
import { SoundscapePreviewer } from "./soundscape-previewer.js";

let wrappersRegistered = false;
let hooksRegistered = false;

/**
 * Defines the flag keys and default values for all playlist-level settings.
 */
const KEYS = {
  ENABLED: "silenceEnabled",         // boolean
  FADE_IN: "fadeIn",                 // number (ms)
  MODE: "silenceMode",               // "static" | "random"
  DURATION: "silenceDuration",       // number (ms)
  MIN_DELAY: "minDelay",             // number (ms)
  MAX_DELAY: "maxDelay",             // number (ms)
  CROSSFADE_ENABLED: "crossfade",      // boolean - Master switch
  USE_CUSTOM_AUTO_FADE: "useCustomAutoFade", // boolean
  CUSTOM_AUTO_FADE_MS: "customAutoFadeMs",  // number (ms)
  LOOP_PLAYLIST: "loopPlaylist",       // boolean
  VOLUME_NORMALIZATION_ENABLED: "volumeNormalizationEnabled", // boolean
  NORMALIZED_VOLUME: "normalizedVolume", // number (0-1)
  SOUNDSCAPE_MODE: "soundscapeMode",       // boolean
  SOUNDSCAPE_MAX_POLYPHONY: "soundscapeMaxPolyphony", // number (1-16)
  SOUNDSCAPE_PLAY_CHANCE_SCALING: "soundscapePlayChanceScaling", // "independent" | "scaled" | "soft"
  SOUNDSCAPE_DEFAULT_MIN_DELAY: "soundscapeDefaults.minDelay",
  SOUNDSCAPE_DEFAULT_MAX_DELAY: "soundscapeDefaults.maxDelay",
  SOUNDSCAPE_DEFAULT_TIMING_MODE: "soundscapeDefaults.timingMode",
  SOUNDSCAPE_DEFAULT_INITIAL_FIRE_MODE: "soundscapeDefaults.initialFireMode",
  SOUNDSCAPE_DEFAULT_VARIANCE: "soundscapeDefaults.volumeVariance",
  SOUNDSCAPE_DEFAULT_PLAY_CHANCE: "soundscapeDefaults.playChance",
  SOUNDSCAPE_DEFAULT_RANDOM_PAN: "soundscapeDefaults.randomPan"
};

const DEFAULTS = {
  [KEYS.FADE_IN]: 0,
  [KEYS.MODE]: "static",
  [KEYS.DURATION]: 0,
  [KEYS.MIN_DELAY]: 0,
  [KEYS.MAX_DELAY]: 0,
  [KEYS.CROSSFADE_ENABLED]: false,
  [KEYS.USE_CUSTOM_AUTO_FADE]: false, // Default to using the main Fade-Out
  [KEYS.CUSTOM_AUTO_FADE_MS]: 1000,
  [KEYS.ENABLED]: false,
  [KEYS.LOOP_PLAYLIST]: false,
  [KEYS.VOLUME_NORMALIZATION_ENABLED]: false,
  [KEYS.NORMALIZED_VOLUME]: 0.5,
  [KEYS.SOUNDSCAPE_MODE]: false,
  [KEYS.SOUNDSCAPE_MAX_POLYPHONY]: 4,
  [KEYS.SOUNDSCAPE_PLAY_CHANCE_SCALING]: "independent",
  soundscapeDefaults: {
    minDelay: 15,
    maxDelay: 60,
    timingMode: "uniform",
    initialFireMode: "normal",
    volumeVariance: 0,
    playChance: 100,
    randomPan: false
  }
};

const PROCEDURAL_TIMING_OPTIONS = {
  uniform: "Uniform Random",
  fixed: "Fixed Cadence",
  natural: "Natural (Center-Weighted)",
};

const PROCEDURAL_INITIAL_FIRE_OPTIONS = {
  normal: "Use Cadence",
  staggered: "Stagger First Fire",
  immediate: "Immediate First Fire",
};

const PLAY_CHANCE_SCALING_OPTIONS = {
  independent: "Independent",
  scaled: "Linear by Polyphony",
  soft: "Soft by Polyphony",
};

function sanitizeProceduralTimingMode(value) {
  return Object.prototype.hasOwnProperty.call(PROCEDURAL_TIMING_OPTIONS, value) ? value : "uniform";
}

function sanitizeProceduralInitialFireMode(value) {
  return Object.prototype.hasOwnProperty.call(PROCEDURAL_INITIAL_FIRE_OPTIONS, value) ? value : "normal";
}

function sanitizePlayChanceScaling(value) {
  return Object.prototype.hasOwnProperty.call(PLAY_CHANCE_SCALING_OPTIONS, value) ? value : "independent";
}

function formatProceduralCadenceSummary(min, max, timingMode) {
  if (timingMode === "fixed") return `Fixed ${min}s`;
  const modeLabel = timingMode === "natural" ? "Natural" : "Uniform";
  return `${modeLabel} ${min}-${max}s`;
}

/**
 * Registers the necessary libWrapper patches for the PlaylistConfig sheet.
 */
export function registerPlaylistSheetWrappers() {
  if (!wrappersRegistered) {
    wrappersRegistered = true;
    _registerV13Wrappers();
  }
  _registerPlaylistConfigHooks();
}

/**
 * Registers wrappers for Foundry v13+ (DocumentSheetV2).
 */
function _registerV13Wrappers() {
  debug("Registering V13 PlaylistConfig wrappers");

  // Supply module data to the template context. Also inject a synthetic
  // "soundscape" entry into the mode <select> so Soundscape appears as a 5th
  // playback mode, while storage stays as {mode: -1, soundscapeMode: true flag}.
  libWrapper.register(
    MODULE_ID,
    "foundry.applications.sheets.PlaylistConfig.prototype._prepareContext",
    async function (wrapped, options) {
      const ctx = await wrapped.call(this, options);
      ctx.sos = Flags.getPlaylistFlags(ctx.document);

      if (ctx.modes && typeof ctx.modes === "object") {
        ctx.modes = { ...ctx.modes, soundscape: "Soundscape" };
      }
      const soundscapeActive =
        ctx.document?.mode === CONST.PLAYLIST_MODES.DISABLED &&
        !!ctx.document?.getFlag(MODULE_ID, KEYS.SOUNDSCAPE_MODE);
      if (soundscapeActive && ctx.source && typeof ctx.source === "object") {
        ctx.source = { ...ctx.source, mode: "soundscape" };
      }
      return ctx;
    },
    "WRAPPER"
  );

  // We are now wrapping _processFormData, which is more robust.
  libWrapper.register(
    MODULE_ID,
    "foundry.applications.sheets.PlaylistConfig.prototype._processFormData",
    function (wrapped, event, form, formData) {
      debug("Processing Sound of Silence flags using robust method.");

      const basePath = `flags.${MODULE_ID}`;

      // The mode <select> carries data-dtype="Number" from NumberField, so
      // FormDataExtended converts "soundscape" -> NaN before we see it.
      // Recover the sentinel from the live DOM and rewrite to {mode: -1} +
      // soundscapeMode flag. Any non-Soundscape selection self-heals by
      // forcing the flag off.
      const rawModeValue = formData.object.mode;
      const selectEl = form.elements?.mode;
      const domModeValue = selectEl?.value;
      const isSoundscapeChoice =
        !Number.isFinite(rawModeValue) && domModeValue === "soundscape";
      if (isSoundscapeChoice) {
        formData.object.mode = CONST.PLAYLIST_MODES.DISABLED;
      } else if (!Number.isFinite(rawModeValue)) {
        formData.object.mode = CONST.PLAYLIST_MODES.DISABLED;
      }

      // 1. Start with a clean slate based on our defaults.
      const cleanFlags = foundry.utils.duplicate(DEFAULTS);

      // 2. Extract and sanitize all values directly from the flat formData.
      const raw = formData.object;
      cleanFlags.fadeIn = Number(raw[`${basePath}.${KEYS.FADE_IN}`] ?? 0);
      cleanFlags.silenceDuration = Number(raw[`${basePath}.${KEYS.DURATION}`] ?? 0);
      cleanFlags.minDelay = Number(raw[`${basePath}.${KEYS.MIN_DELAY}`] ?? 0);
      cleanFlags.maxDelay = Number(raw[`${basePath}.${KEYS.MAX_DELAY}`] ?? 0);
      cleanFlags.customAutoFadeMs = Number(raw[`${basePath}.${KEYS.CUSTOM_AUTO_FADE_MS}`] ?? 1000);
      cleanFlags.silenceMode = raw[`${basePath}.${KEYS.MODE}`] ?? "static";

      cleanFlags.volumeNormalizationEnabled = !!raw[`${basePath}.${KEYS.VOLUME_NORMALIZATION_ENABLED}`];
      cleanFlags.normalizedVolume = Number(raw[`${basePath}.${KEYS.NORMALIZED_VOLUME}`] ?? 0.5);

      const soundscapeMode = isSoundscapeChoice;
      const crossfadeEnabled = !!raw[`${basePath}.${KEYS.CROSSFADE_ENABLED}`] && !soundscapeMode;
      const silenceEnabled = !!raw[`${basePath}.${KEYS.ENABLED}`] && !soundscapeMode;
      const formDataObj = foundry.utils.flattenObject(formData.object);
      const autoFadeType = formDataObj[`flags.${MODULE_ID}.autoFadeType`];

      // 3. Apply the critical logic to the clean data (mutual exclusivity).
      cleanFlags.soundscapeMode = soundscapeMode;
      cleanFlags.crossfade = crossfadeEnabled;
      cleanFlags.silenceEnabled = silenceEnabled && !crossfadeEnabled;

      const maxPoly = Number(raw[`${basePath}.${KEYS.SOUNDSCAPE_MAX_POLYPHONY}`] ?? 4);
      cleanFlags.soundscapeMaxPolyphony = Math.max(1, Math.min(16, Number.isFinite(maxPoly) ? maxPoly : 4));

      const scaling = raw[`${basePath}.${KEYS.SOUNDSCAPE_PLAY_CHANCE_SCALING}`];
      cleanFlags.soundscapePlayChanceScaling = sanitizePlayChanceScaling(scaling);

      const clampNum = (value, fallback, min, max) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, n));
      };
      let defMin = clampNum(raw[`${basePath}.${KEYS.SOUNDSCAPE_DEFAULT_MIN_DELAY}`], 15, 0, 3600);
      let defMax = clampNum(raw[`${basePath}.${KEYS.SOUNDSCAPE_DEFAULT_MAX_DELAY}`], 60, 0, 3600);
      if (defMax < defMin) [defMin, defMax] = [defMax, defMin];
      cleanFlags.soundscapeDefaults = {
        minDelay: defMin,
        maxDelay: defMax,
        timingMode: sanitizeProceduralTimingMode(raw[`${basePath}.${KEYS.SOUNDSCAPE_DEFAULT_TIMING_MODE}`]),
        initialFireMode: sanitizeProceduralInitialFireMode(raw[`${basePath}.${KEYS.SOUNDSCAPE_DEFAULT_INITIAL_FIRE_MODE}`]),
        volumeVariance: clampNum(raw[`${basePath}.${KEYS.SOUNDSCAPE_DEFAULT_VARIANCE}`], 0, 0, 1),
        playChance: clampNum(raw[`${basePath}.${KEYS.SOUNDSCAPE_DEFAULT_PLAY_CHANCE}`], 100, 0, 100),
        randomPan: !!raw[`${basePath}.${KEYS.SOUNDSCAPE_DEFAULT_RANDOM_PAN}`]
      };

      if (crossfadeEnabled && autoFadeType === "custom") {
        cleanFlags.useCustomAutoFade = true;
      } else {
        cleanFlags.useCustomAutoFade = false;
      }

      // The playlist document is located at `this.document`, not `this.object`.
      const selectedMode = Number(formData.object.mode);
      const loopPlaylist = !!raw[`${basePath}.${KEYS.LOOP_PLAYLIST}`] &&
        [CONST.PLAYLIST_MODES.SEQUENTIAL,
        CONST.PLAYLIST_MODES.SHUFFLE,
        CONST.PLAYLIST_MODES.SIMULTANEOUS]
          .includes(selectedMode);

      cleanFlags.loopPlaylist = loopPlaylist;

      // 4. Clean up the original formData.
      for (const key of Object.keys(formData.object)) {
        if (key.startsWith(basePath)) {
          delete formData.object[key];
        }
      }

      // 5. Inject our perfectly structured, clean object back into the formData.
      foundry.utils.setProperty(formData.object, basePath, cleanFlags);

      // Finally, call the original wrapped function with the now-sanitized data.
      return wrapped.call(this, event, form, formData);
    },
    "WRAPPER"
  );
}

/**
 * Build the Soundscape subsection HTML.
 * Shows max polyphony, playlist-level defaults, play-chance scaling mode,
 * and a read-only procedural roster for the current playlist.
 * @param {Playlist} playlist
 * @param {object} sos
 * @param {(key: string) => string} fieldName
 * @param {boolean} visible
 * @returns {string}
 */
function _buildSoundscapePanel(playlist, sos, fieldName, visible) {
  const defaults = sos.soundscapeDefaults ?? {};
  const scaling = sanitizePlayChanceScaling(sos.soundscapePlayChanceScaling);
  const maxPoly = sos.soundscapeMaxPolyphony ?? 4;
  const defaultTimingMode = sanitizeProceduralTimingMode(defaults.timingMode);
  const defaultInitialFireMode = sanitizeProceduralInitialFireMode(defaults.initialFireMode);
  const hasPreviewableContent = Array.from(playlist?.sounds ?? [])
    .some((ps) => !Flags.getSoundFlag(ps, "isSilenceGap"));
  const previewDisabled = hasPreviewableContent ? "" : "disabled";
  const previewStatus = hasPreviewableContent ? "Ready" : "No Sounds";

  const proceduralRows = (playlist?.sounds ?? [])
    .filter((ps) => !Flags.getSoundFlag(ps, "isSilenceGap") && Flags.getSoundFlag(ps, "isProcedural"))
    .map((ps) => {
      const min = Flags.resolveProceduralField(ps, "minDelay");
      const max = Flags.resolveProceduralField(ps, "maxDelay");
      const timingMode = sanitizeProceduralTimingMode(Flags.resolveProceduralField(ps, "timingMode"));
      const initialFireMode = sanitizeProceduralInitialFireMode(Flags.resolveProceduralField(ps, "initialFireMode"));
      const chance = Flags.resolveProceduralField(ps, "playChance");
      const pan = Flags.resolveProceduralField(ps, "randomPan");
      const name = foundry.utils.escapeHTML ? foundry.utils.escapeHTML(ps.name ?? "(unnamed)") : (ps.name ?? "(unnamed)");
      const cadenceSummary = formatProceduralCadenceSummary(min, max, timingMode);
      return `
        <tr>
          <td class="sos-roster-name" title="${name}">${name}</td>
          <td class="sos-roster-num">${cadenceSummary}</td>
          <td class="sos-roster-num">${PROCEDURAL_INITIAL_FIRE_OPTIONS[initialFireMode]}</td>
          <td class="sos-roster-num">${chance}%</td>
          <td class="sos-roster-pan">${pan ? '<i class="fas fa-arrows-left-right"></i>' : "&mdash;"}</td>
        </tr>`;
    })
    .join("");

  const rosterTable = proceduralRows
    ? `
      <table class="sos-roster-table">
        <thead>
          <tr>
            <th>Procedural Sound</th>
            <th>Cadence</th>
            <th>First Fire</th>
            <th>Chance</th>
            <th>Pan</th>
          </tr>
        </thead>
        <tbody>${proceduralRows}</tbody>
      </table>`
    : `<p class="notes sos-compact sos-roster-empty">No procedural sounds configured yet. Mark any sound as "Procedural One-Shot" in its sound config.</p>`;

  return /* html */`
    <div class="sos-soundscape-options sos-subsection sos-soundscape-panel" style="display: ${visible ? "block" : "none"};">
      <div class="sos-soundscape-grid">
        <div class="form-group sos-compact sos-soundscape-cell">
          <label>Max Polyphony</label>
          <div class="sos-poly-input-row">
            <input type="number" name="${fieldName("soundscapeMaxPolyphony")}" value="${maxPoly}" step="1" min="1" max="16">
            <span class="sos-poly-hint">1-16</span>
          </div>
          <p class="notes sos-compact">Maximum concurrent one-shots before new fires are skipped.</p>
        </div>

        <div class="form-group sos-compact sos-soundscape-cell">
          <label>Play Chance Scaling</label>
          <div class="form-fields radio-group sos-radio-row">
            <label class="radio sos-compact">
              <input type="radio" name="${fieldName("soundscapePlayChanceScaling")}" value="independent" ${scaling === "independent" ? "checked" : ""}>
              <span>Independent</span>
            </label>
            <label class="radio sos-compact">
              <input type="radio" name="${fieldName("soundscapePlayChanceScaling")}" value="scaled" ${scaling === "scaled" ? "checked" : ""}>
              <span>Linear by Polyphony</span>
            </label>
            <label class="radio sos-compact">
              <input type="radio" name="${fieldName("soundscapePlayChanceScaling")}" value="soft" ${scaling === "soft" ? "checked" : ""}>
              <span>Soft by Polyphony</span>
            </label>
          </div>
          <p class="notes sos-compact">Linear drops chance evenly as the cap fills. Soft keeps more chance alive until the soundscape starts getting crowded.</p>
        </div>
      </div>

      <fieldset class="sos-soundscape-defaults">
        <legend>Procedural Defaults</legend>
        <p class="notes sos-compact">Fallback values for new procedural sounds; per-sound settings override these. Gap values are measured after each fire ends.</p>
        <div class="sos-two-column">
          <div class="sos-column">
            <label>Default Min Gap <span class="sos-label-units">(s)</span></label>
            <input type="number" name="${fieldName("soundscapeDefaults.minDelay")}" value="${defaults.minDelay ?? 15}" step="1" min="0" max="3600">
          </div>
          <div class="sos-column">
            <label>Default Max Gap <span class="sos-label-units">(s)</span></label>
            <input type="number" name="${fieldName("soundscapeDefaults.maxDelay")}" value="${defaults.maxDelay ?? 60}" step="1" min="0" max="3600">
          </div>
        </div>
        <div class="sos-two-column">
          <div class="sos-column">
            <label>Default Cadence Mode</label>
            <select name="${fieldName("soundscapeDefaults.timingMode")}">
              ${Object.entries(PROCEDURAL_TIMING_OPTIONS).map(([value, label]) =>
                `<option value="${value}" ${defaultTimingMode === value ? "selected" : ""}>${label}</option>`
              ).join("")}
            </select>
            <p class="notes sos-compact">How the gap is picked after each fire ends.</p>
          </div>
          <div class="sos-column">
            <label>Default First Fire</label>
            <select name="${fieldName("soundscapeDefaults.initialFireMode")}">
              ${Object.entries(PROCEDURAL_INITIAL_FIRE_OPTIONS).map(([value, label]) =>
                `<option value="${value}" ${defaultInitialFireMode === value ? "selected" : ""}>${label}</option>`
              ).join("")}
            </select>
            <p class="notes sos-compact">Only affects the first fire after activation; later fires use the cadence mode.</p>
          </div>
        </div>
        <div class="sos-two-column">
          <div class="sos-column">
            <label>Default Volume Variance <span class="sos-label-units">(0–1)</span></label>
            <input type="number" name="${fieldName("soundscapeDefaults.volumeVariance")}" value="${defaults.volumeVariance ?? 0}" step="0.05" min="0" max="1">
          </div>
          <div class="sos-column">
            <label>Default Play Chance <span class="sos-label-units">(%)</span></label>
            <input type="number" name="${fieldName("soundscapeDefaults.playChance")}" value="${defaults.playChance ?? 100}" step="1" min="0" max="100">
          </div>
        </div>
        <label class="checkbox sos-compact-checkbox">
          <input type="checkbox" name="${fieldName("soundscapeDefaults.randomPan")}" ${defaults.randomPan ? "checked" : ""}>
          <span>Default: Random Stereo Pan</span>
        </label>
      </fieldset>

      ${game.user.isGM ? `
        <fieldset class="sos-soundscape-preview">
          <legend>Preview</legend>
          <div class="sos-soundscape-preview-row">
            <button type="button" class="sos-soundscape-preview-start sos-proc-audition-fire" data-tooltip="Preview Soundscape" ${previewDisabled}>
              <i class="fa-solid fa-play"></i>
            </button>
            <button type="button" class="sos-soundscape-preview-stop sos-proc-audition-stop" data-tooltip="Stop Preview" disabled>
              <i class="fa-solid fa-stop"></i>
            </button>
            <span class="sos-soundscape-preview-status">${previewStatus}</span>
          </div>
        </fieldset>
      ` : ""}

      <fieldset class="sos-procedural-roster">
        <legend>Procedural Roster</legend>
        ${rosterTable}
      </fieldset>
    </div>
  `;
}

/**
 * Injects custom HTML form controls into the PlaylistConfig sheet.
 */
function _registerPlaylistConfigHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  Hooks.on("renderPlaylistConfig", (app, htmlRaw, data) => {
  const html = htmlRaw instanceof HTMLElement ? $(htmlRaw) : htmlRaw;
  debug("Rendering PlaylistConfig with SOS fields");

  // --- 1. SETUP ---
  const fadeRow = html.find('input[name="fade"]').closest(".form-group");

  // We append to the existing label to preserve Foundry's translation.
  const fadeLabel = fadeRow.find("label");
  if (!fadeLabel.text().includes("(ms)")) {
    fadeLabel.append(' <span class="sos-label-units">(ms)</span>');
  }

  // Replace the range-picker with a simple input for fade duration
const fadeInput = fadeRow.find('input[name="fade"]');
const fadeValue = fadeInput.val();
const fadeRangePicker = fadeRow.find('range-picker');
if (fadeRangePicker.length) {
  fadeRangePicker.replaceWith(`<input type="number" name="fade" value="${fadeValue}" step="1" min="0">`);
}

  const sos = Flags.getPlaylistFlags(app.document);
  if (!Number.isFinite(sos.maxDelay) || sos.maxDelay === 0) {
    sos.maxDelay = sos.silenceDuration;
  }
  const fieldName = (key) => `flags.${MODULE_ID}.${key}`;
  const $modeSelect = html.find('select[name="mode"], select[name="playbackMode"]');
  const $sortModeRow = html.find('select[name="sorting"]').closest(".form-group");

  // Pre-calculate whether looping is allowed for the current playlist mode
  const ALLOWED_LOOP_MODES = [
    CONST.PLAYLIST_MODES.SEQUENTIAL,
    CONST.PLAYLIST_MODES.SHUFFLE,
    CONST.PLAYLIST_MODES.SIMULTANEOUS
  ];
  const playlistMode = app.document?.mode ?? data.document?.mode ?? CONST.PLAYLIST_MODES.DISABLED;
  const canLoop = ALLOWED_LOOP_MODES.includes(playlistMode);
  const soundscapeActive =
    playlistMode === CONST.PLAYLIST_MODES.DISABLED && !!sos.soundscapeMode;
  const nonSoundscapeDisplay = soundscapeActive ? "none" : "block";

  // Define a localizable label for "Fade-In"
  const fadeInLabel = game.i18n.localize("Fade-In");


  // --- 2. CREATE THE CONSOLIDATED UI BLOCK ---
  const $mainBlock = $(`
    <div class="sos-config-section">
      <div class="form-group sos-compact">
        <!-- CHANGE 3: Use the localizable variable for the Fade-In label -->
        <label>${fadeInLabel} <span class="sos-label-units">(ms)</span></label>
        <input type="number" name="${fieldName(KEYS.FADE_IN)}" value="${sos.fadeIn}" step="1" min="0">
      </div>

      <hr class="sos-section-divider">

      <!-- Compact Toggle Group -->
      <div class="sos-toggle-cluster">
        <div class="form-group sos-compact sos-non-soundscape-setting" style="display: ${nonSoundscapeDisplay};">
          <label class="checkbox sos-feature-toggle">
            <input type="checkbox" name="${fieldName(KEYS.LOOP_PLAYLIST)}" ${sos.loopPlaylist ? "checked" : ""} ${canLoop ? "" : "disabled"}>
            <span class="sos-feature-label">Loop Entire Playlist</span>
          </label>
          ${canLoop ? "" : `<p class="notes sos-compact disabled-note">Only works in Sequential, Shuffle, or Simultaneous mode</p>`}
        </div>

        <div class="form-group sos-compact sos-non-soundscape-setting" style="display: ${nonSoundscapeDisplay};">
          <label class="checkbox sos-feature-toggle">
            <input type="checkbox" name="${fieldName(KEYS.CROSSFADE_ENABLED)}" ${sos.crossfade ? "checked" : ""} ${soundscapeActive ? "disabled" : ""}>
            <span class="sos-feature-label">Enable Crossfade</span>
          </label>
        </div>
        <div class="sos-crossfade-options sos-subsection" style="display: ${sos.crossfade ? "block" : "none"};">
          <!-- Crossfade options remain here -->
          <div class="form-group sos-compact">
            <label>Automatic Crossfade Duration</label>
            <div class="form-fields radio-group">
              <label class="radio sos-compact">
                <input type="radio" name="flags.${MODULE_ID}.autoFadeType" value="default" ${!sos.useCustomAutoFade ? "checked" : ""}>
                <span>Use Playlist Fade-Out</span>
              </label>
              <label class="radio sos-compact">
                <input type="radio" name="flags.${MODULE_ID}.autoFadeType" value="custom" ${sos.useCustomAutoFade ? "checked" : ""}>
                <span>Custom <span class="sos-label-units">(ms)</span></span>
              </label>
              <input type="number" name="${fieldName(KEYS.CUSTOM_AUTO_FADE_MS)}" value="${sos.customAutoFadeMs}" 
                     class="sos-custom-fade-input" style="display: ${sos.useCustomAutoFade ? "block" : "none"};">
            </div>
            <p class="notes sos-compact">Duration used when tracks transition automatically</p>
          </div>
        </div>
        
        ${_buildSoundscapePanel(app.document, sos, fieldName, soundscapeActive)}

        <div class="form-group sos-compact sos-non-soundscape-setting" style="display: ${nonSoundscapeDisplay};">
          <label class="checkbox sos-feature-toggle">
            <input type="checkbox" name="${fieldName(KEYS.ENABLED)}" ${sos.silenceEnabled ? "checked" : ""} ${soundscapeActive ? "disabled" : ""}>
            <span class="sos-feature-label">Enable Silence</span>
          </label>
        </div>
        <div class="sos-silence-block sos-subsection" style="display: ${sos.silenceEnabled ? "block" : "none"};">
          <!-- Silence options remain here -->
          <div class="form-group sos-compact">
            <label>Silence Mode</label>
            <select name="${fieldName(KEYS.MODE)}">
              <option value="static" ${sos.silenceMode === "static" ? "selected" : ""}>Static</option>
              <option value="random" ${sos.silenceMode === "random" ? "selected" : ""}>Random</option>
            </select>
          </div>
          <div class="form-group sos-compact">
            <label>Duration <span class="sos-label-units">(ms)</span></label>
            <input type="number" name="${fieldName(KEYS.DURATION)}" value="${sos.silenceDuration}" step="100" min="0">
          </div>
          <div class="form-group sos-compact sos-delay-group" style="display: none;">
            <label class="sos-range-label">Min Delay <span class="sos-label-units">(ms)</span>: <span class="sos-minDelay-val">${sos.minDelay}</span></label>
            <input type="range" name="${fieldName(KEYS.MIN_DELAY)}" min="0" max="${sos.silenceDuration}" step="100" value="${sos.minDelay}">
            <label class="sos-range-label">Max Delay <span class="sos-label-units">(ms)</span>: <span class="sos-maxDelay-val">${sos.maxDelay}</span></label>
            <input type="range" name="${fieldName(KEYS.MAX_DELAY)}" min="0" max="${sos.silenceDuration}" step="100" value="${sos.maxDelay}">
          </div>
        </div>

      </div>

      <hr class="sos-section-divider">
      
      <div class="form-group sos-compact">
        <label class="checkbox sos-feature-toggle">
          <input type="checkbox" name="${fieldName(KEYS.VOLUME_NORMALIZATION_ENABLED)}" ${sos.volumeNormalizationEnabled ? "checked" : ""}>
          <span class="sos-feature-label">Enable Volume Normalization</span>
        </label>
        <p class="notes sos-compact">Permanently sets the volume for all sounds in this playlist that do not have the override flag checked.</p>
      </div>
      <div class="sos-normalization-options sos-subsection" style="display: ${sos.volumeNormalizationEnabled ? "block" : "none"};">
        <div class="form-group">
            <label>Target Volume</label>
            <div class="form-fields">
                <range-picker name="${fieldName(KEYS.NORMALIZED_VOLUME)}" value="${sos.normalizedVolume}" min="0" max="1" step="0.05"/>
            </div>
        </div>
      </div>
      <hr class="sos-section-divider">
    </div>
  `);

  // --- 3. INJECT HTML INTO THE FORM ---
  fadeRow.after($mainBlock);

  // --- 4. ATTACH ALL EVENT HANDLERS (now scoped to $mainBlock) ---
  const normalizationMaster = $mainBlock.find(`input[name="${fieldName("volumeNormalizationEnabled")}"]`);
  const normalizationOptions = $mainBlock.find('.sos-normalization-options');
  normalizationMaster.on('change', () => normalizationOptions.toggle(normalizationMaster.is(':checked')));

  const crossfadeMaster = $mainBlock.find(`input[name="${fieldName(KEYS.CROSSFADE_ENABLED)}"]`);
  const crossfadeOptions = $mainBlock.find('.sos-crossfade-options');
  const silenceMaster = $mainBlock.find(`input[name="${fieldName(KEYS.ENABLED)}"]`);
  const silenceOptions = $mainBlock.find('.sos-silence-block');
  const soundscapeOptions = $mainBlock.find('.sos-soundscape-options');
  const nonSoundscapeSettings = $mainBlock.find('.sos-non-soundscape-setting');
  const isSoundscapeChoice = () => String($modeSelect.val()) === "soundscape";
  const soundscapePreviewPanel = $mainBlock.find('.sos-soundscape-preview');
  const soundscapePreviewStart = soundscapePreviewPanel.find('.sos-soundscape-preview-start');
  const soundscapePreviewStop = soundscapePreviewPanel.find('.sos-soundscape-preview-stop');
  const soundscapePreviewStatus = soundscapePreviewPanel.find('.sos-soundscape-preview-status');
  const hasPreviewableSoundscapeContent = Array.from(app.document?.sounds ?? [])
    .some((ps) => !Flags.getSoundFlag(ps, "isSilenceGap"));

  function refreshSoundscapeState() {
    const soundscapeOn = isSoundscapeChoice();
    nonSoundscapeSettings.toggle(!soundscapeOn);
    $sortModeRow.toggle(!soundscapeOn);
    crossfadeMaster.prop('disabled', soundscapeOn);
    silenceMaster.prop('disabled', soundscapeOn);

    if (soundscapeOn) {
      crossfadeMaster.prop('checked', false);
      silenceMaster.prop('checked', false);
    }

    crossfadeOptions.toggle(crossfadeMaster.is(':checked') && !soundscapeOn);
    silenceOptions.toggle(silenceMaster.is(':checked') && !soundscapeOn);
    soundscapeOptions.toggle(soundscapeOn);
    refreshSoundscapePreviewControls();
  }

  function readNamedValue(name, fallback) {
    const field = $mainBlock.find(`[name="${name}"]`)[0] ?? html.find(`[name="${name}"]`)[0];
    return field?.value ?? field?.getAttribute?.("value") ?? fallback;
  }

  function readNumber(name, fallback, min = -Infinity, max = Infinity) {
    const value = Number(readNamedValue(name, fallback));
    const n = Number.isFinite(value) ? value : fallback;
    return Math.max(min, Math.min(max, n));
  }

  function collectSoundscapePreviewOverrides() {
    let defMin = readNumber(fieldName(KEYS.SOUNDSCAPE_DEFAULT_MIN_DELAY), 15, 0, 3600);
    let defMax = readNumber(fieldName(KEYS.SOUNDSCAPE_DEFAULT_MAX_DELAY), 60, 0, 3600);
    if (defMax < defMin) [defMin, defMax] = [defMax, defMin];

    return {
      fade: readNumber("fade", app.document?.fade ?? 0, 0),
      flags: {
        fadeIn: readNumber(fieldName(KEYS.FADE_IN), 0, 0),
        soundscapeMaxPolyphony: readNumber(fieldName(KEYS.SOUNDSCAPE_MAX_POLYPHONY), 4, 1, 16),
        soundscapePlayChanceScaling: sanitizePlayChanceScaling(
          $mainBlock.find(`input[name="${fieldName(KEYS.SOUNDSCAPE_PLAY_CHANCE_SCALING)}"]:checked`).val()
        ),
        volumeNormalizationEnabled: normalizationMaster.is(':checked'),
        normalizedVolume: readNumber(fieldName(KEYS.NORMALIZED_VOLUME), 0.5, 0, 1),
        soundscapeDefaults: {
          minDelay: defMin,
          maxDelay: defMax,
          timingMode: sanitizeProceduralTimingMode(readNamedValue(fieldName(KEYS.SOUNDSCAPE_DEFAULT_TIMING_MODE), "uniform")),
          initialFireMode: sanitizeProceduralInitialFireMode(readNamedValue(fieldName(KEYS.SOUNDSCAPE_DEFAULT_INITIAL_FIRE_MODE), "normal")),
          volumeVariance: readNumber(fieldName(KEYS.SOUNDSCAPE_DEFAULT_VARIANCE), 0, 0, 1),
          playChance: readNumber(fieldName(KEYS.SOUNDSCAPE_DEFAULT_PLAY_CHANCE), 100, 0, 100),
          randomPan: !!$mainBlock.find(`input[name="${fieldName(KEYS.SOUNDSCAPE_DEFAULT_RANDOM_PAN)}"]`).is(':checked')
        }
      }
    };
  }

  function setSoundscapePreviewStatus(text, state = "ready") {
    soundscapePreviewPanel
      .removeClass("is-loading is-playing is-failed")
      .toggleClass("is-loading", state === "loading")
      .toggleClass("is-playing", state === "playing")
      .toggleClass("is-failed", state === "failed");
    soundscapePreviewStatus.text(text);
  }

  function refreshSoundscapePreviewControls() {
    if (!soundscapePreviewPanel.length) return;
    const previewing = SoundscapePreviewer.isPreviewing(app.document);
    const canPreview = hasPreviewableSoundscapeContent && isSoundscapeChoice() && !previewing;
    soundscapePreviewStart.prop('disabled', !canPreview);
    soundscapePreviewStop.prop('disabled', !previewing);
    if (previewing) setSoundscapePreviewStatus("Playing", "playing");
    else if (!hasPreviewableSoundscapeContent) setSoundscapePreviewStatus("No Sounds", "failed");
    else setSoundscapePreviewStatus("Ready", "ready");
  }

  soundscapePreviewStart.on('click', async (event) => {
    event.preventDefault();
    if (soundscapePreviewStart.prop('disabled')) return;
    setSoundscapePreviewStatus("Loading", "loading");
    soundscapePreviewStart.prop('disabled', true);
    const started = await SoundscapePreviewer.start(app.document, {
      forceSoundscapeMode: true,
      configOverrides: collectSoundscapePreviewOverrides()
    });
    app._soundOfSilenceSoundscapePreview = started;
    refreshSoundscapePreviewControls();
  });

  soundscapePreviewStop.on('click', (event) => {
    event.preventDefault();
    SoundscapePreviewer.stop(app.document);
    app._soundOfSilenceSoundscapePreview = false;
    refreshSoundscapePreviewControls();
  });

  crossfadeMaster.on('change', () => {
    crossfadeOptions.toggle(crossfadeMaster.is(':checked'));
    if (crossfadeMaster.is(':checked')) {
      silenceMaster.prop('checked', false).trigger('change');
    }
  });

  silenceMaster.on('change', () => {
    silenceOptions.toggle(silenceMaster.is(':checked'));
    if (silenceMaster.is(':checked')) {
      crossfadeMaster.prop('checked', false).trigger('change');
    }
  });

  // Soundscape default min/max auto-swap on blur.
  const $defMin = $mainBlock.find(`input[name="${fieldName("soundscapeDefaults.minDelay")}"]`);
  const $defMax = $mainBlock.find(`input[name="${fieldName("soundscapeDefaults.maxDelay")}"]`);
  $defMin.on("change", () => {
    if (Number($defMin.val()) > Number($defMax.val())) $defMax.val($defMin.val());
  });
  $defMax.on("change", () => {
    if (Number($defMax.val()) < Number($defMin.val())) $defMin.val($defMax.val());
  });

  const customFadeInput = $mainBlock.find(`input[name="${fieldName(KEYS.CUSTOM_AUTO_FADE_MS)}"]`);
  $mainBlock.find(`input[name="flags.${MODULE_ID}.autoFadeType"]`).on('change', (ev) => {
    customFadeInput.toggle(ev.currentTarget.value === 'custom');
  });

  const silenceModeSelect = $mainBlock.find(`select[name="${fieldName(KEYS.MODE)}"]`);
  const randomDelayGroup = $mainBlock.find('.sos-delay-group');
  silenceModeSelect.on('change', () => randomDelayGroup.toggle(silenceModeSelect.val() === 'random'));
  randomDelayGroup.toggle(silenceModeSelect.val() === 'random');

  $mainBlock.find(`input[name="${fieldName(KEYS.DURATION)}"]`).on('input', function () {
    const silVal = Number($(this).val()) || 0;
    const minDelayInput = $mainBlock.find(`input[name="${fieldName(KEYS.MIN_DELAY)}"]`);
    const maxDelayInput = $mainBlock.find(`input[name="${fieldName(KEYS.MAX_DELAY)}"]`);
    minDelayInput.attr('max', silVal);
    maxDelayInput.attr('max', silVal);
    if (Number(minDelayInput.val()) > silVal) minDelayInput.val(silVal).trigger('input');
    if (Number(maxDelayInput.val()) > silVal) maxDelayInput.val(silVal).trigger('input');
  });

  function clampSliders(changed) {
    const $min = $mainBlock.find(`input[name="${fieldName(KEYS.MIN_DELAY)}"]`);
    const $max = $mainBlock.find(`input[name="${fieldName(KEYS.MAX_DELAY)}"]`);
    let minVal = Number($min.val());
    let maxVal = Number($max.val());
    if (changed === "min" && minVal > maxVal) $max.val(minVal);
    if (changed === "max" && maxVal < minVal) $min.val(maxVal);
    $mainBlock.find('.sos-minDelay-val').text($min.val());
    $mainBlock.find('.sos-maxDelay-val').text($max.val());
  }
  $mainBlock.find(`input[name="${fieldName(KEYS.MIN_DELAY)}"]`).on('input', () => clampSliders("min"));
  $mainBlock.find(`input[name="${fieldName(KEYS.MAX_DELAY)}"]`).on('input', () => clampSliders("max"));
  clampSliders();

  const loopChk = $mainBlock.find(`input[name="${fieldName(KEYS.LOOP_PLAYLIST)}"]`);
  const loopNote = loopChk.closest('.form-group').find('p.notes');

  function refreshLoopToggle() {
    const mode = Number($modeSelect.val());
    const isAllowed = ALLOWED_LOOP_MODES.includes(mode);
    loopChk.prop('disabled', !isAllowed);
    loopNote.toggle(!isAllowed);
  }
  $modeSelect.on('change', refreshLoopToggle);
  $modeSelect.on('change', refreshSoundscapeState);
  refreshSoundscapeState();
  refreshLoopToggle();
  });

  Hooks.on("closePlaylistConfig", (app) => {
    if (!app?._soundOfSilenceSoundscapePreview) return;
    if (SoundscapePreviewer.isPreviewing(app.document)) {
      SoundscapePreviewer.stop(app.document, { notify: false });
    }
    app._soundOfSilenceSoundscapePreview = false;
  });
}
