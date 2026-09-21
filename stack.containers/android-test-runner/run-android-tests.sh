#!/usr/bin/env bash
set -Eeuo pipefail

artifacts="${ANDROID_ARTIFACT_DIR:-/artifacts}/android-api${ANDROID_API_LEVEL:-36}"
mkdir -p "$artifacts"
if [ "$#" -eq 0 ]; then
  adb shell getprop >"$artifacts/device-properties.txt"
  curl -fsS "http://${APPIUM_HOST:-127.0.0.1}:${APPIUM_PORT:-4723}/status" >"$artifacts/appium-status.json"
  printf '%s\n' '<testsuite name="android-smoke" tests="1" failures="0"><testcase name="emulator-and-appium-ready"/></testsuite>' >"$artifacts/junit.xml"
  exit 0
fi
exec "$@"
