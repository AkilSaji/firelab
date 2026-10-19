// @firelab/perf/chips: the chip table and tier vocabulary only. Pure and
// DOM-free (apart from readGpu/detectDevice), so Node tools can import it.
export { CHIPS, FIRE_TV_MODELS, classifyGpu, classifyDevice, parseUserAgent, cleanGpuName, readGpu, detectDevice } from './src/chips.js';
export { TIERS, TIER_IDS, TIER_ALIASES, isTier, normalizeTier, lighterTier, richerTier, capTier, pick } from './src/tiers.js';
