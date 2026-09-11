import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  liveBackgroundAgents,
  sessionHasLiveBackgroundWork,
  sidechainTranscriptPath,
  subagentRowId,
} from "../src/agent-activity.ts";
import { subagentSessions, type SessionInfo } from "../src/sessions.ts";
import {
  activeSessionIdForRows,
  buildPanelModel,
  buildPanelRows,
  buildPublishedState,
  dashboardRowsForModel,
} from "../src/panel.ts";
import { buildConversation, readConversationTail } from "../src/conversation.ts";

/**
 * C4 — subagents nested under their session.
 *
 * What Claude Code writes to disk for a subagent, verified on a real
 * transcript: NO registry entry (`~/.claude/sessions/<pid>.json` is one file
 * per top-level process; a subagent runs inside its parent), a sidechain
 * transcript at `<project>/<sessionId>/subagents/agent-<id>.jsonl` with
 * `agent-<id>.meta.json` beside it (`agentType`, `description`,
 * `toolUseId`), a parent tool_result whose `toolUseResult` carries `agentId`
 * (`isAsync: true, status: "async_launched"` for a background agent), and a
 * `<task-notification>` in the parent when it finishes. Nothing on disk says
 * "still running" — that is derived from launch-without-notification.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SESSION = "11111111-2222-4333-8444-555555555555";

function fixture() {
  const root = mkdtempSync("/tmp/conch-c4-");
  roots.push(root);
  const project = join(root, "-Users-someone-project");
  mkdirSync(project, { recursive: true });
  return { root, project, transcript: join(project, `${SESSION}.jsonl`) };
}

function launch(agentId: string, description: string, async = true, toolUseId = `toolu_${agentId}`) {
  return [
    {
      type: "assistant",
      uuid: `a-${agentId}`,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: { description, prompt: "go" } }],
      },
    },
    {
      type: "user",
      uuid: `u-${agentId}`,
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolUseId,
          content: [{ type: "text", text: async ? `Async agent launched successfully.\nagentId: ${agentId}` : "The answer." }],
        }],
      },
      toolUseResult: async
        ? { isAsync: true, status: "async_launched", agentId, description }
        : { status: "completed", agentId, agentType: "general-purpose" },
    },
  ];
}

function notice(agentId: string, status = "completed", carrier: "user" | "queue-operation" | "attachment" = "attachment") {
  const content = `<task-notification>\n<task-id>${agentId}</task-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>`;
  if (carrier === "user") {
    return { type: "user", uuid: `n-${agentId}`, message: { role: "user", content }, origin: { kind: "task-notification" } };
  }
  if (carrier === "queue-operation") return { type: "queue-operation", operation: "enqueue", content };
  return { type: "attachment", attachment: { type: "queued_command", prompt: content } };
}

function sidechain(f: ReturnType<typeof fixture>, agentId: string, meta?: Record<string, unknown>): string {
  const path = sidechainTranscriptPath(f.transcript, agentId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    type: "assistant",
    isSidechain: true,
    agentId,
    uuid: `s-${agentId}`,
    message: { role: "assistant", content: [{ type: "text", text: `I am ${agentId}.` }] },
  }) + "\n");
  if (meta) writeFileSync(path.replace(/\.jsonl$/, ".meta.json"), JSON.stringify(meta));
  return path;
}

const lines = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry));

function writeParent(f: ReturnType<typeof fixture>, ...entries: unknown[]): void {
  writeFileSync(f.transcript, lines(...entries).join("\n") + "\n");
}

describe("what the sidechain and the parent transcript say about subagents", () => {
  test("a launched-and-not-yet-reported background agent is live; finished and synchronous ones are not", () => {
    const f = fixture();
    sidechain(f, "aaa1", { agentType: "general-purpose", description: "Fix the flaky test", toolUseId: "toolu_aaa1" });
    sidechain(f, "bbb2", { agentType: "Plan", description: "Review the design" });
    sidechain(f, "ccc3");
    writeParent(
      f,
      ...launch("bbb2", "Review the design"),
      ...launch("ccc3", "Answer synchronously", false),
      ...launch("aaa1", "Fix the flaky test"),
      notice("bbb2"),
    );

    const live = liveBackgroundAgents(f.transcript);
    expect(live.map((agent) => agent.agentId)).toEqual(["aaa1"]);
    expect(live[0]).toMatchObject({
      description: "Fix the flaky test",
      agentType: "general-purpose",
      transcriptPath: join(f.project, SESSION, "subagents", "agent-aaa1.jsonl"),
    });
    expect(typeof live[0]!.startedAt).toBe("number");
    expect(sessionHasLiveBackgroundWork(f.transcript)).toBe(true);
  });

  test("a live agent becomes a row nested under its parent, and only a Claude session can have one", () => {
    const f = fixture();
    sidechain(f, "aaa1", { description: "Fix the flaky test" });
    writeParent(f, ...launch("aaa1", "Fix the flaky test"));
    const parent: SessionInfo = { sessionId: SESSION, name: "conch", cwd: "/work", backend: "claude", pid: 42 };

    const nested = subagentSessions(parent, f.transcript);
    expect(nested).toHaveLength(1);
    expect(nested[0]).toMatchObject({
      sessionId: subagentRowId("aaa1"),
      parentSessionId: SESSION,
      backend: "claude",
      name: "Fix the flaky test",
      cwd: "/work",
      status: "busy",
      transcriptPath: sidechainTranscriptPath(f.transcript, "aaa1"),
    });
    // No pid: nothing can be injected into, revealed or closed.
    expect(nested[0]!.pid).toBeUndefined();

    expect(subagentSessions({ ...parent, backend: "codex" }, f.transcript)).toEqual([]);
    expect(subagentSessions(nested[0]!, f.transcript)).toEqual([]);
    expect(subagentSessions(parent, undefined)).toEqual([]);
  });
});

describe("the panel row model nests subagents", () => {
  const parent: SessionInfo = { sessionId: "p1", name: "conch", status: "idle", statusUpdatedAt: 50 };
  const other: SessionInfo = { sessionId: "p2", name: "arch", status: "busy", statusUpdatedAt: 50 };
  const older: SessionInfo = {
    sessionId: "agent-old", parentSessionId: "p1", name: "Older task", status: "busy", statusUpdatedAt: 10,
  };
  const newer: SessionInfo = {
    sessionId: "agent-new", parentSessionId: "p1", name: "Newer task", status: "busy", statusUpdatedAt: 20,
  };
  const orphan: SessionInfo = {
    sessionId: "agent-orphan", parentSessionId: "gone", name: "Nobody's", status: "busy",
  };
  const options = {
    sessionStates: new Map(),
    pausedSessionIds: new Set<string>(),
    live: { state: "speaking" as const, label: "Newer task", partial: "" },
    mode: { muted: false, paused: false, holding: 0 },
    navSelectedId: null,
  };

  test("children sit directly under their parent, oldest first, and are never the active row", () => {
    const rows = buildPanelRows({
      ...options,
      sessions: [newer, other, orphan, parent, older],
      activeSessionId: "agent-new",
    });
    expect(rows.map((row) => row.sessionId)).toEqual(["p1", "agent-old", "agent-new", "p2"]);
    expect(rows[1]).toMatchObject({ parentSessionId: "p1", status: "working", active: false });
    expect(rows[2]).toMatchObject({ parentSessionId: "p1", active: false, liveGlyph: null });
    expect(rows[0]!.parentSessionId).toBeUndefined();
    expect(rows.find((row) => row.sessionId === "agent-orphan")).toBeUndefined();
    // Speech is addressed by label; a subagent's label is a task description.
    expect(activeSessionIdForRows(rows, options.live)).toBeNull();
    expect(activeSessionIdForRows(rows, { state: "speaking", label: "conch" })).toBe("p1");
  });

  test("the published row carries parentSessionId and the sidechain transcript; the TUI indents it", () => {
    const model = buildPanelModel({
      ...options,
      sessions: [parent, { ...older, transcriptPath: "/p/s/subagents/agent-old.jsonl" }],
      activeSessionId: null,
    });
    const published = buildPublishedState("owner", model, new Map(), new Set(), 1, {
      transcriptPathForSessionId: (id) => id === "agent-old" ? "/p/s/subagents/agent-old.jsonl" : undefined,
    });
    expect(published.rows.map((row) => row.id)).toEqual(["p1", "agent-old"]);
    expect(published.rows[1]).toMatchObject({
      parentSessionId: "p1",
      transcriptPath: "/p/s/subagents/agent-old.jsonl",
      active: false,
    });
    expect(published.rows[0]!.parentSessionId).toBeUndefined();

    const painted = dashboardRowsForModel(model);
    expect(painted[0]).toContain("conch");
    expect(painted[1]).toContain("↳ Older task");
  });
});

describe("the conversation knows which agent a Task block started", () => {
  test("a background Agent block stays running until its notification, and names its agent", () => {
    const conversation = buildConversation("s", lines(
      ...launch("aaa1", "Fix the flaky test"),
      ...launch("ccc3", "Answer synchronously", false),
    ), "claude");
    expect(conversation.items["tool:toolu_aaa1"]!.tool).toMatchObject({
      kind: "subagent",
      status: "running",
      subagent: { id: "agent-aaa1" },
    });
    expect(conversation.items["tool:toolu_ccc3"]!.tool).toMatchObject({
      status: "done",
      subagent: { id: "agent-ccc3" },
    });

    for (const carrier of ["attachment", "queue-operation", "user"] as const) {
      const finished = buildConversation("s", lines(
        ...launch("aaa1", "Fix the flaky test"),
        notice("aaa1", "completed", carrier),
      ), "claude");
      expect(finished.items["tool:toolu_aaa1"]!.tool!.status).toBe("done");
    }
    const failed = buildConversation("s", lines(
      ...launch("aaa1", "Fix the flaky test"),
      notice("aaa1", "failed"),
    ), "claude");
    expect(failed.items["tool:toolu_aaa1"]!.tool!.status).toBe("error");
    // A notification about a background Bash task names no block and changes nothing.
    const bash = buildConversation("s", lines(...launch("aaa1", "x"), notice("b0ob4u9um")), "claude");
    expect(bash.items["tool:toolu_aaa1"]!.tool!.status).toBe("running");
  });

  test("reading the parent's tail attaches each agent's sidechain path", async () => {
    const f = fixture();
    writeParent(f, ...launch("aaa1", "Fix the flaky test"));
    const conversation = await readConversationTail(f.transcript, SESSION, "claude");
    expect(conversation.items["tool:toolu_aaa1"]!.tool!.subagent).toEqual({
      id: "agent-aaa1",
      transcriptPath: join(f.project, SESSION, "subagents", "agent-aaa1.jsonl"),
    });
  });
});

describe("a subagent stopping is not the parent's turn ending", () => {
  async function hook(payload: Record<string, unknown>): Promise<unknown[]> {
    const root = mkdtempSync("/tmp/conch-c4-hook-");
    roots.push(root);
    mkdirSync(join(root, "claude", "sessions"), { recursive: true });
    const socketPath = join(root, "d.sock");
    const received: unknown[] = [];
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
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || key.startsWith("CONCH_") || key.startsWith("CLAUDE_")) continue;
      env[key] = value;
    }
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "hook"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...env,
        HOME: root,
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        CONCH_CONFIG_DIR: join(root, "config"),
        CONCH_SOCKET: socketPath,
        CLAUDE_CODE_ENTRYPOINT: "cli",
      },
      stdin: new Blob([JSON.stringify(payload)]),
      stdout: "ignore",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 8_000);
    await proc.exited;
    clearTimeout(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return received;
  }

  test("SubagentStop reaches the daemon as nothing; the same session's UserPromptSubmit still does", async () => {
    // Claude Code fires `SubagentStop` when a Task/Agent finishes and `Stop`
    // only for the main agent. conch registers only Stop, Notification and
    // UserPromptSubmit, and the hook drops SubagentStop before the Stop path
    // can turn it into a "turn-end" — which would announce the parent as
    // finished while it is still working.
    const stopped = await hook({ hook_event_name: "SubagentStop", session_id: SESSION, cwd: "/work" });
    expect(stopped).toEqual([]);

    const working = await hook({ hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: "/work" });
    expect(working).toHaveLength(1);
    expect(working[0]).toMatchObject({ type: "working", sessionId: SESSION });
  }, 30_000);
});

describe("the daemon and the Mac app wire it up", () => {
  const repo = join(import.meta.dir, "..");
  const read = (path: string) => readFileSync(join(repo, path), "utf8");

  test("renderSessionPanel builds rows and conversations from the nested set, but addresses only live sessions", () => {
    const daemon = read("src/daemon.ts");
    const start = daemon.indexOf("async function renderSessionPanel");
    expect(start).toBeGreaterThan(-1);
    const body = daemon.slice(start, daemon.indexOf("async function rehydrateFromTranscripts", start));

    const nested = body.indexOf("subagentSessions(session, session.transcriptPath ?? findTranscript(");
    const rows = body.indexOf("sessions: visible,");
    const conversations = body.indexOf("visible.slice(0, MAX_PUBLISHED_CONVERSATIONS)");
    const paths = body.indexOf("visible.flatMap((session) =>");
    for (const index of [nested, rows, conversations, paths]) expect(index).toBeGreaterThan(-1);
    expect(nested).toBeLessThan(rows);
    expect(rows).toBeLessThan(conversations);
    // Number shortcuts and the theater cursor stay on sessions conch can talk to.
    expect(body).toContain("numberPanelSessionRows(model.rows, live)");
    expect(body).toContain("theaterNavigation.reconcile(new Set(live.map(");
    expect(body).not.toContain("ledger.forgetGone(new Set(visible");
  });

  test("the Mac decodes parentSessionId and the subagent link with a default of none", () => {
    const models = read("mac-app/conch-mac/Models.swift");
    expect(models).toContain("let parentSessionId: String?");
    expect(models).toContain("parentSessionId =\n            try? container.decodeIfPresent(String.self, forKey: .parentSessionId)");
    expect(models).toContain("parentSessionId: String? = nil");
    expect(models).toContain("struct Subagent: Decodable, Equatable, Sendable");
    expect(models).toContain("subagent = try? c.decodeIfPresent(Subagent.self, forKey: .subagent)");
  });

  test("the dashboard indents a subagent, never types into it, and offers the way back", () => {
    const dashboard = read("mac-app/conch-mac/DashboardView.swift");
    expect(dashboard).toContain(".padding(.leading, row.parentSessionId == nil && row.startedBySessionId == nil ? 0 : 18)");
    expect(dashboard).toContain("if let row = focusedRow, row.parentSessionId == nil {\n                        composer(for: row)");
    expect(dashboard).toContain('.help("Back to \\(parent.label)")');
    expect(dashboard).toContain("$0.parentSessionId == nil && $0.label == state.live.label");
    // A finished agent has no row; the pane builds one from the block that started it.
    expect(dashboard).toContain("?? subagentRow(id: selectedSessionID)");
    expect(dashboard).toContain("transcriptPath: item.tool?.subagent?.transcriptPath");
  });

  test("a Task block opens its agent only when the daemon named one", () => {
    const stack = read("mac-app/conch-mac/ConversationStackView.swift");
    const site = stack.indexOf("if item.tool?.kind == .subagent, let agent = item.tool?.subagent {");
    expect(site).toBeGreaterThan(-1);
    const block = stack.slice(site, stack.indexOf("if expanded, !result.isEmpty {", site));
    expect(block).toContain("onOpenSubagent(agent)");
    expect(stack).toContain("var onOpenSubagent: (ConversationItem.Tool.Subagent) -> Void");
  });
});
