import { expect, test } from "bun:test";
import { buildConversation, publishedConversation } from "../src/conversation.ts";

const withResult = (result: string) => {
  const conversation = buildConversation("s", [
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: result }] } }),
  ], "claude");
  return publishedConversation(conversation).items.find((item) => item.tool)!.tool!.result!;
};

test("a long tool result keeps its start and its end, with the cut named", () => {
  // A failing run prints its passes first and the failure last.
  const run = `${"(pass) a test that passed\n".repeat(100)}error: expect(received).toBe(expected)\n 1 fail`;
  const published = withResult(run);
  expect(published.startsWith("(pass) a test that passed")).toBe(true);
  expect(published.endsWith("1 fail")).toBe(true);
  expect(published).toContain(`… ${run.length - 400} characters cut …`);
  // Still at or over the apps' 400-character cap, so they offer the whole of it.
  expect(published.length).toBeGreaterThanOrEqual(400);
});

test("a short result is untouched", () => {
  expect(withResult("ok")).toBe("ok");
});
