/**
 * @file legacy-loop-migration.js
 * @description GM maintenance helper for permanently migrating legacy internal loop flags.
 */
import { Flags } from "./flag-service.js";
import { MODULE_ID } from "./utils.js";

const LEGACY_LOOP_KEYS = ["start", "end", "crossfadeMs", "loopCount", "skipCount"];
const ApplicationBase = foundry.applications?.api?.ApplicationV2 ?? globalThis.FormApplication;

export class LegacyLoopMigrationLauncher extends ApplicationBase {
  static DEFAULT_OPTIONS = {
    id: "sos-legacy-loop-migration-launcher",
    window: {
      title: "Sound of Silence - Migrate Legacy Loops",
    },
  };

  static get defaultOptions() {
    const base = super.defaultOptions ?? {};
    return foundry.utils.mergeObject(base, {
      id: "sos-legacy-loop-migration-launcher",
      title: "Sound of Silence - Migrate Legacy Loops",
    });
  }

  async render(_force = true, _options = {}) {
    await runLegacyLoopMigrationFromSettings();
    return this;
  }

  async close() {
    return this;
  }
}

export function inspectLegacyLoopMigration(args = {}) {
  return toPublicMigrationScan(scanLegacyLoopMigration(args));
}

export async function migrateLegacyLoopFlags(args = {}) {
  if (args.confirmLegacyLoopMigration !== true) {
    throw new Error("Missing confirmLegacyLoopMigration: true");
  }

  const playlistIds = normalizePlaylistIdFilter(args.playlistIds);
  const activePlaylists = getActivePlaybackPlaylists(playlistIds);
  if (activePlaylists.length > 0) {
    return {
      success: false,
      blocked: true,
      reason: "Stop all playlists before migrating legacy loop flags.",
      activePlaylists,
    };
  }

  const scan = scanLegacyLoopMigration({
    maxCandidateSummaries: Number.MAX_SAFE_INTEGER,
    includeRecords: true,
    playlistIds,
  });
  const migrated = [];
  const skipped = [];
  const errors = [];

  for (const record of scan.records) {
    try {
      await replaceLoopWithinFlag(record.sound, record.persistent, record.original);
      migrated.push(record.summary);
    } catch (err) {
      errors.push({
        ...record.summary,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const skippedRecord of scan.skippedRecords) {
    skipped.push(skippedRecord.summary);
  }

  return {
    success: errors.length === 0,
    blocked: false,
    scannedPlaylists: scan.scannedPlaylists,
    scannedSounds: scan.scannedSounds,
    candidates: scan.candidates,
    migrated: migrated.length,
    skipped: skipped.length,
    errors: errors.length,
    alreadyCurrent: scan.alreadyCurrent,
    notUsefulLegacy: scan.notUsefulLegacy,
    migratedSounds: migrated,
    skippedSounds: skipped,
    errorSounds: errors,
  };
}

async function runLegacyLoopMigrationFromSettings() {
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("Only a GM can migrate legacy loop flags.");
    return;
  }

  let status;
  try {
    status = inspectLegacyLoopMigration({ maxCandidateSummaries: 5 });
  } catch (err) {
    ui.notifications?.error?.(`Legacy loop migration scan failed: ${err?.message ?? err}`);
    return;
  }

  if (status.blockedByActivePlayback) {
    const names = status.activePlaylists?.map((playlist) => playlist.name).filter(Boolean).join(", ");
    ui.notifications?.warn?.(`Stop all playlists before migrating legacy loops.${names ? ` Active: ${names}` : ""}`);
    return;
  }

  if (!status.candidates) {
    ui.notifications?.info?.("No legacy internal loop flags need migration.");
    return;
  }

  const confirmed = await confirmLegacyLoopMigration(status);
  if (!confirmed) return;

  try {
    const result = await migrateLegacyLoopFlags({ confirmLegacyLoopMigration: true });
    if (result.blocked) {
      const names = result.activePlaylists?.map((playlist) => playlist.name).filter(Boolean).join(", ");
      ui.notifications?.warn?.(`${result.reason}${names ? ` Active: ${names}` : ""}`);
    } else if (result.success) {
      ui.notifications?.info?.(`Legacy loop migration complete: ${result.migrated} migrated, ${result.skipped} skipped, ${result.errors} errors.`);
    } else {
      ui.notifications?.warn?.(`Legacy loop migration finished with ${result.errors} error(s). ${result.migrated} migrated.`);
    }
  } catch (err) {
    ui.notifications?.error?.(`Legacy loop migration failed: ${err?.message ?? err}`);
  }
}

async function confirmLegacyLoopMigration(status) {
  const count = Number(status?.candidates ?? 0);
  const content = `
    <div class="sos-migration-confirm">
      <p>This will permanently update ${count} playlist sound loop configuration(s) from the old flat format to the current segment format.</p>
      <ul>
        <li>Back up your world before running this migration.</li>
        <li>Stop all playlists before migrating.</li>
        <li>Existing segment-based loop configurations are left alone.</li>
      </ul>
      <p>Continue?</p>
    </div>
  `;
  const dialog = foundry.applications?.api?.DialogV2;
  if (typeof dialog?.confirm === "function") {
    return dialog.confirm({
      window: { title: "Sound of Silence - Migrate Legacy Loops" },
      content,
      yes: {
        icon: "fas fa-database",
        label: "Migrate Legacy Loops",
      },
      no: {
        icon: "fas fa-times",
        label: "Cancel",
      },
      rejectClose: false,
    });
  }

  return window.confirm(`Migrate ${count} legacy loop configuration(s)? Back up your world and stop all playlists first.`);
}

function scanLegacyLoopMigration({ maxCandidateSummaries = 50, includeRecords = false, playlistIds = null } = {}) {
  const maxSummaries = Math.max(0, Math.min(Number(maxCandidateSummaries) || 0, 500));
  const playlistIdFilter = normalizePlaylistIdFilter(playlistIds);
  const records = [];
  const skippedRecords = [];
  const candidateSummaries = [];
  const notUsefulSummaries = [];
  let scannedPlaylists = 0;
  let scannedSounds = 0;
  let alreadyCurrent = 0;
  let candidates = 0;
  let notUsefulLegacy = 0;
  let legacyLike = 0;
  let noLoopConfig = 0;

  for (const playlist of getMigrationPlaylists(playlistIdFilter)) {
    scannedPlaylists++;
    for (const sound of Array.from(playlist.sounds ?? [])) {
      scannedSounds++;
      const classification = classifyLegacyLoopSound(playlist, sound);

      if (classification.status === "no-loop-config") {
        noLoopConfig++;
        continue;
      }

      if (classification.status === "already-current") {
        alreadyCurrent++;
        continue;
      }

      if (classification.legacyLike) legacyLike++;

      if (classification.status === "not-useful-legacy") {
        notUsefulLegacy++;
        const skipped = { summary: classification.summary };
        skippedRecords.push(skipped);
        if (notUsefulSummaries.length < maxSummaries) notUsefulSummaries.push(classification.summary);
        continue;
      }

      if (classification.status === "candidate") {
        candidates++;
        if (includeRecords) {
          records.push({
            playlist,
            sound,
            original: classification.raw,
            persistent: classification.persistent,
            summary: classification.summary,
          });
        }
        if (candidateSummaries.length < maxSummaries) candidateSummaries.push(classification.summary);
      }
    }
  }

  return {
    success: true,
    scannedPlaylists,
    scannedSounds,
    candidates,
    alreadyCurrent,
    notUsefulLegacy,
    legacyLike,
    noLoopConfig,
    candidateSummaries,
    notUsefulSummaries,
    candidateSummaryLimit: maxSummaries,
    candidateSummariesTruncated: candidates > candidateSummaries.length,
    activePlaylists: getActivePlaybackPlaylists(playlistIdFilter),
    playlistIds: playlistIdFilter ? Array.from(playlistIdFilter) : null,
    records,
    skippedRecords,
  };
}

function classifyLegacyLoopSound(playlist, sound) {
  const raw = sound.getFlag(MODULE_ID, "loopWithin");
  if (!isPlainObject(raw)) {
    return { status: "no-loop-config", legacyLike: false };
  }

  const legacyKeys = getLegacyLoopKeys(raw);
  const hasSegments = Object.prototype.hasOwnProperty.call(raw, "segments");
  const hasArraySegments = Array.isArray(raw.segments);
  const hasCurrentSegments = hasArraySegments && raw.segments.length > 0;
  const nonArraySegments = hasSegments && !hasArraySegments;
  const legacyLike = legacyKeys.length > 0 || nonArraySegments;

  if (hasCurrentSegments && !legacyLike) {
    return { status: "already-current", legacyLike: false };
  }

  if (!legacyLike) {
    return { status: "no-loop-config", legacyLike: false };
  }

  const sanitized = Flags.validateLoopConfig(raw);
  const persistent = toPersistentLoopConfig(sanitized);
  const summary = summarizeLegacyLoopCandidate({
    playlist,
    sound,
    raw,
    sanitized,
    persistent,
    legacyKeys,
    nonArraySegments,
  });

  if (!hasUsefulLoopSegment(sanitized)) {
    return {
      status: "not-useful-legacy",
      legacyLike: true,
      summary,
    };
  }

  return {
    status: "candidate",
    legacyLike: true,
    raw,
    persistent,
    summary,
  };
}

async function replaceLoopWithinFlag(sound, persistent, original = null) {
  let cleared = false;
  try {
    await sound.unsetFlag(MODULE_ID, "loopWithin");
    cleared = true;
    return await sound.setFlag(MODULE_ID, "loopWithin", persistent);
  } catch (err) {
    if (cleared && original) {
      try {
        await sound.setFlag(MODULE_ID, "loopWithin", original);
      } catch (_) {
        // Preserve the original migration error; rollback is best-effort only.
      }
    }
    throw err;
  }
}

function getLegacyLoopKeys(raw) {
  return LEGACY_LOOP_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(raw, key));
}

function toPersistentLoopConfig(config) {
  return {
    enabled: Boolean(config?.enabled),
    active: Boolean(config?.active),
    startFromBeginning: config?.startFromBeginning !== false,
    segments: Array.isArray(config?.segments)
      ? config.segments.map((segment) => ({
        start: String(segment?.start ?? "00:00"),
        end: String(segment?.end ?? "00:00"),
        crossfadeMs: Math.max(0, Number(segment?.crossfadeMs) || 0),
        loopCount: Math.max(0, Math.floor(Number(segment?.loopCount) || 0)),
        skipToNext: Boolean(segment?.skipToNext),
      }))
      : [],
  };
}

function summarizeLegacyLoopCandidate({ playlist, sound, raw, sanitized, persistent, legacyKeys, nonArraySegments }) {
  return {
    playlistId: playlist?.id ?? null,
    playlistName: playlist?.name ?? null,
    soundId: sound?.id ?? null,
    soundName: sound?.name ?? null,
    soundUuid: sound?.uuid ?? null,
    enabled: Boolean(persistent.enabled),
    active: Boolean(persistent.active),
    startFromBeginning: Boolean(persistent.startFromBeginning),
    segmentCount: Array.isArray(persistent.segments) ? persistent.segments.length : 0,
    legacyKeys,
    nonArraySegments: Boolean(nonArraySegments),
    rawSegmentsType: Array.isArray(raw?.segments) ? "array" : typeof raw?.segments,
    migratedSegments: Array.isArray(sanitized?.segments)
      ? sanitized.segments.map((segment) => ({
        start: segment.start ?? null,
        end: segment.end ?? null,
        crossfadeMs: Number.isFinite(Number(segment.crossfadeMs)) ? Number(segment.crossfadeMs) : null,
        loopCount: Number.isFinite(Number(segment.loopCount)) ? Number(segment.loopCount) : null,
        skipToNext: Boolean(segment.skipToNext),
      }))
      : [],
  };
}

function hasUsefulLoopSegment(config) {
  return Array.isArray(config?.segments) && config.segments.some((segment) =>
    Number.isFinite(Number(segment.startSec)) &&
    Number.isFinite(Number(segment.endSec)) &&
    Number(segment.endSec) > Number(segment.startSec)
  );
}

function normalizePlaylistIdFilter(playlistIds) {
  if (playlistIds instanceof Set) {
    const ids = Array.from(playlistIds).map((id) => String(id ?? "").trim()).filter(Boolean);
    return ids.length > 0 ? new Set(ids) : null;
  }

  if (!Array.isArray(playlistIds)) return null;
  const ids = playlistIds.map((id) => String(id ?? "").trim()).filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

function getMigrationPlaylists(playlistIds = null) {
  const filter = normalizePlaylistIdFilter(playlistIds);
  return Array.from(game.playlists ?? []).filter((playlist) =>
    !filter || filter.has(String(playlist?.id ?? ""))
  );
}

function getActivePlaybackPlaylists(playlistIds = null) {
  return getMigrationPlaylists(playlistIds)
    .filter((playlist) =>
      Boolean(playlist.playing) ||
      Array.from(playlist.sounds ?? []).some((sound) => Boolean(sound.playing || sound.sound?.playing))
    )
    .map((playlist) => ({
      id: playlist.id ?? null,
      name: playlist.name ?? null,
    }));
}

function toPublicMigrationScan(scan) {
  const { records, skippedRecords, ...publicScan } = scan;
  return {
    ...publicScan,
    canMigrate: scan.candidates > 0 && scan.activePlaylists.length === 0,
    blockedByActivePlayback: scan.activePlaylists.length > 0,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
