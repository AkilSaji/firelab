import type { FpsSample } from '../cdp/fps.js';
import type { NativeSample } from './native.js';
import { median, percentile } from '../lib/stats.js';
import { round1 } from '../lib/util.js';
import { FireLabError } from '../lib/errors.js';

/** Lightest to richest; the shared tier vocabulary (docs/CONTRACT.md). */
export const DEFAULT_TIERS = ['low', 'tv', 'tv-hd', 'high'];

export type SweepCriteria = {
  /** Frame rate the tier must hold (default 30). */
  targetFps: number;
  /** The slowest 10% of seconds must stay at or above this (default 80% of target: 24 for 30). */
  minP10: number;
  /**
   * Slack on the median, as a fraction of the target (default 0.05). Apps that
   * cap themselves at 30 fps measure 28.5-30 because frame pacing jitters by a
   * vsync now and then; that is holding the target, not missing it.
   */
  tolerance: number;
  /** Fewer per-second samples than this can't support a verdict (default 5). */
  minSamples: number;
};

export function criteriaFor(opts: { targetFps?: number; minP10?: number; tolerance?: number; minSamples?: number } = {}): SweepCriteria {
  const targetFps = opts.targetFps ?? 30;
  return { targetFps, minP10: opts.minP10 ?? round1(targetFps * 0.8), tolerance: opts.tolerance ?? 0.05, minSamples: opts.minSamples ?? 5 };
}

export type SweepRow = {
  tier: string;
  fpsMedian: number;
  fpsP10: number;
  memMB?: number;
  scale?: number;
  ok: boolean;
  note?: string;
  /** Extras beyond the contract's row. */
  samples?: number;
  cpuPct?: number;
  source?: FpsSample['source'];
  counter?: FpsSample['counter'];
  loadMs?: number;
};

export type Recommendation = { tier: string; reason: string };

/** Per-second fps samples -> a row verdict. */
export function evaluateRow(tier: string, fps: number[], c: SweepCriteria): Pick<SweepRow, 'tier' | 'fpsMedian' | 'fpsP10' | 'ok' | 'note' | 'samples'> {
  const xs = fps.filter((x) => Number.isFinite(x));
  if (!xs.length) return { tier, fpsMedian: 0, fpsP10: 0, ok: false, samples: 0, note: 'no frames measured (was the page hidden, or not rendering?)' };
  const med = round1(median(xs));
  const p10 = round1(percentile(xs, 10));
  const row = { tier, fpsMedian: med, fpsP10: p10, samples: xs.length };
  if (xs.length < c.minSamples) return { ...row, ok: false, note: `only ${xs.length} s of frames measured; sample longer` };
  const medOk = med >= c.targetFps * (1 - c.tolerance);
  const p10Ok = p10 >= c.minP10;
  if (medOk && p10Ok) return { ...row, ok: true };
  const why = [!medOk ? `median ${med} < ${c.targetFps}` : '', !p10Ok ? `p10 ${p10} < ${c.minP10} (stutters)` : ''].filter(Boolean).join(', ');
  return { ...row, ok: false, note: why };
}

const fmt = (r: SweepRow) => `median ${r.fpsMedian} / p10 ${r.fpsP10} fps`;

/** The richest tier that holds the target, with a plain-English reason. */
export function recommend(rows: SweepRow[], c: SweepCriteria): Recommendation | undefined {
  const measured = rows.filter((r) => (r.samples ?? 1) > 0 && !/crash|failed/i.test(r.note ?? ''));
  if (!rows.length) return undefined;
  let best = -1;
  rows.forEach((r, i) => {
    if (r.ok) best = i;
  });
  if (best < 0) {
    const pool = measured.length ? measured : rows;
    const fastest = pool.reduce((a, b) => (b.fpsMedian > a.fpsMedian ? b : a));
    const lightest = pool[0] as SweepRow;
    const pick = fastest.fpsMedian > lightest.fpsMedian + 2 ? fastest : lightest;
    return {
      tier: pick.tier,
      reason: `No tier holds ${c.targetFps} fps on this device. ${pick.tier} comes closest (${fmt(pick)}): ship it and optimize, or lower the target.`,
    };
  }
  const b = rows[best] as SweepRow;
  const parts = [`${b.tier} is the richest tier that holds ${c.targetFps} fps here (${fmt(b)}${b.memMB ? `, ${Math.round(b.memMB)} MB` : ''}).`];
  const next = rows[best + 1];
  if (next) parts.push(`${next.tier} ${next.note && /crash|failed/i.test(next.note) ? next.note : `drops to ${fmt(next)}`}.`);
  else if (rows.length > 1) parts.push('It is the richest tier tested.');
  const lighterFails = rows.slice(0, best).filter((r) => !r.ok);
  if (lighterFails.length) parts.push(`(${lighterFails.map((r) => r.tier).join(', ')} measured slower; re-run to rule out noise.)`);
  return { tier: b.tier, reason: parts.join(' ') };
}

/** Sets ?<param>=<tier> on a URL, keeping everything else. */
export function tierUrl(base: string, param: string, tier: string): string {
  let u: URL;
  try {
    u = new URL(base);
    if (!['http:', 'https:', 'file:'].includes(u.protocol)) throw new Error('scheme');
  } catch {
    throw new FireLabError('bad-request', `"${base}" is not a valid URL`, { hint: 'Pass the full URL the app loads, e.g. http://192.168.1.20:4173/' });
  }
  u.searchParams.set(param, tier);
  return u.toString();
}

export type SweepResult = {
  device: { id: string; name?: string; model?: string; gpu?: string };
  package?: string;
  url: string;
  param: string;
  criteria: SweepCriteria;
  rows: SweepRow[];
  recommendation?: Recommendation;
  startedAt: number;
  durationS: number;
};

export function sweepMarkdown(r: SweepResult): string {
  const head = `**${r.device.name ?? r.device.id}**${r.device.gpu ? ` (${r.device.gpu})` : ''}: \`?${r.param}=<tier>\`, target ${r.criteria.targetFps} fps (p10 ≥ ${r.criteria.minP10})`;
  const lines = [
    head,
    '',
    '| Tier | Median fps | p10 fps | Memory | Render scale | Holds target |',
    '|---|---:|---:|---:|---:|---|',
    ...r.rows.map(
      (row) =>
        `| ${row.tier === r.recommendation?.tier ? `**${row.tier}**` : row.tier} | ${row.fpsMedian.toFixed(1)} | ${row.fpsP10.toFixed(1)} | ${row.memMB ? `${Math.round(row.memMB)} MB` : '–'} | ${row.scale !== undefined ? row.scale.toFixed(2) : '–'} | ${row.ok ? 'yes' : `no${row.note ? ` (${row.note})` : ''}`} |`,
    ),
  ];
  if (r.recommendation) lines.push('', `**Recommendation: \`${r.recommendation.tier}\`.** ${r.recommendation.reason}`);
  return lines.join('\n');
}

// ---------- the runner ----------

/** What the sweep needs from a page; the real one wraps a WebViewSession. */
export interface SweepPage {
  readonly closed: boolean;
  navigate(url: string): Promise<{ loaded: boolean }>;
  eval(expression: string, timeoutMs?: number): Promise<unknown>;
  installProbe(): Promise<void>;
  resetFps(): Promise<void>;
  readFps(): Promise<FpsSample[]>;
  currentUrl(): Promise<string>;
  close(): void;
}

export interface SweepDeps {
  openPage(): Promise<SweepPage>;
  pressKeys?(keys: string[]): Promise<void>;
  nativeSample?(memory: boolean): Promise<NativeSample>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
}

export type SweepOptions = {
  url: string;
  tiers?: string[];
  param?: string;
  warmupS?: number;
  sampleS?: number;
  action?: { keys?: string[]; eval?: string };
  targetFps?: number;
  minP10?: number;
  tolerance?: number;
  /** Put the page back on the URL it had before the sweep (default true). */
  restore?: boolean;
  device: SweepResult['device'];
  package?: string;
};

export type SweepProgress = {
  progress: number;
  tier?: string;
  /** Position of `tier` in the tier list. */
  index?: number;
  phase: 'start' | 'load' | 'action' | 'warmup' | 'sample' | 'row' | 'restore' | 'done';
  message: string;
  row?: SweepRow;
  /** Median fps measured so far for this tier (while sampling). */
  fps?: number;
};

export async function runSweep(deps: SweepDeps, o: SweepOptions, onProgress: (p: SweepProgress) => void = () => {}, signal?: AbortSignal): Promise<SweepResult> {
  const tiers = o.tiers?.length ? o.tiers : DEFAULT_TIERS;
  const param = o.param ?? 'q';
  const warmupS = o.warmupS ?? 8;
  const sampleS = o.sampleS ?? 15;
  const c = criteriaFor(o);
  tierUrl(o.url, param, tiers[0] as string); // validate early
  const startedAt = deps.now();
  const rows: SweepRow[] = [];
  let page = await deps.openPage();
  let original: string | undefined;
  try {
    original = await page.currentUrl();
  } catch {
    original = undefined;
  }
  onProgress({ progress: 0, phase: 'start', message: `Sweeping ${tiers.join(', ')} on ${o.device.name ?? o.device.id}` });
  const frac = (i: number, f: number) => Math.min(0.99, (i + f) / tiers.length);
  try {
    for (let i = 0; i < tiers.length; i++) {
      if (signal?.aborted) throw new FireLabError('busy', 'Sweep cancelled');
      const tier = tiers[i] as string;
      const url = tierUrl(o.url, param, tier);
      try {
        if (page.closed) page = await deps.openPage();
        onProgress({ progress: frac(i, 0.05), tier, index: i, phase: 'load', message: `${tier}: loading ${url}` });
        const t0 = deps.now();
        await page.navigate(url);
        const loadMs = deps.now() - t0;
        await page.installProbe();
        if (o.action?.keys?.length && deps.pressKeys) {
          onProgress({ progress: frac(i, 0.15), tier, index: i, phase: 'action', message: `${tier}: pressing ${o.action.keys.join(' ')}` });
          await deps.pressKeys(o.action.keys);
        }
        if (o.action?.eval) {
          onProgress({ progress: frac(i, 0.18), tier, index: i, phase: 'action', message: `${tier}: running the action script` });
          await page.eval(o.action.eval, 30000);
        }
        onProgress({ progress: frac(i, 0.2), tier, index: i, phase: 'warmup', message: `${tier}: warming up ${warmupS} s` });
        await deps.sleep(warmupS * 1000, signal);
        await page.installProbe(); // in case the action reloaded the page
        await page.resetFps();
        const cpu0 = deps.nativeSample ? await deps.nativeSample(false).catch(() => undefined) : undefined;
        const fps: FpsSample[] = [];
        const until = deps.now() + sampleS * 1000;
        let tick = 0;
        while (deps.now() < until) {
          await deps.sleep(1000, signal);
          fps.push(...(await page.readFps()));
          tick++;
          if (tick === 1 || tick % 2 === 0) {
            const so = fps.length ? round1(median(fps.map((f) => f.fps))) : undefined;
            onProgress({ progress: frac(i, 0.3 + (0.65 * (sampleS * 1000 - (until - deps.now()))) / (sampleS * 1000)), tier, index: i, phase: 'sample', fps: so, message: `${tier}: measuring (${fps.length} s so far${so !== undefined ? `, ${so} fps median` : ''})` });
          }
        }
        const nat = deps.nativeSample ? await deps.nativeSample(true).catch(() => undefined) : undefined;
        const row: SweepRow = { ...evaluateRow(tier, fps.map((s) => s.fps), c), loadMs };
        if (nat?.memMB !== undefined) row.memMB = nat.memMB;
        if (nat?.cpuPct !== undefined && cpu0) row.cpuPct = nat.cpuPct;
        const scales = fps.map((s) => s.scale).filter((x): x is number => typeof x === 'number');
        if (scales.length) row.scale = Math.round(median(scales) * 100) / 100;
        if (fps[0]) {
          row.source = fps[0].source;
          if (fps[0].counter) row.counter = fps[0].counter;
        }
        rows.push(row);
        onProgress({ progress: frac(i, 1), tier, index: i, phase: 'row', message: `${tier}: ${row.fpsMedian} fps median, ${row.fpsP10} p10 -> ${row.ok ? 'holds' : 'misses'} the target`, row });
      } catch (e) {
        if (signal?.aborted) throw e;
        const msg = (e as Error).message;
        const crashed = page.closed;
        const row: SweepRow = { tier, fpsMedian: 0, fpsP10: 0, ok: false, samples: 0, note: crashed ? `WebView crashed or the app closed (${msg.slice(0, 80)})` : `failed: ${msg.slice(0, 120)}` };
        rows.push(row);
        onProgress({ progress: frac(i, 1), tier, index: i, phase: 'row', message: `${tier}: ${row.note}`, row });
      }
    }
  } finally {
    if (o.restore !== false && original && !/^about:|^chrome-error:/.test(original)) {
      onProgress({ progress: 0.99, phase: 'restore', message: `Restoring ${original}` });
      try {
        if (page.closed) page = await deps.openPage();
        await page.navigate(original);
      } catch {
        /* best effort */
      }
    }
    page.close();
  }
  const result: SweepResult = {
    device: o.device,
    package: o.package,
    url: o.url,
    param,
    criteria: c,
    rows,
    recommendation: recommend(rows, c),
    startedAt,
    durationS: Math.round((deps.now() - startedAt) / 1000),
  };
  onProgress({ progress: 1, phase: 'done', message: result.recommendation ? `Recommended: ${result.recommendation.tier}` : 'Done' });
  return result;
}
