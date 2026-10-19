#!/usr/bin/env node
// Regenerates profiles/schema.json from src/profile/schema.ts (PROFILE_SCHEMA).
// Run after changing the schema:  npm run build && node scripts/fit/gen-profile-schema.mjs
// test/profile-schema.test.ts fails when the two drift apart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE_SCHEMA, validateProfile } from '../../dist/profile/schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = path.join(root, 'profiles');
fs.writeFileSync(path.join(dir, 'schema.json'), `${JSON.stringify(PROFILE_SCHEMA, null, 2)}\n`);
let bad = 0;
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'schema.json')) {
  const errs = validateProfile(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  if (errs.length) {
    bad++;
    console.error(`${f}:\n${errs.map((e) => `  ${e.path} ${e.message}`).join('\n')}`);
  }
}
console.log(`profiles/schema.json written; ${bad ? `${bad} invalid profile(s)` : 'all profiles valid'}.`);
process.exitCode = bad ? 1 : 0;
