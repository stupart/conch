#!/bin/bash
# Generate both apps' icons from the one source image.
#
#   assets/conch-icon-1024.png  ->  the iOS asset catalog
#                               ->  mac-app/conch-mac/Assets.xcassets
#
# One source, regenerated rather than hand-maintained, so the phone and the Mac
# can never drift into showing different icons. Re-run after replacing the
# source PNG:  scripts/make-icons.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$REPO_ROOT/assets/conch-icon-1024.png"
[[ -f "$SOURCE" ]] || { echo "error: missing $SOURCE" >&2; exit 1; }

# The App Store rejects an icon with an alpha channel, and a source exported
# from most design tools has one whether or not anything is transparent.
if [[ "$(sips -g hasAlpha "$SOURCE" | awk '/hasAlpha/{print $2}')" == "yes" ]]; then
  echo "error: $SOURCE has an alpha channel; App Store review rejects that." >&2
  exit 1
fi

echo "==> iOS"
IOS_SET="$REPO_ROOT/mobile/conch-ios/conch-ios/Assets.xcassets/AppIcon.appiconset"
mkdir -p "$IOS_SET"
cp "$SOURCE" "$IOS_SET/icon-1024.png"

echo "==> macOS"
MAC_SET="$REPO_ROOT/mac-app/conch-mac/Assets.xcassets/AppIcon.appiconset"
mkdir -p "$MAC_SET"
# macOS wants the whole ladder; Finder, the Dock and Get Info each pick a
# different rung, and a missing one silently falls back to a blurry upscale.
for spec in "16 16x16 1x" "32 16x16 2x" "32 32x32 1x" "64 32x32 2x" \
            "128 128x128 1x" "256 128x128 2x" "256 256x256 1x" "512 256x256 2x" \
            "512 512x512 1x" "1024 512x512 2x"; do
  set -- $spec
  px="$1"; size="$2"; scale="$3"
  sips -Z "$px" "$SOURCE" --out "$MAC_SET/icon_${size}_${scale}.png" >/dev/null
done

python3 - "$MAC_SET" <<'PY'
import json, sys, pathlib
out = pathlib.Path(sys.argv[1])
images = []
for px, size, scale in [
    (16, "16x16", "1x"), (32, "16x16", "2x"), (32, "32x32", "1x"), (64, "32x32", "2x"),
    (128, "128x128", "1x"), (256, "128x128", "2x"), (256, "256x256", "1x"),
    (512, "256x256", "2x"), (512, "512x512", "1x"), (1024, "512x512", "2x"),
]:
    images.append({
        "filename": f"icon_{size}_{scale}.png",
        "idiom": "mac", "scale": scale, "size": size,
    })
(out / "Contents.json").write_text(
    json.dumps({"images": images, "info": {"author": "xcode", "version": 1}}, indent=2) + "\n")
(out.parent / "Contents.json").write_text(
    json.dumps({"info": {"author": "xcode", "version": 1}}, indent=2) + "\n")
print("wrote", out / "Contents.json")
PY

echo "done — rebuild both apps to pick the icons up"
