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
const { PlaybackClock } = await import("../scripts/playback-clock.js");
const {
  completeSilenceGap,
  recoverPersistedSilenceGaps,
} = await import("../scripts/silence.js");
const {
  getAdjacentPlayableSound,
  getPlayableSoundsInOrder,
  hasSilenceGapDocuments,
} = await import("../scripts/playlist/playable-order.js");
const {
  registerPlaylistAdvanceWrappers,
  registerPlaylistCommandWrappers,
} = await import("../scripts/playlist/playlist-command-wrappers.js");

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
    completionDecision: null,
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

function getSelectedSoundId(changes) {
  return changes?.sounds?.find((update) => update.playing)?.['_id'] ?? null;
}

function applyPlaylistUpdate(playlist, changes) {
  for (const update of changes?.sounds ?? []) {
    const sound = playlist.sounds.get(update._id);
    if (sound) Object.assign(sound, update);
  }
  if (Object.prototype.hasOwnProperty.call(changes ?? {}, "playing")) {
    playlist.playing = Boolean(changes.playing);
  } else {
    playlist.playing = playlist.sounds.some((sound) => sound.playing);
  }
  return playlist;
}

function captureSilenceEnd(playlist) {
  const events = [];
  const handler = (event) => {
    if (event?.playlist === playlist) events.push(event);
  };
  Hooks.on("the-sound-of-silence.silenceEnd", handler);
  return {
    events,
    stop() {
      Hooks.off("the-sound-of-silence.silenceEnd", handler);
    },
  };
}

function installAuthority() {
  const gm = { id: "silence-gm-a", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];
  return gm;
}

test("playable order excludes silence gaps in every raw position and preserves wrapping", () => {
  const rawOrders = [
    ["gap", "first", "second", "third"],
    ["first", "gap", "second", "third"],
    ["first", "second", "third", "gap"],
  ];

  for (const playbackOrder of rawOrders) {
    const playlist = {
      id: `playable-${playbackOrder.indexOf("gap")}`,
      playbackOrder,
      sounds: new SoundCollection(),
    };
    const first = makeSound({ id: "first", parent: playlist });
    const second = makeSound({ id: "second", parent: playlist });
    const third = makeSound({ id: "third", parent: playlist });
    const gap = makeSound({ id: "gap", parent: playlist, flags: { isSilenceGap: true } });
    // Embedded collection order can differ from the sequential playback order.
    playlist.sounds.push(third, second, first, gap);

    assert.deepEqual(
      getPlayableSoundsInOrder(playlist).map((sound) => sound.id),
      ["first", "second", "third"]
    );
    assert.equal(getAdjacentPlayableSound(playlist, "first", -1), third);
    assert.equal(getAdjacentPlayableSound(playlist, "third", 1), first);
    assert.equal(getAdjacentPlayableSound(playlist, "second", 1), third);
    assert.equal(hasSilenceGapDocuments(playlist), true);
  }
});

test("silence completion skips a gap embedded between its source and next real track", async () => {
  const previous = { user: game.user, users: game.users, playlists: game.playlists };
  installAuthority();

  const selections = [];
  const playlist = {
    id: "silence-middle-gap-order",
    name: "Silence Middle Gap Order",
    isOwner: true,
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    playbackOrder: ["first", "source", "gap", "next"],
    sounds: new SoundCollection(),
    getFlag() { return false; },
    async update(changes) {
      selections.push(getSelectedSoundId(changes));
      return applyPlaylistUpdate(this, changes);
    },
    async playSound() {
      throw new Error("natural silence completion must bypass playSound wrappers");
    },
    async stopAll() {
      throw new Error("natural silence completion must bypass stopAll wrappers");
    },
  };
  const first = makeSound({ id: "first", parent: playlist });
  const source = makeSound({ id: "source", parent: playlist });
  const next = makeSound({ id: "next", parent: playlist });
  const gap = makeSound({
    id: "gap",
    parent: playlist,
    playing: true,
    flags: { isSilenceGap: true, gapDuration: 1000, gapSourceSoundId: source.id },
  });
  playlist.sounds.push(first, source, gap, next);
  game.playlists = [playlist];
  const state = makeState({ source, gap });
  State.setSilenceState(playlist, state);
  const captured = captureSilenceEnd(playlist);

  try {
    assert.equal(await completeSilenceGap(playlist, state, { reason: "middle-order" }), true);
    assert.deepEqual(selections, ["next"]);
    assert.equal(next.playing, true);
    assert.equal(first.playing, false);
    assert.equal(source.playing, false);
    assert.equal(playlist.sounds.has(gap.id), false);
    assert.equal(state.resolved, false);
    assert.equal(State.getSilenceState(playlist), undefined);
    assert.deepEqual(captured.events.map(({ completed, cancelled }) => ({ completed, cancelled })), [
      { completed: true, cancelled: undefined },
    ]);
  } finally {
    captured.stop();
    State.clearSilenceState(playlist);
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

test("last-track silence completion loops to the first real track while the active gap is first in raw order", async () => {
  const previous = { user: game.user, users: game.users, playlists: game.playlists };
  installAuthority();

  const selections = [];
  const playlist = {
    id: "silence-loop-boundary",
    name: "Silence Loop Boundary",
    isOwner: true,
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    playbackOrder: ["gap", "first", "last"],
    sounds: new SoundCollection(),
    getFlag(_scope, key) { return key === "loopPlaylist"; },
    async update(changes) {
      selections.push(getSelectedSoundId(changes));
      return applyPlaylistUpdate(this, changes);
    },
    async playSound() {
      throw new Error("looping silence completion must bypass playSound wrappers");
    },
  };
  const first = makeSound({ id: "first", parent: playlist });
  const last = makeSound({ id: "last", parent: playlist });
  const gap = makeSound({
    id: "gap",
    parent: playlist,
    playing: true,
    flags: { isSilenceGap: true, gapDuration: 1000, gapSourceSoundId: last.id },
  });
  playlist.sounds.push(first, last, gap);
  game.playlists = [playlist];
  const state = makeState({ source: last, gap });
  State.setSilenceState(playlist, state);
  const captured = captureSilenceEnd(playlist);

  try {
    assert.equal(await completeSilenceGap(playlist, state, { reason: "loop-boundary" }), true);
    assert.deepEqual(selections, ["first"]);
    assert.equal(first.playing, true);
    assert.equal(last.playing, false);
    assert.equal(playlist.playing, true);
    assert.equal(playlist.sounds.has(gap.id), false);
    assert.equal(state.resolved, false);
    assert.equal(captured.events.length, 1);
    assert.equal(captured.events[0].completed, true);
  } finally {
    captured.stop();
    State.clearSilenceState(playlist);
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

test("last-track silence completion without looping stops naturally through an atomic update", async () => {
  const previous = { user: game.user, users: game.users, playlists: game.playlists };
  installAuthority();

  const selections = [];
  const playlist = {
    id: "silence-terminal-stop",
    name: "Silence Terminal Stop",
    isOwner: true,
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    playbackOrder: ["source", "gap"],
    sounds: new SoundCollection(),
    getFlag() { return false; },
    async update(changes) {
      selections.push(getSelectedSoundId(changes));
      return applyPlaylistUpdate(this, changes);
    },
    async stopAll() {
      throw new Error("natural terminal completion must bypass stopAll wrappers");
    },
  };
  const source = makeSound({ id: "source", parent: playlist });
  const gap = makeSound({
    id: "gap",
    parent: playlist,
    playing: true,
    flags: { isSilenceGap: true, gapDuration: 1000, gapSourceSoundId: source.id },
  });
  playlist.sounds.push(source, gap);
  game.playlists = [playlist];
  const state = makeState({ source, gap });
  State.setSilenceState(playlist, state);
  const captured = captureSilenceEnd(playlist);

  try {
    assert.equal(await completeSilenceGap(playlist, state, { reason: "terminal-stop" }), true);
    assert.deepEqual(selections, [null]);
    assert.equal(playlist.playing, false);
    assert.equal(source.playing, false);
    assert.equal(playlist.sounds.has(gap.id), false);
    assert.equal(state.resolved, false);
    assert.equal(captured.events.length, 1);
    assert.equal(captured.events[0].completed, true);
    assert.equal(captured.events[0].cancelled, undefined);
  } finally {
    captured.stop();
    State.clearSilenceState(playlist);
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

test("a stopped gap timer cleans its marker without replacing an already-playing real track", async () => {
  const previous = { user: game.user, users: game.users, playlists: game.playlists };
  installAuthority();

  let updateCalls = 0;
  const playlist = {
    id: "silence-stale-timer",
    name: "Silence Stale Timer",
    isOwner: true,
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    playbackOrder: ["source", "gap", "replacement"],
    sounds: new SoundCollection(),
    getFlag() { return false; },
    async update(changes) {
      updateCalls += 1;
      return applyPlaylistUpdate(this, changes);
    },
  };
  const source = makeSound({ id: "source", parent: playlist });
  const replacement = makeSound({ id: "replacement", parent: playlist, playing: true });
  const gap = makeSound({
    id: "gap",
    parent: playlist,
    playing: false,
    flags: { isSilenceGap: true, gapDuration: 1000, gapSourceSoundId: source.id },
  });
  playlist.sounds.push(source, gap, replacement);
  game.playlists = [playlist];
  const state = makeState({ source, gap });
  State.setSilenceState(playlist, state);

  try {
    assert.equal(await completeSilenceGap(playlist, state, { reason: "timer" }), true);
    assert.equal(updateCalls, 0);
    assert.equal(replacement.playing, true);
    assert.equal(playlist.playing, true);
    assert.equal(playlist.sounds.has(gap.id), false);
    assert.equal(State.getSilenceState(playlist), undefined);
    assert.equal(state.resolved, true);
  } finally {
    State.clearSilenceState(playlist);
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

test("manual Next and Previous wrappers cancel a gap and navigate relative to its source", async () => {
  const previousLibWrapper = globalThis.libWrapper;
  const previous = { user: game.user, users: game.users, playlists: game.playlists };
  const registrations = new Map();
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };
  installAuthority();
  registerPlaylistAdvanceWrappers();
  const playNext = registrations.get("Playlist.prototype.playNext");

  try {
    for (const { direction, expectedId, rawOrder } of [
      { direction: 1, expectedId: "next", rawOrder: ["previous", "source", "gap", "next"] },
      { direction: -1, expectedId: "previous", rawOrder: ["previous", "gap", "source", "next"] },
    ]) {
      let nativeCalls = 0;
      let timerCancelled = false;
      const selected = [];
      const playlist = {
        id: `silence-manual-${direction}`,
        name: `Silence Manual ${direction}`,
        isOwner: true,
        mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
        playing: true,
        playbackOrder: rawOrder,
        sounds: new SoundCollection(),
        getFlag(_scope, key) {
          return key === "silenceEnabled";
        },
        async playSound(sound) {
          selected.push(sound.id);
          for (const entry of this.sounds) entry.playing = entry === sound;
          this.playing = true;
          return this;
        },
        async stopAll() {
          this.playing = false;
          for (const entry of this.sounds) entry.playing = false;
          return this;
        },
      };
      const previousSound = makeSound({ id: "previous", parent: playlist });
      const source = makeSound({ id: "source", parent: playlist });
      const next = makeSound({ id: "next", parent: playlist });
      const gap = makeSound({
        id: "gap",
        parent: playlist,
        playing: true,
        flags: { isSilenceGap: true, gapDuration: 1000, gapSourceSoundId: source.id },
      });
      playlist.sounds.push(previousSound, source, gap, next);
      game.playlists = [playlist];
      const state = makeState({ source, gap });
      state.timer = {
        cancel() {
          timerCancelled = true;
        },
      };
      State.setSilenceState(playlist, state);
      const captured = captureSilenceEnd(playlist);

      try {
        const result = await playNext.call(
          playlist,
          async () => {
            nativeCalls += 1;
            return playlist;
          },
          null,
          { direction }
        );
        assert.equal(result, playlist);
        assert.deepEqual(selected, [expectedId]);
        assert.equal(nativeCalls, 0);
        assert.equal(timerCancelled, true);
        assert.equal(state.cancelled, true);
        assert.equal(state.resolved, true);
        assert.equal(State.getSilenceState(playlist), undefined);
        assert.equal(playlist.sounds.has(gap.id), false);
        assert.equal(playlist.sounds.get(expectedId)?.playing, true);
        assert.equal(await completeSilenceGap(playlist, state, { reason: "stale-manual-timer" }), false);
        assert.deepEqual(selected, [expectedId]);
        assert.deepEqual(captured.events.map(({ completed, cancelled }) => ({ completed, cancelled })), [
          { completed: false, cancelled: true },
        ]);
      } finally {
        captured.stop();
        State.clearSilenceState(playlist);
      }
    }
  } finally {
    globalThis.libWrapper = previousLibWrapper;
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

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
    async update(changes) {
      const selectedId = getSelectedSoundId(changes);
      calls.push(selectedId ?? "stop");
      if (selectedId === "next" && rejectNext) {
        throw new Error("injected next-track rejection");
      }
      return applyPlaylistUpdate(this, changes);
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

test("gap deletion failure completes naturally and background cleanup does not advance twice", async () => {
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
    async update(changes) {
      if (getSelectedSoundId(changes) === "next") nextPlayCalls += 1;
      return applyPlaylistUpdate(this, changes);
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
      if (rejectDelete) {
        rejectDelete = false;
        throw new Error("injected gap deletion rejection");
      }
      playlist.sounds.remove(sound.id);
    },
  });
  playlist.sounds.push(source, gap, next);
  game.playlists = [playlist];
  const state = makeState({ source, gap });
  State.setSilenceState(playlist, state);

  try {
    assert.equal(await completeSilenceGap(playlist, state, { reason: "test" }), true);
    assert.equal(nextPlayCalls, 1);
    assert.equal(deleteCalls, 1);
    assert.equal(state.advancementComplete, true);
    assert.equal(state.completed, true);
    assert.equal(state.resolved, false);
    assert.equal(State.getSilenceState(playlist), undefined);
    assert.equal(next.playing, true);
    assert.equal(gap.playing, false);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(nextPlayCalls, 1);
    assert.equal(deleteCalls, 2);
    assert.equal(playlist.sounds.has(gap.id), false);
  } finally {
    State.clearSilenceState(playlist, state);
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

test("Stop and Play wait for pending silence advancement before committing their selection", { timeout: 3000 }, async () => {
  const previousLibWrapper = globalThis.libWrapper;
  const previous = { user: game.user, users: game.users, playlists: game.playlists };
  const registrations = new Map();
  globalThis.libWrapper = {
    register(_module, target, callback) { registrations.set(target, callback); },
  };
  installAuthority();
  registerPlaylistCommandWrappers();
  const stopAll = registrations.get("Playlist.prototype.stopAll");
  const playSound = registrations.get("Playlist.prototype.playSound");

  try {
    for (const action of ["stop", "play"]) {
      for (const rejectAdvancement of [false, true]) {
        let releaseAdvancement;
        const advancementGate = new Promise((resolve) => { releaseAdvancement = resolve; });
        let advancementStarted;
        const started = new Promise((resolve) => { advancementStarted = resolve; });
        const selections = [];
        let stopTransition;
        let playbackClock = { soundId: "source" };
        const playlist = {
          id: `pending-advance-${action}-${rejectAdvancement}`,
          name: `Pending Advance ${action}`,
          isOwner: true,
          mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
          fade: 0,
          playing: true,
          playbackOrder: ["source", "gap", "next", "manual"],
          sounds: new SoundCollection(),
          getFlag(_scope, key) { return key === "playbackClock" ? playbackClock : undefined; },
          async setFlag(_scope, key, value) {
            if (key === "stopTransition") stopTransition = value;
            if (key === "playbackClock") playbackClock = value;
            return this;
          },
          async unsetFlag(_scope, key) {
            if (key === "playbackClock") playbackClock = null;
            return this;
          },
          async update(changes) {
            const selectedId = getSelectedSoundId(changes);
            selections.push(selectedId);
            if (selectedId === "next") {
              advancementStarted();
              await advancementGate;
              if (rejectAdvancement) throw new Error("pending advancement rejected");
            }
            const result = applyPlaylistUpdate(this, changes);
            for (const sound of this.sounds) {
              if (sound.sound) sound.sound.playing = sound.playing;
            }
            if (selectedId === "next") {
              // Model the start hooks publishing a clock and releasing the
              // stopping latch when the pending update finally arrives.
              State.clearStoppingFlag(this);
              await PlaybackClock.record(this, next, next.sound, { reason: "pending advancement" });
            }
            return result;
          },
          async updateEmbeddedDocuments(_type, updates) {
            return applyPlaylistUpdate(this, { sounds: updates });
          },
        };
        const source = makeSound({ id: "source", parent: playlist });
        const next = makeSound({ id: "next", parent: playlist });
        next.sound = {
          playing: false, currentTime: 0, duration: 120, stopCalls: 0,
          stop() { this.playing = false; this.stopCalls += 1; },
        };
        const manual = makeSound({ id: "manual", parent: playlist });
        const gap = makeSound({
          id: "gap", parent: playlist, playing: true,
          flags: { isSilenceGap: true, gapDuration: 1000, gapSourceSoundId: source.id },
        });
        playlist.sounds.push(source, gap, next, manual);
        game.playlists = [playlist];
        const state = makeState({ source, gap });
        State.setSilenceState(playlist, state);
        const captured = captureSilenceEnd(playlist);
        let reentrantCleanup;
        const reenter = (event) => {
          if (event.playlist !== playlist) return;
          reentrantCleanup = State.cleanup(playlist, {
            cleanSilence: true, cleanCrossfade: false, cleanLoopers: false, cleanSoundscape: false,
          });
        };
        Hooks.on("the-sound-of-silence.silenceEnd", reenter);

        try {
          const natural = completeSilenceGap(playlist, state, { reason: "pending-advance-test" });
          await started;
          const command = action === "stop"
            ? stopAll.call(playlist)
            : playSound.call(playlist, function (sound) {
              return this.update({
                playing: true,
                sounds: this.sounds.map((entry) => ({
                  _id: entry.id, playing: entry.id === sound.id, pausedTime: null,
                })),
              });
            }, manual);
          for (let attempt = 0; attempt < 20 && !state.cancelled; attempt += 1) {
            await Promise.resolve();
          }
          assert.equal(state.terminalOutcome, "cancelled");
          assert.equal(state.cancelled, true);
          assert.deepEqual(selections, ["next"], "the user selection must wait for the old update");

          releaseAdvancement();
          assert.equal(await natural, false);
          assert.equal(await command, playlist);
          await reentrantCleanup;
          assert.equal(state.resolved, true);
          assert.equal(state.terminalOutcome, "cancelled");
          assert.equal(state.completed, false);
          assert.equal(state.completionRetryCount ?? 0, 0);
          assert.equal(selections.includes("gap"), false, "a rejected cancelled update must not restore the gap");
          assert.equal(playlist.sounds.has(gap.id), false);
          assert.equal(State.getSilenceState(playlist), undefined);
          assert.deepEqual(captured.events.map(({ completed, cancelled }) => ({ completed, cancelled })), [
            { completed: false, cancelled: true },
          ]);
          if (action === "stop") {
            assert.equal(playlist.playing, false);
            assert.equal(playlist.sounds.some((sound) => sound.playing || sound.sound?.playing), false);
            assert.equal(PlaybackClock.get(playlist), null, "Stop must clear the clock written by pending advancement");
            assert.equal(State.isPlaylistStopping(playlist), true);
            if (!rejectAdvancement) {
              assert.equal(next.sound.stopCalls, 1, "Stop must stop the newly activated local media");
              assert.ok(stopTransition.soundIds.includes("next"));
            }
          } else {
            assert.deepEqual(playlist.sounds.filter((sound) => sound.playing).map((sound) => sound.id), ["manual"]);
          }
        } finally {
          releaseAdvancement();
          Hooks.off("the-sound-of-silence.silenceEnd", reenter);
          captured.stop();
          State.clearSilenceState(playlist);
          State.clearStoppingFlag(playlist);
        }
      }
    }
  } finally {
    globalThis.libWrapper = previousLibWrapper;
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

test("Stop and Play cleanup cannot cancel a natural completion whose gap deletion is pending", async () => {
  const previousLibWrapper = globalThis.libWrapper;
  const previous = { user: game.user, users: game.users, playlists: game.playlists };
  const registrations = new Map();
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };
  installAuthority();
  registerPlaylistCommandWrappers();
  const stopAll = registrations.get("Playlist.prototype.stopAll");
  const playSound = registrations.get("Playlist.prototype.playSound");

  try {
    for (const action of ["stop", "play"]) {
      let deletionStarted;
      const deletionStartedPromise = new Promise((resolve) => { deletionStarted = resolve; });
      let releaseDeletion;
      const deletionRelease = new Promise((resolve) => { releaseDeletion = resolve; });
      let deleteCalls = 0;
      const resolutionValues = [];
      const playlist = {
        id: `pending-natural-${action}`,
        name: `Pending Natural ${action}`,
        isOwner: true,
        mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
        fade: 0,
        playing: true,
        playbackOrder: ["source", "gap", "next", "manual"],
        sounds: new SoundCollection(),
        getFlag() { return false; },
        async setFlag() { return this; },
        async update(changes) {
          return applyPlaylistUpdate(this, changes);
        },
        async updateEmbeddedDocuments(_type, updates) {
          return applyPlaylistUpdate(this, { sounds: updates });
        },
      };
      const source = makeSound({ id: "source", parent: playlist });
      const next = makeSound({ id: "next", parent: playlist });
      const manual = makeSound({ id: "manual", parent: playlist });
      const gap = makeSound({
        id: "gap",
        parent: playlist,
        playing: true,
        flags: {
          isSilenceGap: true,
          gapDuration: 1000,
          gapStarted: Date.now(),
          gapSourceSoundId: source.id,
        },
        async deleteSound(sound) {
          deleteCalls += 1;
          deletionStarted();
          await deletionRelease;
          playlist.sounds.remove(sound.id);
        },
      });
      playlist.sounds.push(source, gap, next, manual);
      game.playlists = [playlist];
      const state = makeState({ source, gap });
      state.resolve = (value) => { resolutionValues.push(value); };
      State.setSilenceState(playlist, state);
      const captured = captureSilenceEnd(playlist);

      try {
        const naturalCompletion = completeSilenceGap(playlist, state, {
          reason: `pending-delete-${action}`,
        });
        await deletionStartedPromise;
        assert.equal(state.advancementComplete, true);
        assert.equal(state.deletingForCompletion, true);
        assert.equal(next.playing, true);
        assert.equal(gap.playing, false);

        let actionPromise;
        if (action === "stop") {
          actionPromise = stopAll.call(playlist);
        } else {
          actionPromise = playSound.call(
            playlist,
            async function (sound) {
              return applyPlaylistUpdate(this, {
                playing: true,
                sounds: Array.from(this.sounds).map((entry) => ({
                  _id: entry.id,
                  playing: entry.id === sound.id,
                  pausedTime: null,
                })),
              });
            },
            manual
          );
        }

        await Promise.resolve();
        releaseDeletion();
        assert.equal(await naturalCompletion, true);
        assert.equal(await actionPromise, playlist);

        assert.ok(deleteCalls >= 1);
        assert.equal(state.completed, true);
        assert.equal(state.cancelled, false);
        assert.deepEqual(resolutionValues, [false]);
        assert.deepEqual(captured.events.map(({ completed, cancelled }) => ({ completed, cancelled })), [
          { completed: true, cancelled: undefined },
        ]);
        assert.equal(State.getSilenceState(playlist), undefined);
        assert.equal(playlist.sounds.has(gap.id), false);
        if (action === "stop") {
          assert.equal(playlist.playing, false);
        } else {
          assert.equal(manual.playing, true);
          assert.equal(playlist.playing, true);
        }
      } finally {
        releaseDeletion();
        captured.stop();
        State.clearSilenceState(playlist);
        State.clearStoppingFlag(playlist);
      }
    }
  } finally {
    globalThis.libWrapper = previousLibWrapper;
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

test("authority loss after silence advancement preserves natural completion and leaves only an orphan marker", async () => {
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
    async update(changes) {
      if (getSelectedSoundId(changes) === "next") {
        advancementStarted();
        await new Promise((resolve) => { releaseAdvancement = resolve; });
      }
      return applyPlaylistUpdate(this, changes);
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

    assert.equal(await completion, true);
    assert.equal(deleteCalls, 0);
    assert.equal(playlist.sounds.has(gap.id), true);
    assert.equal(gap.playing, false);
    assert.equal(next.playing, true);
    assert.equal(state.completed, true);
    assert.equal(state.abandoned, false);
    assert.equal(state.resolved, false);
    assert.equal(State.getSilenceState(playlist), undefined);

    game.user = gmB;
    assert.equal(await recoverPersistedSilenceGaps("test authority takeover"), false);
    assert.equal(deleteCalls, 1);
    assert.equal(playlist.sounds.has(gap.id), false);
    assert.equal(State.getSilenceState(playlist), undefined);
  } finally {
    State.clearSilenceState(playlist);
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});
