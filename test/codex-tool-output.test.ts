import { describe, expect, test } from "bun:test";
import { buildConversation } from "../src/conversation.ts";

/** Tool output as current Codex rollouts write it, measured on Tyler's 2026-09-23 threads. */
const line = (value: unknown) => JSON.stringify(value);
const call = (id: string) => line({ type: "response_item", payload: { type: "custom_tool_call", call_id: id, name: "exec", input: "await tools.exec_command({cmd: 'git status'})" } });
const out = (id: string, output: unknown) => line({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output } });
const tool = (lines: string[]) => {
  const conversation = buildConversation("s", lines, "codex");
  return conversation.items["tool:c1"]!.tool!;
};

describe("a Codex tool row says what the tool returned", () => {
  test("output written as a list of parts is read, not dropped", () => {
    const result = tool([call("c1"), out("c1", [
      { type: "input_text", text: "Script completed\nWall time 0.5 seconds\nOutput:\n" },
      { type: "input_text", text: " M packages/app.ts\n" },
    ])]);
    expect(result).toMatchObject({ status: "done", result: "Script completed\nWall time 0.5 seconds\nOutput:\n M packages/app.ts\n" });
  });

  test("an image part is a marker, never its base64", () => {
    const result = tool([call("c1"), out("c1", [
      { type: "input_text", text: "Script completed\nOutput:\n" },
      { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo" },
    ])]);
    expect(result.result).toBe("Script completed\nOutput:\n[image]");
  });

  test("a script that failed, or that Tyler aborted, is an error", () => {
    expect(tool([call("c1"), out("c1", [{ type: "input_text", text: "Script failed\nError: exit 1" }])]).status).toBe("error");
    expect(tool([call("c1"), out("c1", "aborted by user after 24.5s")]).status).toBe("error");
    expect(tool([call("c1"), out("c1", { content: "fine", success: false })]).status).toBe("error");
  });

  test("the older shapes still read", () => {
    expect(tool([call("c1"), out("c1", "plain text")]).result).toBe("plain text");
    expect(tool([call("c1"), out("c1", { content: "wrapped" })]).result).toBe("wrapped");
  });
});
