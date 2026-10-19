/**
 * Markdown output: the CLI's text report and the GitHub step summary.
 */
import { describeMedia } from '../media/check.js';
import { STATUS_MARK, VERDICT_LABEL, VERDICT_MARK, type CheckResult, type CheckStatus, type FitReport, type ModelFit } from './types.js';

/** Matrix columns: each groups one or more checks. */
export const COLUMNS: { id: string; label: string; checks: CheckResult['id'][] }[] = [
  { id: 'install', label: 'Install', checks: ['abi', 'sdk'] },
  { id: 'tv', label: 'TV hardware', checks: ['features', 'leanback', 'gles'] },
  { id: 'webgl', label: 'WebGL', checks: ['webgl'] },
  { id: 'memory', label: 'Memory', checks: ['memory', 'pressure'] },
  { id: 'frames', label: 'Frame rate', checks: ['frames'] },
  { id: 'media', label: 'Media', checks: ['media'] },
];

const RANK: Record<CheckStatus, number> = { skip: -1, pass: 0, warn: 1, fail: 2 };

/** The worst check of a column for one model (undefined when none ran). */
export function columnCell(m: ModelFit, checks: CheckResult['id'][]): CheckResult | undefined {
  const cs = m.checks.filter((c) => checks.includes(c.id) && c.status !== 'skip');
  if (!cs.length) return undefined;
  return cs.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
}

/** Columns with at least one check that ran, for any model. */
export function activeColumns(r: FitReport): typeof COLUMNS {
  return COLUMNS.filter((col) => r.models.some((m) => columnCell(m, col.checks)));
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const ram = (m: ModelFit) => (m.ramMB ? (m.ramMB >= 1024 ? `${Math.round((m.ramMB / 1024) * 10) / 10} GB` : `${m.ramMB} MB`) : '');

function row(m: ModelFit, cols: typeof COLUMNS): string {
  const cells = cols.map((col) => {
    const c = columnCell(m, col.checks);
    return c ? `${STATUS_MARK[c.status]} ${esc(c.summary)}${c.simulated ? ' (sim)' : ''}` : '–';
  });
  const name = `**${esc(m.name)}** \`${m.model}\`${ram(m) ? ` ${ram(m)}` : ''}${m.measuredHere ? ' (measured)' : ''}`;
  return `| ${name} | ${VERDICT_MARK[m.verdict]} ${VERDICT_LABEL[m.verdict]} | ${cells.join(' | ')} | ${m.basis} | ${m.confidence} |`;
}

function table(models: ModelFit[], cols: typeof COLUMNS): string {
  return [`| Model | Verdict | ${cols.map((c) => c.label).join(' | ')} | Basis | Confidence |`, `|---|---|${cols.map(() => '---').join('|')}|---|---|`, ...models.map((m) => row(m, cols))].join('\n');
}

function details(m: ModelFit): string {
  const lines = [`**${m.name}** (\`${m.model}\`): ${VERDICT_MARK[m.verdict]} ${VERDICT_LABEL[m.verdict]}, basis ${m.basis}, confidence ${m.confidence}`];
  for (const r of m.reasons) lines.push(`- ${r}`);
  for (const f of m.fixes) lines.push(`- **Fix:** ${f.replace(/\n/g, ' / ')}`);
  return lines.join('\n');
}

export function appName(r: FitReport): string {
  return r.app.name ?? r.app.apk?.label ?? r.app.package ?? r.app.apk?.package ?? r.app.url ?? 'app';
}

export function fitMarkdown(r: FitReport, opts: { focus?: string[]; full?: boolean } = {}): string {
  const cols = activeColumns(r);
  const focusIds = (opts.focus ?? r.summary.focus.models).map((x) => x.toUpperCase());
  const focus = r.models.filter((m) => focusIds.includes(m.model.toUpperCase()));
  const problems = r.models.filter((m) => !focusIds.includes(m.model.toUpperCase()) && (m.verdict === 'wont-run' || m.verdict === 'risky'));
  const ev = Object.entries(r.evidence).filter(([, v]) => v).map(([k]) => k);
  const out: string[] = [`## FireLab fit: ${esc(appName(r))}`, '', `**${r.summary.headline}**`, '', r.summary.focus.line, ''];
  if (r.measuredOn) out.push(`Measured on: ${r.measuredOn.name ?? r.measuredOn.model} (\`${r.measuredOn.model ?? '?'}\`${r.measuredOn.gpu ? `, ${r.measuredOn.gpu}` : ''}). Target ${r.targetFps} fps.`, '');
  out.push(`Evidence: ${ev.join(', ') || 'none'}.`, '');
  if (focus.length) out.push('### Focus models', '', table(focus, cols), '');
  if (problems.length) out.push(`### Other models with problems (${problems.length})`, '', table(problems, cols), '');
  const explain = [...focus.filter((m) => m.verdict !== 'runs'), ...problems];
  if (explain.length) out.push('<details><summary>Reasons and fixes</summary>', '', ...explain.map(details).flatMap((d) => [d, '']), '</details>', '');
  if (opts.full !== false) out.push(`<details><summary>All ${r.models.length} models</summary>`, '', table(r.models, cols), '', '</details>', '');
  if (r.media.length) {
    out.push('### Media', '');
    for (const f of r.mediaFindings) {
      const info = r.media.find((x) => x.source === f.source);
      out.push(`- ${STATUS_MARK[f.status]} \`${esc(f.source.split(/[\\/]/).pop() ?? f.source)}\`: ${info ? esc(describeMedia(info)) : ''}`);
      for (const i of f.issues) out.push(`  - ${STATUS_MARK[i.status]} ${esc(i.reason)} (${i.models.length > 6 ? `${i.models.length} models` : i.models.join(', ')})${i.fix ? ` **Fix:** ${esc(i.fix)}` : ''}`);
    }
    out.push('');
  }
  out.push(`> ${r.disclaimer}`);
  return out.join('\n');
}

/** Plain-text summary for the terminal. */
export function fitText(r: FitReport, opts: { all?: boolean } = {}): string {
  const lines = [r.summary.headline, r.summary.focus.line, ''];
  const pick = opts.all ? r.models : r.models.filter((m) => m.verdict !== 'runs' || m.measuredHere || r.summary.focus.models.includes(m.model));
  const w = Math.min(46, Math.max(...pick.map((m) => m.name.length + m.model.length + 3), 10));
  for (const m of pick) {
    const name = `${m.name} (${m.model})`;
    lines.push(`${VERDICT_MARK[m.verdict]}  ${name.length > w ? `${name.slice(0, w - 1)}…` : name.padEnd(w)}  ${VERDICT_LABEL[m.verdict].padEnd(11)} ${m.headline}  [${m.basis}, ${m.confidence}]`);
  }
  const hidden = r.models.length - pick.length;
  if (hidden > 0) lines.push(`   … and ${hidden} more models that run (--all to list them)`);
  lines.push('', r.disclaimer);
  return lines.join('\n');
}
