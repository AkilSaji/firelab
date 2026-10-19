/**
 * Native focus from `uiautomator dump` (docs/ENGINE.md 5.2, 7.3). Most Fire TV
 * apps are native (Leanback, plain views, Compose for TV), so there is no page
 * to probe; the window hierarchy still says which view has focus and which
 * views could take it. This file turns the dump XML into the same FocusInfo
 * the in-page probe gives, so abstraction (L3) and the focus oracle work
 * unchanged. A dump takes 1-3 s on a Fire TV, so the Observer reads one only
 * when the picture is new (see NativeFocus below), never on every step.
 */
import type { FocusInfo } from './types.js';
import { sha1 } from './abstraction.js';

/** One <node> of a uiautomator dump. */
export type UiNode = {
  path: string; // child indexes from the root, e.g. "0.0.2.1"
  depth: number;
  text: string;
  desc: string;
  resId: string;
  cls: string;
  pkg: string;
  focusable: boolean;
  focused: boolean;
  enabled: boolean;
  selected: boolean;
  bounds: [x0: number, y0: number, x1: number, y1: number];
  parent?: UiNode;
  children: UiNode[];
};

export type NativeSnapshot = {
  /** The focused view, null when nothing in the app has focus. */
  focus: FocusInfo | null;
  /** Views that could take focus (leaves of the focusable tree, visible, enabled). */
  focusables: FocusInfo[];
  /** The root's size (the screen in pixels). */
  viewport?: [w: number, h: number];
  /** Packages that own nodes in the dump (the window in front). */
  packages: string[];
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

/** The XML between `<hierarchy` and `</hierarchy>` (adb output may carry "UI hierchary dumped to: ..." around it). */
export function extractHierarchy(out: string): string | undefined {
  const a = out.indexOf('<hierarchy');
  if (a < 0) return undefined;
  const end = out.indexOf('</hierarchy>', a);
  if (end >= 0) return out.slice(a, end + '</hierarchy>'.length);
  const selfClosed = /^<hierarchy[^>]*\/>/.exec(out.slice(a));
  return selfClosed ? selfClosed[0] : undefined;
}

/** Parses a dump into a node tree (a small tag scanner: the format is flat attributes, no text content). */
export function parseUiDump(xml: string): UiNode[] {
  const roots: UiNode[] = [];
  const stack: UiNode[] = [];
  const tag = /<(\/?)node\b([^>]*?)(\/?)>/g;
  const attr = /([\w-]+)="([^"]*)"/g;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    if (m[1]) {
      stack.pop();
      continue;
    }
    const a: Record<string, string> = {};
    for (let x = attr.exec(m[2] ?? ''); x; x = attr.exec(m[2] ?? '')) a[x[1] as string] = unescape(x[2] as string);
    const b = BOUNDS.exec(a.bounds ?? '');
    const parent = stack[stack.length - 1];
    const siblings = parent ? parent.children : roots;
    const node: UiNode = {
      path: parent ? `${parent.path}.${siblings.length}` : String(siblings.length),
      depth: stack.length,
      text: (a.text ?? '').trim(),
      desc: (a['content-desc'] ?? '').trim(),
      resId: a['resource-id'] ?? '',
      cls: a.class ?? '',
      pkg: a.package ?? '',
      focusable: a.focusable === 'true',
      focused: a.focused === 'true',
      enabled: a.enabled !== 'false',
      selected: a.selected === 'true',
      bounds: b ? [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] : [0, 0, 0, 0],
      children: [],
    };
    if (parent) node.parent = parent;
    siblings.push(node);
    if (!m[3]) stack.push(node);
  }
  return roots;
}

const walk = (nodes: UiNode[], fn: (n: UiNode) => void): void => {
  for (const n of nodes) {
    fn(n);
    walk(n.children, fn);
  }
};

const hasFocusableDescendant = (n: UiNode): boolean => n.children.some((c) => (c.focusable && c.enabled) || hasFocusableDescendant(c));

/** Own text, else content description, else the first texts below it (a Leanback card's title lives in a child TextView). */
function labelOf(n: UiNode): string | undefined {
  const clean = (t: string) => t.replace(/\s+/g, ' ').trim();
  const own = clean(n.text || n.desc);
  if (own) return own.slice(0, 60);
  const texts: string[] = [];
  walk(n.children, (c) => {
    if (texts.length < 2 && (c.text || c.desc)) texts.push(clean(c.text || c.desc));
  });
  return texts.length ? texts.join(' / ').slice(0, 60) : undefined;
}

const shortId = (resId: string): string => resId.replace(/^.*:id\//, '');
const shortCls = (cls: string): string => cls.split('.').pop() ?? cls;

/**
 * A stable name for a view: resource id + label, which survive scrolling and
 * view recycling. Only when that is ambiguous on the screen (two "Play"
 * buttons with one id) does the position in the tree break the tie.
 */
function naming(nodes: UiNode[]): (n: UiNode) => string {
  const base = (n: UiNode) => {
    const l = labelOf(n);
    const id = shortId(n.resId);
    if (id && l) return `${id}:${l}`;
    if (id) return id;
    if (l) return `${shortCls(n.cls)}:${l}`;
    return '';
  };
  const count = new Map<string, number>();
  for (const n of nodes) {
    const b = base(n);
    count.set(b, (count.get(b) ?? 0) + 1);
  }
  return (n) => {
    const b = base(n);
    if (b && count.get(b) === 1) return b;
    return `${b || shortCls(n.cls)}@${n.path}`;
  };
}

const MIN_SIDE = 8;

/** The focus snapshot of a dump. `pkg` limits nodes to one app (system overlays don't count as the app's controls). */
export function nativeSnapshot(xml: string, pkg?: string): NativeSnapshot {
  const roots = parseUiDump(xml);
  const all: UiNode[] = [];
  walk(roots, (n) => all.push(n));
  const packages = [...new Set(all.map((n) => n.pkg).filter(Boolean))];
  let vw = 0;
  let vh = 0;
  for (const r of roots) (vw = Math.max(vw, r.bounds[2])), (vh = Math.max(vh, r.bounds[3]));
  const visible = (n: UiNode) => {
    const [x0, y0, x1, y1] = n.bounds;
    return x1 - x0 >= MIN_SIDE && y1 - y0 >= MIN_SIDE && x1 > 0 && y1 > 0 && (!vw || x0 < vw) && (!vh || y0 < vh);
  };
  const mine = (n: UiNode) => !pkg || n.pkg === pkg;
  // The deepest focused view: a host view (FlutterView, a WebView, a Compose root) reports focused="true" too.
  const focusedNode = all.filter((n) => n.focused && mine(n)).sort((x, y) => y.depth - x.depth)[0];
  // Containers that hand focus to a child (RecyclerView, a Leanback row) are focusable too; the child is the control.
  const candidates = all.filter((n) => n === focusedNode || (mine(n) && n.enabled && visible(n) && n.focusable && !hasFocusableDescendant(n)));
  const name = naming(candidates);
  const info = (n: UiNode): FocusInfo => {
    const [x0, y0, x1, y1] = n.bounds;
    const f: FocusInfo = { id: name(n), rect: [x0, y0, x1 - x0, y1 - y0], role: shortCls(n.cls) };
    const l = labelOf(n);
    if (l) f.text = l;
    return f;
  };
  const snap: NativeSnapshot = { focus: focusedNode ? info(focusedNode) : null, focusables: candidates.map(info), packages };
  if (vw && vh) snap.viewport = [vw, vh];
  return snap;
}

/** What NativeFocus needs from a driver: the optional `uiDump` method (AdbDriver has it). */
export type UiDumpSource = { uiDump?(opts?: { timeoutMs?: number }): Promise<string> };

/** Consecutive failed dumps (no idle state on an animated screen, uiautomator missing) before native focus gives up. */
export const NATIVE_MAX_FAILURES = 4;
/** Dumps slower than this (median of the last few) cost more device time than native focus is worth: it switches off. */
export const NATIVE_SLOW_DUMP_MS = 4000;
/** Wait at most this long for one dump (uiautomator waits for an idle screen, which animated games never reach). */
export const NATIVE_DUMP_TIMEOUT_MS = 6000;
const CACHE_SIZE = 256;

/**
 * Reads native focus with as few dumps as possible: the snapshot is cached
 * under the exact 64 px thumbnail (plus activity), so a step that lands on a
 * picture seen before costs nothing, and only a new picture (a new state, or
 * a focus move inside the investigation) pays for a dump.
 */
export class NativeFocus {
  readonly counters = { dumps: 0, hits: 0, failures: 0 };
  private readonly cache = new Map<string, NativeSnapshot>();
  private failStreak = 0;
  private everWorked = false;
  private last?: { key: string; snap: NativeSnapshot };
  private readonly durations: number[] = [];
  off = false;
  /** Why native focus switched itself off (for the report's notes). */
  offReason?: string;

  constructor(
    private readonly src: UiDumpSource,
    private readonly pkg: string,
  ) {}

  static available(src: UiDumpSource): boolean {
    return typeof src.uiDump === 'function';
  }

  /** The cache key of an observation: activity + the exact thumbnail bytes. */
  static key(activity: string | undefined, thumb: Uint8Array | undefined): string | undefined {
    return thumb ? `${activity ?? ''}|${sha1(Buffer.from(thumb.buffer, thumb.byteOffset, thumb.byteLength).toString('base64'))}` : undefined;
  }

  /** The snapshot for this picture: from the cache, or one dump. Undefined when focus is unknown (dump failed, native focus off). */
  async read(key: string | undefined, opts: { fresh?: boolean } = {}): Promise<NativeSnapshot | undefined> {
    if (this.off || !this.src.uiDump) return undefined;
    if (key && !opts.fresh) {
      const hit = this.cache.get(key);
      if (hit) {
        this.counters.hits++;
        this.last = { key, snap: hit };
        return hit;
      }
    }
    this.counters.dumps++;
    const t0 = Date.now();
    try {
      const out = await this.src.uiDump({ timeoutMs: NATIVE_DUMP_TIMEOUT_MS });
      const xml = extractHierarchy(out);
      if (!xml) throw new Error('no hierarchy in uiautomator output');
      const snap = nativeSnapshot(xml, this.pkg);
      this.failStreak = 0;
      this.everWorked = true;
      this.noteDuration(Date.now() - t0);
      if (key) {
        if (this.cache.size >= CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
        this.cache.set(key, snap);
        this.last = { key, snap };
      }
      return snap;
    } catch {
      this.counters.failures++;
      this.noteDuration(Date.now() - t0);
      if (++this.failStreak >= NATIVE_MAX_FAILURES && !this.off) {
        this.off = true;
        this.offReason = this.everWorked ? 'uiautomator dumps kept failing on this app (an animated screen never goes idle for uiautomator)' : 'uiautomator dumps failed on this app';
      }
      return undefined;
    }
  }

  /** Switches native focus off when dumps are too slow to be worth their device time (e.g. animated games on a 1 GB stick). */
  private noteDuration(ms: number): void {
    this.durations.push(ms);
    if (this.durations.length > 5) this.durations.shift();
    if (this.off || this.durations.length < 3) return;
    const sorted = [...this.durations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] as number;
    if (median > NATIVE_SLOW_DUMP_MS) {
      this.off = true;
      this.offReason = `uiautomator dumps take about ${(median / 1000).toFixed(1)} s each on this app and device, so native focus checks are off to keep exploring fast`;
    }
  }

  /** The focusables of the latest snapshot when it is for this picture, else of a fresh dump. */
  async focusables(key: string | undefined): Promise<FocusInfo[]> {
    if (key && this.last?.key === key) return this.last.snap.focusables;
    return (await this.read(key))?.focusables ?? [];
  }
}
