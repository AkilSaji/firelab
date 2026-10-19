import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHookObject,
  updateHook,
  validateHook,
  HOOK_VERSION,
  createTapDetector,
  keyNames,
  computeScaleInfo,
  threeAdapter,
  babylonAdapter,
  pixiAdapter,
  canvasAdapter,
  autoAdapter,
  createMeter,
} from '../index.js';
import { fakeDocument } from './helpers.js';

describe('window.firelab hook', () => {
  test('has exactly the contract shape', () => {
    const h = createHookObject({ tier: 'tv', autoTier: 'tv', gpu: 'PowerVR Rogue GE8300' });
    assert.deepEqual(Object.keys(h).sort(), ['autoTier', 'canvas', 'fps', 'fpsMedian', 'frameMs', 'gpu', 'marks', 'paused', 'scale', 'targetFps', 'tier', 'version']);
    assert.equal(h.version, HOOK_VERSION);
    assert.equal(HOOK_VERSION, '1');
    assert.deepEqual(validateHook(h), []);
  });

  test('updates in place with readable rounding', () => {
    const h = createHookObject({ tier: 'tv', autoTier: 'tv' });
    const frameMs = h.frameMs;
    const same = updateHook(h, { fps: 27.4321, fpsMedian: 26.94, p50: 36.123, p95: 51.98, scale: 0.8000001, width: 767.6, height: 432.2, drawCalls: 175.2, triangles: 249360, heapMB: 54.4 });
    assert.equal(same, h);
    assert.equal(h.frameMs, frameMs, 'nested objects are reused');
    assert.deepEqual(JSON.parse(JSON.stringify(h)), {
      version: '1',
      tier: 'tv',
      autoTier: 'tv',
      gpu: '',
      fps: 27.4,
      fpsMedian: 26.9,
      frameMs: { p50: 36.1, p95: 52 },
      scale: 0.8,
      canvas: { width: 768, height: 432 },
      marks: {},
      paused: false,
      targetFps: 30,
      drawCalls: 175,
      triangles: 249360,
      heapMB: 54,
    });
  });

  test('optional fields: undefined keeps, null removes', () => {
    const h = createHookObject({ tier: 'tv', autoTier: 'tv' });
    updateHook(h, { drawCalls: 10 });
    updateHook(h, { fps: 30 });
    assert.equal(h.drawCalls, 10);
    updateHook(h, { drawCalls: null, heapMB: NaN });
    assert.equal('drawCalls' in h, false);
    assert.equal('heapMB' in h, false);
  });

  test('validateHook finds problems', () => {
    assert.deepEqual(validateHook(null), ['not an object']);
    const bad = { version: '2', tier: 'ultra', autoTier: 'tv', gpu: 1, fps: 'x', fpsMedian: NaN, frameMs: {}, scale: 1, canvas: null, marks: [], drawCalls: 'many' };
    const errors = validateHook(bad);
    for (const needle of ['version', 'tier must', 'gpu', 'fps must', 'fpsMedian', 'frameMs.p50', 'canvas', 'marks', 'drawCalls']) {
      assert.ok(errors.some((e) => e.includes(needle)), `expected an error about ${needle}: ${errors.join('; ')}`);
    }
  });
});

describe('meter toggle keys', () => {
  const press = (d, key, at, hold = 80, extra = {}) => {
    const a = d.handle({ type: 'keydown', key, code: key, ...extra }, at);
    const b = d.handle({ type: 'keyup', key, code: key, ...extra }, at + hold);
    return a || b;
  };

  test('two quick taps of rewind', () => {
    const d = createTapDetector();
    assert.equal(press(d, 'MediaRewind', 1000), false);
    assert.equal(press(d, 'MediaRewind', 1300), true);
    assert.equal(press(d, 'MediaRewind', 1600), false, 'the count restarts');
  });

  test('too slow, too long, or interrupted does not count', () => {
    const d = createTapDetector();
    press(d, 'MediaRewind', 0);
    assert.equal(press(d, 'MediaRewind', 2000), false, 'too far apart');
    assert.equal(press(d, 'MediaRewind', 2300, 900), false, 'held, not tapped');
    press(d, 'MediaRewind', 4000);
    press(d, 'ArrowLeft', 4150);
    assert.equal(press(d, 'MediaRewind', 4300), false, 'another key in between');
  });

  test('held keys repeat keydown: only the keyup counts', () => {
    const d = createTapDetector();
    d.handle({ type: 'keydown', key: 'MediaRewind' }, 0);
    d.handle({ type: 'keydown', key: 'MediaRewind' }, 30);
    d.handle({ type: 'keydown', key: 'MediaRewind' }, 60);
    d.handle({ type: 'keyup', key: 'MediaRewind' }, 90);
    assert.equal(press(d, 'MediaRewind', 300), true);
  });

  test('keyCode-only TV remotes (227, 412) and the keyboard backquote', () => {
    const d = createTapDetector();
    press(d, '', 0, 80, { keyCode: 227 });
    assert.equal(press(d, '', 200, 80, { keyCode: 227 }), true);
    press(d, '`', 1000, 80, { code: 'Backquote' });
    assert.equal(d.handle({ type: 'keydown', key: '`', code: 'Backquote' }, 1200) || d.handle({ type: 'keyup', key: '`', code: 'Backquote' }, 1250), true);
    assert.deepEqual(keyNames({ key: 'Unidentified', keyCode: 412 }), ['Unidentified', 'MediaRewind']);
  });

  test('ignored while typing in a text field', () => {
    const d = createTapDetector();
    const target = { tagName: 'INPUT' };
    press(d, 'MediaRewind', 0, 80, { target });
    assert.equal(press(d, 'MediaRewind', 200, 80, { target }), false);
  });

  test('custom keys and tap count', () => {
    const d = createTapDetector({ keys: ['F9'], taps: 3 });
    press(d, 'F9', 0);
    press(d, 'F9', 200);
    assert.equal(press(d, 'F9', 400), true);
    assert.equal(press(d, 'MediaRewind', 600), false);
  });
});

describe('scale maths and adapters', () => {
  test('Fire TV Stick tv tier: scale 0.6 = 768x432, 1.0 = 1280x720', () => {
    const v = { maxHeight: 720, cssWidth: 960, cssHeight: 540, devicePixelRatio: 2 };
    const lo = computeScaleInfo(0.6, v);
    assert.equal(lo.pixelRatio, 0.8);
    assert.deepEqual([lo.width, lo.height], [768, 432]);
    const hi = computeScaleInfo(1, v);
    assert.deepEqual([hi.width, hi.height], [1280, 720]);
    assert.ok(Math.abs(hi.maxPixelRatio - 4 / 3) < 1e-9);
  });

  test('never renders above the screen: the budget is capped by devicePixelRatio', () => {
    const i = computeScaleInfo(1, { maxHeight: 1440, cssWidth: 1280, cssHeight: 720, devicePixelRatio: 1 });
    assert.deepEqual([i.width, i.height, i.pixelRatio], [1280, 720, 1]);
  });

  test('zero-sized layouts fall back to 1280x720 instead of a 0px buffer', () => {
    const i = computeScaleInfo(1, { maxHeight: 720, cssWidth: 0, cssHeight: 0, devicePixelRatio: 1 });
    assert.deepEqual([i.width, i.height], [1280, 720]);
  });

  test('three.js adapter', () => {
    const calls = [];
    const r = { domElement: {}, setPixelRatio: (x) => calls.push(x), info: { render: { calls: 3, triangles: 99 } }, getContext: () => 'gl' };
    const a = threeAdapter(r);
    a.setScale(0.5, { pixelRatio: 0.66 });
    assert.deepEqual(calls, [0.66]);
    assert.deepEqual(a.stats(), { drawCalls: 3, triangles: 99 });
    assert.equal(a.gl, 'gl');
    assert.equal(autoAdapter(r).name, 'three');
  });

  test('Babylon adapter', () => {
    const calls = [];
    const engine = { setHardwareScalingLevel: (l) => calls.push(['level', l]), resize: () => calls.push(['resize']), getRenderingCanvas: () => 'canvas', _drawCalls: { current: 12 } };
    const a = babylonAdapter(engine, { scene: { getActiveIndices: () => 300 } });
    a.setScale(1, { pixelRatio: 2 });
    assert.deepEqual(calls, [['level', 0.5], ['resize']]);
    assert.deepEqual(a.stats(), { drawCalls: 12, triangles: 100 });
    assert.equal(a.canvas, 'canvas');
    assert.equal(autoAdapter(engine).name, 'babylon');
  });

  test('Pixi adapter (v7 view / v8 canvas)', () => {
    const resized = [];
    const app = { renderer: { resolution: 1, resize: (w, h) => resized.push([w, h]) }, screen: { width: 960, height: 540 }, view: 'v7canvas' };
    const a = pixiAdapter(app);
    a.setScale(1, { pixelRatio: 1.5 });
    assert.equal(app.renderer.resolution, 1.5);
    assert.deepEqual(resized, [[960, 540]]);
    assert.equal(a.canvas, 'v7canvas');
    assert.equal(autoAdapter(app).name, 'pixi');
  });

  test('canvas adapter sets the buffer, the viewport and calls back', () => {
    const canvas = { width: 1, height: 1, getContext() {} };
    const viewport = [];
    const resized = [];
    const a = canvasAdapter(canvas, { gl: { viewport: (...v) => viewport.push(v) }, onResize: (...r) => resized.push(r) });
    a.setScale(0.6, { width: 768, height: 432, pixelRatio: 0.8 });
    assert.deepEqual([canvas.width, canvas.height], [768, 432]);
    assert.deepEqual(viewport, [[0, 0, 768, 432]]);
    assert.deepEqual(resized, [[768, 432, 0.8]]);
    assert.equal(autoAdapter(canvas).name, 'canvas');
  });

  test('autoAdapter passes adapters through and rejects unknowns', () => {
    const custom = { setScale() {} };
    assert.equal(autoAdapter(custom), custom);
    assert.equal(autoAdapter({}), null);
    assert.equal(autoAdapter(null), null);
  });
});

describe('meter', () => {
  const data = { fps: 27.4, fpsMedian: 26.9, targetFps: 30, p50: 36.1, p95: 52, scale: 0.8, width: 768, height: 432, tier: 'tv', tierSource: 'auto', gpu: 'PowerVR Rogue GE8300', drawCalls: 175, triangles: 249360, heapMB: 54, paused: false };

  test('creates nothing until shown, then draws a few times a second', () => {
    const doc = fakeDocument();
    const m = createMeter({ document: doc, devicePixelRatio: 2 });
    m.update(data);
    assert.equal(doc.body.children.length, 0, 'hidden meters cost nothing');
    m.show();
    const canvas = doc.body.children[0];
    assert.equal(canvas.width, 268 * 2);
    assert.match(canvas.style.cssText, /position:fixed/);
    const texts = canvas.ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
    assert.ok(texts.includes('27.4'));
    assert.ok(texts.some((t) => /p50 36\.1/.test(t)));
    assert.ok(texts.some((t) => /768×432/.test(t) && /tv \(auto\)/.test(t)));
    assert.ok(texts.some((t) => /GE8300/.test(t) && /175 dc/.test(t) && /249k tri/.test(t)));
    assert.equal(m.toggle(), false);
    assert.equal(doc.body.children.length, 0);
    m.destroy();
  });

  test('shows why measurement is paused', () => {
    const doc = fakeDocument();
    const m = createMeter({ document: doc });
    m.show();
    m.update({ ...data, paused: true, pauseReason: 'video' });
    const texts = doc.body.children[0].ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
    assert.ok(texts.some((t) => /paused · video/.test(t)));
  });

  test('without a document it is a harmless no-op', () => {
    const m = createMeter({ document: null });
    assert.doesNotThrow(() => {
      m.show();
      m.update(data);
      m.hide();
    });
  });
});
