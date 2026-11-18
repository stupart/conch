import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runsInsideAgent, runTeamCommand, type TeamCliDeps } from "../src/team-cli.ts";
import { createControlServer, type ControlServer } from "../src/control-server.ts";
import { forwardToDaemonSocket } from "../src/phone-bridge.ts";
import { STARTER_TEAM_TYPES, type TeamSummary } from "../src/teams.ts";
import type { TeamReply, TeamRequest } from "../src/team-desk.ts";

// `conch team`, as Tyler runs it in a Terminal and a lead runs it from its shell (team-cli.ts). The daemon is faked:
// each test answers the request lines it is sent.

const TEAM: TeamSummary = {
  id: "build-review-1", typeId: "build-review", name: "Build + review", task: "Add a dark mode to Settings", cwd: "/work/app", startedAt: 0,
  members: [
    { key: "lead-1", roleId: "lead", roleName: "Lead", label: "Lead · Add a dark mode to Settings", state: "running", sessionId: "s-1", status: "working", startedAt: 0 },
    { key: "builder-1", roleId: "builder", roleName: "Builder", label: "Builder · Toggle", state: "running", sessionId: "s-2", status: "waiting", startedAt: 0, reportsTo: "lead-1" },
    { key: "critic-1", roleId: "critic", roleName: "Critic", label: "Critic · Round 1", state: "running", sessionId: "s-3", status: "working", startedAt: 0, budgetMinutes: 30, reportsTo: "lead-1" },
  ],
  tasks: [{ text: "Add a dark mode to Settings", at: 0, from: "you" }],
};

const teamsReply = (extra: Record<string, unknown> = {}) => ({
  kind: "teams", types: STARTER_TEAM_TYPES, running: [TEAM], agents: {}, signIns: [], missingStarters: 0, ...extra,
});

function cli(answer: (request: Record<string, unknown>) => unknown, extra: Partial<TeamCliDeps> = {}) {
  const sent: Array<{ request: Record<string, unknown>; timeoutMs: number }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: TeamCliDeps = {
    async request(line, timeoutMs) {
      const request = JSON.parse(line);
      sent.push({ request, timeoutMs });
      return JSON.stringify(answer(request));
    },
    callerPid: 4242,
    fromAgent: false,
    cwd: "/work/app",
    configDir: "/config",
    stdin: async () => "From stdin\n",
    stdinIsTTY: true,
    readFile: async (path) => { throw new Error(`no ${path}`); },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    sleep: async () => {},
    now: () => 12 * 60_000,
    ...extra,
  };
  return { deps, sent, out, err, run: (...argv: string[]) => runTeamCommand(argv, deps) };
}

describe("conch team", () => {
  test("start: the team, then the lead once it runs, by its session id", async () => {
    let looks = 0;
    const c = cli((request) => request.kind === "team-start"
      ? { kind: "team-started", team: { ...TEAM, members: [{ ...TEAM.members[0], state: "starting", sessionId: undefined }] } }
      : teamsReply({ running: [{ ...TEAM, members: [looks++ ? TEAM.members[0] : { ...TEAM.members[0], state: "starting", sessionId: undefined }] }] }));
    expect(await c.run("start", "build-review", "Add a dark mode to Settings", "--cwd", "sub")).toBe(0);
    expect(c.sent[0]!.request).toEqual({ kind: "team-start", type: "build-review", task: "Add a dark mode to Settings", cwd: "/work/app/sub", callerPid: 4242 });
    expect(c.out.at(-1)).toContain("session s-1");
  });

  test("start in a folder an agent won't trust yet: nothing started, and how to say yes; refusals exit 3", async () => {
    const c = cli(() => ({ kind: "team-needs-trust", cwd: "/work/app", agents: ["Claude Code"] }));
    expect(await c.run("start", "build-review", "x")).toBe(3);
    const again = cli(() => ({ kind: "team-started", team: TEAM }));
    expect(await again.run("start", "build-review", "x", "--trust-folder", "--no-wait")).toBe(0);
    expect(again.sent[0]!.request.trustFolder).toBe(true);
    expect(again.sent).toHaveLength(1);
  });

  test("add: the member's session id and how to read its report; the daemon's refusals and failures keep their exit codes", async () => {
    const member = { key: "builder-2", roleId: "builder", roleName: "Builder", label: "Builder 2 · Toggle", state: "running", sessionId: "s-9", startedAt: 0 };
    const c = cli(() => ({ kind: "team-member-added", team: TEAM, member }), { fromAgent: true });
    expect(await c.run("add", "builder", "Build the toggle")).toBe(0);
    expect(c.sent[0]!.request).toEqual({ kind: "team-add", role: "builder", task: "Build the toggle", callerPid: 4242, fromAgent: true });
    expect(c.out[0]).toContain("s-9");
    for (const [code, exit] of [["invalid", 2], ["refused", 3], ["failed", 1]] as const) {
      const refused = cli(() => ({ kind: "team-error", code, error: "no" }));
      expect(await refused.run("add", "builder", "x")).toBe(exit);
      expect(refused.err).toEqual(["[conch] no"]);
    }
  });

  test("task: to a running team's lead, or a new team of a type; a task of - is read from stdin", async () => {
    const c = cli(() => ({ kind: "team-tasked", team: TEAM, to: "Lead · Add a dark mode to Settings" }));
    expect(await c.run("task", "build-review-1", "-")).toBe(0);
    expect(c.sent[0]!.request).toMatchObject({ kind: "team-task", team: "build-review-1", task: "From stdin", cwd: "/work/app" });
  });

  test("members: your own team by default, each with its session, status and budget", async () => {
    const c = cli(() => teamsReply({ caller: { team: "build-review-1", member: "builder-1" } }));
    expect(await c.run("members")).toBe(0);
    expect(c.out[0]).toStartWith("build-review-1");
    expect(c.out).toHaveLength(4);
    const none = cli(() => teamsReply());
    expect(await none.run("members")).toBe(2);
  });

  test("brief: read from conch's folder, yours by default, without the daemon when named", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-team-brief-"));
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, "teams", "build-review-1"), { recursive: true });
    writeFileSync(join(dir, "teams", "build-review-1", "builder-1.md"), "# Build + review: Builder\n\nYour task\n");
    const named = cli(() => { throw new Error("no daemon needed"); }, { configDir: dir, readFile: (path) => Bun.file(path).text() });
    expect(await named.run("brief", "build-review-1", "builder-1")).toBe(0);
    expect(named.out).toEqual(["# Build + review: Builder\n\nYour task"]);
    const own = cli(() => teamsReply({ caller: { team: "build-review-1", member: "builder-1" } }), { configDir: dir, readFile: (path) => Bun.file(path).text() });
    expect(await own.run("brief")).toBe(0);
    expect(own.out[0]).toStartWith("# Build + review");
    expect(await own.run("brief", "../etc", "passwd")).toBe(2);
  });

  test("the command's own mistakes exit 2 with the usage; an old daemon is said to need updating", async () => {
    const c = cli(() => ({ kind: "session-error", error: "invalid" }));
    expect(await c.run("start", "build-review", "fix", "the", "bug")).toBe(2);
    expect(await c.run("frobnicate")).toBe(2);
    expect(await c.run("start", "--cwd")).toBe(2);
    expect(await c.run()).toBe(1);
  });

  test("a conch team run inside Claude Code or Codex says so, so the daemon never takes it for the user", () => {
    expect(runsInsideAgent({ CLAUDECODE: "1" })).toBe(true);
    expect(runsInsideAgent({ CODEX_THREAD_ID: "019a" })).toBe(true);
    expect(runsInsideAgent({ TERM: "xterm" })).toBe(false);
  });

});

describe("through a real control server", () => {
  const servers: ControlServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  test("a team request reaches the desk as decoded, and its answer comes back in one frame; a bad one never reaches it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-team-socket-"));
    const socketPath = join(dir, "c.sock");
    const handled: TeamRequest[] = [];
    const server = createControlServer({
      socketPath, ownerDeviceId: "this-mac", log: () => {},
      sessions: { resolve: (value) => value, current: () => ({ published: true, label: "demo" }) },
      application: {
        configuration: () => ({ kind: "config-error", error: "stub" }),
        session: () => ({ kind: "session-error", error: "stub" }),
        runtime: () => ({ kind: "session-error", error: "stub" }) as never,
        turn: () => {},
        device: () => ({ kind: "ack" }),
      },
      teams: { handle: async (request) => { handled.push(request); return { kind: "team-tasked", team: TEAM, to: "Lead" } satisfies TeamReply; } },
    });
    servers.push(server);
    expect(await server.start()).toBe(true);
    try {
      const reply = JSON.parse(await forwardToDaemonSocket(socketPath, JSON.stringify({ kind: "team-task", team: "build-review-1", task: " Ship it ", callerPid: 77 }), 2_000));
      expect(reply).toMatchObject({ kind: "team-tasked", to: "Lead" });
      expect(handled).toEqual([{ kind: "team-task", team: "build-review-1", task: "Ship it", callerPid: 77 }]);
      const bad = JSON.parse(await forwardToDaemonSocket(socketPath, JSON.stringify({ kind: "team-start", type: "x", task: "" }), 2_000));
      expect(bad).toEqual({ kind: "team-error", code: "invalid", error: "the task is empty" });
      expect(handled).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("the caller lookup's reason for a pid it can't place is the one the daemon matches to tell the user's own Terminal apart", async () => {
  const { sessionForCallerPid } = await import("../src/caller-session.ts");
  const binding = await sessionForCallerPid(12345, { infos: [], claudeDir: "/nowhere", parents: async () => new Map([[12345, 1]]), read: async () => { throw new Error("none"); } });
  expect(binding).toEqual({ status: "unverified", reason: "no live session conch knows started pid 12345" });
});
