import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMeminfo, parseTop, parseProcStatTicks, parseCpuTotals, parseGfxinfo, parseRendererPid, parseProcMeminfo } from '../src/perf/parse.js';
import { NativeSampler } from '../src/perf/native.js';
import { fakeAdb, SERIAL } from './helpers/fake-adb.js';

const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

describe('dumpsys meminfo', () => {
  it('reads the App Summary of a real WebView game (Fire OS 8)', () => {
    expect(parseMeminfo(fx('meminfo-webview-app.txt'))).toEqual({
      pssKB: 266411,
      rssKB: 295103,
      swapPssKB: 39255,
      javaHeapKB: 4188,
      nativeHeapKB: 23168,
      codeKB: 6244,
      graphicsKB: 152087,
      privateOtherKB: 15384,
      systemKB: 64632,
      glMtrackKB: 152087,
    });
  });

  it('reads the Android 9 summary ("TOTAL:") and grep-filtered output', () => {
    const fos7 = ' App Summary\n            Graphics:    40102\n           TOTAL:   204157       TOTAL SWAP PSS:    40442\n';
    expect(parseMeminfo(fos7)).toMatchObject({ pssKB: 204157, swapPssKB: 40442, graphicsKB: 40102 });
    const grepped = '        TOTAL   290746   133844    26320   109413   262600     9308     6406     2901\n           TOTAL PSS:   290746            TOTAL RSS:   262600       TOTAL SWAP PSS:   109413\n';
    expect(parseMeminfo(grepped)).toMatchObject({ pssKB: 290746, rssKB: 262600 });
    expect(parseMeminfo('        TOTAL    51234    40000')).toMatchObject({ pssKB: 51234 });
  });
});

describe('/proc parsing', () => {
  it('reads utime+stime even when the process name has spaces and parens', () => {
    const line = '13181 (ocessService0:0) S 1155 327 0 0 -1 1077936448 802477 0 77168 0 228533 22592 0 0 10 -10 36 0 251511 2924818432 67095';
    expect(parseProcStatTicks(line)).toEqual({ pid: 13181, name: 'ocessService0:0', ticks: 251125, startTime: 251511 });
    expect(parseProcStatTicks('42 (my (weird) app) R 1 1 0 0 -1 0 0 0 0 0 100 50 0 0 20 0 1 0 999 0 0')?.ticks).toBe(150);
    expect(parseProcStatTicks('garbage')).toBeNull();
  });
  it('reads CPU totals and meminfo', () => {
    expect(parseCpuTotals('cpu  778597 18053 220334 1311030 4920 0 10338 0 0 0')).toEqual({ busy: 1027322, total: 2343272 });
    expect(parseCpuTotals('intr 1 2 3')).toBeNull();
    expect(parseProcMeminfo('MemTotal:        1710032 kB\nMemAvailable:     373684 kB\n')).toEqual({ MemTotal: 1710032, MemAvailable: 373684 });
  });
});

describe('top', () => {
  it('reads a real toybox `top -b -n 1` from a Fire TV', () => {
    const t = parseTop(fx('top.txt'));
    expect(t.cpuCores).toBe(4);
    expect(t.processes[0]).toMatchObject({ pid: 13181, user: 'u0_i9001', cpu: 65.6, mem: 15.1, res: '254M', state: 'S' });
    expect(t.processes[0]?.name).toMatch(/^com\.amazon\.webview\.chromium:sandboxed_process0/);
    expect(t.processes.find((p) => p.name === 'com.sunsetvilla.tv')?.cpu).toBe(43.7);
  });
});

describe('gfxinfo', () => {
  it('reads frame stats', () => {
    const text = 'Stats since: 123ns\nTotal frames rendered: 5321\nJanky frames: 412 (7.74%)\n50th percentile: 9ms\n90th percentile: 21ms\n95th percentile: 34ms\n99th percentile: 81ms\n';
    expect(parseGfxinfo(text)).toEqual({ totalFrames: 5321, jankyFrames: 412, jankyPct: 7.74, p50: 9, p90: 21, p95: 34, p99: 81 });
  });
});

describe('WebView renderer lookup', () => {
  it('finds the sandboxed renderer serving an app uid (real dumpsys activity processes)', () => {
    expect(parseRendererPid(fx('activity-processes.txt'), 10263)).toBe(13181);
    expect(parseRendererPid(fx('activity-processes.txt'), 10264)).toBeNull();
    expect(parseRendererPid(fx('activity-processes.txt'), 1000)).toBeNull();
  });
});

describe('NativeSampler', () => {
  const out = (up: number, cpu: string, app: number, ren: number) =>
    [
      `${up} 13796.01`,
      '@@stat',
      cpu,
      '@@app',
      `13059 (.sunsetvilla.tv) S 327 327 0 0 -1 1077936448 483828 257 28544 0 ${app} 0 0 1 10 -10 53 0 251431 2093166592 34964`,
      '@@ren',
      `13181 (ocessService0:0) S 1155 327 0 0 -1 1077936448 802477 0 77168 0 ${ren} 0 0 0 10 -10 36 0 251511 2924818432 67095`,
      '@@meminfo',
      'MemTotal:        1710032 kB',
      'MemAvailable:     373684 kB',
      '@@appmem',
      '           TOTAL PSS:   266411            TOTAL RSS:   295103       TOTAL SWAP PSS:    39255',
      '            Graphics:   152087                         152087',
      '@@renmem',
      '           TOTAL PSS:   290746            TOTAL RSS:   262600       TOTAL SWAP PSS:   109413',
    ].join('\n');

  it('sums app + renderer memory and computes CPU % of one core between samples', () => {
    const { adb } = fakeAdb();
    const s = new NativeSampler(adb, SERIAL, 'com.sunsetvilla.tv');
    const a = s.parse(out(1000, 'cpu 1000 0 0 3000 0 0 0', 10000, 20000), 1, 13059, 13181);
    expect(a).toMatchObject({ appPid: 13059, rendererPid: 13181, appPssMB: 260.2, rendererPssMB: 283.9, memMB: 544.1, graphicsMB: 148.5, memAvailableMB: 364.9 });
    expect(a.cpuPct).toBeUndefined();
    // 2 s later: app used 90 ticks, renderer 130 -> 220 ticks / 100 Hz / 2 s = 110% of one core
    const b = s.parse(out(1002, 'cpu 1400 0 0 3400 0 0 0', 10090, 20130), 2, 13059, 13181);
    expect(b.cpuPct).toBe(110);
    expect(b.deviceCpuPct).toBe(50);
  });

  it('resets when the app restarts (new pid)', () => {
    const { adb } = fakeAdb();
    const s = new NativeSampler(adb, SERIAL, 'com.sunsetvilla.tv');
    s.parse(out(1000, 'cpu 1000 0 0 3000 0 0 0', 10000, 20000), 1, 13059, 13181);
    expect(s.parse(out(1002, 'cpu 1400 0 0 3400 0 0 0', 50, 60), 2, 99999, 13181).cpuPct).toBeUndefined();
  });

  it('runs one adb round trip per sample after finding the renderer once', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/shell pidof com.sunsetvilla.tv/, '13059\n');
    runner.on(/stat -c %u \/proc\/13059/, `10263\n@@procs\n${fx('activity-processes.txt')}`);
    runner.on(/cat \/proc\/uptime/, out(1000, 'cpu 1000 0 0 3000 0 0 0', 10000, 20000));
    const s = new NativeSampler(adb, SERIAL, 'com.sunsetvilla.tv');
    const a = await s.sample();
    expect(a.rendererPid).toBe(13181);
    await s.sample({ memory: false });
    const cmds = runner.shellCommands();
    expect(cmds.filter((c) => c.includes('dumpsys activity processes'))).toHaveLength(1);
    expect(cmds[cmds.length - 1]).not.toContain('dumpsys meminfo');
  });

  it('reports nothing but the time when the app is not running', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/shell pidof/, { stdout: Buffer.from(''), stderr: '', code: 1 });
    const s = await new NativeSampler(adb, SERIAL, 'com.example.game').sample();
    expect(Object.keys(s)).toEqual(['ts']);
  });
});
