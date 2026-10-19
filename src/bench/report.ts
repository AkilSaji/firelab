/**
 * The benchmark report: statistics over the runs (bench.json), an HTML page
 * (report.html) and a Markdown summary (report.md). Self-contained: no CDN,
 * charts are inline SVG.
 */
import fs from 'node:fs';
import path from 'node:path';
import { a12, a12Magnitude, fisherExact, iqr, mannWhitney } from '../engine/stats.js';
import { STRATEGIES, type BenchResult, type BenchRun, type BenchStrategy } from './run.js';

export type MetricId = 'jsBlocks' | 'states' | 'maxDepth' | 'progress' | 'triggered' | 'detected';
export const METRICS: Record<MetricId, { label: string; what: string; independent: boolean }> = {
  triggered: { label: 'Seeded bugs triggered', what: 'the game says the bug fired (ground truth, same for every strategy)', independent: true },
  detected: { label: 'Seeded bugs reported', what: 'triggered, and the tester reported it with a finding of the right kind', independent: true },
  jsBlocks: { label: 'JS blocks covered', what: "V8 block coverage of the game's own scripts", independent: true },
  progress: { label: 'Game progress', what: 'the furthest point the game reached (e.g. dungeon floor)', independent: true },
  maxDepth: { label: 'Deepest screen (keys)', what: 'shortest key sequence from launch to the deepest screen reached (FireLab state abstraction)', independent: false },
  states: { label: 'Distinct screens', what: "states in FireLab's abstraction (engine-defined: shown for context)", independent: false },
};

const value = (r: BenchRun, m: MetricId): number | undefined =>
  m === 'triggered' ? Object.keys(r.triggered).length : m === 'detected' ? Object.keys(r.detected).length : m === 'progress' ? r.progress : r[m];

export type Comparison = { metric: MetricId; a: BenchStrategy; b: BenchStrategy; medA: number; medB: number; a12: number; magnitude: string; p: number };

export type SubjectStats = {
  subject: string;
  metrics: { metric: MetricId; byStrategy: Partial<Record<BenchStrategy, { median: number; q1: number; q3: number; n: number }>> }[];
  /** FireLab vs each other strategy, per metric. */
  comparisons: Comparison[];
  /** Per seeded bug and strategy: runs that triggered / reported it, and median seconds to trigger. */
  bugs: { id: string; what: string; depth: number; byStrategy: Partial<Record<BenchStrategy, { triggered: number; detected: number; runs: number; medianS?: number }>>; fisher: Partial<Record<BenchStrategy, number>> }[];
};

export function benchStats(b: BenchResult): SubjectStats[] {
  return b.subjects.map((subject) => {
    const runs = b.runs.filter((r) => r.subject === subject && !r.error);
    const of = (s: BenchStrategy) => runs.filter((r) => r.strategy === s);
    const metrics = (Object.keys(METRICS) as MetricId[])
      .filter((m) => runs.some((r) => value(r, m) !== undefined))
      .map((metric) => ({
        metric,
        byStrategy: Object.fromEntries(
          b.strategies.map((s) => {
            const xs = of(s).map((r) => value(r, metric)).filter((x): x is number => x !== undefined);
            return [s, xs.length ? { ...iqr(xs), n: xs.length } : { median: NaN, q1: NaN, q3: NaN, n: 0 }];
          }),
        ),
      }));
    const ref: BenchStrategy = b.strategies.includes('firelab') ? 'firelab' : (b.strategies[0] as BenchStrategy);
    const comparisons: Comparison[] = [];
    for (const { metric } of metrics)
      for (const other of b.strategies) {
        if (other === ref) continue;
        const A = of(ref).map((r) => value(r, metric)).filter((x): x is number => x !== undefined);
        const B = of(other).map((r) => value(r, metric)).filter((x): x is number => x !== undefined);
        if (!A.length || !B.length) continue;
        const e = a12(A, B);
        comparisons.push({ metric, a: ref, b: other, medA: iqr(A).median, medB: iqr(B).median, a12: e, magnitude: a12Magnitude(e), p: mannWhitney(A, B).p });
      }
    const info = b.subjectInfo[subject];
    const bugs = (info?.bugs ?? []).map((bug) => {
      const byStrategy = Object.fromEntries(
        b.strategies.map((s) => {
          const rs = of(s);
          const ts = rs.map((r) => r.triggered[bug.id]).filter((x): x is number => x !== undefined);
          return [s, { triggered: ts.length, detected: rs.filter((r) => r.detected[bug.id] !== undefined).length, runs: rs.length, ...(ts.length ? { medianS: iqr(ts).median } : {}) }];
        }),
      ) as SubjectStats['bugs'][number]['byStrategy'];
      const fisher: Partial<Record<BenchStrategy, number>> = {};
      const R = byStrategy[ref];
      for (const s of b.strategies)
        if (s !== ref && R && byStrategy[s]) {
          const S = byStrategy[s] as { triggered: number; runs: number };
          fisher[s] = fisherExact(R.triggered, R.runs - R.triggered, S.triggered, S.runs - S.triggered);
        }
      return { ...bug, byStrategy, fisher };
    });
    return { subject, metrics, comparisons, bugs };
  });
}

/** One sentence for listings: total bugs triggered per strategy over all runs. */
export function benchHeadline(b: BenchResult): string {
  const per = b.strategies.map((s) => {
    const rs = b.runs.filter((r) => r.strategy === s && !r.error);
    const bugs = new Set(rs.flatMap((r) => Object.keys(r.triggered).map((k) => `${r.subject}:${k}`)));
    return `${STRATEGIES[s].label} ${bugs.size}`;
  });
  const total = Object.values(b.subjectInfo).reduce((n, s) => n + s.bugs.length, 0);
  return `Distinct seeded bugs triggered (of ${total}) in ${b.runsPer} × ${b.minutes} min runs: ${per.join(', ')}`;
}

// ---------- rendering ----------

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const COLORS: Record<BenchStrategy, string> = { firelab: '#ff7a1a', 'firelab-k': '#f0507a', 'firelab-mvp': '#e3b341', random: '#6e8efb', monkey: '#43b581' };
const fmt = (x: number) => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? Math.round(x).toString() : (Math.round(x * 10) / 10).toString()) : '–');
const fmtP = (p: number) => (!Number.isFinite(p) ? '–' : p < 0.001 ? '<0.001' : p.toFixed(3));

/** Median curve over runs: value at each second (step function), for one strategy and one series. */
function medianCurve(runs: BenchRun[], idx: 1 | 2, horizonS: number, points = 60): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= points; i++) {
    const t = (horizonS * i) / points;
    const vals = runs.map((r) => {
      let v = 0;
      for (const p of r.curve) if (p[0] <= t) v = p[idx];
      return v;
    });
    out.push([t, vals.length ? iqr(vals).median : 0]);
  }
  return out;
}

function chart(b: BenchResult, subject: string, idx: 1 | 2, title: string): string {
  const W = 560;
  const H = 220;
  const P = { l: 46, r: 12, t: 22, b: 30 };
  const horizon = b.minutes * 60;
  const series = b.strategies.map((s) => ({ s, pts: medianCurve(b.runs.filter((r) => r.subject === subject && r.strategy === s && !r.error), idx, horizon) }));
  const maxY = Math.max(1, ...series.flatMap((x) => x.pts.map((p) => p[1])));
  const X = (t: number) => P.l + ((W - P.l - P.r) * t) / horizon;
  const Y = (v: number) => H - P.b - ((H - P.t - P.b) * v) / maxY;
  const grid = [0, 0.5, 1].map((f) => `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(maxY * f)}" y2="${Y(maxY * f)}" class="g"/><text x="${P.l - 6}" y="${Y(maxY * f) + 4}" text-anchor="end">${fmt(maxY * f)}</text>`).join('');
  const xt = [0, 0.5, 1].map((f) => `<text x="${X(horizon * f)}" y="${H - 10}" text-anchor="middle">${fmt((b.minutes * f))} min</text>`).join('');
  const lines = series.map(({ s, pts }) => `<polyline fill="none" stroke="${COLORS[s]}" stroke-width="2.4" points="${pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ')}"/>`).join('');
  return `<figure class="chart"><figcaption>${esc(title)} (median of runs)</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${grid}${xt}${lines}</svg></figure>`;
}

export function renderBenchHtml(b: BenchResult): string {
  const stats = benchStats(b);
  const legend = b.strategies.map((s) => `<span><i style="background:${COLORS[s]}"></i>${esc(STRATEGIES[s].label)}</span>`).join('');
  const sections = stats
    .map((st) => {
      const info = b.subjectInfo[st.subject];
      const metricRows = st.metrics
        .map((m) => `<tr><th>${esc(METRICS[m.metric].label)}${METRICS[m.metric].independent ? '' : ' <small>(engine-defined)</small>'}</th>${b.strategies.map((s) => { const v = m.byStrategy[s]; return `<td>${v && v.n ? `<b>${fmt(v.median)}</b> <small>${fmt(v.q1)}–${fmt(v.q3)}</small>` : '–'}</td>`; }).join('')}</tr>`)
        .join('');
      const cmpRows = st.comparisons
        .filter((c) => METRICS[c.metric].independent || c.metric === 'maxDepth')
        .map((c) => `<tr><td>${esc(METRICS[c.metric].label)}</td><td>${esc(STRATEGIES[c.a].label)} vs ${esc(STRATEGIES[c.b].label)}</td><td>${fmt(c.medA)} vs ${fmt(c.medB)}</td><td class="${c.a12 >= 0.71 ? 'win' : c.a12 <= 0.29 ? 'loss' : ''}">${c.a12.toFixed(2)} <small>${c.magnitude}</small></td><td>${fmtP(c.p)}</td></tr>`)
        .join('');
      const bugRows = st.bugs
        .map((bug) => `<tr><th>${esc(bug.id)} <small>~${bug.depth} keys</small><div class="what">${esc(bug.what)}</div></th>${b.strategies.map((s) => { const v = bug.byStrategy[s]; return `<td>${v ? `<b>${v.triggered}/${v.runs}</b> triggered<br><small>${v.detected}/${v.runs} reported${v.medianS !== undefined ? ` · median ${fmt(v.medianS)} s` : ''}${s !== 'firelab' && bug.fisher[s] !== undefined ? ` · Fisher p ${fmtP(bug.fisher[s] as number)}` : ''}</small>` : '–'}</td>`; }).join('')}</tr>`)
        .join('');
      return `<section><h2>${esc(info?.name ?? st.subject)}</h2>${info?.notes ? `<p class="note">${esc(info.notes)}</p>` : ''}
<div class="charts">${chart(b, st.subject, 1, 'JS blocks covered over time')}${chart(b, st.subject, 2, 'Distinct screens over time')}</div>
<h3>Metrics (median, IQR)</h3><table><thead><tr><th></th>${b.strategies.map((s) => `<th>${esc(STRATEGIES[s].label)}</th>`).join('')}</tr></thead><tbody>${metricRows}</tbody></table>
${bugRows ? `<h3>Seeded bugs</h3><table class="bugs"><thead><tr><th>Bug</th>${b.strategies.map((s) => `<th>${esc(STRATEGIES[s].label)}</th>`).join('')}</tr></thead><tbody>${bugRows}</tbody></table>` : ''}
${cmpRows ? `<h3>FireLab against each baseline</h3><p class="note">Â12 = probability that a FireLab run beats a baseline run (0.5 = no difference; ≥ 0.71 large, Vargha and Delaney). p = two-sided Mann-Whitney U.</p><table><thead><tr><th>Metric</th><th>Pair</th><th>Medians</th><th>Â12</th><th>p</th></tr></thead><tbody>${cmpRows}</tbody></table>` : ''}
</section>`;
    })
    .join('');
  const strategies = b.strategies.map((s) => `<li><b style="color:${COLORS[s]}">${esc(STRATEGIES[s].label)}</b>: ${esc(STRATEGIES[s].what)}</li>`).join('');
  const failed = b.runs.filter((r) => r.error);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(b.title)}</title>
<style>
:root{--bg:#14111f;--panel:#1d1a2d;--line:#2f2a47;--fg:#eef1fa;--dim:#9aa1bb;--acc:#ff7a1a}
@media (prefers-color-scheme: light){:root{--bg:#f7f6fb;--panel:#fff;--line:#e2dfee;--fg:#1b1830;--dim:#5d6178}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 16px 60px}
h1{font-size:26px;margin:0 0 4px}h2{margin:36px 0 8px;font-size:20px}h3{margin:20px 0 8px;font-size:15px;color:var(--dim);text-transform:uppercase;letter-spacing:.04em}
.head{color:var(--dim)}.headline{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--acc);border-radius:10px;padding:12px 16px;margin:16px 0;font-size:16px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:14px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600}
small{color:var(--dim)}.what{font-weight:400;color:var(--dim);font-size:12.5px}.note{color:var(--dim);font-size:13.5px}
.win{color:#43b581;font-weight:700}.loss{color:#f05d5e;font-weight:700}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.chart{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 10px}
figcaption{font-size:13px;color:var(--dim)}svg{width:100%;height:auto}svg text{fill:var(--dim);font-size:11px}svg .g{stroke:var(--line)}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin:8px 0}.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px}
ul{padding-left:20px}code{font-size:13px}
</style></head><body><main>
<h1>${esc(b.title)}</h1>
<div class="head">${esc(new Date(b.createdAt).toLocaleString())} · ${b.runsPer} runs × ${b.minutes} min per strategy and game · FireLab ${esc(b.firelabVersion)} · ${esc(b.machine.chrome ?? 'Chrome')} · ${esc(b.machine.platform)}</div>
${b.headline ? `<div class="headline">${esc(b.headline)}</div>` : ''}
<div class="legend">${legend}</div>
${sections}
<section><h2>Method</h2>
<ul>${strategies}</ul>
<p>Every strategy runs the same games with the same wall-clock budget, the same remote keys and the same passive checks (crash, JS exception, black or frozen screen, stopped render loop); only FireLab walks the D-pad focus. One seed per run; runs are interleaved across strategies so machine load is shared. Games run in headless Chrome at the Fire TV WebView's 960×540 viewport, with keys delivered as FireLab's TV wrapper delivers them.</p>
<p><b>Ground truth.</b> Each seeded bug records in the page when it fires, whoever drives the game. <i>Triggered</i> counts those; <i>reported</i> also needs a finding of the matching kind from the tester. JS coverage is V8 precise block coverage of the game's own scripts, which no strategy can inflate. FireLab's own state count and depth are shown for context only.</p>
<p><b>Statistics.</b> Medians with inter-quartile ranges; two-sided Mann-Whitney U with Vargha-Delaney Â12 effect sizes for continuous metrics; Fisher's exact test per seeded bug, following Arcuri and Briand (ICSE 2011) and Klees et al. (CCS 2018). With ${b.runsPer} runs per cell, treat p-values as indicative; Klees et al. recommend 30 runs, and recent fuzzing practice accepts 10 or more.</p>
<p><b>For reference</b> (published results on Android apps, a different setting, not comparable one to one): on Themis's 52 real crash bugs (Su et al., FSE 2021; 6 h × 5 runs) Ape found 24, Monkey 22, ComboDroid 21, Stoat 19, Humanoid 18, TimeMachine 15 and Q-testing 10, and 18 bugs were found by no tool, 12 of them because they need more than 5 page transitions. On AndroTest (Choudhary et al., ASE 2015; 68 apps, 1 h × 10 runs) Monkey had the best coverage and every tool plateaued within 5-10 minutes. No TV or D-pad benchmark has been published; Deep Quest is FireLab's own depth benchmark, and Firefly Lake's bugs mirror bugs found in a shipped TV game.</p>
${failed.length ? `<p class="note">Runs with errors (left out of the statistics): ${failed.map((r) => `${esc(r.subject)}/${esc(r.strategy)}#${r.rep + 1}: ${esc(r.error)}`).join('; ')}</p>` : ''}
<p class="note">Raw data: <code>bench.json</code>; each run's FireLab report is under <code>runs/</code>.</p>
</section></main></body></html>`;
}

export function renderBenchMd(b: BenchResult): string {
  const stats = benchStats(b);
  const L: string[] = [`# ${b.title}`, '', `${b.runsPer} runs × ${b.minutes} min per strategy and game · ${b.machine.chrome ?? 'Chrome'} · ${b.createdAt.slice(0, 10)}`, ''];
  if (b.headline) L.push(`**${b.headline}**`, '');
  for (const st of stats) {
    L.push(`## ${b.subjectInfo[st.subject]?.name ?? st.subject}`, '');
    L.push(`| Metric | ${b.strategies.map((s) => STRATEGIES[s].label).join(' | ')} |`, `|---|${b.strategies.map(() => '---').join('|')}|`);
    for (const m of st.metrics) L.push(`| ${METRICS[m.metric].label}${METRICS[m.metric].independent ? '' : ' (engine-defined)'} | ${b.strategies.map((s) => { const v = m.byStrategy[s]; return v && v.n ? `${fmt(v.median)} (${fmt(v.q1)}–${fmt(v.q3)})` : '–'; }).join(' | ')} |`);
    if (st.bugs.length) {
      L.push('', `| Seeded bug | ${b.strategies.map((s) => STRATEGIES[s].label).join(' | ')} |`, `|---|${b.strategies.map(() => '---').join('|')}|`);
      for (const bug of st.bugs) L.push(`| ${bug.id} (~${bug.depth} keys) | ${b.strategies.map((s) => { const v = bug.byStrategy[s]; return v ? `${v.triggered}/${v.runs} triggered, ${v.detected}/${v.runs} reported` : '–'; }).join(' | ')} |`);
    }
    const cmp = st.comparisons.filter((c) => METRICS[c.metric].independent);
    if (cmp.length) {
      L.push('', '| Metric | Pair | Medians | Â12 | p |', '|---|---|---|---|---|');
      for (const c of cmp) L.push(`| ${METRICS[c.metric].label} | ${STRATEGIES[c.a].label} vs ${STRATEGIES[c.b].label} | ${fmt(c.medA)} vs ${fmt(c.medB)} | ${c.a12.toFixed(2)} (${c.magnitude}) | ${fmtP(c.p)} |`);
    }
    L.push('');
  }
  return L.join('\n');
}

export function writeBenchReport(b: BenchResult, dir: string): { html: string; md: string } {
  const html = path.join(dir, 'report.html');
  const md = path.join(dir, 'report.md');
  fs.writeFileSync(html, renderBenchHtml(b));
  fs.writeFileSync(md, `${renderBenchMd(b)}\n`);
  return { html, md };
}
