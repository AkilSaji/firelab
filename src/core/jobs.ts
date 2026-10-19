import { EventEmitter } from 'node:events';
import type { Job } from './types.js';
import type { SweepProgress, SweepResult } from '../perf/sweep.js';
import { shortId } from '../lib/util.js';

export type JobEvents = { progress: [Job, SweepProgress]; done: [Job] };

/** Keeps sweep jobs in memory so the dashboard can poll or stream them. */
export class JobStore extends EventEmitter<JobEvents> {
  private jobs = new Map<string, Job & { result?: SweepResult; abort?: AbortController }>();

  create(device: string, abort?: AbortController, extra: Pick<Job, 'request' | 'criteria'> = {}): Job {
    const job: Job & { abort?: AbortController } = { id: shortId('sw_'), kind: 'sweep', status: 'running', progress: 0, device, rows: [], startedAt: Date.now(), ...extra };
    if (abort) job.abort = abort;
    this.jobs.set(job.id, job);
    // Keep the last 50.
    if (this.jobs.size > 50) this.jobs.delete(this.jobs.keys().next().value as string);
    return job;
  }

  get(id: string): Job | undefined {
    const j = this.jobs.get(id);
    if (!j) return undefined;
    const { abort: _a, result: _r, ...pub } = j;
    return pub;
  }

  result(id: string): SweepResult | undefined {
    return this.jobs.get(id)?.result;
  }

  list(): Job[] {
    return [...this.jobs.keys()].map((k) => this.get(k) as Job).reverse();
  }

  runningFor(device: string): Job | undefined {
    return this.list().find((j) => j.device === device && j.status === 'running');
  }

  progress(id: string, p: SweepProgress): void {
    const j = this.jobs.get(id);
    if (!j) return;
    j.progress = Math.round(p.progress * 100) / 100;
    j.message = p.message;
    if (p.row) j.rows = [...j.rows.filter((r) => r.tier !== p.row?.tier), p.row];
    const phase = p.phase === 'warmup' ? 'warming up' : p.phase === 'sample' ? 'sampling' : p.phase === 'load' || p.phase === 'action' || p.phase === 'start' ? 'launching' : undefined;
    if (p.tier && phase) j.current = { tier: p.tier, index: p.index ?? 0, phase, ...(p.fps !== undefined ? { fps: p.fps } : {}) };
    else if (p.phase === 'row' || p.phase === 'restore' || p.phase === 'done') j.current = undefined;
    this.emit('progress', this.get(id) as Job, p);
  }

  finish(id: string, result: SweepResult, extra: { markdown?: string; resultPath?: string } = {}): void {
    const j = this.jobs.get(id);
    if (!j) return;
    j.status = 'done';
    j.progress = 1;
    j.current = undefined;
    j.rows = result.rows;
    j.result = result;
    if (result.recommendation) j.recommendation = result.recommendation;
    j.endedAt = Date.now();
    if (extra.markdown) j.markdown = extra.markdown;
    if (extra.resultPath) j.resultPath = extra.resultPath;
    this.emit('done', this.get(id) as Job);
  }

  fail(id: string, error: string): void {
    const j = this.jobs.get(id);
    if (!j) return;
    j.status = 'error';
    j.error = error;
    j.current = undefined;
    j.endedAt = Date.now();
    this.emit('done', this.get(id) as Job);
  }

  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j?.abort || j.status !== 'running') return false;
    j.abort.abort();
    return true;
  }
}
