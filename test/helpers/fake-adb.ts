import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Adb, type AdbRunner, type ExecOptions, type ExecResult } from '../../src/adb/client.js';

type Reply = string | Buffer | ExecResult | ((args: string[], opts?: ExecOptions) => string | Buffer | ExecResult | Promise<string | Buffer | ExecResult>);
type Rule = { match: RegExp | ((args: string[]) => boolean); reply: Reply; times?: number };

/**
 * A scripted adb: rules match the joined argument list ("-s X shell input keyevent 19")
 * and answer with recorded output. Unmatched calls fail loudly so tests notice.
 */
export class FakeRunner implements AdbRunner {
  rules: Rule[] = [];
  calls: string[][] = [];
  spawned: { args: string[]; proc: FakeProcess }[] = [];

  on(match: Rule['match'], reply: Reply, times?: number): this {
    this.rules.push({ match, reply, times });
    return this;
  }

  /** Commands run with `adb -s <serial> shell <cmd>`: just the <cmd> part. */
  shellCommands(): string[] {
    return this.calls.filter((a) => a[2] === 'shell').map((a) => a[3] as string);
  }

  async exec(args: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push(args);
    const joined = args.join(' ');
    const idx = this.rules.findIndex((r) => (r.match instanceof RegExp ? r.match.test(joined) : r.match(args)));
    if (idx < 0) return { stdout: Buffer.alloc(0), stderr: `fake adb: no rule for "${joined}"`, code: 1 };
    const rule = this.rules[idx] as Rule;
    if (rule.times !== undefined && --rule.times <= 0) this.rules.splice(idx, 1);
    let r = typeof rule.reply === 'function' ? await rule.reply(args, opts) : rule.reply;
    if (typeof r === 'string') r = { stdout: Buffer.from(r), stderr: '', code: 0 };
    else if (Buffer.isBuffer(r)) r = { stdout: r, stderr: '', code: 0 };
    return r;
  }

  spawn(args: string[]): ChildProcessWithoutNullStreams {
    const proc = new FakeProcess();
    this.spawned.push({ args, proc });
    return proc as unknown as ChildProcessWithoutNullStreams;
  }
}

export class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit('exit', 0);
    return true;
  }
  write(text: string): void {
    this.stdout.write(text);
  }
}

export function fakeAdb(): { adb: Adb; runner: FakeRunner } {
  const runner = new FakeRunner();
  return { adb: new Adb('/fake/adb', runner), runner };
}

export const SERIAL = '192.168.1.194:5555';
export const DEVICES_L = `List of devices attached\n${SERIAL}     device product:karat model:AFTMA08C15 device:karat transport_id:4\n\n`;
