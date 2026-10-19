// Fakes for running createPerf() in Node: a window, a document with a canvas
// that records 2D drawing calls, a manual clock, requestAnimationFrame and
// setInterval that only advance when the test says so.

export function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

export class FakeTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, ...event });
  }
  count(type) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

export function fake2d() {
  const calls = [];
  return new Proxy(
    { calls },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === 'measureText') return (s) => ({ width: String(s).length * 6 });
        return (...args) => calls.push([prop, ...args]);
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );
}

export function fakeDocument() {
  const doc = new FakeTarget();
  doc.visibilityState = 'visible';
  const children = [];
  doc.body = {
    children,
    appendChild(el) {
      children.push(el);
      el.isConnected = true;
      el.remove = () => {
        children.splice(children.indexOf(el), 1);
        el.isConnected = false;
      };
      return el;
    },
  };
  doc.createElement = (tag) => {
    const ctx = fake2d();
    return {
      tagName: tag.toUpperCase(),
      width: 300,
      height: 150,
      clientWidth: 0,
      clientHeight: 0,
      style: {},
      dataset: {},
      isConnected: false,
      setAttribute() {},
      getContext: (kind) => (kind === '2d' ? ctx : null),
      ctx,
    };
  };
  doc.getElementsByTagName = () => doc.videos || [];
  return doc;
}

export function fakeEnv(overrides = {}) {
  const win = new FakeTarget();
  const doc = fakeDocument();
  let now = 0;
  let rafs = new Map();
  let rafId = 0;
  let intervals = new Map();
  let intervalId = 0;
  const env = {
    window: win,
    document: doc,
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 9; AFTSSS Build/PS7717; wv) Chrome/138.0 Mobile Safari/537.36', maxTouchPoints: 0 },
    search: () => overrides.searchString ?? '',
    storage: overrides.storage ?? memoryStorage(),
    now: () => now,
    requestAnimationFrame(cb) {
      rafs.set(++rafId, cb);
      return rafId;
    },
    cancelAnimationFrame(id) {
      rafs.delete(id);
    },
    setInterval(cb, ms) {
      intervals.set(++intervalId, { cb, ms, next: now + ms });
      return intervalId;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    devicePixelRatio: () => overrides.dpr ?? 2,
    viewport: () => overrides.viewport ?? { width: 960, height: 540 },
    heapMB: () => 54.4,
    hidden: () => doc.visibilityState === 'hidden',
    reload() {
      env.reloaded = (env.reloaded || 0) + 1;
    },
  };
  const ctl = {
    env,
    win,
    doc,
    get now() {
      return now;
    },
    /** Advance the clock, firing intervals that fall due. */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, it] of intervals) if (it.next <= end && (!due || it.next < due.it.next)) due = { id, it };
        if (!due) break;
        now = due.it.next;
        due.it.next += due.it.ms;
        due.it.cb();
      }
      now = end;
    },
    /** Run one animation frame `dt` ms after the last one. */
    raf(dt) {
      ctl.advance(dt);
      const pending = rafs;
      rafs = new Map();
      for (const cb of pending.values()) cb(now);
    },
    pendingRafs: () => rafs.size,
    intervals: () => intervals.size,
  };
  return ctl;
}

export const GE8300 = {
  tier: 'tv',
  reason: 'test',
  platform: 'firetv',
  isTv: true,
  model: 'AFTSSS',
  device: 'Fire TV Stick (3rd gen, 2020)',
  gpu: 'PowerVR Rogue GE8300',
  renderer: 'PowerVR Rogue GE8300',
  vendor: 'Imagination Technologies',
  masked: false,
  webgl: 2,
  chip: 'powervr-ge8300',
};

export const GE9215 = { ...GE8300, tier: 'tv-hd', gpu: 'PowerVR Rogue GE9215', renderer: 'PowerVR Rogue GE9215', chip: 'powervr-ge9215', model: 'AFTMA08C15' };
