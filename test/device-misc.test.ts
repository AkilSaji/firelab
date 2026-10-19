import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLogcatLine, dumpLogcat, atLeast } from '../src/adb/logcat.js';
import { parsePower, wakeDevice } from '../src/adb/power.js';
import { Reconnector } from '../src/adb/reconnect.js';
import { WatchSession, listSessions } from '../src/perf/watch.js';
import { measure } from '../src/perf/measure.js';
import { fakeAdb, SERIAL, DEVICES_L } from './helpers/fake-adb.js';

describe('logcat', () => {
  it('parses -v epoch and -v threadtime lines', () => {
    expect(parseLogcatLine('1760538791.123  13059 13101 E chromium: [ERROR:gl_utils.cc] GL_OUT_OF_MEMORY')).toEqual({
      ts: 1760538791123,
      pid: 13059,
      tid: 13101,
      level: 'error',
      tag: 'chromium',
      text: '[ERROR:gl_utils.cc] GL_OUT_OF_MEMORY',
    });
    const tt = parseLogcatLine('10-15 19:33:01.123  1234  1250 W ActivityManager: Slow operation', 2026);
    expect(tt).toMatchObject({ pid: 1234, level: 'warn', tag: 'ActivityManager', text: 'Slow operation' });
    expect(new Date(tt?.ts ?? 0).getMonth()).toBe(9);
    expect(parseLogcatLine('--------- beginning of main')).toBeNull();
    expect(atLeast('error', 'warn')).toBe(true);
    expect(atLeast('info', 'warn')).toBe(false);
  });

  it('dumps the last lines for one process at a minimum level', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/logcat -d -v epoch -t 50 --pid=13059/, [
      '--------- beginning of main',
      '1760538791.100  13059 13101 I chromium: [INFO:CONSOLE(1)] "loaded"',
      '1760538791.200  13059 13101 W AudioTrack: underrun',
      '1760538791.300  13059 13101 E chromium: renderer crashed',
      '1760538791.400   999   999 E Other: not ours',
    ].join('\n'));
    const lines = await dumpLogcat(adb, SERIAL, { pid: 13059, lines: 50, minLevel: 'warn' });
    expect(lines.map((l) => l.text)).toEqual(['underrun', 'renderer crashed']);
  });
});

describe('power state and wake', () => {
  it('reads awake, asleep and screensaver states', () => {
    expect(parsePower('  mWakefulness=Awake\nDisplay Power: state=ON')).toEqual({ wakefulness: 'Awake', displayOn: true, dreaming: false, awake: true });
    expect(parsePower('  mWakefulness=Dreaming\nDisplay Power: state=ON')).toMatchObject({ dreaming: true, awake: false });
    expect(parsePower('  mWakefulness=Asleep\nDisplay Power: state=OFF')).toMatchObject({ displayOn: false, awake: false });
  });

  it('sends KEYCODE_WAKEUP and waits until the device reports Awake', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/dumpsys power/, '  mWakefulness=Dreaming\nDisplay Power: state=ON\n', 1);
    runner.on(/input keyevent KEYCODE_WAKEUP/, '');
    runner.on(/dumpsys power/, '  mWakefulness=Awake\nDisplay Power: state=ON\n');
    const r = await wakeDevice(adb, SERIAL, 2000);
    expect(r).toMatchObject({ woke: true, awake: true });
    expect(runner.shellCommands()).toContain('input keyevent KEYCODE_WAKEUP');
  });

  it('does nothing when already awake', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/dumpsys power/, '  mWakefulness=Awake\nDisplay Power: state=ON\n');
    expect(await wakeDevice(adb, SERIAL)).toMatchObject({ woke: false, awake: true });
    expect(runner.shellCommands().some((c) => c.includes('WAKEUP'))).toBe(false);
  });
});

describe('Reconnector', () => {
  it('reconnects a Wi-Fi device that dropped off, with backoff, and says when it is back', async () => {
    const { adb, runner } = fakeAdb();
    let online = true;
    runner.on(/^devices -l$/, () => (online ? DEVICES_L : 'List of devices attached\n\n'));
    runner.on(/^connect /, () => `failed to connect to ${SERIAL}`);
    const r = new Reconnector(adb, 1000);
    const events: string[] = [];
    r.on('lost', (s) => events.push(`lost ${s}`));
    r.on('reconnected', (s, n) => events.push(`back ${s} after ${n}`));
    await r.poll(0); // sees it online, starts watching
    expect(r.watching).toEqual([SERIAL]);
    online = false;
    await r.poll(1000); // lost -> connect attempt 1
    await r.poll(1500); // inside backoff: no attempt
    await r.poll(3100); // attempt 2
    expect(runner.calls.filter((c) => c[0] === 'connect')).toHaveLength(2);
    online = true;
    await r.poll(4000);
    expect(events).toEqual([`lost ${SERIAL}`, `back ${SERIAL} after 2`]);
  });

  it('drops a stale "offline" entry before reconnecting, and leaves unauthorized devices alone', async () => {
    const { adb, runner } = fakeAdb();
    let list = `List of devices attached\n${SERIAL}\toffline\n`;
    runner.on(/^devices -l$/, () => list);
    runner.on(/^disconnect /, '');
    runner.on(/^connect /, `connected to ${SERIAL}`);
    const r = new Reconnector(adb);
    r.watch(SERIAL);
    r.watch('USB123'); // USB devices aren't watched
    expect(r.watching).toEqual([SERIAL]);
    await r.poll(0);
    expect(runner.calls.map((c) => c[0])).toEqual(['devices', 'disconnect', 'connect']);
    list = `List of devices attached\n${SERIAL}\tunauthorized\n`;
    runner.calls = [];
    await r.poll(60000);
    expect(runner.calls.map((c) => c[0])).toEqual(['devices']);
  });
});

describe('WatchSession', () => {
  it('records keys, perf, errors and thumbnails, then summarizes to disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-watch-'));
    const keyListeners: ((k: { ts: number; key: string; action: 'down' | 'up'; holdMs?: number }) => void)[] = [];
    let fpsVal = 30;
    const consoleFns: ((e: { ts: number; level: 'error'; text: string; source: 'console' }) => void)[] = [];
    const w = new WatchSession(
      {
        keys: { start() {}, stop() {}, on: (_e: 'key', fn: (k: never) => void) => keyListeners.push(fn) },
        native: async (memory) => ({ ts: Date.now(), ...(memory ? { memMB: 500 + fpsVal } : {}), cpuPct: 150 }),
        fps: async () => [{ ts: Date.now(), fps: fpsVal--, source: 'raf' as const, counter: 'draws' as const }],
        onConsole: (fn) => {
          consoleFns.push(fn as never);
          return () => {};
        },
        thumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
      { sessionId: 'w_test1', device: SERIAL, package: 'com.example.game', dir: path.join(dir, 'w_test1'), intervalMs: 60_000, thumbEveryMs: 60_000 },
    );
    const perf: number[] = [];
    w.on('perf', (p) => perf.push(p.fps ?? -1));
    w.start();
    for (const k of ['down', 'down', 'ok']) {
      keyListeners.forEach((fn) => fn({ ts: Date.now(), key: k, action: 'down' }));
      keyListeners.forEach((fn) => fn({ ts: Date.now(), key: k, action: 'up', holdMs: 90 }));
    }
    consoleFns.forEach((fn) => fn({ ts: Date.now(), level: 'error', text: 'TypeError: boom', source: 'console' }));
    await w.samplePerf();
    await w.samplePerf();
    await new Promise((r) => setTimeout(r, 20)); // first thumbnail
    const s = await w.stop();
    expect(s).toMatchObject({
      sessionId: 'w_test1',
      device: SERIAL,
      package: 'com.example.game',
      keys: 3,
      fps: { median: 29, p10: 28.2 },
      memMB: { max: 529 },
      errors: 1,
      thumbnails: ['thumb-0001.jpg'],
      topKeys: [
        { key: 'down', count: 2 },
        { key: 'ok', count: 1 },
      ],
      firstErrors: ['TypeError: boom'],
    });
    expect(perf).toEqual([30, 29, 28]);
    const timeline = fs.readFileSync(path.join(dir, 'w_test1', 'timeline.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string });
    expect(timeline[0]?.type).toBe('start');
    expect(timeline.filter((e) => e.type === 'key')).toHaveLength(6);
    expect(timeline[timeline.length - 1]?.type).toBe('stop');
    expect(listSessions(dir).map((x) => x.sessionId)).toEqual(['w_test1']);
    expect(listSessions(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('measure', () => {
  it('combines page fps with native memory/CPU', async () => {
    let i = 0;
    const m = await measure(
      {
        readFps: async () => [{ ts: 0, fps: [30, 28, 29][i++ % 3] as number, source: 'page' as const }],
        native: async (memory) => ({ ts: 0, appPid: 1, ...(memory ? { memMB: 410, appPssMB: 200, rendererPssMB: 210 } : {}), cpuPct: 99 }),
        pageHook: () => ({ tier: 'tv' }),
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
      },
      0.05,
    );
    expect(m.fps?.source).toBe('page');
    expect(m.memMB).toBe(410);
    expect(m.cpuPct).toBe(99);
    expect(m.page).toEqual({ tier: 'tv' });
  });
  it('explains missing data', async () => {
    const m = await measure({ native: async () => ({ ts: 0 }), sleep: async () => {} }, 0.01);
    expect(m.notes).toEqual(['No WebView to read frame rate from; memory and CPU only.', 'The app is not running.']);
  });
});

describe('DeviceMonitor backlog', () => {
  it('replays recent perf, log and key events to a new subscriber (a reloaded dashboard)', async () => {
    const { fakeLab } = await import('./helpers/fake-lab.js');
    const world = fakeLab();
    const m = await world.lab.monitor(SERIAL);
    const rec = (m as unknown as { record: (k: string, e: object) => void }).record.bind(m);
    const old = Date.now() - 200_000;
    rec('perf', { ts: old, fps: 1, source: 'raf' });
    rec('perf', { ts: Date.now(), fps: 30, source: 'raf' });
    rec('log', { ts: 1, level: 'error', text: 'boom', source: 'console' });
    rec('key', { ts: 2, key: 'ok', action: 'down' });
    const got: string[] = [];
    const unsub = m.subscribe({ perf: (e) => got.push(`perf ${e.fps}`), log: (e) => got.push(`log ${e.text}`), key: (e) => got.push(`key ${e.key}`) });
    expect(got).toEqual(['perf 30', 'log boom', 'key ok']); // the 3-minute-old perf sample aged out
    unsub();
    expect(await world.lab.monitor(SERIAL)).toBe(m); // kept for the next viewer
    await world.lab.close();
  });
});
