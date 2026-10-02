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
  const wait = content.slice(content.indexOf("private func waitForSession("));
  expect(wait).toContain("expectedId: launchedSessionId ?? (mode == .resume ? resumeSelection?.sessionId : nil)");
  // And a fresh session, which has no id yet, is a SESSION id not there before: a count
  // grew whenever another session's agent appeared (agents are rows since #390).
  expect(wait).toContain("before: sessionsBeforeLaunch");
  expect(wait).toContain("if let id = watch.match(in: launched) { return id }");
  const watch = readFileSync(
    join(import.meta.dir, "../design/ConchDesign/Sources/ConchDesign/StartedSession.swift"), "utf8");
  expect(watch).toContain("return sessions.contains { $0.id == expectedId } ? expectedId : nil");
  expect(watch).toContain("return sessions.first { !before.contains($0.id) }?.id");
});

test("a new Claude session is found though its row names no backend", () => {
  // The daemon publishes `backend` only for Codex and for agents (src/panel.ts). Comparing the
  // raw field missed every new Claude session, and the sheet never closed onto it.
  const watch = readFileSync(
    join(import.meta.dir, "../design/ConchDesign/Sources/ConchDesign/StartedSession.swift"), "utf8");
  expect(watch).toContain('(row.backend ?? "claude") == backend');
  const panel = readFileSync(join(import.meta.dir, "../src/panel.ts"), "utf8");
  expect(panel).toContain("...(session.backend ? { backend: session.backend } : {}),");
});

test("a session that checks in is shown in conch, and conch comes back from the Terminal it raised", () => {
  // Tyler: "When a session starts successfully it should then show the session back in the conch app."
  const start = content.slice(content.indexOf("private func start()"));
  expect(start).toContain("if let appeared {\n                onStarted(appeared)\n                dismiss()");
  expect(content).toContain("StartSessionSheet(onStarted: showStarted)");
  const show = content.slice(content.indexOf("private func showStarted("), content.indexOf("private func showStarted(") + 700);
  expect(show).toContain("workspace.viewing = id");
  // Only back from Terminal: anywhere else Tyler went meanwhile, he stays.
  expect(show).toContain('guard !NSApp.isActive, NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.Terminal" else { return }');
  expect(show).toContain("NSApp.activate(ignoringOtherApps: true)");
});
