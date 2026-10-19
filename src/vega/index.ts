/**
 * Vega OS support. Importing this module registers the 'vda' driver kind, so
 * `createDriver({ kind: 'vda' })` builds a VdaDriver. (createDriver also
 * imports it on demand.) NOT YET TESTED ON A REAL VEGA DEVICE: see docs/VEGA.md.
 */
import { registerDriver } from '../driver/index.js';
import { VdaDriver, resolveVegaSerial } from './driver.js';
import { defaultVegaRunner, type VegaRunner } from './runner.js';

export { VdaDriver, resolveVegaSerial, type VdaDriverOptions } from './driver.js';
export { VEGA_KEYS, DOCUMENTED_VEGA_KEYS, inputdArgs, escapeSendText } from './keys.js';
export { parseVdaDevices, parseVegaLogLine, parseVegaLogs, parseAceMemusage, parsePid, guessLevel, type VdaDevice } from './parse.js';
export { VegaProcessRunner, defaultVegaRunner, findVega, vegaCandidates, VEGA_INSTALL_HINT, type VegaRunner, type VegaResult } from './runner.js';

registerDriver('vda', async (o) => {
  // `extra.runner` lets tests and embedders supply their own way to run `vega`.
  const runner = (o.extra?.runner as VegaRunner | undefined) ?? defaultVegaRunner();
  const serial = await resolveVegaSerial(runner, o.serial);
  const driver = new VdaDriver({ serial, runner, ...(o.extra?.keyMap ? { keyMap: o.extra.keyMap as Record<string, string> } : {}) });
  if (o.probe !== false) await driver.probe(o.app);
  return driver;
});
