import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeDriver } from '../../src/driver/fake.js';
import type { KeySpec } from '../../src/driver/types.js';
import { explore, readRunDir } from '../../src/engine/index.js';
import { Abstraction } from '../../src/engine/abstraction.js';
import { NATIVE_MAX_FAILURES, NativeFocus, extractHierarchy, nativeSnapshot, parseUiDump } from '../../src/engine/uidump.js';
import type { Observation } from '../../src/engine/types.js';
import { VirtualClock } from './sim-app.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-native-'));

const node = (a: Record<string, string>, children = ''): string => {
  const attrs = { index: '0', text: '', 'resource-id': '', class: 'android.view.View', package: 'com.example.tv', 'content-desc': '', checkable: 'false', checked: 'false', clickable: 'false', enabled: 'true', focusable: 'false', focused: 'false', scrollable: 'false', 'long-clickable': 'false', password: 'false', selected: 'false', bounds: '[0,0][0,0]', ...a };
  const s = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
  return children ? `<node ${s}>${children}</node>` : `<node ${s} />`;
};
const b = (x: number, y: number, w: number, h: number) => `[${x},${y}][${x + w},${y + h}]`;

/** A Leanback-style browse screen: a focusable row container with cards (title in a child TextView), a button, a system overlay. */
const BROWSE =
  "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">" +
  node({ class: 'android.widget.FrameLayout', bounds: b(0, 0, 1920, 1080) },
    node({ 'resource-id': 'com.example.tv:id/row', class: 'androidx.leanback.widget.HorizontalGridView', focusable: 'true', bounds: b(0, 300, 1920, 300) },
      node({ 'resource-id': 'com.example.tv:id/card', class: 'androidx.leanback.widget.ImageCardView', focusable: 'true', focused: 'true', bounds: b(100, 320, 300, 260) },
        node({ 'resource-id': 'com.example.tv:id/title_text', class: 'android.widget.TextView', text: 'Tom &amp; Jerry', bounds: b(110, 520, 280, 40) })) +
      node({ 'resource-id': 'com.example.tv:id/card', class: 'androidx.leanback.widget.ImageCardView', focusable: 'true', bounds: b(450, 320, 300, 260) },
        node({ 'resource-id': 'com.example.tv:id/title_text', class: 'android.widget.TextView', text: 'News', bounds: b(460, 520, 280, 40) })) +
      node({ 'resource-id': 'com.example.tv:id/card', class: 'androidx.leanback.widget.ImageCardView', focusable: 'true', bounds: b(800, 320, 300, 260) }) +
      node({ 'resource-id': 'com.example.tv:id/card', class: 'androidx.leanback.widget.ImageCardView', focusable: 'true', bounds: b(1150, 320, 300, 260) })) +
    node({ 'resource-id': 'com.example.tv:id/search', class: 'android.widget.ImageButton', 'content-desc': 'Search', focusable: 'true', bounds: b(1700, 40, 120, 120) }) +
    node({ 'resource-id': 'com.example.tv:id/disabled', class: 'android.widget.Button', text: 'Later', focusable: 'true', enabled: 'false', bounds: b(1700, 900, 120, 80) }) +
    node({ 'resource-id': 'com.example.tv:id/offscreen', class: 'android.widget.Button', text: 'Far', focusable: 'true', bounds: b(1990, 400, 120, 80) }) +
    node({ 'resource-id': 'com.android.systemui:id/toast', package: 'com.android.systemui', class: 'android.widget.Button', text: 'OK', focusable: 'true', bounds: b(800, 900, 200, 80) })) +
  '</hierarchy>';

describe('uiautomator dump parsing', () => {
  test('extracts the hierarchy from adb output', () => {
    expect(extractHierarchy(`junk\n${BROWSE}UI hierchary dumped to: /dev/stdout\n`)).toBe(BROWSE.slice(BROWSE.indexOf('<hierarchy')));
    expect(extractHierarchy('ERROR: could not get idle state.')).toBeUndefined();
    expect(extractHierarchy('<hierarchy rotation="0" />')).toBe('<hierarchy rotation="0" />');
  });

  test('builds the tree with paths and unescaped text', () => {
    const roots = parseUiDump(BROWSE);
    expect(roots).toHaveLength(1);
    const row = roots[0]!.children[0]!;
    expect(row.path).toBe('0.0');
    expect(row.children).toHaveLength(4);
    expect(row.children[0]!.children[0]!.text).toBe('Tom & Jerry');
    expect(row.children[1]!.bounds).toEqual([450, 320, 750, 580]);
  });

  test('focused view and focusables: leaves only, visible, enabled, in the app', () => {
    const s = nativeSnapshot(BROWSE, 'com.example.tv');
    expect(s.viewport).toEqual([1920, 1080]);
    expect(s.focus).toEqual({ id: 'card:Tom & Jerry', rect: [100, 320, 300, 260], role: 'ImageCardView', text: 'Tom & Jerry' });
    const ids = s.focusables.map((f) => f.id);
    // The row container hands focus to its cards; disabled, off-screen and systemui views don't count.
    expect(ids).toEqual(['card:Tom & Jerry', 'card:News', 'card@0.0.2', 'card@0.0.3', 'search:Search']);
    expect(s.packages).toEqual(['com.example.tv', 'com.android.systemui']);
    // Without a package filter the overlay's button is a control too.
    expect(nativeSnapshot(BROWSE).focusables.map((f) => f.id)).toContain('toast:OK');
  });

  test('a host view that also says focused (FlutterView) yields to the deepest focused node', () => {
    const xml =
      '<hierarchy rotation="0">' +
      node({ class: 'android.widget.FrameLayout', focusable: 'true', focused: 'true', bounds: b(0, 0, 1280, 720) },
        node({ class: 'android.view.View', bounds: b(0, 0, 1280, 720) },
          node({ class: 'android.view.View', 'content-desc': ' Mobil80 Profile&#10;Version 1.1', focusable: 'true', focused: 'true', bounds: b(0, 0, 1280, 720) }) +
          node({ class: 'android.widget.Button', 'content-desc': 'Menu', focusable: 'true', bounds: b(1200, 20, 60, 60) }))) +
      '</hierarchy>';
    const s = nativeSnapshot(xml, 'com.example.tv');
    expect(s.focus?.id).toBe('View:Mobil80 Profile Version 1.1');
    expect(s.focusables.map((f) => f.id)).toEqual(['View:Mobil80 Profile Version 1.1', 'Button:Menu']);
  });

  test('nothing focused gives focus null', () => {
    const s = nativeSnapshot(BROWSE.replace('focused="true"', 'focused="false"'), 'com.example.tv');
    expect(s.focus).toBeNull();
    expect(s.focusables).toHaveLength(5);
  });

  test('native focus is the L3 key of the state', () => {
    const s = nativeSnapshot(BROWSE, 'com.example.tv');
    const obs: Observation = { ts: 0, step: 1, foreground: 'com.example.tv', activity: '.Main', logs: [], console: [], settleMs: 0, focus: s.focus, viewport: s.viewport, frame: { hash: 'ab'.repeat(8), luma: { mean: 1, std: 1 } } };
    const st = new Abstraction().abstract(obs);
    expect(st.level).toBe(3);
    expect(st.key.focus).toBe('card:Tom & Jerry');
    expect(st.key.vis).toBeUndefined();
  });
});

describe('NativeFocus', () => {
  test('one dump per new picture', async () => {
    let n = 0;
    const nf = new NativeFocus({ uiDump: async () => (n++, BROWSE) }, 'com.example.tv');
    const k1 = NativeFocus.key('.Main', new Uint8Array([1, 2, 3]));
    const k2 = NativeFocus.key('.Main', new Uint8Array([1, 2, 4]));
    expect((await nf.read(k1))?.focus?.id).toBe('card:Tom & Jerry');
    await nf.read(k1);
    expect(await nf.focusables(k1)).toHaveLength(5);
    expect(n).toBe(1);
    await nf.read(k2);
    expect(n).toBe(2);
    expect(nf.counters).toEqual({ dumps: 2, hits: 1, failures: 0 });
  });

  test('gives up after repeated failures when no dump ever worked', async () => {
    const nf = new NativeFocus({ uiDump: async () => 'ERROR: could not get idle state.' }, 'com.example.tv');
    for (let i = 0; i < NATIVE_MAX_FAILURES; i++) expect(await nf.read(`k${i}`)).toBeUndefined();
    expect(nf.off).toBe(true);
    expect(NativeFocus.available({})).toBe(false);
  });
});

// ---------- a simulated native TV app ----------

const NPKG = 'com.example.nativetv';
type NativeBug = 'trap' | 'nonspatial' | 'hidden';
type Item = { id: string; text: string; rect: [number, number, number, number]; card?: boolean };
const ITEMS: Item[] = [
  { id: 'home', text: 'Home', rect: [100, 100, 200, 80] },
  { id: 'movies', text: 'Movies', rect: [400, 100, 200, 80] },
  { id: 'shows', text: 'Shows', rect: [700, 100, 200, 80] },
  { id: 'settings', text: 'Settings', rect: [1000, 100, 200, 80] },
  { id: 'card', text: 'Card 1', rect: [100, 400, 300, 200], card: true },
  { id: 'card', text: 'Card 2', rect: [500, 400, 300, 200], card: true },
  { id: 'card', text: 'Card 3', rect: [900, 400, 300, 200], card: true },
  { id: 'opt', text: 'Subtitles', rect: [100, 750, 300, 100] },
  { id: 'opt', text: 'Audio', rect: [500, 750, 300, 100] },
];
const CREDITS: Item = { id: 'credits', text: 'Credits', rect: [1600, 900, 200, 80] };

/** Native Android TV app on a FakeDriver: no eval, focus only through uiDump. Moves follow the grid unless a bug says otherwise. */
class NativeSim {
  readonly driver: FakeDriver;
  readonly clock = new VirtualClock();
  focus = 0;
  dumps = 0;
  constructor(readonly bugs: Set<NativeBug>) {
    const d = new FakeDriver({ caps: { eval: false, console: false, holds: true }, screen: { width: 64, height: 36 } });
    this.driver = d;
    d.on('launch', async (app) => {
      this.clock.t += 800;
      this.focus = 0;
      return d.base.launch(app);
    });
    d.on('press', async (keys: KeySpec[]) => {
      for (const k of keys) {
        this.clock.t += 150;
        if (d.state.foreground?.package === NPKG) this.key(k.key);
        else if (k.key === 'home') await d.base.press([k]);
      }
    });
    d.on('screenshot', async (o?: { format?: string; width?: number }) => {
      this.clock.t += 400;
      return d.base.screenshot(o);
    });
    d.setFrame(() => this.frame());
    (d as unknown as { uiDump: () => Promise<string> }).uiDump = async () => {
      this.clock.t += 1500;
      this.dumps++;
      return this.dump();
    };
  }

  private inTrap(): boolean {
    return this.bugs.has('trap') && this.focus >= 7;
  }

  key(k: string): void {
    const f = this.focus;
    const row = f < 4 ? 0 : f < 7 ? 1 : 2;
    if (k === 'back') {
      if (!this.inTrap()) this.driver.state.foreground = { package: 'com.fake.launcher' };
      return;
    }
    if (this.inTrap()) {
      if (k === 'right' && f === 7) this.focus = 8;
      else if (k === 'left' && f === 8) this.focus = 7;
      return;
    }
    if (k === 'right' && f === 1 && this.bugs.has('nonspatial')) return void (this.focus = 6);
    if (k === 'left' && f !== 0 && f !== 4 && f !== 7) this.focus = f - 1;
    else if (k === 'right' && f !== 3 && f !== 6 && f !== 8) this.focus = f + 1;
    else if (k === 'down' && row === 0) this.focus = 4 + Math.min(f, 2);
    else if (k === 'down' && row === 1) this.focus = f === 4 ? 7 : 8;
    else if (k === 'up' && row === 1) this.focus = f - 4;
    else if (k === 'up' && row === 2) this.focus = f === 7 ? 4 : 5;
  }

  dump(): string {
    const items = this.bugs.has('hidden') ? [...ITEMS, CREDITS] : ITEMS;
    const kids = items
      .map((it, i) => {
        const a = { 'resource-id': `${NPKG}:id/${it.id}`, class: it.card ? 'android.widget.FrameLayout' : 'android.widget.Button', package: NPKG, focusable: 'true', focused: String(i === this.focus), bounds: b(...it.rect) };
        return it.card ? node(a, node({ 'resource-id': `${NPKG}:id/title`, class: 'android.widget.TextView', package: NPKG, text: it.text, bounds: b(it.rect[0], it.rect[1] + 150, it.rect[2], 40) })) : node({ ...a, text: it.text });
      })
      .join('');
    return `<?xml version='1.0' ?><hierarchy rotation="0">${node({ class: 'android.widget.FrameLayout', package: NPKG, bounds: b(0, 0, 1920, 1080) }, kids)}</hierarchy>UI hierchary dumped to: /dev/stdout`;
  }

  frame() {
    const w = 64;
    const h = 36;
    const data = new Uint8Array(w * h * 4);
    const r = (ITEMS[this.focus] as Item).rect;
    const [fx0, fy0, fx1, fy1] = [Math.floor((r[0] / 1920) * w), Math.floor((r[1] / 1080) * h), Math.ceil(((r[0] + r[2]) / 1920) * w), Math.ceil(((r[1] + r[3]) / 1080) * h)];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const lit = x >= fx0 && x < fx1 && y >= fy0 && y < fy1;
        data[o] = lit ? 250 : 20 + x;
        data[o + 1] = lit ? 220 : 30 + y;
        data[o + 2] = lit ? 60 : 70;
        data[o + 3] = 255;
      }
    return { width: w, height: h, data };
  }
}

async function runNative(bugs: NativeBug[], o: Partial<Parameters<typeof explore>[0]> = {}) {
  const sim = new NativeSim(new Set(bugs));
  const r = await explore({ driver: sim.driver as never, clock: sim.clock, package: NPKG, minutes: 15, out: tmp(), minimize: false, ...o });
  return { sim, r, full: readRunDir(r.dir) };
}

describe('explorer on a native app (focus from uiautomator)', () => {
  test('finds a non-spatial move and an unreachable control, with one dump per new picture', async () => {
    const { r, sim, full } = await runNative(['nonspatial', 'hidden']);
    const by = (k: string) => r.findings.filter((f) => f.kind === k);
    expect(by('unreachable-control').map((f) => f.title)).toEqual(['"Credits" can\'t be reached with the D-pad']);
    expect(by('non-spatial-move').map((f) => f.title)).toEqual(['D-pad right from "Movies" jumps to "Card 3" (expected "Shows")']);
    expect(by('focus-trap')).toEqual([]);
    // Dumps only for new pictures: far fewer than steps.
    expect(sim.dumps).toBe(full.counters.dumps);
    expect(full.counters.dumps!).toBeLessThan(r.steps / 3);
    expect(full.counters.dumpHits!).toBeGreaterThan(full.counters.dumps!);
    expect(r.notes.join('\n')).toContain('uiautomator');
    expect(full.focusGraphs[0]!.nodes.map((n) => n.id)).toContain('card:Card 1');
  });

  test('finds a focus trap that Back does not leave', async () => {
    const { r } = await runNative(['trap']);
    const traps = r.findings.filter((f) => f.kind === 'focus-trap');
    expect(traps).toHaveLength(1);
    expect(traps[0]!.title).toBe('Focus trap: the D-pad and Back can\'t leave "Audio", "Subtitles"');
    expect(traps[0]!.severity).toBe('critical');
  });

  test('a clean native app has no focus findings, and states are focus states', async () => {
    const { r } = await runNative([], { minutes: 4 });
    expect(r.findings.filter((f) => f.oracle === 'focus')).toEqual([]);
    expect(r.states).toBeGreaterThanOrEqual(ITEMS.length);
    expect(r.notes.join('\n')).not.toContain('focus oracle off');
  });

  test('without eval or uiDump the focus oracle is off', async () => {
    const sim = new NativeSim(new Set());
    delete (sim.driver as unknown as { uiDump?: unknown }).uiDump;
    const r = await explore({ driver: sim.driver as never, clock: sim.clock, package: NPKG, steps: 30, out: tmp(), minimize: false });
    expect(r.notes.join('\n')).toContain('focus oracle off');
    expect(r.findings.filter((f) => f.oracle === 'focus')).toEqual([]);
  });
});
