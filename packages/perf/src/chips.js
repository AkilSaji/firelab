// Chip detection: which GPU is this, what kind of device is it, and which
// quality tier should it start on.
//
// Everything here except readGpu() is pure (strings in, objects out), so it
// runs in Node as well: the FireLab tester uses the same table to label the
// devices it finds.

import { capTier } from './tiers.js';

/** @typedef {import('./tiers.js').TierId} TierId */

/**
 * @typedef {object} ChipEntry
 * @property {string} id         stable identifier, e.g. 'powervr-ge8300'
 * @property {RegExp} match      tested against the WebGL renderer string
 * @property {TierId} tier       starting tier for this GPU
 * @property {string} family     human name of the GPU or family
 * @property {string} why        why it gets this tier
 * @property {string[]} [devices] devices known to use it
 * @property {string} [measured] a real measurement behind the choice
 */

/**
 * The chip table. First match wins, so specific entries come before the
 * catch-alls of their vendor. Each entry says why it got its tier.
 *
 * Measured data points (Sunset Villa, a three.js game, 30 fps cap):
 * - PowerVR GE8300 (Fire TV Stick 3rd gen): `tv` holds 27 fps standing and
 *   24 walking at 768x432; `tv-hd` with sun shadows drops to 13-17 fps.
 * - PowerVR GE9215 (Fire TV Stick 4K Max 2nd gen): `tv-hd` runs at up to 1080p.
 *
 * @type {readonly ChipEntry[]}
 */
export const CHIPS = Object.freeze([
  // ---- software rendering: no GPU at all ----
  {
    id: 'software',
    match: /SwiftShader|llvmpipe|softpipe|Software Rasterizer|Basic Render Driver|Microsoft Basic/i,
    tier: 'low',
    family: 'Software renderer',
    why: 'A CPU rasterizer (headless Chrome, a blocklisted driver, a VM): every pixel costs CPU time, so draw the least.',
  },

  // ---- Imagination PowerVR ----
  {
    id: 'powervr-sgx',
    match: /PowerVR SGX|\bSGX ?\d{3}/i,
    tier: 'low',
    family: 'PowerVR SGX (Series5)',
    why: '2010-2014 GPUs limited to OpenGL ES 2: no WebGL2 and little fill rate.',
  },
  {
    id: 'powervr-ge8100',
    match: /GE8100/i,
    tier: 'low',
    family: 'PowerVR Rogue GE8100',
    why: 'Single-cluster entry Rogue (MT6739-class phones and boxes): about half of a GE8300.',
  },
  {
    id: 'powervr-ge8300',
    match: /GE8300/i,
    tier: 'tv',
    family: 'PowerVR Rogue GE8300',
    devices: ['Fire TV Stick (3rd gen, AFTSSS)', 'Fire TV Stick Lite (AFTSS)', 'Fire TV Stick 4K (2018, AFTMM)'],
    why: 'The 1 GB Fire TV Sticks: fill rate for 720p without shadows. Both CPU- and geometry-bound in busy scenes.',
    measured: 'Sunset Villa: tv = 27 fps standing, 24 walking at 768x432; tv-hd with shadows = 13-17 fps.',
  },
  {
    id: 'powervr-ge83xx',
    match: /GE8[2-4]\d\d/i,
    tier: 'tv',
    family: 'PowerVR Rogue GE8320 / GE8322',
    why: 'Same 8XE family as the GE8300 (Helio P35/G35 phones, Unisoc boxes): comparable fill rate.',
  },
  {
    id: 'powervr-ge9215',
    match: /GE9215/i,
    tier: 'tv-hd',
    family: 'PowerVR Rogue GE9215',
    devices: ['Fire TV Stick 4K Max (2nd gen, AFTMA08C15)', 'Fire TV Stick 4K Max (2021, AFTKA)'],
    why: 'The 2 GB Fire TV Sticks: enough fill rate for 1080p when a scene is light, with adaptive resolution backing off when it is not.',
    measured: 'Sunset Villa: tv-hd at up to 1080p on the Fire TV Stick 4K Max (2nd gen).',
  },
  {
    id: 'powervr-ge9xxx',
    match: /GE9\d{3}/i,
    tier: 'tv-hd',
    family: 'PowerVR Rogue GE9xxx (9XE)',
    why: 'The 9XE successors of the GE8300 roughly double its fill rate.',
  },
  {
    id: 'powervr-gm9xxx',
    match: /GM9\d{3}/i,
    tier: 'tv-hd',
    family: 'PowerVR Rogue GM9xxx (9XM)',
    why: 'Mid-range 9XM Rogue (e.g. Helio P90): faster than the 9XE stick GPUs.',
  },
  {
    id: 'powervr-rogue-6-7',
    match: /(PowerVR|Rogue|IMG).{0,24}\bG[XTEM]?[67]\d{3}\b/i,
    tier: 'tv',
    family: 'PowerVR Rogue Series6/7',
    devices: ['Fire TV (2nd gen, 2015, AFTS): GX6250'],
    why: '2013-2016 Rogue GPUs: OpenGL ES 3 capable, TV-class fill rate.',
  },
  {
    id: 'powervr-b-series',
    match: /B-Series|\bBX[EMST]\b|\bBX[EMST]-/i,
    tier: 'tv-hd',
    family: 'IMG B-Series (BXE / BXM / BXS)',
    why: '2020+ successors of the 9XE/9XM GPUs used in newer TV SoCs: at least GE9215-class.',
  },
  {
    id: 'powervr-c-d-series',
    match: /[CD]-Series|\b[CD]X[DTSM]?-\d/i,
    tier: 'tv-hd',
    family: 'IMG C/D-Series',
    why: 'Current Imagination GPUs (e.g. DXT in recent phones): plenty for 1080p.',
  },
  {
    id: 'powervr-other',
    match: /PowerVR|Imagination|\bIMG\b/i,
    tier: 'tv',
    family: 'PowerVR (unrecognised)',
    why: 'An Imagination GPU we have no data for: start lean, adaptive resolution can still raise the picture.',
  },

  // ---- Arm Mali ----
  {
    id: 'mali-utgard',
    match: /Mali-(200|300|400|450|470)\b/i,
    tier: 'low',
    family: 'Mali-400 / Mali-450 (Utgard)',
    devices: ['Fire TV Stick (2nd gen, AFTT)', 'Fire TV (3rd gen, AFTN)', 'Fire TV Cube (1st gen, AFTA)', 'most 2015-2019 Android TV boxes'],
    why: 'OpenGL ES 2 only, so no WebGL2 at all: WebGL2 games cannot run, WebGL1 pages should draw the minimum.',
  },
  {
    id: 'mali-midgard-entry',
    match: /Mali-T(6\d\d|7[0-7]\d|8[0-3]\d)\b/i,
    tier: 'low',
    family: 'Mali-T6xx / T720 / T760 / T820 / T830 (Midgard)',
    why: 'Midgard GPUs in budget boxes (e.g. Amlogic S912 with T820 MP3): ES 3.x but Mali-450-class fill rate.',
  },
  {
    id: 'mali-midgard-high',
    match: /Mali-T8[6-9]\d\b/i,
    tier: 'tv',
    family: 'Mali-T860 / T880',
    why: '2016 flagship Midgard: TV-class when clocked down in boxes.',
  },
  {
    id: 'mali-entry-bifrost',
    match: /Mali-G(31|51|310)\b/i,
    tier: 'tv',
    family: 'Mali-G31 / G51 / G310',
    devices: ['Chromecast with Google TV (Mali-G31 MP2)', 'Xiaomi Mi Box S (2nd gen) / Mi TV Stick 4K (Mali-G31 MP2)'],
    why: 'Entry Bifrost/Valhall in current Android TV sticks: about GE8300 speed, so 720p without shadows.',
  },
  {
    id: 'mali-mid',
    match: /Mali-G(5[2-9]|[6-9]\d|\d{3})\b|Immortalis/i,
    tier: 'tv-hd',
    family: 'Mali-G52 and newer (Bifrost / Valhall / 5th gen)',
    devices: ['Fire TV Cube (2nd gen, AFTR): Mali-G52 MP6', 'Fire TV Cube (3rd gen, AFTGAZL): Mali-G52'],
    why: 'Mid-range and better Mali: 1080p with sun shadows is within reach.',
  },
  {
    id: 'mali-other',
    match: /\bMali\b/i,
    tier: 'tv',
    family: 'Mali (unrecognised)',
    why: 'An Arm GPU we have no data for (or a masked name): start lean.',
  },

  // ---- Qualcomm Adreno ----
  {
    id: 'adreno-windows',
    match: /Adreno[^0-9]{0,12}X\d|Adreno[^0-9]{0,12}8cx|Snapdragon X/i,
    tier: 'high',
    family: 'Adreno X / 8cx (Windows on Arm laptops)',
    why: 'Laptop-class Snapdragon GPUs.',
  },
  {
    id: 'adreno-2xx-30x',
    match: /Adreno[^0-9]{0,12}(2\d\d|30\d)\b/i,
    tier: 'low',
    family: 'Adreno 2xx / 302-308',
    why: 'Entry Snapdragon 2xx/4xx GPUs: Mali-450-class fill rate (2xx lacks ES 3).',
  },
  {
    id: 'adreno-3xx-5xx',
    match: /Adreno[^0-9]{0,12}[345]\d\d\b/i,
    tier: 'tv',
    family: 'Adreno 3xx-5xx',
    devices: ['Fire TV (1st gen, 2014, AFTB): Adreno 320'],
    why: 'Mid-range Snapdragons of 2013-2018: TV-class.',
  },
  {
    id: 'adreno-6xx-plus',
    match: /Adreno[^0-9]{0,12}[6-9]\d\d\b/i,
    tier: 'tv-hd',
    family: 'Adreno 6xx and newer',
    why: 'Snapdragon 6xx/7xx/8xx GPUs: 1080p with shadows.',
  },
  {
    id: 'adreno-other',
    match: /Adreno/i,
    tier: 'tv',
    family: 'Adreno (unrecognised)',
    why: 'A Qualcomm GPU with a masked or unknown number: start lean.',
  },

  // ---- NVIDIA ----
  {
    id: 'tegra-old',
    match: /Tegra ?(2|3)\b/i,
    tier: 'low',
    family: 'NVIDIA Tegra 2 / 3',
    why: '2011-2012 tablets: ES 2 only.',
  },
  {
    id: 'tegra-k1',
    match: /Tegra ?(4|K1)\b/i,
    tier: 'tv',
    family: 'NVIDIA Tegra 4 / K1',
    why: '2013-2014 Tegra: TV-class today.',
  },
  {
    id: 'tegra-x1',
    match: /Tegra/i,
    tier: 'tv-hd',
    family: 'NVIDIA Tegra X1',
    devices: ['NVIDIA SHIELD TV'],
    why: 'The fastest common Android TV GPU (Maxwell): 1080p with shadows.',
  },
  {
    id: 'nvidia-desktop',
    match: /NVIDIA|GeForce|Quadro|\bRTX\b|\bGTX\b|TITAN/i,
    tier: 'high',
    family: 'NVIDIA GeForce / RTX / Quadro',
    why: 'Desktop and laptop GPUs.',
  },

  // ---- desktop vendors ----
  {
    id: 'amd',
    match: /\bAMD\b|Radeon|\bATI\b/i,
    tier: 'high',
    family: 'AMD Radeon',
    why: 'Desktop, laptop and console-class GPUs.',
  },
  {
    id: 'intel-entry',
    match: /Intel.*HD Graphics (400|405|500|505|600|605)\b|Bay ?Trail|Cherry ?Trail|\(BYT\)|\(CHV\)/i,
    tier: 'tv',
    family: 'Intel HD Graphics 400-605 (Atom / Celeron / Pentium Silver)',
    why: 'Low-power Atom-class laptops and Chromebooks: TV-class fill rate, worse at high resolutions.',
  },
  {
    id: 'intel',
    match: /Intel|Iris|\bArc\b|Mesa DRI Intel/i,
    tier: 'high',
    family: 'Intel HD / UHD / Iris / Arc',
    why: 'Laptop and desktop integrated graphics: adaptive resolution handles the slower ones.',
  },

  // ---- Apple ----
  {
    id: 'apple-m',
    match: /Apple M\d/i,
    tier: 'high',
    family: 'Apple M-series',
    why: 'Apple silicon Macs.',
  },
  {
    id: 'apple-a',
    match: /Apple A\d/i,
    tier: 'tv-hd',
    family: 'Apple A-series',
    why: 'iPhone / iPad / Apple TV GPUs: fast, but a phone or a TV box, not a desktop.',
  },
  {
    id: 'apple-gpu',
    match: /Apple/i,
    tier: 'high',
    family: 'Apple GPU (model hidden by Safari)',
    why: 'Safari reports only "Apple GPU". On a Mac that is Apple silicon; iPhones and iPads are capped at tv-hd by the device rule.',
  },

  // ---- other mobile and embedded GPUs ----
  {
    id: 'xclipse',
    match: /Xclipse|Maleoon/i,
    tier: 'tv-hd',
    family: 'Samsung Xclipse / Huawei Maleoon',
    why: 'Flagship phone GPUs.',
  },
  {
    id: 'vivante',
    match: /Vivante|\bGC\d{3,4}\b/i,
    tier: 'low',
    family: 'Vivante GC',
    why: 'Embedded GPUs in old set-top boxes (NXP i.MX, Marvell): ES 2-class.',
  },
  {
    id: 'videocore-old',
    match: /VideoCore|V3D 4/i,
    tier: 'low',
    family: 'Broadcom VideoCore IV / V3D 4 (Raspberry Pi 1-4)',
    devices: ['Fire TV Stick (1st gen, AFTM)'],
    why: 'Very little fill rate.',
  },
  {
    id: 'videocore-new',
    match: /V3D [5-9]/i,
    tier: 'tv',
    family: 'Broadcom V3D 7 (Raspberry Pi 5)',
    why: 'About Mali-G31 class.',
  },
]);

/**
 * Fire TV model codes (from the user agent) for when the GPU name is hidden.
 * Only used as a fallback: the GPU string wins when it is readable.
 * @type {Readonly<Record<string, { name: string, gpu: string, tier: TierId }>>}
 */
export const FIRE_TV_MODELS = Object.freeze({
  AFTB: { name: 'Fire TV (1st gen, 2014)', gpu: 'Adreno 320', tier: 'tv' },
  AFTM: { name: 'Fire TV Stick (1st gen, 2014)', gpu: 'VideoCore IV', tier: 'low' },
  AFTS: { name: 'Fire TV (2nd gen, 2015)', gpu: 'PowerVR GX6250', tier: 'tv' },
  AFTT: { name: 'Fire TV Stick (2nd gen, 2016)', gpu: 'Mali-450 MP4', tier: 'low' },
  AFTN: { name: 'Fire TV (3rd gen, 2017)', gpu: 'Mali-450 MP3', tier: 'low' },
  AFTA: { name: 'Fire TV Cube (1st gen, 2018)', gpu: 'Mali-450 MP3', tier: 'low' },
  AFTMM: { name: 'Fire TV Stick 4K (2018)', gpu: 'PowerVR GE8300', tier: 'tv' },
  AFTR: { name: 'Fire TV Cube (2nd gen, 2019)', gpu: 'Mali-G52 MP6', tier: 'tv-hd' },
  AFTSSS: { name: 'Fire TV Stick (3rd gen, 2020)', gpu: 'PowerVR GE8300', tier: 'tv' },
  AFTSS: { name: 'Fire TV Stick Lite (2020)', gpu: 'PowerVR GE8300', tier: 'tv' },
  AFTKA: { name: 'Fire TV Stick 4K Max (2021)', gpu: 'PowerVR GE9215', tier: 'tv-hd' },
  AFTGAZL: { name: 'Fire TV Cube (3rd gen, 2022)', gpu: 'Mali-G52', tier: 'tv-hd' },
  AFTMA08C15: { name: 'Fire TV Stick 4K Max (2nd gen)', gpu: 'PowerVR GE9215', tier: 'tv-hd' },
});

/** @typedef {'firetv' | 'androidtv' | 'tv' | 'mobile' | 'desktop'} Platform */

/**
 * @typedef {object} UaInfo
 * @property {Platform} platform
 * @property {boolean} isTv          a TV, stick or set-top box
 * @property {string | null} model    e.g. 'AFTSSS' or 'MIBOX4'
 * @property {string | null} device   friendly name when the model is known
 * @property {boolean} wrapped        running inside an app WebView ("; wv)" or FireLab's wrapper)
 */

const ANDROID_TV = /Android ?TV|Google ?TV|BRAVIA|SHIELD|MiTV|MIBOX|Chromecast|SmartTV|Smart-TV|\bDTV\b|\bATV\b|\bSTB\b|Leanback|\bTV\b|\bBox\b|AFT[A-Z0-9]/i;
const OTHER_TV = /Tizen|Web0S|webOS|VIDAA|HbbTV|NetCast|CrKey|Roku|PlayStation|Xbox|AppleTV|tvOS|SMART-TV|SmartTV|Opera TV|Vewd/i;

/**
 * Reads the platform and device model from a user agent string.
 * @param {string} [ua]
 * @param {{ maxTouchPoints?: number }} [hints]
 * @returns {UaInfo}
 */
export function parseUserAgent(ua = '', hints = {}) {
  const fire = /\b(AFT[A-Z0-9]{1,12})\b/.exec(ua);
  const android = /Android/i.test(ua);
  const am = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?(?:;|\))/.exec(ua);
  let model = fire ? fire[1] : am ? am[1].trim() : null;
  if (model === 'K' || model === 'wv') model = null; // Chrome's reduced user agent hides the model
  /** @type {Platform} */
  let platform;
  if (fire) platform = 'firetv';
  else if (android && ANDROID_TV.test(ua)) platform = 'androidtv';
  else if (OTHER_TV.test(ua)) platform = 'tv';
  else if (android || /iPhone|iPad|iPod|Mobile|\bKF[A-Z]{2,}/.test(ua)) platform = 'mobile';
  else if (/Macintosh/.test(ua) && (hints.maxTouchPoints ?? 0) > 1) platform = 'mobile'; // iPadOS
  else platform = 'desktop';
  const known = fire ? FIRE_TV_MODELS[fire[1]] : undefined;
  return {
    platform,
    isTv: platform === 'firetv' || platform === 'androidtv' || platform === 'tv',
    model,
    device: known ? known.name : fire ? 'Fire TV' : null,
    wrapped: /; wv\)|FireLab\//.test(ua),
  };
}

/**
 * Finds the chip table entry for a WebGL renderer string.
 * @param {string | null | undefined} renderer
 * @returns {ChipEntry | null}
 */
export function classifyGpu(renderer) {
  if (!renderer) return null;
  for (const chip of CHIPS) if (chip.match.test(renderer)) return chip;
  return null;
}

/**
 * Shortens a WebGL renderer string for display:
 * "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)" -> "Apple M2 Pro".
 * @param {string | null | undefined} renderer
 * @returns {string}
 */
export function cleanGpuName(renderer) {
  if (!renderer) return '';
  let s = String(renderer).trim();
  const angle = /^ANGLE \((.*)\)$/s.exec(s);
  if (angle) {
    const parts = angle[1].split(', ');
    // ANGLE (vendor, renderer, backend[, driver])
    s = parts.length >= 2 ? parts[1] : parts[0];
  }
  return s
    .replace(/^ANGLE Metal Renderer: /, '')
    .replace(/\s*\(0x[0-9a-f]+\)/gi, '')
    .replace(/\s*Direct3D\S*( vs_\S+ ps_\S+)?/g, '')
    .replace(/\s*OpenGL( ES)? [\d.]+.*$/, '')
    .replace(/\s*\/(PCIe|integrated)\/SSE2$/i, '')
    .replace(/\(R\)|\(TM\)/g, (m) => (m === '(TM)' ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @typedef {object} GpuInfo
 * @property {string} renderer   unmasked renderer, or the masked one, or ''
 * @property {string} vendor
 * @property {boolean} masked     true when WEBGL_debug_renderer_info was unavailable
 * @property {0 | 1 | 2} webgl    best WebGL version available
 */

/**
 * @typedef {object} Detection
 * @property {TierId} tier         the tier this device should start on
 * @property {string} reason       one sentence on why
 * @property {Platform} platform
 * @property {boolean} isTv
 * @property {string | null} model
 * @property {string | null} device
 * @property {string} gpu          display name of the GPU ('' when unknown)
 * @property {string} renderer     raw renderer string
 * @property {string} vendor
 * @property {boolean} masked
 * @property {0 | 1 | 2} webgl
 * @property {string | null} chip  id of the matching chip table entry
 */

/**
 * Picks a starting tier from what is known about the device. Pure.
 *
 * Rules, in order:
 * 1. No WebGL at all -> low.
 * 2. A chip table match -> its tier; else the Fire TV model table (when the
 *    GPU name is hidden); else 'high' on desktops and 'tv' everywhere else.
 * 3. TVs, sticks, phones and tablets never get 'high' (capped at tv-hd).
 * 4. No WebGL2 -> capped at low.
 *
 * @param {{ renderer?: string, vendor?: string, masked?: boolean, webgl?: 0 | 1 | 2, ua?: string, maxTouchPoints?: number }} info
 * @returns {Detection}
 */
export function classifyDevice(info) {
  const renderer = info.renderer || '';
  const webgl = info.webgl ?? (renderer ? 2 : 0);
  const ua = parseUserAgent(info.ua || '', { maxTouchPoints: info.maxTouchPoints });
  const chip = classifyGpu(renderer);
  const known = ua.model ? FIRE_TV_MODELS[ua.model] : undefined;
  /** @type {TierId} */
  let tier;
  let reason;
  if (webgl === 0) {
    tier = 'low';
    reason = 'WebGL is not available.';
  } else if (chip) {
    tier = chip.tier;
    reason = `${chip.family}: ${chip.why}`;
  } else if (known) {
    tier = known.tier;
    reason = `${known.name} (${ua.model}) uses a ${known.gpu}; the GPU name itself was hidden.`;
  } else if (ua.platform === 'desktop') {
    tier = 'high';
    reason = renderer ? `Unrecognised GPU "${renderer}" on a desktop browser.` : 'GPU name hidden on a desktop browser.';
  } else {
    tier = 'tv';
    reason = renderer ? `Unrecognised GPU "${renderer}" on a ${ua.platform} device: start lean.` : `GPU name hidden on a ${ua.platform} device: start lean.`;
  }
  if (tier === 'high' && ua.platform !== 'desktop') {
    tier = 'tv-hd';
    reason += ' Capped at tv-hd: TVs, sticks, phones and tablets never get the desktop tier.';
  }
  if (webgl === 1 && tier !== 'low') {
    tier = capTier(tier, 'low');
    reason += ' Capped at low: no WebGL2.';
  }
  return {
    tier,
    reason,
    platform: ua.platform,
    isTv: ua.isTv,
    model: ua.model,
    device: ua.device,
    gpu: cleanGpuName(renderer) || (known && !renderer ? known.gpu : ''),
    renderer,
    vendor: info.vendor || '',
    masked: Boolean(info.masked),
    webgl,
    chip: chip ? chip.id : null,
  };
}

/**
 * Reads the GPU from WebGL. Pass the app's own context to avoid creating a
 * temporary one (which costs memory on 1 GB sticks); otherwise a throwaway
 * canvas is used and its context is released straight away.
 *
 * @param {{ gl?: WebGLRenderingContext | WebGL2RenderingContext | null, document?: Document }} [opts]
 * @returns {GpuInfo}
 */
export function readGpu(opts = {}) {
  /** @type {GpuInfo} */
  const out = { renderer: '', vendor: '', masked: true, webgl: 0 };
  /** @type {any} */
  let gl = opts.gl || null;
  let temporary = false;
  try {
    if (!gl) {
      const doc = opts.document || (typeof document !== 'undefined' ? document : null);
      if (!doc) return out;
      const canvas = doc.createElement('canvas');
      canvas.width = canvas.height = 1;
      gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
      if (gl) out.webgl = 2;
      else {
        gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (gl) out.webgl = 1;
      }
      temporary = true;
    } else {
      out.webgl = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? 2 : 1;
    }
    if (!gl) return out;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      out.renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
      out.vendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '');
      out.masked = false;
    }
    // Newer Firefox returns sanitised names from RENDERER directly.
    if (!out.renderer) out.renderer = String(gl.getParameter(gl.RENDERER) || '');
    if (!out.vendor) out.vendor = String(gl.getParameter(gl.VENDOR) || '');
    if (out.renderer === 'WebKit WebGL' || out.renderer === 'Mozilla') out.renderer = '';
  } catch {
    /* blocked or lost context: keep what we have */
  } finally {
    if (temporary && gl) {
      try {
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

/**
 * Reads the GPU and user agent of the current browser and picks a tier.
 * @param {{ gl?: WebGLRenderingContext | WebGL2RenderingContext | null, document?: Document, navigator?: Navigator }} [opts]
 * @returns {Detection}
 */
export function detectDevice(opts = {}) {
  const gpu = readGpu(opts);
  const nav = opts.navigator || (typeof navigator !== 'undefined' ? navigator : undefined);
  return classifyDevice({ ...gpu, ua: nav?.userAgent || '', maxTouchPoints: nav?.maxTouchPoints || 0 });
}
