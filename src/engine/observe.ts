/**
 * The observer (docs/ENGINE.md 5.2): wait for the UI to settle (asynchronous
 * waits are the main cause of flaky UI tests [48, 49]), then read the probe,
 * one small frame, the device log and the console since the previous step.
 */
import type { AppRef, ConsoleEntry, DeviceDriver, LogLine } from './driver.js';
import type { Clock } from './clock.js';
import type { Action, FocusInfo, Observation, Probe } from './types.js';
import { PROBE_INSTALL, focusablesExpression, parseFocusables, parseProbe, probeDigest, probeReadExpression, type ProbeConfig } from './probe.js';
import { fingerprint } from './frame.js';
import { NativeFocus } from './uidump.js';

export type SettleOptions = { maxMs?: number; minMs?: number; pollMs?: number };

/**
 * settle(maxMs = 2000, minMs = 250) from 5.2: poll a digest of the discrete UI
 * state until two polls agree and at least minMs passed. Animated scenes never
 * settle fully; after maxMs that is accepted.
 */
export async function settle(digest: () => Promise<string>, clock: Clock, opts: SettleOptions = {}): Promise<number> {
  const maxMs = opts.maxMs ?? 2000;
  const minMs = opts.minMs ?? 250;
  const pollMs = opts.pollMs ?? 150;
  const t0 = clock.now();
  let last = await digest();
  for (;;) {
    await clock.sleep(pollMs);
    const d = await digest();
    const dt = clock.now() - t0;
    if (d === last && dt >= minMs) return dt;
    last = d;
    if (dt > maxMs) return maxMs;
  }
}

export type ObserverOptions = {
  driver: DeviceDriver;
  app: AppRef;
  clock: Clock;
  probe: ProbeConfig;
  settle?: SettleOptions;
  /** Scripts that must run before the page's own (the GPU shim): added over CDP after each launch, then the page reloads once. */
  initScripts?: string[];
};

export class Observer {
  private readonly d: DeviceDriver;
  private readonly app: AppRef;
  private readonly clock: Clock;
  private readonly cfg: ProbeConfig;
  private readonly settleOpts: SettleOptions;
  private lastLogTs = 0;
  private consoleBuf: ConsoleEntry[] = [];
  private unsubscribe?: () => void;
  private lastProbe?: Probe;
  private readonly initScripts: string[];
  /** Init scripts still to add on this launch (the WebView wasn't reachable yet). */
  private initPending = false;
  /** Times the init scripts went in (one page reload each). */
  initInstalls = 0;
  /** Native focus (uiautomator) for apps without the probe; undefined when the driver can't dump. */
  private readonly native?: NativeFocus;
  /** The native cache key of the latest observation (its picture), for focusables(). */
  private nativeKey?: string;
  /** Calls to evaluate/screenshot/uiautomator, for the run's cost summary. */
  readonly counters = { probes: 0, frames: 0, thumbs: 0, dumps: 0, dumpHits: 0 };

  constructor(o: ObserverOptions) {
    this.d = o.driver;
    this.app = o.app;
    this.clock = o.clock;
    this.cfg = o.probe;
    this.settleOpts = o.settle ?? {};
    this.initScripts = o.initScripts ?? [];
    this.lastLogTs = o.clock.now();
    if (NativeFocus.available(o.driver)) this.native = new NativeFocus(o.driver, o.app.package);
  }

  get canProbe(): boolean {
    return this.d.caps.eval && typeof this.d.evaluate === 'function';
  }

  /** Focus comes from uiautomator dumps: no probe, and the driver can dump (and dumps haven't kept failing). */
  get nativeFocus(): boolean {
    return !this.canProbe && !!this.native && !this.native.off;
  }

  /** Whether the driver could serve native focus at all (for choosing oracles before the first dump). */
  get canDumpUi(): boolean {
    return !!this.native;
  }

  /** After every (re)launch: the page is new, so the probe and the console listener go back in. */
  async afterLaunch(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.d.caps.console && this.d.onConsole) this.unsubscribe = this.d.onConsole(this.app, (e) => this.consoleBuf.push(e));
    this.initPending = this.initScripts.length > 0;
    await this.installInit();
    if (this.canProbe) await this.install();
  }

  /** Whether the driver can add scripts that run before the page's own. */
  get canInit(): boolean {
    return this.d.caps.cdp && typeof this.d.cdp === 'function';
  }

  /**
   * Adds the init scripts to the new page and reloads it, so they run before
   * the page's scripts. The scripts stay on the DevTools target until the
   * next launch makes a new one.
   */
  private async installInit(): Promise<void> {
    if (!this.initPending || !this.canInit || !this.d.cdp) return;
    try {
      await this.d.cdp('Page.enable').catch(() => undefined);
      for (const source of this.initScripts) await this.d.cdp('Page.addScriptToEvaluateOnNewDocument', { source });
      await this.d.cdp('Page.reload', {});
      this.initPending = false;
      this.initInstalls++;
      await this.clock.sleep(500).catch(() => undefined);
    } catch {
      /* the WebView may not be up yet: the next probe read tries again */
    }
  }

  private async install(): Promise<void> {
    try {
      await this.d.evaluate?.(PROBE_INSTALL, { app: this.app, timeoutMs: 5000 });
    } catch {
      /* the page may still be loading; the next read retries */
    }
  }

  /** One probe read (installs the probe again if the page reloaded). */
  async probe(): Promise<Probe | undefined> {
    if (!this.canProbe || !this.d.evaluate) return undefined;
    if (this.initPending) await this.installInit();
    this.counters.probes++;
    try {
      let raw = await this.d.evaluate<unknown>(probeReadExpression(this.cfg), { app: this.app, timeoutMs: 3000 });
      if (raw === null) {
        await this.install();
        raw = await this.d.evaluate<unknown>(probeReadExpression(this.cfg), { app: this.app, timeoutMs: 3000 });
      }
      this.lastProbe = parseProbe(raw);
      return this.lastProbe;
    } catch {
      this.lastProbe = undefined;
      return undefined;
    }
  }

  async focusables(): Promise<FocusInfo[]> {
    if (this.nativeFocus && this.native) {
      const F = await this.native.focusables(this.nativeKey);
      this.syncNativeCounters();
      return F;
    }
    if (!this.canProbe || !this.d.evaluate) return [];
    try {
      return parseFocusables(await this.d.evaluate<unknown>(focusablesExpression(this.cfg), { app: this.app, timeoutMs: 3000 }));
    } catch {
      return [];
    }
  }

  private async frame(): Promise<{ fp?: ReturnType<typeof fingerprint> }> {
    try {
      this.counters.frames++;
      const f = await this.d.screenshot({ format: 'rgba', width: 64 });
      if (!f.rgba) return {};
      return { fp: fingerprint({ width: f.width, height: f.height, data: f.rgba }) };
    } catch {
      return {};
    }
  }

  /** A 480 px JPEG (or PNG) for a new state or a finding's evidence. */
  async thumb(): Promise<{ data: Buffer; mime: 'image/jpeg' | 'image/png' } | undefined> {
    try {
      this.counters.thumbs++;
      const f = await this.d.screenshot({ format: 'jpeg', width: 480, quality: 70 });
      return f.data ? { data: f.data, mime: f.mime ?? 'image/jpeg' } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Settle, then read everything one step needs. */
  async observe(step: number, extra: { action?: Action; relaunched?: boolean; pid?: number } = {}): Promise<Observation> {
    let settleMs: number;
    if (this.canProbe) {
      settleMs = await settle(async () => probeDigest(await this.probe()), this.clock, this.settleOpts);
    } else {
      // No probe: settle on the picture instead (slower, but the only signal there is).
      settleMs = await settle(async () => (await this.frame()).fp?.hash ?? '', this.clock, { pollMs: 300, ...this.settleOpts });
    }
    const probe = this.canProbe ? this.lastProbe : undefined;
    // Separate adb calls: run them at once (on a Fire TV the frame alone takes 1-2 s).
    const [fg, { fp }, logs] = await Promise.all([this.d.foreground().catch(() => null), this.frame(), this.readLogs()]);
    const consoleEntries = this.consoleBuf;
    this.consoleBuf = [];
    const obs: Observation = { ts: this.clock.now(), step, foreground: fg?.package ?? null, logs, console: consoleEntries, settleMs };
    if (fg?.activity) obs.activity = fg.activity;
    if (probe) obs.probe = probe;
    if (fp) {
      obs.frame = { hash: fp.hash, luma: fp.luma, thumb64: fp.thumb64 };
      obs.thumbSize = fp.size;
    }
    if (extra.action) obs.action = extra.action;
    if (extra.relaunched) obs.relaunched = true;
    if (extra.pid !== undefined) obs.pid = extra.pid;
    if (!probe && this.nativeFocus && this.native && fg?.package === this.app.package) {
      // A dump only for a picture not seen before (1-3 s each); a known picture reuses its snapshot.
      this.nativeKey = NativeFocus.key(fg.activity, fp?.thumb64);
      const snap = await this.native.read(this.nativeKey);
      this.syncNativeCounters();
      if (snap) {
        obs.focus = snap.focus;
        if (snap.viewport) obs.viewport = snap.viewport;
      }
    } else this.nativeKey = undefined;
    return obs;
  }

  private syncNativeCounters(): void {
    if (!this.native) return;
    this.counters.dumps = this.native.counters.dumps;
    this.counters.dumpHits = this.native.counters.hits;
  }

  /** Native focus gave up (dumps kept failing): a note for the report. */
  get nativeOff(): boolean {
    return !!this.native?.off;
  }

  /** Why native focus is off, when it switched itself off. */
  get nativeOffReason(): string | undefined {
    return this.native?.offReason;
  }

  private async readLogs(): Promise<LogLine[]> {
    try {
      const lines = await this.d.logs({ app: this.app, sinceTs: this.lastLogTs });
      const fresh = lines.filter((l) => l.ts > this.lastLogTs);
      for (const l of fresh) if (l.ts > this.lastLogTs) this.lastLogTs = l.ts;
      return fresh;
    } catch {
      return [];
    }
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
