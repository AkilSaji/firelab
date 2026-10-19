import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAdaptiveResolution } from '../index.js';

/** Feeds frames at a constant rate for `ms` of controller time; returns the window results. */
function feed(ctrl, fps, ms) {
  const dt = 1000 / fps;
  const out = [];
  for (let t = 0; t < ms; t += dt) {
    const r = ctrl.frame(dt);
    if (r) out.push(r);
  }
  return out;
}

/** Simulates a device whose frame rate depends on the render scale. */
function simulate(ctrl, deviceFps, ms) {
  const out = [];
  let t = 0;
  while (t < ms) {
    const dt = 1000 / deviceFps(ctrl.scale);
    const r = ctrl.frame(dt);
    if (r) out.push({ ...r, t });
    t += dt;
  }
  return out;
}

function recorder(opts = {}) {
  const changes = [];
  const fallbacks = [];
  const ctrl = createAdaptiveResolution({
    ...opts,
    onChange: (scale, prev, why) => changes.push({ scale, prev, why }),
    onFallback: (f) => fallbacks.push(f),
  });
  return { ctrl, changes, fallbacks };
}

describe('adaptive resolution: stepping down', () => {
  test('steps down one notch per window under load, down to the floor', () => {
    const { ctrl, changes } = recorder();
    assert.equal(ctrl.scale, 0.75);
    feed(ctrl, 24, 20000);
    assert.deepEqual(
      changes.map((c) => c.scale),
      [0.65, 0.6],
    );
    assert.equal(ctrl.scale, 0.6);
    assert.ok(changes.every((c) => c.why === 'down'));
  });

  test('steps twice when far below target', () => {
    const { ctrl, changes } = recorder({ initialScale: 1 });
    feed(ctrl, 15, 5500);
    assert.equal(changes[0].scale, 0.8);
  });

  test('never goes below minScale or above maxScale', () => {
    const { ctrl } = recorder({ minScale: 0.5, maxScale: 0.9, initialScale: 2 });
    assert.equal(ctrl.scale, 0.9, 'initial scale is clamped');
    feed(ctrl, 5, 60000);
    assert.equal(ctrl.scale, 0.5);
    feed(ctrl, 30, 600000);
    assert.equal(ctrl.scale, 0.9);
  });

  test('reports "floor" when it cannot go lower', () => {
    const { ctrl } = recorder({ initialScale: 0.6 });
    const results = feed(ctrl, 24, 12000);
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r.action === 'floor'));
  });
});

describe('adaptive resolution: recovering', () => {
  test('raises again once the load is gone, one step per cooldown', () => {
    const { ctrl, changes } = recorder();
    feed(ctrl, 20, 15000);
    assert.equal(ctrl.scale, 0.6);
    const before = changes.length;
    feed(ctrl, 30, 60000);
    const ups = changes.slice(before);
    assert.ok(ups.length >= 3, `expected several raises, got ${ups.length}`);
    assert.ok(ups.every((c) => c.why === 'up'));
    for (const c of ups) assert.ok(Math.abs(c.scale - c.prev - 0.1) < 1e-9, 'one step at a time');
  });

  test('needs raiseAfter good windows and the cooldown before a raise', () => {
    const { ctrl, changes } = recorder({ initialScale: 0.6 });
    // warm-up 3 s, then 3 good windows (6 s) -> but cooldown is measured from start (no change yet), so the first raise comes at the 3rd good window.
    feed(ctrl, 30, 3000 + 2000 * 2 + 100);
    assert.equal(changes.length, 0, 'two good windows are not enough');
    feed(ctrl, 30, 2000);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].scale, 0.7);
    // Right after a change the cooldown (10 s) applies even if windows are good.
    feed(ctrl, 30, 8000);
    assert.equal(changes.length, 1, 'cooldown holds the next raise');
    feed(ctrl, 30, 4000);
    assert.equal(changes.length, 2);
  });

  test('holds inside the hysteresis band', () => {
    const { ctrl, changes } = recorder();
    const results = feed(ctrl, 28, 120000); // between dropBelow (27) and raiseAbove (28.5)
    assert.equal(changes.length, 0);
    assert.ok(results.every((r) => r.action === 'hold'));
  });

  test('reports "ceiling" at maxScale', () => {
    const { ctrl } = recorder({ initialScale: 1 });
    const results = feed(ctrl, 30, 10000);
    assert.ok(results.every((r) => r.action === 'ceiling'));
  });
});

describe('adaptive resolution: robustness', () => {
  test('ignores the warm-up period', () => {
    const { ctrl, changes } = recorder();
    feed(ctrl, 10, 2900);
    assert.equal(changes.length, 0);
    assert.equal(ctrl.state().measuring, false);
  });

  test('a single hitch in a window does not lower the resolution', () => {
    const { ctrl, changes } = recorder();
    feed(ctrl, 30, 3100); // warm-up
    for (let i = 0; i < 4; i++) {
      for (let f = 0; f < 59; f++) ctrl.frame(1000 / 30);
      ctrl.frame(400); // a garbage-collection pause
    }
    assert.equal(changes.filter((c) => c.why === 'down').length, 0);
  });

  test('ignores invalid frame durations', () => {
    const { ctrl } = recorder();
    for (const dt of [NaN, -5, 0, Infinity, undefined]) assert.equal(ctrl.frame(dt), null);
    assert.equal(ctrl.state().t, 0);
  });

  test('does not oscillate on a device that can only just hold a level', () => {
    // Fill-bound device, 30 fps cap: 0.85 holds 30 fps, 0.95 manages 24.
    const deviceFps = (s) => Math.min(30, 30 * (0.85 / s) ** 2);
    const { ctrl, changes } = recorder();
    const results = simulate(ctrl, deviceFps, 30 * 60000);
    const downs = changes.filter((c) => c.why === 'down').length;
    const slowWindows = results.filter((r) => r.fps < 27).length;
    // Retries are blocked for 3, 6, 12, 24 minutes: at most a handful in 30 minutes.
    assert.ok(downs <= 5, `expected few drops, got ${downs}`);
    assert.ok(slowWindows / results.length < 0.02, `slow windows ${slowWindows}/${results.length}`);
    assert.ok(ctrl.state().blocked.length >= 1);
    assert.ok(ctrl.state().blocked[0].strikes >= 2, 'repeat failures double the block');

    // Without blocking it would bounce every ~15 s.
    const naive = recorder({ blockMs: 0 });
    simulate(naive.ctrl, deviceFps, 30 * 60000);
    assert.ok(naive.changes.filter((c) => c.why === 'down').length > 50);
  });

  test('settles on the best level a device can hold', () => {
    // Fill-bound: fps proportional to 1/scale^2, enough headroom up to ~0.8.
    const deviceFps = (s) => Math.min(30, 31 * (0.8 / s) ** 2);
    const { ctrl } = recorder({ initialScale: 1 });
    simulate(ctrl, deviceFps, 10 * 60000);
    assert.ok(ctrl.scale >= 0.7 && ctrl.scale <= 0.8 + 1e-9, `settled at ${ctrl.scale}`);
  });

  test('works at 60 fps targets', () => {
    const { ctrl, changes } = recorder({ targetFps: 60 });
    feed(ctrl, 45, 10000);
    assert.ok(changes.length >= 1 && changes[0].why === 'down');
  });

  test('validates its options', () => {
    assert.throws(() => createAdaptiveResolution({ targetFps: 0 }), RangeError);
    assert.throws(() => createAdaptiveResolution({ minScale: 1, maxScale: 0.5 }), RangeError);
    assert.throws(() => createAdaptiveResolution({ dropBelow: 29, raiseAbove: 28 }), RangeError);
  });
});

describe('adaptive resolution: pause', () => {
  test('makes no decisions while paused', () => {
    const { ctrl, changes } = recorder();
    feed(ctrl, 30, 3100);
    ctrl.setPaused(true);
    assert.equal(ctrl.paused, true);
    const results = feed(ctrl, 8, 60000); // a video, a loading screen
    assert.equal(results.length, 0);
    assert.equal(changes.length, 0);
  });

  test('discards the partial window and settles after resuming', () => {
    const { ctrl, changes } = recorder();
    feed(ctrl, 30, 3100);
    feed(ctrl, 10, 1500); // 1.5 s of a slow partial window
    ctrl.setPaused(true);
    ctrl.setPaused(false);
    feed(ctrl, 10, 900); // inside the settle time: ignored
    assert.equal(changes.length, 0);
    feed(ctrl, 30, 2500);
    assert.equal(changes.length, 0, 'the slow frames before the pause were thrown away');
  });
});

describe('adaptive resolution: tier fallback', () => {
  test('fires once when the floor cannot hold the target', () => {
    const { ctrl, fallbacks } = recorder();
    feed(ctrl, 15, 60000);
    assert.equal(fallbacks.length, 1);
    assert.equal(fallbacks[0].scale, 0.6);
    assert.equal(fallbacks[0].windows, 4);
    assert.ok(fallbacks[0].fps < 22.5);
    assert.equal(ctrl.state().fallbackFired, true);
  });

  test('needs consecutive slow windows at the floor', () => {
    const { ctrl, fallbacks } = recorder({ initialScale: 0.6 });
    feed(ctrl, 30, 3100);
    for (let i = 0; i < 10; i++) {
      feed(ctrl, 15, 6000); // 3 slow windows
      feed(ctrl, 26, 2000); // then one that is slow-ish but above fallbackBelow
    }
    assert.equal(fallbacks.length, 0);
  });

  test('does not fire while above fallbackBelow, or when disabled', () => {
    const a = recorder();
    feed(a.ctrl, 25, 120000);
    assert.equal(a.fallbacks.length, 0);
    const b = recorder({ fallback: false });
    feed(b.ctrl, 10, 120000);
    assert.equal(b.fallbacks.length, 0);
  });

  test('reset() re-arms the fallback and returns to the initial scale', () => {
    const { ctrl, fallbacks, changes } = recorder();
    feed(ctrl, 15, 60000);
    ctrl.reset();
    assert.equal(ctrl.scale, 0.75);
    assert.equal(changes.at(-1).why, 'reset');
    assert.equal(ctrl.state().fallbackFired, false);
    feed(ctrl, 15, 60000);
    assert.equal(fallbacks.length, 2);
  });
});

describe('adaptive resolution: range and introspection', () => {
  test('setRange clamps the current scale', () => {
    const { ctrl, changes } = recorder({ initialScale: 1 });
    ctrl.setRange({ maxScale: 0.8 });
    assert.equal(ctrl.scale, 0.8);
    assert.equal(changes.at(-1).why, 'reset');
    assert.throws(() => ctrl.setRange({ minScale: 0.9 }), RangeError);
  });

  test('onWindow sees every evaluated window', () => {
    const seen = [];
    const ctrl = createAdaptiveResolution({ initialScale: 1, onWindow: (w) => seen.push(w) });
    feed(ctrl, 30, 3000 + 2000 * 5 + 50);
    assert.equal(seen.length, 5);
    assert.ok(seen.every((w) => typeof w.fps === 'number' && typeof w.action === 'string'));
  });

  test('exposes its resolved options', () => {
    const ctrl = createAdaptiveResolution({ targetFps: 30 });
    assert.equal(ctrl.options.dropBelow, 27);
    assert.equal(ctrl.options.raiseAbove, 28.5);
    assert.equal(ctrl.options.fallbackBelow, 22.5);
  });
});
