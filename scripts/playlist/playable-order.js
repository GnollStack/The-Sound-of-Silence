/**
 * @file playable-order.js
 * @description Playlist ordering helpers that exclude temporary SoS documents.
 */
import { Flags } from "../flag-service.js";

/**
 * Return playlist sounds in playback order without temporary silence gaps.
 *
 * Silence gaps are embedded PlaylistSound documents so Foundry includes them in
 * its cached playbackOrder. Runtime advancement must never treat those
 * transition markers as real playlist content.
 *
 * @param {Playlist} playlist
 * @returns {PlaylistSound[]}
 */
export function getPlayableSoundsInOrder(playlist) {
  const sounds = playlist?.sounds;
  if (!sounds?.get) return [];

  const seen = new Set();
  const playable = [];
  for (const soundId of Array.from(playlist.playbackOrder ?? [])) {
    if (seen.has(soundId)) continue;
    seen.add(soundId);

    const sound = sounds.get(soundId);
    if (!sound || Flags.getSoundFlag(sound, "isSilenceGap")) continue;
    playable.push(sound);
  }
  return playable;
}

/**
 * Resolve an adjacent real playlist sound, preserving Foundry's wrapping
 * Previous/Next behavior while ignoring temporary silence documents.
 *
 * @param {Playlist} playlist
 * @param {string|null} soundId
 * @param {number} [direction=1]
 * @returns {PlaylistSound|null}
 */
export function getAdjacentPlayableSound(playlist, soundId, direction = 1) {
  const playable = getPlayableSoundsInOrder(playlist);
  if (!playable.length) return null;

  const index = playable.findIndex((sound) => sound.id === soundId);
  if (index < 0) return direction === -1 ? playable.at(-1) : playable[0];

  const offset = direction === -1 ? -1 : 1;
  return playable[(index + offset + playable.length) % playable.length] ?? null;
}

/**
 * Whether the playlist currently contains any temporary silence documents.
 *
 * @param {Playlist} playlist
 * @returns {boolean}
 */
export function hasSilenceGapDocuments(playlist) {
  return Array.from(playlist?.sounds ?? [])
    .some((sound) => Flags.getSoundFlag(sound, "isSilenceGap"));
}
