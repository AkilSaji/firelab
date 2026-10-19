import { beforeEach, describe, expect, it } from 'vitest';
import { inputHoldScript, InputKeyInjector, parseKeys } from '../src/adb/keys.js';
import { parseGeteventDevices } from '../src/adb/getevent.js';
import { KernelKeyInjector, kernelKeyMap, sendeventScript, forgetSendeventVerdicts } from '../src/adb/sendevent.js';
import { SmartRemote, forgetHidVerdicts } from '../src/adb/hid.js';
import { fakeAdb, SERIAL } from './helpers/fake-adb.js';

const LP = `add device 1: /dev/input/event0
  name:     "mtk-kpd"
  events:
    KEY (0001): KEY_POWER
  input props:
    <none>
add device 2: /dev/input/event3
  name:     "AR Remote"
  events:
    KEY (0001): KEY_ESC               KEY_ENTER             KEY_UP                KEY_LEFT
                KEY_RIGHT             KEY_DOWN              KEY_MENU              KEY_BACK
                KEY_HOMEPAGE          KEY_PLAYPAUSE         KEY_SELECT
    MSC (0004): MSC_SCAN
  input props:
    <none>
add device 3: /dev/input/event9
  name:     "FireLab Remote 1a2b"
  events:
    KEY (0001): KEY_UP KEY_DOWN KEY_LEFT KEY_RIGHT
`;

beforeEach(() => {
  forgetHidVerdicts();
  forgetSendeventVerdicts();
});

describe('getevent -lp', () => {
  it('lists devices with names and the keys they declare', () => {
    const d = parseGeteventDevices(LP);
    expect(d.map((x) => [x.path, x.name])).toEqual([
      ['/dev/input/event0', 'mtk-kpd'],
      ['/dev/input/event3', 'AR Remote'],
      ['/dev/input/event9', 'FireLab Remote 1a2b'],
    ]);
    expect(d[1]?.keys).toEqual(['KEY_ESC', 'KEY_ENTER', 'KEY_UP', 'KEY_LEFT', 'KEY_RIGHT', 'KEY_DOWN', 'KEY_MENU', 'KEY_BACK', 'KEY_HOMEPAGE', 'KEY_PLAYPAUSE', 'KEY_SELECT']);
    expect(d[1]?.keys).not.toContain('MSC_SCAN');
  });

  it('reads the unlabelled form (hex codes)', () => {
    const d = parseGeteventDevices('add device 1: /dev/input/event2\n  name:     "ir"\n  events:\n    0001: 0067  006c  0069  006a\n          0161\n    0004: 0004\n');
    expect(d[0]?.keys).toEqual(['KEY_UP', 'KEY_DOWN', 'KEY_LEFT', 'KEY_RIGHT', 'KEY_SELECT']);
  });
});

describe('input-based holds', () => {
  it('emulate auto-repeat in one shell call: a press, ~400 ms, then presses every ~30 ms until the hold ends', () => {
    const s = inputHoldScript('22', 2000);
    expect(s).toContain('</proc/uptime');
    expect(s).toContain('e=$(( $(t) + 200 ))');
    expect(s.indexOf('input keyevent 22; sleep 0.400')).toBeGreaterThan(0);
    expect(s).toContain('while [ $(t) -lt $e ]; do input keyevent 22; sleep 0.030; done');
    // short holds don't wait past their end
    expect(inputHoldScript('23', 150)).toContain('input keyevent 23; sleep 0.150');
    expect(() => inputHoldScript('22; reboot', 100)).toThrow(/Bad key/);
  });

  it('InputKeyInjector sends each hold as one call, sized to the hold time', async () => {
    const { adb, runner } = fakeAdb();
    const timeouts: (number | undefined)[] = [];
    runner.on(/input keyevent/, (_a, o) => (timeouts.push(o?.timeoutMs), ''));
    await new InputKeyInjector(adb, SERIAL).press(parseKeys(['up', 'right:2000', 'ok:long']));
    expect(runner.shellCommands()).toEqual(['input keyevent 19', inputHoldScript('22', 2000), 'input keyevent --longpress 23']);
    expect(timeouts[1]).toBeGreaterThanOrEqual(22000);
  });
});

describe('sendevent (experimental true holds)', () => {
  it('picks the remote node and the key it declares, never a FireLab virtual remote', () => {
    const m = kernelKeyMap(parseGeteventDevices(LP));
    expect(m.get('right')).toEqual({ path: '/dev/input/event3', device: 'AR Remote', linux: 'KEY_RIGHT', code: 106 });
    expect(m.get('ok')).toMatchObject({ linux: 'KEY_SELECT', code: 353 });
    expect(m.get('back')).toMatchObject({ linux: 'KEY_BACK', code: 158 });
    expect(m.has('volup')).toBe(false);
  });

  it('writes down, SYN, hold, up, SYN in one script', () => {
    const m = kernelKeyMap(parseGeteventDevices(LP));
    const s = sendeventScript([{ key: m.get('right')!, holdMs: 2000 }, { key: m.get('ok')!, holdMs: 60 }], 100);
    expect(s).toBe(
      '{ sendevent /dev/input/event3 1 106 1; sendevent /dev/input/event3 0 0 0; sleep 2.000; sendevent /dev/input/event3 1 106 0; sendevent /dev/input/event3 0 0 0; sleep 0.100; ' +
        'sendevent /dev/input/event3 1 353 1; sendevent /dev/input/event3 0 0 0; sleep 0.060; sendevent /dev/input/event3 1 353 0; sendevent /dev/input/event3 0 0 0; } 2>&1',
    );
  });

  it('checks the node takes writes with an empty report, and holds for real when it does', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/getevent -lp/, LP).on(/sendevent \/dev\/input\/event3 0 0 0 2>&1; echo @@rc/, '@@rc=0\n').on(/^-s \S+ shell \{ sendevent/, '');
    const k = new KernelKeyInjector(adb, SERIAL);
    expect(k.holds()).toBeUndefined();
    await k.press(parseKeys(['right:1500']));
    expect(k.holds()).toBe(true);
    expect(runner.shellCommands().at(-1)).toContain('sleep 1.500; sendevent /dev/input/event3 1 106 0');
  });

  it('falls back to input when the node is not writable (SELinux or permissions)', async () => {
    const { adb, runner } = fakeAdb();
    runner
      .on(/getevent -lp/, LP)
      .on(/echo @@rc/, 'could not open /dev/input/event3, Permission denied\n@@rc=1\n')
      .on(/input keyevent/, '');
    const r = new SmartRemote(adb, SERIAL, 'sendevent');
    await r.press(parseKeys(['right:700']));
    expect(r.holds()).toBe(false);
    expect(runner.shellCommands().filter((c) => c.includes('input keyevent'))).toEqual([inputHoldScript('22', 700)]);
    expect(runner.shellCommands().some((c) => c.startsWith('{ sendevent'))).toBe(false);
  });
});
