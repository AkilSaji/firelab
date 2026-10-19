/**
 * Read-only views of what FireLab left on disk, for the dashboard's Tests,
 * Scenarios and Reports pages: engine runs (exploreDir()/<runId>), their
 * finding traces, watch sessions as replayable traces, and benchmark reports
 * (<dataDir>/bench/<id>/bench.json + report.html). Every path that comes
 * from a URL is checked: plain names only, and the result must stay inside
 * its folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exploreDir } from '../engine/config.js';
import { validateTrace } from '../engine/trace.js';
import { actionKey } from '../engine/actions.js';
import { REMOTE_KEYS, type RemoteKey } from '../engine/driver.js';
import type { Finding, Severity, Trace, TraceStep } from '../engine/types.js';
import { FireLabError } from '../lib/errors.js';
import { dataDir } from '../lib/paths.js';

const NAME = /^[\w][\w.-]*$/;

/** A file or folder name from a URL: letters, digits, _ . - only, no "..". */
export function safeName(s: string | undefined, what = 'name'): string {
  if (!s || !NAME.test(s) || s.includes('..') || s.length > 200) throw new FireLabError('bad-request', `Bad ${what}`);
  return s;
}

function inside(root: string, p: string): boolean {
  const r = path.resolve(root) + path.sep;
  return path.resolve(p).startsWith(r);
}

export function runDir(runId: string): string {
  const dir = path.join(exploreDir(), safeName(runId, 'run id'));
  if (!inside(exploreDir(), dir) || !fs.existsSync(path.join(dir, 'run.json'))) throw new FireLabError('not-found', `No engine run ${runId}`);
  return dir;
}

/** A file of a run: `report.html`, `traces/<f>`, `thumbs/<f>`. */
export function runFile(runId: string, sub: '' | 'traces' | 'thumbs', file: string): string {
  const dir = runDir(runId);
  const p = path.join(dir, sub, safeName(file, 'file name'));
  if (!inside(dir, p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) throw new FireLabError('not-found', `No ${sub ? `${sub}/` : ''}${file} in run ${runId}`);
  return p;
}

const readJson = <T>(p: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

type RunJson = {
  runId: string;
  config: { app: { package: string; url?: string }; minutes?: number; steps?: number; seed?: number; oracles?: string[]; strategy?: string; emulateGpu?: { model?: string } };
  device: { serial: string; model?: string; name?: string; kind?: string };
  strategy: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  steps: number;
  states: number;
  stopped: string;
  error?: string;
  notes?: string[];
};

const SEVERITIES: Severity[] = ['critical', 'major', 'minor', 'info'];

export type RunSummary = {
  runId: string;
  package: string;
  url?: string;
  device: RunJson['device'];
  strategy: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  /** Mtime of run.json: when it was written on this computer (demo runs keep a virtual start time). */
  writtenAt: number;
  steps: number;
  states: number;
  stopped: string;
  error?: string;
  findings: Record<Severity, number>;
  /** Default CI rule (any critical or major finding that reproduced, or an engine error). */
  failed: boolean;
  emulateGpu?: string;
  report?: string;
  traces: number;
  demo: boolean;
};

function summarizeRun(dir: string): RunSummary | undefined {
  const run = readJson<RunJson>(path.join(dir, 'run.json'));
  if (!run?.runId || !run.config?.app) return undefined;
  const findings = readJson<Finding[]>(path.join(dir, 'findings.json')) ?? [];
  const counts = { critical: 0, major: 0, minor: 0, info: 0 } as Record<Severity, number>;
  for (const f of findings) if (SEVERITIES.includes(f.severity)) counts[f.severity]++;
  const failing = findings.some((f) => (f.severity === 'critical' || f.severity === 'major') && f.status !== 'not-reproduced');
  const id = path.basename(dir);
  let traces = 0;
  try {
    traces = fs.readdirSync(path.join(dir, 'traces')).filter((f) => f.endsWith('.trace.json')).length;
  } catch {
    /* none */
  }
  return {
    runId: id,
    package: run.config.app.package,
    ...(run.config.app.url ? { url: run.config.app.url } : {}),
    device: run.device,
    strategy: run.strategy ?? run.config.strategy ?? 'explore',
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    writtenAt: fs.statSync(path.join(dir, 'run.json')).mtimeMs,
    steps: run.steps,
    states: run.states,
    stopped: run.stopped,
    ...(run.error ? { error: run.error } : {}),
    findings: counts,
    failed: failing || run.stopped === 'error',
    ...(run.config.emulateGpu?.model ? { emulateGpu: run.config.emulateGpu.model } : {}),
    ...(fs.existsSync(path.join(dir, 'report.html')) ? { report: `/api/runs/${encodeURIComponent(id)}/report.html` } : {}),
    traces,
    demo: run.device?.kind === 'mock' && run.device?.serial === 'demo-tv',
  };
}

/** Engine runs on this computer, newest first. */
export function listRuns(limit = 200): RunSummary[] {
  const root = exploreDir();
  if (!fs.existsSync(root)) return [];
  const out: RunSummary[] = [];
  for (const name of fs.readdirSync(root)) {
    if (!NAME.test(name)) continue;
    const s = summarizeRun(path.join(root, name));
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.writtenAt - a.writtenAt).slice(0, limit);
}

export type TraceInfo = { runId: string; file: string; findingId?: string; title?: string; severity?: Severity; kind?: string; status?: Finding['status']; minimized: boolean; keys: string[]; length: number; package: string; createdAt: number; demo: boolean };

function traceKeysOf(t: Trace): string[] {
  return t.steps.map((s) => actionKey(s.action));
}

/** The findings of one run with their key sequences. */
export function runFindings(runId: string): (Pick<Finding, 'id' | 'severity' | 'kind' | 'title' | 'status' | 'step' | 'oracle'> & { repro?: Finding['repro']; trace: string; keys: string[] })[] {
  const dir = runDir(runId);
  const findings = readJson<Finding[]>(path.join(dir, 'findings.json')) ?? [];
  return findings.map((f) => {
    const file = f.minimized ?? f.trace;
    const t = readJson<Trace>(path.join(dir, 'traces', file));
    return { id: f.id, oracle: f.oracle, severity: f.severity, kind: f.kind, title: f.title, status: f.status, step: f.step, ...(f.repro ? { repro: f.repro } : {}), trace: file, keys: t?.steps ? traceKeysOf(t) : [] };
  });
}

export function runDetail(runId: string): RunSummary & { findingList: ReturnType<typeof runFindings>; notes: string[]; config: RunJson['config'] } {
  const dir = runDir(runId);
  const s = summarizeRun(dir);
  if (!s) throw new FireLabError('not-found', `Run ${runId} has no readable run.json`);
  const run = readJson<RunJson>(path.join(dir, 'run.json')) as RunJson;
  return { ...s, findingList: runFindings(runId), notes: run.notes ?? [], config: run.config };
}

/** Every finding trace (shrunk ones preferred) in the newest `runs` runs. */
export function listTraces(runs = 60): TraceInfo[] {
  const out: TraceInfo[] = [];
  for (const r of listRuns(runs)) {
    const dir = path.join(exploreDir(), r.runId);
    const findings = readJson<Finding[]>(path.join(dir, 'findings.json')) ?? [];
    for (const f of findings) {
      const file = f.minimized ?? f.trace;
      const t = readJson<Trace>(path.join(dir, 'traces', file));
      if (!t?.steps) continue;
      const keys = traceKeysOf(t);
      out.push({ runId: r.runId, file, findingId: f.id, title: f.title, severity: f.severity, kind: f.kind, status: f.status, minimized: !!f.minimized, keys, length: keys.length, package: t.app?.package ?? r.package, createdAt: t.createdAt ?? r.startedAt, demo: r.demo });
    }
  }
  return out;
}

// ---------- watch sessions as traces ----------

/**
 * A watch session's remote presses (timeline.jsonl) as an engine trace with
 * the recorded gaps, so the engine can replay what the person did.
 */
export function sessionTrace(sessionsDir: string, sessionId: string): Trace {
  const dir = path.join(sessionsDir, safeName(sessionId, 'session id'));
  if (!inside(sessionsDir, dir)) throw new FireLabError('bad-request', 'Bad session id');
  const summary = readJson<{ device: string; package?: string; startedAt: number }>(path.join(dir, 'summary.json'));
  if (!summary) throw new FireLabError('not-found', `No finished watch session ${sessionId}`);
  if (!summary.package) throw new FireLabError('bad-request', `Session ${sessionId} didn't record which app it watched, so it can't be replayed`);
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(path.join(dir, 'timeline.jsonl'), 'utf8').split('\n');
  } catch {
    throw new FireLabError('not-found', `Session ${sessionId} has no timeline`);
  }
  const downs: { ts: number; key: string; holdMs?: number }[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    let e: { type?: string; ts?: number; key?: string; action?: string; holdMs?: number };
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.type !== 'key' || typeof e.ts !== 'number' || typeof e.key !== 'string') continue;
    if (e.action === 'down') downs.push({ ts: e.ts, key: e.key });
    else if (e.action === 'up' && e.holdMs !== undefined) {
      const d = [...downs].reverse().find((x) => x.key === e.key && x.holdMs === undefined);
      if (d) d.holdMs = e.holdMs;
    }
  }
  const steps: TraceStep[] = [];
  let prev = summary.startedAt;
  for (const d of downs) {
    if (!REMOTE_KEYS.includes(d.key as RemoteKey) || ['home', 'volup', 'voldown', 'mute'].includes(d.key)) continue;
    const gapMs = Math.min(Math.max(0, d.ts - prev), steps.length ? 120_000 : 5000);
    prev = d.ts;
    const action = d.holdMs !== undefined && d.holdMs >= 400 ? { kind: 'key' as const, key: d.key as RemoteKey, mode: 'hold' as const, holdMs: Math.min(d.holdMs, 10_000) } : { kind: 'key' as const, key: d.key as RemoteKey };
    steps.push({ i: steps.length, action, gapMs });
  }
  if (!steps.length) throw new FireLabError('bad-request', `Session ${sessionId} has no remote presses to replay`);
  const trace: Trace = { version: 1, app: { package: summary.package }, device: { serial: summary.device }, createdAt: summary.startedAt, seed: 1, setup: [], steps };
  validateTrace(trace);
  return trace;
}

/** Remote presses of a session, as key specs (for the Scenarios page). */
export function sessionKeys(sessionsDir: string, sessionId: string): string[] {
  try {
    return traceKeysOf(sessionTrace(sessionsDir, sessionId));
  } catch {
    return [];
  }
}

// ---------- benchmark reports ----------

export type BenchReport = { id: string; createdAt?: number | string; title: string; subjects: string[]; strategies: string[]; headline?: string; report?: string };

export function benchDir(): string {
  return path.join(dataDir(), 'bench');
}

/** Benchmark reports: <dataDir>/bench/<id>/bench.json with kind "firelab-bench", next to report.html. */
export function listBench(): BenchReport[] {
  const root = benchDir();
  if (!fs.existsSync(root)) return [];
  const out: BenchReport[] = [];
  for (const name of fs.readdirSync(root)) {
    if (!NAME.test(name)) continue;
    const b = readJson<Record<string, unknown>>(path.join(root, name, 'bench.json'));
    if (!b || b.kind !== 'firelab-bench') continue;
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    out.push({
      id: name,
      ...(typeof b.createdAt === 'number' || typeof b.createdAt === 'string' ? { createdAt: b.createdAt } : {}),
      title: typeof b.title === 'string' && b.title ? b.title : name,
      subjects: strs(b.subjects),
      strategies: strs(b.strategies),
      ...(typeof b.headline === 'string' ? { headline: b.headline } : {}),
      ...(fs.existsSync(path.join(root, name, 'report.html')) ? { report: `/api/bench/${encodeURIComponent(name)}/report.html` } : {}),
    });
  }
  const t = (x: BenchReport) => (typeof x.createdAt === 'number' ? x.createdAt : x.createdAt ? Date.parse(x.createdAt) || 0 : 0);
  return out.sort((a, b) => t(b) - t(a));
}

/** A file next to a benchmark's bench.json (report.html and what it links to, one level deep or in a sub folder). */
export function benchFile(id: string, parts: string[]): string {
  const dir = path.join(benchDir(), safeName(id, 'benchmark id'));
  const p = path.join(dir, ...parts.map((x) => safeName(x, 'file name')));
  if (!inside(dir, p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) throw new FireLabError('not-found', `No ${parts.join('/')} in benchmark ${id}`);
  return p;
}
