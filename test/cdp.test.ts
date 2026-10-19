import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDevtoolsSockets, parsePsNames, listDevtoolsSockets } from '../src/cdp/sockets.js';
import { pickPageTarget, remoteObjectText, WebViewSession, type CdpTarget } from '../src/cdp/webview.js';
import { CdpClient } from '../src/cdp/client.js';
import { bucketsToSamples, FpsSampler, PROBE_SOURCE } from '../src/cdp/fps.js';
import { FakeDevtools } from './helpers/fake-devtools.js';
import { fakeAdb, SERIAL } from './helpers/fake-adb.js';

const UNIX = `Num       RefCount Protocol Flags    Type St Inode Path
0000000000000000: 00000002 00000000 00010000 0001 01 193653 @webview_devtools_remote_13059
0000000000000000: 00000002 00000000 00010000 0001 01 193654 @chrome_devtools_remote
0000000000000000: 00000002 00000000 00010000 0001 01 193655 @com.opera.browser_devtools_remote
0000000000000000: 00000003 00000000 00000000 0001 03 193656 @webview_devtools_remote_13059
0000000000000000: 00000002 00000000 00010000 0001 01  20001 /dev/socket/logdw`;

describe('DevTools socket discovery', () => {
  it('finds WebView, Chrome and other browser sockets in /proc/net/unix (deduplicated)', () => {
    expect(parseDevtoolsSockets(UNIX)).toEqual([
      { name: 'webview_devtools_remote_13059', kind: 'webview', pid: 13059 },
      { name: 'chrome_devtools_remote', kind: 'chrome', package: 'com.android.chrome' },
      { name: 'com.opera.browser_devtools_remote', kind: 'other', package: 'com.opera.browser' },
    ]);
  });
  it('maps pids to packages via ps', async () => {
    expect(parsePsNames('  PID NAME\n13059 com.sunsetvilla.tv\n13181 com.amazon.webview.chromium:sandboxed_process0\n').get(13059)).toBe('com.sunsetvilla.tv');
    const { adb, runner } = fakeAdb();
    runner.on(/grep -a devtools_remote/, `${UNIX}\n@@ps\n  PID NAME\n13059 com.sunsetvilla.tv:main\n`);
    expect((await listDevtoolsSockets(adb, SERIAL))[0]).toMatchObject({ pid: 13059, package: 'com.sunsetvilla.tv' });
  });
});

describe('target and value helpers', () => {
  it('picks the visible, attached page with a URL', () => {
    const t = (id: string, type: string, url: string, description = ''): CdpTarget => ({ id, type, url, title: '', description, webSocketDebuggerUrl: `ws://x/${id}` });
    const picked = pickPageTarget([t('w', 'worker', ''), t('a', 'page', 'about:blank', '{"empty":true}'), t('b', 'page', 'http://g/', '{"attached":true,"visible":true}'), t('c', 'page', 'http://ads/', '{"attached":true,"visible":false}')]);
    expect(picked?.id).toBe('b');
    expect(pickPageTarget([t('c', 'page', 'http://ads/'), t('d', 'page', 'http://game/')], 'game')?.id).toBe('d');
    expect(pickPageTarget([t('w', 'worker', '')])).toBeUndefined();
  });
  it('formats console arguments', () => {
    expect(remoteObjectText({ type: 'string', value: 'hi' })).toBe('hi');
    expect(remoteObjectText({ type: 'object', value: { a: 1 } })).toBe('{"a":1}');
    expect(remoteObjectText({ type: 'number', unserializableValue: 'NaN' })).toBe('NaN');
    expect(remoteObjectText({ type: 'object', subtype: 'error', description: 'Error: boom\n    at x' })).toBe('Error: boom\n    at x');
    expect(remoteObjectText({ type: 'undefined' })).toBe('undefined');
  });
});

describe('fps buckets', () => {
  it('counts frames that drew for WebGL apps and skips idle seconds', () => {
    const s = bucketsToSamples([
      { t: 1, ms: 1000, frames: 60, drawFrames: 30 },
      { t: 2, ms: 1000, frames: 60, drawFrames: 0 }, // menu: not rendering, not slow
      { t: 3, ms: 2000, frames: 4, drawFrames: 0 }, // main thread stalled
      { t: 4, ms: 1000, frames: 58, drawFrames: 27 },
    ]);
    expect(s.map((x) => [x.fps, x.counter])).toEqual([
      [30, 'draws'],
      [2, 'raf'],
      [27, 'draws'],
    ]);
  });
  it('counts rAF callbacks for pages without WebGL', () => {
    expect(bucketsToSamples([{ t: 1, ms: 1000, frames: 59, drawFrames: 0 }])).toEqual([{ ts: 1, fps: 59, source: 'raf', counter: 'raf' }]);
  });
  it('treats a WebGL game sitting on a menu as idle, not as 60 fps', () => {
    const menu = [{ t: 1, ms: 1000, frames: 60, drawFrames: 0, gl: true }];
    expect(bucketsToSamples(menu)).toEqual([]);
    expect(bucketsToSamples([{ t: 1, ms: 1000, frames: 60, drawFrames: 0 }], true)).toEqual([]);
  });
  it('ships a probe that installs once', () => {
    expect(PROBE_SOURCE).toContain("if (window.__firelabProbe) return 'present'");
    expect(PROBE_SOURCE).toContain('WebGL2RenderingContext');
    expect(PROBE_SOURCE).toContain('HTMLCanvasElement');
  });
});

describe('CDP client and WebView session (fake DevTools server)', () => {
  let dt: FakeDevtools;
  beforeEach(async () => {
    dt = await new FakeDevtools().start();
  });
  afterEach(async () => {
    await dt.stop();
  });

  function session() {
    const { adb, runner } = fakeAdb();
    runner.on(/grep -a devtools_remote/, `${UNIX}\n@@ps\n13059 com.sunsetvilla.tv\n`);
    runner.on(/pidof com.sunsetvilla.tv/, '13059\n');
    runner.on(/forward tcp:0 localabstract:webview_devtools_remote_13059/, `${dt.port}\n`);
    runner.on(/forward --remove/, '');
    return { adb, runner, open: () => WebViewSession.open(adb, SERIAL, { package: 'com.sunsetvilla.tv' }) };
  }

  it('evaluates expressions and returns values', async () => {
    dt.handler = (m) => (m.method === 'Runtime.evaluate' ? { result: { type: 'string', value: `you said ${String(m.params?.expression)}` } } : {});
    const { open } = session();
    const s = await open();
    expect(s.target.id).toBe('P1');
    expect(await s.eval('navigator.userAgent')).toBe('you said navigator.userAgent');
    const ev = dt.received.find((m) => m.method === 'Runtime.evaluate');
    expect(ev?.params).toMatchObject({ returnByValue: true, awaitPromise: true });
    s.close();
  });

  it('turns page exceptions into eval-failed errors', async () => {
    dt.handler = (m) => (m.method === 'Runtime.evaluate' ? { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: __sv is not defined\n    at <anonymous>:1:1' } } } : {});
    const s = await session().open();
    await expect(s.eval('__sv.state')).rejects.toMatchObject({ code: 'eval-failed', message: expect.stringMatching(/ReferenceError: __sv is not defined/) });
    s.close();
  });

  it('times out instead of hanging when the page never answers', async () => {
    dt.handler = (m) => (m.method === 'Runtime.evaluate' ? undefined : {});
    const s = await session().open();
    await expect(s.eval('while(true){}', { timeoutMs: 100 })).rejects.toMatchObject({ code: 'timeout' });
    s.close();
  });

  it('records console messages and exceptions', async () => {
    const s = await session().open();
    const got = new Promise((r) => s.once('console', r));
    dt.emit('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: 'low fps' }, { type: 'number', value: 12 }], timestamp: 1000 });
    await got;
    dt.emit('Runtime.exceptionThrown', { timestamp: 2000, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is null' }, url: 'http://g/main.js', lineNumber: 41 } });
    dt.emit('Log.entryAdded', { entry: { level: 'error', text: 'Failed to load resource: 404', url: 'http://g/a.png', timestamp: 3000 } });
    await new Promise((r) => setTimeout(r, 30));
    expect(s.consoleLogs()).toEqual([
      { ts: 1000, level: 'warn', text: 'low fps 12', source: 'console' },
      { ts: 2000, level: 'error', text: 'TypeError: x is null', source: 'exception', url: 'http://g/main.js', line: 42 },
      { ts: 3000, level: 'error', text: 'Failed to load resource: 404', source: 'browser', url: 'http://g/a.png' },
    ]);
    expect(s.consoleLogs({ minLevel: 'error' })).toHaveLength(2);
    expect(s.consoleLogs({ since: 1500 })).toHaveLength(2);
    s.close();
  });

  it('navigates and waits for the load event', async () => {
    dt.handler = (m, send) => {
      if (m.method === 'Page.navigate') setTimeout(() => send({ method: 'Page.loadEventFired', params: { timestamp: 1 } }), 20);
      return {};
    };
    const s = await session().open();
    expect(await s.navigate('http://g/?q=tv', 2000)).toEqual({ loaded: true });
    expect(dt.received.map((m) => m.method)).toContain('Page.enable');
    s.close();
  });

  it('notices when the app goes away (socket closed) and removes the forward', async () => {
    const { open, runner } = session();
    const s = await open();
    const closed = new Promise((r) => s.once('close', r));
    dt.dropClients();
    await closed;
    expect(s.closed).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(runner.calls.some((c) => c.includes('--remove'))).toBe(true);
    await expect(s.eval('1')).rejects.toMatchObject({ code: 'cdp-failed' });
  });

  it('explains a running app without debuggable WebView, and a stopped app', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/grep -a devtools_remote/, `@@ps\n`);
    runner.on(/pidof com.native.game/, '4242\n');
    runner.on(/pidof com.stopped.game/, { stdout: Buffer.from(''), stderr: '', code: 1 });
    await expect(WebViewSession.open(adb, SERIAL, { package: 'com.native.game' })).rejects.toMatchObject({ code: 'no-webview', hint: expect.stringMatching(/setWebContentsDebuggingEnabled/) });
    await expect(WebViewSession.open(adb, SERIAL, { package: 'com.stopped.game' })).rejects.toMatchObject({ code: 'not-running' });
  });

  it('samples fps from window.firelab when the page publishes it, else from the probe', async () => {
    let mode: 'hook' | 'probe' | 'paused' = 'hook';
    dt.handler = (m) => {
      if (m.method !== 'Runtime.evaluate') return {};
      const expr = String(m.params?.expression);
      if (expr.includes('__firelabProbe) return')) return { result: { type: 'string', value: 'installed' } };
      if (mode === 'hook') return { result: { type: 'object', value: { hook: { fps: 27.4, fpsMedian: 26.9, scale: 0.8, tier: 'tv' }, probe: [], hidden: false } } };
      if (mode === 'paused') return { result: { type: 'object', value: { hook: { fps: 60, paused: true }, probe: [], hidden: false } } };
      return { result: { type: 'object', value: { hook: null, probe: [{ t: 5, ms: 1000, frames: 60, drawFrames: 29 }], hidden: false } } };
    };
    const s = await session().open();
    const f = new FpsSampler(s);
    await f.install();
    expect(await f.read()).toEqual([{ ts: expect.any(Number), fps: 27.4, source: 'page', scale: 0.8, fpsMedian: 26.9, tier: 'tv' }]);
    mode = 'paused';
    expect(await f.read()).toEqual([]);
    mode = 'probe';
    expect(await f.read()).toEqual([{ ts: 5, fps: 29, source: 'raf', counter: 'draws' }]);
    s.close();
  });

  it('CdpClient rejects a dead endpoint quickly', async () => {
    await expect(CdpClient.connect('ws://127.0.0.1:1/devtools/page/x', 2000)).rejects.toBeTruthy();
  });
});

describe('the injected probe (run in a VM with a fake browser)', () => {
  it('counts frames, frames that drew WebGL, and notices WebGL contexts', async () => {
    const vm = await import('node:vm');
    let rafCb: ((t: number) => void) | null = null;
    class WebGLRenderingContext {
      drawElements() {
        return 'drawn';
      }
    }
    class HTMLCanvasElement {
      getContext(type: string) {
        return type === 'webgl' ? new WebGLRenderingContext() : {};
      }
    }
    let now = 0;
    const sandbox: Record<string, unknown> = {
      performance: { now: () => now },
      Date,
      requestAnimationFrame: (cb: (t: number) => void) => {
        rafCb = cb;
        return 1;
      },
      WebGLRenderingContext,
      HTMLCanvasElement,
      Object,
      String,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    expect(vm.runInContext(PROBE_SOURCE, sandbox)).toBe('installed');
    expect(vm.runInContext(PROBE_SOURCE, sandbox)).toBe('present');
    const frame = (draw: boolean) => {
      now += 1000 / 60;
      if (draw) gl.drawElements();
      rafCb?.(now);
    };
    const gl = new HTMLCanvasElement().getContext('webgl') as WebGLRenderingContext;
    // 2 s at 60 Hz, drawing every other frame (a game capped at 30 fps)
    for (let i = 0; i < 120; i++) frame(i % 2 === 0);
    const P = vm.runInContext('window.__firelabProbe', sandbox) as { take: () => { frames: number; drawFrames: number; gl: boolean; ms: number }[] };
    const buckets = P.take();
    expect(buckets.length).toBeGreaterThanOrEqual(1);
    expect(buckets[0]).toMatchObject({ gl: true });
    expect(buckets[0]!.frames).toBeGreaterThanOrEqual(59);
    expect(Math.abs(buckets[0]!.drawFrames - buckets[0]!.frames / 2)).toBeLessThanOrEqual(1);
    const fps = bucketsToSamples(buckets as never);
    expect(Math.abs((fps[0]?.fps ?? 0) - 30)).toBeLessThanOrEqual(1);
    expect(gl.drawElements()).toBe('drawn'); // wrapped methods still work
    expect(P.take()).toEqual([]);
  });
});
