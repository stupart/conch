#!/bin/bash
# Xcode build phase ("Embed speech engine", conch-mac target): put seashell's
# speech engine in conch.app — whisper-cli, whisper-server and sox at
# Contents/Helpers, the Silero VAD model at Contents/Resources/models — with
# their licences (and SoX's source, which its GPL asks to travel with it),
# each binary signed like the app.
#
# Why: a downloaded conch must hear and transcribe with nothing else installed.
# The daemon resolves every part from the app first (src/speech-engine.ts), then
# a seashell install, then Homebrew; only the 574 MB whisper model is fetched,
# on first run, by the daemon.
#
# One slice per architecture Xcode builds ($ARCHS), from scripts/fetch-engine.sh
# (pinned sources, verified, cached under build/vendor); several are joined with
# lipo, so the helpers always match the app.
#
# Signing, as scripts/embed-uv.sh: nested code is signed before Xcode seals the
# bundle, with the app's identity, the Hardened Runtime and the app's timestamp
# policy. sox also gets the audio-input entitlement: it is the process that
# opens the microphone (mac-app/helpers/sox.entitlements). An unsigned build
# (CODE_SIGNING_ALLOWED=NO, the CI gate's) embeds without signing. This script
# never reads a key, a .p12 or a password.
#
# Environment (all set by Xcode): TARGET_BUILD_DIR, CONTENTS_FOLDER_PATH,
# UNLOCALIZED_RESOURCES_FOLDER_PATH, ARCHS, CONFIGURATION, CODE_SIGNING_ALLOWED,
# EXPANDED_CODE_SIGN_IDENTITY, OTHER_CODE_SIGN_FLAGS.
# Test seams: CONCH_ENGINE_SOURCE (a directory with the built files, used for
# every arch instead of fetch-engine.sh), CODESIGN, LIPO.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
: "${TARGET_BUILD_DIR:?run this from the conch-mac Xcode build}"
: "${CONTENTS_FOLDER_PATH:?run this from the conch-mac Xcode build}"
RESOURCES="$TARGET_BUILD_DIR/${UNLOCALIZED_RESOURCES_FOLDER_PATH:-$CONTENTS_FOLDER_PATH/Resources}"
HELPERS="$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH/Helpers"
CODESIGN="${CODESIGN:-/usr/bin/codesign}"
LIPO="${LIPO:-/usr/bin/lipo}"
BINARIES=(whisper-cli whisper-server sox)
VAD_FILE=ggml-silero-v6.2.0.bin
SOX_TARBALL=sox-14.4.2.tar.gz

skip_or_fail() { # <why>
  # A release must carry the engine: without it a new user's microphone and
  # transcription depend on Homebrew again. A Debug build may go without
  # (offline, no cmake); the daemon then resolves seashell or Homebrew.
  if [[ "${CONFIGURATION:-}" == "Release" ]]; then
    echo "error: $1; a Release conch.app must carry the speech engine" >&2
    exit 1
  fi
  echo "warning: $1; this ${CONFIGURATION:-Debug} build has no bundled speech engine"
  exit 0
}

archs=()
for arch in ${ARCHS:-arm64}; do
  case "$arch" in
    arm64 | x86_64) archs+=("$arch") ;;
    *) skip_or_fail "no speech engine recipe for $arch" ;;
  esac
done

sources=()
for arch in "${archs[@]}"; do
  if [[ -n "${CONCH_ENGINE_SOURCE:-}" ]]; then
    sources+=("$CONCH_ENGINE_SOURCE")
  elif dir="$("$SCRIPT_DIR/fetch-engine.sh" "$arch")"; then
    sources+=("$dir")
  else
    skip_or_fail "could not build the pinned speech engine for $arch (scripts/fetch-engine.sh)"
  fi
done
for dir in "${sources[@]}"; do
  for file in "${BINARIES[@]}"; do
    [[ -x "$dir/$file" ]] || { echo "error: $dir/$file is not an executable" >&2; exit 1; }
  done
  for file in "$VAD_FILE" "$SOX_TARBALL"; do
    [[ -f "$dir/$file" ]] || { echo "error: $dir/$file is missing" >&2; exit 1; }
  done
done

mkdir -p "$HELPERS" "$RESOURCES/models"
for file in "${BINARIES[@]}"; do
  if [[ "${#sources[@]}" -eq 1 ]]; then
    install -m 0755 "${sources[0]}/$file" "$HELPERS/$file"
  else
    slices=()
    for dir in "${sources[@]}"; do slices+=("$dir/$file"); done
    rm -f "$HELPERS/$file"
    "$LIPO" -create "${slices[@]}" -output "$HELPERS/$file"
    chmod 0755 "$HELPERS/$file"
  fi
done
install -m 0644 "${sources[0]}/$VAD_FILE" "$RESOURCES/models/$VAD_FILE"

notices="$RESOURCES/ThirdParty"
mkdir -p "$notices/whisper.cpp" "$notices/sox" "$notices/silero-vad"
install -m 0644 "$REPO_ROOT/mac-app/third-party/whisper.cpp/LICENSE" "$REPO_ROOT/mac-app/third-party/whisper.cpp/NOTICE" "$notices/whisper.cpp/"
install -m 0644 "$REPO_ROOT/mac-app/third-party/sox/COPYING" "$REPO_ROOT/mac-app/third-party/sox/LICENSE.GPL" \
  "$REPO_ROOT/mac-app/third-party/sox/LICENSE.LGPL" "$REPO_ROOT/mac-app/third-party/sox/NOTICE" \
  "${sources[0]}/$SOX_TARBALL" "$notices/sox/"
install -m 0644 "$REPO_ROOT/mac-app/third-party/silero-vad/LICENSE" "$REPO_ROOT/mac-app/third-party/silero-vad/NOTICE" "$notices/silero-vad/"

if [[ "${CODE_SIGNING_ALLOWED:-YES}" == "YES" && -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]]; then
  for file in "${BINARIES[@]}"; do
    entitlements=()
    [[ "$file" == sox ]] && entitlements=(--entitlements "$REPO_ROOT/mac-app/helpers/sox.entitlements")
    # OTHER_CODE_SIGN_FLAGS is deliberately unquoted: it is a list of flags.
    # shellcheck disable=SC2086
    "$CODESIGN" --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" --options runtime \
      ${entitlements[@]+"${entitlements[@]}"} --timestamp=none ${OTHER_CODE_SIGN_FLAGS:-} "$HELPERS/$file"
  done
  echo "embedded and signed ${BINARIES[*]} (${archs[*]}) in $HELPERS"
else
  echo "embedded ${BINARIES[*]} (${archs[*]}) in $HELPERS (code signing is off for this build)"
fi
