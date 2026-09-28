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
node /usr/local/lib/android-mail-proxy.js &
node /usr/local/lib/android-dns-proxy.js &
emulator -avd "$avd" -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swiftshader -accel on -wipe-data -dns-server 127.0.0.1 >"$artifacts/emulator.log" 2>&1 &
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do sleep 2; done
if [ "$api" = 36 ]; then
  test -s /ca/caddy-ca.crt || { printf 'Caddy CA bundle is required for native mail checks\n' >&2; exit 1; }
  adb root >/dev/null
  adb wait-for-device
  awk '/-----BEGIN CERTIFICATE-----/ { cert = $0 "\n"; next }
       cert != "" { cert = cert $0 "\n" }
       /-----END CERTIFICATE-----/ { last = cert }
       END { printf "%s", last }' /ca/caddy-ca.crt > /tmp/caddy-root.crt
  hash="$(openssl x509 -in /tmp/caddy-root.crt -noout -subject_hash_old)"
  adb push /tmp/caddy-root.crt "/data/local/tmp/${hash}.0" >/dev/null
  adb shell 'mkdir -p /data/local/tmp/system-cacerts && cp /apex/com.android.conscrypt/cacerts/* /data/local/tmp/system-cacerts/ && mount -t tmpfs tmpfs /apex/com.android.conscrypt/cacerts && cp /data/local/tmp/system-cacerts/* /apex/com.android.conscrypt/cacerts/'
  adb shell "cp /data/local/tmp/${hash}.0 /apex/com.android.conscrypt/cacerts/${hash}.0 && chmod 0644 /apex/com.android.conscrypt/cacerts/*"
fi
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
appium --address "${APPIUM_HOST:-127.0.0.1}" --port "${APPIUM_PORT:-4723}" \
  --allow-insecure=uiautomator2:chromedriver_autodownload \
  --log-level error --log "$artifacts/appium.log" >/dev/null 2>&1 &
export APPIUM_PID=$!
exec /usr/local/bin/run-android-tests "$@"
