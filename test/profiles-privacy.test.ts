import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Community profiles describe a model, never someone's device or home (profiles/README.md).
const dir = path.join(import.meta.dirname, '..', 'profiles');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'schema.json');

const FORBIDDEN_KEYS = /^(serial|serialno|ro\.serialno|androidid|android_id|mac|macaddress|wifimac|bssid|ssid|wifi|ip|ipaddress|account|accounts|email|user|username|owner|packages|installedapps)$/i;
const PATTERNS: [string, RegExp][] = [
  // Home-network addresses and anything with a port (Fire OS versions like 8.1.8.2 look like IPs too).
  ['a local IP address', /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b|\b(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}\b/],
  ['a MAC address', /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i],
  ['an email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
  ['a Fire TV serial number', /\bG[0-9A-Z]{3}[0-9A-Z]{12}\b/],
];

function walk(v: unknown, at: string, out: { path: string; key?: string; value?: string }[]): void {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`, out));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.push({ path: `${at}.${k}`, key: k });
      walk(x, `${at}.${k}`, out);
    }
  else if (typeof v === 'string') out.push({ path: at, value: v });
}

describe('profiles/ contain no personal data', () => {
  it('has profiles to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const f of files) {
    it(f, () => {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { model?: string };
      expect(`${p.model}.json`, 'the file name must be the model code').toBe(f);
      const items: { path: string; key?: string; value?: string }[] = [];
      walk(p, '$', items);
      for (const it of items) {
        if (it.key) expect(FORBIDDEN_KEYS.test(it.key), `${f} ${it.path}: personal field`).toBe(false);
        if (it.value && it.path !== '$.$schema')
          for (const [what, re] of PATTERNS) expect(re.test(it.value), `${f} ${it.path} looks like ${what}: "${it.value}"`).toBe(false);
      }
    });
  }
});
