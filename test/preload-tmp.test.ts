import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

// Tests make scratch folders with `tmpdir()` and don't remove them; 86,567 had piled up in the user's temp folder.
// The preload points every one of them at a folder of the run's own, removed after the last test.
test("every test's tmpdir() is the run's own folder, and the run removes it", () => {
  expect(basename(tmpdir().replace(/\/$/, ""))).toStartWith("conch-test-run-");
  expect(dirname(tmpdir().replace(/\/$/, ""))).not.toContain("conch-test-run-");
  const preload = readFileSync(join(import.meta.dir, "preload.ts"), "utf8");
  expect(preload).toContain("process.env.TMPDIR = runRoot;");
  expect(preload).toContain("afterAll(() => rmSync(runRoot, { recursive: true, force: true }));");
});
