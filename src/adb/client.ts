import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { FireLabError } from '../lib/errors.js';
import { ADB_INSTALL_HINT } from './locate.js';
import { parseDevices, type AdbDevice } from './devices.js';

export type ExecOptions = {
  /** Kill adb after this long (default 15 s). */
  timeoutMs?: number;
  /** Data for adb's stdin. */
  input?: string | Buffer;
  /** Max stdout size (default 64 MB, enough for a 4K raw screenshot). */
  maxBuffer?: number;
};

export type ExecResult = { stdout: Buffer; stderr: string; code: number | null };

/**
 * The seam between FireLab and the adb binary. The real one runs adb; tests
 * pass a fake that answers from recorded fixtures.
 */
export interface AdbRunner {
  exec(args: string[], opts?: ExecOptions): Promise<ExecResult>;
  spawn(args: string[]): ChildProcessWithoutNullStreams;
}

export class ProcessRunner implements AdbRunner {
  constructor(readonly binary: string) {}

  exec(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const timeout = opts.timeoutMs ?? 15000;
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.binary,
        args,
        { timeout, maxBuffer: opts.maxBuffer ?? 64 << 20, encoding: 'buffer', windowsHide: true },
        (err, stdout, stderr) => {
          const errStr = stderr ? stderr.toString('utf8') : '';
          if (err) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string };
            if (e.code === 'ENOENT') {
              return reject(new FireLabError('adb-missing', `adb not found at ${this.binary}`, { hint: ADB_INSTALL_HINT }));
            }
            if (e.killed || e.signal === 'SIGTERM') {
              return reject(
                new FireLabError('timeout', `adb ${redactArgs(args)} timed out after ${Math.round(timeout / 100) / 10} s`, {
                  hint: 'The device may be asleep, busy or off the network. Try `firelab devices` or wake it',
                }),
              );
            }
            if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              return reject(new FireLabError('adb-failed', `adb ${redactArgs(args)} produced too much output`));
            }
            // Non-zero exit: hand it back, callers decide.
            return resolve({ stdout: stdout ?? Buffer.alloc(0), stderr: errStr, code: typeof e.code === 'number' ? e.code : 1 });
          }
          resolve({ stdout: stdout ?? Buffer.alloc(0), stderr: errStr, code: 0 });
        },
      );
      if (opts.input !== undefined) child.stdin?.end(opts.input);
    });
  }

  spawn(args: string[]): ChildProcessWithoutNullStreams {
    return spawn(this.binary, args, { stdio: 'pipe', windowsHide: true });
  }
}

const redactArgs = (args: string[]): string => {
  const s = args.join(' ');
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
};

/** Turns adb's own error text (not the remote command's) into a FireLabError. */
export function classifyAdbError(text: string, serial?: string): FireLabError | null {
  const t = text.trim();
  const who = serial ? `Device ${serial}` : 'The device';
  if (/unauthorized/i.test(t)) {
    return new FireLabError('unauthorized', `${who} has not authorized this computer`, {
      hint: 'Look at the TV and accept the "Allow USB debugging?" prompt (tick "Always allow from this computer"). No prompt? Run `adb kill-server`, then connect again',
    });
  }
  if (/device offline|device still connecting|error: closed/i.test(t)) {
    return new FireLabError('offline', `${who} is offline`, {
      hint: 'It dropped off adb (Wi-Fi blip, sleep or reboot). FireLab reconnects Wi-Fi devices on its own; or run `adb connect <ip>:5555`',
    });
  }
  const notFound = /device '([^']+)' not found|device not found/i.exec(t);
  if (notFound) {
    return new FireLabError('device-not-found', `${notFound[1] ? `Device ${notFound[1]}` : who} is not connected`, {
      hint: 'List devices with `firelab devices`, or connect one with `firelab devices --scan`',
    });
  }
  if (/no devices\/emulators found|no devices found/i.test(t)) {
    return new FireLabError('no-device', 'No device is connected', {
      hint: 'Turn on ADB debugging on the Fire TV, then run `firelab devices --scan` (see `firelab doctor`)',
    });
  }
  if (/more than one device/i.test(t)) {
    return new FireLabError('ambiguous-device', 'More than one device is connected', { hint: 'Pick one with --device <serial>' });
  }
  if (/^(adb: )?error:/m.test(t) || /^adb: /m.test(t)) {
    return new FireLabError('adb-failed', t.split('\n')[0] ?? t);
  }
  return null;
}

export type ShellOptions = ExecOptions & {
  /** Throw if the remote command exits non-zero (default false: return stdout). */
  check?: boolean;
};

export type ConnectResult = { ok: boolean; already: boolean; message: string };

/** A typed adb client. Every call has a timeout; errors carry a hint. */
export class Adb {
  readonly runner: AdbRunner;
  constructor(
    readonly path: string,
    runner?: AdbRunner,
  ) {
    this.runner = runner ?? new ProcessRunner(path);
  }

  /** Runs adb and returns stdout; throws on a non-zero exit. */
  async run(args: string[], opts: ExecOptions = {}): Promise<string> {
    const r = await this.runner.exec(args, opts);
    const out = r.stdout.toString('utf8');
    if (r.code !== 0) {
      const serial = args[0] === '-s' ? args[1] : undefined;
      throw classifyAdbError(`${r.stderr}\n${out}`, serial) ?? new FireLabError('adb-failed', `adb ${redactArgs(args)} failed: ${(r.stderr || out).trim().split('\n')[0] ?? ''}`);
    }
    return out;
  }

  /**
   * `adb -s <serial> shell <command>`. Returns stdout even when the remote
   * command fails (e.g. `pidof` with no match); adb's own errors throw.
   */
  async shell(serial: string, command: string, opts: ShellOptions = {}): Promise<string> {
    const r = await this.runner.exec(['-s', serial, 'shell', command], opts);
    const out = r.stdout.toString('utf8');
    if (r.code !== 0) {
      const adbErr = classifyAdbError(r.stderr, serial);
      if (adbErr && (adbErr.code !== 'adb-failed' || !out)) throw adbErr;
      if (opts.check) throw new FireLabError('adb-failed', `\`${command.slice(0, 80)}\` failed on ${serial}: ${(r.stderr || out).trim().split('\n')[0] ?? ''}`);
    }
    return out;
  }

  /** `adb exec-out`: raw bytes (no newline translation), for screenshots. */
  async execOut(serial: string, command: string, opts: ExecOptions = {}): Promise<Buffer> {
    const r = await this.runner.exec(['-s', serial, 'exec-out', command], opts);
    if (r.code !== 0 && r.stdout.length === 0) {
      throw classifyAdbError(r.stderr, serial) ?? new FireLabError('adb-failed', `exec-out failed on ${serial}: ${r.stderr.trim()}`);
    }
    return r.stdout;
  }

  spawn(args: string[]): ChildProcessWithoutNullStreams {
    return this.runner.spawn(args);
  }

  async version(): Promise<string> {
    const out = await this.run(['version'], { timeoutMs: 5000 });
    return parseAdbVersion(out);
  }

  async devices(): Promise<AdbDevice[]> {
    return parseDevices(await this.run(['devices', '-l'], { timeoutMs: 8000 }));
  }

  /** `adb connect host[:5555]`. adb exits 0 even when it fails, so we read the text. */
  async connect(host: string, timeoutMs = 8000): Promise<ConnectResult> {
    const target = host.includes(':') ? host : `${host}:5555`;
    const r = await this.runner.exec(['connect', target], { timeoutMs });
    return parseConnectOutput(`${r.stdout.toString('utf8')}\n${r.stderr}`);
  }

  async disconnect(host: string): Promise<void> {
    await this.runner.exec(['disconnect', host], { timeoutMs: 5000 });
  }

  /** Forwards a local TCP port (0 = any free port) to a device socket; returns the port. */
  async forward(serial: string, remote: string, localPort = 0): Promise<number> {
    const out = await this.run(['-s', serial, 'forward', `tcp:${localPort}`, remote], { timeoutMs: 8000 });
    const port = localPort || Number(out.trim().split(/\s+/).pop());
    if (!Number.isInteger(port) || port <= 0) throw new FireLabError('adb-failed', `adb forward did not return a port (got "${out.trim()}")`);
    return port;
  }

  async forwardRemove(serial: string, localPort: number): Promise<void> {
    await this.runner.exec(['-s', serial, 'forward', '--remove', `tcp:${localPort}`], { timeoutMs: 5000 });
  }

  async forwardList(): Promise<{ serial: string; local: string; remote: string }[]> {
    const out = await this.run(['forward', '--list'], { timeoutMs: 5000 });
    return out
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length === 3)
      .map(([serial, local, remote]) => ({ serial: serial as string, local: local as string, remote: remote as string }));
  }

  /** `adb install -r` (replace). Returns adb's output; throws with the INSTALL_FAILED reason. */
  async install(serial: string, apkPath: string, opts: { downgrade?: boolean; grant?: boolean } = {}): Promise<string> {
    const args = ['-s', serial, 'install', '-r'];
    if (opts.downgrade) args.push('-d');
    if (opts.grant) args.push('-g');
    args.push(apkPath);
    const r = await this.runner.exec(args, { timeoutMs: 300000 });
    const out = `${r.stdout.toString('utf8')}\n${r.stderr}`;
    if (r.code !== 0 || !/\bSuccess\b/.test(out)) {
      const reason = /Failure \[([^\]]+)\]/.exec(out)?.[1] ?? /(INSTALL_[A-Z_]+[^\n]*)/.exec(out)?.[1];
      throw classifyAdbError(r.stderr, serial) ?? new FireLabError('adb-failed', `Install failed: ${reason ?? out.trim().split('\n').pop()}`, { hint: installHint(reason) });
    }
    return out.trim();
  }
}

export function parseAdbVersion(out: string): string {
  const m = /Android Debug Bridge version ([\d.]+)/.exec(out);
  const v = /^Version ([^\s]+)/m.exec(out);
  return [m?.[1], v ? `(platform-tools ${v[1]})` : ''].filter(Boolean).join(' ') || out.trim().split('\n')[0] || 'unknown';
}

export function parseConnectOutput(text: string): ConnectResult {
  const t = text.trim();
  const already = /already connected/i.test(t);
  const ok = already || /^connected to/im.test(t);
  const failed = /failed|cannot|unable|refused|timed out|no route/i.test(t);
  return { ok: ok && !failed, already, message: t.split('\n').find((l) => l.trim()) ?? t };
}

function installHint(reason?: string): string | undefined {
  if (!reason) return undefined;
  if (/NO_MATCHING_ABIS/.test(reason)) return 'The APK has no native code for this device\'s CPU (Fire TV Sticks are mostly 32-bit armeabi-v7a)';
  if (/UPDATE_INCOMPATIBLE|INCONSISTENT_CERTIFICATES/.test(reason)) return 'An app with this package name but a different signature is installed; uninstall it first (this deletes its data)';
  if (/VERSION_DOWNGRADE/.test(reason)) return 'The installed version is newer; pass downgrade to allow it';
  if (/OLDER_SDK/.test(reason)) return 'The APK needs a newer Android than this device has (check minSdkVersion)';
  if (/INSUFFICIENT_STORAGE/.test(reason)) return 'Free some space on the device';
  return undefined;
}
