import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexThreadLabel,
  codexThreadStatus,
  detectCodexTurnEnds,
  isInterAgentEnvelope,
  readCodexOpenThreadIds,
  readCodexRolloutTail,
  readCodexThreadPid,
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
      rollout_path TEXT, updated_at_ms INTEGER, archived INTEGER, source TEXT)`);
    for (const t of threads) {
      state.run(
        `INSERT INTO threads VALUES (?,'/tmp',?,NULL,'','',?,0,'cli')`,
        [t.id, t.name, t.updated_at_ms] as any,
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
      expect(readCodexThreads({ codexHome: home, now: NOW }).entries.map((e) => e.sessionId))
        .toEqual(["open"]);
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
      expect(readCodexOpenThreadIds(home)).toEqual(new Set());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("a Codex session is addressable, not just visible", () => {
  // Codex publishes no pid, so its rows arrived pid=0 and every message typed
  // at one fell through to the clipboard as "session-not-routable" — while
  // Claude sessions worked. Same composer, same button, silently different
  // outcome depending on which agent you happened to be talking to.
  test("no lock file means no owner, not a wrong one", () => {
    const home = mkdtempSync(join(tmpdir(), "conch-codex-pid-"));
    expect(readCodexThreadPid(home, "nothing-here")).toBeUndefined();
  });

  // The answer is cached because a thread's owner cannot change without the
  // lock being released, and lsof is far too expensive to run per row per
  // render.
  test("the answer is cached rather than re-derived every render", () => {
    const home = mkdtempSync(join(tmpdir(), "conch-codex-pid-"));
    const first = readCodexThreadPid(home, "cached", 1_000);
    const second = readCodexThreadPid(home, "cached", 1_100);
    expect(first).toBe(second);
  });
});
