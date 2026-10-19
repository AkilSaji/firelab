/**
 * JavaScript code coverage of the app's page (docs/ENGINE.md 12.2, 11 tier B):
 * V8 precise block coverage through DevTools (Profiler.startPreciseCoverage),
 * the measure search-based and coverage-guided testers optimise [4, 8]. It is
 * engine-independent, so the benchmark uses it to compare strategies fairly,
 * and the explorer counts "this action ran new code" as progress, like a
 * coverage-guided fuzzer.
 *
 * Blocks are keyed by script URL and source range, so they add up across
 * relaunches (each launch is a new page, and V8 counts from zero again).
 * Scripts without a URL (FireLab's own probe, eval'd snippets) don't count.
 */
import type { DeviceDriver } from './driver.js';

type Range = { startOffset: number; endOffset: number; count: number };
type FunctionCoverage = { functionName: string; ranges: Range[]; isBlockCoverage: boolean };
type ScriptCoverage = { scriptId: string; url: string; functions: FunctionCoverage[] };

export type CoverageSummary = {
  /** Distinct covered blocks over the whole run. */
  blocks: number;
  /** Distinct functions that ran. */
  functions: number;
  /** Scripts that had covered code, with their block counts. */
  scripts: { url: string; blocks: number }[];
};

/** Keys of the covered blocks in one takePreciseCoverage result (pure; tested). */
export function coveredBlocks(result: ScriptCoverage[], include: (url: string) => boolean = () => true): { blocks: Set<string>; functions: Set<string> } {
  const blocks = new Set<string>();
  const functions = new Set<string>();
  for (const s of result) {
    if (!s.url || /^(chrome|devtools|extensions)::?/.test(s.url) || !include(s.url)) continue;
    for (const f of s.functions) {
      const top = f.ranges[0];
      if (!top || top.count === 0) continue;
      functions.add(`${s.url}#${top.startOffset}`);
      // Block coverage: the first range is the function, nested ranges with count 0 are blocks that didn't run.
      // Covered blocks = the function body plus nested ranges that ran.
      for (const r of f.ranges) if (r.count > 0) blocks.add(`${s.url}#${r.startOffset}-${r.endOffset}`);
    }
  }
  return { blocks, functions };
}

export class JsCoverage {
  private readonly blocks = new Set<string>();
  private readonly functions = new Set<string>();
  private readonly perScript = new Map<string, number>();
  private on = false;
  /** Set when DevTools refused (no cdp, or the page has no Profiler): the run goes on without coverage. */
  off?: string;
  samples = 0;

  constructor(
    private readonly d: DeviceDriver,
    private readonly include: (url: string) => boolean = () => true,
  ) {}

  get available(): boolean {
    return !this.off && this.d.caps.cdp && typeof this.d.cdp === 'function';
  }

  /** After every launch: the page is new, so coverage collection starts again. */
  async start(): Promise<void> {
    this.on = false;
    if (!this.available || !this.d.cdp) return;
    try {
      await this.d.cdp('Profiler.enable');
      await this.d.cdp('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
      this.on = true;
    } catch (e) {
      this.off = `JS coverage off: ${(e as Error).message}`;
    }
  }

  /** Reads coverage since the last call; returns how many blocks are new to the run. */
  async sample(): Promise<number> {
    if (!this.available || !this.d.cdp) return 0;
    if (!this.on) await this.start();
    if (!this.on) return 0;
    try {
      const r = (await this.d.cdp('Profiler.takePreciseCoverage')) as { result?: ScriptCoverage[] } | undefined;
      this.samples++;
      const { blocks, functions } = coveredBlocks(r?.result ?? [], this.include);
      let added = 0;
      for (const b of blocks) {
        if (this.blocks.has(b)) continue;
        this.blocks.add(b);
        added++;
        const url = b.slice(0, b.lastIndexOf('#'));
        this.perScript.set(url, (this.perScript.get(url) ?? 0) + 1);
      }
      for (const f of functions) this.functions.add(f);
      return added;
    } catch {
      // The page may be reloading (or the app left): start again on the next sample.
      this.on = false;
      return 0;
    }
  }

  get size(): number {
    return this.blocks.size;
  }

  summary(): CoverageSummary {
    return {
      blocks: this.blocks.size,
      functions: this.functions.size,
      scripts: [...this.perScript.entries()].map(([url, blocks]) => ({ url, blocks })).sort((a, b) => b.blocks - a.blocks).slice(0, 30),
    };
  }
}
