import test from "node:test";
import assert from "node:assert/strict";

if (!globalThis.foundry) {
  globalThis.foundry = {
    audio: {
      AudioTimeout: class AudioTimeout {
        constructor() {
          this.cancelled = false;
          this.complete = new Promise((resolve) => { this._resolve = resolve; });
        }

        cancel() {
          if (this.cancelled) return;
          this.cancelled = true;
          this._resolve();
        }

        static wait() {
          return Promise.resolve();
        }
      },
    },
    applications: {
      api: {
        ApplicationV2: class ApplicationV2 {},
        HandlebarsApplicationMixin: (Base) => class extends Base {},
      },
    },
    utils: {
      deepClone: (value) => structuredClone(value),
      duplicate: (value) => structuredClone(value),
      mergeObject: (base, update) => Object.assign(base, update),
    },
  };
}

globalThis.Playlist ??= class Playlist {};
globalThis.PlaylistSound ??= class PlaylistSound {};
globalThis.CONST ??= {
  PLAYLIST_MODES: {
    DISABLED: -1,
    SEQUENTIAL: 0,
    SHUFFLE: 1,
    SIMULTANEOUS: 2,
  },
};
globalThis.ui ??= { playlists: { render() {} } };

if (!globalThis.Hooks) {
  const listeners = new Map();
  globalThis.Hooks = {
    on(name, callback) {
      const callbacks = listeners.get(name) ?? [];
      callbacks.push(callback);
      listeners.set(name, callbacks);
      return callback;
    },
    off(name, callback) {
      const callbacks = listeners.get(name) ?? [];
      listeners.set(name, callbacks.filter((entry) => entry !== callback));
    },
    callAll(name, ...args) {
      for (const callback of listeners.get(name) ?? []) callback(...args);
    },
  };
}

globalThis.game ??= {
  settings: { get: () => false },
  users: [],
  user: { id: "test-player", isGM: false, active: true },
  playlists: [],
};

const { State } = await import("../scripts/state-manager.js");
const {
  completeSilenceGap,
  recoverPersistedSilenceGaps,
} = await import("../scripts/silence.js");

class SoundCollection extends Array {
  static get [Symbol.species]() {
    return Array;
  }

  get(id) {
    return this.find((sound) => sound.id === id);
  }

  has(id) {
    return Boolean(this.get(id));
  }

  remove(id) {
    const index = this.findIndex((sound) => sound.id === id);
    if (index >= 0) this.splice(index, 1);
  }

  get size() {
    return this.length;
  }
}

function makeSound({ id, parent, playing = false, flags = {}, deleteSound }) {
  return {
    id,
    name: id,
    parent,
    playing,
    getFlag(_scope, key) {
      return flags[key];
    },
    async delete() {
      if (deleteSound) return deleteSound(this);
      parent.sounds.remove(id);
    },
  };
}

function makeState({ source, gap, gapMs = 1000 }) {
  let resolved;
  return {
    sourceSound: source,
    sourceSoundId: source.id,
    gap,
    gapMs,
    startedAt: Date.now(),
    expectedEndAt: Date.now() + gapMs,
    cancelled: false,
    completed: false,
    abandoned: false,
    advancementComplete: false,
    completionAttempt: null,
    deletingForCompletion: false,
    timer: { cancel() {} },
    resolve(value) {
      resolved = value;
    },
    get resolved() {
      return resolved;
    },
  };
}

function installAuthority() {
  const gm = { id: "silence-gm-a", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];
  return gm;
}

test("failed silence advancement preserves and restores the gap for retry", async () => {
  const previous = { user: game.user, users: game.users, playlists: game.playlists };
  installAuthority();

  const calls = [];
  let rejectNext = true;
  let deleteCalls = 0;
  const playlist = {
    id: "silence-advance-failure",
    name: "Silence Advance Failure",
    isOwner: true,
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    playbackOrder: ["source", "next"],
    sounds: new SoundCollection(),
    getFlag() { return false; },
    async playSound(sound) {
      calls.push(sound.id);
      if (sound.id === "next" && rejectNext) {
        gap.playing = false;
        throw new Error("injected next-track rejection");
      }
      for (const entry of this.sounds) entry.playing = entry === sound;
      return sound;
    },
  };
  const source = makeSound({ id: "source", parent: playlist });
  const next = makeSound({ id: "next", parent: playlist });
  const gap = makeSound({
    id: "gap",
    parent: playlist,
    playing: true,
    flags: { isSilenceGap: true, gapDuration: 1000, gapStarted: Date.now(), gapSourceSoundId: source.id },
    deleteSound(sound) {
      deleteCalls += 1;
      playlist.sounds.remove(sound.id);
    },
  });
  playlist.sounds.push(source, gap, next);
  game.playlists = [playlist];
  const state = makeState({ source, gap });
  State.setSilenceState(playlist, state);

  try {
    assert.equal(await completeSilenceGap(playlist, state, { reason: "test" }), false);
    assert.deepEqual(calls, ["next", "gap"]);
    assert.equal(gap.playing, true);
    assert.equal(deleteCalls, 0);
    assert.equal(state.completed, false);
    assert.equal(state.advancementComplete, false);
    assert.equal(state.completionRetryCount, 1);
    assert.equal(state.resolved, undefined);
    assert.equal(State.getSilenceState(playlist), state);

    rejectNext = false;
    assert.equal(await completeSilenceGap(playlist, state, { reason: "retry" }), true);
    assert.deepEqual(calls, ["next", "gap", "next"]);
    assert.equal(deleteCalls, 1);
    assert.equal(state.completed, true);
    assert.equal(state.resolved, false);
    assert.equal(State.getSilenceState(playlist), undefined);
  } finally {
    State.clearSilenceState(playlist, state);
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

test("gap deletion failure reports failure and retry does not advance twice", async () => {
  const previous = { user: game.user, users: game.users, playlists: game.playlists };
  installAuthority();

  let nextPlayCalls = 0;
  let deleteCalls = 0;
  let rejectDelete = true;
  const playlist = {
    id: "silence-delete-failure",
    name: "Silence Delete Failure",
    isOwner: true,
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    playbackOrder: ["source", "next"],
    sounds: new SoundCollection(),
    getFlag() { return false; },
    async playSound(sound) {
      if (sound.id === "next") nextPlayCalls += 1;
      for (const entry of this.sounds) entry.playing = entry === sound;
      return sound;
    },
  };
  const source = makeSound({ id: "source", parent: playlist });
  const next = makeSound({ id: "next", parent: playlist });
  const gap = makeSound({
    id: "gap",
    parent: playlist,
    playing: true,
    flags: { isSilenceGap: true, gapDuration: 1000, gapStarted: Date.now(), gapSourceSoundId: source.id },
    deleteSound(sound) {
      deleteCalls += 1;
      if (rejectDelete) throw new Error("injected gap deletion rejection");
      playlist.sounds.remove(sound.id);
    },
  });
  playlist.sounds.push(source, gap, next);
  game.playlists = [playlist];
  const state = makeState({ source, gap });
  State.setSilenceState(playlist, state);

  try {
    assert.equal(await completeSilenceGap(playlist, state, { reason: "test" }), false);
    assert.equal(nextPlayCalls, 1);
    assert.equal(deleteCalls, 1);
    assert.equal(state.advancementComplete, true);
    assert.equal(state.completed, false);
    assert.equal(state.completionRetryCount, 1);
    assert.equal(state.resolved, undefined);
    assert.equal(State.getSilenceState(playlist), state);

    rejectDelete = false;
    assert.equal(await completeSilenceGap(playlist, state, { reason: "retry" }), true);
    assert.equal(nextPlayCalls, 1);
    assert.equal(deleteCalls, 2);
    assert.equal(state.completed, true);
    assert.equal(state.resolved, false);
    assert.equal(State.getSilenceState(playlist), undefined);
  } finally {
    State.clearSilenceState(playlist, state);
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

test("authority loss during silence advancement leaves the gap for takeover", async () => {
  const previous = { user: game.user, users: game.users, playlists: game.playlists };
  const gmA = installAuthority();
  const gmB = { id: "silence-gm-b", isGM: true, active: true };
  game.users = [gmA, gmB];

  let releaseAdvancement;
  let advancementStarted;
  const started = new Promise((resolve) => { advancementStarted = resolve; });
  let deleteCalls = 0;
  const playlist = {
    id: "silence-authority-loss",
    name: "Silence Authority Loss",
    isOwner: true,
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    playbackOrder: ["source", "next"],
    sounds: new SoundCollection(),
    getFlag() { return false; },
    async playSound(sound) {
      if (sound.id === "next") {
        advancementStarted();
        await new Promise((resolve) => { releaseAdvancement = resolve; });
      }
      return sound;
    },
  };
  const source = makeSound({ id: "source", parent: playlist });
  const next = makeSound({ id: "next", parent: playlist });
  const startedAt = Date.now();
  const gap = makeSound({
    id: "gap",
    parent: playlist,
    playing: true,
    flags: { isSilenceGap: true, gapDuration: 60000, gapStarted: startedAt, gapSourceSoundId: source.id },
    deleteSound(sound) {
      deleteCalls += 1;
      playlist.sounds.remove(sound.id);
    },
  });
  playlist.sounds.push(source, gap, next);
  game.playlists = [playlist];
  const state = makeState({ source, gap, gapMs: 60000 });
  State.setSilenceState(playlist, state);

  try {
    const completion = completeSilenceGap(playlist, state, { reason: "test" });
    await started;
    gmA.active = false;
    releaseAdvancement();

    assert.equal(await completion, false);
    assert.equal(deleteCalls, 0);
    assert.equal(playlist.sounds.has(gap.id), true);
    assert.equal(state.abandoned, true);
    assert.equal(state.resolved, true);
    assert.equal(State.getSilenceState(playlist), undefined);

    game.user = gmB;
    await recoverPersistedSilenceGaps("test authority takeover");
    const recovered = State.getSilenceState(playlist);
    assert.equal(recovered?.gap, gap);
    assert.equal(recovered?.sourceSound, source);
    assert.equal(recovered?.recovered, true);
    recovered?.timer?.cancel?.();
    State.clearSilenceState(playlist, recovered);
  } finally {
    State.clearSilenceState(playlist);
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});
