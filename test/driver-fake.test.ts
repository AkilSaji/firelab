import { describe, expect, it } from 'vitest';
import { FakeDriver } from '../src/driver/fake.js';
import { decodePng } from '../src/adb/png.js';
import { decodeJpeg } from '../src/adb/image.js';
import { FireLabError } from '../src/lib/errors.js';
import type { DeviceDriver } from '../src/driver/types.js';

const APP = { package: 'com.example.game' };

describe('FakeDriver', () => {
  it('is a DeviceDriver with every capability by default, and configurable caps', () => {
    const d: DeviceDriver = new FakeDriver();
    expect(d.kind).toBe('mock');
    expect(Object.values(d.caps).every(Boolean)).toBe(true);
    const limited = new FakeDriver({ kind: 'vda', serial: 'vega-1', caps: { eval: false, holds: false, keys: false as never } });
    expect(limited.kind).toBe('vda');
    expect(limited.serial).toBe('vega-1');
    expect(limited.caps).toMatchObject({ eval: false, holds: false, keys: true });
  });

  it('records every call with its arguments', async () => {
    const d = new FakeDriver();
    await d.launch(APP);
    await d.press([{ key: 'down' }, { key: 'ok', mode: 'long' }], { gapMs: 100 });
    await d.screenshot({ format: 'rgba' });
    expect(d.calls.map((c) => c.method)).toEqual(['launch', 'press', 'screenshot']);
    expect(d.callsTo('press')[0]?.args).toEqual([[{ key: 'down' }, { key: 'ok', mode: 'long' }], { gapMs: 100 }]);
    expect(d.state.pressed.map((k) => k.key)).toEqual(['down', 'ok']);
    d.clearCalls();
    expect(d.calls).toHaveLength(0);
  });

  it('plays a plausible device: launch, foreground, pid, stop, crash', async () => {
    const d = new FakeDriver();
    expect(await d.foreground()).toEqual({ package: 'com.fake.launcher' });
    const { pid } = await d.launch(APP);
    expect(pid).toBeGreaterThan(0);
    expect(await d.pid(APP)).toBe(pid);
    expect((await d.foreground())?.package).toBe(APP.package);
    await d.stop(APP);
    expect(await d.pid(APP)).toBeUndefined();
    expect((await d.foreground())?.package).toBe('com.fake.launcher');
    await d.launch(APP);
    d.crash(APP.package);
    expect(await d.pid(APP)).toBeUndefined();
    const logs = await d.logs({ app: APP, minLevel: 'error' });
    expect(logs.map((l) => l.text)).toEqual(['FATAL EXCEPTION: main', `Process: ${APP.package}, PID: ${pid! + 1}`, 'java.lang.RuntimeException: boom']);
  });

  it('filters logs by time, level and app', async () => {
    const d = new FakeDriver();
    await d.launch(APP);
    d.pushLog({ ts: 1000, level: 'info', text: 'old' }, APP.package);
    d.pushLog({ ts: 2000, level: 'warn', text: 'mine' }, APP.package);
    d.pushLog({ ts: 2500, level: 'error', pid: 1, text: 'someone else' });
    d.pushLog({ ts: 3000, level: 'info', pid: 1, text: `Start proc for ${APP.package}` });
    expect((await d.logs({ sinceTs: 1500 })).map((l) => l.text)).toEqual(['mine', 'someone else', `Start proc for ${APP.package}`]);
    expect((await d.logs({ app: APP, sinceTs: 1500 })).map((l) => l.text)).toEqual(['mine', `Start proc for ${APP.package}`]);
    expect((await d.logs({ minLevel: 'error' })).map((l) => l.text)).toEqual(['someone else']);
  });

  it('answers with scripted values, functions and errors; once() goes first', async () => {
    const d = new FakeDriver();
    d.on('evaluate', (expr: string) => (expr === 'game.state' ? { scene: 'menu' } : null));
    d.once('evaluate', 'first');
    expect(await d.evaluate('anything')).toBe('first');
    expect(await d.evaluate('game.state')).toEqual({ scene: 'menu' });
    expect(await d.evaluate('other')).toBeNull();
    d.once('screenshot', new FireLabError('timeout', 'screencap timed out'));
    await expect(d.screenshot()).rejects.toMatchObject({ code: 'timeout' });
    expect((await d.screenshot({ format: 'rgba' })).width).toBe(64);
    d.on('measure', async () => ({ fps: { median: 22, p10: 15 }, memMB: 700 }));
    expect(await d.measure(APP, 10)).toEqual({ fps: { median: 22, p10: 15 }, memMB: 700 });
    d.resetReplies('measure');
    expect((await d.measure(APP, 10)).fps?.median).toBe(60);
  });

  it('lets a scripted reply keep the default behaviour through base', async () => {
    const d = new FakeDriver();
    d.on('launch', async (app) => ({ ...(await d.base.launch(app)), launchMs: 4000 }));
    const r = await d.launch(APP);
    expect(r.launchMs).toBe(4000);
    expect(await d.pid(APP)).toBe(r.pid);
  });

  it('refuses methods whose cap is off (strict by default), like a careful driver', async () => {
    const d = new FakeDriver({ caps: { eval: false, console: false, recordKeys: false } });
    await expect(d.evaluate('1')).rejects.toMatchObject({ code: 'unsupported' });
    expect(() => d.onConsole(APP, () => {})).toThrow(/caps.console is false/);
    expect(() => d.recordKeys()).toThrow(/caps.recordKeys/);
    const lax = new FakeDriver({ caps: { eval: false }, strictCaps: false });
    expect(await lax.evaluate('1')).toBeUndefined();
  });

  it('returns real images: RGBA thumbnails of the requested width, PNG and JPEG', async () => {
    const d = new FakeDriver({ screen: { width: 1280, height: 720, rgba: [200, 10, 10, 255] } });
    const t = await d.screenshot({ format: 'rgba', width: 64 });
    expect([t.width, t.height, t.rgba?.length]).toEqual([64, 36, 64 * 36 * 4]);
    expect([...(t.rgba?.slice(0, 4) ?? [])]).toEqual([200, 10, 10, 255]);
    const png = await d.screenshot({ format: 'png', width: 320 });
    expect(decodePng(png.data!).width).toBe(320);
    const jpg = await d.screenshot({ width: 160 });
    expect(jpg.mime).toBe('image/jpeg');
    expect(decodeJpeg(jpg.data!).height).toBe(90);
    d.setFrame((s) => {
      const on = s.foreground?.package === APP.package;
      return { width: 2, height: 2, data: new Uint8Array(16).fill(on ? 255 : 0) };
    });
    await d.launch(APP);
    expect((await d.screenshot({ format: 'rgba', width: 2 })).rgba?.[0]).toBe(255);
  });

  it('streams console entries and recorded keys until they stop', async () => {
    const d = new FakeDriver();
    const got: string[] = [];
    const off = d.onConsole(APP, (e) => got.push(`${e.level}:${e.text}`));
    d.emitConsole(APP.package, { level: 'error', text: 'TypeError: x is null', source: 'exception' });
    d.emitConsole('com.other.app', { text: 'not mine' });
    off();
    d.emitConsole(APP.package, { text: 'after' });
    expect(got).toEqual(['error:TypeError: x is null']);
    const rec = d.recordKeys();
    d.humanPress('right', 600);
    expect(await rec.stop()).toMatchObject([{ key: 'right', action: 'down' }, { key: 'right', action: 'up', holdMs: 600 }]);
    d.humanPress('left');
    expect(d.activeRecordings).toBe(0);
  });

  it('applies the same reset safety rules as the real driver', async () => {
    const d = new FakeDriver({ installed: ['com.firelab.mine'] });
    await expect(d.reset(APP, {} as never)).rejects.toMatchObject({ code: 'confirm-required' });
    await expect(d.reset(APP, { confirm: true })).rejects.toMatchObject({ code: 'confirm-required' });
    await d.reset(APP, { confirm: true, allowAnyPackage: true });
    await d.reset({ package: 'com.firelab.mine' }, { confirm: true });
    const { package: pkg } = await d.install('/builds/Space Game.apk');
    expect(pkg).toBe('com.fake.spacegame');
    await d.reset({ package: pkg }, { confirm: true });
  });

  it('validates keys and packages', async () => {
    const d = new FakeDriver();
    await expect(d.press([{ key: 'jump' as never }])).rejects.toMatchObject({ code: 'bad-request' });
    await expect(d.press([])).rejects.toMatchObject({ code: 'bad-request' });
    await expect(d.launch({ package: 'not a package' })).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('close() ends listeners and recordings, and later calls fail', async () => {
    const d = new FakeDriver();
    d.onConsole(APP, () => {});
    d.recordKeys();
    await d.close();
    expect(d.listenerCount()).toBe(0);
    expect(d.activeRecordings).toBe(0);
    await expect(d.press([{ key: 'up' }])).rejects.toMatchObject({ code: 'bad-request' });
    expect(d.callsTo('close')).toHaveLength(1);
  });
});
