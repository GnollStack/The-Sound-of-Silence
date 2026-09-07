import test from "node:test";
import assert from "node:assert/strict";

import { createFixtureAudioResolver, requireNamedPlaylistSounds } from "../scripts/diagnostics-fixture-selection.js";

test("diagnostic fixture roles resolve by exact name when playlist sound order is reversed", () => {
  const source = { id: "legacy-source", name: "Legacy Loop Source" };
  const next = { id: "legacy-next", name: "Legacy Loop Next" };
  const unrelated = { id: "unrelated", name: "Unrelated Fixture Sound" };
  const playlist = {
    id: "legacy-loop-fixture",
    name: "Legacy Loop Crossfade Fixture",
    sounds: [next, unrelated, source],
  };

  const resolved = requireNamedPlaylistSounds(playlist, [
    "Legacy Loop Source",
    "Legacy Loop Next",
  ]);

  assert.equal(resolved[0], source);
  assert.equal(resolved[1], next);
});

test("diagnostic fixture role resolution reports the exact missing sound", () => {
  const source = { id: "legacy-source", name: "Legacy Loop Source" };
  const next = { id: "legacy-next", name: "Legacy Loop Next" };
  const playlist = {
    id: "legacy-loop-fixture",
    name: "Legacy Loop Crossfade Fixture",
    sounds: [],
  };

  playlist.sounds = [next];
  assert.throws(
    () => requireNamedPlaylistSounds(playlist, ["Legacy Loop Source", "Legacy Loop Next"]),
    {
      name: "Error",
      message: 'Playlist fixture "Legacy Loop Crossfade Fixture" is missing sound "Legacy Loop Source".',
    }
  );

  playlist.sounds = [source];
  assert.throws(
    () => requireNamedPlaylistSounds(playlist, ["Legacy Loop Source", "Legacy Loop Next"]),
    {
      name: "Error",
      message: 'Playlist fixture "Legacy Loop Crossfade Fixture" is missing sound "Legacy Loop Next".',
    }
  );
});

test("generic fixture audio reuses at most three twelve-second tones without reading campaign data", () => {
  const originalGame = Object.getOwnPropertyDescriptor(globalThis, "game");
  const generated = [];
  const resolveAudio = createFixtureAudioResolver((options) => {
    generated.push(options);
    return `tone:${options.frequency}:${options.durationSec}`;
  });
  Object.defineProperty(globalThis, "game", {
    configurable: true,
    get() { throw new Error("fixture audio must not inspect campaign playlists"); },
  });
  try {
    const paths = new Set();
    for (let run = 0; run < 3; run += 1) {
      for (const frequency of [110, 220, 330, 440, 550, 660, 770, 880]) {
        paths.add(resolveAudio({ frequency }));
      }
    }
    assert.equal(paths.size, 3);
    assert.equal(generated.length, 3);
    assert.ok(generated.every((options) => options.durationSec === 12));
  } finally {
    if (originalGame) Object.defineProperty(globalThis, "game", originalGame);
    else delete globalThis.game;
  }
});

test("explicit fixture audio retains exact-duration and streamed paths without generating a tone", () => {
  const resolveAudio = createFixtureAudioResolver(() => {
    throw new Error("explicit audio must be preserved");
  });
  for (const path of ["data:audio/wav;base64,short-tone", "https://example.test/stream.ogg"]) {
    assert.equal(resolveAudio({ path }), path);
  }
});

test("fixture audio reuses Foundry's created asset URL only within its originating world", () => {
  let generated = 0;
  const resolveAudio = createFixtureAudioResolver(() => {
    generated += 1;
    return "data:audio/wav;base64,pool-tone";
  });
  const sourcePath = resolveAudio({ worldId: "first-world" });
  const createdPath = "worlds/first-world/assets/sounds/generated-tone.wav";
  assert.equal(resolveAudio.rememberCreatedPath({ sourcePath, path: createdPath, worldId: "first-world" }), true);
  assert.equal(resolveAudio({ worldId: "first-world" }), createdPath);
  assert.equal(generated, 1);
  assert.equal(resolveAudio({ worldId: "second-world" }), sourcePath);
  assert.equal(generated, 2);
  assert.equal(resolveAudio.rememberCreatedPath({
    sourcePath: "campaign/music.ogg", path: "campaign/music.ogg", worldId: "second-world",
  }), false);
});
