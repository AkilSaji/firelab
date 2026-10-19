/**
 * `--report fit.html`: one self-contained HTML file (inline CSS and SVG, no
 * scripts, no external requests) with the headline verdict, the models x
 * checks matrix, reasons and fixes, basis and confidence, the device it was
 * measured on, the runs and the media findings.
 */
import { describeMedia } from '../../media/check.js';
import { GPU_FAMILIES } from '../gpus.js';
import { RESERVE_COMFORT_MB, RESERVE_HARD_MB } from '../memory.js';
import { LABEL } from '../score.js';
import { COLUMNS, activeColumns, appName, columnCell } from '../markdown.js';
import { VERDICT_LABEL, type CheckResult, type CheckStatus, type Confidence, type FitReport, type ModelFit, type Verdict } from '../types.js';
import { REPORT_CSS } from './style.js';

export const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const ICON = {
  pass: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  warn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M8 3.5v5.5"/><path d="M8 12.5v.01"/></svg>',
  fail: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
  skip: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 8h6"/></svg>',
};
const BIG = {
  runs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
  risky: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5L2.8 19.5h18.4z"/><path d="M12 10v4.5"/><path d="M12 17.2v.01"/></svg>',
  'wont-run': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  'not-covered': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 12h12"/></svg>',
};
const LOGO =
  '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0e1114"/><rect x="4.5" y="6.5" width="23" height="16" rx="3" fill="none" stroke="#eef1f4" stroke-width="2"/><path d="M12 26.5h8" stroke="#eef1f4" stroke-width="2" stroke-linecap="round"/><path d="M16.3 9.4c1.1 2.3 3.8 3.4 3.8 6.6 0 2.4-1.8 4.1-4.1 4.1s-4.1-1.7-4.1-3.8c0-1.7 1.1-2.9 1.9-3.6.1 1.3.7 2.2 1.6 2.3-.3-2.1-.1-4.1 .9-5.6z" fill="#ff7b29"/></svg>';

const STATUS_WORD: Record<CheckStatus, string> = { pass: 'ok', warn: 'risky', fail: "won't run", skip: 'not checked' };
const statusMark = (s: CheckStatus) => `<span class="st st-${s}" role="img" aria-label="${esc(STATUS_WORD[s])}" title="${esc(STATUS_WORD[s])}">${ICON[s]}</span>`;
const verdictMark = (v: Verdict) => statusMark(v === 'runs' ? 'pass' : v === 'risky' ? 'warn' : v === 'wont-run' ? 'fail' : 'skip');
const verdictTag = (v: Verdict) => `<span class="verdict v-${v}">${verdictMark(v)}${esc(VERDICT_LABEL[v])}</span>`;
const basisBadge = (b: string, simulated?: boolean) => `<span class="badge b-${esc(b)}">${esc(b)}${simulated ? ' (sim)' : ''}</span>`;
const confDots = (c: Confidence) => {
  const n = c === 'high' ? 3 : c === 'medium' ? 2 : 1;
  return `<span class="conf" title="confidence: ${c}">${[1, 2, 3].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}<span>${c}</span></span>`;
};
const tierChip = (t?: string) => (t ? `<span class="tier tier--${esc(t)}">${esc(t)}</span>` : '');
const ram = (mb?: number) => (mb ? (mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`) : 'RAM ?');
const fileName = (s: string) => s.replace(/[?#].*$/, '').split(/[\\/]/).pop() || s;

const GROUPS: { kind: ModelFit['kind'] | 'vega'; label: string }[] = [
  { kind: 'stick', label: 'Fire TV Sticks' },
  { kind: 'cube', label: 'Fire TV Cube' },
  { kind: 'box', label: 'Fire TV boxes' },
  { kind: 'tv', label: 'Smart TVs with Fire TV built in' },
  { kind: 'vega', label: 'Not covered: Vega OS' },
];

function cell(m: ModelFit, checks: CheckResult['id'][]): string {
  const c = columnCell(m, checks);
  if (!c) return `<td><div class="cell none">${statusMark('skip')}–</div></td>`;
  const label = checks.map((id) => m.checks.find((x) => x.id === id && x.status !== 'skip')).filter(Boolean).map((x) => `${LABEL[(x as CheckResult).id]}: ${(x as CheckResult).reason}`).join('\n');
  return `<td title="${esc(label)}"><div class="cell">${statusMark(c.status)}<div>${esc(c.summary)}${c.simulated ? '<small>simulated</small>' : ''}</div></div></td>`;
}

function whyRow(m: ModelFit, span: number, collapsed = false): string {
  const bad = m.checks.filter((c) => c.status === 'fail' || c.status === 'warn').sort((a, b) => (a.status === b.status ? 0 : a.status === 'fail' ? -1 : 1));
  if (!bad.length && m.verdict !== 'not-covered') return '';
  const reasons = bad.length ? bad.map((c) => `<li>${statusMark(c.status)}<div><b>${esc(LABEL[c.id])}.</b> ${esc(c.reason)} <span class="muted">(${esc(c.basis)}${c.simulated ? ', simulated' : ''}, ${esc(c.confidence)} confidence)</span></div></li>`).join('') : m.reasons.map((r) => `<li>${statusMark('skip')}<div>${esc(r)}</div></li>`).join('');
  const fixes = m.fixes.length ? `<div class="fixes"><span class="label">Fix</span><ul>${m.fixes.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : '<div></div>';
  const box = `<div class="why-box"><div><span class="label">Why</span><ul>${reasons}</ul></div>${fixes}</div>`;
  return `<tr class="why"><td colspan="${span}">${collapsed ? `<details><summary>Why and how to fix</summary>${box}</details>` : box}</td></tr>`;
}

function matrix(r: FitReport): string {
  const cols = activeColumns(r).length ? activeColumns(r) : COLUMNS.slice(0, 1);
  const span = 4 + cols.length;
  const head = `<thead><tr><th>Model</th><th>Verdict</th>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}<th>Basis</th><th>Confidence</th></tr></thead>`;
  const bodies = GROUPS.map((g) => {
    const ms = r.models.filter((m) => (g.kind === 'vega' ? m.verdict === 'not-covered' : m.kind === g.kind && m.verdict !== 'not-covered'));
    if (!ms.length) return '';
    const counts = (['runs', 'risky', 'wont-run'] as Verdict[]).map((v) => [v, ms.filter((m) => m.verdict === v).length] as const).filter(([, n]) => n);
    const rows = ms
      .map((m) => {
        // Smart TVs are many and mostly estimated: their explanations start folded.
        const why = whyRow(m, span, g.kind === 'tv');
        const cls = ['model', m.measuredHere ? 'here' : '', why ? 'has-why' : ''].filter(Boolean).join(' ');
        const meta = `<div class="mmeta">${esc(m.model)} · ${esc(ram(m.ramMB))}${m.gpu ? ` · ${esc(m.gpu)}` : ''} ${tierChip(m.tier)}${m.measuredHere ? ' <span class="badge b-here">measured here</span>' : ''}${m.profile ? ` <span class="badge b-profile" title="profiles/${esc(m.model)}.json, ${esc(m.profile.source)} ${esc(m.profile.capturedAt)}">profile</span>` : ''}</div>`;
        const name = `<td><div class="mname">${esc(m.name)}</div>${meta}</td>`;
        if (m.verdict === 'not-covered') return `<tr class="${cls}">${name}<td>${verdictTag(m.verdict)}</td><td colspan="${cols.length + 2}" class="muted">${esc(m.reasons[0] ?? '')}</td></tr>`;
        return `<tr class="${cls}">${name}<td>${verdictTag(m.verdict)}</td>${cols.map((c) => cell(m, c.checks)).join('')}<td>${basisBadge(m.basis)}</td><td>${confDots(m.confidence)}</td></tr>${why}`;
      })
      .join('');
    const summary = g.kind === 'vega' ? `${ms.length} models` : counts.map(([v, n]) => `${n} ${VERDICT_LABEL[v]}`).join(' · ');
    return `<tbody class="group"><tr><th colspan="${span}">${esc(g.label)} <span class="muted">· ${esc(summary)}</span></th></tr></tbody><tbody>${rows}</tbody>`;
  }).join('');
  return `<div class="matrix-wrap"><table class="matrix">${head}${bodies}</table></div>`;
}

function focusCards(r: FitReport): string {
  const ms = r.models.filter((m) => r.summary.focus.models.includes(m.model));
  if (!ms.length) return '';
  return `<div class="focus">${ms
    .map((m) => {
      const checks = m.checks.filter((c) => c.status !== 'skip');
      const fixes = m.fixes.length ? `<div class="fix"><span class="label">Fix</span><ul>${m.fixes.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : '';
      const order = (c: CheckResult) => (c.status === 'fail' ? 0 : c.status === 'warn' ? 1 : 2);
      const passing = checks.filter((c) => c.status === 'pass');
      return `<article class="card"><h3>${verdictMark(m.verdict)}${esc(m.name)}</h3><p class="sub">${esc(m.model)} · ${esc(ram(m.ramMB))} · ${esc(m.gpu ?? 'GPU ?')} · ${esc(m.platform ?? '')} ${tierChip(m.tier)} ${basisBadge(m.basis)} ${confDots(m.confidence)}</p><ul class="checks">${checks
        .filter((c) => c.status !== 'pass' || c.id === 'memory' || c.id === 'frames')
        .sort((a, b) => order(a) - order(b))
        .map((c) => `<li>${statusMark(c.status)}<div><b>${esc(LABEL[c.id])}</b> <span class="mono muted">${esc(c.summary)}</span><br>${esc(c.reason)} <span class="muted">(${esc(c.basis)}${c.simulated ? ', simulated' : ''}, ${esc(c.confidence)} confidence)</span></div></li>`)
        .join('')}</ul>${passing.filter((c) => c.id !== 'memory' && c.id !== 'frames').length ? `<p class="passed">${statusMark('pass')}<span>${passing.filter((c) => c.id !== 'memory' && c.id !== 'frames').map((c) => `${esc(LABEL[c.id])} <span class="mono muted">${esc(c.summary)}</span>`).join(' · ')}</span></p>` : ''}${fixes}</article>`;
    })
    .join('')}</div>`;
}

function runsTable(r: FitReport): string {
  if (!r.runs.length) return '';
  const rows = r.runs
    .map((run) => {
      const f = run.frames;
      const m = run.memory;
      const sim = run.simulated ? `imitates ${run.simulated.forModel}: ${run.simulated.kinds.map((k) => (k === 'cpu' ? `CPU ÷${run.simulated?.cpuRate}` : `${run.simulated?.pixelFactor}x pixels (scale ${run.simulated?.scale})`)).join(' + ')}` : 'measured';
      return `<tr><td>${esc(run.label)}</td><td>${tierChip(run.tier) || '–'}</td><td>${run.canvas ? `${run.canvas.width}x${run.canvas.height}` : '–'}${run.scale !== undefined ? ` <span class="muted">×${run.scale}</span>` : ''}</td><td class="r">${f ? `${f.fpsMedian} / ${f.fpsP10}` : '–'}</td><td class="r">${f ? `${f.frameMsP50} / ${f.frameMsP95}${f.frameMsFrom === 'fps' ? '*' : ''}` : '–'}</td><td class="r">${m?.totalMB !== undefined ? `${Math.round(m.totalMB)}${m.appPssMB !== undefined ? ` <span class="muted">(${Math.round(m.appPssMB)} + ${Math.round(m.rendererPssMB ?? 0)})</span>` : ''}` : '–'}</td><td class="r">${m?.memAvailableMinMB !== undefined ? Math.round(m.memAvailableMinMB) : '–'}</td><td>${esc(sim)}${f?.capped ? ' <span class="badge">at frame cap</span>' : ''}</td></tr>`;
    })
    .join('');
  return `<div class="matrix-wrap"><table class="data"><thead><tr><th>Run</th><th>Tier</th><th>Canvas</th><th class="r">fps median / p10</th><th class="r">Frame ms p50 / p95</th><th class="r">App + WebView MB</th><th class="r">Min avail MB</th><th>Kind</th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted" style="margin-top:8px;font-size:11px">* frame times derived from per-second fps (the page doesn't publish window.firelab.frameMs).</p>`;
}

function mediaSection(r: FitReport): string {
  if (!r.media.length) return '';
  const items = r.mediaFindings
    .map((f) => {
      const info = r.media.find((x) => x.source === f.source);
      const issues = f.issues.length
        ? `<ul>${f.issues
            .map((i) => `<li>${statusMark(i.status)}<div>${esc(i.reason)}<div class="models">${i.models.length > 8 ? `${i.models.length} models` : esc(i.models.join(', '))}</div>${i.fix ? `<div class="mfix"><b>Fix:</b> ${esc(i.fix)}</div>` : ''}</div></li>`)
            .join('')}</ul>`
        : '';
      return `<article class="card media-item"><h3>${statusMark(f.status)}${esc(fileName(f.source))}</h3><p class="desc">${esc(info ? describeMedia(info) : '')}${info?.bytesRead ? ` · read ${Math.round(info.bytesRead / 1024)} KB` : ''}</p>${issues}</article>`;
    })
    .join('');
  return `<section><div class="section-head"><h2>Media</h2><span class="hint">Each file against each model's decoders and the streaming bitrates seen to work.</span></div><div class="media-list">${items}</div></section>`;
}

function method(r: FitReport): string {
  const fams = GPU_FAMILIES.filter((g) => r.models.some((m) => m.gpu && g.match.test(m.gpu)));
  const rows = fams.map((g) => `<tr><td>${esc(g.family)}</td><td class="r">${g.factor}${g.range ? ` <span class="muted">(${g.range[0]}–${g.range[1]})</span>` : ''}</td><td>${basisBadge(g.source === 'measured' ? 'measured' : 'estimated')}</td><td>${g.webgl2 === false ? 'no (ES 2)' : g.webgl2 ? 'yes' : 'depends'}</td><td>${esc(g.why)}</td></tr>`).join('');
  return `<details class="method"><summary>How fit decides</summary><div class="card">
<p><b>Verdicts.</b> Each model gets the worst result of its checks: any ❌ check makes it <b>won't run</b>, any ⚠️ makes it <b>risky</b>. <b>Basis</b>: <i>measured</i> = on this very model during this run; <i>profile</i> = from the model's device profile (profiles/&lt;MODEL&gt;.json); <i>estimated</i> = from spec tables, scaling or a simulation. Confidence says how much to trust the number.</p>
<p><b>Memory.</b> App + WebView renderer PSS against the model's budget (about ${RESERVE_COMFORT_MB} MB of MemAvailable left) and limit (about ${RESERVE_HARD_MB} MB left, where the low-memory killer steps in). Calibrated on two real runs: 415 MB was fine on a 1 GB Fire TV Stick (3rd gen) with 83 MB left.</p>
<p><b>Frame rate.</b> Frame times measured on your device, scaled by the GPU speed ratio below (GE8300 = 1.0). A run that held the app's frame cap hides its headroom, so scaling it down is pessimistic; the CPU-throttle and pixel-load simulations give a direct estimate instead.</p>
<div class="matrix-wrap" style="margin-top:12px"><table class="data"><thead><tr><th>GPU</th><th class="r">Speed</th><th>Source</th><th>WebGL2</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table></div>
</div></details>`;
}

export function renderFitReport(r: FitReport): string {
  const focus = r.models.filter((m) => r.summary.focus.models.includes(m.model));
  const fv = r.summary.focus.verdict;
  const verdictWord = fv === 'runs' ? 'Runs' : fv === 'risky' ? 'Risky' : fv === 'wont-run' ? "Won't run" : 'Not covered';
  const focusNames = focus.map((m) => m.name.replace(/ \/ .*$/, '')).join(' and ');
  const why = focus.find((m) => m.verdict === fv && m.verdict !== 'runs')?.headline ?? focus[0]?.headline ?? '';
  const d = r.measuredOn;
  const ev = r.evidence;
  const evChip = (on: boolean, label: string) => `<span class="chip ${on ? 'on' : 'off'}">${esc(label)}</span>`;
  const device = d
    ? `<div><span class="label">Measured on</span><h2>${esc(d.name ?? d.model ?? 'device')}</h2></div><dl class="kv"><dt>Model</dt><dd>${esc(d.model ?? '?')}</dd><dt>GPU</dt><dd>${esc(d.gpu ?? '?')}</dd><dt>OS</dt><dd>${esc(d.os ?? (d.sdk ? `API ${d.sdk}` : '?'))}</dd>${d.webviewMajor ? `<dt>WebView</dt><dd>${d.webviewMajor}</dd>` : ''}<dt>ABIs</dt><dd>${esc((d.abis ?? []).join(', ') || '?')}</dd>${d.ramMB ? `<dt>RAM</dt><dd>${esc(ram(d.ramMB))}</dd>` : ''}</dl>`
    : `<div><span class="label">Measured on</span><h2>No device</h2><p class="muted" style="margin-top:6px">Static checks only. Run <code>firelab fit</code> with a Fire TV connected for memory and frame-rate checks.</p></div>`;
  const tiles = (['runs', 'risky', 'wont-run', 'not-covered'] as Verdict[])
    .map((v) => `<div class="tile t-${v}"><span class="label">${esc(v === 'not-covered' ? 'Vega OS' : VERDICT_LABEL[v])}</span><span class="n">${v === 'runs' ? r.summary.runs : v === 'risky' ? r.summary.risky : v === 'wont-run' ? r.summary.wontRun : r.summary.notCovered}</span></div>`)
    .join('');
  const app = appName(r);
  const created = r.createdAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Fit report: ${esc(app)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<header class="top"><div class="brand">${LOGO}<span>Fire<b>Lab</b></span></div><span class="sep"></span><span class="doc">Fit report</span><span class="app">${esc(app)}</span><span class="meta">${esc(created)} · v${esc(r.firelabVersion)}</span></header>
<main class="wrap">
<div class="hero">
  <div class="card verdict-card v-${fv}">
    <div class="big-mark">${BIG[fv]}</div>
    <div style="min-width:0;flex:1">
      <span class="label">Will it run on the sticks most people own?</span>
      <h1 style="margin-top:8px"><em>${esc(verdictWord)}</em> on the ${focus.length ? esc(focusNames) : 'focus models'}</h1>
      ${why ? `<p class="why">${esc(why)}</p>` : ''}
      <p class="overall">${esc(r.summary.headline)} Target ${r.targetFps} fps.</p>
      <div class="tiles">${tiles}</div>
    </div>
  </div>
  <div class="card device-card">
    ${device}
    <div><span class="label">Evidence</span><div class="chips" style="margin-top:8px">${evChip(ev.static, 'APK')}${evChip(ev.web, 'WebGL needs')}${evChip(ev.measured, 'Measured')}${evChip(ev.simulated, 'Simulated')}${evChip(ev.pressure, 'Memory pressure')}${evChip(ev.media, 'Media')}</div></div>
  </div>
</div>
${focus.length ? `<section><div class="section-head"><h2>${r.summary.focus.models.join(', ') === 'AFTSSS, AFTSS' ? 'The 1 GB sticks' : 'Focus models'}</h2><span class="hint">${esc(r.summary.focus.line)}</span></div>${focusCards(r)}</section>` : ''}
<section><div class="section-head"><h2>Every Fire OS model</h2><span class="hint">Hover a cell for the full reason.</span></div>
<div class="legend"><span>${statusMark('pass')} runs</span><span>${statusMark('warn')} risky</span><span>${statusMark('fail')} won't run</span><span>${statusMark('skip')} not checked</span><span>${basisBadge('measured')} on this model</span><span>${basisBadge('profile')} device profile</span><span>${basisBadge('estimated')} tables, scaling or simulation</span></div>
${matrix(r)}</section>
${r.runs.length ? `<section><div class="section-head"><h2>Runs</h2><span class="hint">What was measured${d ? ` on ${esc(d.name ?? d.model ?? 'the device')}` : ''}.</span></div>${runsTable(r)}${r.pressure ? `<p style="margin-top:10px">${statusMark(r.pressure.outcome === 'survived' ? 'pass' : r.pressure.outcome === 'unknown' ? 'skip' : 'warn')} <b>Memory pressure (${esc(r.pressure.level)}):</b> ${esc(r.pressure.outcome)}. ${esc(r.pressure.detail)}</p>` : ''}</section>` : ''}
${mediaSection(r)}
${r.notes.length ? `<section><div class="section-head"><h2>Notes</h2></div><ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>` : ''}
${method(r)}
<p class="disclaimer"><b>The real device is the final word.</b> ${esc(r.disclaimer)}</p>
<footer>FireLab ${esc(r.firelabVersion)} · firelab fit · ${esc(created)}${r.app.url ? ` · ${esc(r.app.url)}` : ''}${r.app.package ? ` · ${esc(r.app.package)}` : ''}</footer>
</main>
</body>
</html>
`;
}
