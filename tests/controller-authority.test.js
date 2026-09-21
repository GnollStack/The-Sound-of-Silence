import test from "node:test";
import assert from "node:assert/strict";

const { PlaylistActionAuthority: Authority, MODULE_ID } = await import("../scripts/utils.js");
const { registerSettings } = await import("../scripts/settings.js");
const { PlaybackControllerConfig, savePlaybackControllerPolicy } = await import("../scripts/playback/controller-config.js");
const { registerPlaybackAuthorityHooks, reconcileControllerPlayback } = await import("../scripts/playback/authority-coordinator.js");
const { State } = await import("../scripts/state-manager.js");
const { PlaybackClock } = await import("../scripts/playback-clock.js");
const { scheduleCrossfade, cancelCrossfade, performCrossfade } = await import("../scripts/cross-fade.js");
const { runPlaybackRecoveryWatchdog } = await import("../scripts/playback-recovery.js");
const { startSilenceGap, completeSilenceGap, recoverPersistedSilenceGaps } = await import("../scripts/silence.js");
const { LoopingSound } = await import("../scripts/looping-sound.js");
const { reconcilePendingLoopCompletions, clearPendingLoopCompletion } = await import("../scripts/playback/loop-completion.js");

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let serial = 0;

function environment(t) {
  const saved = { ...game };
  const gm = { id: "z-full-gm", role: 4, isGM: true, active: true, name: "GM" };
  const assistant = { id: "a-assistant", role: 3, isGM: true, active: true, name: "Co-DM" };
  let policy = { preferredUserId: null, excludedUserIds: [] };
  game.user = gm;
  game.users = [assistant, gm];
  game.playlists = [];
  game.audio = { locked: false, music: { state: "running", sampleRate: 48000 } };
  game.settings = { get: (_scope, key) => key === "playbackControllerPolicy" ? policy : false };
  Authority.getSelection();
  t.after(() => Object.assign(game, saved));
  return { gm, assistant, policy: value => { policy = value; Authority.getSelection(); } };
}

function media(playing = true) {
  const listeners = new Map();
  return {
    playing, loaded: true, currentTime: 3, duration: 30, volume: 0.5,
    context: { currentTime: 3, state: "running" },
    gain: { value: 0.5, cancelAndHoldAtTime() {}, setValueAtTime() {}, setValueCurveAtTime() {} },
    plays: 0, stops: 0, schedules: [],
    async play() { this.plays++; this.playing = true; },
    stop() { this.stops++; this.playing = false; },
    schedule(callback, at) {
      const handle = { timeout: { cancelled: false, cancel() { this.cancelled = true; } } };
      this.schedules.push({ callback, at, handle });
      return handle;
    },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
    listeners,
  };
}

function fixture(flags = {}) {
  const playlist = new Playlist();
  Object.assign(playlist, {
    id: `controller-test-${++serial}`, name: "Controller test", mode: 0, playing: true, isOwner: true,
    fade: 0, flags, sounds: [], mutations: [],
    getFlag(_scope, key) { return this.flags[key]; },
    async setFlag(_scope, key, value) { this.flags[key] = value; return this; },
    async unsetFlag(_scope, key) { delete this.flags[key]; return this; },
    async update(changes) {
      this.mutations.push(changes);
      if ("playing" in changes) this.playing = changes.playing;
      for (const update of changes.sounds ?? []) Object.assign(this.sounds.get(update._id), update);
      for (const [key, value] of Object.entries(changes)) {
        if (key.startsWith(`flags.${MODULE_ID}.`)) this.flags[key.slice(`flags.${MODULE_ID}.`.length)] = value;
      }
      return this;
    },
    async playSound(sound) {
      return this.update({ playing: true, sounds: this.sounds.map(s => ({ _id: s.id, playing: s === sound })) });
    },
    async stopAll() { return this.update({ playing: false }); },
    async createEmbeddedDocuments(_type, values) {
      return values.map(value => addSound(`gap-${++serial}`, value.playing, value.flags[MODULE_ID]));
    },
  });
  playlist.sounds.get = id => playlist.sounds.find(sound => sound.id === id);
  playlist.sounds.has = id => !!playlist.sounds.get(id);
  const addSound = (id, playing = false, soundFlags = {}) => {
    const sound = new PlaylistSound();
    Object.assign(sound, {
      id, name: id, uuid: `${playlist.id}.${id}`, parent: playlist, playing, volume: 0.5, sound: media(playing),
      getFlag: (_scope, key) => soundFlags[key],
      async update(changes) { Object.assign(this, changes); return this; },
      async delete() { playlist.sounds.splice(playlist.sounds.indexOf(this), 1); },
    });
    playlist.sounds.push(sound);
    return sound;
  };
  const source = addSound("source", true);
  const next = addSound("next");
  playlist.playbackOrder = [source.id, next.id];
  return { playlist, source, next, addSound };
}

test("controller config saves one complete world policy and rejects assistant/player submissions", async t => {
  const env = environment(t);
  const settings = new Map(), menus = new Map(), saves = [];
  game.settings.register = (_scope, key, value) => settings.set(key, value);
  game.settings.registerMenu = (_scope, key, value) => menus.set(key, value);
  game.settings.set = async (...args) => { saves.push(args); env.policy(args[2]); };
  registerSettings();
  assert.equal(settings.get("playbackControllerPolicy").scope, "world");
  assert.equal(settings.get("playbackControllerPolicy").config, false);
  assert.equal(menus.get("playbackControllerConfig").restricted, true);
  await savePlaybackControllerPolicy({ preferredUserId: env.assistant.id, excludedUserIds: [env.gm.id] });
  assert.deepEqual(saves, [[MODULE_ID, "playbackControllerPolicy", {
    preferredUserId: env.assistant.id, excludedUserIds: [env.gm.id],
  }]]);
  await assert.rejects(savePlaybackControllerPolicy({ preferredUserId: env.gm.id, excludedUserIds: [env.gm.id] }), /also be excluded/);
  for (const user of [env.assistant, { role: 1, isGM: false }]) {
    game.user = user;
    assert.equal(new PlaybackControllerConfig().render() instanceof PlaybackControllerConfig, true);
    await assert.rejects(savePlaybackControllerPolicy({}), /Only a full Gamemaster/);
  }
  assert.equal(saves.length, 1);
});

test("controller form includes offline accounts and preserves an unavailable saved preference", async t => {
  const env = environment(t);
  env.assistant.active = false;
  env.policy({ preferredUserId: "deleted-gm", excludedUserIds: [] });
  const form = new PlaybackControllerConfig();
  const context = await form._prepareContext();
  assert.match(context.accounts.find(a => a.id === env.assistant.id).label, /offline/);
  assert.equal(context.accounts.find(a => a.id === "deleted-gm").preferred, true);
  let saved;
  game.settings.set = async (_scope, _key, value) => { saved = value; };
  await savePlaybackControllerPolicy({ preferredUserId: "deleted-gm", excludedUserIds: [env.assistant.id] });
  assert.equal(saved.preferredUserId, "deleted-gm");
  await assert.rejects(savePlaybackControllerPolicy({ preferredUserId: "another-missing-user" }), /Choose a Gamemaster/);
  game.user = env.assistant; // The full GM's already-open form must recheck on submit.
  await assert.rejects(PlaybackControllerConfig.submitPolicy(null, {
    elements: { preferredUserId: { value: "" } }, querySelectorAll: () => [],
  }), /Only a full Gamemaster/);
});

test("queued clock writes are invalidated across A-B-A while a submitted write settles once", async t => {
  const env = environment(t);
  const { playlist, source } = fixture();
  const gate = deferred();
  const writes = [];
  playlist.setFlag = async (_scope, key, value) => {
    writes.push(value);
    if (writes.length === 1) await gate.promise;
    playlist.flags[key] = value;
  };
  const submitted = PlaybackClock.record(playlist, source, source.sound, { force: true });
  await flush();
  const stale = PlaybackClock.record(playlist, source, source.sound, { force: true, offsetSec: 9 });
  env.policy({ preferredUserId: env.assistant.id });
  env.policy({ preferredUserId: env.gm.id });
  gate.resolve();
  assert.ok(await submitted);
  assert.equal(await stale, null);
  assert.equal(writes.length, 1);
  await PlaybackClock.record(playlist, source, source.sound, { force: true, offsetSec: 12 });
  assert.equal(writes.length, 2);
  assert.equal(writes[1].offsetSec, 12);
});

test("handoff cancels obsolete crossfade scheduling without touching live media or its looper", async t => {
  const env = environment(t);
  const { playlist, source } = fixture({ crossfade: true, useCustomAutoFade: true, customAutoFadeMs: 2000 });
  game.playlists = [playlist];
  await scheduleCrossfade(playlist, source);
  const old = source.sound.schedules[0];
  env.policy({ preferredUserId: env.assistant.id });
  cancelCrossfade(playlist);
  old.callback();
  assert.equal(playlist.mutations.length, 0);
  assert.equal(source.sound.stops, 0);
  game.user = env.assistant;
  source.sound.currentTime = 13;
  await reconcileControllerPlayback(playlist);
  assert.equal(source.sound.schedules.at(-1).at, 28);
  assert.equal(source.sound.currentTime, 13);
  assert.equal(source.sound.plays, 0);
  cancelCrossfade(playlist);
});

test("an automatic crossfade committed before handoff finishes one load and one advancement", async t => {
  const env = environment(t);
  const { playlist, source, next } = fixture({ crossfade: true, useCustomAutoFade: true, customAutoFadeMs: 1000 });
  game.playlists = [playlist];
  const gate = deferred();
  next.sound.loaded = false;
  next.load = async () => { await gate.promise; next.sound.loaded = true; return next.sound; };
  const pending = performCrossfade(playlist, source);
  await flush();
  assert.equal(next.playing, true);
  assert.equal(playlist.flags.crossfadeTransition.gmId, env.gm.id);
  env.policy({ preferredUserId: env.assistant.id });
  game.user = env.assistant;
  const session = State.getCrossfadeSession(playlist);
  await reconcileControllerPlayback(playlist);
  assert.equal(State.getCrossfadeSession(playlist), session);
  assert.equal(await performCrossfade(playlist, source), false);
  gate.resolve();
  assert.equal(await pending, true);
  assert.equal(playlist.mutations.length, 1);
  assert.equal(next.sound.plays, 1);
  assert.equal(source.playing, false);
  assert.equal(session.status, "active");
  const fadeToken = State.getFadeToken(next.sound);
  await reconcileControllerPlayback(playlist);
  assert.equal(State.getFadeToken(next.sound), fadeToken);
  assert.equal(next.sound.plays, 1);
  await session.settle({ mode: "complete" });
  assert.equal(next.sound.playing, true);
});

test("a pending media lookup cannot arm a crossfade after authority is lost", async t => {
  const env = environment(t);
  const { playlist, source } = fixture({ crossfade: true, useCustomAutoFade: true, customAutoFadeMs: 1000 });
  const oldWait = foundry.audio.AudioTimeout.wait, gate = deferred(), localMedia = source.sound;
  t.after(() => { foundry.audio.AudioTimeout.wait = oldWait; });
  foundry.audio.AudioTimeout.wait = () => gate.promise;
  source.sound = null;
  const pending = scheduleCrossfade(playlist, source);
  env.policy({ preferredUserId: env.assistant.id });
  source.sound = localMedia;
  gate.resolve();
  await pending;
  assert.equal(localMedia.schedules.length, 0);
  assert.equal(localMedia.playing, true);
});

test("stale terminal fade callbacks cannot stop a playlist after handoff or all-user exclusion", async t => {
  const env = environment(t);
  const { playlist, source, next } = fixture({ crossfade: true, useCustomAutoFade: true, customAutoFadeMs: 1000 });
  playlist.sounds.splice(playlist.sounds.indexOf(next), 1);
  playlist.playbackOrder = [source.id];
  const oldWait = foundry.audio.AudioTimeout.wait, gate = deferred();
  t.after(() => { foundry.audio.AudioTimeout.wait = oldWait; });
  foundry.audio.AudioTimeout.wait = () => gate.promise;
  assert.equal(await performCrossfade(playlist, source), true);
  env.policy({ excludedUserIds: [env.gm.id, env.assistant.id] });
  assert.equal(Authority.getAuthorizedGMId(), null);
  gate.resolve();
  await flush();
  assert.equal(playlist.mutations.length, 0);
  assert.equal(playlist.playing, true);
  assert.equal(await performCrossfade(playlist, source), false);
});

test("new controller recovers an abandoned committed crossfade without restarting incoming media", async t => {
  const env = environment(t);
  const { playlist, source, next } = fixture({ crossfade: true });
  next.playing = true;
  next.sound.playing = true;
  playlist.flags.crossfadeTransition = { incomingSoundId: next.id, outgoingSoundId: source.id, gmId: env.gm.id };
  game.playlists = [playlist];
  env.policy({ preferredUserId: env.assistant.id });
  game.user = env.assistant;
  await runPlaybackRecoveryWatchdog("handoff");
  assert.equal(source.playing, true, "a connected author retains its submitted operation");
  env.gm.active = false;
  await runPlaybackRecoveryWatchdog("disconnect");
  assert.equal(source.playing, false);
  assert.equal(next.sound.plays, 0);
  assert.equal(next.sound.stops, 0);
});

test("silence creation survives handoff with its persisted deadline and no stale playSound", async t => {
  const env = environment(t);
  const { playlist, source } = fixture({ silenceMode: "static", silenceDuration: 60000 });
  game.playlists = [playlist];
  const gate = deferred(), create = playlist.createEmbeddedDocuments.bind(playlist);
  playlist.createEmbeddedDocuments = async (...args) => { await gate.promise; return create(...args); };
  playlist.playSound = () => assert.fail("former controller must not send a second selection");
  const pending = startSilenceGap(playlist, source);
  const original = State.getSilenceState(playlist);
  env.policy({ preferredUserId: env.assistant.id });
  gate.resolve();
  const started = await pending;
  assert.equal(started.reason, "authority-changed");
  const gap = playlist.sounds.find(sound => sound.getFlag(MODULE_ID, "isSilenceGap"));
  assert.ok(gap?.playing);
  game.user = env.assistant;
  await recoverPersistedSilenceGaps("controller test");
  const recovered = State.getSilenceState(playlist);
  assert.equal(recovered.expectedEndAt, original.expectedEndAt);
  assert.equal(source.playing, false);
  recovered.timer.cancel();
  State.clearSilenceState(playlist);
});

test("silence completion already submitted during handoff settles naturally exactly once", async t => {
  const env = environment(t);
  const { playlist, source, next } = fixture({ silenceMode: "static", silenceDuration: 60000 });
  game.playlists = [playlist];
  await startSilenceGap(playlist, source);
  const state = State.getSilenceState(playlist), gate = deferred();
  const update = playlist.update.bind(playlist);
  let selections = 0;
  playlist.update = async changes => { selections++; await gate.promise; return update(changes); };
  const completion = completeSilenceGap(playlist, state);
  env.policy({ preferredUserId: env.assistant.id });
  const relinquish = recoverPersistedSilenceGaps("pending completion");
  gate.resolve();
  assert.equal(await completion, true);
  await relinquish;
  assert.equal(state.terminalOutcome, "natural");
  assert.equal(selections, 1);
  assert.equal(next.playing, true);
  game.user = env.assistant;
  await recoverPersistedSilenceGaps("new controller");
  assert.equal(selections, 1);
  assert.equal(playlist.sounds.some(s => s.getFlag(MODULE_ID, "isSilenceGap")), false);
});

test("delayed loop completion cannot advance after A-B-A authority changes", async t => {
  const env = environment(t);
  const { playlist, source } = fixture();
  const oldWait = foundry.audio.AudioTimeout.wait, gate = deferred();
  t.after(() => { foundry.audio.AudioTimeout.wait = oldWait; });
  foundry.audio.AudioTimeout.wait = ms => ms === 100 ? gate.promise : Promise.resolve();
  const looper = Object.create(LoopingSound.prototype);
  Object.assign(looper, { ps: source, soundA: source.sound, isA_Active: true, isDestroyed: false,
    _invalidateLoopOperation() {}, _setActiveLoopSegment() {}, _unregisterIfCurrent() {} });
  const pending = looper._fadeOutAndAdvance();
  await flush();
  env.policy({ preferredUserId: env.assistant.id });
  env.policy({ preferredUserId: env.gm.id });
  gate.resolve();
  await pending;
  assert.equal(playlist.mutations.length, 0);
  await reconcilePendingLoopCompletions();
  assert.equal(playlist.mutations.length, 1, "the new generation can finish the retired loop without recreating it");
  assert.equal(source.sound.plays, 0);
  clearPendingLoopCompletion(source);
});

test("shared coordinator coalesces policy/presence events and ignores unchanged selections", async t => {
  const env = environment(t);
  const oldHooks = globalThis.Hooks, handlers = new Map(), events = [];
  t.after(() => { globalThis.Hooks = oldHooks; });
  globalThis.Hooks = {
    on(name, callback) { handlers.set(name, [...(handlers.get(name) ?? []), callback]); },
    callAll(name, ...args) { for (const callback of handlers.get(name) ?? []) callback(...args); },
  };
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  Hooks.on(`${MODULE_ID}.playbackAuthorityChanged`, event => events.push(event));
  registerPlaybackAuthorityHooks();
  await tick();
  assert.equal(events.at(-1).userId, env.gm.id);
  Hooks.callAll("userConnected", env.assistant, true);
  Hooks.callAll("updateUser", env.gm, { name: "renamed" });
  await tick();
  assert.equal(events.length, 1);
  env.policy({ preferredUserId: env.assistant.id });
  Hooks.callAll(`${MODULE_ID}.playbackControllerPolicyChanged`);
  Hooks.callAll("userConnected", env.assistant, true);
  await tick();
  assert.equal(events.length, 2);
  assert.equal(events[1].userId, env.assistant.id);
  assert.match(events[1].reason, /settings changed.*userConnected/);
  env.assistant.active = false;
  Hooks.callAll("userConnected", env.assistant, false);
  await tick();
  assert.equal(events.at(-1).userId, env.gm.id);
  env.assistant.active = true;
  Hooks.callAll("userConnected", env.assistant, true);
  await tick();
  assert.equal(events.at(-1).userId, env.assistant.id);
  env.assistant.role = 1;
  env.assistant.isGM = false;
  Hooks.callAll("updateUser", env.assistant, { role: 1 });
  await tick();
  assert.equal(events.at(-1).userId, env.gm.id);
  game.users = [];
  Hooks.callAll("deleteUser", env.gm);
  await tick();
  assert.equal(events.at(-1).userId, null);
});
