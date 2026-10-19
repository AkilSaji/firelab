/**
 * Runs the Vega SDK's `vega` CLI. Every device command goes through it:
 *
 *   vega exec vda -s <serial> <args...>      device tools (shell, pull, devices) [VDA reference]
 *   vega exec inputd-cli <args...>           remote input [inputd-cli]
 *   vega device <subcommand> ...             install-app / launch-app (SDK 0.24 docs)
 *
 * The device is selected with `-s` for vda and with the VEGA_SERIAL
 * environment variable for everything else (vda documents that `-s`
 * overrides VEGA_SERIAL, so both point at the same device).
 *
 * NOT YET TESTED ON A REAL VEGA DEVICE: written from Amazon's Vega 0.24 docs
 * (https://developer.amazon.com/docs/vega/0.24/vda-tools.html and
 * .../inputdcli.html). See docs/VEGA.md for what is verified and what isn't.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FireLabError } from '../lib/errors.js';

export type VegaResult = { code: number; stdout: Buffer; stderr: string };

export interface VegaRunner {
  /** Runs `vega <args...>` with VEGA_SERIAL set when `serial` is given. */
  run(args: string[], opts?: { serial?: string; timeoutMs?: number }): Promise<VegaResult>;
}

export const VEGA_INSTALL_HINT =
  'Install the Vega SDK (https://developer.amazon.com/docs/vega/0.24/install-vega-sdk.html) so the `vega` command is on your PATH, or set VEGA_CLI=/path/to/vega';

/** Where the `vega` CLI could be: $VEGA_CLI, then `vega` (and the older name `kepler`) on PATH, then the SDK's usual home folders. */
export function vegaCandidates(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform: NodeJS.Platform = process.platform): string[] {
  const exe = (n: string) => (platform === 'win32' ? `${n}.exe` : n);
  const out: string[] = [];
  if (env.VEGA_CLI) out.push(env.VEGA_CLI);
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of (env.PATH ?? '').split(sep).filter(Boolean)) {
    out.push(path.join(dir, exe('vega')), path.join(dir, exe('kepler')));
  }
  if (env.VEGA_SDK_ROOT) out.push(path.join(env.VEGA_SDK_ROOT, 'bin', exe('vega')));
  out.push(path.join(home, 'vega', 'bin', exe('vega')), path.join(home, '.vega', 'bin', exe('vega')), path.join(home, 'kepler', 'bin', exe('kepler')));
  return [...new Set(out)];
}

export function findVega(env: NodeJS.ProcessEnv = process.env, exists: (f: string) => boolean = fs.existsSync): string | null {
  return vegaCandidates(env).find((f) => exists(f)) ?? null;
}

/** Runs the real `vega` binary. */
export class VegaProcessRunner implements VegaRunner {
  constructor(private readonly bin: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  run(args: string[], opts: { serial?: string; timeoutMs?: number } = {}): Promise<VegaResult> {
    return new Promise((resolve, reject) => {
      execFile(
        this.bin,
        args,
        { timeout: opts.timeoutMs ?? 30000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', env: { ...this.env, ...(opts.serial ? { VEGA_SERIAL: opts.serial } : {}) } },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
          if (e && e.code === 'ENOENT') {
            reject(new FireLabError('unsupported', `The Vega CLI was not found at ${this.bin}`, { hint: VEGA_INSTALL_HINT }));
            return;
          }
          if (e?.killed) {
            reject(new FireLabError('timeout', `vega ${args.slice(0, 4).join(' ')} timed out after ${Math.round((opts.timeoutMs ?? 30000) / 1000)} s`));
            return;
          }
          resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: stdout ?? Buffer.alloc(0), stderr: stderr?.toString('utf8') ?? '' });
        },
      );
    });
  }
}

export function defaultVegaRunner(env: NodeJS.ProcessEnv = process.env): VegaRunner {
  const bin = findVega(env);
  if (!bin) throw new FireLabError('unsupported', 'The Vega SDK (`vega` CLI) is not installed', { hint: VEGA_INSTALL_HINT });
  return new VegaProcessRunner(bin, env);
}
