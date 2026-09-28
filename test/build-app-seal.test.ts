import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * scripts/build-app.sh signs fresh every time, and never replaces the installed conch with one that doesn't verify.
 *
 * #466 added Helpers/tmux through an embed phase with no declared outputs and changed no app code, so Xcode found its
 * CodeSign step up to date and kept the previous seal over the new files. The script then removed the working
 * /Applications/conch.app, copied in the unverifiable one, and failed verification with conch already quit.
 */
const script = readFileSync(join(import.meta.dir, "..", "scripts", "build-app.sh"), "utf8");
const at = (needle: string): number => {
  const index = script.indexOf(needle);
  expect(index, needle).toBeGreaterThan(-1);
  return index;
};

test("the built product is removed before xcodebuild, so the bundle is made and signed again", () => {
  expect(at('rm -rf "$BUILT_APP_PATH"')).toBeLessThan(at("xcodebuild \\"));
});

test("the built app is verified before the installed one is touched", () => {
  const verify = at('codesign --verify --deep --strict --verbose=2 "$BUILT_APP_PATH"');
  expect(verify).toBeGreaterThan(at("xcodebuild \\"));
  expect(verify).toBeLessThan(at('rm -rf "$INSTALLED_APP_PATH"'));
  expect(verify).toBeLessThan(at('for pid in $RUNNING_PIDS; do kill "$pid"'));
  // A failed check stops the script there.
  const guard = at('if ! codesign --verify --deep --strict --verbose=2 "$BUILT_APP_PATH"; then');
  expect(guard + "if ! ".length).toBe(verify);
  expect(script.slice(guard, script.indexOf("\nfi\n", guard))).toContain("exit 1");
});
