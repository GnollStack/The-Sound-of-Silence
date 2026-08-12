import test from "node:test";
import assert from "node:assert/strict";

const { SoundscapeEngine } = await import("../scripts/procedural-ambience.js");
const { registerSettings } = await import("../scripts/settings.js");
const { API } = await import("../scripts/api.js");

function makeUsers(...users) {
  const collection = [...users];
  collection.get = (id) => collection.find((user) => String(user.id) === String(id));
  return collection;
}

function makeSoundscapeFixture() {
  const playlist = new Playlist();
  playlist.id = "runtime-soundscape";
  playlist.name = "Runtime Soundscape";
  playlist.fade = 0;
  playlist.playing = true;
  playlist.playbackOrder = ["procedural-one"];
  playlist.getFlag = (_scope, key) => ({
    soundscapeMode: true,
    soundscapeMaxPolyphony: 4,
    soundscapeGroups: [],
    volumeNormalizationEnabled: false,
  })[key];

  const sound = new PlaylistSound();
  sound.id = "procedural-one";
  sound.name = "Procedural One";
  sound.parent = playlist;
  sound.playing = true;
  sound.volume = 0.5;
  sound.path = "procedural-one.ogg";
  sound.getFlag = (_scope, key) => ({
    isProcedural: true,
    minDelay: 30,
    maxDelay: 30,
    timingMode: "fixed",
    initialFireMode: "cadence",
    playChance: 100,
    volumeVariance: 0,
    randomPan: false,
  })[key];

  const sounds = [sound];
  sounds.get = (id) => sounds.find((entry) => String(entry.id) === String(id));
  playlist.sounds = sounds;
  return { playlist, sound, sounds };
}

function captureGameState() {
  return {
    user: game.user,
    users: game.users,
    settings: game.settings,
    socket: game.socket,
    audio: game.audio,
  };
}

function restoreGameState(state) {
  Object.assign(game, state);
}

test("primary GM keeps publishing when its local sync preference is disabled", () => {
  const saved = captureGameState();
  try {
    const gm = { id: "gm-a", isGM: true, active: true };
    game.user = gm;
    game.users = makeUsers(gm);
    game.settings = { get: () => false };

    const { playlist } = makeSoundscapeFixture();
    const engine = new SoundscapeEngine(playlist);

    assert.equal(engine.soundscapeSyncEnabled, false);
    assert.equal(engine.syncMode, "authority");
    assert.equal(engine._shouldArmLocalProcedurals(), true);
    assert.equal(engine._shouldEmitSyncedFires(), true);
  } finally {
    restoreGameState(saved);
  }
});

test("live sync preference changes arm and disarm local procedural timers", async () => {
  const saved = captureGameState();
  let engine;
  try {
    let syncEnabled = false;
    const gm = { id: "gm-a", isGM: true, active: true };
    const player = { id: "player-a", isGM: false, active: true };
    game.user = player;
    game.users = makeUsers(gm, player);
    game.settings = {
      get: (_scope, key) => key === "soundscapeProceduralSyncEnabled" ? syncEnabled : false,
    };

    const { playlist, sound } = makeSoundscapeFixture();
    engine = new SoundscapeEngine(playlist);
    engine.isStarted = true;

    engine.syncProceduralSounds();
    assert.equal(engine.oneShotTimers.has(sound.id), true);

    syncEnabled = true;
    engine.syncProceduralSounds();
    assert.equal(engine.syncMode, "synced");
    assert.equal(engine.oneShotTimers.has(sound.id), false);

    syncEnabled = false;
    engine.syncProceduralSounds();
    assert.equal(engine.syncMode, "local");
    assert.equal(engine.oneShotTimers.has(sound.id), true);
  } finally {
    engine?.destroy({ stopBeds: false });
    restoreGameState(saved);
    await Promise.resolve();
  }
});

test("resolved AudioTimeout cancellation cannot fire a disarmed procedural", async () => {
  const saved = captureGameState();
  let engine;
  try {
    const gm = { id: "gm-a", isGM: true, active: true };
    game.user = gm;
    game.users = makeUsers(gm);
    game.settings = { get: () => true };

    const { playlist, sound } = makeSoundscapeFixture();
    engine = new SoundscapeEngine(playlist);
    engine.isStarted = true;
    let fireCount = 0;
    engine._fireOneShot = async () => {
      fireCount += 1;
      return true;
    };

    engine.armProceduralSound(sound);
    const timer = engine.oneShotTimers.get(sound.id)?.timer;
    assert.ok(timer);
    engine.disarmProceduralSound(sound);
    await timer.complete;
    await Promise.resolve();

    assert.equal(fireCount, 0);
    assert.equal(engine.oneShotTimers.has(sound.id), false);
  } finally {
    engine?.destroy({ stopBeds: false });
    restoreGameState(saved);
  }
});

test("synced recipe sequences restart safely for a new publisher session", async () => {
  const saved = captureGameState();
  try {
    const gm = { id: "gm-a", isGM: true, active: true };
    const secondary = { id: "gm-b", isGM: true, active: true };
    const player = { id: "player-a", isGM: false, active: true };
    game.user = player;
    game.users = makeUsers(gm, secondary, player);
    game.settings = { get: () => true };

    const { playlist, sound } = makeSoundscapeFixture();
    const engine = new SoundscapeEngine(playlist);
    engine.isStarted = true;
    engine._playOneShotRecipe = async () => true;

    const recipe = (session, seq, {
      authorId = gm.id,
      claimedGmId = "forged-user",
      manualFire = false,
    } = {}) => ({
      action: "soundscape-procedural-fire",
      playlistId: playlist.id,
      soundId: sound.id,
      manualFire,
      publisherSessionId: session,
      seq,
      eventId: `${playlist.id}:${sound.id}:${seq}:${authorId}:${session}`,
      startAtMs: Date.now(),
      gmId: claimedGmId,
    });

    assert.equal(await engine.executeSyncedFire(
      recipe("session-one", 8),
      { senderUserId: gm.id }
    ), true);
    assert.equal(await engine.executeSyncedFire(
      recipe("session-one", 7),
      { senderUserId: gm.id }
    ), false);
    assert.equal(await engine.executeSyncedFire(
      recipe("session-two", 1),
      { senderUserId: gm.id }
    ), true);

    // A claimed GM id is ignored. Secondary GMs cannot publish automatic
    // schedule events, but may synchronize an explicit Fire Now recipe.
    assert.equal(engine.recentSyncedEvents.at(-1)?.gmId, gm.id);
    assert.equal(await engine.executeSyncedFire(
      recipe("session-three", 1, { authorId: secondary.id }),
      { senderUserId: secondary.id }
    ), false);
    assert.equal(await engine.executeSyncedFire(
      recipe("session-three", 1, {
        authorId: secondary.id,
        manualFire: true,
      }),
      { senderUserId: secondary.id }
    ), true);
    assert.equal(await engine.executeSyncedFire(
      recipe("session-player", 1, {
        authorId: player.id,
        manualFire: true,
      }),
      { senderUserId: player.id }
    ), false);

    const invalidIdentity = recipe("session-four", 1);
    invalidIdentity.eventId = "arbitrary-event-id";
    assert.equal(await engine.executeSyncedFire(
      invalidIdentity,
      { senderUserId: gm.id }
    ), false);
  } finally {
    restoreGameState(saved);
  }
});

test("secondary GM Fire Now emits an explicitly authenticated manual recipe", async () => {
  const saved = captureGameState();
  try {
    const primary = { id: "gm-a", isGM: true, active: true };
    const secondary = { id: "gm-b", isGM: true, active: true };
    game.user = secondary;
    game.users = makeUsers(primary, secondary);
    game.settings = { get: () => true };
    let emitted = null;
    game.socket = {
      id: "secondary-socket",
      emit: (_channel, data) => {
        emitted = data;
      },
    };

    const { playlist, sound } = makeSoundscapeFixture();
    const engine = new SoundscapeEngine(playlist);
    engine.isStarted = true;
    engine._playOneShotRecipe = async () => true;

    assert.equal(await engine.fireOneShotNow(sound.id), true);
    assert.equal(emitted?.manualFire, true);
    assert.equal(emitted?.gmId, secondary.id);
    assert.match(emitted?.eventId ?? "", new RegExp(`:${secondary.id}:`));
  } finally {
    restoreGameState(saved);
  }
});

test("deleting a procedural sound cancels its timer and removes engine ownership", async () => {
  const saved = captureGameState();
  let engine;
  try {
    const gm = { id: "gm-a", isGM: true, active: true };
    game.user = gm;
    game.users = makeUsers(gm);
    game.settings = { get: () => true };

    const { playlist, sound, sounds } = makeSoundscapeFixture();
    engine = new SoundscapeEngine(playlist);
    engine.isStarted = true;
    engine.bedSoundIds.add(sound.id);
    let fireCount = 0;
    engine._fireOneShot = async () => {
      fireCount += 1;
      return true;
    };
    engine.armProceduralSound(sound);
    const timer = engine.oneShotTimers.get(sound.id)?.timer;

    sounds.splice(sounds.indexOf(sound), 1);
    engine.removePlaylistSound(sound);
    await timer.complete;
    await Promise.resolve();

    assert.equal(fireCount, 0);
    assert.equal(engine.oneShotTimers.has(sound.id), false);
    assert.equal(engine.bedSoundIds.has(sound.id), false);
  } finally {
    engine?.destroy({ stopBeds: false });
    restoreGameState(saved);
  }
});

test("sync setting registration reconciles live soundscape engines", () => {
  const saved = captureGameState();
  const registrations = new Map();
  let reconciled = 0;
  try {
    game.settings = {
      register: (_scope, key, config) => registrations.set(key, config),
      registerMenu: () => {},
    };
    registerSettings({
      reconcileSoundscapeEngines: () => {
        reconciled += 1;
      },
    });

    registrations.get("soundscapeProceduralSyncEnabled").onChange(false);
    assert.equal(reconciled, 1);
  } finally {
    restoreGameState(saved);
  }
});

test("diagnostics setting requests use authenticated socket sender identity", async () => {
  const saved = captureGameState();
  let setCount = 0;
  try {
    const gm = { id: "gm-a", isGM: true, active: true };
    const player = { id: "player-a", isGM: false, active: true };
    game.user = player;
    game.users = makeUsers(gm, player);
    game.settings = {
      get: (_scope, key) => key === "enableMcpDiagnostics",
      set: async () => {
        setCount += 1;
      },
    };
    game.socket = { emit: () => {} };

    const request = {
      action: "diagnostics-client-setting-request",
      requestId: "valid_request_id",
      senderUserId: gm.id,
      targetUserId: player.id,
      key: "soundscapeProceduralSyncEnabled",
      value: false,
    };

    await API._handleDiagnosticsClientSettingRequest(request, player.id);
    assert.equal(setCount, 0);

    await API._handleDiagnosticsClientSettingRequest(request, gm.id);
    assert.equal(setCount, 1);
  } finally {
    restoreGameState(saved);
  }
});
