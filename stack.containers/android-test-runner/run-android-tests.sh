#!/usr/bin/env bash
set -Eeuo pipefail

artifacts="${ANDROID_ARTIFACT_DIR:-/artifacts}/android-api${ANDROID_API_LEVEL:-36}"
mkdir -p "$artifacts"
if [ "$#" -eq 0 ]; then
  adb shell getprop >"$artifacts/device-properties.txt"
  appium_url="http://${APPIUM_HOST:-127.0.0.1}:${APPIUM_PORT:-4723}/status"
  for attempt in $(seq 1 60); do
    if curl -fsS "$appium_url" >"$artifacts/appium-status.json"; then
      break
    fi
    if [ "$attempt" -eq 60 ]; then
      printf 'Appium did not become ready at %s within 60 seconds\n' "$appium_url" >&2
      exit 1
    fi
    sleep 1
  done
  printf '%s\n' '<testsuite name="android-smoke" tests="1" failures="0"><testcase name="emulator-and-appium-ready"/></testsuite>' >"$artifacts/junit.xml"
  exit 0
fi
exec "$@"
