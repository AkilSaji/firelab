// Canvas charts, drawn by hand: a time-series line chart (performance) and a
// horizontal bar chart (sweep results). Both are crisp on HiDPI screens, pick
// their colours from CSS custom properties, and redraw on theme changes.

import { cssVar } from './theme.js';
import { on } from './store.js';
import { h } from './dom.js';

const charts = new Set();
on('theme', () => {
  for (const c of charts) {
    c.colors = null;
    c.requestDraw();
  }
});

const MONO = '500 10px ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';
const MONO_B = '650 10px ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';
const MONO_11 = '650 11px ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * pow;
}

function alpha(color, a) {
  // Accepts #rgb/#rrggbb (what our tokens use); anything else falls back to the colour itself.
  if (!color.startsWith('#')) return color;
  let hex = color.slice(1);
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

class CanvasChart {
  constructor(host) {
    this.host = host;
    this.canvas = host.querySelector('canvas') || host.appendChild(document.createElement('canvas'));
    this.ctx = this.canvas.getContext('2d');
    this.w = 0;
    this.h = 0;
    this.colors = null;
    this.raf = 0;
    this.tip = h('div', { class: 'chart-tip', hidden: true });
    host.append(this.tip);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    charts.add(this);
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width));
    const hh = Math.max(1, Math.round(r.height));
    if (w === this.w && hh === this.h && this.dpr === dpr) return;
    this.w = w;
    this.h = hh;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(hh * dpr);
    this.draw();
  }

  destroy() {
    this.ro.disconnect();
    charts.delete(this);
    cancelAnimationFrame(this.raf);
  }

  requestDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  begin() {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.colors) this.colors = this.readColors();
    return ctx;
  }

  readColors() {
    return {
      grid: cssVar('--chart-grid'),
      axis: cssVar('--chart-axis'),
      ref: cssVar('--chart-ref'),
      surface: cssVar('--bg-1'),
      ink1: cssVar('--ink-1'),
      ink2: cssVar('--ink-2'),
      ink3: cssVar('--ink-3'),
      ink4: cssVar('--ink-4'),
      accent: cssVar('--accent'),
      ok: cssVar('--ok'),
      bad: cssVar('--bad'),
    };
  }

  showTip(x, y, lines) {
    const tip = this.tip;
    tip.replaceChildren(...lines.map(([tag, text]) => h(tag, { text })));
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = x + 12;
    if (left + tw > this.w) left = x - tw - 12;
    let top = y - th - 8;
    if (top < 0) top = Math.min(this.h - th, y + 12);
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, top)}px`;
  }

  hideTip() {
    this.tip.hidden = true;
  }
}

/**
 * Time-series line chart.
 * opts: { color: '--series-fps', windowMs, min, max, axis (draw y/x labels), target, format, gapMs }
 */
export class LineChart extends CanvasChart {
  constructor(host, opts = {}) {
    super(host);
    this.opts = { color: '--series-fps', windowMs: 120000, min: null, max: null, axis: false, gapMs: 4000, format: (v) => String(Math.round(v)), ...opts };
    this.points = [];
    this.now = Date.now();
    this.refs = {};
    this.hoverX = null;
    host.addEventListener('pointermove', (e) => {
      const r = host.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.requestDraw();
    });
    host.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.hideTip();
      this.requestDraw();
    });
  }

  readColors() {
    return { ...super.readColors(), line: cssVar(this.opts.color) };
  }

  setData(points, now) {
    this.points = points;
    this.now = now;
    this.requestDraw();
  }

  setRefs(refs) {
    this.refs = { ...this.refs, ...refs };
    this.requestDraw();
  }

  range(vis) {
    const o = this.opts;
    let lo = o.min;
    let hi = o.max;
    const vals = vis.map((p) => p.v);
    if (this.refs.target != null) vals.push(this.refs.target);
    const dmin = vals.length ? Math.min(...vals) : 0;
    const dmax = vals.length ? Math.max(...vals) : 1;
    if (hi == null) {
      const span = Math.max(1e-6, dmax - (lo ?? dmin));
      hi = dmax + span * 0.12;
    }
    if (lo == null) {
      const span = Math.max(1e-6, hi - dmin);
      lo = Math.max(0, dmin - span * 0.25);
    }
    if (hi - lo < 1e-6) hi = lo + 1;
    let ticks = null;
    if (o.axis) {
      const step = niceStep((hi - lo) / 3);
      lo = Math.floor(lo / step) * step;
      hi = Math.ceil(hi / step) * step;
      ticks = [];
      for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
    }
    return { lo, hi, ticks };
  }

  draw() {
    if (!this.w) return;
    const ctx = this.begin();
    const c = this.colors;
    const o = this.opts;
    const t0 = this.now - o.windowMs;
    const vis = [];
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      if (p.t >= t0 || (this.points[i + 1] && this.points[i + 1].t >= t0)) vis.push(p);
    }
    const { lo, hi, ticks } = this.range(vis.filter((p) => p.t >= t0));
    // The left margin fits the widest y label ("1.00", "1,250"), so labels are never clipped.
    ctx.font = MONO;
    const labelW = ticks ? Math.max(...ticks.map((v) => ctx.measureText(o.format(v)).width)) : 0;
    const padL = o.axis ? Math.max(24, Math.ceil(labelW) + 9) : 0;
    const padB = o.axis ? 16 : 1;
    const padT = o.axis ? 6 : 3;
    const padR = o.axis ? 2 : 5;
    const pw = this.w - padL - padR;
    const ph = this.h - padT - padB;
    const X = (t) => padL + ((t - t0) / o.windowMs) * pw;
    const Y = (v) => padT + ph - ((v - lo) / (hi - lo)) * ph;

    // grid + axes
    ctx.lineWidth = 1;
    ctx.strokeStyle = c.grid;
    ctx.font = MONO;
    ctx.fillStyle = c.axis;
    if (ticks) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const v of ticks) {
        const y = Math.round(Y(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(this.w - padR, y);
        ctx.stroke();
        ctx.fillText(o.format(v), padL - 5, Math.min(Math.max(y, padT + 4), padT + ph - 4));
      }
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      const mins = o.windowMs / 60000;
      const marks = mins >= 2 ? [[0, `-${mins}m`], [0.5, `-${mins / 2}m`], [1, 'now']] : [[0, `-${o.windowMs / 1000}s`], [1, 'now']];
      for (const [f, label] of marks) {
        ctx.textAlign = f === 0 ? 'left' : f === 1 ? 'right' : 'center';
        ctx.fillText(label, padL + f * pw, this.h - 3);
      }
    } else {
      const y = Math.round(padT + ph) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.w, y);
      ctx.stroke();
    }

    // reference lines (target dashed, median solid hairline)
    const labels = [];
    if (this.refs.target != null && this.refs.target >= lo && this.refs.target <= hi) {
      const y = Math.round(Y(this.refs.target)) + 0.5;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = alpha(c.ref, 0.65);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(this.w - padR, y);
      ctx.stroke();
      ctx.restore();
      labels.push({ y, text: `${this.refs.target} target`, color: c.ink2 });
    }
    if (this.refs.median != null && vis.length > 3) {
      const y = Math.round(Y(this.refs.median)) + 0.5;
      ctx.strokeStyle = alpha(c.ref, 0.35);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(this.w - padR, y);
      ctx.stroke();
      labels.push({ y, text: `median ${o.format(this.refs.median)}`, color: c.ink3 });
    }

    if (vis.length) {
      // area wash
      const segs = [];
      let cur = [];
      for (let i = 0; i < vis.length; i++) {
        if (i && vis[i].t - vis[i - 1].t > o.gapMs) {
          segs.push(cur);
          cur = [];
        }
        cur.push(vis[i]);
      }
      segs.push(cur);
      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, 0, pw, this.h);
      ctx.clip();
      const grad = ctx.createLinearGradient(0, padT, 0, padT + ph);
      grad.addColorStop(0, alpha(c.line, 0.24));
      grad.addColorStop(1, alpha(c.line, 0.01));
      for (const s of segs) {
        if (s.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(X(s[0].t), padT + ph);
        for (const p of s) ctx.lineTo(X(p.t), Y(p.v));
        ctx.lineTo(X(s[s.length - 1].t), padT + ph);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }
      ctx.lineWidth = o.axis ? 2 : 1.6;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = c.line;
      for (const s of segs) {
        ctx.beginPath();
        s.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.v)) : ctx.moveTo(X(p.t), Y(p.v))));
        ctx.stroke();
      }
      ctx.restore();

      // end dot with a surface ring
      const last = vis[vis.length - 1];
      if (last.t >= t0) this.dot(X(last.t), Y(last.v), c.line);
    }

    // reference labels on the right, nudged apart only if they truly collide
    if (labels.length) {
      ctx.font = MONO_B;
      ctx.textAlign = 'right';
      labels.sort((a, b) => a.y - b.y);
      if (labels.length === 2 && labels[1].y - labels[0].y < 12) {
        labels[1].alignLeft = true;
      }
      for (const l of labels) {
        const ty = l.y - 4 < padT + 8 ? l.y + 12 : l.y - 4;
        const tx = l.alignLeft ? padL + 4 : this.w - padR - 2;
        ctx.textAlign = l.alignLeft ? 'left' : 'right';
        const tw = ctx.measureText(l.text).width;
        ctx.fillStyle = alpha(c.surface, 0.85);
        ctx.fillRect(l.alignLeft ? tx - 2 : tx - tw - 2, ty - 9, tw + 4, 12);
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, tx, ty);
      }
    }

    // hover crosshair + tooltip
    if (this.hoverX != null && vis.length) {
      const t = t0 + ((this.hoverX - padL) / pw) * o.windowMs;
      let best = vis[0];
      for (const p of vis) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      if (best.t >= t0) {
        const x = Math.round(X(best.t)) + 0.5;
        ctx.strokeStyle = alpha(c.ink2, 0.5);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + ph);
        ctx.stroke();
        this.dot(x, Y(best.v), c.line);
        const secs = Math.round((this.now - best.t) / 1000);
        this.showTip(x, Y(best.v), [
          ['b', o.format(best.v, true)],
          ['span', secs <= 0 ? 'now' : `${secs}s ago`],
        ]);
      }
    }
  }

  dot(x, y, color) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = this.colors.surface;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/**
 * Horizontal bars for a sweep: one row per tier, bar = median fps, the solid
 * part ends at p10, a dashed line marks the target. The recommended tier is
 * drawn in the accent colour; the others are muted.
 */
export class SweepChart extends CanvasChart {
  constructor(host) {
    super(host);
    this.rows = [];
    this.target = 30;
    this.pick = null;
    this.hoverRow = -1;
    this.rowH = 32;
    host.addEventListener('pointermove', (e) => {
      const r = host.getBoundingClientRect();
      const y = e.clientY - r.top;
      const i = Math.floor((y - this.top) / this.rowH);
      const next = i >= 0 && i < this.rows.length ? i : -1;
      this.hoverY = y;
      this.hoverXPos = e.clientX - r.left;
      if (next !== this.hoverRow || next >= 0) {
        this.hoverRow = next;
        this.requestDraw();
      }
    });
    host.addEventListener('pointerleave', () => {
      this.hoverRow = -1;
      this.hideTip();
      this.requestDraw();
    });
  }

  set({ rows, target, pick }) {
    this.rows = rows;
    this.target = target;
    this.pick = pick;
    this.top = 20;
    this.host.style.height = `${this.top + rows.length * this.rowH + 20}px`;
    this.requestDraw();
  }

  draw() {
    if (!this.w) return;
    const ctx = this.begin();
    const c = this.colors;
    const tierColor = (t) => cssVar(`--tier-${t}`) || c.ink3;
    const labelW = 64;
    const valueW = 92;
    const x0 = labelW;
    const pw = Math.max(40, this.w - labelW - valueW);
    const maxV = Math.max(this.target * 1.2, ...this.rows.map((r) => r.fpsMedian * 1.08), 10);
    const step = niceStep(maxV / 4);
    const xMax = Math.ceil(maxV / step) * step;
    const X = (v) => x0 + (Math.max(0, v) / xMax) * pw;
    const top = this.top;
    const bottom = top + this.rows.length * this.rowH;

    // vertical grid + x labels
    ctx.font = MONO;
    ctx.lineWidth = 1;
    ctx.textAlign = 'center';
    for (let v = 0; v <= xMax + 1e-6; v += step) {
      const x = Math.round(X(v)) + 0.5;
      ctx.strokeStyle = c.grid;
      ctx.beginPath();
      ctx.moveTo(x, top - 4);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.fillStyle = c.axis;
      ctx.fillText(String(v), x, bottom + 14);
    }
    ctx.textAlign = 'left';
    ctx.fillText('fps', X(xMax) + 6, bottom + 14);

    // target
    const tx = Math.round(X(this.target)) + 0.5;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = alpha(c.ref, 0.75);
    ctx.beginPath();
    ctx.moveTo(tx, top - 8);
    ctx.lineTo(tx, bottom);
    ctx.stroke();
    ctx.restore();
    ctx.font = MONO_B;
    ctx.fillStyle = c.ink2;
    ctx.textAlign = 'center';
    ctx.fillText(`target ${this.target}`, tx, top - 11);

    this.rows.forEach((r, i) => {
      const y = top + i * this.rowH;
      const cy = y + this.rowH / 2;
      const isPick = r.tier === this.pick;
      // tier label with its swatch
      ctx.fillStyle = tierColor(r.tier);
      ctx.fillRect(2, cy - 4, 8, 8);
      ctx.font = MONO_11;
      ctx.fillStyle = c.ink1;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(r.tier.toUpperCase(), 16, cy);

      // bar: solid to p10, lighter to the median, 4px round end
      const bh = 16;
      const xe = X(r.fpsMedian);
      const xp = X(Math.min(r.fpsP10, r.fpsMedian));
      const col = isPick ? c.accent : c.ink4;
      this.bar(x0, cy - bh / 2, xe - x0, bh, alpha(col, isPick ? 0.45 : 0.4));
      this.bar(x0, cy - bh / 2, Math.max(0, xp - x0), bh, col, xe - xp < 3);
      // 2px surface gap at p10
      if (xe - xp >= 3) {
        ctx.fillStyle = c.surface;
        ctx.fillRect(xp - 1, cy - bh / 2, 2, bh);
      }

      // value + status at the bar's tip
      ctx.font = MONO_B;
      ctx.textAlign = 'left';
      const label = `${r.fpsMedian.toFixed(1)} / ${r.fpsP10.toFixed(1)}`;
      const lx = xe + 8;
      const lw = ctx.measureText(label).width;
      ctx.fillStyle = c.surface;
      ctx.fillRect(lx - 3, cy - 8, lw + 22, 15);
      ctx.fillStyle = c.ink1;
      ctx.fillText(label, lx, cy - 1);
      this.mark(lx + lw + 9, cy - 1, r.ok);
    });
    ctx.textBaseline = 'alphabetic';

    if (this.hoverRow >= 0) {
      ctx.fillStyle = alpha(c.ink3, 0.08);
      ctx.fillRect(0, top + this.hoverRow * this.rowH + 2, this.w, this.rowH - 4);
      const r = this.rows[this.hoverRow];
      const lines = [
        ['b', `${r.tier}: ${r.fpsMedian.toFixed(1)} fps median`],
        ['span', `p10 ${r.fpsP10.toFixed(1)} fps${r.memMB ? ` · ${Math.round(r.memMB)} MB` : ''}${r.scale ? ` · scale ${r.scale.toFixed(2)}` : ''}`],
        ['span', r.ok ? 'holds the target' : 'below the target'],
      ];
      this.showTip(Math.min(this.hoverXPos ?? 0, this.w - 10), top + this.hoverRow * this.rowH + 4, lines);
    }
  }

  bar(x, y, w, hgt, color, roundEnd = true) {
    if (w <= 0) return;
    const { ctx } = this;
    const r = roundEnd ? Math.min(4, w, hgt / 2) : 0;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w - r, y);
    if (r) ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + hgt - r);
    if (r) ctx.arcTo(x + w, y + hgt, x + w - r, y + hgt, r);
    ctx.lineTo(x, y + hgt);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  mark(x, y, ok) {
    const { ctx } = this;
    const c = this.colors;
    ctx.save();
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = ok ? c.ok : c.bad;
    ctx.beginPath();
    if (ok) {
      ctx.moveTo(x - 4, y);
      ctx.lineTo(x - 1, y + 3);
      ctx.lineTo(x + 4, y - 3.5);
    } else {
      ctx.moveTo(x - 3.5, y - 3.5);
      ctx.lineTo(x + 3.5, y + 3.5);
      ctx.moveTo(x + 3.5, y - 3.5);
      ctx.lineTo(x - 3.5, y + 3.5);
    }
    ctx.stroke();
    ctx.restore();
  }
}
