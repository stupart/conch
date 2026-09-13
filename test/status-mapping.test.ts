import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { liveBackgroundAgents, sessionHasLiveBackgroundWork, sidechainTranscriptPath } from "../src/agent-activity.ts";
import type { TurnEvent } from "../src/hook.ts";
import { buildPanelRows, type PanelSessionState } from "../src/panel.ts";
import { findTranscript, registrySnapshot, subagentSessions } from "../src/sessions.ts";
import { downgradeTurnWithLiveBackgroundWork } from "../src/voice-loop.ts";

/**
 * Working vs not working, end to end from what Claude Code 2.1.266 writes:
 * `~/.claude/sessions/<pid>.json` (status is only busy | idle | shell |
 * waiting, rewritten only when it changes) and the parent transcript's
 * subagent records, copied from a real one: an async launch, a completion as
 * a queue-operation plus a task-notification user message, and a SendMessage
 * result carrying `resumedAgentId`.
 */
const CWD = "/Users/t";
const PARENT = "11111111-2222-4333-8444-555555555555";
const AGENT = "ac5fd8748539ae7fb";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const claudeDir = mkdtempSync(join(tmpdir(), "conch-status-"));
  roots.push(claudeDir);
  mkdirSync(join(claudeDir, "sessions"), { recursive: true });
  const project = join(claudeDir, "projects", CWD.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const options = { configDir: join(claudeDir, "conch-config"), codexHome: join(claudeDir, "codex"), processParents: async () => null };
  return {
    claudeDir,
    options,
    registry(pid: number, entry: object) {
      writeFileSync(join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({
        pid, cwd: CWD, kind: "interactive", entrypoint: "cli", startedAt: 1, ...entry,
      }));
    },
    /** The parent transcript, plus a fresh sidechain for AGENT. */
    parent(...records: object[]) {
      const path = join(project, `${PARENT}.jsonl`);
      writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const side = sidechainTranscriptPath(path, AGENT);
      mkdirSync(dirname(side), { recursive: true });
      writeFileSync(side, JSON.stringify({ type: "assistant", isSidechain: true, agentId: AGENT, message: { role: "assistant", content: [{ type: "text", text: "on it" }] } }) + "\n");
      writeFileSync(side.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Fix the flaky test" }));
      return path;
    },
    append(path: string, ...records: object[]) {
      appendFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    },
    async rows(states: Map<string, PanelSessionState> = new Map()) {
      const snap = (await registrySnapshot(claudeDir, options))!;
      const live = snap.infos.filter((s) => s.backend !== "codex");
      const nested = live.flatMap((s) => subagentSessions(s, s.transcriptPath ?? findTranscript(claudeDir, s.sessionId, options)));
      return buildPanelRows({
        sessions: [...live, ...nested],
        sessionStates: states,
        pausedSessionIds: new Set(),
        live: { state: "idle", label: "", partial: "" },
        mode: { muted: false, paused: false, holding: 0 },
        activeSessionId: null,
        navSelectedId: null,
      });
    },
  };
}

const launched = (id: string) => ({
  type: "user",
  uuid: "launch",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_launch", content: [{ type: "text", text: `Async agent launched successfully.\nagentId: ${id}` }] }] },
  toolUseResult: { isAsync: true, status: "async_launched", agentId: id, description: "Fix the flaky test" },
});

const completed = (id: string, n: number) => {
  const content = `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>`;
  return [
    { type: "queue-operation", operation: "enqueue", content },
    { type: "user", uuid: `done-${n}`, message: { role: "user", content }, origin: { kind: "task-notification" } },
  ];
};

const resumed = (id: string, n: number) => {
  const result = { success: true, message: `Resuming agent ${id.slice(0, 7)}`, resumedAgentId: id, pin: { id, name: id, ref: "5502fd" } };
  return {
    type: "user",
    uuid: `resume-${n}`,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_send${n}`, content: [{ type: "text", text: JSON.stringify(result) }] }] },
    toolUseResult: result,
    sourceToolAssistantUUID: `send-${n}`,
  };
};

const statusOf = (rows: Awaited<ReturnType<ReturnType<typeof fixture>["rows"]>>, id: string) =>
  rows.find((row) => row.sessionId === id)?.status;

/** What the Stop hook and the daemon's downgrade latch for a finished turn. */
function stopLatch(transcriptPath: string, at: number): PanelSessionState {
  const event: TurnEvent = { type: "turn-end", sessionId: PARENT, label: "parent", announce: "", transcriptPath, eventAt: at };
  downgradeTurnWithLiveBackgroundWork(event, sessionHasLiveBackgroundWork(transcriptPath));
  return { label: "parent", status: event.type === "working" ? "working" : "waiting", at };
}

describe("registry status on a row", () => {
  test("shell reads as waiting, busy as working, waiting as needs", async () => {
    const f = fixture();
    f.registry(101, { sessionId: "shell-session", name: "dev server", status: "shell", statusUpdatedAt: 1000 });
    f.registry(102, { sessionId: "busy-session", name: "mid turn", status: "busy", statusUpdatedAt: 1000 });
    f.registry(103, { sessionId: "needs-session", name: "permission", status: "waiting", statusUpdatedAt: 1000 });
    f.registry(104, { sessionId: "idle-session", name: "done", status: "idle", statusUpdatedAt: 1000 });
    const rows = await f.rows();
    expect(statusOf(rows, "shell-session")).toBe("waiting");
    expect(statusOf(rows, "busy-session")).toBe("working");
    expect(statusOf(rows, "needs-session")).toBe("needs");
    expect(statusOf(rows, "idle-session")).toBe("waiting");
  });
});

describe("a subagent resumed with SendMessage", () => {
  test("is live again until its next completion, and closes on it", async () => {
    const f = fixture();
    f.registry(201, { sessionId: PARENT, name: "parent", status: "busy", statusUpdatedAt: 1000 });
    const path = f.parent(launched(AGENT), ...completed(AGENT, 1));
    expect(liveBackgroundAgents(path)).toEqual([]);

    f.append(path, resumed(AGENT, 1));
    expect(liveBackgroundAgents(path).map((a) => a.agentId)).toEqual([AGENT]);
    expect(statusOf(await f.rows(), `agent-${AGENT}`)).toBe("working");

    f.append(path, ...completed(AGENT, 2));
    expect(liveBackgroundAgents(path)).toEqual([]);
    expect((await f.rows()).map((row) => row.sessionId)).toEqual([PARENT]);

    // A second resume reopens it again.
    f.append(path, resumed(AGENT, 2));
    expect(liveBackgroundAgents(path).map((a) => a.agentId)).toEqual([AGENT]);
  });

  test("the parent's turn ending while it runs: parent and subagent both read working", async () => {
    const f = fixture();
    // Claude Code keeps the parent `busy` while a background agent runs and
    // does not rewrite the file, so its timestamp stays older than the Stop.
    f.registry(301, { sessionId: PARENT, name: "parent", status: "busy", statusUpdatedAt: 1000 });
    const path = f.parent(launched(AGENT), ...completed(AGENT, 1), resumed(AGENT, 1));

    const during = await f.rows(new Map([[PARENT, stopLatch(path, 2000)]]));
    expect(statusOf(during, PARENT)).toBe("working");
    expect(statusOf(during, `agent-${AGENT}`)).toBe("working");

    // It finishes, wakes the parent, and the parent's next Stop is a real turn end.
    f.append(path, ...completed(AGENT, 2));
    const after = await f.rows(new Map([[PARENT, stopLatch(path, 3000)]]));
    expect(statusOf(after, PARENT)).toBe("waiting");
    expect(after.map((row) => row.sessionId)).toEqual([PARENT]);
  });
});

describe("a window parked on a background job that is no longer listed", () => {
  test("its frozen busy is not work: waiting, a pre-park latch loses, a newer one wins", async () => {
    const f = fixture();
    f.registry(401, { sessionId: "pred", name: "window", parkedJobId: "gonejob", status: "busy", statusUpdatedAt: 100 });
    f.registry(402, { sessionId: "plain", name: "plain", status: "busy", statusUpdatedAt: 100 });

    const rows = await f.rows();
    expect(statusOf(rows, "pred")).toBe("waiting");
    expect(statusOf(rows, "plain")).toBe("working");

    const prePark = new Map([["pred", { label: "window", status: "working" as const, at: 50 }]]);
    expect(statusOf(await f.rows(prePark), "pred")).toBe("waiting");

    const newer = new Map([["pred", { label: "window", status: "needs" as const, at: 200 }]]);
    expect(statusOf(await f.rows(newer), "pred")).toBe("needs");
  });
});
