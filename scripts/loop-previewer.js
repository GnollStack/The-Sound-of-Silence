// loop-previewer.js

import { debug, toSec, formatTime, MODULE_ID, SEGMENT_COLORS, error } from "./utils.js";
import { equalPowerCrossfade } from "./audio-fader.js";

const LOOP_SEGMENT_LABEL_MAX_LENGTH = 48;
let nextPreviewerInstanceId = 0;

function defaultLoopSegmentLabel(index = 0) {
    const safeIndex = Number(index);
    return `Loop Segment ${Number.isFinite(safeIndex) && safeIndex >= 0 ? safeIndex + 1 : 1}`;
}

function sanitizeLoopSegmentLabel(value, index = 0) {
    const fallback = defaultLoopSegmentLabel(index);
    const text = String(value ?? "")
        .replace(/<[^>]*>/g, " ")
        .replace(/[<>]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, LOOP_SEGMENT_LABEL_MAX_LENGTH)
        .trim();
    return text || fallback;
}

export function getLoopSegmentDurationError(segment, duration, index = 0) {
    const trackDuration = Number(duration);
    if (!Number.isFinite(trackDuration) || trackDuration <= 0) return null;

    const startSec = Number(segment?.startSec);
    const endSec = Number(segment?.endSec);
    const crossfadeMs = Number(segment?.crossfadeMs);
    const prefix = `Segment ${index + 1}`;
    const epsilon = 0.001;

    if (Number.isFinite(startSec) && startSec >= trackDuration - epsilon) {
        return `${prefix}: Start must be before the end of the audio`;
    }
    if (Number.isFinite(endSec) && endSec > trackDuration + epsilon) {
        return `${prefix}: End exceeds the audio duration`;
    }
    if (
        Number.isFinite(startSec) &&
        Number.isFinite(endSec) &&
        Number.isFinite(crossfadeMs) &&
        crossfadeMs > Math.max(0, endSec - startSec) * 1000 + 1
    ) {
        return `${prefix}: Crossfade longer than segment`;
    }
    return null;
}

export class LoopPreviewer {
    constructor(app, html, data) {
        this.app = app;
        this.html = html;
        this.data = data;
        this.soundA = null;
        this.soundB = null;
        this.isA_Active = true;
        this.isPlaying = false;
        this.isPreviewingLoop = false;
        this.animationFrameId = null;
        this.timeoutIds = [];
        this.duration = 0;
        this.pausedTime = 0;
        this.segments = [];
        this.activeDrag = null;
        this.hasValidationError = false;
        this.loopEnabled = false;
        this._generation = 0;
        this._destroyed = false;
        this._dragNamespace = `.loopeditor${++nextPreviewerInstanceId}`;
        this._boundHandleMouseMove = this._onHandleMouseMove.bind(this);
        this._boundHandleMouseUp = this._onHandleMouseUp.bind(this);
    }

    async init() {
        debug("[Previewer] Initializing...");
        const generation = this._generation;
        if (!this._cacheDOM()) return;
        if (!(await this._loadAudioMetadata(generation))) return;
        if (!this._isCurrent(generation)) return;

        this.rescanSegments();
        this._attachGlobalListeners();
        this._updateVisuals();
        this.$timer.text(`${formatTime(0, false)} / ${formatTime(this.duration, false)}`);
    }

    _cacheDOM() {
        this.$editor = this.html.find(".sos-loop-editor");
        if (!this.$editor.length) return false;

        this.$container = this.$editor.find(".sos-loop-timeline-container");
        this.$fallback = this.$editor.find(".sos-loop-timeline-container-fallback");
        this.$playPauseBtn = this.$editor.find(".loop-play-pause");
        this.$playIcon = this.$playPauseBtn.find("i");
        this.$stopBtn = this.$editor.find(".loop-stop");
        this.$volumeSlider = this.$editor.find(".sos-loop-preview-volume");
        this.$progress = this.$container.find(".sos-loop-timeline-progress");
        this.$timer = this.$editor.find(".sos-loop-timer");
        this.$warningOverlay = this.$container.find(".sos-loop-timeline-warning-overlay");
        this.$updateBtn = this.html.closest(".app").find('button[type="submit"]');

        // Add error message element
        this.$errorMsg = this.$editor.find(".sos-loop-validation-error-msg");
        if (!this.$errorMsg.length) {
            this.$errorMsg = $('<div class="sos-loop-validation-error-msg"></div>');
            this.$container.before(this.$errorMsg);
        }

        return true;
    }

    _isCurrent(generation) {
        return !this._destroyed && generation === this._generation;
    }

    _stopSound(sound) {
        try {
            const result = sound?.stop?.();
            result?.catch?.(() => {});
        } catch (_) { }
    }

    async _loadAudioMetadata(generation = this._generation) {
        const audioPath = this.data.document.path;
        let sound = null;
        try {
            sound = new foundry.audio.Sound(audioPath);
            await sound.load();
            if (!this._isCurrent(generation)) {
                this._stopSound(sound);
                return false;
            }
            this.duration = sound.duration;
            debug(`[Previewer] Sound loaded. Duration: ${this.duration.toFixed(2)}s`);
        } catch (err) {
            if (!this._isCurrent(generation)) return false;
            this.$fallback.html(`<p class="error">Could not load audio file.</p>`).show();
            this.$editor.find(".sos-loop-buttons-row").hide();
            return false;
        }
        if (!this.duration) {
            this.$fallback.html(`<p class="error">Audio has no duration.</p>`).show();
            return false;
        }
        this.$fallback.hide();
        this.$editor.find(".sos-loop-buttons-row").css("display", "flex");
        return true;
    }

    rescanSegments() {
        debug("[Previewer] Rescanning segments from form.");
        this.segments = [];
        this.html.find('.sos-loop-segment-section').each((index, el) => {
            const $el = $(el);
            const segment = {
                index,
                color: SEGMENT_COLORS[index % SEGMENT_COLORS.length],
                $form: $el,
                $startInput: $el.find('input[name*=".start"]'),
                $endInput: $el.find('input[name*=".end"]'),
                $labelInput: $el.find('input[name*=".label"]'),
                $crossfadeInput: $el.find('input[name*=".crossfadeMs"]'),
                $loopCountInput: $el.find('input[name*=".loopCount"]'),
                $previewBtn: $el.find('button.sos-loop-preview-segment'),
                $previewPointBtn: $el.find('button.sos-loop-preview-point'),
                $stopBtn: $el.find('button.loop-stop')
            };
            this.segments.push(segment);
        });
        this._readSegmentsFromInputs();
        this._renderAllSegments();
        this._attachSegmentListeners();
    }

    _readSegmentsFromInputs() {
        this.segments.forEach(seg => {
            seg.label = sanitizeLoopSegmentLabel(seg.$labelInput.val(), seg.index);
            seg.startSec = toSec(seg.$startInput.val());
            seg.endSec = toSec(seg.$endInput.val());
            seg.crossfadeMs = Number(seg.$crossfadeInput.val()) || 0;
        });
        this._validateAllSegments();
    }

    _renderAllSegments() {
        this.$container.find(".sos-loop-timeline-selection, .sos-loop-timeline-handle, .sos-loop-timeline-crossfade").remove();

        this.segments.forEach(seg => {
            const startPct = (seg.startSec / this.duration) * 100;
            const endPct = (seg.endSec / this.duration) * 100;
            const widthPct = endPct - startPct;

            // Main segment bar
            seg.$selection = $(`<div class="sos-loop-timeline-selection"></div>`).css({
                left: `${startPct}%`,
                width: `${widthPct}%`,
                backgroundColor: seg.color
            }).appendTo(this.$container);

            // Crossfade indicator (darker shade, extends from end handle backwards)
            const crossfadeMs = Number(seg.$crossfadeInput?.val()) || 0;
            const segmentDurationMs = (seg.endSec - seg.startSec) * 1000;

            // The crossfade bar should always be sticky to the end bar.
            // So its right edge is always at endPct, and its width is proportional to crossfadeMs.
            // Calculate width in percent of timeline
            if (crossfadeMs > 0 && segmentDurationMs > 0) {
                const crossfadeWidthPct = (crossfadeMs / 1000 / this.duration) * 100;
                const crossfadeStartPct = Math.max(0, endPct - crossfadeWidthPct);
                // Create darker version of segment color
                const darkerColor = this._darkenColor(seg.color, 0.4);

                seg.$crossfade = $(`<div class="sos-loop-timeline-crossfade"></div>`).css({
                    left: `${crossfadeStartPct}%`,
                    width: `${Math.min(crossfadeWidthPct, endPct - startPct)}%`,
                    backgroundColor: darkerColor,
                    borderLeft: `1px solid ${darkerColor}`
                }).appendTo(this.$container);
            }

            // Start handle
            seg.$startHandle = $(`<div class="sos-loop-timeline-handle" data-handle="start"></div>`).css({
                left: `${startPct}%`,
                backgroundColor: seg.color
            }).appendTo(this.$container);

            // End handle
            seg.$endHandle = $(`<div class="sos-loop-timeline-handle" data-handle="end"></div>`).css({
                left: `${endPct}%`,
                backgroundColor: seg.color
            }).appendTo(this.$container);

            // Create the time tooltip element for this segment
            const midPct = (startPct + endPct) / 2;
            seg.$timeTooltip = $(`<div class="sos-loop-timeline-tooltip"></div>`).css({
                left: `${midPct}%`
            }).appendTo(this.$container);
        });

        // Render fade zones on top
        this._renderFadeZones();
    }

    // Show Users Playlist inherited Fade-ins and Fade-outs
    _renderFadeZones() {
        // Remove existing fade zones
        this.$container.find(".sos-loop-timeline-fadein, .sos-loop-timeline-fadeout").remove();

        // Get fade durations from the playlist
        const playlist = this.data.document.parent;
        if (!playlist) return;

        const fadeInMs = Number(playlist.getFlag('the-sound-of-silence', 'fadeIn')) || 0;
        const fadeOutMs = Number(playlist.fade) || 0;

        const fadeInSec = fadeInMs / 1000;
        const fadeOutSec = fadeOutMs / 1000;

        if (fadeInSec > 0) {
            const fadeInPct = (fadeInSec / this.duration) * 100;

            $(`<div class="sos-loop-timeline-fadein" data-tooltip="Fade-In Zone (${fadeInMs}ms)"></div>`).css({
                left: '0%',
                width: `${fadeInPct}%`
            }).appendTo(this.$container);
        }

        if (fadeOutSec > 0) {
            const fadeOutPct = (fadeOutSec / this.duration) * 100;
            const startPct = 100 - fadeOutPct;

            $(`<div class="sos-loop-timeline-fadeout" data-tooltip="Fade-Out Zone (${fadeOutMs}ms)"></div>`).css({
                left: `${startPct}%`,
                width: `${fadeOutPct}%`
            }).appendTo(this.$container);
        }
    }

    // new helper method to darken colors
    _darkenColor(hex, factor) {
        // Remove # if present
        hex = hex.replace('#', '');

        // Convert to RGB
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);

        // Darken by factor (0.0 = black, 1.0 = original)
        const newR = Math.round(r * factor);
        const newG = Math.round(g * factor);
        const newB = Math.round(b * factor);

        // Convert back to hex
        return `#${newR.toString(16).padStart(2, '0')}${newG.toString(16).padStart(2, '0')}${newB.toString(16).padStart(2, '0')}`;
    }

    _updateTooltip(segment, isVisible) {
        if (!segment?.$timeTooltip) return;

        if (isVisible) {
            const label = sanitizeLoopSegmentLabel(segment.label, segment.index);
            const text = `${label}: ${formatTime(segment.startSec, false)} - ${formatTime(segment.endSec, false)}`;
            const startPct = (segment.startSec / this.duration) * 100;
            const endPct = (segment.endSec / this.duration) * 100;
            const midPct = (startPct + endPct) / 2;

            segment.$timeTooltip.text(text).css('left', `${midPct}%`).addClass('visible');
        } else {
            segment.$timeTooltip.removeClass('visible');
        }
    }

    _attachGlobalListeners() {
        this.$playPauseBtn.off(".previewer").on("click.previewer", this._onPlayPause.bind(this));
        this.$stopBtn.off(".previewer").on("click.previewer", () => this.stopAll());
        this.$volumeSlider.off(".previewer").on("input.previewer change.previewer", () => this._applyPreviewVolume());
        this.$container.off(".previewer")
            .on("click.previewer", this._onTimelineClick.bind(this))
            .on("mousedown.previewer", ".sos-loop-timeline-handle", this._onHandleMouseDown.bind(this));
    }

    _getPreviewVolume() {
        const rawValue = this.$volumeSlider?.[0]?.value ?? this.$volumeSlider?.attr?.("value");
        const value = Number(rawValue);
        if (Number.isFinite(value)) return Math.max(0, Math.min(1, value));
        const documentVolume = Number(this.data?.document?.volume);
        return Number.isFinite(documentVolume) ? Math.max(0, Math.min(1, documentVolume)) : 1;
    }

    _applyPreviewVolume() {
        const volume = this._getPreviewVolume();
        if (this.soundA) this.soundA.volume = volume;
        if (this.soundB) this.soundB.volume = volume;
    }

    // Make sure _attachSegmentListeners re-render on crossfade input change
    _attachSegmentListeners() {
        this.segments.forEach(seg => {
            const inputs = seg.$startInput.add(seg.$endInput);
            inputs.off('.previewer').on('input.previewer wheel.previewer', this._onTimeInputChange.bind(this, seg));

            const hoverTargets = seg.$selection.add(seg.$startHandle).add(seg.$endHandle);
            hoverTargets.off('.previewer').on('mouseenter.previewer', () => {
                this._updateTooltip(seg, true);
            }).on('mouseleave.previewer', () => {
                // Don't hide if we are actively dragging this segment
                if (!this.activeDrag || this.activeDrag.segment !== seg) {
                    this._updateTooltip(seg, false);
                }
            });

            // Listen for crossfade changes to update visualization and validation
            seg.$crossfadeInput.off('.previewer').on('input.previewer', () => {
                this._readSegmentsFromInputs();
                this._renderAllSegments();
            });

            seg.$previewBtn.off('.previewer').on('click.previewer', () => this._onPreviewLoop(seg));

            // Add handler for loop point preview
            seg.$previewPointBtn.off('.previewer').on('click.previewer', () => this._onPreviewLoopPoint(seg));

            // Add handler for the segment-level stop button
            seg.$form.find('button.loop-stop').off('.previewer').on('click.previewer', () => {
                this.stopAll();
            });
        });
    }


    stopAll(resetVisuals = true) {
        this._generation++;
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
        this.timeoutIds.forEach(clearTimeout);
        this.timeoutIds = [];

        // Proper cleanup of sounds
        this._stopSound(this.soundA);
        this._stopSound(this.soundB);
        this.soundA = null;
        this.soundB = null;

        this.isPlaying = false;
        this.isPreviewingLoop = false;
        this.pausedTime = 0;
        this.$playIcon?.removeClass?.("fa-pause")?.addClass?.("fa-play");

        // Re-enable ALL buttons
        this.segments.forEach(s => {
            s.$previewBtn.prop('disabled', false);
            s.$previewPointBtn.prop('disabled', false);
        });

        // Reset the timer display
        this.$timer?.text?.(`${formatTime(0, false)} / ${formatTime(this.duration, false)}`);

        if (resetVisuals) this._updateVisuals();
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.stopAll();

        this.$playPauseBtn?.off?.(".previewer");
        this.$stopBtn?.off?.(".previewer");
        this.$volumeSlider?.off?.(".previewer");
        this.$container?.off?.(".previewer");
        this.segments.forEach((segment) => {
            segment.$startInput?.off?.(".previewer");
            segment.$endInput?.off?.(".previewer");
            segment.$crossfadeInput?.off?.(".previewer");
            segment.$previewBtn?.off?.(".previewer");
            segment.$previewPointBtn?.off?.(".previewer");
            segment.$form?.find?.("button.loop-stop")?.off?.(".previewer");
        });
        if (this.activeDrag?.animationFrame !== null && this.activeDrag?.animationFrame !== undefined) {
            cancelAnimationFrame(this.activeDrag.animationFrame);
        }
        this.activeDrag = null;
        if (typeof globalThis.$ === "function" && globalThis.document) {
            globalThis.$(globalThis.document).off(this._dragNamespace);
        }
    }

    _tick(generation = this._generation) {
        if (!this._isCurrent(generation) || !this.isPlaying) return;
        const activeSound = this.isA_Active ? this.soundA : this.soundB;
        if (activeSound) {
            this.$timer.text(`${formatTime(activeSound.currentTime, false)} / ${formatTime(this.duration, false)}`);
        }
        this._updateVisuals();
        this.animationFrameId = requestAnimationFrame(() => this._tick(generation));
    }

    _updateVisuals() {
        const activeSound = this.isA_Active ? this.soundA : this.soundB;
        if (activeSound && this.isPlaying) {
            const progressPct = (activeSound.currentTime / this.duration) * 100;
            this.$progress.css("width", `${progressPct}%`);
        } else {
            this.$progress.css("width", `0%`);
        }
    }

    _validateAllSegments() {
        if (!this.loopEnabled) {
            this.hasValidationError = false;
            this.$container.removeClass("validation-error");
            this.$warningOverlay.hide();

            let $submitBtn = $('form[id^="PlaylistSoundConfig-"] button[type="submit"]');
            if ($submitBtn.length) {
                $submitBtn.prop('disabled', false);
            }
            return;
        }

        // Get fade zones
        const playlist = this.data.document.parent;
        const fadeInSec = playlist ? (Number(playlist.getFlag('the-sound-of-silence', 'fadeIn')) || 0) / 1000 : 0;
        const fadeOutSec = playlist ? (Number(playlist.fade) || 0) / 1000 : 0;
        const fadeOutStart = this.duration - fadeOutSec;

        let hasError = false;
        let errorMessage = '';

        for (let i = 0; i < this.segments.length; i++) {
            const current = this.segments[i];

            // Basic validations
            if (current.endSec <= current.startSec) {
                hasError = true;
                errorMessage = `Segment ${i + 1}: End must be after start`;
                break;
            }

            const durationError = getLoopSegmentDurationError(current, this.duration, i);
            if (durationError) {
                hasError = true;
                errorMessage = durationError;
                break;
            }

            // Check crossfade duration
            if (current.crossfadeMs > 0) {
                const crossfadeSec = current.crossfadeMs / 1000;
                const segmentDuration = current.endSec - current.startSec;
                if (crossfadeSec > segmentDuration) {
                    hasError = true;
                    errorMessage = `Segment ${i + 1}: Crossfade longer than segment`;
                    break;
                }
            }

            // Check for fade zone conflicts - NOW TREATED AS ERRORS
            if (fadeInSec > 0 && current.startSec < fadeInSec) {
                hasError = true;
                errorMessage = `Segment ${i + 1}: Starts in fade-in zone`;
                break;
            }
            if (fadeOutSec > 0 && current.endSec > fadeOutStart) {
                hasError = true;
                errorMessage = `Segment ${i + 1}: Ends in fade-out zone`;
                break;
            }

            // Check overlaps
            for (let j = i + 1; j < this.segments.length; j++) {
                const other = this.segments[j];
                const overlapStart = Math.max(current.startSec, other.startSec);
                const overlapEnd = Math.min(current.endSec, other.endSec);
                if (overlapStart < overlapEnd) {
                    hasError = true;
                    errorMessage = `Segments ${i + 1} and ${j + 1} overlap`;
                    break;
                }
            }
            if (hasError) break;
        }

        // Log error message if present
        if (hasError && errorMessage) {
            debug(`[Previewer] ⚠️ Validation error: ${errorMessage}`);
        }

        this.hasValidationError = hasError;
        this.$container.toggleClass("validation-error", hasError);
        this.$warningOverlay.toggle(hasError);

        let $submitBtn = $('form[id^="PlaylistSoundConfig-"] button[type="submit"]');
        if ($submitBtn.length) {
            $submitBtn.prop('disabled', hasError);
        }

        if (hasError && errorMessage) {
            this.$errorMsg.text(errorMessage).show();
        } else {
            this.$errorMsg.hide();
        }
    }

    //  Update enabled state
    updateLoopEnabledState(enabled) {
        this.loopEnabled = !!enabled;
        debug(`[Previewer] Loop enabled state changed to: ${this.loopEnabled}`);
        this._validateAllSegments(); // Revalidate with new state
    }

    // _onHandleMouseMove to update crossfade during all drags
    // Make crossfade bar sticky to the end bar
    _onHandleMouseMove(ev) {
        if (!this.activeDrag) return;

        // Store the most recent mouse event
        this.activeDrag.latestEvent = ev;

        // If an animation frame is not already scheduled, schedule one.
        // This prevents scheduling more updates than the screen can render.
        if (this.activeDrag.animationFrame === null) {
            this.activeDrag.animationFrame = requestAnimationFrame(this._updateDragVisuals.bind(this));
        }
    }

    _onHandleMouseUp() {
        if (!this.activeDrag) return;

        // Hide the tooltip when dragging ends
        this._updateTooltip(this.activeDrag.segment, false);

        // Cancel any pending frame to prevent a final update after mouse up
        if (this.activeDrag.animationFrame !== null) {
            cancelAnimationFrame(this.activeDrag.animationFrame);
        }

        // Manually trigger one last visual update to ensure the final position is rendered
        this._updateDragVisuals();

        this.html.find(".sos-loop-timeline-handle.active").removeClass('active');

        // Log validation result only when drag completes
        const segment = this.activeDrag.segment;
        debug(`[Previewer] Drag complete for segment ${segment.index}: ${formatTime(segment.startSec, true)} - ${formatTime(segment.endSec, true)}`);

        this.activeDrag = null;
        $(document).off(this._dragNamespace);

        // Validate the final state ONCE at the end of the drag.
        this._validateAllSegments();
        if (this.hasValidationError) {
            debug(`[Previewer] ⚠️ Validation error detected - submit button disabled`);
        }
    }

    _onPlayPause() {
        if (this.isPreviewingLoop) return;
        const activeSound = this.isA_Active ? this.soundA : this.soundB;

        if (this.isPlaying) {
            // Pausing
            this.pausedTime = activeSound?.currentTime || 0;
            activeSound?.pause();
            this.isPlaying = false;
            this.$playIcon.removeClass("fa-pause").addClass("fa-play");
        } else {
            // Resuming - check if we have a paused position
            if (this.pausedTime > 0) {
                // Instead of calling play() on a paused sound, recreate it
                this._seekAndPlay(this.pausedTime);
                this.pausedTime = 0; // Clear paused state
            } else {
                // Starting from beginning
                this._seekAndPlay(0);
            }
        }
    }

    async _seekAndPlay(time) {
        this.stopAll();
        const generation = this._generation;
        if (!this._isCurrent(generation)) return;

        const sound = new foundry.audio.Sound(this.data.document.path);
        try {
            await sound.load();
            if (!this._isCurrent(generation)) {
                this._stopSound(sound);
                return;
            }

            this.soundA = sound;
            this.isA_Active = true;
            sound.addEventListener("end", () => this._onSoundEnd(generation), { once: true });
            await sound.play({ offset: time, volume: this._getPreviewVolume() });
            if (!this._isCurrent(generation)) {
                this._stopSound(sound);
                if (this.soundA === sound) this.soundA = null;
                return;
            }

            this.isPlaying = true;
            this.$playIcon.removeClass("fa-play").addClass("fa-pause");
            this._tick(generation);
        } catch (err) {
            this._stopSound(sound);
            if (!this._isCurrent(generation)) return;
            error("[Previewer] Error starting audio preview:", err);
            this.stopAll();
        }
    }

    _onSoundEnd(generation = this._generation) {
        if (!this._isCurrent(generation) || this.isPreviewingLoop) return;
        this.isPlaying = false;
        this.$playIcon.removeClass("fa-pause").addClass("fa-play");
        this._updateVisuals();
    };

    async _onPreviewLoop(segment) {
        this.stopAll(false);
        const generation = this._generation;
        if (!this._isCurrent(generation)) return;
        this.isPreviewingLoop = true;
        this.segments.forEach(s => s.$previewBtn.prop('disabled', true));

        const startSec = toSec(segment.$startInput.val());
        const endSec = toSec(segment.$endInput.val());
        const crossfadeMs = Number(segment.$crossfadeInput.val()) || 0;
        const label = sanitizeLoopSegmentLabel(segment.$labelInput.val(), segment.index);

        // Validate segment duration
        const segmentDuration = endSec - startSec;
        if (segmentDuration <= 0) {
            debug("[Previewer] Invalid segment duration");
            this.stopAll(true);
            return;
        }

        // Ensure crossfade isn't longer than segment
        const safeCrossfadeMs = Math.min(crossfadeMs, segmentDuration * 1000);

        const performCrossfade = async () => {
            if (!this._isCurrent(generation) || !this.isPreviewingLoop) return;

            let targetSound = null;
            try {
                const activeWasA = this.isA_Active;
                const sourceSound = activeWasA ? this.soundA : this.soundB;
                targetSound = activeWasA ? this.soundB : this.soundA;
                if (!sourceSound) return;

                if (!targetSound) {
                    const loadedTarget = new foundry.audio.Sound(this.data.document.path);
                    await loadedTarget.load();
                    if (!this._isCurrent(generation) || !this.isPreviewingLoop) {
                        this._stopSound(loadedTarget);
                        return;
                    }
                    targetSound = loadedTarget;
                    if (activeWasA) this.soundB = targetSound;
                    else this.soundA = targetSound;
                }

                // Use _fromLoop to bypass playlist fade effects
                const previewVolume = this._getPreviewVolume();
                await targetSound.play({ offset: startSec, volume: 0, _fromLoop: true });
                if (!this._isCurrent(generation) || !this.isPreviewingLoop) {
                    this._stopSound(targetSound);
                    return;
                }

                equalPowerCrossfade(sourceSound, targetSound, safeCrossfadeMs, { targetVolIn: previewVolume });

                this.timeoutIds.push(setTimeout(() => {
                    const activeSound = this.isA_Active ? this.soundA : this.soundB;
                    if (this._isCurrent(generation) && sourceSound !== activeSound) {
                        this._stopSound(sourceSound);
                    }
                }, safeCrossfadeMs + 100));

                this.isA_Active = !activeWasA;

                const loopDurationMs = (endSec - startSec) * 1000;
                const delayUntilNextFade = Math.max(50, loopDurationMs - safeCrossfadeMs);

                this.timeoutIds.push(setTimeout(() => {
                    if (this._isCurrent(generation)) void performCrossfade();
                }, delayUntilNextFade));
            } catch (err) {
                if (!this._isCurrent(generation)) {
                    this._stopSound(targetSound);
                    return;
                }
                error("[Previewer] Error during full loop preview:", err);
                this.stopAll(true);
            }
        };

        const initialSound = new foundry.audio.Sound(this.data.document.path);
        try {
            await initialSound.load();
            if (!this._isCurrent(generation) || !this.isPreviewingLoop) {
                this._stopSound(initialSound);
                return;
            }
            this.soundA = initialSound;
            this.isA_Active = true;

            await initialSound.play({ offset: startSec, volume: this._getPreviewVolume(), _fromLoop: true });
            if (!this._isCurrent(generation) || !this.isPreviewingLoop) {
                this._stopSound(initialSound);
                return;
            }
            this.isPlaying = true;
            this._tick(generation);

            const loopDurationMs = (endSec - startSec) * 1000;
            const delayUntilFirstFade = Math.max(50, loopDurationMs - safeCrossfadeMs);

            debug(`[Previewer] Starting preview loop "${label}". Segment: ${startSec}-${endSec}, Duration: ${loopDurationMs}ms, First fade in: ${delayUntilFirstFade}ms`);

            this.timeoutIds.push(setTimeout(() => {
                if (this._isCurrent(generation)) void performCrossfade();
            }, delayUntilFirstFade));
        } catch (err) {
            this._stopSound(initialSound);
            if (!this._isCurrent(generation)) return;
            error("[Previewer] Error starting full loop preview:", err);
            this.stopAll(true);
        }
    }

    /**
     * Previews just the loop transition point - plays 5 seconds before and after the crossfade
     */
    async _onPreviewLoopPoint(segment) {
        this.stopAll(false);
        const generation = this._generation;
        if (!this._isCurrent(generation)) return;
        this.isPreviewingLoop = true;

        // Disable all buttons during preview
        this.segments.forEach(s => {
            s.$previewBtn.prop('disabled', true);
            s.$previewPointBtn.prop('disabled', true);
        });

        const startSec = toSec(segment.$startInput.val());
        const endSec = toSec(segment.$endInput.val());
        const crossfadeMs = Number(segment.$crossfadeInput.val()) || 0;
        const label = sanitizeLoopSegmentLabel(segment.$labelInput.val(), segment.index);

        // Validate segment
        const segmentDuration = endSec - startSec;
        if (segmentDuration <= 0) {
            debug("[Previewer] Invalid segment duration");
            this.stopAll(true);
            return;
        }

        const PREVIEW_WINDOW = 3.0; // the amount in seconds window before and after Loop Segment in the loop preview
        const safeCrossfadeMs = Math.min(crossfadeMs, segmentDuration * 1000);
        const crossfadeSec = safeCrossfadeMs / 1000;

        // Calculate where the crossfade starts (end of segment minus crossfade duration)
        const crossfadeStartSec = endSec - crossfadeSec;

        // Play from PREVIEW_WINDOW seconds before the crossfade point
        const playFromSec = Math.max(startSec, crossfadeStartSec - PREVIEW_WINDOW);

        debug(`[Previewer] Preview loop point "${label}": playing from ${playFromSec.toFixed(2)}s, crossfade at ${crossfadeStartSec.toFixed(2)}s`);

        const initialSound = new foundry.audio.Sound(this.data.document.path);
        try {
            await initialSound.load();
            if (!this._isCurrent(generation) || !this.isPreviewingLoop) {
                this._stopSound(initialSound);
                return;
            }
            this.soundA = initialSound;
            this.isA_Active = true;

            await initialSound.play({ offset: playFromSec, volume: this._getPreviewVolume(), _fromLoop: true });
            if (!this._isCurrent(generation) || !this.isPreviewingLoop) {
                this._stopSound(initialSound);
                return;
            }
            this.isPlaying = true;
            this._tick(generation);

            // Schedule the crossfade at the right moment
            const delayUntilCrossfade = Math.max(0, (crossfadeStartSec - playFromSec) * 1000);

            debug(`[Previewer] Crossfade will trigger in ${delayUntilCrossfade}ms`);

            this.timeoutIds.push(setTimeout(async () => {
                if (!this._isCurrent(generation) || !this.isPreviewingLoop) return;

                debug("[Previewer] Triggering crossfade now");

                let targetSound = null;
                try {
                    const activeWasA = this.isA_Active;
                    const sourceSound = activeWasA ? this.soundA : this.soundB;
                    targetSound = activeWasA ? this.soundB : this.soundA;
                    if (!sourceSound) return;

                    if (!targetSound) {
                        const loadedTarget = new foundry.audio.Sound(this.data.document.path);
                        await loadedTarget.load();
                        if (!this._isCurrent(generation) || !this.isPreviewingLoop) {
                            this._stopSound(loadedTarget);
                            return;
                        }
                        targetSound = loadedTarget;
                        if (activeWasA) this.soundB = targetSound;
                        else this.soundA = targetSound;
                    }

                    const previewVolume = this._getPreviewVolume();
                    await targetSound.play({ offset: startSec, volume: 0, _fromLoop: true });
                    if (!this._isCurrent(generation) || !this.isPreviewingLoop) {
                        this._stopSound(targetSound);
                        return;
                    }

                    equalPowerCrossfade(sourceSound, targetSound, safeCrossfadeMs, { targetVolIn: previewVolume });

                    this.timeoutIds.push(setTimeout(() => {
                        if (this._isCurrent(generation)) this._stopSound(sourceSound);
                    }, safeCrossfadeMs + 100));

                    this.isA_Active = !activeWasA;

                    const stopDelayMs = safeCrossfadeMs + (PREVIEW_WINDOW * 1000);
                    debug(`[Previewer] Preview will stop in ${stopDelayMs}ms (crossfade ${safeCrossfadeMs}ms + preview ${PREVIEW_WINDOW * 1000}ms)`);

                    this.timeoutIds.push(setTimeout(() => {
                        if (!this._isCurrent(generation)) return;
                        debug("[Previewer] Preview complete, stopping");
                        this.stopAll(true);
                    }, stopDelayMs));
                } catch (err) {
                    this._stopSound(targetSound);
                    if (!this._isCurrent(generation)) return;
                    error("[Previewer] Error during loop point crossfade:", err);
                    this.stopAll(true);
                }

            }, delayUntilCrossfade));

        } catch (err) {
            this._stopSound(initialSound);
            if (!this._isCurrent(generation)) return;
            error("[Previewer] Error during loop point preview:", err);
            this.stopAll(true);
        }
    }

    _onTimelineClick(ev) {
        this.segments.forEach(s => this._updateTooltip(s, false));

        if ($(ev.target).hasClass("sos-loop-timeline-handle")) return;
        const rect = ev.currentTarget.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const percent = Math.max(0, Math.min(100, (x / rect.width) * 100));
        const seekTime = (percent / 100) * this.duration;
        this._seekAndPlay(seekTime);
    }

    _onHandleMouseDown(ev) {
        this.stopAll();
        const $handle = $(ev.currentTarget);
        $handle.addClass('active');
        for (const seg of this.segments) {
            if (seg.$startHandle[0] === $handle[0]) {
                this.activeDrag = { segment: seg, type: "start" };
                break;
            }
            if (seg.$endHandle[0] === $handle[0]) {
                this.activeDrag = { segment: seg, type: "end" };
                break;
            }
        }
        if (!this.activeDrag) return;
        // Show the tooltip when dragging starts
        this._updateTooltip(this.activeDrag.segment, true);
        // Add properties to track the animation frame and the latest event
        this.activeDrag.animationFrame = null;
        this.activeDrag.latestEvent = ev;

        const $document = $(document);
        $document.off(this._dragNamespace);
        $document.on(`mousemove${this._dragNamespace}`, this._boundHandleMouseMove);
        $document.on(`mouseup${this._dragNamespace}`, this._boundHandleMouseUp);
    }

    /**
 * Updates the visuals of a timeline drag operation.
 * This is called inside a requestAnimationFrame callback for performance.
 * @private
 */
    _updateDragVisuals() {
        if (!this.activeDrag) return;

        const { segment, type, latestEvent } = this.activeDrag;
        const rect = this.$container[0].getBoundingClientRect();
        const x = latestEvent.clientX - rect.left;
        const percent = Math.max(0, Math.min(100, (x / rect.width) * 100));
        let newTimeSec = (percent / 100) * this.duration;

        // Round to whole seconds for dragging
        newTimeSec = Math.round(newTimeSec);

        if (type === "start") {
            segment.startSec = newTimeSec;
        } else {
            segment.endSec = newTimeSec;
        }

        segment.$startInput.val(formatTime(segment.startSec, true));
        segment.$endInput.val(formatTime(segment.endSec, true));

        const startPct = (segment.startSec / this.duration) * 100;
        const endPct = (segment.endSec / this.duration) * 100;
        const widthPct = endPct - startPct;

        segment.$startHandle.css("left", `${startPct}%`);
        segment.$endHandle.css("left", `${endPct}%`);
        segment.$selection.css({ left: `${startPct}%`, width: `${widthPct}%` });

        // Update the tooltip's text and position during the drag
        this._updateTooltip(segment, true);

        // Update crossfade bar
        const crossfadeMs = Number(segment.$crossfadeInput?.val()) || 0;
        if (segment.$crossfade && crossfadeMs > 0) {
            const crossfadeWidthPct = (crossfadeMs / 1000 / this.duration) * 100;
            const crossfadeStartPct = Math.max(0, endPct - crossfadeWidthPct);
            segment.$crossfade.css({
                left: `${crossfadeStartPct}%`,
                width: `${Math.min(crossfadeWidthPct, widthPct)}%`
            });
        }

        // Allow the next animation frame to be scheduled
        this.activeDrag.animationFrame = null;
    }

    _onTimeInputChange(segment, event) {

        this.segments.forEach(s => this._updateTooltip(s, false));

        if (event.type === 'wheel') {
            event.preventDefault();
            event.stopPropagation();

            const input = $(event.currentTarget);
            let currentSec = toSec(input.val());

            // Robust direction: wheel down = +deltaY, wheel up = -deltaY
            const dir = Math.sign(-event.originalEvent.deltaY) || 0; // up=+1, down=-1

            // Step sizes: default 1s, Ctrl = 0.1s (fine), Shift = 5s (coarse)
            const step =
                event.ctrlKey ? 0.1 :
                    event.shiftKey ? 5.0 :
                        1.0;

            let next = currentSec + dir * step;

            // Clamp within track
            const max = this.duration || Number.MAX_SAFE_INTEGER;
            next = Math.min(Math.max(0, next), max);

            input.val(formatTime(next, true));
        }

        // For BOTH wheel and input events, re-read and redraw
        this._readSegmentsFromInputs();
        this._renderAllSegments();

        this._attachSegmentListeners();
    }

}
