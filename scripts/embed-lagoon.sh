#!/bin/bash
# Xcode build phase ("Embed lagoon", conch-mac target): copy the lagoon's page into conch.app at Contents/Resources/Lagoon,
# where the app finds it (`Bundle.main.url(forResource: "Lagoon", withExtension: nil)`, LagoonPane.swift).
#
# The folder comes from CONCH_LAGOON_BUNDLE, a build setting scripts/build-app.sh passes once scripts/prepare-lagoon.sh has
# built or found it in the brand repo. Without it (any other build: Xcode's own, the CI gate's, a release) the app has no
# lagoon, which this says in one line, and Debug › Show Lagoon says it isn't in this build. A Lagoon left in the product
# by an earlier build is removed either way, so what is sealed is only ever what was asked for.
#
# Signing: these are plain files, served by the app and never run, so nothing here signs (unlike the helpers, which
# scripts/embed-tmux.sh and the others sign before the seal). This phase runs before Xcode's CodeSign, which seals them
# into the app's CodeResources like any resource; build-app.sh's `codesign --verify --deep --strict` then checks every
# byte. They are copied without extended attributes, resource forks or quarantine (a resource fork or Finder info on a
# resource fails the seal), and a symlink in the folder is refused: a link out of the bundle fails `--strict` too.
#
# Environment (all set by Xcode but the first): CONCH_LAGOON_BUNDLE, TARGET_BUILD_DIR, CONTENTS_FOLDER_PATH,
# UNLOCALIZED_RESOURCES_FOLDER_PATH.
set -euo pipefail

: "${TARGET_BUILD_DIR:?run this from the conch-mac Xcode build}"
: "${CONTENTS_FOLDER_PATH:?run this from the conch-mac Xcode build}"
RESOURCES="$TARGET_BUILD_DIR/${UNLOCALIZED_RESOURCES_FOLDER_PATH:-$CONTENTS_FOLDER_PATH/Resources}"
LAGOON="$RESOURCES/Lagoon"

rm -rf "$LAGOON"
if [[ -z "${CONCH_LAGOON_BUNDLE:-}" ]]; then
  echo "note: no lagoon in this build (CONCH_LAGOON_BUNDLE is unset; scripts/build-app.sh sets it when the brand repo is here)"
  exit 0
fi
if [[ ! -f "$CONCH_LAGOON_BUNDLE/index.html" ]]; then
  echo "error: CONCH_LAGOON_BUNDLE=$CONCH_LAGOON_BUNDLE has no index.html" >&2
  exit 1
fi
if [[ -n "$(find "$CONCH_LAGOON_BUNDLE" -type l -print -quit)" ]]; then
  echo "error: $CONCH_LAGOON_BUNDLE holds a symlink; the lagoon is copied as plain files only" >&2
  exit 1
fi

mkdir -p "$RESOURCES"
ditto --noextattr --norsrc --noqtn --noacl "$CONCH_LAGOON_BUNDLE" "$LAGOON"
# Served, never run: nothing in it is executable.
find "$LAGOON" -type f -exec chmod 0644 {} +
find "$LAGOON" -type d -exec chmod 0755 {} +
files="$(find "$LAGOON" -type f | wc -l | tr -d ' ')"
bytes="$(find "$LAGOON" -type f -exec stat -f %z {} + | awk '{ s += $1 } END { print s + 0 }')"
echo "embedded the lagoon: $files files, $bytes bytes ($(head -1 "$LAGOON/BUNDLE.txt" 2>/dev/null || echo "no BUNDLE.txt"))"
