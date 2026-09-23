import { describe, expect, test } from "bun:test";
import { buildConversation } from "../src/conversation.ts";

/**
 * What a current Codex rollout (0.151+, "paginated") holds, measured on Tyler's
 * 2026-09-23 threads: no user_message / agent_message events; Tyler's words and Codex's
 * replies as `item_completed` UserMessage / AgentMessage (each with its turn_id), mirrored
 * in raw `response_item` messages — and that raw stream is also where Codex puts what it
 * injects: developer instructions, `<skills_instructions>`, `<turn_aborted>`, and
 * `<environment_context>` / `<recommended_plugins>` in the user role.
 */
const line = (value: unknown) => JSON.stringify(value);
const started = (turn: string) => line({ type: "event_msg", payload: { type: "task_started", turn_id: turn } });
const said = (turn: string, type: "UserMessage" | "AgentMessage", text: string, id: string, phase?: string) =>
  line({ type: "event_msg", payload: { type: "item_completed", turn_id: turn, item: { type, id, content: [{ type: type === "UserMessage" ? "text" : "Text", text }], ...(phase ? { phase } : {}) } } });
const raw = (role: string, text: string, phase?: string) =>
  line({ type: "response_item", payload: { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }], ...(phase ? { phase } : {}) } });
const rows = (lines: string[]) => {
  const conversation = buildConversation("s", lines, "codex");
  return conversation.order.map((id) => [conversation.items[id]!.kind, conversation.items[id]!.text]);
};

describe("a current Codex rollout shows what was said, once", () => {
  test("injected instructions and context never read as Tyler or as Codex", () => {
    expect(rows([
      raw("developer", "<skills_instructions> ## Skills A skill is a set of local instructions"),
      raw("user", "<recommended_plugins> Here is a list of plugins that are available"),
      raw("user", "<environment_context> <current_date>2026-09-23</current_date>"),
      started("t1"),
      raw("user", "Fix the blank region above the image"),
      said("t1", "UserMessage", "Fix the blank region above the image", "u1"),
      said("t1", "AgentMessage", "I'll trace the editor layout first.", "m1", "commentary"),
      raw("assistant", "I'll trace the editor layout first.", "commentary"),
      raw("developer", "<turn_aborted> The previous turn was interrupted on purpose."),
      said("t1", "AgentMessage", "Fixed the regression.", "m2", "final_answer"),
      raw("assistant", "Fixed the regression.", "final_answer"),
    ])).toEqual([
      ["user", "Fix the blank region above the image"],
      ["assistant", "I'll trace the editor layout first."],
      ["assistant", "Fixed the regression."],
    ]);
  });

  test("a reply recorded only as an item still shows (Codex's own history reads only these)", () => {
    expect(rows([started("t1"), said("t1", "UserMessage", "go", "u1"), said("t1", "AgentMessage", "Done.", "m1", "final_answer")]))
      .toEqual([["user", "go"], ["assistant", "Done."]]);
  });

  test("one agent of a team messaging another is not a reply", () => {
    expect(rows([
      line({ type: "response_item", payload: { type: "agent_message", id: "amsg_1", author: "/root", recipient: "/root/email_delivery", content: [{ type: "input_text", text: "Message Type: NEW_TASK\nSender: /root" }] } }),
    ])).toEqual([]);
  });

  test("the same words in a later turn are their own row", () => {
    expect(rows([
      started("t1"), said("t1", "UserMessage", "continue", "u1"), said("t1", "AgentMessage", "Done.", "m1"), raw("assistant", "Done."),
      started("t2"), said("t2", "UserMessage", "continue", "u2"), said("t2", "AgentMessage", "Done.", "m2"), raw("assistant", "Done."),
    ])).toEqual([["user", "continue"], ["assistant", "Done."], ["user", "continue"], ["assistant", "Done."]]);
  });

  test("in an older rollout too, the turn keeps a repeated message its own row", () => {
    const event = (payload: object) => line({ type: "event_msg", payload });
    expect(rows([
      started("t1"), event({ type: "user_message", message: "go" }), event({ type: "agent_message", message: "Done." }),
      started("t2"), event({ type: "user_message", message: "go" }), event({ type: "agent_message", message: "Done." }),
    ])).toEqual([["user", "go"], ["assistant", "Done."], ["user", "go"], ["assistant", "Done."]]);
  });

  test("an older rollout, with the events and no items, reads as before", () => {
    expect(rows([
      started("t1"),
      line({ type: "event_msg", payload: { type: "user_message", message: "go" } }),
      raw("user", "go"),
      raw("assistant", "Done."),
      line({ type: "event_msg", payload: { type: "agent_message", message: "Done." } }),
    ])).toEqual([["user", "go"], ["assistant", "Done."]]);
  });
});

describe("a Codex turn that ends without a reply", () => {
  const ended = (payload: object) => line({ type: "event_msg", payload });
  const material = (lines: string[]) => {
    const conversation = buildConversation("s", lines, "codex");
    return conversation.order.map((id) => conversation.items[id]!).filter((item) => item.kind === "material").map((item) => item.material);
  };

  test("a failed one shows why, as Codex recorded it", () => {
    expect(material([
      started("t1"), said("t1", "UserMessage", "go", "u1"),
      ended({ type: "task_complete", turn_id: "t1", last_agent_message: null, error: { message: "You've hit your usage limit.", codex_error_info: "usage_limit_exceeded" } }),
    ])).toEqual([{ kind: "system_note", title: "Turn failed", detail: "You've hit your usage limit.", status: "error" }]);
  });

  test("a stopped one shows it was interrupted", () => {
    expect(material([started("t1"), said("t1", "UserMessage", "go", "u1"), ended({ type: "turn_aborted", turn_id: "t1", reason: "interrupted" })]))
      .toEqual([{ kind: "interruption", title: "Request interrupted" }]);
  });

  test("a finished one adds nothing", () => {
    expect(material([started("t1"), said("t1", "AgentMessage", "Done.", "m1"), ended({ type: "task_complete", turn_id: "t1", last_agent_message: "Done." })]))
      .toEqual([]);
  });
});
