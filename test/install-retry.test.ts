import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FireLabError } from '../src/lib/errors.js';
import { fakeLab } from './helpers/fake-lab.js';

describe('install', () => {
  it('a streamed install that stalls is retried once with --no-streaming', async () => {
    const { lab, runner, home } = fakeLab();
    const apk = path.join(home, 'x.apk');
    fs.writeFileSync(apk, 'not really an apk');
    const timeouts: (number | undefined)[] = [];
    runner.on(
      (a) => a.includes('install') && !a.includes('--no-streaming'),
      (args, opts) => {
        timeouts.push(opts?.timeoutMs);
        throw new FireLabError('timeout', `adb ${args.join(' ')} timed out after 120 s`);
      },
    );
    runner.on(
      (a) => a.includes('install') && a.includes('--no-streaming'),
      (_args, opts) => {
        timeouts.push(opts?.timeoutMs);
        return 'Performing Push Install\nSuccess\n';
      },
    );
    const r = await lab.install(undefined, apk);
    expect(r.ok).toBe(true);
    expect(timeouts).toEqual([120_000, 180_000]);
    expect(r.warnings.join('\n')).toMatch(/stalled after 120 s; installed again with --no-streaming/);
  });

  it('other install failures are not retried', async () => {
    const { lab, runner, home } = fakeLab();
    const apk = path.join(home, 'x.apk');
    fs.writeFileSync(apk, 'not really an apk');
    runner.on(/install/, { stdout: Buffer.from('adb: failed to install x.apk: Failure [INSTALL_FAILED_VERSION_DOWNGRADE]\n'), stderr: '', code: 1 });
    await expect(lab.install(undefined, apk)).rejects.toMatchObject({ code: 'adb-failed' });
    expect(runner.calls.filter((a) => a.includes('install')).length).toBe(1);
  });
});
