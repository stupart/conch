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
# required.
#
# One app per architecture, each carrying that architecture's daemon and speech
# engine (scripts/embed-daemon.sh, scripts/embed-engine.sh). A universal app
# would carry both — a 64 MB and a 71 MB daemon plus two engines — about twice
# the size, for a slice every Mac ignores. The app's daemon IS the CLI built just
# before it (CONCH_DAEMON_BINARY), so the two halves of a release are one build.
command -v xcodebuild >/dev/null 2>&1 || echo "⚠️  no xcodebuild — shipping the CLI only" >&2

for pair in "arm64:bun-darwin-arm64:arm64" "x64:bun-darwin-x64:x86_64"; do
  arch="${pair%%:*}"; rest="${pair#*:}"; target="${rest%%:*}"; xcode_arch="${rest##*:}"
  echo "→ building conch $VERSION for $arch ($target)"
  bun build --compile --target="$target" ./src/cli.ts --outfile "$DIST/conch"
  APP_SRC=""
  if command -v xcodebuild >/dev/null 2>&1; then
    echo "→ building conch.app for $arch"
    derived="build/release-app-$arch.noindex"
    rm -rf "$derived"
    if xcodebuild -project mac-app/conch-mac.xcodeproj -scheme conch-mac \
         -configuration Release -derivedDataPath "$derived" \
         ARCHS="$xcode_arch" ONLY_ACTIVE_ARCH=NO \
         CONCH_DAEMON_BINARY="$PWD/$DIST/conch" CONCH_DAEMON_SOURCE=bundled \
         build >"$derived.log" 2>&1; then
      APP_SRC="$derived/Build/Products/Release/conch-mac.app"
      codesign --verify --strict "$APP_SRC" || { echo "app signature invalid" >&2; exit 1; }
      # The uv the natural voices set themselves up with (scripts/embed-uv.sh).
      [ -x "$APP_SRC/Contents/Helpers/uv" ] || { echo "app has no Contents/Helpers/uv" >&2; exit 1; }
      codesign --verify --strict "$APP_SRC/Contents/Helpers/uv" || { echo "embedded uv signature invalid" >&2; exit 1; }
      # Its daemon and speech engine, signed and entitled, for this architecture.
      scripts/check-app-bundle.sh "$APP_SRC" bundled || exit 1
      # The daemon is the CLI in this tarball, the same build: its digest before signing.
      cli_sha="$(shasum -a 256 "$DIST/conch" | cut -d' ' -f1)"
      app_sha="$(cut -d' ' -f1 "$APP_SRC/Contents/Resources/conch-daemon.sha256")"
      [ "$cli_sha" = "$app_sha" ] || { echo "the app's daemon ($app_sha) is not this CLI ($cli_sha)" >&2; exit 1; }
    else
      echo "⚠️  app build for $arch failed (see $derived.log) — shipping the CLI only" >&2
    fi
  fi
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
