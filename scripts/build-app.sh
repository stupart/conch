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

# The lagoon's page (LagoonPane.swift), from the brand repo when it's on this Mac: built into a scratch folder of ours, or
# its dist/lagoon reused when that is up to date (scripts/prepare-lagoon.sh). The "Embed lagoon" build phase copies it into
# Contents/Resources/Lagoon before Xcode seals the bundle; it is never committed here. Without the brand repo, a line says
# so and the app is built without it.
LAGOON_SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/conch-lagoon-build.XXXXXX")"
trap 'rm -rf "$LAGOON_SCRATCH"' EXIT
LAGOON_BUNDLE="$("$SCRIPT_DIR/prepare-lagoon.sh" "$LAGOON_SCRATCH")"

echo "Building conch.app (Release) with derived data at $DERIVED_DATA_PATH"
# The embed phases (uv, daemon, speech engine, tmux) write into the bundle
# without declared outputs, so Xcode can't see that they changed it. A build
# that changes no app code finds its CodeSign step up to date and keeps the old
# seal over the new files: #466 installed a conch.app whose seal didn't name
# Helpers/tmux, and it failed verification with conch already quit. Without
# the product, the bundle is made again and signed every time.
rm -rf "$BUILT_APP_PATH"
# CONCH_DAEMON_SOURCE=checkout: this is the dev install, so the app runs the
# daemon from the checkout first (DaemonHost.prefersCheckout) — the bundled one
# would be stale the moment anyone edits the source. It still carries the
# bundled daemon and engine, checked below exactly as a release checks them.
# The version the app shows (About, Finder's Get Info) is conch's, from package.json, and the build number is the
# commit count, rising with every commit. The project's MARKETING_VERSION is a placeholder 1.0, which every build
# shipped as until 2026-10-09 (conch 0.4.0 called itself "1.0").
APP_VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -1)"
APP_BUILD="$(git -C "$REPO_ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"
xcodebuild \
  -project "$PROJECT_PATH" \
  -scheme conch-mac \
  -configuration Release \
  -destination 'platform=macOS' \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  MARKETING_VERSION="${APP_VERSION:-1.0}" \
  CURRENT_PROJECT_VERSION="$APP_BUILD" \
  CONCH_LAGOON_BUNDLE="$LAGOON_BUNDLE" \
  CONCH_DAEMON_SOURCE=checkout \
  build

if [[ ! -d "$BUILT_APP_PATH" ]]; then
  echo "error: xcodebuild succeeded but the app was not found at $BUILT_APP_PATH" >&2
  exit 1
fi

# The lagoon was asked for and isn't in the app: the build phase didn't run, and the seal is over something else.
if [[ -n "$LAGOON_BUNDLE" && ! -f "$BUILT_APP_PATH/Contents/Resources/Lagoon/index.html" ]]; then
  echo "error: the lagoon ($LAGOON_BUNDLE) didn't reach $BUILT_APP_PATH/Contents/Resources/Lagoon" >&2
  exit 1
fi

# Checked BEFORE the installed app is touched: a build that doesn't verify
# leaves the working conch.app in place and running, rather than a broken one
# that won't launch.
echo "Verifying the built signature:"
if ! codesign --verify --deep --strict --verbose=2 "$BUILT_APP_PATH"; then
  echo "error: the built conch.app doesn't verify; the installed one was left as it was" >&2
  exit 1
fi

echo "Installing $INSTALLED_APP_PATH"
# Replacing the bundle pulls the ground out from under a RUNNING copy: the
# process survives on its open inode but its resources are gone, and it starts
# reporting nonsense — Tyler saw "daemon not responding" from an app whose
# daemon was perfectly healthy. If it was running, put it back afterwards.
#
# Resolved to PIDs and killed one by one, never `pkill -f`: a pattern kill
# reaches whatever else happens to match it, and has already cost this project
# another session's work.
WAS_RUNNING=""
RUNNING_PIDS="$(pgrep -f "$INSTALLED_APP_PATH/Contents/MacOS/" || true)"
if [[ -n "$RUNNING_PIDS" ]]; then
  WAS_RUNNING=1
  echo "conch.app is running (pids: $RUNNING_PIDS) — it will be relaunched on the new build"
  for pid in $RUNNING_PIDS; do kill "$pid" 2>/dev/null || true; done
  sleep 1
fi
# Swapped in by rename, not deleted and then copied. `rm -rf` then `ditto` left /Applications/conch.app missing
# or half-written for seconds, and the Dock, which watches its pinned apps, cached the "can't open" circle-slash
# for conch and kept it (Tyler, 2026-10-04: "the icon has no image"; seen again 2026-10-08 after a day of
# installs). The new build is copied beside the old one first, on the same volume, so the swap is two renames
# microseconds apart.
STAGED_APP_PATH="$(dirname "$INSTALLED_APP_PATH")/.conch-installing.app"
RETIRED_APP_PATH="$(dirname "$INSTALLED_APP_PATH")/.conch-retired.app"
rm -rf "$STAGED_APP_PATH" "$RETIRED_APP_PATH"
ditto "$BUILT_APP_PATH" "$STAGED_APP_PATH"
if [[ -e "$INSTALLED_APP_PATH" ]]; then mv "$INSTALLED_APP_PATH" "$RETIRED_APP_PATH"; fi
mv "$STAGED_APP_PATH" "$INSTALLED_APP_PATH"
rm -rf "$RETIRED_APP_PATH"
# Only the installed copy is conch to Launch Services: the build product Xcode registered, and the two names
# above, would each be another "conch" in Spotlight, Launchpad and Open With (301 of them had piled up by
# 2026-10-08). Re-registering the installed copy refreshes its icon for the Dock and Finder.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREGISTER" -u "$BUILT_APP_PATH" >/dev/null 2>&1 || true
"$LSREGISTER" -u "$STAGED_APP_PATH" >/dev/null 2>&1 || true
"$LSREGISTER" -u "$RETIRED_APP_PATH" >/dev/null 2>&1 || true
"$LSREGISTER" -f "$INSTALLED_APP_PATH" >/dev/null 2>&1 || true

echo "Verifying installed signature:"
codesign --verify --strict --verbose=2 "$INSTALLED_APP_PATH"
codesign -dv --verbose=2 "$INSTALLED_APP_PATH"

# The natural voices set themselves up with the uv the app carries
# (scripts/embed-uv.sh, src/voice-env.ts). A Release app without it, or with
# it unsigned, would leave every new user on the macOS `say` voice.
UV_HELPER="$INSTALLED_APP_PATH/Contents/Helpers/uv"
if [[ ! -x "$UV_HELPER" ]]; then
  echo "error: $UV_HELPER is missing — the Embed uv helper build phase did not run" >&2
  exit 1
fi
echo "Verifying the embedded uv:"
codesign --verify --strict --verbose=2 "$UV_HELPER"
codesign -dv --verbose=2 "$UV_HELPER" 2>&1 | grep -E '^(Authority=Developer ID Application|TeamIdentifier|CodeDirectory)'
"$UV_HELPER" --version

# The daemon and seashell's speech engine the app carries (scripts/embed-daemon.sh,
# scripts/embed-engine.sh): present, signed, entitled, the app's architectures,
# the source's version.
echo "Verifying the bundled daemon and speech engine:"
"$SCRIPT_DIR/check-app-bundle.sh" "$INSTALLED_APP_PATH" checkout

if [[ -n "$WAS_RUNNING" ]]; then
  echo "Relaunching conch.app"
  # -g: in the background, so a deploy never takes focus from whatever you're typing in.
  # A clean environment: run from inside an agent session, `open` hands the app that session's (its account
  # folder, its tmux), and the daemon the app starts would inherit them (2026-10-02). The app cleans its daemon's
  # environment too (DaemonEnvironment); this keeps the app itself out of it.
  env -i HOME="$HOME" USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-${USER:-$(id -un)}}" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    open -g -a "$INSTALLED_APP_PATH"
fi

if [[ -d "$INSTALLED_APP_PATH/Contents/Resources/Lagoon" ]]; then
  echo "The lagoon is in the app: $(du -sh "$INSTALLED_APP_PATH/Contents/Resources/Lagoon" | cut -f1) (Debug › Show Lagoon)"
fi

echo "Installed $INSTALLED_APP_PATH"
