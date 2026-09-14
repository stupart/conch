import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const composer = readFileSync(join(import.meta.dir, "..", "mac-app/conch-mac/ComposerView.swift"), "utf8");

/** A Swift member from its signature to its closing brace at four-space indentation. */
function member(signature: string): string {
  const start = composer.indexOf(signature);
  expect(start, `missing: ${signature}`).toBeGreaterThan(-1);
  const end = composer.indexOf("\n    }\n", start);
  expect(end).toBeGreaterThan(start);
  return composer.slice(start, end);
}

/**
 * Tyler typed a long reply into the conversation overlay and conch froze until he force-quit it. A sample of the
 * spinning app had ComposerDraftStore.persist, JSON-encoding every draft into preferences, heaviest on the main thread,
 * once per keystroke. Drafts now save once typing pauses, and when the app quits.
 */
test("drafts save once typing pauses and when conch quits, never on every keystroke", () => {
  const update = member("private func update(_ sessionID: String, mutate: (inout Entry) -> Void) {");
  expect(update).toContain("scheduleSave()");
  expect(update).not.toContain("persist()");
  // The same text sent again is not a change.
  expect(update).toContain("guard entry.text != (before?.text ?? \"\") || entry.attachments != (before?.attachments ?? []) else { return }");
  const schedule = member("private func scheduleSave() {");
  expect(schedule).toContain("saveTask?.cancel()");
  expect(schedule).toContain("try? await Task.sleep(for: .milliseconds(500))");
  expect(schedule).toContain("self?.persist()");
  expect(composer).toContain("forName: NSApplication.willTerminateNotification");
  expect(composer).toContain("MainActor.assumeIsolated { self?.saveNow() }");
});
