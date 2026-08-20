import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeFolderTrusted } from "../src/sessions.ts";

function configWith(projects: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "conch-trust-"));
  const path = join(dir, "claude.json");
  writeFileSync(path, JSON.stringify({ projects }));
  return path;
}

test("a folder Claude Code has never opened will stop and ask", () => {
  // The session sits on "Is this a project you trust?" and writes no registry
  // file until answered, so conch cannot see it and the app looks broken.
  const path = configWith({ "/work/other": { hasTrustDialogAccepted: true } });
  expect(claudeFolderTrusted("/work/new", path)).toBe(false);
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("a folder already accepted will not", () => {
  const path = configWith({ "/work/known": { hasTrustDialogAccepted: true } });
  expect(claudeFolderTrusted("/work/known", path)).toBe(true);
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("a recorded folder that never accepted still will", () => {
  const path = configWith({ "/work/half": { hasTrustDialogAccepted: false } });
  expect(claudeFolderTrusted("/work/half", path)).toBe(false);
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("an unreadable config says nothing rather than guessing", () => {
  // Warning about a folder that is actually fine is its own small lie, so the
  // caller must be able to tell "no" from "cannot tell".
  expect(claudeFolderTrusted("/work/x", "/nope/missing.json")).toBeNull();
});
