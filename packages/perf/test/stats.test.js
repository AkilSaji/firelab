import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, sortedPercentile, median, createFrameStats, createFrameLimiter } from '../index.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

describe('percentile', () => {
  test('matches linear interpolation between closest ranks (NumPy default)', () => {
    const v = [15, 20, 35, 40, 50];
    close(percentile(v, 0), 15);
    close(percentile(v, 1), 50);
    close(percentile(v, 0.5), 35);
    close(percentile(v, 0.4), 29); // pos 1.6 -> 20 + 0.6 * 15
    close(percentile(v, 0.95), 48); // pos 3.8 -> 40 + 0.8 * 10
  });
  test('does not depend on input order and does not modify it', () => {
    const v = [50, 15, 40, 20, 35];
    close(percentile(v, 0.4), 29);
    assert.deepEqual(v, [50, 15, 40, 20, 35]);
  });
  test('edge cases', () => {
    assert.ok(Number.isNaN(percentile([], 0.5)));
    close(percentile([7], 0.95), 7);
    close(percentile([1, 2], 2), 2, 0); // clamped
    close(percentile([1, 2], -1), 1, 0);
    close(median([3, 1, 2, 10]), 2.5);
    close(sortedPercentile(Float32Array.from([1, 2, 3, 99]), 0.5, 3), 2);
  });
});

describe('createFrameStats', () => {
  function run(stats, fps, ms, start = 0) {
    const dt = 1000 / fps;
    let now = start;
    for (let t = 0; t < ms - 1e-9; t += dt) {
      now += dt;
      stats.push(dt, now);
    }
    return now;
  }

  test('fps over the last second', () => {
    const s = createFrameStats();
    const now = run(s, 30, 5000);
    close(s.fps(now), 30, 1e-4);
  });

  test('fps is right before a full second has passed', () => {
    const s = createFrameStats();
    const now = run(s, 30, 400);
    close(s.fps(now), 30, 1e-4);
  });

  test('fps drops to zero when frames stop', () => {
    const s = createFrameStats();
    const now = run(s, 60, 2000);
    assert.equal(s.fps(now + 1500), 0);
    assert.equal(createFrameStats().fps(100), 0);
  });

  test('p50 / p95 frame times', () => {
    const s = createFrameStats();
    let now = 0;
    for (let i = 0; i < 100; i++) {
      const dt = i % 10 === 9 ? 100 : 20; // every 10th frame is slow
      now += dt;
      s.push(dt, now);
    }
    const { p50, p95 } = s.frameMs(now);
    close(p50, 20);
    assert.ok(p95 >= 99 && p95 <= 100, `p95 ${p95}`);
  });

  test('median of per-second rates resists a single bad second', () => {
    const s = createFrameStats();
    let now = run(s, 30, 6000);
    now = run(s, 10, 1000, now); // one slow second
    now = run(s, 30, 3000, now);
    close(s.fpsMedian(), 30, 0.6);
  });

  test('the ring wraps without losing recent frames', () => {
    const s = createFrameStats({ capacity: 32 });
    const now = run(s, 60, 10000);
    assert.equal(s.count(), 600);
    // only 32 frames are kept: fps over a full second can't be counted, but frame times can
    close(s.frameMs(now).p50, 1000 / 60, 1e-4);
  });

  test('ignores invalid samples and resets', () => {
    const s = createFrameStats();
    s.push(NaN, 10);
    s.push(-1, 10);
    s.push(16, NaN);
    assert.equal(s.count(), 0);
    run(s, 30, 1000);
    s.reset();
    assert.equal(s.count(), 0);
    assert.equal(s.fpsMedian(), 0);
    assert.deepEqual(s.frameMs(5000), { p50: 0, p95: 0 });
  });
});

describe('createFrameLimiter', () => {
  function count(limiter, hz, ms, jitter = 0) {
    let rendered = 0;
    const dt = 1000 / hz;
    const frames = Math.round(ms / dt);
    for (let i = 1; i <= frames; i++) {
      const j = jitter ? (i % 2 ? jitter : -jitter) : 0;
      if (limiter.ready(i * dt + j)) rendered++;
    }
    return rendered;
  }
  test('30 fps on a 60 Hz display renders every other frame', () => {
    assert.equal(count(createFrameLimiter(30), 60, 10000), 300);
  });
  test('tolerates vsync jitter', () => {
    const n = count(createFrameLimiter(30), 60, 10000, 0.8);
    assert.ok(n >= 299 && n <= 301, `rendered ${n}`);
  });
  test('30 fps on a 120 Hz display renders every fourth frame', () => {
    assert.equal(count(createFrameLimiter(30), 120, 10000), 300);
  });
  test('0 disables the limit; setFps changes it', () => {
    const l = createFrameLimiter(0);
    assert.equal(count(l, 60, 1000), 60);
    assert.equal(l.fps, 0);
    l.setFps(20);
    assert.equal(l.fps, 20);
  });
  test('restarts after a stall instead of rendering a burst', () => {
    const l = createFrameLimiter(30);
    count(l, 60, 1000);
    assert.equal(l.ready(5000), true);
    assert.equal(l.ready(5016.7), false);
    assert.equal(l.ready(5033.4), true);
  });
});
