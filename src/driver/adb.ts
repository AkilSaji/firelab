import { FireLab, type FireLabOptions } from '../core/firelab.js';
import { installedByFireLab } from '../core/installs.js';
import { REMOTE_KEYS } from '../adb/keys.js';
import { captureScreen, screenRgba } from '../adb/screenshot.js';
import { resizeRgba } from '../adb/image.js';
import { encodePng } from '../adb/png.js';
import { assertPackage, pidOf } from '../adb/apps.js';
import { normalizeSerial } from '../adb/devices.js';
import { dumpLogcat } from '../adb/logcat.js';
import { KeyRecorder } from '../adb/getevent.js';
import { listDevtoolsSockets } from '../cdp/sockets.js';
import type { WebViewSession } from '../cdp/webview.js';
import { NativeSampler } from '../perf/native.js';
import { FireLabError } from '../lib/errors.js';
import { round1, sleep } from '../lib/util.js';
import type { AppRef, ConsoleEntry, DeviceDriver, DriverCaps, DriverInfo, Frame, KeySpec, LogLine, MemorySample, RecordedKey, ResetOptions } from './types.js';

export type AdbDriverOptions = {
  /** adb serial or IP ("192.168.1.50" means 192.168.1.50:5555). */
  serial: string;
  /** Share an existing FireLab (the MCP server's, the dashboard's). Default: the driver makes its own. */
  lab?: FireLab;
  /** Whether close() also closes the FireLab (default: only when the driver made it). */
  ownsLab?: boolean;
  /** Options for the FireLab the driver makes when none is given. */
  labOptions?: FireLabOptions;
  /** Packages reset() may clear although FireLab didn't install them (the caller vouches for them). */
  resetAllow?: string[];
  /** How long launch() waits for the app's WebView DevTools socket before eval/console/cdp count as off (default 3000 ms). */
  webviewWaitMs?: number;
  /** How many recent log lines logs() reads before filtering (default 2000). */
  logLines?: number;
};

/** Device-level caps an adb device always has; the rest start false and are probed. */
function adbCaps(): DriverCaps {
  return {
    keys: true,
    holds: false, // until the virtual remote is verified (probe / first hold)
    text: true, // `input text` (ASCII)
    screenshot: true,
    rgbaThumb: true, // raw framebuffer (or PNG) -> RGBA -> box downscale, no JPEG
    launch: true,
    reset: false, // per app: only FireLab-installed ones
    install: true,
    eval: false, // per app: needs a debuggable WebView
    console: false,
    cdp: false,
    logs: true,
    memory: true, // dumpsys meminfo + /proc
    measure: true,
    recordKeys: false, // until getevent is found
  };
}

/** KeySpec -> the CLI key syntax FireLab.pressKeys reads ("right:1500", "ok:long"). */
export function keySpecString(k: KeySpec): string {
  if (!k || typeof k.key !== 'string' || !Object.prototype.hasOwnProperty.call(REMOTE_KEYS, k.key)) {
    throw new FireLabError('bad-request', `Unknown remote key "${String(k?.key)}"`, { hint: `Use one of: ${Object.keys(REMOTE_KEYS).join(', ')}` });
  }
  const mode = k.mode ?? 'press';
  if (mode === 'press') return k.key;
  if (mode === 'long') return `${k.key}:long`;
  if (mode !== 'hold') throw new FireLabError('bad-request', `Unknown key mode "${String(mode)}"`, { hint: 'press, long or hold' });
  const ms = Math.round(k.holdMs ?? 500);
  if (!(ms >= 1 && ms <= 30000)) throw new FireLabError('bad-request', `Hold time for "${k.key}" must be 1-30000 ms`);
  return `${k.key}:${ms}`;
}

/** Keeps a console listener attached to an app's WebView across reloads and relaunches. */
class ConsoleSubscription {
  private off?: () => void;
  private timer?: NodeJS.Timeout;
  private attempts = 0;
  stopped = false;

  constructor(
    private readonly open: () => Promise<WebViewSession>,
    private readonly fn: (e: ConsoleEntry) => void,
  ) {}

  attach(): void {
    if (this.stopped) return;
    this.open().then(
      (s) => {
        if (this.stopped) return;
        this.attempts = 0;
        const onConsole = (e: ConsoleEntry) => {
          try {
            this.fn(e);
          } catch {
            /* a listener's bug must not break the session */
          }
        };
        const onClose = () => {
          this.detach();
          this.retry();
        };
        s.on('console', onConsole);
        s.once('close', onClose);
        this.off = () => {
          s.off('console', onConsole);
          s.off('close', onClose);
        };
      },
      () => this.retry(),
    );
  }

  private retry(): void {
    if (this.stopped) return;
    const delay = Math.min(5000, 500 * 2 ** Math.min(this.attempts++, 4));
    this.timer = setTimeout(() => this.attach(), delay);
    this.timer.unref();
  }

  private detach(): void {
    this.off?.();
    this.off = undefined;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.detach();
  }
}

/**
 * DeviceDriver for Fire TV and Android TV over adb: a thin adapter over
 * `FireLab` (src/core/firelab.ts). See docs/DRIVERS.md for the caps model.
 */
export class AdbDriver implements DeviceDriver {
  readonly kind = 'adb' as const;
  readonly serial: string;
  readonly caps: DriverCaps = adbCaps();
  readonly lab: FireLab;
  private readonly ownsLab: boolean;
  private readonly resetAllow: Set<string>;
  private app?: AppRef;
  /** Every pid seen per package, so logs() still finds a crashed process's last words. */
  private readonly pids = new Map<string, Set<number>>();
  /** Packages that had a WebView (true) or didn't after a full wait (false). */
  private readonly webviewSeen = new Map<string, boolean>();
  private readonly samplers = new Map<string, NativeSampler>();
  private readonly recorders = new Set<KeyRecorder>();
  private readonly consoleSubs = new Set<ConsoleSubscription>();
  /** DevTools sessions this driver used: their adb forwards go on close(). */
  private readonly sessions = new Set<WebViewSession>();
  private clockOffset?: Promise<number>;
  private closed = false;

  constructor(private readonly opts: AdbDriverOptions) {
    if (!opts?.serial) throw new FireLabError('bad-request', 'AdbDriver needs a serial', { hint: 'Use createDriver() to pick the only connected device' });
    this.serial = normalizeSerial(opts.serial);
    this.lab = opts.lab ?? new FireLab(opts.labOptions);
    this.ownsLab = opts.ownsLab ?? !opts.lab;
    this.resetAllow = new Set(opts.resetAllow ?? []);
  }

  private get adb() {
    return this.lab.adb;
  }

  private assertOpen(): void {
    if (this.closed) throw new FireLabError('bad-request', `The driver for ${this.serial} is closed`);
  }

  private notePid(pkg: string, pid: number | null | undefined): void {
    if (!pid) return;
    let s = this.pids.get(pkg);
    if (!s) this.pids.set(pkg, (s = new Set()));
    s.add(pid);
  }

  private setWebCaps(on: boolean): void {
    this.caps.eval = on;
    this.caps.console = on;
    this.caps.cdp = on;
  }

  private resettable(pkg: string): boolean {
    return this.resetAllow.has(pkg) || installedByFireLab(this.lab.home, pkg, this.serial);
  }

  // ---------- caps ----------

  /** See DeviceDriver.probe: device-level caps, plus app-level ones for `app`. */
  async probe(app?: AppRef): Promise<DriverCaps> {
    this.assertOpen();
    const [holds, getevent] = await Promise.all([
      this.lab
        .remote(this.serial)
        .then(async (r) => (r.probe ? (await r.probe()).holds : r.holds?.() === true))
        .catch(() => false),
      this.adb
        .shell(this.serial, 'command -v getevent >/dev/null 2>&1 && echo @@yes', { timeoutMs: 8000 })
        .then((o) => o.includes('@@yes'))
        .catch(() => false),
    ]);
    this.caps.holds = holds;
    this.caps.recordKeys = getevent;
    if (app) await this.probeApp(app, 0);
    return this.caps;
  }

  /** App-level caps: reset (FireLab installed it) and eval/console/cdp (a debuggable WebView), waiting up to `waitMs` for the WebView. */
  private async probeApp(app: AppRef, waitMs: number): Promise<void> {
    assertPackage(app.package);
    this.app = app;
    this.caps.reset = this.resettable(app.package);
    const until = Date.now() + waitMs;
    for (;;) {
      const has = await this.hasWebview(app.package).catch(() => false);
      if (this.app !== app) return; // another launch/probe took over
      if (has || Date.now() >= until) {
        this.setWebCaps(has);
        if (has || waitMs > 0) this.webviewSeen.set(app.package, has);
        return;
      }
      await sleep(Math.min(500, Math.max(50, until - Date.now())));
    }
  }

  private async hasWebview(pkg: string): Promise<boolean> {
    const [pid, sockets] = await Promise.all([pidOf(this.adb, this.serial, pkg), listDevtoolsSockets(this.adb, this.serial)]);
    this.notePid(pkg, pid);
    return sockets.some((s) => (pid && s.pid === pid) || s.package === pkg);
  }

  private async refreshHolds(): Promise<void> {
    const r = await this.lab.remote(this.serial).catch(() => undefined);
    this.caps.holds = r?.holds?.() === true;
  }

  // ---------- device ----------

  async info(): Promise<DriverInfo> {
    this.assertOpen();
    const i = await this.lab.deviceInfo(this.serial);
    const out: DriverInfo = {};
    if (i.model) out.model = i.model;
    if (i.name) out.name = i.name;
    if (i.os) out.os = i.os;
    if (i.ramMB) out.ramMB = i.ramMB;
    if (i.gpu) out.gpu = i.gpu;
    if (i.tier) out.tier = i.tier;
    if (i.resolution) out.resolution = { ...i.resolution };
    return out;
  }

  async wake(): Promise<void> {
    this.assertOpen();
    await this.lab.wake(this.serial);
  }

  // ---------- remote ----------

  async press(keys: KeySpec[], opts: { gapMs?: number } = {}): Promise<void> {
    this.assertOpen();
    if (!Array.isArray(keys) || !keys.length) throw new FireLabError('bad-request', 'No keys given');
    const specs = keys.map(keySpecString);
    for (let i = 0; i < specs.length; i += 100) {
      if (i > 0 && opts.gapMs) await sleep(opts.gapMs);
      await this.lab.pressKeys(this.serial, specs.slice(i, i + 100), { gapMs: opts.gapMs });
    }
    // A hold may have just verified (or ruled out) the virtual remote.
    if (keys.some((k) => (k.mode ?? 'press') !== 'press')) await this.refreshHolds();
  }

  async typeText(text: string): Promise<void> {
    this.assertOpen();
    await this.lab.typeText(this.serial, text);
  }

  // ---------- screen ----------

  async screenshot(opts: { width?: number; quality?: number; format?: 'jpeg' | 'png' | 'rgba' } = {}): Promise<Frame> {
    this.assertOpen();
    const format = opts.format ?? 'jpeg';
    if (format === 'rgba' || (format === 'png' && opts.width)) {
      // Raw framebuffer straight to a small RGBA buffer: no JPEG encode/decode.
      const screen = await captureScreen(this.adb, this.serial);
      const want = Math.max(1, Math.round(opts.width ?? (format === 'rgba' ? 64 : screen.width)));
      const img = resizeRgba(screenRgba(screen), want);
      if (format === 'rgba') return { width: img.width, height: img.height, rgba: img.data, captureMs: screen.ms };
      return { width: img.width, height: img.height, data: encodePng(img), mime: 'image/png', captureMs: screen.ms };
    }
    const s = await this.lab.screenshot(this.serial, { width: opts.width, quality: opts.quality, format });
    return { width: s.width, height: s.height, data: s.data, mime: s.mime, captureMs: s.captureMs };
  }

  /** See DeviceDriver.uiDump. Straight to stdout when uiautomator allows it, else through a file in /data/local/tmp. */
  async uiDump(opts: { timeoutMs?: number } = {}): Promise<string> {
    this.assertOpen();
    const timeoutMs = opts.timeoutMs ?? 15000;
    const direct = (await this.adb.execOut(this.serial, 'uiautomator dump /dev/stdout', { timeoutMs })).toString('utf8');
    if (direct.includes('<hierarchy')) return direct;
    const file = '/data/local/tmp/firelab-ui.xml';
    const out = await this.adb.shell(this.serial, `uiautomator dump ${file} >/dev/null 2>&1; cat ${file}; rm -f ${file}`, { timeoutMs });
    if (out.includes('<hierarchy')) return out;
    const why = (direct.trim() || out.trim()).split('\n')[0] ?? '';
    throw new FireLabError('adb-failed', `uiautomator dump gave no hierarchy on ${this.serial}${why ? `: ${why.slice(0, 120)}` : ''}`, { hint: 'An animated screen can keep uiautomator from ever seeing the UI idle' });
  }

  // ---------- apps ----------

  async foreground(): Promise<{ package: string; activity?: string } | null> {
    this.assertOpen();
    return this.lab.foreground(this.serial);
  }

  async launch(app: AppRef): Promise<{ pid?: number; launchMs?: number }> {
    this.assertOpen();
    assertPackage(app?.package);
    const r = await this.lab.launch(this.serial, app.package, app.url ? { url: app.url } : {});
    this.notePid(app.package, r.pid);
    // Wait for the WebView only if this app might have one: once it had none after a full wait, check once.
    const wait = this.webviewSeen.get(app.package) === false ? 0 : (this.opts.webviewWaitMs ?? 3000);
    await this.probeApp(app, wait);
    const out: { pid?: number; launchMs?: number } = {};
    if (r.pid) out.pid = r.pid;
    if (r.launchMs !== undefined) out.launchMs = r.launchMs;
    return out;
  }

  async stop(app: AppRef): Promise<void> {
    this.assertOpen();
    await this.lab.stop(this.serial, assertPackage(app?.package));
  }

  async pid(app: AppRef): Promise<number | undefined> {
    this.assertOpen();
    const pid = await pidOf(this.adb, this.serial, assertPackage(app?.package));
    this.notePid(app.package, pid);
    return pid ?? undefined;
  }

  /**
   * Clears the app's data. Needs `{ confirm: true }`, and refuses apps that
   * FireLab didn't install (docs/CONTRACT.md safety rules) unless the caller
   * passes `allowAnyPackage: true` or listed the package in `resetAllow`.
   */
  async reset(app: AppRef, opts: ResetOptions): Promise<void> {
    this.assertOpen();
    const pkg = assertPackage(app?.package);
    if (opts?.confirm !== true) {
      throw new FireLabError('confirm-required', `Resetting ${pkg} deletes all of its data (saves, logins, settings)`, { hint: 'Pass { confirm: true } if that is what you want' });
    }
    if (!this.resettable(pkg) && opts.allowAnyPackage !== true) {
      throw new FireLabError('confirm-required', `FireLab didn't install ${pkg} on ${this.serial}, so it won't clear its data`, {
        hint: "Only apps installed with FireLab (install, firelab wrap) are reset by default. If you're sure, pass { confirm: true, allowAnyPackage: true } or list it in resetAllow",
      });
    }
    await this.lab.reset(this.serial, pkg, true);
  }

  async install(path: string): Promise<{ package: string }> {
    this.assertOpen();
    const r = await this.lab.install(this.serial, path);
    if (this.app?.package === r.package) this.caps.reset = this.resettable(r.package);
    return { package: r.package };
  }

  // ---------- WebView ----------

  private async session(pkg?: string): Promise<WebViewSession> {
    const s = await this.lab.webview(this.serial, pkg);
    this.sessions.add(s);
    return s;
  }

  async evaluate<T = unknown>(expression: string, opts: { app?: AppRef; timeoutMs?: number } = {}): Promise<T> {
    this.assertOpen();
    const pkg = opts.app?.package ?? this.app?.package;
    try {
      const s = await this.session(pkg);
      if (!expression?.trim()) throw new FireLabError('bad-request', 'Empty expression');
      const value = await s.eval<T>(expression, { timeoutMs: opts.timeoutMs ?? 10000 });
      if (s.package && s.package === this.app?.package) this.setWebCaps(true);
      return value;
    } catch (e) {
      if (e instanceof FireLabError && e.code === 'no-webview' && pkg && pkg === this.app?.package) this.setWebCaps(false);
      throw e;
    }
  }

  onConsole(app: AppRef, fn: (e: ConsoleEntry) => void): () => void {
    this.assertOpen();
    const pkg = assertPackage(app?.package);
    const sub = new ConsoleSubscription(() => this.session(pkg), fn);
    this.consoleSubs.add(sub);
    sub.attach();
    return () => {
      sub.stop();
      this.consoleSubs.delete(sub);
    };
  }

  async cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.assertOpen();
    if (!method || typeof method !== 'string') throw new FireLabError('bad-request', 'A CDP method name is needed, e.g. "HeapProfiler.collectGarbage"');
    const s = await this.session(this.app?.package);
    return s.cdp.send(method, params, 60000);
  }

  // ---------- logs and performance ----------

  /** Device clock minus host clock (ms), when they differ by more than the 1 s `date` can resolve. */
  private deviceClockOffset(): Promise<number> {
    this.clockOffset ??= (async () => {
      const t0 = Date.now();
      const out = await this.adb.shell(this.serial, 'date +%s', { timeoutMs: 5000 }).catch(() => '');
      const t1 = Date.now();
      const dev = Number(out.trim());
      if (!Number.isFinite(dev) || dev < 1e9) return 0;
      const off = dev * 1000 + 500 - (t0 + t1) / 2; // +500: date truncates to the second
      return Math.abs(off) > 1500 ? Math.round(off) : 0;
    })();
    return this.clockOffset;
  }

  /**
   * Recent device log lines, newest last, with timestamps on the host clock.
   * With `app`: lines from any process the app had in this driver's lifetime
   * (so a crash's FATAL EXCEPTION from a pid that's gone still shows) and
   * lines that name the package (ActivityManager's "Process ... has died").
   */
  async logs(opts: { app?: AppRef; sinceTs?: number; minLevel?: LogLine['level'] } = {}): Promise<LogLine[]> {
    this.assertOpen();
    const pkg = opts.app ? assertPackage(opts.app.package) : undefined;
    if (pkg) this.notePid(pkg, await pidOf(this.adb, this.serial, pkg).catch(() => null));
    const [offset, raw] = await Promise.all([
      this.deviceClockOffset(),
      dumpLogcat(this.adb, this.serial, { lines: this.opts.logLines ?? 2000, ...(opts.minLevel ? { minLevel: opts.minLevel } : {}) }),
    ]);
    const pids = pkg ? (this.pids.get(pkg) ?? new Set<number>()) : undefined;
    const out: LogLine[] = [];
    for (const l of raw) {
      const ts = l.ts - offset;
      if (opts.sinceTs !== undefined && ts < opts.sinceTs) continue;
      if (pkg && !pids?.has(l.pid) && !l.text.includes(pkg)) continue;
      out.push({ ts, level: l.level, tag: l.tag, pid: l.pid, text: l.text });
    }
    return out;
  }

  async memory(app: AppRef): Promise<MemorySample> {
    this.assertOpen();
    const pkg = assertPackage(app?.package);
    let sampler = this.samplers.get(pkg);
    if (!sampler) this.samplers.set(pkg, (sampler = new NativeSampler(this.adb, this.serial, pkg)));
    const n = await sampler.sample({ memory: true });
    this.notePid(pkg, n.appPid);
    const out: MemorySample = { ts: n.ts };
    if (n.memMB !== undefined) out.pssMB = n.memMB;
    if (n.graphicsMB !== undefined) out.graphicsMB = n.graphicsMB;
    if (n.memAvailableMB !== undefined) out.availMB = n.memAvailableMB;
    if (this.caps.eval && this.app?.package === pkg && n.appPid) {
      const heap = await this.session(pkg)
        .then((s) => s.cdp.send<{ usedSize?: number }>('Runtime.getHeapUsage', {}, 4000))
        .catch(() => undefined);
      if (typeof heap?.usedSize === 'number') out.jsHeapMB = round1(heap.usedSize / 1048576);
    }
    return out;
  }

  /** FireLab's measure(): fps (WebView probe or SurfaceFlinger), memory and CPU over `seconds` (2-120). */
  async measure(app: AppRef, seconds: number): Promise<Awaited<ReturnType<FireLab['measure']>>> {
    this.assertOpen();
    return this.lab.measure(this.serial, { package: assertPackage(app?.package), seconds });
  }

  /** Records a person's remote presses (getevent) until stop(). FireLab's own injected keys don't show up. */
  recordKeys(): { stop(): Promise<RecordedKey[]> } {
    this.assertOpen();
    const rec = new KeyRecorder(this.adb, this.serial);
    rec.on('error', () => {});
    rec.start();
    this.recorders.add(rec);
    return {
      stop: async () => {
        rec.stop();
        this.recorders.delete(rec);
        return rec.keys.map((k) => ({ ts: k.ts, key: k.key, action: k.action, ...(k.holdMs !== undefined ? { holdMs: k.holdMs } : {}) }));
      },
    };
  }

  /**
   * Stops key recorders and console listeners, closes the DevTools sessions
   * this driver used, which removes their adb forwards (never anyone else's), and
   * closes the FireLab if the driver made it (which also ends the virtual
   * remote and the Wi-Fi reconnector).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.consoleSubs) s.stop();
    this.consoleSubs.clear();
    for (const r of this.recorders) r.stop();
    this.recorders.clear();
    const sessions = [...this.sessions];
    this.sessions.clear();
    if (this.ownsLab) await this.lab.close();
    else for (const pkg of new Set(sessions.map((s) => s.package).filter((p): p is string => !!p))) this.lab.releaseWebviews(this.serial, pkg);
    // A closing session removes its own forward (tcp:<its port> only), so
    // nothing here can touch a forward another tool made.
    for (const s of sessions) if (!s.closed) s.close();
  }
}
