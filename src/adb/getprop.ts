/** Parses `getprop` output: lines like "[ro.product.model]: [AFTMA08C15]". */
export function parseGetprop(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^\[([^\]]+)\]:\s*\[([\s\S]*?)\]\s*$/;
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

/** "MemTotal:        1710032 kB" -> 1670 (MB). */
export function parseMemTotalMB(text: string): number | undefined {
  const m = /MemTotal:\s+(\d+)\s*kB/i.exec(text);
  return m ? Math.round(Number(m[1]) / 1024) : undefined;
}

/** `wm size` -> the effective size (override wins over physical). */
export function parseWmSize(text: string): { width: number; height: number; physical?: { width: number; height: number } } | undefined {
  const phys = /Physical size:\s*(\d+)x(\d+)/i.exec(text);
  const over = /Override size:\s*(\d+)x(\d+)/i.exec(text);
  const pick = over ?? phys;
  if (!pick) return undefined;
  const res: { width: number; height: number; physical?: { width: number; height: number } } = { width: Number(pick[1]), height: Number(pick[2]) };
  if (over && phys) res.physical = { width: Number(phys[1]), height: Number(phys[2]) };
  return res;
}

export function parseWmDensity(text: string): number | undefined {
  const over = /Override density:\s*(\d+)/i.exec(text);
  const phys = /Physical density:\s*(\d+)/i.exec(text);
  const m = over ?? phys;
  return m ? Number(m[1]) : undefined;
}

/** Splits output of a multi-part shell script whose parts start with "@@name". */
export function splitSections(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let cur = '_';
  let buf: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^@@(\S+)\s*$/.exec(line.trim());
    if (m) {
      out[cur] = buf.join('\n');
      cur = m[1] as string;
      buf = [];
    } else buf.push(line);
  }
  out[cur] = buf.join('\n');
  return out;
}
