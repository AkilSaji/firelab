// Which tier to use: an override from the URL, from code or from storage,
// else what chip detection picked. Pure apart from the storage you pass in.

import { TIERS, normalizeTier } from './tiers.js';

/** @typedef {import('./tiers.js').TierId} TierId */
/** @typedef {'url' | 'code' | 'saved' | 'fallback' | 'auto'} TierSource */

/**
 * The bits of the Web Storage API this library uses.
 * @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void }} StorageLike
 */

/**
 * @typedef {object} FallbackRecord
 * @property {TierId} tier   the lighter tier to use
 * @property {TierId} from   the tier that proved too slow
 * @property {string} gpu    the GPU it was measured on
 * @property {number} at     when (ms since epoch)
 */

/**
 * @typedef {object} TierChoice
 * @property {TierId} tier
 * @property {TierSource} source
 * @property {TierId} auto            what detection picked
 * @property {FallbackRecord | null} fallback  a stored fallback, when one applies
 */

/** Storage keys used under the configurable prefix. */
export const STORAGE_SUFFIX = Object.freeze({ saved: '', fallback: ':fallback' });

/**
 * Wraps a storage so that every call is safe: private windows, blocked site
 * data and quota errors make localStorage throw.
 * @param {StorageLike | null | undefined} storage
 * @returns {StorageLike}
 */
export function safeStorage(storage) {
  return {
    getItem(key) {
      try {
        return storage ? storage.getItem(key) : null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        storage?.setItem(key, value);
      } catch {
        /* ignore */
      }
    },
    removeItem(key) {
      try {
        storage?.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Reads a stored fallback, ignoring it when it is stale or was measured on a
 * different GPU.
 * @param {StorageLike} storage
 * @param {string} key          the fallback key (prefix + ':fallback')
 * @param {{ gpu?: string, now?: number, ttlMs?: number }} [opts]
 * @returns {FallbackRecord | null}
 */
export function readFallback(storage, key, opts = {}) {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    const tier = normalizeTier(rec && rec.tier);
    const from = normalizeTier(rec && rec.from);
    if (!tier || !from) return null;
    const now = opts.now ?? Date.now();
    const ttl = opts.ttlMs ?? Infinity;
    if (typeof rec.at === 'number' && now - rec.at > ttl) return null;
    if (opts.gpu && rec.gpu && rec.gpu !== opts.gpu) return null;
    return { tier, from, gpu: String(rec.gpu || ''), at: Number(rec.at) || 0 };
  } catch {
    // Older format: just the tier id.
    const tier = normalizeTier(raw);
    return tier ? { tier, from: tier, gpu: '', at: 0 } : null;
  }
}

/**
 * Chooses the tier. Precedence, highest first:
 *
 * 1. URL parameter (`?q=tv-hd`; `?q=auto` ignores every override)
 * 2. `code`: a tier forced by the app
 * 3. a tier the user saved (setTier(…, { persist: true }))
 * 4. a stored automatic fallback (the richer tier proved too slow here)
 * 5. chip detection
 *
 * The URL wins so that a FireLab sweep can force each tier in turn.
 *
 * @param {object} opts
 * @param {TierId} opts.auto                    detection result
 * @param {string} [opts.search]                location.search
 * @param {string} [opts.param]                 URL parameter name (default 'q')
 * @param {unknown} [opts.code]                 tier forced from code
 * @param {StorageLike} [opts.storage]
 * @param {string} [opts.storageKey]            default 'firelab-tier'
 * @param {string} [opts.gpu]                   for validating a stored fallback
 * @param {number} [opts.now]
 * @param {number} [opts.fallbackTtlMs]         default 30 days
 * @returns {TierChoice}
 */
export function resolveTier(opts) {
  const param = opts.param ?? 'q';
  const key = opts.storageKey ?? 'firelab-tier';
  const storage = safeStorage(opts.storage);
  const auto = opts.auto;
  let fromUrl = null;
  if (opts.search && param) {
    try {
      const raw = new URLSearchParams(opts.search).get(param);
      if (raw !== null) {
        if (raw.trim().toLowerCase() === 'auto') return { tier: auto, source: 'auto', auto, fallback: null };
        fromUrl = normalizeTier(raw);
      }
    } catch {
      /* malformed search string */
    }
  }
  if (fromUrl) return { tier: fromUrl, source: 'url', auto, fallback: null };
  const fromCode = normalizeTier(opts.code);
  if (fromCode) return { tier: fromCode, source: 'code', auto, fallback: null };
  const saved = normalizeTier(storage.getItem(key + STORAGE_SUFFIX.saved));
  if (saved) return { tier: saved, source: 'saved', auto, fallback: null };
  const fallback = readFallback(storage, key + STORAGE_SUFFIX.fallback, {
    gpu: opts.gpu,
    now: opts.now,
    ttlMs: opts.fallbackTtlMs ?? 30 * 24 * 3600 * 1000,
  });
  // A fallback only ever makes things lighter than detection.
  if (fallback && TIERS[fallback.tier].rank < TIERS[auto].rank) {
    return { tier: fallback.tier, source: 'fallback', auto, fallback };
  }
  return { tier: auto, source: 'auto', auto, fallback: null };
}

