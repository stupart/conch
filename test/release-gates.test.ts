import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
const release = read("scripts/release.sh");

/**
 * Releasing has to be one command, because a checklist is what failed.
 *
 * The tap sat pinned to v0.2.1 for 327 commits — including the fix for a
 * microphone that could not hear at all — not because releasing was hard but
 * because it was a sequence someone had to remember. Anyone running
 * `brew install` in that window got software that did not work, and nothing
 * told them.
 */
test("the release script refuses more than it does", () => {
  // Never from a dirty or diverged tree: a release must be reproducible from
  // the tag it claims to be.
  expect(release).toContain('[ "$(git branch --show-current)" = "main" ] || fail');
  expect(release).toContain('[ -z "$(git status --porcelain)" ] || fail');
  expect(release).toContain('|| fail "main is not in sync with origin"');
  // `&&`, not `||`: the guard fires when the tag DOES resolve. Verified that
  // `set -e` tolerates the non-final failure of an AND list, so a missing tag
  // (the normal case) falls through instead of aborting the release.
  expect(release).toContain('git rev-parse "$TAG" >/dev/null 2>&1 && fail "$TAG already exists"');

  // Never a red release. Both gates, since neither implies the other.
  expect(release).toContain("bun test");
  expect(release).toContain("bunx tsc --noEmit || fail");
});

/**
 * The app is not optional cargo — it is the half that carries
 * NSMicrophoneUsageDescription and the audio-input entitlement. A CLI-only
 * tarball would install a conch whose recorder cannot be granted a microphone,
 * which is the exact failure this release is meant to deliver the fix for.
 * `build-release.sh` degrades to CLI-only with a warning; here that becomes a
 * refusal.
 */
test("a tarball without the app is not shippable", () => {
  expect(release).toContain('grep -q "conch.app/"');
  expect(release).toContain("the app is what holds the mic permission");
});

/**
 * The tap is bumped by the same command that publishes, because the failure
 * being prevented is precisely a release the tap never points at.
 */
test("publishing and the tap bump cannot come apart", () => {
  const publish = release.indexOf("gh release create");
  const tap = release.indexOf("bumping $TAP_REPO");
  expect(publish).toBeGreaterThan(-1);
  expect(tap).toBeGreaterThan(-1);
  expect(publish).toBeLessThan(tap);

  // ...and the formula is verified after editing, not assumed.
  expect(release).toContain('|| fail "arm64 sha did not land in the formula"');
  expect(release).toContain('|| fail "version did not land in the formula"');
});

test("the release script is executable", () => {
  const mode = statSync(join(import.meta.dir, "..", "scripts/release.sh")).mode;
  expect(mode & 0o111).toBeGreaterThan(0);
});

/**
 * CI exists at all now. It did not, which is how a red main was merged: the
 * suite was piped into `tail`, the exit code went unread, and nothing
 * downstream disagreed.
 */
test("CI runs both gates on every push and PR", () => {
  const ci = read(".github/workflows/ci.yml");
  expect(ci).toContain("runs-on: macos-latest");
  expect(ci).toContain("run: bun test");
  expect(ci).toContain("run: bunx tsc --noEmit");
  expect(ci).toContain("pull_request:");
});

/**
 * A release from CI must be signed with the SAME identity as a local one.
 *
 * macOS ties the microphone grant to the code signing identity, so an app
 * signed ad-hoc or by a different cert is a new app to TCC — and every upgrade
 * would silently drop the permission that makes conch able to hear at all.
 * That is the bug this whole release exists to deliver the fix for, so the
 * workflow refuses rather than shipping it back.
 */
test("the release workflow refuses an unsigned or wrongly-signed app", () => {
  const wf = read(".github/workflows/release.yml");

  expect(wf).toContain("MACOS_CERT_P12_BASE64 is not set");
  expect(wf).toContain("codesign --verify --strict");
  expect(wf).toContain("TeamIdentifier=5DRS8F56M2");
  expect(wf).toContain('grep -q "conch.app/"');

  // Publishing and the tap bump live in one job so they cannot come apart.
  expect(wf).toContain("bump the tap");
  expect(wf).toContain("TAP_TOKEN is not set");

  // Tag-triggered, not per-commit: a signed build per merge, and an update
  // notice for a docs change, is not what "keep brew current" should cost.
  expect(wf).toContain('tags: ["v*"]');
});

test("CI reports how far the tap is behind main", () => {
  const ci = read(".github/workflows/ci.yml");
  expect(ci).toContain("release-gap:");
  expect(ci).toContain("git rev-list --count");
  // A warning, not a failure — being ahead of a release is normal.
  expect(ci).toContain("::warning::main is $AHEAD commits ahead");
});
