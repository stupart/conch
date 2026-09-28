import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeQuestionKeys } from "../src/agent-adapter.ts";
import { validateSocketTurnEvent } from "../src/control-server.ts";
import type { AgentQuestion, QuestionAnswer } from "../src/conversation.ts";

/**
 * "Something else…" on a question, from either app, as far as the keys the picker takes.
 *
 * Tyler's typed answer to a multi-select question ("Ship tonight") failed twice from the phone
 * on 2026-09-28: the daemon took only option names for a multi-select question, and the phone
 * showed a bare "Not delivered." Claude Code's picker offers "Type something" there too, and
 * records ticked options beside the words ("G1, G3, plus my words"; measured in a tmux lab).
 */
const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const mac = read("mac-app/conch-mac/ConversationStackView.swift");
const phone = read("mobile/conch-ios/conch-ios/ConversationStack.swift");

const gamma: AgentQuestion = {
  header: "Gamma", question: "Pick gammas?", multiSelect: true,
  options: [{ label: "G1" }, { label: "G2" }, { label: "G3" }],
};

/** One struct's whole source, from its declaration to the brace that closes it at column 0. */
function structSource(source: string, declaration: string): string {
  const at = source.indexOf(declaration);
  expect(at, `missing: ${declaration}`).toBeGreaterThan(-1);
  return source.slice(at, source.indexOf("\n}\n", at) + 3);
}

test("each app's own answer type puts ticks and words on the wire, and the daemon types the measured keys", async () => {
  // The real declarations, compiled: the Mac's Encodable answer and the phone's `wire`.
  const macAnswer = structSource(read("mac-app/conch-mac/ConchSocketClient.swift"), "struct ConchQuestionAnswer:");
  const phoneAnswer = structSource(read("mobile/conch-ios/conch-ios/Models.swift"), "struct QuestionAnswer:");
  const dir = mkdtempSync(join(tmpdir(), "conch-free-text-swift-"));
  try {
    const main = join(dir, "main.swift"), binary = join(dir, "answers");
    writeFileSync(main, `import Foundation
${macAnswer}
${phoneAnswer}
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
func line(_ value: Any) -> String {
    String(data: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
}
let mac: [ConchQuestionAnswer] = [
    ConchQuestionAnswer(choices: [0, 2], text: "plus my words"),
    ConchQuestionAnswer(text: "words alone"),
    ConchQuestionAnswer(choices: [1]),
]
print(String(data: try! encoder.encode(mac), encoding: .utf8)!)
let phone: [QuestionAnswer] = [
    QuestionAnswer(choices: [0, 2], text: "plus my words"),
    QuestionAnswer(text: "words alone"),
    QuestionAnswer(choices: [1]),
]
print(line(phone.map(\\.wire)))
`);
    const compiler = Bun.spawn(["swiftc", main, "-o", binary], { stdout: "pipe", stderr: "pipe" });
    const diagnostics = await new Response(compiler.stderr).text();
    expect(await compiler.exited, diagnostics).toBe(0);
    const program = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" });
    expect(await program.exited).toBe(0);
    const [macLine, phoneLine] = (await new Response(program.stdout).text()).trim().split("\n");
    const expected = [{ choices: [0, 2], text: "plus my words" }, { text: "words alone" }, { choices: [1] }];
    for (const wire of [JSON.parse(macLine!), JSON.parse(phoneLine!)]) {
      expect(wire).toEqual(expected);
      // Accepted at the socket, each answer alone for a lone multi-select question...
      for (const answer of wire) {
        const event = validateSocketTurnEvent({ type: "inject", sessionId: "s1", label: "alpha", announce: "x", answers: [answer], questionId: "tool:tu_ask" });
        expect(event.ok).toBe(true);
      }
      // ...and typed as the keys measured on the real picker.
      expect(claudeQuestionKeys([gamma], [wire[0] as QuestionAnswer])).toEqual([
        { press: "1" }, { press: "3" }, "Down", "Down", "Down", { type: "plus my words" }, "Down", "Enter", { press: "1" },
      ]);
      expect(claudeQuestionKeys([gamma], [wire[1] as QuestionAnswer])).toEqual([
        "Down", "Down", "Down", { type: "words alone" }, "Down", "Enter", { press: "1" },
      ]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 300_000);

describe("a settled question card is a record, not controls", () => {
  const between = (source: string, from: string, to: string) => {
    const start = source.indexOf(from);
    expect(start, `missing: ${from}`).toBeGreaterThan(-1);
    const end = source.indexOf(to, start + from.length);
    expect(end, `missing after ${from}: ${to}`).toBeGreaterThan(start);
    return source.slice(start, end);
  };

  test("Mac: no button, no hover, no hit shape; what was chosen stays marked and the rest dim", () => {
    const row = between(mac, "    private func questionRow(", "    private func multiAnswer(");
    const settled = between(row, "                } else {\n                    // Settled", "            if answerable, let noTerminal {");
    expect(settled).not.toContain("Button");
    expect(settled).not.toContain(".onHover");
    expect(settled).not.toContain(".contentShape");
    expect(settled).toContain("questionOption(option, multiSelect: asked.multiSelect, selected: picked, live: false)");
    expect(settled).toContain(".opacity(picked ? 1 : 0.45)");
    expect(settled).toContain("let picked = chosen.contains(option.label)");
    // The pointer is tracked only where it can do something: the modifier adds hover and the
    // hit shape on a live option, and nothing at all on a settled one.
    const hover = between(mac, "private struct OptionHover: ViewModifier {", "/// What one row is drawn from");
    expect(hover).toMatch(/if live \{\s*content\s*\.contentShape\(Rectangle\(\)\)\s*\.onHover \{/);
    expect(hover).toMatch(/\} else \{\s*content\s*\}/);
    const option = between(mac, "    private func questionOption(", "    private func toggleSelection(");
    expect(option).not.toContain(".onHover");
    expect(option).toContain('(selected && !live ? "checkmark.circle.fill" : "circle")');
    // Only the live card is a form, by the daemon's rule, and only it redraws for the pointer.
    expect(mac).toContain("let live = item.id == liveQuestionID");
    expect(mac).toContain("hovered: live ? hoveredOption : nil");
    expect(mac).toContain("isRunningQuestion: { $0.question != nil && $0.tool?.status == \"running\" }");
  });

  test("iPhone: no button and no raised ground; what was chosen stays marked and the rest dim", () => {
    const row = between(phone, "    private func questionRow(", "    private func optionLabel(");
    const settled = between(row, "                } else {\n                    // Settled", "            if isActive, !inSet, noTerminal != nil");
    expect(settled).not.toContain("Button");
    expect(settled).toContain("optionLabel(option, multiSelect: asked.multiSelect, selected: picked, live: false)");
    expect(settled).toContain(".opacity(picked ? 1 : 0.45)");
    const label = between(phone, "    private func optionLabel(", "    private func multiAnswer(");
    expect(label).toContain("selected ? Palette.needs.opacity(0.10) : (live ? Palette.raised : Color.clear)");
    expect(label).toContain('(selected ? (live ? "largecircle.fill.circle" : "checkmark.circle.fill") : "circle")');
    expect(phone).toContain("let live = item.id == liveQuestionID");
    expect(phone).toContain("isRunningQuestion: { $0.question != nil && $0.tool?.status == \"running\" }");
  });
});

describe("\"Something else…\" sends the right event from each surface", () => {
  test("a lone single-choice question points at the composer; its words reach the daemon as a plain message", () => {
    // The composer's words go as text; the daemon answers the waiting question with them
    // (`textQuestionAnswers`, tested in question-answers and voice-loop).
    expect(read("mac-app/conch-mac/DashboardView.swift")).toContain("onFreeform: { composerFocusRequest += 1 }");
    expect(read("mobile/conch-ios/conch-ios/SessionView.swift")).toContain("onFreeform: { typing = true }");
  });

  test("a multi-select question takes its words on the card, sent with its ticks as one answer", () => {
    const macMulti = mac.slice(mac.indexOf("    private func multiAnswer("), mac.indexOf("    private func questionOption("));
    expect(macMulti).toContain("ConchQuestionAnswer(choices: picked.isEmpty ? nil : picked, text: typed.isEmpty ? nil : typed)");
    expect(macMulti).toContain("guard !picked.isEmpty || !typed.isEmpty else { return nil }");
    const phoneMulti = phone.slice(phone.indexOf("    private func multiAnswer("));
    expect(phoneMulti).toContain("QuestionAnswer(choices: picked.isEmpty ? nil : picked, text: typed.isEmpty ? nil : typed)");
    expect(phoneMulti).toContain("guard !picked.isEmpty || !typed.isEmpty else { return nil }");
    // Typing on a multi-select question keeps its ticks; on a single-choice one the words replace the pick.
    for (const source of [mac, phone]) {
      expect(source).toContain("if !typed.isEmpty && !asked.multiSelect { multiSelections[questionID] = nil }");
      expect(source).toContain("if asked.multiSelect, !picked.isEmpty, !typed.isEmpty {");
    }
  });
});
