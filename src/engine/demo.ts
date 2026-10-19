/**
 * `firelab demo`: the real engine against a simulated TV game, so anyone can
 * see FireLab work in a minute with no Fire TV, no Android SDK and no adb.
 *
 * "Lantern Lake" is a tiny game that lives inside a FakeDriver: a title screen,
 * a lake you steer a boat on, and a pause menu with D-pad focus. It carries six
 * seeded bugs, the same kinds examples/web-game/bugs.js plants in Firefly Lake:
 * a crash, a JS exception, a black screen, a frozen render loop, a focus trap
 * and an unreachable menu item. Time is virtual: ten minutes of device time
 * take a few seconds, and a seed gives the same run every time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FakeDriver } from '../driver/fake.js';
import type { KeySpec } from '../driver/types.js';
import type { Clock } from './clock.js';
import type { DeviceDriver } from './driver.js';
import type { ExploreEvent } from './explorer.js';

export const DEMO_PACKAGE = 'dev.firelab.demo';
export type DemoBug = 'crash' | 'throw' | 'black' | 'freeze' | 'trap' | 'hidden';
export const DEMO_BUGS: readonly DemoBug[] = ['crash', 'throw', 'black', 'freeze', 'trap', 'hidden'];

/** A clock that jumps forward on every sleep: a "10 minute" run takes milliseconds. */
export class VirtualClock implements Clock {
  t: number;
  constructor(start = Date.UTC(2026, 9, 16, 10, 0, 0)) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += Math.max(0, ms);
  }
}

// ---------- a tiny raster: rectangles, triangles, gradients and a 5x7 font ----------

const W = 320;
const H = 180;
type RGB = [number, number, number];

const FONT: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31], '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 2, 4, 8, 31], '3': [31, 2, 4, 2, 1, 17, 14], '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8], '8': [14, 17, 17, 14, 17, 17, 14], '9': [14, 17, 17, 15, 1, 2, 12],
  ':': [0, 12, 12, 0, 12, 12, 0], '-': [0, 0, 0, 31, 0, 0, 0], '.': [0, 0, 0, 0, 0, 12, 12], '!': [4, 4, 4, 4, 4, 0, 4],
};

class Canvas {
  readonly data = new Uint8Array(W * H * 4);
  px(x: number, y: number, c: RGB, a = 1): void {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (Math.floor(y) * W + Math.floor(x)) * 4;
    const d = this.data;
    d[o] = Math.round((d[o] as number) * (1 - a) + c[0] * a);
    d[o + 1] = Math.round((d[o + 1] as number) * (1 - a) + c[1] * a);
    d[o + 2] = Math.round((d[o + 2] as number) * (1 - a) + c[2] * a);
    d[o + 3] = 255;
  }
  rect(x: number, y: number, w: number, h: number, c: RGB, a = 1): void {
    for (let j = Math.max(0, Math.floor(y)); j < Math.min(H, y + h); j++) for (let i = Math.max(0, Math.floor(x)); i < Math.min(W, x + w); i++) this.px(i, j, c, a);
  }
  vgrad(y0: number, y1: number, top: RGB, bottom: RGB): void {
    for (let y = y0; y < y1; y++) {
      const t = (y - y0) / Math.max(1, y1 - y0 - 1);
      this.rect(0, y, W, 1, [top[0] + (bottom[0] - top[0]) * t, top[1] + (bottom[1] - top[1]) * t, top[2] + (bottom[2] - top[2]) * t]);
    }
  }
  tri(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, c: RGB): void {
    const minX = Math.floor(Math.min(ax, bx, cx));
    const maxX = Math.ceil(Math.max(ax, bx, cx));
    const minY = Math.floor(Math.min(ay, by, cy));
    const maxY = Math.ceil(Math.max(ay, by, cy));
    const e = (x0: number, y0: number, x1: number, y1: number, x: number, y: number) => (x1 - x0) * (y - y0) - (y1 - y0) * (x - x0);
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const w0 = e(bx, by, cx, cy, x, y);
        const w1 = e(cx, cy, ax, ay, x, y);
        const w2 = e(ax, ay, bx, by, x, y);
        if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) this.px(x, y, c);
      }
  }
  text(s: string, x: number, y: number, c: RGB, scale = 1): void {
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const g = FONT[ch];
      if (g) for (let r = 0; r < 7; r++) for (let b = 0; b < 5; b++) if (((g[r] as number) >> (4 - b)) & 1) this.rect(cx + b * scale, y + r * scale, scale, scale, c);
      cx += 6 * scale;
    }
  }
  textWidth(s: string, scale = 1): number {
    return s.length * 6 * scale - scale;
  }
}

// ---------- the game ----------

const ITEMS = ['resume', 'busy', 'quality', 'meter', 'quit'] as const;
const LABELS: Record<string, string> = { resume: 'Resume', busy: 'Busy scene: off', quality: 'Quality: auto', meter: 'Perf meter', quit: 'Back to title', credits: 'Credits' };
type Mode = 'title' | 'playing' | 'menu';

/** Menu rows in the 320x180 picture; the probe reports them scaled to a 1920x1080 page. */
const ROW = { x: 100, y: 52, w: 120, h: 15, gap: 18 };

export class DemoGame {
  readonly driver: FakeDriver;
  readonly clock: VirtualClock;
  readonly bugs: Set<DemoBug>;
  mode: Mode = 'title';
  item = 0;
  lane = 1;
  lanterns = 0;
  errors = 0;
  lastError = '';
  visitedQuality = false;
  black = false;
  frozen = false;
  frozenAt = 0;
  rights = 0;
  resumedAt = -Infinity;
  launches = 0;
  /** Device time per call, in virtual ms: roughly a Fire TV over Wi-Fi. */
  costs = { press: 450, screenshot: 700, evaluate: 60 };

  constructor(bugs: readonly DemoBug[] = DEMO_BUGS, opts: { clock?: VirtualClock } = {}) {
    this.clock = opts.clock ?? new VirtualClock();
    this.bugs = new Set(bugs);
    const d = new FakeDriver({
      serial: 'demo-tv',
      caps: { eval: true, console: false, holds: true, cdp: false, memory: false, measure: false, recordKeys: false },
      info: { model: 'DEMO', name: 'Simulated Fire TV (demo)', os: 'Simulated Fire OS', ramMB: 1024, tier: 'tv', resolution: { width: 1920, height: 1080 } },
      screen: { width: W, height: H },
      launcher: 'com.amazon.tv.launcher',
    });
    this.driver = d;
    d.on('launch', async (app) => {
      this.clock.t += 2500;
      this.reset();
      this.launches++;
      return d.base.launch(app);
    });
    d.on('press', async (keys: KeySpec[], o?: { gapMs?: number }) => {
      for (const [i, k] of keys.entries()) {
        if (i > 0) this.clock.t += o?.gapMs ?? 0;
        this.clock.t += this.costs.press / keys.length;
        if (d.state.foreground?.package === DEMO_PACKAGE) this.key(k.key);
        if (k.key === 'home') await d.base.press([k]);
      }
    });
    d.on('evaluate', async (expr: string) => {
      this.clock.t += this.costs.evaluate;
      if (d.state.foreground?.package !== DEMO_PACKAGE) throw new Error('no webview');
      if (expr.includes('FIRELAB_ENGINE_PROBE_INSTALL')) return true;
      if (expr.includes('FIRELAB_ENGINE_PROBE_FOCUSABLES')) return this.focusables();
      if (expr.includes('FIRELAB_ENGINE_PROBE_READ')) return this.probe();
      return undefined;
    });
    d.on('screenshot', async (o?: { format?: 'jpeg' | 'png' | 'rgba'; width?: number; quality?: number }) => {
      this.clock.t += this.costs.screenshot;
      return d.base.screenshot(o);
    });
    d.setFrame(() => this.frame());
  }

  /** The driver, typed for the engine. */
  get engineDriver(): DeviceDriver {
    return this.driver as unknown as DeviceDriver;
  }

  reset(): void {
    Object.assign(this, { mode: 'title', item: 0, lane: 1, lanterns: 0, errors: 0, lastError: '', visitedQuality: false, black: false, frozen: false, rights: 0, resumedAt: -Infinity });
  }

  private exit(): void {
    this.driver.state.foreground = { package: 'com.amazon.tv.launcher' };
  }

  private menuMove(dir: 1 | -1): void {
    if (this.bugs.has('trap') && this.visitedQuality) {
      const ring = [1, 2, 3];
      const at = Math.max(0, ring.indexOf(this.item));
      this.item = ring[(at + dir + ring.length) % ring.length] as number;
    } else this.item = (this.item + dir + ITEMS.length) % ITEMS.length; // the 6th item (Credits) is never in the cycle
    if (ITEMS[this.item] === 'quality') this.visitedQuality = true;
  }

  key(k: string): void {
    const t = this.clock.now();
    switch (this.mode) {
      case 'title':
        if (k === 'ok' || k === 'playpause') this.mode = 'playing';
        else if (k === 'menu') (this.mode = 'menu'), (this.item = 0);
        else if (k === 'back') this.exit();
        return;
      case 'playing':
        if (k === 'left') this.lane = Math.max(0, this.lane - 1);
        else if (k === 'right') {
          this.lane = Math.min(2, this.lane + 1);
          this.lanterns = Math.min(9, this.lanterns + 1);
          if (this.bugs.has('freeze') && ++this.rights >= 4 && !this.frozen) (this.frozen = true), (this.frozenAt = t);
        } else if (k === 'ok' && this.bugs.has('black') && t - this.resumedAt < 300) this.black = true;
        else if (k === 'back' || k === 'menu') (this.mode = 'menu'), (this.item = 0);
        return;
      case 'menu': {
        const it = ITEMS[this.item];
        if (k === 'up') this.menuMove(-1);
        else if (k === 'down') this.menuMove(1);
        else if (k === 'left' && it === 'quality' && this.bugs.has('throw')) {
          this.errors++;
          this.lastError = "Cannot read properties of undefined (reading 'label')@game.js:301";
        } else if (k === 'ok') {
          if (it === 'resume') (this.mode = 'playing'), (this.resumedAt = t);
          else if (it === 'quit') this.mode = 'title';
          else if (it === 'meter' && this.bugs.has('crash')) {
            const pid = this.driver.state.running.get(DEMO_PACKAGE);
            for (const text of ['FATAL EXCEPTION: main', `Process: ${DEMO_PACKAGE}, PID: ${pid}`, 'java.lang.IllegalStateException: perf meter overlay already attached', '\tat dev.firelab.demo.Meter.show(Meter.java:42)', '\tat dev.firelab.demo.Menu.select(Menu.java:88)'])
              this.driver.state.logs.push({ ts: t + 1, level: 'error', tag: 'AndroidRuntime', pid, text });
            this.driver.state.running.delete(DEMO_PACKAGE);
            this.exit();
          }
        } else if (k === 'back' && !(this.bugs.has('trap') && this.visitedQuality)) (this.mode = 'playing'), (this.resumedAt = -Infinity);
        return;
      }
    }
  }

  /** Frames drawn so far (stops counting when the render loop freezes). */
  raf(): number {
    return Math.floor((this.frozen ? this.frozenAt : this.clock.now()) / 33);
  }

  private ids(): string[] {
    return this.bugs.has('hidden') ? [...ITEMS, 'credits'] : [...ITEMS];
  }

  private rect(i: number): [number, number, number, number] {
    return [ROW.x * 6, (ROW.y + i * ROW.gap) * 6, ROW.w * 6, ROW.h * 6];
  }

  focusables() {
    if (this.mode !== 'menu') return [];
    return this.ids().map((id, i) => ({ id: `#menu-${id}`, rect: this.rect(i), text: LABELS[id] }));
  }

  probe() {
    const p: Record<string, unknown> = {
      url: '/lantern-lake/',
      title: 'Lantern Lake',
      hook: true,
      raf: this.raf(),
      rafSource: 'draws',
      errors: this.errors,
      paused: this.mode === 'menu',
      targetFps: 30,
      scene: this.mode,
      viewport: [1920, 1080],
      app: { mode: this.mode, item: this.mode === 'menu' ? ITEMS[this.item] : null, lane: this.mode === 'playing' ? this.lane : null },
    };
    if (this.lastError) p.lastError = this.lastError;
    if (this.mode === 'menu') {
      const id = ITEMS[this.item] as string;
      p.focus = { id: `#menu-${id}`, rect: this.rect(this.item), text: LABELS[id] };
    }
    return p;
  }

  frame() {
    const c = new Canvas();
    if (this.black) return { width: W, height: H, data: c.data.fill(0).map((v, i) => (i % 4 === 3 ? 255 : 0)) };
    const t = (this.frozen ? this.frozenAt : this.clock.now()) / 1000;
    this.scenery(c, t);
    if (this.mode === 'title') {
      const title = 'LANTERN LAKE';
      c.rect(60, 34, 200, 46, [24, 14, 44], 0.55);
      c.text(title, (W - c.textWidth(title, 3)) / 2, 44, [255, 214, 140], 3);
      const cta = 'PRESS OK TO SAIL';
      c.text(cta, (W - c.textWidth(cta)) / 2, 94, [255, 244, 236]);
      c.text('FIRELAB DEMO GAME', (W - c.textWidth('FIRELAB DEMO GAME')) / 2, 108, [200, 180, 210]);
    } else if (this.mode === 'playing') this.play(c, t);
    else this.menu(c);
    return { width: W, height: H, data: c.data };
  }

  private scenery(c: Canvas, t: number): void {
    c.vgrad(0, 78, [70, 40, 110], [250, 140, 110]);
    c.rect(150, 58, 24, 24, [255, 200, 120], 0.9); // the sun
    c.vgrad(78, H, [90, 60, 130], [30, 24, 70]);
    for (let i = 0; i < 9; i++) {
      const x = (i * 41 + 13) % W;
      c.tri(x - 14, 80, x + 14, 80, x, 52 + (i % 3) * 6, [28, 22, 50]); // pines on the far shore
    }
    for (let i = 0; i < 6; i++) c.rect(((i * 57 + t * 20) % W) | 0, 100 + i * 12, 30, 1, [200, 160, 220], 0.35); // ripples
  }

  private play(c: Canvas, t: number): void {
    const laneX = [110, 160, 210];
    for (const x of laneX) for (let y = 86; y < H; y += 8) c.rect(x - 1, y, 2, 4, [180, 160, 220], 0.25);
    for (let i = 0; i < 5; i++) {
      const y = 86 + ((i * 23 + t * 40) % 90);
      const x = laneX[(i * 2 + 1) % 3] as number;
      c.rect(x - 3, y - 3, 6, 6, [255, 210, 110]);
      c.rect(x - 5, y - 5, 10, 10, [255, 200, 120], 0.25);
    }
    const bx = laneX[this.lane] as number;
    c.tri(bx - 12, 160, bx + 12, 160, bx, 166, [240, 225, 200]);
    c.tri(bx - 1, 158, bx - 1, 136, bx + 11, 156, [230, 120, 90]);
    c.rect(6, 6, 76, 15, [20, 12, 40], 0.6);
    c.text(`LANTERNS ${this.lanterns}`, 10, 10, [255, 220, 150]);
  }

  private menu(c: Canvas): void {
    c.rect(0, 0, W, H, [16, 10, 30], 0.45);
    c.rect(ROW.x - 12, 22, ROW.w + 24, 18 + this.ids().length * ROW.gap + 8, [28, 18, 52], 0.85);
    c.text('PAUSED', (W - c.textWidth('PAUSED', 2)) / 2, 28, [255, 240, 230], 2);
    this.ids().forEach((id, i) => {
      const y = ROW.y + i * ROW.gap;
      const focused = this.mode === 'menu' && ITEMS[this.item] === id;
      if (focused) c.rect(ROW.x, y, ROW.w, ROW.h, [255, 140, 140]);
      c.text(LABELS[id] as string, ROW.x + 6, y + 4, focused ? [36, 18, 58] : id === 'credits' ? [170, 150, 190] : [240, 230, 240]);
    });
  }
}

// ---------- the demo run ----------

export type DemoOptions = {
  /** Folder for the two runs and the report (default ~/.firelab/explore/demo-<time>). */
  out?: string;
  minutes?: number;
  seed?: number;
  /** Also run the random baseline and draw it in the report (default true). */
  baseline?: boolean;
  onEvent?: (e: ExploreEvent, run: 'explore' | 'random') => void;
};

/** Runs the random baseline and the explorer on Lantern Lake and writes the report. */
export async function runDemo(o: DemoOptions = {}) {
  const { explore, exploreDir } = await import('./index.js');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
  const root = path.resolve(o.out ?? path.join(exploreDir(), `demo-${stamp}`));
  fs.mkdirSync(root, { recursive: true });
  const minutes = o.minutes ?? 10;
  let baselineDir: string | undefined;
  if (o.baseline !== false) {
    const g = new DemoGame();
    baselineDir = path.join(root, 'random');
    await explore({ driver: g.engineDriver, clock: g.clock, package: DEMO_PACKAGE, minutes, seed: o.seed, strategy: 'random', minimize: false, out: baselineDir, onEvent: (e) => o.onEvent?.(e, 'random') });
  }
  const g = new DemoGame();
  const summary = await explore({
    driver: g.engineDriver,
    clock: g.clock,
    package: DEMO_PACKAGE,
    minutes,
    seed: o.seed,
    minimizeMinutes: 4,
    out: path.join(root, 'explore'),
    failOn: ['crash', 'black', 'frozen', 'focus-trap'],
    ...(baselineDir ? { baseline: baselineDir } : {}),
    onEvent: (e) => o.onEvent?.(e, 'explore'),
  });
  return { root, baselineDir, summary };
}
