/**
 * The run report (docs/ENGINE.md 10.5): one self-contained report.html
 * (thumbnails inlined, capped near 10 MB) and a short report.md for PRs and chat.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Action, Cell, Finding, Severity, Trace } from './types.js';
import type { CoveragePoint, ExploreResult } from './explorer.js';
import type { FocusGraphRecord } from './oracles/focus.js';
import { stateLabel } from './abstraction.js';
import { actionKey } from './actions.js';

const SEV_ORDER: Severity[] = ['critical', 'major', 'minor', 'info'];
const MAX_INLINE_BYTES = 9.5 * 1024 * 1024;

export type ReportOptions = {
  /** Another run's coverage to draw as a dashed line (explore vs random). */
  baseline?: { label: string; coverage: CoveragePoint[]; findings?: number };
  /** Command prefix for copy-paste lines (default "firelab"). */
  cli?: string;
  /** How to show the run folder in commands and the footer (default its absolute path); e.g. a relative path for a report you publish. */
  dirLabel?: string;
};

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const KEY_GLYPH: Record<string, string> = { up: '▲', down: '▼', left: '◀', right: '▶', ok: 'OK', back: 'Back', menu: '☰', playpause: '⏯', rewind: '⏪', fastforward: '⏩', home: 'Home', search: 'Search', volup: 'Vol+', voldown: 'Vol−', mute: 'Mute', wake: 'Wake' };

export function keyLabel(a: Action): string {
  if (a.kind === 'wait') return `wait ${a.ms} ms`;
  if (a.kind === 'text') return `“${a.text}”`;
  if (a.kind === 'relaunch') return 'relaunch';
  let s = KEY_GLYPH[a.key] ?? a.key;
  if (a.mode === 'long') s += ' hold';
  else if (a.mode === 'hold') s += ` hold ${((a.holdMs ?? 800) / 1000).toFixed(1)}s`;
  if (a.repeat && a.repeat > 1) s += ` ×${a.repeat}`;
  return s;
}

function readTraceSafe(dir: string, file: string | undefined): Trace | undefined {
  if (!file) return undefined;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'traces', file), 'utf8')) as Trace;
  } catch {
    return undefined;
  }
}

const fmtDuration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

class Inliner {
  private used = 0;
  private readonly cache = new Map<string, string>();
  constructor(private readonly dir: string) {}
  uri(file: string | undefined, force = false): string | undefined {
    if (!file) return undefined;
    const hit = this.cache.get(file);
    if (hit) return hit;
    const p = path.join(this.dir, 'thumbs', path.basename(file));
    try {
      const b = fs.readFileSync(p);
      if (!force && this.used + b.length > MAX_INLINE_BYTES) return undefined;
      this.used += b.length;
      const u = `data:${/\.png$/i.test(file) ? 'image/png' : 'image/jpeg'};base64,${b.toString('base64')}`;
      this.cache.set(file, u);
      return u;
    } catch {
      return undefined;
    }
  }
}

/** Plain-words guidance per finding kind: what the viewer experiences and where to look first. */
export const KIND_HELP: Record<string, { name: string; why: string; look: string }> = {
  crash: { name: 'App crash', why: 'The app closes and the viewer lands back on the Fire TV home screen.', look: 'The stack trace in the log below: the first frame from your own package is usually the culprit.' },
  anr: { name: 'App not responding', why: 'The app froze long enough for Android to offer to close it.', look: 'Work on the main thread: big loads, sync network or disk calls, long loops in a key handler.' },
  'webview-renderer-gone': { name: 'WebView crashed', why: 'The page went blank or the app closed: the WebView renderer died, often from running out of memory on 1 GB sticks.', look: 'Texture and buffer sizes, memory growth over time; handle onRenderProcessGone to recover.' },
  'process-restarted': { name: 'App restarted by itself', why: 'The app died and Android started it again: the viewer loses their place.', look: 'A crash just before this step (check the log), or the system killing the app for memory.' },
  'unexpected-exit': { name: 'Key quit the app', why: 'A key took the viewer out of the app when they did not ask to leave.', look: 'Back/Escape handling: call preventDefault() on keys you handle, and only exit from the root screen.' },
  'js-exception': { name: 'JavaScript error', why: 'Code stopped half-way: the screen may not update, or a button silently does nothing.', look: 'The file and line in the message; often a missing null check in a key handler.' },
  'console-error': { name: 'Console error', why: 'Usually harmless (a missing icon), sometimes a missing asset the screen needs.', look: 'The URL or message in the log: check the asset exists on the server the TV loads from.' },
  'black-screen': { name: 'Black screen', why: 'The viewer sees nothing but black while the app is still open.', look: 'A canvas or video hidden and never shown again, a scene that did not start, or two starts racing each other.' },
  'frozen-screen': { name: 'Frozen picture', why: 'The picture stopped changing although the scene animates or keys usually change it.', look: 'The render loop and the input handlers of this scene; an exception inside requestAnimationFrame stops it.' },
  'render-loop-stopped': { name: 'Render loop stopped', why: 'The app says it is running, but no frame was drawn: the game looks frozen.', look: 'A requestAnimationFrame / setAnimationLoop callback that is not rescheduled, or that threw.' },
  'webgl-context-lost': { name: 'WebGL context lost', why: 'The GPU dropped the page\'s 3D context: the canvas goes blank.', look: 'GPU memory use; listen for webglcontextrestored and rebuild resources.' },
  'focus-trap': { name: 'Focus trap', why: 'Once focus is in this group, the arrows and Back cannot get out: a remote user has to force-quit.', look: 'Key handlers on these controls that swallow arrows or Back, or a focus map with no exit.' },
  'unreachable-control': { name: 'Unreachable control', why: 'The control is on screen, but no arrow-key path ever focuses it: remote users can never press it.', look: 'Your focus order or nextFocus mapping: the control is not in it, or the list wraps before it.' },
  'non-spatial-move': { name: 'Arrow goes the wrong way', why: 'An arrow key moves focus somewhere that does not match the layout, so the viewer gets lost.', look: 'Navigation that follows list order instead of the layout (common in grids); use spatial navigation.' },
  'focus-lost': { name: 'Focus lost', why: 'After this key nothing has focus, so the next presses seem to do nothing.', look: 'Focus moving to a hidden or removed element; give focus back explicitly after closing a panel.' },
  'dead-end': { name: 'Dead end', why: 'No key on the remote leaves this screen.', look: 'The screen\'s key handling: Back should always lead somewhere.' },
  plateau: { name: 'Exploration plateau', why: 'FireLab stopped finding new screens for a while (not a bug).', look: 'If big parts of the app are missing from the screen map, run longer or pass --state-expr.' },
};

function coverageSvg(main: CoveragePoint[], durationMs: number, baseline: ReportOptions['baseline'] | undefined, marks: { t: number; sev: Severity; id: string; n: number }[]): string {
  const W = 620;
  const H = 230;
  const L = 36;
  const B = 28;
  const T = 16;
  const R = 14;
  const tMax = Math.max(durationMs, ...main.map((p) => p.t), ...(baseline?.coverage.map((p) => p.t) ?? []), 1);
  const sMax = Math.max(4, ...main.map((p) => p.states), ...(baseline?.coverage.map((p) => p.states) ?? []));
  const x = (t: number) => L + (Math.min(t, tMax) / tMax) * (W - L - R);
  const y = (s: number) => H - B - (s / sMax) * (H - B - T);
  const at = (pts: CoveragePoint[], t: number) => {
    let s = 0;
    for (const p of pts) if (p.t <= t) s = p.states;
    return s;
  };
  const line = (pts: CoveragePoint[], end: number) => {
    if (!pts.length) return '';
    let d = `M${x(0).toFixed(1)},${y(0).toFixed(1)}`;
    let last = 0;
    for (const p of pts) {
      d += ` H${x(p.t).toFixed(1)} V${y(p.states).toFixed(1)}`;
      last = p.states;
    }
    return `${d} H${x(end).toFixed(1)} V${y(last).toFixed(1)}`;
  };
  const ticksY = [...new Set([0, Math.round(sMax / 2), sMax])];
  const minutes = tMax / 60000;
  const stepMin = minutes <= 2 ? 0.5 : minutes <= 10 ? 2 : minutes <= 30 ? 5 : minutes <= 90 ? 15 : 30;
  const ticksX: number[] = [];
  for (let m = 0; m <= minutes + 1e-9; m += stepMin) ticksX.push(m);
  const area = main.length ? `${line(main, tMax)} V${y(0).toFixed(1)} H${x(0).toFixed(1)} Z` : '';
  const dots = marks
    .map((m) => `<a href="#${esc(m.id)}"><circle cx="${x(m.t).toFixed(1)}" cy="${y(at(main, m.t)).toFixed(1)}" r="7" class="mk ${m.sev}"><title>#${m.n} found at ${fmtDuration(m.t)}</title></circle><text x="${x(m.t).toFixed(1)}" y="${(y(at(main, m.t)) + 3.5).toFixed(1)}" text-anchor="middle" class="mkn">${m.n}</text></a>`)
    .join('');
  return `<svg class="cov" viewBox="0 0 ${W} ${H}" role="img" aria-label="Distinct screens found over time, with the moment each finding appeared">
  <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".32"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
  ${ticksY.map((s) => `<line x1="${L}" x2="${W - R}" y1="${y(s)}" y2="${y(s)}" class="grid"/><text x="${L - 8}" y="${y(s) + 4}" text-anchor="end" class="ax">${s}</text>`).join('')}
  ${ticksX.map((m, i) => `<text x="${x(m * 60000)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === ticksX.length - 1 && x(m * 60000) > W - R - 20 ? 'end' : 'middle'}" class="ax">${m % 1 ? m.toFixed(1) : m}${m === 0 ? '' : ' min'}</text>`).join('')}
  ${area ? `<path d="${area}" fill="url(#g)"/>` : ''}
  ${baseline ? `<path d="${line(baseline.coverage, tMax)}" class="base"/>` : ''}
  <path d="${line(main, tMax)}" class="main"/>
  ${dots}
</svg>`;
}

function focusSvg(g: FocusGraphRecord, problems: Set<string>): string {
  const nodes = g.nodes.filter((n) => n.rect[2] > 0 && n.rect[3] > 0);
  if (nodes.length < 2) return '';
  const minX = Math.min(...nodes.map((n) => n.rect[0]));
  const minY = Math.min(...nodes.map((n) => n.rect[1]));
  const maxX = Math.max(...nodes.map((n) => n.rect[0] + n.rect[2]));
  const maxY = Math.max(...nodes.map((n) => n.rect[1] + n.rect[3]));
  const pad = 26;
  const W = 460;
  // Stretch vertically so the arrows between stacked rows have room (TV menus are tightly packed).
  const sx = (W - 2 * pad) / Math.max(1, maxX - minX);
  const sy = Math.min(Math.max(sx * 1.9, 0.5), 330 / Math.max(1, maxY - minY));
  const H = Math.max(120, (maxY - minY) * sy + 2 * pad);
  const ox = (W - (maxX - minX) * sx) / 2;
  const pos = new Map(
    nodes.map((n) => {
      const w = Math.max(24, n.rect[2] * sx * 0.8);
      const h = Math.min(26, Math.max(16, n.rect[3] * sx * 0.75));
      const cx = ox + (n.rect[0] - minX + n.rect[2] / 2) * sx;
      const cy = pad + (n.rect[1] - minY + n.rect[3] / 2) * sy;
      return [n.id, { x: cx - w / 2, y: cy - h / 2, w, h, n }];
    }),
  );
  const center = (id: string) => {
    const p = pos.get(id);
    return p ? { x: p.x + p.w / 2, y: p.y + p.h / 2 } : undefined;
  };
  const reached = new Set<string>(g.edges.flatMap((e) => [e.from, e.to]));
  const edges = g.edges
    .filter((e) => e.from !== e.to && pos.has(e.from) && pos.has(e.to))
    .map((e) => {
      const pa = pos.get(e.from) as { w: number; h: number };
      const pb = pos.get(e.to) as { w: number; h: number };
      const a = center(e.from) as { x: number; y: number };
      const b = center(e.to) as { x: number; y: number };
      const bad = problems.has(`${e.from}|${e.dir}|${e.to}`);
      const off = e.dir === 'up' || e.dir === 'left' ? -5 : 5;
      const vertical = Math.abs(b.y - a.y) > Math.abs(b.x - a.x);
      const [dx, dy] = vertical ? [off, 0] : [0, off];
      // Clip the arrow to the box edges, so it runs between the boxes, not under them.
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const exit = (w: number, h: number) => Math.min(vx ? w / 2 / Math.abs(vx) : Infinity, vy ? h / 2 / Math.abs(vy) : Infinity);
      const t0 = Math.min(0.45, exit(pa.w, pa.h) + 0.02);
      const t1 = Math.max(0.55, 1 - exit(pb.w, pb.h) - 0.02);
      const x1 = a.x + vx * t0 + dx;
      const y1 = a.y + vy * t0 + dy;
      const x2 = a.x + vx * t1 + dx;
      const y2 = a.y + vy * t1 + dy;
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="${bad ? 'fe bad' : 'fe'}" marker-end="url(#${bad ? 'ab' : 'a'})"><title>${esc(e.dir)}</title></line>`;
    })
    .join('');
  const boxes = [...pos.values()]
    .map((p) => `<g><rect x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" width="${p.w.toFixed(1)}" height="${p.h.toFixed(1)}" rx="5" class="${reached.has(p.n.id) ? 'fn' : 'fn un'}"/><text x="${(p.x + p.w / 2).toFixed(1)}" y="${(p.y + p.h / 2 + 4).toFixed(1)}" text-anchor="middle" class="fl">${esc((p.n.text ?? p.n.id).slice(0, 20))}</text></g>`)
    .join('');
  return `<svg viewBox="0 0 ${W} ${H.toFixed(0)}" class="fg" role="img" aria-label="Focus map"><defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--muted)"/></marker><marker id="ab" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--critical)"/></marker></defs>${boxes}${edges}</svg>`;
}

function keySteps(steps: Trace['steps'], max = 40): string {
  if (!steps.length) return '<p class="muted small">No keys: it shows right after the app starts.</p>';
  const shown = steps.slice(0, max).map((s, i) => `<li><span class="kn">${i + 1}</span><span class="k">${esc(keyLabel(s.action))}</span></li>`);
  if (steps.length > max) shown.push(`<li><span class="k more">+${steps.length - max} more</span></li>`);
  return `<ol class="keys">${shown.join('')}</ol>`;
}

/** A screen's label for people: the scene, then the app state as "key value" (no JSON, no zeros or nulls). */
export function screenLabel(c: Pick<Cell, 'key'>): string {
  const k = c.key;
  const parts: string[] = [];
  if (k.scene) parts.push(k.scene);
  if (k.modal) parts.push(k.modal);
  if (k.app) {
    let v: unknown;
    try {
      v = JSON.parse(k.app);
    } catch {
      v = k.app;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [name, x] of Object.entries(v as Record<string, unknown>)) {
        if (x === null || x === '' || x === 0 || x === false || x === undefined || String(x) === k.scene) continue;
        const val = typeof x === 'object' ? JSON.stringify(x) : String(x);
        parts.push(/^(mode|state|screen|scene|page|view)$/i.test(name) ? val : `${name} ${val}`);
      }
    } else if (v !== null && v !== undefined && String(v) !== k.scene) parts.push(String(v));
  }
  if (!parts.length) parts.push(k.focus ? `focus ${k.focus.split('>').pop()}` : (k.activity?.split('.').pop() ?? k.pkg));
  return parts.join(' · ');
}

const STATUS_LABEL: Record<Finding['status'], string> = { new: 'not replayed', confirmed: 'reproduces', flaky: 'flaky', 'not-reproduced': 'not reproduced' };
const SEV_WORD: Record<Severity, string> = { critical: 'Critical', major: 'Major', minor: 'Minor', info: 'Info' };

export function renderReportHtml(r: ExploreResult, opts: ReportOptions = {}): string {
  const cli = opts.cli ?? 'firelab';
  const inl = new Inliner(r.dir);
  const findings = [...r.findings].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || a.step - b.step);
  const counts = Object.fromEntries(SEV_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length])) as Record<Severity, number>;
  const serious = counts.critical + counts.major;
  const bugs = findings.filter((f) => f.severity !== 'info');
  const reproducible = bugs.filter((f) => f.status === 'confirmed').length;
  const problems = new Set<string>();
  for (const f of findings)
    if (f.kind === 'non-spatial-move') {
      const [, , from, dir, to] = f.signature.split('|');
      problems.add(`${from}|${dir}|${to}`);
    }
  const findingCells = new Set(findings.map((f) => f.stateId));
  const app = r.config.app.package;
  const devName = r.device.name ?? r.device.model ?? r.device.serial;
  const devBits = [r.device.model && r.device.name ? r.device.model : undefined, r.device.os, r.device.ramMB ? `${r.device.ramMB} MB RAM` : undefined, r.device.tier ? `tier ${r.device.tier}` : undefined].filter(Boolean).join(' · ');
  const strategy = r.strategy === 'random' ? 'random baseline' : r.strategy === 'monkey' ? 'Monkey baseline' : 'Go-Explore';
  const num = new Map(findings.map((f, i) => [f.id, i + 1]));

  // ---- verdict ----
  const verdictCls = counts.critical ? 'bad' : serious ? 'warn' : 'good';
  const verdictTitle = serious ? `${serious} problem${serious === 1 ? '' : 's'} need${serious === 1 ? 's' : ''} attention` : bugs.length ? 'No serious problems found' : 'No problems found';
  const sevPhrase = SEV_ORDER.filter((s) => s !== 'info' && counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(', ');
  const verdictText = `FireLab played <b>${esc(app)}</b> on a <b>${esc(devName)}</b> for ${esc(fmtDuration(r.durationMs))}: ${r.steps} key presses, ${r.states} different screens. ${bugs.length ? `It found ${sevPhrase}${reproducible ? `; ${reproducible} reproduce${reproducible === 1 ? 's' : ''} reliably from a fresh launch` : ''}.` : 'Nothing went wrong.'}${r.stopped !== 'budget' ? ` The run was ${r.stopped === 'aborted' ? 'stopped early' : `cut short by an error${r.error ? ` (${esc(r.error)})` : ''}`}.` : ''}`;

  // ---- overview table ----
  const rows = findings
    .map((f) => {
      const t = readTraceSafe(r.dir, f.minimized) ?? readTraceSafe(r.dir, f.trace);
      const help = KIND_HELP[f.kind];
      const rate = f.repro ? `${f.repro.hits}/${f.repro.runs}` : '–';
      return `<tr data-sev="${f.severity}"><td class="n">${num.get(f.id)}</td><td><span class="pill ${f.severity}">${SEV_WORD[f.severity]}</span></td><td><a href="#${esc(f.id)}">${esc(f.title)}</a><div class="small muted">${esc(help?.name ?? f.kind)}</div></td><td class="c"><span class="rate st-${f.status}" title="${STATUS_LABEL[f.status]}">${rate}</span></td><td class="c">${t ? t.steps.length : '–'}</td></tr>`;
    })
    .join('');
  const filters = SEV_ORDER.filter((s) => counts[s])
    .map((s) => `<button type="button" class="flt ${s}" data-sev="${s}" aria-pressed="false">${SEV_WORD[s]} <b>${counts[s]}</b></button>`)
    .join('');

  // ---- cards ----
  const cards = findings
    .map((f) => {
      const full = readTraceSafe(r.dir, f.trace);
      const min = readTraceSafe(r.dir, f.minimized);
      const t = min ?? full;
      const help = KIND_HELP[f.kind];
      const shot = inl.uri(f.evidence.thumbs[0], true);
      const strip = f.evidence.thumbs
        .slice(1)
        .map((th) => inl.uri(th))
        .filter(Boolean)
        .map((u, i, a) => `<figure><img src="${u}" alt="" loading="lazy"><figcaption>${i === a.length - 1 ? 'last screen' : `${a.length - i} back`}</figcaption></figure>`)
        .join('');
      const traceFile = path.join(opts.dirLabel ?? r.dir, 'traces', f.minimized ?? f.trace);
      const cmd = `${cli} replay ${traceFile} --times 5`;
      const rate = f.repro ? `${f.repro.hits}/${f.repro.runs}` : '';
      const statusText = f.status === 'new' ? 'not replayed yet' : `${STATUS_LABEL[f.status]}${rate ? ` ${rate} replays` : ''}`;
      const shrunk = min && f.shrink && f.shrink.before > min.steps.length ? `shrunk from ${f.shrink.before} keys` : '';
      const reproTitle = t ? `${t.steps.length} key${t.steps.length === 1 ? '' : 's'} from a fresh launch` : 'trace missing';
      const logs = f.evidence.logs.length ? `<details><summary>Log · ${f.evidence.logs.length} line${f.evidence.logs.length === 1 ? '' : 's'}</summary><pre>${esc(f.evidence.logs.slice(0, 24).join('\n'))}</pre></details>` : '';
      const probe = f.evidence.probe ? `<details><summary>App state when found</summary><pre>${esc(JSON.stringify(f.evidence.probe, null, 1).slice(0, 2000))}</pre></details>` : '';
      const files = `<details><summary>Files</summary><p class="small"><a href="traces/${esc(f.trace)}">traces/${esc(f.trace)}</a>${f.minimized ? ` · <a href="traces/${esc(f.minimized)}">traces/${esc(f.minimized)}</a>` : ''}<br><span class="muted">signature</span> <code>${esc(f.signature)}</code>${f.count && f.count > 1 ? `<br><span class="muted">seen ${f.count} times during the run</span>` : ''}</p></details>`;
      return `<article class="card sev-${f.severity}" id="${esc(f.id)}" data-sev="${f.severity}">
  <header class="ch"><span class="no">#${num.get(f.id)}</span><span class="pill ${f.severity}">${SEV_WORD[f.severity]}</span><span class="kind">${esc(help?.name ?? f.kind)}</span><span class="status st-${f.status}">${esc(statusText)}</span></header>
  <h3>${esc(f.title)}</h3>
  <div class="cb">
    <div class="shot">${shot ? `<img src="${shot}" alt="The TV screen when this was found">` : '<div class="noshot">no screenshot</div>'}${strip ? `<div class="strip" aria-label="Screens on the way there">${strip}</div>` : ''}</div>
    <div class="body">
      ${help ? `<div class="explain"><p><b>What the viewer sees.</b> ${esc(help.why)}</p><p><b>Where to look.</b> ${esc(help.look)}</p></div>` : ''}
      <div class="repro"><div class="rl"><b>Reproduce</b> · ${esc(reproTitle)}${shrunk ? ` <span class="muted">(${shrunk})</span>` : ''}${t?.expect?.investigate ? ' <span class="muted">· then FireLab walks the focus</span>' : ''}</div>
        ${t ? keySteps(t.steps) : ''}
        <div class="cmd"><code>${esc(cmd)}</code><button type="button" data-copy="${esc(cmd)}">Copy</button></div>
      </div>
      <details${f.detail.length < 260 ? ' open' : ''}><summary>Details</summary><p class="detail">${esc(f.detail.length > 1200 ? f.detail.slice(0, 1197) + '…' : f.detail)}</p></details>
      ${logs}${probe}${files}
    </div>
  </div>
</article>`;
    })
    .join('\n');

  // ---- screens ----
  const cells = [...r.cells].sort((a, b) => b.visits - a.visits);
  const maxVisits = Math.max(1, ...cells.map((c) => c.visits));
  const tile = (c: Cell) => {
    const u = inl.uri(c.thumb);
    const big = c.visits >= maxVisits * 0.5;
    const frontier = c.chosen === 0;
    const label = screenLabel(c);
    return `<figure class="st${big ? ' l' : ''}${frontier ? ' frontier' : ''}${findingCells.has(c.id) ? ' hasf' : ''}" title="${esc(`${label} · ${c.visits} visits · ${c.depth} keys from launch\n${stateLabel(c)}`)}">${u ? `<img src="${u}" alt="" loading="lazy">` : '<div class="noshot small">no picture</div>'}<figcaption><span class="lbl">${esc(label.slice(0, 60))}</span><span class="vis">${c.visits}×</span></figcaption></figure>`;
  };
  const focusMaps = r.focusGraphs
    .map((g) => ({ g, svg: focusSvg(g, problems) }))
    .filter((x) => x.svg)
    .map((x) => `<figure class="fmap">${x.svg}<figcaption>${x.g.nodes.length} controls · ${x.g.edges.length} arrow moves tested</figcaption></figure>`)
    .join('');
  const marks = findings.filter((f) => f.severity !== 'info').map((f) => ({ t: Math.max(0, f.ts - r.startedAt), sev: f.severity, id: f.id, n: num.get(f.id) as number }));
  const legend = `<div class="legend"><span><i class="lm"></i>${esc(strategy)} · ${r.states} screens</span>${opts.baseline ? `<span><i class="lb"></i>${esc(opts.baseline.label)} · ${opts.baseline.coverage.at(-1)?.states ?? 0} screens</span>` : ''}${marks.length ? '<span><i class="ld"></i>a finding (click it)</span>' : ''}</div>`;
  const stat = (v: string, l: string) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
  const sevTiles = SEV_ORDER.filter((s) => s !== 'info')
    .map((s) => `<a class="tile ${s}${counts[s] ? '' : ' zero'}" href="#findings"><b>${counts[s]}</b><span>${SEV_WORD[s]}</span></a>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FireLab report · ${esc(app)}</title>
<style>
:root{--bg:#0b0f14;--panel:#131a22;--panel2:#1a222d;--line:#26313f;--text:#e8eef5;--soft:#c4cfdb;--muted:#8796a8;--accent:#ff9e3d;--critical:#ff5d5d;--major:#ffb02e;--minor:#5aa9ff;--info:#8796a8;--ok:#3fcf6b;--code:#0a0e13;color-scheme:dark}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:70px}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1200px;margin:0 auto;padding:0 20px 64px}
.small{font-size:13px}.muted{color:var(--muted)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
nav.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
nav.top .in{max-width:1200px;margin:0 auto;padding:10px 20px;display:flex;align-items:center;gap:18px}
.logo{display:flex;align-items:center;gap:8px;font-weight:800;letter-spacing:.02em;text-decoration:none}
.logo i{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#ffb35c,#ff6a3d);display:inline-block;box-shadow:0 0 18px #ff8a3d55}
nav.top .links{display:flex;gap:4px;margin-left:auto;overflow-x:auto}
nav.top .links a{text-decoration:none;color:var(--muted);font-size:14px;padding:6px 10px;border-radius:8px;white-space:nowrap}
nav.top .links a:hover{color:var(--text);background:var(--panel)}
.head{padding:28px 0 8px}
.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:700}
h1{margin:6px 0 4px;font-size:clamp(24px,3.4vw,34px);line-height:1.15;word-break:break-word}
.sub{color:var(--muted);font-size:14px}
.verdict{margin:20px 0 22px;border-radius:16px;padding:20px 22px;display:flex;gap:18px;align-items:flex-start;border:1px solid var(--vc);background:linear-gradient(90deg,color-mix(in srgb,var(--vc) 16%,transparent),color-mix(in srgb,var(--vc) 4%,transparent))}
.verdict.bad{--vc:var(--critical)}.verdict.warn{--vc:var(--major)}.verdict.good{--vc:var(--ok)}
.verdict .ic{flex:none;width:44px;height:44px;border-radius:50%;background:var(--vc);color:#111;display:grid;place-items:center;font-weight:900;font-size:24px}
.verdict h2{margin:0 0 4px;font-size:22px}
.verdict p{margin:0;color:var(--soft)}
.grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr);gap:18px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px}
.panel h2,.ph{margin:0 0 12px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:650}
.tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.tile{display:block;text-decoration:none;border-radius:12px;padding:12px 14px;background:var(--panel2);border-top:3px solid var(--c)}
.tile b{display:block;font-size:clamp(28px,3.6vw,40px);line-height:1.05;color:var(--c)}
.tile span{color:var(--muted);font-size:13px}
.tile.zero{opacity:.4}
.critical{--c:var(--critical)}.major{--c:var(--major)}.minor{--c:var(--minor)}.info{--c:var(--info)}
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}
.stat{background:var(--panel2);border-radius:12px;padding:10px 14px}
.stat b{display:block;font-size:20px}
.stat span{color:var(--muted);font-size:12px}
.cov{width:100%;height:auto;display:block}
.cov .grid{stroke:var(--line)}.cov .ax{fill:var(--muted);font-size:11px}
.cov .main{fill:none;stroke:var(--accent);stroke-width:2.5;stroke-linejoin:round}
.cov .base{fill:none;stroke:var(--muted);stroke-width:2;stroke-dasharray:6 5}
.cov .mk{stroke:var(--panel);stroke-width:2.5;fill:var(--c)}.cov .mkn{font-size:9px;font-weight:800;fill:#111;pointer-events:none}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--muted);font-size:13px;margin-top:8px}
.legend i{display:inline-block;vertical-align:middle;margin-right:7px}
.lm{width:22px;border-top:3px solid var(--accent)}.lb{width:22px;border-top:2px dashed var(--muted)}.ld{width:11px;height:11px;border-radius:50%;background:var(--critical)}
h2.sec{font-size:22px;margin:40px 0 6px}
p.lead{margin:0 0 16px;color:var(--muted)}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}
.flt{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}
.flt b{color:var(--c)}.flt[aria-pressed=true]{border-color:var(--c);background:color-mix(in srgb,var(--c) 16%,var(--panel))}
table.ov{width:100%;border-collapse:separate;border-spacing:0;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.ov th{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600;text-align:left;padding:10px 12px;background:var(--panel2)}
.ov td{padding:10px 12px;border-top:1px solid var(--line);vertical-align:top}
.ov td a{text-decoration:none;font-weight:600}.ov td a:hover{text-decoration:underline}
.ov .n{color:var(--muted);width:36px}.ov .c,.ov th.c{text-align:center;width:90px}
.pill{display:inline-block;background:var(--c);color:#111;font-weight:800;border-radius:6px;padding:1px 8px;font-size:11px;letter-spacing:.04em;text-transform:uppercase}
.rate{display:inline-block;min-width:44px;border-radius:999px;padding:1px 8px;font-size:13px;border:1px solid var(--line);color:var(--muted)}
.st-confirmed{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 55%,transparent)}.st-flaky{color:var(--major);border-color:color-mix(in srgb,var(--major) 45%,transparent)}
.card{background:var(--panel);border:1px solid var(--line);border-top:3px solid var(--c);border-radius:16px;padding:18px;margin:0 0 16px}
.card.sev-critical{--c:var(--critical)}.card.sev-major{--c:var(--major)}.card.sev-minor{--c:var(--minor)}.card.sev-info{--c:var(--info)}
.ch{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;font-size:13px}
.no{font-weight:800;color:var(--muted)}
.kind{color:var(--soft);font-size:12.5px}
.status{margin-left:auto;border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--muted)}
.card h3{margin:8px 0 14px;font-size:clamp(18px,2vw,21px);line-height:1.3}
.cb{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:20px}
.shot img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:10px;display:block;background:#000;border:1px solid var(--line)}
.noshot{aspect-ratio:16/9;border-radius:10px;background:var(--panel2);display:grid;place-items:center;color:var(--muted)}
.strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin-top:8px}
.strip figure{margin:0}.strip img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:6px;display:block;border:1px solid var(--line);opacity:.9}
.strip figcaption{font-size:10.5px;color:var(--muted);text-align:center;margin-top:2px}
.explain{background:var(--panel2);border-radius:12px;padding:10px 14px;margin-bottom:12px}
.explain p{margin:4px 0;color:var(--soft);font-size:14px}.explain b{color:var(--text)}
.repro{border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.rl{font-size:13px;color:var(--soft);margin-bottom:10px}
ol.keys{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:10px 8px}
ol.keys li{display:flex;align-items:center;gap:4px}
.kn{font-size:10px;color:var(--muted);min-width:12px;text-align:right}
.k{display:inline-block;min-width:38px;text-align:center;padding:5px 10px;border-radius:8px;background:#28323f;border:1px solid #3a4757;border-bottom-width:3px;font-weight:700;font-size:14px;white-space:nowrap}
.k.more{background:none;border-style:dashed;color:var(--muted);font-weight:400}
.cmd{display:flex;gap:8px;margin-top:12px}
.cmd code{flex:1;min-width:0;overflow-x:auto;white-space:nowrap;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:12px;color:var(--soft)}
.cmd button{flex:none;background:var(--accent);color:#111;border:0;border-radius:8px;padding:0 14px;font-weight:800;cursor:pointer}
details{margin-top:10px;font-size:13.5px;border-top:1px solid var(--line);padding-top:8px}
summary{cursor:pointer;color:var(--muted);font-weight:600}summary:hover{color:var(--text)}
.detail{margin:8px 0 0;color:var(--soft);white-space:pre-wrap;word-break:break-word}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;max-height:280px;font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--soft)}
.empty{padding:40px;text-align:center;background:var(--panel);border:1px dashed var(--line);border-radius:16px;color:var(--soft)}
.map{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;grid-auto-flow:dense}
.st{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:6px;position:relative}
.st.l{grid-column:span 2}
.st img,.st .noshot{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:8px;display:block}
.st figcaption{display:flex;gap:6px;font-size:11.5px;color:var(--muted);margin-top:5px;padding:0 2px}
.st .lbl{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.st .vis{flex:none}
.st.frontier{border-style:dashed;border-color:color-mix(in srgb,var(--accent) 70%,transparent)}
.st.hasf::after{content:"";position:absolute;top:12px;right:12px;width:12px;height:12px;border-radius:50%;background:var(--critical);box-shadow:0 0 0 3px var(--panel)}
.keyrow{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px;color:var(--muted);margin:0 0 12px}
.fmaps{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,440px),1fr));gap:12px}
.fmap{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px}
.fmap figcaption{font-size:12px;color:var(--muted);text-align:center}
.fg{width:100%;height:auto}.fn{fill:var(--panel2);stroke:#4b5b70}.fn.un{stroke:var(--critical);stroke-dasharray:4 3}.fl{fill:var(--text);font-size:10px}
.fe{stroke:#8fa1b6;stroke-width:1.6;opacity:.75}.fe.bad{stroke:var(--critical);stroke-width:2.6;opacity:1}
dl.cfg{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 18px;margin:0;font-size:14px}
dl.cfg dt{color:var(--muted)}dl.cfg dd{margin:0;word-break:break-word}
ul.notes{margin:12px 0 0;padding-left:20px;color:var(--soft)}ul.notes li{margin:6px 0}
footer{margin-top:44px;color:var(--muted);font-size:12.5px;border-top:1px solid var(--line);padding-top:14px;display:flex;flex-wrap:wrap;gap:6px 18px;word-break:break-all}
.hide{display:none!important}
@media (max-width:900px){.grid2,.cb{grid-template-columns:minmax(0,1fr)}.st.l{grid-column:auto}.ov .c:last-child,.ov th:last-child{display:none}}
@media (max-width:560px){.wrap,nav.top .in{padding-left:16px;padding-right:16px}.ov th,.ov td{padding:8px 7px}.ov .n,.ov th:first-child{display:none}.ov .c,.ov th.c{width:auto}.ov td a{word-break:break-word}nav.top .links a{padding:6px 7px;font-size:13px}.verdict{flex-direction:column;gap:10px}.tiles{gap:6px}.stats{grid-template-columns:1fr 1fr}.strip{grid-template-columns:repeat(3,minmax(0,1fr))}.strip figure:nth-child(n+4){display:none}.status{margin-left:0}}
@media print{nav.top,.cmd button,.filters{display:none}body{background:#fff;color:#000}.card,.panel,table.ov{break-inside:avoid}}
</style>
</head>
<body>
<nav class="top"><div class="in"><a class="logo" href="#top"><i></i>FireLab</a><div class="links"><a href="#summary">Summary</a><a href="#findings">Findings${bugs.length ? ` (${bugs.length})` : ''}</a><a href="#screens">Screens</a>${focusMaps ? '<a href="#focus">Focus</a>' : ''}<a href="#run">Run</a></div></div></nav>
<div class="wrap" id="top">
<div class="head"><div class="eyebrow">Game testing report</div><h1>${esc(app)}</h1><div class="sub">${esc(devName)}${devBits ? ` · ${esc(devBits)}` : ''}${r.config.app.url ? ` · <span title="${esc(r.config.app.url)}">${esc(r.config.app.url.length > 70 ? r.config.app.url.slice(0, 67) + '…' : r.config.app.url)}</span>` : ''}</div></div>
<section class="verdict ${verdictCls}" id="summary"><div class="ic" aria-hidden="true">${verdictCls === 'good' ? '✓' : '!'}</div><div><h2>${esc(verdictTitle)}</h2><p>${verdictText}</p></div></section>
<section class="grid2">
  <div class="panel"><h2>Findings by severity</h2><div class="tiles">${sevTiles}</div>
    <div class="stats">${stat(esc(fmtDuration(r.durationMs)), 'on the device')}${stat(String(r.steps), 'key presses')}${stat(String(r.states), 'different screens')}${stat(bugs.length ? `${reproducible}/${bugs.length}` : '–', 'reproduce reliably')}</div>
  </div>
  <div class="panel"><h2>Screens found over time</h2>${coverageSvg(r.coverage, r.durationMs, opts.baseline, marks)}${legend}</div>
</section>

<h2 class="sec" id="findings">Findings</h2>
${findings.length ? `<p class="lead">Most severe first. Each one comes with the keys that reproduce it from a fresh launch, so you can watch it happen with <code>${esc(cli)} replay</code>.</p>
<div class="filters" role="group" aria-label="Filter by severity">${filters}</div>
<table class="ov"><thead><tr><th>#</th><th>Severity</th><th>Finding</th><th class="c">Repro</th><th class="c">Keys</th></tr></thead><tbody>${rows}</tbody></table>
<div style="height:18px"></div>
${cards}` : '<div class="empty"><b>No findings.</b><br>FireLab didn\'t see a crash, error, black or frozen screen, or a focus problem in this run.</div>'}

<h2 class="sec" id="screens">Screens explored</h2>
<p class="lead">Every different screen FireLab reached, most visited first.</p>
<div class="keyrow"><span>Big tile = visited a lot</span><span>Dashed = reached but never explored from</span><span>Red dot = a finding happened here</span></div>
<div class="map">${cells.map(tile).join('')}</div>
${focusMaps ? `<h2 class="sec" id="focus">Focus maps</h2><p class="lead">What the arrow keys do on each screen FireLab walked. Red arrows disagree with the layout; red dashed boxes were never reached.</p><div class="fmaps">${focusMaps}</div>` : ''}

<h2 class="sec" id="run">Run details</h2>
<div class="panel"><dl class="cfg">
<dt>Strategy</dt><dd>${esc(strategy)} · seed ${r.config.seed}${r.config.minutes ? ` · ${r.config.minutes} min budget` : ''}${r.config.steps ? ` · ${r.config.steps} steps budget` : ''}</dd>
<dt>Keys used</dt><dd>${esc(r.config.keys.join(' '))}</dd>
<dt>Checks</dt><dd>${esc(r.config.oracles.join(', '))}</dd>
${r.config.stateExpr ? `<dt>App state</dt><dd><code>${esc(r.config.stateExpr)}</code></dd>` : ''}${r.config.focusSelector ? `<dt>Focus selector</dt><dd><code>${esc(r.config.focusSelector)}</code></dd>` : ''}
<dt>Device time</dt><dd>${r.stepMs ? `${(r.stepMs / 1000).toFixed(1)} s per key press · ` : ''}${r.counters.relaunches} app launches · ${r.counters.investigations} focus walks</dd>
${r.depth ? `<dt>Depth</dt><dd>deepest screen ${r.depth.max} key presses from launch · mean ${r.depth.mean} · ${Object.entries(r.depth.histogram).map(([k, v]) => `${esc(k)}: ${v}`).join(', ')}</dd>` : ''}${r.jsCoverage ? `<dt>JS coverage</dt><dd>${r.jsCoverage.blocks} blocks in ${r.jsCoverage.functions} functions${r.jsCoverage.scripts.length ? ` · ${r.jsCoverage.scripts.slice(0, 4).map((s) => `${esc(s.url.split('/').pop() || s.url)} ${s.blocks}`).join(', ')}` : ''}</dd>` : ''}
<dt>Getting around</dt><dd>${r.counters.returnsGraph} returns over known keys · ${r.counters.returnsReplay} by relaunch and replay · ${r.counters.returnsFailed} missed</dd>
<dt>Device</dt><dd>${esc([devName, devBits, r.device.serial].filter(Boolean).join(' · '))}</dd>
</dl>
${r.notes.length ? `<ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
</div>
<footer><span>Run ${esc(r.runId)}</span><span>${esc(new Date(r.startedAt).toISOString().replace('T', ' ').slice(0, 16))} UTC</span><span>Made with FireLab · <code>${esc(cli)} report ${esc(opts.dirLabel ?? r.dir)}</code> rebuilds this page</span></footer>
</div>
<script>
document.addEventListener('click',function(e){
  var b=e.target.closest('button[data-copy]');
  if(b){navigator.clipboard&&navigator.clipboard.writeText(b.dataset.copy).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1200)});return}
  var f=e.target.closest('button.flt');if(!f)return;
  var on=f.getAttribute('aria-pressed')!=='true';
  document.querySelectorAll('button.flt').forEach(function(x){x.setAttribute('aria-pressed','false')});
  if(on)f.setAttribute('aria-pressed','true');
  var s=on?f.dataset.sev:null;
  document.querySelectorAll('tr[data-sev],article[data-sev]').forEach(function(el){el.classList.toggle('hide',!!s&&el.dataset.sev!==s)});
});
</script>
</body></html>
`;
}

export function renderReportMd(r: ExploreResult, opts: ReportOptions = {}): string {
  const cli = opts.cli ?? 'firelab';
  const findings = [...r.findings].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || a.step - b.step);
  const lines: string[] = [];
  lines.push(`## FireLab Engine: ${r.config.app.package}`);
  lines.push('');
  lines.push(`${r.device.name ?? r.device.model ?? r.device.serial} · ${fmtDuration(r.durationMs)} · ${r.steps} steps · ${r.states} states${r.depth ? ` · ${r.depth.max} deep` : ''}${r.jsCoverage ? ` · ${r.jsCoverage.blocks} JS blocks` : ''} · ${r.strategy === 'random' ? 'random baseline' : r.strategy === 'monkey' ? 'Monkey baseline' : 'Go-Explore'} (seed ${r.config.seed})`);
  lines.push('');
  if (!findings.length) lines.push('No findings.');
  else {
    lines.push('| Severity | Finding | Repro | Keys |', '|---|---|---|---|');
    for (const f of findings) {
      const t = readTraceSafe(r.dir, f.minimized) ?? readTraceSafe(r.dir, f.trace);
      const keys = t ? t.steps.map((s) => actionKey(s.action)) : [];
      const k = keys.length > 16 ? `${keys.slice(0, 16).join(' ')} … (+${keys.length - 16})` : keys.join(' ');
      const rate = f.repro ? `${STATUS_LABEL[f.status]} ${f.repro.hits}/${f.repro.runs}` : STATUS_LABEL[f.status];
      lines.push(`| ${f.severity} | ${f.title.replace(/\|/g, '\\|')} | ${rate} | \`${k || '(launch)'}\` |`);
    }
    lines.push('');
    const top = findings[0] as Finding;
    lines.push(`Replay one: \`${cli} replay ${path.join(opts.dirLabel ?? r.dir, 'traces', top.minimized ?? top.trace)} --times 5\``);
  }
  if (r.notes.length) {
    lines.push('', '<details><summary>Notes</summary>', '');
    for (const n of r.notes) lines.push(`- ${n}`);
    lines.push('', '</details>');
  }
  lines.push('', `Full report: \`${path.join(opts.dirLabel ?? r.dir, 'report.html')}\``);
  return lines.join('\n') + '\n';
}

export function writeReport(r: ExploreResult, opts: ReportOptions = {}): { html: string; md: string } {
  const html = path.join(r.dir, 'report.html');
  const md = path.join(r.dir, 'report.md');
  fs.writeFileSync(html, renderReportHtml(r, opts));
  fs.writeFileSync(md, renderReportMd(r, opts));
  return { html, md };
}
