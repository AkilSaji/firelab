/**
 * Health oracle (docs/ENGINE.md 7.1): crash, ANR, renderer gone, unexpected
 * exit, process restart, JS exceptions. Crashes and exceptions are the oracle
 * behind most of the Android testing literature [1, 4, 5, 8, 9]. It reads only
 * what the step already collected, so it is free.
 */
import type { LogLine } from '../driver.js';
import type { ExploreConfig, FindingDraft, Observation, Oracle, OracleContext, State } from '../types.js';
import { actionKey } from '../actions.js';
import { basename, draft, normalizeText } from './common.js';

/** WebView renderer crash patterns, kept in one table (tested). */
export const RENDERER_GONE_PATTERNS: readonly RegExp[] = [
  /onRenderProcessGone/i,
  /Render(er)? process (crashed|gone|exited|was killed)/i,
  /RenderProcessGoneDetail/i,
  /chromium.*Renderer process.*(crash|kill)/i,
  /Out of memory.*renderer|renderer.*out of memory/i,
];

const FATAL = /FATAL EXCEPTION/;

/** Exception class and top frame of the stack that follows a FATAL EXCEPTION line. */
export function parseCrash(lines: readonly LogLine[], at: number): { cls: string; frame: string; stack: string[] } {
  const start = lines[at] as LogLine;
  const stack: string[] = [];
  let cls = '';
  let frame = '';
  for (let i = at + 1; i < lines.length && stack.length < 14; i++) {
    const l = lines[i] as LogLine;
    if (start.pid !== undefined && l.pid !== undefined && l.pid !== start.pid) continue;
    if (FATAL.test(l.text)) break;
    stack.push(l.text);
    const c = /^\s*(?:Caused by: )?([A-Za-z_$][\w$]*(?:\.[\w$]+)*(?:Exception|Error|Throwable))\b/.exec(l.text);
    if (c && !cls) cls = c[1] as string;
    const f = /^\s*at\s+([\w$.<>]+)/.exec(l.text);
    if (f && !frame) frame = f[1] as string;
  }
  return { cls: cls || 'UnknownException', frame: frame || '?', stack };
}

/** Packages that are the TV's home screen: leaving to them is an exit, not a hand-off to another app. */
export const HOME_SCREENS = /launcher|tvlauncher|\.home\b|com\.amazon\.tv\.launcher|com\.amazon\.firebat|leanbacklauncher/i;

export type HealthEnv = {
  pkg: string;
  /** Is leaving the app expected for this (state, action)? (home, or back from a root screen). */
  expectedExit?: (fromStateId: string | undefined, action: string) => 'expected' | 'minor' | 'major';
};

/** Everything the step shows, as finding drafts. Pure: used by check() and by matches() during replays. */
export function healthSignals(obs: Observation, prev: Observation | undefined, env: HealthEnv, state?: Pick<State, 'id'>): FindingDraft[] {
  const out: FindingDraft[] = [];
  const pid = obs.pid ?? prev?.pid;
  // Native crashes, ANRs, renderer deaths from the device log.
  obs.logs.forEach((l, i) => {
    if (FATAL.test(l.text)) {
      const near = obs.logs.slice(i, i + 4).map((x) => x.text).join('\n');
      const ours = (pid !== undefined && l.pid === pid) || near.includes(env.pkg);
      if (!ours) return;
      const { cls, frame, stack } = parseCrash(obs.logs, i);
      out.push(
        draft(
          { oracle: 'health', kind: 'crash', severity: 'critical', title: `App crashed: ${cls} at ${frame}`, detail: stack.slice(0, 8).join('\n'), signature: `crash:${cls}@${frame}` },
          obs,
          state,
          { logs: [l.text, ...stack].slice(0, 20) },
        ),
      );
    }
    const anr = /ANR in ([\w.]+)/.exec(l.text);
    if (anr && anr[1] === env.pkg)
      out.push(draft({ oracle: 'health', kind: 'anr', severity: 'critical', title: `App not responding (ANR)`, detail: l.text, signature: `anr:${env.pkg}` }, obs, state, { logs: obs.logs.slice(i, i + 10).map((x) => x.text) }));
    if (RENDERER_GONE_PATTERNS.some((re) => re.test(l.text)) && (l.pid === undefined || l.pid === pid || l.text.includes(env.pkg)))
      out.push(draft({ oracle: 'health', kind: 'webview-renderer-gone', severity: 'critical', title: 'The WebView renderer process died', detail: l.text, signature: 'webview-renderer-gone' }, obs, state, { logs: [l.text] }));
  });
  // Leaving the app.
  if (prev && prev.foreground === env.pkg && obs.foreground !== env.pkg && obs.action && !obs.relaunched) {
    const a = actionKey(obs.action);
    const key = obs.action.kind === 'key' ? obs.action.key : undefined;
    // Without a probe (an app that can't be inspected) screens are coarse pictures, so "how deep" is a guess:
    // Back leaving the app is then treated as normal (it is, on a game's first screen), not as a finding.
    const verdict = key === 'home' || (key === 'back' && !prev.probe) ? 'expected' : (env.expectedExit?.(prev.stateId, a) ?? 'major');
    const crashed = out.some((f) => f.kind === 'crash' || f.kind === 'anr');
    // OK that brings another app to the front (not the TV's home screen) is a hand-off, as when a games hub
    // launches a game: worth a note, not a bug.
    const handoff = key === 'ok' && !!obs.foreground && !HOME_SCREENS.test(obs.foreground);
    if (handoff && !crashed)
      out.push(draft({ oracle: 'health', kind: 'opened-app', severity: 'info', title: `"${a}" opened another app (${obs.foreground})`, detail: `After pressing ${a} the app handed over to ${obs.foreground}, as a launcher or hub does. FireLab relaunched the app under test and carried on.`, signature: `opened-app:${obs.foreground}` }, obs, state));
    else if (verdict !== 'expected' && !crashed)
      out.push(
        draft(
          {
            oracle: 'health',
            kind: 'unexpected-exit',
            severity: verdict,
            title: `"${a}" left the app (foreground is now ${obs.foreground ?? 'nothing'})`,
            detail: `After pressing ${a} the app was no longer in the foreground. Foreground: ${obs.foreground ?? 'none'}.`,
            signature: `unexpected-exit:${prev.stateId ?? '?'}:${a}`,
          },
          obs,
          state,
        ),
      );
  }
  // The process changed without a relaunch.
  if (prev?.pid !== undefined && obs.pid !== undefined && obs.pid !== prev.pid && !obs.relaunched)
    out.push(draft({ oracle: 'health', kind: 'process-restarted', severity: 'critical', title: `The app process restarted (pid ${prev.pid} -> ${obs.pid})`, detail: 'The pid changed although FireLab did not relaunch the app: it probably crashed and Android restarted it.', signature: 'process-restarted' }, obs, state, { numbers: { pidBefore: prev.pid, pidAfter: obs.pid } }));
  // JS exceptions and console errors.
  let explained = 0;
  for (const e of obs.console) {
    if (e.source !== 'exception' && e.level !== 'error') continue;
    const exception = e.source === 'exception';
    if (exception) explained++;
    const sig = `js-error:${normalizeText(e.text)}@${basename(e.url)}:${e.line ?? 0}`;
    out.push(
      draft(
        { oracle: 'health', kind: exception ? 'js-exception' : 'console-error', severity: exception ? 'major' : 'minor', title: `${exception ? 'Uncaught' : 'Console error'}: ${e.text.slice(0, 100)}`, detail: `${e.text}${e.url ? `\n  at ${e.url}:${e.line ?? '?'}` : ''}`, signature: sig },
        obs,
        state,
        { logs: [e.text] },
      ),
    );
  }
  const before = prev && !obs.relaunched ? (prev.probe?.errors ?? 0) : 0;
  const now = obs.probe?.errors ?? 0;
  if (obs.probe && now > before && explained === 0) {
    const last = obs.probe.lastError ?? 'uncaught error';
    const at = last.lastIndexOf('@');
    const msg = at >= 0 ? last.slice(0, at) : last;
    const where = at >= 0 ? last.slice(at + 1) : '';
    const [file, line] = where.split(':');
    out.push(
      draft(
        { oracle: 'health', kind: 'js-exception', severity: 'major', title: `Uncaught: ${msg.slice(0, 100)}`, detail: `${now - before} uncaught error(s) counted by the probe. Last: ${last}`, signature: `js-error:${normalizeText(msg)}@${basename(file)}:${line ?? 0}` },
        obs,
        state,
        { logs: [last], numbers: { errors: now - before } },
      ),
    );
  }
  return out;
}

export function createHealthOracle(config: ExploreConfig): Oracle {
  const env = (ctx?: OracleContext): HealthEnv => ({
    pkg: config.app.package,
    expectedExit: (from, action) => {
      if (!ctx || !from) return 'major';
      // A long Back is "quit" on Fire TV (FireLab's wrapper too).
      if (action === 'back:long') return 'expected';
      const m = /^back(?:\*(\d+))?$/.exec(action);
      if (!m) return 'major';
      const presses = Number(m[1] ?? 1);
      const cell = ctx.graph.cells.get(from);
      if (!cell) return 'minor';
      // Back at a root screen leaving the app is normal TV behaviour; so are n Backs from n screens deep. The screen
      // counts, not the full state: the title screen reached again later (with app state that differs) is still the root.
      const same = (c: typeof cell) => c.key.pkg === cell.key.pkg && c.key.activity === cell.key.activity && c.key.path === cell.key.path && c.key.scene === cell.key.scene && c.key.modal === cell.key.modal;
      let depth = cell.depth;
      for (const c of ctx.graph.cells.values()) if (c.depth < depth && same(c)) depth = c.depth;
      if (depth <= presses) return 'expected';
      return 'minor';
    },
  });
  return {
    id: 'health',
    cost: 'free',
    needs: ['logs'],
    check(ctx, obs, prev, state) {
      for (const f of healthSignals(obs, prev, env(ctx), state)) ctx.emit(f);
    },
    matches(signature, obs, prev) {
      // A crash during a replay counts only if the top frame matches: the signature carries it.
      return healthSignals(obs, prev, env()).some((f) => f.signature === signature);
    },
  };
}
