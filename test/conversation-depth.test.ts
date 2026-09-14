import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConversationTail } from "../src/conversation.ts";

const dir = mkdtempSync(join(tmpdir(), "conch-depth-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: "2026-09-14T06:00:00Z", type, payload });

function said(conversation: Awaited<ReturnType<typeof readConversationTail>>): string[] {
  return conversation.order
    .map((key) => conversation.items[key]!)
    .filter((item) => item.kind === "user" || item.kind === "assistant")
    .map((item) => item.text ?? "");
}

/**
 * Tyler's "Asset Generator" Codex session looked hours out of date: its 243 MB rollout ended in megabyte-long event
 * lines, and the last 512 KB held three tool calls and nothing said. A read that finds too little now reaches back.
 */
test("a transcript whose tail is all tool noise is read further back until there is a conversation to show", async () => {
  const path = join(dir, "rollout-2026-09-14T06-00-00-0000aaaa-bbbb-cccc-dddd-eeeeffff0000.jsonl");
  const lines: string[] = [];
  for (let turn = 0; turn < 4; turn++) {
    lines.push(line("event_msg", { type: "user_message", message: `make logo ${turn}` }));
    lines.push(line("event_msg", { type: "agent_message", message: `made logo ${turn}` }));
  }
  // One event bigger than the whole default window, as an image result is, then a few small tool calls.
  lines.push(line("event_msg", { type: "item_completed", item: "x".repeat(700 * 1024) }));
  for (let call = 0; call < 3; call++) {
    lines.push(line("response_item", { type: "function_call", id: `call-${call}`, name: "shell", arguments: "{}" }));
  }
  writeFileSync(path, lines.join("\n") + "\n");

  // The old fixed read: nothing said.
  const shallow = await readConversationTail(path, "s", "codex", { tailBytes: 512 * 1024 });
  expect(said(shallow)).toEqual([]);

  // The default read reaches back past the big line to what was said.
  const deep = await readConversationTail(path, "s", "codex");
  expect(said(deep)).toEqual([
    "make logo 0", "made logo 0", "make logo 1", "made logo 1",
    "make logo 2", "made logo 2", "make logo 3", "made logo 3",
  ]);
  // And again from the remembered depth, the same answer.
  expect(said(await readConversationTail(path, "s", "codex"))).toEqual(said(deep));
});

test("a transcript with enough said in its tail is read no deeper, and a small one is read whole", async () => {
  const path = join(dir, "rollout-2026-09-14T06-00-01-0000aaaa-bbbb-cccc-dddd-eeeeffff0001.jsonl");
  const lines = [line("event_msg", { type: "user_message", message: "early" })];
  lines.push(line("event_msg", { type: "item_completed", item: "y".repeat(700 * 1024) }));
  for (let turn = 0; turn < 4; turn++) {
    lines.push(line("event_msg", { type: "user_message", message: `ask ${turn}` }));
    lines.push(line("event_msg", { type: "agent_message", message: `answer ${turn}` }));
  }
  writeFileSync(path, lines.join("\n") + "\n");
  // Eight messages in the last 512 KB: that is enough, so "early", behind the big line, is not reached for.
  expect(said(await readConversationTail(path, "t", "codex"))).not.toContain("early");

  const small = join(dir, "rollout-2026-09-14T06-00-02-0000aaaa-bbbb-cccc-dddd-eeeeffff0002.jsonl");
  writeFileSync(small, line("event_msg", { type: "user_message", message: "only this" }) + "\n");
  expect(said(await readConversationTail(small, "u", "codex"))).toEqual(["only this"]);
});
