import test from "node:test";
import assert from "node:assert/strict";

// The Foundry globals (foundry, game, Hooks, CONST, PlaylistSound) are
// installed by runtime-boundaries.test.js, which run-tests.js imports first.
const { State } = await import("../scripts/state-manager.js");
const {
  activateCrossfadeSession,
  createCrossfadeSession,
  settleCrossfadeSession,
} = await import("../scripts/playback/transition-session.js");
const { equalPowerCrossfade, scheduleEndOfTrackFade } = await import("../scripts/audio-fader.js");
const { Flags } = await import("../scripts/flag-service.js");
const { performCrossfade, prepareIncomingCrossfadeMedia } = await import("../scripts/cross-fade.js");
const { registerPlaylistCommandWrappers } = await import("../scripts/playlist/playlist-command-wrappers.js");
const { API } = await import("../scripts/api.js");
const { USER_QUERIES, audioTimerOptions, debounceByKey, queryUserWithTimeout } = await import("../scripts/utils.js");

function makeGain(value) {
  return {
    value,
    curves: [],
    cancelAndHoldAtTime() {},
    cancelScheduledValues() {},
    setValueAtTime(next) { this.value = next; },
    setValueCurveAtTime(curve) { this.curves.push(Array.from(curve)); this.value = curve.at(-1); },
    linearRampToValueAtTime(next) { this.value = next; },
  };
}

function makeMedia(id, { playing = true, gain = 0.5, context = { currentTime: 0 } } = {}) {
  return {
    id,
    playing,
    context,
    gain: makeGain(gain),
    get volume() { return this.gain.value; },
    set volume(value) { this.gain.value = value; },
    stopCalls: 0,
    stop() { this.playing = false; this.stopCalls++; },
    async play() { this.playing = true; },
  };
}

class SoundCollection extends Array {
  static get [Symbol.species]() { return Array; }
  get(id) { return this.find((sound) => sound.id === id); }
  has(id) { return Boolean(this.get(id)); }
}

function makePlaylist(id, flags = {}) {
  return {
    id,
    name: id,
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    fade: 0,
    playing: true,
    isOwner: true,
    sounds: new SoundCollection(),
    playbackOrder: [],
    getFlag(_scope, key) { return flags[key]; },
    async setFlag() { return this; },
    stopAllCalls: 0,
    async stopAll() { this.stopAllCalls++; this.playing = false; for (const sound of this.sounds) sound.playing = false; },
  };
}

function makeDocument(id, parent, { playing = true, volume = 0.5, sound = null, repeat = false } = {}) {
  const document = new PlaylistSound();
  Object.assign(document, {
    id,
    name: id,
    parent,
    playing,
    pausedTime: null,
    repeat,
    volume,
    sound,
    getFlag() { return undefined; },
    async update(changes) { Object.assign(document, changes); return document; },
  });
  parent.sounds.push(document);
  parent.playbackOrder.push(id);
  return document;
}

async function flush(times = 10) {
  for (let index = 0; index < times; index++) await Promise.resolve();
}

function withGm(callback) {
  const previous = { user: game.user, users: game.users, audio: game.audio, settings: game.settings };
  const gm = { id: "gm-v14", name: "GM", isGM: true, active: true, role: 4 };
  game.user = gm;
  game.users = [gm];
  game.audio = { locked: false, music: { state: "running", sampleRate: 48000 } };
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      game.user = previous.user;
      game.users = previous.users;
      game.audio = previous.audio;
      game.settings = previous.settings;
    });
}

test("a handoff keeps a retained outgoing track at its current gain instead of tailing it", async () => {
  const playlist = makePlaylist("retain-outgoing");
  const outgoing = makeMedia("outgoing", { gain: 0.35 });
  const incoming = makeMedia("incoming", { gain: 0.2 });
  const session = createCrossfadeSession({
    playlist,
    outgoingDocument: { id: "a" },
    incomingDocument: { id: "b" },
    outgoingSound: outgoing,
    durationMs: 6000,
    outgoingTargetVolume: 0.9,
  });
  activateCrossfadeSession(session, { outgoingSound: outgoing, incomingSound: incoming, incomingTargetVolume: 0.9 });

  await settleCrossfadeSession(playlist, { mode: "handoff", reason: "previous", retain: ["a"] });
  await flush();

  assert.equal(session.status, "handed-off");
  assert.equal(outgoing.playing, true, "the track Previous selected keeps playing");
  assert.equal(outgoing.stopCalls, 0);
  assert.equal(outgoing.gain.value, 0.35, "its gain is held where the fade left it");
  assert.equal(incoming.playing, true);
  assert.equal(incoming.gain.value, 0.2);
});

test("a replacement transition back to the previous outgoing track keeps that track live", async () => {
  const playlist = makePlaylist("retain-replacement");
  const a = makeMedia("a-media", { gain: 0.4 });
  const b = makeMedia("b-media", { gain: 0.1 });
  const first = createCrossfadeSession({
    playlist,
    outgoingDocument: { id: "a" },
    incomingDocument: { id: "b" },
    outgoingSound: a,
    durationMs: 6000,
    outgoingTargetVolume: 0.8,
  });
  activateCrossfadeSession(first, { outgoingSound: a, incomingSound: b, incomingTargetVolume: 0.8 });

  const second = createCrossfadeSession({
    playlist,
    outgoingDocument: { id: "b" },
    incomingDocument: { id: "a" },
    outgoingSound: b,
    durationMs: 6000,
  });
  await flush();

  try {
    assert.equal(first.status, "handed-off");
    assert.equal(State.getCrossfadeSession(playlist), second);
    assert.equal(a.playing, true, "the old outgoing track is the new incoming track and stays live");
    assert.equal(a.stopCalls, 0);
    assert.equal(a.gain.value, 0.4, "no 250 ms tail dips it to silence");
    assert.equal(b.playing, true);
    assert.equal(b.gain.value, 0.1);
  } finally {
    await settleCrossfadeSession(playlist, { mode: "cancel", reason: "test cleanup" });
  }
});

test("an equal-power crossfade can start its incoming curve from a retained gain", () => {
  const out = makeMedia("eq-out", { gain: 0.7 });
  const incoming = makeMedia("eq-in", { gain: 0.3 });

  const tokens = equalPowerCrossfade(out, incoming, 1000, { targetVolIn: 0.8, startVolIn: 0.3 });

  assert.ok(tokens?.inToken);
  const inCurve = incoming.gain.curves.at(-1);
  assert.ok(inCurve, "an incoming curve was scheduled");
  // Float32Array storage rounds the samples.
  assert.ok(Math.abs(inCurve[0] - 0.3) < 1e-6, `the curve starts at the retained gain, got ${inCurve[0]}`);
  assert.ok(Math.abs(inCurve.at(-1) - 0.8) < 1e-6, "and ends at the target");
  assert.ok(inCurve.every((value, index) => index === 0 || value >= inCurve[index - 1] - 1e-9), "rising monotonically");
  const outCurve = out.gain.curves.at(-1);
  assert.ok(Math.abs(outCurve[0] - 0.7) < 1e-6);
  assert.ok(Math.abs(outCurve.at(-1)) < 1e-6);
  State.clearFadingSound(out);
  State.clearFadingSound(incoming);
});

test("already-playing incoming media keeps its gain when the crossfade asks for it", async () => {
  const media = makeMedia("keep-gain", { gain: 0.45 });
  const document = { id: "keep", name: "keep", sound: media, async load() {} };
  await withGm(async () => {
    const kept = await prepareIncomingCrossfadeMedia(document, { keepGain: true });
    assert.equal(kept, media);
    assert.equal(media.gain.value, 0.45);
    const muted = await prepareIncomingCrossfadeMedia(document, { keepGain: false });
    assert.equal(muted, media);
    assert.equal(media.gain.value, 0);
  });
});

test("the terminal fade of the last track has one owner across the timer, recovery and the natural end", () => withGm(async () => {
  const playlist = makePlaylist("terminal", { crossfade: true, useCustomAutoFade: true, customAutoFadeMs: 1000, loopPlaylist: false });
  const media = makeMedia("last-media", { gain: 0.6 });
  const last = makeDocument("last", playlist, { sound: media });

  const first = await performCrossfade(playlist, last, { reason: "regression-timer" });
  assert.equal(first, true);
  await flush(20);
  // The mocked AudioTimeout resolves at once, so the fade timer has already finished the stop.
  assert.equal(playlist.stopAllCalls, 1, "the terminal timer stopped the playlist once");
  assert.equal(State.getTerminalFade(playlist), undefined, "the owner released itself");
  assert.equal(media.gain.curves.length, 1, "one terminal fade curve");

  // Arm again (as clock recovery would) while the owner is still registered, and
  // let the natural end arrive before the timer: one stop, no native advancement.
  playlist.playing = true;
  last.playing = true;
  media.playing = true;
  media.gain.value = 0.6;
  let finished = 0;
  State.setTerminalFade(playlist, {
    soundId: last.id,
    reason: "regression",
    finish() { finished++; return true; },
    cancel() {},
  });
  const second = await performCrossfade(playlist, last, { recovery: true, reason: "watchdog" });
  assert.equal(second, true, "recovery reports the terminal path as handled");
  assert.equal(media.gain.curves.length, 1, "no second fade curve on the same track");

  const registrations = new Map();
  const previousWrapper = globalThis.libWrapper;
  const previousSettings = game.settings;
  globalThis.libWrapper = { register(_module, target, callback) { registrations.set(target, callback); } };
  game.settings = { get: () => false };
  try {
    registerPlaylistCommandWrappers();
    const onEnd = registrations.get("PlaylistSound.prototype._onEnd");
    let nativeCalls = 0;
    const result = onEnd.call(last, () => { nativeCalls++; return "native"; });
    assert.equal(result, undefined);
    assert.equal(nativeCalls, 0, "the natural end does not reach Foundry's wrap-around playNext");
    assert.equal(finished, 1, "the natural end finished the terminal stop");
  } finally {
    globalThis.libWrapper = previousWrapper;
    game.settings = previousSettings;
    State.clearTerminalFade(playlist);
  }
}));

test("playlist cleanup cancels a pending terminal stop", async () => {
  const playlist = makePlaylist("terminal-cleanup");
  let cancelled = 0;
  State.setTerminalFade(playlist, { soundId: "x", reason: "regression", finish() {}, cancel() { cancelled++; } });

  await State.cleanup(playlist, { cleanSilence: false, cleanLoopers: false, cleanSoundscape: false });

  assert.equal(cancelled, 1);
  assert.equal(State.getTerminalFade(playlist), undefined);
});

test("fade-in and end-of-track fades share Foundry's half-track cap", () => {
  const shortTrack = { sound: { duration: 4 } };
  assert.equal(Flags.getEffectiveFadeDuration(5000, shortTrack), 2000);
  assert.equal(Flags.getEffectiveFadeDuration(1500, shortTrack), 1500);
  assert.equal(Flags.getEffectiveFadeDuration(5000, { sound: {} }), 5000, "an unknown duration keeps the configured value");
  assert.equal(Flags.getEffectiveFadeDuration(0, shortTrack), 0);
});

test("the end-of-track fade is scheduled on the sound's own clock with the capped duration", () => {
  const playlist = makePlaylist("end-fade");
  playlist.fade = 5000;
  let scheduledAt = null;
  let unscheduled = 0;
  const handle = Promise.resolve();
  handle.timeout = { cancelled: false, cancel() { this.cancelled = true; } };
  const sound = {
    playing: true,
    duration: 4,
    currentTime: 0,
    context: { currentTime: 0 },
    gain: makeGain(0.5),
    schedule(_fn, at) { scheduledAt = at; return handle; },
    // Like Sound#unschedule, cancel the handle's AudioTimeout.
    unschedule(given) { if (given === handle) { unscheduled++; handle.timeout.cancel(); } },
  };
  const ps = makeDocument("end-fade-track", playlist, { sound });

  scheduleEndOfTrackFade(ps);

  const timer = State.getEndOfTrackFade(ps);
  assert.ok(timer, "an end-of-track fade is registered");
  assert.equal(scheduledAt, 2, "the fade starts at duration minus the capped 2 s fade");
  assert.equal(timer.cancelled, false);
  timer.cancel();
  assert.equal(unscheduled, 1, "cancel goes through Sound#unschedule");
  assert.equal(timer.cancelled, true);
  State.clearEndOfTrackFade(ps);
});

test("module timers take the document's channel context", () => {
  const context = { sampleRate: 48000 };
  assert.deepEqual(audioTimerOptions({ context }), { context });
  assert.deepEqual(audioTimerOptions({ sound: { context }, context: { other: true } }), { context });
  assert.equal(audioTimerOptions({ sound: null, context: undefined }), undefined);
  assert.equal(audioTimerOptions(null), undefined);
});

test("per-key debounce keeps two quick changes on different sliders", async () => {
  const previousDebounce = foundry.utils.debounce;
  foundry.utils.debounce = (fn, delay) => {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  };
  try {
    const persisted = [];
    const persist = debounceByKey((args) => persisted.push(args), 5, ({ soundId }) => soundId);
    persist({ soundId: "a", value: 0.1 });
    persist({ soundId: "b", value: 0.2 });
    persist({ soundId: "a", value: 0.3 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(persisted.sort((x, y) => x.soundId.localeCompare(y.soundId)), [
      { soundId: "a", value: 0.3 },
      { soundId: "b", value: 0.2 },
    ]);
  } finally {
    foundry.utils.debounce = previousDebounce;
  }
});

test("client diagnostics are collected through User#query without the module socket", () => withGm(async () => {
  const previousRandom = foundry.utils.randomID;
  foundry.utils.randomID = () => "request-1";
  const emits = [];
  const previousSocket = game.socket;
  game.socket = { emit: (...entry) => emits.push(entry), on() {}, off() {} };
  const previousGather = API._gatherLocalDiagnostics;
  API._gatherLocalDiagnostics = ({ playlistIds }) => ({
    client: { userId: game.user.id, userName: "GM", isGM: true, clientInstanceId: "gm-instance" },
    audio: { locked: false, contexts: {} },
    playingSounds: [],
    playlistDocuments: playlistIds === null ? [{ id: "all" }] : [],
  });
  const asked = [];
  const answering = {
    id: "player-a", name: "Player A", isGM: false, active: true,
    async query(name, data, options) {
      asked.push({ name, data, options });
      return { client: { userId: "player-a", userName: "Player A", isGM: false, clientInstanceId: "a-instance" }, audio: {}, playingSounds: [], playlistDocuments: [] };
    },
  };
  const impostor = {
    id: "player-b", name: "Player B", isGM: false, active: true,
    async query() { return { client: { userId: "player-a", clientInstanceId: "b-instance" }, playingSounds: [] }; },
  };
  const silent = {
    id: "player-c", name: "Player C", isGM: false, active: true,
    async query() { throw new Error("User [player-c] did not answer"); },
  };
  const offline = { id: "player-d", name: "Player D", isGM: false, active: false, async query() { throw new Error("must not be asked"); } };
  game.users = [game.user, answering, impostor, silent, offline];
  try {
    const result = await API.collectClientDiagnostics({ timeoutMs: 1000 });
    assert.equal(result.transport, "user-query");
    assert.equal(emits.length, 0, "no socket message is sent");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].name, USER_QUERIES.clientDiagnostics);
    assert.deepEqual(asked[0].data, { requestId: "request-1", playlistIds: null });
    assert.equal(asked[0].options.timeout, 1000);
    assert.equal(result.responded, 2, "the GM itself and the answering player");
    assert.deepEqual(result.clients.map((client) => client.client.userId), ["gm-v14", "player-a"]);
    assert.deepEqual(result.failures.map((failure) => failure.userId), ["player-b", "player-c"]);
    assert.match(result.failures[0].reason, /another user/);
    assert.deepEqual(result.missingActiveUsers.map((user) => user.id), ["player-b", "player-c"]);
  } finally {
    foundry.utils.randomID = previousRandom;
    game.socket = previousSocket;
    API._gatherLocalDiagnostics = previousGather;
  }
}));

test("the diagnostics query handler refuses closed gates and non-GM askers", () => withGm(async () => {
  const previousGather = API._gatherLocalDiagnostics;
  API._gatherLocalDiagnostics = ({ playlistIds }) => ({ client: { userId: game.user.id }, playlistIds });
  const gm = game.user;
  const player = { id: "player", name: "Player", isGM: false, active: true };
  game.users = Object.assign([gm, player], { get: (id) => [gm, player].find((user) => user.id === id) });
  try {
    game.settings = { get: () => false };
    assert.throws(() => API._answerClientDiagnosticsQuery({}, { user: gm }), /gates are closed/);
    game.settings = { get: () => true };
    assert.throws(() => API._answerClientDiagnosticsQuery({}, { user: player }), /active GM/);
    assert.throws(() => API._answerClientDiagnosticsQuery({}, {}), /active GM/);
    const answer = API._answerClientDiagnosticsQuery({ playlistIds: ["p1"] }, { user: gm });
    assert.deepEqual(answer.playlistIds, ["p1"]);
    const registered = API._registerUserQueries();
    assert.equal(registered, Boolean(globalThis.CONFIG?.queries));
  } finally {
    API._gatherLocalDiagnostics = previousGather;
  }
}));

test("the client setting query applies only the allowlisted setting for an active GM", () => withGm(async () => {
  const gm = game.user;
  const player = { id: "player", name: "Player", isGM: false, active: true };
  game.users = Object.assign([gm, player], { get: (id) => [gm, player].find((user) => user.id === id) });
  const writes = [];
  const values = { enableMcpDiagnostics: true, soundscapeProceduralSyncEnabled: true };
  game.settings = {
    get: (_module, key) => values[key],
    set: async (_module, key, value) => { writes.push([key, value]); values[key] = value; },
  };
  await assert.rejects(API._answerClientSettingQuery({ key: "soundscapeProceduralSyncEnabled", value: false }, { user: player }), /active GM/);
  const denied = await API._answerClientSettingQuery({ key: "debug", value: true }, { user: gm });
  assert.equal(denied.success, false);
  assert.match(denied.error, /allowlisted/);
  const applied = await API._answerClientSettingQuery({ key: "soundscapeProceduralSyncEnabled", value: false }, { user: gm });
  assert.equal(applied.success, true);
  assert.equal(applied.value, false);
  assert.deepEqual(writes, [["soundscapeProceduralSyncEnabled", false]]);
}));

test("queryUserWithTimeout rejects when the server never answers", async () => {
  const user = { query: () => new Promise(() => {}) };
  await assert.rejects(queryUserWithTimeout(user, USER_QUERIES.clientDiagnostics, {}, { timeout: 250 }), /no answer within 250 ms/);
  await assert.rejects(queryUserWithTimeout({}, USER_QUERIES.clientDiagnostics), /cannot be queried/);
});

test("personal mix values scale the GM's mix instead of replacing it", () => withGm(async () => {
  const stored = {
    personalPlaylistVolumeEnabled: true,
    personalPlaylistVolumes: { "mix-playlist": 0.5 },
    personalTrackVolumes: {},
  };
  game.user = { id: "mix-player", name: "Mix Player", isGM: false, active: true };
  game.settings = { get: (_module, key) => stored[key], set: async (_module, key, value) => { stored[key] = value; } };
  const playlist = makePlaylist("mix-playlist", { volumeNormalizationEnabled: false });
  const ps = makeDocument("mix-track", playlist, { volume: 0.8 });
  ps.uuid = "Playlist.mix-playlist.PlaylistSound.mix-track";

  assert.ok(Math.abs(Flags.resolveTargetVolume(ps) - 0.4) < 1e-9, "saved playlist factor 0.5 halves the GM's 0.8");
  assert.ok(Math.abs(Flags.resolveTargetVolume(ps, { sharedVolume: 0.4 }) - 0.2) < 1e-9, "a procedural variance target is scaled too");
  assert.ok(Math.abs(Flags.resolveTargetVolume(ps, { playlistVolume: 1 }) - 0.8) < 1e-9, "a transient slider at 100% plays the GM's level");
  assert.ok(Math.abs(Flags.resolveTargetVolume(ps, { trackInput: 0.25 }) - 0.2) < 1e-9, "a track slider scales the track");
  assert.equal(Flags.getPersonalTrackVolumeInput(ps), 0.5, "an unmoved track slider shows the inherited playlist factor");

  stored.personalTrackVolumes = { [Flags.getPersonalTrackVolumeKey(ps)]: 0.25 };
  assert.ok(Math.abs(Flags.resolveTargetVolume(ps) - 0.2) < 1e-9, "a saved track factor wins over the playlist factor");
  assert.ok(Math.abs(Flags.applyPersonalPlaylistVolume(playlist, 0.8) - 0.4) < 1e-9);

  stored.personalPlaylistVolumes = {};
  stored.personalTrackVolumes = {};
  assert.ok(Math.abs(Flags.resolveTargetVolume(ps) - 0.8) < 1e-9, "no saved values means the GM's mix unchanged");
  assert.equal(Flags.getPersonalPlaylistVolume(playlist), 1);

  stored.personalPlaylistVolumeEnabled = false;
  assert.ok(Math.abs(Flags.resolveTargetVolume(ps, { trackInput: 0.1 }) - 0.8) < 1e-9, "disabled: the shared target, whatever the sliders say");
}));

test("the personal mix reset clears absolute values once and marks the factor model", () => withGm(async () => {
  const stored = { personalMixModel: 0, personalPlaylistVolumes: { a: 0.3 }, personalTrackVolumes: { "Playlist.a.PlaylistSound.b": 0.7 } };
  const writes = [];
  game.settings = { get: (_module, key) => stored[key], set: async (_module, key, value) => { writes.push([key, value]); stored[key] = value; } };

  assert.equal(await Flags.migratePersonalMixModel(), true);
  assert.deepEqual(stored.personalPlaylistVolumes, {});
  assert.deepEqual(stored.personalTrackVolumes, {});
  assert.equal(stored.personalMixModel, 1);
  assert.equal(await Flags.migratePersonalMixModel(), false, "a second run is a no-op");
  assert.equal(writes.length, 3);
}));
