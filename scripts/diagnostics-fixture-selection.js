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

/**
 * Share a small audio pool across generic diagnostics. Twelve seconds keeps
 * tracks alive through client snapshots without decoding campaign music.
 * Scenarios that need a precise duration or real stream supply an explicit path.
 */
export function createFixtureAudioResolver(createTone) {
  const frequencies = [330, 440, 660];
  const worlds = new Map();
  const getTones = (worldId) => {
    const key = String(worldId ?? "");
    if (!worlds.has(key)) worlds.set(key, new Map());
    return worlds.get(key);
  };
  const resolveAudio = ({ path = null, frequency = 440, worldId = "" } = {}) => {
    if (path !== null && path !== undefined) return path;
    const tones = getTones(worldId);
    const requested = Number.isFinite(Number(frequency)) ? Number(frequency) : 440;
    const selected = frequencies.reduce((closest, candidate) =>
      Math.abs(candidate - requested) < Math.abs(closest - requested) ? candidate : closest
    );
    if (!tones.has(selected)) {
      const generated = createTone({ durationSec: 12, frequency: selected });
      tones.set(selected, { generated, path: generated });
    }
    return tones.get(selected).path;
  };
  resolveAudio.rememberCreatedPath = ({ sourcePath, path, worldId = "" } = {}) => {
    if (typeof path !== "string" || !path) return false;
    for (const tone of getTones(worldId).values()) {
      if (tone.generated !== sourcePath && tone.path !== sourcePath) continue;
      tone.path = path;
      return true;
    }
    return false;
  };
  return resolveAudio;
}
