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

# Ship the macOS app inside the FORMULA tarball rather than as a separate cask.
# Homebrew quarantines cask artifacts (verified: a cask-installed .app carries
# com.apple.quarantine, a formula-installed one does not), and a quarantined app
# that is signed but not notarized is refused by Gatekeeper. Shipping it in the
# formula means one `brew install` delivers both halves, with no notarization
# required. Universal so a single tarball serves both architectures.
APP_SRC=""
if command -v xcodebuild >/dev/null 2>&1; then
  echo "→ building conch.app (universal)"
  rm -rf build/release-app
  if xcodebuild -project mac-app/conch-mac.xcodeproj -scheme conch-mac \
       -configuration Release -derivedDataPath build/release-app \
       ARCHS="x86_64 arm64" ONLY_ACTIVE_ARCH=NO build >/dev/null 2>&1; then
    APP_SRC="build/release-app/Build/Products/Release/conch-mac.app"
    codesign --verify --strict "$APP_SRC" || { echo "app signature invalid" >&2; exit 1; }
  else
    echo "⚠️  app build failed — shipping the CLI only" >&2
  fi
else
  echo "⚠️  no xcodebuild — shipping the CLI only" >&2
fi

for pair in "arm64:bun-darwin-arm64" "x64:bun-darwin-x64"; do
  arch="${pair%%:*}"; target="${pair##*:}"
  echo "→ building conch $VERSION for $arch ($target)"
  bun build --compile --target="$target" ./src/cli.ts --outfile "$DIST/conch"
  if [ -n "$APP_SRC" ]; then
    # ditto, not cp: it preserves the bundle's code signature.
    /usr/bin/ditto "$APP_SRC" "$DIST/conch.app"
    tar -C "$DIST" -czf "$DIST/conch-macos-$arch.tar.gz" conch conch.app
    rm -rf "$DIST/conch.app"
  else
    tar -C "$DIST" -czf "$DIST/conch-macos-$arch.tar.gz" conch
  fi
  rm "$DIST/conch"
done

echo "\nartifacts (v$VERSION):"
cd "$DIST"
shasum -a 256 conch-macos-*.tar.gz | tee SHA256SUMS
