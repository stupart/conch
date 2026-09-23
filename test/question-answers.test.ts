import { describe, expect, test } from "bun:test";
import { claudeQuestionKeys, type AnswerKey } from "../src/agent-adapter.ts";
import { validateSocketTurnEvent } from "../src/control-server.ts";
import {
  agentQuestion,
  agentQuestions,
  buildConversation,
  latestAnswerableQuestions,
  textQuestionAnswers,
  type AgentQuestion,
} from "../src/conversation.ts";
import { ANSWER_KEY_GAP_MS, injectKeys, PASTE_OVER_CHARS, type OsaRunner } from "../src/inject.ts";
import type { Config } from "../src/config.ts";

/**
 * Every key sequence below is one measured on Claude Code 2.1.280, by driving
 * a real session's AskUserQuestion picker in a pseudo-terminal and reading the
 * answer it recorded (2026-09-23). The recorded answer is in each comment.
 */
const q = (header: string, labels: string[], multiSelect = false): AgentQuestion => ({
  header,
  question: `Pick ${header.toLowerCase()}?`,
  options: labels.map((label) => ({ label })),
  multiSelect,
});
const alpha = q("Alpha", ["A1", "A2", "A3"]);
const beta = q("Beta", ["B1", "B2"]);
const gamma = q("Gamma", ["G1", "G2", "G3"], true);
const delta = q("Delta", ["D1", "D2"]);

describe("Claude Code's picker keys", () => {
  test("two questions: each number picks and moves on, then 1 submits on the review screen", () => {
    // "Pick alpha?"="A2", "Pick beta?"="B1"
    expect(claudeQuestionKeys([alpha, beta], [{ choices: [1] }, { choices: [0] }]))
      .toEqual([{ press: "2" }, { press: "1" }, { press: "1" }]);
  });

  test("words of your own: the number after the last option, the words, Return", () => {
    // "Pick alpha?"="hello world", "Pick beta?"="B2"
    expect(claudeQuestionKeys([alpha, beta], [{ text: "hello world" }, { choices: [1] }]))
      .toEqual([{ press: "4" }, { type: "hello world" }, "Enter", { press: "2" }, { press: "1" }]);
  });

  test("a lone single-choice question submits on its number, with no review screen", () => {
    // "Pick delta?"="D2"; and typed, "Pick delta?"="my own words"
    expect(claudeQuestionKeys([delta], [{ choices: [1] }])).toEqual([{ press: "2" }]);
    expect(claudeQuestionKeys([delta], [{ text: "my own words" }]))
      .toEqual([{ press: "3" }, { type: "my own words" }, "Enter"]);
  });

  test("multi-select: numbers toggle, → moves on, and even alone it ends on the review screen", () => {
    // "Pick gammas?"="G1, G3"; and with a second question, "G1, G3" and "D2"
    expect(claudeQuestionKeys([gamma], [{ choices: [0, 2] }]))
      .toEqual([{ press: "1" }, { press: "3" }, "Right", { press: "1" }]);
    expect(claudeQuestionKeys([gamma, delta], [{ choices: [0, 2] }, { choices: [1] }]))
      .toEqual([{ press: "1" }, { press: "3" }, "Right", { press: "2" }, { press: "1" }]);
  });

  test("answers that don't fit the questions are refused, not typed", () => {
    for (const answers of [
      [{ choices: [1] }],                                // one answer for two questions
      [{ choices: [3] }, { choices: [0] }],              // no fourth option
      [{ choices: [0, 1] }, { choices: [0] }],           // two picks for a single-choice question
      [{ choices: [-1] }, { choices: [0] }],
    ]) expect(typeof claudeQuestionKeys([alpha, beta], answers)).toBe("string");
    expect(typeof claudeQuestionKeys([gamma], [{ text: "words" }])).toBe("string");
    expect(typeof claudeQuestionKeys([], [])).toBe("string");
  });
});

describe("every question in a call", () => {
  const input = { questions: [alpha, beta].map(({ header, question, options, multiSelect }) => ({ header, question, options, multiSelect })) };

  test("is read, in order; the first is still the one a voice reads", () => {
    expect(agentQuestions(input).map(({ header }) => header)).toEqual(["Alpha", "Beta"]);
    expect(agentQuestion(input)?.header).toBe("Alpha");
  });

  test("one malformed question voids the call rather than shifting every later answer", () => {
    expect(agentQuestions({ questions: [input.questions[0], { header: "Broken", options: [] }] })).toEqual([]);
  });

  test("the transcript row carries them all, and the pending lookup returns them all", () => {
    const conversation = buildConversation("s1", [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "ask me" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu_ask", name: "AskUserQuestion", input }] } }),
    ], "claude");
    const row = Object.values(conversation.items).find((item) => item.question)!;
    expect(row.questions?.map(({ header }) => header)).toEqual(["Alpha", "Beta"]);
    expect(latestAnswerableQuestions(conversation).map(({ header }) => header)).toEqual(["Alpha", "Beta"]);
  });

  test("a single question keeps the old shape: no `questions` field", () => {
    const conversation = buildConversation("s1", [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "AskUserQuestion", input: { questions: [input.questions[0]] } }] } }),
    ], "claude");
    expect(Object.values(conversation.items).find((item) => item.question)?.questions).toBeUndefined();
  });
});

describe("words sent to a session that is waiting on a question", () => {
  test("name an option, case aside, or are words of your own on one line", () => {
    expect(textQuestionAnswers([delta], "  d2 ")).toEqual([{ choices: [1] }]);
    expect(textQuestionAnswers([delta], "neither,\nsomething else")).toEqual([{ text: "neither, something else" }]);
  });

  test("a multi-select question takes its options, comma-separated, and nothing else", () => {
    expect(textQuestionAnswers([gamma], "G3, g1")).toEqual([{ choices: [2, 0] }]);
    expect(typeof textQuestionAnswers([gamma], "G3 and my own idea")).toBe("string");
  });

  test("several questions at once cannot be answered by words: which one would they be for?", () => {
    expect(textQuestionAnswers([alpha, beta], "A2")).toContain("asking 2 questions at once");
  });
});

describe("the answers field on the socket", () => {
  const event = (answers: unknown, type = "inject") => validateSocketTurnEvent({
    type, sessionId: "s1", label: "alpha", announce: "A2", answers,
  });

  test("an inject may carry choices or words per question", () => {
    expect(event([{ choices: [1] }, { text: "my own words" }]).ok).toBe(true);
  });

  test("anything else is refused before it can reach a keyboard", () => {
    for (const bad of [
      [], "A2", [{}], [{ choices: [1], text: "both" }], [{ choices: [] }], [{ choices: [8] }],
      [{ choices: [1, 1] }], [{ choices: [1.5] }], [{ text: "" }], [{ text: "two\nlines" }],
      [{ text: "x".repeat(4001) }], Array.from({ length: 9 }, () => ({ choices: [0] })),
    ]) expect(event(bad).ok).toBe(false);
    expect(event([{ choices: [0] }], "wake").ok).toBe(false);
  });
});

describe("typing the keys", () => {
  const cfg = { keystrokeFallback: true } as Config;
  const keys: AnswerKey[] = [{ press: "4" }, { type: "hello world" }, "Enter", { press: "2" }, "Right", { press: "1" }];

  test("tmux: each key in order, literal except the named ones, with a gap between", async () => {
    const sent: Array<[string, boolean]> = [];
    const slept: number[] = [];
    const result = await injectKeys(cfg, 4242, keys, undefined, {
      findTmuxPane: async () => "%1",
      sendTmuxKeys: async (_pane, text, literal) => { sent.push([text, literal]); return { exitCode: 0 }; },
      sleep: async (ms) => void slept.push(ms),
    });
    expect(result).toEqual({ via: "tmux" });
    expect(sent).toEqual([["4", true], ["hello world", true], ["Enter", false], ["2", true], ["Right", false], ["1", true]]);
    expect(slept).toEqual(Array(keys.length - 1).fill(ANSWER_KEY_GAP_MS));
  });

  test("Terminal: one script, the focus guard before every key after the first", async () => {
    const scripts: Array<{ lines: string[]; argv: string[] }> = [];
    const osa: OsaRunner = async (lines, argv = []) => {
      scripts.push({ lines, argv });
      return { text: "ok", timedOut: false, exitCode: 0 };
    };
    const result = await injectKeys(cfg, 4242, keys, undefined, {
      osa, findTmuxPane: async () => null, ttyForPid: async () => "ttys007", sleep: async () => {},
    });
    expect(result).toEqual({ via: "osascript-focused" });
    const typing = scripts.at(-1)!;
    expect(typing.argv).toEqual(["4", "hello world", "2", "1", "/dev/ttys007"]);
    const script = typing.lines.join("\n");
    expect(script.match(/-- conch-focus-guard/g)?.length).toBe(keys.length);
    expect(script).toContain('keystroke (item 2 of argv)');
    expect(script).toContain("key code 36");
    expect(script).toContain("key code 124");
  });

  test("words too long to type are pasted in a step of their own, and the clipboard put back", async () => {
    const long = "x".repeat(PASTE_OVER_CHARS + 1);
    const scripts: string[][] = [];
    const leases: string[] = [];
    let restored = 0;
    const result = await injectKeys(cfg, 4242, [{ press: "3" }, { type: long }, "Enter"], undefined, {
      osa: async (lines) => { scripts.push(lines); return { text: "ok", timedOut: false, exitCode: 0 }; },
      findTmuxPane: async () => null, ttyForPid: async () => "ttys007", sleep: async () => {},
      pasteboard: {
        prepare: async (text) => { leases.push(text); return { changeCount: 7, items: [] }; },
        restore: async () => { restored += 1; return true; },
      },
    });
    expect(result).toEqual({ via: "osascript-focused" });
    expect(leases).toEqual([long]);
    expect(restored).toBe(1);
    // focus, then: the number, the paste, Return — three guarded steps.
    expect(scripts.length).toBe(4);
    expect(scripts[2]!.join("\n")).toContain('keystroke "v" using command down');
  });

  test("a window that comes to the front partway stops the rest", async () => {
    let calls = 0;
    const result = await injectKeys(cfg, 4242, keys, undefined, {
      osa: async () => (++calls === 1 ? { text: "ok", timedOut: false, exitCode: 0 } : { text: "front-window-changed", timedOut: false, exitCode: 0 }),
      findTmuxPane: async () => null, ttyForPid: async () => "ttys007", sleep: async () => {},
    });
    expect(result).toMatchObject({ failed: true, reason: "front-window-changed" });
  });
});

describe("the Mac question card, as source (conch-mac has no XCTest target)", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const stack = readFileSync(`${import.meta.dir}/../mac-app/conch-mac/ConversationStackView.swift`, "utf8");
  const between = (from: string, to: string) => {
    const start = stack.indexOf(from);
    expect(start).toBeGreaterThan(-1);
    const slice = stack.slice(start, stack.indexOf(to, start + from.length));
    expect(slice.length).toBeGreaterThan(200);
    return slice;
  };

  test("a question row renders every question the call asked", () => {
    const tool = between("case .tool:", "} else if let plan = item.plan");
    expect(tool).toContain("let questions = item.allQuestions");
    expect(tool).toContain("answeredSummary(questions, result: item.tool?.result)");
    expect(tool).toContain("questionCard(");
  });

  test("several questions: each is filled in, and one Submit sends every answer in order", () => {
    const card = between("private func questionCard(", "private func setAnswers(");
    expect(card).toContain('questionRow(asked, questionID: "\\(itemID)#\\(index)", answerable: answerable, inSet: true)');
    expect(card).toContain("if let filled { onAnswer(filled.summary, filled.answers) }");
    expect(card).toContain(".disabled(filled == nil || noTerminal != nil)");
  });

  test("in a set, a pick is held for Submit and never sent on its own", () => {
    const row = between("    private func questionRow(", "private func questionOption(");
    const held = row.slice(row.indexOf("} else if inSet {"), row.indexOf("} else {", row.indexOf("} else if inSet {")));
    expect(held).toContain("multiSelections[questionID] = [option.label]");
    expect(held).not.toContain("onAnswer(");
  });

  test("Submit waits for an answer to every question; typed words win over a pick", () => {
    const answers = between("private func setAnswers(", "private func toolRow(");
    expect(answers.indexOf("if !typed.isEmpty {")).toBeLessThan(answers.indexOf("} else if !picked.isEmpty {"));
    expect(answers).toMatch(/\} else \{\s*return nil\s*\}/);
  });

  test("an answered set collapses to each question's own recorded answer", () => {
    const summary = between("private func answeredSummary(", "private func questionCard(");
    expect(summary).toContain("QuestionOutcome.answers(to: questions.map(\\.question), in: result)");
  });
});

describe("the phone question card, as source (conch-ios has no XCTest target)", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const read = (name: string) => readFileSync(`${import.meta.dir}/../mobile/conch-ios/conch-ios/${name}`, "utf8");
  const stack = read("ConversationStack.swift");
  const between = (source: string, from: string, to: string) => {
    const start = source.indexOf(from);
    expect(start).toBeGreaterThan(-1);
    const slice = source.slice(start, source.indexOf(to, start + from.length));
    expect(slice.length).toBeGreaterThan(200);
    return slice;
  };

  test("the phone decodes every question in the call", () => {
    const models = read("Models.swift");
    expect(models).toContain("questions = try? c.decodeIfPresent([AgentQuestion].self, forKey: .questions)");
    expect(models).toContain("var allQuestions: [AgentQuestion] { questions ?? question.map { [$0] } ?? [] }");
  });

  test("a question row renders every question the call asked", () => {
    const tool = between(stack, 'case "tool":', "} else if let plan = item.plan");
    expect(tool).toContain("let questions = item.allQuestions");
    expect(tool).toContain("questionCard(");
  });

  test("several questions: each is filled in, and one Submit sends every answer in order", () => {
    const card = between(stack, "private func questionCard(", "private func questionRow(");
    expect(card).toContain('questionID: inSet ? "\\(itemID)#\\(index)" : itemID,');
    expect(card).toContain("if let filled { onAnswer(filled.summary, filled.answers, itemID) }");
  });

  test("in a set, a pick is held for Submit and never sent on its own", () => {
    const row = between(stack, "    private func questionRow(", "private var noTerminalReason: some View {");
    const from = row.indexOf("} else if inSet {");
    expect(from).toBeGreaterThan(-1);
    const held = row.slice(from, row.indexOf("} else {", from));
    expect(held).toContain("multiSelections[questionID] = [option.label]");
    expect(held).not.toContain("onAnswer(");
  });

  test("Submit waits for an answer to every question; typed words win over a pick", () => {
    const answers = between(stack, "private func setAnswers(", "/// The collapsed question:");
    expect(answers.indexOf("if !typed.isEmpty {")).toBeLessThan(answers.indexOf("} else if !picked.isEmpty {"));
    expect(answers).toContain("answers.append(QuestionAnswer(text: typed))");
    expect(answers).toContain("answers.append(QuestionAnswer(choices: picked))");
    expect(answers).toMatch(/\} else \{\s*return nil\s*\}/);
  });

  test("the answers cross the wire as `answers`, the words only as the summary", () => {
    expect(read("Models.swift")).toContain('var wire: [String: Any] { choices.map { ["choices": $0] } ?? ["text": text ?? ""] }');
    const inject = between(read("BridgeClient.swift"), "    func inject(", "private func deliveryOutcome(");
    expect(inject).toContain('if let answers { payload["answers"] = answers.map(\\.wire) }');
    const session = read("SessionView.swift");
    const answer = between(session, "private func answerQuestion(", "private func approve(");
    expect(answer).toMatch(/text: summary,\s*answers: answers/);
  });
});
