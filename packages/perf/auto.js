// @firelab/perf/auto: zero-code drop-in.
//
//   <script type="module" src="https://cdn.jsdelivr.net/npm/@firelab/perf/auto.js"></script>
//
// Publishes window.firelab (fps, frame times, tier, GPU) for the FireLab
// tester, shows the meter with ?perf=1 or a double tap of rewind, and counts
// requestAnimationFrame callbacks. Adaptive resolution needs to know your
// renderer: call window.__firelabPerf.attach(renderer), or use createPerf().
import { createPerf } from './src/perf.js';

export const perf = createPerf();
