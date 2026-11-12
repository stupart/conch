import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The composer review of 28 Sep (#437): the fixes, pinned. Most of them were about the composer that floated over other
 * apps (ComposerDock: its reply line, the steering hold, the swoop), and went with the overlays on 2026-11-11. What is
 * left is the window's composer, which every send still goes through.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const composer = read("mac-app/conch-mac/ComposerView.swift");

/** A Swift member from its signature to its closing brace at `indent` spaces. */
function member(source: string, signature: string, indent = 4): string {
  const start = source.indexOf(signature);
  expect(start, `missing: ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf(`\n${" ".repeat(indent)}}\n`, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** `first` is in `source`, and before `then`, which is there too. */
function before(source: string, first: string, then: string): void {
  const a = source.indexOf(first), b = source.indexOf(then);
  expect(a, `missing: ${first}`).toBeGreaterThan(-1);
  expect(b, `missing: ${then}`).toBeGreaterThan(-1);
  expect(a, `${first} before ${then}`).toBeLessThan(b);
}

describe("2: Return respects a send in flight, as the button does", () => {
  test("send asks the button's whole gate first", () => {
    const send = member(composer, "private func send() {");
    expect(send).toMatch(/^private func send\(\) \{\n(\s*\/\/[^\n]*\n)*\s*guard canSend else \{ return \}/);
    before(send, "guard canSend else { return }", "ComposerDraftStore.shared.setSending(session, true)");
    expect(member(composer, "private var canSend: Bool {")).toContain("!composed.isEmpty && !isSending && messageUnavailableReason == nil");
    // Return goes through it: the editor's Return is the composer's `send`, and nothing else.
    expect(composer).toContain("ComposerEditor(text: $draft, isFocused: $fieldFocused, identity: sessionID, onSend: send)");
    const editor = read("mac-app/conch-mac/ComposerEditor.swift");
    const keys = member(editor, "func textView(_ view: NSTextView, doCommandBy selector: Selector) -> Bool {", 8);
    expect(keys).toMatch(/case \.send:\n\s*parent\.onSend\(\)/);
    expect(editor.match(/onSend\(\)/g) ?? []).toHaveLength(1);
  });
});
