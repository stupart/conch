import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dismissedWriter, loadDismissed } from "../src/dismissed-store.ts";

test("dismissals written when they change come back after a restart", () => {
  const file = join(mkdtempSync(join(tmpdir(), "conch-dismissed-")), "dismissed.json");
  expect(loadDismissed(file)).toEqual(new Set());
  const ids = new Set(["a", "b"]);
  const save = dismissedWriter(file, new Set());
  save(ids);
  expect(loadDismissed(file)).toEqual(new Set(["a", "b"]));
  // Unchanged: not written again.
  const written = statSync(file).mtimeMs;
  save(new Set(["b", "a"]));
  expect(statSync(file).mtimeMs).toBe(written);
  ids.delete("a");
  save(ids);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ dismissed: ["b"] });
});

test("an unreadable or foreign file is no dismissals, never a crash", () => {
  const file = join(mkdtempSync(join(tmpdir(), "conch-dismissed-")), "dismissed.json");
  writeFileSync(file, "{ torn");
  expect(loadDismissed(file)).toEqual(new Set());
  writeFileSync(file, JSON.stringify({ dismissed: ["ok", 7, "", null] }));
  expect(loadDismissed(file)).toEqual(new Set(["ok"]));
});
