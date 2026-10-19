import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as api from '../index.js';
import * as chips from '../chips.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('index.d.ts declares every runtime export, and nothing more', () => {
  const declared = new Set([...read('index.d.ts').matchAll(/^export (?:declare )?(?:function|const) (\w+)/gm)].map((m) => m[1]));
  assert.deepEqual([...declared].sort(), Object.keys(api).sort());
});

test('chips.d.ts matches the chips entry point', () => {
  const block = /export \{([^}]*)\} from '\.\/index\.js';/.exec(read('chips.d.ts'))[1];
  const declared = block.split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(declared.sort(), Object.keys(chips).sort());
});

test('package.json points at files that exist', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, '@firelab/perf');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, 'MIT');
  for (const entry of Object.values(pkg.exports)) {
    for (const file of typeof entry === 'string' ? [entry] : Object.values(entry)) assert.doesNotThrow(() => read(file), file);
  }
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
});
