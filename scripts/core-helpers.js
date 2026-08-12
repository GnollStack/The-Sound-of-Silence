/**
 * @file core-helpers.js
 * @description Foundry-independent helpers shared by runtime code and Node regression tests.
 */

/**
 * Normalize a finite, non-negative number while preserving an explicit zero.
 * @param {unknown} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
export function normalizeNonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  if (Number.isFinite(number)) return Math.max(0, number);

  const safeFallback = Number(fallback);
  return Number.isFinite(safeFallback) ? Math.max(0, safeFallback) : 0;
}

/**
 * Format seconds as MM:SS or MM:SS.mmm after rounding the complete value.
 * Rounding first ensures millisecond overflow carries into seconds/minutes.
 * @param {unknown} seconds
 * @param {boolean} [showMilliseconds=true]
 * @returns {string}
 */
export function formatTimeValue(seconds, showMilliseconds = true) {
  const numeric = Number(seconds);
  const safeSeconds = Number.isFinite(numeric) ? Math.max(0, numeric) : 0;

  if (showMilliseconds) {
    const totalMilliseconds = Math.round(safeSeconds * 1000);
    const minutes = Math.floor(totalMilliseconds / 60000);
    const secondsPart = Math.floor((totalMilliseconds % 60000) / 1000);
    const milliseconds = totalMilliseconds % 1000;
    return `${String(minutes).padStart(2, "0")}:${String(secondsPart).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
  }

  const wholeSeconds = Math.floor(safeSeconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const secondsPart = wholeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secondsPart).padStart(2, "0")}`;
}

/**
 * Select one deterministic active GM from any iterable of user-like objects.
 * @param {Iterable<object>|null|undefined} users
 * @returns {string|null}
 */
export function selectPrimaryActiveGmId(users) {
  const activeGmIds = Array.from(users ?? [])
    .filter((user) => user?.isGM && user?.active !== false && user?.id != null)
    .map((user) => String(user.id))
    .sort((left, right) => left < right ? -1 : (left > right ? 1 : 0));
  return activeGmIds[0] ?? null;
}

/**
 * Create a small deterministic PRNG from any stable string-like seed.
 * This keeps client-local playlist ordering identical without consuming the
 * shared/global Math.random stream.
 * @param {unknown} seed
 * @returns {() => number} Values in the range [0, 1).
 */
export function createDeterministicRandom(seed) {
  const text = String(seed ?? "");
  let state = 2166136261;
  for (let index = 0; index < text.length; index++) {
    state ^= text.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  state >>>= 0;

  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Decide whether Foundry's native _onEnd handler should run for an SoS mode.
 * Non-authority clients suppress feature-owned automatic document mutations.
 * @param {object} options
 * @param {boolean} [options.crossfade=false]
 * @param {boolean} [options.silence=false]
 * @param {unknown} [options.crossfadeMs=0]
 * @param {boolean} [options.crossfadeStarted=true]
 * @param {boolean} [options.silenceStarted=false]
 * @param {boolean} [options.isAuthority=false]
 * @returns {boolean}
 */
export function shouldUseNativeTrackCompletion({
  crossfade = false,
  silence = false,
  crossfadeMs = 0,
  crossfadeStarted = true,
  silenceStarted = false,
  isAuthority = false,
} = {}) {
  if (!crossfade && !silence) return true;
  if (!isAuthority) return false;
  if (crossfade) {
    return normalizeNonNegativeNumber(crossfadeMs, 0) <= 0 || !crossfadeStarted;
  }
  return !silenceStarted;
}

/**
 * Enumerate an API object's own properties and prototype methods.
 * @param {object|null|undefined} api
 * @returns {string[]}
 */
export function getPublicApiKeys(api) {
  if (!api || (typeof api !== "object" && typeof api !== "function")) return [];

  const keys = new Set(Object.keys(api));
  let prototype = Object.getPrototypeOf(api);
  while (prototype && prototype !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(prototype)) {
      if (key !== "constructor") keys.add(key);
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return Array.from(keys).sort();
}
