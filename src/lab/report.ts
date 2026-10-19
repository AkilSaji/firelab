/** HTML report and Markdown job summary for `firelab lab smoke`. */
import fs from 'node:fs';
import path from 'node:path';
import type { SmokeResult, CheckStatus } from './smoke.js';

const MARK: Record<CheckStatus, string> = { pass: '✅', warn: '⚠️', fail: '❌', skip: '➖' };

export const HONESTY =
  'This emulator matches the Fire TV model\'s memory, screen and Android API level, not its Mali/PowerVR GPU, ARM CPU, Amazon WebView or Fire OS services. Frame rates and launch times here are not the real device\'s: run `firelab fit` with the real profiles for performance.';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

export type ReportContext = { lab?: { name: string; model: string; modelName?: string; image: string; ramMB: number; width: number; height: number; density: number }; explore?: { status: string; detail: string; report?: string } };

export function smokeMarkdown(r: SmokeResult, ctx: ReportContext = {}): string {
  const lines: string[] = [];
  lines.push(`## FireLab lab: ${r.verdict === 'pass' ? '✅ passed' : '❌ failed'}${r.package ? ` · \`${r.package}\`` : ''}`);
  lines.push('');
  if (ctx.lab) {
    lines.push(`Emulator shaped like the **${ctx.lab.model}**${ctx.lab.modelName ? ` (${ctx.lab.modelName})` : ''}: ${ctx.lab.ramMB} MB RAM, ${ctx.lab.width}x${ctx.lab.height} @ ${ctx.lab.density} dpi, \`${ctx.lab.image}\`.`);
    lines.push('');
  }
  lines.push('| | Check | Result |');
  lines.push('|---|---|---|');
  for (const c of r.checks) lines.push(`| ${MARK[c.status]} | ${mdCell(c.title)} | ${mdCell(c.detail)} |`);
  if (ctx.explore) lines.push(`| ${ctx.explore.status === 'pass' ? MARK.pass : ctx.explore.status === 'fail' ? MARK.fail : MARK.skip} | Explore (plays the app with the remote) | ${mdCell(ctx.explore.detail)} |`);
  lines.push('');
  for (const n of r.notes) lines.push(`- ${n}`);
  if (r.notes.length) lines.push('');
  lines.push(`> ${HONESTY}`);
  return `${lines.join('\n')}\n`;
}

export function smokeHtml(r: SmokeResult, ctx: ReportContext = {}): string {
  let shot = '';
  if (r.screenshot && fs.existsSync(r.screenshot)) shot = `<img alt="Screenshot" src="data:image/jpeg;base64,${fs.readFileSync(r.screenshot).toString('base64')}">`;
  const rows = r.checks.map((c) => `<tr class="${c.status}"><td>${MARK[c.status]}</td><td>${esc(c.title)}</td><td><pre>${esc(c.detail)}</pre></td></tr>`).join('');
  const explore = ctx.explore
    ? `<tr class="${ctx.explore.status}"><td>${ctx.explore.status === 'pass' ? MARK.pass : ctx.explore.status === 'fail' ? MARK.fail : MARK.skip}</td><td>Explore</td><td><pre>${esc(ctx.explore.detail)}</pre>${ctx.explore.report ? `<a href="${esc(ctx.explore.report)}">explore report</a>` : ''}</td></tr>`
    : '';
  const lab = ctx.lab
    ? `<p>Emulator shaped like the <b>${esc(ctx.lab.model)}</b>${ctx.lab.modelName ? ` (${esc(ctx.lab.modelName)})` : ''}: ${ctx.lab.ramMB} MB RAM, ${ctx.lab.width}x${ctx.lab.height} @ ${ctx.lab.density} dpi, <code>${esc(ctx.lab.image)}</code>.</p>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>FireLab lab report</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#666;--line:#e3e3e3;--pass:#e8f6ec;--warn:#fff6e0;--fail:#fdecec}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#999;--line:#333;--pass:#13281a;--warn:#2d2610;--fail:#331616}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}.muted{color:var(--muted)}table{border-collapse:collapse;width:100%;margin:16px 0}
td{border-bottom:1px solid var(--line);padding:8px;vertical-align:top}td:first-child{width:28px}tr.pass{background:var(--pass)}tr.warn{background:var(--warn)}tr.fail{background:var(--fail)}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:13px/1.4 ui-monospace,monospace}img{max-width:100%;border:1px solid var(--line);border-radius:6px}
blockquote{border-left:3px solid #f39c12;margin:16px 0;padding:4px 12px;color:var(--muted)}
</style></head><body>
<h1>FireLab lab: ${r.verdict === 'pass' ? '✅ passed' : '❌ failed'}</h1>
<div class="muted">${esc(r.package ?? '')} on ${esc(r.device)} · ${new Date().toISOString()}</div>
${lab}
<table>${rows}${explore}</table>
${r.notes.length ? `<ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
${shot}
<blockquote>${esc(HONESTY)}</blockquote>
${r.logcat ? `<p><a href="${esc(path.basename(r.logcat))}">logcat.txt</a></p>` : ''}
</body></html>
`;
}
