import { describe, expect, it } from 'vitest';
import { parseGeteventLine, KeyRecorder } from '../src/adb/getevent.js';
import { fakeAdb, SERIAL } from './helpers/fake-adb.js';

const SESSION = `add device 6: /dev/input/event5
  name:     "Amazon Fire TV Remote"
[   7790.101234] /dev/input/event5: EV_MSC       MSC_SCAN             000c0042
[   7790.101234] /dev/input/event5: EV_KEY       KEY_UP               DOWN
[   7790.101234] /dev/input/event5: EV_SYN       SYN_REPORT           00000000
[   7790.201234] /dev/input/event5: EV_KEY       KEY_UP               UP
[   7790.201234] /dev/input/event5: EV_SYN       SYN_REPORT           00000000
[   7791.000000] /dev/input/event5: EV_KEY       KEY_SELECT           DOWN
[   7791.500000] /dev/input/event5: EV_KEY       KEY_SELECT           REPEAT
[   7792.250000] /dev/input/event5: EV_KEY       KEY_SELECT           UP
[   7793.000000] /dev/input/event5: EV_KEY       KEY_BACK             DOWN
[   7793.080000] /dev/input/event5: EV_KEY       KEY_BACK             UP
`;

describe('parseGeteventLine', () => {
  it('reads labelled key events', () => {
    expect(parseGeteventLine('[   7790.101234] /dev/input/event5: EV_KEY       KEY_UP               DOWN')).toEqual({
      kernelTs: 7790.101234,
      device: '/dev/input/event5',
      linux: 'KEY_UP',
      key: 'up',
      action: 'down',
    });
  });
  it('reads unlabelled (hex) events', () => {
    expect(parseGeteventLine('[  10.5] /dev/input/event2: 0001 0161 00000001')).toMatchObject({ linux: 'KEY_SELECT', key: 'ok', action: 'down' });
    expect(parseGeteventLine('/dev/input/event2: 0001 00a4 00000000')).toMatchObject({ key: 'playpause', action: 'up' });
  });
  it('maps Fire TV remote keys to remote names', () => {
    const k = (code: string) => parseGeteventLine(`[1.0] /dev/input/event1: EV_KEY ${code} DOWN`)?.key;
    expect([k('KEY_HOMEPAGE'), k('KEY_MENU'), k('KEY_FASTFORWARD'), k('KEY_REWIND'), k('KEY_VOLUMEUP'), k('KEY_VOICECOMMAND'), k('KEY_F13')]).toEqual(['home', 'menu', 'fastforward', 'rewind', 'volup', 'search', 'f13']);
  });
  it('ignores sync, scan, touch and device lines', () => {
    expect(parseGeteventLine('[1.0] /dev/input/event5: EV_SYN SYN_REPORT 00000000')).toBeNull();
    expect(parseGeteventLine('[1.0] /dev/input/event2: EV_KEY BTN_TOUCH DOWN')).toBeNull();
    expect(parseGeteventLine('add device 6: /dev/input/event5')).toBeNull();
    expect(parseGeteventLine('  name:     "Amazon Fire TV Remote"')).toBeNull();
  });
});

describe('KeyRecorder', () => {
  it('records presses with hold times, skipping auto-repeat, across chunk boundaries', () => {
    const { adb } = fakeAdb();
    const rec = new KeyRecorder(adb, SERIAL);
    const seen: string[] = [];
    rec.on('key', (k) => seen.push(`${k.key}:${k.action}${k.holdMs !== undefined ? `:${k.holdMs}` : ''}`));
    const mid = Math.floor(SESSION.length / 2);
    rec.feed(SESSION.slice(0, mid), 1000);
    rec.feed(SESSION.slice(mid), 2000);
    expect(seen).toEqual(['up:down', 'up:up:100', 'ok:down', 'ok:up:1250', 'back:down', 'back:up:80']);
    expect(rec.keys).toHaveLength(6);
  });

  it('runs `getevent -lt` on the device and stops it', () => {
    const { adb, runner } = fakeAdb();
    const rec = new KeyRecorder(adb, SERIAL);
    rec.start();
    expect(runner.spawned[0]?.args).toEqual(['-s', SERIAL, 'shell', 'getevent -lt']);
    const got: string[] = [];
    rec.on('key', (k) => got.push(k.key));
    runner.spawned[0]?.proc.write('[ 1.0] /dev/input/event5: EV_KEY KEY_DOWN DOWN\n');
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(got).toEqual(['down']);
        rec.stop();
        expect(runner.spawned[0]?.proc.killed).toBe(true);
        resolve();
      }, 10);
    });
  });
});
