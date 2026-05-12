/**
 * @file normalization-hooks.js
 * @description GM-side volume normalization propagation and visible control sync.
 */
import { Flags } from "../flag-service.js";
import { debug, MODULE_ID } from "../utils.js";

const VOLUME_EPSILON = 0.0001;

export function registerNormalizationHooks() {
  Hooks.on("updatePlaylist", async (playlist, changes, options, userId) => {
    if (game.user.id !== userId || !game.user.isGM) return;

    const flagPath = `flags.${MODULE_ID}`;
    const normalizationToggled = foundry.utils.hasProperty(
      changes,
      `${flagPath}.volumeNormalizationEnabled`
    );
    const volumeChanged = foundry.utils.hasProperty(
      changes,
      `${flagPath}.normalizedVolume`
    );

    const normFlags = Flags.getPlaylistFlags(playlist);
    if (
      !normFlags.volumeNormalizationEnabled ||
      (!normalizationToggled && !volumeChanged)
    ) {
      return;
    }

    const targetVolume = normFlags.normalizedVolume;
    const updates = [];

    const convertedVolume =
      foundry.audio.AudioHelper.inputToVolume(targetVolume);
    const temporaryOverridePath = `flags.${MODULE_ID}.normalizedVolumeOverride`;

    for (const sound of playlist.sounds) {
      if (Flags.getSoundFlag(sound, "allowVolumeOverride")) continue;

      const overrideSnapshot = Flags.getSoundFlag(
        sound,
        "normalizedVolumeOverride"
      );
      const hasTemporaryOverride =
        overrideSnapshot !== null &&
        typeof overrideSnapshot !== "undefined" &&
        Number.isFinite(Number(overrideSnapshot));
      const currentVolume = Number(sound.volume);
      const volumeChanged =
        !Number.isFinite(currentVolume) ||
        Math.abs(currentVolume - convertedVolume) > VOLUME_EPSILON;

      if (volumeChanged || hasTemporaryOverride) {
        updates.push({
          _id: sound.id,
          volume: convertedVolume,
          [temporaryOverridePath]: null,
        });
      }
    }

    if (updates.length > 0) {
      debug(
        `[Volume] Normalizing ${updates.length} sounds to ${(
          targetVolume * 100
        ).toFixed(0)}% in "${playlist.name}"`
      );

      await playlist.updateEmbeddedDocuments("PlaylistSound", updates, {
        _fromNormalization: true,
        render: false,
      });

      const playlistElement = document.querySelector(
        `.playlist[data-entry-id="${playlist.id}"], .playlist[data-document-id="${playlist.id}"]`
      );
      if (playlistElement) {
        for (const update of updates) {
          const soundElement = playlistElement.querySelector(
            `.sound[data-sound-id="${update._id}"]`
          );
          if (soundElement) {
            const rangePicker = soundElement.querySelector(
              "range-picker.sound-volume"
            );
            if (rangePicker) {
              rangePicker.value = targetVolume;
            }
          }
        }
      }

      const currentlyPlaying = document.querySelector(".currently-playing");
      if (currentlyPlaying) {
        for (const update of updates) {
          const soundElement = currentlyPlaying.querySelector(
            `.sound[data-sound-id="${update._id}"]`
          );
          if (soundElement) {
            const rangePicker = soundElement.querySelector(
              "range-picker.sound-volume"
            );
            if (rangePicker) {
              rangePicker.value = targetVolume;
            }
          }
        }
      }
    }
  });
}
