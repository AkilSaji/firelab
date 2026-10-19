/**
 * `firelab bench`: run the engine benchmark, or re-render a saved one.
 * Exit codes: 0 ok, 1 error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { errorMessage } from '../lib/errors.js';
import { customSubject, SUBJECTS, type BenchSubject } from './subjects.js';
import { STRATEGIES, type BenchResult, type BenchStrategy } from './run.js';

export const BENCH_HELP = `firelab bench: measure FireLab's engine against baselines on games with seeded bugs (no TV needed).

  firelab bench [--subjects firefly,deep-quest] [--strategies firelab,firelab-mvp,random,monkey]
                [--runs 5] [--minutes 10] [--parallel 2] [--subject name=url] [--out dir] [--headed]
                [--knowledge pack.json]   adds firelab-k: FireLab with a knowledge pack learned on OTHER games
  firelab bench report <bench dir>          re-render report.html / report.md from bench.json

Subjects (from a FireLab checkout; served locally):
${Object.values(SUBJECTS).map((s) => `  ${s.id.padEnd(12)} ${s.name}`).join('\n')}
  --subject name=url  any web game (coverage, screens and findings; no seeded bugs). Repeatable.

Strategies:
${(Object.keys(STRATEGIES) as BenchStrategy[]).map((s) => `  ${s.padEnd(12)} ${STRATEGIES[s].what}`).join('\n')}

Each run: headless Chrome at the Fire TV viewport, one seed, the same wall-clock budget.
Scores: seeded bugs triggered (ground truth from the game) and reported, JS block coverage,
game progress, depth. Statistics: medians/IQR, Mann-Whitney U, Vargha-Delaney A12, Fisher.
Output: ~/.firelab/bench/<id>/ (bench.json, report.html, report.md, runs/).`;

const list = (s?: string) => (s ? s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) : undefined);

export async function runBenchCli(argv: string[], io = { out: (s: string) => process.stdout.write(`${s}\n`), err: (s: string) => process.stderr.write(`${s}\n`) }): Promise<number> {
  try {
    const { values: v, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        subjects: { type: 'string' },
        subject: { type: 'string', multiple: true },
        strategies: { type: 'string' },
        runs: { type: 'string' },
        minutes: { type: 'string' },
        parallel: { type: 'string' },
        seed: { type: 'string' },
        out: { type: 'string' },
        title: { type: 'string' },
        headed: { type: 'boolean' },
        knowledge: { type: 'string', multiple: true },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (v.help) {
      io.out(BENCH_HELP);
      return 0;
    }
    if (positionals[0] === 'report') {
      const dir = path.resolve(positionals[1] ?? '.');
      const b = JSON.parse(fs.readFileSync(path.join(dir, 'bench.json'), 'utf8')) as BenchResult;
      const { writeBenchReport, benchHeadline } = await import('./report.js');
      b.headline = benchHeadline(b);
      fs.writeFileSync(path.join(dir, 'bench.json'), JSON.stringify(b, null, 1));
      const r = writeBenchReport(b, dir);
      io.out(`Report: ${r.html}`);
      return 0;
    }
    const num = (k: 'runs' | 'minutes' | 'parallel' | 'seed', d: number) => {
      if (v[k] === undefined) return d;
      const n = Number(v[k]);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--${k} must be a positive number`);
      return n;
    };
    const subjects: BenchSubject[] = [];
    for (const id of list(v.subjects) ?? (v.subject?.length ? [] : Object.keys(SUBJECTS))) {
      const s = SUBJECTS[id];
      if (!s) throw new Error(`Unknown subject "${id}" (built in: ${Object.keys(SUBJECTS).join(', ')}; or --subject name=url)`);
      subjects.push(s);
    }
    for (const spec of v.subject ?? []) subjects.push(customSubject(spec));
    const strategies = (list(v.strategies) ?? ['firelab', 'firelab-mvp', 'random', 'monkey', ...(v.knowledge?.length ? ['firelab-k'] : [])]) as BenchStrategy[];
    if (strategies.includes('firelab-k') && !v.knowledge?.length) throw new Error('firelab-k needs --knowledge <pack.json> (learned on other games)');
    for (const s of strategies) if (!STRATEGIES[s]) throw new Error(`Unknown strategy "${s}" (${Object.keys(STRATEGIES).join(', ')})`);
    const { runBench } = await import('./run.js');
    const runs = num('runs', 5);
    const minutes = num('minutes', 10);
    const parallel = num('parallel', 2);
    io.err(`Benchmark: ${subjects.length} game(s) × ${strategies.length} strategies × ${runs} runs × ${minutes} min, ${parallel} at a time (about ${Math.ceil((subjects.length * strategies.length * runs * minutes) / parallel)} min)`);
    const { result, dir } = await runBench({ subjects, strategies, runs, minutes, parallel, seed: num('seed', 1), headed: !!v.headed, ...(v.knowledge?.length ? { knowledge: v.knowledge } : {}), ...(v.out ? { out: v.out } : {}), ...(v.title ? { title: v.title } : {}), onProgress: (m) => io.err(m) });
    if (v.json) io.out(JSON.stringify(result, null, 2));
    else {
      io.out(result.headline ?? '');
      io.out(`Report: ${path.join(dir, 'report.html')}`);
    }
    return 0;
  } catch (e) {
    io.err(`Error: ${errorMessage(e)}`);
    return 1;
  }
}
