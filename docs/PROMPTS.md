# Copy-paste prompts

Prompts for an AI coding assistant (Claude Code, Claude Desktop, Cursor, Kiro,
VS Code) that has FireLab connected over MCP. Set that up first:
[README, step 3](../README.md#60-second-quick-start). Replace the parts in
`<angle brackets>`.

Two kinds of assistant:

- **Assistants that can run terminal commands** (Claude Code, Cursor and Kiro
  agents) can do everything here, including starting an emulator and wrapping a
  web game. The prompts that need a terminal say so.
- **Chat-only assistants** (Claude Desktop) use FireLab's MCP tools only. Start
  the emulator or install your app yourself first, then use the prompts.

Every prompt works on a real Fire TV or on a Fire-TV-shaped emulator, unless it
says otherwise.

## Contents

0. [Just try FireLab (no TV, no setup)](#0-just-try-firelab)
1. [No Fire TV: set up an emulator and test](#1-no-fire-tv-set-up-an-emulator-and-test)
2. [Find bugs in my game](#2-find-bugs-in-my-game)
3. [Fix what it found and prove it's fixed](#3-fix-what-it-found-and-prove-its-fixed)
4. [Test a web game (HTML5 / three.js / Phaser)](#4-test-a-web-game)
5. [Test a native APK (Unity, Android, React Native)](#5-test-a-native-apk)
6. [Play-test it like a person and review the TV experience](#6-play-test-it-like-a-person)
7. [Performance on this TV](#7-performance-on-this-tv)
8. [Will it run on every Fire TV?](#8-will-it-run-on-every-fire-tv)
9. [Check D-pad navigation only](#9-check-d-pad-navigation-only)
10. [Explain a FireLab report](#10-explain-a-firelab-report)
11. [Add FireLab to CI](#11-add-firelab-to-ci)
12. [Make my game easier for FireLab to test](#12-make-my-game-easier-to-test)
13. [Test on Vega OS (untested driver)](#13-test-on-vega-os)

---

## 0. Just try FireLab

*Works in any assistant with FireLab connected. No TV, no emulator, no SDK.*

```text
Show me what FireLab can do. Run explore_start with driver "demo" (a simulated TV game with seeded
bugs; it needs no device and finishes in seconds), then explore_status until it is done, then
explore_findings. Explain each bug as if I were the game's developer: what the player sees, the exact
keys that reproduce it, how reliably it reproduced, and what kind of code mistake usually causes it.
```

From a terminal it's one command: `npm run demo` (or `firelab demo`).

## 1. No Fire TV: set up an emulator and test

*Needs a terminal assistant and the Android SDK (the assistant checks).*

```text
I don't have a Fire TV. Use FireLab's lab to test my app on an emulator shaped like a Fire TV Stick.

1. Run `firelab lab doctor --profile AFTSSS` and fix what it reports. Show me any command
   that downloads something or needs my licence acceptance before running it.
2. Create and start the emulator: `firelab lab create --profile AFTSSS --install`, then
   `firelab lab start --headless`. It shows up as a device (usually emulator-5554).
3. Install my app: <path to my .apk>. (For a web game, see the web-game prompt instead.)
4. Run `firelab lab smoke --apk <path to my .apk>` and tell me if it launched, crashed or ran out of memory.
5. Then explore it with the explore_start tool (device "emulator-5554", package <my.package.id>,
   minutes 15), check explore_status every minute, and when it is done read explore_findings.
6. Report: every finding with what the player would see, the exact keys that reproduce it,
   how reliably it reproduced, and what to change in my code.

Remember the emulator matches the stick's memory, screen and Android version, not its GPU:
don't draw conclusions about frame rate from it.
```

**AFTSSS** is the Fire TV Stick 3rd gen (1 GB RAM, the hardest common target).
**AFTMA08C15** is the Fire TV Stick 4K Plus. `firelab lab create --list-models`
lists the rest.

## 2. Find bugs in my game

```text
Find bugs in my Fire TV game <my.package.id> with FireLab.

1. list_devices; if the TV's screen is off, wake_device.
2. explore_start with package "<my.package.id>" and minutes 20. If it is a web game that marks the
   focused button with a CSS class, also pass focusSelector (for example ".focused").
3. Every minute or so, explore_status: tell me briefly what screen it is on and how many screens and
   findings it has so far.
4. When the status is "done", explore_findings.
5. For each finding, most severe first:
   - what the player experiences, in one sentence;
   - the exact key sequence that reproduces it, and the reproduction rate (e.g. 5/5);
   - the likely cause, using the log, JS error or focus details in the finding;
   - the file and function in my code I should look at, if you can find it in this repository.
6. End with a prioritised fix list and the path to report.html.

Don't use the TV for anything else while the run is going.
```

## 3. Fix what it found and prove it's fixed

*Needs a terminal assistant, with your game's code open.*

```text
Take the FireLab findings from my last explore run (explore_findings, or the run folder <path>)
and fix the critical and major ones in this codebase, one at a time:

1. Read the finding, its repro keys and its trace file.
2. Before changing code, run `firelab replay <trace file> --times 3` and confirm it reproduces.
3. Find the cause in the code and fix it with the smallest change. Explain the fix.
4. Rebuild and reinstall the app on the TV (or emulator).
5. Run `firelab replay <trace file> --times 5` again. It must say "not reproduced" (exit code 0).
   If it still reproduces, keep going; don't move on.
6. When all are done, run explore again for 10 minutes to check nothing new broke.

Show me a table at the end: finding, cause, fix, replay before (k/n), replay after (k/n).
```

## 4. Test a web game

*Needs a terminal assistant. Works for any page: HTML5, three.js, Phaser, PixiJS, Babylon.js.*

```text
My game is a web page in this repository. Test it on the Fire TV (or emulator) with FireLab.

1. Start a local server for the game and find the URL the TV can reach:
   - on a real Fire TV: this computer's LAN address, e.g. http://192.168.1.20:8080/;
   - on the emulator: http://10.0.2.2:<port>/ (the emulator's name for this computer).
2. Wrap it as a Fire TV app and install it:
   `firelab wrap --url <that url> --name "<My Game>" --install <device>`.
   The package will be dev.firelab.<mygame> (shown in the output).
3. If the game has a small state object (scene, menu item), find it in the code and use it as
   stateExpr, e.g. "game.state.scene". If menus mark focus with a CSS class, use it as focusSelector.
4. explore_start with that package, url, stateExpr, focusSelector and minutes 20; follow it with
   explore_status, then explore_findings.
5. Report each finding with its keys, the JS error or log, and where to fix it in this code.

Remember that in the wrapped app Back arrives as Escape: the game must call preventDefault() on keys it handles.
```

## 5. Test a native APK

```text
Test my native Fire TV app with FireLab. The APK is <path/to/app.apk> and the package is <my.package.id>.

1. install_app with the APK (on the device or emulator in list_devices).
2. launch_app, wait 5 seconds, screenshot: describe the first screen.
3. explore_start with package "<my.package.id>" and minutes 20; poll explore_status; then explore_findings.
4. Native apps have no web page to look inside, so FireLab checks crashes, ANRs, black and frozen
   screens, keys that quit the app, and D-pad focus where Android exposes it. Tell me which checks
   ran and which were off (the notes in the findings or the report say so).
5. For crashes, quote the stack trace and point to the class and method.
```

## 6. Play-test it like a person

```text
Play-test <my.package.id> on the Fire TV like a first-time player, with FireLab's tools.
Goal: <e.g. "start a game, finish the first level, open settings and change the volume">.

After every step take a screenshot and describe what you see. Look for:
- text too small or low-contrast to read from 3 metres away;
- content cut off at the edges (TV overscan: keep important things inside 5% margins);
- focus you can't see, or that jumps somewhere unexpected;
- dead ends where Back does nothing, or Back that quits the app;
- anything slow, frozen or black.

Use press_keys with the D-pad (up/down/left/right, ok, back, menu). Check webview_console with
minLevel "warn" for errors if it is a web app. Finish on the home screen (press_keys ["home"]).
Report what works, what's broken (with the screenshot step), and concrete fixes.
```

There is also a built-in prompt for this: **`playtest`**.

## 7. Performance on this TV

*Real Fire TV only: emulator frame rates mean nothing.*

```text
Measure how my game performs on this Fire TV with FireLab.

1. device_info: note the model, GPU, RAM and the tier FireLab suggests.
2. Get to the busiest scene (press_keys), then measure_performance for 15 seconds:
   fps median and p10 (stutter), memory, CPU.
3. If it is a web game with quality tiers in the URL (?q=low|tv|tv-hd|high), run
   performance_sweep with url "<page url>" and the tiers it supports, plus actionKeys that reach gameplay.
4. Explain the numbers in plain words: is it smooth (median >= 30 and p10 >= 24)? How much memory
   headroom is left on a 1 GB stick? Which tier should ship for this device, and why?
5. Suggest the 3 changes that would help most (resolution scale, shadows, draw calls, texture sizes).
```

There is also a built-in prompt for this: **`tune_performance`**.

## 8. Will it run on every Fire TV?

*Needs a terminal assistant.*

```text
Use `firelab fit` to estimate whether my app runs on every Fire TV model.

Run `firelab fit --apk <path/to/app.apk> --url <page url if it is a web app> -d <device> --report fit.html`.
Then explain the matrix: which models are fine, which are risky and why (32-bit ABI, minSdk, WebGL
features, memory budget, GPU speed), and which model I should buy or borrow to test on for real.
Be clear that the verdicts are estimates from one device plus device profiles, not tests on each model.
```

## 9. Check D-pad navigation only

```text
Check the D-pad navigation of <my.package.id> with FireLab, nothing else.

Run explore_start with package "<my.package.id>", oracles ["focus"], minutes 10 (add focusSelector
"<css class of the focused element>" for a web app). When it's done, explore_findings.
List every focus trap, unreachable control, arrow key that goes the wrong way and place where focus
disappears, with the screen it happens on, the keys to get there, and how to fix the focus order.
```

## 10. Explain a FireLab report

```text
Here is a FireLab run folder: <path to the run folder, or the runId>.
Read findings.json and the trace files (or call explore_findings with that runId) and explain the
report to me as if I'd never used FireLab: what each finding means for a player, how serious it is,
how reliably it reproduced, and the order I should fix them in. Skip anything marked "info".
```

## 11. Add FireLab to CI

*Needs a terminal assistant and a GitHub repository.*

```text
Add FireLab's GitHub Action to this repository so every pull request is tested on a Fire-TV-shaped
emulator. Follow docs/LAB.md in the FireLab repository (the "GitHub Actions" section). Build the APK
in the workflow first, then run the action with the APK path and profile AFTSSS. Fail the job on
crash, black, frozen and focus-trap findings, upload report.html as an artifact and write report.md
to the job summary. Show me the workflow file before you commit it.
```

## 12. Make my game easier to test

*Needs a terminal assistant, with your game's code open.*

```text
Make my web game easier for FireLab's engine to test. In this codebase:

1. Add @firelab/perf (packages/perf in the FireLab repository) or a small `window.firelab` object
   that publishes: `paused` (true in menus), `targetFps`, and `marks.scene` (the current screen name).
2. Expose a small state object for FireLab's --state-expr, e.g. `window.game.ui = { scene, menuItem }`:
   only the few values that define the screen, no positions or timers.
3. Make sure the focused menu item has a CSS class (e.g. "focused") or real DOM focus.
4. Make keys you handle call preventDefault(), especially Back/Escape.
5. Tell me the exact explore command to use afterwards, with --state-expr and --focus-selector.
```

## 13. Test on Vega OS

*Needs a terminal assistant and the Vega SDK (`vega --version` works). FireLab's
Vega driver is built from Amazon's docs and has **not run on a real Vega device
or the Vega Virtual Device yet**: treat its results as a first check, and expect
key names or output parsers to need a fix ([docs/VEGA.md](VEGA.md)).*

```text
Test my Vega OS app <my.app.id> with FireLab on <the Vega Virtual Device | my Vega Fire TV at <ip>>.

1. Check the Vega setup: `vega --version`, then `vega exec vda devices -l`. For a Fire TV on Wi-Fi,
   run `vega exec vda connect <ip>` first. Run `npm run vega:check` in the FireLab repository and tell
   me which steps failed. Look at vega-check/screen.jpg yourself: does it show the TV screen?
2. If I gave you a .vpkg, the explore command installs it with --apk <file.vpkg>.
3. Run: firelab explore --driver vda --package <my.app.id> --minutes 20 --out vega-run --json
   (add -d <serial> when more than one Vega device is connected).
4. Summarise the findings, and read me the notes in vega-run/report.md: on Vega, FireLab can't read
   the app's state or focus (states come from the screen), and it sees the app go only when its
   process ends, so an unexpected-exit there is likely a crash. A dead end or frozen picture may be
   the launcher after Back left the app: check the screenshot before calling it a bug.
5. For each real finding, replay it: firelab replay --driver vda <trace> --times 5.
6. If a FireLab command failed or did nothing on the TV (e.g. a key that "worked" but the screen
   didn't change), tell me the exact command and output so I can report it.
```

---

## Without an AI assistant

The same things from a terminal:

```sh
firelab lab create --profile AFTSSS --install && firelab lab start --headless   # no Fire TV: an emulator
firelab explore --package <my.package.id> --minutes 20                          # find bugs
firelab replay <run>/traces/<finding>.min.trace.json --times 5                   # watch one again
firelab report <run> --open                                                      # open the report
```

See [GETTING-STARTED.md](GETTING-STARTED.md) for the full walkthrough.
