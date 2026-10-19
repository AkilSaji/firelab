# Troubleshooting

Start with `firelab doctor`. It checks Node, adb, your network and every
device, and prints the fix for each problem it finds.

## Turning on ADB debugging on a Fire TV

1. **Settings > My Fire TV > About**, then select the device name (for example
   "Fire TV Stick 4K") **7 times**, until the TV says you are a developer.
   On older Fire OS versions you can skip this step: Developer options are
   already there.
2. Go back to **My Fire TV > Developer options** and turn **ADB debugging**
   on. Fire OS 7 and later only offer **Apps from Unknown Sources** per app,
   and you don't need it for testing over adb.
3. Find the TV's IP address under **Settings > My Fire TV > About > Network**.
4. Run `firelab connect 192.168.1.50`, using your TV's address. You can also
   run `firelab devices --scan --connect`, which finds Fire TVs on the Wi-Fi
   for you.
5. The TV shows **"Allow USB debugging?"**. Tick **Always allow from this
   computer** and select **OK**.

Android TV and Google TV work the same way. There the setting is
**Settings > System > About > Android TV OS build** (select it 7 times), then
**Developer options > USB debugging** (or **Network debugging**). For adb over
Wi-Fi, run `adb tcpip 5555` once over USB, or use **Wireless debugging** on
Android 11 and later.

## "unauthorized"

The TV hasn't accepted this computer's adb key yet.

- Look at the TV. The **Allow USB debugging?** dialog may be hidden behind a
  video or a screensaver, so wake the TV and press Home. Select **OK** with
  **Always allow** ticked.
- If no dialog shows, run `adb kill-server` and then `firelab connect <ip>`
  again. The dialog only appears when a host offers a key the TV hasn't seen.
- If you have two copies of adb (for example Android Studio's and
  Homebrew's), each may have a different key and they keep restarting each
  other's server. Pick one copy, either with the `ADB` environment variable
  or by putting it first on `PATH`. `firelab doctor` shows which adb FireLab
  uses.
- To start over, go to Developer options > **Revoke USB debugging
  authorizations** on the TV, then connect again.

## The device keeps dropping off Wi-Fi ("offline", or missing)

Fire TVs leave adb when they sleep, when Wi-Fi blips, and after DHCP gives
them a new address. FireLab watches every Wi-Fi device you have connected:

- If the device goes **offline**, FireLab drops the stale entry and
  reconnects, retrying every 2 s and backing off to every 30 s. The dashboard
  shows `connecting` while this happens, and tools work again by themselves
  once the device is back.
- If the TV got a **new IP**, run `firelab devices --scan` to find it again.
  To stop that from happening, give the TV a fixed address (a DHCP
  reservation) in your router.
- Some routers put clients in **AP / client isolation** (common on guest
  networks), which blocks the Mac from reaching the TV. Use the main network.
- Prefer 5 GHz Wi-Fi or Ethernet (Fire TV Cube, or a USB Ethernet adapter):
  screenshots and the screen mirror move about 1–2 MB per frame.

## Black screenshots / the screensaver

- If the screen is **asleep or showing the screensaver**, run `firelab wake`
  or the `wake_device` tool. It sends `KEYCODE_WAKEUP`, which unlike a D-pad
  key does nothing in the foreground app, and checks `dumpsys power` until
  the device says `Awake`. `launch_app` wakes the device first.
- **DRM video** (Prime Video, Netflix and other protected streams) shows
  black in every screen capture. That is Android, not FireLab.
- To keep the TV awake during long sessions, set **Settings > Display &
  Sounds > Screensaver > Start time** to Never, or keep pressing keys.
- If a screenshot fails with **"screencap returned no PNG"**, the error
  includes whatever the device printed instead. FireLab already strips the
  warning text that some Fire OS builds print before the image, and undoes
  CRLF mangling from old shells.

## WebView tools say "no debuggable WebView"

`webview_eval`, `webview_console`, fps measurement and the sweep talk to the
page through Chrome DevTools. Android only exposes a WebView's DevTools
socket when the app allows it:

```java
// in your Activity or Application, for debug builds
if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
```

```kotlin
WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
```

Then restart the app. Things to know:

- Apps made with `firelab wrap` enable this unless you pass `--release`.
- Chrome-based browsers expose `chrome_devtools_remote` without any change.
- With Capacitor or Cordova, debug builds enable it already.
- Store builds normally ship with debugging off. Test a debug build, or put
  the call behind a hidden developer setting.
- **"is not running"** means the app's process isn't up. Use `launch_app`
  first.
- FireLab reaches the page with `adb forward` to the app's DevTools socket.
  You don't need Chrome or `chrome://inspect` on the computer.

## Frame rate looks wrong

- With **`window.firelab`** (the [@firelab/perf](../packages/perf) hook)
  FireLab reads the page's own numbers, which is the most accurate source.
- Without it, FireLab injects a probe. For WebGL apps the probe counts
  **frames that issued draw calls**: a game capped at 30 fps still gets 60
  rAF callbacks a second, and the probe reports 30, not 60. Seconds where the
  page drew nothing while rAF ran freely (a menu or a video) are skipped,
  because they say nothing about rendering speed. On Sunset Villa (three.js)
  the probe agreed with the game's own frame counter to within about
  1 fps per second (24.6 vs 24.2 median fps over 12 s on a Fire TV Stick 4K
  Plus).
- If your app has its own meter, pass `fpsExpr` (for example
  `"window.game.stats.fps"`) to `measure_performance` or `performance_sweep`.
- For **native and Unity apps** (no WebView), FireLab reads frame
  presentation times from SurfaceFlinger (`dumpsys SurfaceFlinger
  --latency`) for the app's layer.
- **Memory** is the app's PSS plus its WebView renderer's (WebView runs the
  page in a separate sandboxed process). GPU memory shows up as "Graphics" in
  the app's numbers.

## Sweep problems

- **Every tier shows "no frames measured"**: the page isn't rendering.
  Maybe it's on a menu, or it paused itself. Pass `actionKeys` (for example
  `["ok"]`) or `actionEval` to get into gameplay after each load, and a
  longer `warmupS` if loading takes a while.
- **A tier "crashed"**: the WebView renderer ran out of memory (common with
  rich tiers on 1 GB Sticks). The sweep carries on with the next tier;
  `logcat` with level `error` shows the details.
- **The URL didn't change the quality**: the app has to read the tier
  parameter (default `q`; change it with `param`). @firelab/perf reads `?q=`
  out of the box.
- The sweep reloads the page several times and then restores the URL it
  started on. Unsaved in-page state is lost, so don't run it during
  someone's play session.

## Keys don't do anything

- Run `firelab info` to check that the right app is in the foreground and
  the screen is awake.
- Plain presses use `input keyevent`. Each call starts a JVM on the device
  (about 1 s on a Fire TV Stick), so FireLab batches presses into one call.
  Use `gapMs` when an app needs time between presses (animations, focus
  moves).
- Holds and long presses use a **virtual HID remote** made with Android's
  built-in `hid` command. Android sees real key-down and key-up events with
  the hold time you asked for. If the device doesn't allow it, FireLab falls
  back to `input keyevent --longpress` and logs a warning. Set
  `FIRELAB_REMOTE=input` to never use HID, or `FIRELAB_REMOTE=hid` to send
  everything through it (much faster for long key sequences).
- `type_text` can only type ASCII, because `input text` can't do more. For
  other characters, set the field's value with `webview_eval`.

## Recording a play session records no keys

`watch_start` records the **physical remote** through `getevent`. Keys that
FireLab itself sends with `input keyevent` never pass through a kernel input
device, so they don't show up. That is deliberate: the recording shows what
the person did. Fire TV remotes connect over Bluetooth and appear as an input
device only while they're awake, and FireLab handles devices that appear in
the middle of a session.

## adb not found

Install Android platform-tools:

- macOS: `brew install --cask android-platform-tools`
- Debian/Ubuntu: `sudo apt install adb`
- Windows: `winget install Google.PlatformTools`
- Or download it from
  <https://developer.android.com/tools/releases/platform-tools>

FireLab looks for adb in these places, in order:

1. `$ADB`
2. `PATH`
3. `$ANDROID_HOME/platform-tools` and `$ANDROID_SDK_ROOT/platform-tools`
4. Android Studio's default SDK folder

To point MCP clients at a specific adb, set `"env": { "ADB": "/path/to/adb" }`
in their config.

## MCP client can't start FireLab

- In stdio mode, stdout belongs to the protocol, so FireLab logs to
  **stderr**. Run `npx firelab mcp` in a terminal: it should wait silently
  for input. Any error it prints there is the problem.
- **Node 20** works for everything except the WebView tools, which need
  Node's built-in WebSocket from **Node 22**. `firelab doctor` warns about
  this.
- If your client can't spawn processes, use `firelab mcp --http 7301` and
  connect to `http://127.0.0.1:7301/mcp` (Streamable HTTP).
