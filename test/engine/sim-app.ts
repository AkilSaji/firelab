/**
 * A simulated TV game on a FakeDriver, for engine tests: a title screen, a
 * playing scene that animates, and a pause menu with DOM-style focus. Bugs
 * (the same ones examples/web-game/bugs.js seeds into Firefly Lake) switch on
 * per test. Time is virtual: the clock jumps on every sleep, so a "10 minute"
 * run takes milliseconds and is deterministic.
 */
import { FakeDriver, type FakeDriverOptions } from '../../src/driver/fake.js';
import type { KeySpec } from '../../src/driver/types.js';
import type { Clock } from '../../src/engine/clock.js';

export const PKG = 'dev.firelab.simgame';

export type SimBug = 'throw' | 'trap' | 'black' | 'freeze' | 'hidden' | 'crash' | 'selfdrawn';

export class VirtualClock implements Clock {
  t: number;
  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += Math.max(0, ms);
  }
}

const ITEMS = ['resume', 'busy', 'quality', 'meter', 'quit'] as const;
type Mode = 'title' | 'playing' | 'menu';

export class SimGame {
  readonly driver: FakeDriver;
  readonly clock: VirtualClock;
  readonly bugs: Set<SimBug>;
  mode: Mode = 'title';
  item = 0;
  lane = 1;
  errors = 0;
  lastError = '';
  visitedQuality = false;
  black = false;
  frozen = false;
  frozenRaf = 0;
  rights = 0;
  resumedAt = -Infinity;
  launches = 0;
  /** Costs per call, in virtual ms (a Fire TV is slow: keys ~150 ms, screenshots ~400 ms). */
  costs = { press: 150, screenshot: 400, evaluate: 30 };

  constructor(bugs: SimBug[] = [], opts: { clock?: VirtualClock; evalCap?: boolean; driver?: Pick<FakeDriverOptions, 'kind' | 'caps'> } = {}) {
    this.clock = opts.clock ?? new VirtualClock();
    this.bugs = new Set(bugs);
    const d = new FakeDriver({ caps: { eval: opts.evalCap ?? true, console: false, holds: true }, screen: { width: 64, height: 36 }, ...opts.driver });
    this.driver = d;
    d.on('launch', async (app) => {
      this.clock.t += 800;
      this.reset();
      this.launches++;
      return d.base.launch(app);
    });
    d.on('press', async (keys: KeySpec[], opts?: { gapMs?: number }) => {
      for (const [i, k] of keys.entries()) {
        if (i > 0) this.clock.t += opts?.gapMs ?? 0;
        this.clock.t += this.costs.press / keys.length;
        if (d.state.foreground?.package === PKG) this.key(k.key);
        if (k.key === 'home') await d.base.press([k]);
      }
    });
    d.on('evaluate', async (expr: string) => {
      this.clock.t += this.costs.evaluate;
      if (d.state.foreground?.package !== PKG) throw new Error('no webview');
      if (expr.includes('FIRELAB_ENGINE_PROBE_INSTALL')) return true;
      if (expr.includes('FIRELAB_ENGINE_PROBE_FOCUSABLES')) return this.focusables();
      if (expr.includes('FIRELAB_ENGINE_PROBE_READ')) return this.probe();
      return undefined;
    });
    d.on('screenshot', async (o?: { format?: string; width?: number }) => {
      this.clock.t += this.costs.screenshot;
      return d.base.screenshot(o);
    });
    d.setFrame(() => this.frame());
  }

  reset(): void {
    Object.assign(this, { mode: 'title', item: 0, lane: 1, errors: 0, lastError: '', visitedQuality: false, black: false, frozen: false, rights: 0, resumedAt: -Infinity });
  }

  private exit(): void {
    this.driver.state.foreground = { package: 'com.fake.launcher' };
  }

  private menuMove(dir: 1 | -1): void {
    const n = this.bugs.has('hidden') ? ITEMS.length : ITEMS.length; // the hidden 6th item is never in the cycle
    if (this.bugs.has('trap') && this.visitedQuality) {
      const ring = [1, 2, 3];
      const at = ring.indexOf(this.item);
      this.item = ring[(at + dir + ring.length) % ring.length] as number;
    } else this.item = (this.item + dir + n) % n;
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
          if (this.bugs.has('freeze') && ++this.rights >= 4 && !this.frozen) (this.frozen = true), (this.frozenRaf = this.raf());
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
            const pid = this.driver.state.running.get(PKG);
            for (const text of ['FATAL EXCEPTION: main', `Process: ${PKG}, PID: ${pid}`, 'java.lang.IllegalStateException: meter overlay', '\tat dev.firelab.Meter.show(Meter.java:42)'])
              this.driver.state.logs.push({ ts: t + 1, level: 'error', tag: 'AndroidRuntime', pid, text });
            this.driver.state.running.delete(PKG);
            this.exit();
          }
        } else if (k === 'back' && !(this.bugs.has('trap') && this.visitedQuality)) (this.mode = 'playing'), (this.resumedAt = -Infinity);
        return;
      }
    }
  }

  raf(): number {
    return this.frozen ? this.frozenRaf : Math.floor(this.clock.now() / 33);
  }

  private rect(i: number): [number, number, number, number] {
    return [800, 300 + i * 110, 320, 80];
  }

  focusables() {
    if (this.mode !== 'menu') return [];
    const ids = this.bugs.has('hidden') ? [...ITEMS, 'credits'] : [...ITEMS];
    return ids.map((id, i) => ({ id: `#m-${id}`, rect: this.rect(i), text: id }));
  }

  probe() {
    const p: Record<string, unknown> = {
      url: '/game/',
      title: 'Sim',
      hook: true,
      raf: this.raf(),
      rafSource: 'draws',
      errors: this.errors,
      paused: this.mode === 'menu',
      targetFps: 30,
      scene: this.mode,
      viewport: [1920, 1080],
      app: { mode: this.mode, lane: this.mode === 'playing' ? this.lane : 0 },
    };
    if (this.lastError) p.lastError = this.lastError;
    // 'selfdrawn': the game draws its own highlight; the focus FireLab can read never moves (like a canvas game read through accessibility).
    if (this.mode === 'menu') p.focus = this.bugs.has('selfdrawn') ? { id: '#canvas', rect: [0, 0, 1920, 1080] } : { id: `#m-${ITEMS[this.item]}`, rect: this.rect(this.item), text: ITEMS[this.item] };
    return p;
  }

  frame() {
    const w = 64;
    const h = 36;
    const data = new Uint8Array(w * h * 4);
    const t = this.frozen ? this.frozenRaf : this.raf();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        let v: [number, number, number];
        if (this.black) v = [0, 0, 0];
        else if (this.mode === 'title') v = [40 + x * 2, 30, 90 + y * 3];
        else if (this.mode === 'menu') v = x > 24 && x < 40 && Math.floor(y / 4) === this.item + 2 ? [240, 200, 60] : [20, 30 + y, 50];
        else v = [(x * 4 + t * 7) % 256, 80 + this.lane * 40, (y * 6 + t * 3) % 256];
        data[o] = v[0];
        data[o + 1] = v[1];
        data[o + 2] = v[2];
        data[o + 3] = 255;
      }
    return { width: w, height: h, data };
  }
}
