# Getting started: test your app on a Fire TV

This page walks you through testing an app or game on a Fire TV with FireLab,
from a new TV to a report you can act on. It also says what each step gives
you back. Go through it in order the first time. After that, use the
[cheat sheet](#cheat-sheet) at the end.

You need a Fire TV (any model), a computer on the same Wi-Fi, Node 22+ and adb
(`brew install --cask android-platform-tools`, `sudo apt install adb` or
`winget install Google.PlatformTools`). If you don't have a Fire TV yet, read
steps 1 and 2, then go to [step 7](#7-no-tv-or-ci-the-lab-and-the-github-action).

Install it:

```sh
npm install -g firelab        # or put `npx -y` in front of each command instead
```

(From source: `git clone https://github.com/AkilSaji/firelab.git && cd firelab && npm install && npm run build && npm link`.)

**No Fire TV?** Test a web game in headless Chrome at the Fire TV viewport:
`firelab explore --driver browser --url http://localhost:8080/ --minutes 10`.
**Just want to see it work first?** `firelab demo` runs the engine on a
simulated TV game with seeded bugs and opens the report in about five seconds.

## The journey at a glance

| Step | Command | What you get back |
|---|---|---|
| 1. Connect the TV | `firelab doctor`, `firelab devices --scan --connect` | A checked connection, with a fix for each problem |
| 2. Put your app on it | `firelab wrap --install` (web) or `firelab install` (APK) | Your app installed and launched |
| 3. Watch it | `firelab ui` | Screen mirror, remote, fps/memory charts, console |
| 4. Find bugs | `firelab explore` | `report.html`: each bug with a screenshot, the shortest key sequence that causes it and a reproduction rate |
| 5. Check performance | `firelab measure`, `firelab sweep` | fps, memory and CPU; the best quality tier for this TV |
| 6. Other Fire TV models | `firelab fit` | An *estimated* go / risky / no-go verdict for each Fire TV model |
| 7. No TV, or CI | `firelab lab`, the GitHub Action | Fire-TV-shaped emulators and a CI report |
| 8. Let an AI agent do it | `firelab mcp` | The same tools for Claude Code, Kiro, Cursor or VS Code |

## 1. Set up the TV (once)

1. On the Fire TV, open **Settings > My Fire TV > About** and select the device
   name 7 times. This turns on Developer options.
2. Open **Settings > My Fire TV > Developer options** and turn on
   **ADB debugging**.
3. Note the TV's IP address under **About > Network**.

On your computer:

```sh
firelab devices --scan --connect   # finds Fire TVs on your Wi-Fi and connects them
firelab doctor                     # checks adb, the device, Wi-Fi debugging and the wrap toolchain
```

The first time you connect, the TV asks **"Allow USB debugging?"**. Tick
**Always allow from this computer** and press **Allow**. If the scan doesn't
find the TV, connect by IP: `firelab connect 192.168.1.50`.

`firelab doctor` prints `[ok]`, `[!!]` (a warning) or `[XX]` (a problem) for
each check, and a numbered fix under every problem. Run it again until it says
**All set**. If something is still wrong, see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

If more than one device is connected, add `-d <serial|ip>` to any command.

## 2. Put your app on the TV

### A web game (HTML5, three.js, Phaser, ...)

Serve the game so the TV can reach it. The server must listen on your LAN
address, not only on `localhost`. With Vite, run `vite --host`. To try the
included example game, run `npm start --workspace examples/web-game`
(Firefly Lake, port 8080).

Then wrap the URL into a Fire TV app and install it:

```sh
firelab wrap --check     # once: checks that the Android build-tools and JDK 17 are there
firelab wrap --url http://192.168.1.20:8080/ --name "My Game" --package dev.firelab.mygame --install 192.168.1.50
```

`wrap` builds a debuggable APK (no Gradle needed), installs it and launches it.
The remote reaches your page as keyboard events: arrow keys, `Enter` for OK,
and `Escape` for Back (call `preventDefault()` to handle Back yourself). The
APK is a **debug build on purpose**: FireLab needs WebView debugging to read
the console, count frames and check focus. Keep `--release` for the build you
publish.

You only wrap once. When you change your game, reload the page; you don't need
to rebuild the APK.

### A native APK (Android, Unity, Unreal, Godot, ...)

```sh
firelab install build/my-game.apk   # checks the APK's ABI and minSdk against the TV first
firelab launch com.example.mygame   # prints the launch time (cold/warm start)
```

## 3. Watch it in the dashboard

```sh
firelab ui        # opens http://127.0.0.1:7300
```

The dashboard shows a live mirror of the TV screen, a virtual remote (your
keyboard's arrows, Enter and Backspace work too), fps, memory and CPU charts,
and the WebView console. You can also run sweeps from it. Leave it open while
you do the next steps.

## 4. Find bugs: `firelab explore`

`explore` plays your app with the remote on its own. It looks for new screens,
tries every key on each one, and records anything that goes wrong.

```sh
firelab explore --package dev.firelab.mygame --minutes 30
# a web game: add --url so every relaunch opens the right page
firelab explore --package dev.firelab.mygame --url http://192.168.1.20:8080/ --minutes 30
# a native APK: --apk installs it first and reads the package from it
firelab explore --apk build/my-game.apk --minutes 30
```

Real TVs are slow, at about 3 seconds per key press including a screenshot. So
10 minutes is a quick look of a few hundred steps, and 30 minutes or more
finds deeper bugs. When the time is up, FireLab spends up to 20 more minutes
(`--minimize-minutes`) shrinking each finding. While it runs, it prints new
screens and findings as it finds them. When it finishes, it prints the
findings and the path to the report.

### What it checks, and for which apps

| Check (`--fail-on` name) | What it finds | Native APK | Web app (wrapped) |
|---|---|---|---|
| Crash / ANR (`crash`) | The app crashed or stopped responding (logcat), or the WebView renderer died | ✅ | ✅ |
| Unexpected exit (`exit`) | The app left the foreground without you pressing Home | ✅ | ✅ |
| Black screen (`black`) | The screen stayed black for two settled steps (fades don't count) | ✅ | ✅ |
| Frozen screen (`frozen`) | The picture stopped changing although key presses used to change it | ✅ | ✅ |
| JS errors (`js`; `error` adds `console.error`) | Uncaught exceptions and `console.error` in the page | – | ✅ |
| Render loop stopped (`frozen`; `webgl`) | The game says it is rendering but no frame was drawn for 2 s; the WebGL context was lost | – | ✅ (needs [`window.firelab`](../packages/perf)) |
| Focus trap (`focus-trap`) | A group of controls the D-pad can't leave | – | ✅ |
| Unreachable control (`unreachable`) | A visible button the D-pad can never reach | – | ✅ |
| Non-spatial move (`non-spatial`) | An arrow key jumps somewhere that doesn't match the layout | – | ✅ |
| Focus lost (`focus` = all four focus checks) | Focus disappears, so nothing is highlighted | – | ✅ |
| Stuck (`stuck`) | A screen the explorer can't leave by any key | ✅ | ✅ |

**Native APKs get the crash, ANR, exit, black and frozen checks only**,
because FireLab can see their logs and pixels but not their UI tree. For a
native app, states come from a visual hash of the screen. Web apps also get
JS errors, the render-loop check and the focus checks, because FireLab reads
the page through Chrome DevTools. The focus checks need focus information:
DOM focus, a CSS class you name with `--focus-selector .focused`, or
`window.firelab.marks.focus`. A pure canvas UI with none of these skips the
focus checks, and the report tells you how to switch them on.

### Read the report

Open the `report.html` path that `explore` printed, or add `--open`. By
default the run lives in `~/.firelab/explore/<runId>/`; use `--out dir` to put
it somewhere else. The report is one self-contained file you can attach to a
bug, and the folder also holds `report.md` for a pull request.

- **The header** shows the app, the device (model, RAM, tier), how long it
  ran, how many steps and states, and a curve of states found over time.
- **Each finding** is a card, critical first:
  - **The screenshot** of the moment it was found, with a strip of the screens
    on the way there.
  - **Shortest repro**: the key sequence, shrunk from the full path
    (`menu up up up`, "from 37"). Pressing these keys from a fresh launch
    causes the bug.
  - **The reproduction rate, k/n**: how many of n replays from a fresh launch
    showed the bug again. 5/5 is solid. **Confirmed** means it reproduced in
    at least 60 % of replays; **flaky** means it reproduced sometimes (a bug
    that depends on timing or randomness); **not reproduced** means it never
    came back, so treat it as a lead and not as a proven bug.
  - **A copy-paste `firelab replay` command**, plus the log excerpt and the
    probe values (scene, focus, frame counter) at that moment.
- **State map**: a thumbnail for every screen it found, sized by how often it
  visited. Outlined thumbnails are screens it found but didn't explore.
  Underneath is the focus graph of each screen it walked.
- **Notes**: which checks were off and why, and what to add to switch them on.

### Fix it, then prove it's fixed

```sh
firelab replay ~/.firelab/explore/<runId>/traces/<findingId>.min.trace.json --times 5
```

`replay` relaunches the app, presses the keys and prints `reproduced k/n`.
Run it before your fix (5/5) and after it (0/5). You can also shrink an
unshrunk finding later with `firelab shrink <runDir>:<findingId>`, and rebuild
a report with `firelab report <runId | dir>`.

To use it as a gate, add `--fail-on crash,black,frozen,focus-trap`. Then
`explore` exits with code 1 when a matching finding reproduces. Use `--json`
for a machine-readable summary. Add `--seed 1` to make a run repeatable.

## 5. Check performance

```sh
firelab measure --package dev.firelab.mygame --seconds 10
```

`measure` prints the fps median and p10 (the slowest 10 %), memory (the app
plus its WebView renderer), CPU, and for native apps the jank from
SurfaceFlinger frame timing. For web games, frame counts come from
`window.firelab` when your page publishes it
([`@firelab/perf`](../packages/perf) does). Without it, an injected probe
counts the frames that really drew WebGL.

For a web game that has quality tiers (`?q=low|tv|tv-hd|high`; `@firelab/perf`
gives you these), the sweep finds the best tier for this TV:

```sh
firelab sweep --url http://192.168.1.20:8080/ --package dev.firelab.mygame --tiers low,tv,tv-hd,high
```

It loads the page at each tier, measures it, and recommends the richest tier
that holds 30 fps, with the reason. To record a real person's play session
(keys, fps, memory, errors and thumbnails), run `firelab watch --minutes 10`.

## 6. Other Fire TV models: `firelab fit`

You own one Fire TV, but your players have more than 60 models. `firelab fit`
measures your app on the TV you have, then compares the result with what each
model has (RAM, GPU, WebGL, video decoders, Android API). You get a verdict
for each model:

```sh
firelab fit --apk build/my-game.apk --url http://192.168.1.20:8080/ -p dev.firelab.mygame --tiers tv,tv-hd --simulate all --report fit.html
```

```
✅  Fire TV Stick 4K Plus (AFTMA08C15)   runs        All checks pass        [estimated, medium]
⚠️  Fire TV Stick (3rd gen) (AFTSSS)     risky       Memory: 435 / 415 MB   [profile, high]
❌  Fire TV Stick (2nd gen) (AFTT)       won't run   WebGL: no WebGL2       [estimated, high]
```

**These are estimates, not test results.** They come from one device plus a
profile of each model. Only two profiles, **AFTMA08C15** (Fire TV Stick 4K
Plus) and **AFTSSS** (Fire TV Stick 3rd gen), were measured on real hardware
with `firelab profile`. Every other model comes from published specs and is
marked `estimated`, with a confidence level. Use `fit` to decide which models
to test by hand first, and test on the real device before you ship. To add a
model, run `firelab profile` on that TV and open a pull request with the
`profiles/<MODEL>.json` it writes.

Other ways to run it:

```sh
firelab fit --static --apk build/my-game.apk --needs webgl2   # no device: manifest, ABI, minSdk, needs
firelab fit --offline firelab-measurement.json --fail-on AFTSSS,AFTSS   # re-score a saved run, e.g. in CI
firelab media ./videos                                      # do your MP4s play on every model's decoders?
```

`fit` saves `firelab-measurement.json` after measuring, so CI can re-score it
without a TV. `--fail-on` exits with code 2 when one of those models gets ❌.
See `firelab fit --help`.

For web games, `--emulate-gpu` shows where the game breaks on a model's GPU
without that model: WebGL reports only that GPU's features and limits (WebGL2,
texture sizes, extensions, compressed formats, shader precision) and the calls
that fail are listed. It copies features and limits, not speed, and works on
the device you own, the emulator lab (`firelab explore --emulate-gpu AFTT`) or
desktop Chrome (`--script`). See [GPU.md](GPU.md).

```sh
firelab fit --emulate-gpu AFTT,AFTSSS --url http://192.168.1.20:8080/ -p dev.firelab.mygame --seconds 60
```

## 7. No TV, or CI: the lab and the GitHub Action

`firelab lab` makes an Android emulator shaped like a Fire TV model, with the
same **RAM and heap, Android API level, and screen size and density**. Every
FireLab command then works on it as if it were a TV.

```sh
firelab lab doctor                              # what's missing, with install commands
firelab lab create --profile AFTSSS --install   # Fire TV Stick (3rd gen): Android 9, 1 GB, 1080p
firelab lab start --headless
firelab lab smoke --apk build/my-game.apk       # install, launch, screenshot, no crash/ANR, memory vs the budget
firelab explore --apk build/my-game.apk --minutes 10
firelab lab stop
```

The emulator **does not match the TV's GPU** (Mali or PowerVR), its ARM CPU,
Amazon's WebView or Fire OS services. So emulator frame rates and launch
times say nothing about a real stick. Use the lab for crashes, memory limits,
layout at TV resolution and the explore checks. Use `firelab fit` and a real
TV for performance.

In CI, the [FireLab lab action](../action/action.yml) does all of this on
GitHub's `ubuntu-latest`. It runs the smoke checks and `firelab explore`,
uploads the HTML report and writes a job summary:

```yaml
- uses: AkilSaji/firelab/action@v0
  with:
    apk: app/build/outputs/apk/debug/app-debug.apk   # or url: https://my-game.example/
    profile: AFTSSS
```

Details are in [LAB.md](LAB.md).

## 8. Let an AI agent test it: MCP

`firelab mcp` gives an AI agent the same abilities. It can see the screen,
press the remote, read the console, measure, sweep and run `explore`.

```sh
claude mcp add firelab -- npx -y firelab mcp   # or `-- firelab mcp` after npm install -g
```

It runs on your computer, next to adb; nothing goes to a cloud service. The
configs for Claude Desktop, Kiro, Cursor, VS Code, a no-`npm link` setup and
the HTTP transport (`firelab mcp --http 7301`, then connect to
`http://127.0.0.1:7301/mcp`) are in the
[README](../README.md#60-second-quick-start). Then ask the agent:

> Explore my game dev.firelab.mygame for 20 minutes, then fix the critical
> findings and replay each one to prove it's fixed.

Ready-made prompts for every step, including testing without a Fire TV, are in
[PROMPTS.md](PROMPTS.md).

The `explore_app`, `playtest` and `tune_performance` prompts and the `explore_*` tools are
listed in [TOOLS.md](TOOLS.md).

## Cheat sheet

```sh
firelab doctor                                         # is everything set up?
firelab devices --scan --connect                       # find and connect TVs
firelab wrap --url <url> --name <name> --install <ip>  # web game -> Fire TV app
firelab install app.apk                                # native app
firelab ui                                             # dashboard
firelab explore --package <pkg> --minutes 30           # find bugs -> report.html
firelab replay <trace.json> --times 5                  # does it still reproduce?
firelab measure --package <pkg>                        # fps, memory, CPU
firelab sweep --url <url> --tiers low,tv,tv-hd,high    # best quality tier
firelab fit --apk app.apk -p <pkg>                     # estimated verdict for each Fire TV model
firelab lab create --profile AFTSSS --install          # emulator shaped like a Fire TV Stick
firelab help                                           # everything else
```
