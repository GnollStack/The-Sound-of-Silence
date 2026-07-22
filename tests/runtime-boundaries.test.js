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
      constructor(duration = 0) {
        this.duration = duration;
        this.cancelled = false;
        this.complete = new Promise((resolve, reject) => {
          this._resolve = resolve;
          this._reject = reject;
        });
      }

      cancel() {
        if (this.cancelled) return;
        this.cancelled = true;
        this._reject(new Error("cancelled"));
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
globalThis.Hooks = { callAll() {} };
globalThis.CONST = {
  PLAYLIST_MODES: {
    DISABLED: -1,
    SEQUENTIAL: 0,
    SHUFFLE: 1,
    SIMULTANEOUS: 2,
  },
};
globalThis.game = { settings: { get: () => false } };

const { Flags, sanitizeSoundscapeGroups } = await import("../scripts/flag-service.js");
const { safeStop } = await import("../scripts/utils.js");
const {
  activateCrossfadeSession,
  createCrossfadeSession,
  settleCrossfadeSession,
} = await import("../scripts/playback/transition-session.js");
const { planCrossfadePreload } = await import("../scripts/playback/preload-coordinator.js");
const { State } = await import("../scripts/state-manager.js");
const { SoundscapeEngine } = await import("../scripts/procedural-ambience.js");

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
