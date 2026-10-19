import { encodePng } from '../adb/png.js';
import { encodeJpeg, resizeRgba } from '../adb/image.js';
import { FireLabError } from '../lib/errors.js';
import { DRIVER_KEYS, type AppRef, type ConsoleEntry, type DeviceDriver, type DriverCaps, type DriverInfo, type Frame, type KeySpec, type LogLine, type MemorySample, type RecordedKey, type ResetOptions } from './types.js';

/**
 * A scriptable DeviceDriver for tests, demos and anyone building on FireLab
 * without a TV. It behaves like a small, plausible device by default (apps
 * start and stop, logs filter, screenshots are real images), records every
 * call, lets a test script any method's answer, and has configurable caps.
 *
 *   const tv = new FakeDriver({ caps: { eval: false } });
 *   tv.on('evaluate', (expr) => expr === 'game.state' ? { scene: 'menu' } : undefined);
 *   tv.once('screenshot', new FireLabError('timeout', 'screencap timed out'));
 *   await engine.run(tv);
 *   expect(tv.callsTo('press').length).toBeGreaterThan(10);
 */

export type FakeMethod =
  | 'info' | 'wake' | 'press' | 'typeText' | 'screenshot' | 'foreground' | 'launch' | 'stop' | 'pid' | 'reset' | 'install'
  | 'evaluate' | 'onConsole' | 'cdp' | 'logs' | 'memory' | 'measure' | 'recordKeys' | 'probe' | 'close';

export type FakeMeasure = { fps?: { median: number; p10: number }; memMB?: number; cpuPct?: number; page?: Record<string, unknown> };

/** What each scriptable method resolves to. */
export type FakeReturns = {
  info: DriverInfo;
  wake: void;
  press: void;
  typeText: void;
  screenshot: Frame;
  foreground: { package: string; activity?: string } | null;
  launch: { pid?: number; launchMs?: number };
  stop: void;
  pid: number | undefined;
  reset: void;
  install: { package: string };
  evaluate: unknown;
  cdp: unknown;
  logs: LogLine[];
  memory: MemorySample;
  measure: FakeMeasure;
  probe: DriverCaps;
};

/**
 * A scripted answer: a value, an Error (the call rejects with it), or a
 * function of the call's arguments returning either (sync or async). Inside a
 * function, `fake.base.<method>(...)` runs the default behaviour.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FakeReply<T> = T | Error | ((...args: any[]) => T | Error | Promise<T>);

export type FakeCall = { method: FakeMethod; args: unknown[]; ts: number };

export type FakeDriverOptions = {
  serial?: string;
  /** The kind it reports (default 'mock'); 'adb'/'vda' let you test kind-specific code paths. */
  kind?: 'adb' | 'vda' | 'mock';
  /** Overrides on top of "everything works". */
  caps?: Partial<DriverCaps>;
  info?: DriverInfo;
  /** Screen size (default 1920x1080) and the colour of the default frame. */
  screen?: { width: number; height: number; rgba?: [number, number, number, number] };
  /** Packages that count as installed by FireLab (reset allowed). install() adds to it. */
  installed?: string[];
  /** Throw 'unsupported' when a method is called while its cap is false (default true), like a careful real driver. */
  strictCaps?: boolean;
  /** Delay every call by this many ms (default 0). */
  latencyMs?: number;
  /** The package shown when no app is in front (default 'com.fake.launcher'). */
  launcher?: string;
};

const CAP_FOR: Partial<Record<FakeMethod, keyof DriverCaps>> = {
  typeText: 'text',
  reset: 'reset',
  install: 'install',
  evaluate: 'eval',
  onConsole: 'console',
  cdp: 'cdp',
  memory: 'memory',
  measure: 'measure',
  recordKeys: 'recordKeys',
};

const LEVELS: LogLine['level'][] = ['verbose', 'debug', 'info', 'warn', 'error', 'fatal'];

function allCaps(): DriverCaps {
  return { keys: true, holds: true, text: true, screenshot: true, rgbaThumb: true, launch: true, reset: true, install: true, eval: true, console: true, cdp: true, logs: true, memory: true, measure: true, recordKeys: true };
}

/** The device the fake pretends to be; tests may read and change it directly. */
export type FakeState = {
  awake: boolean;
  foreground: { package: string; activity?: string } | null;
  /** Running apps: package -> pid. */
  running: Map<string, number>;
  /** Every pid each package had (for logs({ app })). */
  pidHistory: Map<string, Set<number>>;
  nextPid: number;
  installed: Set<string>;
  logs: LogLine[];
  /** Every key pressed, flattened, in order. */
  pressed: KeySpec[];
  typed: string[];
  /** What screenshot() shows: a fixed RGBA image, or a function of the state (e.g. per foreground app). */
  frame?: { width: number; height: number; data: Uint8Array } | ((s: FakeState) => { width: number; height: number; data: Uint8Array });
};

export class FakeDriver implements DeviceDriver {
  readonly kind: 'adb' | 'vda' | 'mock';
  readonly serial: string;
  readonly caps: DriverCaps;
  readonly calls: FakeCall[] = [];
  readonly state: FakeState;
  closed = false;
  private readonly opts: FakeDriverOptions;
  private readonly replies = new Map<FakeMethod, { once: FakeReply<unknown>[]; always?: FakeReply<unknown>; hasAlways: boolean }>();
  private readonly consoleListeners = new Map<string, Set<(e: ConsoleEntry) => void>>();
  private readonly recordings = new Set<RecordedKey[]>();
  private readonly screen: { width: number; height: number; rgba: [number, number, number, number] };

  /** The default behaviour of every method, for use inside scripted replies. */
  readonly base: {
    info(): Promise<DriverInfo>;
    wake(): Promise<void>;
    press(keys: KeySpec[], opts?: { gapMs?: number }): Promise<void>;
    typeText(text: string): Promise<void>;
    screenshot(opts?: { width?: number; quality?: number; format?: 'jpeg' | 'png' | 'rgba' }): Promise<Frame>;
    foreground(): Promise<{ package: string; activity?: string } | null>;
    launch(app: AppRef): Promise<{ pid?: number; launchMs?: number }>;
    stop(app: AppRef): Promise<void>;
    pid(app: AppRef): Promise<number | undefined>;
    reset(app: AppRef, opts: ResetOptions): Promise<void>;
    install(path: string): Promise<{ package: string }>;
    evaluate(expression: string, opts?: { app?: AppRef; timeoutMs?: number }): Promise<unknown>;
    cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
    logs(opts: { app?: AppRef; sinceTs?: number; minLevel?: LogLine['level'] }): Promise<LogLine[]>;
    memory(app: AppRef): Promise<MemorySample>;
    measure(app: AppRef, seconds: number): Promise<FakeMeasure>;
    probe(app?: AppRef): Promise<DriverCaps>;
  };

  constructor(opts: FakeDriverOptions = {}) {
    this.opts = opts;
    this.kind = opts.kind ?? 'mock';
    this.serial = opts.serial ?? 'fake-tv';
    this.caps = { ...allCaps(), ...opts.caps, keys: true, screenshot: true, launch: true, logs: true };
    this.screen = { width: opts.screen?.width ?? 1920, height: opts.screen?.height ?? 1080, rgba: opts.screen?.rgba ?? [16, 24, 40, 255] };
    const launcher = opts.launcher ?? 'com.fake.launcher';
    this.state = {
      awake: true,
      foreground: { package: launcher },
      running: new Map([[launcher, 100]]),
      pidHistory: new Map([[launcher, new Set([100])]]),
      nextPid: 1000,
      installed: new Set(opts.installed ?? []),
      logs: [],
      pressed: [],
      typed: [],
    };
    const st = this.state;
    const self = this;
    this.base = {
      async info() {
        return opts.info ?? { model: 'FAKE1', name: 'Fake TV', os: 'FakeOS 1.0', ramMB: 1024, gpu: 'Fake GPU', tier: 'tv', resolution: { width: self.screen.width, height: self.screen.height } };
      },
      async wake() {
        st.awake = true;
      },
      async press(keys) {
        if (!Array.isArray(keys) || !keys.length) throw new FireLabError('bad-request', 'No keys given');
        for (const k of keys) {
          if (!(DRIVER_KEYS as readonly string[]).includes(k?.key)) throw new FireLabError('bad-request', `Unknown remote key "${String(k?.key)}"`);
          if (k.mode === 'hold' && k.holdMs !== undefined && !(k.holdMs >= 1 && k.holdMs <= 30000)) throw new FireLabError('bad-request', `Hold time for "${k.key}" must be 1-30000 ms`);
        }
        st.pressed.push(...keys.map((k) => ({ ...k })));
        if (keys.some((k) => k.key === 'home')) st.foreground = { package: launcher };
      },
      async typeText(text) {
        st.typed.push(text);
      },
      async screenshot(o = {}) {
        const img = self.currentFrame();
        const format = o.format ?? 'jpeg';
        if (format === 'rgba') {
          const small = resizeRgba(img, Math.max(1, Math.round(o.width ?? 64)));
          return { width: small.width, height: small.height, rgba: small.data, captureMs: 1 };
        }
        const w = Math.max(1, Math.min(Math.round(o.width ?? (format === 'png' ? img.width : 960)), img.width));
        const small = resizeRgba(img, w);
        return format === 'png'
          ? { width: small.width, height: small.height, data: encodePng(small), mime: 'image/png', captureMs: 1 }
          : { width: small.width, height: small.height, data: encodeJpeg(small, o.quality ?? 70), mime: 'image/jpeg', captureMs: 1 };
      },
      async foreground() {
        return st.foreground ? { ...st.foreground } : null;
      },
      async launch(app) {
        const pkg = self.pkg(app);
        let pid = st.running.get(pkg);
        if (!pid) {
          pid = st.nextPid++;
          st.running.set(pkg, pid);
          let h = st.pidHistory.get(pkg);
          if (!h) st.pidHistory.set(pkg, (h = new Set()));
          h.add(pid);
        }
        st.foreground = { package: pkg, activity: `${pkg}.MainActivity` };
        st.awake = true;
        return { pid, launchMs: 250 };
      },
      async stop(app) {
        const pkg = self.pkg(app);
        st.running.delete(pkg);
        if (st.foreground?.package === pkg) st.foreground = { package: launcher };
      },
      async pid(app) {
        return st.running.get(self.pkg(app));
      },
      async reset(app, o) {
        const pkg = self.pkg(app);
        if (o?.confirm !== true) throw new FireLabError('confirm-required', `Resetting ${pkg} deletes all of its data`, { hint: 'Pass { confirm: true }' });
        if (!st.installed.has(pkg) && o.allowAnyPackage !== true) throw new FireLabError('confirm-required', `FireLab didn't install ${pkg}, so it won't clear its data`, { hint: 'Pass allowAnyPackage: true if you are sure' });
        st.running.delete(pkg);
      },
      async install(path) {
        const base = String(path).split(/[\\/]/).pop()?.replace(/\.apk$/i, '').replace(/[^A-Za-z0-9]+/g, '').toLowerCase() || 'app';
        const pkg = `com.fake.${/^[a-z]/.test(base) ? base : `app${base}`}`;
        st.installed.add(pkg);
        return { package: pkg };
      },
      async evaluate() {
        return undefined;
      },
      async cdp() {
        return {};
      },
      async logs(o = {}) {
        const min = o.minLevel ? LEVELS.indexOf(o.minLevel) : 0;
        const pkg = o.app?.package;
        const pids = pkg ? (st.pidHistory.get(pkg) ?? new Set<number>()) : undefined;
        return st.logs
          .filter((l) => (o.sinceTs === undefined || l.ts >= o.sinceTs) && LEVELS.indexOf(l.level) >= min && (!pkg || (l.pid !== undefined && pids?.has(l.pid)) || l.text.includes(pkg)))
          .map((l) => ({ ...l }));
      },
      async memory(app) {
        return { ts: Date.now(), pssMB: st.running.has(self.pkg(app)) ? 180 : undefined, jsHeapMB: 24, graphicsMB: 40, availMB: 420 };
      },
      async measure() {
        return { fps: { median: 60, p10: 57 }, memMB: 180, cpuPct: 45 };
      },
      async probe() {
        return self.caps;
      },
    };
  }

  // ---------- scripting ----------

  /** Answers every later call to `method` with `reply` (until changed). */
  on<M extends keyof FakeReturns>(method: M, reply: FakeReply<FakeReturns[M]>): this {
    const r = this.slot(method);
    r.always = reply;
    r.hasAlways = true;
    return this;
  }

  /** Answers the next call to `method` with `reply` (queued before any `on` reply). */
  once<M extends keyof FakeReturns>(method: M, reply: FakeReply<FakeReturns[M]>): this {
    this.slot(method).once.push(reply);
    return this;
  }

  /** Drops scripted replies (for one method, or all), back to the default behaviour. */
  resetReplies(method?: FakeMethod): this {
    if (method) this.replies.delete(method);
    else this.replies.clear();
    return this;
  }

  private slot(method: FakeMethod) {
    let r = this.replies.get(method);
    if (!r) this.replies.set(method, (r = { once: [], hasAlways: false }));
    return r;
  }

  /** Calls to one method, oldest first. */
  callsTo(method: FakeMethod): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  clearCalls(): this {
    this.calls.length = 0;
    return this;
  }

  // ---------- simulation helpers ----------

  /** Sends a console entry to `onConsole` listeners of `pkg`. */
  emitConsole(pkg: string, entry: Partial<ConsoleEntry> & { text: string }): void {
    const e: ConsoleEntry = { ts: Date.now(), level: 'log', source: 'console', ...entry };
    for (const fn of this.consoleListeners.get(pkg) ?? []) fn(e);
  }

  /** Adds a device log line (pid defaults to the app's current pid when `app` is given). */
  pushLog(line: Partial<LogLine> & { text: string }, app?: string): LogLine {
    const l: LogLine = { ts: Date.now(), level: 'info', ...(app && this.state.running.get(app) ? { pid: this.state.running.get(app) } : {}), ...line };
    this.state.logs.push(l);
    return l;
  }

  /** The app dies: its process goes, the launcher comes back, and a FATAL EXCEPTION lands in the log. */
  crash(pkg: string, message = 'java.lang.RuntimeException: boom'): void {
    const pid = this.state.running.get(pkg);
    this.state.logs.push(
      { ts: Date.now(), level: 'error', tag: 'AndroidRuntime', ...(pid ? { pid } : {}), text: 'FATAL EXCEPTION: main' },
      { ts: Date.now(), level: 'error', tag: 'AndroidRuntime', ...(pid ? { pid } : {}), text: `Process: ${pkg}, PID: ${pid ?? 0}` },
      { ts: Date.now(), level: 'error', tag: 'AndroidRuntime', ...(pid ? { pid } : {}), text: message },
    );
    this.state.running.delete(pkg);
    if (this.state.foreground?.package === pkg) this.state.foreground = { package: this.opts.launcher ?? 'com.fake.launcher' };
  }

  /** A person presses a key on the real remote: active `recordKeys` sessions see it. */
  humanPress(key: string, holdMs = 80): void {
    const ts = Date.now();
    for (const rec of this.recordings) rec.push({ ts, key, action: 'down' }, { ts: ts + holdMs, key, action: 'up', holdMs });
  }

  /** Sets what screenshot() shows: a solid colour, an RGBA image, or a function of the state. */
  setFrame(frame: FakeState['frame'] | [number, number, number, number]): void {
    if (Array.isArray(frame)) {
      this.screen.rgba = frame;
      this.state.frame = undefined;
    } else this.state.frame = frame;
  }

  private currentFrame(): { width: number; height: number; data: Uint8Array } {
    const f = typeof this.state.frame === 'function' ? this.state.frame(this.state) : this.state.frame;
    if (f) return f;
    const { width, height, rgba } = this.screen;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
    return { width, height, data };
  }

  private pkg(app: AppRef): string {
    if (!app || typeof app.package !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(app.package)) {
      throw new FireLabError('bad-request', `"${String(app?.package)}" is not an Android package name`);
    }
    return app.package;
  }

  // ---------- the DeviceDriver surface ----------

  private async call<M extends keyof FakeReturns>(method: M, args: unknown[], fallback: () => Promise<FakeReturns[M]>): Promise<FakeReturns[M]> {
    this.calls.push({ method, args, ts: Date.now() });
    if (this.closed && method !== 'probe') throw new FireLabError('bad-request', `The driver for ${this.serial} is closed`);
    const cap = CAP_FOR[method];
    if (cap && this.opts.strictCaps !== false && !this.caps[cap]) {
      throw new FireLabError('unsupported', `${method}() isn't available: caps.${cap} is false on ${this.serial}`, { hint: 'Check driver.caps before calling optional methods' });
    }
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    const slot = this.replies.get(method);
    let reply: FakeReply<unknown> | undefined;
    if (slot?.once.length) reply = slot.once.shift();
    else if (slot?.hasAlways) reply = slot.always;
    else return fallback();
    const value = typeof reply === 'function' ? await (reply as (...a: unknown[]) => unknown)(...args) : reply;
    if (value instanceof Error) throw value;
    return value as FakeReturns[M];
  }

  info() {
    return this.call('info', [], () => this.base.info());
  }
  wake() {
    return this.call('wake', [], () => this.base.wake());
  }
  press(keys: KeySpec[], opts?: { gapMs?: number }) {
    return this.call('press', [keys, opts], () => this.base.press(keys, opts));
  }
  typeText(text: string) {
    return this.call('typeText', [text], () => this.base.typeText(text));
  }
  screenshot(opts?: { width?: number; quality?: number; format?: 'jpeg' | 'png' | 'rgba' }) {
    return this.call('screenshot', [opts], () => this.base.screenshot(opts));
  }
  foreground() {
    return this.call('foreground', [], () => this.base.foreground());
  }
  launch(app: AppRef) {
    return this.call('launch', [app], () => this.base.launch(app));
  }
  stop(app: AppRef) {
    return this.call('stop', [app], () => this.base.stop(app));
  }
  pid(app: AppRef) {
    return this.call('pid', [app], () => this.base.pid(app));
  }
  reset(app: AppRef, opts: ResetOptions) {
    return this.call('reset', [app, opts], () => this.base.reset(app, opts));
  }
  install(path: string) {
    return this.call('install', [path], () => this.base.install(path));
  }
  evaluate<T = unknown>(expression: string, opts?: { app?: AppRef; timeoutMs?: number }): Promise<T> {
    return this.call('evaluate', [expression, opts], () => this.base.evaluate(expression, opts)) as Promise<T>;
  }
  cdp(method: string, params?: Record<string, unknown>) {
    return this.call('cdp', [method, params], () => this.base.cdp(method, params));
  }
  logs(opts: { app?: AppRef; sinceTs?: number; minLevel?: LogLine['level'] }) {
    return this.call('logs', [opts], () => this.base.logs(opts));
  }
  memory(app: AppRef) {
    return this.call('memory', [app], () => this.base.memory(app));
  }
  measure(app: AppRef, seconds: number) {
    return this.call('measure', [app, seconds], () => this.base.measure(app, seconds));
  }
  probe(app?: AppRef) {
    return this.call('probe', [app], () => this.base.probe(app));
  }

  onConsole(app: AppRef, fn: (e: ConsoleEntry) => void): () => void {
    this.calls.push({ method: 'onConsole', args: [app, fn], ts: Date.now() });
    this.syncGuard('onConsole');
    const pkg = this.pkg(app);
    let set = this.consoleListeners.get(pkg);
    if (!set) this.consoleListeners.set(pkg, (set = new Set()));
    set.add(fn);
    return () => void set.delete(fn);
  }

  recordKeys(): { stop(): Promise<RecordedKey[]> } {
    this.calls.push({ method: 'recordKeys', args: [], ts: Date.now() });
    this.syncGuard('recordKeys');
    const keys: RecordedKey[] = [];
    this.recordings.add(keys);
    return {
      stop: async () => {
        this.recordings.delete(keys);
        return keys.slice();
      },
    };
  }

  private syncGuard(method: 'onConsole' | 'recordKeys'): void {
    if (this.closed) throw new FireLabError('bad-request', `The driver for ${this.serial} is closed`);
    const cap = CAP_FOR[method];
    if (cap && this.opts.strictCaps !== false && !this.caps[cap]) {
      throw new FireLabError('unsupported', `${method}() isn't available: caps.${cap} is false on ${this.serial}`, { hint: 'Check driver.caps before calling optional methods' });
    }
  }

  /** Listeners and recordings end; later calls throw. */
  async close(): Promise<void> {
    this.calls.push({ method: 'close', args: [], ts: Date.now() });
    this.closed = true;
    this.consoleListeners.clear();
    this.recordings.clear();
  }

  /** How many console listeners are attached (all apps, or one). */
  listenerCount(pkg?: string): number {
    if (pkg) return this.consoleListeners.get(pkg)?.size ?? 0;
    let n = 0;
    for (const s of this.consoleListeners.values()) n += s.size;
    return n;
  }

  /** How many recordKeys sessions are running. */
  get activeRecordings(): number {
    return this.recordings.size;
  }
}
