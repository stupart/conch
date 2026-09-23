import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_KEYBOARD,
  APPROVAL_KEYS,
  APPROVAL_REASK,
  approvalAnnounce,
  approvalDetail,
  classifyApprovalAnswer,
  pendingApproval,
  pendingApprovalFromLines,
  pendingCodexApprovalFromLines,
  summarizeToolUse,
} from "../src/approval.ts";
import { shouldHandleTurnAudibly } from "../src/daemon.ts";

const assistant = (...content: unknown[]) => JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
const user = (...content: unknown[]) => JSON.stringify({ type: "user", message: { role: "user", content } });
const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const result = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "ok" });
const bash = use("tu_1", "Bash", { command: "git push origin main", description: "Push" });

/** Transcript order (oldest first) is how Claude Code writes; the reader gets it newest first. */
const newestFirst = (...oldestFirst: string[]) => [...oldestFirst].reverse();

/**
 * Real lines from Tyler's own Codex rollout, captured 2026-09-19 from
 * ~/.codex/sessions/2026/09/19/rollout-2026-09-19T19-00-38-01a0b8e5-….jsonl.
 * Reduced only by trimming one long input script and long tool output; the
 * envelope, the field names and the escalation are verbatim.
 *
 * Ordinal 107 is the ask that started this: `bun install` wanting escalated
 * permission, with no `custom_tool_call_output` after it. It sat unanswered for
 * hours, and `readCodexRolloutTail` read the thread as "busy" the whole time —
 * which `registryToPanel` renders as "working".
 */
const CODEX_TASK_STARTED = String.raw`{"timestamp":"2026-09-19T11:51:05.614Z","ordinal":89,"type":"event_msg","payload":{"type":"task_started","turn_id":"01a0b981-7a87-7cb2-8320-79a8e0312f86","started_at":1789818665,"model_context_window":258400,"collaboration_mode_kind":"default"}}`;
const CODEX_ORDINARY_CALL = String.raw`{"timestamp":"2026-09-19T11:51:17.783Z","ordinal":95,"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_0f19e8bf8f5bb023016aae772e2bd887d2949c1891fde29aeb","status":"completed","call_id":"call_9kMQwV8oyZhJi34xnEZQjO8r","name":"exec","input":"text(await tools.exec_command({cmd:\"git status --short && git worktree list\",workdir:\"/Users/tylerstupart/Projects/Seashell\",max_output_tokens:2500}));\n","internal_chat_message_metadata_passthrough":{"turn_id":"01a0b981-7a87-7cb2-8320-79a8e0312f86","create_time":1789818666.498133}}}`;
const CODEX_ORDINARY_OUTPUT = String.raw`{"timestamp":"2026-09-19T11:51:17.956Z","ordinal":101,"type":"response_item","payload":{"type":"custom_tool_call_output","id":"ctco_01a0b981-aac4-7182-bc32-ff832f55110e","call_id":"call_9kMQwV8oyZhJi34xnEZQjO8r","output":[{"type":"input_text","text":"Script completed\nWall time 0.2 seconds\nOutput:\n"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a0b981-7a87-7cb2-8320-79a8e0312f86","create_time":1789818677.956609}},"metadata":{"client_authored":false,"fallback_token_limit_override":12000}}`;
const CODEX_ESCALATED_CALL = String.raw`{"timestamp":"2026-09-19T11:51:31.795Z","ordinal":107,"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_0f19e8bf8f5bb023016aae7740998087d29c15626dd510a213","status":"completed","call_id":"call_R3SFJWQHZ4ebOGHTATol2WJF","name":"exec","input":"text(await tools.exec_command({cmd:\"bun install --frozen-lockfile\",workdir:\"/Users/tylerstupart/Projects/Seashell/.worktrees/fix-humain-integration\",sandbox_permissions:\"require_escalated\",justification:\"May I download the locked Seashell dependencies to run its test suite and reproduce bugs?\",prefix_rule:[\"bun\",\"install\"],yield_time_ms:10000,max_output_tokens:1500}));\ntext(ALL_TOOLS.filter(t=>/review_to_front/.test(t.name)));\n","internal_chat_message_metadata_passthrough":{"turn_id":"01a0b981-7a87-7cb2-8320-79a8e0312f86","create_time":1789818678.512885}}}`;
/** The same call answered, in the shape ordinal 101 records a finished one. */
const CODEX_ESCALATED_OUTPUT = String.raw`{"timestamp":"2026-09-19T11:52:02.118Z","ordinal":113,"type":"response_item","payload":{"type":"custom_tool_call_output","id":"ctco_01a0b981-aac4-7182-bc32-ff832f55110f","call_id":"call_R3SFJWQHZ4ebOGHTATol2WJF","output":[{"type":"input_text","text":"Script completed\nWall time 12.4 seconds\nOutput:\n"}]}}`;

describe("what Codex is waiting on, from its rollout", () => {
  test("an unanswered escalation is the pending prompt", () => {
    expect(pendingCodexApprovalFromLines(newestFirst(
      CODEX_TASK_STARTED,
      CODEX_ORDINARY_CALL,
      CODEX_ORDINARY_OUTPUT,
      CODEX_ESCALATED_CALL,
    ))).toEqual({
      id: "call_R3SFJWQHZ4ebOGHTATol2WJF",
      name: "exec",
      summary: "bun install --frozen-lockfile",
      answerable: false,
    });
  });

  test("an answered escalation is not pending", () => {
    expect(pendingCodexApprovalFromLines(newestFirst(
      CODEX_ESCALATED_CALL,
      CODEX_ESCALATED_OUTPUT,
    ))).toBeNull();
  });

  test("an ordinary command still running is not a prompt", () => {
    // The other direction of the same bug. Every in-flight command has no
    // output yet, so reading "no output" alone as a permission prompt would
    // report every working session as blocked on you. Only the escalation is
    // an ask.
    expect(pendingCodexApprovalFromLines(newestFirst(
      CODEX_TASK_STARTED,
      CODEX_ORDINARY_CALL,
    ))).toBeNull();
  });

  test("a rollout file routes to the Codex reader by its name", () => {
    // `pendingApproval` is what the voice loop and the daemon both call; a
    // Codex rollout must not be read with the Claude transcript parser, which
    // finds nothing in it and reports no prompt at all.
    const dir = mkdtempSync(join(tmpdir(), "conch-codex-approval-"));
    try {
      const path = join(dir, "rollout-2026-09-19T19-00-38-01a0b8e5.jsonl");
      writeFileSync(path, [CODEX_TASK_STARTED, CODEX_ORDINARY_CALL, CODEX_ORDINARY_OUTPUT, CODEX_ESCALATED_CALL].join("\n") + "\n");
      expect(pendingApproval(path)).toEqual({
        id: "call_R3SFJWQHZ4ebOGHTATol2WJF",
        name: "exec",
        summary: "bun install --frozen-lockfile",
        answerable: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an ask conch cannot press keys at says so instead of offering the four-way answer", () => {
    expect(approvalAnnounce("seashell", { name: "exec", summary: "bun install", answerable: false }))
      .toBe("seashell needs permission for exec: bun install. Answer it in the session.");
    // Claude's dialog is unchanged.
    expect(approvalAnnounce("alpha", { name: "Bash", summary: "git push" }))
      .toBe("alpha needs permission for Bash: git push. Yes, or no?");
  });
});

describe("what is being asked, from the transcript", () => {
  test("the newest tool_use with no tool_result is the pending prompt", () => {
    expect(pendingApprovalFromLines(newestFirst(
      user({ type: "text", text: "push it" }),
      assistant({ type: "thinking", thinking: "" }),
      assistant(bash),
    ))).toEqual({ id: "tu_1", name: "Bash", summary: "git push origin main" });
  });

  test("an answered prompt is not pending", () => {
    // The dialog was answered by hand (or the hook fired late): the result is on disk.
    expect(pendingApprovalFromLines(newestFirst(assistant(bash), user(result("tu_1"))))).toBeNull();
  });

  test("a parallel call with the first already answered names the second", () => {
    const second = use("tu_2", "Edit", { file_path: "/repo/src/app.ts", old_string: "a", new_string: "b" });
    expect(pendingApprovalFromLines(newestFirst(assistant(bash, second), user(result("tu_1")))))
      .toEqual({ id: "tu_2", name: "Edit", summary: "app.ts" });
  });

  test("a question is not a permission", () => {
    // Claude Code fires permission_prompt for an AskUserQuestion too; Enter would pick an option.
    expect(pendingApprovalFromLines(newestFirst(
      assistant(use("tu_q", "AskUserQuestion", { questions: [{ question: "Which?" }] })),
    ))).toBeNull();
  });

  test("a finished reply or a newer prompt from you means nothing is waiting", () => {
    expect(pendingApprovalFromLines(newestFirst(assistant(bash), user(result("tu_1")), assistant({ type: "text", text: "Pushed." })))).toBeNull();
    expect(pendingApprovalFromLines(newestFirst(assistant(bash), user({ type: "text", text: "never mind" })))).toBeNull();
  });

  test("a partial line mid-write and non-message entries are skipped", () => {
    expect(pendingApprovalFromLines(newestFirst(
      assistant(bash),
      JSON.stringify({ type: "progress", data: {} }),
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_9","na',
    ))).toEqual({ id: "tu_1", name: "Bash", summary: "git push origin main" });
    expect(pendingApprovalFromLines([])).toBeNull();
  });
});

describe("reading the tail of a real transcript file", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("finds the pending call behind a long transcript, and never throws on a missing file", () => {
    const root = mkdtempSync(join(tmpdir(), "conch-approval-"));
    roots.push(root);
    const path = join(root, "session.jsonl");
    const filler = Array.from({ length: 400 }, (_, i) => assistant({ type: "text", text: `earlier reply ${i} `.repeat(40) }));
    writeFileSync(path, [...filler, user({ type: "text", text: "push it" }), assistant(bash)].join("\n") + "\n");
    expect(pendingApproval(path)).toEqual({ id: "tu_1", name: "Bash", summary: "git push origin main" });
    expect(pendingApproval(join(root, "missing.jsonl"))).toBeNull();
  });
});

describe("the one spoken line", () => {
  test("names the action the way the tool does", () => {
    expect(summarizeToolUse("Bash", { command: "  git   status\n  && git log " })).toBe("git status && git log");
    expect(summarizeToolUse("Edit", { file_path: "/repo/src/app.ts" })).toBe("app.ts");
    expect(summarizeToolUse("WebFetch", { url: "https://example.com/x" })).toBe("https://example.com/x");
    expect(summarizeToolUse("mcp__linear__save_issue", { title: "Bug", team: "ENG" })).toBe("title Bug, team ENG");
    expect(summarizeToolUse("Odd", {})).toBe("Odd");
    expect(summarizeToolUse("Odd", "not an object")).toBe("Odd");
  });

  test("is capped, because it is read aloud", () => {
    const long = summarizeToolUse("Bash", { command: "x".repeat(500) });
    expect(long.length).toBe(120);
    expect(long.endsWith("…")).toBe(true);
  });

  test("announce and row detail carry the tool and the summary", () => {
    const ask = { name: "Bash", summary: "git push origin main" };
    expect(approvalAnnounce("Fix login", ask)).toBe("Fix login needs permission for Bash: git push origin main. Yes, or no?");
    expect(approvalDetail(ask)).toBe("permission: Bash — git push origin main");
    // "always" is never offered: what it grants differs per tool and can't be announced.
    expect(APPROVAL_REASK).not.toContain("always");
    expect(APPROVAL_KEYBOARD).toContain("keyboard");
  });
});

describe("the spoken answer, four ways", () => {
  const cases: Array<[string, ReturnType<typeof classifyApprovalAnswer>]> = [
    ["Yes.", { kind: "once" }],
    ["Yeah, go ahead.", { kind: "once" }],
    ["just this once", { kind: "once" }],
    ["yes, this time", { kind: "once" }],
    ["Always.", { kind: "always" }],
    ["yes, always", { kind: "always" }],
    ["Yes, and don't ask again.", { kind: "always" }],
    ["don't ask me again", { kind: "always" }],
    ["allow it for this session", { kind: "always" }],
    ["No.", { kind: "deny" }],
    ["no thanks", { kind: "deny" }],
    ["Nope, stop.", { kind: "deny" }],
    ["Cancel", { kind: "deny" }],
    ["No, use the main branch instead.", { kind: "instead", text: "use the main branch instead." }],
    ["Don't. Run the tests first.", { kind: "instead", text: "Run the tests first." }],
    ["Instead, push to a feature branch.", { kind: "instead", text: "push to a feature branch." }],
    ["Tell it to skip the push.", { kind: "instead", text: "skip the push." }],
    ["Use the other branch.", null],
    ["Yes. No.", null],
    ["no, always", null],
    ["instead", null],
    ["", null],
    ["   ", null],
  ];
  for (const [heard, expected] of cases) {
    test(`"${heard}" -> ${expected ? expected.kind : "unclear"}`, () => {
      expect(classifyApprovalAnswer([heard])).toEqual(expected);
    });
  }

  test("segments split on a pause are one answer", () => {
    expect(classifyApprovalAnswer(["No,", "use main."])).toEqual({ kind: "instead", text: "use main." });
    expect(classifyApprovalAnswer(["Yes.", "", "  "])).toEqual({ kind: "once" });
  });

  test("each outcome presses what a person would press", () => {
    expect(APPROVAL_KEYS).toEqual({
      once: ["Enter"],
      always: ["Down", "Enter"],
      deny: ["Escape"],
      instead: ["Escape"],
    });
  });
});

describe("the daemon's wiring", () => {
  const read = (file: string) => readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
  // The wiring itself — which prompts get a voice, the row's words, the quiet
  // gates, announce-then-listen and the ear held elsewhere, the re-ask, the
  // always confirm, instead as Escape-then-text, and the mic reserved behind
  // the speech lane — is executed against the voice loop in
  // voice-loop.test.ts ("permission by voice").

  test("a permission with a voice is audible; every other needs-you is not", () => {
    const ask = { id: "tu_1", name: "Bash", summary: "git push" };
    expect(shouldHandleTurnAudibly({ type: "needs-you", approval: ask }, false)).toBe(true);
    expect(shouldHandleTurnAudibly({ type: "needs-you" }, false)).toBe(false);
    expect(shouldHandleTurnAudibly({ type: "working", approval: ask }, false)).toBe(false);
  });

  test("Down is a key the injector can press", () => {
    const inject = read("inject.ts");
    expect(inject).toContain('key: "Enter" | "Escape" | "Down"');
    expect(inject).toContain('key === "Down" ? 125');
  });
});

/**
 * A8: two windows resume one session id, so one transcript holds both dialogs.
 * The newest unresolved tool in the FILE is whoever asked last — never a reason
 * to announce it to the other window, or to press that window's keys.
 */
describe("which window's permission this is", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const preamble = (bridge: string, leafUuid: string) => [
    JSON.stringify({ type: "last-prompt", leafUuid }),
    JSON.stringify({ type: "bridge-session", bridgeSessionId: `cse_${bridge}` }),
  ];
  const prompt = (uuid: string, parentUuid: string | null, text: string) =>
    JSON.stringify({ type: "user", uuid, parentUuid, message: { role: "user", content: text } });
  const reply = (uuid: string, parentUuid: string, ...content: unknown[]) =>
    JSON.stringify({ type: "assistant", uuid, parentUuid, message: { role: "assistant", content } });

  test("each window reads its own branch's ask, and an unattributable one is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "conch-approval-windows-"));
    roots.push(root);
    const path = join(root, "session.jsonl");
    writeFileSync(path, [
      ...preamble("A", "u1"), prompt("u1", null, "shared"),
      ...preamble("A", "u1"), reply("a1", "u1", { type: "text", text: "ok" }),
      ...preamble("A", "a1"), prompt("u2", "a1", "push it"),
      ...preamble("A", "u2"), reply("a2", "u2", use("tu_A", "Bash", { command: "git push origin main" })),
      ...preamble("B", "a1"), prompt("u3", "a1", "clean it"),
      ...preamble("B", "u3"), reply("a3", "u3", use("tu_B", "Bash", { command: "rm -rf build" })),
    ].join("\n") + "\n");
    // Whoever wrote last owns the file's tail — that is all a window-blind read can see.
    expect(pendingApproval(path)).toMatchObject({ id: "tu_B" });
    expect(pendingApproval(path, { bridgeSessionId: "session_A" }))
      .toEqual({ id: "tu_A", name: "Bash", summary: "git push origin main" });
    expect(pendingApproval(path, { bridgeSessionId: "session_B" }))
      .toEqual({ id: "tu_B", name: "Bash", summary: "rm -rf build" });
    // A window the transcript cannot place answers nothing.
    expect(pendingApproval(path, {})).toBeNull();
  });
});
