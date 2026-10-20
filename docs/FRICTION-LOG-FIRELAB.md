# Friction log: using FireLab

[FRICTION-LOG.md](FRICTION-LOG.md) is about Amazon's platform. This one is
about FireLab itself: every place a developer (or we, using FireLab on our own
games) got stuck, confused, slowed down or misled while going from "I have a
game" to "I know where it breaks". We kept it while building and dogfooding
FireLab in October 2026. Each entry says what happened, how we noticed, what we
changed, and what is still open, so the next person knows where the rough edges
are.

**Severity:** High = wrong results or a dead end; Medium = cost real time or
needed a workaround; Low = papercut. **Status:** Fixed (with the change),
Mitigated (a workaround or a clear message, the cause remains), Open.

## Summary

| # | Stage | Friction | Severity | Status |
|---|---|---|---|---|
| 1 | First run | Testing a web game needed an APK wrapper and a Fire TV first | High | Fixed |
| 2 | First run | The emulator's frame rates looked like results but meant nothing | High | Mitigated |
| 3 | GPU | "Works on my laptop" WebGL bugs only showed on the stick | High | Fixed |
| 4 | Engine | The engine stayed shallow on games with a dialog behind every button | High | Fixed |
| 5 | Engine | The focus check used up most of the key presses | Medium | Fixed |
| 6 | Engine | Every key looked useful in games that animate every frame | Medium | Fixed |
| 7 | Engine | An optimisation made the engine skip the key that triggers a real bug | High | Fixed |
| 8 | Engine | A state expression that counts gold made the engine shop forever | High | Mitigated |
| 9 | Engine | "Back left the app" false alarms on the title screen | Medium | Fixed |
| 10 | Engine | Timing and counter bugs don't shrink to a few keys | Medium | Open |
| 11 | Engine | Bugs 40-100 presses deep aren't reached in 10 minutes | High | Open |
| 12 | Engine | Hidden game state (a bought item, a used save slot) is invisible to the explorer | Medium | Mitigated |
| 13 | Benchmark | There was no way to show judges the engine beats anything | High | Fixed |
| 14 | Benchmark | A benchmark game reported a bug that didn't actually break anything | High | Fixed |
| 15 | Benchmark | A Chrome crash aborted runs, and three runs were lost | Medium | Fixed |
| 16 | Benchmark | A full benchmark takes about two hours | Medium | Open |
| 17 | Benchmark | Browser thumbnails were twice the expected size | Medium | Fixed |
| 18 | Tests | A real-Chrome test failed 2 of 3 times under load | Medium | Fixed |
| 19 | Dashboard | The key log's timeline drew over the press list | Medium | Fixed |
| 20 | Dashboard | Three panels side by side made the bottom row cramped | Low | Fixed |
| 21 | Dashboard | Ports 7300 and 8080 were taken by another FireLab or demo server | Low | Mitigated |
| 22 | Learning | Nothing a run learned helped the next game | Medium | Fixed |
| 23 | Learning | Shared knowledge could change test results on a developer's machine | Medium | Fixed |
| 24 | Docs | Our own Monkey baseline could never press OK | High | Fixed |

---

## First run

### 1. Testing a web game needed an APK wrapper and a Fire TV

- **What happened:** to explore a web game you had to `firelab wrap` it into an APK (Android build tools, a JDK), install it on a Fire TV or the emulator, then `firelab explore --package`. A developer who just wanted to try FireLab on their game had a long setup before the first key press.
- **Fix:** the browser driver (`src/driver/browser.ts`): `firelab explore --driver browser --url <game>` runs the game in headless Chrome at the Fire TV WebView's 960×540 viewport, with keys delivered exactly as FireLab's TV wrapper delivers them (synthetic KeyboardEvents on the focused element; Back as Escape; an unhandled Back goes back in history or leaves the app). About 2 key steps per second (1.8–2.65 in the benchmark) instead of about 0.4 on a stick. `--headed` shows the window, so you can watch the engine play.
- **Still true:** the browser isn't the Amazon WebView or a Fire TV GPU; findings about speed, memory and the WebView need a device or the emulator.

### 2. Emulator frame rates looked like results

- **What happened:** `firelab lab` matches a model's RAM, screen and API level, so its numbers look authoritative, but it renders with the host's GPU (or SwiftShader when headless), not the stick's. On an API 36 image the emulator also raised the RAM we asked for (1024 MB) to 2473 MB.
- **Mitigation:** `lab start`, `lab doctor` and every smoke report print that frame rates and launch times aren't the device's, and `lab start` warns when the RAM was raised. `firelab fit` with measured profiles is the place for performance.

## GPU

### 3. WebGL bugs that only show on the stick

- **What happened:** a game that renders on the laptop can need WebGL2, 8K textures or S3TC, which some sticks don't have. Nothing told the developer before the player did.
- **Fix:** `--emulate-gpu <model>` (docs/GPU.md): a script installed before the page's own scripts makes WebGL report only that model's GPU features and limits, fails calls the way the driver would (null contexts, `INVALID_VALUE` textures, highp shaders that don't compile on Mali-450), and lists them. It works in `fit`, in `explore` (each failed call becomes a `gpu-unsupported` finding) and in desktop Chrome (`--script`, `--bookmarklet`).
- **How we noticed the next problem:** the first `explore --emulate-gpu` run marked "WebGL2 refused" as minor, because @firelab/perf creates a WebGL1 context to detect the chip; we changed it to count a fallback only when the page draws with WebGL1.

## Engine

### 4. The engine stayed shallow on menu-heavy games

- **What happened:** on Deep Quest (nested dialogs and a dungeon), the first engine version reached 27 screens and 5 presses deep in 2 minutes. Every focus position counted as its own state, and every state got all ten remote keys.
- **Fix (docs/ENGINE.md 6.7):** widget-level actions (read the focusable controls once per screen, move the focus to the next untried one and press OK), frontier and log-depth terms in cell selection, longer episodes while they discover, and OK-first / Back-last order. In the benchmark FireLab reaches a median of 246 screens and 36 presses deep in 10 minutes on Deep Quest, against 108 and 16 for the first version.

### 5. The focus check used up the key presses

- **What happened:** the focus oracle walks every new screen with all four arrows. On Deep Quest, 296 of 411 presses (72%) went to focus walks.
- **Fix:** focus walks are capped at 30% of the run's presses; screens over the cap are walked when the share drops.

### 6. Every key looked useful in animated games

- **What happened:** the engine learns "dead keys" (keys the app ignores) by checking whether the picture changed. Deep Quest's torch animates every frame, so Menu, Play/Pause, Rewind and Fast-forward kept getting presses: about 230 of 1,282.
- **Fix:** with the in-page probe, a key counts as effective only if the app's state (or the focused control's label) changed; pixels are used only for apps without a probe.

### 7. An optimisation skipped the key that triggers a real bug

- **What happened:** to save presses, the engine predicts that a key which did nothing on two positions of a screen does nothing on the others. On Firefly Lake, ▶ on the Quality item only changes its label ("Quality: auto" → "high"), which isn't part of the state, so the engine stopped pressing it there, and in the benchmark it triggered the "throw" bug 0/5 times while Random and Monkey got it 5/5.
- **How we noticed:** the benchmark's per-bug table.
- **Fix:** a key that changes the focused control's label counts as doing something. A 5-minute check afterwards triggered the bug in 2 of 3 runs.
- **Lesson:** every shortcut in an explorer needs a benchmark to catch what it costs.

### 8. A state expression that counts gold made the engine shop forever

- **What happened:** with `--state-expr` returning the bag (as an ordered list) and the gold, every purchase was a new state. The engine kept buying: 318 presses in the shop and 154 in the buy dialog out of 1,478. This is the "noisy TV" problem of novelty-driven explorers.
- **Mitigation:** the benchmark subject now uses a good state expression (the *set* of items, no counters; see the comment in `src/bench/subjects.ts`). Numbers in state expressions are already rounded to one significant digit, but a list that grows with every action still explodes.
- **Open:** detecting a state expression that grows without bound and warning about it.

### 9. "Back left the app" false alarms

- **What happened:** Back on the title screen quits a TV game, and that is expected. But a burst of Backs (`back*5`) from a few screens deep, or Back on the title screen reached again later with different app state, was reported as an unexpected exit.
- **Fix:** n Backs from n screens deep, a long Back, and Back on any state of the root *screen* are expected; deeper exits are minor.

### 10. Timing and counter bugs don't shrink to a few keys

- **What happened:** Lantern Lake's freeze needs four ▶ presses since launch, wherever they fall. With a 4-minute shrink budget (about 7 replays at roughly 35 s each) delta debugging can't get it down to a few keys; it stays confirmed but long. This also happened with the first engine version.
- **Open:** a smarter first cut for this shape (keep only presses of the keys that appear in the trace's last steps), or a larger default budget for confirmed critical findings.

### 11. Deep bugs aren't reached in 10 minutes

- **What happened:** no strategy, FireLab included, reached Deep Quest's floor-10, -20 and -30 bugs in 10-minute runs. FireLab and its first version reach floors 1-3 at best, but a wrong door costs a return to the last camp. Themis (52 real Android bugs) found the same: most bugs no tool finds need many screen transitions.
- **Open:** longer runs, per-game checkpoints (a `--setup` expression that loads a save), and LLM help on plateaus (ENGINE.md 6.5).

### 12. Hidden game state is invisible to the explorer

- **What happened:** Deep Quest's options bug needs "High quality applied" plus Controls › Remap. Nothing on screen tells the explorer the quality changed, so it doesn't know to retry Remap.
- **Mitigation:** `--state-expr` lets the developer expose the state that matters; the benchmark subject shows how (see 8).

## Benchmark

### 13. No way to show the engine beats anything

- **What happened:** "it finds bugs" is a claim. Judges and users need a comparison with the tools people already use.
- **Fix:** `firelab bench` (docs/BENCHMARK.md): FireLab, its first version, Random and Android Monkey's D-pad event mix on games with seeded bugs that record when they fire, repeated runs, Mann-Whitney U, Vargha-Delaney Â12 and Fisher's exact test, an HTML report, and the dashboard lists it.

### 14. A benchmark game reported a bug that didn't break anything

- **What happened:** Deep Quest recorded its Options bug as fired whenever Remap was pressed after High quality had *ever* been applied, even if quality was later set back, so no TypeError happened. A FireLab run "triggered" the bug but couldn't report it, because there was nothing to report.
- **Fix:** the bug records itself only when the TypeError is actually thrown. Ground truth must be exact, or every strategy's score is wrong.

### 15. A Chrome crash aborted runs

- **What happened:** in the first full benchmark, three runs in the same round failed with "No page is open": Chrome went away under four parallel browsers. The runs were left out of the statistics, which lost data.
- **Fix:** if Chrome or the tab disappears, the browser driver now treats it as "the app is gone": the engine relaunches (a new Chrome if needed) and the run goes on.

### 16. A full benchmark takes about two hours

- **What happened:** 2 games × 4 strategies × 5 runs × 10 minutes, 4 at a time, is about 2 hours on a laptop; 10 runs per cell (accepted practice) would be 4 hours.
- **Open:** more parallelism on bigger machines, a CI job that runs it nightly, and a "quick" preset for a first look.

### 17. Browser thumbnails were twice the expected size

- **What happened:** the browser driver asked Chrome for a 64 px thumbnail and got 128 px: the clip's scale multiplies CSS pixels, and the device pixel ratio applies on top. Frame fingerprints were computed on the wrong size.
- **How we noticed:** the driver's real-Chrome test.
- **Fix:** the scale divides by the device pixel ratio.

## Tests

### 18. A real-Chrome test was flaky under load

- **What happened:** the browser-driver test failed 2 of 3 full-suite runs (about 15.6 s, a DevTools timeout) while a benchmark was running four Chromes.
- **Fix:** longer DevTools timeouts, waiting for the exception event instead of a fixed sleep, two retries, and the test is skipped when no Chrome is installed.

## Dashboard

### 19. The key log's timeline drew over the press list

- **What happened:** on a 2× screen, the key log's canvas drew at twice the height of its 120 px box and covered the list of presses.
- **Fix:** the canvas's CSS size is pinned to its box (its backing store stays in device pixels).

### 20. The bottom row was cramped

- **What happened:** the Tools dock, Test Execution and Test Results sat side by side from 1600 px wide, so the key log toolbar wrapped and labels were cut.
- **Fix:** side by side only from 1920 px; below that the dock gets a full row with the two panels under it.

### 21. Ports were taken by other FireLab servers

- **What happened:** with several FireLab sessions on one machine, the dashboard's 7300 and the demo server's 8080 were already in use.
- **Mitigation:** `firelab ui --port <n>` and `serve.mjs --port <n>`.
- **Open:** pick the next free port automatically and print it.

## Learning

### 22. Nothing a run learned helped the next game

- **What happened:** every run started from zero: a bug pattern found on one game (e.g. a fast triple OK blanks the screen) wasn't tried on the next.
- **Fix:** knowledge packs (knowledge/README.md, ENGINE.md 6.8): `firelab learn export` turns confirmed findings into bug patterns and key priors, developers contribute them by pull request (also from MCP `learn_export` or CI), and every explore run with a pack installed sometimes tries the patterns first on new screens. No URLs, names, text or screenshots, and nothing is uploaded automatically.
- **Open:** whether patterns transfer between games is being measured (`firelab bench --knowledge`, a pack learned on one game, tested on another).

### 23. Shared knowledge could change test results

- **What happened:** the engine loads packs from `~/.firelab/knowledge` by default, so a developer's own packs could change what the test suite's seeded runs find.
- **Fix:** `FIRELAB_NO_KNOWLEDGE=1` turns off the default packs (the test config sets it); the benchmark loads knowledge only for the `firelab-k` strategy, and only the packs given.

## Docs

### 24. Our own Monkey baseline could never press OK

- **What happened:** ENGINE.md's evaluation plan used `adb shell monkey --pct-nav 100`. That sends only arrows: OK, Back and Menu are *majornav*. The baseline would have been unfairly weak, and any "beats Monkey" result meaningless. A research survey pointed it out.
- **Fix:** the plan and `--strategy monkey` use Monkey's real D-pad mix (nav 60%, majornav 35%, syskeys 5%). The same trap is in the platform log (FRICTION-LOG.md entry 17), because Fire TV teams fall into it too.
