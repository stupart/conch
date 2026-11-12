import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeTeamRequest,
  MEMBER_GONE_MS,
  TeamDesk,
  teamBriefPath,
  teamDeskPaths,
  type TeamCaller,
  type TeamDeskDependencies,
  type TeamReply,
  type TeamStartOutcome,
  type TeamStartRequest,
  type TeamsReply,
} from "../src/team-desk.ts";
import { isMacAppOnlyRequest } from "../src/phone-bridge.ts";
import { applyRuntimeControlMessage } from "../src/control-server.ts";
import { validateRuntimeControlMessage, type RuntimeControlMessage } from "../src/settings.ts";
import { STARTER_TEAM_TYPES, type TeamType } from "../src/teams.ts";

// 2026-11-12, Tyler: "… and then i can spin up or pass tasks to team types." The daemon's desk, with the daemon's own
// start, delivery and caller lookup faked: nothing here starts a session or touches a running conch.

interface World {
  desk: TeamDesk;
  deps: TeamDeskDependencies;
  dir: string;
  starts: TeamStartRequest[];
  delivered: Array<{ sessionId: string; text: string; from?: string }>;
  statuses: Map<string, "working" | "waiting" | "needs">;
  callers: Map<number, TeamCaller | null | { unverified: string }>;
  clock: { now: number };
  logs: string[];
}

function world(overrides: Partial<TeamDeskDependencies> & { outcome?: (request: TeamStartRequest, n: number) => TeamStartOutcome | Promise<TeamStartOutcome> } = {}, dir = mkdtempSync(join(tmpdir(), "conch-teams-"))): World {
  const starts: TeamStartRequest[] = [];
  const delivered: World["delivered"] = [];
  const statuses = new Map<string, "working" | "waiting" | "needs">();
  const callers = new Map<number, TeamCaller | null | { unverified: string }>();
  const clock = { now: 1_000_000 };
  const logs: string[] = [];
  const { outcome, ...rest } = overrides;
  const deps: TeamDeskDependencies = {
    ...teamDeskPaths(dir),
    now: () => clock.now,
    log: (line) => logs.push(line),
    async start(request) {
      starts.push(request);
      const result = await (outcome ?? ((_r, n) => ({ sessionId: `s-${n}` })))(request, starts.length);
      if ("sessionId" in result) statuses.set(result.sessionId, "working");
      return result;
    },
    folderTrusted: () => true,
    isFolder: (path) => path.startsWith("/work"),
    sessionStatus: (id) => statuses.get(id),
    callerOf: async (pid) => callers.has(pid) ? callers.get(pid)! : null,
    async deliverFromUser(sessionId, text) {
      delivered.push({ sessionId, text });
      return { delivered: true };
    },
    signIns: () => [{ id: "abc-1", label: "Work Max", addedAt: 1 }],
    changed: () => {},
    ...rest,
  };
  return { desk: new TeamDesk(deps), deps, dir, starts, delivered, statuses, callers, clock, logs };
}

const list = async (w: World) => (await w.desk.handle({ kind: "teams" })) as TeamsReply;

async function startBuildReview(w: World, extra: Record<string, unknown> = {}) {
  const reply = await w.desk.handle({ kind: "team-start", type: "build-review", task: "Add a dark mode to Settings", cwd: "/work/app", ...extra });
  await w.desk.settled();
  return reply;
}

describe("team types: Settings › Teams' list, edits, copies and the starters", () => {
  test("a fresh conch lists its starter types, every agent's choices and the sign-ins, labels and ids only", async () => {
    const w = world();
    const reply = await list(w);
    expect(reply.kind).toBe("teams");
    expect(reply.types.map((type) => type.id)).toEqual(STARTER_TEAM_TYPES.map((type) => type.id));
    expect(reply.running).toEqual([]);
    expect(reply.missingStarters).toBe(0);
    expect(reply.agents.claude.efforts).toContain("xhigh");
    expect(reply.agents.codex.permissions).toEqual(["read-only", "workspace-write", "danger-full-access"]);
    expect(reply.signIns).toEqual([{ id: "abc-1", label: "Work Max" }]);
    // Nothing is written until something changes.
    expect(existsSync(w.deps.typesPath)).toBe(false);
  });

  test("a new type gets an id of its own; an edit names the type it was loaded as and replaces it, renamed or not", async () => {
    const w = world();
    const mine: TeamType = { ...structuredClone(STARTER_TEAM_TYPES[0]!), name: "Build + review" };
    const added = await w.desk.handle({ kind: "team-type-save", type: { ...mine, id: undefined } }) as TeamsReply;
    expect(added.saved).toBe("build-review-2");
    const edited = await w.desk.handle({ kind: "team-type-save", type: { ...mine, id: "small-team", name: "Small team" }, previousId: "build-review-2" }) as TeamsReply;
    expect(edited.saved).toBe("small-team");
    expect(edited.types.map((type) => type.id)).toEqual(["build-review", "research-spec-build", "design-crit", "small-team"]);
    // Kept, and read back by the next daemon.
    expect(JSON.parse(readFileSync(w.deps.typesPath, "utf8")).types.at(-1).name).toBe("Small team");
    expect((await list(world({}, w.dir))).types.at(-1)!.id).toBe("small-team");
    // Renaming onto another's id, or saving over one that has gone, is refused.
    expect(await w.desk.handle({ kind: "team-type-save", type: { ...mine, id: "design-crit" }, previousId: "small-team" })).toEqual({
      kind: "team-error", code: "invalid", error: `a team type is already called "design-crit"`, field: "id",
    });
    expect(await w.desk.handle({ kind: "team-type-save", type: mine, previousId: "gone" })).toMatchObject({ kind: "team-error", code: "refused" });
  });

  test("an invalid type is refused with the field to show it at", async () => {
    const w = world();
    const broken = structuredClone(STARTER_TEAM_TYPES[0]!);
    broken.roles[1]!.reportsTo = "nobody";
    expect(await w.desk.handle({ kind: "team-type-save", type: broken, previousId: "build-review" })).toEqual({
      kind: "team-error", code: "invalid", error: `Builder reports to "nobody", which isn't a role here`, field: "roles.1.reportsTo",
    });
  });

  test("duplicate lands beside the original as a copy; delete and the starters come back on asking", async () => {
    const w = world();
    const copied = await w.desk.handle({ kind: "team-type-duplicate", id: "design-crit" }) as TeamsReply;
    expect(copied.saved).toBe("design-crit-loop-copy");
    expect(copied.types.find((type) => type.id === copied.saved)!.name).toBe("Design crit loop copy");
    const again = await w.desk.handle({ kind: "team-type-duplicate", id: "design-crit" }) as TeamsReply;
    expect(again.types.find((type) => type.id === again.saved)!.name).toBe("Design crit loop copy 2");
    const gone = await w.desk.handle({ kind: "team-type-delete", id: "build-review" }) as TeamsReply;
    expect(gone.missingStarters).toBe(1);
    const back = await w.desk.handle({ kind: "team-types-restore" }) as TeamsReply;
    expect(back.missingStarters).toBe(0);
    expect(back.types.at(-1)!.id).toBe("build-review");
  });
});

describe("starting a team on a task", () => {
  test("the lead starts first, on the role's agent, with its brief as one first line; the team is published as it goes", async () => {
    const custom = structuredClone(STARTER_TEAM_TYPES[0]!);
    custom.roles[0] = { ...custom.roles[0]!, model: "opus", effort: "xhigh", signIn: "work max", permissions: "acceptEdits" };
    custom.roles[2] = { ...custom.roles[2]!, atStart: true, host: "background" };
    const w = world();
    await w.desk.handle({ kind: "team-type-save", type: custom, previousId: "build-review" });
    const reply = await startBuildReview(w);
    expect(reply.kind).toBe("team-started");
    const team = (reply as Extract<TeamReply, { kind: "team-started" }>).team;
    expect(team.id).toBe("build-review-1");
    expect(team.members.map((member) => [member.key, member.state])).toEqual([["lead-1", "starting"], ["reviewer-1", "starting"]]);
    // In order, the lead first, each as the daemon's own start takes it.
    expect(w.starts.map((start) => start.label)).toEqual(["Lead · Add a dark mode to Settings", "Reviewer · Add a dark mode to Settings"]);
    expect(w.starts[0]).toEqual({
      backend: "claude",
      cwd: "/work/app",
      prompt: expect.stringContaining("Your task: Add a dark mode to Settings"),
      label: "Lead · Add a dark mode to Settings",
      claudeSignInId: "abc-1",
      options: { model: "opus", effort: "xhigh", "permission-mode": "acceptEdits", "bypass-permissions": false },
    });
    expect(w.starts[0]!.prompt).not.toContain("\n");
    expect(w.starts[1]).toMatchObject({ host: "background", options: { effort: "high" } });
    // The reviewer's brief names its lead by session, which it had by then.
    expect(w.starts[1]!.prompt).toContain(`reporting to "Lead · Add a dark mode to Settings" (session s-1)`);
    const brief = readFileSync(teamBriefPath(w.dir, "build-review-1", "reviewer-1"), "utf8");
    expect(brief).toContain("(lead-1, session s-1)");
    const published = w.desk.published();
    expect(published[0]!.members).toEqual([
      expect.objectContaining({ key: "lead-1", state: "running", sessionId: "s-1", status: "working" }),
      expect.objectContaining({ key: "reviewer-1", state: "running", sessionId: "s-2", reportsTo: "lead-1" }),
    ]);
    // The running team never carries the type it was started from, nor anything to do with trust.
    expect(Object.keys(published[0]!)).not.toContain("type");
    expect(w.desk.teamForSession("s-2")).toEqual({ team: "build-review-1", member: "reviewer-1" });
  });

  test("a folder an agent hasn't been told to trust is asked about first, for every agent the type can start; nothing starts", async () => {
    const codex = structuredClone(STARTER_TEAM_TYPES[0]!);
    codex.roles[1]!.backend = "codex";
    const w = world({ folderTrusted: (backend) => backend === "codex" ? false : true });
    await w.desk.handle({ kind: "team-type-save", type: codex, previousId: "build-review" });
    expect(await startBuildReview(w)).toEqual({ kind: "team-needs-trust", cwd: "/work/app", agents: ["Codex"] });
    expect(w.starts).toEqual([]);
    expect((await list(w)).running).toEqual([]);
    // Told to trust it, it starts, and so does every member asked for later.
    expect((await startBuildReview(w, { trustFolder: true })).kind).toBe("team-started");
    expect(w.starts[0]!.trustFolder).toBe(true);
  });

  test("a type, a folder or a sign-in conch doesn't have is refused with what there is", async () => {
    const w = world();
    expect(await w.desk.handle({ kind: "team-start", type: "nope", task: "x", cwd: "/work/app" })).toMatchObject({
      kind: "team-error", code: "refused", error: expect.stringContaining(`conch has "Build + review" (build-review)`),
    });
    expect(await w.desk.handle({ kind: "team-start", type: "Build + review", task: "x", cwd: "/elsewhere" })).toEqual({
      kind: "team-error", code: "invalid", error: "/elsewhere is not a folder that exists", field: "cwd",
    });
    const signed = structuredClone(STARTER_TEAM_TYPES[2]!);
    signed.roles[0]!.signIn = "Personal";
    await w.desk.handle({ kind: "team-type-save", type: signed, previousId: "design-crit" });
    expect(await w.desk.handle({ kind: "team-start", type: "design-crit", task: "x", cwd: "/work/app" })).toMatchObject({
      kind: "team-error", code: "refused", error: expect.stringContaining(`no Claude sign-in is called "Personal"`), field: "roles.0.signIn",
    });
    expect(w.starts).toEqual([]);
  });

  test("a member that doesn't start says why; the next one still starts", async () => {
    const w = world({ outcome: (_request, n) => { if (n === 1) throw new Error("the new session's agent exited as soon as it started, in Terminal (ttys009)\nmore"); return { sessionId: `s-${n}` }; } });
    const research = await w.desk.handle({ kind: "team-start", type: "research-spec-build", task: "Find a charting library", cwd: "/work/app" });
    expect(research.kind).toBe("team-started");
    await w.desk.settled();
    expect(w.desk.published()[0]!.members.map((member) => [member.key, member.state, member.error])).toEqual([
      ["lead-1", "failed", "the new session's agent exited as soon as it started, in Terminal (ttys009)"],
      ["researcher-1", "running", undefined],
    ]);
  });

  test("an agent's start works in the agent's own folder unless it names another", async () => {
    const w = world();
    w.callers.set(4242, { sessionId: "agent-1", label: "Planner", cwd: "/work/planner" });
    expect((await w.desk.handle({ kind: "team-start", type: "design-crit", task: "Polish onboarding", callerPid: 4242 })).kind).toBe("team-started");
    expect(w.starts[0]!.cwd).toBe("/work/planner");
    // The task is recorded as the agent's.
    expect(w.desk.published()[0]!.tasks[0]!.from).toBe("Planner");
  });
});

describe("asking conch for a member", () => {
  async function running(w: World) {
    await startBuildReview(w);
    w.callers.set(100, { sessionId: "s-1", label: "Lead · Add a dark mode to Settings", cwd: "/work/app" });
  }

  test("the lead asks for a builder on its own part, and gets its session id once it runs", async () => {
    const w = world();
    await running(w);
    const reply = await w.desk.handle({ kind: "team-add", role: "builder", task: "Build the toggle in SettingsView", callerPid: 100 });
    expect(reply).toMatchObject({ kind: "team-member-added", member: { key: "builder-1", label: "Builder · Build the toggle in…", sessionId: "s-2", reportsTo: "lead-1", task: "Build the toggle in SettingsView", state: "running" } });
    expect(w.starts[1]!.prompt).toContain("Your task: Build the toggle in SettingsView");
    expect(w.starts[1]!.prompt).toContain("`conch team brief build-review-1 builder-1`");
    expect(readFileSync(teamBriefPath(w.dir, "build-review-1", "builder-1"), "utf8")).toContain("The team's task: Add a dark mode to Settings");
  });

  test("a role runs at most its limit working at once; one waiting for its next word doesn't count", async () => {
    const w = world();
    await running(w);
    for (const part of ["one", "two", "three"]) expect((await w.desk.handle({ kind: "team-add", role: "Builder", task: part, callerPid: 100 })).kind).toBe("team-member-added");
    expect(await w.desk.handle({ kind: "team-add", role: "builder", task: "four", callerPid: 100 })).toEqual({
      kind: "team-error", code: "refused",
      error: "3 builders are already working (builder-1, builder-2, builder-3), and Build + review runs at most 3 at once: wait for one to finish, then ask again",
    });
    w.statuses.set("s-2", "waiting");
    expect(await w.desk.handle({ kind: "team-add", role: "builder", task: "four", callerPid: 100 })).toMatchObject({ kind: "team-member-added", member: { key: "builder-4" } });
  });

  test("the hierarchy decides who may ask for whom; a session off the team may not ask at all; there is one lead", async () => {
    const w = world();
    await running(w);
    await w.desk.handle({ kind: "team-add", role: "builder", task: "one", callerPid: 100 });
    w.callers.set(200, { sessionId: "s-2", label: "Builder · one" });
    expect(await w.desk.handle({ kind: "team-add", role: "reviewer", task: "review me", callerPid: 200 })).toMatchObject({
      code: "refused", error: "a reviewer reports to the lead, not to you: ask them", field: "role",
    });
    w.callers.set(300, { sessionId: "elsewhere", label: "Other work" });
    expect(await w.desk.handle({ kind: "team-add", role: "builder", task: "x", callerPid: 300 })).toMatchObject({ code: "refused", error: "you aren't a member of a running conch team" });
    expect(await w.desk.handle({ kind: "team-add", team: "build-review-1", role: "builder", task: "x", callerPid: 300 })).toMatchObject({
      code: "refused", error: "only build-review-1's own members can ask for members, and you aren't one",
    });
    expect(await w.desk.handle({ kind: "team-add", role: "lead", task: "x", callerPid: 100 })).toMatchObject({ code: "refused", error: "build-review-1 has its lead already: a team has one" });
    expect(await w.desk.handle({ kind: "team-add", role: "designer", task: "x", callerPid: 100 })).toMatchObject({ code: "refused", error: "Build + review has no role \"designer\": it has lead, builder, reviewer" });
  });

  test("the user names the team and may ask for any role; an agent conch can't place is never taken for the user", async () => {
    const w = world();
    await running(w);
    expect(await w.desk.handle({ kind: "team-add", role: "reviewer", task: "x" })).toMatchObject({ code: "invalid", field: "team" });
    expect((await w.desk.handle({ kind: "team-add", team: "build-review-1", role: "reviewer", task: "Review PR 12", callerPid: 999 })).kind).toBe("team-member-added");
    expect(await w.desk.handle({ kind: "team-add", team: "build-review-1", role: "builder", task: "x", callerPid: 999, fromAgent: true })).toMatchObject({
      code: "refused", error: "conch can't tell which session is asking",
    });
    w.callers.set(555, { unverified: "pid 555 runs 2 sessions" });
    expect(await w.desk.handle({ kind: "team-add", team: "build-review-1", role: "builder", task: "x", callerPid: 555 })).toMatchObject({
      code: "refused", error: "conch can't tell which session is asking (pid 555 runs 2 sessions)",
    });
  });
});

describe("passing a team a task", () => {
  test("the user's task reaches the running team's lead as the user's own words", async () => {
    const w = world();
    await startBuildReview(w);
    const reply = await w.desk.handle({ kind: "team-task", team: "build-review-1", task: "Also check the phone width" });
    expect(reply).toMatchObject({ kind: "team-tasked", to: "Lead · Add a dark mode to Settings" });
    expect(w.delivered).toEqual([{ sessionId: "s-1", text: "New task for the team (build-review-1): Also check the phone width" }]);
    expect((reply as Extract<TeamReply, { kind: "team-tasked" }>).team.tasks.map((task) => task.from)).toEqual(["you", "you"]);
  });

  test("an agent's task to a running team waits for peer messages: refused with what to do, and nothing typed anywhere", async () => {
    const w = world();
    await startBuildReview(w);
    w.callers.set(700, { sessionId: "agent-9", label: "Chief of staff" });
    expect(await w.desk.handle({ kind: "team-task", team: "build-review-1", task: "x", callerPid: 700 })).toMatchObject({
      kind: "team-error", code: "refused", error: expect.stringContaining("conch team start build-review"),
    });
    expect(w.delivered).toEqual([]);
    // Once peer messages land, the daemon wires them, and the same ask is delivered from the agent.
    const sent: Array<{ from: string; to: string; text: string }> = [];
    const peers = world({ deliverFromSession: async (from, to, text) => { sent.push({ from: from.label, to, text }); return { delivered: true }; } });
    await startBuildReview(peers);
    peers.callers.set(700, { sessionId: "agent-9", label: "Chief of staff" });
    expect((await peers.desk.handle({ kind: "team-task", team: "build-review-1", task: "Ship it", callerPid: 700 })).kind).toBe("team-tasked");
    expect(sent).toEqual([{ from: "Chief of staff", to: "s-1", text: "New task for your team (build-review-1): Ship it" }]);
    // And every brief says to message rather than to end a turn with the report.
    expect(peers.starts[0]!.prompt).not.toContain("conch_transcript_tail");
    expect(readFileSync(teamBriefPath(peers.dir, "build-review-1", "lead-1"), "utf8")).toContain("conch message");
  });

  test("a team type rather than a running team starts a new team of it on the task", async () => {
    const w = world();
    const reply = await w.desk.handle({ kind: "team-task", team: "Design crit loop", task: "Tighten the empty state", cwd: "/work/app" });
    expect(reply).toMatchObject({ kind: "team-started", team: { id: "design-crit-1", task: "Tighten the empty state" } });
  });

  test("a lead that has ended can't be told; an unknown name lists what there is", async () => {
    const w = world();
    await startBuildReview(w);
    w.statuses.delete("s-1");
    w.desk.published();
    w.clock.now += MEMBER_GONE_MS;
    w.desk.published();
    expect(await w.desk.handle({ kind: "team-task", team: "build-review-1", task: "x" })).toMatchObject({ code: "refused", error: expect.stringContaining("lead isn't running") });
    expect(await w.desk.handle({ kind: "team-task", team: "nothing", task: "x" })).toMatchObject({ code: "refused", error: expect.stringContaining("Running: build-review-1") });
  });
});

describe("a team's life", () => {
  test("a member whose session has gone for a minute has ended; a team whose members have all ended ends", async () => {
    const w = world();
    await startBuildReview(w);
    w.statuses.delete("s-1");
    w.desk.published();
    w.clock.now += MEMBER_GONE_MS - 1;
    expect(w.desk.published()[0]!.members[0]!.state).toBe("running");
    w.clock.now += 1;
    // Ended; the team, a minute old, still settling: a start on its way is not an ending.
    expect(w.desk.published()[0]!.members[0]!.state).toBe("ended");
    // Two minutes old, every member ended: the team has too.
    w.clock.now += 60_000;
    expect(w.desk.published()).toEqual([]);
    expect(w.logs.some((line) => line.includes("every member has ended"))).toBe(true);
  });

  test("the lead or the user ends a team; its sessions stay; a member can't", async () => {
    const w = world();
    await startBuildReview(w);
    w.callers.set(100, { sessionId: "s-1", label: "Lead" });
    await w.desk.handle({ kind: "team-add", role: "builder", task: "one", callerPid: 100 });
    w.callers.set(200, { sessionId: "s-2", label: "Builder" });
    expect(await w.desk.handle({ kind: "team-end", team: "build-review-1", callerPid: 200 })).toMatchObject({ code: "refused", error: "only build-review-1's lead or the user can end it" });
    expect((await w.desk.handle({ kind: "team-end", team: "build-review-1", callerPid: 100 })).kind).toBe("teams");
    expect(w.desk.published()).toEqual([]);
    expect(w.desk.teamForSession("s-2")).toBeUndefined();
  });

  test("a daemon that restarts keeps its teams; a start it never saw through is said to have failed", async () => {
    const w = world({ outcome: (_r, n) => n === 1 ? { sessionId: "s-1" } : new Promise<TeamStartOutcome>(() => {}) });
    await w.desk.handle({ kind: "team-start", type: "research-spec-build", task: "Find a library", cwd: "/work/app" });
    await Bun.sleep(5);
    const next = world({}, w.dir);
    next.statuses.set("s-1", "waiting");
    expect(next.desk.published()[0]!.members.map((member) => [member.key, member.state, member.error])).toEqual([
      ["lead-1", "running", undefined],
      ["researcher-1", "failed", "conch restarted before it saw this member start"],
    ]);
    // The next team of the type takes the next number.
    expect(((await next.desk.handle({ kind: "team-start", type: "research-spec-build", task: "Again", cwd: "/work/app" })) as Extract<TeamReply, { kind: "team-started" }>).team.id).toBe("research-spec-build-2");
  });

  test("a saved file that doesn't parse is set aside, not trusted, and the starters stand in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-teams-"));
    writeFileSync(join(dir, "teams.json"), "{ not json");
    const w = world({}, dir);
    expect((await list(w)).types).toHaveLength(STARTER_TEAM_TYPES.length);
    expect(existsSync(join(dir, "teams.json"))).toBe(false);
  });
});

describe("through the daemon's own start (#601)", () => {
  test("each member's start passes the socket's own check and reaches the runtime's start, waited on, with its label", async () => {
    const reached: Array<Extract<RuntimeControlMessage, { kind: "session-start" }>> = [];
    const signed = structuredClone(STARTER_TEAM_TYPES[0]!);
    signed.roles[0] = { ...signed.roles[0]!, signIn: "Work Max", model: "claude-fable-5", permissions: "plan" };
    signed.roles[1] = { ...signed.roles[1]!, backend: "codex", effort: "xhigh", permissions: "workspace-write", atStart: true, host: "background" };
    const w = world({
      // As daemon.ts wires it: validated as any socket's start is, then the runtime's own dispatch, trust check and all.
      start: async (request) => {
        const checked = validateRuntimeControlMessage({ kind: "session-start", ...request, wait: true });
        if (!checked.ok) throw new Error(checked.err);
        const reply = await applyRuntimeControlMessage(checked.value, {
          listResumable: () => ({ sessions: [], complete: true }),
          folderTrusted: () => true,
          start: async (message) => {
            reached.push(message as never);
            return { sessionId: `s-${reached.length}`, label: (message as { label?: string }).label };
          },
          close: () => {},
          report: () => {},
        });
        if (reply.kind === "session-needs-trust") return { needsTrust: reply.cwd };
        if (reply.kind !== "session-started") throw new Error(reply.kind);
        return reply.sessionId ? { sessionId: reply.sessionId, ...(reply.label ? { label: reply.label } : {}) } : { running: reply.running ?? "" };
      },
    });
    await w.desk.handle({ kind: "team-type-save", type: signed, previousId: "build-review" });
    expect((await startBuildReview(w)).kind).toBe("team-started");
    expect(w.desk.published()[0]!.members.map((member) => [member.key, member.state, member.error])).toEqual([
      ["lead-1", "running", undefined],
      ["builder-1", "running", undefined],
    ]);
    expect(reached.map(({ prompt: _prompt, ...rest }) => rest)).toEqual([
      {
        kind: "session-start", backend: "claude", cwd: "/work/app", claudeSignInId: "abc-1",
        options: { model: "claude-fable-5", effort: "high", "permission-mode": "plan", "bypass-permissions": false },
        label: "Lead · Add a dark mode to Settings", wait: true,
      },
      {
        kind: "session-start", backend: "codex", host: "background", cwd: "/work/app",
        options: { "reasoning-effort": "xhigh", sandbox: "workspace-write", "bypass-permissions": false },
        label: "Builder · Add a dark mode to Settings", wait: true,
      },
    ]);
  });
});

describe("on the wire", () => {
  test("each kind is checked before the desk sees it", () => {
    expect(decodeTeamRequest({ kind: "something-else" })).toBeNull();
    expect(decodeTeamRequest({ kind: "teams", callerPid: 42, fromAgent: true })).toEqual({ kind: "teams", callerPid: 42, fromAgent: true });
    expect(decodeTeamRequest({ kind: "team-start", type: "build-review", task: "  Do it  ", cwd: "/work", trustFolder: true })).toEqual({
      kind: "team-start", type: "build-review", task: "Do it", cwd: "/work", trustFolder: true,
    });
    expect(decodeTeamRequest({ kind: "team-start", type: "x", task: "y", cwd: "relative" })).toEqual({ error: "cwd must be an absolute path" });
    expect(decodeTeamRequest({ kind: "team-start", type: "x", task: "" })).toEqual({ error: "the task is empty" });
    expect(decodeTeamRequest({ kind: "team-add", role: "builder", task: "x", callerPid: 1 })).toEqual({ error: "callerPid must be a process id" });
    expect(decodeTeamRequest({ kind: "team-type-save", type: [] })).toEqual({ error: "type must be a team type" });
    expect(decodeTeamRequest({ kind: "team-end" })).toEqual({ error: "team is missing" });
  });

  test("teams are the Mac's and its CLI's: a phone can't start one", () => {
    expect(isMacAppOnlyRequest({ kind: "team-start", type: "build-review", task: "x", cwd: "/work" })).toBe(true);
    expect(isMacAppOnlyRequest({ kind: "teams" })).toBe(true);
  });
});
