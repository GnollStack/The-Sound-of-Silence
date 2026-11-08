import test from "node:test";
import assert from "node:assert/strict";

// The Foundry globals (foundry, game, Hooks, CONST, PlaylistSound) are
// installed by runtime-boundaries.test.js, which run-tests.js imports first.
const { State } = await import("../scripts/state-manager.js");
const {
  activateCrossfadeSession,
  createCrossfadeSession,
  isCurrentCrossfadeSession,
  settleCrossfadeSession,
} = await import("../scripts/playback/transition-session.js");
const { setRangePickerValueSilently } = await import("../scripts/personal-audio-mix.js");
const { isFadeTokenStale, STALE_FADE_TOKEN_GRACE_MS } = await import("../scripts/audio-fader.js");
const { Flags } = await import("../scripts/flag-service.js");
const { LoopingSound } = await import("../scripts/looping-sound.js");
const { executeSegmentSkip } = await import("../scripts/internal-loop.js");
const { registerPlaylistCommandWrappers } = await import("../scripts/playlist/playlist-command-wrappers.js");
const { registerSoundPlaybackWrappers } = await import("../scripts/playback/sound-wrappers.js");

function makeGain(value) {
  return {
    value,
    cancelAndHoldAtTime() {},
    cancelScheduledValues() {},
    setValueAtTime(next) { this.value = next; },
    setValueCurveAtTime(curve) { this.value = curve.at(-1); },
    linearRampToValueAtTime(next) { this.value = next; },
  };
}

function makeMedia(id, { playing = true, gain = 0.5 } = {}) {
  return {
    id,
    playing,
    context: { currentTime: 0 },
    gain: makeGain(gain),
    get volume() { return this.gain.value; },
    set volume(value) { this.gain.value = value; },
    stopCalls: 0,
    stop() { this.playing = false; this.stopCalls++; },
    async play() { this.playing = true; },
  };
}

function makeCollection() {
  const items = [];
  return {
    push: (sound) => items.push(sound),
    get: (id) => items.find((sound) => sound.id === id),
    has: (id) => items.some((sound) => sound.id === id),
    find: (fn) => items.find(fn),
    filter: (fn) => items.filter(fn),
    some: (fn) => items.some(fn),
    map: (fn) => items.map(fn),
    [Symbol.iterator]: () => items[Symbol.iterator](),
  };
}

function makePlaylist(id, flags = {}) {
  return {
    id,
    name: id,
    mode: CONST.PLAYLIST_MODES.SEQUENTIAL,
    fade: 0,
    playing: true,
    isOwner: true,
    sounds: makeCollection(),
    getFlag(_scope, key) { return flags[key]; },
  };
}

function makeDocument(id, parent, { playing = true, volume = 0.5, flags = {}, sound = null } = {}) {
  const document = new PlaylistSound();
  Object.assign(document, {
    id,
    name: id,
    parent,
    playing,
    pausedTime: null,
    repeat: false,
    volume,
    sound,
    getFlag(_scope, key) { return flags[key]; },
    async update(changes) { Object.assign(document, changes); return document; },
  });
  parent?.sounds?.push?.(document);
  return document;
}

async function flush(times = 10) {
  for (let index = 0; index < times; index++) await Promise.resolve();
}

test("handing a running crossfade off keeps the incoming track live and tails the outgoing one", async () => {
  const playlist = makePlaylist("handoff-playlist");
  const outgoing = makeMedia("outgoing", { gain: 0.2 });
  const incoming = makeMedia("incoming", { gain: 0.15 });
  const session = createCrossfadeSession({
    playlist,
    outgoingDocument: { id: "a" },
    incomingDocument: { id: "b" },
    outgoingSound: outgoing,
    durationMs: 6000,
    outgoingTargetVolume: 0.8,
  });
  activateCrossfadeSession(session, { outgoingSound: outgoing, incomingSound: incoming, incomingTargetVolume: 0.8 });

  const settled = await settleCrossfadeSession(playlist, { mode: "handoff", reason: "regression" });
  await flush();

  assert.equal(settled, true);
  assert.equal(session.status, "handed-off");
  assert.equal(isCurrentCrossfadeSession(session), false);
  assert.equal(State.getCrossfadeSession(playlist), undefined);
  assert.equal(incoming.playing, true, "the track fading in keeps playing");
  assert.equal(incoming.stopCalls, 0);
  assert.equal(incoming.gain.value, 0.15, "the incoming gain is held, not snapped to its target");
  assert.notEqual(outgoing.gain.value, 0.8, "the outgoing gain is not restored to its target");
  assert.equal(outgoing.gain.value, 0, "the outgoing track receives its short fade-out tail");
});

test("a replacement transition hands the previous session off instead of cancelling it", async () => {
  const playlist = makePlaylist("replacement-playlist");
  const outgoing = makeMedia("outgoing", { gain: 0.3 });
  const incoming = makeMedia("incoming", { gain: 0.1 });
  const first = createCrossfadeSession({
    playlist,
    outgoingDocument: { id: "a" },
    incomingDocument: { id: "b" },
    outgoingSound: outgoing,
    durationMs: 6000,
    outgoingTargetVolume: 0.9,
  });
  activateCrossfadeSession(first, { outgoingSound: outgoing, incomingSound: incoming, incomingTargetVolume: 0.9 });

  const second = createCrossfadeSession({
    playlist,
    outgoingDocument: { id: "b" },
    incomingDocument: { id: "c" },
    outgoingSound: incoming,
    durationMs: 6000,
  });
  await flush();

  try {
    assert.equal(first.status, "handed-off");
    assert.equal(State.getCrossfadeSession(playlist), second);
    assert.equal(incoming.playing, true);
    assert.equal(incoming.stopCalls, 0);
    assert.equal(incoming.gain.value, 0.1);
    assert.notEqual(outgoing.gain.value, 0.9);
  } finally {
    await settleCrossfadeSession(playlist, { mode: "cancel", reason: "test cleanup" });
  }
});

test("a session that has not started fading hands off by discarding only its incoming media", async () => {
  const playlist = makePlaylist("preparing-playlist");
  const outgoing = makeMedia("outgoing", { gain: 0.4 });
  const incoming = makeMedia("incoming", { playing: true, gain: 0 });
  const session = createCrossfadeSession({
    playlist,
    outgoingDocument: { id: "a" },
    incomingDocument: { id: "b" },
    outgoingSound: outgoing,
    durationMs: 6000,
    outgoingTargetVolume: 0.4,
  });
  session.incomingSound = incoming;

  await settleCrossfadeSession(playlist, { mode: "handoff", reason: "regression" });

  assert.equal(session.status, "handed-off");
  assert.equal(incoming.stopCalls, 1, "unstarted incoming media is discarded");
  assert.equal(outgoing.playing, true, "the audible outgoing track is left for the replacement to fade");
  assert.equal(outgoing.stopCalls, 0);
  assert.equal(outgoing.gain.value, 0.4);
});

test("stop settlement holds both gains for the stop path", async () => {
  const playlist = makePlaylist("stop-playlist");
  const outgoing = makeMedia("outgoing", { gain: 0.2 });
  const incoming = makeMedia("incoming", { gain: 0.15 });
  const session = createCrossfadeSession({
    playlist,
    outgoingDocument: { id: "a" },
    incomingDocument: { id: "b" },
    outgoingSound: outgoing,
    durationMs: 6000,
    outgoingTargetVolume: 0.8,
  });
  activateCrossfadeSession(session, { outgoingSound: outgoing, incomingSound: incoming, incomingTargetVolume: 0.8 });

  await State.cleanup(playlist, {
    cleanSilence: false,
    cleanCrossfade: true,
    cleanLoopers: false,
    cleanSoundscape: false,
    crossfadeSettlement: "stop",
  });

  assert.equal(session.status, "stopped");
  assert.equal(outgoing.playing, true);
  assert.equal(incoming.playing, true);
  assert.equal(outgoing.stopCalls, 0);
  assert.equal(incoming.stopCalls, 0);
  assert.equal(outgoing.gain.value, 0.2, "no snap back to the outgoing target before the stop fade");
  assert.equal(incoming.gain.value, 0.15);
  assert.equal(State.isSoundFading(outgoing), false);
  assert.equal(State.isSoundFading(incoming), false);
});

test("crossfade completion applies the incoming document's current volume, not the captured one", async () => {
  const playlist = makePlaylist("completion-playlist");
  const outgoingDocument = makeDocument("a", playlist);
  const incomingDocument = makeDocument("b", playlist, { volume: 0.25 });
  const outgoing = makeMedia("outgoing");
  const incoming = makeMedia("incoming", { gain: 0.2 });
  incomingDocument.sound = incoming;
  const session = createCrossfadeSession({
    playlist,
    outgoingDocument,
    incomingDocument,
    outgoingSound: outgoing,
    durationMs: 100,
  });
  activateCrossfadeSession(session, { outgoingSound: outgoing, incomingSound: incoming, incomingTargetVolume: 0.25 });

  incomingDocument.volume = 0.6; // changed while the fade was running
  await settleCrossfadeSession(playlist, { mode: "complete", reason: "regression" });

  assert.equal(session.status, "completed");
  assert.equal(incoming.gain.value, 0.6);
  assert.equal(outgoing.stopCalls, 1);
});

test("programmatic slider sync does not bubble into volume change handlers", () => {
  class FakeNode {
    constructor(parent = null) {
      this.parent = parent;
      this.listeners = [];
    }

    addEventListener(type, fn, options) {
      this.listeners.push({ type, fn, capture: Boolean(options?.capture ?? options) });
    }

    removeEventListener(type, fn, options) {
      const capture = Boolean(options?.capture ?? options);
      this.listeners = this.listeners.filter((entry) =>
        !(entry.type === type && entry.fn === fn && entry.capture === capture)
      );
    }

    dispatchEvent(event) {
      let stopped = false;
      let immediate = false;
      event.stopPropagation = () => { stopped = true; };
      event.stopImmediatePropagation = () => { stopped = true; immediate = true; };
      // Like the DOM, capture listeners on the target run before bubble listeners.
      const ordered = [
        ...this.listeners.filter((entry) => entry.capture),
        ...this.listeners.filter((entry) => !entry.capture),
      ];
      for (const entry of ordered) {
        if (immediate) break;
        if (entry.type === event.type) entry.fn(event);
      }
      if (!stopped && event.bubbles && this.parent) this.parent.dispatchEvent(event);
    }
  }

  class FakePicker extends FakeNode {
    constructor(parent) {
      super(parent);
      this._value = 0;
    }

    get value() { return this._value; }

    // Foundry's form element setter dispatches both events for any assignment.
    set value(value) {
      this._value = value;
      this.dispatchEvent({ type: "input", bubbles: true });
      this.dispatchEvent({ type: "change", bubbles: true });
    }
  }

  const directory = new FakeNode();
  const picker = new FakePicker(directory);
  let delegated = 0;
  directory.addEventListener("input", () => { delegated += 1; });
  directory.addEventListener("change", () => { delegated += 1; });

  setRangePickerValueSilently(picker, 0.4);
  assert.equal(picker.value, 0.4);
  assert.equal(delegated, 0, "a programmatic sync must not reach delegated volume handlers");
  assert.equal(picker.listeners.length, 0, "the suppressing listeners are removed again");

  picker.value = 0.7;
  assert.equal(delegated, 2, "a user-driven change still bubbles normally");
});

test("_onEnd ignores a stopped document, a stopping playlist and a looper mid-handoff", () => {
  const registrations = new Map();
  const previous = {
    libWrapper: globalThis.libWrapper,
    user: game.user,
    users: game.users,
    settingsGet: game.settings.get,
  };
  globalThis.libWrapper = {
    register(_module, target, callback) { registrations.set(target, callback); },
  };
  game.user = { id: "gm", isGM: true, active: true, role: 4 };
  game.users = [game.user];
  game.settings.get = () => false;

  const playlist = makePlaylist("onend-playlist");
  const sound = makeDocument("track", playlist, { playing: false });
  let nativeCalls = 0;
  const native = () => { nativeCalls += 1; return "native"; };

  try {
    registerPlaylistCommandWrappers();
    const onEnd = registrations.get("PlaylistSound.prototype._onEnd");

    assert.equal(onEnd.call(sound, native), undefined, "a document that already stopped is ignored");
    assert.equal(nativeCalls, 0);

    sound.playing = true;
    State.setActiveLooper(sound, { isDestroyed: false, isCrossfading: true, loopingDisabled: false });
    assert.equal(onEnd.call(sound, native), undefined, "the source buffer ending mid-handoff is ignored");
    assert.equal(nativeCalls, 0);

    State.clearActiveLooper(sound);
    assert.equal(onEnd.call(sound, native), "native", "an ordinary natural end still advances");
    assert.equal(nativeCalls, 1);

    State.markPlaylistAsStopping(playlist);
    assert.equal(onEnd.call(sound, native), undefined, "a natural end during Stop All is ignored");
    assert.equal(nativeCalls, 1);
  } finally {
    State.clearStoppingFlag(playlist);
    State.clearActiveLooper(sound);
    globalThis.libWrapper = previous.libWrapper;
    game.user = previous.user;
    game.users = previous.users;
    game.settings.get = previous.settingsGet;
  }
});

test("a loop handoff does not promote its target after the document was stopped", async () => {
  const context = { currentTime: 0 };
  const sourceSound = {
    id: "source-buffer",
    playing: true,
    currentTime: 4,
    volume: 0.6,
    gain: makeGain(0.6),
    context,
    stopCalls: 0,
    stop() { this.playing = false; this.stopCalls++; },
  };
  const targetSound = {
    id: "target-buffer",
    playing: false,
    volume: 0,
    gain: makeGain(0),
    context,
    stopCalls: 0,
    async play() { this.playing = true; },
    stop() { this.playing = false; this.stopCalls++; },
  };
  const segment = { start: "00:01.000", end: "00:05.000", startSec: 1, endSec: 5, crossfadeMs: 100, loopCount: 0 };
  const playlistSound = { id: "loop-sound", name: "Stopped Mid-Handoff", volume: 0.6, playing: true, sound: sourceSound };
  const looper = new LoopingSound(playlistSound, { segments: [segment] });
  looper.soundA = sourceSound;
  looper.soundB = targetSound;
  looper.activeLoopSegment = segment;
  looper._prepareTargetSound = async () => targetSound;
  let released = 0;
  looper._endCurrentLoopSegment = () => { released += 1; };

  const handoff = looper._performCrossfadeLoop();
  for (let index = 0; index < 6 && !looper.handoffTimer; index++) await Promise.resolve();
  assert.ok(looper.handoffTimer, "handoff timer should be armed");

  playlistSound.playing = false; // another track was selected while the fade ran
  looper.handoffTimer._resolve(); // the timer completes normally

  assert.equal(await handoff, false);
  assert.equal(playlistSound.sound, sourceSound, "the stopped document never adopts the target buffer");
  assert.equal(looper.isA_Active, true);
  assert.ok(targetSound.stopCalls >= 1, "the incoming buffer is stopped instead of promoted");
  assert.equal(looper.isCrossfading, false);
  assert.equal(looper.loopsCompleted, 0);
  assert.equal(released, 1, "the segment is released so no timerless looper remains");
});

test("loop iterations are counted only after a successful handoff", async () => {
  const context = { currentTime: 0 };
  const sourceSound = { id: "source", playing: true, currentTime: 4, volume: 0.6, gain: makeGain(0.6), context, stop() { this.playing = false; } };
  const targetSound = { id: "target", playing: false, volume: 0, gain: makeGain(0), context, async play() { this.playing = true; }, stop() { this.playing = false; } };
  const segment = { start: "00:01.000", end: "00:05.000", startSec: 1, endSec: 5, crossfadeMs: 100, loopCount: 3 };
  const playlistSound = { id: "count-sound", name: "Counted", volume: 0.6, playing: true, sound: sourceSound };
  const looper = new LoopingSound(playlistSound, { segments: [segment] });
  looper.soundA = sourceSound;
  looper.activeLoopSegment = segment;
  looper._prepareTargetSound = async () => targetSound;
  let armed = 0;
  let released = 0;
  looper._armCrossfadeLoop = () => { armed += 1; };
  looper._endCurrentLoopSegment = () => { released += 1; };

  looper._executeCrossfadeAndHandoff = async () => false;
  assert.equal(await looper._performCrossfadeLoop(), false);
  assert.equal(looper.loopsCompleted, 0, "a failed handoff is not counted as a completed pass");
  assert.equal(released, 1);

  looper._executeCrossfadeAndHandoff = async () => true;
  assert.equal(await looper._performCrossfadeLoop(), true);
  assert.equal(looper.loopsCompleted, 1);
  assert.equal(armed, 1);
});

test("a failed loop target releases the segment instead of leaving a timerless looper", async () => {
  const segment = { start: "00:01.000", end: "00:05.000", startSec: 1, endSec: 5, crossfadeMs: 100, loopCount: 0 };
  const sourceSound = { id: "source", playing: true, currentTime: 4, volume: 0.6, gain: makeGain(0.6), context: { currentTime: 0 }, stop() {} };
  const playlistSound = { id: "failed-target", name: "Failed Target", volume: 0.6, playing: true, sound: sourceSound };
  const looper = new LoopingSound(playlistSound, { segments: [segment] });
  looper.soundA = sourceSound;
  looper.activeLoopSegment = segment;
  looper._prepareTargetSound = async () => null;
  let released = 0;
  looper._endCurrentLoopSegment = () => { released += 1; };

  assert.equal(await looper._performCrossfadeLoop(), false);
  assert.equal(released, 1);
  assert.equal(looper.isCrossfading, false);
});

test("segment skips report refusal while a transition is in progress so replication can retry", () => {
  const segments = [
    { start: "00:01.000", end: "00:05.000", startSec: 1, endSec: 5, crossfadeMs: 100, loopCount: 0 },
    { start: "00:06.000", end: "00:08.000", startSec: 6, endSec: 8, crossfadeMs: 100, loopCount: 0 },
  ];
  const playlist = makePlaylist("skip-playlist");
  const document = makeDocument("skip-sound", playlist, {
    flags: {
      loopWithin: {
        enabled: true,
        active: true,
        startFromBeginning: true,
        segments: [
          { start: "00:01.000", end: "00:05.000", crossfadeMs: 100, loopCount: 0 },
          { start: "00:06.000", end: "00:08.000", crossfadeMs: 100, loopCount: 0 },
        ],
      },
    },
  });
  const looper = new LoopingSound(document, { segments });
  let skips = 0;
  looper._skipToSegment = async () => { skips += 1; return true; };

  try {
    State.setActiveLooper(document, looper);
    looper.isCrossfading = true;
    assert.equal(looper.skipToSegmentByIndex(1), false);
    assert.equal(executeSegmentSkip(document, 1), false, "replication sees the refusal and retries");
    assert.equal(skips, 0);

    looper.isCrossfading = false;
    assert.equal(executeSegmentSkip(document, 1), true);
    assert.equal(skips, 1);
    assert.equal(looper.skipToSegmentByIndex(5), false, "an out-of-range index is refused");
  } finally {
    State.clearActiveLooper(document);
  }
});

test("a document stop cancels its internal loop and releases the media's fade ownership", () => {
  const registrations = new Map();
  const previousLibWrapper = globalThis.libWrapper;
  globalThis.libWrapper = {
    register(_module, target, callback) { registrations.set(target, callback); },
  };
  const playlist = makePlaylist("stop-sync-playlist");
  const media = makeMedia("looped-media", { playing: true, gain: 0.3 });
  const document = makeDocument("looped", playlist, { playing: false, sound: media });
  const destroyCalls = [];
  const looper = {
    isDestroyed: false,
    loopingDisabled: false,
    isAborted: false,
    destroy(allowFadeOut) { destroyCalls.push(allowFadeOut); this.isDestroyed = true; },
    retire() { destroyCalls.push("retire"); },
  };

  try {
    registerSoundPlaybackWrappers();
    const sync = registrations.get("PlaylistSound.prototype.sync");
    State.setActiveLooper(document, looper);
    State.startFade(media, { type: "crossfade-out", duration: 1000, targetVol: 0 });

    let nativeCalls = 0;
    sync.call(document, () => { nativeCalls += 1; });

    assert.deepEqual(destroyCalls, [true], "the looper is destroyed, letting the active buffer fade");
    assert.equal(State.getActiveLooper(document), undefined);
    assert.equal(State.isSoundFading(media), false, "fade ownership is released for Foundry's own stop fade");
    assert.equal(nativeCalls, 1, "native sync proceeds and stops the media");
  } finally {
    State.clearActiveLooper(document);
    State.clearFadingSound(media);
    globalThis.libWrapper = previousLibWrapper;
  }
});

test("fade tokens are stale by elapsed time, never by gain level", () => {
  const now = 100000;
  assert.equal(isFadeTokenStale(null, now), false);
  assert.equal(isFadeTokenStale({ startedAt: now - 1000, duration: 2000 }, now), false);
  assert.equal(isFadeTokenStale({ startedAt: now - 2000 - STALE_FADE_TOKEN_GRACE_MS + 1, duration: 2000 }, now), false);
  assert.equal(isFadeTokenStale({ startedAt: now - 2000 - STALE_FADE_TOKEN_GRACE_MS - 1, duration: 2000 }, now), true);
  assert.equal(isFadeTokenStale({ startedAt: now - STALE_FADE_TOKEN_GRACE_MS - 1 }, now), true, "a reservation with no duration ages out too");
});

test("effective crossfade duration is clamped to half of the outgoing track", () => {
  const playlist = makePlaylist("clamp-playlist", { useCustomAutoFade: true, customAutoFadeMs: 6000 });
  assert.equal(Flags.getEffectiveCrossfadeDuration(playlist, null), 6000);
  assert.equal(Flags.getEffectiveCrossfadeDuration(playlist, { sound: { duration: 30 } }), 6000);
  assert.equal(Flags.getEffectiveCrossfadeDuration(playlist, { sound: { duration: 4 } }), 2000);
  assert.equal(Flags.getEffectiveCrossfadeDuration(playlist, { sound: { duration: Number.NaN } }), 6000);
  assert.equal(Flags.getEffectiveCrossfadeDuration(playlist, { sound: { duration: 12 } }), 6000);
});
