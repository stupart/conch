import { resolve } from "node:path";
import { teamBriefPath, type TeamReply, type TeamsReply } from "./team-desk.ts";
import { teamTree, type TeamMember, type TeamSummary, type TeamType } from "./teams.ts";

/**
 * `conch team`: start a team on a task, pass a running team or a team type a new task, ask conch for a member, and read
 * who is on a team and a member's brief. Tyler's, from a Terminal, and an agent's from its shell: a lead asks conch for
 * members here rather than starting subagents conch can't see (team-desk.ts has who may ask for what).
 *
 * Exit codes as `conch agent` uses them (PR #610): 0 done, 1 conch failed (no daemon, no answer, a start that failed),
 * 2 the command was wrong, 3 conch refused and said why.
 */

export const TEAM_USAGE = `usage: conch team [list] [--json]                          the teams running, and the team types
       conch team types [--json]                          each team type's roles, hierarchy and rules
       conch team start <type> "<task>" [--cwd <dir>] [--trust-folder] [--no-wait]
                                                          start a team on a task: its lead, and the members it starts with
       conch team task <team|type> "<task>" [--cwd <dir>] pass a running team a new task (through its lead), or start a team of a type on it
       conch team add <role> "<task>" [--team <team>]     ask conch for a member of your team (a role below yours), on its own task
       conch team members [<team>] [--json]               who is on a team: role, session id, working or waiting (yours by default)
       conch team brief [<team> <member>]                 a member's brief: its role, the team's rules, how to work with conch (yours by default)
       conch team end <team>                              the team's work is done: its sessions stay open
  "<task>" may be - to read it from stdin. Team types are edited in the Mac app's Settings › Teams.`;

export interface TeamCliDeps {
  /** One request line to the daemon, its one reply line (phone-bridge.ts `forwardToDaemonSocket`). */
  request(line: string, timeoutMs: number): Promise<string>;
  /** The process that ran this: the shell, walked up to its session by the daemon. */
  callerPid: number;
  /** Whether this runs inside an agent (Claude Code's or Codex's environment says so). */
  fromAgent: boolean;
  cwd: string;
  configDir: string;
  stdin(): Promise<string>;
  stdinIsTTY: boolean;
  readFile(path: string): Promise<string>;
  out(line: string): void;
  err(line: string): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

/** The environment Claude Code and Codex give every command they run: a `conch team` there is an agent's. */
export function runsInsideAgent(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_PID || env.CODEX_THREAD_ID);
}

/** A start waits for the lead's session this long; past it, `conch team members` says how it went. */
export const TEAM_START_WAIT_MS = 60_000;
/** A member asked for is waited on as `conch_start` waits (#601), with room for the daemon's own launch. */
const ADD_TIMEOUT_MS = 70_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
  error?: string;
}

const VALUED = new Set(["--cwd", "--team"]);
const BARE = new Set(["--json", "--trust-folder", "--no-wait", "--help", "-h"]);

function parse(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (VALUED.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { positional, flags, error: `${arg} needs a value` };
      flags.set(arg, value);
      i += 1;
    } else if (BARE.has(arg)) {
      flags.set(arg, true);
    } else if (arg.startsWith("--")) {
      return { positional, flags, error: `conch team doesn't take ${arg}` };
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

export async function runTeamCommand(argv: readonly string[], deps: TeamCliDeps): Promise<number> {
  const args = parse(argv);
  if (args.flags.has("--help") || args.flags.has("-h") || argv[0] === "help") {
    deps.out(TEAM_USAGE);
    return 0;
  }
  const usage = (problem: string): number => {
    deps.err(`[conch] ${problem}\n${TEAM_USAGE}`);
    return 2;
  };
  if (args.error) return usage(args.error);
  const [sub = "list", ...rest] = args.positional;
  const json = args.flags.has("--json");
  const caller = { callerPid: deps.callerPid, ...(deps.fromAgent ? { fromAgent: true as const } : {}) };

  const ask = async (message: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<TeamReply | number> => {
    let line: string;
    try {
      line = await deps.request(JSON.stringify(message), timeoutMs);
    } catch (error) {
      deps.err(`[conch] conch isn't answering (${error instanceof Error ? error.message : String(error)}). Is conch running?`);
      return 1;
    }
    let reply: TeamReply;
    try { reply = JSON.parse(line) as TeamReply; } catch { reply = { kind: "nothing" } as never; }
    if (!reply || typeof reply.kind !== "string" || !reply.kind.startsWith("team")) {
      deps.err("[conch] this conch doesn't have teams yet: update it.");
      return 1;
    }
    if (reply.kind === "team-error") {
      deps.err(`[conch] ${reply.error}`);
      return reply.code === "invalid" ? 2 : reply.code === "refused" ? 3 : 1;
    }
    return reply;
  };
  const taskFrom = async (value: string | undefined): Promise<string | undefined> => {
    if (value === "-" || (value === undefined && !deps.stdinIsTTY)) return (await deps.stdin()).trim() || undefined;
    return value?.trim() || undefined;
  };
  const folder = () => resolve(deps.cwd, (args.flags.get("--cwd") as string | undefined) ?? ".");

  switch (sub) {
    case "list":
    case "ls": {
      if (rest.length) return usage(`conch team list takes no ${rest.length === 1 ? "argument" : "arguments"}`);
      const reply = await ask({ kind: "teams", ...caller });
      if (typeof reply === "number") return reply;
      const teams = reply as TeamsReply;
      if (json) {
        deps.out(JSON.stringify({ running: teams.running, types: teams.types.map(({ id, name, summary }) => ({ id, name, summary })) }, null, 2));
        return 0;
      }
      const now = (deps.now ?? Date.now)();
      if (teams.running.length) {
        deps.out("Running:");
        for (const team of teams.running) {
          deps.out(`  ${team.id}  ${team.name}  ${ago(team.startedAt, now)} ago  in ${team.cwd}${teams.caller?.team === team.id ? "  (yours)" : ""}`);
          deps.out(`    ${oneLine(team.task, 100)}`);
          for (const line of memberLines(team, now)) deps.out(`    ${line}`);
        }
      } else {
        deps.out("No team is running.");
      }
      deps.out("Team types:");
      for (const type of teams.types) deps.out(`  ${type.id.padEnd(22)} ${type.name}: ${hierarchyLine(type)}`);
      if (!teams.types.length) deps.out("  none: add one in the Mac app's Settings › Teams");
      return 0;
    }
    case "types": {
      if (rest.length) return usage("conch team types takes no arguments");
      const reply = await ask({ kind: "teams", ...caller });
      if (typeof reply === "number") return reply;
      const teams = reply as TeamsReply;
      if (json) {
        deps.out(JSON.stringify(teams.types, null, 2));
        return 0;
      }
      for (const [index, type] of teams.types.entries()) {
        if (index) deps.out("");
        deps.out(`${type.name} (${type.id})`);
        if (type.summary) deps.out(`  ${type.summary}`);
        for (const { role, depth } of teamTree(type)) {
          const agent = [role.backend === "codex" ? "Codex" : "Claude", role.model, role.effort].filter(Boolean).join(" ");
          const extra = [
            (role.maxConcurrent ?? 1) > 1 ? `up to ${role.maxConcurrent} at once` : "",
            role.workspace === "worktree" ? "own worktree" : "",
            role.atStart && role.reportsTo ? "starts with the team" : "",
            role.budgetMinutes ? `${role.budgetMinutes} min` : "",
          ].filter(Boolean).join(", ");
          deps.out(`  ${"  ".repeat(depth)}- ${role.name} (${role.id}): ${agent}${extra ? `; ${extra}` : ""}`);
        }
        type.rules.forEach((rule, n) => deps.out(`  ${n + 1}. ${rule}`));
      }
      return 0;
    }
    case "start": {
      const [type, given, extra] = rest;
      if (!type) return usage("name the team type to start");
      if (extra !== undefined) return usage("quote the task: conch team start <type> \"<task>\"");
      const task = await taskFrom(given);
      if (!task) return usage("the task is empty");
      const cwd = folder();
      const reply = await ask({ kind: "team-start", type, task, cwd, ...(args.flags.has("--trust-folder") ? { trustFolder: true } : {}), ...caller });
      if (typeof reply === "number") return reply;
      return startedOrTrust(reply, deps, args.flags.has("--no-wait"), ask);
    }
    case "task": {
      const [team, given, extra] = rest;
      if (!team) return usage("name the team, or a team type, to give the task to");
      if (extra !== undefined) return usage("quote the task: conch team task <team> \"<task>\"");
      const task = await taskFrom(given);
      if (!task) return usage("the task is empty");
      const reply = await ask({ kind: "team-task", team, task, cwd: folder(), ...caller });
      if (typeof reply === "number") return reply;
      if (reply.kind === "team-tasked") {
        deps.out(`[conch] passed the task to "${reply.to}", the lead of ${reply.team.id}.`);
        return 0;
      }
      return startedOrTrust(reply, deps, false, ask);
    }
    case "add": {
      const [role, given, extra] = rest;
      if (!role) return usage("name the role to ask for");
      if (extra !== undefined) return usage("quote the task: conch team add <role> \"<task>\"");
      const task = await taskFrom(given);
      if (!task) return usage("the member's task is empty");
      const team = args.flags.get("--team");
      const reply = await ask({ kind: "team-add", role, task, ...(typeof team === "string" ? { team } : {}), ...caller }, ADD_TIMEOUT_MS);
      if (typeof reply === "number") return reply;
      if (reply.kind !== "team-member-added") return unexpected(deps);
      const { member } = reply;
      deps.out(member.sessionId
        ? `[conch] started ${member.key}, "${member.label}" (session ${member.sessionId}), on ${reply.team.id}. Read its report: conch_transcript_tail {session: "${member.sessionId}", wait: 30}, passing back the cursor, until its status is waiting.`
        : `[conch] started ${member.key}, "${member.label}", on ${reply.team.id}; it runs in ${member.running ?? "a new window"}, though conch can't see it as a session yet.`);
      return 0;
    }
    case "members": {
      if (rest.length > 1) return usage("conch team members takes one team at most");
      const reply = await ask({ kind: "teams", ...caller });
      if (typeof reply === "number") return reply;
      const teams = reply as TeamsReply;
      const id = rest[0] ?? teams.caller?.team;
      if (!id) return usage("name the team: you aren't on one");
      const team = teams.running.find((one) => one.id === id.toLowerCase());
      if (!team) {
        deps.err(`[conch] there's no running team "${id}"${teams.running.length ? `. Running: ${teams.running.map((one) => one.id).join(", ")}` : ""}`);
        return 3;
      }
      if (json) {
        deps.out(JSON.stringify(team, null, 2));
        return 0;
      }
      deps.out(`${team.id}  ${team.name}  in ${team.cwd}`);
      for (const line of memberLines(team, (deps.now ?? Date.now)(), teams.caller?.team === team.id ? teams.caller.member : undefined)) deps.out(`  ${line}`);
      return 0;
    }
    case "brief": {
      let [team, member] = rest;
      if (rest.length > 2 || (team && !member)) return usage("conch team brief <team> <member>, or no arguments for your own");
      if (!team) {
        const reply = await ask({ kind: "teams", ...caller });
        if (typeof reply === "number") return reply;
        const own = (reply as TeamsReply).caller;
        if (!own) {
          deps.err("[conch] you aren't on a running team: name one, conch team brief <team> <member>");
          return 3;
        }
        ({ team, member } = own);
      }
      if (!/^[a-z0-9-]{1,80}$/.test(team!) || !/^[a-z0-9-]{1,40}$/.test(member!)) return usage("a team and a member are named like build-review-2 lead-1");
      const path = teamBriefPath(deps.configDir, team!, member!);
      try {
        deps.out((await deps.readFile(path)).trimEnd());
        return 0;
      } catch {
        deps.err(`[conch] there's no brief for ${member} on ${team} (${path})`);
        return 3;
      }
    }
    case "end": {
      const [team, extra] = rest;
      if (!team || extra !== undefined) return usage("name the one team to end");
      const reply = await ask({ kind: "team-end", team, ...caller });
      if (typeof reply === "number") return reply;
      deps.out(`[conch] ended ${team}. Its sessions stay open; close them in the Mac app when you're done with them.`);
      return 0;
    }
    default:
      return usage(`conch team has no ${JSON.stringify(sub)}`);
  }
}

function unexpected(deps: TeamCliDeps): number {
  deps.err("[conch] conch answered something this conch team doesn't know: update it.");
  return 1;
}

/** A start's answer: the team and its members, or the folder its agents haven't been told to trust; then the lead, waited for. */
async function startedOrTrust(
  reply: TeamReply,
  deps: TeamCliDeps,
  noWait: boolean,
  ask: (message: Record<string, unknown>, timeoutMs?: number) => Promise<TeamReply | number>,
): Promise<number> {
  if (reply.kind === "team-needs-trust") {
    deps.err(`[conch] ${reply.agents.join(" and ")} ${reply.agents.length > 1 ? "haven't" : "hasn't"} been told to trust ${reply.cwd} yet, so nothing was started. Run it again with --trust-folder to have conch answer yes when ${reply.agents.length > 1 ? "they ask" : "it asks"}.`);
    return 3;
  }
  if (reply.kind !== "team-started") return unexpected(deps);
  const { team } = reply;
  deps.out(`[conch] started ${team.id} ("${team.name}") in ${team.cwd}: ${team.members.map((member) => `${member.key} "${member.label}"`).join(", ")}.`);
  if (noWait) return 0;
  // The lead, once conch has seen it: its session id is what anyone reads its answer by.
  const lead = team.members[0]!;
  const sleep = deps.sleep ?? Bun.sleep;
  const now = deps.now ?? Date.now;
  const until = now() + TEAM_START_WAIT_MS;
  while (now() < until) {
    await sleep(1_000);
    const looked = await ask({ kind: "teams" });
    if (typeof looked === "number") return looked;
    const seen = (looked as TeamsReply).running.find((one) => one.id === team.id)?.members.find((member) => member.key === lead.key);
    if (!seen) break;
    if (seen.state === "failed") {
      deps.err(`[conch] the lead didn't start: ${seen.error ?? "conch didn't say why"}`);
      return 1;
    }
    if (seen.state === "running") {
      deps.out(seen.sessionId
        ? `[conch] the lead is running as "${seen.label}" (session ${seen.sessionId}). \`conch team members ${team.id}\` lists the team.`
        : `[conch] the lead is running in ${seen.running}, though conch can't see it as a session yet.`);
      return 0;
    }
  }
  deps.out(`[conch] the lead is still starting; \`conch team members ${team.id}\` says how it went.`);
  return 0;
}

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** "now", "5m", "2h", "3d": Settings › Failures' short words. */
export function ago(ms: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - ms) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1_440)}d`;
}

/** "Lead → Builder (×3), Reviewer": a type's tree on one line, the lead first and its reports after the arrow. */
export function hierarchyLine(type: Pick<TeamType, "roles">): string {
  const tree = teamTree(type);
  const name = (role: (typeof tree)[number]["role"]) => `${role.name}${(role.maxConcurrent ?? 1) > 1 ? ` (×${role.maxConcurrent})` : ""}`;
  const [lead, ...rest] = tree;
  if (!lead) return "";
  const levels = new Map<number, string[]>();
  for (const { role, depth } of rest) levels.set(depth, [...(levels.get(depth) ?? []), name(role)]);
  return [name(lead.role), ...[...levels.keys()].sort((a, b) => a - b).map((depth) => levels.get(depth)!.join(", "))].join(" → ");
}

/** One line per member: its key and label, where it stands, its session, and how far into its budget it is. */
export function memberLines(team: TeamSummary, now: number, you?: string): string[] {
  return team.members.map((member: TeamMember) => {
    const where = member.state === "running"
      ? member.status === "needs" ? "needs you" : member.status ?? (member.sessionId ? "running" : `running in ${member.running ?? "a window conch can't see"}`)
      : member.state === "failed" ? `failed: ${member.error ?? "conch didn't say why"}` : member.state;
    const budget = member.budgetMinutes && member.state === "running" ? `, ${ago(member.startedAt, now)} of ${member.budgetMinutes}m` : "";
    const reports = member.reportsTo ? `  reports to ${member.reportsTo}` : "";
    return `${member.key.padEnd(12)} ${member.label}${member.key === you ? " (you)" : ""}  ${where}${budget}${member.sessionId ? `  session ${member.sessionId}` : ""}${reports}`;
  });
}
