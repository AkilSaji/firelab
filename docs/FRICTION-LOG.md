# Friction log: building and testing Fire TV apps

What got in our way while building FireLab and testing games on real Fire TVs
during the Build, Ship, Shape hackathon (October 2026). Every entry is
something we hit ourselves, on the device named, with the numbers we measured.
Each says what we did about it in FireLab and what would help from Amazon.

**Devices:** Fire TV Stick 4K Plus (AFTMA08C15, Fire OS 8.1.8.2 / Android 11),
Fire TV Stick 3rd gen (AFTSSS, Fire OS 7.7.1.7 / Android 9), and an Android
emulator shaped like the AFTSSS (`firelab lab`). Computer: macOS on Apple
silicon, adb 1.0.41 (platform-tools 37.0.1).

**Severity:** High = blocked a test or made results wrong; Medium = cost real
time or needed a workaround; Low = papercut.

| # | Area | Friction | Severity |
|---|---|---|---|
| 1 | Input | Each `adb shell input keyevent` takes about 1.2 s | High |
| 2 | Input | No reliable way to hold a remote key over adb on Fire OS 8 | Medium |
| 3 | WebView apps | No documented way for a WebView TV app to say "I handled Back"; the obvious approach races | High |
| 4 | Screen capture | Screenshots take 1.1–2.5 s at 1080p, sometimes much more | Medium |
| 5 | WebView apps | Release builds can't be inspected, so most installed games can't be tested deeply | Medium |
| 6 | Emulator | No Fire OS emulator; Android images don't match Fire TV memory or API on Apple silicon | High |
| 7 | Emulator | No published host requirements for running a Fire TV / Vega emulator | Medium |
| 8 | Device | Fire TVs drop off adb over Wi-Fi during long test runs | Medium |
| 9 | Device data | Per-model memory budgets aren't published; apps see 901 MB on a "1 GB" stick | Medium |
| 10 | Vega | App lifecycle (`vlcm`) query and launch syntax isn't on the VDA tools page | Medium |
| 11 | Emulator | Real remote presses can't be simulated on the emulator without root | Low |
| 12 | Companion apps | No platform guidance for "play on your phone" servers; party games collide on the same port and crash | High |
| 13 | Accessibility | Games that draw their own highlight are invisible to the accessibility tree (VoiceView, test tools) | Medium |
| 14 | Emulator | The emulator renders with a software GPU: WebGL features, limits and speed differ from every Fire TV | High |
| 15 | Device data | No published per-model GPU/WebGL capability table (WebGL2, max texture size, ASTC/ETC, extensions) | High |
| 16 | WebView apps | Which web features each Fire OS WebView has (WebGPU, WebGL2, WASM SIMD) isn't documented per model | Medium |
| 17 | Testing docs | No guidance for automated D-pad testing; the obvious Monkey setting never presses OK | Medium |
| 18 | Testing | No reference TV apps or benchmark for testing tools: a claim like "finds more bugs" can't be checked | Medium |

See also [FRICTION-LOG-FIRELAB.md](FRICTION-LOG-FIRELAB.md): the friction of using FireLab itself, found by dogfooding it, with what we fixed.

---

## 1. Each `input keyevent` takes about 1.2 s

- **Where:** Fire TV Stick 4K Plus (Fire OS 8.1.8.2), adb over Wi-Fi.
- **What we did:** sent one D-pad key per `adb shell input keyevent` call, as most Android test tools do.
- **What happened:** we measured 1.10–1.36 s per key (three runs: 1305, 1358, 1104 ms). Three keys sent as separate calls with a 120 ms gap took 4.0 s, so a "fast double press" (the way players trigger start/resume races) arrived about a second apart and never reproduced the bug.
- **Expected:** key injection in tens of milliseconds, close to a real remote.
- **Also measured:** Fire TV Stick 3rd gen (Fire OS 7.7.1.7), 2026-10-19: 1.03–1.86 s per key (five calls, median 1.17 s); three separate calls with 120 ms gaps 3.5 s; the same three keys in one batched call 1.29 s.
- **Impact:** an automated test step took 3.4–3.6 s on the 4K Plus (166–178 steps per 10 minutes). Timing bugs that need fast presses are invisible to tools that send keys one call at a time.
- **Workaround in FireLab:** repeated keys go out as one batched `input keyevent A B C` call, which lands them milliseconds apart (`src/engine/session.ts`). That made the seeded double-OK black-screen bug reproducible.
- **Would help:** a documented low-latency input path for development devices (for example a debug-only input service or a faster `input` on Fire OS), or guidance on the recommended way to drive the remote from a test harness.

## 2. No reliable key holds over adb on Fire OS 8

- **Where:** Fire TV Stick 4K Plus (Fire OS 8.1.8.2).
- **What we did:** tried real key-down/key-up holds (hold right to steer, hold OK) through a virtual HID remote built with Android's `hid` command.
- **What happened:** FireLab's capability probe reports holds as unavailable on this device (`holds: false`), so holds fall back to `input keyevent --longpress` or repeated key-downs. On the Fire TV Stick 3rd gen (Fire OS 7) real holds work (measured 2026-10-19: `right:800` sent as a held key).
- **Impact:** "hold to run" or "hold to charge" game mechanics can't be tested with exact hold times.
- **Would help:** a supported way to inject key-down/key-up pairs with a duration on developer-mode devices.

## 3. Handling Back in a WebView TV app races

- **Where:** a wrapped WebView app (FireLab's `firelab wrap` template, the common "WebView in an Activity" pattern) on the Fire TV Stick 4K Plus, the Fire TV Stick 3rd gen and the emulator.
- **What we did:** forwarded Back to the page as an Escape key event, and only closed the app if the page didn't call `preventDefault()`. The page's answer came back through an `evaluateJavascript` callback.
- **What happened:** when the page was busy (a 3D scene rebuilding), the key-up check ran before the callback, and Back quit the app even though the game had handled it. FireLab's engine found it and shrank a 37-key path to 8 keys (`menu ▲ ▲ ▲ ◀ ▶ ▲ Back`). Measured with FireLab's replays from a fresh launch:

  | Device | Old wrapper | Fixed wrapper |
  |---|---|---|
  | Fire TV Stick 4K Plus, seeded bugs on | 5/5 | not re-run (TV offline) |
  | Fire TV Stick 4K Plus, seeded bugs off | 2/3 | not re-run (TV offline) |
  | Fire TV Stick 3rd gen, seeded bugs on | 2/5 | **0/5** |
  | Fire TV Stick 3rd gen, seeded bugs off | 2/3 | **0/5** |
  | AFTSSS-shaped emulator, seeded bugs on | 4/5 | **0/5** |

- **Expected:** a documented pattern for WebView-based Fire TV apps to consume Back, since many TV games are web apps in a WebView.
- **Fix in FireLab:** the key-down script itself records whether the page used Back, so the check is ordered (`android-template/src/dev/firelab/wrap/MainActivity.java`).
- **Would help:** an official Fire TV sample or docs section for Back handling in WebView apps (and in web apps opened in Silk), including the case where the page is busy.

## 4. Screenshots are slow

- **Where:** Fire TV Stick 4K Plus.
- **What happened:** a raw framebuffer capture took 1.6–2.1 s per frame; a 480 px JPEG through `screencap` took 1.5–2.1 s, with one outlier at 7.9 s. A full PNG takes about 2.5 s. On the Fire TV Stick 3rd gen (2026-10-19): full PNG 2.1–2.3 s, raw framebuffer 0.8–1.0 s, FireLab's compressed path 1.2–1.4 s. Some Android builds can print warning text before the PNG bytes, which breaks naive PNG parsing.
- **Impact:** checking for black or frozen screens costs more device time than the key press itself.
- **Workaround in FireLab:** raw framebuffer through the device's gzip, cut down to a 64 px frame on the computer; the warning text is stripped; the frame grab runs in parallel with the other per-step adb calls.
- **Would help:** a faster capture path for developer-mode devices (or a documented low-resolution capture), and `screencap` that never mixes text into image output.

## 5. Release builds can't be inspected

- **Where:** Fire TV Stick 3rd gen with 14 games installed.
- **What happened:** only 5 of the 14 were debuggable. Of those 5, three still had WebView inspection switched off (`setWebContentsDebuggingEnabled` isn't on by default even in debug builds) and one loaded its game from `http://localhost/`, a developer setup that doesn't exist on another device. For the other 9 the WebView can't be inspected over Chrome DevTools: no JS errors, no frame counter, no focus information. FireLab falls back to crash/ANR, black/frozen screen and "key quit the app" checks.
- **Would help:** on devices in developer mode, allow WebView inspection of sideloaded apps (with a visible indicator), or document the recommended "test build" setup for Appstore submissions.

## 6. No Fire OS emulator; Android images don't match

- **Where:** macOS on Apple silicon, Android Emulator.
- **What we did:** built emulators shaped like real Fire TV models (`firelab lab`): same API level, RAM and screen as the model.
- **What happened:** there is no arm64 Android TV system image below API 31, so a Fire OS 7 (API 28) stick can only be matched with a phone image (Google APIs, API 28) set up like a TV; in this session the installed Google APIs API 36 image was used. The emulator also raised the RAM we asked for (1024 MB) to 2473 MB, so low-memory behaviour of 1 GB sticks can't be reproduced. GPU, WebView version and Fire OS services differ too.
- **Impact:** developers without hardware can't trust performance or memory results, and can't test on the most common low-end stick.
- **Would help:** official Fire OS virtual device images (at least Fire OS 7 and 8, arm64 and x86_64), or published per-model emulator profiles.

## 7. No published host requirements for emulators

- **Where:** hackathon Discord, October 2026.
- **What happened:** on 2026-10-16 in #amazon-developer-general-chat, a participant asked how much RAM they need to run the emulator; an Amazon evangelist answered that they "don't publish official stats but the recommendation I received was 8gb RAM", and that there's no way to know beforehand whether it will run.
- **Would help:** published host requirements for the Vega Virtual Device and any Fire OS emulator, and a published per-model capability table (CPU, GPU, RAM available to apps, WebView version, codecs).

## 8. Fire TVs drop off adb over Wi-Fi

- **Where:** Fire TV Stick 4K Plus, during a long test session (2026-10-16).
- **What happened:** the TV stopped answering mid-replay ("Host is down") and didn't come back for the rest of that session. Separately, the Fire TV Stick 3rd gen's IP changed between sessions (DHCP), five times during the hackathon.
- **Impact:** unattended test runs stop half-way.
- **Workaround in FireLab:** automatic reconnect, and `firelab devices --scan` to find the TV again.
- **Would help:** a developer-option "keep Wi-Fi and adb awake while debugging" setting, and a stable device name (mDNS) for adb over Wi-Fi.

## 9. Memory budgets aren't published per model

- **Where:** Fire TV Stick 3rd gen.
- **What happened:** the "1 GB" stick reports 901 MB of RAM; the per-app heap limit and how much a WebView game can use before low-memory kills isn't documented per model.
- **Impact:** developers find the limit by crashing on the device.
- **Workaround in FireLab:** `firelab profile` records what a device reports; `firelab fit` estimates budgets and labels them as estimates.
- **Would help:** a per-model table of memory available to apps and the recommended budget for games.

## 10. Vega app lifecycle syntax isn't documented with the VDA tools

- **Where:** Vega SDK 0.24 documentation.
- **What happened:** building FireLab's Vega driver from the docs, the device and input commands (`vega exec vda`, `inputd-cli`) were documented, but we couldn't find the exact syntax to query the foreground app and launch an app through `vlcm` on the VDA tools page, so the driver has to guess and fall back (unverified without Vega hardware).
- **Would help:** a reference page for `vlcm` (or an equivalent "launch / stop / foreground app" command set) next to the VDA tools docs.

## 11. Real remote presses can't be simulated on the emulator without root

- **Where:** Android Emulator (Google APIs arm64 image).
- **What happened:** FireLab's play-session recorder reads real remote input events. To test it without hardware we needed to send real input events: `adb emu event send` produced no events, and `sendevent` was refused ("Permission denied") until `adb root`.
- **Would help:** a documented way to simulate the Fire TV remote's input device on emulators.

## 12. "Play on your phone" servers collide and crash

- **Where:** Fire TV Stick 3rd gen, four party games that let players join from their phones (each runs a small web server on the TV and shows a QR code).
- **What happened:** the games pick fixed ports in the same range: the games hub listened on 8765 and 8775, Game E on 8766, Game C on 8765 and 8865. With the hub or Game E still running in the background (as Fire OS keeps them after you press Home), launching Game C crashed it 4–7 seconds later: `java.net.BindException: Address already in use` from its Ktor server. Game C alone: works. After Game E: crashes. After the hub: crashes. Reproduced on demand.
- **Impact:** a player who opens one party game and then another sees the second one vanish. Nothing on the platform warns developers, and the crash only appears when another app happens to hold the port.
- **Second game, same crash:** Game B crashed on launch the same way (`BindException`), reproduced 5/5 by `firelab explore` while another party game was still running.
- **Found with:** FireLab (`launch`, the device log, and the health oracle's crash detection).
- **Would help:** platform guidance for second-screen and companion servers on Fire TV (pick a free port, advertise it with mDNS or the QR code, handle `BindException`), or a shared companion-connection service so games don't each run their own server.

## 13. Self-drawn focus is invisible to accessibility

- **Where:** Fire TV Stick 3rd gen, Game D (a game whose menu highlight is drawn by the game, not by Android view focus).
- **What happened:** pressing ▼ visibly moved the highlight from PARTY to SOLO to HOW TO PLAY, but the accessibility tree (`uiautomator dump`) kept reporting the same focused node. Any tool that reads focus that way, including FireLab's native focus check and very likely Fire OS's VoiceView screen reader (not tested), sees a menu where nothing can be selected. FireLab first reported four "unreachable" buttons; we fixed it to detect this case (the picture changes but focus doesn't) and skip those checks with a note.
- **Impact:** blind and low-vision players using VoiceView can't navigate such menus; automated accessibility checks give false results.
- **Would help:** guidance and a sample for exposing custom-drawn focus to accessibility on Fire TV (WebView: real DOM focus or `aria-activedescendant`; native: `AccessibilityNodeInfo` focus), and a lint or Appstore check for it.

## 14. The emulator's GPU is nothing like a Fire TV's

- **Where:** `firelab lab` emulator shaped like the AFTSSS (Google APIs API 36 arm64 image, headless), macOS on Apple silicon, 2026-10-16.
- **What we did:** opened a three.js game (Firefly Lake) in a wrapped WebView on the emulator and asked WebGL what it runs on.
- **What happened:** the WebView (Chrome 133.0.6943.137) renders through `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …))`, a software renderer. The AFTSSS has a PowerVR Rogue GE8300 and the Amazon WebView 138. Frame rates on the emulator say nothing about the stick, and WebGL features differ in both directions: our desktop Chrome (Apple M1) offers 16384 px textures, S3TC and WebGPU; a Mali-450 stick has no WebGL2 and is expected (from its GPU family) to have 4096 px textures and no S3TC. A game that works in the emulator or on the developer's laptop can show a black screen on the stick.
- **Impact:** without the device, a developer can't see "breaks on this stick" bugs: WebGL2 missing, a texture over the limit, a compressed format the GPU can't decode, highp shaders on GPUs without fragment highp.
- **Workaround in FireLab:** `--emulate-gpu <model>` (docs/GPU.md) makes WebGL report only that model's GPU features and limits, on the emulator, a real device or desktop Chrome, and lists the WebGL calls that fail. Verified on the emulator: under the Mali-450 profile Firefly Lake throws "WebGL2 not available" (in desktop Chrome it shows its own "This device has no WebGL2" screen), and `explore --emulate-gpu AFTT` turns it into a confirmed finding (5/5 replays). Also verified with no device at all, in headless Chrome on 2026-10-19 (docs/results/no-fire-tv-gpu-emulation-2026-10-19/). It copies features and limits, not speed.
- **Would help:** Fire OS emulator images whose WebGL reports the target model's GPU (as `--emulate-gpu` does), and entry 15.

## 15. No per-model GPU and WebGL capability table

- **Where:** Amazon's device specification pages; FireLab's profiles of the AFTSSS and AFTMA08C15.
- **What happened:** the spec pages name the GPU (e.g. "PowerVR GE8300") but not what web games need: WebGL2 or not, `MAX_TEXTURE_SIZE`, `MAX_RENDERBUFFER_SIZE`, extensions, compressed texture formats (ASTC, ETC2, PVRTC), float render targets, shader precision. Even on the two sticks we own, our profiles have WebGL2 measured (FP16 mediump only on the AFTSSS) but the texture limits and the extension list still unknown, because measuring them needs a debuggable WebView app on each model. For the other 60+ Fire TV models, FireLab's GPU values are estimates from the GPU family.
- **Impact:** game developers learn their texture atlas is too big, or their ASTC textures don't decode, from player reviews.
- **Workaround in FireLab:** per-family estimates in `src/fit/gpus.ts` and `src/fit/gpu-emulate.ts`, every value labelled measured / spec / estimated; `firelab profile` records the real values from a device, and the profiles are shared by pull request.
- **Would help:** a published table per model: GPU, WebGL1/2, max texture and renderbuffer size, extensions, compressed formats, `getShaderPrecisionFormat` results, WebView (Chromium) version.

## 16. Web features per Fire OS WebView aren't documented

- **Where:** Fire OS 7 (Android 9) and Fire OS 8 (Android 11) WebViews.
- **What happened:** Chromium enables WebGPU on Android 12 and later, so no Fire OS WebView has it; we inferred this from Chromium's rules, not from Amazon docs. The WebView version is measured as 138 on a Fire OS 7 stick (Appstore updates), but Fire OS 5 and 6 models are frozen on older, unrecorded versions. Whether WebGL2 works on older GPUs (PowerVR GX6250, Adreno 320) depends on Chromium's GPU blocklist, so FireLab has to assume the worst case.
- **Impact:** a web game built with WebGPU or WASM SIMD fails on every Fire TV; the developer finds out on the device.
- **Workaround in FireLab:** `--emulate-gpu` hides `navigator.gpu`; `firelab fit --needs webgpu,wasm-simd` checks needs against what each model is known or estimated to have.
- **Would help:** a "Web platform on Fire TV" page: the WebView version per Fire OS version and model, and which features (WebGL2, WebGPU, WASM SIMD/threads, media codecs, gamepad) are available.

## 17. No guidance for automated D-pad testing

- **Where:** Amazon's Fire TV testing docs, and the Android `monkey` documentation they lead to.
- **What we did:** set up Android Monkey as the baseline for D-pad testing, as the tool comparisons in the research literature do.
- **What happened:** the natural setting `--pct-nav 100` sends only the four arrows. The centre button (OK), Back and Menu are in the separate *majornav* category, so a TV app driven this way is never entered: Monkey wanders the first screen. We only caught it because a research survey pointed it out; our own design doc had the wrong command.
- **Impact:** teams that "ran Monkey on the TV app" may have tested far less than they think.
- **Workaround in FireLab:** `--strategy monkey` sends Monkey's mix with OK, Back and Menu included (`--pct-nav 60 --pct-majornav 35 --pct-syskeys 5`), and `firelab explore` presses every focusable control on each screen.
- **Would help:** a Fire TV page on automated testing with a remote: a correct Monkey command line for D-pad apps, and how to test focus (traps, unreachable controls) and Back.

## 18. No reference apps or benchmark for TV testing tools

- **Where:** published research on automated GUI and game testing (summarised in docs/RESEARCH.md section 9).
- **What happened:** Android testing tools are compared on public benchmarks with known bugs (for example Themis: 52 real bugs, docs/RESEARCH.md section 9). There is nothing comparable for TV or D-pad apps, or for HTML5 games: no reference apps with known bugs, so nobody can check a claim like "this tool finds more TV bugs than Monkey".
- **Workaround in FireLab:** `firelab bench` and two games with seeded bugs that record when each bug fires (Firefly Lake, and Deep Quest, a TV RPG whose bugs sit from 9 to 100 presses deep), scored with standard statistics (docs/BENCHMARK.md).
- **Would help:** a few open-source Fire TV sample apps with documented, seeded bugs (focus traps, Back handling, memory leaks, media stalls) for tool builders, and a place to report results.

---

## Test session log

Entries added while testing real games on real devices.

| Date | Device | What we ran | Result |
|---|---|---|---|
| 2026-10-18 | Fire TV Stick 3rd gen (AFTSSS) | Back-race replay, old vs fixed wrapper | Old 2/5 and 2/3; fixed 0/5 and 0/5 (entry 3) |
| 2026-10-18 | Fire TV Stick 3rd gen (AFTSSS) | `firelab sweep` on Firefly Lake (low, tv, tv-hd) | `tv` holds 30 fps (median 30.0, p10 29.6, 176 MB); `tv-hd` 26.7 / 24.0 |
| 2026-10-18 | Fire TV Stick 3rd gen (AFTSSS) | Launch checks on 5 debuggable games | 3 render; 1 needs a localhost dev server; 1 (Game C) crashes on launch when another party game holds port 8765 (entry 12) |
| 2026-10-18 | Fire TV Stick 3rd gen (AFTSSS) | `firelab explore` (10 min each) on Game F, the games hub, Game E, Game C; none allow WebView inspection | Game C: crash on launch confirmed 4/5 by the engine (entry 12). Others: no crashes, ANRs or black screens; minor findings only. Picture-only mode produced false "frozen" alarms (a dialog pausing the background), fixed in FireLab the same day |
| 2026-10-18 | Fire TV Stick 3rd gen (AFTSSS) | `firelab explore` (8 min each) on Game G, Game A, Game H, Game D, Game I, Game B, Game J | Game A: crash on Back (`NullPointerException` in `onDestroy`), 1 key, 5/5. Game B: crash on launch (`BindException`, entry 12), 5/5. Game D: false "unreachable" buttons from self-drawn focus (entry 13), fixed in FireLab; the re-run found nothing. Others: no crashes, ANRs or black screens |
| 2026-10-18 | Fire TV Stick 3rd gen (AFTSSS) | Re-runs of the games hub and Game D after the fixes | Game D: no findings. The hub's "OK opens another game" is now treated as a hand-off, not an exit (code fix; not re-run on the device) |
| 2026-10-16 | AFTSSS-shaped emulator (API 36, WebView 133, SwiftShader) | `firelab fit --emulate-gpu AFTT,AFTSSS` and `explore --emulate-gpu AFTT` on Firefly Lake | Mali-450 profile: WebGL2 refused, the game throws "WebGL2 not available"; finding confirmed 5/5. GE8300 profile: renders, two WebGL2 contexts (entry 14) |
| 2026-10-18 | Desktop Chrome 155, Fire TV viewport (browser driver) | `firelab bench`: FireLab vs Random and Monkey's D-pad mix, Firefly Lake and Deep Quest, 5 × 10 min each | FireLab covered 52-79% more game code than Monkey (Â12 = 1.00) and reported 4 vs 2 seeded bugs per run on Firefly Lake; nobody reached Deep Quest's bugs below floor 10 in 10 minutes (entries 17, 18; docs/BENCHMARK.md) |
