/** Guard multiplayer assertions against missing responders and early snapshots. */
export function assertExpectedSyncClients(collection, expectedClients) {
  const identity = (snapshot) => snapshot.client?.clientInstanceId ||
    snapshot.client?.socketId || snapshot.client?.userId;
  const responded = new Set((collection.clients ?? []).map(identity).filter(Boolean));
  const missing = expectedClients.filter((client) => !responded.has(identity(client)));
  if (missing.length) {
    const names = missing.map((client) => client.client?.userName || identity(client) || "unknown client");
    throw new Error(`Client diagnostics missing expected responder(s): ${names.join(", ")}.`);
  }
}

export async function collectUntilSyncState(collect, matches, { timeoutMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let collection;
  do {
    collection = await collect();
    if (matches(collection)) return collection;
    // Each collection already waits for the configured socket response window.
  } while (Date.now() < deadline);
  return collection;
}
