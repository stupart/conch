import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  LIVE_WINDOW_MS,
  liveBackgroundAgents,
  parseTaskNotice,
  resumedAgentOf,
  sidechainTranscriptPath,
  subagentRowId,
} from "../src/agent-activity.ts";
import { buildConversation } from "../src/conversation.ts";
import { LiveActivity, WAITING_ON_OWN_WORK_LINE } from "../src/live-activity.ts";
import { normalizeClaudeRecord } from "../src/records-claude.ts";
import type { RecordNormalizerContext } from "../src/records-types.ts";
import { subagentSessions, type SessionInfo } from "../src/sessions.ts";

/**
 * Tyler, 2026-11-12: "conch ui shows 3 sub-agents for u but it says 2 more in the claude code ui." Two causes, in the
 * shapes Claude Code 2.1.309 writes (ids, names and words here are made up):
 *
 * 1. A background agent that stops with background work of its own still running (a push, a gate) sends its parent a
 *    notification with `<status>completed</status>` and `Agent "<name>" is waiting on its own background work`. It
 *    is not finished, and Claude Code still counts it; conch dropped it.
 * 2. SendMessage to a stopped agent resumes it: `toolUseResult.resumedAgentId`, "Resuming agent <id>". The block that
 *    started it stayed finished, and a notification queued before the resume but filed after it ended it again.
 */

const SESSION = "11111111-2222-4333-8444-555555555555";
const T0 = Date.parse("2026-11-12T02:00:00.000Z");
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync("/tmp/conch-resume-");
  roots.push(root);
  const project = join(root, "-Users-someone-project");
  mkdirSync(project, { recursive: true });
  return { project, transcript: join(project, `${SESSION}.jsonl`) };
}

function launch(agentId: string, description: string, minutes = 0) {
  const toolUseId = `toolu_${agentId}`;
  return [
    {
      type: "assistant", uuid: `a-${agentId}`, timestamp: iso(minutes),
      message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: { description, prompt: "go", run_in_background: true } }] },
    },
    {
      type: "user", uuid: `u-${agentId}`, timestamp: iso(minutes),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text: `Async agent launched successfully.\nagentId: ${agentId}` }] }] },
      toolUseResult: { isAsync: true, status: "async_launched", agentId, description },
    },
  ];
}

const WAITING = (name: string) => `Agent "${name}" is waiting on its own background work`;
const FINISHED = (name: string) => `Agent "${name}" finished`;
const LIMIT = (name: string) =>
  `Agent "${name}" failed: Agent terminated early due to an API error: You've hit your weekly limit · resets Nov 14 at 6am (error type rate_limit, HTTP 429)`;

function noticeText(agentId: string, status: string, summary: string, withToolUseId = true): string {
  return [
    "<task-notification>",
    `<task-id>${agentId}</task-id>`,
    ...(withToolUseId ? [`<tool-use-id>toolu_${agentId}</tool-use-id>`] : []),
    `<output-file>/tmp/claude-test/tasks/${agentId}.output</output-file>`,
    `<status>${status}</status>`,
    `<summary>${summary}</summary>`,
    "<note>Made-up note: the same task-id may notify again.</note>",
    "<result>Made-up interim words.</result>",
    "</task-notification>",
  ].join("\n");
}

/** One notification in the three forms Claude Code files it: queued, as the parent's turn, and as an attachment. */
function notice(
  agentId: string,
  status: string,
  summary: string,
  minutes: number,
  carrier: "user" | "queue-operation" | "attachment" = "user",
) {
  const content = noticeText(agentId, status, summary, carrier !== "attachment");
  const timestamp = iso(minutes);
  if (carrier === "queue-operation") return { type: "queue-operation", operation: "enqueue", timestamp, content };
  if (carrier === "attachment") {
    return {
      type: "attachment", uuid: `q-${agentId}-${minutes}`, timestamp,
      attachment: { type: "queued_command", prompt: content, commandMode: "task-notification", origin: { kind: "task-notification" }, timestamp },
    };
  }
  return {
    type: "user", uuid: `n-${agentId}-${minutes}`, timestamp, promptSource: "system",
    message: { role: "user", content }, origin: { kind: "task-notification", producer: "session-task" },
  };
}

function resume(agentId: string, minutes: number, carry: "toolUseResult" | "text" = "toolUseResult") {
  const toolUseId = `toolu_send_${agentId}_${minutes}`;
  const result = { success: true, message: `Resuming agent ${agentId.slice(0, 7)}`, resumedAgentId: agentId, pin: { id: agentId, name: agentId, ref: "abc123" } };
  return [
    {
      type: "assistant", uuid: `s-${agentId}-${minutes}`, timestamp: iso(minutes),
      message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "SendMessage", input: { to: agentId, summary: "Carry on", message: "Carry on." } }] },
    },
    {
      type: "user", uuid: `r-${agentId}-${minutes}`, timestamp: iso(minutes),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text: JSON.stringify(result) }] }] },
      ...(carry === "toolUseResult" ? { toolUseResult: { ...result, revivedAgentId: agentId } } : {}),
    },
  ];
}

const lines = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry));

function writeParent(f: ReturnType<typeof fixture>, ...entries: unknown[]): void {
  writeFileSync(f.transcript, lines(...entries).join("\n") + "\n");
}

/** An agent's own transcript: it sent a push to the background, and stopped. */
function sidechain(f: ReturnType<typeof fixture>, agentId: string, options: { ownWork?: boolean; ageMinutes?: number } = {}): string {
  const path = sidechainTranscriptPath(f.transcript, agentId);
  mkdirSync(dirname(path), { recursive: true });
  const entries: unknown[] = [
    { type: "user", isSidechain: true, agentId, uuid: `p-${agentId}`, message: { role: "user", content: "Push the branch." } },
  ];
  if (options.ownWork) {
    entries.push(
      {
        type: "assistant", isSidechain: true, agentId, uuid: `b-${agentId}`,
        message: { role: "assistant", content: [{ type: "tool_use", id: `tu-${agentId}`, name: "Bash", input: { command: "git push", run_in_background: true } }] },
      },
      {
        type: "user", isSidechain: true, agentId, uuid: `br-${agentId}`,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu-${agentId}`, content: "Command running in background with ID: bg1." }] },
      },
    );
  }
  entries.push({
    type: "assistant", isSidechain: true, agentId, uuid: `e-${agentId}`,
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Still waiting on the push." }] },
  });
  writeFileSync(path, lines(...entries).join("\n") + "\n");
  const meta = path.replace(/\.jsonl$/, ".meta.json");
  writeFileSync(meta, JSON.stringify({ agentType: "general-purpose", description: `Agent ${agentId}` }));
  if (options.ageMinutes) {
    const at = new Date(Date.now() - options.ageMinutes * 60_000);
    utimesSync(path, at, at);
    utimesSync(meta, at, at);
  }
  return path;
}

/** A parent timeline in wall-clock minutes before now, so the scan's freshness windows see it as recent. */
const ago = (minutes: number) => (Date.now() - T0) / 60_000 - minutes;

describe("parsing what Claude Code says about an agent", () => {
  test("waiting is not an end; finished, failed and stopped are, and say why when they did not finish", () => {
    expect(parseTaskNotice(noticeText("a1", "completed", WAITING("Push it")))).toMatchObject({
      taskId: "a1", status: "completed", outcome: "waiting", failed: false,
    });
    expect(parseTaskNotice(noticeText("a1", "completed", WAITING("Push it")))!.stopped).toBeUndefined();
    const finished = parseTaskNotice(noticeText("a1", "completed", FINISHED("Push it")))!;
    expect(finished).toMatchObject({ outcome: "ended", failed: false });
    expect(finished.stopped).toBeUndefined();
    expect(parseTaskNotice(noticeText("a1", "failed", LIMIT("Push it")))).toMatchObject({ outcome: "ended", failed: true, stopped: "stopped: usage limit" });
    const why = (status: string, summary: string) => parseTaskNotice(noticeText("a1", status, summary))!.stopped;
    expect(why("failed", `Agent "x" failed: Agent stalled: no progress for 600s (stream watchdog did not recover)`)).toBe("stopped: stalled");
    expect(why("failed", `Agent "x" failed: Agent terminated early due to an API error: API Error: Connection reset`)).toBe("stopped: API error");
    expect(why("failed", `Agent "x" failed: Something new went wrong. Details follow`)).toBe("stopped: Something new went wrong");
    expect(why("killed", `Agent "x" was stopped by Claude`)).toBe("stopped");
    expect(why("completed", `Agent "x" stopped at its 200-turn limit (partial result; SendMessage to task-id to continue)`)).toBe("stopped: turn limit");
    // Older notifications, with no summary at all, end as they always did.
    expect(parseTaskNotice("<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>")!.outcome).toBe("ended");
    expect(parseTaskNotice("<task-notification><status>completed</status></task-notification>")).toBeNull();
  });

  test("a resume names its agent in toolUseResult, or in the result's JSON when that is all there is", () => {
    expect(resumedAgentOf({ success: true, message: "Resuming agent a1b2c3d", resumedAgentId: "a1b2c3d4e5" })).toBe("a1b2c3d4e5");
    expect(resumedAgentOf({ revivedAgentId: "a1b2c3d4e5" })).toBe("a1b2c3d4e5");
    expect(resumedAgentOf(undefined, JSON.stringify({ success: true, resumedAgentId: "a1b2c3d4e5" }))).toBe("a1b2c3d4e5");
    expect(resumedAgentOf({ success: true, message: "Message queued for delivery to a1b2c3d at its next tool round." })).toBeUndefined();
    expect(resumedAgentOf(undefined, "resumedAgentId, but not JSON")).toBeUndefined();
  });
});

describe("the sidebar keeps an agent Claude Code still counts", () => {
  test("waiting on its own background work, it stays a row whose line says so; finishing ends it", async () => {
    const f = fixture();
    // It wrote its last words a moment before the notification, as Claude Code does.
    sidechain(f, "aaa1", { ownWork: true, ageMinutes: 1 });
    const stopped = ago(1);
    writeParent(f, ...launch("aaa1", "Push it", ago(30)), notice("aaa1", "completed", WAITING("Push it"), stopped));
    const live = liveBackgroundAgents(f.transcript);
    expect(live.map((agent) => agent.agentId)).toEqual(["aaa1"]);
    expect(live[0]!.waitingSince).toBe(Date.parse(iso(stopped)));

    const parent: SessionInfo = { sessionId: SESSION, name: "conch", cwd: "/work", backend: "claude", pid: 42 };
    const [row] = await subagentSessions(parent, f.transcript);
    expect(row).toMatchObject({ sessionId: subagentRowId("aaa1"), status: "busy", waitingOnOwnWorkSince: Date.parse(iso(stopped)) });

    const activity = new LiveActivity();
    await activity.observe([{ id: row!.sessionId, transcriptPath: row!.transcriptPath!, format: "claude", waitingOnOwnWorkSince: row!.waitingOnOwnWorkSince }]);
    expect(activity.select([row!.sessionId], Date.now()).activities.get(row!.sessionId)).toMatchObject({
      text: WAITING_ON_OWN_WORK_LINE, kind: "step",
    });

    writeParent(
      f,
      ...launch("aaa1", "Push it", ago(30)),
      notice("aaa1", "completed", WAITING("Push it"), stopped),
      notice("aaa1", "completed", FINISHED("Push it"), ago(0.5)),
    );
    expect(liveBackgroundAgents(f.transcript)).toEqual([]);
  });

  test("quiet past six minutes while it waits, it is still listed; finished or with no work of its own, it is not", () => {
    const f = fixture();
    sidechain(f, "aaa1", { ownWork: true, ageMinutes: 40 });
    sidechain(f, "bbb2", { ownWork: true, ageMinutes: 40 });
    sidechain(f, "ccc3", { ageMinutes: 40 });
    writeParent(
      f,
      ...launch("aaa1", "Push it", ago(90)),
      ...launch("bbb2", "Gate it", ago(80)),
      ...launch("ccc3", "Read it", ago(70)),
      notice("aaa1", "completed", WAITING("Push it"), ago(40)),
      notice("bbb2", "completed", FINISHED("Gate it"), ago(40)),
      notice("ccc3", "completed", WAITING("Read it"), ago(40)),
    );
    expect(LIVE_WINDOW_MS).toBeLessThan(40 * 60_000);
    expect(liveBackgroundAgents(f.transcript).map((agent) => agent.agentId)).toEqual(["aaa1"]);
  });

  test("silent past three hours, a waiting agent is no longer listed", () => {
    const f = fixture();
    sidechain(f, "aaa1", { ownWork: true, ageMinutes: 181 });
    writeParent(f, ...launch("aaa1", "Push it", ago(200)), notice("aaa1", "completed", WAITING("Push it"), ago(181)));
    expect(liveBackgroundAgents(f.transcript)).toEqual([]);
  });

  test("woken by its own work reporting, it is running again, not waiting", () => {
    const f = fixture();
    const path = sidechain(f, "aaa1", { ownWork: true });
    writeParent(f, ...launch("aaa1", "Push it", ago(30)), notice("aaa1", "completed", WAITING("Push it"), ago(3)));
    appendFileSync(path, JSON.stringify({ type: "user", isSidechain: true, agentId: "aaa1", uuid: "w-aaa1", message: { role: "user", content: "The push finished." } }) + "\n");
    const live = liveBackgroundAgents(f.transcript);
    expect(live.map((agent) => agent.agentId)).toEqual(["aaa1"]);
    expect(live[0]!.waitingSince).toBeUndefined();
  });

  test("stopped by a usage limit it is gone; resumed it is back, though a stale queued copy lands after the resume", () => {
    const f = fixture();
    sidechain(f, "aaa1");
    const stopped = [...launch("aaa1", "Slim it", ago(60)), notice("aaa1", "failed", LIMIT("Slim it"), ago(5), "queue-operation"), notice("aaa1", "failed", LIMIT("Slim it"), ago(5))];
    writeParent(f, ...stopped);
    expect(liveBackgroundAgents(f.transcript)).toEqual([]);

    writeParent(f, ...stopped, ...resume("aaa1", ago(2)));
    expect(liveBackgroundAgents(f.transcript).map((agent) => agent.agentId)).toEqual(["aaa1"]);

    // The order Claude Code wrote on 2026-11-12: queued at :59, resumed at :02, the queued copy filed after the resume.
    writeParent(
      f,
      ...launch("aaa1", "Slim it", ago(60)),
      notice("aaa1", "completed", FINISHED("Slim it"), ago(2.1), "queue-operation"),
      ...resume("aaa1", ago(2)),
      notice("aaa1", "completed", FINISHED("Slim it"), ago(2.1), "attachment"),
    );
    expect(liveBackgroundAgents(f.transcript).map((agent) => agent.agentId)).toEqual(["aaa1"]);

    // A notification written after the resume is about the resumed run, and ends it.
    writeParent(f, ...stopped, ...resume("aaa1", ago(2)), notice("aaa1", "failed", LIMIT("Slim it"), ago(1)));
    expect(liveBackgroundAgents(f.transcript)).toEqual([]);
  });
});

describe("the block that started an agent says what became of it", () => {
  const block = (conversation: ReturnType<typeof buildConversation>) => conversation.items["tool:toolu_aaa1"]!.tool!;

  test("waiting keeps it running and says so; every form of the notification agrees; finishing ends it", () => {
    for (const carrier of ["user", "queue-operation", "attachment"] as const) {
      const waiting = buildConversation("s", lines(...launch("aaa1", "Push it"), notice("aaa1", "completed", WAITING("Push it"), 5, carrier)), "claude");
      expect(block(waiting)).toMatchObject({ status: "running", subagent: { id: "agent-aaa1", waiting: true } });
    }
    const finished = buildConversation("s", lines(
      ...launch("aaa1", "Push it"),
      notice("aaa1", "completed", WAITING("Push it"), 5),
      notice("aaa1", "completed", FINISHED("Push it"), 9),
    ), "claude");
    expect(block(finished)).toMatchObject({ status: "done", subagent: { id: "agent-aaa1" } });
    expect(block(finished).subagent!.waiting).toBeUndefined();
    expect(block(finished).subagent!.stopped).toBeUndefined();
  });

  test("a usage limit ends it and says why; a resume runs it again; a stale copy after the resume changes nothing", () => {
    const stopped = buildConversation("s", lines(...launch("aaa1", "Slim it"), notice("aaa1", "failed", LIMIT("Slim it"), 30)), "claude");
    expect(block(stopped)).toMatchObject({ status: "error", subagent: { stopped: "stopped: usage limit" } });

    for (const carry of ["toolUseResult", "text"] as const) {
      const resumed = buildConversation("s", lines(
        ...launch("aaa1", "Slim it"),
        notice("aaa1", "failed", LIMIT("Slim it"), 30),
        ...resume("aaa1", 40, carry),
        notice("aaa1", "failed", LIMIT("Slim it"), 30, "attachment"),
      ), "claude");
      expect(block(resumed)).toMatchObject({ status: "running", subagent: { id: "agent-aaa1", resumedAt: Date.parse(iso(40)) } });
      expect(block(resumed).subagent!.stopped).toBeUndefined();
      // The SendMessage row is still the message it sent (#615), not a step of its own.
      expect(resumed.items["tool:toolu_send_aaa1_40"]!.peer).toBeDefined();
    }

    const again = buildConversation("s", lines(
      ...launch("aaa1", "Slim it"),
      notice("aaa1", "failed", LIMIT("Slim it"), 30),
      ...resume("aaa1", 40),
      notice("aaa1", "completed", FINISHED("Slim it"), 55),
    ), "claude");
    expect(block(again).status).toBe("done");
    expect(block(again).subagent!.stopped).toBeUndefined();
  });

  test("a notification about a background command names no block and changes nothing", () => {
    const bash = buildConversation("s", lines(
      ...launch("aaa1", "x"),
      notice("bzz9", "completed", `Background command "Run the gate" completed (exit code 0)`, 5),
    ), "claude");
    expect(block(bash).status).toBe("running");
  });
});

describe("history agrees with the live window", () => {
  function harness(): RecordNormalizerContext {
    return { sessionId: "s", sourceId: "claude-log", generation: 0, offset: 0, state: {}, turnForItem: () => undefined, itemForNativeId: () => undefined };
  }

  test("a notification is stored as the line the live window shows, never as Tyler's words, and starts no turn", () => {
    for (const summary of [WAITING("Push it"), LIMIT("Slim it")]) {
      const entry = notice("aaa1", summary === LIMIT("Slim it") ? "failed" : "completed", summary, 5);
      const out = normalizeClaudeRecord(entry, harness());
      expect(out.items).toHaveLength(1);
      expect(out.items[0]).toMatchObject({ kind: "material", role: "system", text: summary });
      expect(out.turns).toEqual([]);

      const live = buildConversation("s", lines(entry), "claude");
      const material = live.items[live.order[0]!]!;
      expect(material.material).toMatchObject({ kind: "task", detail: summary });
    }
  });

  test("Tyler's own words that mention a notification are still his", () => {
    const out = normalizeClaudeRecord({ type: "user", uuid: "u1", message: { role: "user", content: "why does <task-notification> show?" } }, harness());
    expect(out.items[0]).toMatchObject({ kind: "message", role: "user" });
  });
});

describe("the apps show it on the block", () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

  test("the Mac and the phone decode waiting and stopped, and draw them after the agent's name", () => {
    const mac = read("mac-app/conch-mac/Models.swift");
    expect(mac).toContain("waiting = (try? c.decodeIfPresent(Bool.self, forKey: .waiting)) ?? false");
    expect(mac).toContain("stopped = try? c.decodeIfPresent(String.self, forKey: .stopped)");
    expect(read("mac-app/conch-mac/ConversationStackView.swift")).toContain("if let note = item.tool?.subagent?.note {");
    const phone = read("mobile/conch-ios/conch-ios/Models.swift");
    expect(phone).toContain("c.nestedContainer(keyedBy: SubagentKeys.self, forKey: .subagent)");
    expect(read("mobile/conch-ios/conch-ios/ConversationStack.swift")).toContain("if let note = item.tool?.subagentNote {");
  });
});
