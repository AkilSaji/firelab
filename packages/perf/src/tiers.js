// Quality tiers: the shared vocabulary of FireLab (docs/CONTRACT.md).
//
// From lightest to richest: low, tv, tv-hd, high. A tier says how much a
// device can draw; what that means for your scene (shadows, particle counts,
// view distance) is up to you, see pick().

/** @typedef {'low' | 'tv' | 'tv-hd' | 'high'} TierId */

/**
 * @typedef {object} TierPreset
 * @property {TierId} id
 * @property {number} rank        0 for low … 3 for high
 * @property {string} label       short human name
 * @property {number} maxHeight   tallest drawing buffer worth rendering, in device pixels (540, 720, 1080, 1440)
 * @property {string} summary     one line on what the tier is for
 */

/** @type {readonly TierId[]} */
export const TIER_IDS = Object.freeze(/** @type {TierId[]} */ (['low', 'tv', 'tv-hd', 'high']));

/** @type {Readonly<Record<TierId, TierPreset>>} */
export const TIERS = Object.freeze({
  low: Object.freeze({
    id: /** @type {TierId} */ ('low'),
    rank: 0,
    label: 'Low',
    maxHeight: 540,
    summary: 'Very old or very weak GPUs (Mali-450, Mali-T720, software rendering): minimal effects, 540p.',
  }),
  tv: Object.freeze({
    id: /** @type {TierId} */ ('tv'),
    rank: 1,
    label: 'TV',
    maxHeight: 720,
    summary: 'Budget streaming sticks (PowerVR GE8300, Mali-G31/G51, Adreno 3xx-5xx): 720p cap, no shadows.',
  }),
  'tv-hd': Object.freeze({
    id: /** @type {TierId} */ ('tv-hd'),
    rank: 2,
    label: 'TV HD',
    maxHeight: 1080,
    summary: 'Newer sticks and boxes (PowerVR GE9xxx, Mali-G52+, Adreno 6xx+): up to 1080p, sun shadows.',
  }),
  high: Object.freeze({
    id: /** @type {TierId} */ ('high'),
    rank: 3,
    label: 'High',
    maxHeight: 1440,
    summary: 'Desktop and laptop GPUs.',
  }),
});

/** Friendly spellings accepted wherever a tier id is read (URL, storage, code). */
export const TIER_ALIASES = Object.freeze({
  min: 'low',
  lowest: 'low',
  lean: 'tv',
  medium: 'tv',
  med: 'tv',
  hd: 'tv-hd',
  tvhd: 'tv-hd',
  tv_hd: 'tv-hd',
  'tv hd': 'tv-hd',
  max: 'high',
  ultra: 'high',
  desktop: 'high',
});

/**
 * True when `value` is one of the four tier ids.
 * @param {unknown} value
 * @returns {value is TierId}
 */
export function isTier(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TIERS, value);
}

/**
 * Turns user input ("HD", " tv-hd ", "max") into a tier id, or null.
 * @param {unknown} value
 * @returns {TierId | null}
 */
export function normalizeTier(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (isTier(v)) return v;
  const alias = /** @type {Record<string, string>} */ (TIER_ALIASES)[v];
  return alias && isTier(alias) ? alias : null;
}

/**
 * The tier one step lighter, or null for 'low'.
 * @param {TierId} tier
 * @returns {TierId | null}
 */
export function lighterTier(tier) {
  const i = TIER_IDS.indexOf(tier);
  return i > 0 ? TIER_IDS[i - 1] : null;
}

/**
 * The tier one step richer, or null for 'high'.
 * @param {TierId} tier
 * @returns {TierId | null}
 */
export function richerTier(tier) {
  const i = TIER_IDS.indexOf(tier);
  return i >= 0 && i < TIER_IDS.length - 1 ? TIER_IDS[i + 1] : null;
}

/**
 * The lighter of two tiers: capTier('high', 'tv-hd') === 'tv-hd'.
 * @param {TierId} tier
 * @param {TierId} cap
 * @returns {TierId}
 */
export function capTier(tier, cap) {
  return TIERS[tier].rank > TIERS[cap].rank ? cap : tier;
}

/**
 * Picks the setting for a tier from a partial map, falling back to the
 * nearest lighter tier that has one (then the nearest richer one).
 *
 *   pick('tv', { low: { shadows: false }, 'tv-hd': { shadows: true } })
 *   // -> { shadows: false }
 *
 * @template T
 * @param {TierId} tier
 * @param {Partial<Record<TierId, T>>} map
 * @returns {T | undefined}
 */
export function pick(tier, map) {
  const i = TIER_IDS.indexOf(tier);
  if (i < 0) return undefined;
  for (let j = i; j >= 0; j--) if (map[TIER_IDS[j]] !== undefined) return map[TIER_IDS[j]];
  for (let j = i + 1; j < TIER_IDS.length; j++) if (map[TIER_IDS[j]] !== undefined) return map[TIER_IDS[j]];
  return undefined;
}
