import { EventEmitter } from 'node:events';
import type { FireLab } from './firelab.js';
import { KeyRecorder } from '../adb/getevent.js';
import { LogcatStream } from '../adb/logcat.js';
import { foregroundApp, pidOf } from '../adb/apps.js';
import { powerState } from '../adb/power.js';
import { NativeSampler } from '../perf/native.js';
import { SurfaceFlingerSampler } from '../perf/surfaceflinger.js';
import { FpsSampler } from '../cdp/fps.js';
import type { WebViewSession } from '../cdp/webview.js';
import type { KeyEvent, LogEvent, PerfEvent, StateEvent } from '../perf/watch.js';
import type { Vitals } from './vitals.js';
import { median } from '../lib/stats.js';
import { round1 } from '../lib/util.js';
import { log } from '../lib/log.js';

type Events = { perf: [PerfEvent]; log: [LogEvent]; key: [KeyEvent]; state: [StateEvent]; vitals: [Vitals]; idle: [] };

/**
 * Live view of one device for the dashboard's SSE stream: remote presses,
 * the foreground app's frame rate / memory / CPU, its console and error log,
 * and connection state. Runs while someone is subscribed.
 */
export class DeviceMonitor extends EventEmitter<Events> {
  private subs = 0;
  private timers: NodeJS.Timeout[] = [];
  private keys?: KeyRecorder;
  private logcat?: { pkg: string; pid: number; stream: LogcatStream };
  private fg?: string;
  private nat?: NativeSampler;
  private sf?: SurfaceFlingerSampler;
  private wv?: { pkg: string; session: WebViewSession; fps: FpsSampler };
  private wvRetryAt = 0;
  private tick = 0;
  private busy = false;
  lastState?: StateEvent;
  lastVitals?: Vitals;

  constructor(
    private readonly lab: FireLab,
    readonly serial: string,
  ) {
    super();
    this.setMaxListeners(50);
  }

  /** Recent events, replayed to new subscribers (a reloaded dashboard keeps its charts). */
  private backlog: { perf: PerfEvent[]; log: LogEvent[]; key: KeyEvent[] } = { perf: [], log: [], key: [] };
  static readonly PERF_BACKLOG_MS = 120_000;

  private record<K extends 'perf' | 'log' | 'key'>(kind: K, ev: Events[K][0]): void {
    const list = this.backlog[kind] as Events[K][0][];
    list.push(ev);
    if (kind === 'perf') {
      const cutoff = Date.now() - DeviceMonitor.PERF_BACKLOG_MS;
      while (list.length && (list[0] as PerfEvent).ts < cutoff) list.shift();
    } else if (list.length > (kind === 'log' ? 300 : 200)) list.shift();
    (this.emit as (k: K, e: Events[K][0]) => boolean)(kind, ev);
  }

  /** Registers listeners, replays the backlog to them, and returns an unsubscribe function. */
  subscribe(handlers: Partial<{ [K in keyof Omit<Events, 'idle'>]: (e: Events[K][0]) => void }>): () => void {
    const entries = Object.entries(handlers) as [keyof Events, (e: never) => void][];
    if (this.lastState) handlers.state?.(this.lastState);
    if (this.lastVitals) handlers.vitals?.(this.lastVitals);
    for (const e of this.backlog.perf) handlers.perf?.(e);
    for (const e of this.backlog.log) handlers.log?.(e);
    for (const e of this.backlog.key) handlers.key?.(e);
    for (const [ev, fn] of entries) this.on(ev, fn as never);
    if (++this.subs === 1) this.start();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const [ev, fn] of entries) this.off(ev, fn as never);
      if (--this.subs <= 0) this.stop();
    };
  }

  private start(): void {
    this.startKeys();
    void this.pollState();
    this.timers.push(setInterval(() => void this.pollState(), 5000));
    this.timers.push(setInterval(() => void this.pollPerf(), 2000));
    // Network and temperature: every 4 s (the sampler never reads faster than every 2 s).
    this.timers.push(setInterval(() => void this.pollVitals(), 4000));
  }

  private async pollVitals(): Promise<void> {
    if (!this.lastState?.connected) return;
    try {
      const v = await this.lab.vitalsSampler(this.serial).sample();
      if (v.ts === this.lastVitals?.ts) return;
      this.lastVitals = v;
      this.emit('vitals', v);
    } catch (e) {
      log.debug('monitor: vitals failed', e);
    }
  }

  private startKeys(): void {
    try {
      this.keys = new KeyRecorder(this.lab.adb, this.serial);
      this.keys.on('key', (k) => this.record('key', { ts: k.ts, key: k.key, action: k.action, ...(k.holdMs !== undefined ? { holdMs: k.holdMs } : {}) }));
      this.keys.on('exit', () => {
        // adb dropped (Wi-Fi blip): try again while someone is watching.
        if (this.subs > 0) setTimeout(() => this.subs > 0 && this.keys && this.keys.start(), 3000);
      });
      this.keys.start();
    } catch (e) {
      log.debug('monitor: key recorder failed', e);
    }
  }

  private async pollState(): Promise<void> {
    const adb = this.lab.adb;
    let connected = false;
    try {
      connected = (await adb.devices()).some((d) => d.serial === this.serial && d.state === 'device');
    } catch {
      connected = false;
    }
    const st: StateEvent = { ts: Date.now(), connected };
    if (connected) {
      const [fg, pw] = await Promise.all([foregroundApp(adb, this.serial).catch(() => null), powerState(adb, this.serial).catch(() => undefined)]);
      if (fg) st.foreground = fg.package;
      if (pw) st.screenOn = pw.displayOn !== false && !pw.dreaming;
      if (fg?.package !== this.fg) this.onForeground(fg?.package);
    }
    this.lastState = st;
    this.emit('state', st);
  }

  private onForeground(pkg?: string): void {
    this.fg = pkg;
    this.nat = pkg ? new NativeSampler(this.lab.adb, this.serial, pkg) : undefined;
    this.sf = pkg ? new SurfaceFlingerSampler(this.lab.adb, this.serial, pkg) : undefined;
    this.wvRetryAt = 0;
    if (this.wv && this.wv.pkg !== pkg) this.wv = undefined;
    this.logcat?.stream.stop();
    this.logcat = undefined;
    if (pkg) void this.startLogcat(pkg);
  }

  private async startLogcat(pkg: string): Promise<void> {
    const pid = await pidOf(this.lab.adb, this.serial, pkg).catch(() => null);
    if (!pid || this.fg !== pkg) return;
    const stream = new LogcatStream(this.lab.adb, this.serial, pid);
    stream.on('line', (l) => {
      if (l.level !== 'error' && l.level !== 'fatal' && l.level !== 'warn') return;
      // WebView apps also report console messages via logcat ("chromium" tag); the console stream has them already.
      if (this.wv && /chromium|Console/i.test(l.tag)) return;
      // Amazon WebView's own metrics client logs harmless "errors" all the time.
      if (/^AWVMetrics/.test(l.tag)) return;
      this.record('log', { ts: l.ts, level: l.level === 'warn' ? 'warn' : 'error', text: `${l.tag}: ${l.text}`, source: 'logcat' });
    });
    stream.start();
    this.logcat = { pkg, pid, stream };
  }

  private async ensureWebview(): Promise<FpsSampler | undefined> {
    const pkg = this.fg;
    if (!pkg) return undefined;
    if (this.wv && this.wv.pkg === pkg && !this.wv.session.closed) return this.wv.fps;
    if (Date.now() < this.wvRetryAt) return undefined;
    this.wvRetryAt = Date.now() + 10000;
    const session = await this.lab.webview(this.serial, pkg).catch(() => undefined);
    if (!session) return undefined;
    const fps = new FpsSampler(session);
    await fps.install().catch(() => undefined);
    session.on('console', (e) => {
      if (this.wv?.session !== session) return;
      this.record('log', { ts: e.ts, level: e.level === 'debug' ? 'log' : e.level, text: e.text, source: e.source === 'exception' ? 'exception' : 'console' });
    });
    this.wv = { pkg, session, fps };
    return fps;
  }

  private async pollPerf(): Promise<void> {
    if (this.busy || !this.lastState?.connected) return;
    this.busy = true;
    try {
      this.tick++;
      const fpsSampler = await this.ensureWebview();
      const [fps, nat] = await Promise.all([
        fpsSampler ? fpsSampler.read().catch(() => []) : this.sf ? this.sf.read().catch(() => []) : Promise.resolve([]),
        this.nat ? this.nat.sample({ memory: this.tick % 3 === 1 }).catch(() => undefined) : Promise.resolve(undefined),
      ]);
      const last = fps[fps.length - 1];
      const ev: PerfEvent = { ts: Date.now(), source: last ? (last.source === 'expr' ? 'page' : last.source === 'surface' ? 'native' : last.source) : 'native' };
      if (last) {
        ev.fps = round1(median(fps.map((f) => f.fps)));
        if (last.fpsMedian !== undefined) ev.fpsMedian = last.fpsMedian;
        if (last.scale !== undefined) ev.scale = last.scale;
        // Frame time only when the page measures it (window.firelab.frameMs from @firelab/perf).
        const fm = last.source === 'page' ? (fpsSampler?.lastHook as { frameMs?: { p50?: unknown; p95?: unknown } } | null | undefined)?.frameMs : undefined;
        if (typeof fm?.p50 === 'number' && Number.isFinite(fm.p50)) ev.frameMs = round1(fm.p50);
        if (typeof fm?.p95 === 'number' && Number.isFinite(fm.p95)) ev.frameP95Ms = round1(fm.p95);
        if (last.counter) ev.counter = last.counter;
        else if (last.source === 'surface') ev.counter = 'surfaceflinger';
      }
      if (nat?.memMB !== undefined) ev.memMB = nat.memMB;
      if (nat?.cpuPct !== undefined) ev.cpuPct = nat.cpuPct;
      if (ev.fps !== undefined || ev.memMB !== undefined || ev.cpuPct !== undefined) this.record('perf', ev);
    } finally {
      this.busy = false;
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.keys?.stop();
    this.keys = undefined;
    this.logcat?.stream.stop();
    this.logcat = undefined;
    this.wv = undefined;
    this.subs = 0;
    this.emit('idle');
  }
}
