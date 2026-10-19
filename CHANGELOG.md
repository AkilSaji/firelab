# Changelog

## 0.1.0 (2026-10)

First public release.

- **Devices:** find Fire TVs on the Wi-Fi, connect, keep them connected; model
  names, Fire OS, ABI, RAM, GPU and a quality tier for every Fire TV model.
- **Remote and screen:** D-pad, media keys, text and real holds (virtual HID
  remote); fast screenshots.
- **WebView tools:** JavaScript evaluation, console, frame counting over Chrome
  DevTools, with no Chrome needed.
- **Performance:** `measure`, the quality-tier `sweep`, `watch` play sessions,
  and `@firelab/perf` for games (tier detection, adaptive resolution, meter).
- **Game testing engine:** `firelab explore` plays an app with the remote
  (Go-Explore), finds crashes, JS errors, black/frozen screens, focus traps,
  unreachable controls and wrong-way arrows, shrinks each to a short repro,
  and writes `report.html`. `replay`, `shrink` and `report` work with its traces.
- **fit:** an estimated per-model matrix from one device and device profiles,
  plus `--emulate-gpu` to copy a stick's WebGL features and limits.
- **lab:** Fire-TV-shaped Android emulators and a GitHub Action.
- **wrap:** turn a web URL into a Fire TV APK.
- **MCP server** with 24 tools and 3 prompts; **dashboard**; **CLI**.
- **`firelab demo`** (`npm run demo`): the engine on Lantern Lake, a simulated TV game with six seeded
  bugs; no device needed, about five seconds. `--driver demo` and the MCP `explore_start` tool take it too,
  and `npm run demo:dashboard` shows the dashboard with a simulated TV. A real report from a Fire TV
  Stick 4K Plus is in `docs/sample-run/`.
- **Vega OS driver** (`--driver vda`): built from Amazon's documentation, not
  yet run on a real Vega device.
