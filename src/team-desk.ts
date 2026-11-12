import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { adapterFor, type SessionBackend } from "./agent-adapter.ts";
import { resolveSessionSignIn, type ClaudeSessionSignIn } from "./claude-session-sign-ins.ts";
import { conchHome } from "./home.ts";
import { writeSettingsFileAtomic } from "./settings.ts";
import {
  leadRole,
  memberLabel,
  reportsUpTo,
  roleStartOptions,
  slugify,
  STARTER_TEAM_TYPES,
  teamAgentChoices,
  teamBrief,
  teamFirstMessage,
  teamSummary,
  teamTaskError,
  teamTree,
  validateTeamType,
  type TeamHost,
  type TeamInstance,
  type TeamMember,
  type TeamMessaging,
  type TeamRole,
  type TeamSummary,
  type TeamType,
} from "./teams.ts";

/**
 * The daemon's desk for teams (teams.ts has the model and the why): the team types Settings › Teams edits, the teams
 * running, and every request about them, from the Mac app (`{kind: "teams"}` and the rest) and from `conch team`.
 *
 * A member is started as `conch_start` starts a session (#601, daemon.ts `startLiveSession`): the daemon's own start,
 * waited on until conch sees it running, on the role's agent, model, effort, sign-in and permissions, with its brief as
 * its first message. Who may ask for whom is the hierarchy's: a member may ask conch for roles below its own, the user for
 * any; a role runs at most its `maxConcurrent` working at once.
 *
 * A task passed to a running team goes to its lead. The user's own words are delivered as the user's, as the composer
 * delivers them. An agent's words to another session are a peer message, which this branch can't send yet
 * (feat/peer-messages): `deliverFromSession` is that seam, and until the daemon wires it, an agent's task to a running
 * team is refused with what to do instead.
 *
 * Resources: what a member starts is its session's in the resource ledger (feat/resource-ledger), and `teamForSession`
 * is how the ledger rolls them up to the team.
 */

// MARK: the wire

export type TeamRequest =
  | { kind: "teams"; callerPid?: number; fromAgent?: true }
  | { kind: "team-type-save"; type: unknown; previousId?: string }
  | { kind: "team-type-delete"; id: string }
  | { kind: "team-type-duplicate"; id: string }
  | { kind: "team-types-restore" }
  | { kind: "team-start"; type: string; task: string; cwd?: string; trustFolder?: true; callerPid?: number; fromAgent?: true }
  | { kind: "team-task"; team: string; task: string; cwd?: string; callerPid?: number; fromAgent?: true }
  | { kind: "team-add"; team?: string; role: string; task: string; callerPid?: number; fromAgent?: true }
  | { kind: "team-end"; team: string; callerPid?: number; fromAgent?: true };

export type TeamErrorCode = "invalid" | "refused" | "failed";

export interface TeamsReply {
  kind: "teams";
  types: TeamType[];
  running: TeamSummary[];
  agents: Record<SessionBackend, { efforts: readonly string[]; permissions: readonly string[] }>;
  signIns: Array<{ id: string; label: string }>;
  /** How many of conch's starter types aren't in the list: Settings › Teams offers them back. */
  missingStarters: number;
  saved?: string;
  /** The asking session's own team and member, for `conch team` with no team named. */
  caller?: { team: string; member: string };
}

export type TeamReply =
  | TeamsReply
  | { kind: "team-started"; team: TeamSummary }
  | { kind: "team-needs-trust"; cwd: string; agents: string[] }
  | { kind: "team-tasked"; team: TeamSummary; to: string }
  | { kind: "team-member-added"; team: TeamSummary; member: TeamMember }
  | { kind: "team-error"; error: string; field?: string; code: TeamErrorCode };

const TEAM_KINDS = new Set(["teams", "team-type-save", "team-type-delete", "team-type-duplicate", "team-types-restore", "team-start", "team-task", "team-add", "team-end"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A team request as the socket takes it, its fields checked; null for any other kind. */
export function decodeTeamRequest(body: unknown): TeamRequest | { error: string } | null {
  if (!isRecord(body) || typeof body.kind !== "string" || !TEAM_KINDS.has(body.kind)) return null;
  const string = (key: string, max = 200): string | undefined | { error: string } => {
    const value = body[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim() || value.length > max) return { error: `${key} must be text of at most ${max} characters` };
    return value.trim();
  };
  const caller: { callerPid?: number; fromAgent?: true } = {};
  if (body.callerPid !== undefined) {
    if (typeof body.callerPid !== "number" || !Number.isSafeInteger(body.callerPid) || body.callerPid <= 1) return { error: "callerPid must be a process id" };
    caller.callerPid = body.callerPid;
  }
  if (body.fromAgent !== undefined) {
    if (body.fromAgent !== true) return { error: "fromAgent must be true when present" };
    caller.fromAgent = true;
  }
  const need = (key: string, max?: number): string | { error: string } => {
    const value = string(key, max);
    return value === undefined ? { error: `${key} is missing` } : value;
  };
  const task = (): string | { error: string } => {
    const error = teamTaskError(body.task);
    return error ? { error } : (body.task as string).trim();
  };
  const cwd = (): string | undefined | { error: string } => {
    const value = string("cwd", 4_096);
    if (typeof value === "string" && !isAbsolute(value)) return { error: "cwd must be an absolute path" };
    return value;
  };
  const failed = (...values: unknown[]) => values.find((value): value is { error: string } => isRecord(value) && typeof value.error === "string");
  switch (body.kind) {
    case "teams":
      return { kind: "teams", ...caller };
    case "team-types-restore":
      return { kind: "team-types-restore" };
    case "team-type-save": {
      const previousId = string("previousId", 40);
      if (failed(previousId)) return failed(previousId)!;
      if (!isRecord(body.type)) return { error: "type must be a team type" };
      return { kind: "team-type-save", type: body.type, ...(previousId ? { previousId: previousId as string } : {}) };
    }
    case "team-type-delete":
    case "team-type-duplicate": {
      const id = need("id", 40);
      if (failed(id)) return failed(id)!;
      return { kind: body.kind, id: id as string };
    }
    case "team-start": {
      const type = need("type", 80);
      const told = task();
      const folder = cwd();
      if (failed(type, told, folder)) return failed(type, told, folder)!;
      if (body.trustFolder !== undefined && body.trustFolder !== true) return { error: "trustFolder must be true when present" };
      return {
        kind: "team-start", type: type as string, task: told as string, ...(folder ? { cwd: folder as string } : {}),
        ...(body.trustFolder === true ? { trustFolder: true as const } : {}), ...caller,
      };
    }
    case "team-task": {
      const team = need("team", 80);
      const told = task();
      const folder = cwd();
      if (failed(team, told, folder)) return failed(team, told, folder)!;
      return { kind: "team-task", team: team as string, task: told as string, ...(folder ? { cwd: folder as string } : {}), ...caller };
    }
    case "team-add": {
      const team = string("team", 80);
      const role = need("role", 40);
      const told = task();
      if (failed(team, role, told)) return failed(team, role, told)!;
      return { kind: "team-add", ...(team ? { team: team as string } : {}), role: role as string, task: told as string, ...caller };
    }
    case "team-end": {
      const team = need("team", 80);
      if (failed(team)) return failed(team)!;
      return { kind: "team-end", team: team as string, ...caller };
    }
  }
  return null;
}

// MARK: where it is kept

export function teamsConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONCH_CONFIG_DIR ?? join(conchHome(), ".config", "conch");
}

/** A member's brief: `~/.config/conch/teams/<team>/<member>.md`, beside the team's other briefs. */
export function teamBriefPath(configDir: string, teamId: string, memberKey: string): string {
  return join(configDir, "teams", teamId, `${memberKey}.md`);
}

interface TeamTypesFile { v: 1; types: TeamType[] }
interface TeamInstancesFile { v: 1; counters: Record<string, number>; teams: TeamInstance[] }

/** Ended teams kept for `conch team list --all` and the briefs' sake; running ones are always kept. */
const ENDED_KEPT = 20;
/** A member's session gone from conch this long has ended: one refresh without it is not enough. */
export const MEMBER_GONE_MS = 60_000;
/** A team whose members have all ended ends too, once it is this old: a start still on its way is not an ending. */
const TEAM_SETTLE_MS = 120_000;

function readJson(path: string): unknown {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return undefined; }
  try { return JSON.parse(raw); } catch {
    // Set aside, never trusted and never thrown on: the next save starts from the starters.
    try { renameSync(path, `${path}.unreadable-${Date.now()}`); } catch {}
    return undefined;
  }
}

// MARK: the desk

export interface TeamStartRequest {
  backend: SessionBackend;
  cwd: string;
  prompt: string;
  label: string;
  claudeSignInId?: string;
  options?: Record<string, string | boolean>;
  host?: TeamHost;
  trustFolder?: true;
}

/** What a member's start came to: the session conch saw, where it runs unseen, or the folder its agent won't trust yet. */
export type TeamStartOutcome = { sessionId: string; label?: string } | { running: string } | { needsTrust: string };

export interface TeamCaller {
  sessionId: string;
  label: string;
  cwd?: string;
}

export interface TeamDeskDependencies {
  typesPath: string;
  instancesPath: string;
  configDir: string;
  now(): number;
  log(line: string): void;
  /** Start one member: the daemon's own start with `wait` (#601). Throws with why it didn't start. */
  start(request: TeamStartRequest): Promise<TeamStartOutcome>;
  /** Whether an agent already trusts a folder; null when unknown (as `session-start` asks it). */
  folderTrusted?(backend: SessionBackend, cwd: string): boolean | null;
  isFolder(path: string): boolean;
  /** A live session's status in conch, by id; undefined once conch doesn't have it. */
  sessionStatus(sessionId: string): "working" | "waiting" | "needs" | undefined;
  /**
   * The session a process belongs to (caller-session.ts): verified, null when it isn't any session's (the user's own
   * Terminal), or why conch can't tell.
   */
  callerOf(pid: number): Promise<TeamCaller | null | { unverified: string }>;
  /** The user's own words into a session, as the composer sends them. */
  deliverFromUser(sessionId: string, text: string): Promise<{ delivered: boolean; error?: string }>;
  /** An agent's words to another session: peer messages (feat/peer-messages). Absent until they land. */
  deliverFromSession?(from: TeamCaller, sessionId: string, text: string): Promise<{ delivered: boolean; error?: string }>;
  signIns(): readonly ClaudeSessionSignIn[];
  /** Something a viewer shows changed: publish. */
  changed(): void;
}

type Origin = { kind: "user" } | { kind: "session"; caller: TeamCaller };
type TeamErrorReply = Extract<TeamReply, { kind: "team-error" }>;

const refused = (error: string, field?: string): TeamErrorReply => ({ kind: "team-error", code: "refused", error, ...(field ? { field } : {}) });
const invalid = (error: string, field?: string): TeamErrorReply => ({ kind: "team-error", code: "invalid", error, ...(field ? { field } : {}) });
const callerCwd = (origin: Origin): string | undefined => origin.kind === "session" ? origin.caller.cwd : undefined;

export class TeamDesk {
  private types: TeamType[];
  private counters: Record<string, number>;
  private teams: TeamInstance[];
  /** When each member's session was first seen missing (`MEMBER_GONE_MS`), by team and key. In memory only. */
  private readonly missingSince = new Map<string, number>();
  private readonly starting = new Set<Promise<void>>();

  constructor(private readonly deps: TeamDeskDependencies) {
    this.types = this.readTypes();
    const instances = readJson(deps.instancesPath) as Partial<TeamInstancesFile> | undefined;
    this.counters = isRecord(instances?.counters) ? { ...(instances!.counters as Record<string, number>) } : {};
    this.teams = Array.isArray(instances?.teams) ? (instances!.teams as TeamInstance[]).filter((team) => isRecord(team) && typeof team.id === "string" && isRecord(team.type)) : [];
    // A start the last daemon didn't see through never will be: it is said, not left starting for ever.
    for (const team of this.teams) {
      for (const member of team.members) {
        if (member.state === "starting" && !member.sessionId) {
          member.state = "failed";
          member.error = "conch restarted before it saw this member start";
        }
      }
    }
  }

  private readTypes(): TeamType[] {
    const file = readJson(this.deps.typesPath) as Partial<TeamTypesFile> | undefined;
    if (!file || !Array.isArray(file.types)) return structuredClone([...STARTER_TEAM_TYPES]);
    const types: TeamType[] = [];
    for (const raw of file.types) {
      const checked = validateTeamType(raw);
      if (checked.ok && !types.some((one) => one.id === checked.value.id)) types.push(checked.value);
      else this.deps.log(`teams: a saved team type didn't read back and was left out${checked.ok ? "" : `: ${checked.error}`}`);
    }
    return types;
  }

  private saveTypes(): void {
    writeSettingsFileAtomic(this.deps.typesPath, { v: 1, types: this.types } satisfies TeamTypesFile);
  }

  private saveTeams(): void {
    const running = this.teams.filter((team) => team.endedAt === undefined);
    const ended = this.teams.filter((team) => team.endedAt !== undefined).sort((a, b) => b.endedAt! - a.endedAt!).slice(0, ENDED_KEPT);
    this.teams = [...running, ...ended].sort((a, b) => a.startedAt - b.startedAt);
    writeSettingsFileAtomic(this.deps.instancesPath, { v: 1, counters: this.counters, teams: this.teams } satisfies TeamInstancesFile);
  }

  /** The teams at work, for the sessions file (`teams`): the sidebar groups their members under them. */
  published(): TeamSummary[] {
    this.observe();
    return this.running().map((team) => this.summary(team));
  }

  /** The running team a session is a member of: what the resource ledger rolls a member's resources up to. */
  teamForSession(sessionId: string): { team: string; member: string } | undefined {
    for (const team of this.running()) {
      const member = team.members.find((one) => one.sessionId === sessionId);
      if (member) return { team: team.id, member: member.key };
    }
  }

  /** Every start under way, settled: for tests and for a clean shutdown. */
  async settled(): Promise<void> {
    while (this.starting.size) await Promise.allSettled([...this.starting]);
  }

  private summary(team: TeamInstance): TeamSummary {
    return teamSummary(team, (sessionId) => this.deps.sessionStatus(sessionId));
  }

  private running(): TeamInstance[] {
    return this.teams.filter((team) => team.endedAt === undefined);
  }

  private messaging(): TeamMessaging {
    return { peerMessages: this.deps.deliverFromSession !== undefined };
  }

  /** Members whose sessions have gone end, and a team whose members have all ended ends with them. */
  private observe(): void {
    const now = this.deps.now();
    let changed = false;
    for (const team of this.running()) {
      for (const member of team.members) {
        if (member.state !== "running" || !member.sessionId) continue;
        const key = `${team.id}/${member.key}`;
        if (this.deps.sessionStatus(member.sessionId) !== undefined) {
          this.missingSince.delete(key);
          continue;
        }
        const since = this.missingSince.get(key) ?? now;
        this.missingSince.set(key, since);
        if (now - since >= MEMBER_GONE_MS) {
          member.state = "ended";
          this.missingSince.delete(key);
          changed = true;
        }
      }
      const over = team.members.every((member) => member.state === "ended" || member.state === "failed");
      if (over && now - team.startedAt >= TEAM_SETTLE_MS) {
        team.endedAt = now;
        this.deps.log(`team ${team.id}: every member has ended, so the team has too`);
        changed = true;
      }
    }
    if (changed) this.saveTeams();
  }

  // MARK: requests

  async handle(request: TeamRequest): Promise<TeamReply> {
    try {
      switch (request.kind) {
        case "teams": return await this.list(request.callerPid);
        case "team-type-save": return this.saveType(request.type, request.previousId);
        case "team-type-delete": return this.deleteType(request.id);
        case "team-type-duplicate": return this.duplicateType(request.id);
        case "team-types-restore": return this.restoreStarters();
      }
      const origin = await this.origin(request);
      if ("error" in origin) return origin;
      switch (request.kind) {
        // An agent's start works where it works, unless it names another folder.
        case "team-start": return this.start(request.type, request.task, request.cwd ?? callerCwd(origin), origin, request.trustFolder);
        case "team-task": return await this.passTask(request.team, request.task, request.cwd ?? callerCwd(origin), origin);
        case "team-add": return await this.add(request.team, request.role, request.task, origin);
        case "team-end": return await this.end(request.team, origin);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log(`teams: ${request.kind} failed: ${message}`);
      return { kind: "team-error", code: "failed", error: message };
    }
  }

  /**
   * Who is asking. The Mac app names no process: the user. `conch team` names its shell, walked up to its session: an
   * agent's, or none (the user's own Terminal). One that says it runs inside an agent (`fromAgent`, from Claude Code's
   * and Codex's environment) but that conch can't place is refused rather than taken for the user, whose words go into
   * a session as the user's.
   */
  private async origin(request: { callerPid?: number; fromAgent?: true }): Promise<Origin | TeamErrorReply> {
    if (request.callerPid === undefined) {
      return request.fromAgent ? refused("conch can't tell which session is asking: run this from the agent's own shell") : { kind: "user" };
    }
    const found = await this.deps.callerOf(request.callerPid);
    if (found && "sessionId" in found) return { kind: "session", caller: found };
    if (request.fromAgent || (found && "unverified" in found)) {
      return refused(`conch can't tell which session is asking${found && "unverified" in found ? ` (${found.unverified})` : ""}`);
    }
    return { kind: "user" };
  }

  private async list(callerPid?: number): Promise<TeamsReply> {
    this.observe();
    let caller: TeamsReply["caller"];
    if (callerPid !== undefined) {
      const found = await this.deps.callerOf(callerPid);
      if (found && "sessionId" in found) caller = this.teamForSession(found.sessionId);
    }
    return this.reply(undefined, caller);
  }

  private reply(saved?: string, caller?: TeamsReply["caller"]): TeamsReply {
    let signIns: Array<{ id: string; label: string }> = [];
    try { signIns = this.deps.signIns().map(({ id, label }) => ({ id, label })); } catch {}
    const choices = (backend: SessionBackend) => {
      const { efforts, permissions } = teamAgentChoices(backend);
      return { efforts, permissions };
    };
    return {
      kind: "teams",
      types: structuredClone(this.types),
      running: this.running().map((team) => this.summary(team)),
      agents: { claude: choices("claude"), codex: choices("codex") },
      signIns,
      missingStarters: STARTER_TEAM_TYPES.filter((starter) => !this.types.some((type) => type.id === starter.id)).length,
      ...(saved ? { saved } : {}),
      ...(caller ? { caller } : {}),
    };
  }

  private uniqueTypeId(base: string, except?: string): string {
    const taken = (id: string) => this.types.some((type) => type.id === id && type.id !== except);
    if (!taken(base)) return base;
    for (let n = 2; ; n += 1) {
      const id = `${base.slice(0, 36)}-${n}`;
      if (!taken(id)) return id;
    }
  }

  /**
   * An edit names the type it was loaded as (`previousId`), renamed or not, and replaces it; a save without one is a new
   * type, whose id is made unique, so a new type never lands on top of another of the same name.
   */
  private saveType(raw: unknown, previousId?: string): TeamReply {
    const checked = validateTeamType(raw);
    if (!checked.ok) return invalid(checked.error, checked.field);
    const type = checked.value;
    if (previousId !== undefined) {
      const at = this.types.findIndex((one) => one.id === previousId);
      if (at < 0) return refused(`there's no team type "${previousId}" to save over: it may have been deleted`);
      if (type.id !== previousId && this.types.some((one) => one.id === type.id)) return invalid(`a team type is already called "${type.id}"`, "id");
      this.types[at] = type;
    } else {
      type.id = this.uniqueTypeId(type.id);
      this.types.push(type);
    }
    this.saveTypes();
    this.deps.log(`teams: saved the team type "${type.name}" (${type.id})`);
    this.deps.changed();
    return this.reply(type.id);
  }

  private deleteType(id: string): TeamReply {
    const before = this.types.length;
    this.types = this.types.filter((type) => type.id !== id);
    if (this.types.length === before) return refused(`there's no team type "${id}"`);
    this.saveTypes();
    this.deps.log(`teams: deleted the team type ${id}; teams already running keep their copy of it`);
    this.deps.changed();
    return this.reply();
  }

  private duplicateType(id: string): TeamReply {
    const source = this.types.find((type) => type.id === id);
    if (!source) return refused(`there's no team type "${id}"`);
    const names = new Set(this.types.map((type) => type.name.toLowerCase()));
    let name = `${source.name} copy`.slice(0, 60);
    for (let n = 2; names.has(name.toLowerCase()); n += 1) name = `${source.name} copy ${n}`.slice(0, 60);
    const copy: TeamType = { ...structuredClone(source), name, id: this.uniqueTypeId(slugify(name, 40) || `${source.id}-copy`) };
    this.types.splice(this.types.indexOf(source) + 1, 0, copy);
    this.saveTypes();
    this.deps.changed();
    return this.reply(copy.id);
  }

  private restoreStarters(): TeamReply {
    const missing = STARTER_TEAM_TYPES.filter((starter) => !this.types.some((type) => type.id === starter.id));
    this.types.push(...structuredClone(missing));
    if (missing.length) this.saveTypes();
    this.deps.changed();
    return this.reply();
  }

  private findType(query: string): TeamType | undefined {
    const asked = query.trim().toLowerCase();
    return this.types.find((type) => type.id === asked)
      ?? this.types.find((type) => type.name.toLowerCase() === asked)
      ?? this.types.find((type) => type.id === slugify(asked));
  }

  private findTeam(query: string): TeamInstance | undefined {
    const asked = query.trim().toLowerCase();
    return this.running().find((team) => team.id === asked);
  }

  private typesListed(): string {
    return this.types.length ? `conch has ${this.types.map((type) => `"${type.name}" (${type.id})`).join(", ")}` : "conch has no team types: add one in Settings › Teams";
  }

  private start(typeQuery: string, task: string, cwd: string | undefined, origin: Origin, trustFolder?: true): TeamReply {
    const type = this.findType(typeQuery);
    if (!type) return refused(`there's no team type "${typeQuery}". ${this.typesListed()}`, "type");
    if (!cwd) return invalid("name the folder the team works in", "cwd");
    if (!this.deps.isFolder(cwd)) return invalid(`${cwd} is not a folder that exists`, "cwd");
    // Every agent the type can start is asked now, not when a member is asked for an hour later.
    if (!trustFolder) {
      const asking = new Set<string>();
      for (const role of type.roles) {
        const trusted = this.deps.folderTrusted?.(role.backend, cwd);
        if (trusted === false || (role.host === "background" && trusted !== true)) asking.add(adapterFor(role.backend).displayName);
      }
      if (asking.size) return { kind: "team-needs-trust", cwd, agents: [...asking] };
    }
    const signIn = this.signInsFor(type);
    if ("error" in signIn) return refused(signIn.error, signIn.field);
    const number = (this.counters[type.id] ?? 0) + 1;
    this.counters[type.id] = number;
    const now = this.deps.now();
    const team: TeamInstance = {
      id: `${type.id}-${number}`,
      typeId: type.id,
      name: type.name,
      task,
      cwd,
      startedAt: now,
      type: structuredClone(type),
      members: [],
      tasks: [{ text: task, at: now, from: origin.kind === "user" ? "you" : origin.caller.label }],
      ...(trustFolder ? { trustFolder: true as const } : {}),
    };
    const lead = leadRole(type);
    for (const { role } of teamTree(type)) {
      if (role.id !== lead.id && !role.atStart) continue;
      team.members.push(this.newMember(team, role, task, role.id === lead.id ? undefined : this.reportsToFor(team, role)));
    }
    this.teams.push(team);
    this.saveTeams();
    this.deps.log(`team ${team.id}: started "${type.name}" in ${cwd} with ${team.members.map((member) => member.key).join(", ")}`);
    this.deps.changed();
    // One at a time, the lead first: a member's brief names whom it reports to by session once that one runs.
    const run = (async () => {
      for (const member of team.members) await this.startMember(team, member);
    })();
    this.track(run);
    return { kind: "team-started", team: this.summary(team) };
  }

  /** Each role's sign-in, named as conch has it: one it doesn't is refused now, as `conch start --sign-in` refuses it. */
  private signInsFor(type: TeamType): { ok: true } | { error: string; field: string } {
    const named = type.roles.filter((role) => role.signIn);
    if (!named.length) return { ok: true };
    let signIns: readonly ClaudeSessionSignIn[];
    try { signIns = this.deps.signIns(); } catch (error) { return { error: `conch couldn't read its Claude sign-ins (${(error as Error).message})`, field: "signIn" }; }
    for (const role of named) {
      try { resolveSessionSignIn(role.signIn!, signIns); }
      catch (error) { return { error: `${role.name}: ${(error as Error).message}`, field: `roles.${type.roles.indexOf(role)}.signIn` }; }
    }
    return { ok: true };
  }

  private newMember(team: TeamInstance, role: TeamRole, task: string, reportsTo: string | undefined, ownTask?: string): TeamMember {
    const number = team.members.filter((member) => member.roleId === role.id).length + 1;
    return {
      key: `${role.id}-${number}`,
      roleId: role.id,
      roleName: role.name,
      label: memberLabel(role, number, team.task),
      state: "starting",
      startedAt: this.deps.now(),
      ...(reportsTo ? { reportsTo } : {}),
      ...(ownTask && ownTask !== task ? { task: ownTask } : {}),
      ...(role.budgetMinutes ? { budgetMinutes: role.budgetMinutes } : {}),
    };
  }

  /** Whom a member started without an asker reports to: the first member of its role's own boss, else the lead. */
  private reportsToFor(team: TeamInstance, role: TeamRole): string | undefined {
    const boss = team.members.find((member) => member.roleId === role.reportsTo && member.state !== "failed");
    return boss?.key ?? team.members.find((member) => member.roleId === leadRole(team.type).id)?.key;
  }

  private track(run: Promise<void>): void {
    this.starting.add(run);
    void run.finally(() => this.starting.delete(run));
  }

  /** Write a member's brief and start its session; the member says how that went. */
  private async startMember(team: TeamInstance, member: TeamMember): Promise<void> {
    const role = team.type.roles.find((one) => one.id === member.roleId)!;
    const briefPath = teamBriefPath(this.deps.configDir, team.id, member.key);
    const context = { team, member, messaging: this.messaging(), briefPath };
    try {
      mkdirSync(dirname(briefPath), { recursive: true });
      writeFileSync(briefPath, teamBrief(context), { mode: 0o600 });
      let claudeSignInId: string | undefined;
      if (role.signIn) claudeSignInId = resolveSessionSignIn(role.signIn, this.deps.signIns()).id;
      const options = roleStartOptions(role);
      const outcome = await this.deps.start({
        backend: role.backend,
        cwd: team.cwd,
        prompt: teamFirstMessage(context),
        label: member.label,
        ...(claudeSignInId ? { claudeSignInId } : {}),
        ...(Object.keys(options).length ? { options } : {}),
        ...(role.host === "background" ? { host: "background" as const } : {}),
        ...(team.trustFolder ? { trustFolder: true as const } : {}),
      });
      if ("needsTrust" in outcome) {
        member.state = "failed";
        member.error = `${adapterFor(role.backend).displayName} doesn't trust ${outcome.needsTrust} yet`;
      } else if ("sessionId" in outcome) {
        member.state = "running";
        member.sessionId = outcome.sessionId;
        if (outcome.label) member.label = outcome.label;
      } else {
        // Running, though conch can't see it as a session yet: where, so someone can look.
        member.state = "running";
        member.running = outcome.running;
      }
    } catch (error) {
      member.state = "failed";
      member.error = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
    }
    this.deps.log(`team ${team.id}: ${member.key} ${member.state === "failed" ? `didn't start: ${member.error}` : member.sessionId ? `is running as "${member.label}" (${member.sessionId})` : `is running in ${member.running}`}`);
    this.saveTeams();
    this.deps.changed();
  }

  private async passTask(query: string, task: string, cwd: string | undefined, origin: Origin): Promise<TeamReply> {
    const team = this.findTeam(query);
    if (!team) {
      // A type, not a running team: a new team of it, on this task.
      if (this.findType(query)) return this.start(query, task, cwd ?? (origin.kind === "session" ? origin.caller.cwd : undefined), origin);
      const running = this.running();
      return refused(`there's no running team or team type "${query}". ${running.length ? `Running: ${running.map((one) => one.id).join(", ")}. ` : ""}${this.typesListed()}`, "team");
    }
    const leadId = leadRole(team.type).id;
    const lead = team.members.find((member) => member.roleId === leadId && member.state === "running" && member.sessionId);
    if (!lead) return refused(`${team.id}'s lead isn't running, so there's no one to pass the task to: start a new team on it`);
    if (origin.kind === "session" && origin.caller.sessionId === lead.sessionId) return refused(`you lead ${team.id}: the task is yours already`);
    let sent: { delivered: boolean; error?: string };
    if (origin.kind === "user") {
      sent = await this.deps.deliverFromUser(lead.sessionId!, `New task for the team (${team.id}): ${task}`);
    } else if (this.deps.deliverFromSession) {
      sent = await this.deps.deliverFromSession(origin.caller, lead.sessionId!, `New task for your team (${team.id}): ${task}`);
    } else {
      return refused(
        `conch can't pass one session's words into another yet, so ${team.id}'s lead wasn't told. The user can pass it from Settings › Teams,`
        + ` or start a new team on it: conch team start ${team.typeId} "<task>"`,
      );
    }
    if (!sent.delivered) return { kind: "team-error", code: "failed", error: `${lead.label} wasn't told${sent.error ? `: ${sent.error}` : ""}` };
    team.tasks.push({ text: task, at: this.deps.now(), from: origin.kind === "user" ? "you" : origin.caller.label });
    this.saveTeams();
    this.deps.log(`team ${team.id}: passed a task to ${lead.key}`);
    this.deps.changed();
    return { kind: "team-tasked", team: this.summary(team), to: lead.label };
  }

  /** Members of a role at work now: starting, or running and not waiting. A finished one waiting for its next word doesn't count. */
  private working(team: TeamInstance, roleId: string): TeamMember[] {
    return team.members.filter((member) => member.roleId === roleId && (member.state === "starting"
      || (member.state === "running" && (!member.sessionId || this.deps.sessionStatus(member.sessionId) !== "waiting"))));
  }

  private async add(query: string | undefined, roleQuery: string, task: string, origin: Origin): Promise<TeamReply> {
    let team: TeamInstance | undefined;
    let asker: TeamMember | undefined;
    if (origin.kind === "session") {
      const own = this.teamForSession(origin.caller.sessionId);
      if (!own) return refused(query ? `only ${query}'s own members can ask for members, and you aren't one` : "you aren't a member of a running conch team");
      if (query && query.toLowerCase() !== own.team) return refused(`you're on ${own.team}, not ${query}`);
      team = this.findTeam(own.team)!;
      asker = team.members.find((member) => member.key === own.member);
    } else {
      if (!query) return invalid("name the team (--team <id>)", "team");
      team = this.findTeam(query);
      if (!team) return refused(`there's no running team "${query}"${this.running().length ? `. Running: ${this.running().map((one) => one.id).join(", ")}` : ""}`, "team");
    }
    const asked = roleQuery.trim().toLowerCase();
    const role = team.type.roles.find((one) => one.id === asked) ?? team.type.roles.find((one) => one.name.toLowerCase() === asked);
    if (!role) return refused(`${team.name} has no role "${roleQuery}": it has ${team.type.roles.map((one) => one.id).join(", ")}`, "role");
    if (!role.reportsTo) return refused(`${team.id} has its ${role.name.toLowerCase()} already: a team has one`, "role");
    if (asker && !reportsUpTo(team.type, role.id, asker.roleId)) {
      const boss = team.type.roles.find((one) => one.id === role.reportsTo)!;
      return refused(`a ${role.name.toLowerCase()} reports to the ${boss.name.toLowerCase()}, not to you: ask them`, "role");
    }
    const working = this.working(team, role.id);
    const most = role.maxConcurrent ?? 1;
    if (working.length >= most) {
      return refused(`${working.length === 1 ? "a" : working.length} ${role.name.toLowerCase()}${working.length === 1 ? " is" : "s are"} already working (${working.map((one) => one.key).join(", ")}), and ${team.name} runs at most ${most} at once: wait for one to finish, then ask again`);
    }
    const member = this.newMember(team, role, team.task, asker?.key ?? this.reportsToFor(team, role), task);
    member.label = memberLabel(role, Number(member.key.split("-").pop()), task);
    team.members.push(member);
    team.tasks.push({ text: task, at: this.deps.now(), from: origin.kind === "user" ? "you" : origin.caller.label });
    this.saveTeams();
    this.deps.changed();
    const run = this.startMember(team, member);
    this.track(run);
    await run;
    if (member.state === "failed") return { kind: "team-error", code: "failed", error: `${member.key} didn't start: ${member.error}` };
    return { kind: "team-member-added", team: this.summary(team), member: structuredClone(member) };
  }

  private async end(query: string, origin: Origin): Promise<TeamReply> {
    const team = this.findTeam(query);
    if (!team) return refused(`there's no running team "${query}"`, "team");
    if (origin.kind === "session") {
      const lead = team.members.find((member) => member.roleId === leadRole(team.type).id);
      if (lead?.sessionId !== origin.caller.sessionId) return refused(`only ${team.id}'s lead or the user can end it`);
    }
    team.endedAt = this.deps.now();
    this.saveTeams();
    this.deps.log(`team ${team.id}: ended; its sessions stay open`);
    this.deps.changed();
    return this.reply();
  }
}

/** The desk's default files, under conch's config folder. */
export function teamDeskPaths(configDir: string = teamsConfigDir()): Pick<TeamDeskDependencies, "typesPath" | "instancesPath" | "configDir"> {
  return { typesPath: join(configDir, "teams.json"), instancesPath: join(configDir, "team-instances.json"), configDir };
}

export const teamFolderExists = (path: string): boolean => {
  try { return existsSync(path) && statSync(path).isDirectory(); } catch { return false; }
};
