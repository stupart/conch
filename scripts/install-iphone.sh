#!/bin/bash
# Build conch-ios for Tyler's iPhone and install it.
#
# The device must be UNLOCKED and reachable — plugged in, or on the same network with
# wireless debugging. When it is asleep or locked, `devicectl` reports it `unavailable`,
# xcodebuild's destination list contains no physical iPhone at all, and `-destination id=…`
# fails with a confusing "My Mac's macOS platform doesn't match" error. That is the device
# being away, not a build problem, so this checks first and says so plainly.
set -euo pipefail

UDID="${CONCH_IPHONE_UDID:-00008120-001A301E2E78C01E}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DD="${CONCH_IPHONE_DD:-$ROOT/build/DD-iphone}"

state="$(xcrun devicectl list devices 2>/dev/null | awk -v u="$UDID" '$0 ~ u { print }')"
if [ -z "$state" ]; then
  echo "✗ no device with UDID $UDID is known to this Mac" >&2
  exit 1
fi
if printf '%s' "$state" | grep -qE "unavailable|disconnected|shutdown"; then
  echo "✗ the iPhone is not reachable right now:" >&2
  printf '   %s\n' "$state" >&2
  echo "   Unlock it (and keep it plugged in, or on the same Wi-Fi) and run this again." >&2
  exit 1
fi

echo "→ building for the device"
xcodebuild -project "$ROOT/mobile/conch-ios/conch-ios.xcodeproj" -scheme conch-ios \
  -configuration Debug -destination "id=$UDID" -derivedDataPath "$DD" \
  -allowProvisioningUpdates -quiet build
echo "→ installing (this REPLACES the app and relaunches it)"
xcrun devicectl device install app --device "$UDID" \
  "$DD/Build/Products/Debug-iphoneos/conch-ios.app"
echo "✓ installed — conch is current on the phone"
