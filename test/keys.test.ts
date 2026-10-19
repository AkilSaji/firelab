import { describe, expect, it } from 'vitest';
import { keyCode, parseKeys, escapeInputText, InputKeyInjector, typeText, REMOTE_KEYS } from '../src/adb/keys.js';
import { fakeAdb, SERIAL } from './helpers/fake-adb.js';

describe('remote key names', () => {
  it('maps the contract names to Android key codes', () => {
    expect(keyCode('ok')).toBe(23);
    expect(keyCode('menu')).toBe(82);
    expect(keyCode('playpause')).toBe(85);
    expect(keyCode('rewind')).toBe(89);
    expect(keyCode('fastforward')).toBe(90);
    expect(keyCode('wake')).toBe(224);
    expect(keyCode('BACK')).toBe(4);
    expect(Object.keys(REMOTE_KEYS)).toHaveLength(16);
  });
  it('accepts aliases, numbers and KEYCODE_ names', () => {
    expect(keyCode('select')).toBe(23);
    expect(keyCode('ff')).toBe(90);
    expect(keyCode('66')).toBe(66);
    expect(keyCode('KEYCODE_CHANNEL_UP')).toBe(-1);
  });
  it('explains unknown keys', () => {
    expect(() => keyCode('jump')).toThrow(/Unknown key "jump"/);
  });
});

describe('parseKeys', () => {
  it('expands repeats, long presses and holds', () => {
    expect(parseKeys(['down*3', 'ok:long', 'right:1500']).map((k) => [k.key, k.mode, k.holdMs])).toEqual([
      ['down', 'press', undefined],
      ['down', 'press', undefined],
      ['down', 'press', undefined],
      ['ok', 'long', undefined],
      ['right', 'hold', 1500],
    ]);
  });
  it('splits space or comma separated strings and applies a default hold', () => {
    expect(parseKeys(['up, up ok'], { holdMs: 200 }).map((k) => `${k.key}:${k.mode}:${k.holdMs}`)).toEqual(['up:hold:200', 'up:hold:200', 'ok:hold:200']);
  });
  it('keeps raw keycode names', () => {
    expect(parseKeys(['KEYCODE_CHANNEL_UP'])[0]).toMatchObject({ key: 'KEYCODE_CHANNEL_UP', code: -1 });
  });
  it('rejects nonsense', () => {
    expect(() => parseKeys(['up*0'])).toThrow(/1-50/);
    expect(() => parseKeys(['up:99999'])).toThrow(/1-30000/);
    expect(() => parseKeys(['up;rm -rf /'])).toThrow(/Can't read key/);
  });
});

describe('InputKeyInjector', () => {
  it('sends a run of plain presses in one `input keyevent` call (one JVM start)', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/shell input keyevent/, '');
    await new InputKeyInjector(adb, SERIAL).press(parseKeys(['down', 'down', 'ok']));
    expect(runner.shellCommands()).toEqual(['input keyevent 20 20 23']);
  });

  it('splits around long presses and honours gaps', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/shell input keyevent/, '');
    await new InputKeyInjector(adb, SERIAL).press(parseKeys(['up', 'ok:long', 'KEYCODE_CHANNEL_UP']));
    expect(runner.shellCommands()).toEqual(['input keyevent 19', 'input keyevent --longpress 23', 'input keyevent KEYCODE_CHANNEL_UP']);
    runner.calls = [];
    const t0 = Date.now();
    await new InputKeyInjector(adb, SERIAL).press(parseKeys(['left', 'right']), { gapMs: 60 });
    expect(runner.shellCommands()).toEqual(['input keyevent 21', 'input keyevent 22']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  });
});

describe('text input', () => {
  it('quotes text for the device shell and spells spaces as %s', () => {
    expect(escapeInputText('hello world')).toBe("'hello%sworld'");
    expect(escapeInputText(`it's $HOME & "you"`)).toBe(`'it'\\''s%s$HOME%s&%s"you"'`);
  });
  it('refuses characters `input text` cannot type', () => {
    expect(() => escapeInputText('café')).toThrow(/ASCII/);
  });
  it('chunks long text', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/shell input text/, '');
    await typeText(adb, SERIAL, 'x'.repeat(170));
    expect(runner.shellCommands()).toHaveLength(3);
  });
});
