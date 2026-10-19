import type { Adb } from '../adb/client.js';
import { assertPackage } from '../adb/apps.js';
import { splitSections } from '../adb/getprop.js';
import { parseCpuTotals, parseMeminfo, parseProcMeminfo, parseProcStatTicks, parseRendererPid } from './parse.js';
import { round1 } from '../lib/util.js';

export type NativeSample = {
  ts: number;
  appPid?: number;
  rendererPid?: number;
  /** App + WebView renderer PSS, MB: what the app costs the device. */
  memMB?: number;
  appPssMB?: number;
  rendererPssMB?: number;
  graphicsMB?: number;
  /** App + renderer CPU, % of one core (like `top`: 4 busy cores = 400%). */
  cpuPct?: number;
  /** Whole device CPU use, % of all cores. */
  deviceCpuPct?: number;
  memAvailableMB?: number;
};

const USER_HZ = 100;
const mb = (kb?: number) => (kb === undefined ? undefined : round1(kb / 1024));

/**
 * Samples an app's memory and CPU over adb in one shell round trip.
 * WebView apps run their page in a separate sandboxed renderer process; it is
 * found once per app pid and counted too.
 */
export class NativeSampler {
  private prev?: { up: number; app?: number; ren?: number; appPid?: number; renPid?: number; busy: number; total: number };
  private rendererFor?: { appPid: number; renPid: number | null };

  constructor(
    private readonly adb: Adb,
    private readonly serial: string,
    readonly pkg: string,
  ) {
    assertPackage(pkg);
  }

  private async rendererPid(appPid: number): Promise<number | null> {
    if (this.rendererFor?.appPid === appPid && this.rendererFor.renPid !== null) return this.rendererFor.renPid;
    const out = await this.adb.shell(this.serial, `stat -c %u /proc/${appPid} 2>/dev/null; echo @@procs; dumpsys activity processes | grep -E 'ProcessRecord\\{[0-9a-f]+ [0-9]+:[^ ]*sandboxed_process'`, { timeoutMs: 10000 });
    const s = splitSections(out);
    const uid = Number((s._ ?? '').trim());
    const renPid = Number.isFinite(uid) && uid > 0 ? parseRendererPid(s.procs ?? '', uid) : null;
    this.rendererFor = { appPid, renPid };
    return renPid;
  }

  /** One sample. `memory: false` skips dumpsys meminfo (the costly part, ~0.4 s of device CPU per process). */
  async sample(opts: { memory?: boolean } = {}): Promise<NativeSample> {
    const ts = Date.now();
    const pidOut = await this.adb.shell(this.serial, `pidof ${this.pkg}`, { timeoutMs: 8000 });
    const appPid = Number(pidOut.trim().split(/\s+/)[0]) || undefined;
    if (!appPid) {
      this.prev = undefined;
      return { ts };
    }
    const renPid = (await this.rendererPid(appPid)) ?? undefined;
    const memory = opts.memory !== false;
    const script = [
      'cat /proc/uptime',
      'echo @@stat; head -1 /proc/stat',
      `echo @@app; cat /proc/${appPid}/stat 2>/dev/null`,
      renPid ? `echo @@ren; cat /proc/${renPid}/stat 2>/dev/null` : '',
      'echo @@meminfo; grep -E "^(MemTotal|MemAvailable):" /proc/meminfo',
      memory ? `echo @@appmem; dumpsys meminfo ${appPid} | grep -E "TOTAL|Graphics:|GL mtrack"` : '',
      memory && renPid ? `echo @@renmem; dumpsys meminfo ${renPid} | grep -E "TOTAL"` : '',
    ]
      .filter(Boolean)
      .join('; ');
    const out = await this.adb.shell(this.serial, script, { timeoutMs: 15000 });
    return this.parse(out, ts, appPid, renPid);
  }

  /** Turns the script output into a sample (exposed for tests). */
  parse(out: string, ts: number, appPid: number, renPid?: number): NativeSample {
    const s = splitSections(out);
    const up = Number((s._ ?? '').trim().split(/\s+/)[0]);
    const cpu = parseCpuTotals((s.stat ?? '').trim());
    const app = parseProcStatTicks((s.app ?? '').trim());
    const ren = renPid ? parseProcStatTicks((s.ren ?? '').trim()) : null;
    const mi = parseProcMeminfo(s.meminfo ?? '');
    const sample: NativeSample = { ts, appPid };
    if (renPid && ren) sample.rendererPid = renPid;
    if (mi.MemAvailable !== undefined) sample.memAvailableMB = mb(mi.MemAvailable);
    if (s.appmem !== undefined) {
      const a = parseMeminfo(s.appmem);
      sample.appPssMB = mb(a.pssKB);
      sample.graphicsMB = mb(a.graphicsKB ?? a.glMtrackKB);
      if (s.renmem !== undefined) sample.rendererPssMB = mb(parseMeminfo(s.renmem).pssKB);
      if (sample.appPssMB !== undefined) sample.memMB = round1(sample.appPssMB + (sample.rendererPssMB ?? 0));
    }
    const cur = { up, app: app?.ticks, ren: ren?.ticks, appPid, renPid, busy: cpu?.busy ?? 0, total: cpu?.total ?? 0 };
    const p = this.prev;
    if (p && up > p.up && p.appPid === appPid) {
      const secs = up - p.up;
      let ticks = 0;
      let have = false;
      if (cur.app !== undefined && p.app !== undefined && cur.app >= p.app) {
        ticks += cur.app - p.app;
        have = true;
      }
      if (renPid && p.renPid === renPid && cur.ren !== undefined && p.ren !== undefined && cur.ren >= p.ren) ticks += cur.ren - p.ren;
      if (have) sample.cpuPct = round1((ticks / USER_HZ / secs) * 100);
      if (cur.total > p.total) sample.deviceCpuPct = round1(((cur.busy - p.busy) / (cur.total - p.total)) * 100);
    }
    this.prev = cur;
    return sample;
  }
}
