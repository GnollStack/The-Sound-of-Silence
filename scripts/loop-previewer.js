// loop-previewer.js

import { debug, toSec, formatTime, MODULE_ID, SEGMENT_COLORS } from "./utils.js";
import { equalPowerCrossfade } from "./audio-fader.js";

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
    }

    async init() {
        debug("[Previewer] Initializing...");
        if (!this._cacheDOM()) return;
        if (!(await this._loadAudioMetadata())) return;

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

    async _loadAudioMetadata() {
        const audioPath = this.data.document.path;
        try {
            const sound = new foundry.audio.Sound(audioPath);
            await sound.load();
            this.duration = sound.duration;
            debug(`[Previewer] Sound loaded. Duration: ${this.duration.toFixed(2)}s`);
        } catch (err) {
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
            seg.startSec = toSec(seg.$startInput.val());
            seg.endSec = toSec(seg.$endInput.val());
            seg.crossfadeMs = Number(seg.$crossfadeInput.val()) ?? 0;
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
            const crossfadeMs = Number(seg.$crossfadeInput?.val()) ?? 0;
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
            const text = `${formatTime(segment.startSec, false)} - ${formatTime(segment.endSec, false)}`;
            const startPct = (segment.startSec / this.duration) * 100;
            const endPct = (segment.endSec / this.duration) * 100;
            const midPct = (startPct + endPct) / 2;

            segment.$timeTooltip.text(text).css('left', `${midPct}%`).addClass('visible');
        } else {
            segment.$timeTooltip.removeClass('visible');
        }
    }

    _attachGlobalListeners() {
        this.$playPauseBtn.on("click", this._onPlayPause.bind(this));
        this.$stopBtn.on("click", () => this.stopAll());
        this.$container.on("click", this._onTimelineClick.bind(this));
        this.$container.on("mousedown", ".sos-loop-timeline-handle", this._onHandleMouseDown.bind(this));
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
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
        this.timeoutIds.forEach(clearTimeout);
        this.timeoutIds = [];

        // Proper cleanup of sounds
        try { this.soundA?.stop(); } catch (_) { }
        try { this.soundB?.stop(); } catch (_) { }
        this.soundA = null;
        this.soundB = null;

        this.isPlaying = false;
        this.isPreviewingLoop = false;
        this.$playIcon.removeClass("fa-pause").addClass("fa-play");

        // Re-enable ALL buttons
        this.segments.forEach(s => {
            s.$previewBtn.prop('disabled', false);
            s.$previewPointBtn.prop('disabled', false);
        });

        // Reset the timer display
        this.$timer.text(`${formatTime(0, false)} / ${formatTime(this.duration, false)}`);

        if (resetVisuals) this._updateVisuals();
    }

    _tick() {
        if (!this.isPlaying) return;
        const activeSound = this.isA_Active ? this.soundA : this.soundB;
        if (activeSound) {
            this.$timer.text(`${formatTime(activeSound.currentTime, false)} / ${formatTime(this.duration, false)}`);
        }
        this._updateVisuals();
        this.animationFrameId = requestAnimationFrame(this._tick.bind(this));
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
        if (this.activeDrag.animationFrame) {
            cancelAnimationFrame(this.activeDrag.animationFrame);
        }

        // Manually trigger one last visual update to ensure the final position is rendered
        this._updateDragVisuals();

        this.html.find(".sos-loop-timeline-handle.active").removeClass('active');

        // Log validation result only when drag completes
        const segment = this.activeDrag.segment;
        debug(`[Previewer] Drag complete for segment ${segment.index}: ${formatTime(segment.startSec, true)} - ${formatTime(segment.endSec, true)}`);

        this.activeDrag = null;
        $(document).off(".loopeditor");

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
        this.soundA = new foundry.audio.Sound(this.data.document.path);
        await this.soundA.load();
        this.soundA.addEventListener("end", this._onSoundEnd.bind(this), { once: true });
        this.soundA.play({ offset: time });
        this.isA_Active = true;
        this.isPlaying = true;
        this.$playIcon.removeClass("fa-play").addClass("fa-pause");
        this._tick();
    }

    _onSoundEnd() {
        if (this.isPreviewingLoop) return;
        this.isPlaying = false;
        this.$playIcon.removeClass("fa-pause").addClass("fa-play");
        this._updateVisuals();
    };

    async _onPreviewLoop(segment) {
        this.stopAll(false);
        this.isPreviewingLoop = true;
        this.segments.forEach(s => s.$previewBtn.prop('disabled', true));

        const startSec = toSec(segment.$startInput.val());
        const endSec = toSec(segment.$endInput.val());
        const crossfadeMs = Number(segment.$crossfadeInput.val()) ?? 0;

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
            if (!this.isPreviewingLoop) return;

            const sourceSound = this.isA_Active ? this.soundA : this.soundB;
            let targetSound = this.isA_Active ? this.soundB : this.soundA;

            if (!targetSound) {
                targetSound = new foundry.audio.Sound(this.data.document.path);
                await targetSound.load();
                if (this.isA_Active) this.soundB = targetSound;
                else this.soundA = targetSound;
            }

            // Use _fromLoop to bypass playlist fade effects
            await targetSound.play({ offset: startSec, volume: 0, _fromLoop: true });

            // Import the crossfade function
            const { equalPowerCrossfade } = await import('./audio-fader.js');
            equalPowerCrossfade(sourceSound, targetSound, safeCrossfadeMs);

            this.timeoutIds.push(setTimeout(() => {
                try { sourceSound.stop(); } catch (_) { }
            }, safeCrossfadeMs + 100));

            this.isA_Active = !this.isA_Active;

            const loopDurationMs = (endSec - startSec) * 1000;
            const delayUntilNextFade = Math.max(50, loopDurationMs - safeCrossfadeMs);

            this.timeoutIds.push(setTimeout(performCrossfade, delayUntilNextFade));
        };

        // Create sound and start playing
        this.soundA = new foundry.audio.Sound(this.data.document.path);
        await this.soundA.load();
        this.isA_Active = true;

        // Start playing
        await this.soundA.play({ offset: startSec, _fromLoop: true });
        this.isPlaying = true;
        this._tick();

        // Calculate when to start the first crossfade
        const loopDurationMs = (endSec - startSec) * 1000;
        const delayUntilFirstFade = Math.max(50, loopDurationMs - safeCrossfadeMs);

        debug(`[Previewer] Starting preview loop. Segment: ${startSec}-${endSec}, Duration: ${loopDurationMs}ms, First fade in: ${delayUntilFirstFade}ms`);

        this.timeoutIds.push(setTimeout(performCrossfade, delayUntilFirstFade));
    }

    /**
     * Previews just the loop transition point - plays 5 seconds before and after the crossfade
     */
    async _onPreviewLoopPoint(segment) {
        this.stopAll(false);
        this.isPreviewingLoop = true;

        // Disable all buttons during preview
        this.segments.forEach(s => {
            s.$previewBtn.prop('disabled', true);
            s.$previewPointBtn.prop('disabled', true);
        });

        const startSec = toSec(segment.$startInput.val());
        const endSec = toSec(segment.$endInput.val());
        const crossfadeMs = Number(segment.$crossfadeInput.val()) ?? 0;

        // Validate segment
        const segmentDuration = endSec - startSec;
        if (segmentDuration <= 0) {
            debug("[Previewer] Invalid segment duration");
            this.stopAll(true);
            return;
        }

        const PREVIEW_WINDOW = 3.0; // the amount in seconds window before and after Loop Segment in the loop preview
        const crossfadeSec = crossfadeMs / 1000;

        // Calculate where the crossfade starts (end of segment minus crossfade duration)
        const crossfadeStartSec = endSec - crossfadeSec;

        // Play from PREVIEW_WINDOW seconds before the crossfade point
        const playFromSec = Math.max(startSec, crossfadeStartSec - PREVIEW_WINDOW);

        debug(`[Previewer] Preview loop point: playing from ${playFromSec.toFixed(2)}s, crossfade at ${crossfadeStartSec.toFixed(2)}s`);

        try {
            // Create and start the first sound
            this.soundA = new foundry.audio.Sound(this.data.document.path);
            await this.soundA.load();
            this.isA_Active = true;

            await this.soundA.play({ offset: playFromSec, _fromLoop: true });
            this.isPlaying = true;
            this._tick();

            // Schedule the crossfade at the right moment
            const delayUntilCrossfade = Math.max(0, (crossfadeStartSec - playFromSec) * 1000);

            debug(`[Previewer] Crossfade will trigger in ${delayUntilCrossfade}ms`);

            this.timeoutIds.push(setTimeout(async () => {
                if (!this.isPreviewingLoop) return;

                debug("[Previewer] Triggering crossfade now");

                const sourceSound = this.isA_Active ? this.soundA : this.soundB;
                let targetSound = this.isA_Active ? this.soundB : this.soundA;

                // Create target sound if needed
                if (!targetSound) {
                    targetSound = new foundry.audio.Sound(this.data.document.path);
                    await targetSound.load();
                    if (this.isA_Active) {
                        this.soundB = targetSound;
                    } else {
                        this.soundA = targetSound;
                    }
                }

                // Start target sound at loop start point
                await targetSound.play({ offset: startSec, volume: 0, _fromLoop: true });

                // Perform crossfade
                const { equalPowerCrossfade } = await import('./audio-fader.js');
                equalPowerCrossfade(sourceSound, targetSound, crossfadeMs);

                // Stop source sound after crossfade completes
                this.timeoutIds.push(setTimeout(() => {
                    try { sourceSound.stop(); } catch (_) { }
                }, crossfadeMs + 100));

                // Switch active sound
                this.isA_Active = !this.isA_Active;

                // The total time to wait from the start of the crossfade is the
                // crossfade duration PLUS the post-fade preview window.
                const stopDelayMs = crossfadeMs + (PREVIEW_WINDOW * 1000);

                debug(`[Previewer] Preview will stop in ${stopDelayMs}ms (crossfade ${crossfadeMs}ms + preview ${PREVIEW_WINDOW * 1000}ms)`);

                // Stop the preview after the crossfade and the final preview window have finished.
                this.timeoutIds.push(setTimeout(() => {
                    debug("[Previewer] Preview complete, stopping");
                    this.stopAll(true);
                }, stopDelayMs));

            }, delayUntilCrossfade));

        } catch (err) {
            console.error("[Previewer] Error during loop point preview:", err);
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

        $(document).on("mousemove.loopeditor", this._onHandleMouseMove.bind(this));
        $(document).on("mouseup.loopeditor", this._onHandleMouseUp.bind(this));
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