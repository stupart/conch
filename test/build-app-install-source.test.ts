import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Dock cached a "can't open" circle-slash for conch while build-app.sh deleted the app and then copied the new one
// in (2026-10-04, 2026-10-08). The install is a rename swap now, and only the installed copy stays registered.
const script = readFileSync(join(import.meta.dir, "..", "scripts", "build-app.sh"), "utf8");

test("the new build is staged beside the old one and swapped in by rename, never deleted-then-copied", () => {
  expect(script).not.toMatch(/rm -rf "\$INSTALLED_APP_PATH"\s*\n\s*ditto "\$BUILT_APP_PATH" "\$INSTALLED_APP_PATH"/);
  const staged = script.indexOf('ditto "$BUILT_APP_PATH" "$STAGED_APP_PATH"');
  const retire = script.indexOf('mv "$INSTALLED_APP_PATH" "$RETIRED_APP_PATH"');
  const swap = script.indexOf('mv "$STAGED_APP_PATH" "$INSTALLED_APP_PATH"');
  expect(staged).toBeGreaterThan(-1);
  expect(retire).toBeGreaterThan(staged);
  expect(swap).toBeGreaterThan(retire);
});

test("only the installed copy stays registered with Launch Services", () => {
  expect(script).toContain('"$LSREGISTER" -u "$BUILT_APP_PATH"');
  expect(script).toContain('"$LSREGISTER" -f "$INSTALLED_APP_PATH"');
});

// 2026-10-12: after a deploy, Tyler's window ran the old build. Its title bar said "a newer conch is installed", and the
// lagoon switch it should have had wasn't there. The running copy was asked to quit, given one second, then the bundle
// was swapped; a copy reopened in between was the old one, and `open` only brought it forward.
test("a deploy waits for the old app to quit, and never leaves an old copy running for `open` to bring forward", () => {
  const script = readFileSync(join(import.meta.dir, "../scripts/build-app.sh"), "utf8");
  const swap = script.indexOf('mv "$STAGED_APP_PATH" "$INSTALLED_APP_PATH"');
  const relaunch = script.indexOf('open -g -a "$INSTALLED_APP_PATH"');
  // Waited for, pid by pid, not a fixed second.
  expect(script).not.toMatch(/kill "\$pid" 2>\/dev\/null \|\| true; done\n\s*sleep 1\n/);
  expect(script).toContain('for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done');
  // After the swap and before the relaunch, whatever is running is the old build, and is quit too.
  const stale = script.indexOf('STALE_PIDS="$(pgrep -f "$INSTALLED_APP_PATH/Contents/MacOS/" || true)"');
  expect(stale).toBeGreaterThan(swap);
  expect(stale).toBeLessThan(relaunch);
});
