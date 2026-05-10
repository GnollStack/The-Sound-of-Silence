/**
 * @file lifecycle.js
 * @description Registers init/ready lifecycle hooks and delegates feature hook setup.
 */
import { registerPlaylistSheetWrappers } from "../playlist-config.js";
import { registerSoundConfigWrappers } from "../sound-config.js";
import { registerCurrentlyPlaying } from "../currently-playing.js";
import { Integrations } from "../integrations.js";
import { API } from "../api.js";
import { registerSoundCacheHooks } from "../sound-cache.js";
import { registerPlaylistUiHooks } from "../playlist-ui.js";
import { registerSoundscapePreviewerHooks } from "../soundscape-previewer.js";
import { registerSettings } from "../settings.js";
import { info, MODULE_ID, registerSequenceCleanupHooks } from "../utils.js";
import { registerFlagServiceHooks } from "../flag-service.js";
import {
  applyPersonalPlaylistVolumesToActiveSounds,
} from "../personal-audio-mix.js";
import { startPlaybackRecoveryWatchdog } from "../playback-recovery.js";
import {
  bootstrapSoundscapeEngines,
  registerSoundscapePlaylistHooks,
  registerSoundscapeSoundHooks,
} from "../soundscape-orchestration.js";
import { registerPlaybackDocumentHooks } from "../playback/document-hooks.js";
import { registerVisibilityRecovery } from "../playback/visibility-recovery.js";
import { registerLoopReplicationHooks } from "../loop/loop-replication-hooks.js";
import {
  registerPlaylistAdvanceWrappers,
  registerPlaylistCommandWrappers,
} from "../playlist/playlist-command-wrappers.js";
import { registerTransitionReplicationHooks } from "../playlist/transition-replication-hooks.js";
import { registerSoundPlaybackWrappers } from "../playback/sound-wrappers.js";
import { registerShuffleHooks } from "../playlist/shuffle-hooks.js";
import { registerNormalizationHooks } from "../volume/normalization-hooks.js";

export function registerLifecycleHooks() {
  Hooks.once("init", () => {
    info("Initializing...");

    // Detect conflicting playlist modules (informational; SoS still activates).
    Integrations.detect();
    registerSequenceCleanupHooks();
    registerFlagServiceHooks();
    registerSoundCacheHooks();
    registerSettings({
      applyPersonalPlaylistVolumesToActiveSounds,
    });
  });

  Hooks.once("ready", () => {
    if (!game.modules.get("lib-wrapper")?.active) {
      ui.notifications.error(`${MODULE_ID} requires the libWrapper module.`);
      return;
    }

    API._initialize();
    const module = game.modules.get(MODULE_ID);
    if (module) {
      module.api = API;
    }

    game.socket.on(`module.${MODULE_ID}`, (data) => API._handleSocketMessage(data));

    Integrations.registerAudioGuards();

    registerSoundscapePreviewerHooks();
    registerPlaylistSheetWrappers();
    registerSoundConfigWrappers();
    registerPlaylistUiHooks();
    registerCurrentlyPlaying();
    startPlaybackRecoveryWatchdog();

    registerPlaybackDocumentHooks();
    bootstrapSoundscapeEngines();
    registerVisibilityRecovery();
    registerLoopReplicationHooks();
    registerSoundscapeSoundHooks();

    registerPlaylistCommandWrappers();
    registerTransitionReplicationHooks();
    registerPlaylistAdvanceWrappers();
    registerSoundPlaybackWrappers();
    registerShuffleHooks();
    registerSoundscapePlaylistHooks();
    registerNormalizationHooks();
  });
}
