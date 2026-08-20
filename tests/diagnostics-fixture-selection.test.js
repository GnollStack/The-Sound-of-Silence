import test from "node:test";
import assert from "node:assert/strict";

import { requireNamedPlaylistSounds } from "../scripts/diagnostics-fixture-selection.js";

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
