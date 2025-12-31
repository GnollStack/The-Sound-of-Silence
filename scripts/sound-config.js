// sound-config.js

import { LoopPreviewer } from "./loop-previewer.js";
import { debug, MODULE_ID, toSec, SEGMENT_COLORS } from "./utils.js";
import { Flags } from "./flag-service.js";

// max amount of Loop Segments
const MAX_SEGMENTS = 16;

// =========================================================================
// Flag Constants & Defaults
// =========================================================================

export const LOOP_KEY = "loopWithin";

const DEFAULTS = {
  enabled: false,
  active: true,
  startFromBeginning: true,
  segments: [],
  // Legacy properties for migration
  start: "00:00",
  end: "00:00",
  crossfadeMs: 1000,
  skipCount: 0,
  loopCount: 0,
};



// =========================================================================
// libWrapper Registrations
// =========================================================================

export function registerSoundConfigWrappers() {
  debug("Registering PlaylistSoundConfig wrappers (loop-within)");

  libWrapper.register(
    MODULE_ID,
    "foundry.applications.sheets.PlaylistSoundConfig.prototype._prepareContext",
    async function (wrapped, options) {
      const ctx = await wrapped.call(this, options);

      // Fetch the parent playlist's flags to check for normalization.
      const playlist = this.document.parent;
      ctx.sosPlaylistFlags = playlist ? Flags.getPlaylistFlags(playlist) : {};

      ctx.loopWithin = Flags.getLoopConfig(ctx.document);
      return ctx;
    },
    "WRAPPER"
  );

  // Hook into _processFormData instead - this is where form data gets processed
  libWrapper.register(
    MODULE_ID,
    "foundry.applications.sheets.PlaylistSoundConfig.prototype._processFormData",
    function (wrapped, event, form, formData) {
      debug(`%c[SoS Debug] --- _processFormData WRAPPER ---`, 'background-color: #6495ED; color: white; font-weight: bold;');
      debug("[SoS Debug] 1. formData.object received:", foundry.utils.deepClone(formData.object));

      const modulePath = `flags.${MODULE_ID}`;
      const loopPath = `${modulePath}.${LOOP_KEY}`;
      const segmentPrefix = `${loopPath}.segments.`;

      // SAFETY: Store original data for recovery
      const originalFormData = foundry.utils.deepClone(formData.object);
      const existingFlags = this.document.getFlag(MODULE_ID);

      try {
        const segments = new Map();
        const otherFlags = {}; // Holds all non-segment flags

        // 1. Extract all our flat flag data into a single object
        for (const [key, value] of Object.entries(formData.object)) {
          if (typeof key !== 'string' || !key.startsWith(modulePath)) continue;

          if (key.startsWith(segmentPrefix)) {
            const rest = key.slice(segmentPrefix.length);
            const parts = rest.split('.');
            if (parts.length !== 2) continue;

            const [indexStr, field] = parts;
            const index = parseInt(indexStr, 10);
            if (!Number.isFinite(index) || index < 0) continue;

            if (!segments.has(index)) segments.set(index, {});
            segments.get(index)[field] = value;

          } else {
            // Catches ...loopWithin.enabled, ...allowVolumeOverride, etc.
            const fieldName = key.substring(modulePath.length + 1);
            foundry.utils.setProperty(otherFlags, fieldName, value);
          }
        }

        const loopData = otherFlags[LOOP_KEY] || {};

        debug("[SoS Debug] 2. Reconstructed segments (Map):", Array.from(segments.entries()));
        debug("[SoS Debug] 2b. Other flags:", foundry.utils.deepClone(otherFlags));

        // 2. Build clean, validated flags
        const cleanRootFlags = {
          allowVolumeOverride: !!otherFlags.allowVolumeOverride,
        };

        const cleanLoopFlags = {
          enabled: !!loopData.enabled,
          active: !!loopData.active && !!loopData.enabled,
          startFromBeginning: !!loopData.startFromBeginning,
        };

        // --- (This segment processing logic is unchanged and correct) ---
        let cleanSegments = [];
        if (segments.size > 0) {
          debug("[SoS Debug] 3. Processing and validating segments...");
          cleanSegments = Array.from(segments.values())
            .filter(segData => typeof segData.start !== 'undefined' && typeof segData.end !== 'undefined')
            .map((segData) => {
              const cleaned = {
                crossfadeMs: Math.max(0, Number(segData.crossfadeMs) ?? 0),
                loopCount: Math.max(0, parseInt(segData.loopCount, 10) || 0),
              };
              const norm = (v) => {
                if (typeof v !== "string") return "00:00.000";
                const trimmed = String(v).trim();
                if (!trimmed || !/^\d{1,2}:\d{2}(\.\d{1,3})?$/.test(trimmed)) return "00:00.000";
                const parts = trimmed.split(":");
                const m = parseInt(parts[0], 10) || 0;
                const [secStr, msStr] = (parts[1] || "0.0").split('.');
                const s = parseInt(secStr, 10) || 0;
                const ms = parseInt((msStr || "0").padEnd(3, '0').slice(0, 3), 10) || 0;
                const clampedM = Math.max(0, m);
                const clampedS = Math.min(59, Math.max(0, s));
                const clampedMs = Math.min(999, Math.max(0, ms));
                return `${String(clampedM).padStart(2, "0")}:${String(clampedS).padStart(2, "0")}.${String(clampedMs).padStart(3, "0")}`;
              };
              cleaned.start = norm(segData.start);
              cleaned.end = norm(segData.end);
              cleaned.skipToNext = !!segData.skipToNext;
              return cleaned;
            });
          cleanSegments.sort((a, b) => toSec(a.start) - toSec(b.start));
        }
        cleanLoopFlags.segments = cleanSegments;
        // --- (End of segment processing) ---

        const finalFlags = {
          ...cleanRootFlags,
          [LOOP_KEY]: cleanLoopFlags
        };

        debug(`[SoS Debug] 4. Final sanitized flags:`, foundry.utils.deepClone(finalFlags));

        // 3. Remove all old flat keys from the form data
        for (const key of Object.keys(formData.object)) {
          if (key.startsWith(modulePath)) {
            delete formData.object[key];
          }
        }

        // 4. Set the single, clean, nested structure back
        foundry.utils.setProperty(formData.object, modulePath, finalFlags);
        debug(`%c[SoS Debug] 5. FINAL formData.object:`, 'background-color: #00dd00; color: black; font-weight: bold;', foundry.utils.deepClone(formData.object));

      } catch (err) {
        // ... (Error handling is unchanged and correct) ...
        console.error(`[${MODULE_ID}] Critical error in form data processing:`, err);
        try {
          if (existingFlags) {
            console.warn(`[${MODULE_ID}] Recovery Level 1: Restoring previous flag data`);
            for (const key of Object.keys(formData.object)) {
              if (key.startsWith(modulePath)) delete formData.object[key];
            }
            foundry.utils.setProperty(formData.object, modulePath, existingFlags);
          } else { throw new Error("No previous flags available"); }
        } catch (recoveryErr) {
          console.error(`[${MODULE_ID}] Recovery Level 1 failed:`, recoveryErr);
          console.warn(`[${MODULE_ID}] Recovery Level 2: Using default values`);
          try {
            for (const key of Object.keys(formData.object)) {
              if (key.startsWith(modulePath)) delete formData.object[key];
            }
            foundry.utils.setProperty(formData.object, modulePath, {
              allowVolumeOverride: false,
              [LOOP_KEY]: foundry.utils.duplicate(DEFAULTS)
            });
          } catch (finalErr) {
            console.error(`[${MODULE_ID}] Recovery Level 2 failed:`, finalErr);
            console.warn(`[${MODULE_ID}] Recovery Level 3: Restoring entire original form data`);
            formData.object = originalFormData;
          }
        }
        ui.notifications.error(`${MODULE_ID}: Failed to save sound configuration. Previous settings restored.`);
      }

      return wrapped.call(this, event, form, formData);
    },
    "WRAPPER"
  );
}


// =========================================================================
// HTML Injection Hook
// =========================================================================

function _createSegmentHtml(segmentData, index) {
  try {
    const field = (key) => `flags.${MODULE_ID}.${LOOP_KEY}.segments.${index}.${key}`;

    const data = foundry.utils.mergeObject({
      start: "00:00.000",
      end: "00:00.000",
      crossfadeMs: 1000,
      loopCount: 0,
      skipToNext: false
    }, segmentData || {});

    const safeStart = String(data.start).replace(/[<>"']/g, '');
    const safeEnd = String(data.end).replace(/[<>"']/g, '');
    const safeCrossfade = Math.max(0, Number(data.crossfadeMs) ?? 1000);
    const safeLoopCount = Math.max(0, parseInt(data.loopCount, 10) || 0);
    const safeSkipToNext = !!data.skipToNext;
    const colorHex = SEGMENT_COLORS[index % SEGMENT_COLORS.length];
    const startColor = `${colorHex}55`; // ~33% alpha - more solid start
    const endColor = `${colorHex}00`;   //   0% alpha - fully transparent end

    return $(/* html */`
      <div class="sos-loop-segment-section sos-compact" data-segment-index="${index}">
        <div class="sos-segment-header sos-compact collapsible" style="background: linear-gradient(90deg, ${startColor} 10%, ${endColor} 90%);">
          <div class="sos-segment-title">
            <i class="fas fa-chevron-right segment-toggle-icon"></i>
            <h4>Loop Segment ${index + 1}</h4>
          </div>
          <div class="sos-segment-preview-buttons">
            <button type="button" class="loop-stop sos-compact" data-tooltip="Stop Preview">
                <i class="fas fa-stop"></i>
              </button>
            <button type="button" class="sos-loop-preview-point sos-compact" data-segment-index="${index}" data-tooltip="Preview Loop Transition (3s window)">
              <i class="fas fa-crosshairs"></i>
            </button>
            <button type="button" class="sos-loop-preview-segment sos-compact" data-segment-index="${index}" data-tooltip="Preview Full Loop">
              <i class="fas fa-play-circle"></i>
            </button>
          </div>
        </div>
        
        <div class="sos-segment-content" style="display: none;">
          <div class="form-group sos-compact sos-time-inputs">
            <div class="sos-time-input-wrapper">
              <label>Start <span class="sos-label-units">(MM:SS.mmm)</span></label>
              <input type="text" name="${field("start")}" value="${safeStart}" placeholder="00:30.500">
            </div>
            <div class="sos-time-input-wrapper">
              <label>End <span class="sos-label-units">(MM:SS.mmm)</span></label>
              <input type="text" name="${field("end")}" value="${safeEnd}" placeholder="01:45.250">
            </div>
          </div>
          
          <div class="form-group sos-compact sos-two-column">
            <div class="sos-column">
              <label>Crossfade <span class="sos-label-units">(ms)</span></label>
              <input type="number" name="${field("crossfadeMs")}" value="${safeCrossfade}" step="100" min="0">
            </div>
            <div class="sos-column">
              <label>Loop Count <span class="sos-label-units">(0 = infinite)</span></label>
              <input type="number" name="${field("loopCount")}" value="${safeLoopCount}" step="1" min="0">
            </div>
          </div>
          
          <div class="form-group sos-compact">
            <label class="checkbox sos-compact-checkbox">
              <input type="checkbox" name="${field("skipToNext")}" ${safeSkipToNext ? 'checked' : ''}>
              <span>Skip to next segment after loops complete</span>
            </label>
            <p class="notes sos-compact">Jumps to next segment instead, If there is no segment it will stop at the last one and play through the song.</p>
          </div>
        </div>
      </div>
    `);
  } catch (err) {
    console.error(`[${MODULE_ID}] Failed to create segment HTML:`, err);
    return $(`<div class="sos-loop-segment-section error sos-compact">
      <p class="error-text">Error rendering segment ${index + 1}. Please remove and re-add.</p>
    </div>`);
  }
}


Hooks.on("renderPlaylistSoundConfig", (app, htmlRaw, data) => {
  const html = htmlRaw instanceof HTMLElement ? $(htmlRaw) : htmlRaw;
  const loop = data.loopWithin ?? Flags.getLoopConfig(app.document);
  const allowVolumeOverride = Flags.getSoundFlag(app.document, "allowVolumeOverride");
  const field = (k) => `flags.${MODULE_ID}.${LOOP_KEY}.${k}`;

  // --- 1. Create UI Blocks ---

  // Create the "Override Volume" block. This will be injected separately.
  const $overrideBlock = $(/* html */`
    <div class="form-group sos-compact">
      <label class="checkbox sos-compact-checkbox">
        <input type="checkbox" name="flags.${MODULE_ID}.allowVolumeOverride" ${allowVolumeOverride ? "checked" : ""}>
        <span>Override Playlist Volume</span>
      </label>
      <p class="notes sos-compact">If checked, this sound will ignore the playlist's "Volume Normalization" setting.</p>
    </div>
  `);

  // The main "Internal Loop" block.
  const $mainBlock = $(/* html */ `
    <div class="sos-sound-config">
      <div class="form-group sos-compact">
        <label class="checkbox sos-feature-toggle">
          <input type="checkbox" name="${field("enabled")}" ${loop.enabled ? "checked" : ""}>
          <span class="sos-feature-label">Enable Internal Loop</span>
        </label>
      </div>
      
      <div class="sos-loop-active-row sos-compact" style="display:${loop.enabled ? "flex" : "none"}">
        <label class="checkbox sos-compact-checkbox">
          <input type="checkbox" name="${field("active")}" ${loop.active ? "checked" : ""}>
          <span>Loop Active</span>
        </label>
      </div>
      
      <div class="sos-loop-body" style="display:${loop.enabled ? "block" : "none"}">
        <div class="form-group sos-compact">
          <label class="checkbox sos-compact-checkbox">
            <input type="checkbox" name="${field("startFromBeginning")}" ${loop.startFromBeginning ? "checked" : ""}>
            <span>Start from beginning (play intro first)</span>
          </label>
        </div>
        
        <div class="form-group sos-loop-editor sos-compact">
          <label class="sos-editor-label">Loop Preview</label>
          
          <div class="sos-loop-buttons-row sos-compact" style="display: none;">
            <div class="sos-loop-buttons-group">
              <button type="button" class="loop-play-pause sos-compact" data-tooltip="Play/Pause Preview">
                <i class="fas fa-play"></i>
              </button>
              <button type="button" class="loop-stop sos-compact" data-tooltip="Stop Preview">
                <i class="fas fa-stop"></i>
              </button>
            </div>
            <div class="sos-loop-timer">00:00 / 00:00</div>
          </div>
          
          <div class="sos-loop-timeline-row">
            <div class="sos-loop-timeline-container">
              <div class="sos-loop-timeline-track"></div>
              <div class="sos-loop-timeline-progress"></div>
              <div class="sos-loop-timeline-warning-overlay"></div>
            </div>
          </div>
          
          <div class="sos-loop-timeline-container-fallback" style="display: block;">
            <p class="loading">Loading audio metadata...</p>
          </div>
        </div>
        
        <div class="sos-loop-segments-container"></div>
        
        <div class="sos-loop-controls-footer sos-compact">
          <button type="button" class="sos-add-loop-segment sos-compact">
            <i class="fas fa-plus"></i> Add Section
          </button>
          <button type="button" class="sos-remove-loop-segment sos-compact">
            <i class="fas fa-minus"></i> Remove Last
          </button>
        </div>
      </div>
    </div>
  `);

  // --- 2. Inject HTML into Correct Positions ---
  // Find reliable anchor points in the default form
  const $repeatGroup = html.find('input[name="repeat"]').closest(".form-group");
  const $fadeGroup = html.find('input[name="fade"]').closest(".form-group");

  // Inject the override block *before* the "Repeat" checkbox group.
  // This correctly places it right after the "Sound Volume" group.
  if ($repeatGroup.length) {
    $repeatGroup.before($overrideBlock);
  }

  // Inject the main module block *after* the "Fade Duration" group.
  if ($fadeGroup.length) {
    $fadeGroup.after($mainBlock);
  }

  // --- 3. Existing Loop Logic (Unchanged) ---
  const $segmentsContainer = $mainBlock.find('.sos-loop-segments-container');
  const $addButton = $mainBlock.find('button.sos-add-loop-segment');
  const $removeButton = $mainBlock.find('button.sos-remove-loop-segment');

  function refreshUI() {
    const segmentCount = $segmentsContainer.children().length;
    $removeButton.prop('disabled', segmentCount <= 1);
    const atLimit = segmentCount >= MAX_SEGMENTS;
    $addButton.prop('disabled', atLimit);
    $addButton.attr('data-tooltip', atLimit ? `Maximum of ${MAX_SEGMENTS} segments reached` : 'Add Loop Section');
    $segmentsContainer.find("h4").each(function (i) {
      $(this).text(`Loop Segment ${i + 1}`);
    });
    app._soundOfSilencePreviewer?.rescanSegments();
  }

  function addSegment(data = {}, index) {
    debug(`[SoS Debug] Adding new segment HTML. Index: ${index ?? 'new'}, Data:`, data);
    const newIndex = index ?? $segmentsContainer.children().length;
    $segmentsContainer.append(_createSegmentHtml(data, newIndex));
  }

  const segments = Array.isArray(loop.segments) ? loop.segments : Object.values(loop.segments || {});
  if (segments.length > 0) {
    segments.forEach((segmentData, index) => addSegment(segmentData, index));
  } else {
    addSegment({}, 0);
  }

  $mainBlock.find('button.sos-add-loop-segment').on('click', (ev) => {
    ev.preventDefault();
    addSegment();
    refreshUI();
  });

  $mainBlock.find('button.sos-remove-loop-segment').on('click', (ev) => {
    ev.preventDefault();
    $segmentsContainer.children().last().remove();
    refreshUI();
  });

  $mainBlock.on('click', '.sos-segment-header.collapsible', function (ev) {
    ev.preventDefault();
    const $header = $(this);
    const $content = $header.next('.sos-segment-content');
    const $icon = $header.find('.segment-toggle-icon');
    $content.slideToggle(200);
    $icon.toggleClass('fa-chevron-right fa-chevron-down');
  });

  $mainBlock.on('click', '.sos-segment-preview-buttons', function (ev) {
    ev.stopPropagation();
  });

  html.find(`input[name="${field("enabled")}"]`).on("change", (ev) => {
    const checked = ev.currentTarget.checked;
    html.find(".sos-loop-active-row, .sos-loop-body").toggle(checked);
  });

  const previewer = new LoopPreviewer(app, html, data);
  previewer.init();
  app._soundOfSilencePreviewer = previewer;

  const initialEnabled = loop.enabled ?? false;
  previewer.updateLoopEnabledState(initialEnabled);

  html.find(`input[name="${field("enabled")}"]`).on("change", (ev) => {
    const checked = ev.currentTarget.checked;
    html.find(".sos-loop-active-row, .sos-loop-body").toggle(checked);
    if (previewer?.updateLoopEnabledState) {
      previewer.updateLoopEnabledState(checked);
    }
  });

  refreshUI();

  // --- 4. FINAL Volume Normalization UI Logic ---
  const $volumeGroup = html.find('label:contains("Sound Volume")').parent();

  // This is the new, correct selector based on your screenshot.
  const $rangePicker = $volumeGroup.find('range-picker[name="volume"]');

  const $overrideCheckbox = html.find(`input[name="flags.${MODULE_ID}.allowVolumeOverride"]`);
  
  // This receives the correct data from the _prepareContext wrapper.
  const normEnabled = data.sosPlaylistFlags?.volumeNormalizationEnabled ?? false;

  // Create and append the informational message.
  const $infoMessage = $(`<p class="notes warning" style="flex-basis: 100%; text-align: center; margin-top: 4px;">Volume is managed by the playlist. To change, check Override Playlist Volume or disable normalization on the playlist.</p>`).hide();
  $volumeGroup.append($infoMessage);

  function updateVolumeControls() {
    const isOverridden = $overrideCheckbox.is(':checked');
    const shouldBeDisabled = normEnabled && !isOverridden;

    // To robustly disable a custom element, we apply CSS to make it non-interactive and appear disabled.
    $rangePicker.css({
        'opacity': shouldBeDisabled ? 0.5 : 1.0,
        'pointer-events': shouldBeDisabled ? 'none' : 'auto'
    });

    // Also toggle the informational message.
    $infoMessage.toggle(shouldBeDisabled);
  }

  // Set the initial state when the window opens.
  updateVolumeControls();

  // React instantly to the checkbox.
  $overrideCheckbox.on('change', updateVolumeControls);
});



Hooks.on("closePlaylistSoundConfig", (app) => {
  const previewer = app._soundOfSilencePreviewer;
  if (previewer?.stopAll) {
    debug("[Previewer] Config window closed. Calling stopAll.");
    previewer.stopAll();
  }
});