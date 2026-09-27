#!/bin/bash
# Xcode build phase ("Embed uv helper", conch-mac target): put the pinned uv in
# conch.app at Contents/Helpers/uv, with its licence, signed like the app.
#
# Why: conch's natural voices (Kokoro) run in a Python environment conch builds
# for itself (src/voice-env.ts). The app hands the daemon this uv's path as
# CONCH_UV (DaemonHost.swift), so a downloaded conch needs nothing else
# installed — no `brew install uv`, no `uv tool install`.
#
# Signing: nested code is signed BEFORE Xcode seals the outer bundle, which is
# why this is a build phase and not a post-build step. Same identity Xcode uses
# for the app ($EXPANDED_CODE_SIGN_IDENTITY — the project's Developer ID
# Application), hardened runtime like the app, and the same timestamp policy as
# the app (Xcode's `build` signs with --timestamp=none; OTHER_CODE_SIGN_FLAGS
# comes after, so a release that asks for a secure timestamp gets one here too).
# An unsigned build (CODE_SIGNING_ALLOWED=NO, the CI gate's) keeps uv's own
# upstream signature. This script never reads a key, a .p12 or a password.
#
# Environment (all set by Xcode): TARGET_BUILD_DIR, CONTENTS_FOLDER_PATH,
# UNLOCALIZED_RESOURCES_FOLDER_PATH, CONFIGURATION, CODE_SIGNING_ALLOWED,
# EXPANDED_CODE_SIGN_IDENTITY, OTHER_CODE_SIGN_FLAGS.
# Test seams: CONCH_UV_SOURCE (a uv binary to embed instead of fetching),
# CODESIGN (the codesign to run).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
: "${TARGET_BUILD_DIR:?run this from the conch-mac Xcode build}"
: "${CONTENTS_FOLDER_PATH:?run this from the conch-mac Xcode build}"
RESOURCES="${UNLOCALIZED_RESOURCES_FOLDER_PATH:-$CONTENTS_FOLDER_PATH/Resources}"
HELPERS="$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH/Helpers"
NOTICES="$TARGET_BUILD_DIR/$RESOURCES/ThirdParty/uv"
CODESIGN="${CODESIGN:-/usr/bin/codesign}"

source_uv="${CONCH_UV_SOURCE:-}"
if [[ -z "$source_uv" ]]; then
  if ! source_uv="$("$SCRIPT_DIR/fetch-uv.sh")"; then
    # A release must carry uv: without it a new user's natural voices can never
    # set themselves up. A Debug build may go without (offline, say); the
    # daemon then looks for a uv elsewhere and says so if it finds none.
    if [[ "${CONFIGURATION:-}" == "Release" ]]; then
      echo "error: could not fetch the pinned uv (scripts/fetch-uv.sh); a Release conch.app must carry it" >&2
      exit 1
    fi
    echo "warning: could not fetch the pinned uv; this ${CONFIGURATION:-Debug} build has no Contents/Helpers/uv"
    exit 0
  fi
fi
[[ -x "$source_uv" ]] || { echo "error: $source_uv is not an executable uv" >&2; exit 1; }

mkdir -p "$HELPERS" "$NOTICES"
install -m 0755 "$source_uv" "$HELPERS/uv"
install -m 0644 "$REPO_ROOT/mac-app/third-party/uv/LICENSE-MIT" \
  "$REPO_ROOT/mac-app/third-party/uv/LICENSE-APACHE" \
  "$REPO_ROOT/mac-app/third-party/uv/NOTICE" "$NOTICES/"

if [[ "${CODE_SIGNING_ALLOWED:-YES}" == "YES" && -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]]; then
  # OTHER_CODE_SIGN_FLAGS is deliberately unquoted: it is a list of flags.
  # shellcheck disable=SC2086
  "$CODESIGN" --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" --options runtime --timestamp=none \
    ${OTHER_CODE_SIGN_FLAGS:-} "$HELPERS/uv"
  echo "embedded and signed $HELPERS/uv"
else
  echo "embedded $HELPERS/uv (code signing is off for this build; uv keeps its upstream signature)"
fi
