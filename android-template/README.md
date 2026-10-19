# FireLab WebView wrapper (android-template)

The Android app behind `firelab wrap`: one Activity with a full-screen
WebView that opens a URL. It is built with the plain Android SDK tools, with
no Gradle and no Android Studio project. The approach was proven in Sunset
Villa's `android/build.sh` on Fire TV Sticks.

```
AndroidManifest.xml                        {{package}}, {{versionCode}}, {{versionName}}, {{debuggable}} placeholders
src/dev/firelab/wrap/MainActivity.java     the app (Java 8 source, minSdk 22, no libraries)
```

`firelab wrap` fills in the rest:

```
res/values/strings.xml                     app_name
res/drawable-xhdpi/banner.png              320x180 TV launcher banner (generated from the name, or --banner)
res/drawable-xxxhdpi/icon.png              192x192 icon (generated, or --icon)
assets/firelab.json                        { url, name, scan, scanPath, debug, keepScreenOn, background, userAgent }
```

## Build pipeline (src/wrap/build.ts)

1. `aapt2 compile --dir res` → `aapt2 link -I android.jar --manifest … -A assets --custom-package dev.firelab.wrap`.
   The application id comes from the manifest; the Java code always lives in
   `dev.firelab.wrap`, so any package id works without code generation.
2. `javac -source 8 -target 8 -bootclasspath android.jar` → `d8 --release --min-api 22`.
3. `classes.dex` is added to the APK by FireLab's own zip writer, so no `zip`
   tool is needed.
4. `zipalign -p 4` → `apksigner sign` with `~/.android/debug.keystore`, or a
   generated `~/.firelab/debug.keystore`, or `--keystore` → `apksigner verify`.

It needs the build-tools (`aapt2`, `d8`, `zipalign`, `apksigner`), any
`platforms/android-N/android.jar`, and a JDK 11+ (17 recommended).
`firelab wrap --check` says what is missing and how to install it.

## What the app does

- **Remote → keyboard events.** D-pad → `ArrowUp/Down/Left/Right` (keyCode
  38/40/37/39), OK → `Enter` (13), ☰ → `ContextMenu` (93), ⏯ →
  `MediaPlayPause` (179), ⏪ → `MediaRewind` (227), ⏩ → `MediaFastForward`
  (228). Events go to `document.activeElement` with `key`, `code`, `keyCode`
  and `which` set, so both modern and legacy TV code work.
- **Back.** The page gets an `Escape` keydown. If it calls `preventDefault()`,
  it handled Back. Otherwise the WebView goes back in history, and at the
  first page the app exits. **Holding Back for 0.9 s always exits.**
- **The page can call** `window.FireLabTV.exit()` and
  `JSON.parse(FireLabTV.info())` (model, manufacturer, sdk, package,
  versionName).
- **Full screen and awake.** No title or system bars, `FLAG_KEEP_SCREEN_ON`,
  landscape, `<video>` full screen supported.
- **Media autoplay** (`setMediaPlaybackRequiresUserGesture(false)`), DOM
  storage, mixed content, cleartext HTTP (LAN dev servers).
- **DevTools.** `WebView.setWebContentsDebuggingEnabled(true)` in debug builds
  (the default), so `firelab` can read `window.firelab` and the console.
  `--release` turns this off.
- **Survives renderer crashes.** On low-memory sticks it rebuilds the WebView
  and shows a retry screen instead of crashing.
- **LAN fallback scan.** When the URL is a private address (10.x, 172.16–31.x,
  192.168.x) and it stops answering (DHCP moved your computer), the app probes
  the same port and path across its /24 subnet. It switches to the first
  server that answers and remembers it for that URL. `--no-scan` turns this
  off.
- **The user agent ends with `FireLab/1`**, so pages (and `@firelab/perf`) can
  tell they are wrapped.
- **Logs.** `adb logcat -s FireLab` shows page loads, errors and the page's
  `console.*` output.

Open another URL without rebuilding (handy for sweeps):

```sh
adb shell am start -n <package>/dev.firelab.wrap.MainActivity -e url "http://192.168.1.20:8080/?q=tv-hd"
adb shell am start -n <package>/dev.firelab.wrap.MainActivity -e url "<url>" --ez persist true   # make it the default
```

## Customising

Copy this folder, change the Java or manifest (keep the placeholders and
`dev.firelab.wrap.MainActivity`), and build with
`firelab wrap --template ./my-template …`.
