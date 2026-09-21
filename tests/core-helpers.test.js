import test from "node:test";
import assert from "node:assert/strict";

import {
  createDeterministicRandom,
  formatTimeValue,
  getPublicApiKeys,
  normalizeNonNegativeNumber,
  normalizePlaybackControllerPolicy,
  resolvePlaybackController,
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

const controllerUsers = [
  { id: "6-assistant", isGM: true, role: 3, active: true },
  { id: "z-gm", isGM: true, role: 4, active: true },
  { id: "f-gm", isGM: true, role: 4, active: true },
  { id: "0-player", isGM: false, role: 1, active: true },
];

test("controller defaults prefer full GMs with stable raw-ID ties in both roles", () => {
  assert.deepEqual(resolvePlaybackController(controllerUsers), { userId: "f-gm", reason: "automatic-full-gm" });
  assert.equal(selectPrimaryActiveGmId([...controllerUsers].reverse()), "f-gm");
  const assistants = [controllerUsers[0], { id: "A-assistant", role: 3, isGM: true, active: true }];
  assert.equal(selectPrimaryActiveGmId(assistants), "6-assistant");
  assert.equal(selectPrimaryActiveGmId(assistants.reverse()), "6-assistant");
});

test("explicit assistant delegation overrides full GMs and exclusions always win", () => {
  assert.deepEqual(resolvePlaybackController(controllerUsers, { preferredUserId: "6-assistant" }), {
    userId: "6-assistant", reason: "preferred",
  });
  assert.equal(selectPrimaryActiveGmId(controllerUsers, {
    preferredUserId: "6-assistant", excludedUserIds: ["6-assistant", "f-gm"],
  }), "z-gm");
  assert.equal(selectPrimaryActiveGmId(controllerUsers, { excludedUserIds: ["f-gm", "z-gm"] }), "6-assistant");
});

test("offline, deleted, demoted and player preferences fall back without modifying saved policy", () => {
  for (const preferred of [
    { ...controllerUsers[0], active: false },
    { ...controllerUsers[0], role: 2, isGM: false },
    { ...controllerUsers[0], role: 2, isGM: true },
    null,
  ]) {
    const policy = Object.freeze({ preferredUserId: "6-assistant", excludedUserIds: Object.freeze([]) });
    const users = [...controllerUsers.slice(1), ...(preferred ? [preferred] : [])];
    assert.equal(selectPrimaryActiveGmId(users, policy), "f-gm");
    assert.equal(policy.preferredUserId, "6-assistant");
  }
  assert.equal(selectPrimaryActiveGmId(controllerUsers, { preferredUserId: "0-player" }), "f-gm");
});

test("malformed controller settings normalize safely and cannot invent eligible users", () => {
  for (const value of [null, undefined, false, "gm", [], 42, { preferredUserId: {}, excludedUserIds: "f-gm" }]) {
    assert.deepEqual(normalizePlaybackControllerPolicy(value), { preferredUserId: null, excludedUserIds: [] });
    assert.equal(selectPrimaryActiveGmId(controllerUsers, value), "f-gm");
  }
  assert.deepEqual(normalizePlaybackControllerPolicy({
    preferredUserId: " f-gm ", excludedUserIds: [null, 42, {}, " z-gm ", "z-gm", ""],
  }), { preferredUserId: "f-gm", excludedUserIds: ["z-gm"] });
});

test("no connected eligible controller produces no selection", () => {
  for (const users of [[], controllerUsers.map(user => ({ ...user, active: false })), [controllerUsers[3]]]) {
    assert.deepEqual(resolvePlaybackController(users), { userId: null, reason: "no-eligible-controller" });
  }
  assert.equal(selectPrimaryActiveGmId(controllerUsers, { excludedUserIds: controllerUsers.map(user => user.id) }), null);
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
