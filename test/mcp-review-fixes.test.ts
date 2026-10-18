import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONCH_FORK_REPLY_MS,
  createMcpToolHandlers,
  defaultMcpDependencies,
  dispatchJsonRpc,
  MCP_TOOLS,
  type McpDependencies,
  type McpToolHandlers,
} from "../src/mcp.ts";
import { McpCallLog, readMcpCalls } from "../src/mcp-usage.ts";
import { FORK_WAIT_MS } from "../src/session-fork.ts";
import { readDeliverableKind } from "../src/deliverables.ts";
import { assistantTail, tailCursor, waitForTail } from "../src/transcript-tail.ts";
import { buildConversation } from "../src/conversation.ts";
import type { ControlResult } from "../src/settings.ts";
import type { SessionInfo } from "../src/sessions.ts";
import type { PublishReply } from "../src/review-verdict.ts";

/**
 * The 2026-10-18 review's fixes on the agent-facing side (~/Documents/conch-notes/mcp-usage-review-2026-10-18.md):
 * forking through the daemon and saying so, a tail an agent can wait on, and review_to_front's refusals naming the fix.
 */

const SESSION: SessionInfo = { sessionId: "session-abc", name: "Build", cwd: "/work/build", pid: 4321, status: "busy" };
const CONFIG = { claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock", sessionsPath: "/virtual/sessions.json" };

type Sent = Parameters<McpDependencies["sendControlMessage"]>[1];

function fakes(overrides: Partial<McpDependencies> = {}, sent: Array<{ message: Sent; timeoutMs?: number }> = []): McpDependencies {
  return {
    ...defaultMcpDependencies,
    async readSessionsFile() { return null; },
    async registrySnapshot() { return { infos: [SESSION], liveIds: new Set([SESSION.sessionId]), complete: true }; },
    async findSessionByName(_dir, query) { return query === "Build" || query === SESSION.sessionId ? SESSION : null; },
    findTranscript() { return "/virtual/session-abc.jsonl"; },
    sessionLabel: () => "Build",
    async sendToDaemon() { return true; },
    async sendControlMessage(_socket, message, timeoutMs) {
      sent.push({ message, timeoutMs });
      return { ok: false, reason: "daemon-down" };
    },
    async transcriptMark() { return 3; },
    now: () => 1_000_000,
    parentPid: () => 4321,
    ...overrides,
  };
}

async function call(handlers: McpToolHandlers, name: string, args: unknown) {
  const response = await dispatchJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, handlers);
  const result = response?.result as { content: Array<{ text: string }>; isError?: boolean };
  const text = result.content[0]!.text;
  return { error: result.isError === true, text, json: () => JSON.parse(text) };
}

describe("conch_fork: the daemon's fork, answered once it is running", () => {
  const forked = (response: Record<string, unknown>): ControlResult => ({ ok: true, response: response as never });

  test("forks your own verified session through session-fork, waits, and says the fork's id and label", async () => {
    const sent: Array<{ message: Sent; timeoutMs?: number }> = [];
    const handlers = createMcpToolHandlers(CONFIG, fakes({
      async sendControlMessage(_socket, message, timeoutMs) {
        sent.push({ message, timeoutMs });
        return forked({ kind: "session-forked", sessionId: SESSION.sessionId, forkId: "fork-1", label: "Marketing pass", notCarriedOver: ["--weird"] });
      },
    }));
    const reply = await call(handlers, "conch_fork", { label: "Marketing pass" });
    expect(reply.error).toBe(false);
    expect(reply.json()).toEqual({
      outcome: "forked",
      from: { sessionId: SESSION.sessionId, label: "Build" },
      forkId: "fork-1",
      label: "Marketing pass",
      notCarriedOver: ["--weird"],
      note: expect.stringContaining("under the same account and in the same folder"),
    });
    expect(sent).toEqual([{
      message: { kind: "session-fork", sessionId: SESSION.sessionId, label: "Marketing pass", wait: true },
      timeoutMs: CONCH_FORK_REPLY_MS,
    }]);
    // Long enough for the daemon's own wait, and under Codex's 60 s tool timeout.
    expect(CONCH_FORK_REPLY_MS).toBeGreaterThan(FORK_WAIT_MS + 10_000);
    expect(CONCH_FORK_REPLY_MS).toBeLessThan(60_000);
  });

  test("a fork running but not yet seen says where it runs, and not to fork again", async () => {
    const handlers = createMcpToolHandlers(CONFIG, fakes({
      async sendControlMessage() {
        return forked({ kind: "session-forked", sessionId: SESSION.sessionId, running: "Terminal (ttys012)" });
      },
    }));
    const reply = (await call(handlers, "conch_fork", { session: "Build" })).json();
    expect(reply).toMatchObject({ outcome: "started", running: "Terminal (ttys012)" });
    expect(reply.note).toContain("Don't fork again");
  });

  test("the daemon's error is the agent's, and a fork that didn't start is never said to be open", async () => {
    const died = createMcpToolHandlers(CONFIG, fakes({
      async sendControlMessage() {
        return forked({ kind: "session-error", error: "the fork's agent exited as soon as it started, in Terminal (ttys012). Its tab shows:\nNo conversation found with session ID: 162f2800" });
      },
    }));
    const reply = await call(died, "conch_fork", {});
    expect(reply.error).toBe(true);
    expect(reply.text).toStartWith("failed: the fork didn't start: the fork's agent exited as soon as it started");
    expect(reply.text).toContain("No conversation found");

    const down = await call(createMcpToolHandlers(CONFIG, fakes()), "conch_fork", {});
    expect(down.text).toBe("failed: conch daemon is not running, so nothing was forked");
    const slow = await call(createMcpToolHandlers(CONFIG, fakes({ async sendControlMessage() { return { ok: false, reason: "ack-unknown", diagnostic: "timed out" }; } })), "conch_fork", {});
    expect(slow.text).toContain("check conch_sessions before forking again");
  });

  test("without a session, an unverified caller is refused and nothing is sent; the call log counts it a refusal", async () => {
    const sent: Array<{ message: Sent; timeoutMs?: number }> = [];
    const path = join(mkdtempSync(join(tmpdir(), "conch-fork-log-")), "mcp-usage.jsonl");
    const log = new McpCallLog({ path, caller: async () => ({}) });
    const handlers = createMcpToolHandlers(CONFIG, fakes({ parentPid: () => 999_999 }, sent));
    const response = await dispatchJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "conch_fork", arguments: {} } }, handlers, log.observe);
    expect((response?.result as { content: Array<{ text: string }> }).content[0]!.text).toContain("conch_fork without `session` means your own session");
    expect(sent).toEqual([]);
    await log.flush();
    expect(readMcpCalls(path)).toMatchObject([{ tool: "conch_fork", outcome: "refused" }]);
    expect((await call(handlers, "conch_fork", { label: "x".repeat(81) })).text).toContain("label must be at most 80 characters");
  });

  test("its schema and description say what it does and where the old way went wrong", () => {
    const tool = MCP_TOOLS.find((one) => one.name === "conch_fork")!;
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["session", "label"]);
    expect(tool.description).toContain("under the same account, in the same folder and with the same flags");
    expect(tool.description).toContain("say a fork is open only when this says so");
    expect(tool.description).toContain("rather than `conch start --resume`");
  });
});

describe("conch_transcript_tail: a cursor, and a wait instead of a poll", () => {
  const conversation = (...items: Array<{ uuid: string; type: "assistant" | "user"; text?: string; tool?: boolean }>) =>
    buildConversation("s", items.map((item) => JSON.stringify(item.type === "assistant"
      ? { type: "assistant", uuid: item.uuid, message: { content: item.tool ? [{ type: "tool_use", id: `c-${item.uuid}`, name: "Bash", input: { command: "ls" } }] : [{ type: "text", text: item.text }] } }
      : { type: "user", uuid: item.uuid, message: { content: item.tool ? [{ type: "tool_result", tool_use_id: `c-${item.uuid}`, content: "ok" }] : [{ type: "text", text: item.text }] } })), "claude");

  test("mid-turn it gives the newest text before the tool calls, marked, where it used to give \"\"", () => {
    const working = conversation(
      { uuid: "u1", type: "user", text: "go" },
      { uuid: "a1", type: "assistant", text: "Running the tests now." },
      { uuid: "a2", type: "assistant", tool: true },
      { uuid: "u2", type: "user", tool: true },
    );
    expect(assistantTail(working)).toMatchObject({ text: "Running the tests now.", midTurn: true });
    const done = conversation({ uuid: "u1", type: "user", text: "go" }, { uuid: "a1", type: "assistant", text: "All green." });
    expect(assistantTail(done)).toMatchObject({ text: "All green.", midTurn: false });
    // The same words in a later turn are a new item, so a new cursor.
    expect(tailCursor({ text: "Done.", id: "a1" })).not.toBe(tailCursor({ text: "Done.", id: "a9" }));
  });

  test("a wait returns as soon as there is new text, and says how long it waited", async () => {
    let clock = 0;
    const reads = [{ text: "old", id: "a1", midTurn: false }, { text: "old", id: "a1", midTurn: false }, { text: "new", id: "a2", midTurn: false }];
    const result = await waitForTail(async () => reads.shift() ?? { text: "new", id: "a2", midTurn: false }, {
      waitMs: 30_000, sleep: async (ms) => { clock += ms; }, now: () => clock,
    });
    expect(result).toMatchObject({ tail: { text: "new" }, unchanged: false, waitedMs: 2_000 });
  });

  test("through the tool: since names the text read; the same again is \"no new text\", not the words or \"\"", async () => {
    let clock = 0;
    let text = "First. Second.";
    const handlers = createMcpToolHandlers(CONFIG, fakes({
      async assistantTail() { return { text, id: text === "First. Second." ? "a1" : "a2", midTurn: false }; },
      splitSentences: (value) => value.split(/(?<=\.)\s+/),
      now: () => clock,
      async sleep(ms) {
        clock += ms;
        if (clock >= 3_000) text = "Third.";
      },
    }));
    const first = (await call(handlers, "conch_transcript_tail", { session: "Build" })).json();
    expect(first).toMatchObject({ sessionId: SESSION.sessionId, label: "Build", status: "working", text: "First. Second." });
    const again = (await call(handlers, "conch_transcript_tail", { session: "Build", since: first.cursor })).json();
    expect(again).toEqual({ sessionId: SESSION.sessionId, label: "Build", status: "working", cursor: first.cursor, unchanged: true, note: "no new text since your cursor" });
    const waited = (await call(handlers, "conch_transcript_tail", { session: "Build", since: first.cursor, wait: 10 })).json();
    expect(waited).toMatchObject({ text: "Third.", waitedSeconds: 3 });
    expect(waited.cursor).not.toBe(first.cursor);
    const quiet = (await call(handlers, "conch_transcript_tail", { session: "Build", since: waited.cursor, wait: 5 })).json();
    expect(quiet).toMatchObject({ unchanged: true, note: "no new text since your cursor, after waiting 5 s", waitedSeconds: 5 });
    expect((await call(handlers, "conch_transcript_tail", { session: "Build", wait: 31 })).text).toBe("wait must be 0 to 30 seconds");
  });

  test("no reply text at all says so in a note rather than returning an empty string", async () => {
    const handlers = createMcpToolHandlers(CONFIG, fakes({ async assistantTail() { return { text: "", midTurn: false }; } }));
    const reply = (await call(handlers, "conch_transcript_tail", { session: "Build" })).json();
    expect(reply).not.toHaveProperty("text");
    expect(reply.note).toContain("no reply text yet");
  });
});

describe("review_to_front's refusals name the fix", () => {
  const filed: PublishReply = {
    kind: "verdict",
    verdict: { kind: "review-filed", filing: { id: "f-1", artifact: "a", version: 1, kind: "url", link: "https://acme.dev" } } as never,
  };
  const handlers = () => createMcpToolHandlers(CONFIG, fakes({ async publishForVerdict() { return filed; } }));

  test("summary is at most 200 characters, in the schema and its words", () => {
    const tool = MCP_TOOLS.find((one) => one.name === "review_to_front")!;
    const summary = (tool.inputSchema.properties as Record<string, { maxLength?: number; description?: string }>).summary!;
    expect(summary.maxLength).toBe(200);
    expect(summary.description).toContain("at most 200 characters");
    expect(tool.description).toContain("one-line summary (at most 200 characters)");
  });

  test("a kind agents guess is read as what it means, and the result says so", async () => {
    expect(readDeliverableKind("link")).toEqual({ ok: true, alias: "link" });
    expect(readDeliverableKind("web")).toEqual({ ok: true, alias: "web" });
    expect(readDeliverableKind("Screenshot")).toEqual({ ok: true, kind: "image", alias: "Screenshot" });
    expect(readDeliverableKind("url")).toEqual({ ok: true, kind: "url" });
    const reply = await call(handlers(), "review_to_front", { summary: "The dashboard", link: "https://acme.dev", kind: "link" });
    expect(reply.error).toBe(false);
    expect(reply.json()).toMatchObject({ outcome: "filed", kindAlias: { given: "link", used: "the link's own kind" } });
  });

  test("an unknown kind is refused with the nearest one", async () => {
    const reply = await call(handlers(), "review_to_front", { summary: "The dashboard", link: "https://acme.dev", kind: "urll" });
    expect(reply.error).toBe(true);
    expect(reply.text).toContain('kind "urll" isn\'t a kind. Did you mean "url"?');
    expect(reply.text).toContain("kind must be one of page, image");
    expect(readDeliverableKind("zebra")).toMatchObject({ ok: false, reason: expect.not.stringContaining("Did you mean") });
  });

  test("an argument it doesn't take names the one it does", async () => {
    expect((await call(handlers(), "review_to_front", { summary: "x", artifactKey: "k" })).text)
      .toBe('refused: unknown argument "artifactKey": use key (it names the artifact: the same key again files its next version)');
    expect((await call(handlers(), "review_to_front", { summary: "x", url: "https://acme.dev" })).text).toContain("use link");
    expect((await call(handlers(), "review_to_front", { summary: "x", nonsense: 1 })).text).toBe('refused: unknown argument "nonsense"');
  });

  test("a link in a hidden folder is refused with how to show it: a copy in /tmp", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-hidden-"));
    mkdirSync(join(root, ".cache"));
    writeFileSync(join(root, ".cache", "shot.png"), "png");
    writeFileSync(join(root, ".cache", "id.pem"), "key");
    const original = process.cwd();
    process.chdir(root);
    try {
      const own = createMcpToolHandlers(CONFIG, fakes({
        async registrySnapshot() { return { infos: [{ ...SESSION, cwd: root }], liveIds: new Set([SESSION.sessionId]), complete: true }; },
        findTranscript() { return undefined; },
        async publishForVerdict() { return filed; },
      }));
      const hidden = await call(own, "review_to_front", { summary: "x", link: join(root, ".cache", "shot.png") });
      expect(hidden.error).toBe(true);
      expect(hidden.text).toContain("hidden file, in a hidden folder");
      expect(hidden.text).toContain("To show it, copy it to /tmp first (cp -R ");
      expect(hidden.text).toContain("and link the copy");
      // A key is never suggested for copying.
      const key = await call(own, "review_to_front", { summary: "x", link: join(root, ".cache", "id.pem") });
      expect(key.text).not.toContain("copy it to /tmp");
    } finally {
      process.chdir(original);
    }
  });
});
