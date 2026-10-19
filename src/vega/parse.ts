/**
 * Parsers for Vega tool output. `vda devices -l` follows adb's documented
 * shape. `loggingctl log -o short-precise` is assumed to print journald's
 * short-precise format, and the `ace_memusage` parser is deliberately
 * tolerant, because Amazon doesn't document its columns. Both are NOT YET
 * VERIFIED against a real Vega device; see docs/VEGA.md.
 */
import type { LogLine } from '../driver/types.js';

export type VdaDevice = { serial: string; state: string; model?: string; product?: string; device?: string };

/** `vda devices -l`: "List of devices attached" then "<serial> <state> key:value ...". */
export function parseVdaDevices(text: string): VdaDevice[] {
  const out: VdaDevice[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^list of devices/i.test(line) || line.startsWith('*')) continue;
    const [serial, state, ...rest] = line.split(/\s+/);
    if (!serial || !state) continue;
    const d: VdaDevice = { serial, state };
    for (const kv of rest) {
      const m = /^(model|product|device):(.+)$/.exec(kv);
      if (m) d[m[1] as 'model' | 'product' | 'device'] = (m[2] as string).replace(/_/g, ' ');
    }
    out.push(d);
  }
  return out;
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** Level from the message text (short-precise output carries no priority). */
export function guessLevel(text: string): LogLine['level'] {
  if (/\b(fatal|panic|crash(ed)?|segfault|abort(ed)?)\b/i.test(text)) return 'fatal';
  if (/\b\w*(error|exception)\b|\b(failed|failure)\b|\bE\//i.test(text)) return 'error';
  if (/\b(warn(ing)?)\b|\bW\//i.test(text)) return 'warn';
  if (/\bdebug\b|\bD\//i.test(text)) return 'debug';
  return 'info';
}

/**
 * One line of `loggingctl log -o short-precise` (journald short-precise):
 *   "Oct 16 15:42:11.123456 vega-host com.example.app[1234]: message"
 * Returns null for lines that don't look like that.
 */
export function parseVegaLogLine(line: string, year = new Date().getFullYear()): LogLine | null {
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?\s+(\S+)\s+([^:\[\s]+)(?:\[(\d+)\])?:\s?(.*)$/.exec(line.trimEnd());
  if (!m) return null;
  const month = MONTHS[m[1] as string];
  if (month === undefined) return null;
  const ms = m[6] ? Math.floor(Number((m[6] as string).padEnd(6, '0')) / 1000) : 0;
  const ts = new Date(year, month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), ms).getTime();
  const text = m[10] as string;
  const out: LogLine = { ts, level: guessLevel(text), tag: m[8] as string, text };
  if (m[9]) out.pid = Number(m[9]);
  return out;
}

export function parseVegaLogs(text: string, year?: number): LogLine[] {
  const out: LogLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = parseVegaLogLine(line, year);
    if (l) out.push(l);
    else if (line.startsWith(' ') && out.length) (out[out.length - 1] as LogLine).text += `\n${line.trim()}`; // continuation line
  }
  return out;
}

/** The short name an app runs under: "com.example.game" -> also matches "game" and "com.example.game.main". */
function appMatches(cell: string, app: string): boolean {
  const c = cell.toLowerCase();
  const a = app.toLowerCase();
  return c === a || c.startsWith(`${a}.`) || c.startsWith(`${a}:`) || c.endsWith(`/${a}`) || c.includes(a);
}

function toMB(value: string, unitHint: 'kb' | 'mb' | 'b'): number | null {
  const m = /^([\d.]+)\s*([kKmMgG]i?[bB]?)?$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const u = (m[2] ?? '').toLowerCase();
  if (u.startsWith('g')) return n * 1024;
  if (u.startsWith('m')) return n;
  if (u.startsWith('k')) return n / 1024;
  return unitHint === 'mb' ? n : unitHint === 'b' ? n / (1024 * 1024) : n / 1024;
}

/**
 * The memory of one app from `ace_memusage`. The output format is not
 * documented, so this looks for a header row with a PSS (else RSS, USS or
 * "mem"/"total") column and the row whose name matches the app. Values with a
 * unit suffix are read as such; bare numbers follow the header's unit, or kB.
 */
export function parseAceMemusage(text: string, app: string): { pssMB: number; column: string } | null {
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const headerIdx = rows.findIndex((r) => /\b(pss|rss|uss|mem|total)\b/i.test(r) && !/\d{3,}/.test(r));
  if (headerIdx < 0) return null;
  const header = rows[headerIdx] as string;
  const cols = header.split(/\s{2,}|\t|\s(?=[A-Za-z])/).map((c) => c.trim()).filter(Boolean);
  const unitHint: 'kb' | 'mb' | 'b' = /\bmb\b|\(m/i.test(header) ? 'mb' : /\bbytes?\b|\(b\)/i.test(header) ? 'b' : 'kb';
  const pick = ['pss', 'rss', 'uss', 'total', 'mem'];
  let col = -1;
  let colName = '';
  for (const want of pick) {
    col = cols.findIndex((c) => c.toLowerCase().replace(/\(.*\)/, '').trim().startsWith(want) || c.toLowerCase().includes(want));
    if (col >= 0) {
      colName = cols[col] as string;
      break;
    }
  }
  if (col < 0) return null;
  for (const row of rows.slice(headerIdx + 1)) {
    const cells = row.split(/\s+/);
    if (!cells.some((c) => appMatches(c, app))) continue;
    // Numeric cells line up with the header's numeric columns from the right when names contain spaces.
    const v = cells[col] !== undefined && toMB(cells[col] as string, unitHint) !== null ? cells[col] : cells.slice().reverse().find((c, i) => i === cols.length - 1 - col && toMB(c, unitHint) !== null);
    const mb = v !== undefined ? toMB(v, unitHint) : null;
    if (mb !== null) return { pssMB: Math.round(mb * 10) / 10, column: colName };
  }
  return null;
}

/** A pid from `pidof <name>` output, else from a `ps` table row naming the app. */
export function parsePid(text: string, app: string): number | undefined {
  const first = text.trim().split(/\s+/)[0];
  if (first && /^\d+$/.test(first) && !/PID/i.test(text.split('\n')[0] ?? '')) return Number(first);
  for (const line of text.split(/\r?\n/)) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 2 || !cells.some((c) => appMatches(c, app))) continue;
    const pid = cells.find((c) => /^\d+$/.test(c));
    if (pid) return Number(pid);
  }
  return undefined;
}
