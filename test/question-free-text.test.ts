import { expect, test } from "bun:test";
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
