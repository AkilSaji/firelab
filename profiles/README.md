# Device profiles: add your Fire TV

A profile is what one Fire TV model really has, measured on the device: Fire OS
and API level, CPU ABIs and speed, memory and the per-app heap, the GPU and its
WebGL limits and extensions, the WebView version, video decoders and the screen.
`firelab fit`, `firelab lab` and `--emulate-gpu` read these files. A model with
a profile gets **measured** facts; every other model falls back to spec sheets
and estimates, and the reports say so.

FireLab knows 66 Fire TV models (`firelab lab create --list-models`). Only these
have a measured profile so far:

| Model | Device | Profile |
|---|---|---|
| AFTSSS | Fire TV Stick (3rd gen), 1 GB | [AFTSSS.json](AFTSSS.json) |
| AFTMA08C15 | Fire TV Stick 4K Plus, 2 GB | [AFTMA08C15.json](AFTMA08C15.json) |

**If you have any other Fire TV, a profile from it is one of the most useful
things you can contribute.** It takes about five minutes.

## Record a profile

You need FireLab from this repository (see the README) and adb debugging on the TV.

```sh
firelab devices --scan --connect                 # find and connect the TV
firelab profile -d <tv-ip>                       # writes profiles/<MODEL>.json
```

For the GPU, WebGL, WebView and media facts, give it a debuggable WebView app,
for example the demo game wrapped with `firelab wrap`:

```sh
node examples/web-game/serve.mjs                 # prints the address the TV can open
firelab wrap --url http://<your-computer-ip>:8080/examples/web-game/ --name "Firefly Lake" --install <tv-ip>
firelab profile -d <tv-ip> -p dev.firelab.fireflylake
```

`firelab profile` is read-only on the TV: it reads getprop, `/proc/meminfo`,
`wm size`, cpufreq, `dumpsys webviewupdate`, and WebGL/MediaCapabilities inside
the page. Start it on the Home screen.

Running it again merges new facts into the existing file (`--no-merge` replaces it).

## Check it and send it

```sh
npm test -- profile                              # validates every file in profiles/
```

Then open a pull request with just `profiles/<MODEL>.json`. Use the
**Device profile** pull request checklist; it asks for the Fire OS version and
which FireLab version recorded it.

What reviewers look for:

- the file name is the model code (`AFTKA.json`), and `model` inside matches;
- facts the tool couldn't measure stay `"source": "unknown"` with a `null` value;
  don't type in values from memory (put spec-sheet values in `notes` instead);
- nothing personal (below).

## Privacy

Profiles describe the **model**, never your device or home. `firelab profile`
doesn't record serial numbers, MAC or IP addresses, account names, Wi-Fi names
or installed apps, and a test (`test/profiles-privacy.test.ts`) rejects files
that contain any of them. Check `references` and `notes` before you send: they
are free text.

## Changing the schema

`schema.json` is generated from `src/profile/schema.ts`. After changing the
schema, run:

```sh
npm run build && node scripts/fit/gen-profile-schema.mjs
```

`test/profile-schema.test.ts` fails when the two drift apart.
