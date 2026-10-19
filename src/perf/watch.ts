import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { FpsSample } from '../cdp/fps.js';
import type { NativeSample } from './native.js';
import type { RecordedKey } from '../adb/getevent.js';
import { median, percentile, max } from '../lib/stats.js';
import { round1 } from '../lib/util.js';
import { log } from '../lib/log.js';

// SSE payloads (docs/CONTRACT.md)
export type PerfEvent = { ts: number; fps?: number; fpsMedian?: number; scale?: number; memMB?: number; cpuPct?: number; source: 'page' | 'raf' | 'native'; counter?: 'draws' | 'raf' | 'surfaceflinger'; frameMs?: number; frameP95Ms?: number };
export type LogEvent = { ts: number; level: 'log' | 'info' | 'warn' | 'error'; text: string; source: 'console' | 'exception' | 'logcat' };
export type KeyEvent = { ts: number; key: string; action: 'down' | 'up'; holdMs?: number };
export type StateEvent = { ts: number; foreground?: string; screenOn?: boolean; connected: boolean };

export type WatchSummary = {
  sessionId: string;
  device: string;
  package?: string;
  startedAt: number;
  endedAt?: number;
  keys: number;
  fps?: { median: number; p10: number };
  memMB?: { max: number };
  errors: number;
  thumbnails: string[];
  /** Extras: where the session lives on disk, and the most common keys. */
  dir?: string;
  topKeys?: { key: string; count: number }[];
  firstErrors?: string[];
};

export interface WatchDeps {
  keys?: { start(): void; stop(): void; on(ev: 'key', fn: (k: RecordedKey) => void): unknown };
  native?: (memory: boolean) => Promise<NativeSample>;
  fps?: () => Promise<FpsSample[]>;
  onConsole?: (fn: (e: LogEvent) => void) => () => void;
  thumbnail?: () => Promise<Buffer>;
  state?: () => Promise<Omit<StateEvent, 'ts'>>;
}

export type WatchOptions = {
  sessionId: string;
  device: string;
  package?: string;
  dir: string;
  /** Perf sample interval (default 3000 ms; memory is read every other sample). */
  intervalMs?: number;
  /** Thumbnail interval (default 10000 ms; 0 = none). */
  thumbEveryMs?: number;
};

/**
 * A recorded play session: the person plays, FireLab writes down what
 * happened (remote presses, frame rate, memory, errors, a thumbnail every few
 * seconds) to <dir>/timeline.jsonl and summarizes it at the end.
 */
export class WatchSession extends EventEmitter<{ perf: [PerfEvent]; log: [LogEvent]; key: [KeyEvent]; state: [StateEvent]; thumb: [string] }> {
  readonly startedAt = Date.now();
  endedAt?: number;
  private timers: NodeJS.Timeout[] = [];
  private fps: number[] = [];
  private mem: number[] = [];
  private keyCounts = new Map<string, number>();
  private keyTotal = 0;
  private errors: string[] = [];
  private thumbs: string[] = [];
  private timeline?: fs.WriteStream;
  private unsubConsole?: () => void;
  private tick = 0;
  private busy = false;
  private thumbBusy = false;

  constructor(
    private readonly deps: WatchDeps,
    readonly opts: WatchOptions,
  ) {
    super();
  }

  get id(): string {
    return this.opts.sessionId;
  }

  private record(type: string, data: object): void {
    this.timeline?.write(`${JSON.stringify({ type, ...data })}\n`);
  }

  start(): void {
    fs.mkdirSync(this.opts.dir, { recursive: true });
    this.timeline = fs.createWriteStream(path.join(this.opts.dir, 'timeline.jsonl'), { flags: 'a' });
    this.record('start', { ts: this.startedAt, device: this.opts.device, package: this.opts.package });
    this.deps.keys?.on('key', (k) => {
      const ev: KeyEvent = { ts: k.ts, key: k.key, action: k.action, ...(k.holdMs !== undefined ? { holdMs: k.holdMs } : {}) };
      if (k.action === 'down') {
        this.keyTotal++;
        this.keyCounts.set(k.key, (this.keyCounts.get(k.key) ?? 0) + 1);
      }
      this.record('key', ev);
      this.emit('key', ev);
    });
    this.deps.keys?.start();
    this.unsubConsole = this.deps.onConsole?.((e) => this.onLog(e));
    const interval = this.opts.intervalMs ?? 3000;
    this.timers.push(setInterval(() => void this.samplePerf(), interval));
    const thumbEvery = this.opts.thumbEveryMs ?? 10000;
    if (thumbEvery > 0 && this.deps.thumbnail) {
      void this.takeThumb();
      this.timers.push(setInterval(() => void this.takeThumb(), thumbEvery));
    }
  }

  onLog(e: LogEvent): void {
    if (e.level === 'error') {
      this.errors.push(e.text);
    }
    this.record('log', e);
    this.emit('log', e);
  }

  /** One perf sample (exposed for tests). */
  async samplePerf(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.tick++;
      const [fps, nat, st] = await Promise.all([
        this.deps.fps ? this.deps.fps().catch(() => [] as FpsSample[]) : Promise.resolve([] as FpsSample[]),
        this.deps.native ? this.deps.native(this.tick % 2 === 1).catch(() => undefined) : Promise.resolve(undefined),
        this.deps.state && this.tick % 2 === 1 ? this.deps.state().catch(() => undefined) : Promise.resolve(undefined),
      ]);
      const now = Date.now();
      for (const f of fps) this.fps.push(f.fps);
      if (nat?.memMB !== undefined) this.mem.push(nat.memMB);
      const last = fps[fps.length - 1];
      const ev: PerfEvent = { ts: now, source: last ? (last.source === 'expr' ? 'page' : last.source === 'surface' ? 'native' : last.source) : 'native' };
      if (last) {
        ev.fps = round1(median(fps.map((f) => f.fps)));
        if (last.fpsMedian !== undefined) ev.fpsMedian = last.fpsMedian;
        if (last.scale !== undefined) ev.scale = last.scale;
        if (last.counter) ev.counter = last.counter;
        else if (last.source === 'surface') ev.counter = 'surfaceflinger';
      }
      if (nat?.memMB !== undefined) ev.memMB = nat.memMB;
      if (nat?.cpuPct !== undefined) ev.cpuPct = nat.cpuPct;
      if (ev.fps !== undefined || ev.memMB !== undefined || ev.cpuPct !== undefined) {
        this.record('perf', ev);
        this.emit('perf', ev);
      }
      if (st) {
        const se: StateEvent = { ts: now, ...st };
        this.record('state', se);
        this.emit('state', se);
      }
    } finally {
      this.busy = false;
    }
  }

  private async takeThumb(): Promise<void> {
    if (!this.deps.thumbnail || this.thumbBusy) return;
    this.thumbBusy = true;
    try {
      const jpg = await this.deps.thumbnail();
      const name = `thumb-${String(this.thumbs.length + 1).padStart(4, '0')}.jpg`;
      fs.writeFileSync(path.join(this.opts.dir, name), jpg);
      this.thumbs.push(name);
      this.record('thumb', { ts: Date.now(), file: name });
      this.emit('thumb', name);
    } catch (e) {
      log.debug('watch: thumbnail failed', e);
    } finally {
      this.thumbBusy = false;
    }
  }

  summary(): WatchSummary {
    const s: WatchSummary = {
      sessionId: this.opts.sessionId,
      device: this.opts.device,
      startedAt: this.startedAt,
      keys: this.keyTotal,
      errors: this.errors.length,
      thumbnails: [...this.thumbs],
      dir: this.opts.dir,
    };
    if (this.opts.package) s.package = this.opts.package;
    if (this.endedAt) s.endedAt = this.endedAt;
    if (this.fps.length) s.fps = { median: round1(median(this.fps)), p10: round1(percentile(this.fps, 10)) };
    if (this.mem.length) s.memMB = { max: round1(max(this.mem)) };
    if (this.keyCounts.size) s.topKeys = [...this.keyCounts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, count]) => ({ key, count }));
    if (this.errors.length) s.firstErrors = [...new Set(this.errors)].slice(0, 5).map((e) => e.slice(0, 300));
    return s;
  }

  async stop(): Promise<WatchSummary> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.deps.keys?.stop();
    this.unsubConsole?.();
    // A last sample so short sessions still get numbers.
    await this.samplePerf().catch(() => {});
    this.endedAt = Date.now();
    const s = this.summary();
    this.record('stop', { ts: this.endedAt });
    await new Promise<void>((resolve) => (this.timeline ? this.timeline.end(resolve) : resolve()));
    fs.writeFileSync(path.join(this.opts.dir, 'summary.json'), JSON.stringify(s, null, 2));
    return s;
  }
}

/** Reads finished sessions from disk, newest first. */
export function listSessions(root: string): WatchSummary[] {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: WatchSummary[] = [];
  for (const d of dirs) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(root, d, 'summary.json'), 'utf8')) as WatchSummary);
    } catch {
      /* running or broken session */
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}
