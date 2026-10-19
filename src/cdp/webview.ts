import { EventEmitter } from 'node:events';
import type { Adb } from '../adb/client.js';
import { pidOf, assertPackage } from '../adb/apps.js';
import { FireLabError } from '../lib/errors.js';
import { CdpClient } from './client.js';
import { listDevtoolsSockets, type DevtoolsSocket } from './sockets.js';

export type CdpTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  description?: string;
};

export type ConsoleEntry = {
  ts: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  source: 'console' | 'exception' | 'browser';
  url?: string;
  line?: number;
};

export const WEBVIEW_DEBUG_HINT =
  'The app must allow WebView debugging: call WebView.setWebContentsDebuggingEnabled(true) (debug builds, or behind a developer setting), ' +
  'then restart the app. Chrome-based browsers expose DevTools without this';

/** Picks the page a person is looking at: a visible, attached page with a URL. */
export function pickPageTarget(targets: CdpTarget[], urlIncludes?: string): CdpTarget | undefined {
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const score = (t: CdpTarget): number => {
    let s = 0;
    try {
      const d = JSON.parse(t.description || '{}') as { visible?: boolean; attached?: boolean; empty?: boolean };
      if (d.visible) s += 4;
      if (d.attached) s += 2;
      if (d.empty) s -= 4;
    } catch {}
    if (t.url && t.url !== 'about:blank') s += 1;
    if (urlIncludes && t.url.includes(urlIncludes)) s += 10;
    return s;
  };
  return pages.sort((a, b) => score(b) - score(a))[0];
}

/** Formats a CDP RemoteObject for logs. */
export function remoteObjectText(o: { type?: string; value?: unknown; description?: string; unserializableValue?: string; subtype?: string }): string {
  if (o.unserializableValue) return o.unserializableValue;
  if (o.type === 'string') return String(o.value);
  if (o.value !== undefined) {
    try {
      return typeof o.value === 'object' ? JSON.stringify(o.value) : String(o.value);
    } catch {
      return String(o.value);
    }
  }
  return o.description ?? (o.type === 'undefined' ? 'undefined' : `[${o.subtype ?? o.type}]`);
}

const CONSOLE_LEVEL: Record<string, ConsoleEntry['level']> = {
  log: 'log', info: 'info', debug: 'debug', warning: 'warn', warn: 'warn', error: 'error', assert: 'error', trace: 'log', dir: 'log', table: 'log', verbose: 'debug',
};

/**
 * A DevTools connection to the page inside an app's WebView (or Chrome),
 * through `adb forward` to the app's devtools socket.
 */
export class WebViewSession extends EventEmitter<{ console: [ConsoleEntry]; close: [] }> {
  private logs: ConsoleEntry[] = [];
  private pageEnabled = false;

  private constructor(
    private readonly adb: Adb,
    readonly serial: string,
    readonly socket: DevtoolsSocket,
    readonly port: number,
    readonly target: CdpTarget,
    readonly cdp: CdpClient,
  ) {
    super();
    cdp.on('event', (method, params) => this.onEvent(method, params));
    cdp.on('close', () => {
      void this.adb.forwardRemove(this.serial, this.port).catch(() => {});
      this.emit('close');
    });
  }

  get package(): string | undefined {
    return this.socket.package;
  }
  get pid(): number | undefined {
    return this.socket.pid;
  }
  get closed(): boolean {
    return this.cdp.closed;
  }

  /**
   * Opens the WebView of `pkg` (or the only/first debuggable WebView when no
   * package is given). Throws a FireLabError with setup hints when there is none.
   */
  static async open(adb: Adb, serial: string, opts: { package?: string; urlIncludes?: string } = {}): Promise<WebViewSession> {
    const sockets = await listDevtoolsSockets(adb, serial);
    let socket: DevtoolsSocket | undefined;
    if (opts.package) {
      assertPackage(opts.package);
      const pid = await pidOf(adb, serial, opts.package);
      socket = sockets.find((s) => (pid && s.pid === pid) || s.package === opts.package);
      if (!socket) {
        if (!pid) throw new FireLabError('not-running', `${opts.package} is not running`, { hint: 'Launch it first (launch_app)' });
        throw new FireLabError('no-webview', `${opts.package} is running but has no debuggable WebView`, { hint: WEBVIEW_DEBUG_HINT });
      }
    } else {
      socket = sockets.find((s) => s.kind === 'webview') ?? sockets[0];
      if (!socket) throw new FireLabError('no-webview', 'No debuggable WebView or browser is running on the device', { hint: WEBVIEW_DEBUG_HINT });
    }
    const port = await adb.forward(serial, `localabstract:${socket.name}`);
    try {
      const targets = await fetchTargets(port);
      const target = pickPageTarget(targets, opts.urlIncludes);
      if (!target?.webSocketDebuggerUrl) throw new FireLabError('no-webview', `${socket.package ?? socket.name} has no page loaded yet`, { hint: 'Wait for the app to load its first page, then retry' });
      const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
      const s = new WebViewSession(adb, serial, socket, port, target, cdp);
      await cdp.send('Runtime.enable', {}, 8000).catch(() => {});
      await cdp.send('Log.enable', {}, 5000).catch(() => {});
      return s;
    } catch (e) {
      await adb.forwardRemove(serial, port).catch(() => {});
      throw e;
    }
  }

  private push(e: ConsoleEntry): void {
    this.logs.push(e);
    if (this.logs.length > 1000) this.logs.splice(0, this.logs.length - 1000);
    this.emit('console', e);
  }

  private onEvent(method: string, p: Record<string, unknown>): void {
    if (method === 'Runtime.consoleAPICalled') {
      const args = (p.args as Parameters<typeof remoteObjectText>[0][]) ?? [];
      const frame = (p.stackTrace as { callFrames?: { url?: string; lineNumber?: number }[] } | undefined)?.callFrames?.[0];
      this.push({
        ts: typeof p.timestamp === 'number' ? Math.round(p.timestamp as number) : Date.now(),
        level: CONSOLE_LEVEL[String(p.type)] ?? 'log',
        text: args.map(remoteObjectText).join(' ').slice(0, 4000),
        source: 'console',
        ...(frame?.url ? { url: frame.url, line: (frame.lineNumber ?? 0) + 1 } : {}),
      });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = (p.exceptionDetails ?? {}) as { text?: string; exception?: { description?: string }; url?: string; lineNumber?: number };
      this.push({
        ts: typeof p.timestamp === 'number' ? Math.round(p.timestamp as number) : Date.now(),
        level: 'error',
        text: (d.exception?.description ?? d.text ?? 'Uncaught exception').slice(0, 4000),
        source: 'exception',
        ...(d.url ? { url: d.url, line: (d.lineNumber ?? 0) + 1 } : {}),
      });
    } else if (method === 'Log.entryAdded') {
      const e = (p.entry ?? {}) as { level?: string; text?: string; url?: string; timestamp?: number };
      this.push({ ts: Math.round(e.timestamp ?? Date.now()), level: CONSOLE_LEVEL[e.level ?? 'info'] ?? 'info', text: (e.text ?? '').slice(0, 4000), source: 'browser', ...(e.url ? { url: e.url } : {}) });
    }
  }

  /** Console messages and exceptions seen since connecting (newest last). */
  consoleLogs(opts: { since?: number; minLevel?: ConsoleEntry['level']; limit?: number } = {}): ConsoleEntry[] {
    const order = ['debug', 'log', 'info', 'warn', 'error'];
    const min = opts.minLevel ? order.indexOf(opts.minLevel) : 0;
    return this.logs.filter((l) => (opts.since === undefined || l.ts > opts.since) && order.indexOf(l.level) >= min).slice(-(opts.limit ?? 200));
  }

  /**
   * Evaluates a JS expression in the page and returns its value (JSON).
   * Promises are awaited. Exceptions become FireLabError('eval-failed').
   */
  async eval<T = unknown>(expression: string, opts: { timeoutMs?: number; awaitPromise?: boolean } = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 10000;
    const r = await this.cdp.send<{
      result?: { type?: string; value?: unknown; description?: string; unserializableValue?: string; subtype?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: opts.awaitPromise ?? true, timeout: timeoutMs, userGesture: true }, timeoutMs + 2000);
    if (r.exceptionDetails) {
      const msg = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'exception';
      throw new FireLabError('eval-failed', `The page threw: ${msg.split('\n').slice(0, 3).join(' | ')}`);
    }
    const res = r.result ?? {};
    if (res.unserializableValue !== undefined) return res.unserializableValue as T;
    if (res.value === undefined && res.type !== 'undefined' && res.description) return res.description as T;
    return res.value as T;
  }

  async enablePage(): Promise<boolean> {
    if (this.pageEnabled) return true;
    try {
      await this.cdp.send('Page.enable', {}, 5000);
      this.pageEnabled = true;
    } catch {
      this.pageEnabled = false;
    }
    return this.pageEnabled;
  }

  /** Runs `source` in every new document before the page's own scripts. */
  async addInitScript(source: string): Promise<string | undefined> {
    if (!(await this.enablePage())) return undefined;
    const r = await this.cdp.send<{ identifier?: string }>('Page.addScriptToEvaluateOnNewDocument', { source }, 5000).catch(() => ({ identifier: undefined }));
    return r.identifier;
  }

  async removeInitScript(id: string): Promise<void> {
    await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }, 5000).catch(() => {});
  }

  /** Loads a URL and waits for its load event (or `timeoutMs`). */
  async navigate(url: string, timeoutMs = 30000): Promise<{ loaded: boolean }> {
    const canWait = await this.enablePage();
    const load = canWait ? this.cdp.waitFor('Page.loadEventFired', timeoutMs).then(() => true, () => false) : Promise.resolve(false);
    const r = await this.cdp.send<{ errorText?: string }>('Page.navigate', { url }, 15000);
    if (r.errorText) throw new FireLabError('cdp-failed', `Couldn't load ${url}: ${r.errorText}`);
    const loaded = await load;
    return { loaded };
  }

  async reload(ignoreCache = false, timeoutMs = 30000): Promise<{ loaded: boolean }> {
    const canWait = await this.enablePage();
    const load = canWait ? this.cdp.waitFor('Page.loadEventFired', timeoutMs).then(() => true, () => false) : Promise.resolve(false);
    await this.cdp.send('Page.reload', { ignoreCache }, 10000);
    return { loaded: await load };
  }

  async url(): Promise<string> {
    return this.eval<string>('location.href', { timeoutMs: 5000 });
  }

  /** The GPU behind WebGL (UNMASKED_RENDERER), via a throwaway context. */
  async webglInfo(): Promise<{ renderer?: string; vendor?: string; webgl2: boolean } | null> {
    return this.eval(
      `(() => { try {
        const hook = window.firelab && window.firelab.gpu;
        const c = document.createElement('canvas');
        const gl2 = c.getContext('webgl2'); const gl = gl2 || c.getContext('webgl');
        if (!gl) return hook ? { renderer: hook, webgl2: false } : null;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const out = { renderer: hook || String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
          vendor: String(ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)), webgl2: !!gl2 };
        const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
        return out;
      } catch (e) { return null; } })()`,
      { timeoutMs: 8000 },
    );
  }

  close(): void {
    this.cdp.close();
  }
}

export async function fetchTargets(port: number, timeoutMs = 5000): Promise<CdpTarget[]> {
  let lastErr: unknown;
  for (const path of ['/json/list', '/json']) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return (await r.json()) as CdpTarget[];
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new FireLabError('cdp-failed', `Couldn't list DevTools targets: ${(lastErr as Error)?.message ?? lastErr}`, {
    hint: 'The app may have just restarted; retry in a moment',
  });
}
