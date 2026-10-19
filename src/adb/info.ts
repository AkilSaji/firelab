import type { Adb } from './client.js';
import { parseGetprop, parseMemTotalMB, parseWmDensity, parseWmSize, splitSections } from './getprop.js';
import { friendlyName, isFireTv, lookupModel, osLabel, tierForGpu, tierForModel, type Tier } from './models.js';

export type DeviceInfo = {
  id: string;
  model?: string;
  manufacturer?: string;
  /** Friendly name, e.g. "Fire TV Stick 4K Plus". */
  name: string;
  /** e.g. "Fire OS 8.1.8.2 (Android 11)". */
  os: string;
  sdk?: number;
  androidVersion?: string;
  fireOs?: boolean;
  /** Primary ABI, e.g. "armeabi-v7a". */
  abi?: string;
  abis: string[];
  ramMB?: number;
  resolution?: { width: number; height: number };
  density?: number;
  /** Codename (ro.product.device), e.g. "karat". */
  codename?: string;
  /** SoC platform (ro.board.platform), e.g. "mt8696". */
  soc?: string;
  buildId?: string;
  /** GPU from Amazon's spec table (replaced by the WebGL renderer once a WebView has been inspected). */
  gpu?: string;
  gpuSource?: 'spec' | 'webgl';
  tier?: Tier;
};

/** The shell script behind `deviceInfo`: one adb round trip. */
export const DEVICE_INFO_SCRIPT = 'getprop; echo @@mem; grep -i MemTotal /proc/meminfo; echo @@wm; wm size 2>/dev/null; wm density 2>/dev/null';

export function parseDeviceInfo(id: string, output: string): DeviceInfo {
  const s = splitSections(output);
  const p = parseGetprop(s._ ?? '');
  const model = p['ro.product.model'] || undefined;
  const manufacturer = p['ro.product.manufacturer'] || undefined;
  const sdk = Number(p['ro.build.version.sdk']) || undefined;
  const abis = (p['ro.product.cpu.abilist'] || [p['ro.product.cpu.abi'], p['ro.product.cpu.abi2']].filter(Boolean).join(','))
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const known = lookupModel(model);
  const size = parseWmSize(s.wm ?? '');
  const info: DeviceInfo = {
    id,
    model,
    manufacturer,
    name: friendlyName(model, manufacturer),
    os: osLabel(p),
    sdk,
    androidVersion: p['ro.build.version.release'] || undefined,
    fireOs: isFireTv(model, manufacturer),
    abi: abis[0],
    abis,
    ramMB: parseMemTotalMB(s.mem ?? ''),
    density: parseWmDensity(s.wm ?? ''),
    codename: p['ro.product.device'] || undefined,
    soc: p['ro.board.platform'] || p['ro.hardware'] || undefined,
    buildId: p['ro.build.display.id'] || p['ro.build.id'] || undefined,
  };
  if (size) info.resolution = { width: size.width, height: size.height };
  if (known?.gpu) {
    info.gpu = known.gpu;
    info.gpuSource = 'spec';
  }
  info.tier = tierForGpu(info.gpu) ?? tierForModel(model);
  return info;
}

export async function getDeviceInfo(adb: Adb, serial: string): Promise<DeviceInfo> {
  const out = await adb.shell(serial, DEVICE_INFO_SCRIPT, { timeoutMs: 15000 });
  return parseDeviceInfo(serial, out);
}
