import { describe, expect, it } from 'vitest';
import { percentile, median, summarize } from '../src/lib/stats.js';
import { criteriaFor, evaluateRow, recommend, tierUrl, sweepMarkdown, runSweep, type SweepPage, type SweepRow, type SweepProgress } from '../src/perf/sweep.js';
import type { FpsSample } from '../src/cdp/fps.js';

describe('statistics', () => {
  it('interpolates percentiles like numpy (linear)', () => {
    const xs = [10, 20, 30, 40, 50];
    expect(median(xs)).toBe(30);
    expect(percentile(xs, 10)).toBe(14);
    expect(percentile(xs, 90)).toBe(46);
    expect(percentile([5], 10)).toBe(5);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
    expect(median([3, 1, 2, NaN])).toBe(2);
  });
  it('summarizes', () => {
    expect(summarize([1, 2, 3, 4])).toMatchObject({ n: 4, median: 2.5, min: 1, max: 4, mean: 2.5 });
  });
  it('handles very long sessions without blowing the stack', () => {
    const xs = Array.from({ length: 300_000 }, (_, i) => i % 61);
    expect(summarize(xs)).toMatchObject({ min: 0, max: 60, median: 30 });
  });
});

describe('row verdicts', () => {
  const c = criteriaFor();
  it('defaults: 30 fps target, p10 >= 24, 5% slack on the median', () => {
    expect(c).toEqual({ targetFps: 30, minP10: 24, tolerance: 0.05, minSamples: 5 });
    expect(criteriaFor({ targetFps: 60 }).minP10).toBe(48);
  });
  it('passes a frame-capped 30 fps app that jitters a little', () => {
    const r = evaluateRow('tv', [30, 29, 30, 30, 28.6, 30, 29.5, 30, 30, 29], c);
    expect(r).toMatchObject({ ok: true, fpsMedian: 30, samples: 10 });
  });
  it('fails on a low median, or on stutter (low p10) even with a good median', () => {
    expect(evaluateRow('tv-hd', [17, 15, 16, 14, 13, 17, 16], c)).toMatchObject({ ok: false, note: 'median 16 < 30, p10 13.6 < 24 (stutters)' });
    const stutter = evaluateRow('high', [30, 30, 30, 30, 30, 30, 30, 12, 14, 30], c);
    expect(stutter.ok).toBe(false);
    expect(stutter.note).toMatch(/p10 \d+(\.\d)? < 24 \(stutters\)/);
  });
  it('refuses to judge without enough data', () => {
    expect(evaluateRow('tv', [], c)).toMatchObject({ ok: false, samples: 0, note: expect.stringMatching(/no frames/) });
    expect(evaluateRow('tv', [30, 30], c)).toMatchObject({ ok: false, note: expect.stringMatching(/only 2 s/) });
  });
});

describe('recommend', () => {
  const c = criteriaFor();
  const row = (tier: string, fpsMedian: number, fpsP10: number, ok: boolean, extra: Partial<SweepRow> = {}): SweepRow => ({ tier, fpsMedian, fpsP10, ok, samples: 15, ...extra });

  it('picks the richest tier that holds the target and says why', () => {
    const r = recommend([row('low', 30, 29, true), row('tv', 30, 28, true), row('tv-hd', 29.6, 26, true, { memMB: 512 }), row('high', 17, 12, false)], c);
    expect(r?.tier).toBe('tv-hd');
    expect(r?.reason).toBe('tv-hd is the richest tier that holds 30 fps here (median 29.6 / p10 26 fps, 512 MB). high drops to median 17 / p10 12 fps.');
  });

  it('notes when the richest tier tested holds', () => {
    expect(recommend([row('tv', 30, 29, true), row('high', 30, 27, true)], c)?.reason).toMatch(/richest tier tested/);
  });

  it('flags noisy results where a lighter tier failed', () => {
    expect(recommend([row('tv', 25, 20, false), row('tv-hd', 30, 27, true)], c)?.reason).toMatch(/tv measured slower; re-run/);
  });

  it('recommends the closest tier when none holds', () => {
    const r = recommend([row('tv', 27, 22, false), row('tv-hd', 15, 11, false)], c);
    expect(r?.tier).toBe('tv');
    expect(r?.reason).toMatch(/^No tier holds 30 fps on this device. tv comes closest/);
  });

  it('mentions a crash on the next tier', () => {
    const r = recommend([row('tv', 30, 28, true), row('high', 0, 0, false, { samples: 0, note: 'WebView crashed or the app closed (x)' })], c);
    expect(r?.reason).toMatch(/high WebView crashed/);
  });

  it('returns undefined for no rows', () => {
    expect(recommend([], c)).toBeUndefined();
  });
});

describe('tierUrl', () => {
  it('sets the tier parameter and keeps the rest', () => {
    expect(tierUrl('http://192.168.1.164:4173/', 'q', 'tv-hd')).toBe('http://192.168.1.164:4173/?q=tv-hd');
    expect(tierUrl('http://x/game?debug=1&q=high#start', 'q', 'tv')).toBe('http://x/game?debug=1&q=tv#start');
    expect(tierUrl('https://x/', 'quality', 'low')).toBe('https://x/?quality=low');
  });
  it('rejects non-URLs', () => {
    expect(() => tierUrl('localhost:4173', 'q', 'tv')).toThrow();
    expect(() => tierUrl('not a url', 'q', 'tv')).toThrow(/not a valid URL/);
  });
});

/** A fake page whose fps depends on the tier in its URL; time is simulated. */
function fakeWorld(fpsByTier: Record<string, number[]>, opts: { crashOn?: string } = {}) {
  let now = 0;
  let url = 'http://tv.local/?saved=1';
  let closed = false;
  let queue: number[] = [];
  const navigations: string[] = [];
  const page: SweepPage = {
    get closed() {
      return closed;
    },
    async navigate(u) {
      navigations.push(u);
      url = u;
      const tier = new URL(u).searchParams.get('q') ?? '';
      if (opts.crashOn === tier) {
        closed = true;
        throw new Error('DevTools connection closed during Page.navigate');
      }
      queue = [...(fpsByTier[tier] ?? [])];
      now += 2000;
      return { loaded: true };
    },
    async eval() {
      return null;
    },
    async installProbe() {},
    async resetFps() {},
    async readFps(): Promise<FpsSample[]> {
      const v = queue.shift();
      return v === undefined ? [] : [{ ts: now, fps: v, source: 'raf', counter: 'draws' }];
    },
    async currentUrl() {
      return url;
    },
    close() {},
  };
  return {
    page,
    navigations,
    deps: {
      openPage: async () => {
        closed = false;
        return page;
      },
      sleep: async (ms: number) => {
        now += ms;
      },
      now: () => now,
      nativeSample: async (memory: boolean) => ({ ts: now, ...(memory ? { memMB: 400 } : {}), cpuPct: 120 }),
    },
  };
}

describe('runSweep', () => {
  const steady = (v: number, n = 12) => Array.from({ length: n }, () => v);

  it('measures each tier, recommends, and restores the original URL', async () => {
    const w = fakeWorld({ tv: steady(30), 'tv-hd': [...steady(30, 10), 29, 29], high: steady(16) });
    const progress: SweepProgress[] = [];
    const r = await runSweep(
      w.deps,
      { url: 'http://192.168.1.164:4173/', tiers: ['tv', 'tv-hd', 'high'], warmupS: 2, sampleS: 10, device: { id: 'x', name: 'Fire TV Stick 4K Plus', gpu: 'PowerVR Rogue GE9215' } },
      (p) => progress.push(p),
    );
    expect(r.rows.map((x) => [x.tier, x.fpsMedian, x.ok, x.memMB])).toEqual([
      ['tv', 30, true, 400],
      ['tv-hd', 30, true, 400],
      ['high', 16, false, 400],
    ]);
    expect(r.recommendation?.tier).toBe('tv-hd');
    expect(w.navigations).toEqual(['http://192.168.1.164:4173/?q=tv', 'http://192.168.1.164:4173/?q=tv-hd', 'http://192.168.1.164:4173/?q=high', 'http://tv.local/?saved=1']);
    expect(progress[0]?.phase).toBe('start');
    expect(progress[progress.length - 1]).toMatchObject({ phase: 'done', progress: 1 });
    expect(progress.filter((p) => p.phase === 'row')).toHaveLength(3);
    // monotonic progress
    for (let i = 1; i < progress.length; i++) expect(progress[i]!.progress).toBeGreaterThanOrEqual(progress[i - 1]!.progress);
    expect(r.rows[0]?.counter).toBe('draws');
  });

  it('records a crash on one tier and carries on', async () => {
    const w = fakeWorld({ tv: steady(30), high: steady(30) }, { crashOn: 'tv-hd' });
    const r = await runSweep(w.deps, { url: 'http://h/', tiers: ['tv', 'tv-hd', 'high'], warmupS: 1, sampleS: 8, device: { id: 'x' } });
    expect(r.rows[1]).toMatchObject({ tier: 'tv-hd', ok: false, note: expect.stringMatching(/crashed/) });
    expect(r.rows[2]?.ok).toBe(true);
  });

  it('can skip restoring', async () => {
    const w = fakeWorld({ tv: steady(30) });
    await runSweep(w.deps, { url: 'http://h/', tiers: ['tv'], warmupS: 0, sampleS: 6, restore: false, device: { id: 'x' } });
    expect(w.navigations).toEqual(['http://h/?q=tv']);
  });

  it('formats a markdown table with the recommendation in bold', async () => {
    const w = fakeWorld({ tv: steady(30), high: steady(12) });
    const r = await runSweep(w.deps, { url: 'http://h/', tiers: ['tv', 'high'], warmupS: 0, sampleS: 6, device: { id: 'x', name: 'Stick', gpu: 'GE8300' } });
    const md = sweepMarkdown(r);
    expect(md).toContain('| **tv** | 30.0 | 30.0 | 400 MB | – | yes |');
    expect(md).toContain('| high | 12.0 | 12.0 | 400 MB | – | no (median 12 < 30, p10 12 < 24 (stutters)) |');
    expect(md).toContain('**Recommendation: `tv`.**');
  });
});
