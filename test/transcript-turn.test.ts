import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentTurnText } from "../src/transcript-turn.ts";

const write = (lines: unknown[]): string => {
  const path = join(mkdtempSync(join(tmpdir(), "conch-turn-")), "t.jsonl");
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
