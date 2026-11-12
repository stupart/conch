#!/bin/bash
# Xcode build phase ("Embed microphone helper", conch-mac target): compile
# conch Microphone (scripts/build-microphone.sh, seashell's native recorder)
# for every architecture Xcode builds ($ARCHS), join the slices with lipo, and
# put it in conch.app at Contents/Helpers/conch-microphone with seashell's
# licence, signed like the app.
#
# Why: sox's CoreAudio driver rewrites the input device's IO buffer size every
# time a capture opens and drops what its small ring cannot hold; this records
# at the device's own rate and touches no device property (2026-11-11). The
# daemon prefers it and keeps sox as the fallback (src/microphone-helper.ts).
#
# Signing, as scripts/embed-engine.sh signs sox: the app's identity, the
# Hardened Runtime, the app's timestamp policy, and the audio-input
# entitlement (mac-app/helpers/conch-microphone.entitlements), because this is
# the process that opens the microphone. Its identifier is the one its
# Info.plist names, so macOS keeps its Microphone permission across rebuilds.
# An unsigned build (CODE_SIGNING_ALLOWED=NO, the CI gate's) embeds without
# signing. This script never reads a key, a .p12 or a password.
#
# Environment (all set by Xcode): TARGET_BUILD_DIR, CONTENTS_FOLDER_PATH,
# UNLOCALIZED_RESOURCES_FOLDER_PATH, ARCHS, CONFIGURATION, CODE_SIGNING_ALLOWED,
# EXPANDED_CODE_SIGN_IDENTITY, OTHER_CODE_SIGN_FLAGS.
# Test seams: SWIFTC (scripts/build-microphone.sh), CODESIGN, LIPO.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
: "${TARGET_BUILD_DIR:?run this from the conch-mac Xcode build}"
: "${CONTENTS_FOLDER_PATH:?run this from the conch-mac Xcode build}"
RESOURCES="$TARGET_BUILD_DIR/${UNLOCALIZED_RESOURCES_FOLDER_PATH:-$CONTENTS_FOLDER_PATH/Resources}"
HELPERS="$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH/Helpers"
HELPER="$HELPERS/conch-microphone"
CODESIGN="${CODESIGN:-/usr/bin/codesign}"
LIPO="${LIPO:-/usr/bin/lipo}"
IDENTIFIER=ai.blueprintstudio.conch.microphone

skip_or_fail() { # <why>
  # A release must carry it: without it conch records with sox again. A Debug
  # build may go without (no Swift toolchain); the daemon then uses sox, and
  # says so.
  if [[ "${CONFIGURATION:-}" == "Release" ]]; then
    echo "error: $1; a Release conch.app must carry conch Microphone" >&2
    exit 1
  fi
  echo "warning: $1; this ${CONFIGURATION:-Debug} build records with sox"
  exit 0
}

archs=()
for arch in ${ARCHS:-arm64}; do
  case "$arch" in
    arm64 | x86_64) archs+=("$arch") ;;
    *) skip_or_fail "no conch Microphone recipe for $arch" ;;
  esac
done

work="$(mktemp -d "${TMPDIR:-/tmp}/conch-microphone.XXXXXX")"
trap 'rm -rf "$work"' EXIT
slices=()
for arch in "${archs[@]}"; do
  if ! "$SCRIPT_DIR/build-microphone.sh" "$arch" "$work/conch-microphone-$arch"; then
    skip_or_fail "could not compile conch Microphone for $arch (scripts/build-microphone.sh)"
  fi
  slices+=("$work/conch-microphone-$arch")
done

mkdir -p "$HELPERS" "$RESOURCES/ThirdParty/seashell"
rm -f "$HELPER"
if [[ "${#slices[@]}" -eq 1 ]]; then
  install -m 0755 "${slices[0]}" "$HELPER"
else
  "$LIPO" -create "${slices[@]}" -output "$HELPER"
  chmod 0755 "$HELPER"
fi
install -m 0644 "$REPO_ROOT/mac-app/third-party/seashell/LICENSE" "$REPO_ROOT/mac-app/third-party/seashell/NOTICE" \
  "$RESOURCES/ThirdParty/seashell/"

if [[ "${CODE_SIGNING_ALLOWED:-YES}" == "YES" && -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]]; then
  # OTHER_CODE_SIGN_FLAGS is deliberately unquoted: it is a list of flags.
  # shellcheck disable=SC2086
  "$CODESIGN" --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" --options runtime --identifier "$IDENTIFIER" \
    --entitlements "$REPO_ROOT/mac-app/helpers/conch-microphone.entitlements" --timestamp=none \
    ${OTHER_CODE_SIGN_FLAGS:-} "$HELPER"
  echo "embedded and signed $HELPER (${archs[*]})"
else
  echo "embedded $HELPER (${archs[*]}; code signing is off for this build)"
fi
