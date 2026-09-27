import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The gate's swift summary reports the whole suite. XCTest words a run with a skip as "with 1 test skipped and 0
 * failures", which the old pattern did not match, so the summary fell back to a sub-suite's line ("35 tests") while
 * 455 had run.
 */
test("the swift summary is the whole suite's line, skips included", () => {
  const script = readFileSync(join(import.meta.dir, "..", "scripts", "ci-local.sh"), "utf8");
  const line = script.split("\n").find((l) => l.trimStart().startsWith("swift)") && l.includes("detail="));
  expect(line).toBeDefined();
  const pattern = /grep -oE '([^']+)'/.exec(line!)?.[1];
  expect(pattern).toBeDefined();
  const log = [
    "\t Executed 35 tests, with 0 failures (0 unexpected) in 0.003 (0.004) seconds",
    "\t Executed 455 tests, with 1 test skipped and 0 failures (0 unexpected) in 5.811 (5.829) seconds",
  ].join("\n");
  const matches = log.match(new RegExp(pattern!, "g")) ?? [];
  expect(matches.at(-1)).toBe("Executed 455 tests, with 1 test skipped and 0 failures");
  // Without a skip, the plain wording still matches.
  expect("Executed 12 tests, with 0 failures".match(new RegExp(pattern!))?.[0]).toBe("Executed 12 tests, with 0 failures");
});
