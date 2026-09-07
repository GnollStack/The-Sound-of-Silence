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
    hasProperty(object, path) {
      return String(path ?? "")
        .split(".")
        .filter(Boolean)
        .every((key) => {
          if (object == null || !Object.prototype.hasOwnProperty.call(object, key)) return false;
          object = object[key];
          return true;
        });
    },
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
const { reserveFadeIn } = await import("../scripts/audio-fader.js");
const { applyFadeIn } = await import("../scripts/fade-in.js");
const { PlaybackClock } = await import("../scripts/playback-clock.js");
const {
  activateCrossfadeSession,
  createCrossfadeSession,
  settleCrossfadeSession,
} = await import("../scripts/playback/transition-session.js");
const { performCrossfade } = await import("../scripts/cross-fade.js");
const {
  planCrossfadePreload,
  resolveNextCrossfadeSound,
} = await import("../scripts/playback/preload-coordinator.js");
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
const {
  registerPlaylistAdvanceWrappers,
  registerPlaylistCommandWrappers,
} = await import("../scripts/playlist/playlist-command-wrappers.js");
const { registerPlaybackDocumentHooks } = await import("../scripts/playback/document-hooks.js");
const { registerSoundPlaybackWrappers } = await import("../scripts/playback/sound-wrappers.js");
const { maybeLoopPlaylist } = await import("../scripts/playlist-loop.js");
const { registerSoundConfigWrappers } = await import("../scripts/sound-config.js");
const { createPlaybackAutomation } = await import("../scripts/diagnostics-playback-automation.js");

test("sound form preserves explicit procedural defaults and inherited fields stay absent", () => {
  const previousWrapper = globalThis.libWrapper;
  const wrappers = new Map();
  globalThis.libWrapper = { register: (_id, target, callback) => wrappers.set(target, callback) };
  try {
    registerSoundConfigWrappers();
    const process = wrappers.get("foundry.applications.sheets.PlaylistSoundConfig.prototype._processFormData");
    for (const existing of [{ minDelay: 15, playChance: 100, randomPan: false }, {}]) {
      const document = {
        flags: { "the-sound-of-silence": existing },
        parent: null,
        getFlag(_scope, key) { return key ? existing[key] : undefined; },
      };
      const object = Object.fromEntries(Object.entries({
        minDelay: 15, maxDelay: 60, playChance: 100, randomPan: false,
        timingMode: "uniform", initialFireMode: "normal", volumeVariance: 0,
      }).map(([key, value]) => [`flags.the-sound-of-silence.${key}`, value]));
      const result = process.call({ document }, (_event, _form, data) => data.object, null, null, { object });
      const flags = result.flags["the-sound-of-silence"];
      for (const key of ["minDelay", "playChance", "randomPan"]) {
        assert.equal(Object.hasOwn(flags, key), Object.hasOwn(existing, key));
        if (Object.hasOwn(existing, key)) assert.equal(flags[key], existing[key]);
      }
      assert.equal(Object.hasOwn(flags, "maxDelay"), false);
    }
  } finally {
    globalThis.libWrapper = previousWrapper;
  }
});

test("client diagnostics stop only marked fixtures belonging to the current world and run", async () => {
  const previous = { game: globalThis.game, ui: globalThis.ui, canvas: globalThis.canvas };
  const calls = [];
  const makePlaylist = (id, marker, name = `SoS MCP Test - ${id}`) => ({
    id, name, playing: false, sounds: [{ playing: true }],
    getFlag() { return marker; },
    async stopAll() { calls.push(`stop:${id}`); },
  });
  const marker = { kind: "playlist", runId: "current-run", worldId: "test-world", fixtureName: "SoS MCP Test - fixture" };
  globalThis.game = {
    ...previous.game, world: { id: "test-world" }, folders: [],
    playlists: [
      makePlaylist("owned", marker),
      makePlaylist("user", undefined, "Campaign Music"),
      makePlaylist("other-run", { ...marker, runId: "other" }),
      makePlaylist("other-world", { ...marker, worldId: "other" }),
      makePlaylist("unmarked", undefined),
      makePlaylist("renamed", marker, "Campaign Music"),
    ],
  };
  globalThis.canvas = { scene: null };
  globalThis.ui = {
    sidebar: { tabGroups: { primary: "chat" }, changeTab(tab, group) { this.tabGroups[group] = tab; } },
    playlists: { render() {} },
  };
  try {
    const automation = createPlaybackAutomation({
      async cleanup(playlist) { calls.push(`cleanup:${playlist.id}`); },
      async collectClientDiagnostics() {
        return { clients: [{ client: { isGM: true, userId: "gm" }, playlistDocuments: [] }] };
      },
    });
    const result = await automation.runClientSyncAutomation({
      scenario: "responder", runId: "current-run", cleanupBefore: false, cleanupAfter: false,
    });
    assert.equal(result.success, false, "missing player must fail the real preflight");
    assert.deepEqual(calls, ["cleanup:owned", "stop:owned"]);
  } finally {
    Object.assign(globalThis, previous);
  }
});

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

function registerPlaybackDocumentHooksForTest() {
  const names = ["updatePlaylist", "updatePlaylistSound"];
  const existing = new Map(names.map((name) => [name, new Set(hookListeners.get(name) ?? [])]));
  registerPlaybackDocumentHooks();
  const added = names.flatMap((name) =>
    (hookListeners.get(name) ?? [])
      .filter((callback) => !existing.get(name).has(callback))
      .map((callback) => ({ name, callback }))
  );
  return () => {
    for (const { name, callback } of added) Hooks.off(name, callback);
  };
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

test("failed gap playback retains cleanup ownership when delete and deactivate both fail", async () => {
  const previous = {
    user: game.user,
    users: game.users,
    playlists: game.playlists,
    setTimeout: globalThis.setTimeout,
  };
  const gm = { id: "startup-cleanup-gm", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];

  const scheduled = [];
  globalThis.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };

  let deleteCalls = 0;
  let deactivateCalls = 0;
  const events = [];
  const playlist = {
    id: "failed-gap-playback-double-cleanup",
    name: "Failed Gap Playback Double Cleanup",
    isOwner: true,
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    playbackOrder: ["source"],
    sounds: new TestSoundCollection(),
    getFlag(_scope, key) {
      return {
        silenceMode: "static",
        silenceDuration: 60000,
      }[key];
    },
    async createEmbeddedDocuments() {
      const gap = makeTestSound({
        id: "failed-startup-gap",
        parent: this,
        playing: true,
        sound: {
          playing: true,
          stop() { this.playing = false; },
        },
        flags: {
          isSilenceGap: true,
          gapDuration: 60000,
          gapStarted: Date.now(),
          gapSourceSoundId: "source",
        },
      });
      gap.delete = async () => {
        deleteCalls += 1;
        throw new Error("injected startup delete failure");
      };
      gap.update = async () => {
        deactivateCalls += 1;
        throw new Error("injected startup deactivate failure");
      };
      this.sounds.push(gap);
      this.playbackOrder = ["source", gap.id];
      return [gap];
    },
    async playSound() {
      throw new Error("injected startup playback failure");
    },
  };
  const source = makeTestSound({ id: "source", parent: playlist });
  playlist.sounds.push(source);
  game.playlists = [playlist];
  const onSilenceEnd = (event) => {
    if (event?.playlist === playlist) events.push(event);
  };
  Hooks.on("the-sound-of-silence.silenceEnd", onSilenceEnd);

  let transition;
  try {
    transition = await startSilenceGap(playlist, source);
    const gap = playlist.sounds.get("failed-startup-gap");
    const state = State.getSilenceState(playlist);

    assert.equal(transition.started, false);
    assert.equal(transition.reason, "cancelled");
    assert.ok(deleteCalls >= 2);
    assert.ok(deactivateCalls >= 2);
    assert.equal(gap.playing, true);
    assert.equal(gap.sound.playing, false);
    assert.equal(state?.gap, gap);
    assert.equal(state?.cancelled, true);
    assert.equal(state?.terminalOutcome, "cancelled");
    assert.equal(state?.cleanupRetryScheduled, true);
    assert.ok(scheduled.length >= 2);

    let completionSettled = false;
    let completionValue;
    transition.completion.then((value) => {
      completionSettled = true;
      completionValue = value;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(completionSettled, false);
    assert.equal(completionValue, undefined);
    assert.deepEqual(events, []);

    assert.equal(await recoverPersistedSilenceGaps("failed startup before cleanup retry"), false);
    const reconciledState = State.getSilenceState(playlist);
    assert.equal(reconciledState, state);
    assert.notEqual(reconciledState?.recovered, true);
    assert.equal(reconciledState?.cancelled, true);
    assert.equal(gap.playing, true);
    assert.equal(completionSettled, false);
    assert.deepEqual(events, []);
  } finally {
    Hooks.off("the-sound-of-silence.silenceEnd", onSilenceEnd);
    State.clearSilenceState(playlist);
    globalThis.setTimeout = previous.setTimeout;
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

test("failed gap playback clears state after delete fails but deactivation succeeds", async () => {
  const previous = {
    user: game.user,
    users: game.users,
    playlists: game.playlists,
    setTimeout: globalThis.setTimeout,
  };
  const gm = { id: "startup-deactivate-gm", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];
  const scheduled = [];
  globalThis.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };

  let deleteCalls = 0;
  let deactivateCalls = 0;
  const events = [];
  const playlist = {
    id: "failed-gap-playback-safe-deactivate",
    name: "Failed Gap Playback Safe Deactivate",
    isOwner: true,
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    playbackOrder: ["source"],
    sounds: new TestSoundCollection(),
    getFlag(_scope, key) {
      return {
        silenceMode: "static",
        silenceDuration: 60000,
      }[key];
    },
    async createEmbeddedDocuments() {
      const gap = makeTestSound({
        id: "safely-deactivated-startup-gap",
        parent: this,
        playing: true,
        flags: {
          isSilenceGap: true,
          gapDuration: 60000,
          gapStarted: Date.now(),
          gapSourceSoundId: "source",
        },
      });
      gap.delete = async () => {
        deleteCalls += 1;
        throw new Error("injected startup delete failure");
      };
      gap.update = async (changes) => {
        deactivateCalls += 1;
        Object.assign(gap, changes);
        return gap;
      };
      this.sounds.push(gap);
      this.playbackOrder = ["source", gap.id];
      return [gap];
    },
    async playSound() {
      throw new Error("injected startup playback failure");
    },
  };
  const source = makeTestSound({ id: "source", parent: playlist });
  playlist.sounds.push(source);
  game.playlists = [playlist];
  const onSilenceEnd = (event) => {
    if (event?.playlist === playlist) events.push(event);
  };
  Hooks.on("the-sound-of-silence.silenceEnd", onSilenceEnd);

  try {
    const transition = await startSilenceGap(playlist, source);
    const gap = playlist.sounds.get("safely-deactivated-startup-gap");

    assert.equal(transition.started, false);
    assert.equal(transition.reason, "creation-failed");
    assert.equal(await transition.completion, false);
    assert.equal(deleteCalls, 1);
    assert.equal(deactivateCalls, 1);
    assert.equal(gap.playing, false);
    assert.equal(gap.pausedTime, null);
    assert.equal(State.getSilenceState(playlist), undefined);
    assert.deepEqual(events, []);
    assert.equal(scheduled.length, 1);
  } finally {
    Hooks.off("the-sound-of-silence.silenceEnd", onSilenceEnd);
    State.clearSilenceState(playlist);
    globalThis.setTimeout = previous.setTimeout;
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

    let staleGapNativeCalls = 0;
    const staleGapMedia = {
      playing: true,
      stop() { this.playing = false; },
    };
    const staleGap = makeTestSound({
      id: "unowned-gap",
      parent: playlist,
      playing: true,
      sound: staleGapMedia,
      flags: { isSilenceGap: true },
    });
    staleGap.update = async (changes) => {
      Object.assign(staleGap, changes);
      return staleGap;
    };
    assert.equal(
      await playSound.call(playlist, async () => {
        staleGapNativeCalls += 1;
        return nativeResult;
      }, staleGap),
      playlist
    );
    assert.equal(staleGapNativeCalls, 0);
    assert.equal(staleGap.playing, false);
    assert.equal(staleGap.pausedTime, null);
    assert.equal(staleGapMedia.playing, false);

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

test("Sound.play wrapper patches the silence-gap clock without scheduling normal track work", async () => {
  const registrations = new Map();
  const previousLibWrapper = globalThis.libWrapper;
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };

  const flags = {
    isSilenceGap: true,
    gapDuration: 2000,
    gapStarted: Date.now() - 500,
  };
  const playlist = {
    id: "sound-wrapper-gap-playlist",
    name: "Sound Wrapper Gap Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    getFlag() { return undefined; },
  };
  const media = { playing: false, volume: 1 };
  const gap = Object.assign(new PlaylistSound(), {
    id: "sound-wrapper-gap",
    name: "Sound Wrapper Gap",
    parent: playlist,
    playing: true,
    pausedTime: null,
    repeat: false,
    sound: media,
    getFlag(_scope, key) { return flags[key]; },
  });
  media._manager = gap;

  try {
    registerSoundPlaybackWrappers();
    const play = registrations.get("foundry.audio.Sound.prototype.play");
    const nativeResult = { native: true };
    let nativeCalls = 0;

    assert.equal(
      await play.call(media, async () => {
        nativeCalls += 1;
        media.playing = true;
        return nativeResult;
      }, { _fromCrossfade: true }),
      nativeResult
    );
    assert.equal(nativeCalls, 1);
    assert.equal(media.duration, 2);
    assert.ok(media.currentTime >= 0.4 && media.currentTime <= 2);
  } finally {
    delete media._manager;
    globalThis.libWrapper = previousLibWrapper;
  }
});

test("PlaylistSound.sync post-corrects only media that was already playing", () => {
  const registrations = new Map();
  const previousLibWrapper = globalThis.libWrapper;
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };

  const playlist = {
    id: "sync-startup-volume-playlist",
    name: "Sync Startup Volume Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    sounds: new TestSoundCollection(),
    getFlag() { return undefined; },
  };
  let gainValue = 0.2;
  const volumeWrites = [];
  const media = { playing: false };
  Object.defineProperty(media, "volume", {
    configurable: true,
    get() { return gainValue; },
    set(value) {
      gainValue = value;
      volumeWrites.push(value);
    },
  });
  const playlistSound = Object.assign(new PlaylistSound(), {
    id: "sync-startup-volume-track",
    name: "Sync Startup Volume Track",
    parent: playlist,
    playing: true,
    pausedTime: null,
    repeat: false,
    volume: 0.65,
    sound: media,
    getFlag() { return undefined; },
  });
  playlist.sounds.push(playlistSound);

  try {
    registerSoundPlaybackWrappers();
    const sync = registrations.get("PlaylistSound.prototype.sync");
    const nativeResult = { native: true };

    assert.equal(sync.call(playlistSound, () => {
      media.playing = true;
      gainValue = 0;
      return nativeResult;
    }), nativeResult);
    assert.deepEqual(volumeWrites, [], "new startup media must remain owned by Sound.play");

    media.playing = true;
    gainValue = 0.2;
    assert.equal(sync.call(playlistSound, () => nativeResult), nativeResult);
    assert.deepEqual(volumeWrites, [0.65], "already-playing media still receives sync correction");
  } finally {
    globalThis.libWrapper = previousLibWrapper;
  }
});

test("playing-only embedded playlist updates do not reapply the live personal mix", () => {
  const unregister = registerPlaybackDocumentHooksForTest();
  const previous = {
    audioHelper: foundry.audio.AudioHelper,
    document: globalThis.document,
    user: game.user,
    users: game.users,
  };
  const user = { id: "embedded-volume-user", name: "Embedded Volume User", isGM: false, active: true };
  const users = [user];
  users.get = (id) => users.find((entry) => entry.id === id);
  game.user = user;
  game.users = users;
  foundry.audio.AudioHelper = {
    inputToVolume: (value) => value,
    volumeToInput: (value) => value,
  };
  globalThis.document = { querySelectorAll: () => [] };

  let gainValue = 0.65;
  const volumeWrites = [];
  const media = { playing: true };
  Object.defineProperty(media, "volume", {
    configurable: true,
    get() { return gainValue; },
    set(value) {
      gainValue = value;
      volumeWrites.push(value);
    },
  });
  const playlist = {
    id: "embedded-volume-playlist",
    name: "Embedded Volume Playlist",
    isOwner: false,
    playing: true,
    sounds: new TestSoundCollection(),
    getFlag() { return undefined; },
  };
  const playlistSound = Object.assign(new PlaylistSound(), {
    id: "embedded-volume-track",
    name: "Embedded Volume Track",
    parent: playlist,
    playing: true,
    pausedTime: null,
    volume: 0.65,
    sound: media,
    getFlag() { return undefined; },
  });
  playlist.sounds.push(playlistSound);

  try {
    Hooks.callAll(
      "updatePlaylist",
      playlist,
      { sounds: [{ _id: playlistSound.id, playing: true }] },
      {},
      user.id
    );
    assert.deepEqual(volumeWrites, []);

    playlistSound.volume = 0.4;
    Hooks.callAll(
      "updatePlaylist",
      playlist,
      { sounds: [{ _id: playlistSound.id, volume: 0.4 }] },
      {},
      user.id
    );
    assert.deepEqual(volumeWrites, [0.4], "real embedded volume changes still reapply the mix");
  } finally {
    unregister();
    foundry.audio.AudioHelper = previous.audioHelper;
    game.user = previous.user;
    game.users = previous.users;
    if (typeof previous.document === "undefined") delete globalThis.document;
    else globalThis.document = previous.document;
  }
});

test("native play rejection releases startup fade ownership and consumes its override", async () => {
  const registrations = new Map();
  const previousLibWrapper = globalThis.libWrapper;
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };

  const gain = {
    value: 0.5,
    cancelAndHoldAtTime() {},
    cancelScheduledValues() {},
    setValueAtTime(value) { this.value = value; },
  };
  const media = {
    playing: false,
    context: { currentTime: 0, state: "running", sampleRate: 48000 },
    gain,
    gainNode: { gain },
    volume: 0.5,
  };
  const playlist = {
    id: "rejected-startup-playlist",
    name: "Rejected Startup Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    sounds: new TestSoundCollection(),
    getFlag(_scope, key) { return key === "fadeIn" ? 0 : undefined; },
  };
  const playlistSound = Object.assign(new PlaylistSound(), {
    id: "rejected-startup-track",
    name: "Rejected Startup Track",
    parent: playlist,
    playing: true,
    pausedTime: null,
    repeat: false,
    volume: 0.5,
    sound: media,
    _sos_fadeInOverride: 250,
    getFlag() { return undefined; },
  });
  playlist.sounds.push(playlistSound);
  media._manager = playlistSound;

  try {
    registerSoundPlaybackWrappers();
    const play = registrations.get("foundry.audio.Sound.prototype.play");
    const failure = new Error("injected native startup rejection");

    await assert.rejects(
      play.call(media, async (options) => {
        assert.equal(options.volume, 0);
        assert.equal(State.getFadeToken(media)?.type, "fade-in-start");
        assert.equal(State.getFadeToken(media)?.duration, 250);
        throw failure;
      }),
      failure
    );
    assert.equal(State.isSoundFading(media), false);
    assert.equal("_sos_fadeInOverride" in playlistSound, false);
  } finally {
    State.clearFadingSound(media);
    delete media._manager;
    globalThis.libWrapper = previousLibWrapper;
  }
});

test("blocked autoplay preserves libWrapper registration for a later skip-intro start", async () => {
  const previous = {
    libWrapper: globalThis.libWrapper,
    playlists: game.playlists,
    audioWait: foundry.audio.AudioTimeout.wait,
  };
  const registrations = new Map();
  const violations = [];
  globalThis.libWrapper = {
    register(_module, target, callback, type) {
      registrations.set(target, { callback, type });
    },
  };
  const invokeRegistered = async (target, media, native, options = {}) => {
    const registration = registrations.get(target);
    if (!registration) return native.call(media, options);
    let chained = false;
    const result = await registration.callback.call(media, (...args) => {
      chained = true;
      return native.apply(media, args);
    }, options);
    // Installed libWrapper checks the resolved call and unregisters a WRAPPER
    // which skipped its next function. MIXED explicitly permits that choice.
    if (registration.type === "WRAPPER" && !chained) {
      violations.push(target);
      registrations.delete(target);
    }
    return result;
  };
  const target = "foundry.audio.Sound.prototype.play";
  const media = {
    playing: false,
    loaded: true,
    duration: 2,
    currentTime: 0,
    volume: 0.6,
    stop() { this.playing = false; },
  };
  const playlist = {
    id: "wrapper-registration-playlist",
    name: "Wrapper Registration Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: false,
    fade: 0,
    sounds: new TestSoundCollection(),
    getFlag() { return undefined; },
  };
  const loopWithin = {
    enabled: true,
    active: true,
    startFromBeginning: false,
    segments: [{ start: "00:00.500", end: "00:01.500", crossfadeMs: 100, loopCount: 0 }],
  };
  const document = Object.assign(new PlaylistSound(), {
    id: "wrapper-registration-track",
    name: "Wrapper Registration Track",
    path: "wrapper-registration.ogg",
    parent: playlist,
    playing: false,
    pausedTime: null,
    repeat: false,
    volume: 0.6,
    sound: media,
    getFlag(_scope, key) { return key === "loopWithin" ? loopWithin : undefined; },
    _onEnd() {},
  });
  playlist.sounds.push(document);
  game.playlists = [playlist];
  foundry.audio.AudioTimeout.wait = () => new Promise(() => {});
  const nativeOffsets = [];
  const nativePlay = async (options) => {
    nativeOffsets.push(options.offset);
    media.currentTime = options.offset ?? 0;
    media.playing = true;
    return media;
  };

  try {
    registerSoundPlaybackWrappers();
    assert.equal(await invokeRegistered(target, media, nativePlay), media);
    assert.deepEqual(nativeOffsets, [], "cancelled first-load autoplay must not reach native playback");

    playlist.playing = true;
    document.playing = true;
    assert.equal(await invokeRegistered(target, media, nativePlay), media);
    assert.deepEqual(violations, [], "conditional playback suppression must satisfy the registered wrapper type");
    assert.equal(registrations.get(target)?.type, "MIXED");
    assert.deepEqual(nativeOffsets, [0.5], "the later start must retain skip-intro offset injection");
    assert.equal(media.currentTime, 0.5);
    assert.ok(State.getActiveLooper(document), "post-play loop scheduling must remain registered too");
  } finally {
    State.getActiveLooper(document)?.destroy(true);
    State.clearActiveLooper(document);
    State.clearFadingSound(media);
    globalThis.libWrapper = previous.libWrapper;
    game.playlists = previous.playlists;
    foundry.audio.AudioTimeout.wait = previous.audioWait;
  }
});

test("Stop before first load completion cannot revive uncached native media", async () => {
  const previous = { libWrapper: globalThis.libWrapper, playlists: game.playlists };
  const registrations = new Map();
  globalThis.libWrapper = {
    register(_module, target, callback) { registrations.set(target, callback); },
  };
  const media = {
    playing: false,
    volume: 0.5,
    stopCalls: 0,
    stop() { this.playing = false; this.stopCalls += 1; },
  };
  const playlist = {
    id: "cold-stop-playlist",
    name: "Cold Stop Playlist",
    playing: true,
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    sounds: new TestSoundCollection(),
    getFlag() { return undefined; },
  };
  const document = Object.assign(new PlaylistSound(), {
    id: "cold-stop-sound", name: "Cold Stop Sound", parent: playlist,
    playing: true, pausedTime: null, repeat: false, volume: 0.5, sound: media,
    getFlag() { return undefined; },
  });
  playlist.sounds.push(document);
  game.playlists = [playlist];

  try {
    registerSoundPlaybackWrappers();
    const play = registrations.get("foundry.audio.Sound.prototype.play");
    let nativePlayCalls = 0;
    let finishLoad;
    const loading = new Promise((resolve) => { finishLoad = resolve; });
    const autoplay = loading.then(() => play.call(media, async () => {
      // Native autoplay may finish after the earlier stop update did not find
      // playing media. This Sound has never entered the wrapper lookup cache.
      nativePlayCalls += 1;
      media.playing = true;
      return media;
    }));
    document.playing = false;
    playlist.playing = false;
    finishLoad();
    assert.equal(await autoplay, media);
    assert.equal(media.playing, false, "late native autoplay must settle back to stopped");
    assert.equal(nativePlayCalls, 0, "cancelled autoplay must not create an audible pipeline");
    assert.equal(media.stopCalls, 0);
    assert.equal(State.getActiveLooper(document), undefined);
    assert.equal(State.getEndOfTrackFade(document), undefined);

    // Stop can also arrive after native play was entered but before it resolves.
    document.playing = true;
    playlist.playing = true;
    let finishNativePlay;
    const nativePending = new Promise((resolve) => { finishNativePlay = resolve; });
    const pendingPlay = play.call(media, async () => {
      await nativePending;
      media.playing = true;
      return media;
    });
    document.playing = false;
    playlist.playing = false;
    finishNativePlay();
    await pendingPlay;
    assert.equal(media.playing, false, "Stop also wins after native play has already begun");
    assert.equal(media.stopCalls, 1);
  } finally {
    game.playlists = previous.playlists;
    globalThis.libWrapper = previous.libWrapper;
  }
});

test("native media lookup supports a playing soundboard sound with an inactive playlist", async () => {
  const previous = { libWrapper: globalThis.libWrapper, playlists: game.playlists };
  const registrations = new Map();
  globalThis.libWrapper = {
    register(_module, target, callback) { registrations.set(target, callback); },
  };
  const media = {
    playing: false, volume: 0.5,
    stop() { this.playing = false; throw new Error("soundboard playback must not be stopped"); },
  };
  const playlist = {
    id: "inactive-soundboard-playlist", name: "Inactive Soundboard Playlist",
    playing: false, mode: CONST.PLAYLIST_MODES.DISABLED,
    sounds: new TestSoundCollection(), getFlag() { return undefined; },
  };
  const document = Object.assign(new PlaylistSound(), {
    id: "inactive-soundboard-track", name: "Soundboard Track", parent: playlist,
    playing: true, pausedTime: null, repeat: true, volume: 0.5, sound: media,
    getFlag() { return undefined; },
  });
  playlist.sounds.push(document);
  game.playlists = [playlist];

  try {
    registerSoundPlaybackWrappers();
    const play = registrations.get("foundry.audio.Sound.prototype.play");
    await play.call(media, async () => { media.playing = true; return media; });
    assert.equal(media.playing, true);
    const unrelatedMedia = { playing: false };
    const options = { volume: 0.25 };
    await play.call(unrelatedMedia, async (received) => {
      assert.equal(received, options, "unrelated audio retains native playback options");
      unrelatedMedia.playing = true;
    }, options);
    assert.equal(unrelatedMedia.playing, true);
  } finally {
    game.playlists = previous.playlists;
    globalThis.libWrapper = previous.libWrapper;
  }
});

test("a newer fade owner can supersede startup without stopping valid media", async () => {
  const registrations = new Map();
  const previousLibWrapper = globalThis.libWrapper;
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };

  const gain = {
    value: 0.5,
    cancelAndHoldAtTime() {},
    cancelScheduledValues() {},
    setValueAtTime(value) { this.value = value; },
  };
  const media = {
    playing: false,
    context: { currentTime: 0, state: "running", sampleRate: 48000 },
    gain,
    gainNode: { gain },
    volume: 0.5,
    stopCalls: 0,
    stop() {
      this.playing = false;
      this.stopCalls += 1;
    },
  };
  const playlist = {
    id: "superseded-startup-playlist",
    name: "Superseded Startup Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    sounds: new TestSoundCollection(),
    getFlag(_scope, key) { return key === "fadeIn" ? 250 : undefined; },
  };
  const playlistSound = Object.assign(new PlaylistSound(), {
    id: "superseded-startup-track",
    name: "Superseded Startup Track",
    parent: playlist,
    playing: true,
    pausedTime: null,
    repeat: true,
    volume: 0.5,
    sound: media,
    getFlag() { return undefined; },
  });
  playlist.sounds.push(playlistSound);
  media._manager = playlistSound;

  try {
    registerSoundPlaybackWrappers();
    const play = registrations.get("foundry.audio.Sound.prototype.play");
    let externalToken;

    await play.call(media, async () => {
      assert.equal(State.getFadeToken(media)?.type, "fade-in-start");
      media.playing = true;
      externalToken = State.startFade(media, { type: "external" });
      return media;
    });

    assert.equal(State.getFadeToken(media), externalToken);
    assert.equal(media.stopCalls, 0);
    assert.equal(media.playing, true);
  } finally {
    State.clearFadingSound(media);
    delete media._manager;
    globalThis.libWrapper = previousLibWrapper;
  }
});

test("fresh skip-intro playback starts at the first loop segment and reuses Foundry's original Sound", async () => {
  const registrations = new Map();
  const previousLibWrapper = globalThis.libWrapper;
  const PreviousSound = foundry.audio.Sound;
  const originalAudioWait = foundry.audio.AudioTimeout.wait;
  const originalLoopStart = LoopingSound.prototype.start;
  let constructedSounds = 0;
  let startupPromise = null;
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };

  const makeScheduleHandle = () => ({
    cancelled: false,
    cancel() { this.cancelled = true; },
    catch() { return this; },
  });
  class ReplacementSound {
    constructor(path, { context } = {}) {
      constructedSounds += 1;
      this.path = path;
      this.context = context;
      this.loaded = false;
      this.failed = false;
      this.playing = false;
      this.currentTime = 0;
      this.duration = 30;
      this.volume = 0;
      this.stopCalls = 0;
    }

    async load() {
      this.loaded = true;
      return this;
    }

    async play(options = {}) {
      this.playing = true;
      this.currentTime = Number(options.offset) || 0;
      this.volume = Number(options.volume) || 0;
      return this;
    }

    stop() {
      this.playing = false;
      this.stopCalls += 1;
    }

    schedule() {
      return makeScheduleHandle();
    }

    addEventListener() {}
    removeEventListener() {}
  }
  foundry.audio.Sound = ReplacementSound;

  const loopWithin = {
    enabled: true,
    active: true,
    startFromBeginning: false,
    segments: [{
      label: "Skip Intro",
      start: "00:05.000",
      end: "00:15.000",
      crossfadeMs: 500,
      loopCount: 0,
      skipToNext: false,
    }],
  };
  const playlist = {
    id: "skip-intro-wrapper-playlist",
    name: "Skip Intro Wrapper Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    fade: 0,
    playing: true,
    isOwner: false,
    sounds: new TestSoundCollection(),
    getFlag(_scope, key) { return key === "fadeIn" ? 1000 : undefined; },
  };
  const gain = {
    value: 0.6,
    curveCalls: [],
    cancelAndHoldAtTime() {},
    cancelScheduledValues() {},
    setValueAtTime(value) { this.value = value; },
    setValueCurveAtTime(curve, startTime, duration) {
      this.curveCalls.push({ curve, startTime, duration });
      this.value = curve.at(-1);
    },
  };
  const media = {
    loaded: true,
    failed: false,
    playing: false,
    currentTime: 0,
    duration: 30,
    volume: 0.6,
    context: { currentTime: 0, state: "running", sampleRate: 48000 },
    gain,
    stopCalls: 0,
    scheduleCalls: [],
    stop() {
      this.playing = false;
      this.stopCalls += 1;
    },
    schedule(callback, at) {
      this.scheduleCalls.push({ callback, at });
      return makeScheduleHandle();
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const playlistSound = Object.assign(new PlaylistSound(), {
    id: "skip-intro-wrapper-track",
    uuid: "Playlist.skip-intro-wrapper-playlist.PlaylistSound.skip-intro-wrapper-track",
    name: "Skip Intro Wrapper Track",
    path: "skip-intro.ogg",
    parent: playlist,
    playing: true,
    pausedTime: null,
    repeat: false,
    volume: 0.6,
    sound: media,
    getFlag(_scope, key) {
      return key === "loopWithin" ? loopWithin : undefined;
    },
    _onEnd() {},
  });
  playlist.sounds.push(playlistSound);
  media._manager = playlistSound;

  LoopingSound.prototype.start = function (...args) {
    startupPromise = Promise.resolve(originalLoopStart.apply(this, args));
    return startupPromise;
  };

  try {
    // Let loop startup/stability checks resolve normally, while retaining the
    // longer fade token so ownership can be asserted deterministically.
    foundry.audio.AudioTimeout.wait = (duration = 0) =>
      Number(duration) >= 1000 ? new Promise(() => {}) : originalAudioWait(duration);
    registerSoundPlaybackWrappers();
    const play = registrations.get("foundry.audio.Sound.prototype.play");
    const nativeResult = { native: true };
    const nativeOptions = [];

    assert.equal(
      await play.call(media, async (options) => {
        nativeOptions.push({ ...options });
        media.playing = true;
        media.currentTime = Number(options.offset) || 0;
        media.volume = options.volume;
        media.gain.value = options.volume;
        return nativeResult;
      }),
      nativeResult
    );

    for (let attempt = 0; attempt < 20 && !startupPromise; attempt += 1) {
      await Promise.resolve();
    }
    assert.ok(startupPromise, "the wrapper should schedule LoopingSound startup");
    assert.equal(await startupPromise, true);

    const looper = State.getActiveLooper(playlistSound);
    assert.ok(looper, "the internal looper should retain runtime ownership");
    assert.equal(nativeOptions.length, 1);
    assert.equal(nativeOptions[0].offset, 5);
    assert.equal(nativeOptions[0].volume, 0);
    assert.equal(media.currentTime, 5);
    assert.equal(looper.soundA, media);
    assert.equal(looper.activeSound, media);
    assert.equal(playlistSound.sound, media);
    assert.equal(constructedSounds, 0);
    assert.equal(media.stopCalls, 0);
    assert.equal(State.isSoundFading(media), true);
    assert.equal(gain.curveCalls.length, 1);
    assert.equal(gain.curveCalls[0].curve[0], 0);
    assert.ok(Math.abs(gain.curveCalls[0].curve.at(-1) - 0.6) < 0.0001);
    assert.equal(gain.curveCalls[0].duration, 1);
  } finally {
    State.getActiveLooper(playlistSound)?.destroy(true);
    State.clearActiveLooper(playlistSound);
    State.clearFadingSound(media);
    delete media._manager;
    LoopingSound.prototype.start = originalLoopStart;
    foundry.audio.AudioTimeout.wait = originalAudioWait;
    foundry.audio.Sound = PreviousSound;
    globalThis.libWrapper = previousLibWrapper;
  }
});

test("zero-fade skip-intro primes fresh gain and applies a 10ms de-click ramp", async () => {
  const registrations = new Map();
  const previousLibWrapper = globalThis.libWrapper;
  const originalAudioWait = foundry.audio.AudioTimeout.wait;
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };

  const gainEvents = [];
  const gain = {
    value: 0.65,
    cancelAndHoldAtTime(time) {
      gainEvents.push({ type: "hold", time });
    },
    cancelScheduledValues(time) {
      gainEvents.push({ type: "cancel", time });
    },
    setValueAtTime(value, time) {
      this.value = value;
      gainEvents.push({ type: "set", value, time });
    },
    setValueCurveAtTime(curve, startTime, duration) {
      this.value = curve.at(-1);
      gainEvents.push({ type: "curve", curve, startTime, duration });
    },
  };
  let gainNodesCreated = 0;
  const context = {
    currentTime: 0,
    state: "running",
    sampleRate: 48000,
    createGain() {
      gainNodesCreated += 1;
      return { gain, connect() {} };
    },
  };
  const volumeWrites = [];
  const media = {
    loaded: true,
    failed: false,
    playing: false,
    currentTime: 0,
    duration: 30,
    context,
    gainNode: null,
    stopCalls: 0,
    scheduleCalls: [],
    get gain() { return this.gainNode?.gain; },
    get volume() { return this.gain?.value; },
    set volume(value) {
      if (!this.gainNode || !Number.isFinite(value)) return;
      this.gain.cancelScheduledValues(this.context.currentTime);
      this.gain.value = value;
      this.gain.setValueAtTime(value, this.context.currentTime);
      volumeWrites.push(value);
    },
    stop() {
      this.playing = false;
      this.stopCalls += 1;
    },
    schedule(callback, at) {
      const handle = {
        callback,
        at,
        cancelled: false,
        cancel() { this.cancelled = true; },
        catch() { return this; },
      };
      this.scheduleCalls.push(handle);
      return handle;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const loopWithin = {
    enabled: true,
    active: true,
    startFromBeginning: false,
    segments: [{
      label: "De-click Segment",
      start: "00:05.000",
      end: "00:15.000",
      crossfadeMs: 500,
      loopCount: 0,
      skipToNext: false,
    }],
  };
  const playlist = {
    id: "declick-playlist",
    name: "De-click Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    fade: 0,
    playing: true,
    isOwner: false,
    sounds: new TestSoundCollection(),
    getFlag(_scope, key) { return key === "fadeIn" ? 0 : undefined; },
  };
  const playlistSound = Object.assign(new PlaylistSound(), {
    id: "declick-track",
    uuid: "Playlist.declick-playlist.PlaylistSound.declick-track",
    name: "De-click Track",
    path: "declick.ogg",
    parent: playlist,
    playing: true,
    pausedTime: null,
    repeat: false,
    volume: 0.65,
    sound: media,
    getFlag(_scope, key) {
      return key === "loopWithin" ? loopWithin : undefined;
    },
    _onEnd() {},
  });
  playlist.sounds.push(playlistSound);
  media._manager = playlistSound;

  try {
    foundry.audio.AudioTimeout.wait = () => new Promise(() => {});
    registerSoundPlaybackWrappers();
    const play = registrations.get("foundry.audio.Sound.prototype.play");
    let nativeOptions;
    let startupToken;

    await play.call(media, async (options) => {
      nativeOptions = { ...options };
      startupToken = State.getFadeToken(media);
      assert.equal(startupToken?.type, "fade-in-start");
      assert.equal(gainNodesCreated, 1);
      assert.equal(media.gain.value, 0, "gain must be silent before native playback begins");
      media.playing = true;
      media.currentTime = Number(options.offset) || 0;
      media.volume = options.volume;
      return media;
    });

    const curveEvent = gainEvents.find((event) => event.type === "curve");
    assert.deepEqual(nativeOptions, { offset: 5, volume: 0 });
    assert.deepEqual(volumeWrites, [0]);
    assert.ok(curveEvent, "the skip-intro start should schedule a de-click curve");
    assert.equal(curveEvent.curve[0], 0);
    assert.ok(Math.abs(curveEvent.curve.at(-1) - 0.65) < 0.0001);
    assert.equal(curveEvent.duration, 0.01);
    assert.equal(State.getFadeToken(media)?.type, "fade-in");
    assert.equal(media.stopCalls, 0);
  } finally {
    State.getActiveLooper(playlistSound)?.destroy(true);
    State.clearActiveLooper(playlistSound);
    State.clearFadingSound(media);
    delete media._manager;
    foundry.audio.AudioTimeout.wait = originalAudioWait;
    globalThis.libWrapper = previousLibWrapper;
  }
});

test("streamed startup stays muted until seek readiness and ignores a lost owner", async () => {
  const listeners = new Map();
  const element = {
    paused: false,
    readyState: 1,
    seeking: true,
    addEventListener(name, callback) {
      const callbacks = listeners.get(name) ?? new Set();
      callbacks.add(callback);
      listeners.set(name, callbacks);
    },
    removeEventListener(name, callback) {
      listeners.get(name)?.delete(callback);
    },
    emit(name) {
      for (const callback of [...(listeners.get(name) ?? [])]) callback({ type: name });
    },
  };
  const curveCalls = [];
  const gain = {
    value: 0.65,
    cancelAndHoldAtTime() {},
    cancelScheduledValues() {},
    setValueAtTime(value) { this.value = value; },
    setValueCurveAtTime(curve, startTime, duration) {
      curveCalls.push({ curve, startTime, duration });
      this.value = curve.at(-1);
    },
  };
  const media = {
    element,
    playing: true,
    context: { currentTime: 0, state: "running", sampleRate: 48000 },
    gain,
    gainNode: { gain },
    get volume() { return gain.value; },
    set volume(value) { gain.value = value; },
  };
  const playlist = {
    id: "stream-ready-playlist",
    name: "Stream Ready Playlist",
    getFlag() { return 0; },
  };
  const playlistSound = Object.assign(new PlaylistSound(), {
    id: "stream-ready-track",
    name: "Stream Ready Track",
    parent: playlist,
    playing: true,
    volume: 0.65,
    sound: media,
    getFlag() { return undefined; },
  });

  try {
    const startupToken = reserveFadeIn(media, { duration: 10, targetVol: 0.65 });
    const firstFade = applyFadeIn(playlist, playlistSound, {
      durationMs: 10,
      sound: media,
      startupToken,
      targetVolume: 0.65,
    });
    await Promise.resolve();

    assert.equal(gain.value, 0);
    assert.equal(curveCalls.length, 0);
    assert.equal(State.getFadeToken(media), startupToken);

    element.seeking = false;
    element.readyState = 3;
    element.emit("seeked");
    await firstFade;

    assert.equal(curveCalls.length, 1);
    assert.equal(curveCalls[0].curve[0], 0);
    assert.equal(curveCalls[0].duration, 0.01);
    assert.ok([...listeners.values()].every((callbacks) => callbacks.size === 0));

    State.clearFadingSound(media);
    element.seeking = true;
    element.readyState = 1;
    gain.value = 0.65;
    const lostToken = reserveFadeIn(media, { duration: 10, targetVol: 0.65 });
    const staleFade = applyFadeIn(playlist, playlistSound, {
      durationMs: 10,
      sound: media,
      startupToken: lostToken,
      targetVolume: 0.65,
    });
    await Promise.resolve();
    State.clearFadingSound(media, lostToken);
    element.seeking = false;
    element.readyState = 3;
    element.emit("playing");
    await staleFade;

    assert.equal(curveCalls.length, 1, "a stopped or replaced startup must not schedule a later ramp");
    assert.equal(State.isSoundFading(media), false);
    assert.ok([...listeners.values()].every((callbacks) => callbacks.size === 0));
  } finally {
    State.clearFadingSound(media);
  }
});

test("mid-segment skip-intro startup adopts explicit and already-advanced playback positions", async () => {
  const registrations = new Map();
  const previousLibWrapper = globalThis.libWrapper;
  const PreviousSound = foundry.audio.Sound;
  const originalAudioWait = foundry.audio.AudioTimeout.wait;
  const originalLoopStart = LoopingSound.prototype.start;
  let constructedSounds = 0;
  let pendingStartup = null;
  let startupWaitCalls = 0;
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };

  const makeScheduleHandle = () => ({
    cancelled: false,
    cancel() { this.cancelled = true; },
    catch() { return this; },
  });
  foundry.audio.Sound = class UnexpectedReplacementSound {
    constructor(path) {
      constructedSounds += 1;
      this.path = path;
      this.loaded = false;
      this.failed = false;
      this.playing = false;
      this.currentTime = 0;
      this.duration = 30;
      this.volume = 0.6;
      this.context = { currentTime: 0 };
    }

    async load() {
      this.loaded = true;
      return this;
    }

    async play(options = {}) {
      this.playing = true;
      this.currentTime = Number(options.offset) || 0;
      return this;
    }

    stop() { this.playing = false; }
    schedule() { return makeScheduleHandle(); }
    addEventListener() {}
    removeEventListener() {}
  };

  LoopingSound.prototype.start = function (...args) {
    pendingStartup = Promise.resolve(originalLoopStart.apply(this, args));
    return pendingStartup;
  };

  const scenarios = [
    {
      label: "explicit-mid-segment",
      options: { offset: 9.5 },
      expectedNativeOffset: 9.5,
      adoptedCurrentTime: 9.5,
    },
    {
      label: "delayed-adoption-inside-segment",
      options: {},
      expectedNativeOffset: 5,
      adoptedCurrentTime: 6.25,
    },
  ];

  try {
    // The historical implementation repeatedly waited for a position within
    // 0.5s of the segment start. Bound those waits so that regression fails
    // as an assertion instead of indefinitely draining the microtask queue.
    foundry.audio.AudioTimeout.wait = (duration = 0) => {
      if (Number(duration) !== 50 || !pendingStartup) return originalAudioWait(duration);
      startupWaitCalls += 1;
      if (startupWaitCalls > 8) {
        return Promise.reject(new Error("bounded mid-segment startup wait"));
      }
      return originalAudioWait(duration);
    };

    registerSoundPlaybackWrappers();
    const play = registrations.get("foundry.audio.Sound.prototype.play");

    for (const scenario of scenarios) {
      pendingStartup = null;
      startupWaitCalls = 0;
      constructedSounds = 0;
      const loopWithin = {
        enabled: true,
        active: true,
        startFromBeginning: false,
        segments: [{
          label: "Adopted Segment",
          start: "00:05.000",
          end: "00:15.000",
          crossfadeMs: 500,
          loopCount: 0,
          skipToNext: false,
        }],
      };
      const playlist = {
        id: `mid-segment-playlist-${scenario.label}`,
        name: `Mid-segment Playlist (${scenario.label})`,
        mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
        fade: 0,
        playing: true,
        isOwner: false,
        sounds: new TestSoundCollection(),
        getFlag() { return undefined; },
      };
      const media = {
        loaded: true,
        failed: false,
        playing: false,
        currentTime: 0,
        duration: 30,
        volume: 0.6,
        context: { currentTime: 0, state: "running", sampleRate: 48000 },
        stopCalls: 0,
        scheduleCalls: [],
        stop() {
          this.playing = false;
          this.stopCalls += 1;
        },
        schedule(callback, at) {
          this.scheduleCalls.push({ callback, at });
          return makeScheduleHandle();
        },
        addEventListener() {},
        removeEventListener() {},
      };
      const playlistSound = Object.assign(new PlaylistSound(), {
        id: `mid-segment-track-${scenario.label}`,
        uuid: `PlaylistSound.mid-segment-${scenario.label}`,
        name: `Mid-segment Track (${scenario.label})`,
        path: "mid-segment.ogg",
        parent: playlist,
        playing: true,
        pausedTime: null,
        repeat: false,
        volume: 0.6,
        sound: media,
        getFlag(_scope, key) {
          return key === "loopWithin" ? loopWithin : undefined;
        },
        _onEnd() {},
      });
      playlist.sounds.push(playlistSound);
      media._manager = playlistSound;
      let nativeOptions;

      try {
        await play.call(media, async (options) => {
          nativeOptions = { ...options };
          media.playing = true;
          // Model playback that has advanced before the delayed looper adopts
          // Foundry's original media object.
          media.currentTime = scenario.adoptedCurrentTime;
          media.volume = options.volume;
          return media;
        }, scenario.options);

        for (let attempt = 0; attempt < 20 && !pendingStartup; attempt += 1) {
          await Promise.resolve();
        }
        assert.ok(pendingStartup, `${scenario.label} should start its LoopingSound`);
        assert.equal(await pendingStartup, true, `${scenario.label} startup result`);

        const looper = State.getActiveLooper(playlistSound);
        assert.ok(looper, `${scenario.label} should retain looper ownership`);
        assert.equal(nativeOptions.offset, scenario.expectedNativeOffset, scenario.label);
        assert.equal(media.currentTime, scenario.adoptedCurrentTime, scenario.label);
        assert.equal(looper.isDestroyed, false, scenario.label);
        assert.equal(looper.activeLoopSegment?.startSec, 5, scenario.label);
        assert.equal(looper.activeLoopSegment?.endSec, 15, scenario.label);
        assert.equal(looper.soundA, media, scenario.label);
        assert.equal(looper.activeSound, media, scenario.label);
        assert.equal(playlistSound.sound, media, scenario.label);
        assert.equal(constructedSounds, 0, scenario.label);
        assert.equal(media.stopCalls, 0, scenario.label);
        assert.ok(startupWaitCalls <= 8, `${scenario.label} startup should settle without polling forever`);
      } finally {
        State.getActiveLooper(playlistSound)?.destroy(true);
        State.clearActiveLooper(playlistSound);
        delete media._manager;
      }
    }
  } finally {
    LoopingSound.prototype.start = originalLoopStart;
    foundry.audio.AudioTimeout.wait = originalAudioWait;
    foundry.audio.Sound = PreviousSound;
    globalThis.libWrapper = previousLibWrapper;
  }
});

function makeLateLoopStartupFixture(id, segments) {
  const scheduled = [];
  const media = {
    playing: true, currentTime: 0, duration: 1.2, volume: 0.5, stopCalls: 0,
    stop() { this.playing = false; this.stopCalls += 1; },
    schedule(callback, at) {
      const handle = { callback, at, cancelled: false, cancel() { this.cancelled = true; }, catch() { return this; } };
      scheduled.push(handle);
      return handle;
    },
  };
  const playlist = { id: `${id}-playlist`, fade: 0, getFlag() { return undefined; } };
  const sound = Object.assign(new PlaylistSound(), {
    id, name: id, parent: playlist, playing: true, volume: 0.5, sound: media,
    getFlag() { return undefined; },
  });
  const looper = new LoopingSound(sound, { startFromBeginning: true, segments });
  State.setActiveLooper(sound, looper);
  return { sound, media, looper, scheduled };
}

test("delayed intro loop startup adopts the current segment while preserving the intro and resume counts", async () => {
  const segment = {
    start: "00:00.100", end: "00:00.350", startSec: 0.1, endSec: 0.35,
    crossfadeMs: 50, loopCount: 3,
  };
  for (const position of [0, 0.15]) {
    const { sound, media, looper, scheduled } = makeLateLoopStartupFixture(`late-loop-${position}`, [segment]);
    try {
      const starting = looper.start();
      // Playback can advance while startup awaits the original media object.
      media.currentTime = position;
      assert.equal(await starting, true);
      assert.equal(State.getActiveLooper(sound), looper);
      assert.equal(looper.activeSound, media);
      assert.equal(media.currentTime, position, "initialization must not seek or restart playback");
      assert.equal(media.stopCalls, 0);
      if (position < segment.startSec) {
        assert.equal(looper.activeLoopSegment, null, "the intro must finish before looping starts");
        assert.equal(scheduled[0].at, segment.startSec);
      } else {
        assert.equal(looper.activeLoopSegment, segment);
        assert.ok(Math.abs(scheduled[0].at - 0.3) < 0.000001, "schedule the remaining segment's crossfade");
        assert.equal(looper.loopsCompleted, 0);
        looper.loopsCompleted = 1;
        looper.pause();
        looper.resume();
        assert.equal(looper.loopsCompleted, 1, "resume must preserve finite-loop progress");
        assert.equal(looper.activeLoopSegment, segment);
      }
    } finally {
      looper.destroy(true);
      State.clearActiveLooper(sound);
    }
  }
});

test("late intro loop startup skips finished segments and retires only after the final segment", async () => {
  const first = {
    start: "00:00.100", end: "00:00.350", startSec: 0.1, endSec: 0.35,
    crossfadeMs: 50, loopCount: 0,
  };
  const later = { ...first, start: "00:00.600", end: "00:00.900", startSec: 0.6, endSec: 0.9 };
  for (const segments of [[first], [first, later]]) {
    const { sound, media, looper, scheduled } = makeLateLoopStartupFixture(`finished-loop-${segments.length}`, segments);
    try {
      const starting = looper.start();
      media.currentTime = first.endSec;
      assert.equal(await starting, segments.length > 1);
      assert.equal(looper.activeLoopSegment, null, "an ended segment must not restart");
      assert.equal(media.currentTime, first.endSec);
      assert.equal(media.playing, true, "retirement must preserve the remaining native playback");
      assert.equal(media.stopCalls, 0);
      if (segments.length > 1) {
        assert.equal(State.getActiveLooper(sound), looper);
        assert.equal(scheduled[0].at, later.startSec);
      } else {
        assert.equal(looper.isDestroyed, true);
        assert.equal(State.getActiveLooper(sound), undefined);
        assert.equal(scheduled.length, 0);
      }
    } finally {
      looper.destroy(true);
      State.clearActiveLooper(sound);
    }
  }
});

test("internal-loop Sound.play offset precedence preserves beginning, resume, and explicit offsets", async () => {
  const registrations = new Map();
  const previousLibWrapper = globalThis.libWrapper;
  const originalWait = foundry.audio.AudioTimeout.wait;
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };

  const cases = [
    {
      label: "start from beginning",
      startFromBeginning: true,
      pausedTime: null,
      options: {},
      expectedOffset: 0,
      expectsScheduledLooper: true,
    },
    {
      label: "resume",
      startFromBeginning: false,
      pausedTime: 7.25,
      options: {},
      expectedOffset: 7.25,
      expectsScheduledLooper: false,
    },
    {
      label: "explicit fresh offset",
      startFromBeginning: false,
      pausedTime: null,
      options: { offset: 9.5 },
      expectedOffset: 9.5,
      expectsScheduledLooper: true,
    },
    {
      label: "explicit offset overrides resume",
      startFromBeginning: false,
      pausedTime: 7.25,
      options: { offset: 11.5 },
      expectedOffset: 11.5,
      expectsScheduledLooper: false,
    },
    {
      label: "zero paused time is fresh",
      startFromBeginning: false,
      pausedTime: 0,
      options: {},
      expectedOffset: 5,
      expectsScheduledLooper: true,
    },
    {
      label: "crossfade skip intro",
      startFromBeginning: false,
      pausedTime: null,
      options: { _fromCrossfade: true },
      expectedOffset: 5,
      expectsScheduledLooper: true,
    },
  ];

  try {
    // Keep newly scheduled loopers from starting; this test isolates the
    // wrapper's native-play contract and destroys each pending looper below.
    foundry.audio.AudioTimeout.wait = () => new Promise(() => {});
    registerSoundPlaybackWrappers();
    const play = registrations.get("foundry.audio.Sound.prototype.play");

    for (const scenario of cases) {
      const loopWithin = {
        enabled: true,
        active: true,
        startFromBeginning: scenario.startFromBeginning,
        segments: [{
          label: "Offset Contract",
          start: "00:05.000",
          end: "00:15.000",
          crossfadeMs: 500,
          loopCount: 0,
          skipToNext: false,
        }],
      };
      const playlist = {
        id: `offset-contract-playlist-${scenario.label}`,
        name: `Offset Contract Playlist (${scenario.label})`,
        mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
        fade: 0,
        playing: true,
        isOwner: false,
        sounds: new TestSoundCollection(),
        getFlag() { return undefined; },
      };
      const media = {
        loaded: true,
        failed: false,
        playing: false,
        currentTime: 0,
        duration: 30,
        volume: 0.6,
        stop() { this.playing = false; },
      };
      const playlistSound = Object.assign(new PlaylistSound(), {
        id: `offset-contract-track-${scenario.label}`,
        uuid: `PlaylistSound.offset-contract-${scenario.label}`,
        name: `Offset Contract Track (${scenario.label})`,
        path: "offset-contract.ogg",
        parent: playlist,
        playing: true,
        pausedTime: scenario.pausedTime,
        repeat: false,
        volume: 0.6,
        sound: media,
        getFlag(_scope, key) {
          return key === "loopWithin" ? loopWithin : undefined;
        },
        _onEnd() {},
      });
      playlist.sounds.push(playlistSound);
      media._manager = playlistSound;
      let receivedOptions;

      try {
        await play.call(media, async (options) => {
          receivedOptions = { ...options };
          media.playing = true;
          media.currentTime = Number(options.offset) || 0;
          return media;
        }, scenario.options);

        assert.equal(receivedOptions.offset, scenario.expectedOffset, scenario.label);
        assert.equal(
          Boolean(State.getActiveLooper(playlistSound)),
          scenario.expectsScheduledLooper,
          `${scenario.label} post-play ownership`
        );
      } finally {
        State.getActiveLooper(playlistSound)?.destroy(true);
        State.clearActiveLooper(playlistSound);
        delete media._manager;
      }
    }
  } finally {
    foundry.audio.AudioTimeout.wait = originalWait;
    globalThis.libWrapper = previousLibWrapper;
  }
});

test("Sound.play records native effective offsets including paused-time addition and playback bounds", async () => {
  const previous = { libWrapper: globalThis.libWrapper, user: game.user, users: game.users };
  const registrations = new Map();
  globalThis.libWrapper = {
    register(_module, target, callback) { registrations.set(target, callback); },
  };
  const gm = { id: "offset-clock-gm", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];
  const cases = [
    { label: "media resume", mediaPaused: 20, documentPaused: 15, options: {}, nativeOffset: undefined, clockOffset: 20 },
    { label: "document resume", mediaPaused: null, documentPaused: 20, options: {}, nativeOffset: 20, clockOffset: 20 },
    { label: "offset plus media resume", mediaPaused: 20, documentPaused: 15, options: { offset: 80 }, nativeOffset: 80, clockOffset: 100 },
    { label: "seek over document resume", mediaPaused: null, documentPaused: 20, options: { offset: 80 }, nativeOffset: 80, clockOffset: 80 },
    { label: "zero offset plus media resume", mediaPaused: 20, documentPaused: 20, options: { offset: 0 }, nativeOffset: 0, clockOffset: 20 },
    { label: "native playback bounds", mediaPaused: 20, documentPaused: 15, options: { offset: 80, loopStart: 10, loopEnd: 90 }, nativeOffset: 80, clockOffset: 90 },
    { label: "fresh seek", mediaPaused: null, documentPaused: null, options: { offset: 80 }, nativeOffset: 80, clockOffset: 80 },
    { label: "crossfade seek", mediaPaused: null, documentPaused: null, options: { offset: 80, _fromCrossfade: true }, nativeOffset: 80, clockOffset: 80 },
    { label: "missing start clock", mediaPaused: 20, documentPaused: 15, options: {}, nativeOffset: undefined, clockOffset: 20, startClock: "missing" },
    { label: "null start clock", mediaPaused: null, documentPaused: 20, options: {}, nativeOffset: 20, clockOffset: 20, startClock: "null" },
    { label: "null context clock", mediaPaused: null, documentPaused: 20, options: {}, nativeOffset: 20, clockOffset: 20, contextClock: null },
  ];

  try {
    registerSoundPlaybackWrappers();
    const play = registrations.get("foundry.audio.Sound.prototype.play");
    for (const scenario of cases) {
      let recordedClock;
      const playlist = {
        id: `offset-clock-${scenario.label}`,
        name: `Offset Clock ${scenario.label}`,
        mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
        fade: 0,
        playing: true,
        isOwner: true,
        sounds: new TestSoundCollection(),
        getFlag(_scope, key) { return key === "playbackClock" ? recordedClock : undefined; },
        async setFlag(_scope, key, value) {
          if (key === "playbackClock") recordedClock = value;
          return this;
        },
      };
      const media = {
        loaded: true, failed: false, playing: false,
        pausedTime: scenario.mediaPaused, currentTime: 0, duration: 120, volume: 0.6,
        context: { currentTime: 1000 },
      };
      const ps = Object.assign(new PlaylistSound(), {
        id: `offset-clock-track-${scenario.label}`,
        uuid: `PlaylistSound.offset-clock-${scenario.label}`,
        name: `Offset Clock Track ${scenario.label}`,
        parent: playlist, sound: media, playing: true, pausedTime: scenario.documentPaused,
        repeat: false, volume: 0.6,
        getFlag() { return undefined; },
      });
      playlist.sounds.push(ps);
      media._manager = ps;
      let nativeOptions;
      let startedOffset;
      const before = Date.now();
      try {
        await play.call(media, async (options) => {
          nativeOptions = { ...options };
          assert.equal(media.pausedTime, scenario.mediaPaused, "the wrapper must preserve native pausedTime");
          // Verified against installed v14.367 #configurePlayback and
          // #queuePlay: finite pausedTime is added even to explicit offsets,
          // then non-loop playback bounds clamp the effective start.
          const loopStart = options.loopStart ?? 0;
          startedOffset = options.offset ?? loopStart;
          if (Number.isFinite(media.pausedTime)) startedOffset += media.pausedTime;
          if (!options.loop && Number.isFinite(options.loopEnd)) {
            startedOffset = Math.min(Math.max(startedOffset, loopStart), options.loopEnd);
          }
          media.startTime = media.context.currentTime - startedOffset;
          if (scenario.startClock === "missing") delete media.startTime;
          if (scenario.startClock === "null") media.startTime = null;
          if (scenario.contextClock === null) media.context.currentTime = null;
          media.playing = true;
          media.pausedTime = undefined;
          // Streamed media can still expose zero when native play resolves.
          media.currentTime = 0;
          return media;
        }, scenario.options);
        const after = Date.now();
        assert.equal(nativeOptions.offset, scenario.nativeOffset, scenario.label);
        assert.equal(startedOffset, scenario.clockOffset, scenario.label);
        assert.equal(recordedClock?.offsetSec, scenario.clockOffset, scenario.label);
        assert.equal(recordedClock.expectedEndAt - recordedClock.startedAt, 120000);
        const recordedAt = recordedClock.startedAt + scenario.clockOffset * 1000;
        assert.ok(recordedAt >= before && recordedAt <= after, scenario.label);

        if (scenario.label === "fresh seek") {
          // Calls outside Sound.play also use null as the default offset.
          // They must adopt live time, then document time if media is absent,
          // while preserving an explicitly supplied zero.
          media.currentTime = 80;
          let clock = await PlaybackClock.record(playlist, ps, media, { force: true });
          assert.equal(clock.offsetSec, 80);
          media.currentTime = null;
          ps.pausedTime = 20;
          clock = await PlaybackClock.record(playlist, ps, media, { force: true });
          assert.equal(clock.offsetSec, 20);
          clock = await PlaybackClock.record(playlist, ps, media, { force: true, offsetSec: 0 });
          assert.equal(clock.offsetSec, 0);
        }
      } finally {
        delete media._manager;
      }
    }
  } finally {
    globalThis.libWrapper = previous.libWrapper;
    game.user = previous.user;
    game.users = previous.users;
  }
});

function makeDelayedClockFixture(id, { rejectFirstWrite = false, onWrite } = {}) {
  let releaseFirstWrite;
  let signalFirstWrite;
  const firstWriteGate = new Promise((resolve) => { releaseFirstWrite = resolve; });
  const firstWriteStarted = new Promise((resolve) => { signalFirstWrite = resolve; });
  const flags = new Map();
  const calls = [];
  let writes = 0;
  const playlist = {
    id,
    name: id,
    isOwner: true,
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    fade: 0,
    getFlag(_scope, key) { return flags.get(key); },
    async setFlag(_scope, key, value) {
      calls.push(`set:${value.reason}`);
      if (++writes === 1) {
        signalFirstWrite();
        await firstWriteGate;
        if (rejectFirstWrite) throw new Error("injected first clock write failure");
      }
      flags.set(key, value);
      // Foundry's update hooks run synchronously and do not await the
      // promises returned by hook callbacks.
      onWrite?.(value);
    },
    async unsetFlag(_scope, key) {
      calls.push("clear");
      flags.delete(key);
    },
  };
  const sound = {
    id: `${id}-sound`,
    name: "Clock Track",
    parent: playlist,
    repeat: false,
    getFlag() { return undefined; },
  };
  return {
    playlist, sound, media: { duration: 120, currentTime: 0 }, calls,
    firstWriteStarted, releaseFirstWrite,
  };
}

test("Stop drains a first pending clock write before clearing its persisted flag", { timeout: 1000 }, async () => {
  const previous = { user: game.user, users: game.users };
  const gm = { id: "pending-clock-stop-gm", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];
  const fixture = makeDelayedClockFixture("pending-clock-stop");

  try {
    const recording = PlaybackClock.record(fixture.playlist, fixture.sound, fixture.media, { reason: "first" });
    await fixture.firstWriteStarted;
    assert.equal(PlaybackClock.get(fixture.playlist), null);
    let clearSettled = false;
    const clearing = PlaybackClock.clear(fixture.playlist, "stopAll completed").then((result) => {
      clearSettled = true;
      return result;
    });
    await Promise.resolve();
    assert.equal(clearSettled, false, "Stop must wait even though the first flag is not persisted yet");
    assert.deepEqual(fixture.calls, ["set:first"]);

    fixture.releaseFirstWrite();
    await recording;
    assert.equal(await clearing, true);
    assert.deepEqual(fixture.calls, ["set:first", "clear"]);
    assert.equal(PlaybackClock.get(fixture.playlist), null);
  } finally {
    fixture.releaseFirstWrite();
    game.user = previous.user;
    game.users = previous.users;
  }
});

test("a later Play retains its clock after queued Stop, including a rejected earlier write", { timeout: 1000 }, async () => {
  const previous = { user: game.user, users: game.users, now: Date.now };
  const gm = { id: "pending-clock-play-gm", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];
  let now = 10000;
  Date.now = () => now;

  try {
    for (const rejectFirstWrite of [false, true]) {
      const fixture = makeDelayedClockFixture(`pending-clock-play-${rejectFirstWrite}`, { rejectFirstWrite });
      now = 10000;
      const firstResult = PlaybackClock.record(fixture.playlist, fixture.sound, fixture.media, { reason: "first" })
        .then((value) => ({ value }), (error) => ({ error }));
      await fixture.firstWriteStarted;
      const clearing = PlaybackClock.clear(fixture.playlist, "stopAll completed");
      // Restart the same track within the normal clock-deduplication window.
      now = 10050;
      const later = PlaybackClock.record(fixture.playlist, fixture.sound, fixture.media, { reason: "later Play" });
      now = 20000;
      fixture.releaseFirstWrite();

      const first = await firstResult;
      assert.equal(Boolean(first.error), rejectFirstWrite);
      assert.equal(await clearing, !rejectFirstWrite);
      const latestClock = await later;
      assert.equal(latestClock.reason, "later Play");
      assert.equal(latestClock.startedAt, 10050, "queued writes retain the actual playback start time");
      assert.equal(PlaybackClock.get(fixture.playlist), latestClock);
      assert.deepEqual(fixture.calls, rejectFirstWrite
        ? ["set:first", "set:later Play"]
        : ["set:first", "clear", "set:later Play"]);
      if (first.value) assert.ok(latestClock.clockSeq > first.value.clockSeq);
    }
  } finally {
    Date.now = previous.now;
    game.user = previous.user;
    game.users = previous.users;
  }
});

test("queued clock mutations recheck authority before writing", { timeout: 1000 }, async () => {
  const previous = { user: game.user, users: game.users };
  const gm = { id: "pending-clock-authority-gm", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];
  const fixture = makeDelayedClockFixture("pending-clock-authority");

  try {
    const recording = PlaybackClock.record(fixture.playlist, fixture.sound, fixture.media, { reason: "first" });
    await fixture.firstWriteStarted;
    const clearing = PlaybackClock.clear(fixture.playlist, "queued Stop");
    const later = PlaybackClock.record(fixture.playlist, fixture.sound, fixture.media, { reason: "queued Play", force: true });
    game.users = [{ id: "replacement-clock-gm", isGM: true, active: true }];
    fixture.releaseFirstWrite();
    const committedClock = await recording;

    assert.equal(await clearing, false);
    assert.equal(await later, null);
    assert.deepEqual(fixture.calls, ["set:first"], "former authority must issue no queued database writes");
    assert.equal(PlaybackClock.get(fixture.playlist), committedClock,
      "the already-sent write can finish, while follow-up recovery belongs to the new authority");
  } finally {
    fixture.releaseFirstWrite();
    game.user = previous.user;
    game.users = previous.users;
  }
});

test("native-style synchronous update hooks can queue clock cleanup without deadlocking", { timeout: 1000 }, async () => {
  const previous = { user: game.user, users: game.users };
  const gm = { id: "reentrant-clock-gm", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];
  let hookCleanup;
  const fixture = makeDelayedClockFixture("reentrant-clock", {
    onWrite() {
      hookCleanup = PlaybackClock.clear(fixture.playlist, "update hook");
      return hookCleanup;
    },
  });

  try {
    const recording = PlaybackClock.record(fixture.playlist, fixture.sound, fixture.media, { reason: "first" });
    await fixture.firstWriteStarted;
    fixture.releaseFirstWrite();
    await recording;
    assert.equal(await hookCleanup, true);
    assert.deepEqual(fixture.calls, ["set:first", "clear"]);
    assert.equal(PlaybackClock.get(fixture.playlist), null);
  } finally {
    fixture.releaseFirstWrite();
    game.user = previous.user;
    game.users = previous.users;
  }
});

test("direct media resume preserves its paused looper without injecting a skip-intro offset", async () => {
  const registrations = new Map();
  const previousLibWrapper = globalThis.libWrapper;
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };

  const loopWithin = {
    enabled: true,
    active: true,
    startFromBeginning: false,
    segments: [{
      label: "Direct Pause Segment",
      start: "00:05.000",
      end: "00:15.000",
      crossfadeMs: 500,
      loopCount: 0,
      skipToNext: false,
    }],
  };
  const playlist = {
    id: "direct-media-resume-playlist",
    name: "Direct Media Resume Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    fade: 0,
    playing: true,
    isOwner: false,
    sounds: new TestSoundCollection(),
    getFlag() { return undefined; },
  };
  const scheduleHandles = [];
  const media = {
    loaded: true,
    failed: false,
    playing: true,
    pausedTime: null,
    currentTime: 8.25,
    duration: 30,
    volume: 0.6,
    stopCalls: 0,
    schedule(callback, at) {
      const handle = {
        callback,
        at,
        cancelled: false,
        cancel() { this.cancelled = true; },
        catch() { return this; },
      };
      scheduleHandles.push(handle);
      return handle;
    },
    stop() {
      this.playing = false;
      this.stopCalls += 1;
    },
  };
  const playlistSound = Object.assign(new PlaylistSound(), {
    id: "direct-media-resume-track",
    uuid: "PlaylistSound.direct-media-resume-track",
    name: "Direct Media Resume Track",
    path: "direct-media-resume.ogg",
    parent: playlist,
    playing: true,
    pausedTime: null,
    repeat: false,
    volume: 0.6,
    sound: media,
    getFlag(_scope, key) {
      return key === "loopWithin" ? loopWithin : undefined;
    },
    _onEnd() {},
  });
  playlist.sounds.push(playlistSound);
  media._manager = playlistSound;

  const config = Flags.getLoopConfig(playlistSound);
  const looper = new LoopingSound(playlistSound, config);
  looper.soundA = media;
  looper.activeLoopSegment = config.segments[0];
  looper.loopsCompleted = 2;
  State.setActiveLooper(playlistSound, looper);

  try {
    registerSoundPlaybackWrappers();
    const pause = registrations.get("foundry.audio.Sound.prototype.pause");
    const play = registrations.get("foundry.audio.Sound.prototype.play");

    assert.equal(
      pause.call(media, function () {
        this.playing = false;
        this.pausedTime = 8.25;
        return this;
      }),
      media
    );
    assert.equal(playlistSound.pausedTime, null);
    assert.ok(looper.pausedSnapshot, "direct Sound.pause should snapshot the existing looper");
    const pausedGeneration = looper._handoffGeneration;
    const pausedSnapshot = looper.pausedSnapshot;
    let nativeOptions;

    assert.equal(
      await play.call(media, async function (options) {
        nativeOptions = { ...options };
        this.playing = true;
        this.currentTime = this.pausedTime;
        this.pausedTime = null;
        return this;
      }),
      media
    );

    assert.equal(nativeOptions.offset, undefined);
    assert.notEqual(nativeOptions.offset, config.segments[0].startSec);
    assert.equal(State.getActiveLooper(playlistSound), looper);
    assert.equal(looper.isDestroyed, false);
    assert.equal(looper._handoffGeneration, pausedGeneration);
    assert.notEqual(pausedSnapshot, null);
    assert.equal(looper.pausedSnapshot, null, "resumeLoopWithin should consume the paused snapshot");
    assert.equal(looper.activeLoopSegment, config.segments[0]);
    assert.equal(looper.soundA, media);
    assert.equal(playlistSound.sound, media);
    assert.equal(media.currentTime, 8.25);
    assert.equal(media.stopCalls, 0);
    assert.equal(scheduleHandles.length, 1, "the resumed loop should re-arm on the original media");
  } finally {
    State.getActiveLooper(playlistSound)?.destroy(true);
    State.clearActiveLooper(playlistSound);
    delete media._manager;
    globalThis.libWrapper = previousLibWrapper;
  }
});

test("zero document pause resumes an existing paused looper instead of replacing it", async () => {
  const registrations = new Map();
  const previousLibWrapper = globalThis.libWrapper;
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };

  const loopWithin = {
    enabled: true,
    active: true,
    startFromBeginning: false,
    segments: [{
      label: "Zero Pause Segment",
      start: "00:05.000",
      end: "00:15.000",
      crossfadeMs: 500,
      loopCount: 0,
      skipToNext: false,
    }],
  };
  const playlist = {
    id: "zero-pause-resume-playlist",
    name: "Zero Pause Resume Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    fade: 0,
    playing: true,
    isOwner: false,
    sounds: new TestSoundCollection(),
    getFlag() { return undefined; },
  };
  const scheduleHandles = [];
  const media = {
    loaded: true,
    failed: false,
    playing: true,
    currentTime: 8.25,
    duration: 30,
    volume: 0.6,
    stopCalls: 0,
    schedule(callback, at) {
      const handle = {
        callback,
        at,
        cancelled: false,
        cancel() { this.cancelled = true; },
        catch() { return this; },
      };
      scheduleHandles.push(handle);
      return handle;
    },
    stop() {
      this.playing = false;
      this.stopCalls += 1;
    },
  };
  const playlistSound = Object.assign(new PlaylistSound(), {
    id: "zero-pause-resume-track",
    uuid: "PlaylistSound.zero-pause-resume-track",
    name: "Zero Pause Resume Track",
    path: "zero-pause-resume.ogg",
    parent: playlist,
    playing: true,
    pausedTime: 0,
    repeat: false,
    volume: 0.6,
    sound: media,
    getFlag(_scope, key) {
      return key === "loopWithin" ? loopWithin : undefined;
    },
    _onEnd() {},
  });
  playlist.sounds.push(playlistSound);
  media._manager = playlistSound;

  const config = Flags.getLoopConfig(playlistSound);
  const looper = new LoopingSound(playlistSound, config);
  looper.soundA = media;
  looper.activeLoopSegment = config.segments[0];
  looper.loopsCompleted = 1;
  State.setActiveLooper(playlistSound, looper);
  looper.pause();
  media.playing = false;
  delete media.pausedTime;

  try {
    assert.ok(looper.pausedSnapshot, "the existing looper must carry resume ownership");
    assert.equal(playlistSound.pausedTime, 0);
    assert.equal(media.pausedTime, undefined);
    const pausedGeneration = looper._handoffGeneration;
    registerSoundPlaybackWrappers();
    const play = registrations.get("foundry.audio.Sound.prototype.play");
    let nativeOptions;

    assert.equal(
      await play.call(media, async function (options) {
        nativeOptions = { ...options };
        this.playing = true;
        this.currentTime = Number(options.offset) || 0;
        return this;
      }),
      media
    );

    assert.equal(nativeOptions.offset, 0);
    assert.notEqual(nativeOptions.offset, config.segments[0].startSec);
    assert.equal(State.getActiveLooper(playlistSound), looper);
    assert.equal(looper.isDestroyed, false);
    assert.equal(looper._handoffGeneration, pausedGeneration);
    assert.equal(looper.pausedSnapshot, null, "the paused looper should take the resume path");
    assert.equal(looper.activeLoopSegment, config.segments[0]);
    assert.equal(looper.soundA, media);
    assert.equal(playlistSound.sound, media);
    assert.equal(media.stopCalls, 0);
    assert.equal(scheduleHandles.length, 1);
  } finally {
    State.getActiveLooper(playlistSound)?.destroy(true);
    State.clearActiveLooper(playlistSound);
    delete media._manager;
    globalThis.libWrapper = previousLibWrapper;
  }
});

test("native gap pause hook cancels the timer and finalizes one cancellation", async () => {
  const unregister = registerPlaybackDocumentHooksForTest();
  const previous = { user: game.user, users: game.users };
  const gm = { id: "pause-gap-gm", name: "Pause Gap GM", isGM: true, active: true };
  const users = [gm];
  users.get = (id) => users.find((user) => user.id === id);
  game.user = gm;
  game.users = users;

  let timerCancelled = false;
  let resolved;
  const events = [];
  const playlist = {
    id: "native-pause-gap-playlist",
    name: "Native Pause Gap Playlist",
    isOwner: true,
    playing: true,
    sounds: new TestSoundCollection(),
  };
  const media = {
    playing: true,
    stop() { this.playing = false; },
  };
  const gap = makeTestSound({
    id: "native-pause-gap",
    parent: playlist,
    playing: false,
    sound: media,
    flags: { isSilenceGap: true, gapDuration: 1000 },
  });
  playlist.sounds.push(gap);
  const state = {
    gap,
    cancelled: false,
    completionAttempt: null,
    deletingForCompletion: false,
    timer: { cancel() { timerCancelled = true; } },
    resolve(value) { resolved = value; },
  };
  State.setSilenceState(playlist, state);
  const onSilenceEnd = (event) => {
    if (event?.playlist === playlist) events.push(event);
  };
  Hooks.on("the-sound-of-silence.silenceEnd", onSilenceEnd);

  try {
    Hooks.callAll("updatePlaylistSound", gap, { playing: false, pausedTime: 0.5 }, {}, gm.id);
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(timerCancelled, true);
    assert.equal(resolved, true);
    assert.equal(state.cancelled, true);
    assert.equal(State.getSilenceState(playlist), undefined);
    assert.equal(playlist.sounds.has(gap.id), false);
    assert.equal(media.playing, false);
    assert.deepEqual(events.map(({ completed, cancelled }) => ({ completed, cancelled })), [
      { completed: false, cancelled: true },
    ]);
  } finally {
    Hooks.off("the-sound-of-silence.silenceEnd", onSilenceEnd);
    State.clearSilenceState(playlist);
    unregister();
    game.user = previous.user;
    game.users = previous.users;
  }
});

test("natural-completion guards keep gap stop updates from becoming cancellations", async () => {
  const unregister = registerPlaybackDocumentHooksForTest();
  const previous = { user: game.user, users: game.users, playlists: game.playlists };
  const gm = { id: "natural-guard-gm", name: "Natural Guard GM", isGM: true, active: true };
  const users = [gm];
  users.get = (id) => users.find((user) => user.id === id);
  game.user = gm;
  game.users = users;

  try {
    for (const guard of ["completionAttempt", "deletingForCompletion"]) {
      let timerCancelCalls = 0;
      let resolveCalls = 0;
      const events = [];
      const playlist = {
        id: `natural-${guard}-playlist`,
        name: `Natural ${guard} Playlist`,
        isOwner: true,
        playing: true,
        sounds: new TestSoundCollection(),
      };
      const gap = makeTestSound({
        id: `natural-${guard}-gap`,
        parent: playlist,
        playing: false,
        flags: { isSilenceGap: true, gapDuration: 1000 },
      });
      playlist.sounds.push(gap);
      game.playlists = [playlist];
      const state = {
        gap,
        cancelled: false,
        completionAttempt: guard === "completionAttempt" ? Promise.resolve(true) : null,
        deletingForCompletion: guard === "deletingForCompletion",
        timer: { cancel() { timerCancelCalls += 1; } },
        resolve() { resolveCalls += 1; },
      };
      State.setSilenceState(playlist, state);
      const onSilenceEnd = (event) => {
        if (event?.playlist === playlist) events.push(event);
      };
      Hooks.on("the-sound-of-silence.silenceEnd", onSilenceEnd);

      try {
        Hooks.callAll("updatePlaylist", playlist, {
          sounds: [{ _id: gap.id, playing: false, pausedTime: null }],
        }, {}, gm.id);
        await new Promise((resolve) => setTimeout(resolve, 5));

        assert.equal(State.getSilenceState(playlist), state, `${guard} must retain natural ownership`);
        assert.equal(state.cancelled, false, `${guard} must not classify the stop as cancellation`);
        assert.equal(timerCancelCalls, 0);
        assert.equal(resolveCalls, 0);
        assert.equal(playlist.sounds.has(gap.id), true);
        assert.deepEqual(events, []);
      } finally {
        Hooks.off("the-sound-of-silence.silenceEnd", onSilenceEnd);
        State.clearSilenceState(playlist, state);
      }
    }
  } finally {
    unregister();
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

test("Play All excludes an orphan silence document from sequential selection", async () => {
  const registrations = new Map();
  const previousLibWrapper = globalThis.libWrapper;
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };

  const playlist = {
    id: "orphan-gap-play-all",
    name: "Orphan Gap Play All",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    isOwner: false,
    playbackOrder: ["orphan-gap", "first-real", "second-real"],
    sounds: new TestSoundCollection(),
    getFlag() { return undefined; },
    async update(changes) {
      for (const update of changes.sounds ?? []) {
        Object.assign(this.sounds.get(update._id), update);
      }
      this.playing = Boolean(changes.playing);
      return this;
    },
  };
  const gap = makeTestSound({
    id: "orphan-gap",
    parent: playlist,
    playing: true,
    flags: { isSilenceGap: true },
  });
  const first = makeTestSound({ id: "first-real", parent: playlist });
  const second = makeTestSound({ id: "second-real", parent: playlist });
  playlist.sounds.push(gap, first, second);

  try {
    registerPlaylistAdvanceWrappers();
    const playAll = registrations.get("Playlist.prototype.playAll");
    let nativeCalls = 0;
    assert.equal(
      await playAll.call(playlist, async () => {
        nativeCalls += 1;
        return playlist;
      }),
      playlist
    );
    assert.equal(nativeCalls, 0);
    assert.equal(first.playing, true);
    assert.equal(second.playing, false);
    assert.equal(gap.playing, false);
    assert.equal(gap.pausedTime, null);
  } finally {
    globalThis.libWrapper = previousLibWrapper;
  }
});

test("Soundboard Play All stops an orphan gap without stopping active real tracks", async () => {
  const registrations = new Map();
  const previousLibWrapper = globalThis.libWrapper;
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };

  let updateCalls = 0;
  const playlist = {
    id: "orphan-gap-soundboard-play-all",
    name: "Orphan Gap Soundboard Play All",
    mode: CONST.PLAYLIST_MODES.DISABLED,
    playing: true,
    isOwner: false,
    playbackOrder: ["orphan-gap", "active-one", "inactive", "active-two"],
    sounds: new TestSoundCollection(),
    getFlag() { return undefined; },
    async update(changes) {
      updateCalls += 1;
      for (const update of changes.sounds ?? []) {
        Object.assign(this.sounds.get(update._id), update);
      }
      if (Object.prototype.hasOwnProperty.call(changes, "playing")) {
        this.playing = Boolean(changes.playing);
      }
      return this;
    },
  };
  const gap = makeTestSound({
    id: "orphan-gap",
    parent: playlist,
    playing: true,
    flags: { isSilenceGap: true },
  });
  const activeOne = makeTestSound({ id: "active-one", parent: playlist, playing: true });
  const inactive = makeTestSound({ id: "inactive", parent: playlist, playing: false });
  const activeTwo = makeTestSound({ id: "active-two", parent: playlist, playing: true });
  playlist.sounds.push(gap, activeOne, inactive, activeTwo);

  try {
    registerPlaylistAdvanceWrappers();
    const playAll = registrations.get("Playlist.prototype.playAll");
    let nativeCalls = 0;
    assert.equal(
      await playAll.call(playlist, async () => {
        nativeCalls += 1;
        return playlist;
      }),
      playlist
    );

    assert.equal(nativeCalls, 0);
    assert.equal(updateCalls, 1);
    assert.equal(activeOne.playing, true);
    assert.equal(activeTwo.playing, true);
    assert.equal(inactive.playing, false);
    assert.equal(gap.playing, false);
    assert.equal(gap.pausedTime, null);
  } finally {
    globalThis.libWrapper = previousLibWrapper;
  }
});

test("Stop All forces a delete-failed silence document inactive", async () => {
  const registrations = new Map();
  const previousLibWrapper = globalThis.libWrapper;
  const previous = { user: game.user, users: game.users };
  globalThis.libWrapper = {
    register(_module, target, callback) {
      registrations.set(target, callback);
    },
  };
  game.user = { id: "stop-player", isGM: false, active: true };
  game.users = [game.user];

  let deleteCalls = 0;
  const media = {
    playing: true,
    stop() { this.playing = false; },
  };
  const playlist = {
    id: "delete-failed-gap-stop-all",
    name: "Delete Failed Gap Stop All",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    fade: 0,
    playing: true,
    isOwner: true,
    sounds: new TestSoundCollection(),
    getFlag() { return undefined; },
    async updateEmbeddedDocuments(_type, updates) {
      for (const update of updates) Object.assign(this.sounds.get(update._id), update);
      return updates;
    },
    async update(changes) {
      if (Object.prototype.hasOwnProperty.call(changes, "playing")) {
        this.playing = Boolean(changes.playing);
      }
      return this;
    },
  };
  const gap = makeTestSound({
    id: "delete-failed-gap",
    parent: playlist,
    playing: true,
    sound: media,
    flags: { isSilenceGap: true },
  });
  gap.delete = async () => {
    deleteCalls += 1;
    throw new Error("injected delete failure");
  };
  playlist.sounds.push(gap);

  try {
    registerPlaylistCommandWrappers();
    const stopAll = registrations.get("Playlist.prototype.stopAll");
    assert.equal(await stopAll.call(playlist), playlist);
    assert.equal(deleteCalls, 1);
    assert.equal(playlist.sounds.has(gap.id), true);
    assert.equal(gap.playing, false);
    assert.equal(gap.pausedTime, null);
    assert.equal(media.playing, false);
    assert.equal(playlist.playing, false);
  } finally {
    State.clearStoppingFlag(playlist);
    globalThis.libWrapper = previousLibWrapper;
    game.user = previous.user;
    game.users = previous.users;
  }
});

test("silence cleanup stops a surviving gap before releasing state ownership", async () => {
  const previous = { user: game.user, users: game.users };
  const gm = { id: "cleanup-gap-gm", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];

  let resolved;
  let timerCancelled = false;
  const playlist = {
    id: "surviving-gap-cleanup",
    name: "Surviving Gap Cleanup",
    sounds: new TestSoundCollection(),
  };
  const gap = makeTestSound({
    id: "surviving-gap",
    parent: playlist,
    playing: true,
    flags: { isSilenceGap: true, gapDuration: 1000 },
  });
  gap.delete = async () => {
    throw new Error("injected delete failure");
  };
  gap.update = async (changes) => {
    Object.assign(gap, changes);
    return gap;
  };
  playlist.sounds.push(gap);
  const silenceState = {
    gap,
    cancelled: false,
    timer: { cancel() { timerCancelled = true; } },
    resolve(value) { resolved = value; },
  };
  State.setSilenceState(playlist, silenceState);

  try {
    await State.cleanup(playlist, {
      cleanSilence: true,
      cleanCrossfade: false,
      cleanLoopers: false,
      cleanSoundscape: false,
    });
    assert.equal(timerCancelled, true);
    assert.equal(resolved, true);
    assert.equal(gap.playing, false);
    assert.equal(gap.pausedTime, null);
    assert.equal(playlist.sounds.has(gap.id), true);
    assert.equal(State.getSilenceState(playlist), undefined);
  } finally {
    State.clearSilenceState(playlist);
    game.user = previous.user;
    game.users = previous.users;
  }
});

test("reconciliation cannot recover a cancelled gap after delete and forced-stop both fail", async () => {
  const previous = {
    user: game.user,
    users: game.users,
    playlists: game.playlists,
    setTimeout: globalThis.setTimeout,
  };
  const gm = { id: "double-failure-gm", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];

  const scheduled = [];
  globalThis.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };

  let deleteCalls = 0;
  let stopUpdateCalls = 0;
  let timerCancelCalls = 0;
  const resolutionValues = [];
  const playlist = {
    id: "cancelled-double-failure-playlist",
    name: "Cancelled Double Failure Playlist",
    isOwner: true,
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    playbackOrder: ["source", "cancelled-gap"],
    sounds: new TestSoundCollection(),
    getFlag() { return undefined; },
  };
  const source = makeTestSound({ id: "source", parent: playlist });
  const gap = makeTestSound({
    id: "cancelled-gap",
    parent: playlist,
    playing: true,
    flags: {
      isSilenceGap: true,
      gapDuration: 60000,
      gapStarted: Date.now(),
      gapSourceSoundId: source.id,
    },
  });
  gap.delete = async () => {
    deleteCalls += 1;
    throw new Error("injected persistent delete failure");
  };
  gap.update = async () => {
    stopUpdateCalls += 1;
    throw new Error("injected persistent stop failure");
  };
  playlist.sounds.push(source, gap);
  game.playlists = [playlist];
  const cancelledState = {
    sourceSound: source,
    sourceSoundId: source.id,
    gap,
    gapMs: 60000,
    startedAt: Date.now(),
    expectedEndAt: Date.now() + 60000,
    cancelled: false,
    completed: false,
    advancementComplete: false,
    completionAttempt: null,
    deletingForCompletion: false,
    timer: { cancel() { timerCancelCalls += 1; } },
    resolve(value) { resolutionValues.push(value); },
  };
  State.setSilenceState(playlist, cancelledState);

  try {
    await State.cleanup(playlist, {
      cleanSilence: true,
      cleanCrossfade: false,
      cleanLoopers: false,
      cleanSoundscape: false,
    });

    assert.equal(deleteCalls, 1);
    assert.equal(stopUpdateCalls, 1);
    assert.equal(timerCancelCalls, 1);
    assert.equal(cancelledState.cancelled, true);
    assert.equal(cancelledState.cleanupRetryScheduled, true);
    assert.equal(State.getSilenceState(playlist), cancelledState);
    assert.equal(gap.playing, true);
    assert.deepEqual(resolutionValues, []);
    assert.equal(scheduled.length, 1);

    assert.equal(await recoverPersistedSilenceGaps("before cancelled cleanup retry"), false);
    const stateAfterRecovery = State.getSilenceState(playlist);
    assert.notEqual(stateAfterRecovery?.recovered, true);
    assert.ok(
      stateAfterRecovery === undefined || stateAfterRecovery === cancelledState,
      "reconciliation must not replace cancelled cleanup ownership with a recovered timer"
    );
    assert.deepEqual(resolutionValues, []);
  } finally {
    State.getSilenceState(playlist)?.timer?.cancel?.();
    State.clearSilenceState(playlist);
    globalThis.setTimeout = previous.setTimeout;
    game.user = previous.user;
    game.users = previous.users;
    game.playlists = previous.playlists;
  }
});

test("playlist looping and crossfade preload skip temporary silence documents", async () => {
  const previous = { user: game.user, users: game.users };
  const gm = { id: "filtered-order-gm", isGM: true, active: true };
  game.user = gm;
  game.users = [gm];

  const selected = [];
  const playlist = {
    id: "filtered-loop-playlist",
    name: "Filtered Loop Playlist",
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    playing: true,
    isOwner: true,
    playbackOrder: ["gap", "first", "source", "target"],
    sounds: new TestSoundCollection(),
    getFlag(_scope, key) { return key === "loopPlaylist"; },
    async playSound(sound) {
      selected.push(sound.id);
      return this;
    },
  };
  const first = makeTestSound({ id: "first", parent: playlist });
  const source = makeTestSound({ id: "source", parent: playlist });
  const target = makeTestSound({ id: "target", parent: playlist });
  const gap = makeTestSound({
    id: "gap",
    parent: playlist,
    playing: true,
    flags: { isSilenceGap: true },
  });
  playlist.sounds.push(first, source, target, gap);

  try {
    assert.equal(resolveNextCrossfadeSound(playlist, source), target);
    assert.equal(await maybeLoopPlaylist(playlist), playlist);
    assert.deepEqual(selected, ["first"]);
  } finally {
    game.user = previous.user;
    game.users = previous.users;
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
