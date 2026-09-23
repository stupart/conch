import { expect, test } from "bun:test";
import { buildConversation } from "../src/conversation.ts";

/** A message sent while a Claude Code session is busy, as its transcript records it (measured 2026-09-23). */
const queued = (prompt: unknown, kind = "human", source = "762e40f7") => JSON.stringify({
  type: "attachment",
  uuid: `att-${source}`,
  attachment: {
    type: "queued_command", commandMode: "prompt", origin: { kind }, prompt,
    source_uuid: source, timestamp: "2026-09-23T04:49:32.715Z",
  },
});
const rows = (...lines: string[]) => {
  const conversation = buildConversation("s", lines, "claude");
  return conversation.order.map((id) => [conversation.items[id]!.kind, conversation.items[id]!.text]);
};

test("a message sent while the session was busy is Tyler's message", () => {
  expect(rows(queued("actually keep the space it occupied"))).toEqual([["user", "actually keep the space it occupied"]]);
});

test("one with an image keeps its words", () => {
  expect(rows(queued([{ type: "text", text: "[Image #10] look at this" }, { type: "image", source: { data: "…" } }], "human", "x2")))
    .toEqual([["user", "[Image #10] look at this"]]);
});

test("a task notification queued the same way is not Tyler's", () => {
  expect(rows(queued("<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>", "task-notification", "x3")))
    .toEqual([]);
});

test("the same queued message read twice is one row", () => {
  expect(rows(queued("once"), queued("once"))).toEqual([["user", "once"]]);
});
