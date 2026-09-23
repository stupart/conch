import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { validateSocketTurnEvent } from "../src/control-server.ts";

/**
 * Claude Code 2.1.280 writes a pending tool call to the transcript only once its permission
 * dialog resolves (measured: no assistant record at all while it is up, 15 s on), so conch,
 * reading the transcript, had nothing to show: a red mark and silence. Its PermissionRequest
 * hook fires just before the dialog opens, with the tool call (measured payload: tool_name
 * "Bash", tool_input { command: "touch look.txt", description }, permission_suggestions).
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function hook(payload: Record<string, unknown>): Promise<{ received: any[]; stdout: string }> {
  const root = mkdtempSync("/tmp/conch-permreq-");
  roots.push(root);
  mkdirSync(join(root, "claude", "sessions"), { recursive: true });
  const socketPath = join(root, "d.sock");
  const received: any[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      received.push(JSON.parse(buffer.slice(0, newline)));
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("CONCH_") || key.startsWith("CLAUDE_")) continue;
    env[key] = value;
  }
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "hook"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...env, HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude"), CONCH_CONFIG_DIR: join(root, "config"), CONCH_SOCKET: socketPath, CLAUDE_CODE_ENTRYPOINT: "cli" },
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 8_000);
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { received, stdout };
}

describe("the PermissionRequest hook", () => {
  test("reports the dialog's tool call to the daemon, and prints nothing that could answer it", async () => {
    const { received, stdout } = await hook({
      hook_event_name: "PermissionRequest",
      session_id: "69a95887-045f-483a-8e03-d3d9b56e3408",
      cwd: "/work",
      tool_name: "Bash",
      tool_input: { command: "touch look.txt", description: "Create an empty file called look.txt" },
      permission_suggestions: [{ type: "addDirectories", directories: ["/work"], destination: "session" }],
    });
    // Anything on stdout is read by Claude Code as the hook's decision.
    expect(stdout).toBe("");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "needs-you",
      ntype: "permission_prompt",
      sessionId: "69a95887-045f-483a-8e03-d3d9b56e3408",
      approval: { name: "Bash", summary: "touch look.txt" },
    });
    expect(received[0].approval.id).toMatch(/^hook:[0-9a-f]{16}$/);
    // And the daemon's socket accepts exactly what the hook sends.
    expect(validateSocketTurnEvent(received[0]).ok).toBe(true);
  }, 30_000);

  test("conch's installer wires it with the others", () => {
    const install = readFileSync(join(import.meta.dir, "../src/install.ts"), "utf8");
    expect(install).toContain('for (const event of ["Stop", "Notification", "UserPromptSubmit", "PermissionRequest"]) {');
  });
});

describe("the approval field on the socket", () => {
  const needs = (approval: unknown, type = "needs-you") =>
    validateSocketTurnEvent({ type, sessionId: "s1", label: "alpha", announce: "alpha needs you", approval });
  test("a needs-you may say what its dialog asks", () => {
    expect(needs({ id: "hook:0123456789abcdef", name: "Bash", summary: "touch look.txt" }).ok).toBe(true);
  });
  test("nothing else, and on nothing else", () => {
    for (const bad of ["Bash", { id: "x", name: "Bash" }, { id: "", name: "Bash", summary: "s" }, { id: "x", name: "Bash", summary: "y".repeat(2001) }]) {
      expect(needs(bad).ok).toBe(false);
    }
    expect(needs({ id: "x", name: "Bash", summary: "s" }, "turn-end").ok).toBe(false);
  });
});

describe("the daemon wires both ends", () => {
  const daemon = readFileSync(join(import.meta.dir, "../src/daemon.ts"), "utf8");
  test("the published row asks the voice loop, which holds the hook's record", () => {
    expect(daemon).toContain("(sessionId, path) => voice.pendingApprovalFor(sessionId, path),");
  });
  test("a question the hook reported is in the published conversation", () => {
    expect(daemon).toContain("withHeldQuestion(read, voice.heldQuestionFor(session.sessionId)),");
  });
  test("a key is pressed only after reading Claude's registry now, not the last snapshot", () => {
    expect(daemon).toMatch(/freshStatus: async \(sessionId\) => \(await registrySnapshot\(cfg\.claudeDir\)\)\?\.infos\s*\.find\(\(session\) => session\.sessionId === sessionId\)\?\.status,/);
  });
});

describe("the hook and Claude Code's question picker", () => {
  // Measured 2026-09-23: PermissionRequest fires for AskUserQuestion too, with the
  // questions in tool_input. As a permission, Allow would press Enter and pick
  // whichever option is highlighted.
  const ask = {
    hook_event_name: "PermissionRequest",
    session_id: "69a95887-045f-483a-8e03-d3d9b56e3408",
    cwd: "/work",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [
      { question: "Pick delta?", header: "Delta", multiSelect: false, options: [{ label: "D1", description: "Option D1" }, { label: "D2" }] },
      { question: "Pick echo?", header: "Echo", multiSelect: true, options: [{ label: "E1" }, { label: "E2" }] },
    ] },
  };

  test("is sent as the questions, never as a permission", async () => {
    const { received, stdout } = await hook(ask);
    expect(stdout).toBe("");
    expect(received).toHaveLength(1);
    expect(received[0].approval).toBeUndefined();
    const announced = received[0].announce;
    expect(received[0]).toMatchObject({ type: "needs-you", ntype: "elicitation_dialog" });
    expect(typeof announced === "string" && announced.includes("Pick delta?")).toBe(true);
    expect(received[0].asking.questions.map((q: any) => q.header)).toEqual(["Delta", "Echo"]);
    expect(received[0].asking.id).toMatch(/^hook:[0-9a-f]{16}$/);
    expect(validateSocketTurnEvent(received[0]).ok).toBe(true);
  }, 30_000);

  test("plan mode's exit dialog is left alone", async () => {
    const { received, stdout } = await hook({ ...ask, tool_name: "ExitPlanMode", tool_input: { plan: "do it" } });
    expect(stdout).toBe("");
    expect(received).toEqual([]);
  }, 30_000);

  test("the socket takes well-formed questions on a needs-you only", () => {
    const needs = (asking: unknown, type = "needs-you") =>
      validateSocketTurnEvent({ type, sessionId: "s1", label: "alpha", announce: "alpha is asking", asking });
    const questions = [{ header: "Delta", question: "Pick delta?", multiSelect: false, options: [{ label: "D1" }, { label: "D2" }] }];
    expect(needs({ id: "hook:0123456789abcdef", questions }).ok).toBe(true);
    for (const bad of [{ id: "x" }, { id: "", questions }, { id: "x", questions: [] }, { id: "x", questions: [{ question: "no options", options: [] }] }]) {
      expect(needs(bad).ok).toBe(false);
    }
    expect(needs({ id: "x", questions }, "turn-end").ok).toBe(false);
  });
});

describe("a held question in the published conversation", () => {
  const { withHeldQuestion, buildConversation, latestAnswerableQuestions } = require("../src/conversation.ts") as typeof import("../src/conversation.ts");
  const q = (header: string) => ({ header, question: `Pick ${header}?`, multiSelect: false, options: [{ label: "A" }, { label: "B" }] });
  const talk = () => buildConversation("s1", [JSON.stringify({ type: "user", message: { role: "user", content: "ask me" } })], "claude");

  test("becomes the running question row the transcript will later hold", () => {
    const conversation = withHeldQuestion(talk(), { id: "hook:abc", questions: [q("Delta"), q("Echo")] });
    const row = conversation.items["tool:hook:abc"]!;
    expect(row).toMatchObject({ kind: "tool", tool: { status: "running", kind: "question" }, question: { header: "Delta" } });
    expect(row.questions?.map((x) => x.header)).toEqual(["Delta", "Echo"]);
    expect(latestAnswerableQuestions(conversation).map((x) => x.header)).toEqual(["Delta", "Echo"]);
  });

  test("adds nothing when the transcript already shows a running question", () => {
    const written = buildConversation("s1", [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu_q", name: "AskUserQuestion", input: { questions: [q("Delta")] } }] } }),
    ], "claude");
    const before = written.order.length;
    expect(withHeldQuestion(written, { id: "hook:abc", questions: [q("Other")] }).order.length).toBe(before);
    expect(withHeldQuestion(talk(), null).order.length).toBe(1);
  });
});
