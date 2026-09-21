#!/usr/bin/env bash
set -Eeuo pipefail

api="${ANDROID_API_LEVEL:-36}"
abi="${ANDROID_ABI:-x86_64}"
avd="p0-api${api}"
artifacts="${ANDROID_ARTIFACT_DIR:-/artifacts}/android-api${api}"
mkdir -p "$artifacts"

cleanup() {
  adb logcat -d >"$artifacts/logcat.txt" 2>/dev/null || true
  adb emu kill >/dev/null 2>&1 || true
}
trap cleanup EXIT

printf 'no\n' | avdmanager create avd --force --name "$avd" \
  --package "system-images;android-${api};google_apis;${abi}" --device "${ANDROID_DEVICE:-pixel_7}"
emulator -avd "$avd" -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swiftshader_indirect -accel on -wipe-data >"$artifacts/emulator.log" 2>&1 &
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do sleep 2; done
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
appium --address "${APPIUM_HOST:-127.0.0.1}" --port "${APPIUM_PORT:-4723}" \
  --log "$artifacts/appium.log" >/dev/null 2>&1 &
exec /usr/local/bin/run-android-tests "$@"
