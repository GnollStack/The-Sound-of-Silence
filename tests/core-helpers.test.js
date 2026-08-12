import test from "node:test";
import assert from "node:assert/strict";

import {
  createDeterministicRandom,
  formatTimeValue,
  getPublicApiKeys,
  normalizeNonNegativeNumber,
  selectPrimaryActiveGmId,
  shouldUseNativeTrackCompletion,
} from "../scripts/core-helpers.js";

test("deterministic random streams are stable and seed-specific", () => {
  const first = createDeterministicRandom("playlist:42:cycle:1");
  const second = createDeterministicRandom("playlist:42:cycle:1");
  const different = createDeterministicRandom("playlist:42:cycle:2");
  const firstValues = Array.from({ length: 8 }, () => first());

  assert.deepEqual(firstValues, Array.from({ length: 8 }, () => second()));
  assert.notDeepEqual(firstValues, Array.from({ length: 8 }, () => different()));
  assert.equal(firstValues.every((value) => value >= 0 && value < 1), true);
});

test("formatTimeValue carries rounded milliseconds across minute boundaries", () => {
  assert.equal(formatTimeValue(59.9996), "01:00.000");
  assert.equal(formatTimeValue(3599.9996), "60:00.000");
  assert.equal(formatTimeValue(-1), "00:00.000");
  assert.equal(formatTimeValue(Number.NaN), "00:00.000");
});

test("formatTimeValue retains the existing whole-second truncation contract", () => {
  assert.equal(formatTimeValue(59.9996, false), "00:59");
  assert.equal(formatTimeValue(60, false), "01:00");
});

test("normalizeNonNegativeNumber preserves zero and rejects non-finite values", () => {
  assert.equal(normalizeNonNegativeNumber(0, 500), 0);
  assert.equal(normalizeNonNegativeNumber("0", 500), 0);
  assert.equal(normalizeNonNegativeNumber(-5, 500), 0);
  assert.equal(normalizeNonNegativeNumber(Number.NaN, 500), 500);
  assert.equal(normalizeNonNegativeNumber(Infinity, 500), 500);
});

test("selectPrimaryActiveGmId is deterministic regardless of collection order", () => {
  const users = [
    { id: "gm-z", isGM: true, active: true },
    { id: "player-a", isGM: false, active: true },
    { id: "gm-a", isGM: true, active: true },
    { id: "gm-0", isGM: true, active: false },
  ];
  assert.equal(selectPrimaryActiveGmId(users), "gm-a");
  assert.equal(selectPrimaryActiveGmId([...users].reverse()), "gm-a");
  assert.equal(selectPrimaryActiveGmId([]), null);
});

test("automatic completion falls back natively only when the authority did not start a transition", () => {
  assert.equal(shouldUseNativeTrackCompletion({ isAuthority: true }), true);
  assert.equal(shouldUseNativeTrackCompletion({ crossfade: true, crossfadeMs: 0, isAuthority: true }), true);
 assert.equal(shouldUseNativeTrackCompletion({ crossfade: true, crossfadeMs: 500, isAuthority: true }), false);
  assert.equal(shouldUseNativeTrackCompletion({
    crossfade: true,
    crossfadeMs: 500,
    crossfadeStarted: false,
    isAuthority: true,
  }), true);
  assert.equal(shouldUseNativeTrackCompletion({ silence: true, silenceStarted: false, isAuthority: true }), true);
  assert.equal(shouldUseNativeTrackCompletion({ silence: true, silenceStarted: true, isAuthority: true }), false);
  assert.equal(shouldUseNativeTrackCompletion({ crossfade: true, crossfadeMs: 0, isAuthority: false }), false);
});

test("getPublicApiKeys includes prototype methods and own fields", () => {
  class ExampleApi {
    constructor() {
      this.ID = "example";
    }

    inspectAll() {}
  }

  assert.deepEqual(getPublicApiKeys(new ExampleApi()), ["ID", "inspectAll"]);
});
