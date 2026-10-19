# @firelab/perf

**Keep TV web games smooth.** A tiny, dependency-free browser library that
works out which GPU it is running on, picks a quality tier for it, holds a
target frame rate by adjusting the render resolution, shows an on-screen
meter, and publishes its numbers on `window.firelab` for the
[FireLab](../../README.md) tester.

It is plain ES modules, so there is no build step. It works with three.js,
Babylon.js, PixiJS or your own WebGL/canvas code, and is MIT licensed.

## Why

A Fire TV Stick is not a laptop. On a 1 GB Fire TV Stick (3rd gen, PowerVR
GE8300), a three.js game that is fine on a MacBook drops to 13–17 fps with sun
shadows and stutters at 1080p. The same game holds 27 fps on the right tier
at 768×432. A Fire TV Stick 4K Max (PowerVR GE9215) runs the richer tier at
up to 1080p. Web apps can't see any of this, and fixing it by hand means
reading GPU strings, guessing resolutions and writing your own fps maths.

With `@firelab/perf` you write one line, and it:

- **detects the chip** (`WEBGL_debug_renderer_info`, user-agent hints for Fire
  TV `AFT…` models, Android TV, Silk) and maps it to a tier: `low`, `tv`,
  `tv-hd` or `high`. A table of real GPUs drives the mapping, and every entry
  says why it got its tier.
- **holds your target fps** (30 on TVs by default) by stepping the render
  scale between a floor and a ceiling. It uses hysteresis, warm-up and a
  cooldown, and blocks levels that just failed, so it does not oscillate.
  If even the floor is too slow, it remembers a lighter tier for the next
  launch.
- **shows a meter** with `?perf=1` or a double tap of the remote's ⏪ button:
  an fps sparkline, frame-time p50/p95, render scale, canvas size, tier, GPU,
  draw calls, triangles and JS heap. It draws on a single 2D canvas about 4
  times a second, so it costs almost nothing.
- **publishes `window.firelab`**, so `firelab sweep`, `measure_performance`
  and the dashboard can read real numbers over DevTools instead of guessing.

## Install

```sh
npm install @firelab/perf
```

Or with no bundler at all:

```html
<script type="module">
  import { createPerf } from 'https://cdn.jsdelivr.net/npm/@firelab/perf@0.1.0/index.js';
</script>
```

For zero code (meter, hook and fps counting, but no resolution control):

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@firelab/perf@0.1.0/auto.js"></script>
```

## Ten lines with three.js

```js
import * as THREE from 'three';
import { createPerf } from '@firelab/perf';

const perf = createPerf();                                  // detect the GPU, pick a tier
const q = perf.pick({ low: { shadows: false }, 'tv-hd': { shadows: true } });
const renderer = new THREE.WebGLRenderer({ antialias: perf.tier !== 'low' });
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = q.shadows;
perf.attach(renderer);                                      // adaptive resolution drives setPixelRatio()
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
  perf.frame();                                             // count this frame
});
```

Then open the page with `?perf=1` to see the meter, or `?q=tv-hd` to force a
tier.

Other engines:

```js
perf.attach(engine);                  // Babylon.js: setHardwareScalingLevel()
perf.attach(app);                     // PixiJS v7/v8: renderer.resolution
perf.attach(canvas);                  // a raw canvas: sets width/height
createPerf({ setScale: (scale, { pixelRatio, width, height }) => myEngine.resize(width, height) });
```

## Quality tiers

| Tier | For | Resolution budget at scale 1 |
|---|---|---|
| `low` | Mali-450, Mali-T720, software rendering. Minimal effects. | 540p |
| `tv` | PowerVR GE8300 (Fire TV Stick 3rd gen, Lite, 4K 2018), Mali-G31/G51, Adreno 3xx–5xx. No shadows. | 720p |
| `tv-hd` | PowerVR GE9215/GE9xxx (Fire TV Stick 4K Max), Mali-G52+, Adreno 6xx+, Tegra X1. Sun shadows. | 1080p |
| `high` | Desktop and laptop GPUs. | 1440p |

The budget never exceeds the screen's real pixels (`devicePixelRatio`).
Tiers say how much a device can draw. What that means for your scene is your
choice, and `perf.pick(map)` reads it, falling back to the nearest lighter
tier you defined.

**How the tier is chosen** (first match wins):

1. The URL parameter `?q=<tier>` (`?q=auto` ignores every override). The
   FireLab sweep uses this one.
2. `createPerf({ tier })` from your code.
3. A tier the user saved: `perf.setTier('tv-hd')`, stored in localStorage.
4. A stored automatic fallback: the auto-picked tier proved too slow on this
   device. It is kept for 30 days and only for the same GPU.
5. Chip detection.

TVs, sticks, phones and tablets never get `high`; they are capped at `tv-hd`.
Without WebGL2 the cap is `low`. A GPU that is not in the table starts on
`high` on desktops and on `tv` everywhere else.

## The chip table

The table is data-driven ([`src/chips.js`](src/chips.js), exported as `CHIPS`
and from `@firelab/perf/chips` for Node tools). The first match wins, and each
entry carries `family`, `tier`, `why`, and, where known, `devices` and
`measured`. In summary:

| GPU | Tier | Why |
|---|---|---|
| **PowerVR GE8300** (Fire TV Stick 3rd gen AFTSSS, Lite AFTSS, 4K 2018 AFTMM) | `tv` | 1 GB sticks: 720p, no shadows. *Measured on Sunset Villa: 27 fps standing / 24 walking at 768×432 on `tv`; 13–17 fps on `tv-hd` with shadows.* |
| PowerVR GE8320 / GE8322 | `tv` | Same 8XE family, similar fill rate. |
| PowerVR GE8100 | `low` | Single-cluster, about half a GE8300. |
| **PowerVR GE9215** (Fire TV Stick 4K Max 2nd gen AFTMA08C15, 4K Max 2021 AFTKA) | `tv-hd` | 2 GB sticks: 1080p when the scene is light. *Measured: `tv-hd` up to 1080p.* |
| PowerVR GE9xxx, GM9xxx, IMG B-Series (BXE/BXM), C/D-Series | `tv-hd` | Successors of the GE8300 with roughly twice the fill rate or more. |
| PowerVR Series6/7 (GX6250 in the 2015 Fire TV) | `tv` | ES 3, TV-class. |
| PowerVR SGX | `low` | ES 2 only. |
| **Mali-400 / 450 / 470** (Fire TV Stick 2nd gen, Fire TV 3rd gen, Cube 1st gen, most 2015–2019 boxes) | `low` | ES 2 only, so **no WebGL2**: WebGL2 games can't run there. |
| Mali-T6xx / T720 / T760 / T820 / T830 | `low` | Budget Midgard: Mali-450-class fill rate. |
| Mali-T860 / T880 | `tv` | 2016 flagship Midgard, clocked down in boxes. |
| **Mali-G31 / G51 / G310** (Chromecast with Google TV, Mi Box S 2nd gen) | `tv` | About GE8300 speed. |
| Mali-G52 and newer, Immortalis (Fire TV Cube 2nd/3rd gen) | `tv-hd` | 1080p with shadows within reach. |
| Adreno 2xx, 302–308 | `low` | Entry Snapdragon GPUs. |
| Adreno 3xx–5xx (Fire TV 1st gen: Adreno 320) | `tv` | Mid-range 2013–2018. |
| Adreno 6xx and newer | `tv-hd` | 1080p with shadows. |
| Adreno X / 8cx (Windows on Arm) | `high` | Laptop class. |
| NVIDIA Tegra X1 (SHIELD TV) / Tegra 4, K1 / Tegra 2, 3 | `tv-hd` / `tv` / `low` | |
| NVIDIA GeForce/RTX, AMD Radeon, Intel UHD/Iris/Arc, Apple M-series | `high` | Desktops and laptops. |
| Intel HD 400–605, Bay Trail, Cherry Trail | `tv` | Atom-class laptops and Chromebooks. |
| Apple A-series | `tv-hd` | Phones, tablets, Apple TV. |
| SwiftShader, llvmpipe, Microsoft Basic Render | `low` | No GPU: every pixel costs CPU time. |
| Vivante GC, VideoCore IV / V3D 4 (Fire TV Stick 1st gen) | `low` | Very little fill rate. |

When the browser hides the GPU name, `FIRE_TV_MODELS` maps Fire TV model codes
from the user agent (AFTSSS, AFTMM, AFTKA, AFTMA08C15, …) to their GPU and
tier.

Found a device that gets the wrong tier? Add a renderer string to
`test/chips.test.js` and an entry to `CHIPS` (with a `why`), then send a pull
request. Measurements from real devices are the most valuable contribution.

## Adaptive resolution

The render **scale** is a share of the tier's resolution budget. With the
defaults on a `tv` stick (960×540 CSS pixels), 0.6–1.0 means 768×432 up to
1280×720.

Every 2 s of rendered frames it measures the frame rate, ignoring the slowest
5 % of frames (a GC pause is no reason to blur the picture), then:

- **below 90 % of target** (27 fps at 30): one step down, or two steps below
  67 %.
- **above 95 % of target**: once this has held for 3 windows in a row and 10 s
  have passed since the last change, one step up.
- **in between**: hold.
- **warm-up**: ignores the first 3 s (shader compiles) and 1 s after every
  change or resume.
- **anti-oscillation**: a level that has to be undone within 8 s of a raise is
  blocked for 3 minutes. Each further failure doubles the block, up to
  30 minutes.
- **tier fallback**: at the floor and still below 75 % of target for 4 windows
  in a row, it fires a `fallback` event. If the tier was auto-picked, the
  lighter tier is stored for the next launch. A tier forced with `?q=` or from
  code is reported but never overwritten.

Desktops (`high`) start at scale 1. TVs start at 0.75 and climb when there is
headroom. `?scale=0.8` pins the scale and turns adaptation off, which is handy
in sweeps.

**Pause measurement** whenever frames are not representative, for example
under a video, a loading screen or a menu over a frozen scene. Reasons stack:

```js
perf.pause('video'); /* … */ perf.resume('video');
createPerf({ pauseWhileVideo: true }); // or let it watch <video> elements itself
```

The adaptive controller is also exported on its own as a pure state machine
(`createAdaptiveResolution`). Feed it frame durations and it calls you back,
so you can use it in any loop or test it with synthetic frame times.

## The meter

Show it with `?perf=1` (`meter: { position: 'top-left' }` to move it), or
toggle it with **two quick taps of ⏪ rewind** on the remote. On a keyboard,
press the backquote key twice. `perf.meter.toggle()` also works. Taps are
counted on keyup, because Fire TV remotes repeat keydown while a button is
held, and the meter never cancels a key. While hidden it creates nothing.

## `window.firelab`

The page hook from the FireLab contract is refreshed about 4 times a second.
It holds plain data, so `JSON.stringify(window.firelab)` always works:

```js
{
  version: '1', tier: 'tv', autoTier: 'tv', gpu: 'PowerVR Rogue GE8300',
  fps: 27.4, fpsMedian: 26.9, frameMs: { p50: 36.1, p95: 52.0 },
  scale: 0.6, canvas: { width: 768, height: 432 },
  drawCalls: 175, triangles: 249360, heapMB: 54,
  marks: { scene: 'explore' },   // perf.mark('scene', 'explore')
  paused: false, targetFps: 30
}
```

`window.__firelabPerf` (non-enumerable) is the live API, for consoles and
sweeps.

## Pairing with the FireLab sweep

`firelab sweep` (and the `performance_sweep` MCP tool) opens your app on a
real device once per tier with `?q=low`, `?q=tv`, `?q=tv-hd`, …, waits,
samples `window.firelab`, and recommends the richest tier that holds your
target. To get useful results:

- Keep the parameter name `q`, or tell the sweep yours (`param`).
- Make the measured state reachable without a person: an `?autoplay=1` that
  plays itself, or a sweep `action` (`keys` or `eval`, e.g.
  `demo.setBusy(true)`).
- Call `perf.pause()` under videos and menus. The hook's `paused` flag tells
  the sweep to skip those samples.
- Use `perf.mark()` to label what is on screen, so the timeline shows it.

## API

```ts
createPerf(options?): Perf
```

| Option | Default | |
|---|---|---|
| `targetFps` | `30` | a number, or `(tier, detection) => number` (e.g. 60 on `high`) |
| `tier` | | force a tier from code (the URL still wins) |
| `param` / `meterParam` / `scaleParam` | `'q'` / `'perf'` / `'scale'` | URL parameter names |
| `storageKey` | `'firelab-tier'` | localStorage key prefix |
| `adaptive` | `true` | `false`, or options for the controller (`minScale`, `maxScale`, `initialScale`, `stepDown`, `stepUp`, `windowMs`, `warmupMs`, `settleMs`, `dropBelow`, `raiseAbove`, `raiseAfter`, `cooldownMs`, `retreatMs`, `blockMs`, `trim`, `fallbackBelow`, `fallbackWindows`) |
| `fallback` | `true` | store a lighter tier when the auto-picked one can't hold the target |
| `scale` | | pin the scale (turns adaptation off) |
| `meter` | `'auto'` | `true`, `false`, or `{ position, keys, visible }` |
| `hook` | `true` | publish `window.firelab` |
| `pauseWhileVideo` | `false` | pause while any `<video>` plays |
| `renderer` / `adapter` / `setScale` / `canvas` | | what to resize (or call `perf.attach()` later) |
| `tiers` | | per-tier overrides: `{ tv: { maxHeight: 648, minScale: 0.8 } }` |
| `detection` | | skip detection (e.g. from `detectDevice()`) |
| `autoFrames` | `true` | count rAF callbacks until you call `perf.frame()` |

| `Perf` member | |
|---|---|
| `tier`, `autoTier`, `source`, `detection`, `preset`, `targetFps`, `scale`, `scaleInfo`, `paused`, `hook` | state |
| `pick(map)` | the value for the current tier |
| `frame(now?)` | call once per rendered frame |
| `attach(target)` / `detach()` | start/stop resizing a renderer |
| `pause(reason?)` / `resume(reason?)` | stack-able measurement pauses |
| `mark(key, value)` | expose app state on the hook (`undefined` removes) |
| `report({ drawCalls, triangles })` | when the adapter can't read them |
| `setTier(tier \| 'auto', { persist = true, reload = false })` | switch at run time |
| `clearFallback()` | forget a stored fallback |
| `on(event, fn)` → unsubscribe | `scale`, `tier`, `fallback`, `sample`, `window`, `pause` |
| `meter.show() / hide() / toggle()` | |
| `snapshot()` | a JSON copy of the hook |
| `destroy()` | remove listeners, timers, meter and hook |

Lower-level building blocks, all exported:

- **Detection:** `detectDevice`, `readGpu`, `classifyDevice`, `classifyGpu`,
  `parseUserAgent`, `cleanGpuName`, `CHIPS`, `FIRE_TV_MODELS`.
- **Tiers:** `TIERS`, `TIER_IDS`, `normalizeTier`, `lighterTier`, `capTier`,
  `pick`, `resolveTier`.
- **Adaptive resolution and frame timing:** `createAdaptiveResolution`,
  `createFrameLimiter` (a steady 30 on a 60 Hz TV), `createFrameStats`,
  `percentile`.
- **Hook:** `createHookObject`, `updateHook`, `validateHook`.
- **Meter and keys:** `createMeter`, `createTapDetector`.
- **Adapters:** `threeAdapter`, `babylonAdapter`, `pixiAdapter`,
  `canvasAdapter`, `computeScaleInfo`.

The types live in [`index.d.ts`](index.d.ts).

## Tests

```sh
npm test        # node --test, no dependencies
```

The suite has 236 tests. They cover chip matching against about 90 real
renderer strings, user-agent parsing, tier precedence and storage, percentile
maths, the adaptive controller driven by synthetic frame times (steps down,
recovers, no oscillation on a marginal device, pauses, fallback), the
`window.firelab` shape, the meter, the key combo, the adapters and
`createPerf` end to end in a fake browser.

## Example

[`examples/web-game`](../../examples/web-game) is Firefly Lake, a small
three.js game that uses all of the above.

## License

MIT
