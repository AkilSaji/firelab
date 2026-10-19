# GPU capability emulation

The emulator lab (`firelab lab`) matches a Fire TV model's RAM, screen and
Android API level, but it renders with your computer's GPU. A laptop GPU can't
be made to run at a stick's speed, but a GPU's **features and limits** are
fixed per chip, and they cause a whole class of "it breaks on this stick" bugs
that you can catch without the stick:

- the game asks for WebGL2 on a Mali-450 stick, which has none;
- a 8192x8192 texture atlas on a GPU whose `MAX_TEXTURE_SIZE` is 4096;
- S3TC (DXT) textures, which no Fire TV GPU decodes;
- `EXT_color_buffer_float` or `OES_texture_float_linear` where the GPU has neither;
- `precision highp float` in a fragment shader on a GPU with no fragment highp;
- bone textures read in the vertex shader on a GPU with no vertex texture units;
- WebGPU, which the Fire TV WebView doesn't have.

`--emulate-gpu <model>` loads a script before the page's own scripts that makes
WebGL report only what that model's GPU supports, and answer the way its driver
does when the game asks for more.

> **This copies GPU features and limits, not speed.** Frame rates under the
> shim are your machine's, not the stick's. For speed, measure on a real device
> (`firelab fit --tiers ... --simulate all`) or use the measured profiles.

## Use it

On the device or the emulator lab, in a debuggable WebView (an app made by
`firelab wrap`, or any WebView app with debugging on):

```sh
firelab fit --emulate-gpu AFTSSS --url http://10.0.2.2:8080/ -p dev.firelab.mygame
firelab fit --emulate-gpu AFTSSS,AFTT --seconds 60        # several models, one after the other
firelab fit --emulate-gpu AFTT --json --markdown gpu.md --strict   # exit 2 when a call failed
```

It installs the shim with DevTools (`Page.addScriptToEvaluateOnNewDocument`),
loads `--url` (or reloads the page), runs for `--seconds` (default 20: play the
game meanwhile to reach more WebGL code), lists the WebGL calls that failed,
then removes the shim and puts the page back.

To let the engine play the game for you under a model's GPU:

```sh
firelab lab create --profile AFTSSS --install && firelab lab start --headless
firelab explore -p dev.firelab.mygame --url http://10.0.2.2:8080/ --emulate-gpu AFTT --minutes 10
```

The shim goes in after every launch (one extra page reload), and the `gpu`
oracle turns each failed call into a `gpu-unsupported` finding (major; minor
when the game asked for WebGL2 and went on drawing with WebGL1), shrunk to the
shortest key sequence like every other finding. Replays and shrinking install
the same GPU profile, which is saved in the trace. `--fail-on gpu` gates on it.
The run's notes list every failed call and every capability check that came
back empty. The MCP `explore_start` tool takes `emulateGpu` too.

Without a device, in desktop Chrome:

```sh
firelab fit --emulate-gpu AFTT --script firelab-gpu-AFTT.js     # the shim as a file
firelab fit --emulate-gpu AFTT --bookmarklet                    # or a javascript: bookmarklet
firelab fit --emulate-gpu AFTT --static                         # just print the profile
```

Load the file as the **first** `<script>` in your page, or install it as a
userscript (Tampermonkey / Violentmonkey; it has a `@run-at document-start`
header). A bookmarklet runs after the page's scripts, so it only catches WebGL
contexts created after the click (for example a game that starts its renderer
on a "Play" button). Failed calls show as `[firelab-gpu]` console warnings;
`window.__firelabGpu.report()` prints them as a table.

## What the shim changes

| WebGL call | Under the shim |
|---|---|
| `getContext('webgl2')` | `null` on GPUs without WebGL2 |
| `getParameter` | `MAX_TEXTURE_SIZE`, `MAX_CUBE_MAP_TEXTURE_SIZE`, `MAX_RENDERBUFFER_SIZE`, `MAX_VIEWPORT_DIMS`, texture units, `MAX_SAMPLES`, max anisotropy: the lower of the GPU's and your machine's. `UNMASKED_RENDERER_WEBGL` / `UNMASKED_VENDOR_WEBGL`: the stick's. `COMPRESSED_TEXTURE_FORMATS`: only formats the GPU decodes |
| `getSupportedExtensions` / `getExtension` | only the GPU's extensions; others return `null` (so the browser never enables them, and their enums fail as on the stick) |
| `texImage2D`, `texStorage2D`, `texImage3D`, `compressedTexImage2D` | over the size limit (per mip level): no texture, `getError()` = `INVALID_VALUE` |
| `compressedTexImage2D/3D`, `compressedTexSubImage2D` | a format family the GPU lacks: no texture, `INVALID_ENUM` |
| `renderbufferStorage(Multisample)` | over `MAX_RENDERBUFFER_SIZE`: `INVALID_VALUE`; more samples than `MAX_SAMPLES`: `INVALID_OPERATION` |
| `getShaderPrecisionFormat` | fragment `mediump` = FP16 (10-bit mantissa) on every Fire TV GPU but VideoCore IV; fragment `highp` = 0 on Mali Utgard |
| `compileShader` / `linkProgram` / `useProgram` | on Mali Utgard: a fragment shader with `highp` and no `GL_FRAGMENT_PRECISION_HIGH` guard, or a vertex shader with a sampler, fails to compile, the program fails to link, and using it is `INVALID_OPERATION` |
| `navigator.gpu` | `undefined` |

Every failure is counted once per kind, with how often it repeated:
`fail` when the call failed, `warn` for a capability check that came back empty
(`getExtension` returning `null`, reading `navigator.gpu`). Engines such as
three.js probe many extensions they can do without, so warnings are listed in
the notes, not as findings.

## Where the values come from

`firelab fit --emulate-gpu <model> --static` prints every value with its
source: `measured` (the model's device profile in `profiles/`), `spec` (the
model table or Amazon's specs) or `estimated`.

- **Renderer, WebGL2, max texture size, compressed formats, float color
  buffers, extension list**: from the model's device profile when it measured
  them (`firelab profile` records them), else from the GPU family in
  `src/fit/gpus.ts`.
- **Extension lists without a profile** are estimated: Chromium's set on that
  OpenGL ES version (see `src/fit/gpu-emulate.ts`), with vendor differences
  (no PVRTC on Mali, no `OES_texture_float_linear` on PowerVR Rogue, no
  instancing or 32-bit indices on OpenGL ES 2 GPUs).
- **Limits other than texture and renderbuffer size** (texture units, MSAA
  samples, anisotropy) are estimated per GPU class. Any limit FireLab has no
  value for is your machine's.
- **WebGL2 where it depends on the WebView's GPU blocklist** (PowerVR GX6250,
  Adreno 320): the worst case, no WebGL2.

Today only the Fire TV Stick (3rd gen) and Fire TV Stick 4K Plus have
profiles, and their extension lists aren't captured yet. Run `firelab profile`
on a real device and send the file to make a model's values measured.

| GPU class | Models (examples) | WebGL2 | Max texture | Compressed |
|---|---|---|---|---|
| PowerVR Rogue GE8300 / GE9215 (ES 3.2) | AFTSSS, AFTSS, AFTMM, AFTKA, AFTKM, AFTKRT, AFTMA08C15 | yes | 8192 | ETC1, ETC2, ASTC, PVRTC |
| Mali Bifrost / Valhall / Midgard (ES 3.2) | AFTR, AFTGAZL, Fire TV smart TVs | yes | 8192 | ETC1, ETC2, ASTC |
| PowerVR GX6250 (ES 3.1) | AFTS | worst case: no | 8192 | ETC1, ETC2, PVRTC |
| Adreno 320 (ES 3.0) | AFTB | worst case: no | 4096 | ETC1, ETC2 |
| Mali-450 / 470 (ES 2) | AFTT, AFTN, AFTA, HD Fire TVs | no | 4096 | ETC1 |
| VideoCore IV (ES 2) | AFTM | no | 2048 | ETC1 |

## What it can't do

- **Speed.** Nothing about frame time, fill rate, bandwidth or thermal
  throttling carries over.
- **Precision.** `mediump` is *reported* as FP16, but shaders still run at your
  GPU's precision, so FP16 banding and overflow don't show.
- **Extensions your browser lacks.** The shim can only hide; a stick extension
  your machine doesn't have (PVRTC on most desktops) returns `null`, and the
  run says so (`hostMissing`).
- **Driver bugs**, shader compiler quirks and the preprocessor: a shader that
  picks `highp` with `#ifdef GL_FRAGMENT_PRECISION_HIGH` takes the highp branch
  on your machine.
- **The Amazon WebView itself**: its Chromium version and its quirks (see
  `firelab fit` and the profiles).
