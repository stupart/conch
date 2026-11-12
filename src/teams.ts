import { adapterFor, BYPASS_OPTION, type SessionBackend } from "./agent-adapter.ts";
import { START_PROMPT_MAX } from "./session-lifecycle.ts";

/**
 * Teams: a team type is a set of roles in a hierarchy with plain-language rules for working together; a team is one
 * running for a task, its members conch's own sessions (team-desk.ts runs them, team-cli.ts is `conch team`).
 *
 * Tyler, 2026-11-12: "would be nice to add 'teams' to conch settings to where we can set up team structures with
 * specialized agents, rules for how they'll work together, and a hierarchy and then i can spin up or pass tasks to team
 * types." The first step of his 2026-10-16 direction, a central conch agent that routes work, where "a roles system may
 * form, with agent types per project and a hierarchy".
 *
 * A role says who the agent is (Claude or Codex, model, effort, the sign-in it runs on, its permissions), what it is told
 * (a prompt, skills, where it works), its limits (how many at once, a time budget) and whom it reports to. The rules are
 * words conch hands every member in its brief: conch enforces only what it can see (who may ask for whom, how many run
 * at once), and the agents keep the rest.
 *
 * This module is pure: the model, its validation, the starter types and the words a member is started with.
 */

// MARK: the model

export type TeamWorkspace = "shared" | "worktree";
export type TeamHost = "terminal" | "background";

export interface TeamRole {
  /** A slug, unique in its type: `builder`. Member keys and branch names are made from it. */
  id: string;
  name: string;
  /** The role this one reports to. Exactly one role has none: the lead. */
  reportsTo?: string;
  backend: SessionBackend;
  model?: string;
  /** The agent's own effort choice (Claude's `--effort`, Codex's reasoning effort). */
  effort?: string;
  /** Claude only: one of conch's Claude sign-ins (claude-session-sign-ins.ts), by label or id. Default's rotating login when absent. */
  signIn?: string;
  /** Claude's permission mode, or Codex's sandbox (`teamAgentChoices`). Absent: conch's own default. */
  permissions?: string;
  /** Absent is a Terminal window, as `conch_start`'s default. */
  host?: TeamHost;
  prompt: string;
  skills: string[];
  /** `worktree`: the member works in a git worktree and branch of its own (its brief names them). */
  workspace: TeamWorkspace;
  /** How many of this role may be working at once. Absent is one. */
  maxConcurrent?: number;
  /** How long a member of this role should take, in its brief and in `conch team members`. Not enforced. */
  budgetMinutes?: number;
  /** Started with the team, not only when asked for. The lead always is. */
  atStart?: boolean;
}

export interface TeamType {
  /** A slug: `build-review`. A running team's id is made from it. */
  id: string;
  name: string;
  summary: string;
  roles: TeamRole[];
  /** How the team works together, one plain-language rule each, handed to every member in its brief. */
  rules: string[];
}

export const TEAM_LIMITS = {
  typeName: 60,
  summary: 300,
  roles: 8,
  roleName: 40,
  slug: 32,
  prompt: 4_000,
  skills: 12,
  skill: 64,
  rules: 12,
  rule: 500,
  maxConcurrent: 8,
  budgetMinutes: { min: 5, max: 1_440 },
  /** A task, as Tyler or a lead writes it. A member's first message carries as much of it as fits; its brief all of it. */
  task: 4_000,
} as const;

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const VALUE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;

/** A name as a slug: lower case, words joined by dashes, at most `max`. Empty when nothing in it is a letter or digit. */
export function slugify(name: string, max: number = TEAM_LIMITS.slug): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/\+/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
}

/** What each agent offers a role, from its own start options (agent-adapter.ts): its efforts and its permissions. */
export interface TeamAgentChoices {
  efforts: readonly string[];
  permissions: readonly string[];
  /** The start option a role's `permissions` sets: Claude's `permission-mode`, Codex's `sandbox`. */
  permissionsOption: string;
  effortOption?: string;
}

export function teamAgentChoices(backend: SessionBackend): TeamAgentChoices {
  const adapter = adapterFor(backend);
  const effort = adapter.startOptions.find((option) => /(^|-)effort$/.test(option.name));
  const permissionsOption = backend === "claude" ? "permission-mode" : "sandbox";
  const permissions = adapter.startOptions.find((option) => option.name === permissionsOption);
  return {
    efforts: effort?.choices ?? [],
    permissions: permissions?.choices ?? [],
    permissionsOption,
    ...(effort ? { effortOption: effort.name } : {}),
  };
}

/**
 * A role's start options, as `session-start` takes them. A role that names its permissions turns conch's bypass off for
 * its members: the setting's bypass would otherwise override a Claude permission mode, and Codex refuses a sandbox beside
 * it (session-lifecycle.ts `conflictingOptionsError`).
 */
export function roleStartOptions(role: TeamRole): Record<string, string | boolean> {
  const choices = teamAgentChoices(role.backend);
  const options: Record<string, string | boolean> = {};
  if (role.model) options.model = role.model;
  if (role.effort && choices.effortOption) options[choices.effortOption] = role.effort;
  if (role.permissions) {
    options[choices.permissionsOption] = role.permissions;
    options[BYPASS_OPTION] = false;
  }
  return options;
}

// MARK: validation

export type TeamTypeCheck = { ok: true; value: TeamType } | { ok: false; error: string; field?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, field: string, max: number, options: { required?: boolean; multiline?: boolean } = {}): string | { error: string; field: string } {
  if (value === undefined || value === null || value === "") {
    return options.required ? { error: `${field} can't be empty`, field } : "";
  }
  if (typeof value !== "string") return { error: `${field} must be text`, field };
  const trimmed = value.trim();
  if (options.required && !trimmed) return { error: `${field} can't be empty`, field };
  if (trimmed.length > max) return { error: `${field} is ${trimmed.length} characters; the most is ${max}`, field };
  if (options.multiline ? CONTROL.test(trimmed) : /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { error: `${field} has control characters in it`, field };
  }
  return trimmed;
}

/**
 * A team type as Settings › Teams saves it, checked and normalised: names trimmed, slugs valid and unique, one lead, every
 * `reportsTo` another role, no loop, agents' choices their own. A refusal names its field (`roles.1.reportsTo`), so the
 * editor can show it there.
 */
export function validateTeamType(value: unknown): TeamTypeCheck {
  if (!isRecord(value)) return { ok: false, error: "a team type is an object" };
  const fail = (error: string, field?: string): TeamTypeCheck => ({ ok: false, error, ...(field ? { field } : {}) });
  const name = text(value.name, "name", TEAM_LIMITS.typeName, { required: true });
  if (typeof name !== "string") return fail(name.error, name.field);
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : slugify(name);
  if (!SLUG.test(id) || id.length > 40) return fail("id must be lower-case letters, digits and dashes", "id");
  const summary = text(value.summary, "summary", TEAM_LIMITS.summary, { multiline: true });
  if (typeof summary !== "string") return fail(summary.error, summary.field);
  if (!Array.isArray(value.roles) || value.roles.length === 0) return fail("a team needs at least one role, its lead", "roles");
  if (value.roles.length > TEAM_LIMITS.roles) return fail(`a team has at most ${TEAM_LIMITS.roles} roles`, "roles");
  const roles: TeamRole[] = [];
  for (const [index, raw] of value.roles.entries()) {
    const role = validateRole(raw, `roles.${index}`);
    if ("error" in role) return fail(role.error, role.field);
    if (roles.some((other) => other.id === role.id)) return fail(`two roles are called "${role.id}"`, `roles.${index}.id`);
    roles.push(role);
  }
  const leads = roles.filter((role) => !role.reportsTo);
  if (leads.length !== 1) {
    return fail(leads.length ? `only one role leads; ${leads.map((role) => role.name).join(" and ")} report to no one` : "one role must lead: it reports to no one", "roles");
  }
  for (const [index, role] of roles.entries()) {
    if (role.reportsTo === undefined) continue;
    if (role.reportsTo === role.id) return fail(`${role.name} can't report to itself`, `roles.${index}.reportsTo`);
    if (!roles.some((other) => other.id === role.reportsTo)) return fail(`${role.name} reports to "${role.reportsTo}", which isn't a role here`, `roles.${index}.reportsTo`);
    // Up the chain from here: a loop never reaches the lead.
    const seen = new Set([role.id]);
    let up = roles.find((other) => other.id === role.reportsTo);
    while (up?.reportsTo) {
      if (seen.has(up.id)) return fail(`${role.name}'s chain of reporting goes round in a loop`, `roles.${index}.reportsTo`);
      seen.add(up.id);
      up = roles.find((other) => other.id === up!.reportsTo);
    }
  }
  // The lead is the team: it always starts with it.
  for (const role of roles) if (!role.reportsTo) role.atStart = true;
  if (value.rules !== undefined && !Array.isArray(value.rules)) return fail("rules is a list", "rules");
  const rules: string[] = [];
  for (const [index, raw] of ((value.rules as unknown[] | undefined) ?? []).entries()) {
    const rule = text(raw, `rule ${index + 1}`, TEAM_LIMITS.rule, { multiline: true });
    if (typeof rule !== "string") return fail(rule.error, `rules.${index}`);
    if (rule) rules.push(rule);
  }
  if (rules.length > TEAM_LIMITS.rules) return fail(`a team has at most ${TEAM_LIMITS.rules} rules`, "rules");
  return { ok: true, value: { id, name, summary, roles, rules } };
}

function validateRole(raw: unknown, at: string): TeamRole | { error: string; field: string } {
  if (!isRecord(raw)) return { error: "a role is an object", field: at };
  const name = text(raw.name, "a role's name", TEAM_LIMITS.roleName, { required: true });
  if (typeof name !== "string") return { error: name.error, field: `${at}.name` };
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : slugify(name);
  if (!SLUG.test(id) || id.length > TEAM_LIMITS.slug) return { error: `${name}'s id must be lower-case letters, digits and dashes`, field: `${at}.id` };
  const backend = raw.backend ?? "claude";
  if (backend !== "claude" && backend !== "codex") return { error: `${name}'s agent is claude or codex`, field: `${at}.backend` };
  const choices = teamAgentChoices(backend);
  const role: TeamRole = { id, name, backend, prompt: "", skills: [], workspace: "shared" };
  if (raw.reportsTo !== undefined && raw.reportsTo !== null && raw.reportsTo !== "") {
    if (typeof raw.reportsTo !== "string") return { error: `${name}'s reportsTo is a role's id`, field: `${at}.reportsTo` };
    role.reportsTo = raw.reportsTo.trim();
  }
  for (const key of ["model", "effort", "signIn", "permissions"] as const) {
    const value = text(raw[key], `${name}'s ${key}`, 80);
    if (typeof value !== "string") return { error: value.error, field: `${at}.${key}` };
    if (!value) continue;
    if ((key === "model") && !VALUE.test(value)) return { error: `${name}'s model is a name like "opus" or "claude-fable-5"`, field: `${at}.model` };
    if (key === "effort" && !choices.efforts.includes(value)) {
      return { error: `${name}'s effort for ${adapterFor(backend).displayName} is one of ${choices.efforts.join(", ")}`, field: `${at}.effort` };
    }
    if (key === "permissions" && !choices.permissions.includes(value)) {
      return { error: `${name}'s permissions for ${adapterFor(backend).displayName} are one of ${choices.permissions.join(", ")}`, field: `${at}.permissions` };
    }
    if (key === "signIn" && backend !== "claude") return { error: `${name} is a Codex role: a sign-in is for Claude`, field: `${at}.signIn` };
    role[key] = value;
  }
  if (raw.host !== undefined && raw.host !== null) {
    if (raw.host !== "terminal" && raw.host !== "background") return { error: `${name}'s host is terminal or background`, field: `${at}.host` };
    if (raw.host === "background") role.host = "background";
  }
  const prompt = text(raw.prompt, `${name}'s prompt`, TEAM_LIMITS.prompt, { multiline: true });
  if (typeof prompt !== "string") return { error: prompt.error, field: `${at}.prompt` };
  role.prompt = prompt;
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills)) return { error: `${name}'s skills are a list`, field: `${at}.skills` };
    for (const skill of raw.skills) {
      const value = text(skill, `${name}'s skill`, TEAM_LIMITS.skill);
      if (typeof value !== "string") return { error: value.error, field: `${at}.skills` };
      if (value && !role.skills.includes(value)) role.skills.push(value);
    }
    if (role.skills.length > TEAM_LIMITS.skills) return { error: `${name} has at most ${TEAM_LIMITS.skills} skills`, field: `${at}.skills` };
  }
  if (raw.workspace !== undefined && raw.workspace !== "shared" && raw.workspace !== "worktree") {
    return { error: `${name} works in the team's folder (shared) or its own worktree (worktree)`, field: `${at}.workspace` };
  }
  if (raw.workspace === "worktree") role.workspace = "worktree";
  if (raw.maxConcurrent !== undefined && raw.maxConcurrent !== null) {
    if (!Number.isInteger(raw.maxConcurrent) || (raw.maxConcurrent as number) < 1 || (raw.maxConcurrent as number) > TEAM_LIMITS.maxConcurrent) {
      return { error: `${name} runs 1 to ${TEAM_LIMITS.maxConcurrent} at once`, field: `${at}.maxConcurrent` };
    }
    if (raw.maxConcurrent !== 1) role.maxConcurrent = raw.maxConcurrent as number;
  }
  if (raw.budgetMinutes !== undefined && raw.budgetMinutes !== null) {
    const { min, max } = TEAM_LIMITS.budgetMinutes;
    if (!Number.isInteger(raw.budgetMinutes) || (raw.budgetMinutes as number) < min || (raw.budgetMinutes as number) > max) {
      return { error: `${name}'s budget is ${min} to ${max} minutes`, field: `${at}.budgetMinutes` };
    }
    role.budgetMinutes = raw.budgetMinutes as number;
  }
  if (raw.atStart === true) role.atStart = true;
  else if (raw.atStart !== undefined && raw.atStart !== false) return { error: `${name}'s atStart is true or false`, field: `${at}.atStart` };
  return role;
}

/** A task as a team takes it: trimmed, not empty, at most `TEAM_LIMITS.task`, newlines allowed. */
export function teamTaskError(task: unknown): string | undefined {
  if (typeof task !== "string" || !task.trim()) return "the task is empty";
  if (task.trim().length > TEAM_LIMITS.task) return `the task is ${task.trim().length} characters; the most is ${TEAM_LIMITS.task}`;
  if (CONTROL.test(task)) return "the task has control characters in it";
}

// MARK: the hierarchy

export function leadRole(type: Pick<TeamType, "roles">): TeamRole {
  return type.roles.find((role) => !role.reportsTo) ?? type.roles[0]!;
}

/** The roles in the order of the tree, each with its depth under the lead: the order briefs and lists show them in. */
export function teamTree(type: Pick<TeamType, "roles">): Array<{ role: TeamRole; depth: number }> {
  const out: Array<{ role: TeamRole; depth: number }> = [];
  const placed = new Set<string>();
  const place = (role: TeamRole, depth: number) => {
    if (placed.has(role.id)) return;
    placed.add(role.id);
    out.push({ role, depth });
    for (const child of type.roles.filter((other) => other.reportsTo === role.id)) place(child, depth + 1);
  };
  place(leadRole(type), 0);
  // A saved type has no orphans; a role a validation never saw still shows, at the top.
  for (const role of type.roles) place(role, 0);
  return out;
}

/** Whether `ancestor` is above `role` in the tree: whom a member may ask conch for. */
export function reportsUpTo(type: Pick<TeamType, "roles">, role: string, ancestor: string): boolean {
  const seen = new Set<string>();
  let up = type.roles.find((other) => other.id === role)?.reportsTo;
  while (up && !seen.has(up)) {
    if (up === ancestor) return true;
    seen.add(up);
    up = type.roles.find((other) => other.id === up)?.reportsTo;
  }
  return false;
}

// MARK: the starter types

/**
 * The team types conch ships, from how Tyler works (2026-11-12): a lead that plans and splits the work so no two parts
 * edit the same files, builders isolated in worktrees each opening a PR, an independent reviewer or critic that reads
 * the result rather than the builder's account of it, evidence before anything is called done, his own words quoted
 * rather than paraphrased, and merging left to him. Settings › Teams edits, duplicates and deletes them like any other;
 * `team-types-restore` puts back one that was deleted.
 */
export const STARTER_TEAM_TYPES: readonly TeamType[] = [
  {
    id: "build-review",
    name: "Build + review",
    summary: "The lead splits the task into parts that don't touch the same files, builders each build one in a worktree of their own and open a PR, and a reviewer reviews every PR. Nobody merges.",
    roles: [
      {
        id: "lead",
        name: "Lead",
        backend: "claude",
        effort: "high",
        prompt: "You plan and coordinate; you don't write the code yourself. Read the task and the code it touches, then split it into parts small enough to review, where no two parts edit the same files. Ask conch for one builder per part, each with a brief that stands on its own: what to change, where, how to check it, and the user's own words where they matter. As builders report, send each PR to the reviewer and send fixes back to its builder. Keep a list of every part and where it stands (not started, building, in review, ready), and finish with that list and the PR links.",
        skills: [],
        workspace: "shared",
        atStart: true,
      },
      {
        id: "builder",
        name: "Builder",
        reportsTo: "lead",
        backend: "claude",
        prompt: "You build one part of the task, in a worktree and branch of your own. Read the code before changing it, and follow the repository's own conventions and instructions. Fix causes, not symptoms. Run the tests that cover what you changed, commit with a message that says why, push, and open a PR. Report to your lead with the PR link, what you checked and how, and anything you were unsure of.",
        skills: [],
        workspace: "worktree",
        maxConcurrent: 3,
      },
      {
        id: "reviewer",
        name: "Reviewer",
        reportsTo: "lead",
        backend: "claude",
        effort: "high",
        prompt: "You review each PR your lead sends you, with fresh eyes: read the diff and the code around it, not the builder's account of it. Check that it does what its part asked, look for bugs, missing tests and anything against the repository's conventions, and run its tests where you can. Report a verdict (approve, or changes needed) and your findings ranked by how much they matter, each pointing at a file and line. You only read: never push to a builder's branch.",
        skills: ["code-review"],
        workspace: "shared",
      },
    ],
    rules: [
      "The lead plans and delegates; the members do the work and report back to whoever they report to.",
      "Each builder works in a git worktree and branch of its own, and opens a PR for its part.",
      "Every PR is reviewed by the reviewer before anyone calls it ready.",
      "Nobody merges. Merging is the user's decision.",
      "Claims need evidence: a test run, a command's output, or a screenshot you opened. Never call something done on another member's word alone.",
      "If two parts turn out to touch the same files, stop and tell the lead before going on.",
    ],
  },
  {
    id: "research-spec-build",
    name: "Research → spec → build",
    summary: "A researcher gathers the evidence and the options, the lead turns them into a short spec and shows it to you before anything is built, then builders build from the spec.",
    roles: [
      {
        id: "lead",
        name: "Lead",
        backend: "claude",
        effort: "high",
        prompt: "You own the spec. Give the researcher the open questions, read what it finds, and write a short spec: the goal, what is in and out, the approach and why, how it will be checked, and the decisions still open. Publish the spec for the user to read, and wait for their go-ahead before asking conch for builders. Then give each builder one part of the spec, and keep the spec current as decisions change.",
        skills: [],
        workspace: "shared",
        atStart: true,
      },
      {
        id: "researcher",
        name: "Researcher",
        reportsTo: "lead",
        backend: "claude",
        prompt: "You find things out before anything is built. Look at the sources themselves (the code, the docs, the pages, the data) rather than answering from memory, and note where each fact came from. Compare two or three options with their trade-offs and recommend one. Report to your lead with your findings, their sources and the questions still open. You don't change code.",
        skills: [],
        workspace: "shared",
        atStart: true,
      },
      {
        id: "builder",
        name: "Builder",
        reportsTo: "lead",
        backend: "claude",
        prompt: "You build one part of the spec, in a worktree and branch of your own. If the spec turns out to be wrong or unclear, ask your lead rather than guessing. Run the tests that cover your change, open a PR, and report what you built, how you checked it, and where it differs from the spec.",
        skills: [],
        workspace: "worktree",
        maxConcurrent: 2,
      },
    ],
    rules: [
      "Research first, then a spec, then building. Nothing is built before the user has seen the spec.",
      "Quote the user's own words to every member rather than paraphrasing them.",
      "Every fact carries its source. Say what was checked and what is assumed.",
      "Builders work in worktrees of their own and open PRs. Nobody merges.",
    ],
  },
  {
    id: "design-crit",
    name: "Design crit loop",
    summary: "A designer builds the UI, a fresh critic each round ranks what to fix from screenshots of the real build, and the designer fixes and re-shoots until the critic passes it or three rounds are up.",
    roles: [
      {
        id: "designer",
        name: "Designer",
        backend: "claude",
        effort: "high",
        prompt: "You lead the loop and do the building. Screenshot every surface and state the task touches from the real, running build, at the sizes it ships at, and open each one yourself. Each round, ask conch for a critic with the screenshots' folder and what to judge against. Fix what it ranks highest first, re-shoot the same states, and compare before and after so nothing that was good got worse. Stop when the critic finds nothing high or medium, or after three rounds, and publish a before-and-after with a plain changelog.",
        skills: [],
        workspace: "shared",
        atStart: true,
      },
      {
        id: "critic",
        name: "Critic",
        reportsTo: "designer",
        backend: "claude",
        effort: "high",
        prompt: "You are the independent critic for one round. Open every screenshot you are given and judge it against the brief and the bar of a top design studio, not against how it was made. Return a verdict and a ranked list of fixes (high, medium, low), each citing the screenshot it is seen in, and from the second round on, anything that got worse. You only read: no edits, no dev servers.",
        skills: [],
        workspace: "shared",
        budgetMinutes: 30,
      },
    ],
    rules: [
      "Every claim about the UI rests on a screenshot of the current build, opened in this round.",
      "The critic is fresh each round and never edits; the designer fixes.",
      "Fix causes; never hide a problem by hiding, clipping or moving what is wrong.",
      "Stop the dev servers you started, and only those.",
      "Nobody merges. Merging is the user's decision.",
    ],
  },
];

// MARK: a running team

export type TeamMemberState = "starting" | "running" | "failed" | "ended";

export interface TeamMember {
  /** `lead-1`, `builder-2`: unique in the team, and what `conch team brief` names. */
  key: string;
  roleId: string;
  roleName: string;
  label: string;
  /** Once conch has seen it running. */
  sessionId?: string;
  state: TeamMemberState;
  /** Why it failed to start. */
  error?: string;
  /** Where it runs when conch couldn't see it as a session yet: "Terminal (ttys012)". */
  running?: string;
  startedAt: number;
  /** The member it reports to, by key. */
  reportsTo?: string;
  /** The task it was started on, when not the team's. */
  task?: string;
  /** Its role's time budget, carried so a list can say how far into it a member is. */
  budgetMinutes?: number;
  /** On the wire only: its session's status in conch now (working, waiting, needs you). Never saved. */
  status?: "working" | "waiting" | "needs";
}

export interface TeamTask {
  text: string;
  at: number;
  /** "you", or the label of the session that passed it. */
  from: string;
}

export interface TeamInstance {
  /** `build-review-2`: the type's id and how many of it there have been. */
  id: string;
  typeId: string;
  name: string;
  task: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  /** The type as it was when the team started: editing or deleting it later changes nothing for a team at work. */
  type: TeamType;
  members: TeamMember[];
  tasks: TeamTask[];
  /** The start was told to trust its folder; members asked for later are started the same way. */
  trustFolder?: true;
}

/** A team on the wire (the sessions file, the socket's replies): everything but the type it was started from. */
export type TeamSummary = Omit<TeamInstance, "type" | "trustFolder">;

/** A team for the wire, each member with its session's status now when `status` can say. */
export function teamSummary(team: TeamInstance, status?: (sessionId: string) => TeamMember["status"] | undefined): TeamSummary {
  const { type: _type, trustFolder: _trust, ...summary } = team;
  const copy = structuredClone(summary);
  if (status) {
    for (const member of copy.members) {
      const now = member.sessionId && member.state === "running" ? status(member.sessionId) : undefined;
      if (now) member.status = now;
    }
  }
  return copy;
}

/** A short title from the task, for members' labels: its first words, up to 28 characters. */
export function taskTitle(task: string): string {
  const line = task.trim().split("\n")[0]!.replace(/\s+/g, " ").replace(/[.:;,!?]+$/, "");
  if (line.length <= 28) return line;
  // Whole words while they fit; one long first word is cut.
  let title = "";
  for (const word of line.split(" ")) {
    if ((title ? `${title} ${word}` : word).length > 28) break;
    title = title ? `${title} ${word}` : word;
  }
  return `${(title || line.slice(0, 27)).replace(/[\s.,;:-]+$/, "")}…`;
}

/** A member's label: its role, numbered past the first, and the task's title, e.g. "Builder 2 · Dark mode for Settings". */
export function memberLabel(role: Pick<TeamRole, "name">, number: number, task: string): string {
  return `${role.name}${number > 1 ? ` ${number}` : ""} · ${taskTitle(task)}`.slice(0, 80);
}

// MARK: what a member is told

/**
 * How members reach each other. 2026-11-12: `conch message` (feat/peer-messages) is coming and isn't on this branch, so
 * a brief can't rely on it yet: a member reports by ending its turn with the report, and whoever it reports to reads it
 * with conch's transcript tools. When peer messages land, the daemon passes `peerMessages: true` and every brief says to
 * message instead; this is the one place that changes.
 */
export interface TeamMessaging {
  peerMessages: boolean;
}

/** `leads`: it has roles below it to read reports from. `top`: it reports to the user, in its own replies. */
function messagingLines(messaging: TeamMessaging, leads: boolean, top: boolean): string[] {
  const own = top ? ["You report to the user in your own replies, as any session does."] : [];
  if (messaging.peerMessages) {
    return [
      ...own,
      `Reach a teammate with \`conch message <their session id> "<text>"\`; \`conch team members\` lists them.${top ? "" : " Report to whoever you report to that way."} Answer messages that way too.`,
    ];
  }
  return [
    ...(top ? own : ["Report by ending your turn with the report itself, addressed to whoever you report to: they read your latest reply with conch's `conch_transcript_tail` tool (your session id, wait: 30)."]),
    ...(leads ? ["Read a member's report with `conch_transcript_tail` (its session id, wait: 30, passing back the cursor) until its status is waiting: `conch team members` gives each one's session id and whether it is working or waiting."] : []),
  ];
}

export interface BriefContext {
  team: TeamInstance;
  member: TeamMember;
  messaging: TeamMessaging;
  /** Where the brief is kept, said in the first message. */
  briefPath: string;
}

/** The worktree and branch a member in a `worktree` role is told to use: made from the team's id and its own key. */
export function memberWorktree(team: Pick<TeamInstance, "id">, member: Pick<TeamMember, "key">): { folder: string; branch: string } {
  return { folder: `.worktrees/${team.id}-${member.key}`, branch: `team/${team.id}/${member.key}` };
}

/** The roles a member may ask conch for: those below its own. */
function rolesBelow(type: TeamType, roleId: string): TeamRole[] {
  return type.roles.filter((role) => reportsUpTo(type, role.id, roleId));
}

/**
 * A member's brief, as Markdown: who it is on the team, whom it reports to, its task, its role's words, the team's tree
 * and rules, and the conch commands it works with. Written beside the team's other briefs and printed by
 * `conch team brief`; the first message carries as much of it as fits.
 */
export function teamBrief({ team, member, messaging }: BriefContext): string {
  const role = team.type.roles.find((one) => one.id === member.roleId)!;
  const above = member.reportsTo ? team.members.find((one) => one.key === member.reportsTo) : undefined;
  const below = rolesBelow(team.type, role.id);
  const lines: string[] = [
    `# ${team.name}: ${member.label}`,
    "",
    `You are the ${role.name.toLowerCase()} (${member.key}) on a conch team, "${team.name}" (team ${team.id}), working in ${team.cwd}.`,
    above
      ? `You report to the ${above.roleName.toLowerCase()}, "${above.label}" (${above.key}${above.sessionId ? `, session ${above.sessionId}` : ""}).`
      : !role.reportsTo ? "You lead this team: you report to the user." : `You report to the ${team.type.roles.find((one) => one.id === role.reportsTo)?.name.toLowerCase() ?? "lead"}.`,
    "",
    "## Your task",
    "",
    (member.task ?? team.task).trim(),
  ];
  if (member.task && member.task.trim() !== team.task.trim()) lines.push("", `The team's task: ${team.task.trim()}`);
  lines.push("", "## Your role", "");
  if (role.prompt) lines.push(role.prompt, "");
  if (role.skills.length) lines.push(`Skills to use: ${role.skills.join(", ")}.`);
  if (role.workspace === "worktree") {
    const { folder, branch } = memberWorktree(team, member);
    lines.push(`Work in a git worktree and branch of your own: from the repository, \`git worktree add ${folder} -b ${branch}\`, then do all your work there and tell conch with \`conch_working_folders\`.`);
  } else {
    lines.push(`Work in the team's folder, ${team.cwd}.`);
  }
  if (role.budgetMinutes) lines.push(`Take about ${role.budgetMinutes} minutes. If it will take longer, say so in your report.`);
  lines.push("", "## The team", "");
  for (const { role: one, depth } of teamTree(team.type)) {
    const limit = (one.maxConcurrent ?? 1) > 1 ? ` (up to ${one.maxConcurrent} at once)` : "";
    const who = team.members.filter((m) => m.roleId === one.id && m.state !== "failed").map((m) => m.key === member.key ? `${m.key}, you` : m.key);
    lines.push(`${"  ".repeat(depth)}- ${one.name}${limit}${who.length ? `: ${who.join(", ")}` : ""}`);
  }
  if (team.type.rules.length) {
    lines.push("", "## How the team works", "");
    team.type.rules.forEach((rule, index) => lines.push(`${index + 1}. ${rule}`));
  }
  lines.push("", "## Working with conch", "");
  lines.push(`- \`conch team members ${team.id}\`: who is on the team, with their session ids and whether each is working or waiting.`);
  if (below.length) {
    lines.push(
      `- \`conch team add <role> "<task>"\`: ask conch for a member, started with this brief's rules and its own task. You can ask for ${below.map((one) => `${one.id}${(one.maxConcurrent ?? 1) > 1 ? ` (up to ${one.maxConcurrent} working at once)` : ""}`).join(", ")}. Ask conch rather than starting subagents conch can't see.`,
    );
  }
  for (const line of messagingLines(messaging, below.length > 0, !role.reportsTo)) lines.push(`- ${line}`);
  lines.push(`- \`conch team brief ${team.id} ${member.key}\`: this brief again.`);
  if (!role.reportsTo) lines.push(`- \`conch team end ${team.id}\` when the team's work is done; its sessions stay open for the user.`);
  return `${lines.join("\n")}\n`;
}

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

function cut(value: string, room: number): string {
  if (value.length <= room) return value;
  if (room < 2) return "";
  return `${value.slice(0, room - 1).replace(/\s+\S*$/, "")}…`;
}

/**
 * A member's first message: one line, at most `START_PROMPT_MAX` characters, never starting with "-" (it is the agent's
 * first argument, session-lifecycle.ts `startPromptError`). Who it is and its task always; its role's words and the
 * rules as far as they fit; and where the whole brief is, which it is told to read first when anything was cut.
 */
export function teamFirstMessage(context: BriefContext): string {
  const { team, member } = context;
  const role = team.type.roles.find((one) => one.id === member.roleId)!;
  const above = member.reportsTo ? team.members.find((one) => one.key === member.reportsTo) : undefined;
  const head = `You're the ${role.name.toLowerCase()} (${member.key}) on a conch team, "${team.name}" (team ${team.id})`
    + (above ? `, reporting to "${above.label}"${above.sessionId ? ` (session ${above.sessionId})` : ""}.` : role.reportsTo ? "." : ", and you lead it.");
  const brief = `Your full brief: \`conch team brief ${team.id} ${member.key}\` (also ${context.briefPath}).`;
  const task = oneLine(member.task ?? team.task);
  const prompt = oneLine(role.prompt);
  const rules = team.type.rules.map((rule, index) => `${index + 1}) ${oneLine(rule)}`).join(" ");
  const below = rolesBelow(team.type, role.id);
  const ask = below.length ? `Ask conch for members with \`conch team add <role> "<task>"\` (${below.map((one) => one.id).join(", ")}), not untracked subagents.` : "";
  const fixed = [head, "", brief].join(" ").length + 64;
  let taskPart = `Your task: ${task}`;
  const taskRoom = Math.max(400, START_PROMPT_MAX - fixed - 600);
  const taskCut = taskPart.length > taskRoom;
  taskPart = cut(taskPart, taskRoom);
  let room = START_PROMPT_MAX - [head, taskPart, ask, brief].filter(Boolean).join(" ").length - 4;
  const parts = [head, taskPart];
  let whole = !taskCut;
  for (const [label, body] of [["Your role:", prompt], ["How the team works:", rules]] as const) {
    if (!body) continue;
    const full = `${label} ${body}`;
    if (full.length + 1 <= room) {
      parts.push(full);
      room -= full.length + 1;
    } else {
      whole = false;
      const some = room > label.length + 40 ? cut(full, room - 1) : "";
      if (some) {
        parts.push(some);
        room -= some.length + 1;
      }
    }
  }
  if (ask) parts.push(ask);
  parts.push(whole ? brief : `Read your full brief first: \`conch team brief ${team.id} ${member.key}\` (also ${context.briefPath}).`);
  const message = parts.join(" ").replace(/^[-\s]+/, "");
  return message.length > START_PROMPT_MAX ? cut(message, START_PROMPT_MAX) : message;
}
