/**
 * Resolve named PlaylistSound roles without relying on embedded Collection order.
 * Foundry may return newly-created embedded documents in a different order than
 * the fixture input, so diagnostics with role-specific flags must use names.
 */
export function requireNamedPlaylistSounds(playlist, names) {
  const sounds = Array.from(playlist?.sounds ?? []);
  const playlistLabel = playlist?.name || playlist?.id || "unknown playlist";

  return names.map((name) => {
    const sound = sounds.find((entry) => entry?.name === name);
    if (!sound) {
      throw new Error(`Playlist fixture "${playlistLabel}" is missing sound "${name}".`);
    }
    return sound;
  });
}
