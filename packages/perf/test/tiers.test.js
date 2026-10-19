import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TIERS, TIER_IDS, isTier, normalizeTier, lighterTier, richerTier, capTier, pick, resolveTier, readFallback, safeStorage } from '../index.js';

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

describe('tiers', () => {
  test('four tiers, lightest first, with the contract budgets', () => {
    assert.deepEqual(TIER_IDS, ['low', 'tv', 'tv-hd', 'high']);
    assert.deepEqual(
      TIER_IDS.map((t) => TIERS[t].maxHeight),
      [540, 720, 1080, 1440],
    );
    TIER_IDS.forEach((t, i) => assert.equal(TIERS[t].rank, i));
    assert.ok(Object.isFrozen(TIERS) && Object.isFrozen(TIERS.tv));
  });

  test('isTier / normalizeTier', () => {
    assert.equal(isTier('tv-hd'), true);
    assert.equal(isTier('TV-HD'), false);
    assert.equal(isTier('toString'), false, 'no prototype keys');
    assert.equal(normalizeTier(' TV-HD '), 'tv-hd');
    assert.equal(normalizeTier('hd'), 'tv-hd');
    assert.equal(normalizeTier('max'), 'high');
    assert.equal(normalizeTier('lean'), 'tv');
    assert.equal(normalizeTier('potato'), null);
    assert.equal(normalizeTier(3), null);
    assert.equal(normalizeTier(undefined), null);
  });

  test('lighter / richer / cap', () => {
    assert.equal(lighterTier('tv-hd'), 'tv');
    assert.equal(lighterTier('low'), null);
    assert.equal(richerTier('tv'), 'tv-hd');
    assert.equal(richerTier('high'), null);
    assert.equal(capTier('high', 'tv-hd'), 'tv-hd');
    assert.equal(capTier('tv', 'tv-hd'), 'tv');
  });

  test('pick falls back to the nearest lighter tier, then richer', () => {
    const map = { low: 'L', 'tv-hd': 'HD' };
    assert.equal(pick('low', map), 'L');
    assert.equal(pick('tv', map), 'L');
    assert.equal(pick('tv-hd', map), 'HD');
    assert.equal(pick('high', map), 'HD');
    assert.equal(pick('tv', { high: 'H' }), 'H');
    assert.equal(pick('tv', {}), undefined);
    assert.equal(pick('tv', { tv: false }), false, 'falsy values count');
  });
});

describe('resolveTier', () => {
  test('auto when nothing overrides it', () => {
    assert.deepEqual(resolveTier({ auto: 'tv' }), { tier: 'tv', source: 'auto', auto: 'tv', fallback: null });
  });

  test('URL parameter wins over everything', () => {
    const storage = memoryStorage({ 'firelab-tier': 'low' });
    const r = resolveTier({ auto: 'tv', search: '?q=tv-hd', code: 'high', storage });
    assert.equal(r.tier, 'tv-hd');
    assert.equal(r.source, 'url');
  });

  test('custom parameter name and aliases', () => {
    assert.equal(resolveTier({ auto: 'tv', search: '?quality=hd', param: 'quality' }).tier, 'tv-hd');
    assert.equal(resolveTier({ auto: 'tv', search: '?q=hd', param: 'quality' }).tier, 'tv');
  });

  test('?q=auto ignores code, saved choices and fallbacks', () => {
    const storage = memoryStorage({ 'firelab-tier': 'low' });
    const r = resolveTier({ auto: 'tv-hd', search: '?q=auto', code: 'low', storage });
    assert.equal(r.tier, 'tv-hd');
    assert.equal(r.source, 'auto');
  });

  test('an invalid URL value is ignored', () => {
    const r = resolveTier({ auto: 'tv', search: '?q=ultra-mega', code: 'low' });
    assert.equal(r.tier, 'low');
    assert.equal(r.source, 'code');
  });

  test('code beats storage; saved choice beats fallback', () => {
    const storage = memoryStorage({
      'firelab-tier': 'tv',
      'firelab-tier:fallback': JSON.stringify({ tier: 'low', from: 'tv', gpu: 'X', at: Date.now() }),
    });
    assert.equal(resolveTier({ auto: 'tv-hd', code: 'high', storage }).source, 'code');
    const saved = resolveTier({ auto: 'tv-hd', storage });
    assert.equal(saved.tier, 'tv');
    assert.equal(saved.source, 'saved');
  });

  test('a stored fallback applies on the same GPU', () => {
    const storage = memoryStorage({ 'firelab-tier:fallback': JSON.stringify({ tier: 'tv', from: 'tv-hd', gpu: 'PowerVR Rogue GE9215', at: 1000 }) });
    const r = resolveTier({ auto: 'tv-hd', storage, gpu: 'PowerVR Rogue GE9215', now: 2000 });
    assert.equal(r.tier, 'tv');
    assert.equal(r.source, 'fallback');
    assert.equal(r.fallback.from, 'tv-hd');
  });

  test('a stored fallback is ignored on another GPU, when stale, or when it is not lighter', () => {
    const rec = (o) => memoryStorage({ 'firelab-tier:fallback': JSON.stringify({ tier: 'tv', from: 'tv-hd', gpu: 'A', at: 0, ...o }) });
    assert.equal(resolveTier({ auto: 'tv-hd', storage: rec({}), gpu: 'B', now: 1 }).source, 'auto');
    assert.equal(resolveTier({ auto: 'tv-hd', storage: rec({}), gpu: 'A', now: 31 * 24 * 3600 * 1000 }).source, 'auto');
    assert.equal(resolveTier({ auto: 'tv-hd', storage: rec({}), gpu: 'A', now: 1, fallbackTtlMs: Infinity }).source, 'fallback');
    assert.equal(resolveTier({ auto: 'tv', storage: rec({ tier: 'tv-hd' }), gpu: 'A', now: 1 }).source, 'auto');
  });

  test('custom storage key', () => {
    const storage = memoryStorage({ 'mygame:q': 'low' });
    assert.equal(resolveTier({ auto: 'tv', storage, storageKey: 'mygame:q' }).tier, 'low');
  });

  test('storage that throws (private mode) is harmless', () => {
    const throwing = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('QuotaExceeded');
      },
      removeItem() {
        throw new Error('nope');
      },
    };
    assert.equal(resolveTier({ auto: 'tv', storage: throwing }).tier, 'tv');
    const s = safeStorage(throwing);
    assert.doesNotThrow(() => s.setItem('a', 'b'));
    assert.doesNotThrow(() => s.removeItem('a'));
    assert.equal(s.getItem('a'), null);
    assert.equal(safeStorage(null).getItem('a'), null);
  });

  test('readFallback accepts a bare tier id and rejects garbage', () => {
    assert.equal(readFallback(memoryStorage({ k: 'tv' }), 'k').tier, 'tv');
    assert.equal(readFallback(memoryStorage({ k: '{"tier":"nope","from":"tv"}' }), 'k'), null);
    assert.equal(readFallback(memoryStorage({ k: '{broken' }), 'k'), null);
    assert.equal(readFallback(memoryStorage({}), 'k'), null);
  });
});
