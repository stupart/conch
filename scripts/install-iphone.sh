#!/bin/bash
# Build conch-ios for a physical iPhone and install it.
#
#   CONCH_IPHONE_UDID=<device id> scripts/install-iphone.sh
#
# Which iPhone: CONCH_IPHONE_UDID when it is set. Otherwise the one physical iPhone
# `xcrun devicectl list devices` knows; with none, or more than one, this stops and says so.
#
# The device must be UNLOCKED and reachable — plugged in, or on the same network with
# wireless debugging. When it is asleep or locked, `devicectl` reports it `unavailable`,
# xcodebuild's destination list contains no physical iPhone at all, and `-destination id=…`
# fails with a confusing "My Mac's macOS platform doesn't match" error. That is the device
# being away, not a build problem, so this checks first and says so plainly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DD="${CONCH_IPHONE_DD:-$ROOT/build/DD-iphone}"

devices="$(xcrun devicectl list devices 2>/dev/null || true)"

if [ -n "${CONCH_IPHONE_UDID:-}" ]; then
  UDID="$CONCH_IPHONE_UDID"
else
  # The Identifier column of each physical iPhone's row.
  udids="$(printf '%s\n' "$devices" | awk '/iPhone/ && / physical *$/ { for (i = 1; i < NF; i++) if ($(i + 1) == "(UDID)") print $i }')"
  count="$(printf '%s' "$udids" | grep -c . || true)"
  if [ "$count" -eq 0 ]; then
    echo "✗ no physical iPhone is known to this Mac." >&2
    echo "   Pair one in Xcode (Window › Devices and Simulators), or set CONCH_IPHONE_UDID to its identifier." >&2
    exit 1
  fi
  if [ "$count" -gt 1 ]; then
    echo "✗ $count physical iPhones are known to this Mac; set CONCH_IPHONE_UDID to the one to install on." >&2
    echo "   \`xcrun devicectl list devices\` lists each one's identifier." >&2
    exit 1
  fi
  UDID="$udids"
fi

state="$(printf '%s\n' "$devices" | grep -F -- "$UDID" || true)"
if [ -z "$state" ]; then
  echo "✗ the iPhone in CONCH_IPHONE_UDID is not known to this Mac (see \`xcrun devicectl list devices\`)" >&2
  exit 1
fi
if printf '%s' "$state" | grep -qE "unavailable|disconnected|shutdown"; then
  echo "✗ the iPhone is not reachable right now:" >&2
  # Its row, without its identifier.
  printf '%s\n' "$state" | awk -v u="$UDID" '{ i = index($0, u); if (i) $0 = substr($0, 1, i - 1) "…" substr($0, i + length(u)); print "   " $0 }' >&2
  echo "   Unlock it (and keep it plugged in, or on the same Wi-Fi) and run this again." >&2
  exit 1
fi

echo "→ building for the device"
# conch's version and the commit count, as the Mac app's (scripts/build-app.sh), not the project's placeholder 1.0.
APP_VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
xcodebuild -project "$ROOT/mobile/conch-ios/conch-ios.xcodeproj" -scheme conch-ios \
  -configuration Debug -destination "id=$UDID" -derivedDataPath "$DD" \
  MARKETING_VERSION="${APP_VERSION:-1.0}" CURRENT_PROJECT_VERSION="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)" \
  -allowProvisioningUpdates -quiet build
echo "→ installing (this REPLACES the app and relaunches it)"
xcrun devicectl device install app --device "$UDID" \
  "$DD/Build/Products/Debug-iphoneos/conch-ios.app"
echo "✓ installed — conch is current on the phone"
