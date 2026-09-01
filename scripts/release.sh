#!/bin/zsh
# Cut a conch release, end to end.
#
#   scripts/release.sh 0.3.0
#
# Why this exists: every step below was already possible by hand, and that is
# exactly the problem. The tap sat pinned to v0.2.1 for 327 commits — including
# a fix for a microphone that could not hear at all — because releasing was a
# checklist rather than a command. Anyone who ran `brew install` in that window
# got software that did not work, and nothing told them.
#
# Refuses more than it does. A release that ships a red suite or a stale tap is
# worse than no release, so every gate fails loudly and early rather than
# leaving a half-published version behind.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
[ -n "$VERSION" ] || { echo "usage: scripts/release.sh <version>   e.g. 0.3.0" >&2; exit 1; }
echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || { echo "version must be x.y.z, got '$VERSION'" >&2; exit 1; }
TAG="v$VERSION"
TAP_REPO="stupart/homebrew-tap"

fail() { echo "\n✗ $1" >&2; exit 1; }
step() { echo "\n→ $1"; }

# --- gates ---------------------------------------------------------------
step "checking the tree"
[ "$(git branch --show-current)" = "main" ] || fail "not on main"
[ -z "$(git status --porcelain)" ] || fail "working tree is dirty"
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "main is not in sync with origin"
git rev-parse "$TAG" >/dev/null 2>&1 && fail "$TAG already exists"

step "running the suite"
bun test >/tmp/conch-release-test.log 2>&1 || fail "tests failed — see /tmp/conch-release-test.log"
bunx tsc --noEmit || fail "typecheck failed"

# --- build ---------------------------------------------------------------
step "building $TAG"
scripts/build-release.sh "$VERSION"
for arch in arm64 x64; do
  [ -f "dist/conch-macos-$arch.tar.gz" ] || fail "missing dist/conch-macos-$arch.tar.gz"
done
# The app is the half that carries the microphone entitlement, so a CLI-only
# tarball is not a conch release — build-release.sh degrades with a warning and
# this is where that warning has to become a refusal.
tar -tzf dist/conch-macos-arm64.tar.gz | grep -q "conch.app/" \
  || fail "tarball has no conch.app — the app build failed, and the app is what holds the mic permission"

ARM_SHA=$(shasum -a 256 dist/conch-macos-arm64.tar.gz | cut -d' ' -f1)
X64_SHA=$(shasum -a 256 dist/conch-macos-x64.tar.gz | cut -d' ' -f1)

# --- publish -------------------------------------------------------------
step "tagging and publishing $TAG"
bun --print "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  p.version = '$VERSION';
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
  'ok'
" >/dev/null
git add package.json
git commit -q -m "conch $VERSION"
git tag -a "$TAG" -m "conch $VERSION"
git push -q origin main "$TAG"
gh release create "$TAG" dist/conch-macos-*.tar.gz \
  --title "conch $VERSION" --generate-notes

# --- the tap -------------------------------------------------------------
# Bumped in the same command as the release, because the failure mode this
# script exists to prevent is precisely a published release the tap never
# points at.
step "bumping $TAP_REPO"
TAP_DIR=$(mktemp -d)
trap 'rm -rf "$TAP_DIR"' EXIT
gh repo clone "$TAP_REPO" "$TAP_DIR" -- -q
FORMULA="$TAP_DIR/Formula/conch.rb"
[ -f "$FORMULA" ] || fail "no Formula/conch.rb in $TAP_REPO"

/usr/bin/sed -i '' \
  -e "s|^  version \".*\"|  version \"$VERSION\"|" \
  -e "s|download/v[0-9.]*/conch-macos-arm64|download/v$VERSION/conch-macos-arm64|" \
  -e "s|download/v[0-9.]*/conch-macos-x64|download/v$VERSION/conch-macos-x64|" \
  "$FORMULA"
# Each sha256 sits under its own `on_arm`/`on_intel` block, so replace them
# positionally rather than by pattern — the two lines are otherwise identical.
/usr/bin/awk -v arm="$ARM_SHA" -v x64="$X64_SHA" '
  /sha256 "/ { n++; if (n == 1) sub(/sha256 "[^"]*"/, "sha256 \"" arm "\""); else if (n == 2) sub(/sha256 "[^"]*"/, "sha256 \"" x64 "\"") }
  { print }
' "$FORMULA" > "$FORMULA.new" && mv "$FORMULA.new" "$FORMULA"

grep -q "$ARM_SHA" "$FORMULA" || fail "arm64 sha did not land in the formula"
grep -q "$X64_SHA" "$FORMULA" || fail "x64 sha did not land in the formula"
grep -q "version \"$VERSION\"" "$FORMULA" || fail "version did not land in the formula"

git -C "$TAP_DIR" add Formula/conch.rb
git -C "$TAP_DIR" commit -q -m "conch $VERSION"
git -C "$TAP_DIR" push -q

echo "\n✓ conch $VERSION released and the tap points at it"
echo "  verify with: brew update && brew upgrade conch"
