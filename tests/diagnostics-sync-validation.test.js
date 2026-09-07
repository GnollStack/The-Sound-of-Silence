import test from "node:test";
import assert from "node:assert/strict";
import {
  assertExpectedSyncClients,
  collectUntilSyncState,
} from "../scripts/diagnostics-sync-validation.js";

const gm = { client: { userId: "gm", userName: "GM", clientInstanceId: "gm-tab" } };
const player = { client: { userId: "player", userName: "Player", clientInstanceId: "player-tab" } };

test("sync validation rejects a player disappearing after a successful preflight", () => {
  assert.throws(
    () => assertExpectedSyncClients({ clients: [gm] }, [gm, player]),
    /missing expected responder\(s\): Player/
  );
});

test("sync validation tracks browser instances even when they share a user", () => {
  const secondTab = { client: { ...player.client, clientInstanceId: "second-player-tab" } };
  assert.throws(
    () => assertExpectedSyncClients({ clients: [gm, secondTab] }, [gm, player]),
    /missing expected responder/
  );
  assert.doesNotThrow(() => assertExpectedSyncClients({ clients: [player, gm, secondTab] }, [gm, player]));
});

test("stop validation resamples asynchronous media completion", async () => {
  let requests = 0;
  const result = await collectUntilSyncState(
    async () => ({ clients: [{ playingSounds: ++requests === 1 ? [{ playing: true }] : [] }] }),
    (snapshot) => snapshot.clients.every((client) => client.playingSounds.length === 0)
  );
  assert.equal(requests, 2);
  assert.deepEqual(result.clients[0].playingSounds, []);
});

test("stop validation retains stuck media evidence at its deadline", async () => {
  const stuck = { clients: [{ playingSounds: [{ playing: true, gainValue: 0.2 }] }] };
  let requests = 0;
  const result = await collectUntilSyncState(
    async () => { requests += 1; return stuck; },
    (snapshot) => snapshot.clients.every((client) => client.playingSounds.length === 0),
    { timeoutMs: 0 }
  );
  assert.equal(requests, 1);
  assert.equal(result, stuck);
});

test("stop validation preserves collection failures instead of passing an empty result", async () => {
  await assert.rejects(
    collectUntilSyncState(async () => { throw new Error("player did not respond"); }, () => true),
    /player did not respond/
  );
});
