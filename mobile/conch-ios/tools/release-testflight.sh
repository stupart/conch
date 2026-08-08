#!/bin/bash
# Cut a TestFlight build of the conch iPhone app.
#
#   tools/release-testflight.sh            # archive + export only (no credentials needed)
#   tools/release-testflight.sh --upload   # …and upload to App Store Connect
#
# Why this exists: the build on Tyler's phone is a DEVELOPMENT install, and
# those expire on their own — 7 days on a free account, a year on a paid one —
# after which the app simply stops launching whether or not we ship anything.
# TestFlight replaces that with real installs that auto-update and last 90 days.
#
# Uploading needs an App Store Connect API key, which only Tyler can create
# (App Store Connect → Users and Access → Integrations → App Store Connect API,
# role "App Manager"). Export these once, e.g. in ~/.zshrc:
#
#   export ASC_KEY_ID=XXXXXXXXXX
#   export ASC_ISSUER_ID=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
#
# and put the downloaded AuthKey_<KEY_ID>.p8 in ~/.appstoreconnect/private_keys/
# (xcrun finds it there by convention; the file is downloadable exactly once).
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT=conch-ios.xcodeproj
SCHEME=conch-ios
ARCHIVE=${TMPDIR:-/tmp}/conch-ios.xcarchive
EXPORT_DIR=${TMPDIR:-/tmp}/conch-ios-export

# Every upload needs a build number higher than the last, or App Store Connect
# rejects it outright. Marketing version stays hand-managed; this is the one
# that must always move.
current=$(grep -m1 "CURRENT_PROJECT_VERSION = " "$PROJECT/project.pbxproj" | sed 's/[^0-9]//g')
next=$(( current + 1 ))
if [ "${1:-}" = "--upload" ]; then
  sed -i '' "s/CURRENT_PROJECT_VERSION = ${current};/CURRENT_PROJECT_VERSION = ${next};/g" "$PROJECT/project.pbxproj"
  echo "build number ${current} -> ${next}"
  build=$next
else
  build=$current
  echo "build number ${build} (not bumped; pass --upload to cut a real one)"
fi

rm -rf "$ARCHIVE" "$EXPORT_DIR"

echo "==> archiving"
xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates archive >/dev/null

cat > "${TMPDIR:-/tmp}/conch-ExportOptions.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>5DRS8F56M2</string>
  <key>uploadSymbols</key><true/>
  <key>signingStyle</key><string>automatic</string>
  <key>destination</key><string>export</string>
</dict>
</plist>
PLIST

echo "==> exporting"
xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist "${TMPDIR:-/tmp}/conch-ExportOptions.plist" \
  -exportPath "$EXPORT_DIR" -allowProvisioningUpdates >/dev/null

IPA=$(find "$EXPORT_DIR" -name '*.ipa' | head -1)
echo "==> $IPA"
codesign -dv --verbose=2 "$(dirname "$IPA")" 2>/dev/null || true

if [ "${1:-}" != "--upload" ]; then
  echo
  echo "Archive + export OK. Re-run with --upload to send it to TestFlight."
  exit 0
fi

: "${ASC_KEY_ID:?set ASC_KEY_ID (see the header of this script)}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID (see the header of this script)}"

# Validate before uploading: a rejected upload still burns the build number,
# and validation names the reason where a failed upload often does not.
echo "==> validating"
xcrun altool --validate-app -f "$IPA" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

echo "==> uploading"
xcrun altool --upload-app -f "$IPA" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

echo
echo "Uploaded build ${build}. It appears in App Store Connect → TestFlight"
echo "after processing (usually 5-15 min), then install via the TestFlight app."
