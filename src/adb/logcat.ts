import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Adb } from './client.js';

export type LogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogLine = { ts: number; pid: number; tid: number; level: LogLevel; tag: string; text: string };

const LEVELS: Record<string, LogLevel> = { V: 'verbose', D: 'debug', I: 'info', W: 'warn', E: 'error', F: 'fatal', A: 'fatal' };

/**
 * Parses `logcat -v epoch` ("1760530000.123  1234  1250 E Tag: msg") and
 * `-v threadtime` ("10-15 19:33:01.123  1234  1250 E Tag: msg") lines.
 */
export function parseLogcatLine(line: string, year = new Date().getFullYear()): LogLine | null {
  let m = /^\s*(\d{9,}\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*:\s?(.*)$/.exec(line);
  if (m) {
    return { ts: Math.round(Number(m[1]) * 1000), pid: Number(m[2]), tid: Number(m[3]), level: LEVELS[m[4] as string] as LogLevel, tag: (m[5] as string).trim(), text: m[6] as string };
  }
  m = /^(\d\d)-(\d\d)\s+(\d\d):(\d\d):(\d\d)\.(\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*:\s?(.*)$/.exec(line);
  if (m) {
    const d = new Date(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    return { ts: d.getTime(), pid: Number(m[7]), tid: Number(m[8]), level: LEVELS[m[9] as string] as LogLevel, tag: (m[10] as string).trim(), text: m[11] as string };
  }
  return null;
}

export const LEVEL_ORDER: LogLevel[] = ['verbose', 'debug', 'info', 'warn', 'error', 'fatal'];
export const atLeast = (l: LogLevel, min: LogLevel): boolean => LEVEL_ORDER.indexOf(l) >= LEVEL_ORDER.indexOf(min);

/** The last `lines` log lines, optionally for one process and at or above a level. */
export async function dumpLogcat(adb: Adb, serial: string, opts: { pid?: number; lines?: number; minLevel?: LogLevel; tag?: string } = {}): Promise<LogLine[]> {
  const n = Math.min(Math.max(opts.lines ?? 200, 1), 5000);
  // Ask for more than needed when filtering here, so the result is still ~n lines.
  const args = ['logcat', '-d', '-v', 'epoch', '-t', String(opts.pid ? n : n * 2)];
  if (opts.pid) args.push(`--pid=${opts.pid}`);
  const out = await adb.shell(serial, args.join(' '), { timeoutMs: 15000 });
  let parsed = out.split(/\r?\n/).map((l) => parseLogcatLine(l)).filter((l): l is LogLine => !!l);
  if (opts.pid) parsed = parsed.filter((l) => l.pid === opts.pid);
  if (opts.minLevel) parsed = parsed.filter((l) => atLeast(l.level, opts.minLevel as LogLevel));
  if (opts.tag) parsed = parsed.filter((l) => l.tag.toLowerCase().includes((opts.tag as string).toLowerCase()));
  return parsed.slice(-n);
}

/** Streams new log lines (from now on) for one process. */
export class LogcatStream extends EventEmitter<{ line: [LogLine]; exit: [] }> {
  private proc?: ChildProcessWithoutNullStreams;
  private buf = '';
  constructor(
    private readonly adb: Adb,
    private readonly serial: string,
    private readonly pid?: number,
  ) {
    super();
  }

  start(): void {
    if (this.proc) return;
    const args = ['-s', this.serial, 'logcat', '-v', 'epoch', '-T', '1'];
    if (this.pid) args.push(`--pid=${this.pid}`);
    const p = this.adb.spawn(args);
    this.proc = p;
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      const parts = this.buf.split(/\r?\n/);
      this.buf = parts.pop() ?? '';
      for (const l of parts) {
        const line = parseLogcatLine(l);
        if (line && (!this.pid || line.pid === this.pid)) this.emit('line', line);
      }
    });
    p.on('exit', () => {
      this.proc = undefined;
      this.emit('exit');
    });
    p.on('error', () => {});
  }

  stop(): void {
    this.proc?.kill();
    this.proc = undefined;
  }
}
