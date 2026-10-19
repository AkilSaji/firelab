import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';

const SAMPLE = path.join(import.meta.dirname, 'fixtures', 'fit', 'sample-measurement.json');

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => (err.push(String(s)), true));
  return { out: () => out.join(''), err: () => err.join('') };
}

afterEach(() => vi.restoreAllMocks());

describe('firelab CLI dispatch', () => {
  it('lists fit, profile, media and lab in the help', async () => {
    const io = capture();
    expect(await main(['help'])).toBe(0);
    for (const cmd of ['fit --offline', 'profile', 'media <file', 'lab ...', 'explore', 'GETTING-STARTED.md']) expect(io.out()).toContain(cmd);
  });

  it('runs firelab fit --offline without a device', async () => {
    const io = capture();
    expect(await main(['fit', '--offline', SAMPLE, '--fail-on', 'none'])).toBe(0);
    expect(io.err()).not.toContain('Unknown command');
    expect(io.out()).toMatch(/AFTSSS/);
  });

  it('prints the fit, profile and media help', async () => {
    const io = capture();
    expect(await main(['fit', '--help'])).toBe(0);
    expect(await main(['profile', '--help'])).toBe(0);
    expect(await main(['media', '--help'])).toBe(0);
    expect(io.out()).toContain('firelab fit:');
    expect(io.out()).toContain('firelab profile:');
    expect(io.out()).toContain('firelab media:');
  });

  it('still rejects unknown commands', async () => {
    const io = capture();
    expect(await main(['nope'])).toBe(2);
    expect(io.err()).toContain('Unknown command "nope"');
  });
});
