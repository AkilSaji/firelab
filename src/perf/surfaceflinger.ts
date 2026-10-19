import type { Adb } from '../adb/client.js';
import { assertPackage, shQuote } from '../adb/apps.js';
import type { FpsSample } from '../cdp/fps.js';

/**
 * Frame rate of any app, WebView or not (Unity, native GL, Android views),
 * from SurfaceFlinger's per-layer present timestamps:
 * `dumpsys SurfaceFlinger --latency <layer>` keeps the last 127 frames of a
 * layer. Read once a second, the frames presented since the last read are
 * the fps. Works for the shell user on Android 5-12 (Fire OS 5-8).
 */

/** Layer names from `dumpsys SurfaceFlinger --list`. */
export function parseLayerList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * The layer that shows an app's frames: its SurfaceView (games render there)
 * if it has one, else its activity window. "Background for" helper layers and
 * other apps are ignored.
 */
export function pickLayer(layers: string[], pkg: string): string | undefined {
  const mine = layers.filter((l) => l.includes(`${pkg}/`) && !/^Background for/i.test(l) && !/BLAST|Bounds for|Task=|ActivityRecord\{/i.test(l));
  return mine.find((l) => /^SurfaceView/i.test(l)) ?? mine.find((l) => /#\d+$/.test(l)) ?? mine[0];
}

/** `--latency` output: refresh period (ns), then "desired actual ready" ns per frame. */
export function parseLatency(text: string): { refreshNs?: number; presents: number[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const refresh = Number(lines[0]);
  const presents: number[] = [];
  for (const l of lines.slice(1)) {
    const parts = l.split(/\s+/).map(Number);
    if (parts.length < 2) continue;
    const desired = parts[0] as number;
    const actual = parts[1] as number;
    // 0 = empty slot; INT64_MAX = fence not signalled yet.
    const t = actual > 0 && actual < 1e18 ? actual : desired > 0 && desired < 1e18 ? desired : 0;
    if (t > 0) presents.push(t);
  }
  presents.sort((a, b) => a - b);
  return { refreshNs: Number.isFinite(refresh) && refresh > 0 ? refresh : undefined, presents };
}

export class SurfaceFlingerSampler {
  private layer?: string;
  private lastPresent = 0;
  private lastAt = 0;

  constructor(
    private readonly adb: Adb,
    private readonly serial: string,
    readonly pkg: string,
  ) {
    assertPackage(pkg);
  }

  async findLayer(): Promise<string | undefined> {
    const out = await this.adb.shell(this.serial, 'dumpsys SurfaceFlinger --list', { timeoutMs: 8000 });
    this.layer = pickLayer(parseLayerList(out), this.pkg);
    return this.layer;
  }

  /** Frames presented since the previous call, as one fps sample (none on the first call). */
  async read(now = Date.now()): Promise<FpsSample[]> {
    if (!this.layer && !(await this.findLayer())) return [];
    const out = await this.adb.shell(this.serial, `dumpsys SurfaceFlinger --latency ${shQuote(this.layer as string)}`, { timeoutMs: 8000 });
    const { presents } = parseLatency(out);
    if (!presents.length) {
      // Layer gone (app restarted / new window): look it up again next time.
      this.layer = undefined;
      return [];
    }
    return this.sampleFrom(presents, now);
  }

  /** Exposed for tests. */
  sampleFrom(presents: number[], now: number): FpsSample[] {
    const newest = presents[presents.length - 1] as number;
    const first = this.lastAt === 0;
    const prevPresent = this.lastPresent;
    const elapsed = (now - this.lastAt) / 1000;
    this.lastPresent = newest;
    this.lastAt = now;
    if (first || elapsed <= 0) return [];
    const fresh = presents.filter((t) => t > prevPresent);
    // The buffer holds 127 frames: if all are new we may have missed some; use their own span.
    if (fresh.length >= presents.length && presents.length > 1) {
      const span = ((newest - (presents[0] as number)) / 1e9) || elapsed;
      return [{ ts: now, fps: Math.round(((presents.length - 1) / span) * 10) / 10, source: 'surface' }];
    }
    return [{ ts: now, fps: Math.round((fresh.length / elapsed) * 10) / 10, source: 'surface' }];
  }
}
