import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexSessionEntry } from "../src/codex-sessions.ts";
import { buildPanelModel, buildPanelRows, buildPublishedState } from "../src/panel.ts";
import { registrySnapshot, sessionLabel, subagentSessions, type SessionInfo } from "../src/sessions.ts";
import {
  codexThreadDbPaths,
  codexThreadLabel,
  codexThreadStatus,
  detectCodexApprovals,
  detectCodexTurnEnds,
  isInterAgentEnvelope,
  readCodexHelperThreads,
  readCodexOpenThreadIds,
  readCodexRolloutTail,
  readCodexThreads,
  readCodexTurnSnapshots,
  readCodexTurnStatuses,
  type CodexTurnMemory,
} from "../src/codex-threads.ts";

/** Build a throwaway pair of databases shaped like Codex 0.147's. */
function codexHome(
  threads: Array<Record<string, unknown>>,
  turns: Array<{ thread_id: string; rollout_ordinal: number; status: string }> = [],
): string {
  const home = mkdtempSync(join(tmpdir(), "conch-codex-home-"));
  const state = new Database(join(home, "state_5.sqlite"));
  state.run(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, cwd TEXT, name TEXT, agent_nickname TEXT, title TEXT,
    rollout_path TEXT, updated_at_ms INTEGER, archived INTEGER, source TEXT)`);
  for (const t of threads) {
    state.run(
      `INSERT INTO threads (id, cwd, name, agent_nickname, title, rollout_path, updated_at_ms, archived, source)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        t.id, t.cwd ?? "/tmp", t.name ?? null, t.agent_nickname ?? null,
        t.title ?? "", t.rollout_path ?? "", t.updated_at_ms ?? 0,
        t.archived ?? 0, t.source ?? "cli",
      ] as any,
    );
  }
  state.close();

  const hist = new Database(join(home, "thread_history_1.sqlite"));
  hist.run(`CREATE TABLE thread_turns (
    thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT)`);
  for (const t of turns) {
    hist.run(
      `INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status) VALUES (?,?,?,?)`,
      [t.thread_id, `${t.thread_id}-${t.rollout_ordinal}`, t.rollout_ordinal, t.status] as any,
    );
  }
  hist.close();
  return home;
}

const NOW = 1_786_000_000_000;

describe("observing Codex sessions without touching them", () => {
  test("reports interactive threads with their live turn status", async () => {
    const home = codexHome(
      [
        { id: "a", name: "asset generator", updated_at_ms: NOW - 1000, source: "cli" },
        { id: "b", title: "humain", updated_at_ms: NOW - 2000, source: "vscode" },
      ],
      [
        // Only the LATEST turn decides busy/idle — an older completed turn on
        // the same thread must not mask a running one.
        { thread_id: "a", rollout_ordinal: 1, status: "completed" },
        { thread_id: "a", rollout_ordinal: 2, status: "inProgress" },
        { thread_id: "b", rollout_ordinal: 1, status: "completed" },
      ],
    );
    try {
      const read = await readCodexThreads({ codexHome: home, now: NOW });
      expect(read.available).toBe(true);
      expect(read.complete).toBe(true);
      expect(read.entries.map((e) => [(e as any).name, e.status])).toEqual([
        ["asset generator", "busy"],
        ["humain", "idle"],
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("excludes one-shot `exec` runs, which are scripts and not sessions", async () => {
    // Measured on the real machine: 354 exec rows against 9 cli and 45 vscode,
    // because every `codex exec` leaves a permanent row — including the probes
    // used to build this feature. Nobody is sitting in one waiting to be
    // announced at.
    const home = codexHome([
      { id: "real", name: "asset generator", updated_at_ms: NOW, source: "cli" },
      { id: "script", name: "some automation", updated_at_ms: NOW, source: "exec" },
    ]);
    try {
      expect((await readCodexThreads({ codexHome: home, now: NOW })).entries.map((e) => e.sessionId))
        .toEqual(["real"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("excludes subagents, matching how Claude sessions are already listed", async () => {
    // Codex records a spawned subagent with a JSON `source` naming its parent,
    // and auto-nicknames it (Averroes, Nash, Sartre on Tyler's machine). conch
    // lists top-level sessions, not the agents they spawn.
    const home = codexHome([
      { id: "parent", name: "asset generator", updated_at_ms: NOW, source: "cli" },
      {
        id: "child",
        agent_nickname: "Averroes",
        updated_at_ms: NOW,
        source: '{"subagent":{"thread_spawn":{"parent_thread_id":"parent","depth":1}}}',
      },
    ]);
    try {
      expect((await readCodexThreads({ codexHome: home, now: NOW })).entries.map((e) => e.sessionId))
        .toEqual(["parent"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("drops threads outside the liveness window", async () => {
    // These rows are permanent history, unlike Claude's per-pid files which
    // vanish with the process. Without a window the ledger fills with every
    // conversation ever held.
    const home = codexHome([
      { id: "fresh", name: "today", updated_at_ms: NOW - 60_000, source: "cli" },
      { id: "ancient", name: "last week", updated_at_ms: NOW - 7 * 86_400_000, source: "cli" },
    ]);
    try {
      expect((await readCodexThreads({ codexHome: home, now: NOW })).entries.map((e) => e.sessionId))
        .toEqual(["fresh"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("never reads the real ~/.codex when conch's state is redirected", async () => {
    // A registry test running in a temp directory silently read the developer's
    // ACTUAL Codex sessions and asserted against whatever they were doing —
    // which is how this was caught: five unrelated tests began failing when two
    // live threads appeared in a snapshot built from an empty directory.
    expect(await readCodexThreads({ configDir: "/tmp/nowhere", now: NOW }))
      .toEqual({ entries: [], complete: true, available: false });

    const previous = process.env.CONCH_CONFIG_DIR;
    process.env.CONCH_CONFIG_DIR = "/tmp/nowhere";
    try {
      expect((await readCodexThreads({ now: NOW })).available).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CONCH_CONFIG_DIR;
      else process.env.CONCH_CONFIG_DIR = previous;
    }
  });

  test("a machine with no Codex is known-empty, not an incomplete read", async () => {
    // complete=false makes liveness logic treat sessions as possibly-gone. A
    // machine that simply has no Codex must not look like a failed read.
    expect(await readCodexThreads({ codexHome: "/tmp/definitely-not-codex", now: NOW }))
      .toEqual({ entries: [], complete: true, available: false });
  });

  test("labels from the thread, never from the working directory", () => {
    // conch labels a Claude session by directory basename, which works because
    // those live in different repos. Every one of Tyler's Codex threads runs
    // from his home directory, so that rule would render every row
    // "tylerstupart".
    expect(codexThreadLabel({ name: "asset generator", agent_nickname: "Nash", title: "x" }))
      .toBe("asset generator");
    expect(codexThreadLabel({ agent_nickname: "Nash", title: "x" })).toBe("Nash");
    expect(codexThreadLabel({ title: "find the asset generator repo" }))
      .toBe("find the asset generator repo");
    expect(codexThreadLabel({ name: "   ", title: "fallback" })).toBe("fallback");
    expect(codexThreadLabel({})).toBeUndefined();
    expect(codexThreadLabel({ title: "x".repeat(80) })).toHaveLength(40);
  });
});

/**
 * Real lines from Tyler's rollout of 2026-09-19, reduced only by trimming a
 * long input script and long tool output. The escalated call had no
 * `custom_tool_call_output` after it for hours, and the thread reported "busy"
 * — which the panel renders as "working" — the entire time.
 */
const STARTED_LINE = String.raw`{"timestamp":"2026-09-19T11:51:05.614Z","ordinal":89,"type":"event_msg","payload":{"type":"task_started","turn_id":"01a0b981-7a87-7cb2-8320-79a8e0312f86","started_at":1789818665,"model_context_window":258400,"collaboration_mode_kind":"default"}}`;
const ESCALATED_LINE = String.raw`{"timestamp":"2026-09-19T11:51:31.795Z","ordinal":107,"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_0f19e8bf8f5bb023016aae7740998087d29c15626dd510a213","status":"completed","call_id":"call_R3SFJWQHZ4ebOGHTATol2WJF","name":"exec","input":"text(await tools.exec_command({cmd:\"bun install --frozen-lockfile\",workdir:\"/Users/tylerstupart/Projects/Seashell/.worktrees/fix-humain-integration\",sandbox_permissions:\"require_escalated\",justification:\"May I download the locked Seashell dependencies to run its test suite and reproduce bugs?\",prefix_rule:[\"bun\",\"install\"],yield_time_ms:10000,max_output_tokens:1500}));\n","internal_chat_message_metadata_passthrough":{"turn_id":"01a0b981-7a87-7cb2-8320-79a8e0312f86","create_time":1789818678.512885}}}`;
const ESCALATED_ANSWERED = String.raw`{"timestamp":"2026-09-19T11:52:02.118Z","ordinal":113,"type":"response_item","payload":{"type":"custom_tool_call_output","id":"ctco_01a0b981-aac4-7182-bc32-ff832f55110f","call_id":"call_R3SFJWQHZ4ebOGHTATol2WJF","output":[{"type":"input_text","text":"Script completed\nWall time 12.4 seconds\nOutput:\n"}]}}`;

describe("Codex sessions blocked on a permission ask", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A rollout on disk, named the way Codex names them so the reader routes to it. */
  function rollout(...lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "conch-codex-approval-"));
    homes.push(dir);
    const path = join(dir, "rollout-2026-09-19T19-00-38-01a0b8e5.jsonl");
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  }

  const snapshot = (transcriptPath: string, status: "busy" | "idle" = "busy") => [{
    sessionId: "s", label: "seashell", cwd: "/tmp", transcriptPath,
    size: 0, turnId: "01a0b981", status, text: "",
  }];

  test("a waiting ask is reported once, however often the poll runs", () => {
    // The daemon polls every five seconds. Announcing the same ask on every
    // pass would make one prompt nag forever.
    const memory = new Map<string, string>();
    const snaps = snapshot(rollout(STARTED_LINE, ESCALATED_LINE));
    const first = detectCodexApprovals(memory, snaps);
    expect(first.map((e) => e.approval?.id)).toEqual(["call_R3SFJWQHZ4ebOGHTATol2WJF"]);
    expect(first[0]!.approval!.summary).toBe("bun install --frozen-lockfile");
    expect(detectCodexApprovals(memory, snaps)).toEqual([]);
    expect(detectCodexApprovals(memory, snaps)).toEqual([]);
  });

  test("an answered ask clears while the thread works on", () => {
    // Approving it does not end the turn. Without this the row would sit on
    // "needs you" until the whole turn finished, which can be many minutes.
    const memory = new Map<string, string>();
    expect(detectCodexApprovals(memory, snapshot(rollout(STARTED_LINE, ESCALATED_LINE)))).toHaveLength(1);
    const answered = detectCodexApprovals(memory, snapshot(rollout(STARTED_LINE, ESCALATED_LINE, ESCALATED_ANSWERED)));
    expect(answered).toHaveLength(1);
    expect(answered[0]!.approval).toBeNull();
    expect(memory.size).toBe(0);
  });

  test("says nothing about a session that never had an ask", () => {
    const memory = new Map<string, string>();
    expect(detectCodexApprovals(memory, snapshot(rollout(STARTED_LINE)))).toEqual([]);
    expect(memory.size).toBe(0);
  });

  test("forgets a session that drops out of the listing", () => {
    const memory = new Map<string, string>();
    detectCodexApprovals(memory, snapshot(rollout(STARTED_LINE, ESCALATED_LINE)));
    expect(memory.size).toBe(1);
    detectCodexApprovals(memory, []);
    expect(memory.size).toBe(0);
  });
});

describe("deciding a Codex turn has ended", () => {
  const base = {
    sessionId: "s", label: "asset generator", cwd: "/tmp",
    transcriptPath: "/tmp/rollout-x.jsonl", size: 0,
  };
  const done = (turnId: string, text = "All green.") =>
    [{ ...base, turnId, status: "idle" as const, text }];
  const running = (turnId: string) =>
    [{ ...base, turnId, status: "busy" as const, text: "" }];

  test("a first sighting is seeded silently", () => {
    // These rollouts are permanent history. Announcing on first sight would
    // make every daemon restart read out a backlog of old turns.
    const memory: CodexTurnMemory = new Map();
    expect(detectCodexTurnEnds(memory, done("t1"))).toEqual([]);
    expect(memory.get("s")).toEqual({ announcedTurnId: "t1" });
  });

  test("a turn already running at first sighting announces when it ends, once", () => {
    // Seeding the in-progress id as announced made this turn's own completion
    // look already spoken for, so the first turn conch caught mid-flight was
    // never heard. Only an already-finished turn stays silent (above).
    const memory: CodexTurnMemory = new Map();
    expect(detectCodexTurnEnds(memory, running("t1"))).toEqual([]);
    expect(detectCodexTurnEnds(memory, running("t1"))).toEqual([]);
    expect(detectCodexTurnEnds(memory, done("t1")).map((e) => e.text)).toEqual(["All green."]);
    expect(detectCodexTurnEnds(memory, done("t1"))).toEqual([]);
  });

  test("announces a turn id it has not spoken for", () => {
    const memory: CodexTurnMemory = new Map();
    detectCodexTurnEnds(memory, done("t1"));
    expect(detectCodexTurnEnds(memory, done("t2")).map((e) => e.text)).toEqual(["All green."]);
  });

  test("never announces the same turn twice", () => {
    const memory: CodexTurnMemory = new Map();
    detectCodexTurnEnds(memory, done("t1"));
    expect(detectCodexTurnEnds(memory, done("t2"))).toHaveLength(1);
    expect(detectCodexTurnEnds(memory, done("t2"))).toHaveLength(0);
    expect(detectCodexTurnEnds(memory, done("t2"))).toHaveLength(0);
  });

  test("stays quiet while a turn is still running", () => {
    const memory: CodexTurnMemory = new Map();
    detectCodexTurnEnds(memory, done("t1"));
    expect(detectCodexTurnEnds(memory, running("t2"))).toEqual([]);
    expect(detectCodexTurnEnds(memory, done("t2"))).toHaveLength(1);
  });

  test("an aborted turn ends without speaking", () => {
    // turn_aborted is over but said nothing; announcing it would put the
    // previous turn's words in its mouth.
    const memory: CodexTurnMemory = new Map();
    detectCodexTurnEnds(memory, done("t1"));
    expect(detectCodexTurnEnds(memory, [{ ...base, turnId: "t2", status: "idle", text: "" }]))
      .toEqual([]);
    // …and it is still marked seen, so it cannot resurface later.
    expect(memory.get("s")).toEqual({ announcedTurnId: "t2" });
  });

  test("a failed turn says nothing either, but is announced with why it failed", () => {
    const memory: CodexTurnMemory = new Map();
    detectCodexTurnEnds(memory, done("t1"));
    const failed = { ...base, turnId: "t2", status: "idle" as const, text: "", error: "You've hit your usage limit." };
    expect(detectCodexTurnEnds(memory, [failed])).toEqual([failed]);
  });

  test("a session leaving and returning is re-seeded rather than replayed", () => {
    const memory: CodexTurnMemory = new Map();
    detectCodexTurnEnds(memory, done("t1"));
    expect(detectCodexTurnEnds(memory, [])).toEqual([]);
    expect(memory.has("s")).toBe(false);
    expect(detectCodexTurnEnds(memory, done("t9"))).toEqual([]);
  });
});

describe("inter-agent traffic is not a reply", () => {
  test("recognises a subagent envelope", () => {
    // Verbatim from Tyler's "humain" thread, whose last agent_message was
    // addressed to a parent agent rather than to him.
    expect(isInterAgentEnvelope(
      "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/some_agent\n\nresult",
    )).toBe(true);
  });

  test("does not swallow a real reply that merely mentions it", () => {
    expect(isInterAgentEnvelope("I looked at the Message Type: FINAL_ANSWER envelope you asked about."))
      .toBe(false);
    expect(isInterAgentEnvelope("Done — the tests pass.")).toBe(false);
  });
});

describe("reading a turn out of a real rollout file", () => {
  function rollout(home: string, id: string, lines: unknown[]): string {
    const dir = join(home, "sessions");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-2026-08-07T00-00-00-${id}.jsonl`);
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return path;
  }
  const complete = (turnId: string, text: string) => ({
    type: "event_msg",
    payload: { type: "task_complete", turn_id: turnId, last_agent_message: text },
  });
  const started = (turnId: string) => ({
    type: "event_msg",
    payload: { type: "task_started", turn_id: turnId },
  });
  const noise = (n: number) => ({
    type: "response_item",
    payload: { type: "reasoning", text: `thinking ${n}`.padEnd(200, "x") },
  });

  test("the whole chain: a finished rollout becomes exactly one announcement", async () => {
    const home = mkdtempSync(join(tmpdir(), "conch-codex-home-"));
    try {
      const path = rollout(home, "t1", [noise(1), complete("turn-1", "First reply.")]);
      const state = new Database(join(home, "state_5.sqlite"));
      state.run(`CREATE TABLE threads (
        id TEXT PRIMARY KEY, cwd TEXT, name TEXT, agent_nickname TEXT, title TEXT,
        rollout_path TEXT, updated_at_ms INTEGER, archived INTEGER, source TEXT)`);
      state.run(
        `INSERT INTO threads VALUES ('t1','/repo','asset generator',NULL,'',?,?,0,'cli')`,
        [path, NOW] as any,
      );
      state.close();

      const memory: CodexTurnMemory = new Map();
      const opts = { codexHome: home, now: NOW };

      // Poll 1 seeds on the turn that was already finished.
      expect(detectCodexTurnEnds(memory, await readCodexTurnSnapshots(opts))).toEqual([]);

      // A new turn starts: still quiet.
      appendFileSync(path, JSON.stringify(started("turn-2")) + "\n");
      expect(detectCodexTurnEnds(memory, await readCodexTurnSnapshots(opts))).toEqual([]);

      // …and completes: announce, once, in the agent's own words.
      appendFileSync(path, JSON.stringify(complete("turn-2", "Second reply. Details after.")) + "\n");
      const ended = detectCodexTurnEnds(memory, await readCodexTurnSnapshots(opts));
      expect(ended).toHaveLength(1);
      expect(ended[0]!.label).toBe("asset generator");
      expect(ended[0]!.text).toBe("Second reply. Details after.");
      expect(detectCodexTurnEnds(memory, await readCodexTurnSnapshots(opts))).toEqual([]);

      // A turn that fails is heard too, with Codex's reason and none of turn 2's words.
      appendFileSync(path, [started("turn-3"), { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-3", last_agent_message: null, error: { message: "You've hit your usage limit." } } }].map((l) => JSON.stringify(l)).join("\n") + "\n");
      expect(detectCodexTurnEnds(memory, await readCodexTurnSnapshots(opts)).map(({ text, error }) => ({ text, error })))
        .toEqual([{ text: "", error: "You've hit your usage limit." }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("finds the turn boundary past a wall of tool output", () => {
    // The bug this replaced: a 256 KB window hunting for an agent_message never
    // found one behind a turn's worth of tool output, so two live sessions ran
    // for half an hour with conch silent. openai/codex#24948 reports rollouts
    // reaching 732 MB, so the tail read stays — it just has to be big enough.
    const home = mkdtempSync(join(tmpdir(), "conch-codex-home-"));
    try {
      const path = rollout(home, "big", [
        complete("old", "buried"),
        ...Array.from({ length: 800 }, (_, i) => noise(i)),
        complete("recent", "The visible one."),
      ]);
      const tail = readCodexRolloutTail(path);
      expect(tail?.turnId).toBe("recent");
      expect(tail?.text).toBe("The visible one.");
      expect(tail?.status).toBe("idle");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a running turn reads as busy with nothing to say", () => {
    const home = mkdtempSync(join(tmpdir(), "conch-codex-home-"));
    try {
      const path = rollout(home, "run", [complete("t1", "done"), started("t2")]);
      expect(readCodexRolloutTail(path)).toMatchObject({ turnId: "t2", status: "busy", text: "" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an inter-agent envelope is not offered as the reply", () => {
    const home = mkdtempSync(join(tmpdir(), "conch-codex-home-"));
    try {
      const path = rollout(home, "sub", [
        complete("t1", "Message Type: FINAL_ANSWER\nSender: /root/agent\n\npayload"),
      ]);
      const tail = readCodexRolloutTail(path);
      expect(tail?.turnId).toBe("t1"); // the turn still ended
      expect(tail?.text).toBe("");     // but there is nothing to say aloud
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a mid-line tail start does not abort the scan", () => {
    const home = mkdtempSync(join(tmpdir(), "conch-codex-home-"));
    try {
      const path = rollout(home, "mid", [
        ...Array.from({ length: 50 }, (_, i) => noise(i)),
        complete("t1", "Found me."),
      ]);
      expect(readCodexRolloutTail(path, 2048)?.text).toBe("Found me.");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a failed turn carries its error, and no reply", () => {
    // Shape measured on Tyler's rollouts: 31 failed turns, each with last_agent_message null.
    const home = mkdtempSync(join(tmpdir(), "conch-codex-home-"));
    try {
      const path = rollout(home, "fail", [complete("t1", "done"), started("t2"), {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "t2", last_agent_message: null, error: { message: " You've hit your usage limit. Visit https://example.test to buy more. ", codex_error_info: "usage_limit_exceeded" } },
      }]);
      expect(readCodexRolloutTail(path)).toMatchObject({ turnId: "t2", status: "idle", text: "", error: "You've hit your usage limit. Visit https://example.test to buy more." });
      expect(readCodexRolloutTail(rollout(home, "ok", [complete("t1", "done")]))).not.toHaveProperty("error");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the daemon announces a failure in one sentence, never with the turn before's reply", () => {
    const daemon = readFileSync(join(import.meta.dir, "../src/daemon.ts"), "utf8");
    expect(daemon).toContain("if (!snapshot.error) try {\n          const full = await lastAssistantText(snapshot.transcriptPath);");
    expect(daemon).toContain("? `stopped. ${firstSentences(snapshot.error, 1, 160)}`");
  });

  test("a missing rollout is null, not a crash", () => {
    expect(readCodexRolloutTail("/tmp/definitely-not-a-rollout.jsonl")).toBeNull();
  });
});

describe("an open Codex thread stays listed however idle", () => {
  // Claude lists a session for as long as its PROCESS lives, however idle. A
  // Codex thread had only recency, so conch hid one Tyler still had open
  // because he had not typed in it for twelve hours — two tools, same session,
  // different rules. `thread-writer-locks/<id>.lock` is Codex's own answer:
  // verified on a live machine as held by codex pid 69776 for the open thread,
  // with no lock at all for one closed hours earlier.
  function homeWith(threads: Array<Record<string, unknown>>, locks: string[]): string {
    const home = mkdtempSync(join(tmpdir(), "conch-codex-home-"));
    const state = new Database(join(home, "state_5.sqlite"));
    state.run(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, cwd TEXT, name TEXT, agent_nickname TEXT, title TEXT,
      rollout_path TEXT, updated_at_ms INTEGER, archived INTEGER, source TEXT,
      has_user_event INTEGER, tokens_used INTEGER)`);
    for (const t of threads) {
      state.run(
        `INSERT INTO threads VALUES (?,'/tmp',?,NULL,?,'',?,0,?,?,?)`,
        [
          t.id,
          t.name ?? null,
          t.title ?? "",
          t.updated_at_ms,
          (t.source as string) ?? "cli",
          // Default to "a person spoke here", because that is what almost every
          // fixture means; the one-shot cases set it explicitly.
          t.has_user_event === undefined ? 1 : t.has_user_event,
          t.tokens_used === undefined ? 100 : t.tokens_used,
        ] as any,
      );
    }
    state.close();
    mkdirSync(join(home, "thread-writer-locks"), { recursive: true });
    for (const id of locks) {
      writeFileSync(join(home, "thread-writer-locks", `${id}.lock`), "");
    }
    return home;
  }

  test("a long-idle thread Codex still has open is listed", async () => {
    const home = homeWith(
      [{ id: "open", name: "asset generator", updated_at_ms: NOW - 12 * 3_600_000 }],
      ["open"],
    );
    try {
      // The premise is that Codex still HOLDS this lock — a bare file on disk
      // is what a crashed or rebooted Codex leaves behind, and that is not an
      // open thread.
      expect(
        (await readCodexThreads({
          codexHome: home,
          now: NOW,
          lockProbe: (paths) => paths.join("\n"),
        })).entries.map((e) => e.sessionId),
      ).toEqual(["open"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a long-idle thread with no lock is gone", async () => {
    const home = homeWith(
      [{ id: "closed", name: "yesterday", updated_at_ms: NOW - 12 * 3_600_000 }],
      [],
    );
    try {
      expect((await readCodexThreads({ codexHome: home, now: NOW })).entries).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a one-shot command that opened a thread is not listed", async () => {
    // `codex mcp login mobbin` — Tyler re-authenticating an MCP server — opened
    // a thread, did its job and exited, and conch listed it as a session for
    // eight hours. The row records the truth: no user event, no tokens.
    const home = homeWith(
      [{
        id: "oneshot", name: null, title: "codex mcp login\nmobbin",
        updated_at_ms: NOW - 60_000, has_user_event: 0, tokens_used: 0,
      }],
      [],
    );
    try {
      expect((await readCodexThreads({ codexHome: home, now: NOW })).entries).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a real session with no tokens yet is listed while it holds its lock", async () => {
    // A session that genuinely just started also has no user event yet. The
    // lock is what separates the two, so the live check must win.
    const home = homeWith(
      [{
        id: "fresh", name: "just started", title: "hello",
        updated_at_ms: NOW - 1_000, has_user_event: 0, tokens_used: 0,
      }],
      ["fresh"],
    );
    try {
      const entries = (await readCodexThreads({
        codexHome: home, now: NOW, lockProbe: (paths) => paths.join("\n"),
      })).entries;
      expect(entries.map((e) => e.sessionId)).toEqual(["fresh"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a thread inside the recency window but older than boot is gone", async () => {
    // Tyler's six rows for one session. After a reboot the whole 8h window is
    // full of threads that died with the machine: recent by timestamp, and
    // impossible by physics.
    const NOW = 1_700_000_000_000;
    const home = homeWith(
      [{ id: "before-boot", name: "yesterday's work", updated_at_ms: NOW - 3_600_000 }],
      [],
    );
    try {
      expect(
        (await readCodexThreads({
          codexHome: home,
          now: NOW,
          bootedAt: NOW - 600_000, // booted ten minutes ago
        })).entries,
      ).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a thread written since boot is still listed", async () => {
    const NOW = 1_700_000_000_000;
    const home = homeWith(
      [{ id: "since-boot", name: "this session", updated_at_ms: NOW - 60_000 }],
      [],
    );
    try {
      expect(
        (await readCodexThreads({
          codexHome: home,
          now: NOW,
          bootedAt: NOW - 600_000,
        })).entries.map((e) => e.sessionId),
      ).toEqual(["since-boot"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("recency still lists a thread whose lock was never written", async () => {
    const home = homeWith([{ id: "fresh", name: "just now", updated_at_ms: NOW - 60_000 }], []);
    try {
      expect((await readCodexThreads({ codexHome: home, now: NOW })).entries.map((e) => e.sessionId))
        .toEqual(["fresh"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the coordination lock is not a thread", async () => {
    // ~/.codex/thread-writer-locks holds a `.coordination.lock` alongside the
    // per-thread ones; treating it as a thread id would list a phantom row.
    const home = homeWith([{ id: "x", name: "x", updated_at_ms: NOW }], []);
    try {
      writeFileSync(join(home, "thread-writer-locks", ".coordination.lock"), "");
      expect(await readCodexOpenThreadIds(home)).toEqual(new Map());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * Codex 0.153.4/0.154.0's own tables, copied from `sqlite3 -readonly
 * ~/.codex/{state_5,thread_history_1}.sqlite .schema` on 2026-09-11: the
 * CREATE TABLE statements verbatim (indexes and triggers left out), and no
 * rows from them.
 */
const REAL_THREADS_DDL = `CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    model_provider TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    sandbox_policy TEXT NOT NULL,
    approval_mode TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    has_user_event INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    git_sha TEXT,
    git_branch TEXT,
    git_origin_url TEXT
, cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', agent_nickname TEXT, agent_role TEXT, memory_mode TEXT NOT NULL DEFAULT 'enabled', model TEXT, reasoning_effort TEXT, agent_path TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT, preview TEXT NOT NULL DEFAULT '', recency_at INTEGER NOT NULL DEFAULT 0, recency_at_ms INTEGER NOT NULL DEFAULT 0, history_mode TEXT NOT NULL DEFAULT 'legacy', name TEXT, is_pinned INTEGER NOT NULL DEFAULT 0, thread_section_id TEXT
    REFERENCES thread_sections(id) ON DELETE SET NULL, section_position INTEGER, section_entered_at_ms INTEGER, project_id TEXT
    REFERENCES projects(id) ON DELETE SET NULL, originator TEXT, daybreak_enabled BOOLEAN)`;
const REAL_EDGES_DDL = `CREATE TABLE thread_spawn_edges (
    parent_thread_id TEXT NOT NULL,
    child_thread_id TEXT NOT NULL PRIMARY KEY,
    status TEXT NOT NULL
)`;
const REAL_TURNS_DDL = `CREATE TABLE thread_turns (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    rollout_ordinal INTEGER NOT NULL,
    status TEXT NOT NULL,
    error_json TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    duration_ms INTEGER,
    first_user_item_id TEXT,
    final_agent_item_id TEXT, rollout_byte_offset INTEGER, rollout_end_ordinal INTEGER, rollout_end_byte_offset INTEGER,
    PRIMARY KEY (thread_id, turn_id)
)`;

/** Where Codex writes a thread's rollout: under `$CODEX_HOME/sessions/`, as every real row does. */
const rollout = (home: string, id: string) => join(home, "sessions", "2026", "09", "11", `rollout-${id}.jsonl`);
/** `threads.source` for a helper, as Codex writes it. */
const spawnedBy = (parent: string) =>
  JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } });

/** A Codex home under a temp dir, from the real schemas; every thread paginated and spoken in unless it says otherwise. */
function realCodexHome(fixture: {
  threads: Array<Record<string, unknown>>;
  edges?: Array<[parent: string, child: string, status: string]>;
  turns?: Array<[thread: string, ordinal: number, status: string]>;
  index?: Array<Record<string, unknown>>;
  /** Lock files on disk. Whether anything holds them is the process table's business. */
  locks?: string[];
}): string {
  const home = mkdtempSync(join(tmpdir(), "conch-codex-real-"));
  const state = new Database(join(home, "state_5.sqlite"));
  state.run(REAL_THREADS_DDL);
  state.run(REAL_EDGES_DDL);
  for (const thread of fixture.threads) {
    const row: Record<string, unknown> = {
      rollout_path: rollout(home, String(thread.id)),
      created_at: 0, updated_at: 0, source: "cli", model_provider: "openai", cwd: "/work", title: "",
      sandbox_policy: "{}", approval_mode: "never", has_user_event: 1, tokens_used: 100,
      history_mode: "paginated", updated_at_ms: NOW,
      ...thread,
    };
    const keys = Object.keys(row);
    state.run(
      `INSERT INTO threads (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
      Object.values(row) as any,
    );
  }
  for (const edge of fixture.edges ?? []) state.run("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)", edge);
  state.close();
  const history = new Database(join(home, "thread_history_1.sqlite"));
  history.run(REAL_TURNS_DDL);
  for (const [thread, ordinal, status] of fixture.turns ?? []) {
    history.run(
      "INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status) VALUES (?, ?, ?, ?)",
      [thread, `${thread}-${ordinal}`, ordinal, status],
    );
  }
  history.close();
  if (fixture.index) {
    writeFileSync(join(home, "session_index.jsonl"), fixture.index.map((line) => JSON.stringify(line)).join("\n") + "\n");
  }
  mkdirSync(join(home, "thread-writer-locks"), { recursive: true });
  for (const id of fixture.locks ?? []) writeFileSync(join(home, "thread-writer-locks", `${id}.lock`), "");
  return home;
}

/**
 * A fake process table: each process's command line and the thread locks it
 * holds, answered the way `lsof -F pn` and `ps -o pid=,args=` answer.
 */
function processTable(home: string, processes: Array<{ pid: number; args: string; holds: string[] }>) {
  return {
    lockProbe: () => processes
      .map((p) => [`p${p.pid}`, ...p.holds.map((id) => `n${join(home, "thread-writer-locks", `${id}.lock`)}`)].join("\n"))
      .join("\n"),
    processArgs: (pids: number[]) =>
      new Map(processes.filter((p) => pids.includes(p.pid)).map((p) => [p.pid, p.args])),
  };
}

type CodexRow = CodexSessionEntry & { name?: string; noTerminal?: string };

describe("where keystrokes for a Codex thread may go: its lock's holder", () => {
  // The lock file holds no pid; the holder is whichever process hosts the
  // thread (docs/codex-harness-notes.md section 2). Live on 2026-09-11: pid
  // 2383, a `codex resume` TUI on ttys001, held its own thread's lock; pid
  // 74676, the ChatGPT app's `codex … app-server`, tty `??`, held a Desktop
  // thread's.
  const rows = async (home: string, table: ReturnType<typeof processTable>, now = NOW) =>
    (await readCodexThreads({ codexHome: home, now, ...table })).entries as CodexRow[];

  test("a thread no process holds is closed: pid 0, and the row says so", async () => {
    // A lock FILE with no holder is what a reboot leaves behind; still closed.
    const home = realCodexHome({ threads: [{ id: "t1", name: "yesterday" }], locks: ["t1"] });
    try {
      const [row] = await rows(home, processTable(home, []));
      expect(row).toMatchObject({ sessionId: "t1", pid: 0, noTerminal: "closed: no Codex process has this thread open" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a thread its terminal session holds is typed into through that session's pid", async () => {
    const home = realCodexHome({ threads: [{ id: "t1", name: "Clone Blueprint Studio" }], locks: ["t1"] });
    try {
      const table = processTable(home, [{ pid: 2383, args: "codex resume t1 -c model=gpt-6-astra", holds: ["t1"] }]);
      const [row] = await rows(home, table);
      expect(row).toMatchObject({ sessionId: "t1", pid: 2383 });
      expect(row!.noTerminal).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a thread an app-server hosts has no pid to type at or raise, and the row says why", async () => {
    const home = realCodexHome({
      threads: [
        { id: "desktop", name: "Desktop thread" },
        { id: "daemon", name: "joined the daemon" },
        { id: "tui", name: "mentions it" },
      ],
      locks: ["desktop", "daemon", "tui"],
    });
    try {
      const table = processTable(home, [
        {
          pid: 74676,
          args: "/Applications/ChatGPT.app/Contents/Resources/codex -c features.x=true app-server --analytics-default-enabled",
          holds: ["desktop"],
        },
        // What `codex app-server daemon start` / `codex remote-control start` run (pid.rs `command_args`).
        { pid: 5150, args: "/opt/homebrew/bin/codex app-server --remote-control --listen unix://", holds: ["daemon"] },
        // A prompt that merely names it is still a terminal session.
        { pid: 2383, args: "codex fix the app-server bug", holds: ["tui"] },
      ]);
      const byId = new Map((await rows(home, table)).map((row) => [row.sessionId, row]));
      expect(byId.get("desktop")).toMatchObject({
        pid: 0,
        noTerminal: "hosted by codex app-server (pid 74676), which has no terminal to type into",
      });
      expect(byId.get("daemon")).toMatchObject({ pid: 0, noTerminal: expect.stringContaining("(pid 5150)") });
      expect(byId.get("tui")).toMatchObject({ pid: 2383 });
      expect(byId.get("tui")!.noTerminal).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a holder that appears after one read is there on the very next", async () => {
    // The per-thread lookup this replaced cached a miss for 30 s, so a thread
    // opened just after a poll stayed pid-less until the entry expired.
    const home = realCodexHome({ threads: [{ id: "t1", name: "just opened" }], locks: ["t1"] });
    try {
      expect((await rows(home, processTable(home, [])))[0]).toMatchObject({ pid: 0 });
      const opened = processTable(home, [{ pid: 2383, args: "codex resume t1", holds: ["t1"] }]);
      expect((await rows(home, opened, NOW + 1_000))[0]).toMatchObject({ pid: 2383 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a held lock whose holder lsof could not name is a miss, not a closed thread", async () => {
    // lsof failing outright falls back to "every lock file is held", with no pid known.
    const home = realCodexHome({ threads: [{ id: "t1", name: "unknown holder" }], locks: ["t1"] });
    try {
      const [row] = (await readCodexThreads({ codexHome: home, now: NOW, lockProbe: () => null })).entries as CodexRow[];
      expect(row).toMatchObject({ sessionId: "t1", pid: 0 });
      expect(row!.noTerminal).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("through the registry and the panel: the reason reaches the published row, which is not revealable", async () => {
    const home = realCodexHome({ threads: [{ id: "desktop", name: "Desktop thread" }], locks: ["desktop"] });
    const claudeDir = mkdtempSync(join(tmpdir(), "conch-claude-"));
    const configDir = mkdtempSync(join(tmpdir(), "conch-config-"));
    mkdirSync(join(claudeDir, "sessions"));
    try {
      const table = processTable(home, [
        { pid: 74676, args: "/Applications/ChatGPT.app/Contents/Resources/codex app-server --analytics-default-enabled", holds: ["desktop"] },
      ]);
      const snap = await registrySnapshot(claudeDir, { codexHome: home, configDir, now: NOW, ...table });
      const info = snap!.infos.find((candidate) => candidate.sessionId === "desktop")!;
      const reason = "hosted by codex app-server (pid 74676), which has no terminal to type into";
      expect(info).toMatchObject({ backend: "codex", pid: 0, noTerminal: reason });
      const model = buildPanelModel({
        sessions: [info],
        sessionStates: new Map(),
        pausedSessionIds: new Set(),
        live: { state: "speaking", label: "", partial: "" },
        mode: { muted: false, paused: false, holding: 0 },
        activeSessionId: null,
        navSelectedId: null,
      });
      const published = buildPublishedState("device", model, new Map(), new Set(), NOW).rows[0]!;
      expect(published).toMatchObject({ id: "desktop", noTerminal: reason });
      expect(published.revealable).toBeUndefined();
    } finally {
      for (const dir of [home, claudeDir, configDir]) rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a Codex thread is named as Codex names it", () => {
  const names = async (home: string) =>
    Object.fromEntries(((await readCodexThreads({ codexHome: home, now: NOW })).entries as CodexRow[])
      .map((row) => [row.sessionId, row.name]));

  test("a legacy thread's name is its newest session_index.jsonl line", async () => {
    const home = realCodexHome({
      threads: [{ id: "legacy", history_mode: "legacy", name: null, title: "the first prompt" }],
      index: [
        { id: "legacy", thread_name: "old name", updated_at: "2026-09-10T10:00:00Z" },
        { id: "legacy", thread_name: "Blueprint", updated_at: "2026-09-11T10:00:00Z" },
        // Blank: skipped, as Codex's own reader skips it.
        { id: "legacy", thread_name: "  ", updated_at: "2026-09-11T11:00:00Z" },
        { id: "other", thread_name: "not this thread", updated_at: "2026-09-11T12:00:00Z" },
      ],
    });
    try {
      expect(await names(home)).toEqual({ legacy: "Blueprint" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a paginated thread's is threads.name, and a cleared one gets no old name back from the index", async () => {
    // All 36 threads on this machine are paginated; for the 8 named ones,
    // threads.name and the index agree.
    const home = realCodexHome({
      threads: [
        { id: "named", name: "Clone Blueprint Studio monorepo" },
        { id: "cleared", name: null, title: "the first prompt" },
      ],
      index: [
        { id: "named", thread_name: "Clone Blueprint Studio monorepo", updated_at: "2026-09-11T10:00:00Z" },
        { id: "cleared", thread_name: "since cleared", updated_at: "2026-09-11T10:00:00Z" },
      ],
    });
    try {
      expect(await names(home)).toEqual({ named: "Clone Blueprint Studio monorepo", cleared: "the first prompt" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("conch's own rename still outranks Codex's name", async () => {
    const home = realCodexHome({ threads: [{ id: "named", name: "Codex's name" }] });
    const claudeDir = mkdtempSync(join(tmpdir(), "conch-claude-"));
    const configDir = mkdtempSync(join(tmpdir(), "conch-config-"));
    mkdirSync(join(claudeDir, "sessions"));
    const labelsPath = join(configDir, "labels.json");
    try {
      const snap = await registrySnapshot(claudeDir, { codexHome: home, configDir, now: NOW });
      const info = snap!.infos.find((candidate) => candidate.sessionId === "named")!;
      expect(sessionLabel(info, info.cwd, { labelsPath })).toBe("Codex's name");
      writeFileSync(labelsPath, JSON.stringify({ named: "Mine" }));
      expect(sessionLabel(info, info.cwd, { labelsPath })).toBe("Mine");
    } finally {
      for (const dir of [home, claudeDir, configDir]) rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Codex helpers nest under their parent", () => {
  // Live on 2026-09-11: 19 `thread_spawn_edges`, every one `open`, while the
  // parent's process (pid 2383) held its own lock and three helpers'. The
  // edge's status cannot say which helpers run; the lock can.
  const BOHR_AT = NOW - 3_600_000;
  const family = () => realCodexHome({
    threads: [
      { id: "parent", name: "Clone Blueprint Studio" },
      // Last written an hour ago, mid-turn: recency alone would call it idle,
      // so busy can only come from its `thread_turns` row.
      {
        id: "bohr", source: spawnedBy("parent"), agent_nickname: "Bohr", agent_role: "explorer", cwd: "/work/api",
        updated_at_ms: BOHR_AT,
      },
      { id: "zeno", source: spawnedBy("parent"), agent_nickname: "Zeno" },
      { id: "goodall", source: spawnedBy("elsewhere"), agent_nickname: "Goodall" },
    ],
    edges: [["parent", "bohr", "open"], ["parent", "zeno", "open"], ["elsewhere", "goodall", "open"]],
    turns: [["bohr", 1, "completed"], ["bohr", 2, "inProgress"]],
    locks: ["parent", "bohr", "zeno", "goodall"],
  });

  test("a helper whose lock is held is listed; a finished one, and another parent's, are not", async () => {
    const home = family();
    try {
      const table = processTable(home, [{ pid: 2383, args: "codex resume parent", holds: ["parent", "bohr", "goodall"] }]);
      expect(await readCodexHelperThreads("parent", rollout(home, "parent"), { ...table, now: NOW })).toEqual([{
        threadId: "bohr",
        name: "Bohr",
        cwd: "/work/api",
        status: "busy",
        updatedAt: BOHR_AT,
        transcriptPath: rollout(home, "bohr"),
      }]);
      // Helpers are never top-level sessions, so never announced.
      expect((await readCodexThreads({ codexHome: home, now: NOW, ...table })).entries.map((e) => e.sessionId))
        .toEqual(["parent"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a parent whose rollout is not under a Codex home has no helpers to read", async () => {
    expect(await readCodexHelperThreads("parent", "/r/rollout-x.jsonl")).toEqual([]);
  });

  test("through the Codex adapter row, with a lock this process really holds: nested, no pid, never active", async () => {
    const home = family();
    // Holding bohr's lock open here makes the real `lsof` find a holder.
    const fd = openSync(join(home, "thread-writer-locks", "bohr.lock"), "r");
    try {
      const parent: SessionInfo = { sessionId: "parent", backend: "codex", name: "Clone Blueprint Studio", cwd: "/work", pid: 2383 };
      const helpers = await subagentSessions(parent, rollout(home, "parent"));
      expect(helpers).toEqual([{
        sessionId: "bohr",
        parentSessionId: "parent",
        backend: "codex",
        name: "Bohr",
        cwd: "/work/api",
        status: "busy",
        statusUpdatedAt: BOHR_AT,
        transcriptPath: rollout(home, "bohr"),
      }]);
      const panel = buildPanelRows({
        sessions: [parent, ...helpers],
        sessionStates: new Map(),
        pausedSessionIds: new Set(),
        live: { state: "speaking", label: "Bohr", partial: "" },
        mode: { muted: false, paused: false, holding: 0 },
        activeSessionId: "bohr",
        navSelectedId: null,
      });
      const row = panel.find((candidate) => candidate.sessionId === "bohr")!;
      expect(row).toMatchObject({ parentSessionId: "parent", active: false });
      expect(row.revealable).toBeUndefined();
    } finally {
      closeSync(fd);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test("a lock file nobody holds is not an open thread", async () => {
  // A reboot is not a clean exit, so Codex's lock files outlive the processes
  // that held them. Presence alone reported sessions that died with the machine.
  const home = mkdtempSync(join(tmpdir(), "conch-locks-"));
  mkdirSync(join(home, "thread-writer-locks"), { recursive: true });
  const held = join(home, "thread-writer-locks", "alive.lock");
  const stale = join(home, "thread-writer-locks", "dead.lock");
  writeFileSync(held, "");
  writeFileSync(stale, "");

  // Probe reports only the first path as open.
  const ids = await readCodexOpenThreadIds(home, () => `n${held}\n`);
  expect([...ids.keys()]).toEqual(["alive"]);

  rmSync(home, { recursive: true, force: true });
});

test("an unusable probe falls back to presence rather than emptying the ledger", async () => {
  // Hiding a live session is worse than showing a dead one.
  const home = mkdtempSync(join(tmpdir(), "conch-locks-"));
  mkdirSync(join(home, "thread-writer-locks"), { recursive: true });
  writeFileSync(join(home, "thread-writer-locks", "a.lock"), "");
  writeFileSync(join(home, "thread-writer-locks", "b.lock"), "");

  const ids = await readCodexOpenThreadIds(home, () => null);
  expect([...ids.keys()].sort()).toEqual(["a", "b"]);

  rmSync(home, { recursive: true, force: true });
});

test("a newline in a title does not break the row it renders in", () => {
  // A Codex title is whatever was typed. `codex mcp login\n  mobbin` arrived
  // with a real newline, which a one-line row cannot render.
  expect(codexThreadLabel({ title: "codex mcp login\n  mobbin" }))
    .toBe("codex mcp login mobbin");
});

/**
 * Discovery used to run its `lsof` and `ps` through `Bun.spawnSync`, and the
 * daemon has ONE thread: while a probe ran, an injection someone was waiting
 * on, a phone publication and the voice loop could not run at all — not queued
 * behind it, unable to run. These fix that, and fix nothing about what
 * discovery finds.
 */
describe("discovery runs without freezing the daemon's one thread", () => {
  /** A probe that can be held open across ticks, the way a slow `lsof` is. */
  function gate() {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    return { held, release: () => release() };
  }
  /** One turn of the macrotask queue — where the daemon's timer-driven work waits. */
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  test("work queued behind discovery runs while its probe is still outstanding", async () => {
    const home = realCodexHome({ threads: [{ id: "t1", name: "live thread" }], locks: ["t1"] });
    try {
      const probe = gate();
      const order: string[] = [];
      const read = readCodexThreads({
        codexHome: home,
        now: NOW,
        lockProbe: async (paths) => {
          order.push("probe-started");
          await probe.held;
          return paths.join("\n");
        },
      });
      let settled = false;
      void read.then(() => { settled = true; });
      // What the daemon has waiting on its own timers while discovery runs.
      setTimeout(() => order.push("injection"), 0);
      setTimeout(() => order.push("publication"), 0);

      // Two turns of the loop, not a stopwatch: both ran while the probe was
      // still out. Inside `spawnSync` neither could have run at all.
      await tick();
      await tick();
      expect(order).toEqual(["probe-started", "injection", "publication"]);
      // …and they ran DURING discovery, not after it: the pass is still waiting
      // on its probe. A synchronous probe cannot produce this ordering.
      expect(settled).toBe(false);

      probe.release();
      expect((await read).entries.map((e) => e.sessionId)).toEqual(["t1"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("overlapping requests coalesce into one pass", async () => {
    const home = realCodexHome({ threads: [{ id: "t1", name: "one" }], locks: ["t1"] });
    try {
      const probe = gate();
      let probes = 0;
      const options = {
        codexHome: home,
        now: NOW,
        lockProbe: async (paths: string[]) => { probes += 1; await probe.held; return paths.join("\n"); },
      };
      // The panel refresh and the turn poller, landing together.
      const first = readCodexThreads(options);
      const second = readCodexThreads(options);
      expect(second).toBe(first);
      probe.release();
      const [a, b] = await Promise.all([first, second]);
      expect(probes).toBe(1);
      expect(a).toBe(b);
      expect(a.entries.map((e) => e.sessionId)).toEqual(["t1"]);

      // A request after the pass has finished is a fresh read, not a cache.
      await readCodexThreads(options);
      expect(probes).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("turn status is asked only about the threads in hand", async () => {
    // The global form ran a correlated MAX() over every turn Codex has ever
    // recorded to answer for the handful of rows a listing shows.
    const home = realCodexHome({
      threads: [{ id: "listed", name: "listed" }, { id: "elsewhere", name: "not in this listing" }],
      turns: [["listed", 1, "inProgress"], ["elsewhere", 1, "inProgress"]],
    });
    try {
      const { history } = codexThreadDbPaths(home);
      expect([...readCodexTurnStatuses(history, ["listed"])]).toEqual([["listed", "inProgress"]]);
      expect(readCodexTurnStatuses(history, [])).toEqual(new Map());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the same machine state still produces the same rows", async () => {
    // Statuses here can only come from `thread_turns`: the open thread was last
    // written twelve hours ago, so recency alone would call it idle.
    const home = realCodexHome({
      threads: [
        { id: "open", name: "asset generator", updated_at_ms: NOW - 12 * 3_600_000 },
        { id: "recent", name: "humain", updated_at_ms: NOW - 60_000 },
        { id: "gone", name: "last week", updated_at_ms: NOW - 7 * 86_400_000 },
      ],
      turns: [["open", 1, "completed"], ["open", 2, "inProgress"], ["recent", 1, "completed"]],
      locks: ["open"],
    });
    try {
      const table = processTable(home, [{ pid: 2383, args: "codex resume open", holds: ["open"] }]);
      const read = await readCodexThreads({ codexHome: home, now: NOW, ...table });
      expect(read.complete).toBe(true);
      expect(read.available).toBe(true);
      expect((read.entries as CodexRow[]).map((row) => [row.sessionId, row.name, row.status, row.pid]))
        .toEqual([
          ["recent", "humain", "idle", 0],
          ["open", "asset generator", "busy", 2383],
        ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
