/**
 * @file playlist-config.js
 * @description This file manages the integration of module settings into the PlaylistConfig sheet.
 * It uses libWrapper to inject data and handle form submission for playlist-level flags,
 * and a hook to render the custom form fields.
 */
import { MODULE_ID } from "./utils.js";
import { debug } from "./utils.js";
import { Flags } from "./flag-service.js";

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
  NORMALIZED_VOLUME: "normalizedVolume" // number (0-1)
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
  [KEYS.NORMALIZED_VOLUME]: 0.5
};

/**
 * Registers the necessary libWrapper patches for the PlaylistConfig sheet.
 */
export function registerPlaylistSheetWrappers() {
  _registerV13Wrappers();
}

/**
 * Registers wrappers for Foundry v13+ (DocumentSheetV2).
 */
function _registerV13Wrappers() {
  debug("Registering V13 PlaylistConfig wrappers");

  // Supply module data to the template context. This part is correct and remains.
  libWrapper.register(
    MODULE_ID,
    "foundry.applications.sheets.PlaylistConfig.prototype._prepareContext",
    async function (wrapped, options) {
      const ctx = await wrapped.call(this, options);
      ctx.sos = Flags.getPlaylistFlags(ctx.document);
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

      const crossfadeEnabled = !!raw[`${basePath}.${KEYS.CROSSFADE_ENABLED}`];
      const silenceEnabled = !!raw[`${basePath}.${KEYS.ENABLED}`];
      const formDataObj = foundry.utils.flattenObject(formData.object);
      const autoFadeType = formDataObj[`flags.${MODULE_ID}.autoFadeType`];

      // 3. Apply the critical logic to the clean data.
      cleanFlags.crossfade = crossfadeEnabled;
      cleanFlags.silenceEnabled = silenceEnabled && !crossfadeEnabled;

      if (crossfadeEnabled && autoFadeType === "custom") {
        cleanFlags.useCustomAutoFade = true;
      } else {
        cleanFlags.useCustomAutoFade = false;
      }

      // The playlist document is located at `this.document`, not `this.object`.
      const loopPlaylist = !!raw[`${basePath}.${KEYS.LOOP_PLAYLIST}`] &&
        [CONST.PLAYLIST_MODES.SEQUENTIAL,
        CONST.PLAYLIST_MODES.SHUFFLE,
        CONST.PLAYLIST_MODES.SIMULTANEOUS]
          .includes(this.document.mode);

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
 * Injects custom HTML form controls into the PlaylistConfig sheet.
 */
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

  // Pre-calculate whether looping is allowed for the current playlist mode
  const ALLOWED_LOOP_MODES = [
    CONST.PLAYLIST_MODES.SEQUENTIAL,
    CONST.PLAYLIST_MODES.SHUFFLE,
    CONST.PLAYLIST_MODES.SIMULTANEOUS
  ];
  const playlistMode = app.document?.mode ?? data.document?.mode ?? CONST.PLAYLIST_MODES.SIMULTANEOUS;
  const canLoop = ALLOWED_LOOP_MODES.includes(playlistMode);

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
          <div class="form-group sos-compact">
          <label class="checkbox sos-feature-toggle">
            <input type="checkbox" name="${fieldName(KEYS.LOOP_PLAYLIST)}" ${sos.loopPlaylist ? "checked" : ""} ${canLoop ? "" : "disabled"}>
            <span class="sos-feature-label">Loop Entire Playlist</span>
          </label>
          ${canLoop ? "" : `<p class="notes sos-compact disabled-note">Only works in Sequential, Shuffle, or Simultaneous mode</p>`}
        </div>
        <div class="form-group sos-compact">
          <label class="checkbox sos-feature-toggle">
            <input type="checkbox" name="${fieldName(KEYS.CROSSFADE_ENABLED)}" ${sos.crossfade ? "checked" : ""}>
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
        
        <div class="form-group sos-compact">
          <label class="checkbox sos-feature-toggle">
            <input type="checkbox" name="${fieldName(KEYS.ENABLED)}" ${sos.silenceEnabled ? "checked" : ""}>
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

  crossfadeMaster.on('change', () => {
    crossfadeOptions.toggle(crossfadeMaster.is(':checked'));
    if (crossfadeMaster.is(':checked')) silenceMaster.prop('checked', false).trigger('change');
  });

  silenceMaster.on('change', () => {
    silenceOptions.toggle(silenceMaster.is(':checked'));
    if (silenceMaster.is(':checked')) crossfadeMaster.prop('checked', false).trigger('change');
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

  const $modeSelect = html.find('select[name="mode"], select[name="playbackMode"]');
  const loopChk = $mainBlock.find(`input[name="${fieldName(KEYS.LOOP_PLAYLIST)}"]`);
  const loopNote = loopChk.closest('.form-group').find('p.notes');

  function refreshLoopToggle() {
    const mode = Number($modeSelect.val());
    const isAllowed = ALLOWED_LOOP_MODES.includes(mode);
    loopChk.prop('disabled', !isAllowed);
    loopNote.toggle(!isAllowed);
  }
  $modeSelect.on('change', refreshLoopToggle);
  refreshLoopToggle();
});