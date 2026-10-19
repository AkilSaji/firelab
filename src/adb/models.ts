/**
 * Fire TV model table and helpers.
 *
 * Source: Amazon's Fire TV device specifications
 * (https://developer.amazon.com/docs/device-specs/device-specifications.html:
 * streaming media players, Fire TV Cube, and Fire TV smart TVs for NA, EMEA and
 * APAC), retrieved 2026-10-15. Where Amazon uses one build model for several
 * products the name lists them all. Entries marked `uncertain` are not on
 * Amazon's pages and come from community reports; correct them by PR.
 */

import { classifyGpu } from '@firelab/perf/chips';

export type Tier = 'low' | 'tv' | 'tv-hd' | 'high';
export const TIERS: readonly Tier[] = ['low', 'tv', 'tv-hd', 'high'];

export type FireTvModel = {
  model: string;
  name: string;
  year?: number;
  kind: 'stick' | 'box' | 'cube' | 'tv';
  gpu?: string;
  ramMB?: number;
  /** Platform it shipped with. Vega OS devices are not Android: adb tooling does not apply. */
  platform?: string;
  uncertain?: boolean;
};

export const FIRE_TV_MODELS: readonly FireTvModel[] = [
  // Streaming media players (sticks and boxes)
  { model: 'AFTB', name: 'Fire TV (1st gen)', year: 2014, kind: 'box', gpu: 'Adreno 320', ramMB: 2048, platform: 'Fire OS 5' },
  { model: 'AFTS', name: 'Fire TV (2nd gen)', year: 2015, kind: 'box', gpu: 'PowerVR Rogue GX6250', ramMB: 2048, platform: 'Fire OS 5' },
  { model: 'AFTN', name: 'Fire TV (3rd gen, 4K pendant)', year: 2017, kind: 'box', gpu: 'Mali-450 MP3', ramMB: 2048, platform: 'Fire OS 6' },
  { model: 'AFTM', name: 'Fire TV Stick (1st gen)', year: 2014, kind: 'stick', gpu: 'VideoCore IV', ramMB: 1024, platform: 'Fire OS 5' },
  { model: 'AFTT', name: 'Fire TV Stick (2nd gen) / Basic Edition', year: 2016, kind: 'stick', gpu: 'Mali-450 MP4', ramMB: 1024, platform: 'Fire OS 5' },
  { model: 'AFTMM', name: 'Fire TV Stick 4K (1st gen)', year: 2018, kind: 'stick', gpu: 'PowerVR GE8300', ramMB: 1536, platform: 'Fire OS 6' },
  { model: 'AFTSSS', name: 'Fire TV Stick (3rd gen)', year: 2020, kind: 'stick', gpu: 'PowerVR GE8300', ramMB: 1024, platform: 'Fire OS 7' },
  { model: 'AFTSS', name: 'Fire TV Stick Lite (2020) / Fire TV Stick HD (2024)', year: 2020, kind: 'stick', gpu: 'PowerVR GE8300', ramMB: 1024, platform: 'Fire OS 7' },
  { model: 'AFTKA', name: 'Fire TV Stick 4K Max (1st gen)', year: 2021, kind: 'stick', gpu: 'PowerVR GE9215', ramMB: 2048, platform: 'Fire OS 7' },
  { model: 'AFTKM', name: 'Fire TV Stick 4K (2nd gen)', year: 2023, kind: 'stick', gpu: 'PowerVR GE9215', ramMB: 2048, platform: 'Fire OS 8' },
  { model: 'AFTKRT', name: 'Fire TV Stick 4K Max (2nd gen)', year: 2023, kind: 'stick', gpu: 'PowerVR GE9215', ramMB: 2048, platform: 'Fire OS 8' },
  { model: 'AFTMA08C15', name: 'Fire TV Stick 4K Plus', year: 2025, kind: 'stick', gpu: 'PowerVR GE9215', ramMB: 2048, platform: 'Fire OS 8' },
  { model: 'AFTCA002', name: 'Fire TV Stick 4K Select', year: 2025, kind: 'stick', gpu: 'Mali-G310', ramMB: 1024, platform: 'Vega OS' },
  { model: 'AFTCL001', name: 'Fire TV Stick HD (2026)', year: 2026, kind: 'stick', gpu: 'Mali-G310', ramMB: 1024, platform: 'Vega OS' },
  { model: 'AFTCR001', name: 'Fire TV Stick 4K (3rd gen)', year: 2026, kind: 'stick', gpu: 'Mali-G310', ramMB: 1024, platform: 'Vega OS' },
  // Fire TV Cube
  { model: 'AFTA', name: 'Fire TV Cube (1st gen)', year: 2018, kind: 'cube', gpu: 'Mali-450 MP3', ramMB: 2048, platform: 'Fire OS 6' },
  { model: 'AFTR', name: 'Fire TV Cube (2nd gen)', year: 2019, kind: 'cube', gpu: 'Mali-G52 MP2', ramMB: 2048, platform: 'Fire OS 7' },
  { model: 'AFTGAZL', name: 'Fire TV Cube (3rd gen)', year: 2022, kind: 'cube', gpu: 'Mali-G52 MP8', ramMB: 2048, platform: 'Fire OS 7' },
  // Amazon-made smart TVs
  { model: 'AFTTI43', name: 'Amazon Fire TV 4-Series (2021)', year: 2021, kind: 'tv', gpu: 'Mali-G52 MP1', platform: 'Fire OS 7' },
  { model: 'AFTTIFF43', name: 'Amazon Fire TV Omni Series (2021) / Omni QLED (2022)', year: 2021, kind: 'tv', gpu: 'Mali-G52 MP1', platform: 'Fire OS 7' },
  { model: 'AFTKA002', name: 'Amazon Fire TV 2-Series (2023)', year: 2023, kind: 'tv', gpu: 'Mali-G52 MC1', platform: 'Fire OS 7' },
  { model: 'AFTKAUK002', name: 'Amazon Fire TV 2-Series (2023, UK)', year: 2023, kind: 'tv', gpu: 'Mali-G52 MC1', platform: 'Fire OS 7' },
  { model: 'AFTCU864A2', name: 'Amazon Fire TV 2-Series (2025)', year: 2025, kind: 'tv', gpu: 'Mali-G57 MC1', platform: 'Fire OS 8' },
  { model: 'AFTCUD6595', name: 'Amazon Fire TV 2-Series (2025)', year: 2025, kind: 'tv', gpu: 'Mali-G57 MC1', platform: 'Fire OS 8' },
  { model: 'AFTNA1322D', name: 'Amazon Fire TV 4-Series (2025)', year: 2025, kind: 'tv', gpu: 'Mali-G57 MC1', platform: 'Fire OS 8' },
  { model: 'AFTNA67200', name: 'Amazon Fire TV 4-Series (2025)', year: 2025, kind: 'tv', gpu: 'Mali-G57 MC1', platform: 'Fire OS 8' },
  { model: 'AFTPOC9BD3', name: 'Amazon Fire TV Omni QLED Series (2025)', year: 2025, kind: 'tv', gpu: 'Mali-G57 MC1', platform: 'Fire OS 8' },
  { model: 'AFTPO9D4D7', name: 'Amazon Fire TV Omni QLED Series (2025)', year: 2025, kind: 'tv', gpu: 'Mali-G57 MC1', platform: 'Fire OS 8' },
  { model: 'AFTBOE497A', name: 'Amazon Ember Artline (2026)', year: 2026, kind: 'tv', gpu: 'Mali-G57 MC1', platform: 'Fire OS 8' },
  { model: 'AFTBOEF7DA', name: 'Amazon Ember Artline (2026)', year: 2026, kind: 'tv', gpu: 'Mali-G57 MC1', platform: 'Fire OS 8' },
  // Partner smart TVs (Fire TV built in)
  { model: 'AFTRS', name: 'Element 4K Fire TV (2017)', year: 2017, kind: 'tv', gpu: 'Mali-T820 MP3', platform: 'Fire OS 5' },
  { model: 'AFTEAMR311', name: 'Insignia HD Fire TV (2018-2020)', year: 2018, kind: 'tv', gpu: 'Mali-450 MP3', platform: 'Fire OS 6' },
  { model: 'AFTJMST12', name: 'Insignia 4K Fire TV (2018)', year: 2018, kind: 'tv', gpu: 'Mali-T820 MP2', platform: 'Fire OS 6' },
  { model: 'AFTBAMR311', name: 'Toshiba HD Fire TV (2018-2020)', year: 2018, kind: 'tv', gpu: 'Mali-450 MP3', platform: 'Fire OS 6' },
  { model: 'AFTKMST12', name: 'Toshiba 4K Fire TV (2018-2019)', year: 2018, kind: 'tv', gpu: 'Mali-T820 MP2', platform: 'Fire OS 6' },
  { model: 'AFTDCT31', name: 'Toshiba / Insignia 4K UHD Fire TV (2020)', year: 2020, kind: 'tv', gpu: 'Mali-G52 MP1', platform: 'Fire OS 7' },
  { model: 'AFTHA001', name: 'Toshiba 4K UHD (2021) / Hisense U6 (2022) Fire TV', year: 2021, kind: 'tv', gpu: 'Mali-G52 MP1', platform: 'Fire OS 7' },
  { model: 'AFTHA002', name: 'Toshiba V35 Series Fire TV (2021)', year: 2021, kind: 'tv', gpu: 'Mali-G52 MP1', platform: 'Fire OS 7' },
  { model: 'AFTHA003', name: 'Toshiba 4K Far-field Fire TV (2021)', year: 2021, kind: 'tv', gpu: 'Mali-G52 MP1', platform: 'Fire OS 7' },
  { model: 'AFTHA004', name: 'Hisense / Toshiba 4K UHD Fire TV (2022)', year: 2022, kind: 'tv', gpu: 'Mali-G31', platform: 'Fire OS 7' },
  { model: 'AFTMD001', name: 'TCL S4 / Q6 Fire TV (2023)', year: 2023, kind: 'tv', gpu: 'Mali-G31', platform: 'Fire OS 7' },
  { model: 'AFTMD002', name: 'TCL S3 1080p Fire TV (2023)', year: 2023, kind: 'tv', gpu: 'Mali-G31 MP2', platform: 'Fire OS 7' },
  { model: 'AFTDEC012E', name: 'TCL S4/S5/Q5/Q6 Fire TV (2024)', year: 2024, kind: 'tv', gpu: 'Mali-G52 2EE', platform: 'Fire OS 8' },
  { model: 'AFTEU011', name: 'Grundig Vision 6 HD Fire TV (2019)', year: 2019, kind: 'tv', gpu: 'Mali-470 MP3', platform: 'Fire OS 7' },
  { model: 'AFTEU014', name: 'Grundig Vision 7 4K Fire TV (2019)', year: 2019, kind: 'tv', gpu: 'Mali-470 MP3', platform: 'Fire OS 7' },
  { model: 'AFTEUFF014', name: 'Grundig OLED 4K Fire TV (2019)', year: 2019, kind: 'tv', gpu: 'Mali-470 MP3', platform: 'Fire OS 7' },
  { model: 'AFTSO001', name: 'JVC 4K Fire TV (2019)', year: 2019, kind: 'tv', gpu: 'Mali-470 MP3', platform: 'Fire OS 7' },
  { model: 'AFTWMST22', name: 'JVC 2K Fire TV (2020)', year: 2020, kind: 'tv', gpu: 'Mali-470 MP3', platform: 'Fire OS 7' },
  { model: 'AFTWI001', name: 'ok 4K Fire TV (2020)', year: 2020, kind: 'tv', gpu: 'Mali-470 MP3', platform: 'Fire OS 7' },
  { model: 'AFTJULI1', name: 'JVC 4K Fire TV with Freeview Play (2021)', year: 2021, kind: 'tv', gpu: 'Mali-G52 MP1', platform: 'Fire OS 7' },
  { model: 'AFTANNA0', name: 'Xiaomi F2 4K (2022) / ok 4K (2021) Fire TV', year: 2021, kind: 'tv', gpu: 'Mali-G52 MP1', platform: 'Fire OS 7' },
  { model: 'AFTBOXE1', name: 'Panasonic 4K MX800 Fire TV (2023)', year: 2023, kind: 'tv', gpu: 'Mali-G52 MC1', platform: 'Fire OS 7' },
  { model: 'AFTSHN02', name: 'TCL FHD Fire TV (2023)', year: 2023, kind: 'tv', gpu: 'Mali-G31 MP2', platform: 'Fire OS 7' },
  { model: 'AFTMA475B1', name: 'TCL 4K Smart Fire TV (2024-2025)', year: 2024, kind: 'tv', gpu: 'Mali-G52 2EE', platform: 'Fire OS 8' },
  { model: 'AFTSH3F7EF', name: '4K Fire TV QLED (2024) / Regal 4K Fire TV (2025)', year: 2024, kind: 'tv', gpu: 'Mali-G52 MC1', platform: 'Fire OS 8' },
  { model: 'AFTPOF46A5', name: '4K Ultra HD Smart TV with Fire TV (2024)', year: 2024, kind: 'tv', gpu: 'Mali-G52 MC1', platform: 'Fire OS 8' },
  { model: 'AFTBR92D74', name: 'Xiaomi TV 4K HDR Fire TV (2026)', year: 2026, kind: 'tv', gpu: 'Mali-G52 2EE', platform: 'Fire OS 8' },
  { model: 'AFTLE', name: 'Onida HD Fire TV (2019)', year: 2019, kind: 'tv', gpu: 'Mali-450 MP3', platform: 'Fire OS 6' },
  { model: 'AFTTIFF55', name: 'Onida HD/FHD Fire TV (2020)', year: 2020, kind: 'tv', gpu: 'Mali-450 MP3', platform: 'Fire OS 6' },
  { model: 'AFTBU001', name: 'AmazonBasics HD/FHD Fire TV (2020)', year: 2020, kind: 'tv', gpu: 'Mali-450 MP3', platform: 'Fire OS 6' },
  { model: 'AFTPR001', name: 'AmazonBasics 4K Fire TV (2020)', year: 2020, kind: 'tv', gpu: 'Mali-G31 MP2', platform: 'Fire OS 7' },
  { model: 'AFTMON001', name: 'Funai 4K Fire TV (2022)', year: 2022, kind: 'tv', gpu: 'Mali-G52 MC1', platform: 'Fire OS 7' },
  { model: 'AFTMON002', name: 'Funai 4K Fire TV (2022)', year: 2022, kind: 'tv', gpu: 'Mali-G52 MC1', platform: 'Fire OS 7' },
  { model: 'AFTBTX4', name: 'Redmi 4K Fire TV (2023)', year: 2023, kind: 'tv', gpu: 'Mali-G52 MC1', platform: 'Fire OS 7' },
  { model: 'AFTWYM01', name: 'Panasonic / JVC 4K Fire TV (2024-2025)', year: 2024, kind: 'tv', gpu: 'Mali-G52 MC1', platform: 'Fire OS 8' },
  { model: 'AFTTOR001', name: 'Panasonic OLED Fire TV (2024-2025)', year: 2024, kind: 'tv', gpu: 'Mali-G52 MC1', platform: 'Fire OS 8' },
];

const BY_MODEL = new Map(FIRE_TV_MODELS.map((m) => [m.model.toUpperCase(), m]));

export function lookupModel(model: string | undefined): FireTvModel | undefined {
  return model ? BY_MODEL.get(model.trim().toUpperCase()) : undefined;
}

export function isFireTv(model?: string, manufacturer?: string): boolean {
  return /^AFT/i.test(model ?? '') || (/amazon/i.test(manufacturer ?? '') && !/^KF/i.test(model ?? ''));
}

/** "Fire TV Stick 4K Plus", "Fire TV device (AFTXYZ)", or "Xiaomi MiTV-AXSO0" for other Android TVs. */
export function friendlyName(model?: string, manufacturer?: string): string {
  const known = lookupModel(model);
  if (known) return known.name;
  if (isFireTv(model, manufacturer)) {
    const brand = manufacturer && !/amazon/i.test(manufacturer) ? `${manufacturer} ` : '';
    return `${brand}Fire TV device (${model ?? 'unknown model'})`;
  }
  return [manufacturer, model].filter(Boolean).join(' ') || 'Android device';
}

/** Fire OS version for an Android API level (used when the build has no Fire OS property). */
export function fireOsForSdk(sdk: number): string | undefined {
  if (sdk >= 30) return 'Fire OS 8';
  if (sdk >= 28) return 'Fire OS 7';
  if (sdk >= 25) return 'Fire OS 6';
  if (sdk >= 22) return 'Fire OS 5';
  return undefined;
}

const ANDROID_RELEASE: Record<number, string> = {
  21: '5.0', 22: '5.1', 23: '6', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9', 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16',
};
export const androidRelease = (sdk: number): string | undefined => ANDROID_RELEASE[sdk];

/**
 * Human OS label from getprop values, e.g. "Fire OS 8.1.8.2 (Android 11)"
 * or "Android 11" for non-Amazon devices.
 */
export function osLabel(props: Record<string, string>): string {
  const sdk = Number(props['ro.build.version.sdk']);
  const release = props['ro.build.version.release'] || (Number.isFinite(sdk) ? androidRelease(sdk) : undefined);
  const android = release ? `Android ${release}` : Number.isFinite(sdk) ? `API ${sdk}` : 'Android';
  const fireMktg = props['ro.build.mktg.fireos']; // "Fire OS 8.1.8.2"
  const fireName = /^(Fire OS [\d.]+)/.exec(props['ro.build.version.name'] ?? '')?.[1]; // "Fire OS 7.7.1.7 (PS7717/5741)"
  const isAmazon = /amazon/i.test(props['ro.product.manufacturer'] ?? '') || /^AFT/.test(props['ro.product.model'] ?? '');
  const fire = fireMktg || fireName || (props['ro.build.version.fireos'] ? `Fire OS ${props['ro.build.version.fireos']}` : undefined) || (isAmazon && Number.isFinite(sdk) ? fireOsForSdk(sdk) : undefined);
  return fire ? `${fire} (${android})` : android;
}

/**
 * Quality tier for a GPU (the WebGL UNMASKED_RENDERER string or a spec name).
 * Uses @firelab/perf's chip table, so the tester and the in-page library
 * always agree; falls back to a few patterns for names the table lacks.
 */
export function tierForGpu(gpu: string | undefined): Tier | undefined {
  if (!gpu) return undefined;
  const chip = classifyGpu(gpu);
  if (chip) return chip.tier;
  return fallbackTier(gpu);
}

function fallbackTier(gpu: string): Tier | undefined {
  const g = gpu.replace(/\(TM\)/gi, '').replace(/\s+/g, ' ');
  if (/Mali-?\s?(4\d\d|T[67]\d\d)|VideoCore|Adreno 2\d\d|GC\d{3,4}|PowerVR SGX/i.test(g)) return 'low';
  if (/GE8\d{3}|PowerVR Rogue (GE8|G6\d|GX6)|Mali-?\s?(T8\d\d|G31|G51)|Adreno [345]\d\d/i.test(g)) return 'tv';
  if (/GE9\d{3}|IMG [BCD]X|BXE|BXM|Mali-?\s?(G52|G57|G6\d|G7\d|G310|G610|G710|G615|G715)|Immortalis|Adreno [6-9]\d\d/i.test(g)) return 'tv-hd';
  if (/NVIDIA|GeForce|Radeon|AMD|Intel|Apple|Iris|UHD Graphics|ANGLE \(.*(Metal|Direct3D|Vulkan)/i.test(g)) return 'high';
  return undefined;
}

/** Best-guess tier from the model table when the GPU string is not known yet. */
export function tierForModel(model: string | undefined): Tier | undefined {
  return tierForGpu(lookupModel(model)?.gpu);
}
