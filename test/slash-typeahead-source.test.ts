import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The slash typeahead in both composers (2026-11-04, Tyler: "can u get me access to slash commands on the mobile app
 * and desktop app?"). When it shows, what it lists and what choosing does are `SlashTypeahead` in ConchDesign, tested
 * there; neither app has a test target for its views, so the wiring is pinned here: both draw the shared list from the
 * shared rules, both offer it only where a command can be typed, and neither sends on a choice.
 */
const root = join(import.meta.dir, "..");
// Line comments ignored, so a description of a site cannot satisfy a guard.
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/^\s*\/\/.*$/gm, "");
const mac = read("mac-app/conch-mac/ComposerView.swift");
const editor = read("mac-app/conch-mac/ComposerEditor.swift");
const phone = read("mobile/conch-ios/conch-ios/SessionView.swift");

function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  expect(a, `missing: ${start}`).toBeGreaterThan(-1);
  const b = text.indexOf(end, a + start.length);
  expect(b, `missing: ${end}`).toBeGreaterThan(-1);
  return text.slice(a, b);
}

describe("the Mac composer", () => {
  test("draws the shared list from the shared rules, over the session's whole catalog", () => {
    expect(mac).toContain("@State private var typeahead = SlashTypeahead()");
    const list = between(mac, "SlashTypeaheadList(", "onChoose: choose");
    expect(list).toContain("matches: typeahead.matches,");
    expect(list).toContain("selected: typeahead.selected,");
    // The floating input's glass has wider corners than the window's card.
    expect(list).toContain("surface: chrome == .panel ? .glass : .card,");
    expect(mac).toContain("AgentCommands.all(for: backend, capabilities: commandRead?.session == sessionID ? commandRead?.capabilities : nil)");
    expect(mac).toContain("typeahead.update(draft: draft, caret: caret)");
  });

  test("only where a command can be typed: a session's own reachable pane with a terminal, and no dictation", () => {
    expect(mac).toContain("commandCapabilities: row.parentSessionId == nil && row.revealable && row.noTerminal == nil");
    expect(mac).toContain("commandCapabilities != nil && !rendersStatically && dictation == nil && messageUnavailableReason == nil");
  });

  test("the keys: arrows move, Tab and Return choose, Esc closes, and Return sends only a line already whole", () => {
    const keys = between(mac, "private func typeaheadKey(_ key: ComposerKey) -> Bool {", "private func choose(_ command: AgentCommand) {");
    expect(keys).toContain("guard typeaheadShowing else { return false }");
    expect(keys).toContain("case .up: typeahead.move(-1)");
    expect(keys).toContain("case .down: typeahead.move(1)");
    expect(keys).toContain("case .escape: typeahead.dismiss()");
    expect(keys).toContain("case .tab, .enter:");
    expect(keys).toContain("} else if key == .enter {");
    // A click fills and never sends.
    const click = between(mac, "private func choose(_ command: AgentCommand) {", "private func fill(");
    expect(click).not.toContain("send()");
  });

  test("the editor offers those keys first, never mid-composition, and only plain Return", () => {
    expect(editor).toContain("if !view.hasMarkedText(), let key = ComposerKey(selector, event: event), parent.onTypeaheadKey(key) { return true }");
    const key = between(editor, "enum ComposerKey: Equatable {", "struct ComposerCaretRequest");
    expect(key).toContain("case #selector(NSResponder.cancelOperation(_:)), #selector(NSTextView.complete(_:)): self = .escape");
    expect(key).toContain("guard flags.isEmpty else { return nil }");
    // The caret is reported, and a chosen command's is placed after the words land.
    expect(editor).toContain("func textViewDidChangeSelection(_ notification: Notification) {");
    expect(editor).toContain("coordinator.place(caret: caretRequest.at)");
  });
});

describe("the phone composer", () => {
  test("draws the same list from the same rules, a tap fills the line, and nothing is sent", () => {
    expect(phone).toContain("@State private var typeahead = SlashTypeahead()");
    expect(phone).toContain("SlashTypeaheadList(matches: typeahead.matches, selected: nil, onChoose: chooseCommand)");
    expect(phone).toContain("typeahead.setCatalog(AgentCommands.all(for: row?.backend, capabilities: commandRead))");
    const choose = between(phone, "private func chooseCommand(_ command: AgentCommand) {", "private var argumentPlaceholder: String? {");
    expect(choose).toContain("talk.setDraft(choice.draft, for: sessionId)");
    expect(choose).not.toContain("bridge.inject(");
    expect(choose).not.toContain("sendDraft");
  });

  test("only where a command can be typed, the Commands sheet's rule", () => {
    expect(phone).toContain("return row.parentSessionId == nil && row.revealable && row.noTerminal == nil");
  });
});
