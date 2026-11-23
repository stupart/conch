import { describe, expect, test } from "bun:test";
import { START_PROMPT_MAX, startPromptError } from "../src/session-lifecycle.ts";
import {
  memberLabel,
  memberWorktree,
  reportsUpTo,
  roleStartOptions,
  slugify,
  STARTER_TEAM_TYPES,
  taskTitle,
  teamBrief,
  teamFirstMessage,
  teamTaskError,
  teamTree,
  validateTeamType,
  type TeamInstance,
  type TeamType,
} from "../src/teams.ts";

// 2026-11-12, Tyler: "would be nice to add 'teams' to conch settings to where we can set up team structures with
// specialized agents, rules for how they'll work together, and a hierarchy and then i can spin up or pass tasks to team
// types." The model: a team type's roles, hierarchy and rules, checked as Settings › Teams saves them, and the words a
// member is started with.

const lead = { id: "lead", name: "Lead", backend: "claude", prompt: "Plan it.", skills: [], workspace: "shared" } as const;
const builder = { id: "builder", name: "Builder", reportsTo: "lead", backend: "claude", prompt: "Build it.", skills: [], workspace: "worktree", maxConcurrent: 2 } as const;
const typeWith = (roles: unknown[], extra: Record<string, unknown> = {}) => ({ name: "Pair", summary: "", roles, rules: ["Nobody merges."], ...extra });

function team(type: TeamType, extra: Partial<TeamInstance> = {}): TeamInstance {
  return {
    id: `${type.id}-1`, typeId: type.id, name: type.name, task: "Add a dark mode to Settings", cwd: "/work/app",
    startedAt: 1, type, members: [], tasks: [], ...extra,
  };
}

describe("a team type, as Settings › Teams saves it", () => {
  test("conch's starter types are valid, each with one lead, and say nothing personal", () => {
    for (const type of STARTER_TEAM_TYPES) {
      const checked = validateTeamType(type);
      expect(checked).toEqual({ ok: true, value: type });
      expect(type.roles.filter((role) => !role.reportsTo)).toHaveLength(1);
      // Public repo: a starter speaks of "the user", never of anyone by name.
      expect(JSON.stringify(type)).not.toMatch(/Tyler|tyler|@[a-z]+\.[a-z]/);
    }
  });

  test("names, ids and choices are normalised; the lead always starts with the team", () => {
    const checked = validateTeamType(typeWith([{ ...lead, name: "  Lead  ", id: undefined }, { ...builder, effort: "high", host: "background" }]));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.id).toBe("pair");
    expect(checked.value.roles[0]).toEqual({ id: "lead", name: "Lead", backend: "claude", prompt: "Plan it.", skills: [], workspace: "shared", atStart: true });
    expect(checked.value.roles[1]).toMatchObject({ effort: "high", host: "background", maxConcurrent: 2, workspace: "worktree" });
  });

  test("a refusal names its field, so the editor can show it there", () => {
    const refuse = (value: unknown) => {
      const checked = validateTeamType(value);
      if (checked.ok) throw new Error("accepted");
      return { error: checked.error, field: checked.field };
    };
    expect(refuse(typeWith([lead, { ...builder, reportsTo: undefined }]))).toEqual({ error: "only one role leads; Lead and Builder report to no one", field: "roles" });
    expect(refuse(typeWith([{ ...lead, reportsTo: "builder" }, builder]))).toMatchObject({ field: "roles" });
    expect(refuse(typeWith([lead, { ...builder, reportsTo: "designer" }]))).toEqual({ error: `Builder reports to "designer", which isn't a role here`, field: "roles.1.reportsTo" });
    expect(refuse(typeWith([lead, { ...builder, id: "a", reportsTo: "b" }, { ...builder, id: "b", name: "B", reportsTo: "a" }]))).toEqual({
      error: "Builder's chain of reporting goes round in a loop", field: "roles.1.reportsTo",
    });
    expect(refuse(typeWith([lead, { ...builder, id: "lead" }]))).toEqual({ error: `two roles are called "lead"`, field: "roles.1.id" });
    expect(refuse(typeWith([lead, { ...builder, effort: "huge" }]))).toEqual({
      error: "Builder's effort for Claude Code is one of low, medium, high, xhigh, max", field: "roles.1.effort",
    });
    expect(refuse(typeWith([lead, { ...builder, backend: "codex", signIn: "Work" }]))).toEqual({ error: "Builder is a Codex role: a sign-in is for Claude", field: "roles.1.signIn" });
    expect(refuse(typeWith([lead, { ...builder, maxConcurrent: 20 }]))).toEqual({ error: "Builder runs 1 to 8 at once", field: "roles.1.maxConcurrent" });
    expect(refuse(typeWith([lead], { name: "" }))).toEqual({ error: "name can't be empty", field: "name" });
    expect(refuse(typeWith([lead], { rules: ["ok", 3] }))).toEqual({ error: "rule 2 must be text", field: "rules.1" });
    expect(refuse(typeWith([]))).toEqual({ error: "a team needs at least one role, its lead", field: "roles" });
  });

  test("a role's start options: model and effort as the agent spells them; its own permissions turn conch's bypass off", () => {
    expect(roleStartOptions({ ...builder, skills: [], model: "opus", effort: "high" })).toEqual({ model: "opus", effort: "high" });
    expect(roleStartOptions({ ...builder, skills: [], permissions: "plan" })).toEqual({ "permission-mode": "plan", "bypass-permissions": false });
    expect(roleStartOptions({ ...builder, skills: [], backend: "codex", effort: "xhigh", permissions: "workspace-write" }))
      .toEqual({ "reasoning-effort": "xhigh", sandbox: "workspace-write", "bypass-permissions": false });
  });

  test("slugs, tasks and labels", () => {
    expect(slugify("Build + review")).toBe("build-review");
    expect(slugify("Research → spec → build")).toBe("research-spec-build");
    expect(slugify("Café crit")).toBe("cafe-crit");
    expect(teamTaskError("  ")).toBe("the task is empty");
    expect(teamTaskError("a".repeat(4_001))).toBe("the task is 4001 characters; the most is 4000");
    expect(teamTaskError("two\nlines")).toBeUndefined();
    expect(taskTitle("Add a dark mode to Settings, and fix the toggle.")).toBe("Add a dark mode to Settings…");
    expect(taskTitle("Fix the build.")).toBe("Fix the build");
    expect(memberLabel({ name: "Builder" }, 2, "Fix the build")).toBe("Builder 2 · Fix the build");
    expect(memberLabel({ name: "Lead" }, 1, "Fix the build")).toBe("Lead · Fix the build");
  });
});

describe("the hierarchy", () => {
  const deep = validateTeamType(typeWith([
    lead,
    { ...builder, id: "manager", name: "Manager", maxConcurrent: undefined, workspace: "shared" },
    { ...builder, reportsTo: "manager" },
    { ...builder, id: "reviewer", name: "Reviewer" },
  ]));
  if (!deep.ok) throw new Error(deep.error);

  test("the tree is the lead, then each role under the one it reports to", () => {
    expect(teamTree(deep.value).map(({ role, depth }) => `${depth}:${role.id}`)).toEqual(["0:lead", "1:manager", "2:builder", "1:reviewer"]);
  });

  test("a member may ask for the roles below its own, all the way down, and no others", () => {
    expect(reportsUpTo(deep.value, "builder", "lead")).toBe(true);
    expect(reportsUpTo(deep.value, "builder", "manager")).toBe(true);
    expect(reportsUpTo(deep.value, "reviewer", "manager")).toBe(false);
    expect(reportsUpTo(deep.value, "lead", "builder")).toBe(false);
  });
});

describe("what a member is told", () => {
  const type = STARTER_TEAM_TYPES[0]!;
  const running = team(type, {
    members: [
      { key: "lead-1", roleId: "lead", roleName: "Lead", label: "Lead · Add a dark mode to Settings", state: "running", sessionId: "s-lead", startedAt: 1 },
      { key: "builder-1", roleId: "builder", roleName: "Builder", label: "Builder · Toggle", state: "starting", startedAt: 2, reportsTo: "lead-1", task: "Build the toggle" },
    ],
  });
  const builderMember = running.members[1]!;
  const leadMember = running.members[0]!;
  const context = (member = builderMember, peerMessages = false) => ({ team: running, member, messaging: { peerMessages }, briefPath: "/config/teams/build-review-1/builder-1.md" });

  test("a builder works in its own worktree and may neither ask for members nor end the team; the lead may do both", () => {
    const brief = teamBrief(context());
    const { folder, branch } = memberWorktree(running, builderMember);
    expect(folder).toBe(".worktrees/build-review-1-builder-1");
    expect(brief).toContain(`\`git worktree add ${folder} -b ${branch}\``);
    expect(brief).not.toContain("conch team add");
    expect(brief).not.toContain("conch team end");
    expect(teamBrief(context(leadMember))).toContain("`conch team end build-review-1`");
  });

  test("with peer messages members report by conch message; without them, by ending the turn", () => {
    expect(teamBrief(context())).not.toContain("conch message");
    expect(teamBrief(context(builderMember, true))).toContain("conch message");
  });

  test("the first message is one valid start line carrying the task and where the whole brief is", () => {
    const message = teamFirstMessage(context());
    expect(startPromptError({ prompt: message })).toBeUndefined();
    expect(message).toContain("Your task: Build the toggle");
    expect(message).toContain("`conch team brief build-review-1 builder-1`");
  });

  test("past 2,000 characters the role and rules are cut, never the start of the task, and it says to read the brief first", () => {
    const long = team({ ...type, rules: Array.from({ length: 12 }, (_, n) => `Rule ${n} ${"x ".repeat(200)}`) }, { members: running.members, task: `- ${"word ".repeat(900)}` });
    const message = teamFirstMessage({ ...context(), team: long, member: { ...builderMember, task: undefined } });
    expect(message.length).toBeLessThanOrEqual(START_PROMPT_MAX);
    expect(startPromptError({ prompt: message })).toBeUndefined();
    expect(message).toContain("Your task: - word word");
    expect(message).toContain("Read your full brief first: `conch team brief build-review-1 builder-1`");
  });
});
