/**
 * `firelab bench`: FireLab's engine against baselines, on the same games, the
 * same budget and repeated seeds, scored on engine-independent ground truth.
 *
 * Protocol (Klees et al., CCS 2018; Arcuri and Briand, ICSE 2011; docs/ENGINE.md 12):
 * every strategy gets the same subjects, wall-clock budget and number of runs
 * (one seed per run); strategies are interleaved so machine load is shared;
 * results are medians with IQR, Mann-Whitney U with Vargha-Delaney A12 for
 * continuous metrics and Fisher's exact test for "triggered bug X in a run".
 *
 * Runs use the browser driver (headless Chrome at the Fire TV viewport), so a
 * benchmark of dozens of runs finishes in hours on a laptop.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { explore, type ExploreSummary } from '../engine/index.js';
import { readRunDir } from '../engine/explorer.js';
import type { DeviceDriver } from '../engine/driver.js';
import { BrowserDriver } from '../driver/browser.js';
import { dataDir, firelabVersion } from '../lib/paths.js';
import type { BenchSubject } from './subjects.js';

export type BenchStrategy = 'firelab' | 'firelab-k' | 'firelab-mvp' | 'random' | 'monkey';
export const STRATEGIES: Record<BenchStrategy, { label: string; what: string }> = {
  firelab: { label: 'FireLab', what: 'the engine: Go-Explore archive with frontier and depth selection, dive order, coverage reward, focus walks' },
  'firelab-k': { label: 'FireLab + knowledge', what: 'FireLab with a shared knowledge pack (--knowledge): key priors and bug patterns learned on other games' },
  'firelab-mvp': { label: 'FireLab (MVP)', what: 'ablation: the first engine version (depth capped at 20, no frontier term, fixed episodes, no dive order, no coverage reward)' },
  random: { label: 'Random', what: 'uniform random remote keys, same pace and oracles' },
  monkey: { label: 'Monkey', what: "Android Monkey's D-pad event mix (nav 60%, majornav 35%, syskeys 5%), same pace and oracles" },
};

export type BenchRun = {
  subject: string;
  strategy: BenchStrategy;
  rep: number;
  seed: number;
  minutes: number;
  steps: number;
  states: number;
  maxDepth: number;
  jsBlocks: number;
  progress?: number;
  /** Seeded bugs the game says fired, with seconds from the run's start. */
  triggered: Record<string, number>;
  /** Seeded bugs the strategy reported (a matching finding after the bug fired). */
  detected: Record<string, number>;
  findings: { kind: string; severity: string; title: string; step: number; t: number }[];
  /** [seconds, blocks, states] samples. */
  curve: [number, number, number][];
  error?: string;
  dir: string;
};

export type BenchResult = {
  kind: 'firelab-bench';
  id: string;
  title: string;
  createdAt: string;
  firelabVersion: string;
  machine: { platform: string; node: string; chrome?: string };
  subjects: string[];
  subjectInfo: Record<string, Pick<BenchSubject, 'id' | 'name' | 'progressLabel' | 'notes'> & { bugs: { id: string; what: string; depth: number }[] }>;
  strategies: BenchStrategy[];
  runsPer: number;
  minutes: number;
  runs: BenchRun[];
  headline?: string;
};

export type BenchOptions = {
  subjects: BenchSubject[];
  strategies: BenchStrategy[];
  runs: number;
  minutes: number;
  /** Runs at the same time (separate Chromes). Default 2. */
  parallel?: number;
  out?: string;
  title?: string;
  headed?: boolean;
  /** Base seed: run r uses seed + r. */
  seed?: number;
  onProgress?: (msg: string) => void;
  /** Knowledge pack(s) for the 'firelab-k' strategy. Learn them on other games, or the result means nothing. */
  knowledge?: string[];
  /** Tests: make the driver (default: a BrowserDriver). */
  driverFor?: (subject: BenchSubject) => DeviceDriver;
};

const GROUND_TRUTH = `(() => ({ hit: window.firelabBugsHit || {}, depth: window.firelabDepth || null, t: Math.round(performance.now()) }))()`;

/** Serves the repository's examples/ folder on a free local port. */
export async function serveExamples(root?: string): Promise<{ url: string; close(): Promise<void> }> {
  const base = root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples');
  if (!fs.existsSync(base)) throw new Error(`No examples/ folder at ${base}: run the built-in subjects from a FireLab checkout, or pass --subject name=url`);
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm' };
  const repo = path.dirname(base);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    let p = decodeURIComponent(u.pathname);
    // /examples/... and /packages/... (Firefly Lake imports @firelab/perf from the repository).
    const file = path.normalize(path.join(repo, p));
    if (!file.startsWith(repo + path.sep) || /[\\/]\.|node_modules/.test(p)) return void res.writeHead(403).end();
    let f = file;
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/examples/`, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * Wraps a driver so the game's ground truth is read before every relaunch and
 * every 10 key presses (a relaunch makes a new page and forgets it).
 */
function withGroundTruth(d: DeviceDriver, onTruth: (hit: Record<string, number>, depth: number | undefined) => void): DeviceDriver {
  let presses = 0;
  let launchedAt = 0;
  let pageT0 = 0;
  const read = async () => {
    try {
      const r = (await d.evaluate?.(GROUND_TRUTH, { timeoutMs: 3000 })) as { hit: Record<string, number>; depth: { floor?: number } | null; t: number } | undefined;
      if (!r) return;
      // Page time -> wall time since this launch.
      const hit: Record<string, number> = {};
      for (const [k, ms] of Object.entries(r.hit)) hit[k] = launchedAt + (ms - pageT0);
      onTruth(hit, r.depth?.floor);
    } catch {
      /* no page right now */
    }
  };
  return new Proxy(d, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== 'function') return v;
      if (prop === 'launch')
        return async (...a: unknown[]) => {
          await read();
          const r = await (v as (...x: unknown[]) => Promise<unknown>).apply(target, a);
          launchedAt = Date.now();
          pageT0 = 0;
          return r;
        };
      if (prop === 'stop' || prop === 'reset' || prop === 'close')
        return async (...a: unknown[]) => {
          await read();
          return (v as (...x: unknown[]) => Promise<unknown>).apply(target, a);
        };
      if (prop === 'press')
        return async (...a: unknown[]) => {
          const r = await (v as (...x: unknown[]) => Promise<unknown>).apply(target, a);
          if (++presses % 10 === 0) await read();
          return r;
        };
      return v.bind(target);
    },
  });
}

async function oneRun(o: BenchOptions, subject: BenchSubject, url: string, strategy: BenchStrategy, rep: number, root: string, chrome: { v?: string }): Promise<BenchRun> {
  const seed = (o.seed ?? 1) + rep;
  const dir = path.join(root, 'runs', `${subject.id}-${strategy}-${rep + 1}`);
  const t0 = Date.now();
  const triggered: Record<string, number> = {};
  let progress: number | undefined;
  const raw = o.driverFor ? o.driverFor(subject) : new BrowserDriver({ headed: !!o.headed, serial: `bench-${strategy}-${rep + 1}` });
  if (!chrome.v) chrome.v = (await raw.info().catch(() => ({ name: undefined }))).name;
  const driver = withGroundTruth(raw, (hit, depth) => {
    for (const [k, t] of Object.entries(hit)) if (triggered[k] === undefined) triggered[k] = Math.max(0, Math.round((t - t0) / 100) / 10);
    if (depth !== undefined) progress = Math.max(progress ?? 0, depth);
  });
  let summary: ExploreSummary | undefined;
  let error: string | undefined;
  try {
    summary = await explore({
      driver,
      url,
      minutes: o.minutes,
      seed,
      strategy: strategy === 'random' ? 'random' : strategy === 'monkey' ? 'monkey' : 'explore',
      deep: strategy !== 'firelab-mvp',
      // Only firelab-k uses shared knowledge, and only the packs given: bundled packs may have been learned on these games.
      knowledge: strategy === 'firelab-k' ? (o.knowledge ?? []) : false,
      coverage: subject.coverageInclude ?? true,
      ...(subject.stateExpr ? { stateExpr: subject.stateExpr } : {}),
      ...(subject.focusSelector ? { focusSelector: subject.focusSelector } : {}),
      minimize: false,
      out: dir,
    });
  } catch (e) {
    error = (e as Error).message;
  } finally {
    await driver.close().catch(() => undefined);
  }
  const r = fs.existsSync(path.join(dir, 'run.json')) ? readRunDir(dir) : undefined;
  const findings = (r?.findings ?? []).map((f) => ({ kind: f.kind, severity: f.severity, title: f.title, step: f.step, t: Math.round((f.ts - (r?.startedAt ?? t0)) / 100) / 10, detail: f.detail }));
  const detected: Record<string, number> = {};
  for (const b of subject.bugs) {
    if (triggered[b.id] === undefined) continue;
    const f = findings.filter((x) => b.matches(x)).sort((a, z) => a.t - z.t)[0];
    if (f) detected[b.id] = Math.max(f.t, triggered[b.id] as number);
  }
  const curve: [number, number, number][] = (r?.coverage ?? []).map((p) => [Math.round(p.t / 1000), p.blocks ?? 0, p.states]);
  return {
    subject: subject.id,
    strategy,
    rep,
    seed,
    minutes: o.minutes,
    steps: r?.steps ?? summary?.steps ?? 0,
    states: r?.states ?? 0,
    maxDepth: r?.depth?.max ?? 0,
    jsBlocks: r?.jsCoverage?.blocks ?? 0,
    ...(progress !== undefined ? { progress } : {}),
    triggered,
    detected,
    findings: findings.map(({ detail: _d, ...f }) => f),
    curve,
    ...(error ?? r?.error ? { error: error ?? r?.error } : {}),
    dir,
  };
}

export async function runBench(o: BenchOptions): Promise<{ result: BenchResult; dir: string }> {
  const id = `bench-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2')}`;
  const root = path.resolve(o.out ?? path.join(dataDir(), 'bench', id));
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
  const log = o.onProgress ?? (() => {});
  const needServer = o.subjects.some((s) => !s.url);
  const server = needServer ? await serveExamples() : undefined;
  const chrome: { v?: string } = {};
  const result: BenchResult = {
    kind: 'firelab-bench',
    id,
    title: o.title ?? `FireLab engine benchmark: ${o.subjects.map((s) => s.id).join(', ')}`,
    createdAt: new Date().toISOString(),
    firelabVersion: firelabVersion(),
    machine: { platform: `${process.platform} ${process.arch}`, node: process.version },
    subjects: o.subjects.map((s) => s.id),
    subjectInfo: Object.fromEntries(o.subjects.map((s) => [s.id, { id: s.id, name: s.name, ...(s.progressLabel ? { progressLabel: s.progressLabel } : {}), ...(s.notes ? { notes: s.notes } : {}), bugs: s.bugs.map((b) => ({ id: b.id, what: b.what, depth: b.depth })) }])),
    strategies: o.strategies,
    runsPer: o.runs,
    minutes: o.minutes,
    runs: [],
  };
  // Interleave: rep-major, then subject, then strategy, so load and network conditions are shared.
  const queue: { subject: BenchSubject; strategy: BenchStrategy; rep: number }[] = [];
  for (let rep = 0; rep < o.runs; rep++) for (const subject of o.subjects) for (const strategy of o.strategies) queue.push({ subject, strategy, rep });
  const total = queue.length;
  let done = 0;
  let started = 0;
  const save = () => fs.writeFileSync(path.join(root, 'bench.json'), JSON.stringify(result, null, 1));
  try {
    const worker = async () => {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        const url = job.subject.url ?? `${server?.url}${job.subject.path}`;
        log(`[${++started}/${total}] ${job.subject.id} · ${STRATEGIES[job.strategy].label} · run ${job.rep + 1}/${o.runs} (${o.minutes} min)`);
        const run = await oneRun(o, job.subject, url, job.strategy, job.rep, root, chrome);
        result.runs.push(run);
        done++;
        log(`  -> ${run.states} states, ${run.jsBlocks} JS blocks, depth ${run.maxDepth}${run.progress !== undefined ? `, progress ${run.progress}` : ''}, triggered ${Object.keys(run.triggered).join(',') || '-'}, detected ${Object.keys(run.detected).join(',') || '-'}${run.error ? ` (error: ${run.error})` : ''}`);
        save();
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.parallel ?? 2, total)) }, worker));
  } finally {
    await server?.close();
  }
  if (chrome.v) result.machine.chrome = chrome.v;
  const { benchHeadline, writeBenchReport } = await import('./report.js');
  result.headline = benchHeadline(result);
  save();
  writeBenchReport(result, root);
  return { result, dir: root };
}
