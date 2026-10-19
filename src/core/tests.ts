import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { shortId } from '../lib/util.js';

/**
 * Dashboard test jobs (the "Test Engine" quick tests): app launch, navigation,
 * performance, explore, GPU check and replay. One shape for all of them so the
 * dashboard's Test Execution panel can follow any job. Finished jobs are kept
 * on disk (<home>/tests/<id>.json) for the Test Results panel.
 */

export type TestKind = 'app-launch' | 'navigation' | 'performance' | 'explore' | 'gpu' | 'replay';
export type TestStatus = 'running' | 'done' | 'failed' | 'stopped';
export type TestStep = { ts: number; text: string; status?: 'ok' | 'warn' | 'fail' | 'info' };
export type Severities = { critical: number; major: number; minor: number; info: number };

export type TestJob = {
  id: string;
  kind: TestKind;
  /** What the dashboard shows, e.g. "App launch · com.example.game". */
  name: string;
  device: string;
  package?: string;
  status: TestStatus;
  /** The test's own verdict once finished: pass, fail, or skip (could not be measured). */
  verdict?: 'pass' | 'fail' | 'skip';
  /** 0..1, or null when the job can't tell. */
  progress: number | null;
  phase?: string;
  message?: string;
  startedAt: number;
  endedAt?: number;
  /** Expected total run time (explore budget, measure seconds...). Absent when unknown. */
  estimatedMs?: number;
  /** Explore jobs: live counters. */
  steps?: number;
  states?: number;
  findings?: Severities;
  /** Engine run id and report URL (explore, navigation). */
  runId?: string;
  report?: string;
  /** Live step list (newest last, at most 300). */
  log: TestStep[];
  request: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

type Internal = TestJob & { abort?: AbortController };

export class TestStore extends EventEmitter<{ progress: [TestJob]; done: [TestJob] }> {
  private jobs = new Map<string, Internal>();

  constructor(private readonly dir?: string) {
    super();
    this.setMaxListeners(100);
  }

  create(kind: TestKind, device: string, name: string, request: Record<string, unknown>, extra: { package?: string; estimatedMs?: number; abort?: AbortController } = {}): TestJob {
    const job: Internal = {
      id: shortId('t_'),
      kind,
      name,
      device,
      status: 'running',
      progress: 0,
      startedAt: Date.now(),
      log: [],
      request,
      ...(extra.package ? { package: extra.package } : {}),
      ...(extra.estimatedMs ? { estimatedMs: extra.estimatedMs } : {}),
    };
    if (extra.abort) job.abort = extra.abort;
    this.jobs.set(job.id, job);
    // Keep the last 50 in memory; finished ones are on disk too.
    if (this.jobs.size > 50) {
      const old = [...this.jobs.values()].find((j) => j.status !== 'running');
      if (old) this.jobs.delete(old.id);
    }
    return this.pub(job);
  }

  private pub(j: Internal): TestJob {
    const { abort: _a, ...rest } = j;
    return { ...rest, log: [...rest.log] };
  }

  get(id: string): TestJob | undefined {
    const j = this.jobs.get(id);
    if (j) return this.pub(j);
    return this.fromDisk(id);
  }

  /** In-memory jobs, newest first. */
  list(): TestJob[] {
    return [...this.jobs.values()].map((j) => this.pub(j)).sort((a, b) => b.startedAt - a.startedAt);
  }

  runningFor(device: string): TestJob | undefined {
    return this.list().find((j) => j.device === device && j.status === 'running');
  }

  update(id: string, patch: Partial<Omit<TestJob, 'id' | 'log'>>): void {
    const j = this.jobs.get(id);
    if (!j || j.status !== 'running') return;
    Object.assign(j, patch);
    this.emit('progress', this.pub(j));
  }

  step(id: string, text: string, status?: TestStep['status']): void {
    const j = this.jobs.get(id);
    if (!j) return;
    j.log.push({ ts: Date.now(), text, ...(status ? { status } : {}) });
    if (j.log.length > 300) j.log.splice(0, j.log.length - 300);
    j.message = text;
    if (j.status === 'running') this.emit('progress', this.pub(j));
  }

  finish(id: string, verdict: TestJob['verdict'], result?: unknown, patch: Partial<TestJob> = {}): void {
    const j = this.jobs.get(id);
    if (!j || j.status !== 'running') return;
    Object.assign(j, patch);
    j.status = j.abort?.signal.aborted ? 'stopped' : 'done';
    if (verdict) j.verdict = verdict;
    if (result !== undefined) j.result = result;
    j.progress = 1;
    j.endedAt = Date.now();
    this.done(j);
  }

  fail(id: string, error: string): void {
    const j = this.jobs.get(id);
    if (!j || j.status !== 'running') return;
    j.status = j.abort?.signal.aborted ? 'stopped' : 'failed';
    j.error = error;
    j.endedAt = Date.now();
    this.step(id, error, 'fail');
    this.done(j);
  }

  private done(j: Internal): void {
    this.save(j);
    this.emit('done', this.pub(j));
  }

  stop(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j?.abort || j.status !== 'running') return false;
    j.abort.abort();
    this.step(id, 'Stopping…', 'info');
    return true;
  }

  stopAll(): void {
    for (const j of this.jobs.values()) if (j.status === 'running') j.abort?.abort();
  }

  // ---------- disk ----------

  private save(j: Internal): void {
    if (!this.dir) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, `${j.id}.json`), JSON.stringify(this.pub(j)));
    } catch {
      /* history is a convenience */
    }
  }

  private fromDisk(id: string): TestJob | undefined {
    if (!this.dir || !/^t_[\w-]+$/.test(id)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8')) as TestJob;
    } catch {
      return undefined;
    }
  }

  /** Jobs that started at or after `since` (memory and disk), newest first, without their step logs. */
  history(since = 0, limit = 200): TestJob[] {
    const byId = new Map<string, TestJob>();
    if (this.dir && fs.existsSync(this.dir)) {
      for (const f of fs.readdirSync(this.dir)) {
        if (!/^t_[\w-]+\.json$/.test(f)) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as TestJob;
          if (j.startedAt >= since) byId.set(j.id, j);
        } catch {
          /* broken file */
        }
      }
    }
    for (const j of this.list()) if (j.startedAt >= since) byId.set(j.id, j);
    return [...byId.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map((j) => ({ ...j, log: j.log.slice(-3) }));
  }

  /** Where a job's files go (screenshots, logcat). */
  filesDir(id: string): string | undefined {
    return this.dir ? path.join(this.dir, id) : undefined;
  }
}
