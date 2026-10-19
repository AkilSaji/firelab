#!/usr/bin/env bash
# Builds the native focus fixture (no Gradle): aapt2 -> javac -> d8 -> zipalign -> apksigner.
# Output: examples/native-tv/out/nativefixture.apk (package dev.firelab.nativefixture).
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
JAR="$SDK/platforms/$(ls "$SDK/platforms" | sort -V | tail -1)/android.jar"
KS="${KEYSTORE:-$HOME/.android/debug.keystore}"
rm -rf out && mkdir -p out/classes out/dex
"$BT/aapt2" link -I "$JAR" --manifest AndroidManifest.xml -o out/unsigned.apk
javac -encoding UTF-8 -source 8 -target 8 -Xlint:-options -nowarn -bootclasspath "$JAR" -classpath "$JAR" -d out/classes src/dev/firelab/nativefixture/MainActivity.java
"$BT/d8" --release --min-api 22 --lib "$JAR" --output out/dex $(find out/classes -name '*.class')
(cd out/dex && zip -q ../unsigned.apk classes.dex)
"$BT/zipalign" -f -p 4 out/unsigned.apk out/aligned.apk
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --out out/nativefixture.apk out/aligned.apk
rm -f out/nativefixture.apk.idsig
echo "built $(pwd)/out/nativefixture.apk"
