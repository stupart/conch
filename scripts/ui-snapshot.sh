#!/usr/bin/env bash
# Photograph conch's own UI without the screen, the user's focus, or the live
# daemon ever being involved.
#
#   ui-snapshot.sh mac <out.png>                The running Mac app draws its own
#                                               window (`conch shot`; /tmp/*.png only).
#   ui-snapshot.sh ios <out-dir> [session-id]   A headless simulator renders a fixture:
#                                               ledger.png, then session.png (its end) and
#                                               session-top.png (its start) for the id,
#                                               and review.png when that row has a review.
#
# ios builds a Debug simulator app into build/ios-sim.noindex, boots a SHUT-DOWN
# iPhone 17-class simulator with `simctl boot` (never the Simulator app), renders
# mobile/conch-ios/fixtures/showcase.json (or $CONCH_FIXTURE) through the app's
# DEBUG-only -conchFixture mode, and shuts that simulator down on exit. It never
# picks a simulator someone else booted, so it never shuts one down either.
# The showcase's long markdown reply is session `claude-readability`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-}"
out="${2:-}"

case "$mode" in
mac)
  [[ -n "$out" ]] || { echo "usage: ui-snapshot.sh mac /tmp/<name>.png" >&2; exit 2; }
  # The hook already lives in the app (DebugSnapshot.swift): `conch shot` writes
  # the request, waits for the PNG, and exits 1 with the app's own reason
  # (<out>.error) when it does not come. The app never activates to do it.
  exec bun "$root/src/cli.ts" shot "$out"
  ;;
ios)
  [[ -n "$out" ]] || { echo "usage: ui-snapshot.sh ios <out-dir> [session-id]" >&2; exit 2; }
  session="${3:-}"
  fixture="${CONCH_FIXTURE:-$root/mobile/conch-ios/fixtures/showcase.json}"
  bundle=ai.blueprintstudio.conch.ios
  derived="$root/build/ios-sim.noindex"
  mkdir -p "$out"
  out="$(cd "$out" && pwd)"

  udid="$(xcrun simctl list devices available | grep -E '^ +iPhone 17' | grep '(Shutdown)' \
    | head -1 | grep -oE '[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}' || true)"
  [[ -n "$udid" ]] || { echo "no shut-down iPhone 17-class simulator available" >&2; exit 1; }

  xcodebuild -project "$root/mobile/conch-ios/conch-ios.xcodeproj" -scheme conch-ios \
    -configuration Debug -destination "generic/platform=iOS Simulator" \
    -derivedDataPath "$derived" CODE_SIGNING_ALLOWED=NO -quiet build
  app="$derived/Build/Products/Debug-iphonesimulator/conch-ios.app"

  # Ages are relative to now, and relative review links to the repo, so the
  # checked-in fixture reads "2m" rather than "400d" and finds its documents.
  prepared="$(mktemp -d)/fixture.json"
  jq --argjson now "$(date +%s)000" --arg root "$root" '
    .ts as $then
    | walk(if type == "object" and (.at | type) == "number" then .at += ($now - $then) else . end)
    | .ts = $now
    | (.rows[].review.link | strings) |= (if test("^(/|https?:)") then . else "\($root)/\(.)" end)
  ' "$fixture" > "$prepared"

  # Armed before the boot, so a boot that fails halfway is still shut down.
  trap 'xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true' EXIT
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" >/dev/null
  # A fixed clock, so two runs differ only where the UI did.
  xcrun simctl status_bar "$udid" override --time 9:41 >/dev/null 2>&1 || true
  xcrun simctl install "$udid" "$app"

  shoot() { # <name.png> [extra launch args...]
    local png="$out/$1"
    shift
    xcrun simctl launch --terminate-running-process "$udid" "$bundle" \
      -conchFixture "$prepared" "$@" >/dev/null
    sleep "${CONCH_SNAPSHOT_SETTLE:-3}"
    xcrun simctl io "$udid" screenshot "$png" >/dev/null 2>&1
    echo "$png"
  }

  echo "simulator $udid"
  shoot ledger.png
  if [[ -n "$session" ]]; then
    shoot session.png -conchFixtureSession "$session"
    # A session opens at its end; this is the start of the same conversation.
    shoot session-top.png -conchFixtureSession "$session" -conchFixtureTop YES
    if jq -e --arg id "$session" '.rows[] | select(.id == $id) | .review' "$prepared" >/dev/null; then
      shoot review.png -conchFixtureSession "$session" -conchFixtureReview YES
    fi
  fi
  ;;
*)
  echo "usage: ui-snapshot.sh mac <out.png> | ios <out-dir> [session-id]" >&2
  exit 2
  ;;
esac
