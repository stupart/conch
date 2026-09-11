import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexSessionEntry } from "../src/codex-sessions.ts";
import { buildPanelModel, buildPanelRows, buildPublishedState } from "../src/panel.ts";
import { registrySnapshot, sessionLabel, subagentSessions, type SessionInfo } from "../src/sessions.ts";
import {
  codexThreadLabel,
  codexThreadStatus,
  detectCodexTurnEnds,
  isInterAgentEnvelope,
  readCodexHelperThreads,
  readCodexOpenThreadIds,
  readCodexRolloutTail,
  readCodexThreads,
  readCodexTurnSnapshots,
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
  test("reports interactive threads with their live turn status", () => {
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
      const read = readCodexThreads({ codexHome: home, now: NOW });
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

  test("excludes one-shot `exec` runs, which are scripts and not sessions", () => {
    // Measured on the real machine: 354 exec rows against 9 cli and 45 vscode,
    // because every `codex exec` leaves a permanent row — including the probes
    // used to build this feature. Nobody is sitting in one waiting to be
    // announced at.
    const home = codexHome([
      { id: "real", name: "asset generator", updated_at_ms: NOW, source: "cli" },
      { id: "script", name: "some automation", updated_at_ms: NOW, source: "exec" },
    ]);
    try {
      expect(readCodexThreads({ codexHome: home, now: NOW }).entries.map((e) => e.sessionId))
        .toEqual(["real"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("excludes subagents, matching how Claude sessions are already listed", () => {
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
      expect(readCodexThreads({ codexHome: home, now: NOW }).entries.map((e) => e.sessionId))
        .toEqual(["parent"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("drops threads outside the liveness window", () => {
    // These rows are permanent history, unlike Claude's per-pid files which
    // vanish with the process. Without a window the ledger fills with every
    // conversation ever held.
    const home = codexHome([
      { id: "fresh", name: "today", updated_at_ms: NOW - 60_000, source: "cli" },
      { id: "ancient", name: "last week", updated_at_ms: NOW - 7 * 86_400_000, source: "cli" },
    ]);
    try {
      expect(readCodexThreads({ codexHome: home, now: NOW }).entries.map((e) => e.sessionId))
        .toEqual(["fresh"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("never reads the real ~/.codex when conch's state is redirected", () => {
    // A registry test running in a temp directory silently read the developer's
    // ACTUAL Codex sessions and asserted against whatever they were doing —
    // which is how this was caught: five unrelated tests began failing when two
    // live threads appeared in a snapshot built from an empty directory.
    expect(readCodexThreads({ configDir: "/tmp/nowhere", now: NOW }))
      .toEqual({ entries: [], complete: true, available: false });

    const previous = process.env.CONCH_CONFIG_DIR;
    process.env.CONCH_CONFIG_DIR = "/tmp/nowhere";
    try {
      expect(readCodexThreads({ now: NOW }).available).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CONCH_CONFIG_DIR;
      else process.env.CONCH_CONFIG_DIR = previous;
    }
  });

  test("a machine with no Codex is known-empty, not an incomplete read", () => {
    // complete=false makes liveness logic treat sessions as possibly-gone. A
    // machine that simply has no Codex must not look like a failed read.
    expect(readCodexThreads({ codexHome: "/tmp/definitely-not-codex", now: NOW }))
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

  test("the whole chain: a finished rollout becomes exactly one announcement", () => {
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
      expect(detectCodexTurnEnds(memory, readCodexTurnSnapshots(opts))).toEqual([]);

      // A new turn starts: still quiet.
      appendFileSync(path, JSON.stringify(started("turn-2")) + "\n");
      expect(detectCodexTurnEnds(memory, readCodexTurnSnapshots(opts))).toEqual([]);

      // …and completes: announce, once, in the agent's own words.
      appendFileSync(path, JSON.stringify(complete("turn-2", "Second reply. Details after.")) + "\n");
      const ended = detectCodexTurnEnds(memory, readCodexTurnSnapshots(opts));
      expect(ended).toHaveLength(1);
      expect(ended[0]!.label).toBe("asset generator");
      expect(ended[0]!.text).toBe("Second reply. Details after.");
      expect(detectCodexTurnEnds(memory, readCodexTurnSnapshots(opts))).toEqual([]);
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

  test("a long-idle thread Codex still has open is listed", () => {
    const home = homeWith(
      [{ id: "open", name: "asset generator", updated_at_ms: NOW - 12 * 3_600_000 }],
      ["open"],
    );
    try {
      // The premise is that Codex still HOLDS this lock — a bare file on disk
      // is what a crashed or rebooted Codex leaves behind, and that is not an
      // open thread.
      expect(
        readCodexThreads({
          codexHome: home,
          now: NOW,
          lockProbe: (paths) => paths.join("\n"),
        }).entries.map((e) => e.sessionId),
      ).toEqual(["open"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a long-idle thread with no lock is gone", () => {
    const home = homeWith(
      [{ id: "closed", name: "yesterday", updated_at_ms: NOW - 12 * 3_600_000 }],
      [],
    );
    try {
      expect(readCodexThreads({ codexHome: home, now: NOW }).entries).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a one-shot command that opened a thread is not listed", () => {
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
      expect(readCodexThreads({ codexHome: home, now: NOW }).entries).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a real session with no tokens yet is listed while it holds its lock", () => {
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
      const entries = readCodexThreads({
        codexHome: home, now: NOW, lockProbe: (paths) => paths.join("\n"),
      }).entries;
      expect(entries.map((e) => e.sessionId)).toEqual(["fresh"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a thread inside the recency window but older than boot is gone", () => {
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
        readCodexThreads({
          codexHome: home,
          now: NOW,
          bootedAt: NOW - 600_000, // booted ten minutes ago
        }).entries,
      ).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a thread written since boot is still listed", () => {
    const NOW = 1_700_000_000_000;
    const home = homeWith(
      [{ id: "since-boot", name: "this session", updated_at_ms: NOW - 60_000 }],
      [],
    );
    try {
      expect(
        readCodexThreads({
          codexHome: home,
          now: NOW,
          bootedAt: NOW - 600_000,
        }).entries.map((e) => e.sessionId),
      ).toEqual(["since-boot"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("recency still lists a thread whose lock was never written", () => {
    const home = homeWith([{ id: "fresh", name: "just now", updated_at_ms: NOW - 60_000 }], []);
    try {
      expect(readCodexThreads({ codexHome: home, now: NOW }).entries.map((e) => e.sessionId))
        .toEqual(["fresh"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the coordination lock is not a thread", () => {
    // ~/.codex/thread-writer-locks holds a `.coordination.lock` alongside the
    // per-thread ones; treating it as a thread id would list a phantom row.
    const home = homeWith([{ id: "x", name: "x", updated_at_ms: NOW }], []);
    try {
      writeFileSync(join(home, "thread-writer-locks", ".coordination.lock"), "");
      expect(readCodexOpenThreadIds(home)).toEqual(new Map());
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
  const rows = (home: string, table: ReturnType<typeof processTable>, now = NOW) =>
    readCodexThreads({ codexHome: home, now, ...table }).entries as CodexRow[];

  test("a thread no process holds is closed: pid 0, and the row says so", () => {
    // A lock FILE with no holder is what a reboot leaves behind; still closed.
    const home = realCodexHome({ threads: [{ id: "t1", name: "yesterday" }], locks: ["t1"] });
    try {
      const [row] = rows(home, processTable(home, []));
      expect(row).toMatchObject({ sessionId: "t1", pid: 0, noTerminal: "closed: no Codex process has this thread open" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a thread its terminal session holds is typed into through that session's pid", () => {
    const home = realCodexHome({ threads: [{ id: "t1", name: "Clone Blueprint Studio" }], locks: ["t1"] });
    try {
      const table = processTable(home, [{ pid: 2383, args: "codex resume t1 -c model=gpt-6-astra", holds: ["t1"] }]);
      const [row] = rows(home, table);
      expect(row).toMatchObject({ sessionId: "t1", pid: 2383 });
      expect(row!.noTerminal).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a thread an app-server hosts has no pid to type at or raise, and the row says why", () => {
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
      const byId = new Map(rows(home, table).map((row) => [row.sessionId, row]));
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

  test("a holder that appears after one read is there on the very next", () => {
    // The per-thread lookup this replaced cached a miss for 30 s, so a thread
    // opened just after a poll stayed pid-less until the entry expired.
    const home = realCodexHome({ threads: [{ id: "t1", name: "just opened" }], locks: ["t1"] });
    try {
      expect(rows(home, processTable(home, []))[0]).toMatchObject({ pid: 0 });
      const opened = processTable(home, [{ pid: 2383, args: "codex resume t1", holds: ["t1"] }]);
      expect(rows(home, opened, NOW + 1_000)[0]).toMatchObject({ pid: 2383 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a held lock whose holder lsof could not name is a miss, not a closed thread", () => {
    // lsof failing outright falls back to "every lock file is held", with no pid known.
    const home = realCodexHome({ threads: [{ id: "t1", name: "unknown holder" }], locks: ["t1"] });
    try {
      const [row] = readCodexThreads({ codexHome: home, now: NOW, lockProbe: () => null }).entries as CodexRow[];
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
  const names = (home: string) =>
    Object.fromEntries((readCodexThreads({ codexHome: home, now: NOW }).entries as CodexRow[])
      .map((row) => [row.sessionId, row.name]));

  test("a legacy thread's name is its newest session_index.jsonl line", () => {
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
      expect(names(home)).toEqual({ legacy: "Blueprint" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a paginated thread's is threads.name, and a cleared one gets no old name back from the index", () => {
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
      expect(names(home)).toEqual({ named: "Clone Blueprint Studio monorepo", cleared: "the first prompt" });
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

  test("a helper whose lock is held is listed; a finished one, and another parent's, are not", () => {
    const home = family();
    try {
      const table = processTable(home, [{ pid: 2383, args: "codex resume parent", holds: ["parent", "bohr", "goodall"] }]);
      expect(readCodexHelperThreads("parent", rollout(home, "parent"), { ...table, now: NOW })).toEqual([{
        threadId: "bohr",
        name: "Bohr",
        cwd: "/work/api",
        status: "busy",
        updatedAt: BOHR_AT,
        transcriptPath: rollout(home, "bohr"),
      }]);
      // Helpers are never top-level sessions, so never announced.
      expect(readCodexThreads({ codexHome: home, now: NOW, ...table }).entries.map((e) => e.sessionId))
        .toEqual(["parent"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a parent whose rollout is not under a Codex home has no helpers to read", () => {
    expect(readCodexHelperThreads("parent", "/r/rollout-x.jsonl")).toEqual([]);
  });

  test("through the Codex adapter row, with a lock this process really holds: nested, no pid, never active", () => {
    const home = family();
    // Holding bohr's lock open here makes the real `lsof` find a holder.
    const fd = openSync(join(home, "thread-writer-locks", "bohr.lock"), "r");
    try {
      const parent: SessionInfo = { sessionId: "parent", backend: "codex", name: "Clone Blueprint Studio", cwd: "/work", pid: 2383 };
      const helpers = subagentSessions(parent, rollout(home, "parent"));
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

test("a lock file nobody holds is not an open thread", () => {
  // A reboot is not a clean exit, so Codex's lock files outlive the processes
  // that held them. Presence alone reported sessions that died with the machine.
  const home = mkdtempSync(join(tmpdir(), "conch-locks-"));
  mkdirSync(join(home, "thread-writer-locks"), { recursive: true });
  const held = join(home, "thread-writer-locks", "alive.lock");
  const stale = join(home, "thread-writer-locks", "dead.lock");
  writeFileSync(held, "");
  writeFileSync(stale, "");

  // Probe reports only the first path as open.
  const ids = readCodexOpenThreadIds(home, () => `n${held}\n`);
  expect([...ids.keys()]).toEqual(["alive"]);

  rmSync(home, { recursive: true, force: true });
});

test("an unusable probe falls back to presence rather than emptying the ledger", () => {
  // Hiding a live session is worse than showing a dead one.
  const home = mkdtempSync(join(tmpdir(), "conch-locks-"));
  mkdirSync(join(home, "thread-writer-locks"), { recursive: true });
  writeFileSync(join(home, "thread-writer-locks", "a.lock"), "");
  writeFileSync(join(home, "thread-writer-locks", "b.lock"), "");

  const ids = readCodexOpenThreadIds(home, () => null);
  expect([...ids.keys()].sort()).toEqual(["a", "b"]);

  rmSync(home, { recursive: true, force: true });
});

test("a newline in a title does not break the row it renders in", () => {
  // A Codex title is whatever was typed. `codex mcp login\n  mobbin` arrived
  // with a real newline, which a one-line row cannot render.
  expect(codexThreadLabel({ title: "codex mcp login\n  mobbin" }))
    .toBe("codex mcp login mobbin");
});
