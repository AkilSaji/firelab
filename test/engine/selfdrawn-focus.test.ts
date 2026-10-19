import { expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { explore } from '../../src/engine/index.js';
import { SimGame, PKG } from './sim-app.js';

test('a game that draws its own highlight gets no false "unreachable" findings, and a note says why', async () => {
  const sim = new SimGame(['selfdrawn']);
  const r = await explore({ driver: sim.driver as never, clock: sim.clock, package: PKG, minutes: 4, minimize: false, out: fs.mkdtempSync(path.join(os.tmpdir(), 'fl-self-')) });
  expect(r.findings.filter((f) => f.oracle === 'focus' && f.kind !== 'focus-lost')).toEqual([]);
  expect(r.notes.join('\n')).toMatch(/draws its own highlight/);
});
