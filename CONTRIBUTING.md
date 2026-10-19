# Contributing to FireLab

Thanks for helping! FireLab is MIT licensed. Contributions are welcome under
the same license. Please follow the [code of conduct](CODE_OF_CONDUCT.md), and
report security problems privately ([SECURITY.md](SECURITY.md)).

**No time for code?** The most useful contributions need only a Fire TV:

- **Add your Fire TV's profile** (5 minutes): `firelab profile -d <tv-ip>`, then
  a pull request with `profiles/<MODEL>.json`. It makes `firelab fit`,
  `firelab lab` and `--emulate-gpu` exact for that model instead of estimated.
  See [profiles/README.md](profiles/README.md).
- **Add a "tested on" row**: `npm run device:check -- --device <ip>` prints one
  for the README table.
- **Report what FireLab found in your app**, or what it missed (a bug it should
  have caught), in an issue.

## Setup

```sh
git clone https://github.com/<owner>/firelab.git && cd firelab
npm install          # also links packages/perf and examples/* (npm workspaces)
npm run build        # TypeScript -> dist/
npm test             # Vitest for src/ (no device needed) + node:test for packages/perf
npm run test:all     # every workspace's tests
node dist/cli.js doctor
```

You need Node 22+ (Node 20 works except for the WebView tools) and Android
platform-tools (`adb`).

## Layout

| Path | What |
|---|---|
| `src/adb/` | adb client and parsers: devices, getprop, Fire TV models, discovery, reconnect, keys, virtual HID remote, screenshots, apps, APK reader, power, getevent, logcat |
| `src/cdp/` | Chrome DevTools over `adb forward`: sockets, CDP client, WebView sessions, fps probe |
| `src/driver/` | `DeviceDriver`: one interface for everything that drives a TV (`AdbDriver`, `FakeDriver` for tests) |
| `src/vega/` | the Vega OS driver over Amazon's `vega` CLI (not yet run on a real device) |
| `src/engine/` | the game-testing engine: explorer, oracles, minimiser, traces/replay, report ([docs/ENGINE.md](docs/ENGINE.md)) |
| `src/fit/`, `src/profile/` | `firelab fit` (per-model estimates), device profiles, `--emulate-gpu` |
| `src/lab/` | `firelab lab`: Fire-TV-shaped emulators and smoke checks ([docs/LAB.md](docs/LAB.md)) |
| `src/media/` | MP4 and media checks |
| `src/perf/` | native sampling (meminfo, /proc, SurfaceFlinger), measure, the sweep, watch sessions |
| `src/core/` | `FireLab`: the one object the MCP server, HTTP API and CLI all drive |
| `src/mcp/` | MCP tools and prompts, stdio + Streamable HTTP |
| `src/http/` | dashboard API + static server for `ui/` |
| `src/wrap/` + `android-template/` | `firelab wrap` (URL -> APK) and the wrapper app's Java source |
| `ui/` | the dashboard (plain JS, no build step) |
| `packages/perf/` | `@firelab/perf`, the browser library |
| `profiles/` | measured device profiles (community-contributed) |
| `examples/` | Firefly Lake (a web game with seeded bugs) and a native TV fixture app |
| `action/`, `.github/` | the GitHub Action and CI workflows |
| `test/` | Vitest tests for `src/`, with recorded device output in `test/fixtures/`; `test/engine/` runs the engine against a simulated game |
| `docs/` | getting started, prompts, engine design, contract between the parts, generated tool reference, lab, Vega, troubleshooting |

## Ground rules

- **Every device fact gets a fixture.** When you parse new device output,
  save a real sample in `test/fixtures/` and remove anything private first:
  serial numbers, MAC addresses, account names. Then write the test against
  that sample. Most of FireLab's bugs come from small differences between
  Fire OS versions, so add a fixture from your device when you fix one.
- **No device in unit tests.** Use `test/helpers/fake-adb.ts` (scripted adb
  answers) and `test/helpers/fake-devtools.ts` (a tiny DevTools WebSocket
  server).
- **Real-device checks** run with `npm run device:check -- --device <ip>`.
  The script is read-only by default; `--keys`, `--sweep` and `--stop` opt
  into actions. Paste its "tested on" row into the README when you test a
  new device.
- **Errors must say what to do.** Throw `FireLabError(code, message, { hint })`.
  The MCP tools, the HTTP API and the CLI show the hint to people and agents.
- **Agents read the tool descriptions.** If you change a tool in
  `src/mcp/server.ts`, run `npm run docs:tools` to regenerate `docs/TOOLS.md`.
- **Never surprise a user's TV.** Tools that change state say so in their
  description and annotations. `reset_app` needs `confirm: true`. Scans never
  connect by themselves.
- **No telemetry**, and keep runtime dependencies few: today they are the MCP
  SDK, zod and jpeg-js.
- **Stdout is sacred in `firelab mcp`.** Log with `src/lib/log.ts`, which
  writes to stderr.

## Adding a Fire TV model

Add the model to `FIRE_TV_MODELS` in `src/adb/models.ts`, using Amazon's
device specification pages as the source. If Amazon doesn't list it, mark it
`uncertain: true`. Tests check that model ids are unique and that every
Android-based entry maps to a tier.

## Commit style

Use small commits with messages in the imperative ("Add SurfaceFlinger fps
for native apps"). Run `npm test` and `npm run build` before you push.
