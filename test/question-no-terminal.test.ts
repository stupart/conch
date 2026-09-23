import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string): string => readFileSync(join(import.meta.dir, "..", path), "utf8");

/** Present first, so a renamed marker fails here instead of passing a later `not.toContain`. */
function sliceFrom(source: string, marker: string, end: string): string {
  const at = source.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const stop = source.indexOf(end, at);
  expect(stop).toBeGreaterThan(at);
  return source.slice(at, stop);
}

/**
 * PR #183 turned off send, stop and close on a row conch cannot type into
 * (`noTerminal`: a closed or app-server Codex thread, a background job with no
 * window). A question card's options, "Something else…" and multi-select
 * Submit were missed: they still sent text, then failed with an error. They go
 * dead on those rows now and say why, with "Open in Terminal" when the row is
 * `attachable`. A background Claude job WITH a window has no `noTerminal`
 * (PR #188), so nothing here touches it.
 */
test("the Mac question card goes dead on a row with no terminal and says why", () => {
  const mac = read("mac-app/conch-mac/ConversationStackView.swift");
  expect(mac).toContain("var noTerminal: String? = nil");
  expect(mac).toContain("var onOpenInTerminal: (() -> Void)? = nil");
  const row = sliceFrom(mac, "private func questionRow(", "private func questionOption(");

  const option = sliceFrom(row, "onAnswer(option.label, [ConchQuestionAnswer(choices: [index])])", "} else {");
  expect(option).toContain(".disabled(noTerminal != nil)");

  const reason = row.indexOf("if answerable, let noTerminal {");
  const freeform = row.indexOf("Button(action: onFreeform) {");
  const submit = row.indexOf("selected.joined(separator: \", \"),");
  expect(reason).toBeGreaterThan(-1);
  expect(freeform).toBeGreaterThan(reason);
  expect(submit).toBeGreaterThan(freeform);
  const reasonBlock = row.slice(reason, freeform);
  expect(reasonBlock).toContain("Text(noTerminal)");
  expect(reasonBlock).toContain("if let onOpenInTerminal {");
  expect(reasonBlock).toContain('Label("Open in Terminal", systemImage: "terminal")');
  expect(row.slice(freeform, submit)).toContain(".disabled(noTerminal != nil)");
  expect(row.slice(submit)).toContain(".disabled(selected.isEmpty || noTerminal != nil)");

  const dashboard = read("mac-app/conch-mac/DashboardView.swift");
  const stack = sliceFrom(dashboard, "ConversationStackView(", ".frame(maxWidth: .infinity, maxHeight: .infinity)");
  expect(stack).toContain("noTerminal: row.noTerminal,");
  expect(stack).toContain("onOpenInTerminal: row.attachable ? { store.openInTerminal(row) } : nil");
});

test("the phone question card goes dead on a row with no terminal and says why", () => {
  const phone = read("mobile/conch-ios/conch-ios/ConversationStack.swift");
  expect(phone).toContain("var noTerminal: String? = nil");
  expect(phone).toContain("var onOpenInTerminal: (() -> Void)? = nil");
  const row = sliceFrom(phone, "private func questionRow(", "private var noTerminalReason: some View {");

  expect(row).toContain(".disabled(!isActive || optionReplyInFlight || option.label.isEmpty || noTerminal != nil)");
  const reason = row.indexOf("if isActive, noTerminal != nil { noTerminalReason }");
  const freeform = row.indexOf("Button(action: onFreeform) {");
  const submit = row.indexOf("selected.joined(separator: \", \"),");
  expect(reason).toBeGreaterThan(-1);
  expect(freeform).toBeGreaterThan(reason);
  expect(submit).toBeGreaterThan(freeform);
  expect(row.slice(freeform, submit)).toContain(".disabled(noTerminal != nil)");
  expect(row.slice(submit)).toContain(".disabled(selected.isEmpty || optionReplyInFlight || noTerminal != nil)");
  // Several questions at once: the reason once, and Submit and each typed answer dead too.
  expect(row).toContain(".disabled(optionReplyInFlight || noTerminal != nil)");
  const card = sliceFrom(phone, "private func questionCard(", "private func questionRow(");
  expect(card).toContain("if noTerminal != nil { noTerminalReason }");
  expect(card).toContain(".disabled(filled == nil || optionReplyInFlight || noTerminal != nil)");
  const reasonBlock = sliceFrom(phone, "private var noTerminalReason: some View {", "private func setAnswers(");
  expect(reasonBlock).toContain("Text(noTerminal)");
  expect(reasonBlock).toContain("if let onOpenInTerminal {");
  expect(reasonBlock).toContain('Label("Open in Terminal", systemImage: "terminal")');

  const session = read("mobile/conch-ios/conch-ios/SessionView.swift");
  const stack = sliceFrom(session, "ConversationStack(", "} else if let replyText {");
  expect(stack).toContain("noTerminal: row?.noTerminal,");
  expect(stack).toContain("onOpenInTerminal: row?.attachable == true ? openInTerminal : nil");
  // The one door every option and Submit reaches refuses too.
  expect(session).toContain("guard !summary.isEmpty, !answers.isEmpty, !optionReplyInFlight, row?.noTerminal == nil else { return }");
});
