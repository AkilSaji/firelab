// @firelab/perf: chip detection, quality tiers, adaptive resolution, an
// on-screen meter and the window.firelab hook for TV web apps and games.
// Dependency-free ES modules; no build step. MIT licensed.

export { createPerf, browserEnv } from './src/perf.js';
export { TIERS, TIER_IDS, TIER_ALIASES, isTier, normalizeTier, lighterTier, richerTier, capTier, pick } from './src/tiers.js';
export { CHIPS, FIRE_TV_MODELS, classifyGpu, classifyDevice, parseUserAgent, cleanGpuName, readGpu, detectDevice } from './src/chips.js';
export { resolveTier, readFallback, safeStorage } from './src/resolve.js';
export { createAdaptiveResolution } from './src/adaptive.js';
export { createFrameStats, percentile, sortedPercentile, median } from './src/stats.js';
export { createFrameLimiter } from './src/limiter.js';
export { createHookObject, updateHook, validateHook, HOOK_VERSION } from './src/hook.js';
export { createMeter } from './src/meter.js';
export { createTapDetector, listenForToggle, keyNames, DEFAULT_TOGGLE_KEYS } from './src/keys.js';
export { threeAdapter, babylonAdapter, pixiAdapter, canvasAdapter, autoAdapter, computeScaleInfo } from './src/adapters.js';
