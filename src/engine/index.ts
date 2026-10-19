/**
 * The FireLab Engine's front door (docs/ENGINE.md 10, 13): explore(), replay(),
 * shrink() and report() for the CLI, the MCP server, CI and scripts.
 *
 *   import { explore } from 'firelab';
 *   const r = await explore({ package: 'dev.firelab.fireflylake', minutes: 10, failOn: ['crash', 'black', 'frozen', 'focus-trap'] });
 *   process.exitCode = r.exitCode;
 */
import { FireLabError } from '../lib/errors.js';
import fs from 'node:fs';
import path from 'node:path';
import type { FireLab } from '../core/firelab.js';
import { createDriver } from '../driver/index.js';
import type { DriverKind } from '../driver/types.js';
import type { DeviceDriver } from './driver.js';
import type { Clock } from './clock.js';
import { realClock } from './clock.js';
import type { ExploreConfig, Finding, Severity, Trace } from './types.js';
import type { GpuEmulation } from '../fit/gpu-shim.js';
import { Explorer, newRunId, readRunDir, writeRunFiles, type ExploreEvent, type ExploreResult, type ExplorerOptions } from './explorer.js';
import { buildConfig, DEFAULT_FAIL_ON, DEFAULT_KEYS, exploreDir, failMatcher } from './config.js';
import type { RemoteKey } from './driver.js';
import { readTrace, replayOnce, replayTrace, traceKeys, type ReplayOptions, type ReplayResult } from './trace.js';
import { shrinkTrace, type ShrinkResult } from './minimize.js';
import { writeReport, type ReportOptions } from './report.js';
import { DEMO_PACKAGE } from './demo.js';

export { Explorer, newRunId, readRunDir, writeRunFiles, type ExploreEvent, type ExploreResult, type ExplorerOptions, type CoveragePoint } from './explorer.js';
export { buildConfig, DEFAULT_KEYS, DEFAULT_FAIL_ON, FAIL_CATEGORIES, failMatcher, exploreDir, parseKeyList } from './config.js';
export { readTrace, validateTrace, replayOnce, replayTrace, traceKeys, type ReplayOptions, type ReplayResult, type ReplayRun } from './trace.js';
export { ddmin, loopCuts, shrinkTrace, split, type ShrinkOptions, type ShrinkResult } from './minimize.js';
export { renderReportHtml, renderReportMd, writeReport, keyLabel, type ReportOptions } from './report.js';
export { PROTECTED_PACKAGES } from './session.js';
export { runDemo, DemoGame, VirtualClock, DEMO_PACKAGE, DEMO_BUGS, type DemoBug, type DemoOptions } from './demo.js';
export { realClock, type Clock } from './clock.js';
export type { Action, Cell, ExploreConfig, Finding, Observation, Probe, Severity, State, Trace, TraceStep, Transition } from './types.js';

export type ExploreRequest = {
  /** adb serial or IP (optional with one device); a `vega exec vda devices` serial for Vega. */
  device?: string;
  /** Which device driver: 'adb' (Fire OS / Android TV, default), 'vda' (Vega OS; not yet run on a real device, docs/VEGA.md) or 'demo' (a simulated TV game; no device needed). */
  driverKind?: EngineDriverKind;
  package?: string;
  /** Install this APK first; its package is explored unless `package` is given. */
  apk?: string;
  /** For wrapped web apps: the page URL (passed to the app as the launch intent's `url` extra). */
  url?: string;
  minutes?: number;
  steps?: number;
  seed?: number;
  keys?: string[] | string;
  oracles?: string[];
  stateExpr?: string;
  focusSelector?: string;
  /** JS run after every launch (e.g. "localStorage.clear()"). */
  setup?: string;
  reset?: ExploreConfig['reset'];
  strategy?: ExploreConfig['strategy'];
  /** Shrink findings after exploring (default true). */
  minimize?: boolean;
  /** Shrink budget per finding, minutes (default 20). */
  minimizeMinutes?: number;
  /** Shrink at most this many critical/major findings, most severe first (default 8). */
  minimizeMax?: number;
  visualState?: boolean;
  allowPackages?: string[];
  /** Make WebGL report only this Fire TV model's GPU features and limits (not its speed) and report the calls that fail: a model id, or a resolved GpuEmulation. */
  emulateGpu?: string | GpuEmulation;
  /**
   * Shared knowledge (key priors and bug patterns other runs confirmed): true (default for strategy 'explore')
   * loads knowledge/ in the package and ~/.firelab/knowledge; a list adds files or folders; false turns it off.
   */
  knowledge?: boolean | string[];
  /** Browser driver: show the Chrome window (watch the engine play). */
  headed?: boolean;
  /** false = the MVP explorer without the depth-first changes (for ablations). */
  deep?: boolean;
  /** Collect V8 JS block coverage (true, or a regex over script URLs to count). */
  coverage?: boolean | string;
  /** Extra device profiles for emulateGpu (beat the bundled ones). */
  profilesDir?: string;
  /** Run directory (default ~/.firelab/explore/<runId>). */
  out?: string;
  /** What makes the run fail (exit code 1). Default: critical, major. */
  failOn?: string[];
  /** Another run directory to draw as the baseline in the report. */
  baseline?: string;

  // programmatic only
  driver?: DeviceDriver;
  lab?: FireLab;
  clock?: Clock;
  signal?: AbortSignal;
  onEvent?: (e: ExploreEvent) => void;
  onExplorer?: (x: Explorer) => void;
  explorer?: Pick<ExplorerOptions, 'settle' | 'episodeSteps' | 'plateauSteps' | 'readyMs' | 'maxStateThumbs'>;
  replay?: Pick<ReplayOptions, 'settle' | 'readyMs' | 'tail'>;
};

export type FindingSummary = Pick<Finding, 'id' | 'oracle' | 'kind' | 'severity' | 'title' | 'status' | 'repro' | 'stateId' | 'step' | 'count'> & { keys: string[]; traceLength: number; trace: string; failing: boolean };

export type ExploreSummary = {
  runId: string;
  dir: string;
  report: { html: string; md: string };
  app: ExploreConfig['app'];
  device: ExploreResult['device'];
  strategy: ExploreConfig['strategy'];
  durationS: number;
  steps: number;
  states: number;
  stopped: ExploreResult['stopped'];
  error?: string;
  counts: Record<Severity, number>;
  /** How deep the explored states go (shortest path from launch, in actions). */
  depth?: ExploreResult['depth'];
  /** JS blocks covered (with coverage on). */
  jsBlocks?: number;
  findings: FindingSummary[];
  failOn: string[];
  failed: boolean;
  exitCode: 0 | 1;
  notes: string[];
};

/** The drivers the engine can open: the device drivers, plus 'demo' (Lantern Lake, a simulated TV game). */
export type EngineDriverKind = DriverKind | 'demo';

async function openDriver(req: { device?: string; driverKind?: EngineDriverKind; lab?: FireLab; driver?: DeviceDriver; headed?: boolean }): Promise<{ driver: DeviceDriver; owned: boolean; clock?: Clock }> {
  if (req.driver) return { driver: req.driver, owned: false };
  if (req.driverKind === 'demo') {
    // A fresh simulated game each time, on its own virtual clock (minutes of device time take seconds).
    const { DemoGame } = await import('./demo.js');
    const g = new DemoGame();
    return { driver: g.engineDriver, owned: false, clock: g.clock };
  }
  const kind: DriverKind = req.driverKind ?? 'adb';
  // The FireLab (adb) is only for the adb driver; Vega goes through the `vega` CLI.
  const driver = (await createDriver({ kind, serial: req.device, ...(kind === 'adb' ? { lab: req.lab } : {}), ...(kind === 'browser' && req.headed ? { extra: { headed: true } } : {}) })) as unknown as DeviceDriver;
  return { driver, owned: true };
}

/** A package-like id for a web page in the browser driver: web.<host>. */
export function webPackage(url: string): string {
  try {
    return `web.${new URL(url).host.replace(/[^a-z0-9.]/gi, '_')}`;
  } catch {
    return 'web.page';
  }
}

function keysOf(dir: string, f: Finding): string[] {
  try {
    const t = readTrace(path.join(dir, 'traces', f.minimized ?? f.trace));
    return traceKeys(t.steps);
  } catch {
    return [];
  }
}

export function summarize(r: ExploreResult, report: { html: string; md: string }, failOn: string[]): ExploreSummary {
  const failing = failMatcher(failOn);
  const counts: Record<Severity, number> = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const f of r.findings) counts[f.severity]++;
  const findings: FindingSummary[] = r.findings.map((f) => {
    const keys = keysOf(r.dir, f);
    return {
      id: f.id,
      oracle: f.oracle,
      kind: f.kind,
      severity: f.severity,
      title: f.title,
      status: f.status,
      ...(f.repro ? { repro: f.repro } : {}),
      stateId: f.stateId,
      step: f.step,
      ...(f.count ? { count: f.count } : {}),
      keys,
      traceLength: keys.length,
      trace: path.join(r.dir, 'traces', f.minimized ?? f.trace),
      failing: failing(f) && f.status !== 'not-reproduced',
    };
  });
  const failed = findings.some((f) => f.failing) || r.stopped === 'error';
  return {
    runId: r.runId,
    dir: r.dir,
    report,
    app: r.config.app,
    device: r.device,
    strategy: r.strategy,
    durationS: Math.round(r.durationMs / 1000),
    steps: r.steps,
    states: r.states,
    stopped: r.stopped,
    ...(r.error ? { error: r.error } : {}),
    counts,
    ...(r.depth ? { depth: r.depth } : {}),
    ...(r.jsCoverage ? { jsBlocks: r.jsCoverage.blocks } : {}),
    findings,
    failOn,
    failed,
    exitCode: failed ? 1 : 0,
    notes: r.notes,
  };
}

const SEV_RANK: Record<Severity, number> = { critical: 0, major: 1, minor: 2, info: 3 };

/** Explore an app, shrink what it finds, write the report. */
export async function explore(req: ExploreRequest): Promise<ExploreSummary> {
  const { driver, owned, clock: driverClock } = await openDriver(req);
  try {
    let pkg = req.package ?? (req.driverKind === 'demo' ? DEMO_PACKAGE : undefined);
    if (req.apk) {
      if (!driver.install) throw new FireLabError('unsupported', 'This driver cannot install apps');
      const r = await driver.install(req.apk);
      pkg ??= r.package;
    }
    // In the browser the page is the app: its host names it.
    if (!pkg && driver.kind === 'browser' && req.url) pkg = webPackage(req.url);
    if (!pkg) throw new FireLabError('bad-request', 'Which app? Pass --package <id> or --apk <file.apk>', { hint: 'For a web page, wrap it first: firelab wrap --url <url> --name <name> --install <device>' });
    const runId = newRunId();
    const knowledge = await resolveKnowledge(req);
    const emulateGpu = typeof req.emulateGpu === 'string' ? await resolveGpu(req.emulateGpu, req.profilesDir) : req.emulateGpu;
    const config = buildConfig(
      {
        app: { package: pkg, ...(req.url ? { url: req.url } : {}) },
        minutes: req.minutes,
        steps: req.steps,
        seed: req.seed,
        keys: req.keys,
        oracles: req.oracles,
        stateExpr: req.stateExpr,
        focusSelector: req.focusSelector,
        setupEval: req.setup,
        reset: req.reset,
        strategy: req.strategy,
        minimize: req.minimize,
        minimizeBudgetMin: req.minimizeMinutes,
        visualState: req.visualState,
        allowPackages: req.allowPackages,
        emulateGpu,
        ...(req.deep === false ? { deep: false } : {}),
        ...(knowledge ? { knowledge } : {}),
        ...(req.coverage ? { coverage: typeof req.coverage === 'string' ? { include: req.coverage } : {} } : {}),
        outDir: req.out ? path.resolve(req.out) : undefined,
      },
      runId,
    );
    const clock = req.clock ?? driverClock ?? realClock;
    const x = new Explorer({ driver, config, clock, signal: req.signal, onEvent: req.onEvent, runId, ...req.explorer });
    req.onExplorer?.(x);
    const result = await x.run();

    if (config.minimize && result.findings.length && !req.signal?.aborted && result.stopped !== 'error') {
      x.setPhase('minimize');
      const todo = result.findings
        .filter((f) => f.severity === 'critical' || f.severity === 'major') // device time goes to what matters
        .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.step - b.step)
        .slice(0, req.minimizeMax ?? 8);
      for (const f of todo) {
        if (req.signal?.aborted) break;
        req.onEvent?.({ type: 'phase', phase: 'minimize', detail: `${f.id} ${f.title}` });
        await shrinkFinding(driver, result.dir, f, { budgetMs: (config.minimizeBudgetMin ?? 20) * 60_000, clock, signal: req.signal, replay: req.replay, allowPackages: config.allowPackages });
      }
      writeRunFiles(result);
    }
    x.setPhase('report');
    const baseline = req.baseline ? baselineOf(req.baseline) : undefined;
    const report = writeReport(result, { ...(baseline ? { baseline } : {}) });
    x.setPhase('done');
    return summarize(result, report, req.failOn?.length ? req.failOn : DEFAULT_FAIL_ON);
  } finally {
    if (owned) await driver.close().catch(() => undefined);
  }
}

async function resolveKnowledge(req: ExploreRequest): Promise<ExploreConfig['knowledge']> {
  if (req.knowledge === false || (req.strategy && req.strategy !== 'explore') || req.deep === false) return undefined;
  // FIRELAB_NO_KNOWLEDGE=1 turns off the default packs (tests, reproducible runs); an explicit list still loads.
  if (req.knowledge === undefined && process.env.FIRELAB_NO_KNOWLEDGE) return undefined;
  const { knowledgeDirs, loadKnowledge } = await import('./learn.js');
  const { usablePatterns, scaledPriors, patternWeight } = await import('./knowledge.js');
  const { pack, files } = loadKnowledge(knowledgeDirs(Array.isArray(req.knowledge) ? req.knowledge : []));
  if (!files.length) return undefined;
  const keys = (typeof req.keys === 'string' ? req.keys.split(/[\s,]+/) : req.keys ?? DEFAULT_KEYS) as RemoteKey[];
  const patterns = usablePatterns(pack, keys.length ? keys : DEFAULT_KEYS).slice(0, 40).map(({ pattern }) => ({ id: pattern.id, kind: pattern.kind, keys: pattern.keys, weight: Math.round(patternWeight(pattern) * 10) / 10 }));
  return { keyPriors: Object.fromEntries(scaledPriors(pack)), patterns, files: files.length };
}

async function resolveGpu(model: string, profilesDir?: string): Promise<GpuEmulation> {
  const [{ gpuEmulationFor }, { loadProfiles }, { profileDirs }] = await Promise.all([import('../fit/gpu-emulate.js'), import('../profile/load.js'), import('../fit/cli.js')]);
  try {
    return gpuEmulationFor(model, loadProfiles(profileDirs(profilesDir)).profiles);
  } catch (e) {
    throw new FireLabError('bad-request', (e as Error).message, { hint: 'Pass a Fire TV model id, e.g. --emulate-gpu AFTSSS' });
  }
}

function baselineOf(dir: string): ReportOptions['baseline'] {
  try {
    const b = readRunDir(dir);
    return { label: b.strategy === 'random' ? 'random baseline' : b.strategy === 'monkey' ? 'Monkey baseline' : `run ${b.runId}`, coverage: b.coverage, findings: b.findings.length };
  } catch {
    return undefined;
  }
}

/** Shrinks one finding in place: writes traces/<id>.min.trace.json and updates the finding. */
export async function shrinkFinding(
  driver: DeviceDriver,
  dir: string,
  f: Finding,
  o: { budgetMs?: number; clock?: Clock; signal?: AbortSignal; replay?: ExploreRequest['replay']; allowPackages?: string[]; onProgress?: (m: string) => void } = {},
): Promise<ShrinkResult> {
  const trace = readTrace(path.join(dir, 'traces', f.trace));
  const r = await shrinkTrace(trace, {
    replay: async (t) => (await replayOnce(driver, t, { clock: o.clock, signal: o.signal, allowPackages: o.allowPackages, ...o.replay })).hit,
    budgetMs: o.budgetMs,
    clock: o.clock,
    signal: o.signal,
    onProgress: o.onProgress,
  });
  f.status = r.status;
  f.repro = r.repro;
  f.shrink = { before: r.before, after: r.after, tests: r.tests, ms: r.ms };
  if (r.status !== 'not-reproduced') {
    const name = f.trace.replace(/\.trace\.json$/, '.min.trace.json');
    fs.writeFileSync(path.join(dir, 'traces', name), JSON.stringify(r.trace, null, 1));
    f.minimized = name;
  }
  return r;
}

/** `firelab replay <trace>`: k/n reproductions of trace.expect. */
export async function replay(req: { trace: string | Trace; device?: string; driverKind?: EngineDriverKind; times?: number; lab?: FireLab; driver?: DeviceDriver; clock?: Clock; signal?: AbortSignal; allowPackages?: string[]; onStep?: ReplayOptions['onStep'] }): Promise<ReplayResult & { keys: string[] }> {
  const trace = typeof req.trace === 'string' ? readTrace(req.trace) : req.trace;
  const { driver, owned, clock: driverClock } = await openDriver(req);
  try {
    const r = await replayTrace(driver, trace, Math.max(1, req.times ?? 1), { clock: req.clock ?? driverClock, signal: req.signal, allowPackages: req.allowPackages, stopOnHit: true, onStep: req.onStep });
    return { ...r, keys: traceKeys(trace.steps) };
  } finally {
    if (owned) await driver.close().catch(() => undefined);
  }
}

/**
 * `firelab shrink <trace.json | runDir:findingId>`: writes <name>.min.trace.json.
 * For a run's finding it also updates findings.json and the report.
 */
export async function shrink(req: { target: string; device?: string; driverKind?: EngineDriverKind; budgetMin?: number; lab?: FireLab; driver?: DeviceDriver; clock?: Clock; signal?: AbortSignal; allowPackages?: string[]; onProgress?: (m: string) => void }): Promise<{ before: number; after: number; status: Finding['status']; repro: { hits: number; runs: number }; tests: number; file: string; keys: string[] }> {
  const { driver, owned, clock: driverClock } = await openDriver(req);
  const clock = req.clock ?? driverClock;
  try {
    const m = /^(.*):(f-[0-9a-f]+)$/.exec(req.target);
    if (m && !req.target.endsWith('.json')) {
      const dir = resolveRunDir(m[1] as string);
      const run = readRunDir(dir);
      const f = run.findings.find((x) => x.id === m[2]);
      if (!f) throw new FireLabError('not-found', `No finding ${m[2]} in ${dir}`);
      const r = await shrinkFinding(driver, dir, f, { budgetMs: (req.budgetMin ?? 20) * 60_000, clock, signal: req.signal, allowPackages: req.allowPackages, onProgress: req.onProgress });
      writeRunFiles(run);
      writeReport(run);
      return { before: r.before, after: r.after, status: r.status, repro: r.repro, tests: r.tests, file: path.join(dir, 'traces', f.minimized ?? f.trace), keys: traceKeys(r.trace.steps) };
    }
    const trace = readTrace(req.target);
    const r = await shrinkTrace(trace, {
      replay: async (t) => (await replayOnce(driver, t, { clock, signal: req.signal, allowPackages: req.allowPackages })).hit,
      budgetMs: (req.budgetMin ?? 20) * 60_000,
      clock,
      signal: req.signal,
      onProgress: req.onProgress,
    });
    const file = req.target.replace(/(\.trace)?\.json$/, '') + '.min.trace.json';
    if (r.status !== 'not-reproduced') fs.writeFileSync(file, JSON.stringify(r.trace, null, 1));
    return { before: r.before, after: r.after, status: r.status, repro: r.repro, tests: r.tests, file, keys: traceKeys(r.trace.steps) };
  } finally {
    if (owned) await driver.close().catch(() => undefined);
  }
}

/** A run id or a directory -> the run directory. */
export function resolveRunDir(idOrDir: string): string {
  if (fs.existsSync(path.join(idOrDir, 'run.json'))) return path.resolve(idOrDir);
  const d = path.join(exploreDir(), idOrDir);
  if (fs.existsSync(path.join(d, 'run.json'))) return d;
  throw new FireLabError('not-found', `No explore run at ${idOrDir}`, { hint: `Looked for run.json there and in ${exploreDir()}` });
}

/** `firelab report <runId | dir>`: regenerates report.html / report.md. */
export function report(idOrDir: string, opts: { baseline?: string; dirLabel?: string } = {}): { html: string; md: string; run: ExploreResult } {
  const run = readRunDir(resolveRunDir(idOrDir));
  const baseline = opts.baseline ? baselineOf(resolveRunDir(opts.baseline)) : undefined;
  return { ...writeReport(run, { ...(baseline ? { baseline } : {}), ...(opts.dirLabel ? { dirLabel: opts.dirLabel } : {}) }), run };
}

/** Lists past runs, newest first. */
export function listRuns(limit = 20): { runId: string; dir: string; package: string; startedAt: number; steps: number; states: number; findings: number }[] {
  const root = exploreDir();
  if (!fs.existsSync(root)) return [];
  const out: { runId: string; dir: string; package: string; startedAt: number; steps: number; states: number; findings: number }[] = [];
  for (const name of fs.readdirSync(root)) {
    try {
      const r = readRunDir(path.join(root, name));
      out.push({ runId: r.runId, dir: r.dir, package: r.config.app.package, startedAt: r.startedAt, steps: r.steps, states: r.states, findings: r.findings.length });
    } catch {
      /* not a run */
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

// ---------- background runs (MCP explore_start / status / stop / findings) ----------

export type ExploreJob = {
  runId: string;
  status: 'starting' | 'running' | 'minimizing' | 'reporting' | 'done' | 'failed' | 'stopped';
  startedAt: number;
  request: Omit<ExploreRequest, 'driver' | 'lab' | 'signal' | 'onEvent' | 'onExplorer' | 'clock'>;
  explorer?: Explorer;
  summary?: ExploreSummary;
  error?: string;
  done: Promise<ExploreSummary | undefined>;
  abort: AbortController;
};

const jobs = new Map<string, ExploreJob>();

/** Starts explore() in the background; returns at once. */
export function startExploreJob(req: ExploreRequest): ExploreJob {
  const abort = new AbortController();
  const { driver: _d, lab: _l, signal: _s, onEvent: _e, onExplorer: _x, clock: _c, ...request } = req;
  const job = { runId: '', status: 'starting', startedAt: Date.now(), request, abort } as ExploreJob;
  const tmpId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  job.runId = tmpId;
  jobs.set(tmpId, job);
  job.done = explore({
    ...req,
    signal: abort.signal,
    onExplorer: (x) => {
      job.explorer = x;
      jobs.delete(job.runId);
      job.runId = x.runId;
      jobs.set(x.runId, job);
      job.status = 'running';
      req.onExplorer?.(x);
    },
    onEvent: (e) => {
      if (e.type === 'phase') job.status = e.phase === 'minimize' ? 'minimizing' : e.phase === 'report' ? 'reporting' : job.status;
      req.onEvent?.(e);
    },
  }).then(
    (s) => {
      job.summary = s;
      job.status = abort.signal.aborted ? 'stopped' : 'done';
      return s;
    },
    (e: unknown) => {
      job.error = (e as Error)?.message ?? String(e);
      job.status = 'failed';
      return undefined;
    },
  );
  return job;
}

export function getExploreJob(runId: string): ExploreJob | undefined {
  return jobs.get(runId);
}

export function exploreJobs(): ExploreJob[] {
  return [...jobs.values()];
}

/** Waits until the background run has its run id (or failed). */
export async function waitForRunId(job: ExploreJob, ms = 60_000): Promise<string> {
  const t0 = Date.now();
  while (job.status === 'starting' && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
  return job.runId;
}
