#!/usr/bin/env bash
set -Eeuo pipefail

lock=/usr/local/share/android-apks.lock.json
destination=${ANDROID_APK_DIR:-/artifacts/android-apks}
selected=${1:-all}
mkdir -p "$destination"

jq -e '.schemaVersion == 1 and (.apps | length == 13)' "$lock" >/dev/null
while IFS=$'\t' read -r app_id package version_name version_code source_url expected_hash expected_signer; do
  if [ "$selected" != all ] && [ "$selected" != "$app_id" ]; then continue; fi
  file="$destination/$app_id.apk"
  if [ ! -f "$file" ] || ! printf '%s  %s\n' "$expected_hash" "$file" | sha256sum -c --status; then
    tmp="$file.download"
    rm -f "$tmp"
    curl --fail --location --silent --show-error --retry 3 --connect-timeout 20 --max-time 1800 --output "$tmp" "$source_url"
    printf '%s  %s\n' "$expected_hash" "$tmp" | sha256sum -c --status
    mv "$tmp" "$file"
  fi
  package_line="$(aapt dump badging "$file")"
  package_line="${package_line%%$'\n'*}"
  case "$package_line" in
    "package: name='$package' versionCode='$version_code' versionName='$version_name' "*) ;;
    *) printf 'APK package/version mismatch: %s\n' "$app_id" >&2; exit 1 ;;
  esac
  actual_signer="$(apksigner verify --print-certs "$file" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p')"
  if [ "$actual_signer" != "$expected_signer" ]; then
    printf 'APK signer mismatch: %s\n' "$app_id" >&2
    exit 1
  fi
  chmod 0644 "$file"
done < <(jq -r '.apps[] | [.id,.package,.version,(.versionCode|tostring),.url,.sha256,.signerSha256] | @tsv' "$lock")

if [ "$selected" != all ] && ! jq -e --arg id "$selected" '.apps | any(.id == $id)' "$lock" >/dev/null; then
  printf "unknown locked Android app: %s\n" "$selected" >&2
  exit 1
fi
