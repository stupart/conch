#!/bin/bash
# Verify that a built conch.app carries everything it needs to run with nothing
# else installed: its daemon and seashell's speech engine, each signed like the
# app, with the entitlements each needs, for the app's own architectures.
#
#   scripts/check-app-bundle.sh <conch.app> <bundled|checkout>
#
# The second argument is the daemon the build prefers (Info.plist
# ConchDaemonSource): `bundled` for anything shipped, `checkout` for the dev
# install (scripts/build-app.sh). Run by build-app.sh, build-release.sh and
# release-app.sh; every failure names the file and exits 1.
set -euo pipefail

APP="${1:?usage: scripts/check-app-bundle.sh <conch.app> <bundled|checkout>}"
EXPECT_SOURCE="${2:?usage: scripts/check-app-bundle.sh <conch.app> <bundled|checkout>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPERS="$APP/Contents/Helpers"
RESOURCES="$APP/Contents/Resources"
VAD_SHA256=2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987

fail() { echo "error: $*" >&2; exit 1; }

source_declared="$(/usr/libexec/PlistBuddy -c 'Print :ConchDaemonSource' "$APP/Contents/Info.plist" 2>/dev/null || true)"
[[ "$source_declared" == "$EXPECT_SOURCE" ]] \
  || fail "$APP declares ConchDaemonSource '$source_declared', expected '$EXPECT_SOURCE'"

app_archs="$(lipo -archs "$APP/Contents/MacOS/conch-mac" | tr ' ' '\n' | sort | xargs)"
for helper in conch-daemon whisper-cli whisper-server sox; do
  path="$HELPERS/$helper"
  [[ -x "$path" ]] || fail "$path is missing — its Embed build phase did not run"
  codesign --verify --strict "$path" || fail "$path is not validly signed"
  details="$(codesign -dv --verbose=2 "$path" 2>&1)"
  grep -q '^Authority=Developer ID Application' <<<"$details" || fail "$path is not signed with the Developer ID identity"
  grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]*\(.*runtime' <<<"$details" || fail "$path is not signed with the Hardened Runtime"
  archs="$(lipo -archs "$path" | tr ' ' '\n' | sort | xargs)"
  [[ "$archs" == "$app_archs" ]] || fail "$path is built for '$archs' but the app is '$app_archs'"
done

entitlements() { codesign -d --entitlements - --xml "$1" 2>/dev/null; }
entitlements "$HELPERS/conch-daemon" | grep -q 'com.apple.security.cs.allow-jit' \
  || fail "$HELPERS/conch-daemon lacks com.apple.security.cs.allow-jit (JavaScriptCore and bun:ffi need it)"
entitlements "$HELPERS/sox" | grep -q 'com.apple.security.device.audio-input' \
  || fail "$HELPERS/sox lacks com.apple.security.device.audio-input (it would record silence)"

vad="$RESOURCES/models/ggml-silero-v6.2.0.bin"
[[ -f "$vad" ]] || fail "$vad is missing"
echo "$VAD_SHA256  $vad" | shasum -a 256 -c - >/dev/null || fail "$vad is not the pinned VAD model"
for notice in ThirdParty/whisper.cpp/LICENSE ThirdParty/sox/LICENSE.GPL ThirdParty/sox/sox-14.4.2.tar.gz \
  ThirdParty/silero-vad/LICENSE ThirdParty/bun/LICENSE.md; do
  [[ -f "$RESOURCES/$notice" ]] || fail "$RESOURCES/$notice is missing"
done

version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -1)"
if tr ' ' '\n' <<<"$app_archs" | grep -qx "$(uname -m)"; then
  reported="$("$HELPERS/conch-daemon" version)"
  [[ "$reported" == "conch $version" ]] || fail "the bundled daemon reports '$reported', expected 'conch $version'"
  "$HELPERS/whisper-cli" --help >/dev/null 2>&1 || fail "$HELPERS/whisper-cli does not run"
  "$HELPERS/sox" -h 2>/dev/null | grep -q 'AUDIO DEVICE DRIVERS: coreaudio' || fail "$HELPERS/sox has no CoreAudio driver"
fi

echo "✓ $APP carries its daemon (conch $version) and speech engine ($app_archs), signed; daemon source: $EXPECT_SOURCE"
