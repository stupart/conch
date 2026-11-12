import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hierarchyLine, memberLines, runsInsideAgent, runTeamCommand, TEAM_USAGE, type TeamCliDeps } from "../src/team-cli.ts";
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
  test("with nothing else: the teams running, their members and the types, as one screen", async () => {
    const c = cli(() => teamsReply({ caller: { team: "build-review-1", member: "builder-1" } }));
    expect(await c.run()).toBe(0);
    expect(c.sent[0]!.request).toEqual({ kind: "teams", callerPid: 4242 });
    expect(c.out[0]).toBe("Running:");
    expect(c.out[1]).toBe("  build-review-1  Build + review  12m ago  in /work/app  (yours)");
    expect(c.out.join("\n")).toContain("build-review           Build + review: Lead → Builder (×3), Reviewer");
    expect(c.out.join("\n")).toContain("design-crit            Design crit loop: Designer → Critic");
  });

  test("start: the team, then the lead once it runs, by its session id", async () => {
    let looks = 0;
    const c = cli((request) => request.kind === "team-start"
      ? { kind: "team-started", team: { ...TEAM, members: [{ ...TEAM.members[0], state: "starting", sessionId: undefined }] } }
      : teamsReply({ running: [{ ...TEAM, members: [looks++ ? TEAM.members[0] : { ...TEAM.members[0], state: "starting", sessionId: undefined }] }] }));
    expect(await c.run("start", "build-review", "Add a dark mode to Settings", "--cwd", "sub")).toBe(0);
    expect(c.sent[0]!.request).toEqual({ kind: "team-start", type: "build-review", task: "Add a dark mode to Settings", cwd: "/work/app/sub", callerPid: 4242 });
    expect(c.out).toEqual([
      `[conch] started build-review-1 ("Build + review") in /work/app: lead-1 "Lead · Add a dark mode to Settings".`,
      `[conch] the lead is running as "Lead · Add a dark mode to Settings" (session s-1). \`conch team members build-review-1\` lists the team.`,
    ]);
  });

  test("start in a folder an agent won't trust yet: nothing started, and how to say yes; refusals exit 3", async () => {
    const c = cli(() => ({ kind: "team-needs-trust", cwd: "/work/app", agents: ["Claude Code"] }));
    expect(await c.run("start", "build-review", "x")).toBe(3);
    expect(c.err[0]).toBe("[conch] Claude Code hasn't been told to trust /work/app yet, so nothing was started. Run it again with --trust-folder to have conch answer yes when it asks.");
    const again = cli(() => ({ kind: "team-started", team: TEAM }));
    expect(await again.run("start", "build-review", "x", "--trust-folder", "--no-wait")).toBe(0);
    expect(again.sent[0]!.request.trustFolder).toBe(true);
    expect(again.sent).toHaveLength(1);
  });

  test("add: the member's session id and how to read its report; the daemon's refusals and failures keep their exit codes", async () => {
    const member = { key: "builder-2", roleId: "builder", roleName: "Builder", label: "Builder 2 · Toggle", state: "running", sessionId: "s-9", startedAt: 0 };
    const c = cli(() => ({ kind: "team-member-added", team: TEAM, member }), { fromAgent: true });
    expect(await c.run("add", "builder", "Build the toggle")).toBe(0);
    expect(c.sent[0]).toEqual({ request: { kind: "team-add", role: "builder", task: "Build the toggle", callerPid: 4242, fromAgent: true }, timeoutMs: 70_000 });
    expect(c.out[0]).toContain(`started builder-2, "Builder 2 · Toggle" (session s-9), on build-review-1. Read its report: conch_transcript_tail {session: "s-9", wait: 30}`);
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
    expect(c.out).toEqual([`[conch] passed the task to "Lead · Add a dark mode to Settings", the lead of build-review-1.`]);
  });

  test("members: your own team by default, each with its session, status and budget", async () => {
    const c = cli(() => teamsReply({ caller: { team: "build-review-1", member: "builder-1" } }));
    expect(await c.run("members")).toBe(0);
    expect(c.out).toEqual([
      "build-review-1  Build + review  in /work/app",
      "  lead-1       Lead · Add a dark mode to Settings  working  session s-1",
      "  builder-1    Builder · Toggle (you)  waiting  session s-2  reports to lead-1",
      "  critic-1     Critic · Round 1  working, 12m of 30m  session s-3  reports to lead-1",
    ]);
    const none = cli(() => teamsReply());
    expect(await none.run("members")).toBe(2);
    expect(none.err[0]).toContain("name the team: you aren't on one");
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
    expect(c.err[0]).toStartWith("[conch] quote the task");
    expect(await c.run("frobnicate")).toBe(2);
    expect(await c.run("start", "--cwd")).toBe(2);
    expect(await c.run()).toBe(1);
    expect(c.err.at(-1)).toBe("[conch] this conch doesn't have teams yet: update it.");
    expect(await c.run("--help")).toBe(0);
    expect(c.out.at(-1)).toBe(TEAM_USAGE);
  });

  test("a conch team run inside Claude Code or Codex says so, so the daemon never takes it for the user", () => {
    expect(runsInsideAgent({ CLAUDECODE: "1" })).toBe(true);
    expect(runsInsideAgent({ CODEX_THREAD_ID: "019a" })).toBe(true);
    expect(runsInsideAgent({ TERM: "xterm" })).toBe(false);
  });

  test("the hierarchy on one line, and members' lines", () => {
    expect(hierarchyLine(STARTER_TEAM_TYPES[1]!)).toBe("Lead → Researcher, Builder (×2)");
    expect(memberLines({ ...TEAM, members: [{ ...TEAM.members[0]!, state: "failed", error: "it exited" }] }, 0)).toEqual(["lead-1       Lead · Add a dark mode to Settings  failed: it exited  session s-1"]);
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

describe("the daemon's wiring", () => {
  const daemon = readFileSync(join(import.meta.dir, "../src/daemon.ts"), "utf8");
  const block = daemon.slice(daemon.indexOf("const teamDesk = new TeamDesk({"), daemon.indexOf("teamDeskReady = teamDesk;"));

  test("a member starts as conch_start starts a session: the socket's own check, the runtime's start, waited on", () => {
    expect(block).toContain(`validateRuntimeControlMessage({ kind: "session-start", ...request, wait: true })`);
    expect(block).toContain("applyRuntimeControlMessage(checked.value, runtimeControlDispatchOptions)");
    expect(block).toContain(`reply.kind === "session-needs-trust"`);
  });

  test("the user's words go in as the composer sends them; an agent's wait for peer messages", () => {
    expect(block).toContain("deliverFromUser: async (sessionId, text) =>");
    expect(block).toContain("enqueue(approvedInjectEvent(");
    expect(block).not.toContain("deliverFromSession:");
  });

  test("the control server is handed the desk, and the sessions file carries the teams at work", () => {
    expect(daemon).toContain("    teams: teamDesk,\n");
    expect(daemon).toContain("const teams = teamDeskReady?.published();");
    expect(daemon).toContain("if (teams?.length) lastPublishedPanelState.teams = teams;");
  });

  test("the user's own Terminal is told apart from a session conch can't place by the caller lookup's own words", async () => {
    expect(block).toContain("binding.reason === `no live session conch knows started pid ${pid}`");
    const { sessionForCallerPid } = await import("../src/caller-session.ts");
    const binding = await sessionForCallerPid(12345, { infos: [], claudeDir: "/nowhere", parents: async () => new Map([[12345, 1]]), read: async () => { throw new Error("none"); } });
    expect(binding).toEqual({ status: "unverified", reason: "no live session conch knows started pid 12345" });
  });
});
