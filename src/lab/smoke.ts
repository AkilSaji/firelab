/**
 * Smoke checks for an app on a lab emulator (or any adb device): installs,
 * launches, still running after a few seconds, a screenshot that isn't
 * black, no crash or ANR in logcat, and memory inside the real model's
 * budget. Runs through FireLab's normal device layer.
 */
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import type { FireLab } from '../core/firelab.js';
import { pidOf } from '../adb/apps.js';
import { sleep } from '../lib/util.js';
import { FireLabError, errorMessage } from '../lib/errors.js';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type SmokeCheck = { id: string; title: string; status: CheckStatus; detail: string; value?: number };

export type LogProblem = { kind: 'crash' | 'anr' | 'native-crash' | 'died' | 'renderer-crash'; line: string };

/**
 * Finds crashes and ANRs of one package in `logcat -v threadtime` text.
 * "FATAL EXCEPTION" counts only when the following "Process:" line names
 * the package.
 */
export function scanLogcat(text: string, pkg: string): LogProblem[] {
  const out: LogProblem[] = [];
  const lines = text.split(/\r?\n/);
  const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const proc = new RegExp(`Process: ${esc}(:[\\w.]+)?, PID`);
  const anr = new RegExp(`ANR in ${esc}(:[\\w.]+)?(\\s|$)`);
  const tomb = new RegExp(`>>> ${esc}(:[\\w.]+)? <<<`);
  const died = new RegExp(`Process ${esc}(:[\\w.]+)? \\(pid \\d+\\) has died`);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (/FATAL EXCEPTION/.test(l)) {
      const next = lines.slice(i + 1, i + 4).find((x) => proc.test(x));
      if (next) out.push({ kind: 'crash', line: `${l.trim()} | ${next.trim()}` });
    } else if (anr.test(l)) out.push({ kind: 'anr', line: l.trim() });
    else if (tomb.test(l)) out.push({ kind: 'native-crash', line: l.trim() });
    else if (died.test(l)) out.push({ kind: 'died', line: l.trim() });
    else if (/Renderer process \(?\d*\)? ?crash|render process .*(crash|gone)/i.test(l)) out.push({ kind: 'renderer-crash', line: l.trim() });
  }
  return out;
}

/** Mean luma (0-255) and its spread over a decoded RGBA image. */
export function lumaStats(rgba: Uint8Array, width: number, height: number): { mean: number; stdev: number } {
  let sum = 0;
  let sq = 0;
  let n = 0;
  const step = Math.max(1, Math.floor((width * height) / 20000));
  for (let p = 0; p < width * height; p += step) {
    const i = p * 4;
    const y = 0.299 * (rgba[i] ?? 0) + 0.587 * (rgba[i + 1] ?? 0) + 0.114 * (rgba[i + 2] ?? 0);
    sum += y;
    sq += y * y;
    n++;
  }
  const mean = sum / n;
  return { mean, stdev: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

export function screenVerdict(s: { mean: number; stdev: number }): { status: CheckStatus; detail: string } {
  if (s.mean < 8 && s.stdev < 4) return { status: 'warn', detail: `the screen is black (mean luma ${s.mean.toFixed(1)})` };
  if (s.stdev < 2) return { status: 'warn', detail: `the screen is one flat colour (luma ${s.mean.toFixed(0)})` };
  return { status: 'pass', detail: `content on screen (luma ${s.mean.toFixed(0)} ± ${s.stdev.toFixed(0)})` };
}

export function memoryVerdict(memMB: number | undefined, budgetMB?: number, limitMB?: number): { status: CheckStatus; detail: string } {
  if (memMB === undefined) return { status: 'skip', detail: 'no memory reading' };
  const vs = [budgetMB !== undefined ? `budget ${budgetMB} MB` : '', limitMB !== undefined ? `limit ${limitMB} MB` : ''].filter(Boolean).join(', ');
  if (limitMB !== undefined && memMB > limitMB) return { status: 'fail', detail: `${memMB} MB is over the real device's hard limit (${vs}): it would be killed` };
  if (budgetMB !== undefined && memMB > budgetMB) return { status: 'warn', detail: `${memMB} MB is over the comfortable budget (${vs})` };
  return { status: 'pass', detail: `${memMB} MB${vs ? ` (${vs})` : ''}` };
}

export function launchVerdict(ms: number | undefined, maxMs: number, strict: boolean): { status: CheckStatus; detail: string } {
  if (ms === undefined) return { status: 'warn', detail: 'am start -W did not report a launch time' };
  if (ms > maxMs) return { status: strict ? 'fail' : 'warn', detail: `${ms} ms (over ${maxMs} ms)` };
  return { status: 'pass', detail: `${ms} ms` };
}

export function overall(checks: SmokeCheck[]): 'pass' | 'fail' {
  return checks.some((c) => c.status === 'fail') ? 'fail' : 'pass';
}

export type SmokeOptions = {
  device?: string;
  apk?: string;
  package?: string;
  url?: string;
  outDir: string;
  /** Seconds to let the app run before the screenshot, logcat and memory checks. */
  settleS?: number;
  maxLaunchMs?: number;
  /** --max-launch-ms was given: over it fails instead of warning. */
  strictLaunch?: boolean;
  budgetMB?: number;
  limitMB?: number;
  model?: string;
  onStep?: (s: string) => void;
};

export type SmokeResult = {
  ok: boolean;
  verdict: 'pass' | 'fail';
  device: string;
  package?: string;
  model?: string;
  checks: SmokeCheck[];
  problems: LogProblem[];
  screenshot?: string;
  logcat?: string;
  notes: string[];
};

export async function runSmoke(lab: FireLab, o: SmokeOptions): Promise<SmokeResult> {
  const checks: SmokeCheck[] = [];
  const notes: string[] = [];
  const step = o.onStep ?? (() => {});
  fs.mkdirSync(o.outDir, { recursive: true });
  const serial = await lab.resolveDevice(o.device);
  const sh = (cmd: string, timeoutMs = 30000) => lab.adb.shell(serial, cmd, { timeoutMs });
  let pkg = o.package;
  const result: SmokeResult = { ok: false, verdict: 'fail', device: serial, ...(o.model ? { model: o.model } : {}), checks, problems: [], notes };

  if (o.apk) {
    step(`Installing ${path.basename(o.apk)}`);
    try {
      const r = await lab.install(serial, o.apk);
      pkg = r.package;
      checks.push({ id: 'install', title: 'Installs', status: 'pass', detail: `${r.package}${r.versionName ? ` ${r.versionName}` : ''}${r.leanback ? '' : ' (no Leanback launcher entry: Fire TV home screen will not show it)'}` });
      for (const w of r.warnings) notes.push(w);
    } catch (e) {
      const msg = errorMessage(e);
      // A hung install usually means a dialog on the device is waiting for a
      // click: say which window has focus and keep a screenshot of it.
      if (e instanceof FireLabError && e.code === 'timeout') {
        const focus = await sh('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"', 15000).catch(() => '');
        if (focus.trim()) notes.push(`While the install hung, the device showed: ${focus.trim().replace(/\s+/g, ' ')}`);
        try {
          const shot = await lab.screenshot(serial, { format: 'jpeg', width: 1920, quality: 85 });
          const file = path.join(o.outDir, 'screenshot.jpg');
          fs.writeFileSync(file, shot.data);
          result.screenshot = file;
        } catch {
          /* no screenshot either: the device itself is stuck */
        }
      }
      checks.push({
        id: 'install',
        title: 'Installs',
        status: 'fail',
        detail: /NO_MATCHING_ABIS/.test(msg) ? `${msg}. The APK has native code for ABIs this emulator can't run; see docs/LAB.md (ARM apps on emulators).` : msg,
      });
      return finish();
    }
  }
  if (!pkg) throw new Error('Give --apk <file.apk> or --package <id>');

  await sh('logcat -c').catch(() => '');
  step(`Launching ${pkg}`);
  let launchMs: number | undefined;
  try {
    await lab.stop(serial, pkg).catch(() => undefined);
    const r = await lab.launch(serial, pkg, o.url ? { url: o.url } : {});
    launchMs = r.launchMs;
    checks.push({ id: 'launch', title: 'Launches', status: 'pass', detail: r.activity });
  } catch (e) {
    checks.push({ id: 'launch', title: 'Launches', status: 'fail', detail: errorMessage(e) });
    return finish();
  }
  const lv = launchVerdict(launchMs, o.maxLaunchMs ?? 5000, !!o.strictLaunch);
  checks.push({ id: 'launch-time', title: 'Launch time', ...lv, ...(launchMs !== undefined ? { value: launchMs } : {}) });

  const settle = o.settleS ?? 10;
  step(`Letting it run for ${settle} s`);
  await sleep(settle * 1000);
  const pid = await pidOf(lab.adb, serial, pkg).catch(() => null);
  checks.push({ id: 'running', title: `Still running after ${settle} s`, status: pid ? 'pass' : 'fail', detail: pid ? `pid ${pid}` : 'the process is gone' });

  step('Screenshot');
  try {
    const shot = await lab.screenshot(serial, { format: 'jpeg', width: 1920, quality: 85 });
    const file = path.join(o.outDir, 'screenshot.jpg');
    fs.writeFileSync(file, shot.data);
    const img = jpeg.decode(shot.data, { useTArray: true });
    const v = screenVerdict(lumaStats(img.data, img.width, img.height));
    checks.push({ id: 'screen', title: 'Screen shows something', ...v });
    result.screenshot = file;
  } catch (e) {
    checks.push({ id: 'screen', title: 'Screen shows something', status: 'warn', detail: `screenshot failed: ${errorMessage(e)}` });
  }

  if (pid) {
    step('Memory');
    try {
      const m = await lab.measure(serial, { package: pkg, seconds: 3 });
      const v = memoryVerdict(m.memMB, o.budgetMB, o.limitMB);
      checks.push({ id: 'memory', title: `Memory vs the ${o.model ?? 'model'}'s budget`, ...v, ...(m.memMB !== undefined ? { value: m.memMB } : {}) });
    } catch (e) {
      checks.push({ id: 'memory', title: 'Memory', status: 'warn', detail: errorMessage(e) });
    }
  }

  step('Logcat');
  const log = await sh('logcat -d -v threadtime -b main -b system -b crash', 60000).catch(() => '');
  const logFile = path.join(o.outDir, 'logcat.txt');
  fs.writeFileSync(logFile, log);
  result.logcat = logFile;
  const problems = scanLogcat(log, pkg);
  result.problems = problems;
  const bad = problems.filter((p) => p.kind !== 'died' || !pid);
  checks.push({
    id: 'logcat',
    title: 'No crash or ANR in logcat',
    status: bad.length ? 'fail' : 'pass',
    detail: bad.length ? bad.map((p) => `${p.kind}: ${p.line.slice(0, 200)}`).join('\n') : 'clean',
  });
  return finish();

  function finish(): SmokeResult {
    result.checks = checks;
    result.verdict = overall(checks);
    result.ok = result.verdict === 'pass';
    if (pkg) result.package = pkg;
    return result;
  }
}
