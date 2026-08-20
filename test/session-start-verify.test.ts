import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = readFileSync(
  join(import.meta.dir, "../mac-app/conch-mac/ContentView.swift"), "utf8");

test("starting a session waits for it to check in", () => {
  // Started is not the same as running. An agent can sit on a prompt before it
  // does anything: Claude Code asks whether it trusts a folder, and Codex has
  // several including "Continuing startup with a fresh local database... Press
  // Enter to continue." Tyler hit that resuming a Codex session — conch said it
  // started, and it was waiting for a keypress nobody could see.
  const start = content.slice(content.indexOf("private func start()"));
  const wait = start.indexOf("await waitForSession()");
  const dismiss = start.indexOf("dismiss()");
  expect(wait).toBeGreaterThan(-1);
  // The sheet must not close before the answer is known.
  expect(wait).toBeLessThan(dismiss);
  expect(start).toContain("Terminal may be");
});

test("resume watches for its exact session, not just any new row", () => {
  // Resume knows which id to expect, so it should not be satisfied by some
  // unrelated session appearing at the same moment.
  const wait = content.slice(content.indexOf("private func waitForSession()"));
  expect(wait).toContain("mode == .resume ? resumeSelection?.sessionId : nil");
  expect(wait).toContain("rows.contains(where: { $0.id == expected })");
  // And a fresh session, which has no id yet, falls back to growth.
  expect(wait).toContain("rows.count > before");
});
