/**
 * `firelab learn export | show | merge`. Exit codes: 0 ok, 1 error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { errorMessage } from '../lib/errors.js';
import { exploreDir } from './config.js';
import { describePack, exportKnowledge, knowledgeDirs, loadKnowledge, mergeFiles, writePack } from './learn.js';

export const LEARN_HELP = `firelab learn: share what FireLab learned on your game, so it gets better for everyone.

  firelab learn export [<run dir | run id>...] [--latest 5] [--reject f-id,...] [--out pack.json] [--json]
  firelab learn show [--knowledge <file|dir>]       what this FireLab already knows (bundled + ~/.firelab/knowledge)
  firelab learn merge <pack.json>... --out knowledge/firelab.json     (maintainers)

export reads explore runs and writes a knowledge pack: the last remote keys of each confirmed,
shrunk finding (a "bug pattern", e.g. ok*3 -> black-screen) and how often each key changed the
app's state. --reject marks findings that were not bugs (they lower a pattern's weight).
Nothing is uploaded: open a pull request adding the file to knowledge/ in the FireLab repository.
Shared: key names, finding kinds, counts, hashed game ids. Not shared: URLs, package names,
screen names, text, screenshots, code.`;

const list = (s?: string) => (s ? s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) : []);

function runDirs(args: string[], latest?: number): string[] {
  const base = exploreDir();
  const dirs = args.map((a) => (fs.existsSync(path.join(a, 'run.json')) ? path.resolve(a) : path.join(base, a))).filter((d) => fs.existsSync(path.join(d, 'run.json')));
  if (!args.length) {
    const all = fs.existsSync(base) ? fs.readdirSync(base).map((d) => path.join(base, d)).filter((d) => fs.existsSync(path.join(d, 'run.json'))) : [];
    all.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    dirs.push(...all.slice(0, latest ?? 5));
  }
  return dirs;
}

export async function runLearnCli(argv: string[], io = { out: (s: string) => process.stdout.write(`${s}\n`), err: (s: string) => process.stderr.write(`${s}\n`) }): Promise<number> {
  try {
    const { values: v, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { out: { type: 'string' }, reject: { type: 'string' }, latest: { type: 'string' }, knowledge: { type: 'string', multiple: true }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
    const [sub, ...rest] = positionals;
    if (v.help || !sub) {
      io.out(LEARN_HELP);
      return v.help ? 0 : 1;
    }
    if (sub === 'export') {
      const dirs = runDirs(rest, v.latest ? Number(v.latest) : undefined);
      if (!dirs.length) throw new Error('No explore runs found: run firelab explore first, or pass a run directory');
      const pack = exportKnowledge(dirs, list(v.reject));
      const file = writePack(pack, v.out);
      if (v.json) io.out(JSON.stringify(pack, null, 2));
      else io.out(describePack(pack));
      io.err(`Knowledge pack: ${file}`);
      io.err('To contribute: fork the FireLab repository, add this file to knowledge/, and open a pull request.');
      return 0;
    }
    if (sub === 'show') {
      const { pack, files, errors } = loadKnowledge(knowledgeDirs(v.knowledge ?? []));
      for (const e of errors) io.err(`skipped: ${e}`);
      if (v.json) io.out(JSON.stringify({ files, pack }, null, 2));
      else io.out(files.length ? `${describePack(pack)}\n  from ${files.length} pack(s): ${files.join(', ')}` : 'No knowledge packs yet (knowledge/ in the package, ~/.firelab/knowledge).');
      return 0;
    }
    if (sub === 'merge') {
      if (!rest.length || !v.out) throw new Error('Usage: firelab learn merge <pack.json>... --out <file>');
      const pack = mergeFiles(rest);
      const file = writePack(pack, v.out);
      io.out(describePack(pack));
      io.err(`Merged: ${file}`);
      return 0;
    }
    throw new Error(`Unknown learn command "${sub}" (export, show, merge)`);
  } catch (e) {
    io.err(`Error: ${errorMessage(e)}`);
    return 1;
  }
}
