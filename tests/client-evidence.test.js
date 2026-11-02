import test from "node:test";
import assert from "node:assert/strict";

const { createSoundOfSilenceDiagnostics } = await import("../scripts/diagnostics.js");

function localDiagnostics(overrides = {}) {
  return {
    client: { userId: "player", userName: "Player", isGM: false, clientInstanceId: "instance", socketId: "socket" },
    audio: { available: true, locked: false },
    audioContexts: { music: "running", environment: "running", interface: "running" },
    coreAudioVolumes: { globalPlaylistVolume: 0.5 },
    playingSounds: [],
    soundscapes: [],
    soundscapeProceduralSyncEnabled: true,
    personalAudioMix: { enabled: true, playlistVolumes: { everyPlaylist: 1 }, trackVolumes: { everyTrack: 1 }, trackOverrideCount: 1 },
    playlistDocuments: [{ id: "should-not-be-copied" }],
    ...overrides,
  };
}

async function withGlobals(callback) {
  const saved = { game: globalThis.game, canvas: globalThis.canvas };
  const writes = [];
  globalThis.game = {
    version: "14.369",
    user: { id: "player", name: "Player", isGM: false, active: true },
    modules: new Map([["the-sound-of-silence", { version: "14.15.5" }]]),
    settings: {
      get: (_module, key) => (key === "enableMcpDiagnostics" ? false : null),
      set: async (...entry) => writes.push(entry),
    },
    socket: { on() {}, emit: (...entry) => writes.push(entry) },
  };
  globalThis.canvas = { scene: { id: "scene", name: "Scene" }, ready: true };
  try {
    return await callback(writes);
  } finally {
    globalThis.game = saved.game;
    globalThis.canvas = saved.canvas;
  }
}

test("clientEvidence projects per-client audio with the diagnostics gate closed and writes nothing", () => withGlobals((writes) => {
  let options = null;
  const diagnostics = createSoundOfSilenceDiagnostics({
    _gatherLocalDiagnostics(requested) { options = requested; return localDiagnostics(); },
  });
  assert.equal(diagnostics.getAvailability().available, false);
  assert.equal(diagnostics.actions.clientEvidence, undefined);
  const evidence = diagnostics.clientEvidence({}, { requesterId: "gm", requesterName: "GM" });
  assert.equal(evidence.success, true, evidence.reason);
  assert.deepEqual(options, { playlistIds: [] });
  assert.equal(evidence.user.id, "player");
  assert.equal(evidence.user.isGM, false);
  assert.equal(evidence.scene.id, "scene");
  assert.equal(evidence.moduleState.audioContexts.music, "running");
  assert.equal(evidence.moduleState.personalAudioMix.trackOverrideCount, 1);
  assert.equal(JSON.stringify(evidence).includes("should-not-be-copied"), false);
  assert.deepEqual(writes, []);
}));

test("clientEvidence stays under 16 kB with many playing sounds and soundscapes", () => withGlobals(() => {
  const playingSounds = Array.from({ length: 500 }, (_, index) => ({
    playlistId: `playlist-${index}`, soundId: `sound-${index}`, soundName: "A very long sound name ".repeat(8), gainValue: 1,
    volume: 1, isFading: false, currentTime: 1, duration: 2, contextState: "running",
  }));
  const soundscapes = Array.from({ length: 100 }, (_, index) => ({ playlistId: `playlist-${index}`, active: true, syncMode: "client", bedCount: 1, armedOneShots: 1, activeOneShots: 1, pendingOneShots: 1 }));
  const diagnostics = createSoundOfSilenceDiagnostics({ _gatherLocalDiagnostics: () => localDiagnostics({ playingSounds, soundscapes }) });
  const evidence = diagnostics.clientEvidence();
  assert.equal(evidence.success, true, evidence.reason);
  assert.equal(evidence.moduleState.playingSoundCount, 500);
  assert.equal(evidence.moduleState.playingSounds.length, 30);
  assert.ok(JSON.stringify(evidence).length <= 16000);
}));

test("clientEvidence returns a reason instead of throwing", () => withGlobals(() => {
  const diagnostics = createSoundOfSilenceDiagnostics({ _gatherLocalDiagnostics() { throw new Error("audio state unavailable"); } });
  const evidence = diagnostics.clientEvidence();
  assert.equal(evidence.success, false);
  assert.match(evidence.reason, /audio state unavailable/);
}));
