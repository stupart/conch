#!/bin/bash
# The gate: every check that used to run in GitHub Actions, plus the ones that
# never did, in one command, with every exit code read.
#
#   scripts/ci-local.sh               fast tier, pre-push's: install, then test tsc swift side by side
#   scripts/ci-local.sh all           fast + mac ios harness gap  (the app builds take minutes)
#   scripts/ci-local.sh all --full    the tier whole: nothing skipped as unchanged, nothing taken as already passed
#   scripts/ci-local.sh tsc swift     any subset, side by side after install; a stage named is always run
#
#   install  bun install --frozen-lockfile                 the lockfile matches package.json
#   test     bun test, in parallel workers                 every file, every time
#   tsc      bunx tsc --noEmit                             bun test does not typecheck
#   swift    swift test --package-path design/ConchDesign  when design/ changed
#   mac      xcodebuild conch-mac, Debug, unsigned         when design/, mac-app/ or what its build runs changed
#   ios      xcodebuild conch-ios, Debug, generic iOS Simulator, unsigned   when design/ or mobile/ changed
#   harness  bun test's Mac harnesses: the app's Swift compiled, driven offscreen   when design/ or mac-app/ changed
#   gap      commits on HEAD since the latest GitHub release — informational, never fails
#
#   CONCH_GATE_JOBS=n  the cores it may use (default a third of this Mac's, at least 4)
#   CONCH_GATE_BASE=r  what "changed" is measured from (default origin/main)
#
# GitHub Actions credits ran out on 2026-09-17, so .github/workflows/ci.yml is
# workflow_dispatch only and nothing in the cloud checks a push. This does.
# scripts/install-hooks.sh makes pre-push run the fast set; `git push --no-verify`
# skips it once.
#
# Each check's output goes to build/ci-local/<check>.log and its exit code is
# read straight from the command, never through a pipe: `$?` after
# `bun test | tail` is tail's, which is how a red main merged on 2026-08-31.
#
# 2026-11-11: lighter. With a dozen agents pushing, gates queued behind the two-slot lock
# (/tmp/conch-probe/gate-lock.sh), the Mac reached a load average of 113, and an agent's own green gate ran again in
# its push's hook. The fast tier took 7-8 minutes, all of it one after another. Three things keep it cheap now:
#  - A tree that passed is not run again. Every stage's pass is recorded in build/ci-local/passed/, keyed by the
#    working tree as the gate tests it (staged, unstaged and untracked files alike), bun.lock, and the bun, Swift,
#    Xcode and macOS versions. A failure is never recorded, and nothing is when the tree moved during the run.
#  - Only what a change can affect runs. "Changed" is every path that differs from the merge-base with
#    $CONCH_GATE_BASE, the working tree included; when that can't be read, everything runs, and a change to this
#    script runs everything. bun test always runs whole: 155 of its 418 files read Swift, docs, plugin or script files
#    as text, which no import graph sees (`bun test --changed` after an edit to DashboardView.swift ran none of the 65
#    files that read it). A change to src/ alone doesn't rebuild the app: in a Debug build a failed compile of the
#    embedded daemon is only a warning, so the mac stage never gated TypeScript.
#  - Independent stages run side by side, each held to a share of $CONCH_GATE_JOBS rather than every core.
set -uo pipefail
cd "$(dirname "$0")/.."

LOGS=build/ci-local
PASSED=$LOGS/passed
ESC=$(printf '\033')
FAST="install test tsc swift"
SLOW="mac ios harness"
STAGES="install test tsc swift mac ios harness gap"
BASE_REF=${CONCH_GATE_BASE:-origin/main}
# The harness stage's files, test/<name>.test.ts.
HARNESSES="sidebar-settle page-capture-render composer-editor-render lagoon-page"

usage() { sed -n '/^#   scripts/,/^#   CONCH_GATE_BASE/p' "$0" | cut -c3-; }

FULL=""
NAMED=""
ARGS=()
for a in "$@"; do
  case "$a" in
    --full)      FULL=1 ;;
    -h | --help) usage; exit 0 ;;
    *)           ARGS+=("$a") ;;
  esac
done
case "${ARGS[*]:-}" in
  "" | fast) set -- $FAST ;;
  all)       set -- $FAST $SLOW gap ;;
  *)         NAMED=1; set -- "${ARGS[@]}" ;;
esac
for c in "$@"; do
  case " $STAGES " in
    *" $c "*) ;;
    *) echo "unknown check '$c'" >&2; usage >&2; exit 2 ;;
  esac
done

# The working tree as the gate tests it, as a tree id: the index copied, then everything in the tree added to the copy,
# so an unstaged edit or an untracked file counts and the real index is never touched.
worktree_id() {
  local index rc
  index=$(mktemp "${TMPDIR:-/tmp}/ci-local-index.XXXXXX") || return 1
  cp "$(git rev-parse --git-path index)" "$index" 2>/dev/null
  GIT_INDEX_FILE=$index git add -A >/dev/null 2>&1 && GIT_INDEX_FILE=$index git write-tree
  rc=$?
  rm -f "$index"
  return $rc
}
# What a stage's pass is a fact about: the tree, the lockfile, and the tools that ran it.
gate_key() {
  local tree
  tree=$(worktree_id) || return 1
  {
    echo "tree $tree"
    echo "lock $(git hash-object bun.lock 2>/dev/null)"
    echo "bun $(bun --version 2>/dev/null)"
    echo "swift $(swift --version 2>&1 | head -1)"
    echo "xcode $(xcodebuild -version 2>/dev/null | tr '\n' ' ')"
    echo "macos $(sw_vers -buildVersion 2>/dev/null)"
  } | shasum -a 256 | cut -c1-40
}
passed_before() { [ -z "$FULL" ] && [ -z "$NAMED" ] && [ -n "$KEY" ] && grep -qx "$1" "$PASSED/$KEY" 2>/dev/null; }

# Every path that differs from the merge-base with $BASE_REF, both sides of a rename, untracked files too.
CHANGED=$LOGS/changed.txt
read_changes() {
  local base
  base=$(git merge-base HEAD "$BASE_REF" 2>/dev/null) || return 1
  BASE_SHORT=$(git rev-parse --short "$base")
  { git diff --name-only --no-renames "$base" -- && git ls-files --others --exclude-standard; } >"$CHANGED" || return 1
}
# The paths a stage's result can depend on. install, test, tsc and gap have none listed: they always run.
inputs() { # <check>
  case "$1" in
    swift) echo '^design/' ;;
    # The project, its package, the build phases' scripts (embed-*, and the fetch-* they call), and package.json (the
    # embedded daemon must report its version).
    mac)   echo '^(design/|mac-app/|scripts/(embed|fetch)-[^/]*$|package\.json$)' ;;
    ios)   echo '^(design/|mobile/)' ;;
    # The Swift they compile, and themselves with their fixtures.
    harness) echo "^(design/|mac-app/|test/($(echo $HARNESSES | tr ' ' '|'))\.test\.ts$|test/fixtures/(sidebar-settle|page-capture|composer-editor|lagoon))" ;;
  esac
}
affected() { # <check> → 0 when what changed can change its result
  local pattern
  pattern=$(inputs "$1")
  [ -z "$pattern" ] && return 0
  # Asked for by name or --full, or with no way to tell what changed: it runs.
  if [ -n "$FULL" ] || [ -n "$NAMED" ] || [ -z "$CHANGES_KNOWN" ]; then return 0; fi
  # A change to the gate runs all of it, so the gate is what checks itself.
  grep -qx 'scripts/ci-local\.sh' "$CHANGED" && return 0
  grep -qE "$pattern" "$CHANGED"
}

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

mkdir -p "$LOGS" "$PASSED"
# Records of trees long gone: a month is far longer than any branch waits for its push.
find "$PASSED" -type f -mtime +30 -delete 2>/dev/null
KEY=$(gate_key 2>/dev/null) || KEY=""
CHANGES_KNOWN=""
BASE_SHORT=""
read_changes && CHANGES_KNOWN=1

# Xcode registers every app it builds with Launch Services, so each worktree's build became another "conch" in
# Spotlight, Launchpad and Open With, and stayed one after the worktree went: 301 had piled up by 2026-10-08. Only
# /Applications/conch.app should be conch to macOS. Never fails a stage.
unregister() { # <app>
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$1" >/dev/null 2>&1 || true
}

stage() { # <check>   the check itself; launch() keeps its output and exit code
  case "$1" in
    install) bun install --frozen-lockfile ;;
    # Without $TMUX: a suite started inside a tmux pane (a conch background session) would otherwise hand it to every
    # tmux a test spawns, and a bare tmux there reaches the real server (test/preload.ts can't clear it for children).
    # --timings: each worker starts on the slowest files left, from the last run's durations.
    test)    env -u TMUX -u TMUX_PANE bun test --parallel="$TEST_WORKERS" \
               --timings="$LOGS/test-timings.json" --update-timings ;;
    tsc)     bunx tsc --noEmit ;;
    swift)   swift test --package-path design/ConchDesign -j "$SWIFT_JOBS" ;;
    mac)     xcodebuild -project mac-app/conch-mac.xcodeproj -scheme conch-mac -configuration Debug \
               -destination 'platform=macOS' -derivedDataPath "$LOGS/mac.noindex" -jobs "$MAC_JOBS" \
               CODE_SIGNING_ALLOWED=NO -quiet build \
               && unregister "$LOGS/mac.noindex/Build/Products/Debug/conch-mac.app" \
               && ls -d "$LOGS/mac.noindex/Build/Products/Debug/conch-mac.app" ;;
    ios)     xcodebuild -project mobile/conch-ios/conch-ios.xcodeproj -scheme conch-ios -configuration Debug \
               -destination 'generic/platform=iOS Simulator' -derivedDataPath "$LOGS/ios.noindex" -jobs "$IOS_JOBS" \
               CODE_SIGNING_ALLOWED=NO -quiet build \
               && unregister "$LOGS/ios.noindex/Build/Products/Debug-iphonesimulator/conch-ios.app" \
               && ls -d "$LOGS/ios.noindex/Build/Products/Debug-iphonesimulator/conch-ios.app" ;;
    # 2026-11-11: the bun tests that compile the Mac app's own Swift with swiftc and drive it offscreen. They were 213 s
    # of the suite's 381 and its three slowest files (page-capture-render 82 s, composer-editor-render 69, lagoon-page
    # 63), so every push paid for them, and they read nothing of src/. Like the sidebar settle harness before them
    # (391dc308, then in the mac stage), they run only with CONCH_APP_HARNESS=1: here, beside the app builds.
    harness) CONCH_APP_HARNESS=1 CONCH_GATE_JOBS="$MAC_JOBS" env -u TMUX -u TMUX_PANE bun test --parallel=2 \
               $(for h in $HARNESSES; do printf 'test/%s.test.ts ' "$h"; done) ;;
    gap)     release_gap ;;
  esac
}

# What runs: every stage asked for, less the ones nothing changed can affect and the ones this tree already passed.
# install is the others' footing: it runs whenever any of them does.
RESULTS=()
SKIPPED=()
WORK=()
for c in "$@"; do
  [ "$c" = install ] && continue
  if ! affected "$c"; then
    SKIPPED+=("$(printf '· %-8s skipped — nothing it builds from changed since %s (%s); --full runs it' "$c" "$BASE_REF" "$BASE_SHORT")")
  elif [ "$c" != gap ] && passed_before "$c"; then
    RESULTS+=("$(printf '✓ %-8s cached  this tree passed it before' "$c")")
  else
    WORK+=("$c")
  fi
done
RUN_INSTALL=""
case " $* " in
  *" install "*)
    if [ "${#WORK[@]}" -gt 0 ] && [ "${WORK[*]}" != gap ] || ! passed_before install; then RUN_INSTALL=1
    else RESULTS=("$(printf '✓ %-8s cached  this tree passed it before' install)" ${RESULTS[@]+"${RESULTS[@]}"}); fi ;;
esac

# The cores the gate may use, and each stage's share. Two gates can hold the lock at once beside every agent's own
# work, so a gate takes a third of the Mac, not all of it: before 2026-11-11 swift test and xcodebuild each took every
# core while bun test used about one. With an app build running beside it the suite's share halves, and the mac build,
# the longest stage then, gets the other half.
CORES=$(sysctl -n hw.ncpu 2>/dev/null || echo 8)
JOBS=${CONCH_GATE_JOBS:-$((CORES / 3))}
[ "$JOBS" -ge 4 ] 2>/dev/null || JOBS=4
SWIFT_JOBS=$((JOBS / 3))
MAC_JOBS=$((JOBS / 2))
IOS_JOBS=$((JOBS / 3))
case " ${WORK[*]:-} " in
  *" mac "* | *" ios "* | *" harness "*) TEST_WORKERS=$((JOBS / 2)) ;;
  *)                     TEST_WORKERS=$((JOBS - 1)) ;;
esac
[ "$TEST_WORKERS" -ge 2 ] || TEST_WORKERS=2

FAILED=""
NEWLY_PASSED=""
PIDS=()
NAMES=()
# Runs a check in the background. Its exit code is read straight from the check inside the subshell, never through a
# pipe, and written beside its log with how long it took.
launch() { # <check>
  local name=$1
  rm -f "$LOGS/$name.rc"
  ( start=$SECONDS; stage "$name" >"$LOGS/$name.log" 2>&1; echo "$? $((SECONDS - start))" >"$LOGS/$name.rc" ) &
  PIDS+=($!)
  NAMES+=("$name")
}
settle() { # <check>   once its run has ended
  local name=$1 log="$LOGS/$1.log" rc elapsed detail=""
  read -r rc elapsed <"$LOGS/$name.rc" 2>/dev/null || { rc=1; elapsed="?"; }
  case "$name" in
    test | harness) detail=$(sed "s/$ESC\[[0-9;]*m//g" "$log" | grep -oE '^ *[0-9]+ (pass|fail)$' | xargs) ;;   # bun colours even a log file
    swift)     detail=$(grep -oE 'Executed [0-9]+ tests?, with ([0-9]+ tests? skipped and )?[0-9]+ failures?' "$log" | tail -1) ;;
    mac | ios) detail=$(tail -1 "$log") ;;   # -quiet drops BUILD SUCCEEDED; the .app is the proof
    gap)       detail=$(head -1 "$log") ;;
  esac
  if [ "$rc" -eq 0 ]; then
    RESULTS+=("$(printf '✓ %-8s %4ss  %s' "$name" "$elapsed" "$detail")")
    [ "$name" = gap ] || NEWLY_PASSED="$NEWLY_PASSED $name"
  else
    FAILED="$FAILED $name"
    RESULTS+=("$(printf '✗ %-8s %4ss  exit %s — %s' "$name" "$elapsed" "$rc" "$log")")
    echo "  ✗ $name failed (exit $rc) — last 40 lines of $log:"
    tail -n 40 "$log" | sed 's/^/    /'
  fi
}
wait_all() {
  local i=0
  while [ "$i" -lt "${#PIDS[@]}" ]; do
    wait "${PIDS[$i]}"
    settle "${NAMES[$i]}"
    i=$((i + 1))
  done
  PIDS=()
  NAMES=()
}

if [ -n "$RUN_INSTALL" ]; then
  echo "→ install"
  launch install
  wait_all
fi
case " $FAILED " in
  *" install "*) ;;
  *)
    if [ "${#WORK[@]}" -gt 0 ]; then
      echo "→ ${WORK[*]}  side by side on $JOBS cores (bun test ×$TEST_WORKERS, swift -j $SWIFT_JOBS, mac -jobs $MAC_JOBS, ios -jobs $IOS_JOBS)"
      for c in "${WORK[@]}"; do launch "$c"; done
      wait_all
    fi
    ;;
esac

# Passes are kept only for the tree that was tested: an edit made while the gate ran is not what passed.
if [ -n "$KEY" ] && [ -n "$NEWLY_PASSED" ]; then
  if [ "$(gate_key 2>/dev/null)" = "$KEY" ]; then
    for c in $NEWLY_PASSED; do grep -qx "$c" "$PASSED/$KEY" 2>/dev/null || echo "$c" >>"$PASSED/$KEY"; done
  else
    echo "  · the tree changed while the gate ran, so none of this run's passes are kept"
  fi
fi

echo
echo "── gate ──"
[ "${#RESULTS[@]}" -gt 0 ] && printf '  %s\n' "${RESULTS[@]}"
[ "${#SKIPPED[@]}" -gt 0 ] && printf '  %s\n' "${SKIPPED[@]}"
for c in $SLOW; do
  case " $* " in *" $c "*) ;; *) printf '  · %-8s not run — slow; opt in with `scripts/ci-local.sh all` or `%s`\n' "$c" "$c" ;; esac
done
echo
if [ -n "$FAILED" ]; then echo "✗ gate failed:$FAILED (${SECONDS}s)"; exit 1; fi
if [ -z "$RUN_INSTALL" ] && [ "${#WORK[@]}" -eq 0 ]; then
  echo "✓ gate passed (${SECONDS}s): this tree passed it before, so nothing ran"
  exit 0
fi
echo "✓ gate passed (${SECONDS}s)"
