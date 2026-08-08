import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexThreadLabel, readCodexThreads } from "../src/codex-threads.ts";

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
