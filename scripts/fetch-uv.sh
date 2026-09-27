#!/bin/bash
# Fetch the pinned uv that conch.app carries, verify it, cache it, print its path.
#
#   scripts/fetch-uv.sh        -> /…/build/vendor/uv-<version>/uv
#
# conch's natural voices run in a Python environment conch builds for itself
# (src/voice-env.ts), and it builds it with this uv, embedded in the app at
# Contents/Helpers/uv by scripts/embed-uv.sh. Nobody has to install uv.
#
# arm64 only, on purpose: MLX, and so Kokoro, runs only on Apple silicon, so an
# Intel Mac has nothing for uv to build. The daemon says so instead of trying.
#
# Pinned by version AND by the sha256 of the release tarball: a changed or
# substituted download fails here, before anything is copied into a signed app.
# To move the pin, change both lines from the release's own .sha256 asset:
#   https://github.com/astral-sh/uv/releases/download/<version>/uv-aarch64-apple-darwin.tar.gz.sha256
set -euo pipefail

UV_VERSION=0.12.19
UV_SHA256=a9a8df1eedeb192f2e47e40e2faabfb387db4b850209118786d42f89dde3e0ba
UV_TRIPLE=aarch64-apple-darwin

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${CONCH_UV_CACHE:-$REPO_ROOT/build/vendor/uv-$UV_VERSION}"
BIN="$CACHE/uv"

# A cached copy is reused only while it is still the exact bytes this pin
# extracted: the digest recorded at extraction time must match.
if [[ -x "$BIN" && -f "$BIN.sha256" ]] && shasum -a 256 -c "$BIN.sha256" >/dev/null 2>&1; then
  echo "$BIN"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
url="https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$UV_TRIPLE.tar.gz"
echo "fetching uv $UV_VERSION ($UV_TRIPLE)" >&2
curl -fsSL --retry 3 --max-time 300 -o "$work/uv.tar.gz" "$url"
echo "$UV_SHA256  $work/uv.tar.gz" | shasum -a 256 -c - >&2
tar -xzf "$work/uv.tar.gz" -C "$work"
"$work/uv-$UV_TRIPLE/uv" --version | grep -q "^uv $UV_VERSION " || {
  echo "error: the uv in $url does not report version $UV_VERSION" >&2
  exit 1
}

mkdir -p "$CACHE"
install -m 0755 "$work/uv-$UV_TRIPLE/uv" "$BIN.partial"
mv -f "$BIN.partial" "$BIN"
shasum -a 256 "$BIN" > "$BIN.sha256"
echo "$BIN"
