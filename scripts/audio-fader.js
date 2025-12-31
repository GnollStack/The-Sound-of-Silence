// audio-fader.js - Advanced audio fading utilities for Foundry VTT

import { debug } from "./utils.js";
import { State } from "./state-manager.js";

const AudioTimeout = foundry.audio.AudioTimeout;

const CURVE_RESOLUTION = 64;

/**
 * Generates an exponential fade curve that sounds perceptually linear to human hearing.
 * Uses the formula: volume = start * (target/start)^progress
 * This compensates for the logarithmic nature of human hearing.
 *
 * @param {number} startVol Starting volume (0 to 1)
 * @param {number} targetVol Target volume (0 to 1)
 * @returns {Float32Array} Curve data for setValueCurveAtTime
 */
function generateExponentialCurve(startVol, targetVol) {
  const curve = new Float32Array(CURVE_RESOLUTION);

  // Validate inputs - handle NaN or invalid values
  if (!Number.isFinite(startVol)) startVol = 0;
  if (!Number.isFinite(targetVol)) targetVol = 1;

  // Clamp to valid range
  startVol = Math.max(0, Math.min(1, startVol));
  targetVol = Math.max(0, Math.min(1, targetVol));

  // Handle edge case: fading to/from zero requires special handling
  // since log(0) is undefined. Use a tiny epsilon instead.
  const EPSILON = 0.0001;
  const safeStart = Math.max(EPSILON, startVol);
  const safeTarget = Math.max(EPSILON, targetVol);

  // Exponential curve: v(t) = start * (target/start)^t
  // This is perceptually linear because human hearing is logarithmic
  const ratio = safeTarget / safeStart;

  for (let i = 0; i < CURVE_RESOLUTION; i++) {
    const progress = i / (CURVE_RESOLUTION - 1);
    curve[i] = safeStart * Math.pow(ratio, progress);

    // Clamp to valid range
    curve[i] = Math.max(0, Math.min(1, curve[i]));
  }

  // Ensure exact endpoints
  curve[0] = startVol;
  curve[CURVE_RESOLUTION - 1] = targetVol;

  return curve;
}

// --- Fader Functions ---

const ACTIVE_FADES = new WeakMap();

export function cancelActiveFade(sound) {
  const id = ACTIVE_FADES.get(sound);
  if (id !== undefined) {
    try {
      cancelAnimationFrame(id);
    } catch (_) {}
    ACTIVE_FADES.delete(sound);
  }
  sound?.gain?.cancelScheduledValues(sound.context.currentTime);
}

/**
 * Fades a sound using an exponential curve that sounds perceptually linear.
 * Executed on the audio thread for precise, glitch-free fading.
 *
 * @param {Sound} sound The V13 Sound object.
 * @param {object} options
 * @param {number} options.targetVol The final volume (0 to 1).
 * @param {number} options.duration The duration of the fade in milliseconds.
 */
export function advancedFade(sound, { targetVol, duration }) {
  if (!sound?.gain) return;
  if (!Number.isFinite(duration) || duration <= 0) {
    sound.volume = targetVol;
    return;
  }

  const gain = sound.gain;
  const context = sound.context;
  
  // Cancel any existing scheduled values FIRST to get a clean state
  gain.cancelScheduledValues(context.currentTime);
  
  // Read current value and handle potential NaN from interrupted curves
  let startVol = gain.value;
  if (!Number.isFinite(startVol)) {
    // Fallback: use the Sound's volume property or target as starting point
    startVol = sound.volume ?? targetVol;
    debug(`[AF] Recovered from NaN gain.value, using fallback: ${startVol}`);
  }
  
  // Establish a known value at current time (Web Audio best practice after cancel)
  gain.setValueAtTime(startVol, context.currentTime);
  
  const durationSec = duration / 1000;

  // Generate perceptually linear exponential curve
  const curve = generateExponentialCurve(startVol, targetVol);

  // Schedule on the audio thread (slight offset to avoid collision with setValueAtTime)
  gain.setValueCurveAtTime(curve, context.currentTime + 0.001, durationSec);
}

/**
 * Fades a sound to 0 using exponential curve, then stops it.
 * @param {Sound} sound
 * @param {number} ms Fade duration in milliseconds (default 500ms).
 * @returns {Promise<void>}
 */
export async function fadeOutAndStop(sound, ms = 500) {
  if (!sound) return Promise.resolve();

  advancedFade(sound, { targetVol: 0, duration: ms });

  await AudioTimeout.wait(ms);

  if (sound.volume <= 0.01) {
    try {
      sound.stop();
    } catch (err) {
      // Sound may have been destroyed
    }
  }
}

/**
 * Performs an equal-power crossfade between two sounds.
 * Uses sine/cosine curves to maintain constant perceived power during transition.
 * This is the correct approach for crossfades (different from regular fades).
 *
 * @param {Sound} soundOut The sound to fade out.
 * @param {Sound} soundIn The sound to fade in.
 * @param {number} duration The duration of the crossfade in milliseconds.
 */
export function equalPowerCrossfade(soundOut, soundIn, duration) {
  debug(`[AF] Starting equal-power crossfade over ${duration}ms.`);
  if (!soundOut || !soundIn) return;
  if (!Number.isFinite(duration) || duration <= 0) {
    soundOut.volume = 0;
    soundIn.volume = soundIn._manager?.volume ?? 1.0;
    return;
  }

  cancelActiveFade(soundOut);
  cancelActiveFade(soundIn);

  const gainOut = soundOut.gain;
  const gainIn = soundIn.gain;
  const contextOut = soundOut.context;
  const contextIn = soundIn.context;

  const startVolOut = gainOut.value;
  const targetVolIn = soundIn._manager?.volume ?? 1.0;

  const durationSec = duration / 1000;

  // Equal-power crossfade curves using trigonometric functions
  // These maintain constant perceived power: cos²(θ) + sin²(θ) = 1
  const curveOut = new Float32Array(CURVE_RESOLUTION);
  const curveIn = new Float32Array(CURVE_RESOLUTION);

  for (let i = 0; i < CURVE_RESOLUTION; i++) {
    const progress = i / (CURVE_RESOLUTION - 1);
    curveOut[i] = startVolOut * Math.cos(progress * 0.5 * Math.PI);
    curveIn[i] = targetVolIn * Math.sin(progress * 0.5 * Math.PI);
  }

  gainOut.cancelScheduledValues(contextOut.currentTime);
  gainIn.cancelScheduledValues(contextIn.currentTime);

  gainOut.setValueCurveAtTime(curveOut, contextOut.currentTime, durationSec);
  gainIn.setValueCurveAtTime(curveIn, contextIn.currentTime, durationSec);
}

/**
 * Schedules an end-of-track fade-out for a sound using the playlist's default fade duration.
 * This is intended for modes (like Sequential) where Crossfade and Looping are not active.
 * @param {PlaylistSound} ps The sound document for which to schedule a fade.
 */
export function scheduleEndOfTrackFade(ps) {
  const playlist = ps.parent;
  const sound = ps.sound;

  if (!playlist || !sound || !sound.playing) return;

  // Don't schedule end-of-track fade for sounds set to loop natively.
  // The loop would restart the sound mid-fade, causing gain.value to become NaN.
  if (ps.repeat) {
    debug(
      `[Fade] Skipping end-of-track fade for "${ps.name}" - sound is set to repeat.`
    );
    return;
  }

  // Use the standard playlist fade duration for this effect.
  const fadeMs = Number(playlist.fade) || 0;
  if (fadeMs <= 0) return;

  const duration = sound.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;

  const fadeStartTime = Math.max(0, duration - fadeMs / 1000);
  const currentTime = sound.currentTime ?? 0;

  // Don't schedule if we're already past the fade point.
  if (currentTime >= fadeStartTime) return;

  const delayMs = (fadeStartTime - currentTime) * 1000;
  const timer = new foundry.audio.AudioTimeout(delayMs, {
    context: sound.context,
  });

  State.setEndOfTrackFade(ps, timer);
  debug(
    `[Fade] Scheduling end-of-track fade at ${fadeStartTime.toFixed(2)}s for "${
      ps.name
    }"`
  );

  timer.complete.then(() => {
    // Verify the timer wasn't cancelled and the sound is still playing
    if (!State.getEndOfTrackFade(ps) || !sound.playing) return;

    State.clearEndOfTrackFade(ps);
    debug(`[Fade] Starting end-of-track exponential fade-out for "${ps.name}"`);
    advancedFade(sound, { targetVol: 0, duration: fadeMs });
  });
}
