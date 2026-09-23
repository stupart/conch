import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addressParkedWindow,
  BG_NO_TERMINAL,
  findHookWindow,
  findSession,
  findSessionByName,
  findTranscript,
  parkedWindowJob,
  parseAttachedJobPids,
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
    options: {
      configDir: join(claudeDir, "conch-config"),
      codexHome: join(claudeDir, "codex"),
      processParents: async () => null,
      attachedJobPids: async () => null,
    },
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
    expect((await findHookWindow(f.claudeDir, "succ", f.options))?.pid).toBe(0);

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

describe("an address naming the hidden window", () => {
  // Processes older than #187 (a hook, the conch MCP server, the window's own
  // children) still name the window's stale id, or only its pid.
  test("its stale id, or its pid when the id is unknown, is the job's row", async () => {
    const f = backgrounded();
    expect((await parkedWindowJob(f.claudeDir, "pred"))?.sessionId).toBe("succ");
    expect((await parkedWindowJob(f.claudeDir, "an-id-no-one-registered", WINDOW))?.sessionId).toBe("succ");
    // By name too, which is how MCP tools, the CLI and a spoken address resolve.
    expect((await findSessionByName(f.claudeDir, "pred", f.options))?.sessionId).toBe("succ");
  });

  test("nothing else is re-addressed: the job itself, a dead pid, a live session of its own", async () => {
    const f = backgrounded();
    expect(await parkedWindowJob(f.claudeDir, "succ")).toBeNull();
    expect(await parkedWindowJob(f.claudeDir, "an-id-no-one-registered", DEAD)).toBeNull();
    // An id the registry knows decides alone; a pid never re-addresses it.
    f.registry(4242, { sessionId: "other", kind: "interactive", name: "other" });
    expect(await parkedWindowJob(f.claudeDir, "other", WINDOW)).toBeNull();
  });

  test("a socket message is re-addressed only in its session id, and a row is never looked up", async () => {
    const f = backgrounded();
    const wire = { type: "turn-end", sessionId: "pred", pid: WINDOW, label: "conch", review: { summary: "x" } };
    expect(await addressParkedWindow(f.claudeDir, wire, () => false)).toEqual({ ...wire, sessionId: "succ" });
    expect(await addressParkedWindow(f.claudeDir, wire, (id) => id === "pred")).toBe(wire);
    const unscoped = { type: "wake", sessionId: "", pid: WINDOW };
    expect(await addressParkedWindow(f.claudeDir, unscoped, () => false)).toBe(unscoped);
  });
});

describe("a live `claude attach <jobId>` process with no registry entry", () => {
  // Claude Code 2.1.280's `claude attach <jobId>` writes no registry file at
  // all — ground truth (2026-09-23): job f31f0d15 was open in a visible
  // Terminal tab (pid 10231, ttys014) with nothing in ~/.claude/sessions
  // naming it, so conch reported BG_NO_TERMINAL for a job someone was looking
  // right at. Only a process-table probe finds that window.
  function attachedJob() {
    const f = fixture();
    f.registry(JOB, {
      sessionId: "attached-job", kind: "bg", name: "conch", jobId: "attachjob",
      startedAt: 2, status: "busy", statusUpdatedAt: 900,
    });
    f.transcript("attached-job", [
      { type: "custom-title", customTitle: "attached job title", sessionId: "attached-job" },
      said("attached-job", "u1", null, "user", "start"),
      said("attached-job", "a1", "u1", "assistant", "still running"),
    ]);
    return f;
  }

  test("is routed through the attach process, not reported as having no terminal", async () => {
    const f = attachedJob();
    const options = { ...f.options, attachedJobPids: async () => new Map([["attachjob", WINDOW]]) };
    const row = (await registrySnapshot(f.claudeDir, options))!.infos.find((s) => s.sessionId === "attached-job")!;
    expect(row).toMatchObject({ pid: WINDOW, jobId: "attachjob", agentPid: JOB });
    expect(row.noTerminal).toBeUndefined();

    const window = await findHookWindow(f.claudeDir, "attached-job", options);
    expect(window).toMatchObject({ sessionId: "attached-job", pid: WINDOW });
  });

  test("a dead attach pid is treated the same as none", async () => {
    const f = attachedJob();
    const options = { ...f.options, attachedJobPids: async () => new Map([["attachjob", DEAD]]) };
    const row = (await registrySnapshot(f.claudeDir, options))!.infos.find((s) => s.sessionId === "attached-job")!;
    expect(row).toMatchObject({ pid: 0, noTerminal: BG_NO_TERMINAL });
  });

  test("a registry-parked window still wins over the process-table fallback", async () => {
    const f = attachedJob();
    f.registry(process.ppid, { sessionId: "viewer", kind: "interactive", parkedJobId: "attachjob", startedAt: 9 });
    // The fallback names a different, DEAD pid here — proof it was never consulted.
    const options = { ...f.options, attachedJobPids: async () => new Map([["attachjob", DEAD]]) };
    const row = (await registrySnapshot(f.claudeDir, options))!.infos.find((s) => s.sessionId === "attached-job")!;
    expect(row.pid).toBe(process.ppid);
  });

  test("the ps parser: bare and path-prefixed claude, ignores the daemon's own pty host and lookalikes", () => {
    const ps = [
      " 10231 claude attach f31f0d15",
      "  9939 /opt/homebrew/bin/claude --bg-pty-host",
      " 20000 /opt/homebrew/bin/claude attach db7b8e98 --verbose",
      " 30000 not-claude attach f31f0d15",
      "   100 claude attach a1",
      "   200 claude attach a1",
    ].join("\n");
    const byJob = parseAttachedJobPids(ps);
    expect(byJob.get("f31f0d15")).toBe(10231);
    expect(byJob.get("db7b8e98")).toBe(20000);
    // The higher pid wins when two windows attach the same job.
    expect(byJob.get("a1")).toBe(200);
    expect(byJob.size).toBe(3);
  });
});

describe("a window's parkedJobId the daemon set without its conversation ever moving", () => {
  // Ground truth (2026-09-23): 2.1.280's daemon pre-spawns idle "bg-spare" job
  // slots per project directory and left a LIVE window's parkedJobId pointing
  // at one — job 25d17f50, auto-named "Prime page wireframe in blueprint
  // studio", transcript just the two metadata records Claude Code writes when
  // a spare gets auto-named (`ai-title`, `agent-name`) — while the window
  // (pid 94777, ttys003) kept running `claude --resume 2f266f8d`, 3,632 real
  // lines, the whole time. Real shapes and ids, shortened for readability.
  function decoyParked() {
    const f = fixture();
    f.registry(WINDOW, {
      sessionId: "resumed", kind: "interactive", name: "arch-25", nameSource: "derived",
      parkedJobId: "spare-slot", startedAt: 1, status: "idle", statusUpdatedAt: 100,
    });
    f.registry(8936, {
      sessionId: "spare-slot", kind: "bg", name: "Prime page wireframe", nameSource: "auto",
      jobId: "spare-slot", startedAt: 2, status: "idle", statusUpdatedAt: 200,
    });
    f.transcript("resumed", [
      said("resumed", "u1", null, "user", "start"),
      said("resumed", "a1", "u1", "assistant", "working on it"),
      said("resumed", "u2", "a1", "user", "keep going"),
      said("resumed", "a2", "u2", "assistant", "still going"),
    ]);
    f.transcript("spare-slot", [
      { type: "ai-title", aiTitle: "Prime page wireframe", sessionId: "spare-slot" },
      { type: "agent-name", agentName: "Prime page wireframe", sessionId: "spare-slot" },
    ]);
    return f;
  }

  test("shows the window's real conversation, not the empty spare job", async () => {
    const f = decoyParked();
    const snap = (await registrySnapshot(f.claudeDir, f.options))!;
    // The real conversation is the row. The empty job is not a row at all
    // (see "a background job nobody has talked to yet"), though it is live.
    expect(snap.infos.map((s) => s.sessionId)).toEqual(["resumed"]);
    expect(snap.liveIds.has("spare-slot")).toBe(true);

    const real = snap.infos.find((s) => s.sessionId === "resumed")!;
    expect(real.pid).toBe(WINDOW);
    expect(real.jobId).toBeUndefined();
    expect(real.noTerminal).toBeUndefined();
    const path = findTranscript(f.claudeDir, real.sessionId)!;
    const conversation = await readConversationTail(path, real.sessionId, "claude");
    expect(lastAssistantReply(conversation)).toBe("still going");
  });

  test("a hook or lookup by the window's own id is not redirected to the empty job", async () => {
    const f = decoyParked();
    expect(await findHookWindow(f.claudeDir, "resumed", f.options)).toMatchObject({ sessionId: "resumed", pid: WINDOW });
    expect(await findSession(f.claudeDir, "resumed", f.options)).toMatchObject({ sessionId: "resumed", pid: WINDOW });
    expect(await parkedWindowJob(f.claudeDir, "resumed", undefined, f.options)).toBeNull();
  });

  test("a genuine background move (continued-in backs the field up) is unaffected", async () => {
    // Regression guard alongside the whole `backgrounded()` suite above: the
    // corroboration check must not start rejecting a REAL move.
    const f = decoyParked();
    f.transcript("resumed", [
      said("resumed", "u1", null, "user", "start"),
      { type: "continued-in", timestamp: "2026-09-23T14:39:00.000Z", sessionId: "resumed", continuedInSessionId: "spare-slot" },
    ]);
    // A real move forks the conversation into the job.
    f.transcript("spare-slot", [said("spare-slot", "u1", null, "user", "start")]);
    const ids = (await registrySnapshot(f.claudeDir, f.options))!.infos.map((s) => s.sessionId);
    expect(ids).toEqual(["spare-slot"]);
  });
});

describe("a background job nobody has talked to yet", () => {
  // Ground truth (2026-09-23): 2.1.280's daemon keeps idle bg-spare jobs per
  // project directory. 50b4f863 and db7b8e98 (`spare: true`, no transcript)
  // and 25d17f50 (auto-named, transcript only `ai-title` + `agent-name`) each
  // showed as a session with no terminal and nothing in it.
  const job = (f: ReturnType<typeof fixture>, pid: number, id: string, extra: object = {}) =>
    f.registry(pid, { sessionId: id, kind: "bg", name: id, jobId: id, startedAt: 2, status: "idle", ...extra });
  const ids = async (f: ReturnType<typeof fixture>) =>
    (await registrySnapshot(f.claudeDir, f.options))!.infos.map((s) => s.sessionId).sort();

  test("a spare with no transcript is not a row, but is still live", async () => {
    const f = fixture();
    job(f, 8921, "spare", { spare: true });
    const snap = (await registrySnapshot(f.claudeDir, f.options))!;
    expect(snap.infos).toEqual([]);
    expect(snap.liveIds.has("spare")).toBe(true);
  });

  test("a job whose transcript is only metadata is not a row; one user record makes it one", async () => {
    const f = fixture();
    job(f, 8936, "named", { name: "Prime page wireframe", nameSource: "auto" });
    const metadata = [
      { type: "ai-title", aiTitle: "Prime page wireframe", sessionId: "named" },
      { type: "agent-name", agentName: "Prime page wireframe", sessionId: "named" },
    ];
    f.transcript("named", metadata);
    expect(await ids(f)).toEqual([]);
    f.transcript("named", [...metadata, said("named", "u1", null, "user", "go")]);
    expect(await ids(f)).toEqual(["named"]);
  });

  test("a job with no transcript found is still a row unless the registry says spare", async () => {
    // The transcript path is a guess from the cwd; a wrong guess must not hide a real job.
    const f = fixture();
    job(f, 8937, "unfound");
    expect(await ids(f)).toEqual(["unfound"]);
  });

  test("a big transcript counts as a conversation without being parsed", async () => {
    const f = fixture();
    job(f, 8938, "big");
    f.transcript("big", Array.from({ length: 800 }, () => ({ type: "custom-title", customTitle: "x".repeat(80), sessionId: "big" })));
    expect(await ids(f)).toEqual(["big"]);
  });

  test("a window whose conversation moved into an empty job keeps its own row", async () => {
    const f = fixture();
    job(f, 8939, "empty");
    f.transcript("empty", [{ type: "ai-title", aiTitle: "empty", sessionId: "empty" }]);
    f.registry(WINDOW, { sessionId: "window", kind: "interactive", parkedJobId: "empty", startedAt: 1 });
    f.transcript("window", [said("window", "u1", null, "user", "start"), ...movedTo("window", "empty")]);
    expect(await ids(f)).toEqual(["window"]);
  });
});
