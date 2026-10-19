# The lab: Fire TV testing without a Fire TV

`firelab lab` creates Android emulators shaped like real Fire TV models, and
the [FireLab lab action](../action/action.yml) runs them in GitHub Actions so
every push of a Fire TV app gets installed, launched, checked and played.

- [What the lab matches, and what it doesn't](#what-the-lab-matches-and-what-it-doesnt)
- [Set up](#set-up)
- [Commands](#commands)
- [How a model becomes an emulator](#how-a-model-becomes-an-emulator)
- [Smoke checks](#smoke-checks)
- [GitHub Actions](#github-actions)
- [ARM apps on emulators](#arm-apps-on-emulators)
- [Troubleshooting](#troubleshooting)

## What the lab matches, and what it doesn't

| | Lab emulator | Real Fire TV |
|---|---|---|
| Android API level | ✅ same as the model's Fire OS (Fire OS 7 = API 28, Fire OS 8 = API 30) | |
| RAM, Dalvik heap | ✅ from the profile (AFTSSS: 1 GB) — see [RAM minimums](#the-emulator-raised-ram) | |
| Screen, density | ✅ 1920x1080 @ 320 dpi (from the profile) | |
| Input | ✅ D-pad + keyboard, no touch screen | |
| Memory budget | ✅ `lab smoke` checks the app against the **real** model's budget and hard limit | |
| GPU | ❌ host GPU or SwiftShader | Mali / PowerVR (GE8300, GE9215, ...) |
| CPU | ❌ the host's cores | 4 ARM cores at 1.5-2 GHz |
| WebView | ❌ Google's Android System WebView | Amazon WebView (Chromium 138 on AFTSSS) |
| System | ❌ Android TV or plain Android | Fire OS launcher, Amazon services, Fire TV settings |
| Codecs | ❌ software decoders | hardware decoders with per-model limits |

So the lab answers "does it install, launch, stay up, draw something, avoid
crashes/ANRs, fit in memory, and survive being played with a remote?". It
does **not** answer "how fast is it on a stick?". For that, use
[`firelab fit`](../src/fit) with the measured profiles in [profiles/](../profiles)
(or a real device with `firelab measure` / `firelab sweep`).

## Set up

You need the Android SDK command-line tools, the emulator, platform-tools and
hardware acceleration. `firelab lab doctor` checks all of it and prints the
exact commands for what's missing:

```sh
firelab lab doctor
firelab lab doctor --profile AFTMA08C15   # also checks that model's system image
```

| Computer | Acceleration | Images used |
|---|---|---|
| Linux x86_64 | KVM (`/dev/kvm`) | Android TV x86 images at the exact API level |
| macOS on Apple Silicon | Hypervisor.framework (built in) | Google APIs arm64 images at the exact API level (there is no arm64 Android TV image below API 31) |
| macOS on Intel, Windows | HVF / WHPX | as Linux |

System images are about 1 GB. The lab never downloads anything unless you
ask: add `--install` to `lab create`, and sdkmanager shows Google's Android
SDK licence for you to accept.

## Commands

```sh
firelab lab create --profile AFTSSS [--install] [--name n] [--image pkg] [--prefer-tv] [--headless] [--force] [--dry-run]
firelab lab create --list-models          # every model and the image it would use
firelab lab start [name] [--headless] [--cold] [--wipe] [--timeout 600] [--port 5554] [--gpu mode]
firelab lab list
firelab lab stop [name|serial|--all]
firelab lab delete <name> --yes
firelab lab smoke --apk app.apk [-d emulator-5554] [--out dir] [--settle 10] [--max-launch-ms 5000] [--summary file.md]
```

- `create` writes the AVD itself (`~/.android/avd/firelab-<MODEL>.avd`, or
  `$ANDROID_AVD_HOME`) with a `firelab.json` that remembers the model and its
  memory budget. It needs no Java unless it has to install an image.
- `start` boots the emulator in the background (log in
  `~/.firelab/lab/<name>.log`), waits for Android to finish booting, turns off
  animations, the screensaver and sleep, and then reads the device back
  through FireLab's normal device layer. Then `firelab info`, `screenshot`,
  `keys`, `install`, `launch`, `ui`, `explore` and the MCP tools all work on
  it with `-d emulator-5554`.
- `--prefer-tv` takes the nearest Android TV image (API 31 on Apple Silicon)
  instead of the exact-API phone image: you get the Leanback launcher but a
  newer Android than the stick runs.
- Vega OS models (Fire TV Stick 4K Select and newer) don't run Android; use
  Amazon's Vega Virtual Device for them.

## How a model becomes an emulator

`firelab lab create --profile AFTSSS --dry-run` shows the decisions and where
each number came from:

```
Lab firelab-AFTSSS: shaped like the AFTSSS (Fire TV Stick (3rd gen))
  image    system-images;android-28;google_apis;arm64-v8a  (no arm64-v8a Android TV image exists at API 28 ...)
  API      28 = Fire OS 7.7.1.7  [measured: getprop]
  RAM      1024 MB  [spec: 1024 MB marketed RAM (MemTotal on the device: 900.7 MB)]
  heap     192 MB  [estimated: usual Android TV dalvik.vm.heapsize for 1024 MB]
  screen   1920x1080 @ 320 dpi  [estimated: usual density for that resolution]
  CPU      4 cores  [spec: quad-core]
  budget   app memory 415 MB comfortable, 458 MB hard limit (checked by `lab smoke`)
```

| Setting | From |
|---|---|
| API level | the profile's `os.sdk`, else the Fire OS version in the model table |
| System image | Android TV at that API for the host's CPU, else Google APIs (updatable WebView), else the default image |
| `hw.ramSize` | the model's marketed RAM (MemTotal rounded up when only that is known) |
| `vm.heapSize` | 192 MB for 1 GB, 256 MB for 2 GB, 384 MB above (estimated; `--heap` overrides) |
| `hw.lcd.*` | the profile's display, else 1920x1080; density from the profile, else 320 for 1080p |
| Hardware | D-pad and keyboard, no touch screen, no camera/GPS/sensors/battery, landscape, 4 GB data |
| `hw.gpu.mode` | `auto`, or `swiftshader_indirect` with `--headless` |

Overrides: `--api`, `--ram`, `--heap`, `--density`, `--image`.

## Smoke checks

`firelab lab smoke --apk app.apk` (or `--package id` for an installed app)
runs, on the lab emulator or any adb device:

| Check | Fails when |
|---|---|
| Installs | `adb install` fails (wrong ABI, bad signature, ...) |
| Launches | there's no launcher activity or `am start` fails |
| Launch time | over `--max-launch-ms` (without it, only a warning above 5 s: emulator times aren't the stick's) |
| Still running after `--settle` s | the process is gone |
| Screen shows something | warns on a black or flat screenshot |
| Memory vs the model's budget | PSS (app + WebView renderer) over the real model's hard limit; warns over the comfortable budget |
| No crash or ANR in logcat | `FATAL EXCEPTION` or `ANR in` for the app, a native tombstone, the process dying, or a WebView renderer crash |

It writes `report.html` (with the screenshot), `summary.md`, `smoke.json`,
`screenshot.jpg` and `logcat.txt` to `--out` (default `./firelab-lab`), and
appends the summary to `--summary` (the action passes `$GITHUB_STEP_SUMMARY`).
Exit code: 0 pass, 2 a check failed, 1 it couldn't run.

For deeper testing, `firelab explore --apk app.apk -d emulator-5554` plays the
app with the remote and reports crashes, black or frozen screens and focus
traps (see [ENGINE.md](ENGINE.md)). On the wrapped web apps, a known race in the
wrapper's Back handling can make Back exit the app even when the page
handled it; explore reports that as minor `unexpected-exit` findings, which
don't fail the default `--fail-on`.

## GitHub Actions

```yaml
jobs:
  firetv:
    runs-on: ubuntu-latest          # has KVM; the action enables it
    steps:
      - uses: actions/checkout@v4
      - run: ./gradlew assembleDebug
      - uses: AkilSaji/firelab/action@v0
        with:
          apk: app/build/outputs/apk/debug/app-debug.apk
          profile: AFTSSS           # or AFTMA08C15, AFTKM, ...
```

For a web app, give `url:` instead of `apk:`; the action wraps it with
`firelab wrap`. `localhost` URLs are rewritten to `10.0.2.2`, the runner as
the emulator sees it, so a server started in an earlier step works.

| Input | Default | |
|---|---|---|
| `apk` / `url` | | what to test (one of them) |
| `name`, `package` | | app name for `url`; package id (default: from the APK) |
| `profile` | `AFTSSS` | Fire TV model to imitate |
| `image` | | system image override |
| `settle`, `max-launch-ms` | `10`, | smoke-check timing |
| `explore` | `auto` | `auto`: run `firelab explore` if this FireLab has it; `true`: required (the job fails with a clear message if it's missing); `false`: skip |
| `explore-minutes`, `explore-fail-on` | `3`, `crash,black,frozen,focus-trap` | passed to `firelab explore` |
| `explore-minimize-minutes` | `2` | time limit for shrinking each finding (it runs after `explore-minutes`); `0` = `--no-minimize` |
| `boot-timeout` | `600` | seconds |
| `out`, `artifact-name` | `firelab-lab`, `firelab-lab-report` | report folder and artifact |
| `accept-android-licenses` | `true` | runs `sdkmanager --licenses` non-interactively so the image can download |
| `firelab-version`, `command` | `latest`, | which FireLab to run |

Outputs: `verdict` (`pass`/`fail`), `serial`, `report`. The job summary shows
the checks table and the explore result; the artifact has the HTML report,
screenshot, logcat and the explore run.

This repository runs the action on itself in
[.github/workflows/lab-self-test.yml](../.github/workflows/lab-self-test.yml)
(the Firefly Lake demo on AFTSSS and AFTMA08C15), and
[.github/workflows/example.yml](../.github/workflows/example.yml) is a
template to copy.

## ARM apps on emulators

Fire TVs run a 32-bit ARM userspace (`armeabi-v7a`). Apps written in
Java/Kotlin, React Native's JS, or web apps in a WebView run anywhere. Apps
with native libraries are harder:

- **Apple Silicon** runs arm64 images, and its CPUs can't execute 32-bit ARM
  code, so apps with only `armeabi-v7a` libraries fail
  (`INSTALL_FAILED_NO_MATCHING_ABIS` or a crash on load). Ship an
  `arm64-v8a` build too, or test that part on a device.
- **Linux x86** Android TV images have no ARM translation. Use
  `--image "system-images;android-30;google_apis;x86_64"` (Android 11 images
  translate ARM code), at the cost of the phone system image.

## Troubleshooting

#### The emulator raised RAM

Newer system images have a minimum RAM, and the emulator raises
`hw.ramSize` to it (it logs "Increasing RAM size to 2560MB"). `lab start`
warns when that happens. App memory is still judged against the real
model's budget by `lab smoke`, but the system won't kill apps the way a 1 GB
stick does. Use an image at the model's own API level (the default) for the
closest match.

#### It boots slowly or not at all

Run `firelab lab doctor`: no KVM/HVF means software emulation, which is too
slow. The lab doesn't save quick-boot snapshots, so every start is a full
boot (about 45 s on an Apple Silicon Mac, 1-3 minutes on a CI runner); apps
you installed stay installed until `--wipe`. The emulator's own log is
`~/.firelab/lab/<name>.log`.

#### "Viewing full screen" or other dialogs over the app

`lab start` turns off the immersive-mode hint, animations, the screensaver
and sleep. Phone images have no Leanback launcher, so start apps with
`firelab launch` (FireLab finds the TV or phone launcher activity).

#### The WebView is old

Images ship the WebView they were built with. Google APIs images let you
install a newer "Android System WebView" APK with `adb install`; that is
why the lab prefers them to the default images. It still isn't Amazon's
WebView.
