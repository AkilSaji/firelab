# Firefly Lake: a FireLab demo game

A small three.js game for Fire TV and Android TV. You sail a paper boat down a
lake at sunset, dodge rocks and catch lanterns. It uses
[`@firelab/perf`](../../packages/perf) end to end:

| Feature | Where to see it |
|---|---|
| Chip detection to a quality tier | The badge in the bottom-left corner (`tv · auto`, `tv-hd · url`, …) |
| Per-tier scene settings with `perf.pick()` | Trees, fireflies, water detail, shadows and lights in `QUALITY` (game.js) |
| Adaptive resolution (30 fps on TVs, 60 on desktops) | The meter's `scale` and canvas size |
| A steady 30 fps frame cap on TVs (`createFrameLimiter`) | `p50 33.3 ms` on the meter |
| On-screen meter | `?perf=1`, or tap ⏪ twice (backquote twice on a keyboard) |
| `window.firelab` for the FireLab tester | DevTools console: `firelab` |
| Pausing measurement in menus (`perf.pause('menu')`) | The meter shows "paused · menu" |
| Tier fallback events | A toast when the tier can't hold its target |
| Quality switching at run time (`perf.setTier`) | Pause menu → Quality |
| A **busy scene** for sweeps to measure | ⏩, the B key, `?busy=1`, or `demo.setBusy(true)` |

## Run it

From the repository root (Node 20+, no install needed):

```sh
node examples/web-game/serve.mjs              # http://localhost:8080
node examples/web-game/serve.mjs --port 9000
```

The server serves the repository root, so the page can import
`packages/perf` directly. It listens on every interface and prints the LAN
address to open on the TV, for example
`http://192.168.1.20:8080/examples/web-game/`. `npx serve .` from the
repository root works too. three.js 0.170.0 loads from jsDelivr through an
import map, so the TV needs internet access.

URL parameters:

| Parameter | Effect |
|---|---|
| `?perf=1` | show the meter |
| `?q=low\|tv\|tv-hd\|high` | force a quality tier (`?q=auto` = detection) |
| `?busy=1` | start in the busy scene: 8× trees, 2048 px shadows, 4 extra point lights, 4× fireflies, 4× water detail |
| `?autoplay=1` | the game plays itself (an autopilot dodges rocks) until a key is pressed, for sweeps and demo videos |
| `?scale=0.8` | pin the render scale (no adaptation) |
| `?fps=60` | target fps (default 30 on TV tiers, 60 on `high`) |
| `?cap=0` | no frame cap |

Controls: ◀ ▶ steer, OK or ▲ jump, ☰ or Back to pause, ⏩ busy scene,
⏪⏪ meter. Back at the title screen is left to the app, so a wrapped app
exits there.

## On a Fire TV

Open it in the Silk browser, or wrap it as an app:

```sh
firelab wrap --url http://192.168.1.20:8080/examples/web-game/ --name "Firefly Lake" --install 192.168.1.50
```

The wrapper passes the remote through as keyboard events (◀ ▶ arrows, OK =
Enter, ⏪ = `MediaRewind`, ⏩ = `MediaFastForward`, ☰ = `ContextMenu`). Its
WebView debugging is on, so FireLab can read `window.firelab`.

## Point FireLab's sweep at it

```sh
# in the wrapped app (firelab wrap above): FireLab relaunches it with each ?q=<tier>
firelab sweep --package dev.firelab.fireflylake --url "http://192.168.1.20:8080/examples/web-game/?autoplay=1" --tiers low,tv,tv-hd
# the heavy case
firelab sweep --package dev.firelab.fireflylake --url "http://192.168.1.20:8080/examples/web-game/?autoplay=1&busy=1"
# or switch the busy scene on after the page loads
firelab sweep --package dev.firelab.fireflylake --url "http://192.168.1.20:8080/examples/web-game/?autoplay=1" --eval "demo.setBusy(true)"
```

Agents can use the MCP tool `performance_sweep` with
`{ "url": "…/examples/web-game/?autoplay=1", "tiers": ["tv", "tv-hd"], "action": { "eval": "demo.setBusy(true)" } }`.
The sweep loads the page once per tier with `?q=<tier>`, samples
`window.firelab.fpsMedian`, `frameMs` and `scale`, and recommends the richest
tier that holds 30 fps.

## Seeded bugs for the game-testing engine

`?bugs=<list>` loads [`bugs.js`](bugs.js), which plants bugs for
`firelab explore` to find. The normal game never loads it. A seeded build also
starts every launch at the auto-detected tier, so runs and replays repeat.

| `?bugs=` | What it does | What the engine should report |
|---|---|---|
| `freeze` | after the 2nd lantern of a run the render loop is not rescheduled | `render-loop-stopped` / `frozen-screen` |
| `black` | OK again within 300 ms of choosing Resume blanks the screen | `black-screen` |
| `throw` | pause menu: ▶ then ◀ on Quality throws a TypeError | `js-exception` |
| `trap` | once focus visited Quality, ▲▼ only cycle Busy/Quality/Meter and Back does nothing | `focus-trap` |
| `grid` | the menu is drawn in 2 columns with a 6th "Credits" cell, but ▲▼ move ±1 in list order and wrap before Credits | `unreachable-control`, `non-spatial-move` |
| `all` | all five | |

```sh
firelab explore --package dev.firelab.fireflylake \
  --url "http://192.168.1.20:8080/examples/web-game/?bugs=all" \
  --state-expr demo.ui --focus-selector "#menu-list li.focused" --minutes 10
```

`demo.ui` is a small state for the engine (`{ mode, item, lanterns }`), so a
score or a timer doesn't turn every frame into a new state.

`window.demo` gives sweeps and the console a handle: `demo.setBusy(on)`,
`demo.start()`, `demo.title()`, `demo.menu()`, `demo.state`, and `demo.perf`
(the `@firelab/perf` instance).

## Files

| File | |
|---|---|
| `index.html` | the page, HUD and screens, plus the import map (three.js from jsDelivr, `@firelab/perf` from `packages/perf`) |
| `game.js` | perf setup, quality table, game logic, D-pad input, menus |
| `bugs.js` | seeded bugs for `firelab explore`, loaded only with `?bugs=` |
| `world.js` | the scene: sky and water shaders, instanced pine trees, fireflies, the boat, `applyQuality()` |
| `style.css` | 16:9 TV layout that scales with the viewport, inside a 5 % safe area |
| `serve.mjs` | a dependency-free static server for the repository root |
