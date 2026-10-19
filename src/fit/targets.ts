/**
 * Builds one FitTarget per Fire TV model: the facts fit compares against,
 * from the model's device profile when there is one, else from
 * src/adb/models.ts plus the GPU, memory and model tables (estimated).
 */
import { FIRE_TV_MODELS, tierForGpu, type FireTvModel } from '../adb/models.js';
import { fact, type DeviceProfile, type Fact } from '../profile/types.js';
import { gpuFamily, CPU_FACTORS, DEFAULT_TV_CPU } from './gpus.js';
import { memoryBudget } from './memory.js';
import { ABIS_32, ABIS_64, ARM64_MODELS, FIRE_OS_SDK, estimatedDecoders, estimatedDisplay, estimatedWebViewMajor } from './model-facts.js';
import type { FitTarget } from './types.js';

const known = <T>(f: Fact<T> | undefined): f is Fact<T> & { value: T } => !!f && f.source !== 'unknown' && f.value !== null;

/** Profile fact if known (and remembered as from the profile), else the fallback. */
function pick<T>(name: string, from: Set<string>, pf: Fact<T> | undefined, fallback: Fact<T>): Fact<T> {
  if (known(pf)) {
    from.add(name);
    return pf;
  }
  return fallback;
}

export function buildTarget(m: FireTvModel, profile?: DeviceProfile): FitTarget {
  const from = new Set<string>();
  const fireOsMajor = Number(/Fire OS (\d)/.exec(m.platform ?? '')?.[1]) || undefined;
  const os = fireOsMajor ? FIRE_OS_SDK[fireOsMajor] : undefined;
  const gpu = (known(profile?.gpu.renderer) ? profile?.gpu.renderer.value : undefined) ?? m.gpu;
  const fam = gpuFamily(gpu);
  const p = profile;
  if (known(profile?.gpu.renderer)) from.add('gpu');

  const sdk = pick('sdk', from, p?.os.sdk, os ? fact(os.sdk, 'spec', `${m.platform} = Android ${os.android} (API ${os.sdk}), the Fire OS it shipped with`) : fact<number>(null, 'unknown'));
  const abis = pick(
    'abis',
    from,
    p?.cpu.abis,
    ARM64_MODELS.has(m.model)
      ? fact(ABIS_64, 'estimated', '64-bit userspace (estimated from the SoC)')
      : fact(ABIS_32, 'estimated', 'Fire TV sticks and most Fire TV smart TVs run a 32-bit ARM userspace'),
  );
  const glEs = fam ? fact(fam.glEs, 'spec', `${fam.family} supports OpenGL ES ${fam.glEs}`) : fact<number>(null, 'unknown');

  const budget = memoryBudget({
    ramMB: m.ramMB,
    totalMB: p?.memory.totalMB,
    appBudgetMB: p?.memory.appBudgetMB,
    appLimitMB: p?.memory.appLimitMB,
    knownGoodMB: p?.memory.knownGoodMB,
    lowestAvailMB: p?.memory.lowestAvailMB,
    availWebViewMB: p?.memory.availWebViewMB,
  });
  if (p && (known(p.memory.appBudgetMB) || known(p.memory.knownGoodMB) || known(p.memory.availWebViewMB))) from.add('memory');

  const speed = pick(
    'speed',
    from,
    p?.gpu.speedFactor,
    fam ? fact(fam.factor, fam.source, `${fam.family}: ${fam.why}`) : fact(1, 'estimated', `"${gpu ?? 'unknown GPU'}" is not in the speed table: assumed GE8300 speed`),
  );
  const cpuRow = CPU_FACTORS[m.model] ?? (m.kind === 'tv' ? DEFAULT_TV_CPU : undefined);
  const cpuSpeed = cpuRow ? fact(cpuRow.factor, m.model === 'AFTSSS' ? 'measured' : 'estimated', cpuRow.cpu) : fact(1, 'estimated', 'CPU unknown: assumed Fire TV Stick (3rd gen) speed');

  const famNote = fam ? `${fam.family} (estimated from the GPU family)` : 'GPU family unknown';
  const webgl2Fallback: Fact<boolean> = !fam
    ? fact<boolean>(null, 'unknown')
    : fam.webgl2 === false
      ? fact(false, 'spec', `${fam.family} is OpenGL ES 2 hardware: WebGL2 is impossible`)
      : fam.webgl2 === true
        ? fact(true, 'estimated', `${fam.family} supports OpenGL ES ${fam.glEs}`)
        : fact<boolean>(null, 'unknown', `${fam.family}: WebGL2 depends on the WebView's GPU blocklist`);
  const webgl = {
    webgl2: pick('webgl2', from, p?.webgl.webgl2, webgl2Fallback),
    maxTextureSize: pick('maxTextureSize', from, p?.webgl.maxTextureSize, fam?.maxTextureSize ? fact(fam.maxTextureSize, 'estimated', famNote) : fact<number>(null, 'unknown')),
    maxRenderbufferSize: pick('maxRenderbufferSize', from, p?.webgl.maxRenderbufferSize, fam?.maxTextureSize ? fact(fam.maxTextureSize, 'estimated', famNote) : fact<number>(null, 'unknown')),
    compressed: pick('compressed', from, p?.webgl.compressed, fam ? fact(fam.compressed, 'estimated', famNote) : fact<string[]>(null, 'unknown')),
    extensions: pick('extensions', from, p?.webgl.extensions, fact<string[]>(null, 'unknown')),
    floatRender: pick('floatRender', from, p?.webgl.floatRender, fact<boolean>(null, 'unknown')),
  };
  const wvMajor = estimatedWebViewMajor(fireOsMajor);
  const webviewMajor = pick(
    'webviewMajor',
    from,
    p?.webview.major,
    wvMajor ? fact(wvMajor, 'estimated', `${m.platform} gets Amazon WebView updates (138 measured on a Fire TV Stick 3rd gen, Oct 2026)`) : fact<number>(null, 'unknown', `${m.platform ?? 'This Fire OS'} ships an older, unrecorded WebView`),
  );
  const decoders = pick('decoders', from, p?.media.decoders, fact(estimatedDecoders(m.model, m.name, m.kind), 'estimated', 'estimated from the SoC'));
  // Streaming thresholds: measured on AFTSSS; same hardware (GE8300 sticks) inherits them as estimates.
  const ge8300Stick = /GE8300/i.test(gpu ?? '') && m.kind === 'stick';
  const streamOk = pick('streamOkMbps', from, p?.media.streamOkMbps, ge8300Stick ? fact(4.5, 'estimated', 'measured on a Fire TV Stick (3rd gen), same hardware') : fact<number>(null, 'unknown'));
  const streamStall = pick('streamStallMbps', from, p?.media.streamStallMbps, ge8300Stick ? fact(6.7, 'estimated', 'measured on a Fire TV Stick (3rd gen), same hardware') : fact<number>(null, 'unknown'));
  const disp = estimatedDisplay(m.name, m.kind);

  return {
    model: m.model,
    name: p?.name ?? m.name,
    kind: m.kind,
    ...(m.year ? { year: m.year } : {}),
    ...(m.ramMB ? { ramMB: m.ramMB } : {}),
    ...(gpu ? { gpu } : {}),
    ...(m.platform ? { platform: m.platform } : {}),
    ...(fireOsMajor ? { fireOsMajor } : {}),
    ...(tierForGpu(gpu) ? { tier: tierForGpu(gpu) } : {}),
    vega: /vega/i.test(m.platform ?? ''),
    ...(p ? { profile: { source: p.source, capturedAt: p.capturedAt } } : {}),
    sdk,
    abis,
    glEs,
    memory: budget,
    speed,
    cpuSpeed,
    webgl,
    webviewMajor,
    decoders,
    streamOkMbps: streamOk,
    streamStallMbps: streamStall,
    display: {
      width: pick('displayWidth', from, p?.display.width, fact(disp.width, 'estimated', 'Fire OS UI resolution')),
      height: pick('displayHeight', from, p?.display.height, fact(disp.height, 'estimated', 'Fire OS UI resolution')),
    },
    fromProfile: from,
  };
}

/** Targets for every model in src/adb/models.ts (or just `models`), using profiles where they exist. */
export function buildTargets(profiles: Map<string, DeviceProfile> = new Map(), models?: string[]): FitTarget[] {
  const want = models?.length ? new Set(models.map((x) => x.toUpperCase())) : undefined;
  const list: FireTvModel[] = [...FIRE_TV_MODELS];
  // Profiles for models the table doesn't know yet still count.
  for (const [model, p] of profiles) {
    if (!list.some((m) => m.model.toUpperCase() === model)) {
      list.push({ model: p.model, name: p.name, kind: /tv/i.test(p.name) && !/stick|cube/i.test(p.name) ? 'tv' : 'stick', ...(p.gpu.renderer.value ? { gpu: p.gpu.renderer.value } : {}), ...(p.os.fireOs.value ? { platform: `Fire OS ${p.os.fireOs.value.split('.')[0]}` } : {}) });
    }
  }
  return list.filter((m) => !want || want.has(m.model.toUpperCase())).map((m) => buildTarget(m, profiles.get(m.model.toUpperCase())));
}
