#!/bin/bash
# The lagoon's page for conch.app (LagoonPane.swift; the brand repo's experiments/bridge/MAC-APP-SPEC.md §2): print the
# folder to embed on stdout, or nothing. scripts/build-app.sh calls this before xcodebuild and hands the folder to the
# "Embed lagoon" build phase (scripts/embed-lagoon.sh), which copies it into Contents/Resources/Lagoon before Xcode seals
# the bundle.
#
# The page is built in the brand repo (~/Projects/conch-design/brand) and never committed here: some 23-33 MB of sprites,
# textures and a vendored three.js. A `dist/lagoon` there that is newer than its builder and everything it is built from
# (its BUNDLE.txt is written last) is used as it is; otherwise the builder writes a fresh copy into the scratch folder given
# here, never into the brand repo's own dist.
#
#   scripts/prepare-lagoon.sh <scratch folder>
#
# No brand repo, no node, or a build that failed: a one-line note on stderr, nothing on stdout, exit 0, and conch.app is
# built without the lagoon (Debug › Show Lagoon then says it isn't in this build). The lagoon is a hidden, read-only page
# while it is tried out; it never holds the app's build hostage.
#
# Environment: CONCH_LAGOON_BRIDGE (the bridge folder; default ~/Projects/conch-design/brand/experiments/bridge),
# NODE (default node). Both are test seams too (test/lagoon-page.test.ts).
set -euo pipefail

SCRATCH="${1:?usage: prepare-lagoon.sh <scratch folder>}"
BRIDGE="${CONCH_LAGOON_BRIDGE:-$HOME/Projects/conch-design/brand/experiments/bridge}"
BUILDER="$BRIDGE/build-bundle.mjs"
SOURCE="$BRIDGE/../lagoon3d-v4"
DIST="$BRIDGE/dist/lagoon"
NODE="${NODE:-node}"

if [[ ! -f "$BUILDER" ]]; then
  echo "note: no lagoon ($BUILDER isn't on this Mac); conch.app is built without it" >&2
  exit 0
fi

# Up to date: a whole dist (its page and its stamp) whose BUNDLE.txt is newer than the builder and than every file under
# what the page is built from. A stamp older than any of them is a build of something that has since changed.
fresh() {
  [[ -f "$DIST/BUNDLE.txt" && -f "$DIST/index.html" ]] || return 1
  local paths=("$BUILDER") part
  for part in index.html css js sprites assets assets-v4/props assets-v4/claws; do
    [[ -e "$SOURCE/$part" ]] && paths+=("$SOURCE/$part")
  done
  [[ -z "$(find "${paths[@]}" -newer "$DIST/BUNDLE.txt" -print -quit 2>/dev/null)" ]]
}

if fresh; then
  echo "lagoon: using $DIST, up to date ($(head -1 "$DIST/BUNDLE.txt"))" >&2
  printf '%s\n' "$DIST"
  exit 0
fi

if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "note: the lagoon needs node to build ($NODE isn't on PATH); conch.app is built without it" >&2
  exit 0
fi

OUT="$SCRATCH/lagoon"
echo "lagoon: building it into $OUT" >&2
# The builder's own report (its size, by part) goes to stderr with the rest: stdout is the folder alone.
if ! "$NODE" "$BUILDER" --out "$OUT" >&2; then
  echo "warning: the lagoon didn't build ($BUILDER failed); conch.app is built without it" >&2
  exit 0
fi
if [[ ! -f "$OUT/index.html" || ! -f "$OUT/BUNDLE.txt" ]]; then
  echo "warning: the lagoon's build left no index.html and BUNDLE.txt in $OUT; conch.app is built without it" >&2
  exit 0
fi
printf '%s\n' "$OUT"
