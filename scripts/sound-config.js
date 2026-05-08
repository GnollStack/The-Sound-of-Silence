// sound-config.js

import { LoopPreviewer } from "./loop-previewer.js";
import { ProceduralAuditioner } from "./procedural-auditioner.js";
import { debug, MODULE_ID, toSec, SEGMENT_COLORS, warn, error } from "./utils.js";
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

const PROCEDURAL_FIELD_DEFAULTS = {
  minDelay: 15,
  maxDelay: 60,
  timingMode: "uniform",
  initialFireMode: "normal",
  volumeVariance: 0,
  randomPan: false,
  playChance: 100,
};

function sanitizeProceduralTimingMode(value) {
  return Object.prototype.hasOwnProperty.call(PROCEDURAL_TIMING_OPTIONS, value) ? value : "uniform";
}

function sanitizeProceduralInitialFireMode(value) {
  return Object.prototype.hasOwnProperty.call(PROCEDURAL_INITIAL_FIRE_OPTIONS, value) ? value : "normal";
}

function getAverageProceduralGapSeconds({ minDelay, maxDelay, timingMode }) {
  return timingMode === "fixed" ? minDelay : (minDelay + maxDelay) / 2;
}

function formatProceduralNumber(value, digits = 1) {
  return Number.isInteger(value) ? `${value}` : value.toFixed(digits);
}



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
        const existingModuleFlags = existingFlags ?? {};
        const playlistDefaults = this.document.parent
          ? Flags.getPlaylistFlag(this.document.parent, "soundscapeDefaults") ?? {}
          : {};
        const hasExplicitProceduralFlag = (key) => {
          const value = existingModuleFlags[key];
          return value !== null && typeof value !== "undefined";
        };
        const inheritedProceduralValue = (key) => {
          const value = playlistDefaults[key];
          return value !== null && typeof value !== "undefined"
            ? value
            : PROCEDURAL_FIELD_DEFAULTS[key];
        };
        const valuesEqual = (a, b) => {
          if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
          return a === b;
        };
        const setOptionalProceduralFlag = (target, key, value) => {
          if (hasExplicitProceduralFlag(key) || !valuesEqual(value, inheritedProceduralValue(key))) {
            target[key] = value;
          }
        };

        debug("[SoS Debug] 2. Reconstructed segments (Map):", Array.from(segments.entries()));
        debug("[SoS Debug] 2b. Other flags:", foundry.utils.deepClone(otherFlags));

        // 2. Build clean, validated flags
        const isProcedural = !!otherFlags.isProcedural;

        // Swap min/max if inverted; clamp to schema range.
        let minDelay = Number(otherFlags.minDelay);
        let maxDelay = Number(otherFlags.maxDelay);
        if (!Number.isFinite(minDelay)) minDelay = 15;
        if (!Number.isFinite(maxDelay)) maxDelay = 60;
        if (maxDelay < minDelay) [minDelay, maxDelay] = [maxDelay, minDelay];
        minDelay = Math.max(0, Math.min(3600, minDelay));
        maxDelay = Math.max(0, Math.min(3600, maxDelay));

        let volumeVariance = Number(otherFlags.volumeVariance);
        if (!Number.isFinite(volumeVariance)) volumeVariance = 0;
        volumeVariance = Math.max(0, Math.min(1, volumeVariance));

        let playChance = Number(otherFlags.playChance);
        if (!Number.isFinite(playChance)) playChance = 100;
        playChance = Math.max(0, Math.min(100, playChance));

        const timingMode = sanitizeProceduralTimingMode(otherFlags.timingMode);
        const initialFireMode = sanitizeProceduralInitialFireMode(otherFlags.initialFireMode);

        const cleanRootFlags = {
          allowVolumeOverride: !!otherFlags.allowVolumeOverride,
          isProcedural,
        };
        setOptionalProceduralFlag(cleanRootFlags, "minDelay", minDelay);
        setOptionalProceduralFlag(cleanRootFlags, "maxDelay", maxDelay);
        setOptionalProceduralFlag(cleanRootFlags, "timingMode", timingMode);
        setOptionalProceduralFlag(cleanRootFlags, "initialFireMode", initialFireMode);
        setOptionalProceduralFlag(cleanRootFlags, "volumeVariance", volumeVariance);
        setOptionalProceduralFlag(cleanRootFlags, "randomPan", !!otherFlags.randomPan);
        setOptionalProceduralFlag(cleanRootFlags, "playChance", playChance);

        // Procedural and internal-loop are mutually exclusive per track.
        const loopEnabled = !!loopData.enabled && !isProcedural;
        const cleanLoopFlags = {
          enabled: loopEnabled,
          active: !!loopData.active && loopEnabled,
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
        error("[SoundConfig] Critical error in form data processing:", err);
        try {
          if (existingFlags) {
            warn("[SoundConfig] Recovery Level 1: Restoring previous flag data");
            for (const key of Object.keys(formData.object)) {
              if (key.startsWith(modulePath)) delete formData.object[key];
            }
            foundry.utils.setProperty(formData.object, modulePath, existingFlags);
          } else { throw new Error("No previous flags available"); }
        } catch (recoveryErr) {
          error("[SoundConfig] Recovery Level 1 failed:", recoveryErr);
          warn("[SoundConfig] Recovery Level 2: Using default values");
          try {
            for (const key of Object.keys(formData.object)) {
              if (key.startsWith(modulePath)) delete formData.object[key];
            }
            foundry.utils.setProperty(formData.object, modulePath, {
              allowVolumeOverride: false,
              [LOOP_KEY]: foundry.utils.duplicate(DEFAULTS)
            });
          } catch (finalErr) {
            error("[SoundConfig] Recovery Level 2 failed:", finalErr);
            warn("[SoundConfig] Recovery Level 3: Restoring entire original form data");
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
    error("[SoundConfig] Failed to create segment HTML:", err);
    return $(`<div class="sos-loop-segment-section error sos-compact">
      <p class="error-text">Error rendering segment ${index + 1}. Please remove and re-add.</p>
    </div>`);
  }
}


Hooks.on("renderPlaylistSoundConfig", (app, htmlRaw, data) => {
  const html = htmlRaw instanceof HTMLElement ? $(htmlRaw) : htmlRaw;
  const loop = data.loopWithin ?? Flags.getLoopConfig(app.document);
  const allowVolumeOverride = Flags.getSoundFlag(app.document, "allowVolumeOverride");
  const documentVolume = Number(app.document.volume);
  const previewVolume = Number.isFinite(documentVolume)
    ? Math.max(0, Math.min(1, documentVolume))
    : 1;
  const resolvedTargetVolume = Number(Flags.resolveTargetVolume(app.document));
  const auditionVolume = Number.isFinite(resolvedTargetVolume)
    ? Math.max(0, Math.min(1, resolvedTargetVolume))
    : previewVolume;
  const field = (k) => `flags.${MODULE_ID}.${LOOP_KEY}.${k}`;
  const rootField = (k) => `flags.${MODULE_ID}.${k}`;

  // Procedural / soundscape per-sound flags.
  const isProcedural = Flags.getSoundFlag(app.document, "isProcedural");
  const minDelay = Flags.resolveProceduralField(app.document, "minDelay");
  const maxDelay = Flags.resolveProceduralField(app.document, "maxDelay");
  const timingMode = Flags.resolveProceduralField(app.document, "timingMode");
  const initialFireMode = Flags.resolveProceduralField(app.document, "initialFireMode");
  const volumeVariance = Flags.resolveProceduralField(app.document, "volumeVariance");
  const randomPan = Flags.resolveProceduralField(app.document, "randomPan");
  const playChance = Flags.resolveProceduralField(app.document, "playChance");

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

  // Procedural one-shot block (Soundscape Mode opt-in per sound).
  const avgSec = Math.round(((Number(minDelay) || 0) + (Number(maxDelay) || 0)) / 2);
  const $proceduralBlock = $(/* html */`
    <div class="sos-procedural-config">
      <div class="form-group sos-compact">
        <label class="checkbox sos-feature-toggle">
          <input type="checkbox" name="${rootField("isProcedural")}" ${isProcedural ? "checked" : ""}>
          <span class="sos-feature-label">Procedural One-Shot</span>
        </label>
        <p class="notes sos-compact">Fires on client-local timers when this playlist is in Soundscape Mode. Delays are measured after each fire ends. Mutually exclusive with Internal Loop.</p>
      </div>
      <div class="sos-procedural-body sos-subsection" style="display: ${isProcedural ? "block" : "none"};">

        <fieldset class="sos-procedural-fieldset">
          <legend>Timing</legend>
          <div class="form-group sos-compact sos-two-column">
            <div class="sos-column">
              <label>Cadence Mode</label>
              <select class="sos-proc-timing-mode" name="${rootField("timingMode")}">
                ${Object.entries(PROCEDURAL_TIMING_OPTIONS).map(([value, label]) =>
                  `<option value="${value}" ${timingMode === value ? "selected" : ""}>${label}</option>`
                ).join("")}
              </select>
              <p class="notes sos-compact">How the gap is picked after each fire ends.</p>
            </div>
            <div class="sos-column">
              <label>First Fire</label>
              <select class="sos-proc-initial-mode" name="${rootField("initialFireMode")}">
                ${Object.entries(PROCEDURAL_INITIAL_FIRE_OPTIONS).map(([value, label]) =>
                  `<option value="${value}" ${initialFireMode === value ? "selected" : ""}>${label}</option>`
                ).join("")}
              </select>
              <p class="notes sos-compact">Only affects the first fire after activation; later fires use the cadence mode above.</p>
            </div>
          </div>
          <div class="form-group sos-compact sos-two-column">
            <div class="sos-column">
              <label>Min Gap <span class="sos-label-units">(s)</span></label>
              <input type="number" class="sos-proc-min" name="${rootField("minDelay")}" value="${minDelay}" step="1" min="0" max="3600">
            </div>
            <div class="sos-column">
              <label>Max Gap <span class="sos-label-units">(s)</span></label>
              <input type="number" class="sos-proc-max" name="${rootField("maxDelay")}" value="${maxDelay}" step="1" min="0" max="3600">
            </div>
          </div>
          <p class="notes sos-compact sos-proc-delay-preview">~<span class="sos-proc-min-readout">${minDelay}</span>–<span class="sos-proc-max-readout">${maxDelay}</span>s between fires (avg ~<span class="sos-proc-avg-readout">${avgSec}</span>s).</p>
          <p class="notes sos-compact sos-proc-rate-preview"></p>
          <p class="notes sos-compact sos-proc-startup-preview"></p>
        </fieldset>

        <fieldset class="sos-procedural-fieldset">
          <legend>Variation</legend>
          <div class="form-group sos-compact sos-two-column">
            <div class="sos-column">
              <label>Volume Variance <span class="sos-label-units">(0–1)</span></label>
              <input type="number" class="sos-proc-variance" name="${rootField("volumeVariance")}" value="${volumeVariance}" step="0.05" min="0" max="1">
              <p class="notes sos-compact">Fraction of target volume to jitter per fire. 0 = no variation.</p>
            </div>
            <div class="sos-column">
              <label>Play Chance <span class="sos-label-units">(%)</span></label>
              <input type="number" class="sos-proc-chance" name="${rootField("playChance")}" value="${playChance}" step="1" min="0" max="100">
              <p class="notes sos-compact">Probability each fire actually plays; skipped fires re-arm.</p>
            </div>
          </div>
          <div class="form-group sos-compact">
            <label class="checkbox sos-compact-checkbox">
              <input type="checkbox" name="${rootField("randomPan")}" ${randomPan ? "checked" : ""}>
              <span>Random Stereo Pan</span>
            </label>
            <p class="notes sos-compact">Places each fire at a random point in the stereo field.</p>
          </div>
        </fieldset>

        ${game.user.isGM ? `
        <fieldset class="sos-procedural-fieldset sos-proc-audition">
          <legend>Audition</legend>
          <div class="sos-proc-audition-row">
            <button type="button" class="sos-proc-audition-fire sos-compact" data-tooltip="Fire Local Preview">
              <i class="fa-solid fa-bolt"></i>
            </button>
            <button type="button" class="sos-proc-audition-stop sos-compact" data-tooltip="Stop Preview" disabled>
              <i class="fas fa-stop"></i>
            </button>
            <div class="sos-proc-audition-volume-wrap" data-tooltip="Preview Volume">
              <i class="fa-solid fa-volume-low" inert></i>
              <range-picker class="sos-proc-audition-volume"
                            value="${auditionVolume}"
                            min="0" max="1" step="0.05">
              </range-picker>
            </div>
            <span class="sos-proc-audition-status">Ready</span>
          </div>
          <p class="notes sos-compact">Local GM preview only. Uses unsaved variation and pan fields, bypasses play chance, and does not start the playlist.</p>
        </fieldset>
        ` : ""}

      </div>
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
              <div class="sos-loop-preview-volume-wrap" data-tooltip="Preview Volume">
                <i class="fa-solid fa-volume-low" inert></i>
                <range-picker class="sos-loop-preview-volume"
                              value="${previewVolume}"
                              min="0" max="1" step="0.05">
                </range-picker>
              </div>
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

  // Inject the procedural block *after* the "Fade Duration" group, before the internal loop block.
  if ($fadeGroup.length) {
    $fadeGroup.after($proceduralBlock);
  }

  // Inject the main module block *after* the procedural block.
  $proceduralBlock.after($mainBlock);

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

  app._soundOfSilenceProceduralAuditioner?.destroy?.();
  app._soundOfSilenceProceduralAuditioner = null;
  const auditioner = new ProceduralAuditioner(app, html, data);
  if (auditioner.init()) {
    app._soundOfSilenceProceduralAuditioner = auditioner;
  }

  const initialEnabled = loop.enabled ?? false;
  previewer.updateLoopEnabledState(initialEnabled);

  html.find(`input[name="${field("enabled")}"]`).on("change", (ev) => {
    const checked = ev.currentTarget.checked;
    html.find(".sos-loop-active-row, .sos-loop-body").toggle(checked);
    if (previewer?.updateLoopEnabledState) {
      previewer.updateLoopEnabledState(checked);
    }
  });

  // Procedural <-> Internal Loop mutual exclusivity.
  const $proceduralCheckbox = $proceduralBlock.find(`input[name="${rootField("isProcedural")}"]`);
  const $loopEnabledCheckbox = $mainBlock.find(`input[name="${field("enabled")}"]`);
  const $proceduralBody = $proceduralBlock.find(".sos-procedural-body");

  function syncProceduralExclusivity() {
    const procOn = $proceduralCheckbox.is(":checked");
    $proceduralBody.toggle(procOn);
    // Hide the whole internal-loop block when procedural is on.
    $mainBlock.toggle(!procOn);
    const proceduralAuditioner = app._soundOfSilenceProceduralAuditioner;
    if (!procOn && (proceduralAuditioner?.sound || proceduralAuditioner?.isLoading)) {
      proceduralAuditioner.stopAll();
    }
    if (procOn && $loopEnabledCheckbox.is(":checked")) {
      $loopEnabledCheckbox.prop("checked", false).trigger("change");
    }
  }
  syncProceduralExclusivity();
  $proceduralCheckbox.on("change", syncProceduralExclusivity);

  // Clamp min/max delay inputs when edited, keep the preview readout live.
  const $minDelay = $proceduralBlock.find(`input[name="${rootField("minDelay")}"]`);
  const $maxDelay = $proceduralBlock.find(`input[name="${rootField("maxDelay")}"]`);
  const $timingMode = $proceduralBlock.find(`select[name="${rootField("timingMode")}"]`);
  const $initialFireMode = $proceduralBlock.find(`select[name="${rootField("initialFireMode")}"]`);
  const $playChanceInput = $proceduralBlock.find(`input[name="${rootField("playChance")}"]`);
  const $minReadout = $proceduralBlock.find(".sos-proc-min-readout");
  const $maxReadout = $proceduralBlock.find(".sos-proc-max-readout");
  const $avgReadout = $proceduralBlock.find(".sos-proc-avg-readout");
  const $ratePreview = $proceduralBlock.find(".sos-proc-rate-preview");
  const $startupPreview = $proceduralBlock.find(".sos-proc-startup-preview");
  const clipDurationSec = Number(app.document.sound?.duration);
  const hasClipDuration = Number.isFinite(clipDurationSec) && clipDurationSec > 0;

  function refreshProcPreview() {
    const min = Number($minDelay.val()) || 0;
    const max = Number($maxDelay.val()) || 0;
    const chance = Math.max(0, Math.min(100, Number($playChanceInput.val()) || 0));
    const timing = sanitizeProceduralTimingMode($timingMode.val());
    const initial = sanitizeProceduralInitialFireMode($initialFireMode.val());
    const avgGapSec = getAverageProceduralGapSeconds({
      minDelay: min,
      maxDelay: max,
      timingMode: timing,
    });
    const avgCycleSec = avgGapSec + ((chance / 100) * (hasClipDuration ? clipDurationSec : 0));
    const attemptsPerMinute = avgCycleSec > 0 ? 60 / avgCycleSec : 0;
    const playsPerMinute = attemptsPerMinute * (chance / 100);

    $minReadout.text(formatProceduralNumber(min, 0));
    $maxReadout.text(formatProceduralNumber(max, 0));
    $avgReadout.text(formatProceduralNumber(avgGapSec));

    const $delayPreview = $proceduralBlock.find(".sos-proc-delay-preview");
    if (timing === "fixed") {
      $delayPreview.html(
        `Fixed cadence after each fire ends: ` +
        `<span class="sos-proc-min-readout">${formatProceduralNumber(min, 0)}</span>s.`
      );
    } else {
      const label = timing === "natural" ? "Natural gap after each fire ends" : "Uniform random gap after each fire ends";
      $delayPreview.html(
        `${label}: ` +
        `<span class="sos-proc-min-readout">${formatProceduralNumber(min, 0)}</span>&ndash;` +
        `<span class="sos-proc-max-readout">${formatProceduralNumber(max, 0)}</span>s ` +
        `(avg ~<span class="sos-proc-avg-readout">${formatProceduralNumber(avgGapSec)}</span>s).`
      );
    }

    const rateLine = chance <= 0
      ? `Approx. 0 plays/minute at 0% chance.`
      : `Approx. ${formatProceduralNumber(playsPerMinute)} plays/minute ` +
        `at ${formatProceduralNumber(chance, 0)}% chance ` +
        `(about ${formatProceduralNumber(attemptsPerMinute)} fire attempts/minute).`;
    const durationNote = hasClipDuration
      ? ` Includes the loaded ~${formatProceduralNumber(clipDurationSec)}s clip duration in the estimate.`
      : ` Gap-only estimate until the clip duration is loaded.`;
    $ratePreview.text(`${rateLine}${durationNote} Ignores polyphony limits and dynamic chance scaling.`);

    const startupLine = initial === "staggered"
      ? `First fire is staggered across active procedurals to reduce startup clustering.`
      : initial === "immediate"
        ? `First fire can happen immediately on activation.`
        : `First fire uses the same cadence rules as later fires.`;
    $startupPreview.text(startupLine);
  }

  $minDelay.on("input", refreshProcPreview);
  $maxDelay.on("input", refreshProcPreview);
  $timingMode.on("change", refreshProcPreview);
  $initialFireMode.on("change", refreshProcPreview);
  $playChanceInput.on("input", refreshProcPreview);

  $minDelay.on("change", () => {
    if (Number($minDelay.val()) > Number($maxDelay.val())) {
      $maxDelay.val($minDelay.val());
      ui.notifications?.info("Min delay exceeded max — max raised to match.");
    }
    refreshProcPreview();
  });
  $maxDelay.on("change", () => {
    if (Number($maxDelay.val()) < Number($minDelay.val())) {
      $minDelay.val($maxDelay.val());
      ui.notifications?.info("Max delay below min — min lowered to match.");
    }
    refreshProcPreview();
  });

  refreshUI();
  refreshProcPreview();

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

  const auditioner = app._soundOfSilenceProceduralAuditioner;
  if (auditioner?.destroy) {
    debug("[Auditioner] Config window closed. Destroying procedural auditioner.");
    auditioner.destroy();
    app._soundOfSilenceProceduralAuditioner = null;
  }
});
