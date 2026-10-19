import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Where FireLab keeps sessions, thumbnails and sweep results: $FIRELAB_HOME or ~/.firelab. */
export function dataDir(): string {
  return process.env.FIRELAB_HOME || path.join(os.homedir(), '.firelab');
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The package root (the folder holding package.json), from dist/ or src/. */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

let cachedVersion: string | undefined;
export function firelabVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { version?: string };
    cachedVersion = pkg.version ?? '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}
