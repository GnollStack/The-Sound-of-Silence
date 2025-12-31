// silence.js

/**
 * @file silence.js
 * @description Manages the "Sound of Silence" feature by creating, playing,
 * and cleaning up temporary silent audio tracks to serve as gaps between playlist sounds.
 */
import { debug, waitForMedia, MODULE_ID, logFeature, LogSymbols } from "./utils.js";
import { Flags } from "./flag-service.js";
import { State } from "./state-manager.js";
import { maybeLoopPlaylist } from "./playlist-loop.js";

// Make the V13 AudioTimeout class available in this file.
const AudioTimeout = foundry.audio.AudioTimeout;

const FLAG_KEY = "isSilenceGap";
const GAP_VOLUME = 0.01;
const GAP_NAME = "Silent Gap";

// ============================================
// Helper Functions
// ============================================


// A minimal 100ms silent WAV file - only 8.8 KB after base64 encoding
// This is a constant tiny file we'll reuse for all gaps
const MINIMAL_SILENT_WAV = (function generateMinimalSilence() {
  const sampleRate = 44100;
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const durationSec = 0.1; // 100ms

  const numSamples = Math.ceil(durationSec * sampleRate);
  const dataSize = numSamples * numChannels * bytesPerSample;
  const fileSize = 44 + dataSize;

  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);

  // WAV Header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, fileSize - 8, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Convert to base64
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return 'data:audio/wav;base64,' + btoa(binary);
})();

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Creates and plays a temporary, near-silent PlaylistSound document to serve as a gap.
 * It also patches the underlying Sound object's duration and currentTime properties
 * to make the Foundry UI timer reflect the gap's countdown.
 * @param {Playlist} playlist The parent playlist.
 * @param {number} durationMs The duration of the silent gap in milliseconds.
 * @returns {Promise<PlaylistSound>} The created gap sound document.
 */
async function createAndPlayGap(playlist, durationMs) {
  const now = Date.now();

  // OPTIMIZATION: Use a tiny 100ms silent file instead of generating full-length audio
  // The actual duration is controlled by AudioTimeout, not the audio file itself
  const silentAudio = MINIMAL_SILENT_WAV;

  let gap;
  try {
    const [created] = await playlist.createEmbeddedDocuments("PlaylistSound", [{
      name: GAP_NAME,
      path: silentAudio,

      playing: true,

      volume: GAP_VOLUME,
      repeat: false,
      flags: {
        [MODULE_ID]: {
          [FLAG_KEY]: true,
          gapDuration: durationMs,
          gapStarted: now
        }
      }
    }]); // Ensure the noHook option is still removed from here
    gap = created;
  } catch (err) {
    console.warn(`[${MODULE_ID}] Failed to create silent gap document:`, err);
    debug(`[${MODULE_ID}] Silent gap creation failed, playlist will continue without gap.`);
    return null;
  }

  try {
    await playlist.playSound(gap);
  } catch (err) {
    console.warn(`[${MODULE_ID}] Failed to play silent gap:`, err);
    try {
      await gap.delete({ noHook: true });
    } catch (_) { }
    return null;
  }

  const sound = await waitForMedia(gap);

  if (!sound) {
    debug(`[${MODULE_ID}] Failed to get sound object for silent gap.`);
    return gap;
  }

  // Patch for UI display - makes the timer show the correct duration
  const durSec = durationMs / 1000;
  Object.defineProperty(sound, "duration", {
    configurable: true,
    get: () => durSec
  });

  Object.defineProperty(sound, "currentTime", {
    configurable: true,
    get: () => Math.min((Date.now() - now) / 1000, durSec)
  });

  ui.playlists?.render(true);
  logFeature(LogSymbols.SILENCE, 'Silence', `${playlist.name} (${durationMs}ms)`);
  return gap;
}


/**
 * Cleans up a silent gap by clearing its timer, deleting the associated
 * PlaylistSound document, and removing its state from the global tracker.
 * @param {Playlist} playlist The parent playlist.
 * @param {object} state The state object for the silent gap from SOS_STATE.
 */
async function teardownGap(playlist, state) {
  State.clearSilenceState(playlist);

  if (state.gap && playlist.sounds.has(state.gap.id)) {
    try {
      await state.gap.delete();
      debug(`[${MODULE_ID}] 🧹 Deleted silent gap "${state.gap.name}"`);
    } catch (err) {
      console.warn(`[${MODULE_ID}] ❌ Failed to delete gap:`, err);
    }
  }
}


// ============================================
// Public API
// ============================================

export const Silence = {
  FLAG_KEY,

  /**
   * Injects a silent track into the given playlist. This is the main entry point for the feature.
   * Returns a Promise that resolves to `true` if the silence is cancelled prematurely,
   * or `false` if it completes naturally.
   * @param {Playlist} playlist The playlist to play silence in.
   * @returns {Promise<boolean>} A promise resolving to true if cancelled, false otherwise.
   */
  async playSilence(playlist, sourceSound) {
    // Only GMs should ever create the temporary silent gap document.
    if (!game.user.isGM) return Promise.resolve(false);

    // Get the final, calculated gap duration from our centralized service.
    const gapMs = Flags.getSilenceDuration(playlist);

    // Silence is not applicable to simultaneous playback mode.
    if (playlist.mode === CONST.PLAYLIST_MODES.SIMULTANEOUS) {
      debug(`[${MODULE_ID}] ⭕ Simultaneous mode – skipping silence.`);
      return Promise.resolve(false);
    }

    if (gapMs <= 0) {
      debug("Gap skipped (duration is zero).");
      return Promise.resolve(false);
    } else {
      debug(`Gap of ${gapMs}ms will be created.`);
    }

    const gap = await createAndPlayGap(playlist, gapMs);

    // Handle the case where gap creation failed
    if (!gap) {
      debug(`[${MODULE_ID}] Gap creation failed, resolving immediately.`);
      return Promise.resolve(false);
    }

    // Emit silence start event
    Hooks.callAll('the-sound-of-silence.silenceStart', {
      playlist,
      duration: gapMs
    });

    return new Promise(resolve => {
      // Use the V13+ AudioTimeout for precise, audio-context-synchronized timing.
      const timer = new AudioTimeout(gapMs);

      const state = {
        gap,
        cancelled: false,
        timer: timer,
        resolve,
        sourceSound // Add the source sound to the state
      };
      State.setSilenceState(playlist, state);

      // Await the completion of the precise timer.
      timer.complete.then(async () => {

        // If the state was cleared by an external cleanup (like stopAll),
        // this entire operation is void. Do nothing.
        if (!State.hasSilenceState(playlist)) {
          debug(`[Silence] Timer expired, but state was already cleaned up. Aborting.`);
          return;
        }
        // Check if we were cancelled while waiting. The 'cancelled' flag is
        // set by the cancelSilentGap function in main.js.
        if (state.cancelled) return;

        debug(`[${MODULE_ID}] ⏱ Silent gap of ${gapMs} ms expired for "${playlist.name}"`);

        // Emit silence end event
        Hooks.callAll('the-sound-of-silence.silenceEnd', {
          playlist,
          duration: gapMs,
          completed: true
        });
        State.recordSilence(gapMs, false);

        const sourceSound = state.sourceSound;
        const wasPlaying = playlist.playing;

        // We must clean up the gap BEFORE advancing to avoid race conditions.
        await teardownGap(playlist, state);

        // Now, advance the playlist if it was playing before the gap.
        if (game.user.isGM && wasPlaying && sourceSound) {
          const order = playlist.playbackOrder;
          const idx = order.indexOf(sourceSound.id) + 1;
          const next = playlist.sounds.get(order[idx]);

          if (next) {
            playlist.playSound(next);
          } else {
            // If there's no next track, check if we should loop the whole playlist.
            if (!maybeLoopPlaylist(playlist)) {
              playlist.stopAll();
            }
          }
        }
        resolve(false); // Resolve normally
      });
    });
  }
};