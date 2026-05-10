/**
 * @file personal-audio-mix.js
 * @description Client-local personal mix application and visible volume-control synchronization.
 */
import { Flags } from "./flag-service.js";
import { State } from "./state-manager.js";
import { debug } from "./utils.js";

function _cssAttrSelector(attribute, value) {
  const text = String(value ?? "");
  const escaped = globalThis.CSS?.escape
    ? CSS.escape(text)
    : text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[${attribute}="${escaped}"]`;
}

function _soundVolumeInputValue(soundDoc) {
  const volume = Number(soundDoc?.volume);
  if (!Number.isFinite(volume)) return null;
  const converted = foundry.audio.AudioHelper.volumeToInput(volume);
  return Number.isFinite(converted) ? converted : volume;
}

function _personalTrackVolumeInputValue(soundDoc) {
  const value = Number(Flags.getPersonalTrackVolumeInput(soundDoc));
  return Number.isFinite(value) ? value : null;
}

function _setRangePickerValue(rangePicker, value) {
  if (!rangePicker || !Number.isFinite(value)) return false;

  let changed = false;
  if (Number(rangePicker.value) !== value) {
    rangePicker.value = value;
    changed = true;
  }
  if (rangePicker.getAttribute?.("value") !== String(value)) {
    rangePicker.setAttribute?.("value", String(value));
    changed = true;
  }

  for (const input of rangePicker.querySelectorAll?.('input[type="range"], input[type="number"]') ?? []) {
    if (Number(input.value) === value) continue;
    input.value = String(value);
    changed = true;
  }

  return changed;
}

export function syncSoundVolumeControls(soundDoc, reason = "volume update") {
  const value = _soundVolumeInputValue(soundDoc);
  if (!Number.isFinite(value)) return;

  const selectors = [
    `.sound${_cssAttrSelector("data-sound-id", soundDoc.id)}`,
    `.sound${_cssAttrSelector("data-document-id", soundDoc.id)}`,
    `.sound${_cssAttrSelector("data-entry-id", soundDoc.id)}`,
  ];

  let updated = 0;
  const rows = document.querySelectorAll(selectors.join(","));
  for (const row of rows) {
    for (const control of row.querySelectorAll("range-picker.sound-volume, input.sound-volume")) {
      if (_setRangePickerValue(control, value)) updated += 1;
    }
  }

  if (updated) {
    debug(`[Volume] Synced ${updated} visible volume control(s) for "${soundDoc.name}" (${reason}).`);
  }
}

export function syncPersonalTrackVolumeControls(soundDoc, reason = "volume update", { force = false } = {}) {
  if (!Flags.isPersonalAudioMixEnabled()) return;
  if (!force && Flags.hasPersonalTrackVolume(soundDoc)) return;

  const value = _personalTrackVolumeInputValue(soundDoc);
  if (!Number.isFinite(value)) return;

  const selectors = [
    `.sound${_cssAttrSelector("data-sound-id", soundDoc.id)}`,
    `.sound${_cssAttrSelector("data-document-id", soundDoc.id)}`,
    `.sound${_cssAttrSelector("data-entry-id", soundDoc.id)}`,
  ];

  let updated = 0;
  const rows = document.querySelectorAll(selectors.join(","));
  for (const row of rows) {
    for (const control of row.querySelectorAll(".sos-personal-track-volume-slider")) {
      if (_setRangePickerValue(control, value)) updated += 1;
    }
  }

  if (updated) {
    debug(`[Volume] Synced ${updated} personal track control(s) for "${soundDoc.name}" (${reason}).`);
  }
}

export function syncPersonalTrackVolumeControlsForPlaylist(playlist, reason = "playlist volume update") {
  if (!playlist?.sounds) return;
  for (const soundDoc of playlist.sounds) {
    syncPersonalTrackVolumeControls(soundDoc, reason);
  }
}

export function syncEmbeddedSoundVolumeControls(playlist, changes, reason = "embedded volume update") {
  if (!Array.isArray(changes?.sounds)) return;

  for (const soundChange of changes.sounds) {
    if (!Object.prototype.hasOwnProperty.call(soundChange ?? {}, "volume")) continue;
    const soundDoc = playlist?.sounds?.get(soundChange._id);
    if (soundDoc) {
      syncSoundVolumeControls(soundDoc, reason);
      syncPersonalTrackVolumeControls(soundDoc, reason);
    }
  }

  applyPersonalAudioMixToActiveSounds(playlist);
}

export function syncPlaylistVolumeControls(playlist, reason = "playlist volume update") {
  const value = Number(Flags.getPlaylistFlag(playlist, "normalizedVolume"));
  if (!Number.isFinite(value)) return;

  const playlistSelector = _cssAttrSelector("data-playlist-id", playlist.id);
  const selectors = [
    `.sos-playlist-volume-slider${playlistSelector}`,
    `.sos-playlist-volume-col${playlistSelector} .sos-playlist-volume-slider`,
  ];

  let updated = 0;
  for (const control of document.querySelectorAll(selectors.join(","))) {
    if (_setRangePickerValue(control, value)) updated += 1;
  }

  if (updated) {
    debug(`[Volume] Synced ${updated} visible playlist volume control(s) for "${playlist.name}" (${reason}).`);
  }
}

export function applyPersonalAudioMixToActiveSound(ps, options = {}) {
  const sound = ps?.sound;
  if (!sound?.playing) return;
  if (State.isSoundFading(sound)) return;
  sound.volume = Flags.resolveTargetVolume(ps, options);
}

export function applyPersonalAudioMixToActiveSounds(playlist, options = {}) {
  if (!playlist) return;

  for (const ps of playlist.sounds ?? []) {
    applyPersonalAudioMixToActiveSound(ps, options);
  }

  const engine = State.getSoundscapeEngine(playlist);
  if (engine?.applyPersonalAudioMix) engine.applyPersonalAudioMix(options);
  else engine?.applyPersonalPlaylistVolume?.(options);
}

export function applyPersonalPlaylistVolumeToActiveSounds(playlist) {
  applyPersonalAudioMixToActiveSounds(playlist);
}

export function applyPersonalPlaylistVolumesToActiveSounds() {
  for (const playlist of game.playlists ?? []) {
    applyPersonalAudioMixToActiveSounds(playlist);
  }
}
