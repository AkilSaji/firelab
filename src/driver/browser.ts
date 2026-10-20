/**
 * BrowserDriver: a web game in headless Chrome, driven like a Fire TV.
 *
 * The page runs at the Fire TV WebView's CSS viewport (960x540 at 2x), and the
 * remote's keys arrive the way FireLab's wrapper delivers them on a TV
 * (android-template MainActivity.sendKey): a synthetic KeyboardEvent on the
 * focused element, Back as Escape, and a Back the page doesn't handle goes
 * back in history or leaves the app. So the engine can explore any web game
 * without a TV, many times faster (no adb, no WebView over Wi-Fi), and the
 * benchmark can repeat runs often enough for statistics.
 *
 * What it is not: the Amazon WebView, a Fire TV GPU or a Fire TV's speed. Use
 * `--emulate-gpu` for the GPU's WebGL features and limits, and a real device
 * or the emulator lab for everything else.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { CdpClient } from '../cdp/client.js';
import { FireLabError } from '../lib/errors.js';
import type { AppRef, ConsoleEntry, DeviceDriver, DriverCaps, DriverInfo, Frame, KeySpec, LogLine, MemorySample, RemoteKey } from './types.js';

export type BrowserDriverOptions = {
  /** Chrome or Chromium binary (default: $CHROME_PATH, then the usual install places). */
  chrome?: string;
  /** Show the window (default headless). */
  headed?: boolean;
  /** CSS viewport (default 960x540, the Fire TV WebView at 1080p) and device pixel ratio (default 2). */
  width?: number;
  height?: number;
  dpr?: number;
  /** Serial shown in reports (default "browser"). */
  serial?: string;
};

/** Remote key -> [key, code, keyCode] as the wrapper sends it (MainActivity.keyFor). */
export const BROWSER_KEYS: Readonly<Partial<Record<RemoteKey, [string, string, number]>>> = {
  up: ['ArrowUp', 'ArrowUp', 38],
  down: ['ArrowDown', 'ArrowDown', 40],
  left: ['ArrowLeft', 'ArrowLeft', 37],
  right: ['ArrowRight', 'ArrowRight', 39],
  ok: ['Enter', 'Enter', 13],
  menu: ['ContextMenu', 'ContextMenu', 93],
  playpause: ['MediaPlayPause', 'MediaPlayPause', 179],
  rewind: ['MediaRewind', 'MediaRewind', 227],
  fastforward: ['MediaFastForward', 'MediaFastForward', 228],
  back: ['Escape', 'Escape', 27],
};

/** The wrapper's key script: dispatch on the focused element, return whether the page called preventDefault(). */
export function keyScript(type: 'keydown' | 'keyup', k: [string, string, number], repeat = false): string {
  const [key, code, keyCode] = k;
  return `(function(){var e=new KeyboardEvent('${type}',{key:'${key}',code:'${code}',repeat:${repeat},bubbles:true,cancelable:true});try{Object.defineProperty(e,'keyCode',{get:function(){return ${keyCode}}});Object.defineProperty(e,'which',{get:function(){return ${keyCode}}});}catch(x){}var t=document.activeElement||document.body||document.documentElement;return !t.dispatchEvent(e);})()`;
}

/** Every place a Chromium-based browser usually lives (Chrome, Chromium, Edge, Brave, and Playwright's own download). */
export function chromeCandidates(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const mac = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Brave Browser.app/Contents/MacOS/Brave Browser', 'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'];
  const win = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'Chromium\\Application\\chrome.exe'];
  const winRoots = [env.PROGRAMFILES ?? 'C:\\Program Files', env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', env.LOCALAPPDATA].filter((x): x is string => !!x);
  return [
    env.CHROME_PATH,
    env.PUPPETEER_EXECUTABLE_PATH,
    ...mac.map((a) => `/Applications/${a}`),
    ...mac.map((a) => path.join(home, 'Applications', a)),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
    ...winRoots.flatMap((r) => win.map((a) => `${r}\\${a}`)),
    ...playwrightChromes(env, home),
  ].filter((x): x is string => !!x);
}

/** Chromium downloaded by `npx playwright install chromium` (newest first). */
function playwrightChromes(env: NodeJS.ProcessEnv, home: string): string[] {
  const roots = [env.PLAYWRIGHT_BROWSERS_PATH, path.join(home, 'Library', 'Caches', 'ms-playwright'), path.join(home, '.cache', 'ms-playwright'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'ms-playwright')].filter((x): x is string => !!x);
  const inside = ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-win/chrome.exe', 'chrome-win64/chrome.exe'];
  const out: string[] = [];
  for (const r of roots) {
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(r).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    } catch {
      continue;
    }
    for (const d of dirs) out.push(...inside.map((i) => path.join(r, d, i)));
  }
  return out;
}

export function findChrome(explicit?: string): string | undefined {
  return [explicit, ...chromeCandidates()].filter((x): x is string => !!x).find((p) => fs.existsSync(p));
}

const LAUNCHER = 'browser.launcher';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BrowserDriver implements DeviceDriver {
  readonly kind = 'browser' as const;
  readonly serial: string;
  readonly caps: DriverCaps = { keys: true, holds: true, text: true, screenshot: true, rgbaThumb: true, launch: true, reset: true, install: false, eval: true, console: true, cdp: true, logs: true, memory: true, measure: false, recordKeys: false };
  private readonly o: Required<Omit<BrowserDriverOptions, 'chrome' | 'serial'>> & { chrome?: string };
  private proc?: ChildProcess;
  private profileDir?: string;
  private port = 0;
  private browserWs?: CdpClient;
  private page?: CdpClient;
  private targetId?: string;
  private app?: AppRef;
  private launches = 0;
  /** null = the app was left (Back at the root, a crash); undefined = nothing launched yet. */
  private fg: { package: string } | null | undefined;
  private readonly logBuf: LogLine[] = [];
  private readonly consoleFns = new Set<(e: ConsoleEntry) => void>();
  private chromeVersion?: string;

  constructor(o: BrowserDriverOptions = {}) {
    this.serial = o.serial ?? 'browser';
    this.o = { width: o.width ?? 960, height: o.height ?? 540, dpr: o.dpr ?? 2, headed: !!o.headed, ...(o.chrome ? { chrome: o.chrome } : {}) };
  }

  // ---------- Chrome ----------

  private async ensureBrowser(): Promise<void> {
    if (this.browserWs && !this.browserWs.closed) return;
    const bin = findChrome(this.o.chrome);
    if (!bin) throw new FireLabError('unsupported', 'No Chrome or Chromium found for the browser driver', { hint: 'Install Google Chrome (or Edge, Brave, Chromium), run `npx playwright install chromium`, or set CHROME_PATH to the browser binary. `firelab doctor` shows where it looked.' });
    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-browser-'));
    const args = [
      ...(this.o.headed ? [] : ['--headless=new']),
      '--remote-debugging-port=0',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      `--window-size=${this.o.width},${this.o.height}`,
      'about:blank',
    ];
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    const ws = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new FireLabError('timeout', 'Chrome did not start within 20 s')), 20_000);
      proc.stderr?.on('data', (d: Buffer) => {
        buf += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
        if (m) {
          clearTimeout(timer);
          resolve(m[1] as string);
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(new FireLabError('unsupported', `Chrome exited (${code}) before DevTools was up: ${buf.slice(-300)}`));
      });
    });
    this.port = Number(new URL(ws).port);
    this.browserWs = await CdpClient.connect(ws, 15_000);
    const v = await this.browserWs.send<{ product?: string }>('Browser.getVersion').catch(() => ({}) as { product?: string });
    this.chromeVersion = v.product;
  }

  private async openPage(url: string): Promise<void> {
    await this.ensureBrowser();
    await this.closePage();
    const { targetId } = await (this.browserWs as CdpClient).send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    this.targetId = targetId;
    const page = await CdpClient.connect(`ws://127.0.0.1:${this.port}/devtools/page/${targetId}`, 15_000);
    this.page = page;
    page.on('event', (method, p) => this.onEvent(method, p));
    // Chrome or the tab went away without closePage(): the app is gone, so the engine relaunches it (a new page,
    // and a new Chrome if needed) instead of failing on the next call.
    page.on('close', () => {
      if (this.page !== page) return;
      this.page = undefined;
      this.targetId = undefined;
      if (this.fg) this.fg = null;
      this.logBuf.push({ ts: Date.now(), level: 'warn', tag: 'browser', text: 'DevTools connection to the page closed (Chrome or the tab went away)' });
    });
    await page.send('Emulation.setDeviceMetricsOverride', { width: this.o.width, height: this.o.height, deviceScaleFactor: this.o.dpr, mobile: false });
    await Promise.all([page.send('Runtime.enable'), page.send('Page.enable'), page.send('Inspector.enable').catch(() => undefined), page.send('Log.enable').catch(() => undefined)]);
    // Fire OS WebViews report Android TV user agents; games that sniff for a TV should see one.
    const ua = `Mozilla/5.0 (Linux; Android 9; AFTSSS Build/PS7717; wv) AppleWebKit/537.36 (KHTML, like Gecko) ${this.chromeVersion?.replace('HeadlessChrome', 'Chrome') ?? 'Chrome/130.0.0.0'} Mobile Safari/537.36 FireLab-browser`;
    await page.send('Emulation.setUserAgentOverride', { userAgent: ua }).catch(() => undefined);
    const load = page.waitFor('Page.loadEventFired', 30_000).catch(() => undefined);
    await page.send('Page.navigate', { url });
    await load;
  }

  private async closePage(): Promise<void> {
    const page = this.page;
    this.page = undefined;
    if (page && !page.closed) page.close();
    if (this.targetId && this.browserWs && !this.browserWs.closed) await this.browserWs.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
    this.targetId = undefined;
  }

  private onEvent(method: string, p: Record<string, unknown>): void {
    const ts = Date.now();
    if (method === 'Runtime.consoleAPICalled') {
      const args = (p.args as { value?: unknown; description?: string }[] | undefined) ?? [];
      const text = args.map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ''))).join(' ');
      const t = String(p.type);
      const level: ConsoleEntry['level'] = t === 'error' || t === 'assert' ? 'error' : t === 'warning' ? 'warn' : t === 'info' ? 'info' : t === 'debug' ? 'debug' : 'log';
      this.emitConsole({ ts, level, text, source: 'console' });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails as { text?: string; url?: string; lineNumber?: number; exception?: { description?: string } } | undefined;
      const text = d?.exception?.description?.split('\n')[0] ?? d?.text ?? 'Uncaught exception';
      this.emitConsole({ ts, level: 'error', text, source: 'exception', ...(d?.url ? { url: d.url } : {}), ...(d?.lineNumber !== undefined ? { line: d.lineNumber + 1 } : {}) });
    } else if (method === 'Inspector.targetCrashed') {
      this.logBuf.push({ ts, level: 'error', tag: 'chromium', text: `Renderer process crashed (${this.app?.package ?? 'page'})` });
      this.fg = null;
    } else if (method === 'Log.entryAdded') {
      const e = p.entry as { level?: string; text?: string } | undefined;
      if (e?.text) this.logBuf.push({ ts, level: e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : 'info', tag: 'browser', text: e.text });
    }
  }

  private emitConsole(e: ConsoleEntry): void {
    for (const fn of this.consoleFns) fn(e);
  }

  private live(): CdpClient {
    if (!this.page || this.page.closed) throw new FireLabError('no-webview', 'No page is open: launch the app first');
    return this.page;
  }

  // ---------- DeviceDriver ----------

  async info(): Promise<DriverInfo> {
    await this.ensureBrowser();
    return { model: 'browser', name: `${this.chromeVersion ?? 'Chrome'} (headless, Fire TV viewport)`, os: process.platform, resolution: { width: this.o.width * this.o.dpr, height: this.o.height * this.o.dpr } };
  }

  async wake(): Promise<void> {}

  async press(keys: KeySpec[], opts: { gapMs?: number } = {}): Promise<void> {
    for (const [i, k] of keys.entries()) {
      if (i > 0 && opts.gapMs) await sleep(opts.gapMs);
      await this.pressOne(k);
    }
  }

  private async pressOne(k: KeySpec): Promise<void> {
    if (k.key === 'home') {
      this.fg = null;
      return;
    }
    const spec = BROWSER_KEYS[k.key];
    if (!spec || this.fg === null || !this.page) return;
    const page = this.live();
    const ev = async (expr: string) => (await page.send<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression: expr, returnByValue: true }, 10_000).catch(() => undefined))?.result?.value === true;
    const holdMs = k.mode === 'long' ? 800 : k.mode === 'hold' ? (k.holdMs ?? 800) : 0;
    const handled = await ev(keyScript('keydown', spec));
    if (holdMs > 0) {
      // Android's key repeat: one repeat key-down every 50 ms after 500 ms.
      const t0 = Date.now();
      await sleep(Math.min(500, holdMs));
      while (Date.now() - t0 < holdMs) {
        await ev(keyScript('keydown', spec, true));
        await sleep(50);
      }
    }
    await ev(keyScript('keyup', spec));
    if (k.key === 'back' && !handled) {
      // Like the wrapper: history back, else the app closes.
      const canGoBack = await ev('history.length > 1 && (history.back(), true)');
      if (!canGoBack) this.fg = null;
    }
  }

  async typeText(text: string): Promise<void> {
    await this.live().send('Input.insertText', { text });
  }

  async screenshot(opts: { width?: number; quality?: number; format?: 'jpeg' | 'png' | 'rgba' } = {}): Promise<Frame> {
    const t0 = Date.now();
    if (!this.page || this.page.closed) {
      // No page (the app was left or Chrome went away): an empty launcher-like frame, as a TV would show its home screen.
      const w = Math.max(16, opts.width ?? 64);
      const h = Math.round((w * this.o.height) / this.o.width);
      return { width: w, height: h, rgba: new Uint8Array(w * h * 4), captureMs: 0 };
    }
    const page = this.live();
    const w = Math.max(16, Math.min(opts.width ?? this.o.width * this.o.dpr, this.o.width * this.o.dpr));
    // The clip's scale multiplies CSS pixels, and the device pixel ratio applies on top.
    const scale = w / (this.o.width * this.o.dpr);
    const fmt = opts.format === 'png' ? 'png' : 'jpeg';
    const r = await page.send<{ data: string }>('Page.captureScreenshot', { format: fmt, ...(fmt === 'jpeg' ? { quality: opts.quality ?? 70 } : {}), clip: { x: 0, y: 0, width: this.o.width, height: this.o.height, scale }, captureBeyondViewport: false }, 15_000);
    const data = Buffer.from(r.data, 'base64');
    if (opts.format === 'rgba') {
      const img = jpeg.decode(data, { useTArray: true, formatAsRGBA: true });
      return { width: img.width, height: img.height, rgba: img.data, captureMs: Date.now() - t0 };
    }
    return { width: Math.round(this.o.width * scale * this.o.dpr), height: Math.round(this.o.height * scale * this.o.dpr), data, mime: fmt === 'png' ? 'image/png' : 'image/jpeg', captureMs: Date.now() - t0 };
  }

  async foreground(): Promise<{ package: string; activity?: string } | null> {
    if (this.fg === undefined) return { package: LAUNCHER };
    return this.fg ?? { package: LAUNCHER };
  }

  async launch(app: AppRef): Promise<{ pid?: number; launchMs?: number }> {
    if (!app.url) throw new FireLabError('bad-request', 'The browser driver needs the page URL (--url)');
    const t0 = Date.now();
    this.app = app;
    await this.openPage(app.url);
    this.launches++;
    this.fg = { package: app.package };
    return { pid: this.launches, launchMs: Date.now() - t0 };
  }

  async stop(_app: AppRef): Promise<void> {
    await this.closePage();
    this.fg = undefined;
  }

  async pid(_app: AppRef): Promise<number | undefined> {
    return this.fg ? this.launches : undefined;
  }

  async reset(app: AppRef, _opts: { confirm: true }): Promise<void> {
    await this.ensureBrowser();
    if (app.url) await (this.browserWs as CdpClient).send('Storage.clearDataForOrigin', { origin: new URL(app.url).origin, storageTypes: 'all' }).catch(() => undefined);
    await this.closePage();
    this.fg = undefined;
  }

  async evaluate<T = unknown>(expression: string, opts: { app?: AppRef; timeoutMs?: number } = {}): Promise<T> {
    const r = await this.live().send<{ result?: { value?: unknown; type?: string; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      opts.timeoutMs ?? 10_000,
    );
    if (r.exceptionDetails) throw new FireLabError('eval-failed', r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluation failed');
    return r.result?.value as T;
  }

  onConsole(_app: AppRef, fn: (e: ConsoleEntry) => void): () => void {
    this.consoleFns.add(fn);
    return () => this.consoleFns.delete(fn);
  }

  async cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.live().send(method, params, 60_000);
  }

  async logs(opts: { app?: AppRef; sinceTs?: number; minLevel?: LogLine['level'] } = {}): Promise<LogLine[]> {
    return this.logBuf.filter((l) => l.ts >= (opts.sinceTs ?? 0));
  }

  async memory(_app: AppRef): Promise<MemorySample> {
    const r = await this.live().send<{ usedSize?: number }>('Runtime.getHeapUsage', {}, 4000).catch(() => ({}) as { usedSize?: number });
    return { ts: Date.now(), ...(r.usedSize ? { jsHeapMB: Math.round((r.usedSize / 1048576) * 10) / 10 } : {}) };
  }

  async close(): Promise<void> {
    await this.closePage().catch(() => undefined);
    this.browserWs?.close();
    this.browserWs = undefined;
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
    }
    if (this.profileDir) fs.rmSync(this.profileDir, { recursive: true, force: true });
  }
}
