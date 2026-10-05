#!/bin/bash
# Xcode build phase ("Embed package notices", conch-mac target): the licences of
# the Swift packages compiled into conch.app, in Resources/ThirdParty/<package>,
# beside those of the helpers (scripts/embed-*.sh).
#
# One package so far: SwiftTerm, the terminal emulator of a hosted session's
# Terminal tab (mac-app/conch-mac/EmbeddedTerminal.swift). Its MIT licence asks
# for the notice to travel with the software; the licence and a NOTICE saying
# which version and how it is used are in mac-app/third-party/SwiftTerm.
#
# Environment (set by Xcode): TARGET_BUILD_DIR, CONTENTS_FOLDER_PATH,
# UNLOCALIZED_RESOURCES_FOLDER_PATH.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
: "${TARGET_BUILD_DIR:?run this from the conch-mac Xcode build}"
: "${CONTENTS_FOLDER_PATH:?run this from the conch-mac Xcode build}"
RESOURCES="$TARGET_BUILD_DIR/${UNLOCALIZED_RESOURCES_FOLDER_PATH:-$CONTENTS_FOLDER_PATH/Resources}"

for package in SwiftTerm; do
  mkdir -p "$RESOURCES/ThirdParty/$package"
  install -m 0644 "$REPO_ROOT/mac-app/third-party/$package/LICENSE" "$REPO_ROOT/mac-app/third-party/$package/NOTICE" \
    "$RESOURCES/ThirdParty/$package/"
done
