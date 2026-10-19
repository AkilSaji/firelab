/**
 * `firelab fit`: will an app run on every Fire OS model? Exports for the CLI,
 * the MCP server, the HTTP API and scripts (see docs/FIT-INTEGRATION.md).
 */
export { runFit, trimMemoryCheck, frameStats, type FitDeps, type FitPage, type FitRunOptions, type FitProgress, type SimulateOptions } from './run.js';
export { scoreFit, scoreModel, speedRefFor, DISCLAIMER, LABEL, type ScoreOptions } from './score.js';
export { fitOffline, ciGate, ciSummary, type GateResult } from './offline.js';
export { emptyMeasurement, readMeasurement, writeMeasurement, parseMeasurement, measurementProblems, MEASUREMENT_FILE } from './measurement.js';
export { fitMarkdown, fitText, COLUMNS, columnCell, activeColumns } from './markdown.js';
export { renderFitReport } from './report/html.js';
export { buildTargets, buildTarget } from './targets.js';
export { readApkFacts, apkFactsFromBuffer, manifestFeatures, requiredFeatures, missingOnTv } from './apk.js';
export { parseNeedsFlag, needsFromDeclaration, needsFromUsage, mergeNeeds, NEEDS_HOOK_SCRIPT, NEEDS_READ_SCRIPT, type DetectedUsage } from './needs.js';
export { GPU_FAMILIES, gpuFamily, CPU_FACTORS } from './gpus.js';
export { memoryBudget, budgetFromRun, budgetFromAvail, estimateBudget, RATIOS, MB_PER_MEGAPIXEL } from './memory.js';
export { fitDepsFromLab, captureDepsFromLab } from './lab.js';
export { fitDepsFromDriver, type FitDriverLike } from './driver.js';
export { runFitCli, FIT_HELP, PROFILE_HELP, MEDIA_HELP, profileDirs, type FitIo } from './cli.js';
export * from './types.js';
