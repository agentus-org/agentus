#!/usr/bin/env bash
# Build the Android companion APK and drop it where both the cockpit server and the notify
# test bed serve it from (/agentus-companion.apk and /dl/agentus-companion.apk).
#
#   bash scripts/build-apk.sh
#
# Needs: Android SDK (ANDROID_HOME, or the default macOS location) and a JDK 17+ — this
# machine's `java` is 8, which AGP rejects, so Android Studio's bundled JBR is the default.
# The first run downloads Gradle 8.13 (~130 MB) into ~/.gradle/wrapper/dists.
set -euo pipefail

cd "$(dirname "$0")/../android"

# --- version gate ---------------------------------------------------------------------------
# The APK is a separate artifact, and a phone has only ONE way to tell builds apart: the
# versionName in its app info. The server's version says nothing about the APK. On 2026-10-18
# the 0.7.1 install was rebuilt twice with new Java inside (the replayed-notification guard,
# then in-page navigation from a notification tap) and shipped under the same 0.7.1 the
# operator already had — so "did my change land?" was unanswerable from the phone, and it
# looked like the rebuild had not happened at all.
# The rule therefore lives in the build, not in a habit: the LAST commit touching app/src must
# also be a commit that set this versionCode. Anything else means code moved and the version
# did not, and the build stops here.
CODE=$(sed -n 's/^ *versionCode *\([0-9][0-9]*\).*/\1/p' app/build.gradle | head -1)
NAME=$(sed -n 's/^ *versionName *"\([^"]*\)".*/\1/p' app/build.gradle | head -1)
if [ -z "$CODE" ]; then
  echo "[apk] REFUSING: cannot read versionCode from app/build.gradle" >&2
  exit 2
fi
if [ "${AGENTUS_APK_ALLOW_STALE_VERSION:-0}" != "1" ]; then
  src_ts=$(git log -1 --format=%ct -- app/src 2>/dev/null || echo 0)
  bump_ts=$(git log -1 -S"versionCode $CODE" --format=%ct -- app/build.gradle 2>/dev/null || echo 0)
  dirty=$(git status --porcelain -- app/src 2>/dev/null || true)
  if [ -n "$dirty" ]; then
    echo "[apk] REFUSING: app/src has uncommitted changes — commit them together with a versionCode bump." >&2
    echo "$dirty" | sed 's/^/[apk]   /' >&2
    echo "[apk] Bump android/app/build.gradle (versionCode + versionName), commit both, then rerun." >&2
    echo "[apk] (override for a throwaway build: AGENTUS_APK_ALLOW_STALE_VERSION=1)" >&2
    exit 2
  fi
  if [ "$src_ts" -gt "$bump_ts" ]; then
    echo "[apk] REFUSING: app/src changed after the commit that set versionCode $CODE (\"$NAME\")." >&2
    echo "[apk]   last app/src commit: $(git log -1 --format='%h %ad %s' --date=short -- app/src)" >&2
    echo "[apk]   versionCode $CODE set in: $(git log -1 -S"versionCode $CODE" --format='%h %ad %s' --date=short -- app/build.gradle)" >&2
    echo "[apk] Bump versionCode (e.g. $((CODE + 1))) and versionName in android/app/build.gradle, commit with the change, then rerun." >&2
    echo "[apk] Why: the phone can only tell builds apart by versionName — same number, two builds, no way to know what is installed." >&2
    exit 2
  fi
fi
echo "[apk] version $NAME (versionCode $CODE)"

export JAVA_HOME="${AGENTUS_JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
echo "[apk] JAVA_HOME=$JAVA_HOME"
echo "[apk] ANDROID_HOME=$ANDROID_HOME"

./gradlew --console=plain assembleRelease

mkdir -p artifacts
cp -f app/build/outputs/apk/release/app-release.apk artifacts/agentus-companion.apk
# Read the identity back out of the built file, not out of the source: the point of the gate is
# that the artifact says what it is.
AAPT2=$(ls "$ANDROID_HOME"/build-tools/*/aapt2 2>/dev/null | tail -1)
if [ -n "$AAPT2" ]; then
  "$AAPT2" dump badging artifacts/agentus-companion.apk 2>/dev/null | head -1 | sed 's/^/[apk] /'
fi
echo "[apk] $(pwd)/artifacts/agentus-companion.apk"
shasum -a 256 artifacts/agentus-companion.apk
