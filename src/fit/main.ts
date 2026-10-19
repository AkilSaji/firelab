#!/usr/bin/env node
/**
 * Standalone entry for the fit commands (the main CLI also runs them: firelab fit|profile|media):
 *   node dist/fit/main.js fit --offline firelab-measurement.json
 *   node dist/fit/main.js profile -d 192.168.1.194
 *   node dist/fit/main.js media ./videos
 */
import { runFitCli, FIT_HELP, PROFILE_HELP, MEDIA_HELP } from './cli.js';

const [command, ...argv] = process.argv.slice(2);
if (!command || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(`${FIT_HELP}\n\n${PROFILE_HELP}\n\n${MEDIA_HELP}\n`);
  process.exit(command ? 0 : 1);
}
process.exitCode = await runFitCli(command, argv);
