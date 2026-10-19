/**
 * The individual fit checks. Each compares one kind of evidence about the
 * app with one model's facts and returns a CheckResult with a reason, a
 * fix, a basis and a confidence. Pure functions: no device access.
 */
import { abiProblem } from '../adb/apk.js';
import { TIERS as TIER_PRESETS } from '@firelab/perf/chips';
import type { Fact } from '../profile/types.js';
import { checkMedia, describeMedia, type MediaLimits, type MediaIssue } from '../media/check.js';
import type { MediaInfo } from '../media/types.js';
import { missingOnTv } from './apk.js';
import { isHard } from './needs.js';
import { MB_PER_MEGAPIXEL } from './memory.js';
import { gpuFamily } from './gpus.js';
import { hasModelDecoders } from './model-facts.js';
import { round1 } from '../lib/util.js';
import type { ApkFacts, Basis, CheckResult, CheckStatus, Confidence, FitRun, FitTarget, PressureResult, WebNeeds } from './types.js';
import type { WebCaps } from '../profile/webcaps.js';

const known = <T>(f: Fact<T> | undefined): T | undefined => (f && f.source !== 'unknown' && f.value !== null ? f.value : undefined);
const confOf = (f: Fact<unknown> | undefined): Confidence => (!f || f.source === 'unknown' ? 'low' : f.source === 'estimated' ? 'medium' : 'high');
const basisOf = (t: FitTarget, field: string): Basis => (t.fromProfile.has(field) ? 'profile' : 'estimated');
const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const minConf = (...c: Confidence[]): Confidence => c.reduce((a, b) => (CONF_RANK[b] < CONF_RANK[a] ? b : a), 'high' as Confidence);
const STATUS_RANK: Record<CheckStatus, number> = { skip: -1, pass: 0, warn: 1, fail: 2 };
export const worstStatus = (xs: CheckStatus[]): CheckStatus => xs.reduce((a, b) => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a), 'skip' as CheckStatus);

const skip = (id: CheckResult['id'], reason: string): CheckResult => ({ id, status: 'skip', summary: '–', reason, basis: 'estimated', confidence: 'low' });

// ---------- static: APK ----------

export function checkAbi(apk: ApkFacts, t: FitTarget, here: boolean): CheckResult {
  const abis = known(t.abis) ?? [];
  const basis: Basis = here ? 'measured' : basisOf(t, 'abis');
  if (!apk.nativeAbis.length) return { id: 'abi', status: 'pass', summary: 'no native code', reason: 'No native libraries: the APK runs on any CPU.', basis, confidence: 'high' };
  const problem = abiProblem(apk, abis);
  if (problem) {
    return {
      id: 'abi',
      status: 'fail',
      summary: `${apk.nativeAbis.join(', ')} only`,
      reason: `Native code for ${apk.nativeAbis.join(', ')} only, but this model runs ${abis.join(', ')}${abis.includes('arm64-v8a') ? '' : ' (32-bit ARM)'}: adb install fails with INSTALL_FAILED_NO_MATCHING_ABIS.`,
      fix: "Ship an armeabi-v7a build too: Gradle `ndk { abiFilters 'armeabi-v7a', 'arm64-v8a' }`; Unity: Player Settings > Target Architectures > ARMv7.",
      basis,
      confidence: here ? 'high' : confOf(t.abis),
    };
  }
  const match = apk.nativeAbis.filter((a) => abis.includes(a));
  return { id: 'abi', status: 'pass', summary: match.join(', '), reason: `Has native code for ${match.join(', ')}, which this model runs.`, basis, confidence: here ? 'high' : confOf(t.abis) };
}

export function checkSdk(apk: ApkFacts, t: FitTarget, here: boolean): CheckResult {
  const sdk = known(t.sdk);
  const basis: Basis = here ? 'measured' : basisOf(t, 'sdk');
  if (sdk === undefined) return skip('sdk', 'Android version of this model unknown.');
  if (apk.minSdk !== undefined && apk.minSdk > sdk) {
    return {
      id: 'sdk',
      status: 'fail',
      summary: `needs API ${apk.minSdk}`,
      reason: `minSdkVersion ${apk.minSdk}, but this model runs API ${sdk}${t.platform ? ` (${t.platform})` : ''}: adb install fails with INSTALL_FAILED_OLDER_SDK.`,
      fix: `Lower minSdkVersion to ${sdk} if the code allows it (Fire OS 7 = API 28, Fire OS 8 = API 30), or leave this model out.`,
      basis,
      confidence: here ? 'high' : confOf(t.sdk),
    };
  }
  if ((apk.targetSdk ?? 99) < 17 && sdk >= 28) {
    return { id: 'sdk', status: 'warn', summary: `target ${apk.targetSdk}`, reason: `targetSdkVersion ${apk.targetSdk}: Android ${sdk >= 30 ? 11 : 9} warns that the app was built for an older version of Android at every launch.`, fix: 'Raise targetSdkVersion (28 or later).', basis, confidence: 'high' };
  }
  return { id: 'sdk', status: 'pass', summary: `API ${apk.minSdk ?? '?'}+ on ${sdk}`, reason: `Needs API ${apk.minSdk ?? 'any'}; this model has API ${sdk}.`, basis, confidence: here ? 'high' : confOf(t.sdk) };
}

export function checkFeatures(apk: ApkFacts, t: FitTarget): CheckResult {
  const missing = missingOnTv(apk);
  const basis: Basis = t.profile ? 'profile' : 'estimated';
  if (!missing.length) return { id: 'features', status: 'pass', summary: 'TV-ready manifest', reason: 'The manifest requires no hardware a Fire TV lacks.', basis, confidence: 'high' };
  const whats = [...new Set(missing.map((x) => x.what))];
  return {
    id: 'features',
    status: 'warn',
    summary: `requires ${whats.length === 1 ? whats[0] : `${whats.length} missing features`}`,
    reason: `The manifest requires ${whats.join(', ')} (${missing.map((x) => `${x.name}: ${x.why}`).join('; ')}). Fire TVs have none of that: sideloading works, but the Amazon Appstore won't offer it on Fire TV, and code paths that use them must cope without.`,
    fix: missing.map((x) => `<uses-feature android:name="${x.name}" android:required="false"/>`).join(' ') + ' and handle the missing hardware at run time.',
    basis,
    confidence: 'high',
  };
}

export function checkLeanback(apk: ApkFacts, t: FitTarget): CheckResult {
  const basis: Basis = t.profile ? 'profile' : 'estimated';
  if (apk.leanback) return { id: 'leanback', status: 'pass', summary: 'Leanback launcher', reason: 'Has a LEANBACK_LAUNCHER activity: it shows up in Your Apps & Channels.', basis, confidence: 'high' };
  return {
    id: 'leanback',
    status: 'warn',
    summary: 'no TV launcher entry',
    reason: 'No activity with category LEANBACK_LAUNCHER: Fire TV may not show it in Your Apps & Channels (people start it from Settings > Applications), and the Appstore expects one for TV apps.',
    fix: 'Add <category android:name="android.intent.category.LEANBACK_LAUNCHER"/> to the main activity\'s intent filter and an android:banner (320x180).',
    basis,
    confidence: 'high',
  };
}

export function checkGles(apk: ApkFacts, t: FitTarget): CheckResult | undefined {
  if (apk.glEsVersion === undefined) return undefined;
  const es = known(t.glEs);
  if (es === undefined) return skip('gles', `Needs OpenGL ES ${apk.glEsVersion}; this model's GPU is unknown.`);
  if (apk.glEsVersion > es + 1e-6) {
    return {
      id: 'gles',
      status: 'fail',
      summary: `needs ES ${apk.glEsVersion}`,
      reason: `Requires OpenGL ES ${apk.glEsVersion}; the ${t.gpu} supports ES ${es}. The GL context can't be created.`,
      fix: `Add an OpenGL ES ${es} rendering path, or leave this model out.`,
      basis: basisOf(t, 'gpu'),
      confidence: 'high',
    };
  }
  return { id: 'gles', status: 'pass', summary: `ES ${apk.glEsVersion} ≤ ${es}`, reason: `Requires OpenGL ES ${apk.glEsVersion}; the ${t.gpu} supports ES ${es}.`, basis: basisOf(t, 'gpu'), confidence: 'high' };
}

// ---------- static: web ----------

/** Chromium major that introduced each feature in Android WebView. */
const FEATURE_SINCE: Record<string, number | null> = {
  wasm: 57,
  'wasm-simd': 91,
  'wasm-threads': 74,
  'offscreen-canvas': 69,
  'shared-array-buffer': 92,
  'web-audio': 35,
  gamepad: 45,
  'media-source': 35,
  workers: 30,
  webgpu: null,
};

type Issue = { status: CheckStatus; short: string; text: string; fix?: string; conf: Confidence };

export function checkWebgl(needs: WebNeeds | undefined, t: FitTarget, here: boolean, caps?: WebCaps): CheckResult {
  if (!needs) return skip('webgl', 'No web needs known: pass --url with a device, --needs, or declare window.firelab.needs.');
  const issues: Issue[] = [];
  const ok: string[] = [];
  const soft = (k: Parameters<typeof isHard>[1]) => !isHard(needs, k);
  // On the measured device itself, the page's own caps are the truth.
  const live = here && caps ? caps : undefined;
  const webgl2 = live ? !!live.webgl2 : known(t.webgl.webgl2);
  const maxTex = live ? (live.webgl2 ?? live.webgl1)?.maxTextureSize : known(t.webgl.maxTextureSize);
  const maxRb = live ? (live.webgl2 ?? live.webgl1)?.maxRenderbufferSize : known(t.webgl.maxRenderbufferSize);
  const compressed = live ? live.compressed : known(t.webgl.compressed);
  const exts = live ? [...(live.webgl2?.extensions ?? []), ...(live.webgl1?.extensions ?? [])] : known(t.webgl.extensions);
  const floatRender = live ? live.floatRender : known(t.webgl.floatRender);
  const wv = live?.chromeMajor ?? known(t.webviewMajor);
  if (needs.webgl === 2) {
    if (webgl2 === false) {
      issues.push({
        status: soft('webgl') ? 'warn' : 'fail',
        short: 'no WebGL2',
        text: soft('webgl') ? `The page used WebGL2, which the ${t.gpu} can't do; it only works here if it falls back to WebGL1.` : `Needs WebGL2; the ${t.gpu} is ${known(t.glEs) === 2 ? 'OpenGL ES 2 hardware' : 'not WebGL2-capable'}, so the page can't create its context.`,
        fix: 'Add a WebGL1 fallback (three.js r162 or older still has one), or leave this model out.',
        conf: live ? 'high' : confOf(t.webgl.webgl2),
      });
    } else if (webgl2 === undefined) issues.push({ status: 'warn', short: 'WebGL2 unknown', text: 'WebGL2 support on this model is not known (its WebView may blocklist the GPU).', conf: 'low' });
    else ok.push('WebGL2');
  }
  const limit = (need: number | undefined, have: number | undefined, label: string, key: 'maxTextureSize' | 'maxRenderbufferSize') => {
    if (!need) return;
    if (have === undefined) {
      if (need > 4096) issues.push({ status: 'warn', short: `${label} limit unknown`, text: `Uses ${label}s up to ${need} px; this model's limit is not known (4096 is safe everywhere we know).`, conf: 'low' });
      return;
    }
    if (need > have) issues.push({ status: soft(key) ? 'warn' : 'fail', short: `${label} ${need} > ${have}`, text: `Uses ${label}s up to ${need} px; this model's limit is ${have}.`, fix: `Cap ${label}s at ${have} px on this hardware (pick sizes from gl.getParameter at run time).`, conf: live ? 'high' : 'medium' });
    else ok.push(`${label} ${need} ≤ ${have}`);
  };
  limit(needs.maxTextureSize, maxTex, 'texture', 'maxTextureSize');
  limit(needs.maxRenderbufferSize, maxRb, 'render target', 'maxRenderbufferSize');
  if (needs.compressed?.length && compressed) {
    const any = needs.compressed.filter((c) => compressed.includes(c));
    if (!any.length) {
      issues.push({
        status: soft('compressed') ? 'warn' : 'fail',
        short: `no ${needs.compressed.map((c) => c.toUpperCase()).join('/')}`,
        text: `Uploads ${needs.compressed.map((c) => c.toUpperCase()).join('/')} textures; this model decodes ${compressed.map((c) => c.toUpperCase()).join(', ') || 'none of those'}. ${soft('compressed') ? 'Fine if they come from a KTX2/Basis transcoder that picks per device; broken if shipped raw.' : ''}`.trim(),
        fix: 'Ship KTX2 (Basis Universal) textures and let the transcoder pick ETC2/ASTC/ETC1 per device, or add an ETC2 set (every WebGL2 device decodes it).',
        conf: live ? 'high' : confOf(t.webgl.compressed),
      });
    } else ok.push(any.map((c) => c.toUpperCase()).join('/'));
  }
  if (needs.extensions?.length) {
    if (exts) {
      const missing = needs.extensions.filter((e) => !exts.includes(e));
      if (missing.length) issues.push({ status: soft('extensions') ? 'warn' : 'fail', short: `no ${missing[0]}`, text: `Needs ${missing.join(', ')}, which this model's WebGL doesn't offer.`, fix: 'Feature-detect the extension and use a fallback path.', conf: live ? 'high' : 'medium' });
      else ok.push(needs.extensions.join(', '));
    } else issues.push({ status: 'warn', short: 'extensions unknown', text: `Needs ${needs.extensions.join(', ')}; this model's extension list hasn't been captured.`, conf: 'low' });
  }
  if (needs.floatRender) {
    if (floatRender === false) issues.push({ status: soft('floatRender') ? 'warn' : 'fail', short: 'no float targets', text: 'Renders to float color buffers; this model offers neither EXT_color_buffer_float nor _half_float.', fix: 'Fall back to RGBA8 render targets (with encoding) on this hardware.', conf: live ? 'high' : 'medium' });
    else if (floatRender === undefined) issues.push({ status: 'warn', short: 'float targets unknown', text: 'Renders to float color buffers; support on this model is not known.', conf: 'low' });
    else ok.push('float render targets');
  }
  if (needs.minWebView) {
    if (wv === undefined) issues.push({ status: 'warn', short: 'WebView version unknown', text: `Needs WebView ${needs.minWebView}+; the WebView version on ${t.platform ?? 'this model'} isn't recorded.`, conf: 'low' });
    else if (wv < needs.minWebView) issues.push({ status: soft('minWebView') ? 'warn' : 'fail', short: `WebView ${wv} < ${needs.minWebView}`, text: `Needs WebView ${needs.minWebView}+; this model has ${wv}.`, fix: 'Polyfill or feature-detect what the newer WebView adds.', conf: live ? 'high' : confOf(t.webviewMajor) });
    else ok.push(`WebView ${wv}`);
  }
  for (const f of needs.features ?? []) {
    const liveHas = live?.features?.[f];
    if (liveHas !== undefined) {
      if (!liveHas) issues.push({ status: soft('features') ? 'warn' : 'fail', short: `no ${f}`, text: `Needs ${f}, which this WebView doesn't offer.`, conf: 'high' });
      else ok.push(f);
      continue;
    }
    const since = FEATURE_SINCE[f];
    if (since === null) issues.push({ status: soft('features') ? 'warn' : 'fail', short: `no ${f}`, text: `Needs ${f}, which Fire TV WebViews don't offer.`, conf: 'medium' });
    else if (since === undefined || wv === undefined) issues.push({ status: 'warn', short: `${f} unknown`, text: `Needs ${f}; support on this model is not known.`, conf: 'low' });
    else if (wv < since) issues.push({ status: soft('features') ? 'warn' : 'fail', short: `no ${f}`, text: `Needs ${f} (WebView ${since}+); this model has ${wv}.`, conf: confOf(t.webviewMajor) });
    else ok.push(f);
  }
  const status = issues.length ? worstStatus(issues.map((i) => i.status)) : 'pass';
  const decisive = issues.filter((i) => i.status === status);
  const basis: Basis = live ? 'measured' : t.fromProfile.has('webgl2') || t.fromProfile.has('maxTextureSize') || t.fromProfile.has('compressed') ? 'profile' : 'estimated';
  const confidence = status === 'pass' ? (live ? 'high' : minConf(confOf(t.webgl.webgl2), 'medium')) : decisive.reduce<Confidence>((a, i) => (CONF_RANK[i.conf] > CONF_RANK[a] ? i.conf : a), 'low');
  const fixes = [...new Set(decisive.map((i) => i.fix).filter((x): x is string => !!x))];
  return {
    id: 'webgl',
    status,
    summary: status === 'pass' ? (ok[0] ?? 'ok') : `${decisive[0]?.short ?? status}${decisive.length > 1 ? ` +${decisive.length - 1}` : ''}`,
    reason: status === 'pass' ? `Has what the page needs${ok.length ? `: ${ok.join(', ')}` : ''}.` : decisive.map((i) => i.text).join(' '),
    ...(fixes.length ? { fix: fixes.join('\n') } : {}),
    basis,
    confidence,
  };
}

// ---------- measured: memory and frames ----------

const TIER_ORDER = ['low', 'tv', 'tv-hd', 'high'];
const tierRank = (t?: string) => (t ? TIER_ORDER.indexOf(t) : -1);

export type RunPick = { run: FitRun; match: 'tier' | 'untiered' | 'richer' | 'lighter' };

/** The run that best stands for this target: same tier, else the nearest richer (pessimistic), else lighter. */
export function pickRun(runs: FitRun[], tier: string | undefined, need: 'memory' | 'frames'): RunPick | undefined {
  const usable = runs.filter((r) => !r.simulated && (need === 'memory' ? r.memory?.totalMB !== undefined : r.frames !== undefined));
  if (!usable.length) return undefined;
  if (tier) {
    const same = usable.find((r) => r.tier === tier);
    if (same) return { run: same, match: 'tier' };
  }
  const tiered = usable.filter((r) => tierRank(r.tier) >= 0);
  if (!tiered.length || !tier) return { run: usable[0] as FitRun, match: 'untiered' };
  const want = tierRank(tier);
  const richer = tiered.filter((r) => tierRank(r.tier) > want).sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
  if (richer[0]) return { run: richer[0], match: 'richer' };
  const lighter = tiered.filter((r) => tierRank(r.tier) < want).sort((a, b) => tierRank(b.tier) - tierRank(a.tier));
  return { run: (lighter[0] ?? tiered[0]) as FitRun, match: 'lighter' };
}

const maxHeightOf = (tier?: string): number | undefined => (tier && tier in TIER_PRESETS ? TIER_PRESETS[tier as keyof typeof TIER_PRESETS].maxHeight : undefined);

export function checkMemory(runs: FitRun[], t: FitTarget, here: boolean): CheckResult {
  const pick = pickRun(runs, t.tier, 'memory');
  if (!pick) return skip('memory', 'Memory not measured (needs a device and a running app).');
  const { run, match } = pick;
  const mem = run.memory as NonNullable<FitRun['memory']>;
  const measured = mem.totalMB as number;
  const budget = known(t.memory.budgetMB);
  const limit = known(t.memory.limitMB);
  if (budget === undefined || limit === undefined) return skip('memory', 'No memory budget for this model.');
  let total = measured;
  const notes: string[] = [];
  let adjusted = false;
  if (!here && match === 'richer' && run.canvas) {
    const hRun = maxHeightOf(run.tier);
    const hT = maxHeightOf(t.tier);
    if (hRun && hT && hT < hRun) {
      const mpRun = (run.canvas.width * run.canvas.height) / 1e6;
      const mpT = mpRun * (hT / hRun) ** 2;
      const saved = Math.max(0, (mpRun - mpT) * MB_PER_MEGAPIXEL);
      total = round1(measured - saved);
      adjusted = saved > 1;
      if (adjusted) notes.push(`Measured ${Math.round(measured)} MB at ${run.tier} (${run.canvas.width}x${run.canvas.height}); this model would use ${t.tier}, about ${Math.round(saved)} MB less at ~${MB_PER_MEGAPIXEL} MB per megapixel of canvas (estimated).`);
    }
  } else if (!here && match === 'richer') notes.push(`Measured at ${run.tier}; this model would use ${t.tier}, which likely needs less.`);
  else if (!here && match === 'lighter') notes.push(`Measured at ${run.tier}; this model would use the richer ${t.tier}, which likely needs more.`);
  const parts = mem.appPssMB !== undefined ? ` (app ${Math.round(mem.appPssMB)} + WebView renderer ${Math.round(mem.rendererPssMB ?? 0)} MB)` : '';
  let status: CheckStatus = total <= budget ? 'pass' : total <= limit ? 'warn' : 'fail';
  // RAM not published (most smart TVs): the budget assumes 1 GB, so it can't prove a failure.
  const ramUnknown = !here && t.ramMB === undefined && !t.fromProfile.has('memory');
  if (ramUnknown && status === 'fail') status = 'warn';
  let reason =
    status === 'pass'
      ? `Uses about ${Math.round(total)} MB${parts}; this model's budget is ${budget} MB (limit ${limit} MB).`
      : status === 'warn'
        ? `Uses about ${Math.round(total)} MB${parts}, over this model's comfortable ${budget} MB (limit ${limit} MB). It will likely run, but Fire OS will close background apps to make room, and leaving and coming back may restart it.`
        : `Uses about ${Math.round(total)} MB${parts}, above this model's ${limit} MB limit: expect the low-memory killer to close it, or the WebView renderer to crash (white screen or reload).`;
  if (here && mem.memAvailableMinMB !== undefined) {
    if (mem.memAvailableMinMB < 50 && status === 'pass') status = 'warn';
    reason += ` MemAvailable went down to ${Math.round(mem.memAvailableMinMB)} MB during the run${mem.memAvailableMinMB < 50 ? ': close to the low-memory killer' : ''}.`;
  }
  if (ramUnknown && total > budget) notes.push(`Amazon doesn't publish this model's RAM, so the budget assumes 1 GB (worst case); with 1.5-2 GB it would fit.`);
  if (notes.length) reason += ` ${notes.join(' ')}`;
  const basis: Basis = here ? 'measured' : basisOf(t, 'memory');
  let confidence: Confidence = here ? 'high' : t.fromProfile.has('memory') ? 'medium' : 'low';
  if (!here && confidence === 'low' && (total < budget * 0.75 || total > limit * 1.25)) confidence = 'medium';
  if (adjusted || match === 'lighter') confidence = minConf(confidence, 'medium');
  if (ramUnknown) confidence = 'low';
  return {
    id: 'memory',
    status,
    summary: `${Math.round(total)} / ${budget} MB`,
    reason,
    ...(status !== 'pass'
      ? { fix: `Bring app + WebView memory under ${budget} MB: compressed textures (KTX2: ETC2/ASTC), dispose unused geometry and textures, a lower render resolution on ${t.tier ?? 'this tier'} (@firelab/perf adaptive resolution), no long-lived decoded video or audio buffers.` }
      : {}),
    basis,
    confidence,
    data: { totalMB: total, measuredMB: measured, budgetMB: budget, limitMB: limit, run: run.label, match },
  };
}

/** Frame-rate thresholds, as fractions of the target fps. */
export const PASS_MEDIAN = 0.8;
export const PASS_P95 = 0.6;
export const WARN_MEDIAN = 0.5;

export type SpeedRef = { factor: number; source: Fact<number>['source']; name: string; gpu?: string };

export function checkFrames(runs: FitRun[], t: FitTarget, here: boolean, device: SpeedRef | undefined, targetFps: number): CheckResult {
  // A simulation of this model (or its GPU family) beats scaling.
  const fam = (g?: string) => gpuFamily(g)?.id;
  const sim =
    runs.find((r) => r.simulated && r.frames && r.simulated.forModel === t.model) ??
    runs.find((r) => r.simulated && r.frames && r.simulated.forGpu && t.gpu && fam(r.simulated.forGpu) !== undefined && fam(r.simulated.forGpu) === fam(t.gpu));
  // Playable, not "holds the tier" (that is the sweep's stricter rule): a median of at least 80% of the
  // target with p95 frames no slower than 60% of it passes; below half the target is unplayable.
  const judge = (fps: number, p95fps: number): CheckStatus => (fps >= targetFps * PASS_MEDIAN && p95fps >= targetFps * PASS_P95 ? 'pass' : fps >= targetFps * WARN_MEDIAN ? 'warn' : 'fail');
  if (sim && !here) {
    const f = sim.frames as NonNullable<FitRun['frames']>;
    const p95fps = 1000 / f.frameMsP95;
    const status = judge(f.fpsMedian, p95fps);
    const kinds = sim.simulated?.kinds ?? [];
    return {
      id: 'frames',
      status,
      summary: `~${Math.round(f.fpsMedian)} fps (sim)`,
      reason: `About ${round1(f.fpsMedian)} fps (p95 frame ${Math.round(f.frameMsP95)} ms), estimated (simulated) on ${device?.name ?? 'the measured device'} with ${kinds.map((k) => (k === 'cpu' ? `the CPU throttled ${sim.simulated?.cpuRate}x` : `${sim.simulated?.pixelFactor}x the pixels`)).join(' and ')} to imitate ${sim.simulated?.forModel === t.model ? 'this model' : `the ${sim.simulated?.forModel} (same GPU)`}.${status === 'pass' ? '' : ` Target: ${targetFps} fps.`}`,
      ...(status !== 'pass' ? { fix: framesFix(t) } : {}),
      basis: 'estimated',
      confidence: kinds.length >= 2 ? 'medium' : 'low',
      simulated: true,
      data: { fps: f.fpsMedian, frameMsP95: f.frameMsP95, run: sim.label },
    };
  }
  const pick = pickRun(runs, t.tier, 'frames');
  if (!pick) return skip('frames', 'Frame rate not measured.');
  const { run, match } = pick;
  const f = run.frames as NonNullable<FitRun['frames']>;
  if (here) {
    const p95fps = 1000 / f.frameMsP95;
    const status = f.samples < 5 ? 'warn' : judge(f.fpsMedian, p95fps);
    return {
      id: 'frames',
      status,
      summary: `${round1(f.fpsMedian)} fps`,
      reason: `${round1(f.fpsMedian)} fps median, p10 ${round1(f.fpsP10)} fps, p95 frame ${Math.round(f.frameMsP95)} ms over ${f.samples} s${run.tier ? ` at ${run.tier}` : ''}, measured on this model.${f.samples < 5 ? ' Too few samples to judge: measure longer.' : ''}`,
      ...(status !== 'pass' ? { fix: framesFix(t) } : {}),
      basis: 'measured',
      confidence: f.samples >= 10 ? 'high' : 'medium',
      data: { fps: f.fpsMedian, frameMsP95: f.frameMsP95, run: run.label },
    };
  }
  if (!device) return skip('frames', 'The measured device has no speed factor, so frames can\'t be scaled.');
  const targetFactor = known(t.speed) ?? 1;
  const ratio = device.factor / targetFactor;
  const estP50 = f.frameMsP50 * ratio;
  const estP95 = f.frameMsP95 * ratio;
  // A faster model can't beat the app's frame cap (the target, or what a capped run held).
  let fps = Math.min(1000 / estP50, f.capped ? f.fpsMedian : Math.max(targetFps, f.fpsMedian));
  fps = round1(fps);
  const p95fps = 1000 / estP95;
  let status = judge(fps, p95fps);
  const notes: string[] = [];
  let confidence: Confidence = device.source === 'measured' && t.speed.source === 'measured' ? 'medium' : 'low';
  if (f.capped && ratio > 1 && status !== 'pass') {
    status = 'warn';
    confidence = 'low';
    notes.push(`The run held the app's ${round1(f.fpsMedian)} fps cap, so its real headroom is unknown: on this model it lands between ${Math.round(fps)} and ${Math.round(f.fpsMedian)} fps. Run with --simulate cpu,gpu (or uncap the frame rate) to narrow it.`);
  }
  if (match === 'richer') {
    notes.push(`Measured at ${run.tier}; this model would use ${t.tier}, which is lighter${status === 'fail' ? ', so this is a worst case' : ''}. Measure ${t.tier} too (--tiers ${t.tier},${run.tier}).`);
    if (status === 'fail') status = 'warn';
    confidence = 'low';
  } else if (match === 'lighter') {
    notes.push(`Measured at ${run.tier}; this model would use the richer ${t.tier}, so expect less than this.`);
    confidence = 'low';
  }
  const how = `scaled from ${round1(f.fpsMedian)} fps on ${device.name} by the GPU speed ratio (${round1(device.factor)} / ${round1(targetFactor)} = ${round1(ratio)}x${t.speed.source === 'measured' ? '' : ', estimated'})`;
  const head = status === 'pass' ? `About ${fps} fps, ${how}.` : status === 'warn' ? `About ${fps} fps, ${how}: below the ${targetFps} fps target; playable but not smooth.` : `About ${fps} fps, ${how}: unplayable.`;
  return {
    id: 'frames',
    status,
    summary: `~${Math.round(fps)} fps`,
    reason: [head, ...notes].join(' '),
    ...(status !== 'pass' ? { fix: framesFix(t) } : {}),
    basis: 'estimated',
    confidence,
    data: { fps, frameMsP50: round1(estP50), frameMsP95: round1(estP95), ratio: round1(ratio), run: run.label, match },
  };
}

const TIER_DESC: Record<string, string> = { low: 'minimal effects, 540p', tv: 'no shadows, a 720p cap', 'tv-hd': 'up to 1080p with sun shadows', high: 'desktop effects' };

function framesFix(t: FitTarget): string {
  const i = TIER_ORDER.indexOf(t.tier ?? '');
  const lighter = i > 0 ? TIER_ORDER[i - 1] : undefined;
  const tier = lighter ? `Make ${t.gpu ?? 'this GPU'} use a lighter tier than ${t.tier}: ${lighter} (${TIER_DESC[lighter]}), with adaptive resolution; @firelab/perf picks tiers by chip.` : `Cut work for ${t.gpu ?? 'this GPU'} below the ${t.tier ?? 'lightest'} tier.`;
  return `${tier}\nCut draw calls and per-pixel work (on a GE8300, MSAA cost 15-25% and IBL was the costliest effect). Confirm with firelab sweep on the real stick.`;
}

// ---------- simulated: memory pressure ----------

export function checkPressure(p: PressureResult | undefined, t: FitTarget, memoryStatus: CheckStatus): CheckResult {
  if (!p) return skip('pressure', 'Memory pressure not simulated (--simulate trim).');
  if (p.outcome === 'unknown') return { ...skip('pressure', `Memory pressure: ${p.detail}`), simulated: true };
  const tight = memoryStatus === 'warn' || memoryStatus === 'fail';
  if (p.outcome === 'survived') return { id: 'pressure', status: 'pass', summary: 'survived trim', reason: `Survived ${p.level} memory pressure without restarting (estimated (simulated)). ${p.detail}`, basis: 'estimated', confidence: 'medium', simulated: true };
  const status: CheckStatus = p.outcome === 'crashed' && tight ? 'fail' : 'warn';
  return {
    id: 'pressure',
    status,
    summary: p.outcome === 'crashed' ? 'crashed under pressure' : 'reloaded under pressure',
    reason: `${p.outcome === 'crashed' ? 'The app process died' : 'The page reloaded (its WebView renderer was killed)'} under simulated ${p.level} memory pressure. ${tight ? 'Memory on this model is already tight, so expect it for real.' : 'On 1 GB models this happens for real when memory runs low.'} ${p.detail}`.trim(),
    fix: 'Handle onTrimMemory / the page being reloaded: save progress often (localStorage), restore it on load, and free caches when the page is hidden.',
    basis: 'estimated',
    confidence: tight ? 'medium' : 'low',
    simulated: true,
  };
}

// ---------- media ----------

export function mediaLimits(t: FitTarget): MediaLimits {
  const decoders = known(t.decoders);
  const ok = known(t.streamOkMbps);
  const stall = known(t.streamStallMbps);
  return {
    name: t.name,
    ...(decoders ? { decoders } : {}),
    decodersFrom: t.fromProfile.has('decoders') ? 'measured' : !decoders ? 'unknown' : hasModelDecoders(t.model) ? 'estimated' : 'generic',
    ...(ok ? { streamOkMbps: ok } : {}),
    ...(stall ? { streamStallMbps: stall } : {}),
    ...(ok || stall ? { streamFrom: t.fromProfile.has('streamStallMbps') ? ('measured' as const) : ('estimated' as const) } : {}),
  };
}

const fileName = (s: string) => s.replace(/[?#].*$/, '').split(/[\\/]/).pop() || s;

export function checkMediaOn(media: MediaInfo[], t: FitTarget): { result: CheckResult; perFile: { source: string; issues: MediaIssue[] }[] } {
  if (!media.length) return { result: skip('media', 'No media checked (--media <file|folder|url>, or media the page loads).'), perFile: [] };
  const lim = mediaLimits(t);
  const perFile = media.map((m) => ({ source: m.source, issues: checkMedia(m, lim) }));
  // File-level problems (fast start, unreadable) are the same on every model: they go in the media
  // findings, not in each model's verdict.
  const all = perFile.flatMap((f) => f.issues.filter((i) => i.scope === 'model').map((i) => ({ ...i, file: fileName(f.source) })));
  const status: CheckStatus = all.length ? worstStatus(all.map((i) => i.status)) : 'pass';
  const decisive = all.filter((i) => i.status === status);
  const basis: Basis = t.fromProfile.has('decoders') || t.fromProfile.has('streamStallMbps') ? 'profile' : 'estimated';
  const confidence = status === 'pass' ? (basis === 'profile' ? 'high' : 'medium') : decisive.reduce<Confidence>((a, i) => (CONF_RANK[i.confidence] > CONF_RANK[a] ? i.confidence : a), 'low');
  const fixes = [...new Set(decisive.map((i) => i.fix).filter((x): x is string => !!x))];
  return {
    result: {
      id: 'media',
      status,
      summary: status === 'pass' ? `${media.length} file${media.length === 1 ? '' : 's'} ok` : `${decisive[0]?.short ?? 'issue'}${decisive.length > 1 ? ` +${decisive.length - 1}` : ''}`,
      reason: status === 'pass' ? `${media.length} file${media.length === 1 ? '' : 's'} within this model's decoder limits (${media.map((m) => describeMedia(m)).slice(0, 2).join('; ')}).` : decisive.map((i) => `${i.file}: ${i.reason}`).join(' '),
      ...(fixes.length ? { fix: fixes.join('\n') } : {}),
      basis,
      confidence,
    },
    perFile,
  };
}
