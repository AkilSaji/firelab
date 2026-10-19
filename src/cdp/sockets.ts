import type { Adb } from '../adb/client.js';

export type DevtoolsSocket = {
  /** Abstract socket name without the "@", e.g. "webview_devtools_remote_13059". */
  name: string;
  kind: 'webview' | 'chrome' | 'other';
  pid?: number;
  /** The owning package when known. */
  package?: string;
};

/** Finds DevTools sockets in /proc/net/unix output. */
export function parseDevtoolsSockets(procNetUnix: string): DevtoolsSocket[] {
  const seen = new Set<string>();
  const out: DevtoolsSocket[] = [];
  for (const line of procNetUnix.split(/\r?\n/)) {
    const m = /@([\w.]*devtools_remote(?:_\d+)?)\s*$/.exec(line.trim());
    if (!m || seen.has(m[1] as string)) continue;
    const name = m[1] as string;
    seen.add(name);
    const wv = /^webview_devtools_remote_(\d+)$/.exec(name);
    if (wv) out.push({ name, kind: 'webview', pid: Number(wv[1]) });
    else if (name === 'chrome_devtools_remote') out.push({ name, kind: 'chrome', package: 'com.android.chrome' });
    else {
      const pidM = /_(\d+)$/.exec(name);
      const pkgM = /^([\w.]+)_devtools_remote$/.exec(name);
      const s: DevtoolsSocket = { name, kind: 'other' };
      if (pidM) s.pid = Number(pidM[1]);
      if (pkgM) s.package = pkgM[1];
      out.push(s);
    }
  }
  return out;
}

/** "PID NAME" lines from `ps -A -o PID,NAME` -> map pid -> process name. */
export function parsePsNames(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), m[2] as string);
  }
  return out;
}

export async function listDevtoolsSockets(adb: Adb, serial: string): Promise<DevtoolsSocket[]> {
  const out = await adb.shell(serial, "grep -a devtools_remote /proc/net/unix; echo @@ps; ps -A -o PID,NAME 2>/dev/null || ps -o PID,NAME", { timeoutMs: 10000 });
  const [unix, ps = ''] = out.split('@@ps');
  const sockets = parseDevtoolsSockets(unix ?? '');
  const names = parsePsNames(ps);
  for (const s of sockets) {
    if (s.pid && !s.package) {
      const n = names.get(s.pid);
      if (n) s.package = n.split(':')[0];
    }
  }
  return sockets;
}
