import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registrySnapshot, withStartedBy, type SessionInfo } from "../src/sessions.ts";
import {
  activeSessionIdForRows,
  buildPanelModel,
  buildPanelRows,
  buildPublishedState,
  dashboardRowsForModel,
  nestedUnder,
} from "../src/panel.ts";

/**
 * C15 — a session started by another session, from the process tree.
 *
 * Verified on this Mac: a Bash tool shell inside a Claude session has the
 * session's own pid as its parent (`ps -o ppid=` on the shell gave 72858, the
 * registry pid of the session running it), so anything it starts — `codex`
 * included — has that pid in its ancestor chain. Codex's shell tool runs
 * commands under a sandbox and a shell, which only lengthens the chain. Both
 * registries carry the pid that closes the loop: Claude's
 * `~/.claude/sessions/<pid>.json`, Codex's hook registry, and for an observed
 * Codex thread the holder of its writer lock.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// claude(100) → zsh(101) → codex(102): Claude Code's Bash tool started Codex.
// codex(200) → sandbox-exec(201) → zsh(202) → claude(203): Codex's shell started Claude.
// claude(300) → zsh(301) → codex(302) → zsh(303) → claude(304): a chain of three.
// claude(400) sits under a terminal nobody lists.
const TREE = new Map<number, number>([
  [100, 50], [101, 100], [102, 101],
  [200, 60], [201, 200], [202, 201], [203, 202],
  [300, 70], [301, 300], [302, 301], [303, 302], [304, 303],
  [400, 80],
  [50, 1], [60, 1], [70, 1], [80, 1],
]);

const session = (sessionId: string, pid: number | undefined, backend: "claude" | "codex" = "claude"): SessionInfo => ({
  sessionId, pid, backend, name: sessionId, cwd: "/w",
});

describe("withStartedBy — the walk over a fake process table", () => {
  test("finds the starter in both directions and along a chain; never itself, never without a pid", () => {
    const infos = [
      session("claude-a", 100), session("codex-a", 102, "codex"),
      session("codex-b", 200, "codex"), session("claude-b", 203),
      session("chain-1", 300), session("chain-2", 302, "codex"), session("chain-3", 304),
      session("alone", 400), session("observed-only", 0, "codex"), session("no-pid", undefined),
    ];
    const marked = withStartedBy(infos, TREE);
    const by = Object.fromEntries(marked.map((info) => [info.sessionId, info.startedBySessionId]));
    expect(by).toEqual({
      "claude-a": undefined, "codex-a": "claude-a",
      "codex-b": undefined, "claude-b": "codex-b",
      "chain-1": undefined, "chain-2": "chain-1", "chain-3": "chain-2",
      "alone": undefined, "observed-only": undefined, "no-pid": undefined,
    });
    // Untouched rows are the same objects; marked ones are copies with one field added.
    expect(marked[0]).toBe(infos[0]);
    expect(marked[1]).toEqual({ ...infos[1]!, startedBySessionId: "claude-a" });
  });

  test("a chain that leaves the table, or that only ever finds the row itself, marks nothing", () => {
    const partial = new Map<number, number>([[102, 101]]); // 101's parent is unknown: `ps` mid-exit
    expect(withStartedBy([session("a", 100), session("b", 102)], partial)[1]!.startedBySessionId).toBeUndefined();
    const loop = new Map<number, number>([[100, 101], [101, 100]]);
    expect(withStartedBy([session("a", 100), session("b", 500)], loop)[0]!.startedBySessionId).toBeUndefined();
  });
});

describe("registrySnapshot — a fake registry in both directions", () => {
  function registry() {
    const root = mkdtempSync(join(tmpdir(), "conch-c15-"));
    roots.push(root);
    const claudeDir = join(root, "claude");
    const configDir = join(root, "conch-config");
    mkdirSync(join(claudeDir, "sessions"), { recursive: true });
    mkdirSync(join(configDir, "codex-sessions"), { recursive: true });
    const claude = (pid: number, sessionId: string) =>
      writeFileSync(join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({
        pid, sessionId, name: sessionId, cwd: "/w", kind: "interactive", entrypoint: "cli", status: "busy",
      }));
    const codex = (pid: number, sessionId: string) =>
      writeFileSync(join(configDir, "codex-sessions", `${pid}.json`), JSON.stringify({
        pid, sessionId, cwd: "/w", status: "busy", updatedAt: 1, transcriptPath: "/w/rollout.jsonl",
      }));
    return { claudeDir, configDir, claude, codex };
  }

  test("Claude-started Codex and Codex-started Claude both carry startedBySessionId; a lone terminal session does not", async () => {
    const r = registry();
    r.claude(100, "claude-a");
    r.codex(102, "codex-a");
    r.codex(200, "codex-b");
    r.claude(203, "claude-b");
    r.claude(400, "alone");
    let reads = 0;
    const snap = await registrySnapshot(r.claudeDir, {
      configDir: r.configDir,
      isPidAlive: () => true,
      processParents: async () => {
        reads += 1;
        return TREE;
      },
    });
    expect(reads).toBe(1);
    const by = Object.fromEntries(snap!.infos.map((info) => [info.sessionId, info.startedBySessionId]));
    expect(by).toEqual({
      "claude-a": undefined, "codex-a": "claude-a",
      "codex-b": undefined, "claude-b": "codex-b",
      "alone": undefined,
    });
    expect(snap!.infos.find((info) => info.sessionId === "codex-a")).toMatchObject({ backend: "codex", pid: 102 });
    expect(snap!.complete).toBe(true);
  });

  test("one session never costs a `ps`, and an unreadable table marks nothing", async () => {
    const r = registry();
    r.claude(100, "claude-a");
    let reads = 0;
    const lone = await registrySnapshot(r.claudeDir, {
      configDir: r.configDir,
      processParents: async () => {
        reads += 1;
        return TREE;
      },
    });
    expect(reads).toBe(0);
    expect(lone!.infos).toHaveLength(1);

    // Two is enough to relate: exactly one read, and the pair is marked.
    r.codex(102, "codex-a");
    const pair = await registrySnapshot(r.claudeDir, {
      configDir: r.configDir,
      isPidAlive: () => true,
      processParents: async () => {
        reads += 1;
        return TREE;
      },
    });
    expect(reads).toBe(1);
    expect(pair!.infos.find((info) => info.sessionId === "codex-a")!.startedBySessionId).toBe("claude-a");

    const blind = await registrySnapshot(r.claudeDir, {
      configDir: r.configDir,
      isPidAlive: () => true,
      processParents: async () => null,
    });
    expect(blind!.infos.map((info) => info.startedBySessionId)).toEqual([undefined, undefined]);
  });
});

describe("the panel row model nests a started session under its starter", () => {
  const starter: SessionInfo = { sessionId: "s1", name: "conch", status: "idle", statusUpdatedAt: 50, pid: 100 };
  const other: SessionInfo = { sessionId: "s2", name: "arch", status: "busy", statusUpdatedAt: 50, pid: 400 };
  const started: SessionInfo = {
    sessionId: "c1", backend: "codex", name: "codex review", status: "busy", statusUpdatedAt: 60, pid: 102,
    startedBySessionId: "s1",
  };
  const grandchild: SessionInfo = {
    sessionId: "g1", name: "claude fixer", status: "idle", statusUpdatedAt: 70, pid: 104, startedBySessionId: "c1",
  };
  const subagent: SessionInfo = {
    sessionId: "agent-x", parentSessionId: "s1", name: "Older task", status: "busy", statusUpdatedAt: 10,
  };
  const orphan: SessionInfo = {
    sessionId: "o1", name: "orphan", status: "busy", statusUpdatedAt: 50, pid: 500, startedBySessionId: "dismissed",
  };
  const options = {
    sessionStates: new Map(),
    pausedSessionIds: new Set<string>(),
    live: { state: "speaking" as const, label: "codex review", partial: "" },
    mode: { muted: false, paused: false, holding: 0 },
    navSelectedId: null,
  };

  test("starter, its subagents, then its started sessions with their own; an orphan stays a top-level session", () => {
    const rows = buildPanelRows({
      ...options,
      sessions: [grandchild, other, started, orphan, starter, subagent],
      activeSessionId: "c1",
    });
    expect(rows.map((row) => row.sessionId)).toEqual(["s1", "agent-x", "c1", "g1", "s2", "o1"]);
    expect(rows[2]).toMatchObject({ startedBySessionId: "s1", backend: "codex", revealable: true });
    expect(rows[2]!.parentSessionId).toBeUndefined();
    expect(rows[3]).toMatchObject({ startedBySessionId: "c1" });
    expect(rows[5]).toMatchObject({ sessionId: "o1", startedBySessionId: "dismissed" });
    expect(rows[0]!.startedBySessionId).toBeUndefined();
    expect(nestedUnder(rows[1]!)).toBe("s1");
    expect(nestedUnder(rows[2]!)).toBe("s1");
    expect(nestedUnder(rows[0]!)).toBeUndefined();
  });

  test("a started session is a full session: active, announced by label, and its glyph is its own", () => {
    const rows = buildPanelRows({
      ...options,
      sessions: [starter, started],
      activeSessionId: "c1",
    });
    expect(rows[1]).toMatchObject({ sessionId: "c1", active: true, liveGlyph: "speaking" });
    expect(activeSessionIdForRows(rows, options.live)).toBe("c1");
  });

  test("a cycle in a bogus tree still lists every row", () => {
    const a: SessionInfo = { sessionId: "a", name: "a", pid: 1, startedBySessionId: "b" };
    const b: SessionInfo = { sessionId: "b", name: "b", pid: 2, startedBySessionId: "a" };
    const rows = buildPanelRows({ ...options, sessions: [a, b], activeSessionId: null });
    expect(rows.map((row) => row.sessionId).sort()).toEqual(["a", "b"]);
  });

  test("the published row carries startedBySessionId; both TUI renderers indent it with ↳", () => {
    const model = buildPanelModel({ ...options, sessions: [starter, started], activeSessionId: null });
    const published = buildPublishedState("owner", model, new Map(), new Set(), 1);
    expect(published.rows.map((row) => row.id)).toEqual(["s1", "c1"]);
    expect(published.rows[1]).toMatchObject({ startedBySessionId: "s1", backend: "codex", active: false });
    expect(published.rows[0]!.startedBySessionId).toBeUndefined();

    const painted = dashboardRowsForModel(model);
    expect(painted[0]).toContain("conch");
    expect(painted[0]).not.toContain("↳");
    expect(painted[1]).toContain("↳ codex review");
  });
});

describe("the theater, the Mac sidebar and the wire agree", () => {
  const repo = join(import.meta.dir, "..");
  const read = (path: string) => readFileSync(join(repo, path), "utf8");

  test("the theater's row lead indents a nested row the same way the footer does", () => {
    const status = read("src/status.ts");
    const lead = status.indexOf("function rowLead(row: PanelRowModel): string {");
    expect(lead).toBeGreaterThan(-1);
    const body = status.slice(lead, status.indexOf("\n}\n", lead));
    expect(body).toContain('return `${cursor} ${nestedUnder(row) ? "↳ " : ""}`;');
  });

  test("the Mac decodes startedBySessionId with a default of none and carries it through a rename", () => {
    const models = read("mac-app/conch-mac/Models.swift");
    expect(models).toContain("let startedBySessionId: String?");
    expect(models).toContain("case startedBySessionId");
    expect(models).toContain("startedBySessionId: String? = nil");
    expect(models).toContain("startedBySessionId =\n            try? container.decodeIfPresent(String.self, forKey: .startedBySessionId)");
    expect(models).toContain("parentSessionId: parentSessionId,\n            startedBySessionId: startedBySessionId");
  });

  test("the sidebar indents a started session under its starter, names the starter, and keeps the agent badge", () => {
    const dashboard = read("mac-app/conch-mac/DashboardView.swift");
    expect(dashboard).toContain(".padding(.leading, row.parentSessionId == nil && row.startedBySessionId == nil ? 0 : 18)");
    expect(dashboard).toContain("startedByLabel: row.startedBySessionId.flatMap { id in\n                                            state.rows.first(where: { $0.id == id })?.label");

    const row = dashboard.indexOf("private struct DashboardRow: View {");
    expect(row).toBeGreaterThan(-1);
    const body = dashboard.slice(row, dashboard.indexOf("private func pulseForReview()", row));
    expect(body).toContain("var startedByLabel: String? = nil");
    const line = body.indexOf('Text("started by \\(startedByLabel)")');
    const badge = body.indexOf("AgentBadge(backend: row.backend)");
    expect(line).toBeGreaterThan(-1);
    expect(badge).toBeGreaterThan(-1);
    expect(line).toBeLessThan(badge);
    // A started session is a session: the composer, close and reveal checks
    // key on parentSessionId alone and must not have grown a second condition.
    expect(dashboard).toContain("if let row = focusedRow, row.parentSessionId == nil {\n                        composer(for: row)");
    expect(dashboard).not.toContain("row.startedBySessionId == nil {\n                        composer(for: row)");
  });
});
