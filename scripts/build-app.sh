#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_PATH="$REPO_ROOT/mac-app/conch-mac.xcodeproj"
# .noindex so Spotlight skips the build output. Without it every build
# leaves another launchable "conch" in Launchpad — Tyler hit this twice.
DERIVED_DATA_PATH="$REPO_ROOT/build/app.noindex"
BUILT_APP_PATH="$DERIVED_DATA_PATH/Build/Products/Release/conch-mac.app"
INSTALLED_APP_PATH="/Applications/conch.app"
TEAM_ID="5DRS8F56M2"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "error: xcodebuild was not found. Install Xcode before building the conch macOS app." >&2
  exit 1
fi

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "error: xcodebuild cannot use a full Xcode installation. Install Xcode and select it with xcode-select." >&2
  exit 1
fi

IDENTITIES="$(security find-identity -v -p codesigning 2>&1 || true)"
IDENTITY_MATCH="$(printf '%s\n' "$IDENTITIES" | grep -F "Developer ID Application:" | grep -F "($TEAM_ID)" || true)"
if [[ -z "$IDENTITY_MATCH" ]]; then
  cat >&2 <<EOF
error: A Developer ID Application signing identity for team $TEAM_ID was not found in the keychain.
Check the available code-signing identities with exactly this command:
  security find-identity -v -p codesigning
EOF
  exit 1
fi

cd "$REPO_ROOT"

echo "Building conch.app (Release) with derived data at $DERIVED_DATA_PATH"
xcodebuild \
  -project "$PROJECT_PATH" \
  -scheme conch-mac \
  -configuration Release \
  -destination 'platform=macOS' \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  build

if [[ ! -d "$BUILT_APP_PATH" ]]; then
  echo "error: xcodebuild succeeded but the app was not found at $BUILT_APP_PATH" >&2
  exit 1
fi

echo "Installing $INSTALLED_APP_PATH"
rm -rf "$INSTALLED_APP_PATH"
ditto "$BUILT_APP_PATH" "$INSTALLED_APP_PATH"

echo "Verifying installed signature:"
codesign --verify --strict --verbose=2 "$INSTALLED_APP_PATH"
codesign -dv --verbose=2 "$INSTALLED_APP_PATH"

echo "Installed $INSTALLED_APP_PATH"
