/** Parsers for Android's performance dumps. All sizes in KB unless named MB. */

export type MeminfoSummary = {
  pssKB?: number;
  rssKB?: number;
  swapPssKB?: number;
  javaHeapKB?: number;
  nativeHeapKB?: number;
  codeKB?: number;
  graphicsKB?: number;
  privateOtherKB?: number;
  systemKB?: number;
  /** "GL mtrack" row (GPU memory attributed to the process) when present. */
  glMtrackKB?: number;
};

const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
};

/**
 * `dumpsys meminfo <pkg|pid>`: reads the App Summary ("TOTAL PSS: 266411",
 * Android 10+) or the TOTAL table row (older), plus summary categories.
 */
export function parseMeminfo(text: string): MeminfoSummary {
  const out: MeminfoSummary = {};
  const totalPss = /TOTAL PSS:\s*([\d,]+)/.exec(text) ?? /^\s*TOTAL:\s+([\d,]+)/m.exec(text);
  if (totalPss) out.pssKB = num(totalPss[1]);
  else {
    const row = /^\s*TOTAL\s+([\d,]+)/m.exec(text);
    if (row) out.pssKB = num(row[1]);
  }
  const rss = /TOTAL RSS:\s*([\d,]+)/.exec(text);
  if (rss) out.rssKB = num(rss[1]);
  const swap = /TOTAL SWAP(?: PSS)?(?: \(KB\))?:\s*([\d,]+)/.exec(text);
  if (swap) out.swapPssKB = num(swap[1]);
  const cat = (label: string) => num(new RegExp(`^\\s*${label}:\\s+([\\d,]+)`, 'm').exec(text)?.[1]);
  out.javaHeapKB = cat('Java Heap');
  out.nativeHeapKB = cat('Native Heap');
  out.codeKB = cat('Code');
  out.graphicsKB = cat('Graphics');
  out.privateOtherKB = cat('Private Other');
  out.systemKB = cat('System');
  const gl = /^\s*GL mtrack\s+([\d,]+)/m.exec(text);
  if (gl) out.glMtrackKB = num(gl[1]);
  for (const k of Object.keys(out) as (keyof MeminfoSummary)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** /proc/meminfo -> { MemTotal: kB, MemAvailable: kB, ... } */
export function parseProcMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line.trim());
    if (m) out[m[1] as string] = Number(m[2]);
  }
  return out;
}

/** utime + stime (clock ticks) from a /proc/<pid>/stat line; the name may contain spaces and parens. */
export function parseProcStatTicks(line: string): { pid: number; name: string; ticks: number; startTime: number } | null {
  const open = line.indexOf('(');
  const close = line.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(line.slice(0, open).trim());
  const rest = line.slice(close + 2).trim().split(/\s+/);
  // rest[0] = state (field 3); utime = field 14 -> rest[11], stime = rest[12], starttime = field 22 -> rest[19]
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { pid, name: line.slice(open + 1, close), ticks: utime + stime, startTime: Number(rest[19]) };
}

/** First line of /proc/stat -> busy and total jiffies over all CPUs. */
export function parseCpuTotals(line: string): { busy: number; total: number } | null {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== 'cpu') return null;
  const v = parts.slice(1).map(Number);
  const total = v.reduce((a, b) => a + b, 0);
  const idle = (v[3] ?? 0) + (v[4] ?? 0);
  return { busy: total - idle, total };
}

export type TopProcess = { pid: number; user: string; cpu: number; mem?: number; res?: string; state?: string; name: string };

/**
 * `top -b -n 1` (toybox, Android 8+): finds the header row, then reads
 * PID, USER, %CPU, %MEM and the command for each process.
 */
export function parseTop(text: string): { cpuCores?: number; processes: TopProcess[] } {
  const lines = text.split(/\r?\n/);
  const hi = lines.findIndex((l) => /\bPID\b/.test(l) && /CPU/.test(l));
  if (hi < 0) return { processes: [] };
  // toybox marks the sort column with brackets glued to the previous name: "S[%CPU]".
  const header = (lines[hi] as string).replace(/(\S)\[/g, '$1 [').trim().split(/\s+/).map((h) => h.replace(/[[\]]/g, ''));
  const col = (n: RegExp) => header.findIndex((h) => n.test(h));
  const iPid = col(/^PID$/);
  const iUser = col(/^USER$/);
  const iCpu = col(/^%?CPU%?$/);
  const iMem = col(/^%?MEM%?$/);
  const iRes = col(/^RES$|^RSS$/);
  const iS = col(/^S$/);
  const iName = Math.max(col(/^ARGS$/), col(/^NAME$/), col(/^CMD$/), col(/^COMMAND$/));
  const processes: TopProcess[] = [];
  for (const raw of lines.slice(hi + 1)) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < header.length - 1 || !/^\d+$/.test(parts[iPid] ?? '')) continue;
    const name = iName >= 0 ? parts.slice(iName).join(' ') : (parts[parts.length - 1] ?? '');
    const p: TopProcess = { pid: Number(parts[iPid]), user: parts[iUser] ?? '', cpu: Number((parts[iCpu] ?? '0').replace('%', '')), name };
    if (iMem >= 0) p.mem = Number((parts[iMem] ?? '').replace('%', ''));
    if (iRes >= 0) p.res = parts[iRes];
    if (iS >= 0) p.state = parts[iS];
    processes.push(p);
  }
  const cores = /(\d+)%cpu/.exec(text);
  return cores ? { cpuCores: Number(cores[1]) / 100, processes } : { processes };
}

export type Gfxinfo = { totalFrames?: number; jankyFrames?: number; jankyPct?: number; p50?: number; p90?: number; p95?: number; p99?: number };

/** `dumpsys gfxinfo <pkg>` (Android 7+): frame stats of the app's own UI (not a WebView's page). */
export function parseGfxinfo(text: string): Gfxinfo {
  const out: Gfxinfo = {};
  const total = /Total frames rendered:\s*(\d+)/.exec(text);
  if (total) out.totalFrames = Number(total[1]);
  const janky = /Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/.exec(text);
  if (janky) {
    out.jankyFrames = Number(janky[1]);
    out.jankyPct = Number(janky[2]);
  }
  for (const p of [50, 90, 95, 99] as const) {
    const m = new RegExp(`${p}th percentile:\\s*(\\d+)ms`).exec(text);
    if (m) out[`p${p}`] = Number(m[1]);
  }
  return out;
}

/** Finds the WebView renderer (sandboxed) process that serves an app, from `dumpsys activity processes`. */
export function parseRendererPid(dump: string, appUid: number): number | null {
  const userId = Math.floor(appUid / 100000);
  const appId = appUid % 100000;
  if (appId < 10000) return null;
  const tag = `u${userId}a${appId - 10000}i`;
  const re = new RegExp(`ProcessRecord\\{[0-9a-f]+ (\\d+):[^\\s}]*sandboxed_process[^\\s}]*/${tag}\\d+`);
  const m = re.exec(dump);
  return m ? Number(m[1]) : null;
}
