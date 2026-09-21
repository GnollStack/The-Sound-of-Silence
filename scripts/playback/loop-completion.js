import { debug, PlaylistActionAuthority } from "../utils.js";

// Completed local loop engines stay retired. Only their outstanding document
// advancement is retained so a later controller can finish it without replay.
const pending = new Map();

export function retainLoopCompletion(sound, advance) {
  const entry = { advance, generation: null, submitted: false };
  pending.set(sound, entry);
  return reconcileLoopCompletion(sound, entry);
}

async function reconcileLoopCompletion(sound, entry) {
  const playlist = sound.parent;
  if (!sound.playing || !playlist?.playing || !playlist.sounds?.has?.(sound.id)) {
    pending.delete(sound);
    return;
  }
  const token = PlaylistActionAuthority.capture();
  if (!token || entry.submitted || entry.generation === token.generation) return;
  entry.generation = token.generation;
  const current = () => pending.get(sound) === entry && PlaylistActionAuthority.isCurrent(token) &&
    sound.playing && playlist.playing;
  const commit = async operation => {
    if (!current() || entry.submitted) return false;
    entry.submitted = true;
    try {
      const result = await operation();
      if (result !== false) pending.delete(sound);
      return result;
    } finally {
      entry.submitted = false;
    }
  };
  try {
    await entry.advance({ current, commit });
  } finally {
    if (entry.generation === token.generation) entry.generation = null;
  }
}

export function reconcilePendingLoopCompletions() {
  return Promise.all(Array.from(pending, ([sound, entry]) =>
    reconcileLoopCompletion(sound, entry).catch(error => debug("[Loop completion] Recovery failed", error))
  ));
}

export function clearPendingLoopCompletion(sound) {
  pending.delete(sound);
}
