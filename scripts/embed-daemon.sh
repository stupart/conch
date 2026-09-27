#!/bin/bash
# Xcode build phase ("Embed conch daemon", conch-mac target): compile conch
# into conch.app at Contents/Helpers/conch-daemon, signed like the app.
#
# Why: the app owns the daemon (mac-app/conch-mac/DaemonHost.swift), and since
# the daemon became the app's child in August the app has looked for this
# binary first — but no build step ever put it there, so only a Mac with a
# conch checkout had a daemon at all. Tyler: "Download one thing and it works."
#
# What: `bun build --compile ./src/cli.ts` — the same command, and so the same
# program, as the `conch` CLI the Homebrew tarball ships (scripts/build-release.sh)
# — one slice per architecture Xcode builds ($ARCHS), joined with lipo. A
# release passes CONCH_DAEMON_BINARY instead: the CLI it already compiled, so
# the app's daemon and the CLI are the same build, byte for byte before signing.
#
# The embedded daemon must report package.json's version; that is checked by
# running it whenever this Mac can (its own architecture is in the build).
#
# Signing, as scripts/embed-uv.sh: before Xcode seals the bundle, with the
# app's identity, the Hardened Runtime and the app's timestamp policy, plus the
# one entitlement a compiled Bun needs (JIT: mac-app/helpers/conch-daemon.entitlements).
# An unsigned build (CODE_SIGNING_ALLOWED=NO, the CI gate's) embeds unsigned.
# This script never reads a key, a .p12 or a password.
#
# In a dev install (scripts/build-app.sh) the app still RUNS the daemon from
# the checkout — the bundled binary would be stale the moment anyone edits the
# source — but carries this one too, so every build has the layout a release has.
#
# Environment (all set by Xcode): TARGET_BUILD_DIR, CONTENTS_FOLDER_PATH, ARCHS,
# CONFIGURATION, CODE_SIGNING_ALLOWED, EXPANDED_CODE_SIGN_IDENTITY, OTHER_CODE_SIGN_FLAGS.
# Seams: CONCH_DAEMON_BINARY (a compiled conch to embed), CONCH_BUN (the bun to
# compile with), CODESIGN, LIPO.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
: "${TARGET_BUILD_DIR:?run this from the conch-mac Xcode build}"
: "${CONTENTS_FOLDER_PATH:?run this from the conch-mac Xcode build}"
HELPERS="$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH/Helpers"
RESOURCES="$TARGET_BUILD_DIR/${UNLOCALIZED_RESOURCES_FOLDER_PATH:-$CONTENTS_FOLDER_PATH/Resources}"
NOTICES="$RESOURCES/ThirdParty/bun"
DAEMON="$HELPERS/conch-daemon"
CODESIGN="${CODESIGN:-/usr/bin/codesign}"
LIPO="${LIPO:-/usr/bin/lipo}"

skip_or_fail() { # <why>
  # A release must carry its daemon, or a downloaded conch runs nothing. A
  # Debug build may go without (no bun on this Mac); DaemonHost then runs a
  # checkout or a `conch` on PATH, and says so if it finds neither.
  if [[ "${CONFIGURATION:-}" == "Release" ]]; then
    echo "error: $1; a Release conch.app must carry its daemon" >&2
    exit 1
  fi
  echo "warning: $1; this ${CONFIGURATION:-Debug} build has no Contents/Helpers/conch-daemon"
  exit 0
}

VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -1)"
[[ -n "$VERSION" ]] || { echo "error: no version in $REPO_ROOT/package.json" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$HELPERS" "$NOTICES"

if [[ -n "${CONCH_DAEMON_BINARY:-}" ]]; then
  [[ -x "$CONCH_DAEMON_BINARY" ]] || { echo "error: CONCH_DAEMON_BINARY=$CONCH_DAEMON_BINARY is not an executable" >&2; exit 1; }
  install -m 0755 "$CONCH_DAEMON_BINARY" "$work/conch-daemon"
else
  bun="${CONCH_BUN:-}"
  if [[ -z "$bun" ]]; then
    # An Xcode build phase does not see a login shell's PATH.
    for candidate in "$(command -v bun || true)" "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
      [[ -n "$candidate" && -x "$candidate" ]] && { bun="$candidate"; break; }
    done
  fi
  [[ -n "$bun" && -x "$bun" ]] || skip_or_fail "bun was not found to compile the daemon"
  slices=()
  for arch in ${ARCHS:-arm64}; do
    case "$arch" in
      arm64) target=bun-darwin-arm64 ;;
      x86_64) target=bun-darwin-x64 ;;
      *) skip_or_fail "bun cannot compile the daemon for $arch" ;;
    esac
    (cd "$REPO_ROOT" && "$bun" build --compile --target="$target" ./src/cli.ts --outfile "$work/conch-daemon-$arch") \
      >"$work/compile-$arch.log" 2>&1 || { cat "$work/compile-$arch.log" >&2; skip_or_fail "bun build --compile failed for $arch"; }
    slices+=("$work/conch-daemon-$arch")
  done
  if [[ "${#slices[@]}" -eq 1 ]]; then
    mv "${slices[0]}" "$work/conch-daemon"
  else
    "$LIPO" -create "${slices[@]}" -output "$work/conch-daemon"
  fi
  chmod 0755 "$work/conch-daemon"
fi

# Same version as the source it was built from — the CLI and the app's daemon
# are one release. Run it only when this Mac can (its architecture is in it).
host="$(uname -m)"
if "$LIPO" -archs "$work/conch-daemon" 2>/dev/null | tr ' ' '\n' | grep -qx "$host"; then
  reported="$("$work/conch-daemon" version 2>/dev/null || true)"
  [[ "$reported" == "conch $VERSION" ]] || {
    echo "error: the daemon to embed reports '$reported', but package.json is $VERSION" >&2
    exit 1
  }
fi

rm -f "$DAEMON"
install -m 0755 "$work/conch-daemon" "$DAEMON"
# Which build this is, before signing changes its bytes: a release checks it
# against the CLI it ships beside (scripts/build-release.sh).
(cd "$work" && shasum -a 256 conch-daemon) > "$RESOURCES/conch-daemon.sha256"
install -m 0644 "$REPO_ROOT/mac-app/third-party/bun/LICENSE.md" "$REPO_ROOT/mac-app/third-party/bun/NOTICE" "$NOTICES/"

if [[ "${CODE_SIGNING_ALLOWED:-YES}" == "YES" && -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]]; then
  # OTHER_CODE_SIGN_FLAGS is deliberately unquoted: it is a list of flags.
  # shellcheck disable=SC2086
  "$CODESIGN" --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" --options runtime \
    --entitlements "$REPO_ROOT/mac-app/helpers/conch-daemon.entitlements" --timestamp=none \
    ${OTHER_CODE_SIGN_FLAGS:-} "$DAEMON"
  echo "embedded and signed $DAEMON (conch $VERSION)"
else
  echo "embedded $DAEMON (conch $VERSION; code signing is off for this build)"
fi
