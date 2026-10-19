/**
 * The no-device lab: Fire-TV-shaped Android emulators and smoke checks.
 * See docs/LAB.md.
 */
export { runLab, LAB_HELP, labDoctorChecks, resolveModel, commandLine, quoteArg, type DoctorCheck } from './cli.js';
export * from './spec.js';
export { findSdk, avdHome, listAvds, writeAvd, metaFromSpec, installedImages, imageInstalled, type SdkTools, type LabMeta, type AvdEntry, type LabEnv } from './sdk.js';
export { runSmoke, scanLogcat, lumaStats, screenVerdict, memoryVerdict, launchVerdict, overall, type SmokeCheck, type SmokeResult, type SmokeOptions, type LogProblem } from './smoke.js';
export { smokeMarkdown, smokeHtml, HONESTY } from './report.js';
