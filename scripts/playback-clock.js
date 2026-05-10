/**
 * @file playback-clock.js
 * @description Shared wall-clock playback metadata used to recover playlist
 * advancement when the owner client's local media clock stalls.
 */

import { MODULE_ID, debug } from "./utils.js";
import { Flags } from "./flag-service.js";

const FLAG_KEY = "playbackClock";
const WATCHDOG_INTERVAL_MS = 2000;
const RECOVERY_GRACE_MS = 1500;
const CLOCK_SEQUENCES = new Map();
const LAST_CLOCK_WRITES = new Map();

function _clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, num));
}

function _finitePositive(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function _resolveDurationSeconds(ps, media) {
  const candidates = [
    media?.duration,
    ps?.duration,
    ps?._source?.duration,
    ps?.system?.duration,
    ps?.flags?.core?.duration,
    ps?.flags?.[MODULE_ID]?.duration,
  ];

  for (const candidate of candidates) {
    const duration = _finitePositive(candidate);
    if (duration) return duration;
  }

  return null;
}

function _nextClockSeq(playlist) {
  const id = playlist?.id;
  const stored = Number(playlist?.getFlag?.(MODULE_ID, FLAG_KEY)?.clockSeq) || 0;
  const local = Number(CLOCK_SEQUENCES.get(id)) || 0;
  const next = Math.max(stored, local) + 1;
  if (id) CLOCK_SEQUENCES.set(id, next);
  return next;
}

function _canWriteClock(playlist) {
  return !!playlist?.isOwner && !!game.user?.isGM;
}

function _resolveOffsetSeconds(ps, media, explicitOffset) {
  const explicit = Number(explicitOffset);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;

  const live = Number(media?.currentTime);
  if (Number.isFinite(live) && live >= 0) return live;

  const paused = Number(ps?.pausedTime);
  if (Number.isFinite(paused) && paused >= 0) return paused;

  return 0;
}

function _resolveExpectedFadeAt(playlist, expectedEndAt) {
  const mode = Flags.getPlaybackMode(playlist);
  const fadeMs = mode.crossfade
    ? Number(Flags.getCrossfadeDuration(playlist)) || 0
    : Number(playlist?.fade) || 0;

  if (fadeMs <= 0) return null;
  return Math.max(0, expectedEndAt - fadeMs);
}

function _sameClock(existing, next) {
  if (!existing || !next) return false;
  if (existing.soundId !== next.soundId) return false;
  if (Math.abs(Number(existing.startedAt) - Number(next.startedAt)) > 750) return false;
  if (Math.abs(Number(existing.durationSec) - Number(next.durationSec)) > 0.05) return false;
  return true;
}

export const PlaybackClock = {
  FLAG_KEY,
  WATCHDOG_INTERVAL_MS,
  RECOVERY_GRACE_MS,

  get(playlist) {
    const clock = playlist?.getFlag?.(MODULE_ID, FLAG_KEY);
    return clock && typeof clock === "object" ? clock : null;
  },

  async record(playlist, ps, media, { reason = "playback", offsetSec = null, force = false } = {}) {
    if (!_canWriteClock(playlist) || !ps) return null;
    if (![CONST.PLAYLIST_MODES.SEQUENTIAL, CONST.PLAYLIST_MODES.SHUFFLE].includes(playlist.mode)) return null;
    if (Flags.getPlaybackMode(playlist).soundscape) return null;
    if (Flags.getSoundFlag(ps, "isSilenceGap")) return null;
    if (ps.repeat) return null;
    const loopConfig = Flags.getLoopConfig(ps);
    if (loopConfig?.enabled && loopConfig?.active) {
      debug(`[Clock] Skipping clock for "${ps.name}" - internal loop is active.`);
      return null;
    }

    const durationSec = _resolveDurationSeconds(ps, media);
    if (!durationSec) {
      debug(`[Clock] Skipping clock for "${ps.name}" - invalid duration (media=${media?.duration}, doc=${ps?.duration}).`);
      return null;
    }

    const now = Date.now();
    const offset = _clamp(_resolveOffsetSeconds(ps, media, offsetSec), 0, durationSec);
    const startedAt = Math.round(now - (offset * 1000));
    const expectedEndAt = Math.round(startedAt + (durationSec * 1000));
    const nextClock = {
      soundId: ps.id,
      soundUuid: ps.uuid,
      clockSeq: _nextClockSeq(playlist),
      ownerId: game.user.id,
      startedAt,
      offsetSec: Number(offset.toFixed(3)),
      durationSec: Number(durationSec.toFixed(3)),
      expectedEndAt,
      expectedFadeAt: _resolveExpectedFadeAt(playlist, expectedEndAt),
      reason,
    };

    const existing = this.get(playlist);
    const lastWrite = LAST_CLOCK_WRITES.get(playlist.id);
    if (!force) {
      if (_sameClock(existing, nextClock)) return existing;
      if (_sameClock(lastWrite, nextClock)) return lastWrite;
    }

    LAST_CLOCK_WRITES.set(playlist.id, nextClock);

    debug(`[Clock] Recording "${ps.name}" for "${playlist.name}" (${reason}).`, nextClock);
    await playlist.setFlag(MODULE_ID, FLAG_KEY, nextClock);
    return nextClock;
  },

  async clear(playlist, reason = "clear") {
    if (!_canWriteClock(playlist)) return false;
    if (!this.get(playlist)) return false;

    debug(`[Clock] Clearing playback clock for "${playlist.name}" (${reason}).`);
    LAST_CLOCK_WRITES.delete(playlist.id);
    await playlist.unsetFlag(MODULE_ID, FLAG_KEY);
    return true;
  },

  resolvePosition(ps, { now = Date.now() } = {}) {
    const playlist = ps?.parent;
    const clock = this.get(playlist);
    if (!clock || clock.soundId !== ps?.id) return null;

    const startedAt = Number(clock.startedAt);
    const durationSec = _finitePositive(clock.durationSec);
    if (!Number.isFinite(startedAt) || !durationSec) return null;

    const elapsed = _clamp((now - startedAt) / 1000, 0, durationSec);
    return {
      currentTime: elapsed,
      duration: durationSec,
      progressPct: durationSec > 0 ? _clamp((elapsed / durationSec) * 100, 0, 100) : 0,
      clock,
    };
  },

  getTransitionDueAt(playlist, clock = this.get(playlist)) {
    if (!clock) return null;
    const mode = Flags.getPlaybackMode(playlist);
    const dueAt = mode.crossfade ? Number(clock.expectedFadeAt) : Number(clock.expectedEndAt);
    return Number.isFinite(dueAt) && dueAt > 0 ? dueAt : null;
  },

  isOverdue(playlist, clock = this.get(playlist), { now = Date.now(), graceMs = RECOVERY_GRACE_MS } = {}) {
    const dueAt = this.getTransitionDueAt(playlist, clock);
    if (!dueAt) return false;
    return now > dueAt + graceMs;
  },

  summarizePlaylist(playlist, { now = Date.now() } = {}) {
    const clock = this.get(playlist);
    if (!clock) return null;

    const ps = playlist?.sounds?.get?.(clock.soundId);
    const position = ps ? this.resolvePosition(ps, { now }) : null;
    const media = ps?.sound;
    const liveTime = Number(media?.currentTime);
    const duration = Number(media?.duration);
    const derivedTime = Number(position?.currentTime);

    return {
      ...clock,
      soundName: ps?.name ?? clock.soundId,
      currentTime: Number.isFinite(derivedTime) ? Number(derivedTime.toFixed(1)) : null,
      mediaCurrentTime: Number.isFinite(liveTime) ? Number(liveTime.toFixed(1)) : null,
      mediaDuration: Number.isFinite(duration) ? Number(duration.toFixed(1)) : null,
      driftSec: Number.isFinite(liveTime) && Number.isFinite(derivedTime)
        ? Number((derivedTime - liveTime).toFixed(1))
        : null,
      overdueMs: this.isOverdue(playlist, clock, { now, graceMs: 0 })
        ? Math.max(0, Math.round(now - this.getTransitionDueAt(playlist, clock)))
        : 0,
      dueAt: this.getTransitionDueAt(playlist, clock),
    };
  },
};
