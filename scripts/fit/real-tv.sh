#!/usr/bin/env bash
# The fit steps that need a real Fire TV. Run them yourself when nobody else
# is using the TV (one agent or person on the device at a time).
#
#   scripts/fit/real-tv.sh profile    [--package <debuggable WebView app>]   read-only
#   scripts/fit/real-tv.sh measure    [--package com.sunsetvilla.tv]         read-only
#   scripts/fit/real-tv.sh tiers  --url <page url> --yes                     reloads the page per tier
#   scripts/fit/real-tv.sh simulate --url <page url> --yes                   reloads, throttles the CPU, sends trim-memory
#
# Environment: FIRELAB_DEVICE (default 192.168.1.194:5555), FIRELAB_PACKAGE
# (default com.sunsetvilla.tv). Results go to ./fit-results/.
set -euo pipefail
cd "$(dirname "$0")/../.."

DEVICE="${FIRELAB_DEVICE:-192.168.1.194:5555}"
PKG="${FIRELAB_PACKAGE:-com.sunsetvilla.tv}"
URL=""
YES=""
step="${1:-help}"
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --package) PKG="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done

npm run build >/dev/null
mkdir -p fit-results
FIT=(node dist/fit/main.js)
stamp="$(date +%Y%m%d-%H%M%S)"

need_yes() {
  if [ -z "$YES" ]; then
    echo "This step changes what is on the TV ($1). It is not read-only, so" >&2
    echo "$PKG must be yours to disturb (com.sunsetvilla.tv: only with the owner's OK). Re-run with --yes." >&2
    exit 1
  fi
}

case "$step" in
  profile)
    # Read-only: getprop, /proc/meminfo, wm size, cpufreq, dumpsys webviewupdate, and
    # WebGL / MediaCapabilities probes inside $PKG's page (it is launched if not running).
    # Start on the Home screen so the idle memory reading means something.
    "${FIT[@]}" profile -d "$DEVICE" --package "$PKG" --out profiles
    echo "Review the diff: git diff profiles/ (the capture is merged into the existing profile)."
    ;;
  measure)
    # Read-only: measures the app as it is now (no reload, no navigation).
    out="fit-results/measurement-$PKG-$stamp.json"
    "${FIT[@]}" fit -d "$DEVICE" --package "$PKG" --seconds 20 --out "$out" --report "fit-results/fit-$PKG-$stamp.html" --markdown "fit-results/fit-$PKG-$stamp.md"
    echo "Re-score later without the TV: node dist/fit/main.js fit --offline $out"
    ;;
  tiers)
    [ -n "$URL" ] || { echo "--url <the page the app loads> is required" >&2; exit 1; }
    need_yes "it reloads the page at ?q=tv and ?q=tv-hd, then restores it"
    out="fit-results/measurement-tiers-$stamp.json"
    "${FIT[@]}" fit -d "$DEVICE" --package "$PKG" --url "$URL" --tiers tv,tv-hd --seconds 20 --warmup 8 --out "$out" --report "fit-results/fit-tiers-$stamp.html"
    ;;
  simulate)
    [ -n "$URL" ] || { echo "--url <the page the app loads> is required" >&2; exit 1; }
    need_yes "it reloads the page, throttles the WebView CPU, renders at a higher scale, and sends RUNNING_CRITICAL trim-memory (the app may reload or restart)"
    out="fit-results/measurement-sim-$stamp.json"
    "${FIT[@]}" fit -d "$DEVICE" --package "$PKG" --url "$URL" --tiers tv,tv-hd --simulate cpu,gpu,trim --simulate-for AFTSSS --seconds 20 --warmup 8 --out "$out" --report "fit-results/fit-sim-$stamp.html"
    echo "Check in the report: the sim:AFTSSS run (CPU throttle + pixel load) and the memory-pressure outcome."
    ;;
  *)
    sed -n '2,12p' "$0"
    ;;
esac
