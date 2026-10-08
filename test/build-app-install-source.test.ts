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
