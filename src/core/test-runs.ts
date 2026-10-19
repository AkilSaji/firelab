/**
 * The dashboard's quick tests, each a background TestJob (src/core/tests.ts)
 * built from FireLab's existing features: lab smoke (app launch), the engine
 * (navigation, explore, replay), measure (performance) and the GPU shim
 * (GPU check). Nothing here invents a number: a value the device didn't give
 * is left out, and a test that couldn't measure says "skip".
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FireLab } from './firelab.js';
import type { TestJob, TestKind } from './tests.js';
import type { ExploreEvent, ExploreJob, ExploreRequest, ReplayResult, Trace } from '../engine/index.js';
import { FireLabError, errorMessage } from '../lib/errors.js';
import { sleep } from '../lib/util.js';
import { log } from '../lib/log.js';

const engine = () => import('../engine/index.js');

/** Explore options the dashboard may send (the rest of ExploreRequest stays programmatic). */
export type ExploreOptions = Pick<ExploreRequest, 'package' | 'url' | 'minutes' | 'steps' | 'seed' | 'keys' | 'oracles' | 'stateExpr' | 'focusSelector' | 'strategy' | 'emulateGpu' | 'failOn' | 'minimize' | 'minimizeMinutes' | 'minimizeMax'> & {
  /** 'demo' runs Lantern Lake, the simulated game, instead of the device. */
  driver?: 'adb' | 'demo';
};

const PROTECTED = ['com.sunsetvilla.tv'];

function refuseProtected(pkg: string | undefined): void {
  if (pkg && PROTECTED.includes(pkg)) {
    throw new FireLabError('confirm-required', `${pkg} holds someone's real progress: FireLab's tests won't relaunch or drive it`, { hint: 'Test a build with its own package id' });
  }
}

async function claim(lab: FireLab, id: string | undefined, demo = false): Promise<string> {
  if (demo) return 'demo-tv';
  const serial = await lab.resolveDevice(id);
  const t = lab.tests.runningFor(serial);
  if (t) throw new FireLabError('busy', `A test is already running on ${serial} (${t.name})`, { hint: 'Stop it from Test Execution, or wait for it to finish' });
  const s = lab.jobs.runningFor(serial);
  if (s) throw new FireLabError('busy', `A sweep is running on ${serial} (${s.id})`);
  return serial;
}

/** The foreground app, unless it is the TV's home screen (testing the launcher is never what was meant). */
async function foregroundPackage(lab: FireLab, serial: string): Promise<string | undefined> {
  const pkg = (await lab.foreground(serial).catch(() => null))?.package;
  return pkg && !/launcher|tvlauncher|\.home$|settings/i.test(pkg) ? pkg : undefined;
}

// ---------------------------------------------------------------- app launch

export async function startAppLaunch(lab: FireLab, id: string | undefined, req: { package?: string; url?: string; settleS?: number; maxLaunchMs?: number }): Promise<TestJob> {
  const serial = await claim(lab, id);
  const pkg = req.package ?? (await foregroundPackage(lab, serial));
  if (!pkg) throw new FireLabError('bad-request', 'Which app? Pick one in Apps first', { hint: 'e.g. { "package": "com.example.game" }' });
  refuseProtected(pkg);
  const settleS = Math.min(Math.max(req.settleS ?? 8, 3), 60);
  const abort = new AbortController();
  const job = lab.tests.create('app-launch', serial, `App launch · ${pkg}`, { ...req, package: pkg, settleS }, { package: pkg, estimatedMs: (settleS + 12) * 1000, abort });
  void runAppLaunch(lab, job.id, serial, pkg, settleS, req);
  return job;
}

async function runAppLaunch(lab: FireLab, jobId: string, serial: string, pkg: string, settleS: number, req: { url?: string; maxLaunchMs?: number }): Promise<void> {
  const T = lab.tests;
  try {
    const [{ runSmoke }, budget] = await Promise.all([import('../lab/smoke.js'), memoryBudget(lab, serial)]);
    if (budget) T.step(jobId, `Memory budget for ${budget.model}: ${budget.budgetMB ?? '?'} MB comfortable, ${budget.limitMB ?? '?'} MB limit (${budget.source})`, 'info');
    else T.step(jobId, 'No memory budget for this model: memory is reported, not judged', 'info');
    const order = ['Launching', 'Letting it run', 'Screenshot', 'Memory', 'Logcat'];
    const r = await runSmoke(lab, {
      device: serial,
      package: pkg,
      ...(req.url ? { url: req.url } : {}),
      outDir: T.filesDir(jobId) ?? path.join(lab.home, 'tests', jobId),
      settleS,
      maxLaunchMs: req.maxLaunchMs ?? 5000,
      strictLaunch: req.maxLaunchMs !== undefined,
      ...(budget?.budgetMB !== undefined ? { budgetMB: budget.budgetMB } : {}),
      ...(budget?.limitMB !== undefined ? { limitMB: budget.limitMB } : {}),
      ...(budget?.model ? { model: budget.model } : {}),
      onStep: (s) => {
        const i = order.findIndex((o) => s.startsWith(o));
        T.update(jobId, { phase: s, ...(i >= 0 ? { progress: (i + 0.5) / order.length } : {}) });
        T.step(jobId, s);
      },
    });
    const word = { pass: 'ok', warn: 'warn', fail: 'fail', skip: 'info' } as const;
    for (const c of r.checks) T.step(jobId, `${c.title}: ${c.detail}`, word[c.status]);
    const launch = r.checks.find((c) => c.id === 'launch-time')?.value;
    const mem = r.checks.find((c) => c.id === 'memory')?.value;
    T.finish(jobId, r.verdict, {
      checks: r.checks,
      problems: r.problems,
      ...(launch !== undefined ? { launchMs: launch } : {}),
      ...(mem !== undefined ? { memMB: mem } : {}),
      ...(budget ? { budget } : {}),
      ...(r.screenshot ? { screenshot: `/api/tests/${jobId}/files/${path.basename(r.screenshot)}` } : {}),
      ...(r.logcat ? { logcat: `/api/tests/${jobId}/files/${path.basename(r.logcat)}` } : {}),
      notes: r.notes,
    });
  } catch (e) {
    T.fail(jobId, errorMessage(e));
  }
}

/** The model's memory budget from fit's model table (profile-measured or estimated). */
async function memoryBudget(lab: FireLab, serial: string): Promise<{ model: string; budgetMB?: number; limitMB?: number; source: string } | undefined> {
  try {
    const info = await lab.deviceInfo(serial);
    if (!info.model) return undefined;
    const [{ buildTargets }, { loadProfiles }, { profileDirs }] = await Promise.all([import('../fit/targets.js'), import('../profile/load.js'), import('../fit/cli.js')]);
    const t = buildTargets(loadProfiles(profileDirs()).profiles, [info.model])[0];
    if (!t) return undefined;
    const b = t.memory.budgetMB;
    const l = t.memory.limitMB;
    if (b.value === null && l.value === null) return undefined;
    return { model: info.model, ...(b.value !== null ? { budgetMB: b.value } : {}), ...(l.value !== null ? { limitMB: l.value } : {}), source: b.source };
  } catch (e) {
    log.debug('memory budget failed', e);
    return undefined;
  }
}

// ---------------------------------------------------------------- performance

export async function startPerformance(lab: FireLab, id: string | undefined, req: { package?: string; seconds?: number; targetFps?: number }): Promise<TestJob> {
  const serial = await claim(lab, id);
  const pkg = req.package ?? (await foregroundPackage(lab, serial));
  const seconds = Math.min(Math.max(req.seconds ?? 15, 5), 120);
  const targetFps = Math.min(Math.max(req.targetFps ?? 30, 10), 120);
  const abort = new AbortController();
  const job = lab.tests.create('performance', serial, `Performance · ${pkg ?? 'foreground app'}`, { ...req, seconds, targetFps }, { ...(pkg ? { package: pkg } : {}), estimatedMs: (seconds + 3) * 1000, abort });
  void runPerformance(lab, job.id, serial, pkg, seconds, targetFps);
  return job;
}

async function runPerformance(lab: FireLab, jobId: string, serial: string, pkg: string | undefined, seconds: number, targetFps: number): Promise<void> {
  const T = lab.tests;
  const t0 = Date.now();
  const tick = setInterval(() => T.update(jobId, { progress: Math.min(0.99, (Date.now() - t0) / ((seconds + 3) * 1000)) }), 1000);
  try {
    const { criteriaFor } = await import('../perf/sweep.js');
    const crit = criteriaFor({ targetFps });
    T.update(jobId, { phase: 'sampling' });
    T.step(jobId, `Sampling ${pkg ?? 'the foreground app'} for ${seconds} s against ${targetFps} fps (median ≥ ${Math.round(targetFps * (1 - crit.tolerance) * 10) / 10}, p10 ≥ ${crit.minP10})`);
    const m = await lab.measure(serial, { ...(pkg ? { package: pkg } : {}), seconds });
    const f = m.fps;
    let verdict: TestJob['verdict'];
    if (!f || f.samples < crit.minSamples) {
      verdict = 'skip';
      T.step(jobId, f ? `Only ${f.samples} fps samples: not enough to judge` : 'No frame rate from this app (no WebView and no SurfaceFlinger frames)', 'warn');
    } else {
      const okMed = f.median >= targetFps * (1 - crit.tolerance);
      const okP10 = f.p10 >= crit.minP10;
      verdict = okMed && okP10 ? 'pass' : 'fail';
      T.step(jobId, `fps median ${f.median}, p10 ${f.p10}, min ${f.min} (${f.samples} samples, source ${f.source})`, verdict === 'pass' ? 'ok' : 'fail');
    }
    if (m.memMB !== undefined) T.step(jobId, `Memory ${m.memMB} MB`, 'info');
    if (m.cpuPct !== undefined) T.step(jobId, `CPU ${m.cpuPct}% of one core`, 'info');
    for (const n of m.notes) T.step(jobId, n, 'info');
    T.finish(jobId, verdict, { measurement: m, criteria: crit });
  } catch (e) {
    T.fail(jobId, errorMessage(e));
  } finally {
    clearInterval(tick);
  }
}

// ---------------------------------------------------------------- GPU check

export type GpuModel = { model: string; name: string; gpu?: string; kind: string; year?: number; platform?: string; tier?: string; emulatable: boolean; reason?: string };

let modelCache: GpuModel[] | undefined;

/** Fire TV models with their GPU, and whether FireLab can emulate that GPU's WebGL features. */
export async function gpuModels(): Promise<GpuModel[]> {
  if (modelCache) return modelCache;
  const [{ FIRE_TV_MODELS, tierForModel }, { gpuEmulationFor }, { loadProfiles }, { profileDirs }] = await Promise.all([
    import('../adb/models.js'),
    import('../fit/gpu-emulate.js'),
    import('../profile/load.js'),
    import('../fit/cli.js'),
  ]);
  let profiles = new Map();
  try {
    profiles = loadProfiles(profileDirs()).profiles;
  } catch {
    /* bundled table only */
  }
  modelCache = FIRE_TV_MODELS.map((m) => {
    const out: GpuModel = { model: m.model, name: m.name, kind: m.kind, emulatable: false, ...(m.gpu ? { gpu: m.gpu } : {}), ...(m.year ? { year: m.year } : {}), ...(m.platform ? { platform: m.platform } : {}) };
    const tier = tierForModel(m.model);
    if (tier) out.tier = tier;
    try {
      gpuEmulationFor(m.model, profiles);
      out.emulatable = true;
    } catch (e) {
      out.reason = (e as Error).message;
    }
    return out;
  });
  return modelCache;
}

export async function startGpuCheck(lab: FireLab, id: string | undefined, req: { model?: string; package?: string; url?: string; seconds?: number }): Promise<TestJob> {
  if (!req.model) throw new FireLabError('bad-request', 'Pick a Fire TV model to emulate', { hint: 'e.g. { "model": "AFTSSS" } (GET /api/gpu/models lists them)' });
  const serial = await claim(lab, id);
  const pkg = req.package ?? (await foregroundPackage(lab, serial));
  refuseProtected(pkg);
  const seconds = Math.min(Math.max(req.seconds ?? 20, 5), 300);
  const [{ gpuEmulationFor }, { loadProfiles }, { profileDirs }] = await Promise.all([import('../fit/gpu-emulate.js'), import('../profile/load.js'), import('../fit/cli.js')]);
  let emu;
  try {
    emu = gpuEmulationFor(req.model, loadProfiles(profileDirs()).profiles);
  } catch (e) {
    throw new FireLabError('bad-request', (e as Error).message);
  }
  const abort = new AbortController();
  const job = lab.tests.create('gpu', serial, `GPU check · ${emu.name} (${emu.model})`, { ...req, seconds, ...(pkg ? { package: pkg } : {}) }, { ...(pkg ? { package: pkg } : {}), estimatedMs: (seconds + 10) * 1000, abort });
  void runGpuCheck(lab, job.id, serial, pkg, emu, seconds, req.url, abort.signal);
  return job;
}

async function runGpuCheck(lab: FireLab, jobId: string, serial: string, pkg: string | undefined, emu: import('../fit/gpu-shim.js').GpuEmulation, seconds: number, url: string | undefined, signal: AbortSignal): Promise<void> {
  const T = lab.tests;
  const t0 = Date.now();
  const tick = setInterval(() => T.update(jobId, { progress: Math.min(0.99, (Date.now() - t0) / ((seconds + 10) * 1000)) }), 1000);
  try {
    const [{ runGpuEmulation }, { fitDepsFromLab }] = await Promise.all([import('../fit/gpu-emulate.js'), import('../fit/lab.js')]);
    T.step(jobId, `${emu.renderer}: copies the GPU's WebGL features and limits, not its speed`, 'info');
    const { deps } = await fitDepsFromLab(lab, serial, pkg);
    if (!deps.openPage) throw new FireLabError('no-webview', 'No WebView page to load: the GPU check needs a debuggable WebView app');
    const page = await deps.openPage();
    let r;
    try {
      r = await runGpuEmulation(page, emu, {
        ...(url ? { url } : {}),
        seconds,
        sleep: (ms) => sleep(ms, signal).catch(() => undefined),
        onProgress: (m) => {
          T.update(jobId, { phase: /running/.test(m) ? 'running' : 'loading' });
          T.step(jobId, m);
        },
      });
    } finally {
      page.close();
    }
    for (const f of r.failures) T.step(jobId, `${f.call} ${f.detail}${f.n > 1 ? ` (x${f.n})` : ''}`, f.sev === 'fail' ? 'fail' : 'warn');
    for (const n of r.notes) T.step(jobId, n, 'info');
    const verdict = !r.installed ? 'skip' : r.failures.some((f) => f.sev === 'fail') ? 'fail' : 'pass';
    T.step(jobId, r.installed ? `${r.failures.length ? `${r.failures.length} kind(s) of WebGL call failed` : 'No WebGL call failed'} · contexts ${r.contexts.webgl} WebGL1, ${r.contexts.webgl2} WebGL2, ${r.contexts.refused} refused` : 'The shim did not load: nothing was checked', verdict === 'pass' ? 'ok' : verdict === 'fail' ? 'fail' : 'warn');
    T.finish(jobId, verdict, r);
  } catch (e) {
    T.fail(jobId, errorMessage(e));
  } finally {
    clearInterval(tick);
  }
}

// ---------------------------------------------------------------- explore / navigation

const ZERO = { critical: 0, major: 0, minor: 0, info: 0 };

export async function startExplore(lab: FireLab, id: string | undefined, opts: ExploreOptions, kind: 'explore' | 'navigation' = 'explore'): Promise<TestJob> {
  const demo = opts.driver === 'demo';
  const serial = await claim(lab, id, demo);
  let pkg = opts.package;
  if (!pkg && !demo) pkg = await foregroundPackage(lab, serial);
  if (!pkg && !demo) throw new FireLabError('bad-request', 'Which app? Pick one in Apps first', { hint: 'e.g. { "package": "com.example.game" }' });
  refuseProtected(pkg);
  const { startExploreJob, waitForRunId, parseKeyList } = await engine();
  if (opts.keys !== undefined) parseKeyList(opts.keys); // 400 on unknown keys before starting
  if (opts.minutes !== undefined && !(opts.minutes > 0 && opts.minutes <= 240)) throw new FireLabError('bad-request', '"minutes" must be between 0 and 240');
  if (opts.steps !== undefined && !(Number.isInteger(opts.steps) && opts.steps > 0)) throw new FireLabError('bad-request', '"steps" must be a positive integer');
  const nav = kind === 'navigation';
  const { driver: _driver, ...rest } = opts;
  const req: ExploreRequest = {
    ...rest,
    ...(pkg ? { package: pkg } : {}),
    ...(nav
      ? {
          minutes: opts.steps ? undefined : opts.minutes ?? 3,
          oracles: ['health', 'screen', 'focus'],
          failOn: opts.failOn?.length ? opts.failOn : ['focus', 'crash', 'black', 'frozen'],
          minimizeMinutes: opts.minimizeMinutes ?? 2,
          minimizeMax: opts.minimizeMax ?? 3,
        }
      : {}),
    ...(demo ? { driverKind: 'demo' as const } : { device: serial, lab }),
  };
  if (!req.minutes && !req.steps) req.minutes = 10;
  const abort = new AbortController();
  const label = nav ? 'Navigation' : 'Explore';
  const budget = req.steps ? `${req.steps} steps` : `${req.minutes} min`;
  const { lab: _l, ...shown } = req;
  const job = lab.tests.create(kind, serial, `${label} · ${pkg ?? 'demo game'} · ${budget}`, shown as Record<string, unknown>, {
    ...(pkg ? { package: pkg } : {}),
    ...(req.minutes && !demo ? { estimatedMs: req.minutes * 60_000 } : {}),
    abort,
  });
  const T = lab.tests;
  T.step(job.id, `${label}: ${budget}, oracles ${(req.oracles ?? ['health', 'screen', 'focus']).join(', ')}${req.emulateGpu ? `, GPU emulated as ${String(req.emulateGpu)}` : ''}`, 'info');
  let ex: ExploreJob;
  try {
    ex = startExploreJob({ ...req, signal: abort.signal, onEvent: (e) => onEngineEvent(lab, job.id, e) });
  } catch (e) {
    T.fail(job.id, errorMessage(e));
    return T.get(job.id) as TestJob;
  }
  abort.signal.addEventListener('abort', () => ex.abort.abort(), { once: true });
  void followExplore(lab, job.id, ex, req, waitForRunId);
  return T.get(job.id) as TestJob;
}

function onEngineEvent(lab: FireLab, jobId: string, e: ExploreEvent): void {
  const T = lab.tests;
  if (e.type === 'start') T.update(jobId, { runId: e.runId, report: `/api/runs/${encodeURIComponent(e.runId)}/report.html` });
  else if (e.type === 'finding') T.step(jobId, `Finding (${e.finding.severity}): ${e.finding.title}`, e.finding.severity === 'critical' || e.finding.severity === 'major' ? 'fail' : 'warn');
  else if (e.type === 'state') T.step(jobId, `New screen: ${e.label}`, 'info');
  else if (e.type === 'relaunch') T.step(jobId, `Relaunched: ${e.reason}`, 'info');
  else if (e.type === 'phase') {
    T.update(jobId, { phase: e.phase });
    T.step(jobId, `Phase: ${e.phase}${e.detail ? ` · ${e.detail}` : ''}`, 'info');
  }
}

async function followExplore(lab: FireLab, jobId: string, ex: ExploreJob, req: ExploreRequest, waitForRunId: (j: ExploreJob, ms?: number) => Promise<string>): Promise<void> {
  const T = lab.tests;
  const poll = setInterval(() => {
    const p = ex.explorer?.progress();
    if (!p) return;
    let progress: number | null = null;
    if (p.phase === 'explore') {
      if (req.steps) progress = Math.min(0.99, p.step / req.steps);
      else if (req.minutes) progress = Math.min(0.99, p.elapsedMs / (req.minutes * 60_000));
    } else progress = 0.99;
    // A step budget: estimate the total from the time per step so far (shown as an estimate).
    const est = req.steps && p.step >= 5 ? Math.round((p.elapsedMs / p.step) * req.steps) : undefined;
    T.update(jobId, { steps: p.step, states: p.states, findings: p.findings, phase: p.phase, progress, ...(est ? { estimatedMs: est } : {}) });
  }, 1000);
  try {
    const runId = await waitForRunId(ex, 120_000);
    if (ex.status !== 'failed' && !runId.startsWith('job-')) T.update(jobId, { runId, report: `/api/runs/${encodeURIComponent(runId)}/report.html` });
    const s = await ex.done;
    if (!s) {
      T.fail(jobId, ex.error ?? 'The engine stopped without a result');
      return;
    }
    T.step(jobId, `${s.steps} steps, ${s.states} screens, ${s.findings.length} finding(s) in ${s.durationS} s${s.failed ? ` · fails on ${s.failOn.join(', ')}` : ''}`, s.failed ? 'fail' : 'ok');
    T.finish(jobId, s.failed ? 'fail' : 'pass', { summary: { ...s, findings: s.findings.map(({ trace, ...f }) => ({ ...f, trace: path.basename(trace) })) } }, {
      runId: s.runId,
      report: `/api/runs/${encodeURIComponent(s.runId)}/report.html`,
      steps: s.steps,
      states: s.states,
      findings: s.counts ?? ZERO,
      phase: 'done',
    });
  } catch (e) {
    T.fail(jobId, errorMessage(e));
  } finally {
    clearInterval(poll);
  }
}

/** Findings of a running or finished explore/navigation job. */
export async function testFindings(job: TestJob): Promise<unknown[]> {
  if (!job.runId) return [];
  const { getExploreJob } = await engine();
  const live = getExploreJob(job.runId);
  if (live?.explorer && live.status !== 'done') {
    return live.explorer.findingsSoFar().map((f) => ({ id: f.id, oracle: f.oracle, severity: f.severity, kind: f.kind, title: f.title, status: f.status, step: f.step }));
  }
  return (await import('./runs.js')).runFindings(job.runId);
}

// ---------------------------------------------------------------- replay

export type ReplayTarget = { runId: string; trace: string } | { sessionId: string };

export async function startReplay(lab: FireLab, id: string | undefined, req: { runId?: string; trace?: string; sessionId?: string; times?: number }): Promise<TestJob> {
  const runs = await import('./runs.js');
  const times = Math.min(Math.max(Math.round(req.times ?? 1), 1), 5);
  let trace: Trace;
  let key: string;
  let demo = false;
  let label: string;
  if (req.runId && req.trace) {
    const { readTrace, readRunDir } = await engine();
    const file = runs.runFile(req.runId, 'traces', req.trace);
    trace = readTrace(file);
    key = `run:${req.runId}/${req.trace}`;
    try {
      const d = readRunDir(runs.runDir(req.runId)).device as { kind?: string; serial?: string };
      demo = d.kind === 'mock' && d.serial === 'demo-tv';
    } catch {
      /* a trace without its run: replay on the device */
    }
    label = `${req.trace.replace(/\.trace\.json$/, '')} from ${req.runId}`;
  } else if (req.sessionId) {
    trace = runs.sessionTrace(lab.sessionsDir, req.sessionId);
    key = `session:${req.sessionId}`;
    label = `watch session ${req.sessionId}`;
  } else throw new FireLabError('bad-request', 'Say what to replay: { runId, trace } or { sessionId }');
  refuseProtected(trace.app.package);
  const serial = await claim(lab, id, demo);
  const abort = new AbortController();
  const job = lab.tests.create('replay', serial, `Replay · ${label}`, { ...req, times }, { package: trace.app.package, abort });
  void runReplay(lab, job.id, serial, trace, times, key, demo, abort.signal);
  return job;
}

async function runReplay(lab: FireLab, jobId: string, serial: string, trace: Trace, times: number, key: string, demo: boolean, signal: AbortSignal): Promise<void> {
  const T = lab.tests;
  try {
    const { replay } = await engine();
    T.step(jobId, `${trace.steps.length} key presses on ${trace.app.package}, ${times}×${trace.expect ? `, expecting ${trace.expect.oracle}` : ''}`, 'info');
    let run = 0;
    const r: ReplayResult & { keys: string[] } = await replay({
      trace,
      times,
      signal,
      ...(demo ? { driverKind: 'demo' as const } : { device: serial, lab }),
      onStep: (i, total) => {
        if (i === 0) T.step(jobId, `Run ${++run} of ${times}`, 'info');
        T.update(jobId, { phase: `run ${run}`, progress: Math.min(0.99, ((run - 1) * total + i) / (times * Math.max(1, total))) });
      },
    });
    const seen = [...new Set(r.detail.flatMap((d) => d.signatures))];
    if (seen.length) T.step(jobId, `Problems seen: ${seen.slice(0, 6).join(', ')}`, 'warn');
    let verdict: TestJob['verdict'];
    let text: string;
    if (r.expect) {
      verdict = r.hits > 0 ? 'fail' : 'pass';
      text = `Reproduced ${r.hits}/${r.runs}`;
    } else {
      verdict = seen.length ? 'fail' : 'pass';
      text = seen.length ? `${seen.length} problem(s) during ${r.runs} replay(s)` : `Played ${trace.steps.length} keys, nothing went wrong`;
    }
    T.step(jobId, text, verdict === 'pass' ? 'ok' : 'fail');
    const last = { at: Date.now(), hits: r.hits, runs: r.runs, verdict, text, jobId, expected: !!r.expect };
    saveReplay(lab, key, last);
    T.finish(jobId, verdict, { hits: r.hits, runs: r.runs, keys: r.keys, expect: r.expect, signatures: seen });
  } catch (e) {
    T.fail(jobId, errorMessage(e));
  }
}

export type LastReplay = { at: number; hits: number; runs: number; verdict?: TestJob['verdict']; text: string; jobId: string; expected: boolean };

function replaysFile(lab: FireLab): string {
  return path.join(lab.home, 'tests', 'replays.json');
}

export function lastReplays(lab: FireLab): Record<string, LastReplay> {
  try {
    return JSON.parse(fs.readFileSync(replaysFile(lab), 'utf8')) as Record<string, LastReplay>;
  } catch {
    return {};
  }
}

function saveReplay(lab: FireLab, key: string, r: LastReplay): void {
  try {
    const all = lastReplays(lab);
    all[key] = r;
    fs.mkdirSync(path.dirname(replaysFile(lab)), { recursive: true });
    fs.writeFileSync(replaysFile(lab), JSON.stringify(all));
  } catch {
    /* convenience only */
  }
}

export const TEST_KINDS: readonly TestKind[] = ['app-launch', 'navigation', 'performance', 'explore', 'gpu', 'replay'];
