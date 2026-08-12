import test from "node:test";
import assert from "node:assert/strict";

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const merge = (base, update) => {
  const result = clone(base) ?? {};
  for (const [key, value] of Object.entries(update ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = merge(result[key] ?? {}, value);
    } else {
      result[key] = clone(value);
    }
  }
  return result;
};

globalThis.foundry = {
  audio: {
    AudioTimeout: class AudioTimeout {
      static rejectOnCancel = false;

      constructor(duration = 0) {
        this.duration = duration;
        this.cancelled = false;
        this.rejectOnCancel = this.constructor.rejectOnCancel;
        this.complete = new Promise((resolve, reject) => {
          this._resolve = resolve;
          this._reject = reject;
        });
      }

      cancel() {
        if (this.cancelled) return;
        this.cancelled = true;
        if (this.rejectOnCancel) {
          this._reject(new Error("AudioTimeoutCancellation"));
          return;
        }
        // Foundry v14 catches AudioTimeoutCancellation internally, so the
        // public complete promise resolves after cancellation.
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
    deepClone: clone,
    duplicate: clone,
    mergeObject: merge,
  },
};
globalThis.Playlist = class Playlist {};
globalThis.PlaylistSound = class PlaylistSound {};
const hookListeners = new Map();
globalThis.Hooks = {
  on(name, callback) {
    const callbacks = hookListeners.get(name) ?? [];
    callbacks.push(callback);
    hookListeners.set(name, callbacks);
    return callback;
  },
  off(name, callback) {
    const callbacks = hookListeners.get(name) ?? [];
    hookListeners.set(name, callbacks.filter((entry) => entry !== callback));
  },
  callAll(name, ...args) {
    for (const callback of hookListeners.get(name) ?? []) callback(...args);
  },
};
globalThis.CONST = {
  PLAYLIST_MODES: {
    DISABLED: -1,
    SEQUENTIAL: 0,
    SHUFFLE: 1,
    SIMULTANEOUS: 2,
  },
};
globalThis.game = {
  settings: { get: () => false },
  users: [],
  user: { id: "test-player", isGM: false, active: true },
  playlists: [],
};
globalThis.ui = { playlists: { render() {} } };

const { Flags, sanitizeSoundscapeGroups } = await import("../scripts/flag-service.js");
const { safeStop } = await import("../scripts/utils.js");
const {
  activateCrossfadeSession,
  createCrossfadeSession,
  settleCrossfadeSession,
} = await import("../scripts/playback/transition-session.js");
const { performCrossfade } = await import("../scripts/cross-fade.js");
const { planCrossfadePreload } = await import("../scripts/playback/preload-coordinator.js");
const { State } = await import("../scripts/state-manager.js");
const { SoundscapeEngine } = await import("../scripts/procedural-ambience.js");
const { SoundscapePreviewer, SoundscapePreviewSession } = await import("../scripts/soundscape-previewer.js");
const { LoopingSound } = await import("../scripts/looping-sound.js");
const { LoopPreviewer, getLoopSegmentDurationError } = await import("../scripts/loop-previewer.js");
const {
  recoverPersistedSilenceGaps,
  registerSilenceRecoveryHooks,
  startSilenceGap,
} = await import("../scripts/silence.js");
const { AdvancedShuffle } = await import("../scripts/advanced-shuffle.js");
const { registerShuffleHooks } = await import("../scripts/playlist/shuffle-hooks.js");
const { registerPlaylistCommandWrappers } = await import("../scripts/playlist/playlist-command-wrappers.js");

class TestSoundCollection extends Array {
  static get [Symbol.species]() {
    return Array;
  }

  get(id) {
    return this.find((sound) => sound.id === id);
  }

  has(id) {
    return Boolean(this.get(id));
  }

  keys() {
    return this.map((sound) => sound.id).values();
  }

  remove(id) {
    const index = this.findIndex((sound) => sound.id === id);
    if (index >= 0) this.splice(index, 1);
  }
}

function makeTestSound({ id, parent, playing = false, flags = {}, sound = null }) {
  const document = {
    id,
    name: id,
    parent,
    playing,
    pausedTime: null,
    repeat: false,
    sound,
    getFlag(_scope, key) {
      return flags[key];
    },
    async delete() {
      parent.sounds.remove(id);
    },
  };
  return document;
}

test("loop validation caps segment count, preserves zero, and normalizes integers", () => {
  const segments = Array.from({ length: 20 }, (_, index) => ({
    label: `Segment ${index + 1}`,
    start: `00:${String(index).padStart(2, "0")}.000`,
    end: `00:${String(index + 1).padStart(2, "0")}.000`,
    crossfadeMs: index === 0 ? 0 : 250,
    loopCount: index === 0 ? 2.9 : 0,
  }));
  const validated = Flags.validateLoopConfig({
    enabled: true,
    active: true,
    startFromBeginning: true,
    segments,
  });

  assert.equal(validated.segments.length, 16);
  assert.equal(validated.segments[0].crossfadeMs, 0);
  assert.equal(validated.segments[0].loopCount, 2);
});

test("persistent loop config removes legacy and runtime-only keys", () => {
  const persistent = Flags.toPersistentLoopConfig({
    enabled: true,
    active: true,
    start: "00:01.000",
    end: "00:02.000",
    crossfadeMs: 0,
    loopCount: 3,
  });

  assert.deepEqual(Object.keys(persistent).sort(), ["active", "enabled", "segments", "startFromBeginning"]);
  assert.equal(persistent.segments.length, 1);
  assert.equal(persistent.segments[0].crossfadeMs, 0);
  assert.equal("startSec" in persistent.segments[0], false);
  assert.equal("endSec" in persistent.segments[0], false);
});

test("safeStop catches asynchronous stop rejection", async () => {
  const stopped = await safeStop({
    stop: () => Promise.reject(new Error("injected stop failure")),
  }, "regression test");
  assert.equal(stopped, false);
});

test("safeStop reports successful asynchronous cleanup", async () => {
  const stopped = await safeStop({ stop: () => Promise.resolve() }, "regression test");
  assert.equal(stopped, true);
});

test("pausing an active crossfade settles both media and clears transition ownership", async () => {
  const playlist = { id: "playlist-1", name: "Regression Playlist" };
  const outgoingDocument = { id: "outgoing" };
  const incomingDocument = { id: "incoming" };
  const outgoingSound = {
    playing: true,
    volume: 0.4,
    stop() {
      this.playing = false;
    },
  };
  const incomingSound = {
    playing: true,
    volume: 0.2,
    stop() {
      this.playing = false;
    },
  };

  const session = createCrossfadeSession({
    playlist,
    outgoingDocument,
    incomingDocument,
    outgoingSound,
    durationMs: 5000,
    outgoingTargetVolume: 0.8,
  });
  activateCrossfadeSession(session, {
    outgoingSound,
    incomingSound,
    incomingTargetVolume: 0.6,
  });

  const settled = await settleCrossfadeSession(playlist, {
    mode: "pause",
    reason: "regression test",
  });

  assert.equal(settled, true);
  assert.equal(session.status, "paused");
  assert.equal(outgoingSound.playing, false);
  assert.equal(incomingSound.playing, false);
  assert.equal(State.getCrossfadeSession(playlist), undefined);
  assert.equal(State.isPlaylistCrossfading(playlist), false);
});

test("a stale crossfade session cannot settle a newer transition", async () => {
  const playlist = { id: "playlist-2", name: "Replacement Playlist" };
  const first = createCrossfadeSession({
    playlist,
    outgoingDocument: { id: "a" },
    incomingDocument: { id: "b" },
  });
  const second = createCrossfadeSession({
    playlist,
    outgoingDocument: { id: "b" },
    incomingDocument: { id: "c" },
  });

  await first.settle({ mode: "complete", reason: "late completion" });

  assert.equal(State.getCrossfadeSession(playlist), second);
  assert.equal(State.isPlaylistCrossfading(playlist), true);
  await second.settle({ mode: "cancel", reason: "test cleanup" });
});

test("playlist cleanup cannot clear a replacement crossfade created during async settlement", async () => {
  const playlist = { id: "playlist-cleanup-race", name: "Cleanup Race Playlist" };
  let releaseStop;
  const stopPending = new Promise((resolve) => { releaseStop = resolve; });
  const first = createCrossfadeSession({
    playlist,
    outgoingDocument: { id: "cleanup-a" },
    incomingDocument: { id: "cleanup-b" },
    incomingSound: null,
  });
  first.incomingSound = {
    playing: true,
    stop() {
      this.playing = false;
      return stopPending;
    },
  };

  const cleanupPending = State.cleanup(playlist, {
    cleanSilence: false,
    cleanLoopers: false,
    cleanSoundscape: false,
  });
  for (let index = 0; index < 8 && first.status !== "settling"; index++) await Promise.resolve();
  assert.equal(first.status, "settling");

  const replacement = createCrossfadeSession({
    playlist,
    outgoingDocument: { id: "cleanup-b" },
    incomingDocument: { id: "cleanup-c" },
  });
  const replacementTimer = { cancel() {} };
  const replacementWaiter = { sound: { removeEventListener() {} }, onPlay() {} };
  State.setCrossfadeTimer(playlist, replacementTimer);
  State.setPlayWaiter(playlist, replacementWaiter);
  releaseStop();
  await cleanupPending;

  assert.equal(State.getCrossfadeSession(playlist), replacement);
  assert.equal(State.isPlaylistCrossfading(playlist), true);
  assert.equal(State.getCrossfadeTimer(playlist), replacementTimer);
  assert.equal(State.getPlayWaiter(playlist), replacementWaiter);
  State.clearCrossfadeTimer(playlist);
  State.clearPlayWaiter(playlist);
  await replacement.settle({ mode: "cancel", reason: "test cleanup" });
});

test("crossfade rolls back an incoming document when its session is cancelled during replication", async () => {
  const previous = {
    user: game.user,
    users: game.users,
    audio: game.audio,
  };
  const gm = { id: "gm-crossfade", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];
  game.audio = {
    locked: false,
    music: { state: "running", sampleRate: 48000 },
  };

  const playlist = {
    id: "crossfade-rollback-playlist",
    name: "Crossfade Rollback Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    isOwner: true,
    fade: 0,
    sounds: new TestSoundCollection(),
    getFlag(_scope, key) {
      return {
        crossfade: true,
        useCustomAutoFade: true,
        customAutoFadeMs: 1000,
      }[key];
    },
    async setFlag() {
      await settleCrossfadeSession(this, { mode: "cancel", reason: "injected stop during replication" });
      return this;
    },
  };
  const outgoing = makeTestSound({
    id: "rollback-outgoing",
    parent: playlist,
    playing: true,
    sound: {
      playing: false,
      volume: 0.5,
      stop() { this.playing = false; },
    },
  });
  const incomingUpdates = [];
  const incoming = makeTestSound({ id: "rollback-incoming", parent: playlist });
  incoming.update = async (changes, options = {}) => {
    incomingUpdates.push({ changes, options });
    Object.assign(incoming, changes);
    return incoming;
  };
  outgoing.update = async (changes) => {
    Object.assign(outgoing, changes);
    return outgoing;
  };
  playlist.sounds.push(outgoing, incoming);
  playlist.playbackOrder = [outgoing.id, incoming.id];

  try {
    const committed = await performCrossfade(playlist, outgoing, {
      recovery: true,
      reason: "rollback regression",
    });

    assert.equal(committed, false);
    assert.equal(outgoing.playing, true);
    assert.equal(incoming.playing, false);
    assert.equal(incomingUpdates.at(-1)?.options?._sosCrossfadeRollback, true);
  } finally {
    await settleCrossfadeSession(playlist, { mode: "cancel", reason: "test cleanup" });
    game.user = previous.user;
    game.users = previous.users;
    game.audio = previous.audio;
  }
});

test("a crossfade that completes while replication is pending still commits its documents", async () => {
  const previous = {
    user: game.user,
    users: game.users,
    audio: game.audio,
  };
  const gm = { id: "gm-short-crossfade", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];
  game.audio = {
    locked: false,
    music: { state: "running", sampleRate: 48000 },
  };

  let completedSession = null;
  const playlist = {
    id: "crossfade-short-playlist",
    name: "Short Crossfade Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    isOwner: true,
    fade: 0,
    sounds: new TestSoundCollection(),
    getFlag(_scope, key) {
      return {
        crossfade: true,
        useCustomAutoFade: true,
        customAutoFadeMs: 25,
      }[key];
    },
    async setFlag() {
      completedSession = State.getCrossfadeSession(this);
      assert.ok(completedSession?.completionTimer, "completion timer should be armed during replication");
      completedSession.completionTimer._resolve();
      await completedSession.completionTimer.complete;
      for (let index = 0; index < 16 && completedSession.status !== "completed"; index++) {
        await Promise.resolve();
      }
      return this;
    },
  };
  const outgoingMedia = {
    playing: true,
    volume: 0.5,
    stop() { this.playing = false; },
  };
  const outgoing = makeTestSound({
    id: "short-outgoing",
    parent: playlist,
    playing: true,
    sound: outgoingMedia,
  });
  const incoming = makeTestSound({
    id: "short-incoming",
    parent: playlist,
  });
  outgoing.update = async (changes) => {
    Object.assign(outgoing, changes);
    return outgoing;
  };
  incoming.update = async (changes) => {
    Object.assign(incoming, changes);
    return incoming;
  };
  playlist.sounds.push(outgoing, incoming);
  playlist.playbackOrder = [outgoing.id, incoming.id];

  try {
    const committed = await performCrossfade(playlist, outgoing, {
      recovery: true,
      reason: "short replication regression",
    });
    assert.equal(completedSession?.status, "completed");
    assert.equal(committed, true);
    assert.equal(outgoing.playing, false);
    assert.equal(incoming.playing, true);
  } finally {
    await settleCrossfadeSession(playlist, { mode: "cancel", reason: "test cleanup" });
    game.user = previous.user;
    game.users = previous.users;
    game.audio = previous.audio;
  }
});

test("a completed crossfade cannot commit or roll back after a replacement claims replication", async () => {
  const previous = {
    user: game.user,
    users: game.users,
    audio: game.audio,
  };
  const gm = { id: "gm-replacement-crossfade", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];
  game.audio = {
    locked: false,
    music: { state: "running", sampleRate: 48000 },
  };

  let completedSession = null;
  let replacementSession = null;
  const playlist = {
    id: "crossfade-replacement-playlist",
    name: "Crossfade Replacement Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    isOwner: true,
    fade: 0,
    sounds: new TestSoundCollection(),
    getFlag(_scope, key) {
      return {
        crossfade: true,
        useCustomAutoFade: true,
        customAutoFadeMs: 25,
      }[key];
    },
    async setFlag() {
      completedSession = State.getCrossfadeSession(this);
      assert.ok(completedSession?.completionTimer, "completion timer should be armed during replication");
      completedSession.completionTimer._resolve();
      await completedSession.completionTimer.complete;
      for (let index = 0; index < 16 && completedSession.status !== "completed"; index++) {
        await Promise.resolve();
      }
      replacementSession = createCrossfadeSession({
        playlist: this,
        outgoingDocument: incoming,
        incomingDocument: { id: "replacement-target" },
      });
      return this;
    },
  };
  const outgoing = makeTestSound({
    id: "replacement-outgoing",
    parent: playlist,
    playing: true,
    sound: {
      playing: true,
      volume: 0.5,
      stop() { this.playing = false; },
    },
  });
  const incoming = makeTestSound({
    id: "replacement-incoming",
    parent: playlist,
  });
  outgoing.update = async (changes) => {
    Object.assign(outgoing, changes);
    return outgoing;
  };
  incoming.update = async (changes) => {
    Object.assign(incoming, changes);
    return incoming;
  };
  playlist.sounds.push(outgoing, incoming);
  playlist.playbackOrder = [outgoing.id, incoming.id];

  try {
    const committed = await performCrossfade(playlist, outgoing, {
      recovery: true,
      reason: "replacement replication regression",
    });

    assert.equal(completedSession?.status, "completed");
    assert.equal(committed, false);
    assert.equal(State.getCrossfadeSession(playlist), replacementSession);
    assert.equal(outgoing.playing, true);
    assert.equal(incoming.playing, true);
  } finally {
    await replacementSession?.settle({ mode: "cancel", reason: "test cleanup" });
    game.user = previous.user;
    game.users = previous.users;
    game.audio = previous.audio;
  }
});

test("silence state compare-and-clear cannot erase a replacement generation", () => {
  const playlist = { id: "silence-playlist", name: "Silence Playlist" };
  const first = { id: "first-generation" };
  const second = { id: "second-generation" };

  State.setSilenceState(playlist, first);
  State.setSilenceState(playlist, second);

  assert.equal(State.clearSilenceState(playlist, first), false);
  assert.equal(State.getSilenceState(playlist), second);
  assert.equal(State.clearSilenceState(playlist, second), true);
  assert.equal(State.getSilenceState(playlist), undefined);
});

test("silence startup is single-flight before embedded document creation resolves", async () => {
  const previous = {
    user: game.user,
    users: game.users,
    playlists: game.playlists,
  };
  const gm = { id: "gm-a", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];

  let resolveCreation;
  let creationCalls = 0;
  const playlist = {
    id: "single-flight-playlist",
    name: "Single Flight Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    sounds: new TestSoundCollection(),
    getFlag(_scope, key) {
      return {
        silenceMode: "static",
        silenceDuration: 60000,
      }[key];
    },
    createEmbeddedDocuments() {
      creationCalls += 1;
      return new Promise((resolve) => { resolveCreation = resolve; });
    },
    async playSound(sound) {
      sound.playing = true;
      return sound;
    },
  };
  game.playlists = [playlist];
  const source = makeTestSound({ id: "source", parent: playlist });
  playlist.sounds.push(source);

  try {
    const firstAttempt = startSilenceGap(playlist, source);
    const duplicateAttempt = await startSilenceGap(playlist, source);

    assert.equal(creationCalls, 1);
    assert.equal(duplicateAttempt.started, true);
    assert.equal(duplicateAttempt.reason, "already-active");

    const startedAt = Date.now();
    const gap = makeTestSound({
      id: "single-flight-gap",
      parent: playlist,
      playing: true,
      sound: {},
      flags: {
        isSilenceGap: true,
        gapDuration: 60000,
        gapStarted: startedAt,
        gapSourceSoundId: source.id,
      },
    });
    playlist.sounds.push(gap);
    resolveCreation([gap]);

    const firstTransition = await firstAttempt;
    assert.equal(firstTransition.started, true);
    assert.equal(State.getSilenceState(playlist)?.gap, gap);

    await State.cleanup(playlist, {
      cleanSilence: true,
      cleanCrossfade: false,
      cleanLoopers: false,
      cleanSoundscape: false,
    });
    assert.equal(State.getSilenceState(playlist), undefined);
    assert.equal(await firstTransition.completion, true);
  } finally {
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

test("userConnected authority handoff reconstructs only an active persisted silence gap", async () => {
  const previous = {
    user: game.user,
    users: game.users,
    playlists: game.playlists,
  };
  const gmA = { id: "gm-a", isGM: true, active: true };
  const gmB = { id: "gm-b", isGM: true, active: true };
  game.user = gmB;
  game.users = [gmA, gmB];

  const playlist = {
    id: "authority-gap-playlist",
    name: "Authority Gap Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    sounds: new TestSoundCollection(),
    getFlag() { return undefined; },
  };
  const source = makeTestSound({ id: "gap-source", parent: playlist });
  const startedAt = Date.now();
  const gap = makeTestSound({
    id: "authority-gap",
    parent: playlist,
    playing: true,
    sound: {},
    flags: {
      isSilenceGap: true,
      gapDuration: 60000,
      gapStarted: startedAt,
      gapSourceSoundId: source.id,
    },
  });
  playlist.sounds.push(source, gap);
  game.playlists = [playlist];

  let abandonedTimerCancelled = false;
  State.setSilenceState(playlist, {
    timer: { cancel() { abandonedTimerCancelled = true; } },
    resolve() {},
  });

  try {
    registerSilenceRecoveryHooks();
    await recoverPersistedSilenceGaps("non-authority test");
    assert.equal(abandonedTimerCancelled, true);
    assert.equal(State.getSilenceState(playlist), undefined);

    gmA.active = false;
    Hooks.callAll("userConnected", gmA, false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recoverPersistedSilenceGaps("test queue drain");

    const recovered = State.getSilenceState(playlist);
    assert.equal(recovered?.gap, gap);
    assert.equal(recovered?.sourceSound, source);
    assert.equal(recovered?.recovered, true);

    await State.cleanup(playlist, {
      cleanSilence: true,
      cleanCrossfade: false,
      cleanLoopers: false,
      cleanSoundscape: false,
    });
  } finally {
    State.clearSilenceState(playlist);
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

test("authority handoff during silence creation preserves the persisted gap for takeover", async () => {
  const previous = {
    user: game.user,
    users: game.users,
    playlists: game.playlists,
  };
  const gmA = { id: "gm-a", isGM: true, active: true };
  const gmB = { id: "gm-b", isGM: true, active: true };
  game.user = gmA;
  game.users = [gmA, gmB];

  let resolveCreation;
  const playlist = {
    id: "creation-handoff-playlist",
    name: "Creation Handoff Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    sounds: new TestSoundCollection(),
    getFlag(_scope, key) {
      return {
        silenceMode: "static",
        silenceDuration: 60000,
      }[key];
    },
    createEmbeddedDocuments() {
      return new Promise((resolve) => { resolveCreation = resolve; });
    },
    async playSound(sound) {
      sound.playing = true;
      return sound;
    },
  };
  const source = makeTestSound({ id: "handoff-source", parent: playlist });
  playlist.sounds.push(source);
  game.playlists = [playlist];

  try {
    const pendingStart = startSilenceGap(playlist, source);
    gmA.active = false;
    await recoverPersistedSilenceGaps("old authority relinquished");

    const gap = makeTestSound({
      id: "handoff-created-gap",
      parent: playlist,
      playing: true,
      sound: {},
      flags: {
        isSilenceGap: true,
        gapDuration: 60000,
        gapStarted: Date.now(),
        gapSourceSoundId: source.id,
      },
    });
    playlist.sounds.push(gap);
    resolveCreation([gap]);

    const oldTransition = await pendingStart;
    assert.equal(oldTransition.started, false);
    assert.equal(oldTransition.reason, "authority-changed");
    assert.equal(playlist.sounds.has(gap.id), true);

    game.user = gmB;
    Hooks.callAll("createPlaylistSound", gap);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(State.getSilenceState(playlist)?.gap, gap);

    await State.cleanup(playlist, {
      cleanSilence: true,
      cleanCrossfade: false,
      cleanLoopers: false,
      cleanSoundscape: false,
    });
  } finally {
    State.clearSilenceState(playlist);
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

test("persisted silence recovery deletes a stopped orphan instead of resurrecting it", async () => {
  const previous = {
    user: game.user,
    users: game.users,
    playlists: game.playlists,
  };
  const gm = { id: "gm-orphan", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];

  const playlist = {
    id: "orphan-gap-playlist",
    name: "Orphan Gap Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    sounds: new TestSoundCollection(),
    getFlag() { return undefined; },
  };
  const normal = makeTestSound({ id: "normal-playing", parent: playlist, playing: true });
  const gap = makeTestSound({
    id: "stopped-gap",
    parent: playlist,
    playing: false,
    flags: {
      isSilenceGap: true,
      gapDuration: 60000,
      gapStarted: Date.now(),
    },
  });
  playlist.sounds.push(normal, gap);
  game.playlists = [playlist];

  try {
    const recovered = await recoverPersistedSilenceGaps("orphan regression");
    assert.equal(recovered, false);
    assert.equal(playlist.sounds.has(gap.id), false);
    assert.equal(State.getSilenceState(playlist), undefined);
  } finally {
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

test("playlist command wrappers preserve Promise results and clear Stop All latch on direct play", async () => {
  const registrations = new Map();
  const previousLibWrapper = globalThis.libWrapper;
  const previous = {
    user: game.user,
    users: game.users,
    settingsGet: game.settings.get,
  };
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };
  game.user = { id: "player", isGM: false, active: true };
  game.users = [game.user];
  game.settings.get = () => false;

  const playlist = {
    id: "stop-contract-playlist",
    name: "Stop Contract Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    fade: 0,
    playing: false,
    isOwner: false,
    sounds: new TestSoundCollection(),
    getFlag() { return undefined; },
  };

  try {
    registerPlaylistCommandWrappers();
    const stopAll = registrations.get("Playlist.prototype.stopAll");
    const playSound = registrations.get("Playlist.prototype.playSound");
    const stopSound = registrations.get("Playlist.prototype.stopSound");

    const stopResultPromise = stopAll.call(playlist);
    assert.equal(typeof stopResultPromise?.then, "function");
    assert.equal(await stopResultPromise, playlist);
    assert.equal(State.isPlaylistStopping(playlist), true);

    const sound = makeTestSound({ id: "direct-track", parent: playlist });
    const nativeResult = { native: true };
    assert.equal(
      await playSound.call(playlist, async () => nativeResult, sound),
      nativeResult
    );
    assert.equal(State.isPlaylistStopping(playlist), false);

    playlist.playing = true;
    const escalatedPromise = Promise.resolve("stopped");
    playlist.stopAll = () => escalatedPromise;
    assert.equal(stopSound.call(playlist, () => "native", sound), escalatedPromise);
    assert.equal(await escalatedPromise, "stopped");

    // Advanced shuffle advancement is owned by only the deterministic primary GM.
    const gmA = { id: "gm-a", isGM: true, active: true };
    const gmB = { id: "gm-b", isGM: true, active: true };
    game.user = gmB;
    game.users = [gmA, gmB];
    game.settings.get = (_module, key) => key === "shufflePattern" ? "exhaustive" : false;
    playlist.mode = CONST.PLAYLIST_MODES.SHUFFLE;
    let nativeEndCalls = 0;
    const onEnd = registrations.get("PlaylistSound.prototype._onEnd");
    assert.equal(onEnd.call(sound, () => { nativeEndCalls += 1; }), undefined);
    assert.equal(nativeEndCalls, 0);
  } finally {
    State.clearStoppingFlag(playlist);
    globalThis.libWrapper = previousLibWrapper;
    game.user = previous.user;
    game.users = previous.users;
    game.settings.get = previous.settingsGet;
  }
});

test("shuffle stop and actual GM-authority changes reset deterministic local cycle state", async () => {
  const registrations = new Map();
  const previousLibWrapper = globalThis.libWrapper;
  const previous = {
    playlists: game.playlists,
    settingsGet: game.settings.get,
    user: game.user,
    users: game.users,
  };
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };
  game.settings.get = (_module, key) => key === "shufflePattern" ? "exhaustive" : false;
  const primary = { id: "gm-a", isGM: true, active: true };
  const secondary = { id: "gm-b", isGM: true, active: true };
  game.user = primary;
  game.users = [primary, secondary];

  const makePlaylist = (seed) => {
    const playlist = {
      id: "stable-shuffle-playlist",
      seed,
      name: "Stable Shuffle Playlist",
      mode: CONST.PLAYLIST_MODES.SHUFFLE,
      playing: true,
      isOwner: false,
      sounds: new TestSoundCollection(),
      getFlag() { return undefined; },
    };
    playlist.sounds.push(
      makeTestSound({ id: "one", parent: playlist }),
      makeTestSound({ id: "two", parent: playlist }),
      makeTestSound({ id: "three", parent: playlist }),
      makeTestSound({ id: "four", parent: playlist })
    );
    return playlist;
  };
  const first = makePlaylist(42);
  const second = makePlaylist(42);

  try {
    registerShuffleHooks();
    assert.deepEqual(
      AdvancedShuffle.generateOrder(first),
      AdvancedShuffle.generateOrder(second),
      "the synchronized Foundry seed must produce the same module order on every client"
    );

    const cachedOrder = [...AdvancedShuffle.generateOrder(first)];
    first.seed = 9999;
    assert.deepEqual(
      AdvancedShuffle.generateOrder(first),
      cachedOrder,
      "an in-progress module cycle must remain stable until its explicit reset"
    );

    Hooks.callAll("updatePlaylist", first, { playing: false });
    assert.equal(State.getShuffleState(first), undefined);

    AdvancedShuffle.generateOrder(first);
    game.playlists = [first];
    secondary.active = false;
    Hooks.callAll("userConnected", secondary, false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.notEqual(State.getShuffleState(first), undefined, "secondary GM changes must preserve the cycle");

    primary.active = false;
    secondary.active = true;
    Hooks.callAll("userConnected", primary, false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(State.getShuffleState(first), undefined);
  } finally {
    AdvancedShuffle.reset(first);
    AdvancedShuffle.reset(second);
    globalThis.libWrapper = previousLibWrapper;
    game.playlists = previous.playlists;
    game.settings.get = previous.settingsGet;
    game.user = previous.user;
    game.users = previous.users;
  }
});

test("crossfade preload defers to Foundry when its native window is early enough", () => {
  const plan = planCrossfadePreload({
    durationSec: 120,
    currentTimeSec: 1,
    fadeMs: 5000,
    nativeLeadSec: 20,
    safetyLeadSec: 5,
  });

  assert.equal(plan.needed, false);
  assert.equal(plan.status, "native-sufficient");
  assert.equal(plan.nativeAtSec, 100);
  assert.equal(plan.desiredAtSec, 110);
});

test("long crossfades schedule preloading before Foundry's native window", () => {
  const plan = planCrossfadePreload({
    durationSec: 120,
    currentTimeSec: 10,
    fadeMs: 30000,
    nativeLeadSec: 20,
    safetyLeadSec: 5,
  });

  assert.equal(plan.needed, true);
  assert.equal(plan.status, "schedule");
  assert.equal(plan.desiredAtSec, 85);
  assert.equal(plan.nativeAtSec, 100);
});

test("late preload planning loads immediately instead of scheduling in the past", () => {
  const plan = planCrossfadePreload({
    durationSec: 120,
    currentTimeSec: 90,
    fadeMs: 30000,
    nativeLeadSec: 20,
    safetyLeadSec: 5,
  });

  assert.equal(plan.needed, true);
  assert.equal(plan.status, "load-now");
});

test("soundscape group validation clamps values, sanitizes ids, and de-duplicates", () => {
  const groups = sanitizeSoundscapeGroups([
    { id: "weather rain", name: "<b>Rain</b>", maxPolyphony: 99, cooldownSec: -5 },
    { id: "weather-rain", name: "", maxPolyphony: 0, cooldownSec: 9999 },
  ]);

  assert.deepEqual(groups, [
    { id: "weather-rain", name: "Rain", maxPolyphony: 16, cooldownSec: 0 },
    { id: "weather-rain-2", name: "Group 2", maxPolyphony: 1, cooldownSec: 3600 },
  ]);
});

test("soundscape group cooldown is bypassable but group polyphony is not", () => {
  const playlist = new Playlist();
  playlist.id = "soundscape-playlist";
  playlist.name = "Grouped Soundscape";
  playlist.mode = CONST.PLAYLIST_MODES.DISABLED;
  playlist.getFlag = (_scope, key) => ({
    soundscapeMode: true,
    soundscapeGroups: [{
      id: "weather",
      name: "Weather",
      maxPolyphony: 1,
      cooldownSec: 10,
    }],
  })[key];

  const sound = new PlaylistSound();
  sound.id = "thunder";
  sound.name = "Thunder";
  sound.parent = playlist;
  sound.volume = 0.5;
  sound.getFlag = (_scope, key) => ({
    isProcedural: true,
    soundscapeGroupId: "weather",
  })[key];

  const engine = new SoundscapeEngine(playlist);
  engine._markGroupCompleted("weather");

  assert.equal(engine._getGroupGate(sound)?.reason, "group-cooldown");
  assert.equal(engine._getGroupGate(sound, { bypassCooldown: true }), null);

  engine._reserveOneShot(sound.id, "weather");
  assert.equal(
    engine._getGroupGate(sound, { bypassCooldown: true })?.reason,
    "group-polyphony"
  );
  engine._releaseOneShotReservation(sound.id, "weather");
});

test("synced soundscape fire recipes carry the authority-approved group id", () => {
  const playlist = new Playlist();
  playlist.id = "recipe-playlist";
  playlist.name = "Recipe Soundscape";
  playlist.getFlag = (_scope, key) => ({
    soundscapeGroups: [{
      id: "birds",
      name: "Birds",
      maxPolyphony: 2,
      cooldownSec: 3,
    }],
    volumeNormalizationEnabled: false,
  })[key];

  const sound = new PlaylistSound();
  sound.id = "owl";
  sound.parent = playlist;
  sound.volume = 0.4;
  sound.getFlag = (_scope, key) => ({
    soundscapeGroupId: "birds",
  })[key];

  const engine = new SoundscapeEngine(playlist);
  const recipe = engine._createFireRecipe(sound, { synced: true });
  const normalized = engine._normalizeFireRecipe(recipe, sound);

  assert.equal(recipe.groupId, "birds");
  assert.equal(normalized.groupId, "birds");
});

test("soundscape preview reads namespaced unsaved overrides", () => {
  class TestPlaylist extends Playlist {
    constructor() {
      super();
      this.id = "preview-playlist";
      this.sounds = [];
    }

    getFlag() {
      return undefined;
    }
  }

  const session = new SoundscapePreviewSession(new TestPlaylist(), {
    configOverrides: {
      flags: {
        "the-sound-of-silence": {
          soundscapeMaxPolyphony: 9,
          soundscapePlayChanceScaling: "soft",
        },
      },
    },
  });

  assert.equal(session.maxPolyphony, 9);
  assert.equal(session._getPlaylistFlag("soundscapePlayChanceScaling"), "soft");
});

test("soundscape preview enforces unsaved group polyphony and cooldown", () => {
  class TestPlaylist extends Playlist {
    constructor() {
      super();
      this.id = "preview-groups";
      this.sounds = [];
    }

    getFlag() {
      return undefined;
    }
  }

  class TestSound extends PlaylistSound {
    constructor(parent) {
      super();
      this.id = "rain-sound";
      this.parent = parent;
    }

    getFlag(_scope, key) {
      return key === "soundscapeGroupId" ? "rain" : undefined;
    }
  }

  const playlist = new TestPlaylist();
  const sound = new TestSound(playlist);
  const session = new SoundscapePreviewSession(playlist, {
    configOverrides: {
      flags: {
        "the-sound-of-silence": {
          soundscapeGroups: [{
            id: "rain",
            name: "Rain",
            maxPolyphony: 1,
            cooldownSec: 5,
          }],
        },
      },
    },
  });

  const group = session._resolveGroup(sound);
  assert.equal(group?.id, "rain");
  assert.equal(session._getGroupGate(group), null);

  session._incrementActiveGroup(group.id);
  assert.equal(session._getGroupGate(group)?.reason, "group-polyphony");
  session._decrementActiveGroup(group.id);

  session._markGroupCompleted(group.id);
  assert.equal(session._getGroupGate(group)?.reason, "group-cooldown");
});

test("cancelling a soundscape preview timer cannot fire after Foundry resolves it", async () => {
  class TestPlaylist extends Playlist {
    constructor() {
      super();
      this.id = "preview-cancel";
      this.sounds = [];
    }

    getFlag() {
      return undefined;
    }
  }

  const playlist = new TestPlaylist();
  const sound = {
    id: "cancelled-one-shot",
    name: "Cancelled One Shot",
    playing: true,
  };
  const session = new SoundscapePreviewSession(playlist);
  let fired = 0;
  session._pickDelayMs = () => 1000;
  session._fireOneShot = async () => {
    fired += 1;
    return true;
  };

  session._armOneShot(sound);
  session.stop();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(fired, 0);
});

test("an older failed soundscape preview cannot remove its replacement session", async () => {
  const previous = {
    user: game.user,
    audio: game.audio,
    notifications: globalThis.ui.notifications,
  };
  game.user = { id: "preview-gm", isGM: true, active: true };
  let notificationErrors = 0;
  globalThis.ui.notifications = {
    info() {},
    warn() {},
    error() { notificationErrors += 1; },
  };

  let rejectFirstUnlock;
  game.audio = {
    locked: true,
    unlock: new Promise((_resolve, reject) => { rejectFirstUnlock = reject; }),
  };
  const sound = {
    id: "preview-procedural",
    name: "Preview Procedural",
    volume: 0.5,
    getFlag(_scope, key) {
      return key === "isProcedural" ? true : undefined;
    },
  };
  const playlist = {
    id: "preview-replacement",
    name: "Preview Replacement",
    playing: false,
    sounds: [sound],
    getFlag(_scope, key) {
      return key === "soundscapeMode" ? true : undefined;
    },
  };

  try {
    const firstStart = SoundscapePreviewer.start(playlist);
    await Promise.resolve();

    game.audio = { locked: false };
    const secondStart = SoundscapePreviewer.start(playlist);
    assert.equal(await secondStart, true);
    assert.equal(SoundscapePreviewer.isPreviewing(playlist), true);

    rejectFirstUnlock(new Error("injected older unlock failure"));
    assert.equal(await firstStart, false);
    assert.equal(SoundscapePreviewer.isPreviewing(playlist), true);
    assert.equal(notificationErrors, 0);
    assert.equal(SoundscapePreviewer.stop(playlist, { notify: false }), true);
  } finally {
    SoundscapePreviewer.stopAll({ notify: false });
    rejectFirstUnlock?.(new Error("test cleanup"));
    game.user = previous.user;
    game.audio = previous.audio;
    globalThis.ui.notifications = previous.notifications;
  }
});

test("cancelling a restarted-loop settle timer cannot arm a stale precise schedule", async () => {
  const segment = {
    start: "00:01.000",
    end: "00:10.000",
    startSec: 1,
    endSec: 10,
    crossfadeMs: 1000,
    loopCount: 0,
  };
  let scheduleCalls = 0;
  const activeSound = {
    id: "hybrid-source",
    playing: true,
    currentTime: 2,
    volume: 0.5,
    schedule() {
      scheduleCalls += 1;
      return { cancel() {} };
    },
    stop() { this.playing = false; },
  };
  const playlistSound = {
    id: "hybrid-loop",
    name: "Hybrid Ownership",
    playing: true,
    volume: 0.5,
    sound: activeSound,
    parent: { id: "hybrid-playlist" },
  };
  const looper = new LoopingSound(playlistSound, { segments: [segment] });
  looper.soundA = activeSound;
  looper.activeLoopSegment = segment;
  looper.wasRestarted = true;

  looper._armCrossfadeLoop();
  const settleTimer = looper.loopCrossfadeTimer;
  assert.ok(settleTimer, "hybrid settle timer should be armed");

  looper.pause();
  await settleTimer.complete;
  await Promise.resolve();

  assert.equal(scheduleCalls, 0);
  assert.equal(looper.loopCrossfadeTimer, null);
});

test("a cancelled failed precise loop schedule cannot arm or fire its fallback", async () => {
  const segment = {
    start: "00:01.000",
    end: "00:10.000",
    startSec: 1,
    endSec: 10,
    crossfadeMs: 1000,
    loopCount: 0,
  };
  let rejectSchedule;
  const preciseTimer = new Promise((_resolve, reject) => { rejectSchedule = reject; });
  preciseTimer.cancel = () => {};
  const activeSound = {
    id: "fallback-source",
    playing: true,
    currentTime: 2,
    volume: 0.5,
    schedule() { return preciseTimer; },
    stop() { this.playing = false; },
  };
  const playlistSound = {
    id: "fallback-loop",
    name: "Fallback Ownership",
    playing: true,
    volume: 0.5,
    sound: activeSound,
    parent: { id: "fallback-playlist" },
  };
  const looper = new LoopingSound(playlistSound, { segments: [segment] });
  looper.soundA = activeSound;
  looper.activeLoopSegment = segment;
  let crossfadeCalls = 0;
  looper._performCrossfadeLoop = async () => { crossfadeCalls += 1; };

  looper._armCrossfadeLoop();
  assert.equal(looper.loopCrossfadeTimer, preciseTimer);
  looper.pause();
  rejectSchedule(new Error("injected schedule cancellation"));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(looper.loopCrossfadeTimer, null);
  assert.equal(crossfadeCalls, 0);
});

test("resolved AudioTimeout cancellation cannot promote a stopped loop buffer", async () => {
  const makeGain = (value) => ({
    value,
    cancelAndHoldAtTime() {},
    cancelScheduledValues() {},
    setValueAtTime(next) { this.value = next; },
    setValueCurveAtTime(curve) { this.value = curve.at(-1); },
  });
  const context = { currentTime: 0 };
  const sourceSound = {
    id: "source-buffer",
    playing: true,
    currentTime: 4,
    volume: 0.6,
    gain: makeGain(0.6),
    context,
    stopCalls: 0,
    stop() {
      this.playing = false;
      this.stopCalls++;
    },
  };
  const targetSound = {
    id: "target-buffer",
    playing: false,
    volume: 0,
    gain: makeGain(0),
    context,
    stopCalls: 0,
    async play() {
      this.playing = true;
    },
    stop() {
      this.playing = false;
      this.stopCalls++;
    },
  };
  const segment = {
    start: "00:01.000",
    end: "00:05.000",
    startSec: 1,
    endSec: 5,
    crossfadeMs: 100,
    loopCount: 0,
  };
  const playlistSound = {
    id: "loop-sound",
    name: "Cancellation Regression",
    volume: 0.6,
    sound: sourceSound,
  };
  const looper = new LoopingSound(playlistSound, { segments: [segment] });
  looper.soundA = sourceSound;
  looper.soundB = targetSound;
  looper.activeLoopSegment = segment;
  looper._prepareTargetSound = async () => targetSound;

  const handoff = looper._performCrossfadeLoop();
  for (let index = 0; index < 4 && !looper.handoffTimer; index++) await Promise.resolve();
  assert.ok(looper.handoffTimer, "handoff timer should be armed");

  looper.pause();
  await handoff;

  assert.equal(looper.isA_Active, true);
  assert.equal(looper.activeLoopSegment, segment);
  assert.equal(looper.pausedSnapshot?.activeSegmentIndex, 0);
  assert.equal(playlistSound.sound, sourceSound);
  assert.equal(targetSound.playing, false);
  assert.ok(targetSound.stopCalls >= 1);
  assert.equal(sourceSound.stopCalls, 0);
});

test("a rejected superseded loop handoff cannot clear newer transition ownership", async () => {
  const AudioTimeout = foundry.audio.AudioTimeout;
  AudioTimeout.rejectOnCancel = true;

  const makeGain = (value) => ({
    value,
    cancelAndHoldAtTime() {},
    cancelScheduledValues() {},
    setValueAtTime(next) { this.value = next; },
    setValueCurveAtTime(curve) { this.value = curve.at(-1); },
  });
  const context = { currentTime: 0 };
  const sourceSound = {
    id: "rejecting-source",
    playing: true,
    currentTime: 4,
    volume: 0.6,
    gain: makeGain(0.6),
    context,
    stop() { this.playing = false; },
  };
  const targetSound = {
    id: "rejecting-target",
    playing: false,
    volume: 0,
    gain: makeGain(0),
    context,
    stopCalls: 0,
    async play() { this.playing = true; },
    stop() {
      this.playing = false;
      this.stopCalls++;
    },
  };
  const segment = {
    start: "00:01.000",
    end: "00:05.000",
    startSec: 1,
    endSec: 5,
    crossfadeMs: 100,
    loopCount: 0,
  };
  const playlistSound = {
    id: "rejecting-loop-sound",
    name: "Rejecting Cancellation Regression",
    volume: 0.6,
    sound: sourceSound,
  };
  const looper = new LoopingSound(playlistSound, { segments: [segment] });
  looper.soundA = sourceSound;
  looper.soundB = targetSound;
  looper.activeLoopSegment = segment;
  looper._prepareTargetSound = async () => targetSound;

  try {
    const firstHandoff = looper._performCrossfadeLoop();
    for (let index = 0; index < 4 && !looper.handoffTimer; index++) await Promise.resolve();
    const oldTimer = looper.handoffTimer;
    assert.ok(oldTimer, "first handoff timer should be armed");

    const replacementTimer = new AudioTimeout(500);
    replacementTimer.complete.catch(() => {});
    looper.handoffTimer = replacementTimer;
    // Model a newer handoff having claimed the transition after the old one
    // was cancelled. The first safeCancel path temporarily cleared the flag.
    looper._setCrossfading(true);
    oldTimer.cancel();
    assert.equal(await firstHandoff, false);

    assert.equal(looper.handoffTimer, replacementTimer);
    assert.equal(looper.isCrossfading, true);
    assert.equal(targetSound.playing, false);
    assert.equal(targetSound.stopCalls, 1);
  } finally {
    looper.handoffTimer?.cancel?.();
    AudioTimeout.rejectOnCancel = false;
  }
});

test("an older rejected loop play cannot clear a newer handoff generation", async () => {
  let rejectOldPlay;
  const oldTarget = {
    id: "old-target",
    play() {
      return new Promise((_resolve, reject) => { rejectOldPlay = reject; });
    },
    stop() {},
  };
  const sourceSound = { id: "generation-source", playing: true, stop() {} };
  const segment = {
    start: "00:01.000",
    end: "00:05.000",
    startSec: 1,
    endSec: 5,
    crossfadeMs: 100,
    loopCount: 0,
  };
  const playlistSound = {
    id: "generation-loop",
    name: "Generation Ownership",
    volume: 0.5,
    sound: sourceSound,
  };
  const looper = new LoopingSound(playlistSound, { segments: [segment] });
  looper.soundA = sourceSound;
  looper.activeLoopSegment = segment;

  const oldHandoff = looper._executeCrossfadeAndHandoff({
    sourceSound,
    targetSound: oldTarget,
    targetOffset: 1,
    crossfadeMs: 100,
  });
  await Promise.resolve();
  const oldGeneration = looper._handoffGeneration;

  looper._handoffGeneration = oldGeneration + 1;
  looper._setCrossfading(true);
  const replacementTimer = new foundry.audio.AudioTimeout(500);
  looper.handoffTimer = replacementTimer;
  rejectOldPlay(new Error("injected old play rejection"));

  assert.equal(await oldHandoff, false);
  assert.equal(looper._handoffGeneration, oldGeneration + 1);
  assert.equal(looper.isCrossfading, true);
  assert.equal(looper.handoffTimer, replacementTimer);
  replacementTimer.cancel();
});

test("retiring a looper during media discovery preserves ordinary playback", async () => {
  const segment = {
    start: "00:01.000",
    end: "00:05.000",
    startSec: 1,
    endSec: 5,
    crossfadeMs: 100,
    loopCount: 0,
  };
  const liveSound = {
    playing: true,
    stopCalls: 0,
    stop() {
      this.playing = false;
      this.stopCalls++;
    },
  };
  const playlistSound = {
    id: "startup-retire-sound",
    name: "Startup Retirement Regression",
    playing: true,
    sound: null,
  };
  const looper = new LoopingSound(playlistSound, {
    startFromBeginning: true,
    segments: [segment],
  });

  const startup = looper.start();
  looper.retire();
  playlistSound.sound = liveSound;

  assert.equal(await startup, false);
  assert.equal(liveSound.playing, true);
  assert.equal(liveSound.stopCalls, 0);
  assert.equal(looper.soundA, null);
});

test("loop segment validation rejects bounds beyond loaded audio", () => {
  assert.equal(
    getLoopSegmentDurationError({ startSec: 9, endSec: 11, crossfadeMs: 500 }, 10, 0),
    "Segment 1: End exceeds the audio duration"
  );
  assert.equal(
    getLoopSegmentDurationError({ startSec: 10, endSec: 10, crossfadeMs: 0 }, 10, 1),
    "Segment 2: Start must be before the end of the audio"
  );
  assert.equal(
    getLoopSegmentDurationError({ startSec: 2, endSec: 4, crossfadeMs: 2500 }, 10, 2),
    "Segment 3: Crossfade longer than segment"
  );
  assert.equal(
    getLoopSegmentDurationError({ startSec: 2, endSec: 4, crossfadeMs: 500 }, 10, 0),
    null
  );
});

test("destroyed loop preview cannot start after an asynchronous load", async () => {
  let resolveLoad;
  const loadComplete = new Promise((resolve) => { resolveLoad = resolve; });
  let createdSound;
  const previousSoundClass = foundry.audio.Sound;

  foundry.audio.Sound = class TestPreviewSound {
    constructor() {
      this.playCalls = 0;
      this.stopCalls = 0;
      createdSound = this;
    }

    load() {
      return loadComplete;
    }

    async play() {
      this.playCalls++;
    }

    stop() {
      this.stopCalls++;
    }

    addEventListener() {}
  };

  try {
    const chainableIcon = {
      removeClass() { return this; },
      addClass() { return this; },
    };
    const previewer = new LoopPreviewer({}, {}, { document: { path: "preview.ogg", volume: 0.5 } });
    previewer.$playIcon = chainableIcon;
    previewer.$timer = { text() {} };
    previewer.$progress = { css() {} };
    previewer._updateVisuals = () => {};
    previewer._getPreviewVolume = () => 0.5;

    const pendingPlay = previewer._seekAndPlay(0);
    previewer.destroy();
    resolveLoad();
    await pendingPlay;

    assert.equal(createdSound.playCalls, 0);
    assert.ok(createdSound.stopCalls >= 1);
    assert.equal(previewer.soundA, null);
    assert.equal(previewer.isPlaying, false);
  } finally {
    foundry.audio.Sound = previousSoundClass;
  }
});

test("destroying one loop preview cancels only its drag handlers and animation frame", () => {
  const previous = {
    dollar: globalThis.$,
    document: globalThis.document,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const removedNamespaces = [];
  const cancelledFrames = [];
  globalThis.document = {};
  globalThis.$ = () => ({
    off(namespace) {
      removedNamespaces.push(namespace);
      return this;
    },
  });
  globalThis.cancelAnimationFrame = (frameId) => cancelledFrames.push(frameId);

  try {
    const first = new LoopPreviewer({}, {}, { document: {} });
    const second = new LoopPreviewer({}, {}, { document: {} });
    first._updateVisuals = () => {};
    second._updateVisuals = () => {};
    first.activeDrag = { animationFrame: 17 };

    first.destroy();

    assert.deepEqual(cancelledFrames, [17]);
    assert.deepEqual(removedNamespaces, [first._dragNamespace]);
    assert.notEqual(first._dragNamespace, second._dragNamespace);
    assert.equal(removedNamespaces.includes(second._dragNamespace), false);
    assert.equal(removedNamespaces.includes(".loopeditor"), false);

    second.destroy();
  } finally {
    globalThis.$ = previous.dollar;
    globalThis.document = previous.document;
    globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
  }
});
