/**
 * @file diagnostics-playback-automation.js
 * @description Mutating, MCP-triggered playback automation for dedicated test worlds.
 */
import { AdvancedShuffle, SHUFFLE_PATTERNS } from "./advanced-shuffle.js";
import { Flags } from "./flag-service.js";
import { disableAllLoopsWithin, nextSegmentWithin } from "./internal-loop.js";
import {
  inspectLegacyLoopMigration,
  migrateLegacyLoopFlags,
} from "./legacy-loop-migration.js";
import { Silence } from "./silence.js";
import { State } from "./state-manager.js";
import { createFixtureAudioResolver, requireNamedPlaylistSounds } from "./diagnostics-fixture-selection.js";
import { activatePlaylistSidebar } from "./diagnostics-sidebar.js";
import { assertExpectedSyncClients, collectUntilSyncState } from "./diagnostics-sync-validation.js";
import { getCrossfadePreloadDiagnostics } from "./playback/preload-coordinator.js";
import { getPlayableSoundsInOrder } from "./playlist/playable-order.js";
import { MODULE_ID, PlaylistActionAuthority } from "./utils.js";

export const FIXTURE_FLAG = "mcpAutomationFixture";
export const FIXTURE_PREFIX = "SoS MCP Test -";
const FIXTURE_FOLDER_NAME = `${FIXTURE_PREFIX}Automation Fixtures`;
const DEFAULT_WAIT_MS = 250;
const resolveFixtureAudio = createFixtureAudioResolver(createToneDataUri);

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
  "pauseResumeTransitions",
  "crossfadePreload",
  "silence",
  "transitionFallbacks",
  "configurationBoundaries",
  "loopWithin",
  "legacyLoopCrossfade",
  "legacyLoopMigration",
  "soundscape",
  "soundscapeAdvanced",
  "soundscapeGroups",
  "shufflePatterns",
  "customFades",
];

const CLIENT_SYNC_SCENARIOS = [
  "responder",
  "authorityElection",
  "basicPlaybackSync",
  "crossfadeReplication",
  "stopTransitionReplication",
  "rapidStartStopReplication",
  "silenceReplication",
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
    runAutomation: (args = {}) => runAutomation(api, args),
    cleanupFixtures: (args = {}) => cleanupFixtures(api, args),
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

export function getPlaybackFixtureCounts(runId = null) {
  const playlists = getFixturePlaylists(runId);
  const folders = collectionToArray(game.folders).filter((folder) => isFixtureFolder(folder));
  return {
    runId,
    playlists: playlists.length,
    playlistSounds: playlists.reduce(
      (total, playlist) => total + Number(playlist.sounds?.size ?? playlist.sounds?.length ?? 0),
      0
    ),
    folders: folders.length,
    fixturePrefix: FIXTURE_PREFIX,
    fixtureFlag: FIXTURE_FLAG,
  };
}

async function runAutomation(api, args = {}) {
  const mode = String(args.mode ?? "playback").trim();
  if (mode === "playback") return runPlaybackAutomation(api, args);
  if (mode === "clientSync") return runClientSyncAutomation(api, args);
  throw new Error('mode must be "playback" or "clientSync".');
}

async function cleanupFixtures(api, args = {}) {
  return cleanupPlaybackFixtures(api, args);
}

async function controlPlayback(api, args) {
  const operation = normalizeChoice(args.operation, CONTROL_OPERATIONS, "operation");
  const playlist = resolvePlaylist(args);
  const waitMs = normalizeWait(args.waitMs, DEFAULT_WAIT_MS);
  const playlistSidebar = await requirePlaylistSidebar();
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
    playlistSidebar,
    playlist: summarizePlaylist(playlist),
  };
}

async function runPlaybackAutomation(api, args) {
  const transitionFallbackPhase = normalizeChoice(
    args.transitionFallbackPhase ?? "all",
    ["all", "setup", "load", "crossfade", "silence", "nativeReplay"],
    "transitionFallbackPhase"
  );
  const transitionFallbackEnd = normalizeChoice(
    args.transitionFallbackEnd ?? "natural",
    ["natural", "manual"],
    "transitionFallbackEnd"
  );
  const scenarioNames = normalizeScenarioList(
    args.scenarios ?? args.scenario ?? "all",
    getPlaybackAutomationScenarios(),
    SCENARIOS,
    "scenarios"
  );
  const requestedScenario = scenarioNames.length === SCENARIOS.length
    ? "all"
    : scenarioNames.join(",");
  const cleanupAfter = args.cleanupAfter !== false && args.leaveFixtures !== true;
  const cleanupBefore = args.cleanupBefore !== false;
  const runId = String(args.runId || foundry.utils.randomID(8));
  const results = [];
  const createdPlaylistIds = [];
  let playlistSidebar = null;
  let beforeCounts = null;
  let beforeCleanup = { skipped: true, playlistsDeleted: 0, foldersDeleted: 0 };
  let cleanup = { skipped: true, playlistsDeleted: 0, foldersDeleted: 0 };
  let runFailure;
  let cleanupFailure;
  let hasRunFailure = false;
  let hasCleanupFailure = false;

  try {
    playlistSidebar = await requirePlaylistSidebar();
    beforeCounts = getWorldDocumentCounts();

    if (cleanupBefore) {
      beforeCleanup = await cleanupPlaybackFixtures(api, { runId, stopFirst: true });
    }
    await stopFixturePlaylists(api, runId);

    for (const scenario of scenarioNames) {
      const result = await runScenario(api, scenario, runId, { transitionFallbackPhase, transitionFallbackEnd });
      results.push(result);
      if (result.playlistId) createdPlaylistIds.push(result.playlistId);
      await stopFixturePlaylists(api, runId);
    }
  } catch (err) {
    hasRunFailure = true;
    runFailure = err;
  } finally {
    if (cleanupAfter) {
      try {
        cleanup = await cleanupPlaybackFixtures(api, { runId, stopFirst: true });
      } catch (err) {
        hasCleanupFailure = true;
        cleanupFailure = err;
      }
    }
  }

  throwAutomationFailures({
    hasRunFailure,
    runFailure,
    hasCleanupFailure,
    cleanupFailure,
    runId,
  });

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
    playlistSidebar,
    beforeCleanup,
    cleanup,
    remainingFixtures: getPlaybackFixtureCounts(runId),
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
  const cleanupAfter = args.cleanupAfter !== false && args.leaveFixtures !== true;
  const cleanupBefore = args.cleanupBefore !== false;
  const runId = String(args.runId || foundry.utils.randomID(8));
  const results = [];
  const createdPlaylistIds = [];
  let playlistSidebar = null;
  let beforeCounts = null;
  let beforeCleanup = { skipped: true, playlistsDeleted: 0, foldersDeleted: 0 };
  let cleanup = { skipped: true, playlistsDeleted: 0, foldersDeleted: 0 };
  let preflight = null;
  let runFailure;
  let cleanupFailure;
  let hasRunFailure = false;
  let hasCleanupFailure = false;

  try {
    playlistSidebar = await requirePlaylistSidebar();
    beforeCounts = getWorldDocumentCounts();

    if (cleanupBefore) {
      beforeCleanup = await cleanupPlaybackFixtures(api, { runId, stopFirst: true });
    }
    await stopFixturePlaylists(api, runId);

    preflight = await collectSyncDiagnostics(api, { timeoutMs, playlistIds: [] });
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
    } else {
      for (const scenario of scenarioNames) {
        if (scenario === "responder") continue;
        const result = await runClientSyncScenario(api, scenario, runId, {
          timeoutMs,
          expectedClients: preflight.clients,
        });
        results.push(result);
        if (result.playlistId) createdPlaylistIds.push(result.playlistId);
        await stopFixturePlaylists(api, runId);
      }
    }
  } catch (err) {
    hasRunFailure = true;
    runFailure = err;
  } finally {
    if (cleanupAfter) {
      try {
        cleanup = await cleanupPlaybackFixtures(api, { runId, stopFirst: true });
      } catch (err) {
        hasCleanupFailure = true;
        cleanupFailure = err;
      }
    }
  }

  throwAutomationFailures({
    hasRunFailure,
    runFailure,
    hasCleanupFailure,
    cleanupFailure,
    runId,
  });

  return finalizeClientSyncRun({
    runId,
    scenarioNames,
    expectedNonGmCount,
    timeoutMs,
    beforeCounts,
    results,
    createdPlaylistIds,
    beforeCleanup,
    cleanup,
    preflight,
    playlistSidebar,
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
  beforeCleanup,
  cleanup,
  preflight,
  playlistSidebar,
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
    beforeCleanup,
    cleanup,
    playlistSidebar,
    remainingFixtures: getPlaybackFixtureCounts(runId),
    preflight: summarizeCollection(preflight),
    documentCounts: {
      before: beforeCounts,
      after: getWorldDocumentCounts(),
    },
  };
}

function throwAutomationFailures({
  hasRunFailure,
  runFailure,
  hasCleanupFailure,
  cleanupFailure,
  runId,
}) {
  if (hasRunFailure && hasCleanupFailure) {
    const runMessage = runFailure instanceof Error ? runFailure.message : String(runFailure);
    const cleanupMessage = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
    throw new AggregateError(
      [runFailure, cleanupFailure],
      `Playback automation run ${runId} failed: ${runMessage}. Fixture cleanup also failed: ${cleanupMessage}.`
    );
  }
  if (hasRunFailure) throw runFailure;
  if (hasCleanupFailure) throw cleanupFailure;
}

async function runClientSyncScenario(api, scenario, runId, { timeoutMs, expectedClients }) {
  const tests = [];
  let playlist = null;
  const collectDiagnostics = async (options) => {
    const collection = await collectSyncDiagnostics(api, options);
    assertExpectedSyncClients(collection, expectedClients);
    return collection;
  };

  try {
    if (scenario === "authorityElection") {
      const diagnostics = await collectDiagnostics({ timeoutMs, playlistIds: [] });
      const gmClients = diagnostics.gmClients;
      const primaryClients = gmClients.filter((client) => client.debug?.authorizedGM === true);
      const expectedId = PlaylistActionAuthority.getAuthorizedGMId();
      record(tests, "authority diagnostics include an active GM", () => gmClients.length >= 1);
      record(tests, "exactly one connected GM reports primary authority", () => primaryClients.length === 1);
      record(tests, "all GM clients agree on the deterministic primary GM", () =>
        gmClients.every((client) => String(client.debug?.authorizedGMId ?? "") === String(expectedId ?? ""))
      );
      record(tests, "the elected primary client matches the deterministic GM id", () =>
        String(primaryClients[0]?.client?.userId ?? "") === String(expectedId ?? "")
      );
    } else if (scenario === "basicPlaybackSync") {
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
      await compareClientDocumentState(collectDiagnostics, tests, playlist, first?.id, {
        label: "playAll",
        timeoutMs,
        expectPlaylistPlaying: true,
        expectLiveMedia: true,
      });

      await playlist.playNext();
      const next = await waitForPlayingSound(playlist, { notSoundId: first?.id });
      record(tests, "GM advance changes active document sound", () => !!next && next.id !== first?.id);
      await wait(400);
      await compareClientDocumentState(collectDiagnostics, tests, playlist, next?.id, {
        label: "advance",
        timeoutMs,
        expectPlaylistPlaying: true,
        expectLiveMedia: true,
      });

      await playlist.stopAll();
      await wait(350);
      await compareClientDocumentState(collectDiagnostics, tests, playlist, null, {
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

      const order = Array.from(playlist.playbackOrder ?? []);
      const first = playlist.sounds.get(order[0]) ?? Array.from(playlist.sounds)[0];
      const second = playlist.sounds.get(order[1]) ?? Array.from(playlist.sounds).find((sound) => sound.id !== first?.id);
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
        await compareClientDocumentState(collectDiagnostics, tests, playlist, second?.id, {
          label: "crossfade in-flight",
          timeoutMs,
          expectPlaylistPlaying: true,
          expectLiveMedia: true,
          allowAnyLiveMedia: true,
          expectedSequenceKey: `pl:${playlist.id}`,
        });
        await wait(650);
        await compareClientDocumentState(collectDiagnostics, tests, playlist, second?.id, {
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
      const started = await waitForPlayingSound(playlist, { requireMedia: true });
      record(tests, "GM stop fixture starts live media", () => !!started);
      await wait(300);
      await compareClientDocumentState(collectDiagnostics, tests, playlist, started?.id, {
        label: "before stop transition",
        timeoutMs,
        expectPlaylistPlaying: true,
        expectLiveMedia: true,
      });
      await playlist.stopAll();
      await compareClientDocumentState(collectDiagnostics, tests, playlist, null, {
        label: "stop transition",
        timeoutMs,
        expectPlaylistPlaying: false,
        expectLiveMedia: false,
        expectedSequenceKey: `pl:${playlist.id}`,
      });
    } else if (scenario === "rapidStartStopReplication") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        fade: 1,
        sounds: [fixtureSound("Rapid Start Stop", {
          runId,
          scenario,
          repeat: true,
          // Use fresh audio so the test can exercise first-load completion.
          path: createToneDataUri({ durationSec: 3, frequency: 300 + (Math.random() * 100) }),
        })],
      });
      await playlist.playAll();
      const source = getPlayingSound(playlist);
      tests.push({
        name: "rapid Stop starts from an active document without waiting for media",
        pass: !!source,
        gmMediaLoadedAtStop: source?.sound?.loaded ?? false,
        gmMediaPlayingAtStop: source?.sound?.playing ?? false,
      });
      await playlist.stopAll();
      // Keep observing beyond the initial stopped document update: a pending
      // first load can attempt autoplay after a superficially clean snapshot.
      await wait(1500);
      await compareClientDocumentState(collectDiagnostics, tests, playlist, null, {
        label: "rapid Stop after first-load observation window",
        timeoutMs,
        expectPlaylistPlaying: false,
        expectLiveMedia: false,
        expectedSequenceKey: `pl:${playlist.id}`,
      });
    } else if (scenario === "silenceReplication") {
      const manualGapMs = 1000;
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        fade: 0,
        flags: { silenceEnabled: true, silenceMode: "static", silenceDuration: 250 },
        sounds: [
          fixtureSound("Sync Silence A", { runId, scenario, repeat: true, durationSec: 3, frequency: 330 }),
          fixtureSound("Sync Silence B", { runId, scenario, repeat: true, durationSec: 3, frequency: 440 }),
          fixtureSound("Sync Silence C", { runId, scenario, repeat: true, durationSec: 3, frequency: 550 }),
        ],
      });
      const [source, target] = getPlayableSoundsInOrder(playlist);
      await playlist.playSound(source);
      await waitForPlayingSound(playlist, { soundId: source.id, requireMedia: true });
      const natural = await Silence.startGap(playlist, source);
      const completed = await waitForPromiseSettlement(natural.completion, { timeoutMs: 1500 });
      record(tests, "GM natural silence completes normally", () =>
        natural.started && completed.settled && completed.value === false && !completed.error
      );
      await waitForPlayingSound(playlist, { soundId: target.id, requireMedia: true });
      const advanced = await compareClientDocumentState(collectDiagnostics, tests, playlist, target.id, {
        label: "natural silence completion",
        timeoutMs,
        expectPlaylistPlaying: true,
        expectLiveMedia: true,
      });
      recordNoGapSnapshots(tests, advanced, playlist.id, "natural silence completion");

      await api.updatePlaylistConfig(playlist, { silenceDuration: manualGapMs });
      await playlist.playSound(source);
      await waitForPlayingSound(playlist, { soundId: source.id, requireMedia: true });
      const manual = await Silence.startGap(playlist, source);
      const gap = getSilenceGaps(playlist)[0];
      // Keep this sample shorter than the gap even when the caller requests a
      // long response window, so Next is exercised while silence is active.
      const duringGap = await collectDiagnostics({ timeoutMs: Math.min(timeoutMs, 500), playlistIds: [playlist.id] });
      for (const client of duringGap.clients) {
        const name = client.client?.userName ?? "Client";
        const snapshot = findSnapshotPlaylist(client, playlist.id);
        record(tests, `${name} receives the active silence gap`, () =>
          snapshot?.sounds?.some((sound) => sound.id === gap?.id && sound.isSilenceGap && sound.playing)
        );
      }
      record(tests, "GM manual Next interrupts active silence", () =>
        manual.started && State.hasSilenceState(playlist)
      );
      await playlist.playNext(gap?.id ?? null);
      const cancelled = await waitForPromiseSettlement(manual.completion, { timeoutMs: 1000 });
      record(tests, "GM manual Next cancels silence completion", () =>
        cancelled.settled && cancelled.value === true && !cancelled.error
      );
      // The target repeats so natural playback cannot disguise a second
      // advancement when the cancelled gap's original deadline passes.
      await wait(manualGapMs + 150);
      const afterCancel = await compareClientDocumentState(collectDiagnostics, tests, playlist, target.id, {
        label: "manual Next after cancelled silence deadline",
        timeoutMs,
        expectPlaylistPlaying: true,
        expectLiveMedia: true,
      });
      recordNoGapSnapshots(tests, afterCancel, playlist.id, "manual silence cancellation");
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
        await compareClientDocumentState(collectDiagnostics, tests, playlist, sound.id, {
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
          await compareClientDocumentState(collectDiagnostics, tests, playlist, sound.id, {
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
        const collection = await collectDiagnostics({ timeoutMs, playlistIds: [playlist.id] });
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
      const started = await collectDiagnostics({ timeoutMs, playlistIds: [playlist.id] });
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
      const stopped = await collectDiagnostics({ timeoutMs, playlistIds: [playlist.id] });
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

      const collection = await collectDiagnostics({ timeoutMs, playlistIds: [playlist.id] });
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
      await Flags.setFlag(playlist, "soundscapeGroups", [{
        id: "synced-group",
        name: "Synced Group",
        maxPolyphony: 2,
        cooldownSec: 1,
      }]);
      await Flags.setFlag(proc, "soundscapeGroupId", "synced-group");

      await playlist.playAll();
      const engine = await waitForSoundscapeEngine(playlist, { timeoutMs: 2500 });
      await wait(350);
      const fired = proc ? await engine?.fireOneShotNow?.(proc.id) : false;
      const gmEvent = [...(engine?.getDiagnostics?.()?.recentSyncedEvents ?? [])]
        .reverse()
        .find((event) => event.soundId === proc?.id && event.status === "played");
      record(tests, "GM emits and plays synced procedural fire", () =>
        fired === true &&
        !!gmEvent?.eventId &&
        gmEvent.groupId === "synced-group"
      );

      await wait(250);
      const collection = await collectDiagnostics({ timeoutMs, playlistIds: [playlist.id] });
      for (const client of collection.nonGmClients) {
        const clientName = client.client?.userName ?? "Player";
        const snapshot = findSoundscapeSnapshot(client, playlist.id);
        const event = findSoundscapeEvent(snapshot, gmEvent?.eventId);
        const missed = findMissedSoundscapeEvent(snapshot, gmEvent?.eventId);
        record(tests, `${clientName} receives soundscape group configuration`, () =>
          snapshot?.groups?.some((group) =>
            group.id === "synced-group" &&
            group.max === 2 &&
            group.cooldownSec === 1
          )
        );
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
          event.groupId === gmEvent.groupId &&
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

      const armed = await collectDiagnostics({ timeoutMs, playlistIds: [playlist.id] });
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
      const disarmed = await collectDiagnostics({ timeoutMs, playlistIds: [playlist.id] });
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
      const preflight = await collectDiagnostics({ timeoutMs, playlistIds: [] });
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
        const started = await collectDiagnostics({ timeoutMs, playlistIds: [playlist.id] });
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
        const afterFire = await collectDiagnostics({ timeoutMs, playlistIds: [playlist.id] });
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

      const collection = await collectDiagnostics({ timeoutMs, playlistIds: [playlistId] });
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

async function runScenario(api, scenario, runId, {
  transitionFallbackPhase = "all",
  transitionFallbackEnd = "natural",
} = {}) {
  const tests = [];
  let playlist = null;
  let scenarioEvidence = null;
  const scenarioCleanups = [];

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
      const [first, target] = getPlayableSoundsInOrder(playlist);
      if (!first || !target) {
        throw new Error("Crossfade fixture did not create two playable sounds.");
      }
      const metricBefore = Number(api.getMetrics()?.crossfades?.total ?? 0);
      await playlist.playSound(first);
      const ready = await waitForPlayingSound(playlist, { soundId: first.id, requireMedia: true });
      record(tests, "crossfade source media starts", () => !!ready);
      if (ready) await api.crossfadeToNext(playlist, first);
      await wait(450);
      const active = getPlayingSound(playlist);
      const metricAfter = Number(api.getMetrics()?.crossfades?.total ?? 0);
      record(tests, "crossfade advances to the next playback-order sound", () => active?.id === target.id);
      record(tests, "crossfade metric increments", () => metricAfter > metricBefore);
      record(tests, "crossfade runtime state clears", () => !State.isPlaylistCrossfading(playlist));
    } else if (scenario === "pauseResumeTransitions") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        fade: 1,
        flags: {
          crossfade: true,
          useCustomAutoFade: true,
          customAutoFadeMs: 900,
        },
        sounds: [
          fixtureSound("Pause Crossfade A", {
            runId,
            scenario,
            path: createToneDataUri({ durationSec: 2.5, frequency: 330 }),
          }),
          fixtureSound("Pause Crossfade B", {
            runId,
            scenario,
            path: createToneDataUri({ durationSec: 2.5, frequency: 440 }),
          }),
        ],
      });
      const [source, target] = getPlayableSoundsInOrder(playlist);
      if (!source || !target) {
        throw new Error("Pause crossfade fixture did not create two playable sounds.");
      }
      await playlist.playSound(source);
      await waitForPlayingSound(playlist, {
        soundId: source.id,
        requireMedia: true,
        timeoutMs: 2500,
      });
      await api.crossfadeToNext(playlist, source);
      await wait(120);

      const incoming = target;
      const sessionBeforePause = State.getCrossfadeSession(playlist);
      record(tests, "crossfade session is active before pause", () =>
        incoming.playing && incoming.id !== source.id &&
        !!sessionBeforePause &&
        ["preparing", "active"].includes(sessionBeforePause.status)
      );

      const capturedTime = Number(incoming?.sound?.currentTime);
      if (incoming) {
        await incoming.update({
          playing: false,
          pausedTime: Number.isFinite(capturedTime) ? capturedTime : 0,
        });
      }
      await wait(150);

      record(tests, "pause clears active transition ownership", () =>
        !State.getCrossfadeSession(playlist) && !State.isPlaylistCrossfading(playlist)
      );
      record(tests, "pause settles both crossfade media participants", () =>
        Array.from(playlist.sounds).every((sound) => !sound.sound?.playing)
      );
      record(tests, "pause preserves a finite incoming offset", () =>
        !!incoming && Number.isFinite(Number(incoming.pausedTime))
      );

      if (incoming) await incoming.update({ playing: true });
      const resumed = incoming
        ? await waitForPlayingSound(playlist, {
            soundId: incoming.id,
            requireMedia: true,
            timeoutMs: 2500,
          })
        : null;
      record(tests, "resume restarts the logical incoming track", () =>
        !!resumed?.sound?.playing && resumed.id === incoming?.id
      );
      record(tests, "resume does not revive the outgoing crossfade media", () =>
        !source.sound?.playing && !State.getCrossfadeSession(playlist)
      );
    } else if (scenario === "crossfadePreload") {
      const originalNativeLead = CONFIG.Playlist?.autoPreloadSeconds;
      let source = null;
      let target = null;
      try {
        CONFIG.Playlist.autoPreloadSeconds = 1;
        playlist = await createFixturePlaylist(runId, scenario, {
          mode: playlistMode("SEQUENTIAL", 1),
          fade: 1,
          flags: {
            crossfade: true,
            useCustomAutoFade: true,
            customAutoFadeMs: 2000,
          },
          sounds: [
            fixtureSound("Preload Source", {
              runId,
              scenario,
              path: createToneDataUri({ durationSec: 4, frequency: 330 }),
            }),
            fixtureSound("Preload Target", {
              runId,
              scenario,
              path: createToneDataUri({ durationSec: 4, frequency: 440 }),
            }),
          ],
        });
        [source, target] = getPlayableSoundsInOrder(playlist);
        if (!source || !target) {
          throw new Error("Crossfade preload fixture did not create two playable sounds.");
        }
        await playlist.playSound(source);
        await waitForPlayingSound(playlist, {
          soundId: source.id,
          requireMedia: true,
          timeoutMs: 2500,
        });
        const ready = await waitForCondition(
          () => getCrossfadePreloadDiagnostics(playlist)?.status === "ready",
          { timeoutMs: 2500, intervalMs: 40 }
        );
        const preload = getCrossfadePreloadDiagnostics(playlist);
        record(tests, "long crossfade preload becomes ready", () =>
          ready === true && preload?.status === "ready"
        );
        record(tests, "preload targets the next playback-order sound", () =>
          preload?.sourceSoundId === source.id && preload?.targetSoundId === target.id
        );
        record(tests, "preload runs earlier than Foundry's native window", () =>
          Number(preload?.desiredAtSec) < Number(preload?.nativeAtSec)
        );
        record(tests, "preloading does not start target playback", () =>
          !!target.sound?.loaded && !target.sound.playing && target.playing === false
        );
      } finally {
        const configuredNativeLead = CONFIG.Playlist?.autoPreloadSeconds;
        if (CONFIG.Playlist) CONFIG.Playlist.autoPreloadSeconds = originalNativeLead;
        const preload = getCrossfadePreloadDiagnostics(playlist);
        const mediaEvidence = (sound) => ({
          soundId: sound?.id ?? null,
          documentPlaying: sound?.playing === true,
          mediaPresent: !!sound?.sound,
          loaded: sound?.sound?.loaded === true,
          playing: sound?.sound?.playing === true,
          state: sound?.sound?._state ?? null,
          duration: Number.isFinite(sound?.sound?.duration) ? sound.sound.duration : null,
          currentTime: Number.isFinite(sound?.sound?.currentTime) ? sound.sound.currentTime : null,
          contextState: sound?.sound?.context?.state ?? null,
        });
        scenarioEvidence = {
          capturedAt: Date.now(),
          playbackOrder: Array.from(playlist?.playbackOrder ?? []).slice(0, 4),
          sourceSoundId: source?.id ?? null,
          targetSoundId: target?.id ?? null,
          nativeLeadSec: configuredNativeLead ?? null,
          originalNativeLeadSec: originalNativeLead ?? null,
          audioLocked: game.audio?.locked ?? null,
          contextStates: Object.fromEntries(["music", "environment", "interface"].map((name) =>
            [name, game.audio?.[name]?.state ?? null]
          )),
          source: mediaEvidence(source),
          target: mediaEvidence(target),
          preload: preload && !Array.isArray(preload) ? {
            playlistId: preload.playlistId,
            sourceSoundId: preload.sourceSoundId,
            targetSoundId: preload.targetSoundId,
            status: preload.status,
            crossfadeAtSec: preload.crossfadeAtSec,
            desiredAtSec: preload.desiredAtSec,
            nativeAtSec: preload.nativeAtSec,
            loadStartedAt: preload.loadStartedAt,
            loadCompletedAt: preload.loadCompletedAt,
            loadLatencyMs: preload.loadLatencyMs,
            error: preload.error ? String(preload.error).slice(0, 500) : null,
          } : null,
        };
      }
    } else if (scenario === "silence") {
      const naturalGapMs = 200;
      const manualGapMs = 500;
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        fade: 0,
        flags: {
          silenceEnabled: true,
          silenceMode: "static",
          silenceDuration: naturalGapMs,
        },
        sounds: [
          fixtureSound("Silence Previous", {
            runId,
            scenario,
            path: createToneDataUri({ durationSec: 3, frequency: 220 }),
          }),
          fixtureSound("Silence Source", {
            runId,
            scenario,
            path: createToneDataUri({ durationSec: 3, frequency: 330 }),
          }),
          fixtureSound("Silence Next", {
            runId,
            scenario,
            path: createToneDataUri({ durationSec: 3, frequency: 440 }),
          }),
        ],
      });
      const realOrder = getPlayableSoundsInOrder(playlist);
      if (realOrder.length !== 3) {
        throw new Error(`Silence fixture expected three real playback-order sounds; found ${realOrder.length}.`);
      }
      const [previous, source, target] = realOrder;
      const silenceEvents = [];
      const onSilenceEnd = (event) => {
        if (event?.playlist?.id === playlist.id) silenceEvents.push(event);
      };
      Hooks.on("the-sound-of-silence.silenceEnd", onSilenceEnd);
      scenarioCleanups.push(() => Hooks.off("the-sound-of-silence.silenceEnd", onSilenceEnd));

      // A normal middle-of-playlist gap must advance to the next real track,
      // even though the active temporary gap can appear first in playbackOrder.
      await playlist.playSound(source);
      await waitForPlayingSound(playlist, { soundId: source.id });
      const naturalEventIndex = silenceEvents.length;
      const naturalTransition = await Silence.startGap(playlist, source);
      record(tests, "silent gap state appears", () => State.hasSilenceState(playlist));
      record(tests, "silent gap document created", () => getSilenceGaps(playlist).length === 1);
      record(tests, "silent gap participates in raw Foundry playback order", () => {
        const gap = getSilenceGaps(playlist)[0];
        return !!gap && Array.from(playlist.playbackOrder ?? []).includes(gap.id);
      });
      const naturalCompletion = await waitForPromiseSettlement(
        naturalTransition.completion,
        { timeoutMs: 1500 }
      );
      const naturalAdvanced = await waitForCondition(
        () => target.playing && !source.playing && !State.hasSilenceState(playlist),
        { timeoutMs: 1000, intervalMs: 25 }
      );
      record(tests, "silent gap completes naturally", () =>
        naturalTransition.started === true &&
        naturalCompletion.settled === true &&
        naturalCompletion.value === false &&
        !naturalCompletion.error
      );
      record(tests, "natural silence emits one completed event", () => {
        const events = silenceEvents.slice(naturalEventIndex);
        return events.length === 1 && events[0].completed === true && events[0].cancelled !== true;
      });
      record(tests, "silent gap advances to the next real track", () =>
        naturalAdvanced && getPlayingSound(playlist)?.id === target.id
      );
      record(tests, "silent gap state clears", () => !State.hasSilenceState(playlist));
      record(tests, "silent gap document removed", () => getSilenceGaps(playlist).length === 0);

      // At the real-order boundary, Loop Entire Playlist must restart the
      // first real track instead of selecting the still-persisted gap marker.
      await playlist.stopAll();
      await api.updatePlaylistConfig(playlist, { loopPlaylist: true });
      await playlist.playSound(target);
      await waitForPlayingSound(playlist, { soundId: target.id });
      const loopEventIndex = silenceEvents.length;
      const loopTransition = await Silence.startGap(playlist, target);
      const loopCompletion = await waitForPromiseSettlement(
        loopTransition.completion,
        { timeoutMs: 1500 }
      );
      const loopRestarted = await waitForCondition(
        () => previous.playing && !target.playing && !State.hasSilenceState(playlist),
        { timeoutMs: 1000, intervalMs: 25 }
      );
      record(tests, "loop-boundary silence completes naturally", () =>
        loopTransition.started === true &&
        loopCompletion.settled === true &&
        loopCompletion.value === false &&
        !loopCompletion.error
      );
      record(tests, "loop-boundary silence emits one completed event", () => {
        const events = silenceEvents.slice(loopEventIndex);
        return events.length === 1 && events[0].completed === true && events[0].cancelled !== true;
      });
      record(tests, "loop-boundary silence restarts the first real track", () =>
        loopRestarted &&
        getPlayingSound(playlist)?.id === previous.id &&
        getSilenceGaps(playlist).length === 0
      );

      // The same boundary without Loop Entire Playlist must stop cleanly and
      // still classify the gap as a natural completion rather than a cancel.
      await playlist.stopAll();
      await api.updatePlaylistConfig(playlist, { loopPlaylist: false });
      await playlist.playSound(target);
      await waitForPlayingSound(playlist, { soundId: target.id });
      const terminalEventIndex = silenceEvents.length;
      const terminalTransition = await Silence.startGap(playlist, target);
      const terminalCompletion = await waitForPromiseSettlement(
        terminalTransition.completion,
        { timeoutMs: 1500 }
      );
      const terminalStopped = await waitForCondition(
        () => !playlist.playing && !getPlayingSound(playlist) && !State.hasSilenceState(playlist),
        { timeoutMs: 1000, intervalMs: 25 }
      );
      record(tests, "terminal silence completes naturally", () =>
        terminalTransition.started === true &&
        terminalCompletion.settled === true &&
        terminalCompletion.value === false &&
        !terminalCompletion.error
      );
      record(tests, "terminal silence emits one completed event", () => {
        const events = silenceEvents.slice(terminalEventIndex);
        return events.length === 1 && events[0].completed === true && events[0].cancelled !== true;
      });
      record(tests, "terminal non-loop silence stops the playlist", () =>
        terminalStopped && getSilenceGaps(playlist).length === 0
      );

      // Manual Next owns the transition from this point onward. It must cancel
      // the gap and its timer, advance relative to the source track, and remain
      // stable after the old timer's original deadline has passed.
      await api.updatePlaylistConfig(playlist, { silenceDuration: manualGapMs });
      await playlist.playSound(source);
      await waitForPlayingSound(playlist, { soundId: source.id });
      const manualNextEventIndex = silenceEvents.length;
      const manualTransition = await Silence.startGap(playlist, source);
      const manualGap = getSilenceGaps(playlist)[0] ?? null;
      record(tests, "manual Next starts from an active silent gap", () =>
        manualTransition.started === true && !!manualGap && State.hasSilenceState(playlist)
      );
      await playlist.playNext(manualGap?.id ?? null, { direction: 1 });
      const manualAdvanced = await waitForCondition(
        () => target.playing && !State.hasSilenceState(playlist) && getSilenceGaps(playlist).length === 0,
        { timeoutMs: 1000, intervalMs: 25 }
      );
      const manualCompletion = await waitForPromiseSettlement(
        manualTransition.completion,
        { timeoutMs: 1000 }
      );
      record(tests, "manual Next cancels the silent gap and advances", () =>
        manualAdvanced &&
        manualCompletion.settled === true &&
        manualCompletion.value === true &&
        !manualCompletion.error &&
        getPlayingSound(playlist)?.id === target.id
      );
      record(tests, "manual Next emits one cancelled event", () => {
        const events = silenceEvents.slice(manualNextEventIndex);
        return events.length === 1 && events[0].completed === false && events[0].cancelled === true;
      });

      await wait(manualGapMs + 200);
      record(tests, "cancelled Next gap timer cannot advance again", () =>
        playlist.playing &&
        getPlayingSound(playlist)?.id === target.id &&
        !State.hasSilenceState(playlist) &&
        getSilenceGaps(playlist).length === 0
      );

      // Previous follows the same source-anchored cancellation path and must
      // not navigate relative to the temporary document's raw-order position.
      await playlist.playSound(source);
      await waitForPlayingSound(playlist, { soundId: source.id });
      const manualPreviousEventIndex = silenceEvents.length;
      const previousTransition = await Silence.startGap(playlist, source);
      const previousGap = getSilenceGaps(playlist)[0] ?? null;
      await playlist.playNext(previousGap?.id ?? null, { direction: -1 });
      const manualRewound = await waitForCondition(
        () => previous.playing && !State.hasSilenceState(playlist) && getSilenceGaps(playlist).length === 0,
        { timeoutMs: 1000, intervalMs: 25 }
      );
      const previousCompletion = await waitForPromiseSettlement(
        previousTransition.completion,
        { timeoutMs: 1000 }
      );
      record(tests, "manual Previous cancels the silent gap and rewinds", () =>
        manualRewound &&
        previousCompletion.settled === true &&
        previousCompletion.value === true &&
        !previousCompletion.error &&
        getPlayingSound(playlist)?.id === previous.id
      );
      record(tests, "manual Previous emits one cancelled event", () => {
        const events = silenceEvents.slice(manualPreviousEventIndex);
        return events.length === 1 && events[0].completed === false && events[0].cancelled === true;
      });

      await wait(manualGapMs + 200);
      record(tests, "cancelled Previous gap timer cannot advance again", () =>
        playlist.playing &&
        getPlayingSound(playlist)?.id === previous.id &&
        !State.hasSilenceState(playlist) &&
        getSilenceGaps(playlist).length === 0
      );
    } else if (scenario === "transitionFallbacks") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        fade: 0,
        flags: {
          crossfade: !["silence", "nativeReplay"].includes(transitionFallbackPhase),
          useCustomAutoFade: true,
          customAutoFadeMs: 0,
          silenceEnabled: transitionFallbackPhase === "silence",
          silenceMode: "static",
          silenceDuration: 0,
        },
        sounds: [
          fixtureSound("Zero Transition Source", {
            runId,
            scenario,
            path: createToneDataUri({ durationSec: 1.2, frequency: 330 }),
          }),
          fixtureSound("Zero Transition Next", {
            runId,
            scenario,
            path: createToneDataUri({ durationSec: 1.2, frequency: 440 }),
          }),
        ],
      });
      const [source, target] = getPlayableSoundsInOrder(playlist);
      if (!source || !target) {
        throw new Error("Transition fallback fixture did not create two playable sounds.");
      }

      await runTransitionFallbackPhase(
        api, playlist, tests, source, target, transitionFallbackPhase, transitionFallbackEnd
      );
    } else if (scenario === "configurationBoundaries") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        sounds: [
          fixtureSound("Configuration Boundary Sound", {
            runId,
            scenario,
            flags: {
              loopWithin: {
                enabled: true,
                active: true,
                start: "00:01.000",
                end: "00:02.000",
                crossfadeMs: 900,
                loopCount: 3,
              },
            },
          }),
        ],
      });
      const [sound] = Array.from(playlist.sounds);

      await api.updatePlaylistConfig(playlist, {
        normalizedVolume: 5,
        customAutoFadeMs: -25,
        soundscapeMaxPolyphony: 99,
        crossfade: "invalid-boolean",
      });
      record(tests, "public playlist config clamps normalized volume", () =>
        Flags.getPlaylistFlag(playlist, "normalizedVolume") === 1
      );
      record(tests, "public playlist config preserves the zero lower bound", () =>
        Flags.getPlaylistFlag(playlist, "customAutoFadeMs") === 0
      );
      record(tests, "public playlist config clamps soundscape polyphony", () =>
        Flags.getPlaylistFlag(playlist, "soundscapeMaxPolyphony") === 16
      );
      record(tests, "public playlist config rejects invalid boolean values", () =>
        Flags.getPlaylistFlag(playlist, "crossfade") === false
      );

      const segments = Array.from({ length: 17 }, (_, index) => ({
        label: `Boundary ${index + 1}`,
        start: `00:${String(index).padStart(2, "0")}.000`,
        end: `00:${String(index + 1).padStart(2, "0")}.000`,
        crossfadeMs: index === 0 ? 0 : 250,
        loopCount: index === 0 ? 2.9 : 0,
        skipToNext: false,
      }));
      await api.updateLoopConfig(sound, {
        enabled: true,
        active: true,
        startFromBeginning: true,
        segments,
      });
      const rawLoop = sound.getFlag(MODULE_ID, "loopWithin") ?? {};
      record(tests, "complete loop update caps persisted segments at sixteen", () =>
        Array.isArray(rawLoop.segments) && rawLoop.segments.length === 16
      );
      record(tests, "complete loop update preserves explicit zero crossfade", () =>
        rawLoop.segments?.[0]?.crossfadeMs === 0
      );
      record(tests, "complete loop update normalizes loop counts to integers", () =>
        rawLoop.segments?.[0]?.loopCount === 2
      );
      record(tests, "complete loop update removes stale legacy and runtime keys", () =>
        !["start", "end", "crossfadeMs", "loopCount", "startSec", "endSec"]
          .some((key) => Object.prototype.hasOwnProperty.call(rawLoop, key)) &&
        !rawLoop.segments.some((segment) => "startSec" in segment || "endSec" in segment)
      );
      record(tests, "current client matches deterministic automatic authority", () =>
        PlaylistActionAuthority.isAuthorizedGM() &&
        String(PlaylistActionAuthority.getAuthorizedGMId()) === String(game.user.id)
      );

      // Exercise the registered sheet wrappers, form serialization, and native
      // submit workflow against this run's documents only.
      await sound.setFlag(MODULE_ID, "minDelay", 15);
      for (const document of [playlist, sound]) {
        const sheet = document.sheet;
        try {
          await sheet.render({ force: true });
          record(tests, `${document.documentName} config renders SoS controls`, () =>
            !!sheet.form?.querySelector(`[name^="flags.${MODULE_ID}."]`)
          );
          if (document === sound) {
            const formData = new foundry.applications.ux.FormDataExtended(sheet.form);
            const processed = sheet._processFormData(new Event("submit"), sheet.form, formData);
            record(tests, "sound form retains an explicit procedural default", () =>
              processed.flags?.[MODULE_ID]?.minDelay === 15
            );
          }
          const savedName = `${document.name} Saved`;
          sheet.form.elements.name.value = savedName;
          await sheet.submit();
          record(tests, `${document.documentName} config persists submitted fields`, () => document.name === savedName);
        } finally {
          await sheet.close();
        }
      }
      record(tests, "sound config save preserves all sixteen loop segments", () =>
        sound.getFlag(MODULE_ID, "loopWithin")?.segments?.length === 16
      );
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
      const looper = State.getActiveLooper(sound);
      const loopPauseOffset = Number(sound.sound?.currentTime);
      await sound.update({
        playing: false,
        pausedTime: Number.isFinite(loopPauseOffset) ? loopPauseOffset : 0,
      });
      await wait(120);
      record(tests, "loop pause snapshots segment state", () =>
        !!looper?.pausedSnapshot &&
        looper.pausedSnapshot.loopsCompleted === looper.loopsCompleted
      );
      record(tests, "loop pause cancels every transition timer", () =>
        !looper?.mainSchedule &&
        !looper?.loopCrossfadeTimer &&
        !looper?.handoffTimer &&
        !looper?.finalTransitionTimer &&
        looper?.isCrossfading === false
      );
      await sound.update({ playing: true });
      await waitForPlayingSound(playlist, {
        soundId: sound.id,
        requireMedia: true,
        timeoutMs: 2500,
      });
      await wait(100);
      record(tests, "loop resume restores and re-arms the same looper", () =>
        State.getActiveLooper(sound) === looper &&
        !looper?.pausedSnapshot &&
        !!sound.sound?.playing
      );
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

      // A skip-intro loop must apply the first-segment offset to Foundry's
      // initial Sound.play call. Replacing the media object after playback has
      // already begun creates an audible hard stop and can lose native state.
      playlist = await createFixturePlaylist(runId, `${scenario}-skip-intro-startup`, {
        mode: playlistMode("SEQUENTIAL", 1),
        fade: 0,
        sounds: [
          fixtureSound("Looping Sound Skip Intro Startup", {
            runId,
            scenario: `${scenario}-skip-intro-startup`,
            path: createToneDataUri({ durationSec: 4, frequency: 660 }),
            flags: {
              loopWithin: {
                enabled: true,
                active: true,
                startFromBeginning: false,
                segments: [
                  { start: "00:00.500", end: "00:03.000", crossfadeMs: 100, loopCount: 0 },
                ],
              },
            },
          }),
        ],
      });
      const [skipIntroSound] = Array.from(playlist.sounds);
      const skipIntroConfig = Flags.getLoopConfig(skipIntroSound);
      const expectedStartSec = Number(skipIntroConfig.segments?.[0]?.startSec);
      const audioReady = isAudioReady();
      let preloadResult = { settled: false, value: undefined, error: null };
      let initialMedia = null;
      let initialPlayPosition = null;
      let initialStopEvents = 0;
      let lifecycleObservable = false;
      let startupLooperReady = false;
      let startupLooper = null;

      if (audioReady && skipIntroSound) {
        preloadResult = await waitForPromiseSettlement(skipIntroSound.load(), { timeoutMs: 2000 });
        initialMedia = skipIntroSound.sound ?? null;
        lifecycleObservable = Boolean(
          initialMedia?.addEventListener && initialMedia?.removeEventListener
        );

        if (preloadResult.settled && !preloadResult.error && initialMedia && lifecycleObservable) {
          const onInitialPlay = () => {
            if (initialPlayPosition !== null) return;
            const position = Number(initialMedia.currentTime);
            if (Number.isFinite(position)) initialPlayPosition = position;
          };
          const onInitialStop = () => {
            initialStopEvents += 1;
          };
          initialMedia.addEventListener("play", onInitialPlay);
          initialMedia.addEventListener("stop", onInitialStop);
          scenarioCleanups.push(() => {
            initialMedia.removeEventListener("play", onInitialPlay);
            initialMedia.removeEventListener("stop", onInitialStop);
          });

          await playlist.playSound(skipIntroSound);
          await waitForCondition(
            () => Number.isFinite(initialPlayPosition),
            { timeoutMs: 1200, intervalMs: 20 }
          );
          startupLooperReady = await waitForCondition(() => {
            const candidate = State.getActiveLooper(skipIntroSound);
            return Boolean(candidate && !candidate.isDestroyed && candidate.activeSound?.playing);
          }, { timeoutMs: 1200, intervalMs: 20 });

          // Allow the old restart-based implementation enough time to replace
          // and stop the original media before inspecting object identity.
          await wait(350);
          startupLooper = State.getActiveLooper(skipIntroSound);
        }
      }

      tests.push({
        name: "skip-intro startup preloads one observable original Sound",
        pass: Boolean(
          audioReady &&
          preloadResult.settled &&
          !preloadResult.error &&
          initialMedia &&
          lifecycleObservable
        ),
        audioReady,
        preloadSettled: preloadResult.settled,
        preloadError: preloadResult.error,
      });
      tests.push({
        name: "startFromBeginning=false initial playback begins at the first segment",
        pass: Boolean(
          Number.isFinite(expectedStartSec) &&
          Number.isFinite(initialPlayPosition) &&
          Math.abs(initialPlayPosition - expectedStartSec) <= 0.12
        ),
        expectedStartSec: Number.isFinite(expectedStartSec) ? expectedStartSec : null,
        observedStartSec: Number.isFinite(initialPlayPosition) ? initialPlayPosition : null,
      });
      tests.push({
        name: "startFromBeginning=false startup preserves the original Sound instance",
        pass: Boolean(
          startupLooperReady &&
          initialMedia &&
          skipIntroSound?.sound === initialMedia &&
          startupLooper?.activeSound === initialMedia &&
          startupLooper?.wasRestarted === false
        ),
        looperReady: startupLooperReady,
        documentKeptOriginalMedia: Boolean(initialMedia && skipIntroSound?.sound === initialMedia),
        looperKeptOriginalMedia: Boolean(initialMedia && startupLooper?.activeSound === initialMedia),
        looperWasRestarted: startupLooper?.wasRestarted ?? null,
      });
      tests.push({
        name: "startFromBeginning=false startup does not hard-stop original media",
        pass: Boolean(
          lifecycleObservable &&
          initialStopEvents === 0 &&
          initialMedia?.playing
        ),
        lifecycleObservable,
        observedStopEvents: initialStopEvents,
        originalMediaPlaying: Boolean(initialMedia?.playing),
      });
    } else if (scenario === "legacyLoopCrossfade") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        fade: 1,
        flags: {
          crossfade: true,
          useCustomAutoFade: true,
          customAutoFadeMs: 100,
        },
        sounds: [
          fixtureSound("Legacy Loop Source", {
            runId,
            scenario,
            path: createToneDataUri({ durationSec: 1.2, frequency: 440 }),
            flags: {
              loopWithin: {
                start: "00:00.100",
                end: "00:00.350",
                crossfadeMs: 50,
                loopCount: 0,
              },
            },
          }),
          fixtureSound("Legacy Loop Next", {
            runId,
            scenario,
            path: createToneDataUri({ durationSec: 1.2, frequency: 550 }),
          }),
        ],
      });
      const [source, next] = requireNamedPlaylistSounds(playlist, [
        "Legacy Loop Source",
        "Legacy Loop Next",
      ]);
      await playlist.playSound(source);
      await waitForPlayingSound(playlist, { soundId: source.id });

      const migrated = Flags.getLoopConfig(source);
      record(tests, "legacy loop config migrates to enabled segment", () =>
        migrated.enabled === true &&
        migrated.active === true &&
        Array.isArray(migrated.segments) &&
        migrated.segments.length === 1
      );

      const loopStarted = await waitForCondition(() => api.isLooping(source), { timeoutMs: 1500 });
      record(tests, "legacy loop state appears", () => loopStarted === true);
      record(tests, "playlist crossfade timer is suppressed while legacy loop owns playback", () =>
        !State.getCrossfadeTimer(playlist)
      );

      await wait(700);
      record(tests, "legacy loop does not advance to next track before break", () =>
        source.playing === true && next.playing !== true
      );
    } else if (scenario === "legacyLoopMigration") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("SEQUENTIAL", 1),
        fade: 1,
        sounds: [
          fixtureSound("Legacy Migration Candidate", {
            runId,
            scenario,
            durationSec: 1.2,
            frequency: 440,
            flags: {
              loopWithin: {
                start: "00:00.100",
                end: "00:00.450",
                crossfadeMs: 75,
                loopCount: 2,
                skipCount: 0,
              },
            },
          }),
          fixtureSound("Legacy Migration Current", {
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
                  { start: "00:00.200", end: "00:00.550", crossfadeMs: 50, loopCount: 0 },
                ],
              },
            },
          }),
          fixtureSound("Legacy Migration Empty", {
            runId,
            scenario,
            durationSec: 1.2,
            frequency: 660,
            flags: {
              loopWithin: {
                start: "00:00.000",
                end: "00:00",
                crossfadeMs: 75,
                loopCount: 0,
              },
            },
          }),
        ],
      });
      const sounds = Array.from(playlist.sounds ?? []);
      const legacySound = sounds.find((sound) => sound.name === "Legacy Migration Candidate");
      const currentSound = sounds.find((sound) => sound.name === "Legacy Migration Current");
      const emptySound = sounds.find((sound) => sound.name === "Legacy Migration Empty");
      const currentBefore = JSON.stringify(currentSound?.getFlag(MODULE_ID, "loopWithin") ?? {});

      const inspectBefore = inspectLegacyLoopMigration({
        maxCandidateSummaries: 10,
        playlistIds: [playlist.id],
      });
      record(tests, "migration inspect scans only the fixture playlist", () =>
        inspectBefore.scannedPlaylists === 1 && inspectBefore.scannedSounds === 3
      );
      record(tests, "migration inspect finds one useful legacy candidate", () =>
        inspectBefore.candidates === 1 &&
        inspectBefore.alreadyCurrent === 1 &&
        inspectBefore.notUsefulLegacy === 1 &&
        inspectBefore.canMigrate === true
      );

      const firstMigration = await migrateLegacyLoopFlags({
        confirmLegacyLoopMigration: true,
        playlistIds: [playlist.id],
      });
      record(tests, "migration writes exactly one fixture sound", () =>
        firstMigration.success === true &&
        firstMigration.migrated === 1 &&
        firstMigration.skipped === 1 &&
        firstMigration.errors === 0
      );

      const legacyRaw = legacySound?.getFlag(MODULE_ID, "loopWithin") ?? {};
      const migratedConfig = legacySound ? Flags.getLoopConfig(legacySound) : null;
      record(tests, "migration persists segment-based loop config", () =>
        Array.isArray(legacyRaw.segments) &&
        legacyRaw.segments.length === 1 &&
        !Object.prototype.hasOwnProperty.call(legacyRaw, "start") &&
        !Object.prototype.hasOwnProperty.call(legacyRaw, "end") &&
        !Object.prototype.hasOwnProperty.call(legacyRaw, "crossfadeMs") &&
        !Object.prototype.hasOwnProperty.call(legacyRaw, "loopCount") &&
        !Object.prototype.hasOwnProperty.call(legacyRaw, "skipCount") &&
        migratedConfig?.enabled === true &&
        migratedConfig?.active === true
      );
      record(tests, "migration preserves legacy timing fields inside the segment", () => {
        const segment = legacyRaw.segments?.[0] ?? {};
        return segment.start === "00:00.100" &&
          segment.end === "00:00.450" &&
          Number(segment.crossfadeMs) === 75 &&
          Number(segment.loopCount) === 2;
      });
      record(tests, "migration leaves current segment config alone", () =>
        JSON.stringify(currentSound?.getFlag(MODULE_ID, "loopWithin") ?? {}) === currentBefore
      );
      record(tests, "migration skips empty legacy loop data", () => {
        const raw = emptySound?.getFlag(MODULE_ID, "loopWithin") ?? {};
        return raw.end === "00:00" && !Array.isArray(raw.segments);
      });

      const secondMigration = await migrateLegacyLoopFlags({
        confirmLegacyLoopMigration: true,
        playlistIds: [playlist.id],
      });
      record(tests, "migration is idempotent on a second pass", () =>
        secondMigration.success === true &&
        secondMigration.candidates === 0 &&
        secondMigration.migrated === 0 &&
        secondMigration.notUsefulLegacy === 1
      );

      const blockedPlaylist = await createFixturePlaylist(runId, `${scenario}-blocked`, {
        mode: playlistMode("SEQUENTIAL", 1),
        fade: 1,
        sounds: [
          fixtureSound("Legacy Migration Blocked", {
            runId,
            scenario: `${scenario}-blocked`,
            durationSec: 1.2,
            frequency: 770,
            flags: {
              loopWithin: {
                start: "00:00.100",
                end: "00:00.450",
                crossfadeMs: 75,
                loopCount: 1,
              },
            },
          }),
        ],
      });
      const [blockedSound] = Array.from(blockedPlaylist.sounds ?? []);
      await blockedPlaylist.update({
        playing: true,
        sounds: [{ _id: blockedSound?.id, playing: true, pausedTime: null }],
      });
      const blockedMigration = await migrateLegacyLoopFlags({
        confirmLegacyLoopMigration: true,
        playlistIds: [blockedPlaylist.id],
      });
      record(tests, "migration refuses active fixture playback", () =>
        blockedMigration.success === false &&
        blockedMigration.blocked === true &&
        Array.isArray(blockedMigration.activePlaylists) &&
        blockedMigration.activePlaylists.some((entry) => entry.id === blockedPlaylist.id)
      );
      await blockedPlaylist.stopAll();
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
    } else if (scenario === "soundscapeGroups") {
      playlist = await createFixturePlaylist(runId, scenario, {
        mode: playlistMode("DISABLED", -1),
        fade: 0,
        flags: {
          soundscapeMode: true,
          soundscapeMaxPolyphony: 3,
          soundscapeGroups: [{
            id: "weather",
            name: "Weather",
            maxPolyphony: 1,
            cooldownSec: 2,
          }],
        },
        sounds: [
          fixtureSound("Grouped Rain", {
            runId,
            scenario,
            path: createToneDataUri({ durationSec: 0.35, frequency: 330 }),
            flags: {
              isProcedural: true,
              soundscapeGroupId: "weather",
              minDelay: 10,
              maxDelay: 10,
              timingMode: "fixed",
              playChance: 100,
            },
          }),
          fixtureSound("Grouped Thunder", {
            runId,
            scenario,
            path: createToneDataUri({ durationSec: 0.35, frequency: 440 }),
            flags: {
              isProcedural: true,
              soundscapeGroupId: "weather",
              minDelay: 10,
              maxDelay: 10,
              timingMode: "fixed",
              playChance: 100,
            },
          }),
        ],
      });
      const [rain, thunder] = requireNamedPlaylistSounds(playlist, [
        "Grouped Rain",
        "Grouped Thunder",
      ]);
      await playlist.update({
        playing: true,
        sounds: [
          { _id: rain.id, playing: true, pausedTime: null },
          { _id: thunder.id, playing: true, pausedTime: null },
        ],
      });
      await api.startSoundscape(playlist);
      const engine = State.getSoundscapeEngine(playlist);
      await wait(150);

      record(tests, "group configuration and sound assignments round-trip", () =>
        Flags.getSoundscapeGroups(playlist).length === 1 &&
        Flags.getSoundscapeGroupForSound(rain)?.id === "weather" &&
        Flags.getSoundscapeGroupForSound(thunder)?.id === "weather"
      );

      const rainFired = await engine.fireOneShotNow(rain.id);
      const thunderBlockedByCap = await engine.fireOneShotNow(thunder.id);
      record(tests, "group cap blocks a second concurrent member", () =>
        rainFired === true &&
        thunderBlockedByCap === false &&
        engine.getGroupPolyphony("weather")?.occupied === 1
      );

      const rainCompleted = await waitForCondition(
        () =>
          engine.getActiveOneShotCount(rain.id) === 0 &&
          Number(engine.getGroupPolyphony("weather")?.nextEligibleAt) > Date.now(),
        { timeoutMs: 2000, intervalMs: 40 }
      );
      record(tests, "successful group member completion starts cooldown", () =>
        rainCompleted === true &&
        engine.getGroupPolyphony("weather")?.occupied === 0
      );

      const blockedBefore = engine.getGroupPolyphony("weather")?.blocked ?? 0;
      const automaticDuringCooldown = await engine._fireOneShot(thunder, {
        bypassChance: true,
      });
      record(tests, "automatic group fire respects cooldown", () =>
        automaticDuringCooldown === false &&
        (engine.getGroupPolyphony("weather")?.blocked ?? 0) > blockedBefore
      );

      const manualDuringCooldown = await engine.fireOneShotNow(thunder.id);
      const groupDiagnostics = engine.getDiagnostics().groups?.[0];
      record(tests, "Fire Now bypasses cooldown but still occupies the group cap", () =>
        manualDuringCooldown === true &&
        groupDiagnostics?.id === "weather" &&
        groupDiagnostics?.occupied === 1 &&
        groupDiagnostics?.max === 1
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

          // Persisted inactive silence gaps are intentionally removed by the
          // runtime recovery hook. Recreate this disposable fixture for each
          // synchronous shuffle assertion instead of depending on an orphan
          // document surviving across setting-update awaits.
          let gap = Array.from(playlist.sounds ?? [])
            .find((sound) => Flags.getSoundFlag(sound, "isSilenceGap"));
          if (!gap) {
            [gap] = await playlist.createEmbeddedDocuments("PlaylistSound", [
              fixtureSound("Shuffle Gap", {
                runId,
                scenario,
                frequency: 660,
                flags: { isSilenceGap: true },
              }),
            ]);
          }

          const playableIds = getPlayableFixtureIds(playlist);
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
      const sounds = requireNamedPlaylistSounds(playlist, [
        "Fade Logarithmic",
        "Fade Linear",
        "Fade S-Curve",
        "Fade Steep",
      ]);

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

          // AudioTimeout finishes through a Web Audio onended event. Its
          // delivery can trail a wall-clock sleep, especially on first use.
          const fadeInSettled = await waitForCondition(
            () => !!media && !State.isSoundFading(media),
            { timeoutMs: 1000, intervalMs: 20 }
          );
          record(tests, `${curve} fade-in token clears`, () => fadeInSettled);
          record(tests, `${curve} fade-in reaches useful gain`, () =>
            !!media && isGainAtLeast(media, Math.min(0.1, Number(soundDoc.volume ?? 0)))
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
          record(tests, `${curve} fade-out token clears`, () => !!media && !State.isSoundFading(media));
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

  for (const cleanup of scenarioCleanups.splice(0)) {
    try {
      cleanup();
    } catch (_) { }
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
    ...(failed.length > 0 && scenarioEvidence ? { evidence: scenarioEvidence } : {}),
    snapshot: playlist ? summarizePlaylist(playlist) : null,
  };
}

async function persistFixtureStage(playlist, name) {
  if (!isFixturePlaylist(playlist)) throw new Error("Stage recording requires an owned diagnostic fixture.");
  const stage = {
    name,
    at: Date.now(),
    userId: game.user?.id ?? null,
    playlistPlaying: Boolean(playlist.playing),
    sounds: Array.from(playlist.sounds ?? []).slice(0, 4).map((sound) => ({
      id: sound.id,
      playing: Boolean(sound.playing),
      mediaLoaded: Boolean(sound.sound?.loaded),
      mediaPlaying: Boolean(sound.sound?.playing),
      mediaState: sound.sound?._state ?? null,
      mediaTime: Number.isFinite(sound.sound?.currentTime) ? sound.sound.currentTime : null,
      mediaDuration: Number.isFinite(sound.sound?.duration) ? sound.sound.duration : null,
    })),
  };
  await playlist.update({ [`flags.${MODULE_ID}.${FIXTURE_FLAG}.stage`]: stage }, {
    render: false,
    noHook: true,
  });
}

async function runFixtureStage(playlist, name, action) {
  await persistFixtureStage(playlist, `${name}:before`);
  const result = await action();
  await persistFixtureStage(playlist, `${name}:after`);
  return result;
}

async function runTransitionFallbackPhase(api, playlist, tests, source, target, phase, endMode) {
  if (phase === "setup") {
    await persistFixtureStage(playlist, "setup:complete");
    record(tests, "transition fixture is created without playback", () => !playlist.playing && !getPlayingSound(playlist));
    return;
  }
  if (phase === "load") {
    for (const sound of [source, target]) {
      await runFixtureStage(playlist, `load:${sound.id}`, () => sound.load());
      record(tests, `${sound.name} loads without playback`, () => sound.sound?.loaded && !sound.sound.playing);
    }
    await persistFixtureStage(playlist, "load:complete");
    return;
  }

  const completeTrack = async (label) => {
    await runFixtureStage(playlist, `${label}.play`, () => playlist.playSound(source));
    const ready = await runFixtureStage(playlist, `${label}.ready`, () =>
      waitForPlayingSound(playlist, { soundId: source.id, requireMedia: true })
    );
    if (!ready) throw new Error(`${label} source media did not start.`);
    if (endMode === "natural") {
      return runFixtureStage(playlist, `${label}.natural-end`, () => waitForCondition(
        () => target.playing && target.sound?.playing && source.playing !== true,
        { timeoutMs: 2500, intervalMs: 40 }
      ));
    }
    // Native Sound stops its media before delivering the document end event.
    await runFixtureStage(playlist, `${label}.media-stop`, () => source.sound.stop());
    await runFixtureStage(playlist, `${label}.document-end`, () => source._onEnd());
    return runFixtureStage(playlist, `${label}.advance`, () => waitForCondition(
      () => getPlayingSound(playlist)?.id === target.id && source.playing !== true,
      { timeoutMs: 1000, intervalMs: 40 }
    ));
  };

  if (phase === "nativeReplay") {
    for (const iteration of [1, 2]) {
      const advanced = await completeTrack(`native-replay-${iteration}`);
      record(tests, `native replay ${iteration} advances to the next track`, () => advanced);
      await runFixtureStage(playlist, `native-replay-${iteration}.stop-all`, () => playlist.stopAll());
      if (iteration === 1) await wait(150);
    }
    await persistFixtureStage(playlist, "nativeReplay:complete");
    return;
  }

  if (phase === "all" || phase === "crossfade") {
    const advanced = await completeTrack("crossfade");
    record(tests, "zero-duration crossfade falls back to native advancement", () => advanced);
    record(tests, "zero-duration crossfade does not leave runtime state", () =>
      !State.isPlaylistCrossfading(playlist) && !State.getCrossfadeTimer(playlist)
    );
    await runFixtureStage(playlist, "crossfade.stop-all", () => playlist.stopAll());
  }
  if (phase === "all") {
    await wait(150);
    await runFixtureStage(playlist, "silence.configure", () => api.updatePlaylistConfig(playlist, {
      crossfade: false,
      silenceEnabled: true,
      silenceMode: "static",
      silenceDuration: 0,
    }));
  }
  if (phase === "all" || phase === "silence") {
    const advanced = await completeTrack("silence");
    record(tests, "zero-duration silence falls back to native advancement", () => advanced);
    record(tests, "zero-duration silence creates no gap state or document", () =>
      !State.hasSilenceState(playlist) && getSilenceGaps(playlist).length === 0
    );
    await runFixtureStage(playlist, "silence.stop-all", () => playlist.stopAll());
  }
  await persistFixtureStage(playlist, `${phase}:complete`);
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

async function compareClientDocumentState(collectDiagnostics, tests, playlist, expectedSoundId, {
  label,
  timeoutMs,
  expectPlaylistPlaying,
  expectLiveMedia,
  allowAnyLiveMedia = false,
  expectedSequenceKey = null,
} = {}) {
  const collect = () => collectDiagnostics({ timeoutMs, playlistIds: [playlist.id] });
  // Document updates can arrive before native or SoS fade completion. Observe
  // both clients until their media stops, then assert the final snapshots.
  const collection = expectLiveMedia === false
    ? await collectUntilSyncState(collect, (result) => result.clients.every((client) => {
      const snapshot = findSnapshotPlaylist(client, playlist.id);
      return !!snapshot && snapshot.playing === expectPlaylistPlaying &&
        getActiveSnapshotSoundIds(snapshot).length === 0 &&
        getLiveSoundsForPlaylist(client, playlist.id).length === 0;
    }), { timeoutMs: Math.max(1500, Number(playlist.fade ?? 0) + 1000) })
    : await collect();
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
        ? (allowAnyLiveMedia ? gmActiveIds.includes(expectedSoundId) : sameMembers(gmActiveIds, [expectedSoundId]))
        : gmActiveIds.length === 0,
      expectedSoundId,
      actualSoundIds: gmActiveIds,
    });
    recordClientLiveMediaAssertion(tests, gmClient, playlist.id, expectedSoundId, {
      label: `${label}: GM`,
      expectLiveMedia,
      allowAnyLiveMedia,
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
        ? (allowAnyLiveMedia ? activeIds.includes(expectedSoundId) : sameMembers(activeIds, [expectedSoundId]))
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
  return collection;
}

function recordNoGapSnapshots(tests, collection, playlistId, label) {
  for (const client of collection.clients) {
    const name = client.client?.userName ?? "Client";
    const snapshot = findSnapshotPlaylist(client, playlistId);
    record(tests, `${label}: ${name} has no leftover silence gap`, () =>
      !!snapshot && !snapshot.sounds.some((sound) => sound.isSilenceGap)
    );
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
      ? Boolean(matchingLiveSound?.playing) && (allowAnyLiveMedia || liveSounds.length === 1)
      : liveSounds.length === 0,
    liveSoundIds: liveSounds.map((sound) => sound.soundId),
    liveSounds: liveSounds.map((sound) => ({
      soundId: sound.soundId,
      playing: sound.playing,
      gainValue: sound.gainValue,
      volume: sound.volume,
      currentTime: sound.currentTime,
      duration: sound.duration,
      contextState: sound.contextState,
      isFading: sound.isFading,
    })),
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

  return { ready: true, reason: "audio ready" };
}

function findSnapshotPlaylist(client, playlistId) {
  return (client?.playlistDocuments ?? client?.documents?.playlists ?? [])
    .find((playlist) => playlist.id === playlistId) ?? null;
}

function findLoopSnapshot(client, playlistId, soundId) {
  const playlist = (client?.playlists ?? [])
    .find((entry) => entry.playlistId === playlistId) ?? null;
  return (playlist?.features?.loops ?? [])
    .find((loop) => loop.soundId === soundId) ?? null;
}

function findSoundscapeSnapshot(client, playlistId) {
  return (client?.soundscapes ?? [])
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
  const beforeCounts = getWorldDocumentCounts();
  const playlists = getFixturePlaylists(runId);
  let playlistsDeleted = 0;
  let foldersDeleted = 0;

  if (stopFirst) {
    for (const playlist of playlists) {
      try {
        const traceFallback = playlist.getFlag(MODULE_ID, FIXTURE_FLAG)?.scenario === "transitionFallbacks";
        if (traceFallback) await persistFixtureStage(playlist, "fixture-delete-cleanup:before");
        await api.cleanup(playlist, {
          cleanSilence: true,
          cleanCrossfade: true,
          cleanLoopers: true,
          cleanSoundscape: true,
          allowFadeOut: false,
        });
        if (playlist.playing) await playlist.stopAll();
        if (traceFallback) await persistFixtureStage(playlist, "fixture-delete-cleanup:after");
      } catch (_) {
        // Keep cleanup best-effort and continue deleting other proven fixtures.
      }
    }
  }

  for (const playlist of playlists) {
    if (!isFixturePlaylist(playlist, runId)) continue;
    if (playlist.getFlag(MODULE_ID, FIXTURE_FLAG)?.scenario === "transitionFallbacks") {
      await persistFixtureStage(playlist, "fixture-delete:before");
    }
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
    documentCounts: {
      before: beforeCounts,
      after: getWorldDocumentCounts(),
    },
    remainingFixtures: getPlaybackFixtureCounts(runId),
  };
}

async function createFixturePlaylist(runId, scenario, { mode, fade = 1, flags = {}, sounds = [] } = {}) {
  const folder = await ensureFixtureFolder();
  const fixtureName = `${FIXTURE_PREFIX}${scenario} ${runId}`;
  const playlist = await Playlist.create({
    name: fixtureName,
    mode,
    fade,
    folder: folder?.id ?? null,
    flags: {
      [MODULE_ID]: {
        ...flags,
        [FIXTURE_FLAG]: createFixtureMarker({
          kind: "playlist",
          runId,
          scenario,
          fixtureName,
        }),
      },
    },
  });

  if (!playlist) throw new Error(`Failed to create fixture playlist for ${scenario}.`);
  if (sounds.length > 0) {
    if (scenario === "transitionFallbacks") await persistFixtureStage(playlist, "fixture-sounds:before");
    const createdSounds = await playlist.createEmbeddedDocuments("PlaylistSound", sounds);
    for (const created of createdSounds) {
      const original = sounds.find((sound) => sound.name === created.name);
      // Foundry can upload a data URI and replace it with a world asset URL.
      // Reuse that proven fixture URL in subsequent scenarios in this world.
      resolveFixtureAudio.rememberCreatedPath({
        sourcePath: original?.path,
        path: created.path,
        worldId: game.world?.id,
      });
    }
    if (scenario === "transitionFallbacks") await persistFixtureStage(playlist, "fixture-sounds:after");
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
  frequency = 440,
  path = null,
  repeat = false,
  volume = 0.25,
  flags = {},
} = {}) {
  return {
    name,
    path: resolveFixtureAudio({ path, frequency, worldId: game.world?.id }),
    repeat,
    volume,
    flags: {
      [MODULE_ID]: {
        ...flags,
        [FIXTURE_FLAG]: createFixtureMarker({
          kind: "sound",
          runId,
          scenario,
          fixtureName: name,
        }),
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
          [FIXTURE_FLAG]: createFixtureMarker({
            kind: "folder",
            fixtureName: FIXTURE_FOLDER_NAME,
          }),
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
  const marker = folder?.getFlag?.(MODULE_ID, FIXTURE_FLAG);
  const fixtureName = String(marker?.fixtureName ?? "");
  return Boolean(
    marker?.kind === "folder" &&
    isCurrentWorldFixtureMarker(marker) &&
    String(folder?.name ?? "").startsWith(FIXTURE_PREFIX) &&
    fixtureName.startsWith(FIXTURE_PREFIX)
  );
}

function getFixturePlaylists(runId = null) {
  return collectionToArray(game.playlists).filter((playlist) => isFixturePlaylist(playlist, runId));
}

function isFixturePlaylist(playlist, runId = null) {
  const marker = playlist?.getFlag?.(MODULE_ID, FIXTURE_FLAG);
  if (!marker || marker.kind !== "playlist") return false;
  if (!isCurrentWorldFixtureMarker(marker)) return false;
  if (!String(playlist.name ?? "").startsWith(FIXTURE_PREFIX)) return false;
  if (!String(marker.fixtureName ?? "").startsWith(FIXTURE_PREFIX)) return false;
  if (runId && marker.runId !== runId) return false;
  return true;
}

function createFixtureMarker({ kind, runId = null, scenario = null, fixtureName }) {
  return {
    kind,
    runId,
    scenario,
    fixtureName,
    worldId: String(game.world?.id ?? ""),
    sceneId: canvas?.scene?.id ?? null,
    createdAt: new Date().toISOString(),
  };
}

function isCurrentWorldFixtureMarker(marker) {
  return String(marker?.worldId ?? "") === String(game.world?.id ?? "");
}

async function stopFixturePlaylists(api, runId) {
  for (const playlist of getFixturePlaylists(runId)) {
    try {
      const traceFallback = playlist.getFlag(MODULE_ID, FIXTURE_FLAG)?.scenario === "transitionFallbacks";
      if (traceFallback) await persistFixtureStage(playlist, "fixture-stop-cleanup:before");
      await api.cleanup(playlist, {
        cleanSilence: true,
        cleanCrossfade: true,
        cleanLoopers: true,
        cleanSoundscape: true,
        allowFadeOut: false,
      });
      if (playlist.playing || collectionToArray(playlist.sounds).some((sound) => sound.playing)) {
        await playlist.stopAll();
      }
      if (traceFallback) await persistFixtureStage(playlist, "fixture-stop-cleanup:after");
    } catch (_) {
      // Continue stopping this run's fixtures; final cleanup reports deletion failures.
    }
  }
  await wait(250);
}

async function requirePlaylistSidebar() {
  const result = await activatePlaylistSidebar();
  if (!result.success) {
    throw new Error("Unable to initialize Foundry's Playlists sidebar for audio automation: " + result.error);
  }
  return result;
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

async function waitForPromiseSettlement(promise, { timeoutMs = 2500 } = {}) {
  const result = {
    settled: false,
    value: undefined,
    error: null,
  };

  Promise.resolve(promise).then(
    (value) => {
      result.settled = true;
      result.value = value;
    },
    (err) => {
      result.settled = true;
      result.error = err instanceof Error ? err.message : String(err);
    }
  );

  await waitForCondition(() => result.settled, { timeoutMs, intervalMs: 25 });
  return result;
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
      soundscapeGroupId: Flags.getSoundFlag(sound, "soundscapeGroupId") || null,
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
