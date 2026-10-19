import { beforeEach, describe, expect, it } from 'vitest';
import { hidScript, registerCommand, reportCommand, HidRemote, SmartRemote, CONSUMER_USAGES, REMOTE_DESCRIPTOR, HID_PROFILES, hidVerdict, forgetHidVerdicts } from '../src/adb/hid.js';
import { parseKeys, inputHoldScript } from '../src/adb/keys.js';
import { fakeAdb, SERIAL } from './helpers/fake-adb.js';
import { fakeHidDevice } from './helpers/fake-hid.js';

beforeEach(() => forgetHidVerdicts());

describe('virtual HID remote', () => {
  it('registers a consumer-control device with a vendor id that has no special key layout', () => {
    const reg = JSON.parse(registerCommand());
    expect(reg).toMatchObject({ id: 1, command: 'register', name: 'FireLab Remote', vid: 0x1209, pid: 0x0001 });
    expect(reg.descriptor).toEqual(REMOTE_DESCRIPTOR);
    expect(REMOTE_DESCRIPTOR.slice(0, 4)).toEqual([0x05, 0x0c, 0x09, 0x01]);
  });

  it('encodes usages little-endian after the report id', () => {
    expect(JSON.parse(reportCommand(0x224)).report).toEqual([1, 0x24, 0x02]);
    expect(JSON.parse(reportCommand(0)).report).toEqual([1, 0, 0]);
  });

  it('covers every remote key except wake', () => {
    expect(Object.keys(CONSUMER_USAGES).sort()).toEqual(['back', 'down', 'fastforward', 'home', 'left', 'menu', 'mute', 'ok', 'playpause', 'rewind', 'right', 'search', 'up', 'voldown', 'volup']);
  });

  it('turns presses, long presses and holds into down / delay / up', () => {
    const s = hidScript(parseKeys(['up', 'right:1500', 'ok:long', 'wake']), { gapMs: 100 });
    const cmds = s.lines.map((l) => JSON.parse(l) as { command: string; report?: number[]; duration?: number });
    expect(cmds.map((c) => (c.command === 'delay' ? `wait ${c.duration}` : `report ${c.report?.[1]}`))).toEqual([
      'report 66', 'wait 60', 'report 0', 'wait 100',
      'report 69', 'wait 1500', 'report 0', 'wait 100',
      'report 65', 'wait 800', 'report 0', 'wait 100',
    ]);
    expect(s.durationMs).toBe(60 + 1500 + 800 + 300);
    expect(s.unsupported.map((k) => k.key)).toEqual(['wake']);
  });

  it('streams JSON to `hid -` on the device and keeps the order with input fallbacks', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/shell input keyevent/, '');
    const dev = fakeHidDevice(runner, { listed: true, delivers: true });
    const r = new HidRemote(adb, SERIAL, { registerWaitMs: 5 });
    await r.press(parseKeys(['down', 'wake', 'ok:200']), { gapMs: 0 });
    const hid = runner.spawned.find((s) => s.args[3] === 'hid');
    expect(hid?.args).toEqual(['-s', SERIAL, 'shell', 'hid', '-']);
    const written = dev.hidLines.map((l) => JSON.parse(l) as { command: string; name?: string; report?: number[]; duration?: number });
    expect(written[0]).toMatchObject({ command: 'register', name: r.deviceName });
    // down (0x43) tap, then wake via input, then ok (0x41) held 200 ms
    expect(written.slice(1).map((c) => (c.command === 'delay' ? c.duration : c.report?.[1]))).toEqual([0x43, 60, 0, 0x41, 200, 0]);
    expect(runner.shellCommands().filter((c) => c.startsWith('input'))).toEqual(['input keyevent 224']);
    await r.close();
    expect(hid?.proc.killed).toBe(true);
  });

  it('falls back to input keyevent for good when hid is missing', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/input keyevent/, '');
    const origSpawn = runner.spawn.bind(runner);
    runner.spawn = (args: string[]) => {
      const proc = origSpawn(args);
      setTimeout(() => {
        (proc as unknown as { stdout: NodeJS.WritableStream }).stdout.write('/system/bin/sh: hid: not found\n');
        proc.emit('exit', 127);
      }, 1);
      return proc;
    };
    const r = new HidRemote(adb, SERIAL, { registerWaitMs: 20 });
    await r.press(parseKeys(['left:900']));
    expect(r.available).toBe(false);
    expect(r.holds()).toBe(false);
    expect(runner.shellCommands()).toEqual([inputHoldScript('21', 900)]);
    await r.press(parseKeys(['right:900']));
    expect(runner.spawned).toHaveLength(1);
  });

  it('SmartRemote uses input for taps, and HID for holds once it proved itself (not Fire OS)', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/input keyevent/, '');
    fakeHidDevice(runner, { listed: true, delivers: true });
    const r = new SmartRemote(adb, SERIAL, 'auto', { registerWaitMs: 5, fireOs: false });
    await r.press(parseKeys(['up', 'ok']));
    expect(runner.shellCommands()).toEqual(['input keyevent 19 23']);
    expect(runner.spawned).toHaveLength(0);
    expect(r.holds()).toBeUndefined();
    await r.press(parseKeys(['right:100']));
    expect(runner.spawned.map((s) => s.args[3])).toEqual(['hid', 'getevent -l']);
    expect(r.holds()).toBe(true);
    const forced = new SmartRemote(adb, SERIAL, 'input');
    await forced.press(parseKeys(['up:500']));
    expect(runner.spawned).toHaveLength(2);
    expect(forced.holds()).toBe(false);
    await r.close();
  });
});

describe('virtual HID remote: proof before trust (Fire OS 8 regression)', () => {
  // Fire TV Stick 4K Plus, Fire OS 8.1.8.2: `hid` takes the device and the
  // reports without a word, and nothing reaches getevent or the app.
  it('notices a remote that registers but delivers nothing, re-sends through input, and remembers', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/input keyevent/, '');
    const dev = fakeHidDevice(runner, { listed: true, delivers: false });
    const r = new HidRemote(adb, SERIAL, { registerWaitMs: 5 });
    await r.press(parseKeys(['right:300']));
    // It did try HID (one report down, the hold, the report up) while getevent watched...
    expect(dev.hidLines.slice(1).map((l) => JSON.parse(l).command)).toEqual(['report', 'delay', 'report']);
    expect(runner.spawned.map((s) => s.args[3])).toEqual(['hid', 'getevent -l']);
    // ...saw nothing, so the same key went again through input, exactly once.
    expect(runner.shellCommands().filter((c) => c.includes('input keyevent'))).toEqual([inputHoldScript('22', 300)]);
    expect(r.available).toBe(false);
    expect(r.holds()).toBe(false);
    expect(hidVerdict(SERIAL)).toMatchObject({ ok: false, reason: expect.stringMatching(/no key events/) });
    // Every watcher and the hid process are gone.
    expect(runner.spawned.every((s) => s.proc.killed)).toBe(true);
    // A new remote for the same device doesn't try again.
    const again = new HidRemote(adb, SERIAL, { registerWaitMs: 5 });
    await again.press(parseKeys(['left:300']));
    expect(runner.spawned).toHaveLength(2);
    expect(again.holds()).toBe(false);
  });

  it('gives up before sending anything when the device never shows up in getevent -lp', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/input keyevent/, '');
    const dev = fakeHidDevice(runner, { listed: false, delivers: false });
    const r = new HidRemote(adb, SERIAL, { registerWaitMs: 5 });
    await r.press(parseKeys(['ok:long']));
    expect(dev.hidLines.map((l) => JSON.parse(l).command)).toEqual(['register']);
    expect(runner.shellCommands().filter((c) => c.includes('input'))).toEqual(['input keyevent --longpress 23']);
    expect(hidVerdict(SERIAL)?.reason).toMatch(/never showed up/);
  });

  it('trusts it once getevent saw its keys, and stops watching after that', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/input keyevent/, '');
    const dev = fakeHidDevice(runner, { listed: true, delivers: true });
    const r = new HidRemote(adb, SERIAL, { registerWaitMs: 5 });
    expect(r.holds()).toBeUndefined();
    await r.press(parseKeys(['right:200']));
    expect(r.holds()).toBe(true);
    expect(hidVerdict(SERIAL)).toMatchObject({ ok: true, device: dev.path });
    await r.press(parseKeys(['left:200']));
    expect(runner.spawned.map((s) => s.args[3])).toEqual(['hid', 'getevent -l']);
    expect(runner.shellCommands().filter((c) => c.includes('input'))).toEqual([]);
    await r.close();
  });

  it('FIRELAB_REMOTE=hid still needs proof, and falls back on its own', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/input keyevent/, '');
    fakeHidDevice(runner, { listed: true, delivers: false });
    const r = new SmartRemote(adb, SERIAL, 'hid', { registerWaitMs: 5 });
    await r.press(parseKeys(['right:250']));
    expect(runner.shellCommands().filter((c) => c.includes('input keyevent'))).toEqual([inputHoldScript('22', 250)]);
    expect(r.holds()).toBe(false);
    expect(await r.holdPath()).toBe('input');
  });

  it('on Fire OS, holds use input until HID is verified, and probing puts no virtual remote on the TV', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/input keyevent/, '').on(/getprop ro.product.manufacturer/, 'Amazon\n');
    fakeHidDevice(runner, { listed: true, delivers: true });
    const r = new SmartRemote(adb, SERIAL, 'auto', { registerWaitMs: 5 });
    expect(await r.holdPath()).toBe('input');
    await r.press(parseKeys(['right:450']));
    expect(runner.spawned).toHaveLength(0);
    expect(runner.shellCommands().filter((c) => c.includes('input keyevent'))).toEqual([inputHoldScript('22', 450)]);
    expect(await r.probe()).toEqual({ holds: false });
    expect(runner.spawned).toHaveLength(0);
    expect(r.holds()).toBeUndefined();
  });

  it('the experimental keyboard profile registers a keyboard and sends 8-bit usages', () => {
    const reg = JSON.parse(registerCommand(1, HID_PROFILES.keyboard));
    expect(reg).toMatchObject({ name: 'FireLab Keyboard', pid: 2 });
    expect(reg.descriptor.slice(0, 4)).toEqual([0x05, 0x01, 0x09, 0x06]);
    const s = hidScript(parseKeys(['right:500', 'home']), { profile: HID_PROFILES.keyboard });
    expect(s.lines.slice(0, 3).map((l) => JSON.parse(l))).toEqual([
      { id: 1, command: 'report', report: [1, 0x4f] },
      { id: 1, command: 'delay', duration: 500 },
      { id: 1, command: 'report', report: [1, 0] },
    ]);
    expect(s.unsupported.map((k) => k.key)).toEqual(['home']);
  });
});
