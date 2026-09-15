import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentTurnText } from "../src/transcript-turn.ts";

const write = (lines: unknown[], name = "t.jsonl"): string => {
  const path = join(mkdtempSync(join(tmpdir(), "conch-turn-")), name);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
};

const user = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const toolResult = () => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
});
const assistant = (...parts: string[]) => ({
  type: "assistant",
  message: { role: "assistant", content: parts.map((text) => ({ type: "text", text })) },
});
const toolCall = () => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] },
});

describe("the turn in progress, as the Mac shows it", () => {
  test("collects narration ACROSS tool calls", async () => {
    // The whole reason this exists. lastAssistantText returns nothing while a
    // tool call is outstanding — right for speech, which must never announce
    // half a turn — so the phone fell back to an earlier turn's spoken
    // announce and showed one unrelated sentence.
    const path = write([
      user("do the thing"),
      assistant("Looking at it."),
      toolCall(),
      toolResult(),
      assistant("Found it — here is why."),
    ]);
    expect(await currentTurnText(path)).toBe("Looking at it.\nFound it — here is why.");
  });

  test("a genuine human turn ends the reply", async () => {
    const path = write([
      user("first question"),
      assistant("first answer"),
      user("second question"),
      assistant("second answer"),
    ]);
    expect(await currentTurnText(path)).toBe("second answer");
  });

  test("a tool result is not a human turn", async () => {
    // Claude Code records tool results as type:"user". Treating one as the
    // boundary stops the scan immediately and collects nothing — which is the
    // normal case, since most turns use a tool.
    const path = write([user("go"), assistant("narration"), toolResult()]);
    expect(await currentTurnText(path)).toBe("narration");
  });

  test("keeps only the tail of a huge transcript", async () => {
    // Real transcripts here run to 105MB and 177MB. Reading one whole would
    // be unusable on the daemon and impossible to send over cellular.
    const filler = Array.from({ length: 400 }, (_, index) => assistant(`old ${index}`.repeat(40)));
    const path = write([user("go"), ...filler, assistant("the newest words")]);
    const text = await currentTurnText(path, 4096);
    expect(text).toContain("the newest words");
    expect(text.length).toBeLessThan(4096);
  });

  test("a missing or unreadable transcript yields empty, not a throw", async () => {
    // The caller keeps its existing fallback; a display fix must never take
    // down the bridge request that was serving a real answer.
    expect(await currentTurnText("/nope/does-not-exist.jsonl")).toBe("");
  });

  test("ignores malformed lines rather than abandoning the turn", async () => {
    const path = write([user("go"), assistant("kept")]);
    writeFileSync(path, `{ not json\n${JSON.stringify(assistant("also kept"))}\n`, { flag: "a" });
    expect(await currentTurnText(path)).toContain("also kept");
  });
});

describe("the turn in progress, in a Codex rollout", () => {
  const event = (payload: Record<string, unknown>) => ({ type: "event_msg", payload });
  const item = (payload: Record<string, unknown>) => ({ type: "response_item", payload });
  const said = (role: string, text: string, phase?: string) =>
    item({ type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }], ...(phase ? { phase } : {}) });

  test("reads the turn in progress, not the previous answer", async () => {
    // Codex wraps every record in a payload envelope. The Claude scan saw no
    // assistant text in it, so the phone fell back to the last COMPLETED answer.
    const path = write([
      event({ type: "task_started", turn_id: "t1" }),
      event({ type: "user_message", message: "first question" }),
      said("user", "first question"),
      said("assistant", "The previous answer."),
      event({ type: "agent_message", message: "The previous answer." }),
      event({ type: "task_complete", turn_id: "t1", last_agent_message: "The previous answer." }),
      event({ type: "task_started", turn_id: "t2" }),
      event({ type: "user_message", message: "second question" }),
      said("user", "second question"),
      item({ type: "reasoning", summary: [] }),
      said("assistant", "Looking at it now.", "commentary"),
      item({ type: "function_call", name: "exec_command", arguments: "{}", call_id: "c1" }),
      item({ type: "function_call_output", call_id: "c1", output: "ok" }),
      said("assistant", "Found it.", "commentary"),
    ], "rollout-2026-09-16T00-00-00-abc.jsonl");
    expect(await currentTurnText(path)).toBe("Looking at it now.\nFound it.");
  });

  test("a finished Codex turn reads as its own words, once", async () => {
    // event_msg and response_item repeat the same reply; it is one block.
    const path = write([
      event({ type: "user_message", message: "go" }),
      said("user", "go"),
      said("assistant", "Done."),
      event({ type: "agent_message", message: "Done." }),
      event({ type: "task_complete", turn_id: "t1", last_agent_message: "Done." }),
    ], "rollout-2026-09-16T00-00-00-def.jsonl");
    expect(await currentTurnText(path)).toBe("Done.");
  });
});
