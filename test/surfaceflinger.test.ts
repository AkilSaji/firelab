import { describe, expect, it } from 'vitest';
import { parseLayerList, pickLayer, parseLatency, SurfaceFlingerSampler } from '../src/perf/surfaceflinger.js';
import { fakeAdb, SERIAL } from './helpers/fake-adb.js';

const LIST = `Display Root#0
Display Overlays#0
com.amazon.tv.launcher/com.amazon.tv.launcher.ui.HomeActivity_vNext#0
com.FDGEntertainment.RedBall4.amazon/com.unity3d.player.UnityPlayerActivity#0
Background for -SurfaceView - com.FDGEntertainment.RedBall4.amazon/com.unity3d.player.UnityPlayerActivity#0
SurfaceView - com.FDGEntertainment.RedBall4.amazon/com.unity3d.player.UnityPlayerActivity#0
com.sunsetvilla.tv/com.sunsetvilla.tv.MainActivity#0
`;

/** --latency output: refresh period, then desired/actual/ready per frame (ns). */
function latency(presentsMs: number[], pending = 0): string {
  const rows = presentsMs.map((ms) => `${ms * 1e6 - 500000}\t${ms * 1e6}\t${ms * 1e6 - 200000}`);
  for (let i = 0; i < pending; i++) rows.push(`${(presentsMs[presentsMs.length - 1] ?? 0) * 1e6 + 1}\t9223372036854775807\t0`);
  while (rows.length < 127) rows.unshift('0\t0\t0');
  return `16666666\n${rows.join('\n')}\n`;
}

describe('SurfaceFlinger frame timing', () => {
  it('picks the game SurfaceView, else the activity window', () => {
    const layers = parseLayerList(LIST);
    expect(pickLayer(layers, 'com.FDGEntertainment.RedBall4.amazon')).toBe('SurfaceView - com.FDGEntertainment.RedBall4.amazon/com.unity3d.player.UnityPlayerActivity#0');
    expect(pickLayer(layers, 'com.sunsetvilla.tv')).toBe('com.sunsetvilla.tv/com.sunsetvilla.tv.MainActivity#0');
    expect(pickLayer(layers, 'com.not.running')).toBeUndefined();
  });

  it('parses present times, skipping empty slots and unsignalled fences', () => {
    const p = parseLatency(latency([1000, 1033, 1066], 1));
    expect(p.refreshNs).toBe(16666666);
    expect(p.presents).toHaveLength(4); // pending frame falls back to its desired time
    expect(p.presents[0]).toBe(1000e6);
  });

  it('turns new presents between reads into fps', () => {
    const { adb } = fakeAdb();
    const s = new SurfaceFlingerSampler(adb, SERIAL, 'com.example.game');
    const frames30 = (fromMs: number, toMs: number) => Array.from({ length: Math.round((toMs - fromMs) / 33.3333) }, (_, i) => Math.round(fromMs + i * 33.3333));
    expect(s.sampleFrom(parseLatency(latency(frames30(0, 1000))).presents, 10_000)).toEqual([]); // first read primes
    expect(s.sampleFrom(parseLatency(latency(frames30(0, 2000))).presents, 11_000)).toEqual([{ ts: 11_000, fps: 30, source: 'surface' }]);
    // nothing presented in the next second: a frozen or idle game
    expect(s.sampleFrom(parseLatency(latency(frames30(0, 2000))).presents, 12_000)[0]?.fps).toBe(0);
  });

  it('falls back to the buffer span when more frames arrived than it holds', () => {
    const { adb } = fakeAdb();
    const s = new SurfaceFlingerSampler(adb, SERIAL, 'com.example.game');
    const at60 = (from: number) => Array.from({ length: 127 }, (_, i) => Math.round(from + i * 16.6667));
    s.sampleFrom(parseLatency(latency(at60(0))).presents, 1000);
    const [x] = s.sampleFrom(parseLatency(latency(at60(5000))).presents, 6000);
    expect(x?.fps).toBeCloseTo(60, 0);
  });

  it('reads the layer list once and quotes the layer name for the shell', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/SurfaceFlinger --list/, LIST);
    runner.on(/SurfaceFlinger --latency/, latency([1000, 1033]));
    const s = new SurfaceFlingerSampler(adb, SERIAL, 'com.FDGEntertainment.RedBall4.amazon');
    await s.read(1000);
    await s.read(2000);
    const cmds = runner.shellCommands();
    expect(cmds.filter((c) => c.includes('--list'))).toHaveLength(1);
    expect(cmds[1]).toBe("dumpsys SurfaceFlinger --latency 'SurfaceView - com.FDGEntertainment.RedBall4.amazon/com.unity3d.player.UnityPlayerActivity#0'");
  });
});
