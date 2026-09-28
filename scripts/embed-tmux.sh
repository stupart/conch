#!/bin/bash
# Xcode build phase ("Embed tmux", conch-mac target): put the pinned tmux in
# conch.app at Contents/Helpers/tmux, with its licences, signed like the app.
#
# Why: conch hosts sessions in its own tmux server, on its own socket. A Mac
# without Homebrew has no tmux, so the app carries one: "download one thing and
# it works." The daemon resolves it from the app it runs for (CONCH_APP_BUNDLE,
# src/tmux-binary.ts) after an explicit CONCH_TMUX and before Homebrew or PATH.
#
# One slice per architecture Xcode builds ($ARCHS), from scripts/fetch-tmux.sh
# (pinned sources, verified, built reproducibly, cached under build/vendor);
# several are joined with lipo, so the helper always matches the app.
#
# Signing, as scripts/embed-engine.sh: nested code is signed before Xcode seals
# the bundle, with the app's identity, the Hardened Runtime and the app's
# timestamp policy. tmux needs no entitlement: it only forks shells and talks on
# a Unix socket. An unsigned build (CODE_SIGNING_ALLOWED=NO, the CI gate's)
# embeds without signing. This script never reads a key, a .p12 or a password.
#
# Environment (all set by Xcode): TARGET_BUILD_DIR, CONTENTS_FOLDER_PATH,
# UNLOCALIZED_RESOURCES_FOLDER_PATH, ARCHS, CONFIGURATION, CODE_SIGNING_ALLOWED,
# EXPANDED_CODE_SIGN_IDENTITY, OTHER_CODE_SIGN_FLAGS.
# Test seams: CONCH_TMUX_SOURCE (a directory holding a built tmux, used for
# every arch instead of fetch-tmux.sh), CODESIGN, LIPO.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
: "${TARGET_BUILD_DIR:?run this from the conch-mac Xcode build}"
: "${CONTENTS_FOLDER_PATH:?run this from the conch-mac Xcode build}"
RESOURCES="$TARGET_BUILD_DIR/${UNLOCALIZED_RESOURCES_FOLDER_PATH:-$CONTENTS_FOLDER_PATH/Resources}"
HELPERS="$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH/Helpers"
TMUX="$HELPERS/tmux"
CODESIGN="${CODESIGN:-/usr/bin/codesign}"
LIPO="${LIPO:-/usr/bin/lipo}"
NOTICES=(NOTICE COPYING LICENSE.compat LICENSE.libevent COPYING.jemalloc LICENSE.utf8proc.md)

skip_or_fail() { # <why>
  # A release must carry tmux: without it a new user's conch-hosted sessions
  # depend on Homebrew again. A Debug build may go without (offline, say); the
  # daemon then resolves Homebrew's or PATH's, and says which.
  if [[ "${CONFIGURATION:-}" == "Release" ]]; then
    echo "error: $1; a Release conch.app must carry tmux" >&2
    exit 1
  fi
  echo "warning: $1; this ${CONFIGURATION:-Debug} build has no Contents/Helpers/tmux"
  exit 0
}

archs=()
for arch in ${ARCHS:-arm64}; do
  case "$arch" in
    arm64 | x86_64) archs+=("$arch") ;;
    *) skip_or_fail "no tmux recipe for $arch" ;;
  esac
done

slices=()
for arch in "${archs[@]}"; do
  if [[ -n "${CONCH_TMUX_SOURCE:-}" ]]; then
    dir="$CONCH_TMUX_SOURCE"
  elif ! dir="$("$SCRIPT_DIR/fetch-tmux.sh" "$arch")"; then
    skip_or_fail "could not build the pinned tmux for $arch (scripts/fetch-tmux.sh)"
  fi
  [[ -x "$dir/tmux" ]] || { echo "error: $dir/tmux is not an executable" >&2; exit 1; }
  slices+=("$dir/tmux")
done

mkdir -p "$HELPERS" "$RESOURCES/ThirdParty/tmux"
rm -f "$TMUX"
if [[ "${#slices[@]}" -eq 1 ]]; then
  install -m 0755 "${slices[0]}" "$TMUX"
else
  "$LIPO" -create "${slices[@]}" -output "$TMUX"
  chmod 0755 "$TMUX"
fi
for notice in "${NOTICES[@]}"; do
  install -m 0644 "$REPO_ROOT/mac-app/third-party/tmux/$notice" "$RESOURCES/ThirdParty/tmux/"
done

if [[ "${CODE_SIGNING_ALLOWED:-YES}" == "YES" && -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]]; then
  # OTHER_CODE_SIGN_FLAGS is deliberately unquoted: it is a list of flags.
  # shellcheck disable=SC2086
  "$CODESIGN" --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" --options runtime --timestamp=none \
    ${OTHER_CODE_SIGN_FLAGS:-} "$TMUX"
  echo "embedded and signed $TMUX (${archs[*]})"
else
  echo "embedded $TMUX (${archs[*]}; code signing is off for this build)"
fi
