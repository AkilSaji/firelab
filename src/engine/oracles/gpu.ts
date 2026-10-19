/**
 * GPU oracle (extension, --emulate-gpu): the page runs under the GPU shim
 * (src/fit/gpu-shim.ts), which makes WebGL report only one Fire TV model's
 * GPU features and limits. Every WebGL call the shim failed is a place the
 * game would break on that stick. Reads only what the probe already carries,
 * so it is free. Features and limits only: it says nothing about speed.
 */
import type { GpuFailure } from '../../fit/gpu-shim.js';
import type { ExploreConfig, Observation, Oracle, OracleContext, State } from '../types.js';
import { draft, normalizeText } from './common.js';

export const gpuSignature = (f: Pick<GpuFailure, 'call' | 'detail'>): string => `gpu:${f.call}:${normalizeText(f.detail)}`;

/** WebGL2 refused but the page drew with WebGL1: the fallback works. (A WebGL1 context alone may be a chip-detection probe.) */
const fellBack = (f: GpuFailure, obs: Observation): boolean => /^getContext\("webgl2"\)/.test(f.call) && obs.probe?.gpu?.drew1 === true;

export function createGpuOracle(config: ExploreConfig): Oracle | undefined {
  const emu = config.emulateGpu;
  if (!emu) return undefined;
  const label = `${emu.name} (${emu.model}, ${emu.renderer})`;
  const warns = new Map<string, GpuFailure>();
  const fails = new Map<string, GpuFailure>();
  let sawShim = false;
  let sawProbe = false;
  return {
    id: 'gpu',
    cost: 'free',
    needs: ['eval', 'cdp'],
    check(ctx: OracleContext, obs: Observation, prev: Observation | undefined, state: State) {
      if (obs.probe) sawProbe = true;
      if (obs.probe?.gpu) sawShim = true;
      const list = obs.probe?.gpuFails ?? [];
      if (!list.length) return;
      // New on this page load: the shim's list starts empty after every (re)load.
      const before = new Set(!obs.relaunched && prev?.probe?.url === obs.probe?.url ? (prev?.probe?.gpuFails ?? []).map((f) => f.key) : []);
      for (const f of list) {
        if (f.sev === 'warn') {
          warns.set(f.key, f);
          continue;
        }
        fails.set(f.key, f);
        if (before.has(f.key)) continue;
        const soft = fellBack(f, obs);
        ctx.emit(
          draft(
            {
              oracle: 'gpu',
              kind: 'gpu-unsupported',
              severity: soft ? 'minor' : 'major',
              title: `${f.call} fails on ${emu.model}: ${f.detail.slice(0, 90)}`,
              detail: `Under the ${label} GPU profile, ${f.call} ${f.detail}.${soft ? ' The page went on drawing with WebGL1.' : ''} This copies the GPU's WebGL features and limits, not its speed.`,
              signature: gpuSignature(f),
            },
            obs,
            state,
            { logs: [`[firelab-gpu] ${f.call} ${f.detail}`] },
          ),
        );
      }
    },
    matches(signature: string, obs: Observation) {
      return (obs.probe?.gpuFails ?? []).some((f) => f.sev === 'fail' && gpuSignature(f) === signature);
    },
    notes() {
      const out: string[] = [];
      if (sawProbe && !sawShim) out.push(`gpu oracle: the ${emu.model} GPU shim never showed up in the page (the driver could not add a script before the page's own): nothing was checked.`);
      if (sawShim) {
        const head = `WebGL under the ${label} profile (features and limits, not speed)`;
        if (!fails.size && !warns.size) out.push(`${head}: no WebGL call failed.`);
        else out.push(`${head}: ${fails.size} call${fails.size === 1 ? '' : 's'} failed${fails.size ? ` (${[...fails.values()].map((f) => `${f.call} ${f.detail}`).slice(0, 6).join('; ')})` : ''}; ${warns.size} capability check${warns.size === 1 ? '' : 's'} came back empty${warns.size ? ` (${[...warns.values()].map((f) => f.call).slice(0, 10).join(', ')})` : ''}.`);
      }
      for (const n of emu.notes.slice(0, 2)) out.push(`gpu: ${n}`);
      return out;
    },
  };
}
