/**
 * Screen oracle (docs/ENGINE.md 7.2): black screen, render loop stopped,
 * frozen pixels, WebGL context lost. Perceptual bugs that show only on the
 * screen [25]; "frozen" borrows Android vitals' idea [35] at whole-screen,
 * seconds scale.
 */
import type { ExploreConfig, FindingDraft, Observation, Oracle, State } from '../types.js';
import { actionKey } from '../actions.js';
import { meanAbsDiff } from '../frame.js';
import { draft, sceneOf } from './common.js';

export const BLACK_MEAN = 10;
export const BLACK_STD = 3;
export const BLACK_MS = 1500;
export const RENDER_STOP_MS = 2000;
export const FROZEN_MS = 3000;
export const FROZEN_ACTIONS = 3;
/** Mean absolute grey difference (0..255) under which two frames count as the same picture. */
export const SAME_FRAME = 0.5;

export const isBlack = (obs: Observation): boolean => !!obs.frame && obs.frame.luma.mean < BLACK_MEAN && obs.frame.luma.std < BLACK_STD;

/** A video that is about to start may show black for a moment. */
const videoStarting = (obs: Observation): boolean => !!obs.probe?.video?.some((v) => v.readyState < 3 && v.t < 0.5);

const rendering = (obs: Observation): boolean => obs.probe?.paused === false && (obs.probe.targetFps ?? 0) > 0;

export function createScreenOracle(config: ExploreConfig): Oracle {
  const pkg = config.app.package;
  let blackRun = 0;
  let firstBlack = 0;
  let blackReported = false;
  /** The scene where the screen first went black (keys pressed on a black screen move the app elsewhere). */
  let blackScene = '';
  let rafStillSince: number | undefined;
  let loopStoppedReported = false;
  let frozenFor = 0;
  let actionsDuringFreeze = 0;
  /** Different navigation keys pressed during the current freeze (picture-only mode needs at least two). */
  let freezeKeys = new Set<string>();
  /** Scenes seen animating (pixels changed while the abstract state stayed the same). */
  const animated = new Set<string>();
  /** (scene, action) -> how often the action changed the picture. */
  const changes = new Map<string, { n: number; changed: number }>();
  let framesSeen = 0;

  /** Stricter, for picture-only mode: at least 3 tries and 80% of them changed the picture. */
  const reliablyChanges = (scene: string, action: string): boolean => {
    const s = changes.get(`${scene}|${action}`);
    return !!s && s.n >= 3 && s.changed / s.n >= 0.8;
  };

  const usuallyChanges = (scene: string, action: string): boolean => {
    const s = changes.get(`${scene}|${action}`);
    return !!s && s.n >= 2 && s.changed / s.n >= 0.6;
  };

  return {
    id: 'screen',
    cost: 'cheap',
    needs: ['screenshot'],
    check(ctx, obs, prev, state) {
      if (obs.frame) framesSeen++;
      const inApp = obs.foreground === pkg;
      const scene = sceneOf(obs, state);
      const out: FindingDraft[] = [];
      if (obs.relaunched) {
        blackRun = 0;
        blackReported = false;
        rafStillSince = undefined;
        loopStoppedReported = false;
        frozenFor = 0;
        actionsDuringFreeze = 0;
        freezeKeys = new Set();
      }

      // Black: two settled steps and 1.5 s, so a fade does not count.
      if (inApp && isBlack(obs) && !videoStarting(obs)) {
        if (blackRun === 0) (firstBlack = obs.ts), (blackScene = scene);
        blackRun++;
        if (blackRun >= 2 && obs.ts - firstBlack >= BLACK_MS && !blackReported) {
          blackReported = true; // once per black spell, not once per scene it lasts into
          const keys = ctx.history.slice(-6).map((o) => (o.action ? actionKey(o.action) : '(launch)'));
          out.push(
            draft(
              { oracle: 'screen', kind: 'black-screen', severity: 'critical', title: `The screen went black in "${blackScene}"`, detail: `The frame stayed black (luma mean ${obs.frame?.luma.mean.toFixed(1)}, std ${obs.frame?.luma.std.toFixed(1)}) for ${Math.round(obs.ts - firstBlack)} ms while the app was in the foreground. Last keys: ${keys.join(' ')}.`, signature: `black-screen@${blackScene}` },
              obs,
              state,
              { numbers: { blackMs: obs.ts - firstBlack, lumaMean: obs.frame?.luma.mean ?? 0 } },
            ),
          );
        }
      } else (blackRun = 0), (blackReported = false);

      // The app says it is rendering, but its frame counter stopped.
      if (inApp && prev?.probe && obs.probe && !obs.relaunched && rendering(obs) && rendering(prev) && obs.probe.raf === prev.probe.raf) {
        rafStillSince ??= prev.ts;
        if (obs.ts - rafStillSince >= RENDER_STOP_MS && !loopStoppedReported) {
          loopStoppedReported = true;
          out.push(
            draft(
              { oracle: 'screen', kind: 'render-loop-stopped', severity: 'critical', title: `The render loop stopped in "${scene}"`, detail: `window.firelab says the app renders at ${obs.probe.targetFps} fps and is not paused, but no frame was drawn for ${Math.round(obs.ts - rafStillSince)} ms (frame counter stuck at ${obs.probe.raf}, ${obs.probe.rafSource ?? 'raf'}).`, signature: `render-loop-stopped@${scene}` },
              obs,
              state,
              { numbers: { stoppedMs: obs.ts - rafStillSince, raf: obs.probe.raf } },
            ),
          );
        }
      } else if (obs.probe && prev?.probe && obs.probe.raf !== prev.probe.raf) {
        rafStillSince = undefined;
        loopStoppedReported = false;
      }

      // WebGL context lost (cheap, and common on 1 GB devices under memory pressure).
      if (inApp && obs.probe && (obs.probe.glLost ?? 0) > (obs.relaunched ? 0 : (prev?.probe?.glLost ?? 0)))
        out.push(draft({ oracle: 'screen', kind: 'webgl-context-lost', severity: 'critical', title: 'The WebGL context was lost', detail: `webglcontextlost fired ${obs.probe.glLost} time(s). On 1 GB devices the GPU process is killed under memory pressure.`, signature: 'webgl-context-lost' }, obs, state));

      // Pixels stopped changing although input (or animation) used to change them.
      if (inApp && prev?.frame && obs.frame && obs.action && !obs.relaunched && prev.foreground === pkg && !isBlack(obs)) {
        const d = meanAbsDiff(obs.frame.thumb64, prev.frame.thumb64);
        const a = actionKey(obs.action);
        const sameState = prev.stateId !== undefined && prev.stateId === obs.stateId;
        if (Number.isFinite(d)) {
          const st = changes.get(`${scene}|${a}`) ?? { n: 0, changed: 0 };
          // Picture-only mode (no probe: the app can't be inspected): an animation that stops is not
          // evidence (menus and dialogs pause backgrounds on purpose), and a screen is a coarse picture
          // hash. Only navigation keys that reliably changed this screen before, and then stop, count.
          const blackBox = !obs.probe;
          const nav = obs.action.kind === 'key' && ['up', 'down', 'left', 'right', 'ok'].includes(obs.action.key);
          const expect = blackBox ? nav && reliablyChanges(scene, a) : animated.has(scene) || usuallyChanges(scene, a);
          if (d < SAME_FRAME && expect) {
            frozenFor += obs.ts - prev.ts;
            actionsDuringFreeze++;
            freezeKeys.add(a);
            if (frozenFor >= FROZEN_MS && actionsDuringFreeze >= FROZEN_ACTIONS && (!blackBox || freezeKeys.size >= 2) && !loopStoppedReported)
              out.push(
                draft(
                  { oracle: 'screen', kind: 'frozen-screen', severity: 'major', title: `The picture froze in "${scene}"`, detail: `${actionsDuringFreeze} key presses over ${Math.round(frozenFor)} ms did not change a single pixel, although this scene ${animated.has(scene) ? 'animates' : 'usually reacts to these keys'}.`, signature: `frozen-screen@${scene}` },
                  obs,
                  state,
                  { numbers: { frozenMs: frozenFor, actions: actionsDuringFreeze } },
                ),
              );
          } else {
            frozenFor = 0;
            actionsDuringFreeze = 0;
            freezeKeys = new Set();
            // Learn only from healthy frames, so a freeze does not teach "this never changes".
            st.n++;
            if (d >= SAME_FRAME) st.changed++;
            changes.set(`${scene}|${a}`, st);
            if (d >= SAME_FRAME && sameState) animated.add(scene);
          }
        }
      }
      for (const f of out) ctx.emit(f);
    },
    matches(signature, obs, prev) {
      const [kind, scene] = signature.split('@');
      if (!obs.frame || obs.foreground !== pkg) return false;
      const sc = obs.probe?.scene ?? obs.probe?.modal ?? obs.stateId;
      if (scene && sc !== scene) return false;
      if (kind === 'black-screen') return isBlack(obs) && !!prev && isBlack(prev) && obs.ts - prev.ts >= BLACK_MS / 2;
      if (kind === 'render-loop-stopped') return !!prev?.probe && !!obs.probe && rendering(obs) && obs.probe.raf === prev.probe.raf && obs.ts - prev.ts >= RENDER_STOP_MS / 2;
      if (kind === 'frozen-screen') return !!prev?.frame && meanAbsDiff(obs.frame.thumb64, prev.frame.thumb64) < SAME_FRAME && rendering(obs);
      if (kind === 'webgl-context-lost') return (obs.probe?.glLost ?? 0) > 0;
      return false;
    },
    notes() {
      return framesSeen ? [] : ['screen oracle off: the driver returned no RGBA frames'];
    },
  };
}
