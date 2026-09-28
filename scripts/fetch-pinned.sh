#!/bin/bash
# Download <url> to <dest> as exactly the bytes <sha256> pins, or not at all.
#
#   scripts/fetch-pinned.sh <url> <sha256> <dest>
#
# For a slow network: an interrupted download is resumed where it stopped
# (curl -C -), in this run or the next, from <dest>.part. Only a verified file
# is ever moved to <dest>, and a <dest> already there is reused only while it
# still verifies. A complete download that is not the pinned bytes is thrown
# away, never resumed onto; so is a partial the server will not resume (GitHub's
# generated source archives send no byte ranges). Three attempts, then it fails.
#
# Used by scripts/fetch-tmux.sh. Test seam: CURL (the curl to run).
set -euo pipefail

url="${1:?usage: scripts/fetch-pinned.sh <url> <sha256> <dest>}"
sum="${2:?usage: scripts/fetch-pinned.sh <url> <sha256> <dest>}"
dest="${3:?usage: scripts/fetch-pinned.sh <url> <sha256> <dest>}"
part="$dest.part"
name="$(basename "$dest")"
CURL="${CURL:-curl}"

verified() { # <file>
  [[ -f "$1" ]] && echo "$sum  $1" | shasum -a 256 -c - >/dev/null 2>&1
}
size() { stat -f %z "$1" 2>/dev/null || echo 0; }

verified "$dest" && exit 0
mkdir -p "$(dirname "$dest")"
for attempt in 1 2 3; do
  echo "fetching $url" >&2
  rc=0
  before="$(size "$part")"
  "$CURL" -fsSL --retry 3 --connect-timeout 30 --max-time 900 -C - -o "$part" "$url" || rc=$?
  if verified "$part"; then
    mv -f "$part" "$dest"
    echo "$sum  $name: OK" >&2
    exit 0
  fi
  if [[ "$rc" -eq 0 ]]; then
    echo "warning: $name downloaded but is not sha256 $sum; starting it over" >&2
    rm -f "$part"
  elif [[ "$(size "$part")" -le "$before" ]]; then
    echo "warning: $name could not be resumed (curl exit $rc); starting it over" >&2
    rm -f "$part"
  else
    echo "warning: $name stopped (curl exit $rc) after $(size "$part") bytes; resuming" >&2
  fi
done
echo "error: could not fetch $url as sha256 $sum" >&2
exit 1
