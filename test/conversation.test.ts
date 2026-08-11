import { describe, expect, test } from "bun:test";
import {
  agentQuestion,
  applyConversationDelta,
  buildConversation,
  conversationDelta,
  conversationWindow,
  emptyConversation,
  planSteps,
  publishedConversation,
  reduceClaudeLine,
  reduceCodexLine,
  summariseToolInput,
  toolDisplayName,
  toolKind,
  upsertConversationItem,
} from "../src/conversation.ts";

const lines = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e));

describe("reading a Claude transcript as a conversation", () => {
  test("a tool result attaches to its call instead of becoming a user message", () => {
    // The trap: Claude Code records tool results as entries of type "user". In
    // a live transcript sampled while building this, 75 of 80 "user" entries
    // were tool results and only 5 were things Tyler typed. Rendering those as
    // user messages turns a conversation into machine noise.
    const conversation = buildConversation("s", lines(
      { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "run the tests" }] } },
      {
        type: "assistant",
        uuid: "a1",
        message: {
          content: [
            { type: "text", text: "Running them now." },
            { type: "tool_use", id: "call1", name: "Bash", input: { description: "Run the suite", command: "bun test" } },
          ],
        },
      },
      {
        type: "user",
        uuid: "u2",
        message: { content: [{ type: "tool_result", tool_use_id: "call1", content: "864 pass" }] },
      },
    ), "claude");

    expect(conversationWindow(conversation, 10).map((i) => i.kind))
      .toEqual(["user", "assistant", "tool"]);
    const tool = conversation.items["tool:call1"]!;
    expect(tool.tool).toMatchObject({ name: "Bash", status: "done", result: "864 pass" });
    // The row is titled by what the tool was FOR, not the first line of script.
    expect(tool.text).toBe("Run the suite");
  });

  test("an errored tool result is marked, not silently completed", () => {
    const conversation = buildConversation("s", lines(
      {
        type: "assistant",
        uuid: "a1",
        message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "false" } }] },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "c1", is_error: true, content: "boom" }] },
      },
    ), "claude");
    expect(conversation.items["tool:c1"]!.tool).toMatchObject({ status: "error", result: "boom" });
  });

  test("thinking is kept as its own kind so a viewer can collapse it", () => {
    const conversation = buildConversation("s", lines({
      type: "assistant",
      uuid: "a1",
      message: { content: [{ type: "thinking", text: "weighing options" }, { type: "text", text: "Done." }] },
    }), "claude");
    expect(conversationWindow(conversation, 10).map((i) => [i.kind, i.text]))
      .toEqual([["thinking", "weighing options"], ["assistant", "Done."]]);
  });

  test("transcript metadata is not conversation", () => {
    // A real transcript is full of these: file-history-delta, custom-title,
    // agent-name, mode, pr-link, attachment, system…
    const conversation = buildConversation("s", lines(
      { type: "custom-title", title: "x" },
      { type: "file-history-snapshot" },
      { type: "system", content: "…" },
    ), "claude");
    expect(conversation.order).toEqual([]);
  });
});

describe("reading a Codex rollout as the same conversation", () => {
  test("agent messages, reasoning and tool calls map onto one shape", () => {
    const conversation = buildConversation("s", lines(
      { type: "event_msg", ordinal: 1, payload: { type: "user_message", message: "fix the build" } },
      { type: "response_item", ordinal: 2, payload: { type: "reasoning", text: "checking" } },
      {
        type: "response_item",
        ordinal: 3,
        payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: 'const r = await tools.exec_command({cmd:"pnpm test"})' },
      },
      {
        type: "response_item",
        ordinal: 4,
        payload: { type: "custom_tool_call_output", call_id: "c1", output: "ok" },
      },
      { type: "response_item", ordinal: 5, payload: { type: "agent_message", id: "m1", text: "Build is green." } },
    ), "codex");

    expect(conversationWindow(conversation, 10).map((i) => i.kind))
      .toEqual(["user", "thinking", "tool", "assistant"]);
    expect(conversation.items["tool:c1"]).toMatchObject({
      text: "pnpm test",
      tool: { name: "exec", status: "done", result: "ok" },
    });
  });

  test("a failed Codex tool is an error", () => {
    const conversation = buildConversation("s", lines(
      { type: "response_item", ordinal: 1, payload: { type: "function_call", call_id: "c1", name: "run", arguments: '{"command":"x"}' } },
      { type: "response_item", ordinal: 2, payload: { type: "function_call_output", call_id: "c1", output: { success: false, content: "nope" } } },
    ), "codex");
    expect(conversation.items["tool:c1"]!.tool).toMatchObject({ status: "error", result: "nope" });
  });
});

describe("tool row titles", () => {
  test("prefers the human-facing description over the script", () => {
    // Taking `command` first made every shell row in a real transcript read
    // "cd ~/conch" — the first line of the script, not what it was for.
    expect(summariseToolInput({ description: "Run the suite", command: "cd ~/conch\nbun test" }))
      .toBe("Run the suite");
    expect(summariseToolInput({ command: "cd ~/conch\nbun test" })).toBe("cd ~/conch");
    expect(summariseToolInput({ file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summariseToolInput(null)).toBe("");
  });

  test("lifts the real command out of Codex's JavaScript wrapper", () => {
    // Codex's dominant tool takes a JS snippet, so the raw first line is the
    // wrapper: `const r = await tools.exec_command({cmd:"rg -n …`.
    expect(summariseToolInput('const r = await tools.exec_command({cmd:"pnpm exec vitest run"})'))
      .toBe("pnpm exec vitest run");
    expect(summariseToolInput('await tools.exec_command({ cmd: "grep -n \\"needle\\" file" })'))
      .toBe('grep -n "needle" file');
  });
});

describe("revisions, so the wire sends only what moved", () => {
  test("an unchanged item does not bump its revision", () => {
    const conversation = emptyConversation("s");
    upsertConversationItem(conversation, { id: "a", kind: "assistant", text: "hi" });
    expect(conversation.items.a!.rev).toBe(1);
    upsertConversationItem(conversation, { id: "a", kind: "assistant", text: "hi" });
    expect(conversation.items.a!.rev).toBe(1);
  });

  test("a streaming tail mutates in place rather than appending", () => {
    // The operation an append-only log cannot express: the last assistant
    // message GROWS while it streams.
    const conversation = emptyConversation("s");
    upsertConversationItem(conversation, { id: "a", kind: "assistant", text: "Let me" });
    upsertConversationItem(conversation, { id: "a", kind: "assistant", text: "Let me check that." });
    expect(conversation.order).toEqual(["a"]);
    expect(conversation.items.a).toMatchObject({ rev: 2, text: "Let me check that." });
  });

  test("a delta carries the order but only the changed items", () => {
    const conversation = emptyConversation("s");
    for (const id of ["a", "b", "c"]) {
      upsertConversationItem(conversation, { id, kind: "assistant", text: id });
    }
    const known = { a: 1, b: 1, c: 1 };
    expect(conversationDelta(conversation, known, 10).changed).toEqual([]);

    upsertConversationItem(conversation, { id: "c", kind: "assistant", text: "c grew" });
    const delta = conversationDelta(conversation, known, 10);
    expect(delta.order).toEqual(["a", "b", "c"]);
    expect(delta.changed.map((i) => i.id)).toEqual(["c"]);
  });

  test("a viewer applying deltas converges on the same conversation", () => {
    const source = emptyConversation("s");
    let viewer = emptyConversation("s");
    const known = () =>
      Object.fromEntries(Object.values(viewer.items).map((i) => [i.id, i.rev]));

    upsertConversationItem(source, { id: "a", kind: "user", text: "hello" });
    viewer = applyConversationDelta(viewer, conversationDelta(source, known(), 10));
    upsertConversationItem(source, { id: "b", kind: "assistant", text: "hi" });
    upsertConversationItem(source, { id: "b", kind: "assistant", text: "hi there" });
    viewer = applyConversationDelta(viewer, conversationDelta(source, known(), 10));

    expect(viewer.order).toEqual(source.order);
    expect(viewer.items).toEqual(source.items);
  });

  test("the window bounds what a viewer holds, dropping what scrolled away", () => {
    const source = emptyConversation("s");
    for (const id of ["a", "b", "c", "d"]) {
      upsertConversationItem(source, { id, kind: "assistant", text: id });
    }
    const viewer = applyConversationDelta(emptyConversation("s"), conversationDelta(source, {}, 2));
    expect(viewer.order).toEqual(["c", "d"]);
    expect(Object.keys(viewer.items).sort()).toEqual(["c", "d"]);
  });
});

describe("tool rows always say something", () => {
  test("falls back to the first short string when no key is recognised", () => {
    // Every MCP tool names its arguments differently, so the known-key list can
    // never be complete. On a real transcript this left rows for
    // `mcp__claude-in-chrome__computer` and `SendUserFile` showing a bare tool
    // name with no indication of what they did.
    expect(summariseToolInput({ action: "screenshot", coordinate: [1, 2] }))
      .toBe("screenshot");
    expect(summariseToolInput({ files: "report.md", status: "normal" }))
      .toBe("report.md");
  });

  test("skips a payload masquerading as a label", () => {
    // A long value is content, not a title.
    const long = "x".repeat(500);
    expect(summariseToolInput({ blob: long, mode: "write" })).toBe("write");
  });

  test("a recognised key still wins over the fallback", () => {
    expect(summariseToolInput({ zzz: "first alphabetically", description: "the real label" }))
      .toBe("the real label");
  });
});

describe("tool names a person can read", () => {
  test("unwraps an MCP wire name, keeping the server", () => {
    // `mcp__claude-in-chrome__computer` is fine in a protocol and hostile in a
    // conversation. The server is the useful half — figma vs linear vs chrome
    // tells you what happened — so it stays, just out of the plumbing.
    expect(toolDisplayName("mcp__claude-in-chrome__computer")).toBe("in-chrome · computer");
    // The plugin name repeated inside the server name would otherwise read
    // "figma-figma".
    expect(toolDisplayName("mcp__plugin_figma_figma__get_screenshot"))
      .toBe("figma · get_screenshot");
    expect(toolDisplayName("mcp__plugin_linear_linear__list_issues"))
      .toBe("linear · list_issues");
  });

  test("leaves an ordinary tool name alone", () => {
    expect(toolDisplayName("Bash")).toBe("Bash");
    expect(toolDisplayName("SendUserFile")).toBe("SendUserFile");
  });
});

describe("the window always contains what was said", () => {
  // A plain "last N" window is wrong for an agent mid-task: a Codex session
  // running a Playwright loop filled the entire window with tool calls, so the
  // pane showed a wall of commands and none of the replies.
  test("recent messages survive a flood of tool calls", () => {
    const conversation = emptyConversation("s");
    upsertConversationItem(conversation, { id: "said", kind: "assistant", text: "here is the answer" });
    for (let i = 0; i < 50; i += 1) {
      upsertConversationItem(conversation, {
        id: `t${i}`, kind: "tool", text: `step ${i}`,
        tool: { name: "exec", status: "done" },
      });
    }
    const published = publishedConversation(conversation, { windowSize: 10 });
    expect(published.items.some((item) => item.id === "said")).toBe(true);
    // …and it stays in ORDER, before the tools that followed it.
    expect(published.items[0]!.id).toBe("said");
  });

  test("a Codex `message` item is the reply, not a tool call", () => {
    // Sampled on a live rollout: Codex turns carry `message` items and often no
    // `agent_message` at all, so ignoring this type left sessions rendering as
    // nothing but tool calls.
    const conversation = buildConversation("s", lines({
      type: "response_item",
      ordinal: 1,
      payload: {
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "output_text", text: "The cleanup is in." }],
      },
    }), "codex");
    expect(conversationWindow(conversation, 5).map((i) => [i.kind, i.text]))
      .toEqual([["assistant", "The cleanup is in."]]);
  });

  test("an encrypted reasoning item is skipped, not rendered blank", () => {
    // Codex reasoning usually has an empty `summary` and an `encrypted_content`
    // blob; a blank thinking row per item is pure noise.
    const conversation = buildConversation("s", lines({
      type: "response_item",
      ordinal: 1,
      payload: { type: "reasoning", id: "r1", summary: [], encrypted_content: "gAAAA..." },
    }), "codex");
    expect(conversation.order).toEqual([]);
  });
});

describe("machine messages filed as 'user' are not you", () => {
  // Claude Code writes these under type:"user", the same disguise as tool
  // results. A <task-notification> saying a background command was killed
  // rendered as a message Tyler had sent: "why is it showing that I'm sending
  // messages like <task-notification> ... when im not??"
  const notification = [
    "<task-notification>",
    "<task-id>b6aog19q7</task-id>",
    "<status>killed</status>",
    '<summary>Background command "Start dev server" was stopped</summary>',
    "</task-notification>",
  ].join("\n");

  test("a task notification becomes a tool row carrying its summary", () => {
    const conversation = buildConversation("s", lines({
      type: "user", uuid: "u1", message: { content: [{ type: "text", text: notification }] },
    }), "claude");
    const items = conversationWindow(conversation, 5);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("tool");
    expect(items[0]!.text).toBe('Background command "Start dev server" was stopped');
    // "killed" is not a success.
    expect(items[0]!.tool?.status).toBe("error");
  });

  test("injected wrappers and interruption artifacts are dropped", () => {
    const conversation = buildConversation("s", lines(
      { type: "user", message: { content: [{ type: "text", text: "<system-reminder>be nice</system-reminder>" }] } },
      { type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } },
      { type: "user", message: { content: [{ type: "text", text: "<local-command-stdout>ok</local-command-stdout>" }] } },
    ), "claude");
    expect(conversation.order).toEqual([]);
  });

  test("a real message that merely mentions a tag is still yours", () => {
    const conversation = buildConversation("s", lines({
      type: "user", uuid: "u2",
      message: { content: [{ type: "text", text: "why does <task-notification> show as me?" }] },
    }), "claude");
    expect(conversationWindow(conversation, 5).map((i) => i.kind)).toEqual(["user"]);
  });
});

describe("types found by indexing every transcript, not by noticing one", () => {
  test("an image you sent is a message, not nothing", () => {
    // 14 `user:image` parts were being dropped across the machine's
    // transcripts, so a turn where Tyler sent a screenshot rendered as whatever
    // text happened to accompany it — or as nothing.
    const conversation = buildConversation("s", lines({
      type: "user",
      uuid: "u1",
      message: { content: [{ type: "image", source: { type: "base64", data: "..." } }] },
    }), "claude");
    expect(conversationWindow(conversation, 5).map((i) => [i.kind, i.text]))
      .toEqual([["user", "[image]"]]);
  });

  test("a Codex reply on the event stream counts", () => {
    // The index counted 286 `event_msg:agent_message` against 165
    // `response_item:agent_message` — the stream conch did NOT read carried
    // more replies than the one it did.
    const conversation = buildConversation("s", lines({
      type: "event_msg",
      ordinal: 4,
      payload: { type: "agent_message", message: "Build is green." },
    }), "codex");
    expect(conversationWindow(conversation, 5).map((i) => [i.kind, i.text]))
      .toEqual([["assistant", "Build is green."]]);
  });

  test("commentary is not the reply", () => {
    const conversation = buildConversation("s", lines({
      type: "event_msg",
      ordinal: 5,
      payload: { type: "agent_message", phase: "commentary", message: "thinking out loud" },
    }), "codex");
    expect(conversation.order).toEqual([]);
  });
});

describe("Codex says everything twice", () => {
  // A rollout records one message as BOTH `response_item:message` and
  // `event_msg:agent_message`. Keyed on file position those became two rows,
  // so the stack showed every reply — and every one of Tyler's own messages —
  // repeated back to back.
  test("one reply mirrored across both streams renders once", () => {
    const conversation = emptyConversation("s");
    const text = "Yep — this is the precise version.";
    reduceCodexLine(conversation, {
      type: "response_item",
      ordinal: 1,
      payload: { type: "message", role: "assistant", content: [{ text }] },
    });
    reduceCodexLine(conversation, {
      type: "event_msg",
      ordinal: 2,
      payload: { type: "agent_message", message: text },
    });
    expect(conversation.order.length).toBe(1);
    expect(conversation.items[conversation.order[0]!]!.text).toBe(text);
  });

  // The two streams are not byte-identical: the response item carries a
  // trailing newline the event does not, which is what defeated the first fix.
  test("a trailing newline does not defeat the match", () => {
    const conversation = emptyConversation("s");
    reduceCodexLine(conversation, {
      type: "event_msg",
      ordinal: 1,
      payload: { type: "user_message", message: "bruh why not use the nice scale one" },
    });
    reduceCodexLine(conversation, {
      type: "response_item",
      ordinal: 2,
      payload: {
        type: "message",
        role: "user",
        content: [{ text: "bruh why not use the nice scale one\n" }],
      },
    });
    expect(conversation.order.length).toBe(1);
  });

  test("a user message mirrored across both streams renders once", () => {
    const conversation = emptyConversation("s");
    const text = "bruh why not use the nice scale one";
    reduceCodexLine(conversation, {
      type: "event_msg",
      ordinal: 1,
      payload: { type: "user_message", message: text },
    });
    reduceCodexLine(conversation, {
      type: "response_item",
      ordinal: 2,
      payload: { type: "message", role: "user", content: [{ text }] },
    });
    expect(conversation.order.length).toBe(1);
    expect(conversation.items[conversation.order[0]!]!.kind).toBe("user");
  });

  test("genuinely different replies still both appear", () => {
    const conversation = emptyConversation("s");
    for (const message of ["first thing", "second thing"]) {
      reduceCodexLine(conversation, {
        type: "event_msg",
        ordinal: 1,
        payload: { type: "agent_message", message },
      });
    }
    expect(conversation.order.length).toBe(2);
  });
});

describe("telling one kind of tool call from another", () => {
  // Every tool call was filed under one `tool` kind, so a session rendered as
  // an undifferentiated stripe — Tyler's "i just see a string of tools calls".
  // The two agents also name identical operations differently, which is why
  // the mapping lives in the daemon and not in a renderer.
  test("both agents' names for running a command agree", () => {
    expect(toolKind("Bash")).toBe("command_execution");
    expect(toolKind("exec_command")).toBe("command_execution");
    expect(toolKind("local_shell")).toBe("command_execution");
  });

  test("both agents' names for changing a file agree", () => {
    expect(toolKind("Edit")).toBe("file_change");
    expect(toolKind("Write")).toBe("file_change");
    expect(toolKind("apply_patch")).toBe("file_change");
  });

  test("reading is not changing", () => {
    expect(toolKind("Read")).toBe("file_read");
    expect(toolKind("Grep")).toBe("search");
    expect(toolKind("WebSearch")).toBe("web_search");
    expect(toolKind("Task")).toBe("subagent");
    expect(toolKind("TodoWrite")).toBe("plan");
  });

  // Where a tool came from outranks what it is called: an MCP server may well
  // expose something named `read`, and it is still someone else's integration
  // rather than the agent touching this machine.
  test("an MCP tool stays an MCP tool whatever it is named", () => {
    expect(toolKind("mcp__plugin_figma_figma__get_screenshot")).toBe("mcp_tool_call");
    expect(toolKind("mcp__whatever__read")).toBe("mcp_tool_call");
  });

  test("an unrecognised tool is not a crash", () => {
    expect(toolKind("SomethingNew")).toBe("unknown");
    expect(toolKind("")).toBe("unknown");
  });
});

describe("plans render as plans, not as tool calls", () => {
  // Agents emit todo lists constantly. As a generic tool row they were noise;
  // as a checklist they are the clearest answer on screen to "what is it
  // actually doing right now".
  test("Claude's TodoWrite becomes steps", () => {
    const steps = planSteps({
      todos: [
        { content: "Map the architecture", status: "completed" },
        { content: "Implement the boundary", status: "in_progress" },
        { content: "Verify end to end", status: "pending" },
      ],
    });
    expect(steps.map((step) => step.status)).toEqual(["done", "running", "pending"]);
    expect(steps[0]!.text).toBe("Map the architecture");
  });

  // Codex does not send an object at all: it sends a line of JavaScript with
  // the plan inline, and its keys are sometimes quoted and sometimes not.
  test("Codex's inline update_plan becomes the same steps", () => {
    const steps = planSteps(
      'const r = await tools.update_plan({explanation:"x","plan":['
      + '{"step":"Map Humain and Sea Shell architecture","status":"completed"},'
      + '{"step":"Define the boundary","status":"in_progress"}]}); text(r)',
    );
    expect(steps.length).toBe(2);
    expect(steps[0]!.text).toBe("Map Humain and Sea Shell architecture");
    expect(steps[1]!.status).toBe("running");
  });

  test("anything that is not a plan yields no steps", () => {
    expect(planSteps({ cmd: "ls" })).toEqual([]);
    expect(planSteps("const r = await tools.exec_command({cmd:\"ls\"})")).toEqual([]);
  });
});

describe("Codex hides the real tool inside an exec call", () => {
  // Codex sends one `exec` whose argument is JavaScript, so classifying on the
  // name alone filed every Codex action under one label — most of why a Codex
  // session looked like undifferentiated noise.
  test("the inner tools.* call decides the kind", () => {
    expect(toolKind("exec", 'const r = await tools.update_plan({plan:[]})')).toBe("plan");
    expect(toolKind("exec", 'const r = await tools.exec_command({cmd:"ls"})'))
      .toBe("command_execution");
    expect(toolKind("exec", 'const r = await tools.apply_patch("*** Begin Patch")'))
      .toBe("file_change");
  });

  test("a bare patch envelope is still a file change", () => {
    expect(toolKind("exec", "*** Begin Patch\n*** Add File: x.ts")).toBe("file_change");
  });

  test("exec with an unreadable argument is still code running", () => {
    expect(toolKind("exec", "something we have no rule for")).toBe("command_execution");
    expect(toolKind("exec")).toBe("command_execution");
  });
});

describe("a question the agent is waiting on", () => {
  // The one place conch's model beats a screen outright: a multiple-choice
  // question is exactly the shape a voice loop answers well — read aloud with
  // its options and answered by saying one, from across the room.
  const real = {
    questions: [{
      question: "Where should this readout land?",
      header: "Deliver",
      multiSelect: true,
      options: [
        { label: "Linear subtask", description: "New subtask under the ticket." },
        { label: "Export PDF", description: "Headless-Chrome PDF." },
      ],
    }],
  };

  test("a real AskUserQuestion call becomes a question", () => {
    const asked = agentQuestion(real)!;
    expect(asked.question).toBe("Where should this readout land?");
    expect(asked.header).toBe("Deliver");
    expect(asked.multiSelect).toBe(true);
    expect(asked.options.map((o) => o.label)).toEqual(["Linear subtask", "Export PDF"]);
  });

  test("the row reads as the question, not as a tool call", () => {
    const conversation = emptyConversation("s");
    reduceClaudeLine(conversation, {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: real }],
      },
    });
    const item = conversation.items[conversation.order[0]!]!;
    expect(item.text).toBe("Where should this readout land?");
    expect(item.tool?.kind).toBe("question");
    expect(item.question?.options.length).toBe(2);
  });

  // A question with nothing to choose from cannot be answered by voice and
  // must not pretend to be answerable.
  test("a malformed question is not a question", () => {
    expect(agentQuestion({ questions: [{ question: "hi", options: [] }] })).toBeNull();
    expect(agentQuestion({ questions: [{ options: [{ label: "a" }] }] })).toBeNull();
    expect(agentQuestion({ cmd: "ls" })).toBeNull();
  });
});
