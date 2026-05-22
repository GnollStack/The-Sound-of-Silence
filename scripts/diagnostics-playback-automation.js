/**
 * @file diagnostics-playback-automation.js
 * @description Mutating, MCP-triggered playback automation for dedicated test worlds.
 */
import { AdvancedShuffle, SHUFFLE_PATTERNS } from "./advanced-shuffle.js";
import { Flags } from "./flag-service.js";
import { disableAllLoopsWithin, nextSegmentWithin } from "./internal-loop.js";
import { Silence } from "./silence.js";
import { State } from "./state-manager.js";
import { MODULE_ID } from "./utils.js";

const FIXTURE_FLAG = "mcpAutomationFixture";
const FIXTURE_FOLDER_NAME = "SoS MCP Automation Fixtures";
const FIXTURE_PLAYLIST_PREFIX = "SoS MCP Test -";
const DEFAULT_WAIT_MS = 250;
const AUDIO_PATH_RE = /\.(?:flac|m4a|mp3|ogg|wav)(?:[?#].*)?$/i;

const CONTROL_OPERATIONS = [
  "playAll",
  "playSound",
  "advance",
  "previous",
  "crossfadeNext",
  "stopAll",
  "cleanup",
];

const SCENARIOS = [
  "basicPlayback",
  "crossfade",
  "silence",
  "loopWithin",
  "soundscape",
  "soundscapeAdvanced",
  "shufflePatterns",
  "customFades",
];

const CLIENT_SYNC_SCENARIOS = [
  "responder",
  "basicPlaybackSync",
  "crossfadeReplication",
  "stopTransitionReplication",
  "loopBreakReplication",
  "loopDisableReplication",
  "loopSegmentSkipReplication",
  "soundscapeStartStopSync",
  "soundscapeBedOnlySync",
  "soundscapeProceduralFireSync",
  "soundscapeProceduralArmDisarmSync",
  "soundscapeClientOptOut",
  "soundscapeCleanupSync",
];

export function createPlaybackAutomation(api) {
  return {
    controlPlayback: (args = {}) => controlPlayback(api, args),
    runPlaybackAutomation: (args = {}) => runPlaybackAutomation(api, args),
    runClientSyncAutomation: (args = {}) => runClientSyncAutomation(api, args),
    cleanupPlaybackFixtures: (args = {}) => cleanupPlaybackFixtures(api, args),
  };
}

export function getPlaybackAutomationActionNames() {
  return ["controlPlayback", "runPlaybackAutomation", "runClientSyncAutomation", "cleanupPlaybackFixtures"];
}

export function getPlaybackAutomationControlOperations() {
  return [...CONTROL_OPERATIONS];
}

export function getPlaybackAutomationScenarios() {
  return ["all", ...SCENARIOS];
}

export function getClientSyncAutomationScenarios() {
  return ["all", ...CLIENT_SYNC_SCENARIOS];
}

async function controlPlayback(api, args) {
  const operation = normalizeChoice(args.operation, CONTROL_OPERATIONS, "operation");
  const playlist = resolvePlaylist(args);
  const waitMs = normalizeWait(args.waitMs, DEFAULT_WAIT_MS);
  let sound = null;

  if (operation === "playSound") {
    sound = resolveSound(playlist, args, { required: true });
    await playlist.playSound(sound);
  } else if (operation === "playAll") {
    await playlist.playAll();
  } else if (operation === "advance") {
    await playlist.playNext();
  } else if (operation === "previous") {
    await playlist.playNext(null, { direction: -1 });
  } else if (operation === "crossfadeNext") {
    sound = resolveSound(playlist, args, { required: false }) ?? getPlayingSound(playlist);
    if (!sound) throw new Error(`Playlist "${playlist.name}" has no active sound to crossfade from.`);
    await api.crossfadeToNext(playlist, sound);
  } else if (operation === "stopAll") {
    await playlist.stopAll();
  } else if (operation === "cleanup") {
    await api.cleanup(playlist, {
      cleanSilence: true,
      cleanCrossfade: true,
      cleanLoopers: true,
      cleanSoundscape: true,
      allowFadeOut: false,
    });
  }

  if (waitMs > 0) await wait(waitMs);

  return {
    success: true,
    operation,
    playlist: summarizePlaylist(playlist),
  };
}

async function runPlaybackAutomation(api, args) {
  const requestedScenario = normalizeChoice(args.scenario ?? "all", getPlaybackAutomationScenarios(), "scenario");
  const leaveFixtures = args.leaveFixtures === true;
  const runId = String(args.runId || foundry.utils.randomID(8));
  const scenarioNames = requestedScenario === "all" ? SCENARIOS : [requestedScenario];
  const beforeCounts = getWorldDocumentCounts();
  const results = [];
  const createdPlaylistIds = [];

  await stopAllPlaylists(api);

  for (const scenario of scenarioNames) {
    const result = await runScenario(api, scenario, runId);
    results.push(result);
    if (result.playlistId) createdPlaylistIds.push(result.playlistId);
    await stopAllPlaylists(api);
  }

  let cleanup = { skipped: true, playlistsDeleted: 0, foldersDeleted: 0 };
  if (!leaveFixtures) {
    cleanup = await cleanupPlaybackFixtures(api, { runId, stopFirst: true });
  }

  const afterCounts = getWorldDocumentCounts();
  const failed = results.filter((result) => !result.success);

  return {
    success: failed.length === 0,
    runId,
    scenario: requestedScenario,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    createdPlaylistIds,
    cleanup,
    documentCounts: {
      before: beforeCounts,
      after: afterCounts,
    },
  };
}

async function runClientSyncAutomation(api, args = {}) {
  const scenarioNames = normalizeScenarioList(
    args.scenarios ?? args.scenario ?? "all",
    getClientSyncAutomationScenarios(),
    CLIENT_SYNC_SCENARIOS,
    "scenarios"
  );
  const expectedNonGmCount = normalizeCount(args.expectedNonGmCount, 1);
  const timeoutMs = normalizeTimeout(args.timeoutMs, 3000, 500, 10000);
  const leaveFixtures = args.leaveFixtures === true;
  const runId = String(args.runId || foundry.utils.randomID(8));
  const beforeCounts = getWorldDocumentCounts();
  const results = [];
  const createdPlaylistIds = [];

  await stopAllPlaylists(api);

  const preflight = await collectSyncDiagnostics(api, { timeoutMs, playlistIds: [] });
  const responderResult = buildResponderScenarioResult(preflight, expectedNonGmCount);
  if (scenarioNames.includes("responder")) results.push(responderResult);

  if (responderResult.failed > 0) {
    const skipped = scenarioNames.filter((scenario) => scenario !== "responder");
    if (skipped.length > 0) {
      results.push(finalizeSyncScenario("clientSyncPreflight", null, [{
        name: `missing active non-GM client(s); skipped ${skipped.join(", ")}`,
        pass: false,
        expectedNonGmCount,
        actualNonGmCount: preflight.nonGmClients.length,
      }], { skippedScenarios: skipped }));
    }

    const cleanup = leaveFixtures
      ? { skipped: true, playlistsDeleted: 0, foldersDeleted: 0 }
      : await cleanupPlaybackFixtures(api, { runId, stopFirst: true });
    return finalizeClientSyncRun({
      runId,
      scenarioNames,
      expectedNonGmCount,
      timeoutMs,
      beforeCounts,
      results,
      createdPlaylistIds,
      cleanup,
      preflight,
    });
  }

  for (const scenario of scenarioNames) {
    if (scenario === "responder") continue;
    const result = await runClientSyncScenario(api, scenario, runId, { timeoutMs });
    results.push(result);
    if (result.playlistId) createdPlaylistIds.push(result.playlistId);
    await stopAllPlaylists(api);
  }

  let cleanup = { skipped: true, playlistsDeleted: 0, foldersDeleted: 0 };
  if (!leaveFixtures) {
    cleanup = await cleanupPlaybackFixtures(api, { runId, stopFirst: true });
  }

  return finalizeClientSyncRun({
    runId,
    scenarioNames,
    expectedNonGmCount,
    timeoutMs,
    beforeCounts,
    results,
    createdPlaylistIds,
    cleanup,
    preflight,
  });
}

function finalizeClientSyncRun({
  runId,
  scenarioNames,
  expectedNonGmCount,
  timeoutMs,
  beforeCounts,
  results,
  createdPlaylistIds,
  cleanup,
  preflight,
}) {
  const failed = results.filter((result) => !result.success);
  const inconclusive = results.reduce((total, result) => total + Number(result.inconclusive ?? 0), 0);
  return {
    success: failed.length === 0,
    runId,
    scenarios: scenarioNames,
    expectedNonGmCount,
    timeoutMs,
    passed: results.length - failed.length,
    failed: failed.length,
    inconclusive,
    results,
    createdPlaylistIds,
    cleanup,
    preflight: summarizeCollection(preflight),
    documentCounts: {
      before: beforeCounts,
      after: getWorldDocumentCounts(),
    },
  };
}

async function runClientSyncScenario(api, scenario, runId, { timeoutMs }) {
  const tests = [];
  let playlist = null;

  try {
    if (scenario === "basicPlaybackSync") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        sounds: [
          fixtureSound("Client Sync Basic A", { runId, scenario, durationSec: 1.2, frequency: 330 }),
          fixtureSound("Client Sync Basic B", { runId, scenario, durationSec: 1.2, frequency: 440 }),
          fixtureSound("Client Sync Basic C", { runId, scenario, durationSec: 1.2, frequency: 550 }),
        ],
      });

      await playlist.playAll();
      const first = await waitForPlayingSound(playlist);
      record(tests, "GM playAll starts a document sound", () => !!first);
      await wait(400);
      await compareClientDocumentState(api, tests, playlist, first?.id, {
        label: "playAll",
        timeoutMs,
        expectPlaylistPlaying: true,
        expectLiveMedia: true,
      });

      await playlist.playNext();
      const next = await waitForPlayingSound(playlist, { notSoundId: first?.id });
      record(tests, "GM advance changes active document sound", () => !!next && next.id !== first?.id);
      await wait(400);
      await compareClientDocumentState(api, tests, playlist, next?.id, {
        label: "advance",
        timeoutMs,
        expectPlaylistPlaying: true,
        expectLiveMedia: true,
      });

      await playlist.stopAll();
      await wait(350);
      await compareClientDocumentState(api, tests, playlist, null, {
        label: "stopAll",
        timeoutMs,
        expectPlaylistPlaying: false,
        expectLiveMedia: false,
      });
    } else if (scenario === "crossfadeReplication") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        fade: 1,
        flags: {
          crossfade: true,
          useCustomAutoFade: true,
          customAutoFadeMs: 500,
        },
        sounds: [
          fixtureSound("Client Sync Crossfade A", { runId, scenario, durationSec: 1.5, frequency: 330 }),
          fixtureSound("Client Sync Crossfade B", { runId, scenario, durationSec: 1.5, frequency: 440 }),
        ],
      });

      const [first, second] = Array.from(playlist.sounds);
      await playlist.playSound(first);
      const ready = await waitForPlayingSound(playlist, {
        soundId: first.id,
        requireMedia: true,
        timeoutMs: 2500,
      });
      if (!ready) {
        recordInconclusive(tests, "GM live media unavailable; crossfade replication not attempted");
      } else {
        await api.crossfadeToNext(playlist, first);
        await wait(120);
        await compareClientDocumentState(api, tests, playlist, second?.id, {
          label: "crossfade in-flight",
          timeoutMs,
          expectPlaylistPlaying: true,
          expectLiveMedia: true,
          allowAnyLiveMedia: true,
          expectedSequenceKey: `pl:${playlist.id}`,
        });
        await wait(650);
        await compareClientDocumentState(api, tests, playlist, second?.id, {
          label: "crossfade completion",
          timeoutMs,
          expectPlaylistPlaying: true,
          expectLiveMedia: true,
          expectedSequenceKey: `pl:${playlist.id}`,
        });
      }
    } else if (scenario === "stopTransitionReplication") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        fade: 1,
        sounds: [
          fixtureSound("Client Sync Stop A", { runId, scenario, durationSec: 1.2, frequency: 330 }),
          fixtureSound("Client Sync Stop B", { runId, scenario, durationSec: 1.2, frequency: 440 }),
        ],
      });

      await playlist.playAll();
      await waitForPlayingSound(playlist);
      await wait(300);
      await playlist.stopAll();
      await wait(450);
      await compareClientDocumentState(api, tests, playlist, null, {
        label: "stop transition",
        timeoutMs,
        expectPlaylistPlaying: false,
        expectLiveMedia: false,
        expectedSequenceKey: `pl:${playlist.id}`,
      });
    } else if (scenario === "loopBreakReplication" || scenario === "loopDisableReplication") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        sounds: [
          fixtureSound("Client Sync Looping Sound", {
            runId,
            scenario,
            durationSec: 1.4,
            frequency: 440,
            flags: {
              loopWithin: {
                enabled: true,
                active: true,
                startFromBeginning: true,
                segments: [
                  { start: "00:00.100", end: "00:00.450", crossfadeMs: 80, loopCount: 0 },
                ],
              },
            },
          }),
        ],
      });

      const [sound] = Array.from(playlist.sounds);
      await playlist.playSound(sound);
      await waitForPlayingSound(playlist, { soundId: sound.id });
      api.startLoop(sound);
      const loopReady = await waitForCondition(() => api.isLooping(sound), { timeoutMs: 1800 });
      record(tests, "GM loop state appears", () => loopReady === true);

      if (!loopReady) {
        recordInconclusive(tests, `GM loop unavailable; ${scenario} replication not attempted`);
      } else if (scenario === "loopBreakReplication") {
        await api.breakLoop(sound);
        await wait(350);
        await compareClientDocumentState(api, tests, playlist, sound.id, {
          label: "loop break",
          timeoutMs,
          expectPlaylistPlaying: true,
          expectLiveMedia: true,
          expectedSequenceKey: `snd:${sound.id}`,
        });
      } else {
        try {
          await disableAllLoopsWithin(sound);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/audio is unlocked|_createSound/i.test(message)) {
            recordInconclusive(tests, "GM audio unavailable; loop disable replication not attempted", message);
          } else {
            throw err;
          }
        }
        if (!tests.some((test) => test.inconclusive && test.name.includes("loop disable replication not attempted"))) {
          await wait(350);
          await compareClientDocumentState(api, tests, playlist, sound.id, {
            label: "loop disable",
            timeoutMs,
            expectPlaylistPlaying: true,
            expectLiveMedia: true,
            expectedSequenceKey: `snd:${sound.id}`,
          });
        }
      }
    } else if (scenario === "loopSegmentSkipReplication") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        sounds: [
          fixtureSound("Client Sync Segment Skip Sound", {
            runId,
            scenario,
            durationSec: 1.8,
            frequency: 520,
            flags: {
              loopWithin: {
                enabled: true,
                active: true,
                startFromBeginning: true,
                segments: [
                  { start: "00:00.100", end: "00:00.450", crossfadeMs: 80, loopCount: 0 },
                  { start: "00:00.700", end: "00:01.050", crossfadeMs: 80, loopCount: 0 },
                ],
              },
            },
          }),
        ],
      });

      const [sound] = Array.from(playlist.sounds);
      await playlist.playSound(sound);
      await waitForPlayingSound(playlist, { soundId: sound.id });
      api.startLoop(sound);
      const loopReady = await waitForCondition(
        () => api.getCurrentLoopSegment(sound)?.start === "00:00.100",
        { timeoutMs: 1800 }
      );
      record(tests, "GM first segment is active", () => loopReady === true);

      if (!loopReady) {
        recordInconclusive(tests, "GM segment loop unavailable; segment skip replication not attempted");
      } else {
        await nextSegmentWithin(sound);
        const gmSkipped = await waitForCondition(
          () => api.getCurrentLoopSegment(sound)?.start === "00:00.700",
          { timeoutMs: 1800 }
        );
        record(tests, "GM skips to second segment", () => gmSkipped === true);

        await wait(350);
        const collection = await collectSyncDiagnostics(api, { timeoutMs, playlistIds: [playlist.id] });
        const gmLoop = findLoopSnapshot(collection.gmClients[0], playlist.id, sound.id);
        for (const client of collection.nonGmClients) {
          const clientName = client.client?.userName ?? "Player";
          const clientLoop = findLoopSnapshot(client, playlist.id, sound.id);
          record(tests, `${clientName} receives segment skip sequence`, () =>
            hasClientSequence(client, `snd:${sound.id}`)
          );
          record(tests, `${clientName} active segment matches GM`, () =>
            !!gmLoop?.activeSegment &&
            !!clientLoop?.activeSegment &&
            clientLoop.activeSegment.start === gmLoop.activeSegment.start
          );
        }
      }
    } else if (scenario === "soundscapeStartStopSync") {
      const fixture = await createSoundscapeSyncFixture(runId, scenario);
      playlist = fixture.playlist;
      const { proc } = fixture;

      await playlist.playAll();
      await wait(700);
      const started = await collectSyncDiagnostics(api, { timeoutMs, playlistIds: [playlist.id] });
      const gmSnapshot = findSoundscapeSnapshot(started.gmClients[0], playlist.id);
      record(tests, "GM soundscape engine starts", () =>
        gmSnapshot?.active === true &&
        gmSnapshot.syncMode === "authority" &&
        gmSnapshot.armedOneShotIds?.includes(proc.id)
      );

      for (const client of started.nonGmClients) {
        const clientName = client.client?.userName ?? "Player";
        const snapshot = findSoundscapeSnapshot(client, playlist.id);
        record(tests, `${clientName} soundscape engine starts in synced mode`, () =>
          snapshot?.active === true &&
          snapshot.syncMode === "synced" &&
          snapshot.armedOneShots === 0
        );
      }

      api.stopSoundscape(playlist, { stopBeds: true });
      await playlist.stopAll();
      await wait(500);
      const stopped = await collectSyncDiagnostics(api, { timeoutMs, playlistIds: [playlist.id] });
      for (const client of stopped.clients) {
        const clientName = client.client?.userName ?? "Client";
        const snapshot = findSoundscapeSnapshot(client, playlist.id);
        record(tests, `${clientName} soundscape engine stops`, () =>
          !snapshot || snapshot.active === false
        );
      }
    } else if (scenario === "soundscapeBedOnlySync") {
      const fixture = await createSoundscapeSyncFixture(runId, scenario);
      playlist = fixture.playlist;
      const { bed, proc } = fixture;

      await playlist.update({
        playing: true,
        sounds: [
          { _id: bed.id, playing: true, pausedTime: null },
          { _id: proc.id, playing: false, pausedTime: null },
        ],
      });
      await api.startSoundscape(playlist);
      await wait(700);

      const collection = await collectSyncDiagnostics(api, { timeoutMs, playlistIds: [playlist.id] });
      for (const client of collection.clients) {
        const clientName = client.client?.userName ?? "Client";
        const snapshot = findSoundscapeSnapshot(client, playlist.id);
        const playlistSnapshot = findSnapshotPlaylist(client, playlist.id);
        record(tests, `${clientName} bed-only engine is active`, () =>
          snapshot?.active === true &&
          snapshot.bedSoundIds?.includes(bed.id) &&
          snapshot.armedOneShots === 0 &&
          snapshot.activeOneShots === 0 &&
          snapshot.pendingOneShots === 0
        );
        record(tests, `${clientName} bed-only document state matches`, () => {
          const activeIds = getActiveSnapshotSoundIds(playlistSnapshot);
          return sameMembers(activeIds, [bed.id]);
        });
      }
    } else if (scenario === "soundscapeProceduralFireSync") {
      const fixture = await createSoundscapeSyncFixture(runId, scenario);
      playlist = fixture.playlist;
      const { proc } = fixture;

      await playlist.playAll();
      const engine = await waitForSoundscapeEngine(playlist, { timeoutMs: 2500 });
      await wait(350);
      const fired = proc ? await engine?.fireOneShotNow?.(proc.id) : false;
      const gmEvent = [...(engine?.getDiagnostics?.()?.recentSyncedEvents ?? [])]
        .reverse()
        .find((event) => event.soundId === proc?.id && event.status === "played");
      record(tests, "GM emits and plays synced procedural fire", () =>
        fired === true && !!gmEvent?.eventId
      );

      await wait(250);
      const collection = await collectSyncDiagnostics(api, { timeoutMs, playlistIds: [playlist.id] });
      for (const client of collection.nonGmClients) {
        const clientName = client.client?.userName ?? "Player";
        const snapshot = findSoundscapeSnapshot(client, playlist.id);
        const event = findSoundscapeEvent(snapshot, gmEvent?.eventId);
        const missed = findMissedSoundscapeEvent(snapshot, gmEvent?.eventId);
        if (!event) {
          const readiness = getClientAudioReadiness(client);
          if (!readiness.ready || ["audio-locked", "no-audio", "no-audio-context", "audio-context-closed", "late", "late-after-wait", "load-failed", "play-failed"].includes(missed?.reason)) {
            recordInconclusive(tests, `${clientName} synced procedural fire playback inconclusive`, missed?.reason ?? readiness.reason);
          } else {
            tests.push({
              name: `${clientName} receives synced procedural fire event`,
              pass: false,
              eventId: gmEvent?.eventId,
              missed,
              snapshot,
            });
          }
          continue;
        }

        record(tests, `${clientName} receives same fire recipe`, () =>
          event.eventId === gmEvent.eventId &&
          event.soundId === gmEvent.soundId &&
          event.seq === gmEvent.seq &&
          approximately(event.panValue, gmEvent.panValue, 0.0001) &&
          approximately(event.varianceFactor, gmEvent.varianceFactor, 0.0001)
        );
        record(tests, `${clientName} reports active procedural count`, () =>
          getSnapshotCount(snapshot, "activeOneShotCounts", proc.id) >= 1 ||
          event.status === "played"
        );
      }
    } else if (scenario === "soundscapeProceduralArmDisarmSync") {
      const fixture = await createSoundscapeSyncFixture(runId, scenario);
      playlist = fixture.playlist;
      const { bed, proc } = fixture;

      await playlist.update({
        playing: true,
        sounds: [
          { _id: bed.id, playing: true, pausedTime: null },
          { _id: proc.id, playing: false, pausedTime: null },
        ],
      });
      await api.startSoundscape(playlist);
      await wait(400);
      await setSoundPlaying(playlist, proc, true);
      await wait(700);

      const armed = await collectSyncDiagnostics(api, { timeoutMs, playlistIds: [playlist.id] });
      const gmSnapshot = findSoundscapeSnapshot(armed.gmClients[0], playlist.id);
      record(tests, "GM arms toggled procedural", () =>
        gmSnapshot?.armedOneShotIds?.includes(proc.id)
      );
      for (const client of armed.nonGmClients) {
        const clientName = client.client?.userName ?? "Player";
        const snapshot = findSoundscapeSnapshot(client, playlist.id);
        const playlistSnapshot = findSnapshotPlaylist(client, playlist.id);
        const activeIds = getActiveSnapshotSoundIds(playlistSnapshot);
        record(tests, `${clientName} sees procedural document active without local timer`, () =>
          activeIds.includes(proc.id) &&
          snapshot?.syncMode === "synced" &&
          !snapshot.armedOneShotIds?.includes(proc.id)
        );
      }

      await setSoundPlaying(playlist, proc, false);
      await wait(700);
      const disarmed = await collectSyncDiagnostics(api, { timeoutMs, playlistIds: [playlist.id] });
      for (const client of disarmed.clients) {
        const clientName = client.client?.userName ?? "Client";
        const snapshot = findSoundscapeSnapshot(client, playlist.id);
        record(tests, `${clientName} clears procedural runtime state`, () =>
          !snapshot?.armedOneShotIds?.includes(proc.id) &&
          getSnapshotCount(snapshot, "activeOneShotCounts", proc.id) === 0 &&
          getSnapshotCount(snapshot, "pendingOneShotCounts", proc.id) === 0
        );
      }
    } else if (scenario === "soundscapeClientOptOut") {
      const preflight = await collectSyncDiagnostics(api, { timeoutMs, playlistIds: [] });
      const target = preflight.nonGmClients[0] ?? null;
      const targetUserId = target?.client?.userId ?? null;
      const originalValue = target?.soundscapeProceduralSyncEnabled !== false;
      record(tests, "non-GM target is available for opt-out", () => !!targetUserId);

      let changed = [];
      if (targetUserId) {
        changed = await setRemoteClientSettingForDiagnostics({
          targetUserId,
          key: "soundscapeProceduralSyncEnabled",
          value: false,
          timeoutMs,
        });
      }
      record(tests, "target client accepts procedural sync opt-out", () =>
        changed.some((response) => response.success === true)
      );

      try {
        const fixture = await createSoundscapeSyncFixture(runId, scenario);
        playlist = fixture.playlist;
        const { proc } = fixture;

        await playlist.playAll();
        const engine = await waitForSoundscapeEngine(playlist, { timeoutMs: 2500 });
        await wait(700);
        const started = await collectSyncDiagnostics(api, { timeoutMs, playlistIds: [playlist.id] });
        const optedOut = started.nonGmClients.find((client) => client.client?.userId === targetUserId);
        const optedOutSnapshot = findSoundscapeSnapshot(optedOut, playlist.id);
        record(tests, "opted-out client reports local sync mode", () =>
          optedOutSnapshot?.soundscapeSyncEnabled === false &&
          optedOutSnapshot.syncMode === "local" &&
          optedOutSnapshot.armedOneShotIds?.includes(proc.id)
        );

        const fired = proc ? await engine?.fireOneShotNow?.(proc.id) : false;
        const gmEvent = [...(engine?.getDiagnostics?.()?.recentSyncedEvents ?? [])]
          .reverse()
          .find((event) => event.soundId === proc?.id && event.status === "played");
        record(tests, "GM still emits synced fire while target is opted out", () =>
          fired === true && !!gmEvent?.eventId
        );

        await wait(250);
        const afterFire = await collectSyncDiagnostics(api, { timeoutMs, playlistIds: [playlist.id] });
        const targetAfterFire = afterFire.nonGmClients.find((client) => client.client?.userId === targetUserId);
        const afterSnapshot = findSoundscapeSnapshot(targetAfterFire, playlist.id);
        record(tests, "opted-out client ignores synced fire event", () =>
          !!afterSnapshot &&
          !findSoundscapeEvent(afterSnapshot, gmEvent?.eventId) &&
          !findMissedSoundscapeEvent(afterSnapshot, gmEvent?.eventId)
        );
      } finally {
        if (targetUserId) {
          await setRemoteClientSettingForDiagnostics({
            targetUserId,
            key: "soundscapeProceduralSyncEnabled",
            value: originalValue,
            timeoutMs,
          });
        }
      }
    } else if (scenario === "soundscapeCleanupSync") {
      const fixture = await createSoundscapeSyncFixture(runId, scenario);
      playlist = fixture.playlist;

      await playlist.playAll();
      await wait(700);
      const playlistId = playlist.id;
      await api.cleanup(playlist, {
        cleanSilence: true,
        cleanCrossfade: true,
        cleanLoopers: true,
        cleanSoundscape: true,
        allowFadeOut: false,
      });
      await playlist.stopAll();
      await wait(350);
      await playlist.delete();
      await wait(500);

      const collection = await collectSyncDiagnostics(api, { timeoutMs, playlistIds: [playlistId] });
      for (const client of collection.clients) {
        const clientName = client.client?.userName ?? "Client";
        record(tests, `${clientName} fixture playlist document is gone`, () =>
          !findSnapshotPlaylist(client, playlistId)
        );
        record(tests, `${clientName} fixture soundscape runtime is gone`, () =>
          !findSoundscapeSnapshot(client, playlistId) &&
          getLiveSoundsForPlaylist(client, playlistId).length === 0
        );
      }
    } else {
      throw new Error(`Unsupported client sync scenario "${scenario}".`);
    }
  } catch (err) {
    tests.push({
      name: `${scenario} scenario threw`,
      pass: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return finalizeSyncScenario(scenario, playlist, tests);
}

async function runScenario(api, scenario, runId) {
  const tests = [];
  let playlist = null;

  try {
    if (scenario === "basicPlayback") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        sounds: [
          fixtureSound("Basic A", { runId, scenario, durationSec: 0.9, frequency: 330 }),
          fixtureSound("Basic B", { runId, scenario, durationSec: 0.9, frequency: 440 }),
          fixtureSound("Basic C", { runId, scenario, durationSec: 0.9, frequency: 550 }),
        ],
      });
      await playlist.playAll();
      const first = await waitForPlayingSound(playlist);
      record(tests, "playAll starts one sound", () => !!first);
      await playlist.playNext();
      const next = await waitForPlayingSound(playlist, { notSoundId: first?.id });
      record(tests, "advance changes active sound", () => !!next && next.id !== first?.id);
      await playlist.stopAll();
      await wait(200);
      record(tests, "stopAll stops playlist", () => !playlist.playing && !getPlayingSound(playlist));
    } else if (scenario === "crossfade") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        fade: 1,
        flags: {
          crossfade: true,
          useCustomAutoFade: true,
          customAutoFadeMs: 150,
        },
        sounds: [
          fixtureSound("Crossfade A", { runId, scenario, durationSec: 1.2, frequency: 330 }),
          fixtureSound("Crossfade B", { runId, scenario, durationSec: 1.2, frequency: 440 }),
        ],
      });
      const [first] = Array.from(playlist.sounds);
      const metricBefore = Number(api.getMetrics()?.crossfades?.total ?? 0);
      await playlist.playSound(first);
      const ready = await waitForPlayingSound(playlist, { soundId: first.id, requireMedia: true });
      record(tests, "crossfade source media starts", () => !!ready);
      if (ready) await api.crossfadeToNext(playlist, first);
      await wait(450);
      const active = getPlayingSound(playlist);
      const metricAfter = Number(api.getMetrics()?.crossfades?.total ?? 0);
      record(tests, "crossfade advances to another sound", () => !!active && active.id !== first.id);
      record(tests, "crossfade metric increments", () => metricAfter > metricBefore);
      record(tests, "crossfade runtime state clears", () => !State.isPlaylistCrossfading(playlist));
    } else if (scenario === "silence") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        flags: {
          silenceEnabled: true,
          silenceMode: "static",
          silenceDuration: 250,
        },
        sounds: [
          fixtureSound("Silence Source", { runId, scenario, durationSec: 0.8, frequency: 330 }),
          fixtureSound("Silence Next", { runId, scenario, durationSec: 0.8, frequency: 440 }),
        ],
      });
      const [source] = Array.from(playlist.sounds);
      await playlist.playSound(source);
      await waitForPlayingSound(playlist, { soundId: source.id });
      const silencePromise = Silence.playSilence(playlist, source);
      await wait(100);
      record(tests, "silent gap state appears", () => State.hasSilenceState(playlist));
      record(tests, "silent gap document created", () => getSilenceGaps(playlist).length === 1);
      await silencePromise;
      await wait(350);
      record(tests, "silent gap state clears", () => !State.hasSilenceState(playlist));
      record(tests, "silent gap document removed", () => getSilenceGaps(playlist).length === 0);
    } else if (scenario === "loopWithin") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        sounds: [
          fixtureSound("Looping Sound", {
            runId,
            scenario,
            durationSec: 1.1,
            frequency: 440,
            flags: {
              loopWithin: {
                enabled: true,
                active: true,
                startFromBeginning: true,
                segments: [
                  { start: "00:00.100", end: "00:00.350", crossfadeMs: 50, loopCount: 0 },
                ],
              },
            },
          }),
        ],
      });
      const [sound] = Array.from(playlist.sounds);
      await playlist.playSound(sound);
      await waitForPlayingSound(playlist, { soundId: sound.id });
      api.startLoop(sound);
      await wait(150);
      record(tests, "loop state appears", () => api.isLooping(sound));
      await api.breakLoop(sound);
      await api.cleanup(playlist, {
        cleanSilence: true,
        cleanCrossfade: true,
        cleanLoopers: true,
        cleanSoundscape: true,
        allowFadeOut: false,
      });
      await wait(150);
      record(tests, "loop state clears after cleanup", () => !api.isLooping(sound));

      playlist = await createFixturePlaylist(runId, `${scenario}-retire`, {
        mode: playlistMode("SEQUENTIAL", 1),
        sounds: [
          fixtureSound("Looping Sound Retires", {
            runId,
            scenario,
            durationSec: 1.2,
            frequency: 550,
            flags: {
              loopWithin: {
                enabled: true,
                active: true,
                startFromBeginning: true,
                segments: [
                  { start: "00:00.100", end: "00:00.350", crossfadeMs: 50, loopCount: 1 },
                ],
              },
            },
          }),
        ],
      });
      const [retireSound] = Array.from(playlist.sounds);
      await playlist.playSound(retireSound);
      await waitForPlayingSound(playlist, { soundId: retireSound.id });
      api.startLoop(retireSound);
      const retireStarted = await waitForCondition(() => api.isLooping(retireSound), { timeoutMs: 1200 });
      record(tests, "finite loop state appears", () => retireStarted === true);
      const retiredCleanly = await waitForCondition(
        () => !api.isLooping(retireSound) && !State.getActiveLooper(retireSound),
        { timeoutMs: 1800 }
      );
      record(tests, "finite loop retirement clears active looper state", () => retiredCleanly === true);
      record(tests, "retired looper is absent from inspection", () =>
        !api.inspectPlaylist(playlist).features.loops
      );
    } else if (scenario === "soundscape") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("DISABLED", -1),
        fade: 1,
        flags: {
          soundscapeMode: true,
          soundscapeMaxPolyphony: 2,
        },
        sounds: [
          fixtureSound("Soundscape Bed", {
            runId,
            scenario,
            durationSec: 1.2,
            frequency: 220,
            repeat: true,
          }),
          fixtureSound("Soundscape Procedural", {
            runId,
            scenario,
            durationSec: 0.45,
            frequency: 660,
            flags: {
              isProcedural: true,
              minDelay: 0,
              maxDelay: 0,
              timingMode: "fixed",
              initialFireMode: "immediate",
              playChance: 100,
            },
          }),
        ],
      });
      await playlist.playAll();
      await wait(500);
      const engine = State.getSoundscapeEngine(playlist);
      const diagnostics = engine?.getDiagnostics?.() ?? null;
      record(tests, "soundscape engine starts", () => api.isSoundscapeActive(playlist));
      record(tests, "soundscape diagnostics are populated", () =>
        !!diagnostics && diagnostics.active === true && diagnostics.bedCount >= 1
      );
      api.stopSoundscape(playlist, { stopBeds: true });
      await playlist.stopAll();
      await wait(200);
      record(tests, "soundscape engine stops", () => !api.isSoundscapeActive(playlist));
    } else if (scenario === "soundscapeAdvanced") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("DISABLED", -1),
        fade: 1,
        flags: {
          soundscapeMode: true,
          soundscapeMaxPolyphony: 1,
          soundscapePlayChanceScaling: "scaled",
          soundscapeDefaults: {
            minDelay: 2,
            maxDelay: 4,
            timingMode: "fixed",
            initialFireMode: "normal",
            volumeVariance: 0.25,
            playChance: 80,
            randomPan: true,
          },
          crossfade: true,
          silenceEnabled: true,
          silenceDuration: 200,
        },
        sounds: [
          fixtureSound("Soundscape Bed Advanced", {
            runId,
            scenario,
            durationSec: 1.5,
            frequency: 220,
            repeat: true,
          }),
          fixtureSound("Soundscape Procedural A", {
            runId,
            scenario,
            durationSec: 1.2,
            frequency: 660,
            flags: {
              isProcedural: true,
              minDelay: 10,
              maxDelay: 10,
              timingMode: "fixed",
              initialFireMode: "normal",
              playChance: 100,
              randomPan: true,
            },
          }),
          fixtureSound("Soundscape Procedural B", {
            runId,
            scenario,
            durationSec: 1.2,
            frequency: 880,
            flags: {
              isProcedural: true,
              minDelay: 10,
              maxDelay: 10,
              timingMode: "fixed",
              initialFireMode: "normal",
              playChance: 100,
            },
          }),
          fixtureSound("Soundscape Defaults Procedural", {
            runId,
            scenario,
            durationSec: 0.75,
            frequency: 440,
            flags: {
              isProcedural: true,
            },
          }),
          fixtureSound("Soundscape Gap Advanced", {
            runId,
            scenario,
            durationSec: 0.4,
            frequency: 330,
            flags: { isSilenceGap: true },
          }),
        ],
      });

      const sounds = Array.from(playlist.sounds ?? []);
      const bed = sounds.find((sound) => sound.name === "Soundscape Bed Advanced");
      const procA = sounds.find((sound) => sound.name === "Soundscape Procedural A");
      const procB = sounds.find((sound) => sound.name === "Soundscape Procedural B");
      const defaultProc = sounds.find((sound) => sound.name === "Soundscape Defaults Procedural");
      const gap = sounds.find((sound) => sound.name === "Soundscape Gap Advanced");

      const mode = Flags.getPlaybackMode(playlist);
      record(tests, "soundscape mode suppresses crossfade and silence", () =>
        mode.soundscape === true &&
        mode.crossfade === false &&
        mode.silence === false &&
        mode.effective === "soundscape"
      );
      record(tests, "soundscape defaults inherit to procedural sounds", () =>
        !!defaultProc &&
        Flags.resolveProceduralField(defaultProc, "minDelay") === 2 &&
        Flags.resolveProceduralField(defaultProc, "maxDelay") === 4 &&
        Flags.resolveProceduralField(defaultProc, "timingMode") === "fixed" &&
        Flags.resolveProceduralField(defaultProc, "initialFireMode") === "normal" &&
        Flags.resolveProceduralField(defaultProc, "playChance") === 80 &&
        Flags.resolveProceduralField(defaultProc, "randomPan") === true
      );

      await playlist.update({
        playing: true,
        sounds: sounds.map((sound) => ({
          _id: sound.id,
          playing: sound.id === bed?.id,
          pausedTime: null,
        })),
      });
      await api.startSoundscape(playlist);
      const bedOnlyEngine = await waitForSoundscapeEngine(playlist);
      const bedOnlyDiagnostics = bedOnlyEngine?.getDiagnostics?.() ?? null;
      record(tests, "soundscape engine starts from bed-only state", () =>
        !!bedOnlyEngine &&
        api.isSoundscapeActive(playlist) &&
        bedOnlyDiagnostics?.bedCount === 1 &&
        bedOnlyDiagnostics.armedOneShots === 0 &&
        bedOnlyDiagnostics.activeOneShots === 0 &&
        bedOnlyDiagnostics.pendingOneShots === 0
      );
      record(tests, "soundscape gap is not activated", () => !!gap && gap.playing === false);

      await setSoundPlaying(playlist, procA, true);
      const procAArmed = await waitForCondition(
        () => !!bedOnlyEngine?.oneShotTimers?.has?.(procA?.id),
        { timeoutMs: 1200 }
      );
      record(tests, "procedural sound arms when toggled on", () => procAArmed === true);

      const firedA = procA ? await bedOnlyEngine.fireOneShotNow(procA.id) : false;
      const activeSoundA = getActiveProceduralSound(bedOnlyEngine, procA?.id);
      record(tests, "manual procedural fire starts one-shot", () =>
        firedA === true &&
        !!activeSoundA?.playing &&
        bedOnlyEngine.getActiveOneShotCount(procA.id) === 1
      );
      record(tests, "random panner attaches to procedural one-shot", () =>
        hasStereoPanner(activeSoundA)
      );
      record(tests, "polyphony reports occupied slot", () =>
        bedOnlyEngine.getPolyphony?.().active === 1 &&
        bedOnlyEngine.getPolyphony?.().max === 1
      );

      await setSoundPlaying(playlist, procB, true);
      await waitForCondition(
        () => !!bedOnlyEngine?.oneShotTimers?.has?.(procB?.id),
        { timeoutMs: 1200 }
      );
      const firedB = procB ? await bedOnlyEngine.fireOneShotNow(procB.id) : false;
      record(tests, "polyphony cap blocks second concurrent one-shot", () =>
        firedB === false &&
        bedOnlyEngine.getPolyphony?.().active <= 1 &&
        bedOnlyEngine.getActiveOneShotCount(procB?.id) === 0
      );
      record(tests, "polyphony skip re-arms blocked procedural", () =>
        !!procB && bedOnlyEngine.oneShotTimers.has(procB.id)
      );

      await setSoundPlaying(playlist, procA, false);
      await waitForCondition(
        () =>
          !bedOnlyEngine.oneShotTimers.has(procA?.id) &&
          bedOnlyEngine.getActiveOneShotCount(procA?.id) === 0 &&
          bedOnlyEngine.getPendingOneShotCount(procA?.id) === 0,
        { timeoutMs: 1500 }
      );
      record(tests, "disarming procedural clears timer and active counts", () =>
        !bedOnlyEngine.oneShotTimers.has(procA?.id) &&
        bedOnlyEngine.getActiveOneShotCount(procA?.id) === 0 &&
        bedOnlyEngine.getPendingOneShotCount(procA?.id) === 0
      );
      record(tests, "disarming procedural detaches panner/stops sound", () =>
        !activeSoundA?.playing && !hasStereoPanner(activeSoundA)
      );

      api.stopSoundscape(playlist, { stopBeds: false });
      await wait(150);
      record(tests, "stopSoundscape can leave bed document playing", () =>
        !api.isSoundscapeActive(playlist) &&
        bed?.playing === true
      );

      await playlist.stopAll();
      await wait(250);
      record(tests, "playlist stopAll clears soundscape bed and procedurals", () =>
        !playlist.playing &&
        Array.from(playlist.sounds ?? []).every((sound) => !sound.playing)
      );
    } else if (scenario === "shufflePatterns") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SHUFFLE", 1),
        sounds: [
          fixtureSound("Shuffle A", { runId, scenario, frequency: 220 }),
          fixtureSound("Shuffle B", { runId, scenario, frequency: 330 }),
          fixtureSound("Shuffle C", { runId, scenario, frequency: 440 }),
          fixtureSound("Shuffle D", { runId, scenario, frequency: 550 }),
          fixtureSound("Shuffle Gap", {
            runId,
            scenario,
            frequency: 660,
            flags: { isSilenceGap: true },
          }),
        ],
      });

      const originalPattern = getGameSetting("shufflePattern", SHUFFLE_PATTERNS.FOUNDRY_DEFAULT);
      const patterns = [
        SHUFFLE_PATTERNS.EXHAUSTIVE,
        SHUFFLE_PATTERNS.WEIGHTED_RANDOM,
        SHUFFLE_PATTERNS.ROUND_ROBIN,
      ];

      try {
        for (const pattern of patterns) {
          await setGameSetting("shufflePattern", pattern);
          resetShufflePlaylist(playlist);

          const playableIds = getPlayableFixtureIds(playlist);
          const gap = Array.from(playlist.sounds ?? []).find((sound) => Flags.getSoundFlag(sound, "isSilenceGap"));
          const order = getPlaybackOrder(playlist);

          record(tests, `${pattern} order includes each playable track once`, () => hasSameMembers(order, playableIds));
          record(tests, `${pattern} order excludes silence gaps`, () => !!gap && !order.includes(gap.id));
          record(tests, `${pattern} cached order is stable`, () => sameOrder(order, getPlaybackOrder(playlist)));

          const initialState = State.getShuffleState(playlist);
          record(tests, `${pattern} state tracks active pattern`, () => initialState?.pattern === pattern);

          for (const soundId of order) {
            const sound = playlist.sounds.get(soundId);
            if (sound) AdvancedShuffle.markTrackPlayed(playlist, sound);
          }

          const completedState = State.getShuffleState(playlist);
          record(tests, `${pattern} clears played set after full cycle`, () =>
            completedState?.playedThisCycle instanceof Set && completedState.playedThisCycle.size === 0
          );
          record(tests, `${pattern} invalidates cached cycle after full cycle`, () =>
            Array.isArray(completedState?.currentCycle) && completedState.currentCycle.length === 0
          );

          const nextOrder = getPlaybackOrder(playlist);
          record(tests, `${pattern} regenerates a complete next cycle`, () => hasSameMembers(nextOrder, playableIds));

          if (gap) AdvancedShuffle.markTrackPlayed(playlist, gap);
          const afterGapState = State.getShuffleState(playlist);
          record(tests, `${pattern} ignores silence gaps for shuffle state`, () =>
            !afterGapState?.playedThisCycle?.has?.(gap.id)
          );

          if (pattern === SHUFFLE_PATTERNS.WEIGHTED_RANDOM) {
            record(tests, "weighted-random maintains bounded weights", () => {
              const weights = Array.from(afterGapState?.trackWeights?.entries?.() ?? []);
              return weights.length === playableIds.length &&
                weights.every(([id, value]) => playableIds.includes(id) && value >= 0.1 && value <= 1);
            });
          }

          if (pattern === SHUFFLE_PATTERNS.ROUND_ROBIN) {
            record(tests, "round-robin keeps balanced play counts after one cycle", () => {
              const counts = playableIds.map((id) => afterGapState?.roundRobinCounts?.get?.(id) ?? 0);
              return counts.length > 0 && counts.every((count) => count === 1);
            });
          }
        }
      } finally {
        await setGameSetting("shufflePattern", originalPattern);
        resetShufflePlaylist(playlist);
      }
    } else if (scenario === "customFades") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 0),
        fade: 1,
        sounds: [
          fixtureSound("Fade Logarithmic", { runId, scenario, frequency: 220 }),
          fixtureSound("Fade Linear", { runId, scenario, frequency: 330 }),
          fixtureSound("Fade S-Curve", { runId, scenario, frequency: 440 }),
          fixtureSound("Fade Steep", { runId, scenario, frequency: 550 }),
        ],
      });

      const originalFadeInCurve = getGameSetting("fadeInCurveType", "logarithmic");
      const originalFadeOutCurve = getGameSetting("fadeOutCurveType", "logarithmic");
      const curves = ["logarithmic", "linear", "s-curve", "steep"];
      const sounds = Array.from(playlist.sounds ?? []);

      record(tests, "audio context is unlocked for live fade tests", () => isAudioReady());

      try {
        for (let i = 0; i < curves.length; i += 1) {
          const curve = curves[i];
          const soundDoc = sounds[i];
          if (!soundDoc) {
            record(tests, `${curve} fixture sound exists`, () => false);
            continue;
          }

          await setGameSetting("fadeInCurveType", curve);
          await setGameSetting("fadeOutCurveType", curve);

          await api.playSoundWithFadeIn(soundDoc, 120);
          const started = await waitForPlayingSound(playlist, {
            soundId: soundDoc.id,
            requireMedia: true,
            timeoutMs: 2500,
          });
          const media = started?.sound ?? null;
          const fadeInToken = media ? State.getFadeToken(media) : null;

          record(tests, `${curve} fade-in media starts`, () => !!media?.playing);
          record(tests, `${curve} fade-in token uses selected curve`, () =>
            fadeInToken?.type === "fade-in" &&
            fadeInToken.curveType === curve &&
            fadeInToken.duration === 120 &&
            approximately(fadeInToken.targetVol, Number(soundDoc.volume ?? 0), 0.001)
          );

          await wait(220);
          record(tests, `${curve} fade-in token clears`, () => !media || !State.isSoundFading(media));
          record(tests, `${curve} fade-in reaches useful gain`, () =>
            !media || isGainAtLeast(media, Math.min(0.1, Number(soundDoc.volume ?? 0)))
          );

          const stopPromise = api.stopSoundWithFadeOut(soundDoc, 120);
          await wait(20);
          const fadeOutToken = media ? State.getFadeToken(media) : null;
          record(tests, `${curve} fade-out token uses selected curve`, () =>
            fadeOutToken?.type === "fade-out" &&
            fadeOutToken.curveType === curve &&
            fadeOutToken.duration === 120 &&
            fadeOutToken.targetVol === 0
          );

          await stopPromise;
          await wait(80);
          record(tests, `${curve} fade-out stops sound document`, () => !soundDoc.playing);
          record(tests, `${curve} fade-out token clears`, () => !media || !State.isSoundFading(media));
        }
      } finally {
        await setGameSetting("fadeInCurveType", originalFadeInCurve);
        await setGameSetting("fadeOutCurveType", originalFadeOutCurve);
      }
    } else {
      throw new Error(`Unsupported scenario "${scenario}".`);
    }
  } catch (err) {
    tests.push({
      name: `${scenario} scenario threw`,
      pass: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const failed = tests.filter((test) => !test.pass);
  return {
    scenario,
    success: failed.length === 0,
    passed: tests.length - failed.length,
    failed: failed.length,
    playlistId: playlist?.id ?? null,
    playlistName: playlist?.name ?? null,
    tests,
    snapshot: playlist ? summarizePlaylist(playlist) : null,
  };
}

async function collectSyncDiagnostics(api, { timeoutMs, playlistIds = null }) {
  const collection = await api.collectClientDiagnostics({ timeoutMs, includeSelf: true, playlistIds });
  const clients = Array.isArray(collection.clients) ? collection.clients : [];
  return {
    ...collection,
    clients,
    gmClients: clients.filter((client) => client.client?.isGM),
    nonGmClients: clients.filter((client) => !client.client?.isGM),
  };
}

async function setRemoteClientSettingForDiagnostics({ targetUserId, key, value, timeoutMs = 3000 } = {}) {
  const requestId = foundry.utils.randomID();
  const responses = [];
  const target = targetUserId ? String(targetUserId) : null;

  return new Promise((resolve) => {
    const channel = `module.${MODULE_ID}`;
    let timeout = null;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      game.socket?.off?.(channel, handler);
      resolve(responses);
    };
    const handler = (data = {}) => {
      if (data.action !== "diagnostics-client-setting-response") return;
      if (data.requestId !== requestId) return;
      if (target && String(data.userId ?? "") !== target) return;
      responses.push(data);
      cleanup();
    };

    game.socket?.on?.(channel, handler);
    game.socket?.emit?.(channel, {
      action: "diagnostics-client-setting-request",
      requestId,
      senderUserId: game.user?.id ?? null,
      targetUserId: target,
      key,
      value,
    });
    timeout = setTimeout(cleanup, Math.max(500, timeoutMs));
  });
}

function buildResponderScenarioResult(collection, expectedNonGmCount) {
  const tests = [];
  record(tests, "GM client responded", () => collection.gmClients.length > 0);
  record(tests, "expected non-GM client count responded", () =>
    collection.nonGmClients.length >= expectedNonGmCount
  );
  record(tests, "client response identities are unique", () => {
    const keys = collection.clients.map((client, index) =>
      client.client?.clientInstanceId || client.client?.socketId || `${client.client?.userId}:${index}`
    );
    return new Set(keys).size === keys.length;
  });
  record(tests, "client snapshots include document playback state", () =>
    collection.clients.every((client) => Array.isArray(client.playlistDocuments))
  );

  for (const test of tests) {
    if (test.name === "expected non-GM client count responded") {
      test.expectedNonGmCount = expectedNonGmCount;
      test.actualNonGmCount = collection.nonGmClients.length;
    }
  }

  return finalizeSyncScenario("responder", null, tests, {
    collection: summarizeCollection(collection),
  });
}

async function compareClientDocumentState(api, tests, playlist, expectedSoundId, {
  label,
  timeoutMs,
  expectPlaylistPlaying,
  expectLiveMedia,
  allowAnyLiveMedia = false,
  expectedSequenceKey = null,
} = {}) {
  const collection = await collectSyncDiagnostics(api, { timeoutMs, playlistIds: [playlist.id] });
  const gmClient = collection.gmClients[0] ?? null;
  const gmPlaylist = gmClient ? findSnapshotPlaylist(gmClient, playlist.id) : null;
  const gmActiveIds = getActiveSnapshotSoundIds(gmPlaylist);

  tests.push({
    name: `${label}: GM snapshot includes fixture playlist`,
    pass: Boolean(gmPlaylist),
    playlistId: playlist.id,
  });

  if (gmPlaylist) {
    tests.push({
      name: `${label}: GM document state matches expected playlist state`,
      pass: gmPlaylist.playing === expectPlaylistPlaying,
      expected: expectPlaylistPlaying,
      actual: gmPlaylist.playing,
    });
    tests.push({
      name: `${label}: GM active sound matches expected state`,
      pass: expectedSoundId
        ? gmActiveIds.includes(expectedSoundId)
        : gmActiveIds.length === 0,
      expectedSoundId,
      actualSoundIds: gmActiveIds,
    });
  }

  for (const client of collection.nonGmClients) {
    const clientName = client.client?.userName ?? client.client?.userId ?? "Player";
    const clientPlaylist = findSnapshotPlaylist(client, playlist.id);
    const activeIds = getActiveSnapshotSoundIds(clientPlaylist);

    tests.push({
      name: `${label}: ${clientName} snapshot includes fixture playlist`,
      pass: Boolean(clientPlaylist),
      playlistId: playlist.id,
    });
    if (!clientPlaylist) continue;

    tests.push({
      name: `${label}: ${clientName} document state matches GM`,
      pass: Boolean(gmPlaylist) &&
        clientPlaylist.playing === gmPlaylist.playing &&
        sameMembers(activeIds, gmActiveIds),
      gmPlaying: gmPlaylist?.playing ?? null,
      playerPlaying: clientPlaylist.playing,
      gmActiveIds,
      playerActiveIds: activeIds,
    });

    tests.push({
      name: `${label}: ${clientName} active sound matches expected state`,
      pass: expectedSoundId
        ? activeIds.includes(expectedSoundId)
        : activeIds.length === 0,
      expectedSoundId,
      actualSoundIds: activeIds,
    });

    if (expectedSequenceKey) {
      tests.push({
        name: `${label}: ${clientName} processed sequence ${expectedSequenceKey}`,
        pass: hasClientSequence(client, expectedSequenceKey),
        sequence: client.sequences?.[expectedSequenceKey] ?? null,
      });
    }

    recordClientLiveMediaAssertion(tests, client, playlist.id, expectedSoundId, {
      label: `${label}: ${clientName}`,
      expectLiveMedia,
      allowAnyLiveMedia,
    });
  }
}

function recordClientLiveMediaAssertion(tests, client, playlistId, expectedSoundId, {
  label,
  expectLiveMedia,
  allowAnyLiveMedia = false,
} = {}) {
  if (typeof expectLiveMedia !== "boolean") return;

  const readiness = getClientAudioReadiness(client);
  if (!readiness.ready) {
    recordInconclusive(tests, `${label} live media assertion inconclusive`, readiness.reason);
    return;
  }

  const liveSounds = getLiveSoundsForPlaylist(client, playlistId);
  const matchingLiveSound = expectedSoundId
    ? liveSounds.find((sound) => sound.soundId === expectedSoundId)
    : null;

  if (expectLiveMedia && !matchingLiveSound && liveSounds.length === 0) {
    recordInconclusive(tests, `${label} live media assertion inconclusive`, "no live media object for playlist");
    return;
  }

  if (expectLiveMedia && allowAnyLiveMedia && !matchingLiveSound && liveSounds.length > 0) {
    tests.push({
      name: `${label} transition live media is active`,
      pass: true,
      liveSoundIds: liveSounds.map((sound) => sound.soundId),
      expectedSoundId,
      acceptedAnyLiveMedia: true,
    });
    return;
  }

  tests.push({
    name: expectLiveMedia
      ? `${label} expected live media is playing`
      : `${label} no live media remains playing`,
    pass: expectLiveMedia
      ? Boolean(matchingLiveSound?.playing)
      : liveSounds.length === 0,
    liveSoundIds: liveSounds.map((sound) => sound.soundId),
    expectedSoundId,
  });
}

function getClientAudioReadiness(client) {
  const audio = client.audio ?? {};
  if (audio.locked === true) return { ready: false, reason: "audio locked" };
  if (audio.unlocked === false) return { ready: false, reason: "audio locked" };

  const contexts = audio.contexts ?? client.audioContexts ?? {};
  const hasRunningContext = Object.values(contexts).some((context) =>
    (typeof context === "string" ? context : context?.state) === "running"
  );
  if (!hasRunningContext) return { ready: false, reason: "no running audio context" };

  const mediaCount = Number(audio.soundDocumentsWithMedia ?? 0);
  const playingCount = Number(audio.playingMediaObjects ?? client.playingSounds?.length ?? 0);
  if (mediaCount <= 0 && playingCount <= 0) {
    return { ready: false, reason: "no live media objects" };
  }

  return { ready: true, reason: "audio ready" };
}

function findSnapshotPlaylist(client, playlistId) {
  return (client.playlistDocuments ?? client.documents?.playlists ?? [])
    .find((playlist) => playlist.id === playlistId) ?? null;
}

function findLoopSnapshot(client, playlistId, soundId) {
  const playlist = (client?.playlists ?? [])
    .find((entry) => entry.playlistId === playlistId) ?? null;
  return (playlist?.features?.loops ?? [])
    .find((loop) => loop.soundId === soundId) ?? null;
}

function findSoundscapeSnapshot(client, playlistId) {
  return (client.soundscapes ?? [])
    .find((snapshot) => snapshot.playlistId === playlistId) ?? null;
}

function findSoundscapeEvent(snapshot, eventId) {
  if (!eventId) return null;
  return (snapshot?.recentSyncedEvents ?? []).find((event) => event.eventId === eventId) ?? null;
}

function findMissedSoundscapeEvent(snapshot, eventId) {
  if (!eventId) return null;
  return (snapshot?.missedSyncedEvents ?? []).find((event) => event.eventId === eventId) ?? null;
}

function getSnapshotCount(snapshot, field, soundId) {
  if (!snapshot || !soundId) return 0;
  return Number(snapshot?.[field]?.[soundId] ?? 0);
}

function getActiveSnapshotSoundIds(playlist) {
  return (playlist?.sounds ?? [])
    .filter((sound) => sound.playing && !sound.isSilenceGap)
    .map((sound) => sound.id);
}

function getLiveSoundsForPlaylist(client, playlistId) {
  return (client.playingSounds ?? []).filter((sound) => sound.playlistId === playlistId);
}

function hasClientSequence(client, key) {
  return Number.isFinite(Number(client.sequences?.[key]?.seq));
}

function recordInconclusive(tests, name, reason = "precondition unavailable") {
  tests.push({
    name,
    pass: null,
    inconclusive: true,
    reason,
  });
}

function finalizeSyncScenario(scenario, playlist, tests, extra = {}) {
  const failed = tests.filter((test) => test.pass === false);
  const inconclusive = tests.filter((test) => test.inconclusive || test.pass === null);
  return {
    scenario,
    success: failed.length === 0,
    passed: tests.filter((test) => test.pass === true).length,
    failed: failed.length,
    inconclusive: inconclusive.length,
    playlistId: playlist?.id ?? null,
    playlistName: playlist?.name ?? null,
    tests,
    snapshot: playlist ? summarizePlaylist(playlist) : null,
    ...extra,
  };
}

function summarizeCollection(collection) {
  return {
    requestId: collection.requestId ?? null,
    responded: Number(collection.responded ?? collection.clients?.length ?? 0),
    activeUsers: collection.activeUsers ?? [],
    activeNonGmUsers: collection.activeNonGmUsers ?? [],
    missingActiveUsers: collection.missingActiveUsers ?? [],
    clientSummary: collection.clientSummary ?? [],
    gmClients: (collection.gmClients ?? []).map((client) => client.client?.userName ?? client.client?.userId ?? "GM"),
    nonGmClients: (collection.nonGmClients ?? []).map((client) => client.client?.userName ?? client.client?.userId ?? "Player"),
  };
}

async function cleanupPlaybackFixtures(api, args = {}) {
  const runId = typeof args.runId === "string" && args.runId.trim() ? args.runId.trim() : null;
  const stopFirst = args.stopFirst !== false;
  const playlists = getFixturePlaylists(runId);
  let playlistsDeleted = 0;
  let foldersDeleted = 0;

  if (stopFirst) {
    for (const playlist of playlists) {
      try {
        await api.cleanup(playlist, {
          cleanSilence: true,
          cleanCrossfade: true,
          cleanLoopers: true,
          cleanSoundscape: true,
          allowFadeOut: false,
        });
        if (playlist.playing) await playlist.stopAll();
      } catch (_) {
        // Keep cleanup best-effort and continue deleting other proven fixtures.
      }
    }
  }

  for (const playlist of playlists) {
    if (!isFixturePlaylist(playlist, runId)) continue;
    await playlist.delete();
    playlistsDeleted += 1;
  }

  const folder = getFixtureFolder();
  if (folder && isFixtureFolder(folder)) {
    const remaining = collectionToArray(game.playlists).filter((playlist) => playlist.folder?.id === folder.id);
    if (remaining.length === 0) {
      await folder.delete();
      foldersDeleted += 1;
    }
  }

  return {
    success: true,
    runId,
    playlistsDeleted,
    foldersDeleted,
  };
}

async function createFixturePlaylist(runId, scenario, { mode, fade = 1, flags = {}, sounds = [] } = {}) {
  const folder = await ensureFixtureFolder();
  const playlist = await Playlist.create({
    name: `${FIXTURE_PLAYLIST_PREFIX}${scenario} ${runId}`,
    mode,
    fade,
    folder: folder?.id ?? null,
    flags: {
      [MODULE_ID]: {
        ...flags,
        [FIXTURE_FLAG]: {
          kind: "playlist",
          runId,
          scenario,
          createdAt: Date.now(),
        },
      },
    },
  });

  if (!playlist) throw new Error(`Failed to create fixture playlist for ${scenario}.`);
  if (sounds.length > 0) {
    await playlist.createEmbeddedDocuments("PlaylistSound", sounds);
  }
  return playlist;
}

async function createSoundscapeSyncFixture(runId, scenario, {
  proceduralDelaySec = 10,
  proceduralPlaying = false,
  randomPan = true,
  volumeVariance = 0.2,
} = {}) {
  const playlist = await createFixturePlaylist(runId, scenario, {
    mode: playlistMode("DISABLED", -1),
    fade: 1,
    flags: {
      soundscapeMode: true,
      soundscapeMaxPolyphony: 2,
    },
    sounds: [
      fixtureSound("Sync Soundscape Bed", {
        runId,
        scenario,
        durationSec: 1.6,
        frequency: 220,
        repeat: true,
      }),
      fixtureSound("Sync Soundscape Procedural", {
        runId,
        scenario,
        durationSec: 1.4,
        frequency: 660,
        flags: {
          isProcedural: true,
          minDelay: proceduralDelaySec,
          maxDelay: proceduralDelaySec,
          timingMode: "fixed",
          initialFireMode: "normal",
          playChance: 100,
          randomPan,
          volumeVariance,
        },
      }),
    ],
  });
  const sounds = Array.from(playlist.sounds ?? []);
  const bed = sounds.find((sound) => sound.name === "Sync Soundscape Bed");
  const proc = sounds.find((sound) => sound.name === "Sync Soundscape Procedural");
  if (!bed || !proc) {
    throw new Error("Soundscape sync fixture did not create expected bed/procedural sounds.");
  }
  if (proceduralPlaying) {
    await playlist.update({
      playing: true,
      sounds: [
        { _id: bed?.id, playing: true, pausedTime: null },
        { _id: proc?.id, playing: true, pausedTime: null },
      ],
    });
  }
  return { playlist, bed, proc };
}

function fixtureSound(name, {
  runId,
  scenario,
  durationSec = 0.75,
  frequency = 440,
  path = null,
  repeat = false,
  volume = 0.25,
  flags = {},
} = {}) {
  return {
    name,
    path: path ?? getReusableAudioPath({ name, frequency }) ?? createToneDataUri({ durationSec, frequency }),
    repeat,
    volume,
    flags: {
      [MODULE_ID]: {
        ...flags,
        [FIXTURE_FLAG]: {
          kind: "sound",
          runId,
          scenario,
          createdAt: Date.now(),
        },
      },
    },
  };
}

function createToneDataUri({ durationSec = 0.75, frequency = 440 } = {}) {
  const sampleRate = 22050;
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const samples = Math.max(1, Math.floor(sampleRate * durationSec));
  const dataSize = samples * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples; i += 1) {
    const fadeIn = Math.min(1, i / Math.max(1, sampleRate * 0.03));
    const fadeOut = Math.min(1, (samples - i) / Math.max(1, sampleRate * 0.03));
    const envelope = Math.min(fadeIn, fadeOut);
    const sample = Math.sin((i / sampleRate) * Math.PI * 2 * frequency) * 0.18 * envelope;
    view.setInt16(44 + (i * bytesPerSample), Math.round(sample * 32767), true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function getReusableAudioPath({ name = "", frequency = 440 } = {}) {
  const paths = getReusableAudioPaths();
  if (paths.length === 0) return null;

  const key = `${name}:${frequency}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  return paths[Math.abs(hash) % paths.length];
}

function getReusableAudioPaths() {
  const paths = [];
  for (const playlist of collectionToArray(game.playlists)) {
    if (isFixturePlaylist(playlist)) continue;
    for (const sound of Array.from(playlist.sounds ?? [])) {
      const path = typeof sound?.path === "string" ? sound.path.trim() : "";
      if (!path || path.startsWith("data:") || !AUDIO_PATH_RE.test(path)) continue;
      paths.push(path);
    }
  }
  return Array.from(new Set(paths)).sort((a, b) => a.localeCompare(b));
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

async function ensureFixtureFolder() {
  const existing = getFixtureFolder();
  if (existing) return existing;
  if (typeof Folder === "undefined" || typeof Folder.create !== "function") return null;

  try {
    return await Folder.create({
      name: FIXTURE_FOLDER_NAME,
      type: "Playlist",
      flags: {
        [MODULE_ID]: {
          [FIXTURE_FLAG]: {
            kind: "folder",
            createdAt: Date.now(),
          },
        },
      },
    });
  } catch (_) {
    return null;
  }
}

function getFixtureFolder() {
  return collectionToArray(game.folders).find((folder) =>
    folder?.name === FIXTURE_FOLDER_NAME &&
    folder?.type === "Playlist" &&
    isFixtureFolder(folder)
  ) ?? null;
}

function isFixtureFolder(folder) {
  return Boolean(folder?.getFlag?.(MODULE_ID, FIXTURE_FLAG));
}

function getFixturePlaylists(runId = null) {
  return collectionToArray(game.playlists).filter((playlist) => isFixturePlaylist(playlist, runId));
}

function isFixturePlaylist(playlist, runId = null) {
  const marker = playlist?.getFlag?.(MODULE_ID, FIXTURE_FLAG);
  if (!marker || marker.kind !== "playlist") return false;
  if (!String(playlist.name ?? "").startsWith(FIXTURE_PLAYLIST_PREFIX)) return false;
  if (runId && marker.runId !== runId) return false;
  return true;
}

async function stopAllPlaylists(api) {
  for (const playlist of collectionToArray(game.playlists)) {
    try {
      await api.cleanup(playlist, {
        cleanSilence: true,
        cleanCrossfade: true,
        cleanLoopers: true,
        cleanSoundscape: true,
        allowFadeOut: false,
      });
      if (playlist.playing) await playlist.stopAll();
    } catch (_) {
      // Continue stopping the rest of the world; individual scenario assertions catch failures.
    }
  }
  await wait(250);
}

function resolvePlaylist(args) {
  const playlistId = normalizeOptionalString(args.playlistId);
  const playlistName = normalizeOptionalString(args.playlistName ?? args.name);
  let playlist = playlistId ? game.playlists?.get?.(playlistId) : null;

  if (!playlist && playlistName) {
    playlist = typeof game.playlists?.getName === "function"
      ? game.playlists.getName(playlistName)
      : collectionToArray(game.playlists).find((entry) => entry.name === playlistName);
  }

  if (!playlist) {
    throw new Error("playlistId or playlistName must identify an existing playlist.");
  }
  if (!(playlist instanceof Playlist)) {
    throw new TypeError("Resolved document is not a Playlist.");
  }
  return playlist;
}

function resolveSound(playlist, args, { required }) {
  const soundId = normalizeOptionalString(args.soundId);
  const soundName = normalizeOptionalString(args.soundName);
  let sound = soundId ? playlist.sounds?.get?.(soundId) : null;

  if (!sound && soundName) {
    sound = Array.from(playlist.sounds ?? []).find((entry) => entry.name === soundName);
  }

  if (!sound && required) {
    throw new Error("soundId or soundName must identify an existing PlaylistSound.");
  }
  if (sound && !(sound instanceof PlaylistSound)) {
    throw new TypeError("Resolved document is not a PlaylistSound.");
  }
  return sound ?? null;
}

function getPlayingSound(playlist) {
  return Array.from(playlist?.sounds ?? []).find((sound) =>
    sound.playing && !Flags.getSoundFlag(sound, "isSilenceGap")
  ) ?? null;
}

async function waitForPlayingSound(
  playlist,
  { soundId = null, notSoundId = null, timeoutMs = 2500, requireMedia = false } = {}
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const sound = getPlayingSound(playlist);
    if (
      sound &&
      (!soundId || sound.id === soundId) &&
      (!notSoundId || sound.id !== notSoundId) &&
      (!requireMedia || sound.sound?.playing)
    ) {
      return sound;
    }
    await wait(100);
  }
  return null;
}

async function waitForSoundscapeEngine(playlist, { timeoutMs = 2500 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const engine = State.getSoundscapeEngine(playlist);
    if (engine && !engine.isDestroyed) return engine;
    await wait(100);
  }
  return State.getSoundscapeEngine(playlist) ?? null;
}

async function waitForCondition(predicate, { timeoutMs = 2500, intervalMs = 50 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (predicate()) return true;
    } catch (_) {
      // Keep polling until the timeout; scenario assertions record failures.
    }
    await wait(intervalMs);
  }
  return false;
}

async function setSoundPlaying(playlist, sound, playing) {
  if (!playlist || !sound) return null;
  return playlist.updateEmbeddedDocuments("PlaylistSound", [{
    _id: sound.id,
    playing: Boolean(playing),
    pausedTime: null,
  }]);
}

function getActiveProceduralSound(engine, soundId) {
  if (!engine || !soundId) return null;
  return Array.from(engine.activeOneShots ?? []).find((sound) => sound?._sosProceduralId === soundId) ?? null;
}

function hasStereoPanner(sound) {
  return Array.from(sound?.effects ?? []).some((effect) =>
    effect && typeof effect === "object" && "pan" in effect && typeof effect.pan?.value === "number"
  );
}

function getSilenceGaps(playlist) {
  return Array.from(playlist?.sounds ?? []).filter((sound) => Flags.getSoundFlag(sound, "isSilenceGap"));
}

function getPlayableFixtureIds(playlist) {
  return Array.from(playlist?.sounds ?? [])
    .filter((sound) => !Flags.getSoundFlag(sound, "isSilenceGap"))
    .map((sound) => sound.id);
}

function getPlaybackOrder(playlist) {
  return Array.from(playlist?.playbackOrder ?? []);
}

function resetShufflePlaylist(playlist) {
  AdvancedShuffle.reset(playlist);
  if (playlist && Object.prototype.hasOwnProperty.call(playlist, "_playbackOrder")) {
    delete playlist._playbackOrder;
  }
}

function hasSameMembers(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  if (actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (actualSet.size !== expectedSet.size) return false;
  return expected.every((id) => actualSet.has(id));
}

function sameMembers(first, second) {
  return hasSameMembers(first, second);
}

function sameOrder(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second)) return false;
  if (first.length !== second.length) return false;
  return first.every((id, index) => id === second[index]);
}

function isAudioReady() {
  const audio = game.audio ?? null;
  if (audio?.locked === true) return false;
  return ["music", "environment", "interface"].some((name) => audio?.[name]?.state === "running");
}

function getGainValue(sound) {
  const value = Number(sound?.gain?.value);
  return Number.isFinite(value) ? value : null;
}

function isGainAtLeast(sound, minimum) {
  const value = getGainValue(sound);
  if (value === null) return true;
  return value >= minimum;
}

function approximately(actual, expected, tolerance = 0.001) {
  const actualNumber = Number(actual);
  const expectedNumber = Number(expected);
  return Number.isFinite(actualNumber) &&
    Number.isFinite(expectedNumber) &&
    Math.abs(actualNumber - expectedNumber) <= tolerance;
}

function summarizePlaylist(playlist) {
  const sounds = Array.from(playlist.sounds ?? []);
  return {
    id: playlist.id,
    name: playlist.name,
    mode: playlist.mode,
    playing: Boolean(playlist.playing),
    flags: Flags.getPlaylistFlags(playlist),
    sounds: sounds.map((sound) => ({
      id: sound.id,
      name: sound.name,
      path: sound.path ?? null,
      playing: Boolean(sound.playing),
      pausedTime: sound.pausedTime ?? null,
      repeat: Boolean(sound.repeat),
      volume: Number(sound.volume ?? 0),
      isSilenceGap: Boolean(Flags.getSoundFlag(sound, "isSilenceGap")),
      isProcedural: Boolean(Flags.getSoundFlag(sound, "isProcedural")),
      hasLoopWithin: Boolean(Flags.getLoopConfig(sound)?.enabled),
    })),
  };
}

function getWorldDocumentCounts() {
  const playlists = collectionToArray(game.playlists);
  return {
    actors: Number(game.actors?.size ?? game.actors?.length ?? 0),
    items: Number(game.items?.size ?? game.items?.length ?? 0),
    journals: Number(game.journal?.size ?? game.journal?.length ?? 0),
    scenes: Number(game.scenes?.size ?? game.scenes?.length ?? 0),
    folders: Number(game.folders?.size ?? game.folders?.length ?? 0),
    playlists: playlists.length,
    playlistSounds: playlists.reduce(
      (total, playlist) => total + Number(playlist.sounds?.size ?? playlist.sounds?.length ?? 0),
      0
    ),
  };
}

function record(tests, name, fn) {
  try {
    tests.push({ name, pass: fn() === true });
  } catch (err) {
    tests.push({
      name,
      pass: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function normalizeChoice(value, allowed, fieldName) {
  const normalized = String(value ?? "").trim();
  if (!allowed.includes(normalized)) {
    throw new Error(`${fieldName} must be one of: ${allowed.join(", ")}.`);
  }
  return normalized;
}

function normalizeScenarioList(value, allowed, allScenarios, fieldName) {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? "all").split(",");
  const normalized = raw.map((entry) => String(entry).trim()).filter(Boolean);
  const selected = normalized.length > 0 ? normalized : ["all"];
  for (const scenario of selected) {
    if (!allowed.includes(scenario)) {
      throw new Error(`${fieldName} entries must be one of: ${allowed.join(", ")}.`);
    }
  }
  return selected.includes("all") ? [...allScenarios] : Array.from(new Set(selected));
}

function normalizeCount(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.floor(num));
}

function normalizeTimeout(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(Math.floor(num), max));
}

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeWait(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(Math.floor(num), 5000));
}

function getGameSetting(key, fallback = null) {
  try {
    return game.settings?.get?.(MODULE_ID, key) ?? fallback;
  } catch (_) {
    return fallback;
  }
}

async function setGameSetting(key, value) {
  if (!game.settings?.set) return null;
  return game.settings.set(MODULE_ID, key, value);
}

function playlistMode(key, fallback) {
  const value = globalThis.CONST?.PLAYLIST_MODES?.[key];
  return Number.isFinite(Number(value)) ? value : fallback;
}

function collectionToArray(collection) {
  if (!collection) return [];
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
