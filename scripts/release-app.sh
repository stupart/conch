#!/bin/zsh
# Build, sign, notarize and package conch.app for a Homebrew cask.
#
#   scripts/release-app.sh [version] [arm64|x86_64]
#
# One architecture per zip (arm64 unless asked): the app carries that
# architecture's daemon and speech engine (scripts/embed-daemon.sh,
# scripts/embed-engine.sh), and a universal app would carry both — about twice
# the download for a slice every Mac ignores. The x86_64 zip is named -x64.
#
# A cask download carries com.apple.quarantine, so Gatekeeper DOES assess it —
# unlike a local build, which is never assessed. That makes notarization
# mandatory here and only here.
#
# One-time setup (needs an app-specific password from appleid.apple.com):
#   xcrun notarytool store-credentials conch \
#     --apple-id "<your apple id>" --team-id 5DRS8F56M2 --password "<app-specific password>"
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-$(bun --print 'require("./package.json").version')}"
ARCH="${2:-arm64}"
case "$ARCH" in
  arm64) ZIP_SUFFIX="" ;;
  x86_64) ZIP_SUFFIX="-x64" ;;
  *) echo "architecture must be arm64 or x86_64, got '$ARCH'" >&2; exit 1 ;;
esac
DIST=dist
# .noindex so Spotlight skips the build output. Without it every build
# leaves another launchable "conch" in Launchpad — Tyler hit this twice.
DERIVED=build/app-release-$ARCH.noindex
APP="$DERIVED/Build/Products/Release/conch-mac.app"
ZIP="$DIST/conch-mac-$VERSION$ZIP_SUFFIX.zip"

command -v xcodebuild >/dev/null || { echo "xcodebuild not found — install Xcode." >&2; exit 1; }
security find-identity -v -p codesigning | grep -q "Developer ID Application" || {
  echo "No Developer ID Application identity in the keychain." >&2
  echo "Check with: security find-identity -v -p codesigning" >&2
  exit 1
}

echo "→ building Release ($ARCH)"
rm -rf "$DERIVED"
xcodebuild -project mac-app/conch-mac.xcodeproj -scheme conch-mac \
  -configuration Release -derivedDataPath "$DERIVED" \
  ARCHS="$ARCH" ONLY_ACTIVE_ARCH=NO CONCH_DAEMON_SOURCE=bundled build >/dev/null

echo "→ verifying the signature"
codesign --verify --strict --verbose=2 "$APP"
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E 'Authority=Developer ID|TeamIdentifier'
# The uv the natural voices set themselves up with (scripts/embed-uv.sh).
[[ -x "$APP/Contents/Helpers/uv" ]] || { echo "app has no Contents/Helpers/uv" >&2; exit 1; }
codesign --verify --strict --verbose=2 "$APP/Contents/Helpers/uv"
# The daemon and speech engine a downloaded conch runs with nothing else installed.
scripts/check-app-bundle.sh "$APP" bundled

mkdir -p "$DIST"
rm -f "$ZIP"
echo "→ packaging $ZIP"
# ditto preserves the bundle's signature; zip(1) does not.
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"

if xcrun notarytool history --keychain-profile conch >/dev/null 2>&1; then
  echo "→ notarizing (this takes a few minutes)"
  xcrun notarytool submit "$ZIP" --keychain-profile conch --wait
  echo "→ stapling"
  # Staple the app, then REPACKAGE: the ticket attaches to the bundle, not the zip.
  xcrun stapler staple "$APP"
  rm -f "$ZIP"
  /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
  xcrun stapler validate "$APP"
  echo "✅ notarized + stapled"
else
  echo "⚠️  No 'conch' notarytool profile — SKIPPING notarization." >&2
  echo "   The zip is signed but NOT notarized. Do not publish it as a cask:" >&2
  echo "   a cask download is quarantined, so Gatekeeper will refuse to open it." >&2
  echo "   Set up once with the store-credentials command at the top of this script." >&2
fi

echo
shasum -a 256 "$ZIP"
