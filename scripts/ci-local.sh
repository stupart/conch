#!/bin/bash
# The gate: every check that used to run in GitHub Actions, plus the ones that
# never did, in one command, with every exit code read.
#
#   scripts/ci-local.sh               fast set: install test tsc swift
#   scripts/ci-local.sh all           fast set + mac ios gap  (the app builds take minutes)
#   scripts/ci-local.sh tsc swift     any subset, in the order given
#
#   install  bun install --frozen-lockfile                 the lockfile matches package.json
#   test     bun test
#   tsc      bunx tsc --noEmit                             bun test does not typecheck
#   swift    swift test --package-path design/ConchDesign
#   mac      xcodebuild conch-mac, Debug, unsigned         never ran in the cloud; slow
#   ios      xcodebuild conch-ios, Debug, generic iOS Simulator, unsigned   same
#   gap      commits on HEAD since the latest GitHub release — informational, never fails
#
# GitHub Actions credits ran out on 2026-09-17, so .github/workflows/ci.yml is
# workflow_dispatch only and nothing in the cloud checks a push. This does.
# scripts/install-hooks.sh makes pre-push run the fast set; `git push --no-verify`
# skips it once.
#
# Each check's output goes to build/ci-local/<check>.log and its exit code is
# read straight from the command, never through a pipe: `$?` after
# `bun test | tail` is tail's, which is how a red main merged on 2026-08-31.
set -uo pipefail
cd "$(dirname "$0")/.."

LOGS=build/ci-local
ESC=$(printf '\033')
FAST="install test tsc swift"
SLOW="mac ios"

usage() { sed -n '/^#   scripts/,/^#   gap/p' "$0" | cut -c3-; }

case "${1:-}" in
  "" | fast)   set -- $FAST ;;
  all)         set -- $FAST $SLOW gap ;;
  -h | --help) usage; exit 0 ;;
esac
for c in "$@"; do
  case "$c" in
    install | test | tsc | swift | mac | ios | gap) ;;
    *) echo "unknown check '$c'" >&2; usage >&2; exit 2 ;;
  esac
done

# The cloud's release-gap job: how stale is what `brew install` delivers. A
# warning, never a failure — being ahead of a release is normal.
release_gap() {
  local tag ahead
  tag=$(gh release view --json tagName --jq .tagName 2>/dev/null) \
    || { echo "no release to measure against (gh offline, signed out, or nothing published)"; return 0; }
  ahead=$(git rev-list --count "$tag..HEAD" 2>/dev/null) \
    || { echo "$tag is not fetched locally — git fetch --tags"; return 0; }
  echo "HEAD is $ahead commits ahead of $tag"
  [ "$ahead" -gt 25 ] && echo "warning: anyone installing from Homebrew is getting $tag"
  return 0
}

mkdir -p "$LOGS"
RESULTS=()
FAILED=""

run() { # <check>
  local name=$1 log="$LOGS/$1.log" start=$SECONDS rc detail=""
  echo "→ $name"
  case "$name" in
    install) bun install --frozen-lockfile ;;
    test)    bun test ;;
    tsc)     bunx tsc --noEmit ;;
    swift)   swift test --package-path design/ConchDesign ;;
    mac)     xcodebuild -project mac-app/conch-mac.xcodeproj -scheme conch-mac -configuration Debug \
               -destination 'platform=macOS' -derivedDataPath "$LOGS/mac.noindex" \
               CODE_SIGNING_ALLOWED=NO -quiet build \
               && ls -d "$LOGS/mac.noindex/Build/Products/Debug/conch-mac.app" ;;
    ios)     xcodebuild -project mobile/conch-ios/conch-ios.xcodeproj -scheme conch-ios -configuration Debug \
               -destination 'generic/platform=iOS Simulator' -derivedDataPath "$LOGS/ios.noindex" \
               CODE_SIGNING_ALLOWED=NO -quiet build \
               && ls -d "$LOGS/ios.noindex/Build/Products/Debug-iphonesimulator/conch-ios.app" ;;
    gap)     release_gap ;;
  esac >"$log" 2>&1
  rc=$?
  case "$name" in
    test)      detail=$(sed "s/$ESC\[[0-9;]*m//g" "$log" | grep -oE '^ *[0-9]+ (pass|fail)$' | xargs) ;;   # bun colours even a log file
    swift)     detail=$(grep -oE 'Executed [0-9]+ tests?, with [0-9]+ failures?' "$log" | tail -1) ;;
    mac | ios) detail=$(tail -1 "$log") ;;   # -quiet drops BUILD SUCCEEDED; the .app is the proof
    gap)       detail=$(head -1 "$log") ;;
  esac
  if [ "$rc" -eq 0 ]; then
    RESULTS+=("$(printf '✓ %-8s %4ss  %s' "$name" "$((SECONDS - start))" "$detail")")
  else
    FAILED="$FAILED $name"
    RESULTS+=("$(printf '✗ %-8s %4ss  exit %s — %s' "$name" "$((SECONDS - start))" "$rc" "$log")")
    echo "  ✗ $name failed (exit $rc) — last 40 lines of $log:"
    tail -n 40 "$log" | sed 's/^/    /'
  fi
}

for c in "$@"; do run "$c"; done

echo
echo "── gate ──"
printf '  %s\n' "${RESULTS[@]}"
for c in $SLOW; do
  case " $* " in *" $c "*) ;; *) echo "  · $c      not run — slow; opt in with \`scripts/ci-local.sh all\` or \`$c\`" ;; esac
done
echo
if [ -n "$FAILED" ]; then echo "✗ gate failed:$FAILED (${SECONDS}s)"; exit 1; fi
echo "✓ gate passed (${SECONDS}s)"
