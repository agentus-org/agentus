#!/usr/bin/env bash
# Build the Android companion APK and drop it where both the cockpit server and the notify
# test bed serve it from (/agentslot-companion.apk and /dl/agentslot-companion.apk).
#
#   bash scripts/build-apk.sh
#
# Needs: Android SDK (ANDROID_HOME, or the default macOS location) and a JDK 17+ — this
# machine's `java` is 8, which AGP rejects, so Android Studio's bundled JBR is the default.
# The first run downloads Gradle 8.13 (~130 MB) into ~/.gradle/wrapper/dists.
set -euo pipefail

export JAVA_HOME="${AGENTSLOT_JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
echo "[apk] JAVA_HOME=$JAVA_HOME"
echo "[apk] ANDROID_HOME=$ANDROID_HOME"

cd "$(dirname "$0")/../android"
./gradlew --console=plain assembleRelease

mkdir -p artifacts
cp -f app/build/outputs/apk/release/app-release.apk artifacts/agentslot-companion.apk
echo "[apk] $(pwd)/artifacts/agentslot-companion.apk"
shasum -a 256 artifacts/agentslot-companion.apk