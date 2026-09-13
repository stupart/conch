import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BG_NO_TERMINAL,
  findHookWindow,
  findSession,
  findTranscript,
  isEngageable,
  registrySnapshot,
  withStartedBy,
  type SessionInfo,
} from "../src/sessions.ts";
import { lastAssistantReply, readConversationTail } from "../src/conversation.ts";
import { buildPanelModel, buildPublishedState } from "../src/panel.ts";

/**
 * The shapes Claude Code 2.1.266 leaves when a conversation is backgrounded:
 * the window (interactive, old id, `parkedJobId`) stays live as a viewer, a
 * `bg` job carries the conversation on under a new id with a `jobId`, and the
 * old transcript ends in `continued-in` followed by metadata that keeps its
 * mtime fresh. Typing into the window reaches the job, so the window is the
 * row's terminal route.
 *
 * The window pid must be a live process for the route to count, so it is this
 * test's own pid; 999999 is above macOS's pid ceiling, so it is never alive.
 * The job's pid is never probed — it is only the agent's own process.
 */
const CWD = "/Users/t";
const WINDOW = process.pid;
const DEAD = 999_999;
const JOB = 72858;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const claudeDir = mkdtempSync(join(tmpdir(), "conch-continued-"));
  roots.push(claudeDir);
  mkdirSync(join(claudeDir, "sessions"), { recursive: true });
  const projects = join(claudeDir, "projects", CWD.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(projects, { recursive: true });
  return {
    claudeDir,
    registry(pid: number, entry: object) {
      writeFileSync(join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({
        pid, cwd: CWD, entrypoint: "cli", status: "busy", ...entry,
      }));
    },
    unregister(pid: number) {
      rmSync(join(claudeDir, "sessions", `${pid}.json`));
    },
    transcript(id: string, records: object[]) {
      writeFileSync(join(projects, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    },
    // Hermetic: no Codex home, no `ps`.
    options: { configDir: join(claudeDir, "conch-config"), codexHome: join(claudeDir, "codex"), processParents: async () => null },
  };
}

const said = (id: string, uuid: string, parentUuid: string | null, role: "user" | "assistant", text: string) => ({
  type: role,
  uuid,
  parentUuid,
  sessionId: id,
  timestamp: "2026-09-10T01:00:00.000Z",
  message: role === "user"
    ? { role, content: text }
    : { role, content: [{ type: "text", text }], stop_reason: "end_turn" },
});

const movedTo = (from: string, to: string) => [
  { type: "cost-state", sessionId: from, totalCostUSD: 1 },
  { type: "bridge-session", sessionId: from, bridgeSessionId: "cse_01Moved" },
  { type: "continued-in", timestamp: "2026-09-10T01:59:06.338Z", sessionId: from, continuedInSessionId: to },
];

/** The real shape: window 61637 (here WINDOW) on `pred`, parked on job `succjob`; bg job 72858 on `succ`. */
function backgrounded(windowPid = WINDOW) {
  const f = fixture();
  // The window's entry froze when it parked: stale id, stale status, no bridge.
  f.registry(windowPid, {
    sessionId: "pred", kind: "interactive", name: "conch", nameSource: "user", parkedJobId: "succjob",
    bridgeSessionId: null, startedAt: 1, status: "idle", statusUpdatedAt: 100,
  });
  f.registry(JOB, {
    sessionId: "succ", kind: "bg", name: "conch", jobId: "succjob", bridgeSessionId: "session_01Moved",
    startedAt: 2, status: "busy", statusUpdatedAt: 900,
  });
  f.transcript("pred", [
    { type: "custom-title", customTitle: "frozen title", sessionId: "pred" },
    said("pred", "u1", null, "user", "start"),
    said("pred", "a1", "u1", "assistant", "frozen on the tenth"),
    ...movedTo("pred", "succ"),
  ]);
  f.transcript("succ", [
    { type: "custom-title", customTitle: "live title", sessionId: "succ" },
    { type: "mode", mode: "normal", sessionId: "succ" },
    { type: "permission-mode", permissionMode: "bypassPermissions", sessionId: "succ" },
    said("succ", "u1", null, "user", "start"),
    said("succ", "a1", "u1", "assistant", "frozen on the tenth"),
    said("succ", "u2", "a1", "user", "keep going"),
    said("succ", "a2", "u2", "assistant", "still going days later"),
  ]);
  return f;
}

const published = (info: SessionInfo) => buildPublishedState("device", buildPanelModel({
  sessions: [info],
  sessionStates: new Map(),
  pausedSessionIds: new Set(),
  live: { state: "idle", label: "", partial: "" },
  mode: { muted: false, paused: false, holding: 0 },
  activeSessionId: null,
  navSelectedId: null,
}), new Map(), new Set(), Date.now()).rows[0]!;

describe("a conversation moved to a background session", () => {
  test("is one row: the live job, with its own title and conversation", async () => {
    const f = backgrounded();
    const snap = (await registrySnapshot(f.claudeDir, f.options))!;
    const claude = snap.infos.filter((s) => s.backend !== "codex");
    expect(claude.map((s) => s.sessionId)).toEqual(["succ"]);
    const row = claude[0]!;
    expect(row.name).toBe("live title");
    // The window it left is still alive — just not a second row.
    expect(snap.liveIds.has("pred")).toBe(true);

    const path = findTranscript(f.claudeDir, row.sessionId)!;
    expect(path.endsWith("succ.jsonl")).toBe(true);
    const conversation = await readConversationTail(path, row.sessionId, "claude");
    expect(lastAssistantReply(conversation)).toBe("still going days later");
  });

  test("the job's row routes to its attached window, and says nothing is missing", async () => {
    const f = backgrounded();
    const row = (await registrySnapshot(f.claudeDir, f.options))!.infos.find((s) => s.sessionId === "succ")!;
    // Everything conch types, stops, reveals or closes goes by this pid.
    expect(row.pid).toBe(WINDOW);
    expect(row.noTerminal).toBeUndefined();
    expect(row.jobId).toBe("succjob");
    expect(row.agentPid).toBe(JOB);
    // State is the job's; the window's entry froze when it parked.
    expect(row.status).toBe("busy");
    expect(row.statusUpdatedAt).toBe(900);
    expect(row.startedAt).toBe(2);
    expect(row.bridgeSessionId).toBe("session_01Moved");
    expect(published(row)).toMatchObject({ id: "succ", revealable: true });
    expect(published(row).attachable).toBeUndefined();
    expect(isEngageable({ kind: "bg", entrypoint: "cli" })).toBe(true);
    expect(isEngageable({ kind: "bg", entrypoint: "claude-desktop" })).toBe(false);
  });

  test("a hook the job fires lands on the job's row, routed to the window", async () => {
    const f = backgrounded();
    const window = await findHookWindow(f.claudeDir, "succ");
    expect(window).toMatchObject({ sessionId: "succ", pid: WINDOW, status: "busy" });
    expect(window?.noTerminal).toBeUndefined();
    expect(isEngageable(window!)).toBe(true);
  });

  test("a lookup naming the window's own stale id resolves to the job's row", async () => {
    const f = backgrounded();
    expect(await findHookWindow(f.claudeDir, "pred")).toMatchObject({ sessionId: "succ", pid: WINDOW, status: "busy" });
    expect(await findSession(f.claudeDir, "pred")).toMatchObject({ sessionId: "succ", pid: WINDOW });
    expect(await findSession(f.claudeDir, "succ")).toMatchObject({ sessionId: "succ", pid: WINDOW });
  });

  test("with no window attached the row stays, says why, and can be opened in Terminal", async () => {
    const f = backgrounded(DEAD); // the window's file outlived its process
    const row = (await registrySnapshot(f.claudeDir, f.options))!.infos.find((s) => s.sessionId === "succ")!;
    expect(row).toMatchObject({ sessionId: "succ", pid: 0, noTerminal: BG_NO_TERMINAL, jobId: "succjob", status: "busy" });
    expect(published(row)).toMatchObject({ id: "succ", noTerminal: BG_NO_TERMINAL, attachable: true });
    expect(published(row).revealable).toBeUndefined();
    expect((await findHookWindow(f.claudeDir, "succ"))?.pid).toBe(0);

    f.unregister(DEAD); // or gone entirely
    const alone = (await registrySnapshot(f.claudeDir, f.options))!.infos.find((s) => s.sessionId === "succ")!;
    expect(alone).toMatchObject({ pid: 0, noTerminal: BG_NO_TERMINAL, jobId: "succjob" });

    // A Codex row with no terminal has no job to attach.
    expect(published({ sessionId: "cx", backend: "codex", pid: 0, noTerminal: "closed" }).attachable).toBeUndefined();
  });

  test("several windows on one job: the most recently started live one", async () => {
    const f = backgrounded();
    f.registry(process.ppid, { sessionId: "viewer-2", kind: "interactive", parkedJobId: "succjob", startedAt: 9 });
    f.registry(DEAD, { sessionId: "viewer-3", kind: "interactive", parkedJobId: "succjob", startedAt: 99 });
    f.registry(4242, { sessionId: "other", kind: "interactive", parkedJobId: "otherjob", startedAt: 999 });
    const snap = (await registrySnapshot(f.claudeDir, f.options))!;
    expect(snap.infos.find((s) => s.sessionId === "succ")!.pid).toBe(process.ppid);
  });

  test("a window parked on a listed job is not a row of its own, even with no continued-in", async () => {
    const f = backgrounded();
    // `claude attach` from a fresh terminal: parked on the job, nothing moved.
    f.registry(process.ppid, { sessionId: "viewer", kind: "interactive", parkedJobId: "succjob", startedAt: 9 });
    const ids = (await registrySnapshot(f.claudeDir, f.options))!.infos.map((s) => s.sessionId);
    expect(ids).toEqual(["succ"]);
  });

  test("a job that is not live leaves the window as its own row", async () => {
    const f = backgrounded();
    f.unregister(JOB);
    const claude = (await registrySnapshot(f.claudeDir, f.options))!.infos;
    expect(claude.map((s) => s.sessionId)).toEqual(["pred"]);
    // It is what that terminal holds, so it keeps its pid and its own title.
    expect(claude[0]!.pid).toBe(WINDOW);
    expect(claude[0]!.noTerminal).toBeUndefined();
    expect(claude[0]!.name).toBe("frozen title");
    expect(await findHookWindow(f.claudeDir, "pred")).toMatchObject({ sessionId: "pred", pid: WINDOW });
  });

  test("a chain is followed through a successor that is no longer live", async () => {
    const f = backgrounded();
    f.registry(WINDOW, { sessionId: "pred", kind: "interactive", startedAt: 1 });
    // pred → mid (gone) → succ (live)
    f.transcript("pred", [said("pred", "u1", null, "user", "start"), ...movedTo("pred", "mid")]);
    f.transcript("mid", [said("mid", "u1", null, "user", "start"), ...movedTo("mid", "succ")]);
    const ids = (await registrySnapshot(f.claudeDir, f.options))!.infos.map((s) => s.sessionId);
    expect(ids).toEqual(["succ"]);
  });

  test("a cycle in continued-in terminates and hides nothing", async () => {
    const f = backgrounded();
    f.unregister(JOB);
    f.transcript("pred", [said("pred", "u1", null, "user", "start"), ...movedTo("pred", "a")]);
    f.transcript("a", movedTo("a", "b"));
    f.transcript("b", movedTo("b", "a"));
    const ids = (await registrySnapshot(f.claudeDir, f.options))!.infos.map((s) => s.sessionId);
    expect(ids).toEqual(["pred"]);
  });

  test("a conversation that carried on in its window after moving is not hidden", async () => {
    const f = backgrounded();
    // Taking the conversation back clears the window's parkedJobId.
    f.registry(WINDOW, { sessionId: "pred", kind: "interactive", startedAt: 1 });
    f.transcript("pred", [
      said("pred", "u1", null, "user", "start"),
      ...movedTo("pred", "succ"),
      said("pred", "u2", "u1", "user", "typed here anyway"),
    ]);
    const snap = (await registrySnapshot(f.claudeDir, f.options))!;
    expect(snap.infos.map((s) => s.sessionId).sort()).toEqual(["pred", "succ"]);
    // And nothing is parked on the job now, so it is not routed to that window.
    expect(snap.infos.find((s) => s.sessionId === "succ")).toMatchObject({ pid: 0, noTerminal: BG_NO_TERMINAL });
  });

  test("a background window sharing an id with a terminal keeps its own key", async () => {
    const f = fixture();
    f.registry(111, { sessionId: "shared", kind: "interactive", startedAt: 1 });
    f.registry(222, { sessionId: "shared", kind: "bg", startedAt: 2 });
    const ids = (await registrySnapshot(f.claudeDir, f.options))!.infos.map((s) => s.sessionId).sort();
    expect(ids).toEqual(["shared#111", "shared#222"]);
  });

  test("a session a job's Bash started is filed under that job, not the window its daemon descends from", () => {
    // Claude Code's daemon is shared and descends from whichever window started
    // it (61637 → 72806 claude daemon run → pty hosts → jobs), so a walk up
    // from anything a second job started passes that window too.
    const conch: SessionInfo = { sessionId: "succ", pid: 61637, agentPid: 72858, jobId: "succjob" };
    const other: SessionInfo = { sessionId: "other", pid: 50000, agentPid: 80000, jobId: "otherjob" };
    const codex: SessionInfo = { sessionId: "cx", backend: "codex", pid: 90000 };
    const parents = new Map([
      [90000, 90001], [90001, 80000], // codex → zsh → job 2
      [80000, 80001], [80001, 72806], // job 2 → its pty host → the daemon
      [72858, 72827], [72827, 72806], // job 1 → its pty host → the daemon
      [72806, 61637], [61637, 1], [50000, 1],
    ]);
    const rows = withStartedBy([conch, other, codex], parents);
    expect(rows.find((r) => r.sessionId === "cx")?.startedBySessionId).toBe("other");
    expect(rows.find((r) => r.sessionId === "other")?.startedBySessionId).toBeUndefined();
    expect(rows.find((r) => r.sessionId === "succ")?.startedBySessionId).toBeUndefined();
  });
});
