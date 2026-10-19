// The on-screen meter: one small fixed canvas, redrawn a few times a second
// with 2D canvas calls only. It never reads layout and never touches the DOM
// after it is created, so it does not distort what it measures. Hidden, it
// costs nothing: the canvas is not even created.

/**
 * @typedef {object} MeterData
 * @property {number} fps
 * @property {number} fpsMedian
 * @property {number} targetFps
 * @property {number} p50
 * @property {number} p95
 * @property {number} scale
 * @property {number} width
 * @property {number} height
 * @property {string} tier
 * @property {string} tierSource
 * @property {string} gpu
 * @property {number} [drawCalls]
 * @property {number} [triangles]
 * @property {number} [heapMB]
 * @property {boolean} paused
 * @property {string} [pauseReason]
 * @property {boolean} [adaptive]
 */

/**
 * @typedef {object} Meter
 * @property {() => void} show
 * @property {() => void} hide
 * @property {() => boolean} toggle   returns the new visibility
 * @property {boolean} visible
 * @property {(data: MeterData) => void} update   feed new numbers (keeps history even while hidden)
 * @property {() => void} destroy
 */

const W = 268;
const H = 108;
const COLORS = { bg: 'rgba(12,12,18,0.8)', text: '#eef0f4', dim: '#9aa1ad', good: '#4ade80', warn: '#fbbf24', bad: '#f87171', grid: 'rgba(255,255,255,0.18)' };
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Droid Sans Mono", monospace';

/** @param {number} x */
const k = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e4 ? `${Math.round(x / 1e3)}k` : String(Math.round(x)));

/**
 * @param {{ document?: Document, devicePixelRatio?: number, position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right', history?: number, inset?: number }} [opts]
 * @returns {Meter}
 */
export function createMeter(opts = {}) {
  const doc = opts.document ?? (typeof document !== 'undefined' ? document : null);
  const position = opts.position ?? 'top-right';
  const inset = opts.inset ?? 12;
  const hist = new Float32Array(Math.max(8, opts.history ?? 64));
  let head = 0;
  let size = 0;
  /** @type {HTMLCanvasElement | null} */
  let canvas = null;
  /** @type {CanvasRenderingContext2D | null} */
  let ctx = null;
  /** @type {MeterData | null} */
  let last = null;
  let visible = false;

  function create() {
    if (!doc || canvas) return;
    const dpr = Math.min(2, Math.max(1, opts.devicePixelRatio ?? (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)));
    canvas = doc.createElement('canvas');
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.setAttribute('aria-hidden', 'true');
    canvas.dataset.firelabMeter = '';
    const [v, h] = position.split('-');
    canvas.style.cssText =
      `position:fixed;${v}:${inset}px;${h}:${inset}px;width:${W}px;height:${H}px;` +
      'z-index:2147483647;pointer-events:none;contain:strict;border-radius:8px';
    ctx = canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** @param {number} fps @param {number} target */
  function colorFor(fps, target) {
    if (fps >= target * 0.93) return COLORS.good;
    if (fps >= target * 0.75) return COLORS.warn;
    return COLORS.bad;
  }

  /** @param {MeterData} d */
  function draw(d) {
    if (!ctx) return;
    const c = ctx;
    c.clearRect(0, 0, W, H);
    c.fillStyle = COLORS.bg;
    roundRect(c, 0, 0, W, H, 8);
    c.fill();
    c.textBaseline = 'top';

    // fps, big
    c.font = `700 20px ${MONO}`;
    c.fillStyle = colorFor(d.fps, d.targetFps);
    const fpsText = d.fps.toFixed(1);
    c.fillText(fpsText, 10, 7);
    const fw = c.measureText(fpsText).width;
    c.font = `11px ${MONO}`;
    c.fillStyle = COLORS.dim;
    c.fillText('fps', 14 + fw, 15);
    c.textAlign = 'right';
    if (d.paused) {
      c.fillStyle = COLORS.warn;
      c.fillText(`paused${d.pauseReason ? ` · ${d.pauseReason}` : ''}`, W - 10, 9);
    } else {
      c.fillText(`med ${d.fpsMedian.toFixed(1)} / target ${d.targetFps}`, W - 10, 9);
    }
    c.textAlign = 'left';

    // sparkline
    const x0 = 10;
    const x1 = W - 10;
    const y0 = 32;
    const y1 = 56;
    const top = Math.max(d.targetFps * 1.25, maxOf(hist, size));
    const yOf = (/** @type {number} */ v) => y1 - (Math.min(v, top) / top) * (y1 - y0);
    c.strokeStyle = COLORS.grid;
    c.lineWidth = 1;
    c.setLineDash([3, 3]);
    c.beginPath();
    c.moveTo(x0, Math.round(yOf(d.targetFps)) + 0.5);
    c.lineTo(x1, Math.round(yOf(d.targetFps)) + 0.5);
    c.stroke();
    c.setLineDash([]);
    if (size > 1) {
      const step = (x1 - x0) / (hist.length - 1);
      const start = x1 - (size - 1) * step;
      c.beginPath();
      for (let i = 0; i < size; i++) {
        const v = hist[(head - size + i + hist.length) % hist.length];
        const x = start + i * step;
        if (i === 0) c.moveTo(x, yOf(v));
        else c.lineTo(x, yOf(v));
      }
      c.strokeStyle = colorFor(d.fpsMedian || d.fps, d.targetFps);
      c.lineWidth = 1.5;
      c.stroke();
    }

    // text rows
    c.font = `11px ${MONO}`;
    c.fillStyle = COLORS.text;
    c.fillText(`frame p50 ${d.p50.toFixed(1)}  p95 ${d.p95.toFixed(1)} ms`, 10, 61);
    const src = d.tierSource && d.tierSource !== 'auto' ? ` (${d.tierSource})` : ' (auto)';
    c.fillText(`${d.adaptive === false ? 'fixed' : 'scale'} ${d.scale.toFixed(2)}  ${d.width}×${d.height}  ${d.tier}${src}`, 10, 75);
    const bits = [shortGpu(d.gpu)];
    if (d.drawCalls !== undefined) bits.push(`${k(d.drawCalls)} dc`);
    if (d.triangles !== undefined) bits.push(`${k(d.triangles)} tri`);
    if (d.heapMB !== undefined) bits.push(`${Math.round(d.heapMB)} MB`);
    c.fillStyle = COLORS.dim;
    c.fillText(fit(c, bits.filter(Boolean).join(' · '), W - 20), 10, 89);
  }

  const meter = {
    get visible() {
      return visible;
    },
    show() {
      create();
      if (!canvas || !doc) return;
      if (!canvas.isConnected) (doc.body || doc.documentElement).appendChild(canvas);
      visible = true;
      if (last) draw(last);
    },
    hide() {
      if (canvas && canvas.isConnected) canvas.remove();
      visible = false;
    },
    toggle() {
      if (visible) meter.hide();
      else meter.show();
      return visible;
    },
    /** @param {MeterData} d */
    update(d) {
      last = d;
      if (!d.paused || d.fps > 0) {
        hist[head] = d.fps;
        head = (head + 1) % hist.length;
        if (size < hist.length) size++;
      }
      if (visible) draw(d);
    },
    destroy() {
      meter.hide();
      canvas = null;
      ctx = null;
    },
  };
  return meter;
}

/** @param {Float32Array} a @param {number} n */
function maxOf(a, n) {
  let m = 0;
  for (let i = 0; i < n; i++) if (a[i] > m) m = a[i];
  return m;
}

/** "PowerVR Rogue GE8300" -> "GE8300", "Mali-G52 MC2" stays. @param {string} gpu */
function shortGpu(gpu) {
  return (gpu || 'GPU unknown').replace(/^PowerVR Rogue /, 'PowerVR ').replace(/^ANGLE \(/, '').slice(0, 40);
}

/** @param {CanvasRenderingContext2D} c @param {string} s @param {number} max */
function fit(c, s, max) {
  if (c.measureText(s).width <= max) return s;
  let t = s;
  while (t.length > 4 && c.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/** @param {CanvasRenderingContext2D} c @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r */
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
