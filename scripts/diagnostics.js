/**
 * @file diagnostics.js
 * @description Safe, allowlisted diagnostics actions for MCP bridge callers.
 */
import { Flags } from "./flag-service.js";
import { Integrations } from "./integrations.js";
import {
  FIXTURE_FLAG,
  FIXTURE_PREFIX,
  createPlaybackAutomation,
  getClientSyncAutomationScenarios,
  getPlaybackFixtureCounts,
  getPlaybackAutomationActionNames,
  getPlaybackAutomationControlOperations,
  getPlaybackAutomationScenarios,
} from "./diagnostics-playback-automation.js";
import {
  MODULE_ID,
  SoundOfSilenceDiagnostics,
  formatTime,
  toSec,
} from "./utils.js";

const READ_ONLY_ACTIONS = [
  "getStatus",
  "validateSettings",
  "validateAssets",
  "collectClientDiagnostics",
  "runSmokeTests",
  "openWindow",
  "parseText",
  "validateText",
  "refreshClient",
];

const MUTATING_ACTIONS = [
  "runAutomation",
  "cleanupFixtures",
  ...getPlaybackAutomationActionNames(),
];

const ACTION_NAMES = [...READ_ONLY_ACTIONS, ...MUTATING_ACTIONS];

const SETTINGS_SCHEMA = Object.freeze({
  debug: { type: "boolean" },
  debugCurrentlyPlayingTimestamps: { type: "boolean" },
  enableMcpDiagnostics: { type: "boolean" },
  personalPlaylistVolumeEnabled: { type: "boolean" },
  personalPlaylistVolumes: { type: "object" },
  personalTrackVolumes: { type: "object" },
  soundscapeProceduralSyncEnabled: { type: "boolean" },
  shufflePattern: {
    type: "string",
    choices: ["foundry-default", "exhaustive", "weighted-random", "round-robin"],
  },
  fadeInCurveType: { type: "string", choices: ["logarithmic", "linear", "s-curve", "steep"] },
  fadeOutCurveType: { type: "string", choices: ["logarithmic", "linear", "s-curve", "steep"] },
});

const MODULE_ASSETS = Object.freeze([
  "module.json",
  "README.md",
  "scripts/main.js",
  "scripts/api.js",
  "scripts/settings.js",
  "scripts/diagnostics.js",
  "scripts/diagnostics-playback-automation.js",
  "scripts/flag-service.js",
  "scripts/legacy-loop-migration.js",
  "templates/diagnostics.hbs",
  "templates/remote-diagnostics.hbs",
  "styles/diagnostics.css",
]);

const VALIDATION_KINDS = ["playlistFlags", "soundFlags", "loopConfig"];
const TIME_PATTERN = /^\d{1,3}:\d{2}(?:\.\d{1,3})?$/;
const SOCKET_CHANNEL = `module.${MODULE_ID}`;

export function createSoundOfSilenceDiagnostics(api) {
  const playbackAutomation = createPlaybackAutomation(api);
  const actions = {
    getStatus: (args = {}) => withGate("getStatus", (availability) => getStatus(api, args, availability)),
    validateSettings: (args = {}) => withGate("validateSettings", () => validateSettings(args)),
    validateAssets: (args = {}) => withGate("validateAssets", () => validateAssets(args)),
    collectClientDiagnostics: (args = {}) => withGate("collectClientDiagnostics", () =>
      api.collectClientDiagnostics(args)
    ),
    runSmokeTests: (args = {}) => withGate("runSmokeTests", () => runSmokeTests(api, args)),
    openWindow: (args = {}) => withGate("openWindow", () => openWindow(api, args)),
    parseText: (args = {}) => withGate("parseText", () => parseText(args)),
    validateText: (args = {}) => withGate("validateText", () => validateText(args)),
    refreshClient: (args = {}) => withRefreshGate("refreshClient", args, () => refreshClient(args)),
    runAutomation: (args = {}) => withMutationGate("runAutomation", args, () =>
      playbackAutomation.runAutomation(args)
    ),
    cleanupFixtures: (args = {}) => withMutationGate("cleanupFixtures", args, () =>
      playbackAutomation.cleanupFixtures(args)
    ),
    controlPlayback: (args = {}) => withMutationGate("controlPlayback", args, () =>
      playbackAutomation.controlPlayback(args)
    ),
    runPlaybackAutomation: (args = {}) => withMutationGate("runPlaybackAutomation", args, () =>
      playbackAutomation.runPlaybackAutomation(args)
    ),
    runClientSyncAutomation: (args = {}) => withMutationGate("runClientSyncAutomation", args, () =>
      playbackAutomation.runClientSyncAutomation(args)
    ),
    cleanupPlaybackFixtures: (args = {}) => withMutationGate("cleanupPlaybackFixtures", args, () =>
      playbackAutomation.cleanupPlaybackFixtures(args)
    ),
  };

  return {
    version: 1,
    socketChannel: SOCKET_CHANNEL,
    actions,
    getAvailability,
    getMutationAvailability,
    getPlaybackAutomationAvailability: getMutationAvailability,
    getRefreshAvailability,
  };
}

function withGate(action, fn) {
  const availability = getAvailability();
  if (!availability.available) {
    throw new Error(
      `${MODULE_ID} diagnostics are unavailable for "${action}": ${availability.reason}`
    );
  }
  return fn(availability);
}

function withMutationGate(action, args, fn) {
  const availability = getMutationAvailability(args);
  if (!availability.available) {
    throw new Error(
      `${MODULE_ID} mutating diagnostics are unavailable for "${action}": ${availability.reason}`
    );
  }
  return fn(availability);
}

function withRefreshGate(action, args, fn) {
  const availability = getRefreshAvailability(args);
  if (!availability.available) {
    throw new Error(
      `${MODULE_ID} client refresh diagnostics are unavailable for "${action}": ${availability.reason}`
    );
  }
  return fn(availability);
}

function getAvailability() {
  const activeGMUser = Boolean(game.user?.isGM && game.user?.active !== false);
  const debugLogging = getSetting("debug", false) === true;
  const enableMcpDiagnostics = getSetting("enableMcpDiagnostics", false) === true;
  const mutationEnabled = enableMcpDiagnostics;
  const refreshEnabled = activeGMUser && debugLogging && enableMcpDiagnostics;
  const missing = [];

  if (!activeGMUser) missing.push("active GM user");
  if (!debugLogging) missing.push("Enable Debug Logging setting");
  if (!enableMcpDiagnostics) missing.push("Enable MCP Diagnostics setting");

  return {
    available: missing.length === 0,
    reason: missing.length ? `Missing ${missing.join(", ")}` : "Available",
    gates: {
      activeGMUser,
      debugLogging,
      enableMcpDiagnostics,
      mutationEnabled,
      refreshEnabled,
    },
  };
}

function getMutationAvailability(args = {}) {
  const base = getAvailability();
  const mutationEnabled = base.gates.enableMcpDiagnostics === true;
  const mutationConfirmed = args.confirmMutation === true;
  const missing = [];

  if (!base.gates.activeGMUser) missing.push("active GM user");
  if (!base.gates.debugLogging) missing.push("Enable Debug Logging setting");
  if (!base.gates.enableMcpDiagnostics) missing.push("Enable MCP Diagnostics setting");
  if (!mutationConfirmed) missing.push("confirmMutation: true");

  return {
    available: missing.length === 0,
    reason: missing.length ? `Missing ${missing.join(", ")}` : "Available",
    gates: {
      ...base.gates,
      mutationEnabled,
      mutationConfirmed,
    },
  };
}

function getRefreshAvailability(args = {}) {
  const base = getAvailability();
  const refreshConfirmed = args.confirmRefresh === true;
  const missing = [];

  if (!base.gates.activeGMUser) missing.push("active GM user");
  if (!base.gates.debugLogging) missing.push("Enable Debug Logging setting");
  if (!base.gates.enableMcpDiagnostics) missing.push("Enable MCP Diagnostics setting");
  if (!refreshConfirmed) missing.push("confirmRefresh: true");

  return {
    available: missing.length === 0,
    reason: missing.length ? `Missing ${missing.join(", ")}` : "Available",
    gates: {
      ...base.gates,
      refreshConfirmed,
    },
  };
}

function getPlaybackAutomationStatus() {
  const base = getAvailability();
  const automationEnabled = base.gates.enableMcpDiagnostics === true;
  return {
    configured: base.available && automationEnabled,
    confirmMutationRequired: true,
    gates: {
      ...base.gates,
      mutationEnabled: automationEnabled,
    },
    actions: [...MUTATING_ACTIONS],
    controlOperations: getPlaybackAutomationControlOperations(),
    scenarios: getPlaybackAutomationScenarios(),
    clientSyncScenarios: getClientSyncAutomationScenarios(),
  };
}

function getSetting(key, fallback = null) {
  try {
    return game.settings?.get(MODULE_ID, key) ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function readSetting(key) {
  try {
    return game.settings?.get(MODULE_ID, key);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function getSettingsSnapshot() {
  return Object.fromEntries(
    Object.keys(SETTINGS_SCHEMA).map((key) => [key, readSetting(key)])
  );
}

function summarizeRuntime() {
  return {
    foundry: {
      version: game.version ?? null,
      release: game.release?.display ?? game.release?.version ?? null,
    },
    system: {
      id: game.system?.id ?? null,
      title: game.system?.title ?? null,
      version: game.system?.version ?? null,
    },
    world: {
      id: game.world?.id ?? null,
      title: game.world?.title ?? null,
    },
    user: {
      id: game.user?.id ?? null,
      name: game.user?.name ?? null,
      isGM: Boolean(game.user?.isGM),
      active: game.user?.active !== false,
    },
    scene: {
      id: canvas?.scene?.id ?? null,
      name: canvas?.scene?.name ?? null,
      ready: Boolean(canvas?.ready),
    },
  };
}

function issue(code, message, data = {}) {
  return { code, message, ...data };
}

function getStatus(api, _args, availability) {
  const modulePackage = game.modules?.get?.(MODULE_ID);
  const playlists = Array.from(game.playlists ?? []);
  const playlistSoundCount = playlists.reduce(
    (total, playlist) => total + Number(playlist.sounds?.size ?? playlist.sounds?.length ?? 0),
    0
  );

  return {
    success: true,
    module: {
      id: MODULE_ID,
      title: modulePackage?.title ?? "The Sound of Silence",
      active: Boolean(modulePackage?.active),
      version: modulePackage?.version ?? modulePackage?.manifest?.version ?? null,
    },
    diagnostics: {
      version: 1,
      available: availability.available,
      gates: availability.gates,
      availableActions: [...ACTION_NAMES],
      readOnlyActions: [...READ_ONLY_ACTIONS],
      mutatingActions: [...MUTATING_ACTIONS],
      bridge: "call-module-debug-action",
      fixturePrefix: FIXTURE_PREFIX,
      fixtureFlag: FIXTURE_FLAG,
      mutation: {
        confirmMutationRequired: true,
        gates: getMutationAvailability({ confirmMutation: false }).gates,
      },
      refresh: {
        confirmRefreshRequired: true,
        gates: getRefreshAvailability({ confirmRefresh: false }).gates,
      },
      playbackAutomation: getPlaybackAutomationStatus(),
    },
    runtime: summarizeRuntime(),
    settings: {
      debug: getSetting("debug", false),
      enableMcpDiagnostics: getSetting("enableMcpDiagnostics", false),
      debugCurrentlyPlayingTimestamps: getSetting("debugCurrentlyPlayingTimestamps", false),
      personalPlaylistVolumeEnabled: getSetting("personalPlaylistVolumeEnabled", false),
      soundscapeProceduralSyncEnabled: getSetting("soundscapeProceduralSyncEnabled", true),
      shufflePattern: getSetting("shufflePattern", null),
      fadeInCurveType: getSetting("fadeInCurveType", null),
      fadeOutCurveType: getSetting("fadeOutCurveType", null),
    },
    foundry: {
      version: game.version ?? null,
      system: {
        id: game.system?.id ?? null,
        title: game.system?.title ?? null,
        version: game.system?.version ?? null,
      },
      world: {
        id: game.world?.id ?? null,
        title: game.world?.title ?? null,
      },
      user: {
        id: game.user?.id ?? null,
        name: game.user?.name ?? null,
        isGM: Boolean(game.user?.isGM),
        active: game.user?.active !== false,
      },
    },
    worldData: {
      playlists: playlists.length,
      playlistSounds: playlistSoundCount,
      scenes: Number(game.scenes?.size ?? game.scenes?.length ?? 0),
      actors: Number(game.actors?.size ?? game.actors?.length ?? 0),
      items: Number(game.items?.size ?? game.items?.length ?? 0),
      journals: Number(game.journal?.size ?? game.journal?.length ?? 0),
      compendiumPacks: Number(game.packs?.size ?? game.packs?.length ?? 0),
    },
    fixtures: getPlaybackFixtureCounts(),
    integrations: Integrations.diagnostics(),
    audio: getAudioSnapshot(playlists),
    playback: api.inspectAll(),
    publicApiKeys: Object.keys(modulePackage?.api ?? {}).sort(),
  };
}

function getAudioSnapshot(playlists = []) {
  const audio = game.audio ?? null;
  const documentPlayingSounds = [];
  let soundDocumentsWithMedia = 0;
  let playingMediaObjects = 0;

  for (const playlist of playlists) {
    for (const sound of Array.from(playlist.sounds ?? [])) {
      const media = sound?.sound ?? null;
      if (media) soundDocumentsWithMedia += 1;
      if (media?.playing) playingMediaObjects += 1;
      if (!sound?.playing) continue;

      documentPlayingSounds.push({
        playlistId: playlist.id ?? null,
        playlistName: playlist.name ?? null,
        soundId: sound.id ?? null,
        soundName: sound.name ?? null,
        path: sound.path ?? null,
        hasMedia: Boolean(media),
        mediaPlaying: Boolean(media?.playing),
        mediaDuration: finiteNumberOrNull(media?.duration),
        documentDuration: finiteNumberOrNull(sound.duration),
      });
    }
  }

  return {
    available: Boolean(audio),
    locked: booleanOrNull(audio?.locked),
    unlocked: booleanOrNull(audio?.unlocked),
    contexts: {
      music: summarizeAudioContext(audio?.music),
      environment: summarizeAudioContext(audio?.environment),
      interface: summarizeAudioContext(audio?.interface),
    },
    soundDocumentsWithMedia,
    playingMediaObjects,
    documentPlayingSounds,
  };
}

function summarizeAudioContext(context) {
  return {
    available: Boolean(context),
    state: typeof context?.state === "string" ? context.state : null,
    sampleRate: finiteNumberOrNull(context?.sampleRate),
    currentTime: finiteNumberOrNull(context?.currentTime),
  };
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseText(args) {
  const text = normalizeRequiredString(args.text, "text");
  const mode = String(args.mode ?? args.kind ?? "time").trim();
  if (mode !== "time") {
    return {
      success: false,
      error: `Unsupported parse mode "${mode}". Supported modes: time.`,
    };
  }

  const input = text.trim();
  const parseable = TIME_PATTERN.test(input);
  const seconds = parseable ? toSec(input) : null;
  const normalized = parseable ? formatTime(seconds, input.includes(".")) : null;

  return {
    success: true,
    kind: "time",
    input,
    parseable,
    validGeneratedData: parseable,
    mechanicallyUseful: parseable && Number.isFinite(seconds) && seconds >= 0,
    seconds,
    normalized,
  };
}

function validateText(args) {
  const text = normalizeRequiredString(args.text, "text");
  const explicitKind = args.kind ? String(args.kind).trim() : null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      success: true,
      parseable: false,
      validGeneratedData: false,
      mechanicallyUseful: false,
      error: err instanceof Error ? err.message : "Invalid JSON",
    };
  }

  const kind = explicitKind || inferValidationKind(parsed);
  if (!VALIDATION_KINDS.includes(kind)) {
    return {
      success: false,
      parseable: true,
      validGeneratedData: false,
      mechanicallyUseful: false,
      error: `Unsupported validation kind. Use one of: ${VALIDATION_KINDS.join(", ")}.`,
    };
  }

  const input = unwrapValidationInput(parsed, kind);
  if (!isPlainObject(input)) {
    return {
      success: true,
      kind,
      parseable: true,
      validGeneratedData: false,
      mechanicallyUseful: false,
      error: `${kind} must be a JSON object.`,
    };
  }

  const result = validateByKind(kind, input);
  return {
    success: true,
    kind,
    parseable: true,
    validGeneratedData: result.issues.length === 0,
    mechanicallyUseful: result.mechanicallyUseful,
    issues: result.issues,
    sanitized: result.sanitized,
  };
}

async function openWindow(api, args) {
  const mode = String(args.mode ?? "local").trim();
  if (mode === "local") {
    new SoundOfSilenceDiagnostics().render({ force: true });
    return {
      success: true,
      opened: "local",
    };
  }

  if (mode === "remote") {
    await api.requestClientDiagnostics();
    return {
      success: true,
      opened: "remote",
    };
  }

  return {
    success: false,
    error: `Unsupported window mode "${mode}". Supported modes: local, remote.`,
  };
}

async function validateSettings(_args = {}) {
  const settings = getSettingsSnapshot();
  const errors = [];
  const warnings = [];

  for (const [key, schema] of Object.entries(SETTINGS_SCHEMA)) {
    const value = settings[key];
    if (value && typeof value === "object" && "error" in value) {
      errors.push(issue("setting-read-error", `Could not read setting "${key}".`, { key, value }));
      continue;
    }

    if (schema.type === "boolean" && typeof value !== "boolean") {
      errors.push(issue("invalid-boolean-setting", `Setting "${key}" must be a boolean.`, { key, value }));
    } else if (schema.type === "string" && typeof value !== "string") {
      errors.push(issue("invalid-string-setting", `Setting "${key}" must be a string.`, { key, value }));
    } else if (schema.type === "object" && !isPlainObject(value)) {
      errors.push(issue("invalid-object-setting", `Setting "${key}" must be an object.`, { key, value }));
    }

    if (schema.choices && !schema.choices.includes(value)) {
      errors.push(issue(
        "invalid-choice-setting",
        `Setting "${key}" must be one of: ${schema.choices.join(", ")}.`,
        { key, value }
      ));
    }
  }

  if (settings.enableMcpDiagnostics === true) {
    warnings.push(issue(
      "mutating-diagnostics-enabled",
      "Enable MCP Diagnostics is on; it also unlocks confirmed MCP automation. Disable it during normal play.",
      { key: "enableMcpDiagnostics" }
    ));
  }

  return {
    success: errors.length === 0,
    checked: Object.keys(SETTINGS_SCHEMA).length,
    errors,
    warnings,
    settings,
  };
}

async function validateAssets(args = {}) {
  const maxChecks = Math.max(1, Math.min(Number(args.maxChecks) || MODULE_ASSETS.length, MODULE_ASSETS.length));
  const checkedAssets = [];
  const errors = [];

  for (const path of MODULE_ASSETS.slice(0, maxChecks)) {
    const url = `modules/${MODULE_ID}/${path}`;
    let ok = false;
    let status = null;
    try {
      const response = await fetch(url, { method: "GET", cache: "no-store" });
      ok = response.ok;
      status = response.status;
    } catch (err) {
      errors.push(issue("asset-fetch-error", `Could not fetch ${path}.`, {
        path,
        error: err instanceof Error ? err.message : String(err),
      }));
    }

    checkedAssets.push({ path, ok, status });
    if (!ok && status !== null) {
      errors.push(issue("asset-missing", `Asset ${path} returned HTTP ${status}.`, { path, status }));
    }
  }

  return {
    success: errors.length === 0,
    checked: checkedAssets.length,
    assets: checkedAssets,
    errors,
  };
}

async function refreshClient(args = {}) {
  const delayMs = Math.max(0, Math.min(Number(args.delayMs) || 250, 5000));
  window.setTimeout(() => window.location.reload(), delayMs);
  return {
    success: true,
    initiated: true,
    delayMs,
  };
}

async function runSmokeTests(api) {
  const tests = [];
  const beforeCounts = getWorldDocumentCounts();

  record(tests, "diagnostics gate is open", () => getAvailability().available === true);
  record(tests, "actions are allowlisted functions", () => {
    const actual = Object.keys(api.diagnostics?.actions ?? {}).sort();
    const expected = [...ACTION_NAMES].sort();
    return (
      actual.length === expected.length &&
      actual.every((name, index) => name === expected[index]) &&
      actual.every((name) => typeof api.diagnostics.actions[name] === "function")
    );
  });
  record(tests, "remote diagnostics gate mirrors current settings", () =>
    typeof api._isRemoteDiagnosticsGateOpen === "function" &&
    api._isRemoteDiagnosticsGateOpen() === true
  );
  record(tests, "remote diagnostics rejects malformed request IDs", () =>
    typeof api._isDiagnosticsRequestIdValid === "function" &&
    api._isDiagnosticsRequestIdValid("abc12345") === true &&
    api._isDiagnosticsRequestIdValid("") === false &&
    api._isDiagnosticsRequestIdValid("not valid") === false
  );
  record(tests, "remote diagnostics requires an active GM sender", () => {
    if (typeof api._resolveActiveGMSocketSender !== "function") return false;
    const activeGM = Array.from(game.users ?? []).find((user) => user?.isGM && user.active !== false);
    if (!activeGM) return false;
    return api._resolveActiveGMSocketSender(activeGM.id)?.id === activeGM.id &&
      api._resolveActiveGMSocketSender("not-a-user") === null;
  });
  record(tests, "time parser accepts valid fixture", () => {
    const parsed = parseText({ text: "01:30.500" });
    return parsed.parseable === true && parsed.seconds === 90.5 && parsed.normalized === "01:30.500";
  });
  record(tests, "time parser rejects bad fixture", () => {
    const parsed = parseText({ text: "not time" });
    return parsed.parseable === false && parsed.seconds === null;
  });
  record(tests, "playlist flag validator accepts useful fixture", () => {
    const result = validateText({
      kind: "playlistFlags",
      text: JSON.stringify({ crossfade: true, useCustomAutoFade: true, customAutoFadeMs: 1500 }),
    });
    return result.parseable && result.validGeneratedData && result.mechanicallyUseful;
  });
  record(tests, "sound flag validator reports bad enum fixture", () => {
    const result = validateText({
      kind: "soundFlags",
      text: JSON.stringify({ isProcedural: true, timingMode: "bad-mode" }),
    });
    return result.parseable && !result.validGeneratedData && result.issues.length > 0;
  });
  record(tests, "loop config validator marks useful segments", () => {
    const result = validateText({
      kind: "loopConfig",
      text: JSON.stringify({
        enabled: true,
        active: true,
        segments: [{ start: "00:10.000", end: "00:20.000", crossfadeMs: 500, loopCount: 0 }],
      }),
    });
    return result.parseable && result.validGeneratedData && result.mechanicallyUseful;
  });
  record(tests, "loop config validator migrates legacy start/end as active", () => {
    const result = validateText({
      kind: "loopConfig",
      text: JSON.stringify({
        start: "00:10.000",
        end: "00:20.000",
        crossfadeMs: 500,
        loopCount: 0,
      }),
    });
    const segment = result.sanitized?.segments?.[0];
    return result.parseable &&
      result.mechanicallyUseful &&
      result.sanitized?.enabled === true &&
      result.sanitized?.active === true &&
      segment?.start === "00:10.000" &&
      segment?.end === "00:20.000";
  });

  const afterCounts = getWorldDocumentCounts();
  record(tests, "diagnostics created no world documents", () =>
    JSON.stringify(beforeCounts) === JSON.stringify(afterCounts)
  );

  const failed = tests.filter((test) => !test.pass);
  return {
    success: failed.length === 0,
    passed: tests.length - failed.length,
    failed: failed.length,
    tests,
    noCreateCounts: {
      before: beforeCounts,
      after: afterCounts,
    },
  };
}

function record(tests, name, fn) {
  try {
    const pass = fn() === true;
    tests.push({ name, pass });
  } catch (err) {
    tests.push({
      name,
      pass: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function inferValidationKind(parsed) {
  if (isPlainObject(parsed)) {
    if (isPlainObject(parsed.playlistFlags)) return "playlistFlags";
    if (isPlainObject(parsed.soundFlags)) return "soundFlags";
    if (isPlainObject(parsed.loopConfig)) return "loopConfig";
  }
  return null;
}

function unwrapValidationInput(parsed, kind) {
  if (isPlainObject(parsed?.[kind])) return parsed[kind];
  return parsed;
}

function validateByKind(kind, input) {
  if (kind === "playlistFlags") {
    const sanitized = Flags.validatePlaylistFlags(input);
    return buildValidationResult(input, sanitized, Flags.getPlaylistFlagKeys(), isUsefulPlaylistFlags);
  }

  if (kind === "soundFlags") {
    const sanitized = Flags.validateSoundFlags(input);
    return buildValidationResult(input, sanitized, Flags.getSoundFlagKeys(), isUsefulSoundFlags);
  }

  const sanitized = Flags.validateLoopConfig(input);
  return buildValidationResult(input, sanitized, Flags.getLoopConfigKeys(), isUsefulLoopConfig);
}

function buildValidationResult(input, sanitized, allowedKeys, usefulnessFn) {
  const allowed = new Set(allowedKeys);
  const issues = [];

  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      issues.push({ key, message: "Unknown key ignored by schema" });
      continue;
    }

    if (isPlainObject(input[key]) || Array.isArray(input[key])) {
      continue;
    }

    if (!jsonEqual(input[key], sanitized[key])) {
      issues.push({ key, message: "Value was sanitized or defaulted" });
    }
  }

  return {
    issues,
    sanitized,
    mechanicallyUseful: usefulnessFn(sanitized),
  };
}

function isUsefulPlaylistFlags(flags) {
  return Boolean(
    flags.crossfade ||
    flags.silenceEnabled ||
    flags.loopPlaylist ||
    flags.volumeNormalizationEnabled ||
    flags.soundscapeMode
  );
}

function isUsefulSoundFlags(flags) {
  return Boolean(
    flags.allowVolumeOverride ||
    flags.isProcedural ||
    isUsefulLoopConfig(flags.loopWithin)
  );
}

function isUsefulLoopConfig(loopConfig) {
  if (!loopConfig?.enabled || !Array.isArray(loopConfig.segments)) return false;
  return loopConfig.segments.some((segment) =>
    Number.isFinite(Number(segment.startSec)) &&
    Number.isFinite(Number(segment.endSec)) &&
    Number(segment.endSec) > Number(segment.startSec)
  );
}

function getWorldDocumentCounts() {
  const playlists = Array.from(game.playlists ?? []);
  return {
    actors: Number(game.actors?.size ?? game.actors?.length ?? 0),
    items: Number(game.items?.size ?? game.items?.length ?? 0),
    journals: Number(game.journal?.size ?? game.journal?.length ?? 0),
    scenes: Number(game.scenes?.size ?? game.scenes?.length ?? 0),
    playlists: playlists.length,
    playlistSounds: playlists.reduce(
      (total, playlist) => total + Number(playlist.sounds?.size ?? playlist.sounds?.length ?? 0),
      0
    ),
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
