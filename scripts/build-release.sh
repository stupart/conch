#!/bin/zsh
# Build standalone conch binaries for a Homebrew release.
#
#   scripts/build-release.sh [version]
#
# Produces dist/conch-macos-{arm64,x64}.tar.gz (each a self-contained binary with
# the Bun runtime baked in — no bun/node needed at runtime) plus dist/SHA256SUMS
# for the formula. `bun build --compile` cross-compiles both Mac targets from any
# host.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-$(bun --print 'require("./package.json").version')}"
DIST=dist
rm -rf "$DIST"; mkdir -p "$DIST"

for pair in "arm64:bun-darwin-arm64" "x64:bun-darwin-x64"; do
  arch="${pair%%:*}"; target="${pair##*:}"
  echo "→ building conch $VERSION for $arch ($target)"
  bun build --compile --target="$target" ./src/cli.ts --outfile "$DIST/conch"
  tar -C "$DIST" -czf "$DIST/conch-macos-$arch.tar.gz" conch
  rm "$DIST/conch"
done

echo "\nartifacts (v$VERSION):"
cd "$DIST"
shasum -a 256 conch-macos-*.tar.gz | tee SHA256SUMS
