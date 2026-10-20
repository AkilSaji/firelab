import fs from 'node:fs';
import path from 'node:path';
import { Adb } from '../adb/client.js';
import { findAdb, ADB_INSTALL_HINT } from '../adb/locate.js';
import { normalizeSerial, parseHostPort, type AdbDevice } from '../adb/devices.js';
import { getDeviceInfo, type DeviceInfo } from '../adb/info.js';
import { scanNetwork, defaultScanRanges, type ScanHit } from '../adb/discovery.js';
import { Reconnector } from '../adb/reconnect.js';
import { parseKeys, typeText, type KeyInjector, type KeyPress } from '../adb/keys.js';
import { SmartRemote } from '../adb/hid.js';
import { captureScreen, screenJpeg, screenPng, type ScreenMethod } from '../adb/screenshot.js';
import { assertPackage, foregroundApp, launchApp, listApps, pidOf, resetApp, stopApp, type AppInfo, type LaunchResult } from '../adb/apps.js';
import { readApkFile, abiProblem, type ApkInfo } from '../adb/apk.js';
import { powerState, wakeDevice } from '../adb/power.js';
import { dumpLogcat, type LogLevel, type LogLine } from '../adb/logcat.js';
import { KeyRecorder } from '../adb/getevent.js';
import { tierForGpu } from '../adb/models.js';
import { WebViewSession, type ConsoleEntry } from '../cdp/webview.js';
import { listDevtoolsSockets } from '../cdp/sockets.js';
import { FpsSampler, PROBE_SOURCE } from '../cdp/fps.js';
import { NativeSampler } from '../perf/native.js';
import { SurfaceFlingerSampler } from '../perf/surfaceflinger.js';
import { parseGfxinfo } from '../perf/parse.js';
import { measure, type Measurement } from '../perf/measure.js';
import { runSweep, sweepMarkdown, tierUrl, criteriaFor, DEFAULT_TIERS, type SweepPage, type SweepResult } from '../perf/sweep.js';
import { WatchSession, listSessions, type WatchSummary } from '../perf/watch.js';
import { FireLabError } from '../lib/errors.js';
import { dataDir, ensureDir, firelabVersion } from '../lib/paths.js';
import { shortId, sleep } from '../lib/util.js';
import { log } from '../lib/log.js';
import { JobStore } from './jobs.js';
import { TestStore } from './tests.js';
import { VitalsSampler, type Vitals } from './vitals.js';
import { DeviceMonitor } from './monitor.js';
import { recordInstall } from './installs.js';
import type { Device, Job, SweepRequest } from './types.js';

export type FireLabOptions = {
  /** Use this adb client (tests pass one with a fake runner). */
  adb?: Adb;
  /** Path to adb; default: found automatically. */
  adbPath?: string;
  /** Where sessions and sweep results go (default ~/.firelab). */
  home?: string;
  /** Keep Wi-Fi devices connected (default true). */
  autoReconnect?: boolean;
  /** Custom key injector per device (default: SmartRemote: `input keyevent`, plus a virtual HID remote for holds). */
  keyInjector?: (adb: Adb, serial: string) => KeyInjector;
};

const toState = (s: AdbDevice['state']): Device['state'] =>
  s === 'device' ? 'device' : s === 'unauthorized' || s === 'authorizing' ? 'unauthorized' : s === 'connecting' ? 'connecting' : 'offline';

/**
 * FireLab's core: one object that the MCP server, the dashboard API and the
 * CLI all drive. Holds the adb client, device info cache, WebView sessions,
 * sweep jobs and watch sessions.
 */
export class FireLab {
  private adbClient?: Adb;
  private readonly opts: FireLabOptions;
  private info = new Map<string, { info: DeviceInfo; at: number }>();
  /** WebGL renderer strings learned from WebViews, per device (they beat the spec sheet). */
  private webglGpu = new Map<string, string>();
  private webviews = new Map<string, WebViewSession>();
  private opening = new Map<string, Promise<WebViewSession>>();
  private injectors = new Map<string, KeyInjector>();
  private watches = new Map<string, WatchSession>();
  private monitors = new Map<string, DeviceMonitor>();
  private reconnector?: Reconnector;
  readonly jobs = new JobStore();
  /** Dashboard test jobs (app launch, navigation, performance, explore, GPU check, replay). */
  readonly tests: TestStore;
  private vitalsSamplers = new Map<string, VitalsSampler>();
  readonly home: string;

  constructor(opts: FireLabOptions = {}) {
    this.opts = opts;
    this.home = opts.home ?? dataDir();
    this.tests = new TestStore(path.join(this.home, 'tests'));
    if (opts.adb) this.adbClient = opts.adb;
  }

  // ---------- adb ----------

  /** The adb client; throws an actionable error when adb isn't installed. */
  get adb(): Adb {
    if (!this.adbClient) {
      const p = this.opts.adbPath ?? findAdb();
      if (!p) throw new FireLabError('adb-missing', 'adb (Android platform-tools) was not found', { hint: ADB_INSTALL_HINT });
      this.adbClient = new Adb(p);
    }
    if (!this.reconnector && this.opts.autoReconnect !== false) {
      this.reconnector = new Reconnector(this.adbClient);
      this.reconnector.start();
    }
    return this.adbClient;
  }

  get reconnect(): Reconnector | undefined {
    void this.adb;
    return this.reconnector;
  }

  async health(): Promise<{ ok: boolean; adb: { path: string; version: string } | null; version: string; error?: string }> {
    try {
      const adb = this.adb;
      return { ok: true, adb: { path: adb.path, version: await adb.version() }, version: firelabVersion() };
    } catch (e) {
      return { ok: false, adb: null, version: firelabVersion(), error: e instanceof FireLabError ? e.friendly : (e as Error).message };
    }
  }

  // ---------- devices ----------

  private async cachedInfo(serial: string, maxAgeMs = 10 * 60_000): Promise<DeviceInfo> {
    const c = this.info.get(serial);
    if (c && Date.now() - c.at < maxAgeMs) return c.info;
    const info = await getDeviceInfo(this.adb, serial);
    this.applyWebglGpu(serial, info);
    this.info.set(serial, { info, at: Date.now() });
    return info;
  }

  private applyWebglGpu(serial: string, info: DeviceInfo): void {
    const renderer = this.webglGpu.get(serial);
    if (!renderer) return;
    info.gpu = renderer;
    info.gpuSource = 'webgl';
    info.tier = tierForGpu(renderer) ?? info.tier;
  }

  /** Records the real GPU once a WebView told us its WebGL renderer. */
  private noteGpu(serial: string, renderer?: string): void {
    if (!renderer || /SwiftShader|llvmpipe/i.test(renderer)) return;
    this.webglGpu.set(serial, renderer);
    const c = this.info.get(serial);
    if (c) this.applyWebglGpu(serial, c.info);
  }

  private toDevice(d: AdbDevice, info?: DeviceInfo): Device {
    const dev: Device = { id: d.serial, state: toState(d.state), transport: d.transport };
    if (d.ip) dev.ip = d.ip;
    const model = info?.model ?? d.model;
    if (model) dev.model = model;
    if (info) {
      dev.name = info.name;
      dev.os = info.os;
      if (info.abi) dev.abi = info.abi;
      if (info.ramMB) dev.ramMB = info.ramMB;
      if (info.gpu) dev.gpu = info.gpu;
      if (info.gpuSource) dev.gpuSource = info.gpuSource;
      if (info.tier) dev.tier = info.tier;
      if (info.resolution) dev.resolution = info.resolution;
      if (info.fireOs !== undefined) dev.fireOs = info.fireOs;
    }
    return dev;
  }

  /** Devices adb knows about (with model details for the ready ones), plus Wi-Fi devices being reconnected. */
  async listDevices(): Promise<Device[]> {
    const raw = await this.adb.devices();
    const out = await Promise.all(
      raw.map(async (d) => {
        if (d.state !== 'device') return this.toDevice(d);
        const info = await this.cachedInfo(d.serial).catch((e) => {
          log.debug(`info for ${d.serial} failed`, e);
          return undefined;
        });
        return this.toDevice(d, info);
      }),
    );
    for (const serial of this.reconnector?.watching ?? []) {
      if (!out.some((d) => d.id === serial)) {
        const hp = parseHostPort(serial);
        const known = this.info.get(serial)?.info;
        out.push({ ...this.toDevice({ serial, state: 'connecting', props: {}, transport: 'tcp', ...(hp ? { ip: hp.ip, port: hp.port } : {}) }, known), state: 'connecting' });
      }
    }
    return out;
  }

  /**
   * Turns an optional id/IP into a ready adb serial. With no id and exactly
   * one ready device, that one. Wi-Fi devices that aren't connected yet get
   * an `adb connect` first.
   */
  async resolveDevice(id?: string): Promise<string> {
    const devices = await this.adb.devices();
    if (!id) {
      const ready = devices.filter((d) => d.state === 'device');
      if (ready.length === 1) return (ready[0] as AdbDevice).serial;
      if (!ready.length) {
        const unauth = devices.find((d) => d.state === 'unauthorized');
        if (unauth) throw new FireLabError('unauthorized', `${unauth.serial} is waiting for you to allow debugging`, { hint: 'Accept the "Allow USB debugging?" prompt on the TV' });
        throw new FireLabError('no-device', 'No device is connected', { hint: 'Connect one with connect_device (IP address) or scan_network, or run `firelab doctor`' });
      }
      throw new FireLabError('ambiguous-device', `${ready.length} devices are connected (${ready.map((d) => d.serial).join(', ')})`, { hint: 'Say which one with the device parameter' });
    }
    const serial = normalizeSerial(id);
    const d = devices.find((x) => x.serial === serial);
    if (d?.state === 'device') return serial;
    if (d?.state === 'unauthorized') throw new FireLabError('unauthorized', `${serial} has not authorized this computer`, { hint: 'Accept the "Allow USB debugging?" prompt on the TV (tick "Always allow")' });
    if (parseHostPort(serial)) {
      await this.connect(serial);
      return serial;
    }
    throw new FireLabError('device-not-found', `Device ${serial} is not connected`, { hint: 'List devices with list_devices' });
  }

  async scan(subnet?: string, onProgress?: (done: number, total: number) => void): Promise<{ found: (ScanHit & { connected: boolean })[]; subnet: string }> {
    const ranges = subnet ? [subnet] : defaultScanRanges();
    const hits = await scanNetwork({ ranges, onProgress });
    let connected = new Set<string>();
    try {
      connected = new Set((await this.adb.devices()).filter((d) => d.state === 'device').map((d) => d.serial));
    } catch {
      /* adb missing: still report the scan */
    }
    return { found: hits.map((h) => ({ ...h, connected: connected.has(`${h.ip}:${h.port}`) })), subnet: ranges.join(', ') };
  }

  async connect(id: string): Promise<Device> {
    const serial = normalizeSerial(id);
    if (!parseHostPort(serial)) throw new FireLabError('bad-request', `"${id}" is not an IP address`, { hint: 'Use the TV\'s IP from Settings > My Fire TV > About > Network, e.g. 192.168.1.50' });
    const r = await this.adb.connect(serial);
    if (!r.ok) {
      throw new FireLabError('device-not-found', `Couldn't connect to ${serial}: ${r.message}`, {
        hint: 'Check the IP, that the TV is on, and that Settings > My Fire TV > Developer options > ADB debugging is ON',
      });
    }
    this.reconnector?.watch(serial);
    // adb lists a fresh Wi-Fi device as "offline"/"unauthorized" for a moment.
    let dev: AdbDevice | undefined;
    for (let i = 0; i < 12; i++) {
      dev = (await this.adb.devices()).find((d) => d.serial === serial);
      if (dev && dev.state !== 'offline' && dev.state !== 'connecting') break;
      await sleep(250);
    }
    if (!dev) throw new FireLabError('device-not-found', `${serial} connected but doesn't show up in adb devices`);
    if (dev.state === 'unauthorized') return this.toDevice(dev);
    const info = dev.state === 'device' ? await this.cachedInfo(serial, 0).catch(() => undefined) : undefined;
    return this.toDevice(dev, info);
  }

  async disconnect(id: string): Promise<{ ok: true }> {
    const serial = normalizeSerial(id);
    this.reconnector?.unwatch(serial);
    await this.closeDevice(serial);
    await this.adb.disconnect(serial);
    return { ok: true };
  }

  async deviceInfo(id?: string): Promise<DeviceInfo & { power?: { awake: boolean; dreaming: boolean; wakefulness?: string }; foreground?: string }> {
    const serial = await this.resolveDevice(id);
    const [info, power, fg] = await Promise.all([
      this.cachedInfo(serial, 60_000),
      powerState(this.adb, serial).catch(() => undefined),
      foregroundApp(this.adb, serial).catch(() => null),
    ]);
    const out: DeviceInfo & { power?: { awake: boolean; dreaming: boolean; wakefulness?: string }; foreground?: string } = { ...info };
    if (power) out.power = { awake: power.awake, dreaming: power.dreaming, wakefulness: power.wakefulness };
    if (fg) out.foreground = fg.package;
    return out;
  }

  // ---------- remote ----------

  private injector(serial: string): KeyInjector {
    let inj = this.injectors.get(serial);
    if (!inj) {
      inj = this.opts.keyInjector ? this.opts.keyInjector(this.adb, serial) : new SmartRemote(this.adb, serial);
      this.injectors.set(serial, inj);
    }
    return inj;
  }

  /** The key injector FireLab uses for a device (the DeviceDriver asks it whether holds work). */
  async remote(id?: string): Promise<KeyInjector> {
    return this.injector(await this.resolveDevice(id));
  }

  async pressKeys(id: string | undefined, keys: string[], opts: { holdMs?: number; gapMs?: number } = {}): Promise<{ ok: true; device: string; pressed: KeyPress[] }> {
    const serial = await this.resolveDevice(id);
    const presses = parseKeys(keys, { holdMs: opts.holdMs });
    if (!presses.length) throw new FireLabError('bad-request', 'No keys given', { hint: 'e.g. ["down", "down", "ok"]' });
    if (presses.length > 100) throw new FireLabError('bad-request', 'At most 100 key presses per call');
    await this.injector(serial).press(presses, { gapMs: opts.gapMs });
    return { ok: true, device: serial, pressed: presses };
  }

  async typeText(id: string | undefined, text: string): Promise<{ ok: true }> {
    const serial = await this.resolveDevice(id);
    await typeText(this.adb, serial, text);
    return { ok: true };
  }

  async wake(id?: string): Promise<{ ok: boolean; woke: boolean; wakefulness?: string; dreaming: boolean }> {
    const serial = await this.resolveDevice(id);
    const st = await wakeDevice(this.adb, serial);
    return { ok: st.awake, woke: st.woke, wakefulness: st.wakefulness, dreaming: st.dreaming };
  }

  async screenshot(
    id: string | undefined,
    opts: { width?: number; quality?: number; format?: 'jpeg' | 'png'; method?: ScreenMethod } = {},
  ): Promise<{ data: Buffer; mime: 'image/jpeg' | 'image/png'; width: number; height: number; device: string; captureMs: number; method: string }> {
    const serial = await this.resolveDevice(id);
    const screen = await captureScreen(this.adb, serial, opts.method ?? 'auto');
    if (opts.format === 'png') return { data: screenPng(screen), mime: 'image/png', width: screen.width, height: screen.height, device: serial, captureMs: screen.ms, method: screen.method };
    const data = screenJpeg(screen, { width: opts.width, quality: opts.quality });
    const w = Math.min(opts.width ?? 960, screen.width);
    return { data, mime: 'image/jpeg', width: w, height: Math.round((screen.height * w) / screen.width), device: serial, captureMs: screen.ms, method: screen.method };
  }

  // ---------- apps ----------

  async apps(id?: string): Promise<{ device: string; apps: AppInfo[] }> {
    const serial = await this.resolveDevice(id);
    return { device: serial, apps: await listApps(this.adb, serial) };
  }

  async launch(id: string | undefined, pkg: string, opts: { url?: string; activity?: string } = {}): Promise<LaunchResult & { device: string }> {
    const serial = await this.resolveDevice(id);
    await wakeDevice(this.adb, serial).catch(() => undefined);
    const r = await launchApp(this.adb, serial, pkg, opts);
    return { ...r, device: serial };
  }

  async stop(id: string | undefined, pkg: string): Promise<{ ok: true; device: string }> {
    const serial = await this.resolveDevice(id);
    await stopApp(this.adb, serial, pkg);
    this.dropWebview(serial, pkg);
    return { ok: true, device: serial };
  }

  async reset(id: string | undefined, pkg: string, confirm: boolean): Promise<{ ok: true; device: string }> {
    const serial = await this.resolveDevice(id);
    await resetApp(this.adb, serial, pkg, confirm);
    this.dropWebview(serial, pkg);
    return { ok: true, device: serial };
  }

  async install(id: string | undefined, apkPath: string): Promise<{ ok: true; device: string; package: string; versionName?: string; leanback: boolean; warnings: string[] }> {
    const serial = await this.resolveDevice(id);
    const file = path.resolve(apkPath);
    if (!fs.existsSync(file)) throw new FireLabError('bad-request', `No file at ${file}`);
    let apk: ApkInfo | undefined;
    const warnings: string[] = [];
    try {
      apk = readApkFile(file);
    } catch (e) {
      warnings.push(`Couldn't read the APK manifest (${(e as Error).message}); installing anyway`);
    }
    if (apk) {
      const info = await this.cachedInfo(serial).catch(() => undefined);
      const problem = info ? abiProblem(apk, info.abis) : null;
      if (problem) throw new FireLabError('unsupported', problem);
      if (info?.sdk && apk.minSdk && apk.minSdk > info.sdk) throw new FireLabError('unsupported', `The APK needs Android API ${apk.minSdk}, the device has ${info.sdk} (${info.os})`);
      if (!apk.leanback) warnings.push('No LEANBACK_LAUNCHER activity: the app may not appear on the Fire TV home screen (it can still be launched with launch_app)');
    }
    const before = apk ? undefined : new Set((await listApps(this.adb, serial)).map((a) => a.package));
    // A streamed install now and then stalls for good (seen on x86 Android TV
    // emulators in CI): give it two minutes, then push the file and install it
    // the old way, which doesn't stream.
    try {
      await this.adb.install(serial, file, { timeoutMs: 120_000 });
    } catch (e) {
      if (!(e instanceof FireLabError && e.code === 'timeout')) throw e;
      warnings.push('The streamed install stalled after 120 s; installed again with --no-streaming');
      await this.adb.install(serial, file, { noStreaming: true, timeoutMs: 180_000 });
    }
    let pkg = apk?.package;
    if (!pkg && before) pkg = (await listApps(this.adb, serial)).map((a) => a.package).find((p) => !before.has(p));
    if (pkg) recordInstall(this.home, serial, pkg, file);
    return { ok: true, device: serial, package: pkg ?? 'unknown', ...(apk?.versionName ? { versionName: apk.versionName } : {}), leanback: apk?.leanback ?? false, warnings };
  }

  async foreground(id?: string): Promise<{ package: string; activity?: string } | null> {
    const serial = await this.resolveDevice(id);
    return foregroundApp(this.adb, serial);
  }

  // ---------- WebView ----------

  private dropWebview(serial: string, pkg?: string): void {
    for (const [k, s] of this.webviews) {
      if (k.startsWith(`${serial}|`) && (!pkg || s.package === pkg || k === `${serial}|${pkg}`)) {
        s.close();
        this.webviews.delete(k);
      }
    }
  }

  /**
   * Closes the DevTools sessions FireLab holds for a device (or one app on it)
   * and removes their adb forwards. They reopen on the next use.
   */
  releaseWebviews(id: string, pkg?: string): void {
    this.dropWebview(normalizeSerial(id), pkg);
  }

  /** A DevTools session to the WebView of `pkg` (default: the foreground app, else any debuggable WebView). */
  async webview(id: string | undefined, pkg?: string): Promise<WebViewSession> {
    const serial = await this.resolveDevice(id);
    let target = pkg;
    if (!target) {
      const sockets = await listDevtoolsSockets(this.adb, serial);
      const fg = await foregroundApp(this.adb, serial).catch(() => null);
      target = (fg && sockets.find((s) => s.package === fg.package)?.package) ?? sockets.find((s) => s.kind === 'webview')?.package ?? sockets[0]?.package;
      if (!target) {
        throw new FireLabError('no-webview', 'No debuggable WebView is running on the device', {
          hint: 'Launch a WebView app built with WebView.setWebContentsDebuggingEnabled(true) (see docs/TROUBLESHOOTING.md)',
        });
      }
    } else assertPackage(target);
    const key = `${serial}|${target}`;
    const cached = this.webviews.get(key);
    if (cached && !cached.closed) return cached;
    const pending = this.opening.get(key);
    if (pending) return pending;
    const p = WebViewSession.open(this.adb, serial, { package: target })
      .then(async (s) => {
        this.webviews.set(key, s);
        s.on('close', () => {
          if (this.webviews.get(key) === s) this.webviews.delete(key);
        });
        const gl = await s.webglInfo().catch(() => null);
        if (gl?.renderer) this.noteGpu(serial, gl.renderer);
        return s;
      })
      .finally(() => this.opening.delete(key));
    this.opening.set(key, p);
    return p;
  }

  async evaluate(id: string | undefined, expression: string, opts: { package?: string; timeoutMs?: number } = {}): Promise<{ value: unknown; package?: string; url: string }> {
    if (!expression?.trim()) throw new FireLabError('bad-request', 'Empty expression');
    const s = await this.webview(id, opts.package);
    const value = await s.eval(expression, { timeoutMs: opts.timeoutMs ?? 10000 });
    return { value, package: s.package, url: s.target.url };
  }

  async consoleLogs(
    id: string | undefined,
    opts: { package?: string; since?: number; minLevel?: ConsoleEntry['level']; limit?: number; waitMs?: number } = {},
  ): Promise<{ package?: string; url: string; entries: ConsoleEntry[]; note?: string }> {
    const s = await this.webview(id, opts.package);
    if (opts.waitMs) await sleep(Math.min(opts.waitMs, 30000));
    const entries = s.consoleLogs({ since: opts.since, minLevel: opts.minLevel, limit: opts.limit });
    const res: { package?: string; url: string; entries: ConsoleEntry[]; note?: string } = { package: s.package, url: s.target.url, entries };
    if (!entries.length) res.note = 'FireLab records console output from the moment it connects to the WebView; pass waitMs to collect for a while, or reload the page with webview_eval("location.reload()")';
    return res;
  }

  // ---------- performance ----------

  async measure(id: string | undefined, opts: { package?: string; seconds?: number; fpsExpr?: string } = {}): Promise<Measurement & { device: string; package?: string }> {
    const serial = await this.resolveDevice(id);
    const seconds = Math.min(Math.max(opts.seconds ?? 10, 2), 120);
    let pkg = opts.package;
    if (!pkg) pkg = (await foregroundApp(this.adb, serial).catch(() => null))?.package;
    const s = await this.webview(serial, pkg).catch(() => undefined);
    const fps = s ? new FpsSampler(s, { fpsExpr: opts.fpsExpr }) : undefined;
    if (fps) await fps.install().catch(() => undefined);
    // No WebView (Unity, native GL, Android views): frame timing from SurfaceFlinger.
    const sf = !fps && pkg ? new SurfaceFlingerSampler(this.adb, serial, pkg) : undefined;
    const nat = pkg ? new NativeSampler(this.adb, serial, pkg) : undefined;
    // Android-view apps: HWUI frame stats (janky frames, frame-time percentiles) for the same window.
    if (sf) await this.adb.shell(serial, `dumpsys gfxinfo ${pkg} reset`, { timeoutMs: 8000 }).catch(() => undefined);
    const m = await measure(
      {
        ...(fps ? { readFps: () => fps.read(), resetFps: () => fps.reset() } : {}),
        ...(sf ? { readFps: () => sf.read(), resetFps: async () => void (await sf.read()) } : {}),
        ...(nat ? { native: (memory: boolean) => nat.sample({ memory }) } : {}),
        pageHook: () => fps?.lastHook ?? undefined,
        sleep: (ms) => sleep(ms),
      },
      seconds,
    );
    if (sf) {
      const g = parseGfxinfo(await this.adb.shell(serial, `dumpsys gfxinfo ${pkg}`, { timeoutMs: 8000 }).catch(() => ''));
      if (g.totalFrames) m.jank = g;
    }
    return { ...m, device: serial, ...(pkg ? { package: pkg } : {}) };
  }

  private sweepPage(serial: string, pkg: string | undefined, fpsExpr?: string): () => Promise<SweepPage> {
    return async () => {
      const s = await this.webview(serial, pkg);
      const fps = new FpsSampler(s, { fpsExpr });
      const init = await s.addInitScript(PROBE_SOURCE).catch(() => undefined);
      return {
        get closed() {
          return s.closed;
        },
        navigate: (url) => s.navigate(url, 45000),
        eval: (expr, timeoutMs) => s.eval(expr, { timeoutMs: timeoutMs ?? 15000 }),
        installProbe: () => fps.install().catch(() => undefined),
        resetFps: () => fps.reset(),
        readFps: () => fps.read(),
        currentUrl: () => s.url(),
        close: () => {
          if (init) void s.removeInitScript(init);
        },
      };
    };
  }

  /** Starts a sweep in the background; poll the job or listen on `jobs`. */
  async startSweep(id: string | undefined, req: SweepRequest & { fpsExpr?: string; restore?: boolean }): Promise<Job> {
    const serial = await this.resolveDevice(id);
    if (!req?.url) throw new FireLabError('bad-request', 'A sweep needs the app URL', { hint: 'e.g. { "url": "http://192.168.1.20:4173/" }; FireLab adds ?q=<tier>' });
    const running = this.jobs.runningFor(serial);
    if (running) throw new FireLabError('busy', `A sweep is already running on ${serial} (${running.id})`);
    if (req.package) assertPackage(req.package);
    const abort = new AbortController();
    tierUrl(req.url, req.param ?? 'q', 'x'); // reject bad URLs before starting
    const crit = criteriaFor({ targetFps: req.targetFps, minP10: req.minP10 });
    const job = this.jobs.create(serial, abort, {
      request: {
        url: req.url,
        tiers: req.tiers?.length ? req.tiers : DEFAULT_TIERS,
        param: req.param ?? 'q',
        targetFps: crit.targetFps,
        warmupS: req.warmupS ?? 8,
        sampleS: req.sampleS ?? 15,
        ...(req.package ? { package: req.package } : {}),
      },
      criteria: crit,
    });
    void this.runSweepJob(job.id, serial, req, abort.signal);
    return this.jobs.get(job.id) as Job;
  }

  /** Runs a sweep and waits for the result (CLI and MCP use this). */
  async sweep(id: string | undefined, req: SweepRequest & { fpsExpr?: string; restore?: boolean }, onProgress?: (j: Job, message: string) => void): Promise<{ job: Job; result?: SweepResult; markdown?: string }> {
    const job = await this.startSweep(id, req);
    const onP = (j: Job, p: { message: string }) => j.id === job.id && onProgress?.(j, p.message);
    this.jobs.on('progress', onP);
    try {
      const done = await new Promise<Job>((resolve) => {
        const check = (j: Job) => {
          if (j.id !== job.id) return;
          this.jobs.off('done', check);
          resolve(j);
        };
        this.jobs.on('done', check);
        const now = this.jobs.get(job.id);
        if (now && now.status !== 'running') {
          this.jobs.off('done', check);
          resolve(now);
        }
      });
      if (done.status === 'error') throw new FireLabError('adb-failed', `Sweep failed: ${done.error}`);
      return { job: done, result: this.jobs.result(job.id), markdown: done.markdown };
    } finally {
      this.jobs.off('progress', onP);
    }
  }

  private async runSweepJob(jobId: string, serial: string, req: SweepRequest & { fpsExpr?: string; restore?: boolean }, signal: AbortSignal): Promise<void> {
    try {
      const info = await this.cachedInfo(serial).catch(() => undefined);
      let pkg = req.package;
      if (pkg) {
        const pid = await pidOf(this.adb, serial, pkg);
        if (!pid) {
          this.jobs.progress(jobId, { progress: 0, phase: 'start', message: `Launching ${pkg}` });
          await this.launch(serial, pkg);
          await sleep(3000);
        }
      } else {
        pkg = (await this.webview(serial)).package;
      }
      const nat = pkg ? new NativeSampler(this.adb, serial, pkg) : undefined;
      const result = await runSweep(
        {
          openPage: this.sweepPage(serial, pkg, req.fpsExpr),
          pressKeys: async (keys) => {
            await this.pressKeys(serial, keys);
          },
          ...(nat ? { nativeSample: (memory: boolean) => nat.sample({ memory }) } : {}),
          sleep: (ms, sig) => sleep(ms, sig),
          now: () => Date.now(),
        },
        {
          url: req.url,
          tiers: req.tiers,
          param: req.param,
          warmupS: req.warmupS,
          sampleS: req.sampleS,
          action: req.action,
          targetFps: req.targetFps,
          minP10: req.minP10,
          restore: req.restore,
          device: { id: serial, name: info?.name, model: info?.model, gpu: this.info.get(serial)?.info.gpu ?? info?.gpu },
          package: pkg,
        },
        (p) => this.jobs.progress(jobId, p),
        signal,
      );
      const markdown = sweepMarkdown(result);
      const dir = ensureDir(path.join(this.home, 'sweeps'));
      const resultPath = path.join(dir, `${jobId}.json`);
      fs.writeFileSync(resultPath, JSON.stringify({ ...result, markdown }, null, 2));
      fs.writeFileSync(path.join(dir, `${jobId}.md`), `${markdown}\n`);
      this.jobs.finish(jobId, result, { markdown, resultPath });
    } catch (e) {
      log.warn('sweep failed', e);
      this.jobs.fail(jobId, e instanceof FireLabError ? e.friendly : (e as Error).message);
    }
  }

  // ---------- watch sessions ----------

  get sessionsDir(): string {
    return path.join(this.home, 'sessions');
  }

  async watchStart(id: string | undefined, opts: { package?: string; intervalMs?: number; thumbEveryMs?: number } = {}): Promise<{ sessionId: string; device: string; package?: string; dir: string }> {
    const serial = await this.resolveDevice(id);
    if (this.watches.has(serial)) throw new FireLabError('busy', `Already watching ${serial} (session ${this.watches.get(serial)?.id})`, { hint: 'Stop it with watch_stop first' });
    let pkg = opts.package;
    if (pkg) assertPackage(pkg);
    else pkg = (await foregroundApp(this.adb, serial).catch(() => null))?.package;
    const sessionId = shortId('w_');
    const dir = path.join(this.sessionsDir, sessionId);
    const keys = new KeyRecorder(this.adb, serial);
    const nat = pkg ? new NativeSampler(this.adb, serial, pkg) : undefined;
    let fps: FpsSampler | undefined;
    let sf: SurfaceFlingerSampler | undefined;
    let session: WebViewSession | undefined;
    const ensureFps = async (): Promise<FpsSampler | undefined> => {
      if (fps && session && !session.closed) return fps;
      session = await this.webview(serial, pkg).catch(() => undefined);
      if (!session) return undefined;
      fps = new FpsSampler(session);
      await fps.install().catch(() => undefined);
      session.on('console', (e) => {
        if (e.level === 'warn' || e.level === 'error') w.onLog({ ts: e.ts, level: e.level, text: e.text, source: e.source === 'exception' ? 'exception' : 'console' });
      });
      return fps;
    };
    const w: WatchSession = new WatchSession(
      {
        keys,
        ...(nat ? { native: (memory: boolean) => nat.sample({ memory }) } : {}),
        fps: async () => {
          const f = await ensureFps();
          if (f) return f.read();
          if (!sf && pkg) sf = new SurfaceFlingerSampler(this.adb, serial, pkg);
          return sf ? sf.read() : [];
        },
        thumbnail: async () => (await this.screenshot(serial, { width: 480, quality: 60 })).data,
        state: async () => {
          const [fg, pw] = await Promise.all([foregroundApp(this.adb, serial).catch(() => null), powerState(this.adb, serial).catch(() => undefined)]);
          return { connected: true, ...(fg ? { foreground: fg.package } : {}), ...(pw ? { screenOn: pw.displayOn !== false && !pw.dreaming } : {}) };
        },
      },
      { sessionId, device: serial, package: pkg, dir, intervalMs: opts.intervalMs, thumbEveryMs: opts.thumbEveryMs },
    );
    w.start();
    this.watches.set(serial, w);
    return { sessionId, device: serial, ...(pkg ? { package: pkg } : {}), dir };
  }

  watchFor(serial: string): WatchSession | undefined {
    return this.watches.get(serial);
  }

  async watchStop(id?: string): Promise<WatchSummary> {
    let serial: string | undefined;
    if (id) serial = normalizeSerial(id);
    else if (this.watches.size === 1) serial = [...this.watches.keys()][0];
    const w = serial ? this.watches.get(serial) : undefined;
    if (!w || !serial) throw new FireLabError('not-found', id ? `No watch session is running on ${serial}` : 'No watch session is running', { hint: 'Start one with watch_start' });
    this.watches.delete(serial);
    return w.stop();
  }

  sessions(): WatchSummary[] {
    const done = listSessions(this.sessionsDir);
    const live = [...this.watches.values()].map((w) => w.summary());
    return [...live, ...done.filter((d) => !live.some((l) => l.sessionId === d.sessionId))];
  }

  // ---------- logs ----------

  async logcat(id: string | undefined, opts: { package?: string; lines?: number; minLevel?: LogLevel; tag?: string } = {}): Promise<{ device: string; package?: string; pid?: number; lines: LogLine[]; note?: string }> {
    const serial = await this.resolveDevice(id);
    let pid: number | undefined;
    if (opts.package) {
      pid = (await pidOf(this.adb, serial, opts.package)) ?? undefined;
      if (!pid) {
        return { device: serial, package: opts.package, lines: [], note: `${opts.package} is not running, so there is no process to filter by. Launch it, or omit package for the whole log.` };
      }
    }
    const lines = await dumpLogcat(this.adb, serial, { pid, lines: opts.lines, minLevel: opts.minLevel, tag: opts.tag });
    return { device: serial, ...(opts.package ? { package: opts.package } : {}), ...(pid ? { pid } : {}), lines };
  }

  // ---------- vitals ----------

  /** Network throughput and temperature of a device (sampled at most every 2 s; null fields say why). */
  async vitals(id: string): Promise<Vitals & { device: string }> {
    const serial = await this.resolveDevice(id);
    return { ...(await this.vitalsSampler(serial).sample()), device: serial };
  }

  /** The shared vitals sampler of a device (the /vitals route and the live monitor use the same one). */
  vitalsSampler(serial: string): VitalsSampler {
    let s = this.vitalsSamplers.get(serial);
    if (!s) {
      s = new VitalsSampler((cmd) => this.adb.shell(serial, cmd, { timeoutMs: 8000 }));
      this.vitalsSamplers.set(serial, s);
    }
    return s;
  }

  // ---------- live monitor (dashboard SSE) ----------

  async monitor(id: string): Promise<DeviceMonitor> {
    const serial = normalizeSerial(id);
    let m = this.monitors.get(serial);
    if (!m) {
      // Kept after the last viewer leaves, so a reloaded dashboard gets the backlog.
      m = new DeviceMonitor(this, serial);
      this.monitors.set(serial, m);
    }
    return m;
  }

  // ---------- cleanup ----------

  private async closeDevice(serial: string): Promise<void> {
    this.dropWebview(serial);
    const inj = this.injectors.get(serial);
    this.injectors.delete(serial);
    await inj?.close?.();
    const w = this.watches.get(serial);
    if (w) {
      this.watches.delete(serial);
      await w.stop().catch(() => undefined);
    }
    this.monitors.get(serial)?.stop();
  }

  /** Stops everything FireLab started: watch sessions, monitors, WebView forwards, background sweeps. */
  async close(): Promise<void> {
    this.reconnector?.stop();
    this.tests.stopAll();
    for (const j of this.jobs.list()) if (j.status === 'running') this.jobs.cancel(j.id);
    for (const m of this.monitors.values()) m.stop();
    this.monitors.clear();
    for (const w of this.watches.values()) await w.stop().catch(() => undefined);
    this.watches.clear();
    for (const inj of this.injectors.values()) await inj.close?.();
    this.injectors.clear();
    for (const s of this.webviews.values()) s.close();
    this.webviews.clear();
  }
}
