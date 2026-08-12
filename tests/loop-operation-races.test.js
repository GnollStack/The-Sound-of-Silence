import test from "node:test";
import assert from "node:assert/strict";

const { LoopingSound } = await import("../scripts/looping-sound.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeGain(value) {
  return {
    value,
    cancelAndHoldAtTime() {},
    cancelScheduledValues() {},
    setValueAtTime(next) { this.value = next; },
    setValueCurveAtTime(curve) { this.value = curve.at(-1); },
  };
}

function makeSegment() {
  return {
    start: "00:01.000",
    end: "00:05.000",
    startSec: 1,
    endSec: 5,
    crossfadeMs: 100,
    loopCount: 0,
  };
}

async function flushUntil(predicate, attempts = 12) {
  for (let index = 0; index < attempts && !predicate(); index++) {
    await Promise.resolve();
  }
  assert.ok(predicate(), "expected asynchronous operation to reach the requested state");
}

test("a superseded target load cannot overwrite the replacement loop buffer", async () => {
  const OriginalSound = foundry.audio.Sound;
  const instances = [];

  class LoadingSound {
    constructor() {
      this.id = `loading-target-${instances.length + 1}`;
      this.loaded = false;
      this.failed = false;
      this.playing = false;
      this.stopCalls = 0;
      this.loadDeferred = deferred();
      instances.push(this);
    }

    async load() {
      await this.loadDeferred.promise;
      this.loaded = true;
      return this;
    }

    addEventListener() {}

    stop() {
      this.playing = false;
      this.stopCalls++;
    }
  }

  foundry.audio.Sound = LoadingSound;
  try {
    const sourceSound = { id: "load-source", playing: true };
    const playlistSound = {
      id: "load-race",
      name: "Load Race",
      path: "load-race.ogg",
      sound: sourceSound,
      _onEnd() {},
    };
    const looper = new LoopingSound(playlistSound, { segments: [makeSegment()] });
    looper.soundA = sourceSound;

    const olderOperation = looper._beginLoopOperation("older load");
    const olderPreparation = looper._prepareTargetSound(olderOperation);
    assert.equal(instances.length, 1);

    const replacementOperation = looper._beginLoopOperation("replacement load");
    const replacementPreparation = looper._prepareTargetSound(replacementOperation);
    assert.equal(instances.length, 2, "replacement must not share the older in-flight target");

    const [olderTarget, replacementTarget] = instances;
    replacementTarget.loadDeferred.resolve();
    assert.equal(await replacementPreparation, replacementTarget);
    assert.equal(looper.soundB, replacementTarget);

    olderTarget.loadDeferred.resolve();
    assert.equal(await olderPreparation, null);
    assert.equal(looper.soundB, replacementTarget, "late older load must not replace the current buffer");
    assert.equal(olderTarget.stopCalls, 1);
    assert.equal(replacementTarget.stopCalls, 0);

    looper._completeLoopOperation(replacementOperation);
  } finally {
    foundry.audio.Sound = OriginalSound;
  }
});

test("an older rejected play cannot clear a replacement loop operation", async () => {
  const context = { currentTime: 0 };
  const oldPlay = deferred();
  const sourceSound = {
    id: "operation-source",
    playing: true,
    currentTime: 4,
    volume: 0.6,
    gain: makeGain(0.6),
    context,
    stopCalls: 0,
    stop() {
      this.playing = false;
      this.stopCalls++;
    },
  };
  const olderTarget = {
    id: "older-operation-target",
    playing: false,
    volume: 0,
    gain: makeGain(0),
    context,
    stopCalls: 0,
    async play() {
      await oldPlay.promise;
      this.playing = true;
    },
    stop() {
      this.playing = false;
      this.stopCalls++;
    },
  };
  const replacementTarget = {
    id: "replacement-operation-target",
    playing: false,
    volume: 0,
    gain: makeGain(0),
    context,
    stopCalls: 0,
    async play() {
      this.playing = true;
    },
    stop() {
      this.playing = false;
      this.stopCalls++;
    },
  };
  const segment = makeSegment();
  const playlistSound = {
    id: "operation-race",
    name: "Operation Race",
    volume: 0.6,
    sound: sourceSound,
  };
  const looper = new LoopingSound(playlistSound, { segments: [segment] });
  looper.soundA = sourceSound;
  looper.activeLoopSegment = segment;

  const targets = [olderTarget, replacementTarget];
  looper._prepareTargetSound = async (operation) => {
    const target = targets.shift();
    operation.targetSound = target;
    looper.soundB = target;
    return target;
  };

  const olderHandoff = looper._performCrossfadeLoop();
  await flushUntil(() => Boolean(looper._activeLoopOperation?.targetSound));

  const replacementHandoff = looper._performCrossfadeLoop();
  await flushUntil(() => Boolean(looper.handoffTimer));
  const replacementTimer = looper.handoffTimer;
  const replacementOperation = looper._activeLoopOperation;

  oldPlay.reject(new Error("injected superseded play failure"));
  assert.equal(await olderHandoff, false);

  assert.equal(looper._activeLoopOperation, replacementOperation);
  assert.equal(looper.handoffTimer, replacementTimer);
  assert.equal(looper.isCrossfading, true);
  assert.equal(replacementTarget.playing, true);
  assert.equal(replacementTarget.stopCalls, 0);
  assert.equal(olderTarget.stopCalls, 1);
  assert.equal(sourceSound.stopCalls, 0);

  looper.pause();
  assert.equal(await replacementHandoff, false);
});
