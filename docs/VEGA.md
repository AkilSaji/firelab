# Vega OS driver

> **Status: built, not yet tested on a real Vega device.** The driver
> (`src/vega`) follows Amazon's Vega SDK 0.24 documentation, and its tests run
> against a fake `vega` CLI. Nobody has run it on a Vega Fire TV or the Vega
> Virtual Device yet. Run [`scripts/vega-check.mjs`](../scripts/vega-check.mjs)
> on one and update the table below. Please send the results in a PR.

Vega OS runs on the Fire TV Stick 4K Select and newer models. It isn't Android:
there's no adb and no Android WebView, and apps are `.vpkg` packages built with
the Vega SDK, not APKs. FireLab reaches Vega devices through the SDK's own
tools:

- `vega exec vda` for the device: shell, pull, the device list
  ([VDA reference](https://developer.amazon.com/docs/vega/0.24/vda-tools.html));
- `vega exec inputd-cli` for the remote
  ([inputd-cli](https://developer.amazon.com/docs/vega/0.24/inputdcli.html));
- `vega device install-app` and `vega device launch-app` for apps
  ([Run your app](https://developer.amazon.com/docs/vega/0.22/run-apps)).

## Use it

```ts
import { createDriver } from 'firelab';

const tv = await createDriver({ kind: 'vda' });           // the only Vega device, or { serial: 'emulator-5554' }
await tv.launch({ package: 'com.example.game' });
await tv.press([{ key: 'down' }, { key: 'ok' }, { key: 'right', mode: 'hold', holdMs: 1200 }]);
const frame = await tv.screenshot({ format: 'jpeg', width: 960 });
const errors = await tv.logs({ app: { package: 'com.example.game' }, minLevel: 'error' });
await tv.close();
```

The game-testing engine and anything else written against the `DeviceDriver`
interface can use the same driver. From the command line:

```sh
firelab explore --driver vda --package com.example.game --minutes 20   # --apk takes a .vpkg here
firelab replay --driver vda <trace.json> --times 5
```

The MCP tool `explore_start` takes `driver: "vda"`. Without eval the engine
uses screen-only states and turns the focus oracle off. Because the foreground
app is only "the last app FireLab launched, while it runs", leaving the app
with Back or Home isn't seen; the report says so, marks dead ends as minor and
adds a caveat to dead ends and frozen pictures (they may be the launcher). An
app whose process ends is reported as unexpected-exit ("likely a crash").

## What works, and how sure we are

"Documented" means the command and its syntax are on Amazon's pages. "Assumed"
means FireLab guesses (a key name, an output format, a fallback) and the check
script will confirm or refute it.

| Feature | Command FireLab runs | Status |
|---|---|---|
| Find the device | `vega exec vda devices -l` | documented (adb-style output assumed) |
| Remote keys: up, down, left, right, OK, back, menu | `vega exec inputd-cli button_press KEY_UP` … `KEY_ENTER`, `KEY_BACK`, `KEY_MENU` | documented |
| Remote keys: home, play/pause, rewind, fast-forward, volume, mute, search, wake | `KEY_HOMEPAGE`, `KEY_PLAYPAUSE`, `KEY_REWIND`, `KEY_FASTFORWARD`, `KEY_VOLUMEUP`, `KEY_VOLUMEDOWN`, `KEY_MUTE`, `KEY_SEARCH`, `KEY_WAKEUP` | assumed (standard Linux names; override with `keyMap`) |
| Long press | `button_press <key> long` | documented |
| Hold for N ms | `button_press <key> --holdDuration <N>` | flag documented, unit (ms) assumed |
| Type text | `inputd-cli send_text <escaped text>` | documented |
| Screenshot | `vda shell gwsi-tool-screenshooter /tmp/firelab-shot.png`, then `vda pull` | documented |
| Device logs | `vda shell loggingctl log -o short-precise` | documented (journald-style line format assumed) |
| App memory | `vda shell ace_memusage` | tool documented, output format assumed (lenient parser) |
| Install | `vega device install-app --packagePath <file.vpkg>` | documented (0.22+); app id read from the output or the file name |
| Launch | `vega device launch-app --appName <id>`, else `vlcm launch-app pkg://<id>` | documented (vlcm form is older) |
| Stop | `vega device terminate-app --appName <id>`, else `vlcm terminate-app pkg://<id>` | assumed |
| Process id | `pidof <id>`, else `ps -A` | assumed |
| Foreground app | the last app FireLab launched, if it's still running | no Vega command known |
| Device selection | `vda -s <serial>` and `VEGA_SERIAL` for the rest | documented |

**Not available on Vega:** JavaScript eval, console streaming and raw CDP
(Vega apps don't run in an Android WebView), frame-rate measurement, recording
the physical remote, and clearing app data. The driver reports these as
`caps: false`, so the engine skips the oracles that need them. An in-app
bridge (`@firelab/perf` talking to FireLab over a WebSocket) could add eval,
console and fps later; see [ENGINE.md](ENGINE.md).

## Verify it

1. Install the Vega SDK
   ([guide](https://developer.amazon.com/docs/vega/0.24/install-vega-sdk.html))
   so that `vega --version` works.
2. Start the Vega Virtual Device, or connect a Vega Fire TV
   (`vega exec vda connect <ip>` after enabling developer mode).
3. Run:

   ```sh
   npm run vega:check                                           # read-only: info, screenshot, logs
   node scripts/vega-check.mjs --keys --app com.example.game    # also every key, launch, memory, stop
   ```

4. Look at `vega-check/screen.jpg` and `after-home.jpg`: a key can "succeed"
   and do nothing if its name is wrong. `vega-check/report.json` has every
   step.

If a step fails, the fix is usually a key name (`keyMap: { home: 'KEY_HOME' }`)
or a parser in `src/vega/parse.ts`. Save the raw command output as a test
fixture so the parser stays right.
