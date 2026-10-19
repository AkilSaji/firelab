import type { Adb } from './client.js';
import { FireLabError } from '../lib/errors.js';
import { sleep } from '../lib/util.js';
import { splitSections } from './getprop.js';

export type AppInfo = {
  package: string;
  label?: string;
  version?: string;
  versionCode?: number;
  /** Has a launcher entry (TV or phone launcher); false for overlays and services. */
  launchable?: boolean;
  updatedAt?: string;
};

const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

/** Validates an Android package name (also keeps shell metacharacters out of commands). */
export function assertPackage(pkg: unknown): string {
  if (typeof pkg !== 'string' || !PKG_RE.test(pkg)) {
    throw new FireLabError('bad-request', `"${String(pkg)}" is not an Android package name`, { hint: 'Package names look like com.example.game; list them with list_apps' });
  }
  return pkg;
}

export const LIST_APPS_SCRIPT = [
  'pm list packages -3 --show-versioncode 2>/dev/null || pm list packages -3',
  'echo @@versions',
  "dumpsys package packages 2>/dev/null | grep -E '^  Package \\[|^    versionName=|^    lastUpdateTime='",
  'echo @@leanback',
  'cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER 2>/dev/null',
  'echo @@launcher',
  'cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER 2>/dev/null',
].join('; ');

/** Packages from `pm list packages [-3] [--show-versioncode]`. */
export function parsePackageList(text: string): { package: string; versionCode?: number }[] {
  const out: { package: string; versionCode?: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^package:(\S+?)(?:\s+versionCode:(\d+))?\s*$/.exec(line.trim());
    if (m) out.push(m[2] ? { package: m[1] as string, versionCode: Number(m[2]) } : { package: m[1] as string });
  }
  return out;
}

/** `dumpsys package packages` filtered to Package / versionName / lastUpdateTime lines. */
export function parsePackageVersions(text: string): Map<string, { version?: string; updatedAt?: string }> {
  const out = new Map<string, { version?: string; updatedAt?: string }>();
  let cur: { version?: string; updatedAt?: string } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const p = /^\s*Package \[([^\]]+)\]/.exec(line);
    if (p) {
      cur = {};
      out.set(p[1] as string, cur);
      continue;
    }
    if (!cur) continue;
    const v = /^\s*versionName=(.*)$/.exec(line);
    if (v && cur.version === undefined) {
      const val = (v[1] as string).trim();
      cur.version = val && val !== 'null' ? val : undefined;
    }
    const u = /^\s*lastUpdateTime=(.*)$/.exec(line);
    if (u && cur.updatedAt === undefined) cur.updatedAt = (u[1] as string).trim();
  }
  return out;
}

/** Component names ("pkg/.Activity") from `cmd package query-activities --brief` or `resolve-activity --brief`. */
export function parseComponents(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(l));
}

export function parseListApps(output: string): AppInfo[] {
  const s = splitSections(output);
  const versions = parsePackageVersions(s.versions ?? '');
  const launchablePkgs = new Set([...parseComponents(s.leanback ?? ''), ...parseComponents(s.launcher ?? '')].map((c) => c.split('/')[0]));
  const haveLauncherInfo = launchablePkgs.size > 0;
  return parsePackageList(s._ ?? '')
    .map((p) => {
      const v = versions.get(p.package);
      const app: AppInfo = { package: p.package };
      if (v?.version) app.version = v.version;
      if (p.versionCode !== undefined) app.versionCode = p.versionCode;
      if (haveLauncherInfo) app.launchable = launchablePkgs.has(p.package);
      if (v?.updatedAt) app.updatedAt = v.updatedAt;
      return app;
    })
    .sort((a, b) => Number(b.launchable ?? 0) - Number(a.launchable ?? 0) || a.package.localeCompare(b.package));
}

/** Third-party apps (what people installed), launchable ones first. */
export async function listApps(adb: Adb, serial: string): Promise<AppInfo[]> {
  return parseListApps(await adb.shell(serial, LIST_APPS_SCRIPT, { timeoutMs: 20000 }));
}

/** The activity a TV launcher would open: Leanback first, then the phone launcher. */
export async function resolveLaunchActivity(adb: Adb, serial: string, pkg: string): Promise<string | null> {
  assertPackage(pkg);
  for (const cat of ['LEANBACK_LAUNCHER', 'LAUNCHER']) {
    const out = await adb.shell(serial, `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.${cat} ${pkg} 2>/dev/null`);
    const comp = parseComponents(out).pop();
    if (comp) return comp;
  }
  // Fire OS 5 (Android 5.1) has no `cmd package`: read the resolver table.
  const dump = await adb.shell(serial, `dumpsys package ${pkg}`);
  return parseMainActivity(dump, pkg);
}

/** Finds a MAIN activity in `dumpsys package <pkg>` (fallback for old Android). */
export function parseMainActivity(dump: string, pkg: string): string | null {
  const lines = dump.split(/\r?\n/);
  const start = lines.findIndex((l) => /android\.intent\.action\.MAIN:/.test(l));
  if (start < 0) return null;
  for (let i = start + 1; i < Math.min(lines.length, start + 12); i++) {
    const m = new RegExp(`\\s(${pkg.replace(/\./g, '\\.')}/[A-Za-z0-9_.$]+)`).exec(lines[i] as string);
    if (m) return m[1] as string;
  }
  return null;
}

export async function pidOf(adb: Adb, serial: string, pkg: string): Promise<number | null> {
  assertPackage(pkg);
  const out = await adb.shell(serial, `pidof ${pkg} 2>/dev/null || ps | grep -E ' ${pkg}$' | awk '{print $2}'`);
  const pid = Number(out.trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export type LaunchResult = { ok: true; package: string; activity: string; pid?: number; launchMs?: number; launchState?: string };

/** Quotes a value for the device shell. */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Starts an app on its launcher activity. With `url`, the intent carries it
 * both as data (-d) and as a string extra named "url" (most WebView wrappers
 * read one of the two). `am start -W` reports the launch time.
 */
export async function launchApp(
  adb: Adb,
  serial: string,
  pkg: string,
  opts: { url?: string; activity?: string; extras?: Record<string, string>; waitForPidMs?: number } = {},
): Promise<LaunchResult> {
  assertPackage(pkg);
  const activity = opts.activity ?? (await resolveLaunchActivity(adb, serial, pkg));
  if (!activity) {
    throw new FireLabError('not-found', `${pkg} has no launcher activity`, { hint: 'Is it installed? Check list_apps; services and overlays can\'t be launched' });
  }
  const args = ['am start -W', `-n ${shQuote(activity)}`];
  if (opts.url) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(opts.url)) throw new FireLabError('bad-request', `"${opts.url}" is not a URL`);
    args.push('-a android.intent.action.VIEW', `-d ${shQuote(opts.url)}`, `--es url ${shQuote(opts.url)}`);
  }
  for (const [k, v] of Object.entries(opts.extras ?? {})) {
    if (!/^[A-Za-z0-9_.]+$/.test(k)) throw new FireLabError('bad-request', `Bad intent extra name "${k}"`);
    args.push(`--es ${k} ${shQuote(v)}`);
  }
  const out = await adb.shell(serial, args.join(' '), { timeoutMs: 30000 });
  if (/Error:|Exception|does not exist/i.test(out) && !/Status: ok/i.test(out)) {
    throw new FireLabError('adb-failed', `Couldn't start ${activity}: ${out.trim().split('\n').find((l) => /Error|Exception/.test(l)) ?? out.trim()}`);
  }
  const res: LaunchResult = { ok: true, package: pkg, activity };
  const total = /TotalTime:\s*(\d+)/.exec(out) ?? /WaitTime:\s*(\d+)/.exec(out);
  if (total) res.launchMs = Number(total[1]);
  const state = /LaunchState:\s*(\w+)/.exec(out);
  if (state) res.launchState = state[1];
  const until = Date.now() + (opts.waitForPidMs ?? 8000);
  while (Date.now() < until) {
    const pid = await pidOf(adb, serial, pkg);
    if (pid) {
      res.pid = pid;
      break;
    }
    await sleep(300);
  }
  return res;
}

/** Force-stops an app (like swiping it away): its process ends, its data stays. */
export async function stopApp(adb: Adb, serial: string, pkg: string): Promise<void> {
  assertPackage(pkg);
  await adb.shell(serial, `am force-stop ${pkg}`, { timeoutMs: 10000 });
}

/** Deletes all of an app's data (`pm clear`): the next launch is a true first run. */
export async function resetApp(adb: Adb, serial: string, pkg: string, confirm: boolean): Promise<void> {
  assertPackage(pkg);
  if (confirm !== true) {
    throw new FireLabError('confirm-required', `Resetting ${pkg} deletes all of its data (saves, logins, settings)`, { hint: 'Pass confirm: true if that is what you want' });
  }
  const out = await adb.shell(serial, `pm clear ${pkg}`, { timeoutMs: 20000 });
  if (!/Success/i.test(out)) throw new FireLabError('adb-failed', `pm clear ${pkg} failed: ${out.trim() || 'no output'}`);
}

/** "pkg/.Activity" from dumpsys activity/window output (Android 5 through 14 formats). */
export function parseForeground(text: string): { package: string; activity?: string } | null {
  const pats = [
    /topResumedActivity=ActivityRecord\{[^}]*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/,
    /mResumedActivity: ActivityRecord\{[^}]*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/,
    /ResumedActivity: ActivityRecord\{[^}]*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/,
    /mFocusedApp=(?:AppWindowToken\{[^}]*token=Token\{[^}]*ActivityRecord\{|ActivityRecord\{)[^}]*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/,
    /mCurrentFocus=Window\{[^}]*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)\}/,
  ];
  for (const re of pats) {
    const m = re.exec(text);
    if (m) {
      const pkg = m[1] as string;
      const act = m[2] as string;
      return { package: pkg, activity: act.startsWith('.') ? `${pkg}${act}` : act };
    }
  }
  return null;
}

export async function foregroundApp(adb: Adb, serial: string): Promise<{ package: string; activity?: string } | null> {
  const out = await adb.shell(serial, "dumpsys activity activities | grep -E 'ResumedActivity|mFocusedApp' ; dumpsys window | grep -E 'mCurrentFocus'", { timeoutMs: 10000 });
  return parseForeground(out);
}
