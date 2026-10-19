import { sleep } from '../lib/util.js';

/**
 * Time as the engine sees it. Real runs use the wall clock; tests pass a
 * virtual clock shared with the MockDriver, so a "20 minute" run takes
 * milliseconds and is deterministic.
 */
export type Clock = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => (ms > 0 ? sleep(ms, signal) : Promise.resolve()),
};
