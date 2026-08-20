#!/bin/sh
# Screenshot every deliverable type through the REAL review pane.
#
# Launches its own instance of the installed app against a synthetic state file
# (never the user's), cycles a review through each fixture in
# test/fixtures/deliverables/ plus one live web URL, and captures the app's own
# window buffer per type into /tmp/deliverable-shots/.
#
# This exists because "all deliverable types render fully" is a claim that rots:
# any renderer change can silently break one type, and only a per-type visual
# check catches it. Run it after touching ReviewView; eyeball every shot.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$REPO/test/fixtures/deliverables"
OUT=/tmp/deliverable-shots
STATE=/tmp/conch-harness-state.json
APP=/Applications/conch.app

mkdir -p "$OUT"
rm -f "$OUT"/*.png

# The tall fixture is generated, not committed — 2.6MB of trivially
# reproducible pixels doesn't belong in git history.
[ -f "$FIXTURES/tall.png" ] || swift "$FIXTURES/generate-tall-image.swift" "$FIXTURES/tall.png"

write_state() { # $1 = summary, $2 = link
  python3 - "$1" "$2" <<'PY'
import json, sys, time
summary, link = sys.argv[1], sys.argv[2]
now = time.time() * 1000
json.dump({
    "v": 1, "ts": now,
    "mode": {"muted": False, "paused": False, "holding": 0},
    "live": {"state": "idle", "label": ""},
    "rows": [{
        "id": "harness-row", "label": "harness", "status": "waiting",
        "at": now, "needsResponse": False, "paused": False, "muted": False,
        "live": None, "active": False,
        "review": {"summary": summary, "link": link, "at": now},
    }],
    "dismissed": [], "dismissedRows": [],
}, open("/tmp/conch-harness-state.json.tmp", "w"))
# Atomic replace: the app polls this file, and a torn mid-write read looks like
# an empty ledger, which silently drops the row selection.
import os
os.replace("/tmp/conch-harness-state.json.tmp", "/tmp/conch-harness-state.json")
PY
}

write_state "harness warming up" "$FIXTURES/sample.md"
CONCH_STATE_FILE="$STATE" CONCH_SOCKET=/tmp/conch-harness-nosock \
  open -n "$APP" --env CONCH_STATE_FILE="$STATE" --env CONCH_SOCKET=/tmp/conch-harness-nosock
sleep 4

# The user's own conch may be running; ours is the newest pid carrying our env.
HARNESS_PID=$(pgrep -f "conch.app/Contents/MacOS/conch-mac" | while read -r p; do
  if ps -E -p "$p" 2>/dev/null | grep -q "conch-harness-state"; then echo "$p"; fi
done | head -1)
[ -z "$HARNESS_PID" ] && { echo "harness instance not found"; exit 1; }

WINDOW_ID=$(swift - "$HARNESS_PID" <<'EOF'
import CoreGraphics
let pid = Int(CommandLine.arguments[1])!
let info = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in info where (w["kCGWindowOwnerPID"] as? Int) == pid
    && ((w["kCGWindowBounds"] as? [String: Any])?["Height"] as? Double ?? 0) > 300 {
    print(w["kCGWindowNumber"] as! Int)
    break
}
EOF
)
[ -z "$WINDOW_ID" ] && { echo "no harness window found for pid $HARNESS_PID"; kill "$HARNESS_PID" 2>/dev/null; exit 1; }
echo "harness pid $HARNESS_PID window $WINDOW_ID"

shot() { # $1 = name, $2 = link
  write_state "deliverable check — $1" "$2"
  sleep 5  # app polls the state file; give it a beat plus render time.
           # Was 3, which caught a local page mid-load and reported "loading…"
           # as if the renderer were broken. A harness that lies about a
           # failure is worse than no harness.
  screencapture -o -x -l"$WINDOW_ID" "$OUT/$1.png"
  echo "  $1 -> $OUT/$1.png"
}

echo "capturing:"
shot markdown "$FIXTURES/sample.md"
shot text "$FIXTURES/sample.txt"
shot json "$FIXTURES/sample.json"
shot pdf "$FIXTURES/sample.pdf"
shot tall-image "$FIXTURES/tall.png"
# Added when both routers were found to have drifted: video played on neither
# by design, and a local page rendered on the Mac but not the phone.
shot local-page "$FIXTURES/page.html"
[ -f "$FIXTURES/sample.mp4" ] && shot video "$FIXTURES/sample.mp4"
[ -f "$FIXTURES/archive.zip" ] && shot unsupported "$FIXTURES/archive.zip"
shot web "https://github.com/stupart/conch"
shot missing-file "$FIXTURES/does-not-exist.png"

# The harness instance served its purpose; the user's own app is untouched.
osascript -e 'tell application "System Events" to set procs to every process whose name is "conch-mac"' >/dev/null 2>&1 || true
[ -n "$HARNESS_PID" ] && kill "$HARNESS_PID" 2>/dev/null || true
rm -f "$STATE"

echo "done — review every image in $OUT"
