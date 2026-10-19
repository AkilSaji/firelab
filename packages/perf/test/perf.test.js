import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPerf, validateHook, threeAdapter } from '../index.js';
import { fakeEnv, memoryStorage, GE8300, GE9215 } from './helpers.js';

function setup(opts = {}, envOpts = {}) {
  const ctl = fakeEnv(envOpts);
  const scales = [];
  const adapter =
    opts.adapter === null
      ? undefined
      : opts.adapter ?? {
          canvas: null,
          setScale: (scale, info) => scales.push({ scale, ...info }),
        };
  const perf = createPerf({ detection: GE8300, env: ctl.env, adapter, ...opts });
  return { ctl, perf, scales, win: ctl.win };
}

/** Drives perf.frame() at a constant rate. */
function frames(ctl, perf, fps, ms) {
  const dt = 1000 / fps;
  for (let t = 0; t < ms; t += dt) {
    ctl.advance(dt);
    perf.frame(ctl.now);
  }
}

describe('createPerf: tier and hook', () => {
  test('publishes a valid window.firelab right away', () => {
    const { perf, win } = setup();
    assert.equal(win.firelab, perf.hook);
    assert.deepEqual(validateHook(win.firelab), []);
    assert.equal(win.firelab.version, '1');
    assert.equal(win.firelab.tier, 'tv');
    assert.equal(win.firelab.autoTier, 'tv');
    assert.equal(win.firelab.gpu, 'PowerVR Rogue GE8300');
    assert.equal(win.firelab.targetFps, 30);
    assert.equal(win.__firelabPerf, perf);
    assert.ok(!Object.keys(win).includes('__firelabPerf'), 'the API is not enumerable');
    assert.doesNotThrow(() => JSON.stringify(win.firelab));
  });

  test('?q= forces the tier (what the FireLab sweep uses)', () => {
    const { perf, win } = setup({}, { searchString: '?q=tv-hd' });
    assert.equal(perf.tier, 'tv-hd');
    assert.equal(perf.source, 'url');
    assert.equal(perf.autoTier, 'tv');
    assert.equal(win.firelab.tier, 'tv-hd');
    assert.equal(win.firelab.autoTier, 'tv');
  });

  test('tier from code, custom parameter name', () => {
    assert.equal(setup({ tier: 'low' }).perf.tier, 'low');
    assert.equal(setup({ param: 'quality' }, { searchString: '?quality=high&q=low' }).perf.tier, 'high');
  });

  test('targetFps can depend on the starting tier', () => {
    const fn = (tier, d) => (tier === 'high' ? 60 : d.isTv ? 30 : 45);
    assert.equal(setup({ targetFps: fn }).perf.targetFps, 30);
    assert.equal(setup({ targetFps: fn }, { searchString: '?q=high' }).perf.targetFps, 60);
    assert.equal(setup({ targetFps: 50 }).perf.hook.targetFps, 50);
    assert.equal(setup({ targetFps: () => NaN }).perf.targetFps, 30, 'nonsense falls back to 30');
  });

  test('pick() reads per-tier settings', () => {
    const { perf } = setup();
    assert.deepEqual(perf.pick({ low: { shadows: false }, 'tv-hd': { shadows: true } }), { shadows: false });
  });

  test('hook: false leaves window alone', () => {
    const { win } = setup({ hook: false });
    assert.equal(win.firelab, undefined);
    assert.equal(win.__firelabPerf, undefined);
  });

  test('marks and reported stats appear on the hook', () => {
    const { perf, win, ctl } = setup();
    perf.mark('scene', 'explore');
    perf.mark('enemies', 12);
    perf.report({ drawCalls: 175.4, triangles: 249360 });
    ctl.advance(300);
    assert.deepEqual(win.firelab.marks, { scene: 'explore', enemies: 12 });
    assert.equal(win.firelab.drawCalls, 175);
    assert.equal(win.firelab.triangles, 249360);
    assert.equal(win.firelab.heapMB, 54);
    perf.mark('enemies', undefined);
    assert.deepEqual(win.firelab.marks, { scene: 'explore' });
    assert.deepEqual(validateHook(win.firelab), []);
  });

  test('snapshot() is a detached JSON copy', () => {
    const { perf } = setup();
    const snap = perf.snapshot();
    snap.tier = 'high';
    assert.equal(perf.hook.tier, 'tv');
    assert.deepEqual(validateHook(snap), []);
  });
});

describe('createPerf: measuring', () => {
  test('counts requestAnimationFrame callbacks until the app reports frames', () => {
    const { perf, ctl, win } = setup({ adapter: null });
    for (let i = 0; i < 120; i++) ctl.raf(1000 / 30);
    ctl.advance(1);
    assert.ok(Math.abs(win.firelab.fps - 30) < 0.6, `fps ${win.firelab.fps}`);
    assert.ok(Math.abs(win.firelab.frameMs.p50 - 33.3) < 0.2);
    assert.equal(ctl.pendingRafs(), 1);
    perf.frame(ctl.now);
    ctl.raf(16);
    assert.equal(ctl.pendingRafs(), 0, 'the built-in loop stops once perf.frame() is used');
  });

  test('app-reported frames drive fps, frame times and the median', () => {
    const { perf, ctl, win } = setup({ adapter: null });
    frames(ctl, perf, 25, 12000);
    ctl.advance(1);
    assert.ok(Math.abs(win.firelab.fps - 25) < 0.6, `fps ${win.firelab.fps}`);
    assert.ok(Math.abs(win.firelab.fpsMedian - 25) < 0.6, `median ${win.firelab.fpsMedian}`);
    assert.equal(win.firelab.frameMs.p50, 40);
  });

  test('a long gap (hidden tab, stopped loop) is not counted as a frame', () => {
    const { perf, ctl, win } = setup({ adapter: null });
    frames(ctl, perf, 30, 2000);
    ctl.advance(20000);
    perf.frame(ctl.now);
    frames(ctl, perf, 30, 2100);
    ctl.advance(1);
    assert.ok(win.firelab.frameMs.p95 < 40, `p95 ${win.firelab.frameMs.p95}`);
  });
});

describe('createPerf: adaptive resolution', () => {
  test('starts at 0.75 of the tier budget: 960x540 on a tv-tier stick', () => {
    const { scales, win, ctl } = setup();
    assert.equal(scales.length, 1);
    assert.equal(scales[0].scale, 0.75);
    assert.equal(scales[0].pixelRatio, 1);
    assert.equal(scales[0].width, 960);
    assert.equal(scales[0].height, 540);
    ctl.advance(300);
    assert.equal(win.firelab.scale, 0.75);
    assert.deepEqual(win.firelab.canvas, { width: 960, height: 540 });
  });

  test('steps down under load to the 768x432 floor measured on the GE8300', () => {
    const { perf, scales, ctl, win } = setup();
    const events = [];
    perf.on('scale', (e) => events.push(e));
    frames(ctl, perf, 24, 20000);
    const last = scales.at(-1);
    assert.equal(last.scale, 0.6);
    assert.equal(last.pixelRatio, 0.8);
    assert.equal(last.width, 768);
    assert.equal(last.height, 432);
    assert.equal(events.length, 2);
    assert.equal(events[0].reason, 'down');
    ctl.advance(300);
    assert.equal(win.firelab.scale, 0.6);
  });

  test('tv-hd on the 4K Max gets a 1080p budget', () => {
    const { scales, perf, ctl } = setup({ detection: GE9215, adaptive: { initialScale: 1 } });
    assert.equal(perf.tier, 'tv-hd');
    assert.equal(scales[0].width, 1920);
    assert.equal(scales[0].height, 1080);
    frames(ctl, perf, 30, 30000);
    assert.equal(scales.length, 1, 'already at the ceiling');
  });

  test('pause() stops adaptation; reasons stack', () => {
    const { perf, scales, ctl, win } = setup();
    frames(ctl, perf, 30, 3100);
    perf.pause('video');
    perf.pause('menu');
    frames(ctl, perf, 10, 30000);
    assert.equal(scales.length, 1);
    perf.resume('video');
    assert.equal(perf.paused, true, 'still paused for the menu');
    ctl.advance(300);
    assert.equal(win.firelab.paused, true);
    perf.resume('menu');
    assert.equal(perf.paused, false);
    frames(ctl, perf, 10, 8000);
    assert.ok(scales.length > 1, 'adapts again after resuming');
  });

  test('the page going hidden pauses measurement', () => {
    const { perf, ctl } = setup();
    ctl.doc.visibilityState = 'hidden';
    ctl.doc.dispatch('visibilitychange');
    assert.equal(perf.paused, true);
    ctl.doc.visibilityState = 'visible';
    ctl.doc.dispatch('visibilitychange');
    assert.equal(perf.paused, false);
  });

  test('pauseWhileVideo pauses while a <video> plays', () => {
    const { perf, ctl } = setup({ pauseWhileVideo: true });
    const video = { tagName: 'VIDEO', paused: false, ended: false };
    ctl.doc.videos = [video];
    ctl.doc.dispatch('playing', { target: video });
    assert.equal(perf.paused, true);
    video.paused = true;
    ctl.doc.dispatch('pause', { target: video });
    assert.equal(perf.paused, false);
  });

  test('?scale= pins the scale and turns adaptation off', () => {
    const { perf, scales, ctl } = setup({}, { searchString: '?scale=0.8' });
    assert.equal(scales[0].scale, 0.8);
    frames(ctl, perf, 10, 30000);
    assert.equal(scales.length, 1);
    assert.equal(perf.adaptiveState(), null);
  });

  test('a window resize re-applies the scale', () => {
    const { scales, win } = setup();
    win.dispatch('resize');
    assert.equal(scales.length, 2);
    assert.equal(scales[1].scale, scales[0].scale);
  });

  test('attach() later (create perf first, then the renderer)', () => {
    const ctl = fakeEnv();
    const perf = createPerf({ detection: GE8300, env: ctl.env });
    assert.equal(perf.scaleInfo, null);
    const calls = [];
    const renderer = {
      domElement: { width: 0, height: 0, clientWidth: 960, clientHeight: 540 },
      info: { render: { calls: 42, triangles: 1234 } },
      setPixelRatio: (r) => calls.push(r),
    };
    perf.attach(renderer);
    assert.deepEqual(calls, [1]);
    renderer.domElement.width = 960;
    renderer.domElement.height = 540;
    ctl.advance(300);
    assert.equal(perf.hook.drawCalls, 42);
    assert.equal(perf.hook.triangles, 1234);
    assert.deepEqual(perf.hook.canvas, { width: 960, height: 540 });
    assert.throws(() => perf.attach({}), TypeError);
  });
});

describe('createPerf: tier fallback', () => {
  test('auto-picked tier that cannot hold the target falls back next launch', () => {
    const storage = memoryStorage();
    const { perf, ctl } = setup({ detection: GE9215 }, { storage });
    const events = [];
    perf.on('fallback', (e) => events.push(e));
    frames(ctl, perf, 14, 60000);
    assert.equal(events.length, 1);
    assert.deepEqual({ ...events[0], fps: undefined }, { from: 'tv-hd', to: 'tv', persisted: true, fps: undefined });
    const rec = JSON.parse(storage.getItem('firelab-tier:fallback'));
    assert.equal(rec.tier, 'tv');
    assert.equal(rec.gpu, 'PowerVR Rogue GE9215');
    perf.destroy();

    const next = setup({ detection: GE9215 }, { storage });
    assert.equal(next.perf.tier, 'tv');
    assert.equal(next.perf.source, 'fallback');
    next.perf.clearFallback();
    assert.equal(storage.getItem('firelab-tier:fallback'), null);
  });

  test('a forced tier is never overwritten, only reported', () => {
    const storage = memoryStorage();
    const { perf, ctl } = setup({}, { storage, searchString: '?q=tv-hd' });
    const events = [];
    perf.on('fallback', (e) => events.push(e));
    frames(ctl, perf, 14, 60000);
    assert.equal(events.length, 1);
    assert.equal(events[0].persisted, false);
    assert.equal(storage.map.size, 0);
  });

  test('fallback: false turns it off', () => {
    const { perf, ctl } = setup({ fallback: false, detection: GE9215 });
    const events = [];
    perf.on('fallback', (e) => events.push(e));
    frames(ctl, perf, 14, 60000);
    assert.equal(events.length, 0);
  });
});

describe('createPerf: setTier', () => {
  test('switches, persists, re-applies the budget and emits', () => {
    const storage = memoryStorage();
    const { perf, scales, win } = setup({}, { storage });
    const events = [];
    perf.on('tier', (e) => events.push(e));
    assert.equal(perf.setTier('tv-hd'), 'tv-hd');
    assert.equal(storage.getItem('firelab-tier'), 'tv-hd');
    assert.equal(perf.source, 'saved');
    assert.equal(win.firelab.tier, 'tv-hd');
    assert.deepEqual(events, [{ tier: 'tv-hd', prev: 'tv', source: 'saved' }]);
    assert.equal(scales.at(-1).maxPixelRatio, 2);
    perf.setTier('auto');
    assert.equal(perf.tier, 'tv');
    assert.equal(perf.source, 'auto');
    assert.equal(storage.getItem('firelab-tier'), null);
    assert.throws(() => perf.setTier('ultra-mega'), RangeError);
  });

  test('persist: false and reload: true', () => {
    const storage = memoryStorage();
    const { perf, ctl } = setup({}, { storage });
    perf.setTier('low', { persist: false });
    assert.equal(perf.source, 'code');
    assert.equal(storage.map.size, 0);
    perf.setTier('high', { reload: true });
    assert.equal(ctl.env.reloaded, 1);
  });
});

describe('createPerf: meter', () => {
  test('?perf=1 shows the meter and it draws', () => {
    const { perf, ctl } = setup({}, { searchString: '?perf=1' });
    assert.equal(perf.meter.visible, true);
    const canvas = ctl.doc.body.children[0];
    assert.ok(canvas);
    assert.equal(canvas.style.cssText.includes('pointer-events:none'), true);
    frames(ctl, perf, 30, 2000);
    assert.ok(canvas.ctx.calls.some(([m, text]) => m === 'fillText' && /fps/.test(String(text))));
  });

  test('a double tap of rewind toggles it; other keys do not', () => {
    const { perf, ctl, win } = setup();
    assert.equal(perf.meter.visible, false);
    const tap = (key) => {
      win.dispatch('keydown', { key, code: key });
      ctl.advance(80);
      win.dispatch('keyup', { key, code: key });
      ctl.advance(150);
    };
    tap('MediaRewind');
    assert.equal(perf.meter.visible, false);
    tap('MediaRewind');
    assert.equal(perf.meter.visible, true);
    tap('ArrowUp');
    tap('MediaRewind');
    tap('ArrowUp');
    tap('MediaRewind');
    assert.equal(perf.meter.visible, true, 'interrupted taps do not count');
    tap('MediaRewind');
    tap('MediaRewind');
    assert.equal(perf.meter.visible, false);
  });

  test('meter: false creates nothing and listens to nothing', () => {
    const { ctl, perf } = setup({ meter: false }, { searchString: '?perf=1' });
    assert.equal(perf.meter.visible, false);
    assert.equal(ctl.doc.body.children.length, 0);
    assert.equal(ctl.win.count('keyup'), 0);
  });
});

describe('createPerf: lifecycle', () => {
  test('destroy() removes the hook, timers and listeners', () => {
    const { perf, ctl, win } = setup({}, { searchString: '?perf=1' });
    assert.ok(ctl.intervals() > 0);
    perf.destroy();
    assert.equal(win.firelab, undefined);
    assert.equal(ctl.intervals(), 0);
    assert.equal(win.count('resize'), 0);
    assert.equal(win.count('keyup'), 0);
    assert.equal(ctl.doc.count('visibilitychange'), 0);
    assert.equal(ctl.doc.body.children.length, 0);
  });

  test('works with the three.js adapter end to end', () => {
    const ctl = fakeEnv();
    const ratios = [];
    const renderer = {
      domElement: { width: 960, height: 540, clientWidth: 960, clientHeight: 540 },
      info: { render: { calls: 175, triangles: 249360 } },
      setPixelRatio(r) {
        ratios.push(r);
        this.domElement.width = Math.round(960 * r);
        this.domElement.height = Math.round(540 * r);
      },
      getContext: () => null,
    };
    const perf = createPerf({ detection: GE8300, env: ctl.env, adapter: threeAdapter(renderer) });
    frames(ctl, perf, 24, 20000);
    ctl.advance(300);
    assert.equal(ratios.at(-1), 0.8);
    assert.deepEqual(perf.hook.canvas, { width: 768, height: 432 });
    assert.equal(perf.hook.drawCalls, 175);
    assert.deepEqual(validateHook(perf.hook), []);
  });
});
