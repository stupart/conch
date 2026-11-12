import { cpus, totalmem } from "node:os";
import { basename } from "node:path";
import {
  budgetOf,
  CpuHistory,
  loadLevel,
  resourceLevel,
  SESSION_THRESHOLDS,
  worse,
  type BudgetSettings,
  type Level,
  type Machine,
  type PublishedBudget,
  type SessionUsage,
} from "./resource-load.ts";

/**
 * The resource ledger: what agent sessions started that is still running, whose it is, how long it was meant to live,
 * and, once that is over, the question to Tyler: Stop, Keep, or Ask later.
 *
 * Tyler, 2026-11-11: "maybe we need like a resource ledger as part of conch so things are linked to the sessions that
 * made them or are using them and we can have less loose ends for things that are meaning to run temporarily." That
 * night his Mac had about twenty dev servers, a headless Chrome two days old, a colima VM six days up at 6 GB, another
 * at 20 GB and three booted simulators, none with a living owner, at a load average of 113, and nobody could say which
 * session had started what or whether it was still needed.
 *
 * How a resource gets its owner, strongest evidence first:
 *  1. **Declared.** `conch resources add` from the session's shell: the owner is the session that ran it, with the
 *     lifetime and the reason it gave.
 *  2. **Tree.** Seen under a live session's process, through a shell (the Bash tool's, or Codex's): remembered by pid
 *     and start time while the session lives, because once it exits its orphans belong to launchd and the ancestry is
 *     gone. A pid that comes round again has another start time, so it is never mistaken for the one remembered.
 *  3. **Environment.** Claude Code puts `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` in every command's environment (2.1.309
 *     does; Codex puts `CODEX_THREAD_ID`), and a process keeps the environment it was started with, through a daemon's
 *     double fork too. Read once per orphan, the keys and nothing else: measured on 2026-11-11, it named the session for
 *     orphaned vite and next dev servers, a python http.server and both colima hostagents, two days after the session.
 *  4. **Command.** A simulator is booted by CoreSimulatorService, so neither tree nor environment can say. A session
 *     process whose command line names the device (`simctl boot <udid>`, `xcodebuild -destination id=…|name=…`) is a
 *     user of it, and its owner when it started no later than the device booted.
 *  5. Otherwise **unowned**: shown as no one's, and never asked about.
 *
 * This module is the model, pure over its inputs; `resource-sampler.ts` reads the Mac and stops things.
 */

// MARK: the process table

/** One process, as one look at the process table gives it. The table may come from anywhere (`ProcessTableSource`). */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Absent when the source doesn't say; then nothing is judged by owner, only by path. */
  uid?: number;
  /** Epoch ms the process started, to the second (`ps lstart`). With the pid, its identity. */
  startedAt: number;
  /** Per cent of one core, as `ps pcpu` reports it (macOS: a decaying average over about a minute). */
  cpu: number;
  /** Resident memory, bytes. */
  rss: number;
  /** Its command line, argv joined with spaces (`ps args`). */
  args: string;
}

export type ProcessTable = readonly ProcessRow[];

/**
 * Where the table comes from. 2026-11-11: another branch is folding the daemon's `ps -Ao` calls into one shared look
 * per interval, so the ledger takes a table rather than spawning its own; until both land, one `ps` of its own
 * (`psProcessTable` in resource-sampler.ts) at most once per sampling interval.
 */
export type ProcessTableSource = () => Promise<ProcessTable | null>;

/** A process's identity: its pid and the second it started. A reused pid has another. */
export function processKey(pid: number, startedAt: number): string {
  return `${pid}@${Math.floor(startedAt / 1000)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `ps -o lstart`: "Wed Nov 11 21:11:24 2026", local time. NaN when it isn't one. */
export function parseLstart(tokens: readonly string[]): number {
  const [, month, day, time, year] = tokens;
  const m = MONTHS.indexOf(month ?? "");
  const [h, min, s] = (time ?? "").split(":").map(Number);
  if (m < 0 || !day || !year || h === undefined || min === undefined || s === undefined) return Number.NaN;
  return new Date(Number(year), m, Number(day), h, min, s).getTime();
}

/** `ps -Ao uid=,pid=,ppid=,pcpu=,rss=,lstart=,args=`, one process a line; lines that don't parse are skipped. */
export function parsePsTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 10) continue;
    const [uid, pid, ppid, cpu, rss] = tokens.slice(0, 5).map(Number);
    const startedAt = parseLstart(tokens.slice(5, 10));
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(startedAt)) continue;
    // The command keeps its own spacing: everything after the five lstart words.
    const args = line.trim().replace(/^(\S+\s+){10}/, "");
    rows.push({ pid: pid!, ppid: ppid!, uid: uid!, cpu: cpu || 0, rss: (rss || 0) * 1024, startedAt, args });
  }
  return rows;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: each listening pid's ports. */
export function parseListenerPorts(text: string): Map<number, number[]> {
  const ports = new Map<number, number[]>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) {
      const port = Number(/:(\d+)$/.exec(line)?.[1]);
      if (!Number.isInteger(port) || port <= 0) continue;
      const list = ports.get(pid) ?? [];
      if (!list.includes(port)) list.push(port);
      ports.set(pid, list.sort((a, b) => a - b));
    }
  }
  return ports;
}

/** `lsof -a -p … -d cwd -Fn`: each pid's working folder. */
export function parseCwds(text: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n/") && pid) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/** What a process's environment says about the session that started it. Only these keys are ever kept. */
export interface SessionEnvironment {
  claudeSessionId?: string;
  claudePid?: number;
  codexThreadId?: string;
}

const ENV_KEYS = /(?:^|\s)(CLAUDE_CODE_SESSION_ID|CLAUDE_PID|CODEX_THREAD_ID)=(\S+)/g;

/**
 * `ps -Eww -o pid=,command= -p …`: each pid's command line with its environment after it. Only the three keys are taken
 * from it; the rest, tokens and all, is never kept or logged. The last of a key wins: the environment follows the
 * arguments, so a command line that happens to mention one comes first.
 */
export function parseSessionEnvironments(text: string): Map<number, SessionEnvironment> {
  const found = new Map<number, SessionEnvironment>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!match) continue;
    const env: SessionEnvironment = {};
    for (const [, key, value] of match[2]!.matchAll(ENV_KEYS)) {
      if (key === "CLAUDE_CODE_SESSION_ID" && /^[0-9a-f-]{8,64}$/i.test(value!)) env.claudeSessionId = value;
      else if (key === "CLAUDE_PID" && /^\d+$/.test(value!)) env.claudePid = Number(value);
      else if (key === "CODEX_THREAD_ID" && /^[\w-]{8,64}$/.test(value!)) env.codexThreadId = value;
    }
    found.set(Number(match[1]), env);
  }
  return found;
}

/** `lsof -a -p <vm pids> -Fn`: which lima instance each Virtualization process runs, from the disk it holds open. */
export function parseLimaInstances(text: string): Map<number, string> {
  const instances = new Map<number, string>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid && !instances.has(pid)) {
      const instance = /\/_lima\/([^/_][^/]*)\//.exec(line)?.[1];
      if (instance) instances.set(pid, instance);
    }
  }
  return instances;
}

// MARK: what a process is

export type ResourceKind = "server" | "browser" | "vm" | "container" | "simulator" | "tmux" | "watcher" | "shell" | "process";

/** Which kinds are worth listing when nothing ties them to a session. A bare shell or process of no one's is noise. */
const UNOWNED_KINDS: ReadonlySet<ResourceKind> = new Set(["server", "browser", "vm", "simulator"]);

/** When several things in one group could name it, the strongest names it. */
const KIND_RANK: Record<ResourceKind, number> = {
  vm: 0, simulator: 1, container: 2, server: 3, browser: 4, tmux: 5, watcher: 6, shell: 7, process: 8,
};

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh"]);

/** The executable's name, from argv[0]: `/bin/zsh` and `-zsh` are both `zsh`. */
export function commandName(args: string): string {
  const first = args.split(/\s/, 1)[0] ?? "";
  return basename(first.replace(/^-/, ""));
}

function isShell(args: string): boolean {
  return SHELLS.has(commandName(args));
}

/** The agents themselves: never a resource, and a boundary a walk up the tree stops at. */
export function isAgentProcess(args: string): boolean {
  const name = commandName(args);
  return name === "claude" || name === "codex";
}

/**
 * An app, a system service or an extension: Tyler's or the system's, never a session's loose end. A tool that only
 * lives inside a bundle is not an app: Xcode's python (`Xcode.app/Contents/Developer/…/Python.app/…`) served an
 * agent's page on 2026-11-11.
 */
export function isSystemOrApp(args: string): boolean {
  if (/^\/(System|usr\/libexec|usr\/sbin|sbin|Library\/Apple|Library\/Developer\/(PrivateFrameworks|CoreSimulator)|private\/var\/run\/com\.apple\.)/.test(args)) return true;
  // The executable's path, which may have spaces ("Application Support/…/FigmaAgent.app"): up to its first option.
  const path = /^\/(?:(?! -).)*/.exec(args)?.[0] ?? "";
  if (/\.app\/Contents\/Developer\//.test(path)) return false;
  return /\.(app|appex|xpc)\/Contents\//.test(path) || /\.framework\//.test(path);
}

/** lima's shared network, which every VM uses: it goes with them, and is never one VM's to stop. */
const SHARED_PLUMBING = /(^|\/)limactl\s+usernet\b/;

const UDID = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/;

/** A headless or remote-driven browser: Playwright's, Puppeteer's, an agent's Chrome. Never its helpers. */
function isDrivenBrowser(args: string): boolean {
  if (/(^|\s)--type=/.test(args)) return false;
  const browser = /(Google Chrome|Chromium|chrome-headless-shell|chromium|Microsoft Edge|Brave Browser|headless_shell)(\s|$|\.app)/.test(args)
    || /ms-playwright\//.test(args);
  return browser && /(^|\s)(--headless|--remote-debugging-port=|--remote-debugging-pipe)/.test(args);
}

/** The lima instance a process belongs to, from a path into `~/.lima` or colima's `_lima`. */
export function limaInstance(args: string): string | undefined {
  return /\/_lima\/([^/_][^/]*)\//.exec(args)?.[1] ?? /\/\.lima\/([^/_][^/]*)\//.exec(args)?.[1];
}

/** colima names its instances `colima` (the default profile) and `colima-<profile>`. */
export function vmFromInstance(instance: string): { tool: "colima" | "lima"; name: string } {
  if (instance === "colima") return { tool: "colima", name: "default" };
  if (instance.startsWith("colima-")) return { tool: "colima", name: instance.slice("colima-".length) };
  return { tool: "lima", name: instance };
}

/** What a server is, in a word a person would use: the framework when the command says, else the program. */
export function serverName(args: string): string {
  if (/next-server|\/next\/dist\/|\bnext (dev|start)\b/.test(args)) return "next";
  for (const tool of ["vite", "astro", "remix", "nuxt", "storybook", "webpack", "wrangler", "expo", "metro", "jekyll", "hugo"]) {
    if (new RegExp(`(^|[/\\s])${tool}(\\s|$|/|\\.)`).test(args)) return tool;
  }
  if (/-m\s+http\.server\b/.test(args)) return "python http.server";
  if (/\brails (s|server)\b/.test(args)) return "rails";
  const name = /^python[\d.]*$|^Python$/.test(commandName(args)) ? "python" : commandName(args);
  if (["node", "bun", "deno", "python", "ruby", "perl"].includes(name)) {
    // The script, not the runtime: `node server.js`, `bun run dev`.
    const script = args.split(/\s+/).slice(1).find((arg) => !arg.startsWith("-"));
    if (script) return `${name} ${basename(script)}`;
  }
  return name;
}

const WATCHER = /(^|\s)--watch(=|\s|$)|(^|[/\s])(nodemon|chokidar|fswatch|watchexec|entr)(\s|$)|(^|[/\s])tsc\s(.*\s)?(-w|--watch)(\s|$)|(^|\s)tail\s+-[fF](\s|$)/;
const CONTAINER = /(^|[/\s])docker(-compose|\s+compose)?\s+(.*\s)?(up|run)(\s|$)/;

/** What one process is, if it is one of the kinds the ledger keeps; `ports` from the listeners. */
export function classifyProcess(row: Pick<ProcessRow, "args">, ports: readonly number[] = []): { kind: ResourceKind; title: string } | null {
  const { args } = row;
  if (/(^|\/)launchd_sim\s/.test(args)) {
    const udid = UDID.exec(args)?.[0];
    return udid ? { kind: "simulator", title: `Simulator ${udid.slice(0, 8)}` } : null;
  }
  if (/(^|\/)limactl\s+hostagent\b/.test(args)) {
    const instance = limaInstance(args) ?? args.trim().split(/\s+/).pop() ?? "lima";
    const vm = vmFromInstance(instance);
    return { kind: "vm", title: vm.tool === "colima" ? `colima ${vm.name}` : `lima ${vm.name}` };
  }
  if (/(^|\/)qemu-system-\S+/.test(args)) return { kind: "vm", title: "qemu VM" };
  if (isDrivenBrowser(args)) {
    const port = /--remote-debugging-port=(\d+)/.exec(args)?.[1];
    return { kind: "browser", title: `headless ${/Chrome|chrome/.test(args) ? "Chrome" : "browser"}${port ? ` :${port}` : ""}` };
  }
  if (ports.length) return { kind: "server", title: `${serverName(args)} ${ports.map((port) => `:${port}`).join(" ")}` };
  if (CONTAINER.test(args) && !/(^|\s)(-d|--detach)(\s|$)/.test(args)) return { kind: "container", title: shortCommand(args, 48) };
  if (commandName(args) === "tmux") {
    const socket = /(?:^|\s)-L\s+(\S+)/.exec(args)?.[1] ?? /(?:^|\s)-S\s+(\S+)/.exec(args)?.[1];
    return { kind: "tmux", title: `tmux${socket ? ` ${basename(socket)}` : ""}` };
  }
  if (WATCHER.test(args)) return { kind: "watcher", title: shortCommand(args, 48) };
  return null;
}

/** A command line short enough for a row: the program by name, then its arguments, cut on a word. */
export function shortCommand(args: string, max = 120): string {
  const [first = "", ...rest] = args.trim().split(/\s+/);
  const text = [basename(first), ...rest].join(" ");
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

/** What a Claude Code Bash tool shell runs, for a background shell's title: the command after its snapshot preamble. */
export function shellCommand(args: string): string {
  const evaled = /eval\s+'((?:[^'\\]|\\.)*)'/.exec(args)?.[1] ?? /eval\s+"((?:[^"\\]|\\.)*)"/.exec(args)?.[1];
  if (evaled) return evaled;
  const dashC = /(?:^|\s)-l?c\s+(.*)$/.exec(args)?.[1];
  return dashC ?? args;
}

// MARK: lifetimes

/** How long a resource was meant to live. */
export type Lifetime =
  /** Until the turn it started in is over. */
  | { kind: "turn"; inferred?: true }
  /** Until its session ends. */
  | { kind: "session"; inferred?: true }
  /** Until a time. */
  | { kind: "until"; until: number; inferred?: true }
  /** Until someone stops it. */
  | { kind: "keep"; inferred?: true };

/** `--until`: turn, session-end (or session), keep, a duration (90s, 30m, 2h, 1d), or a date. */
export function parseLifetime(text: string, now: number): Lifetime | { error: string } {
  const value = text.trim().toLowerCase();
  if (value === "turn" || value === "this-turn") return { kind: "turn" };
  if (value === "session-end" || value === "session") return { kind: "session" };
  if (value === "keep" || value === "forever") return { kind: "keep" };
  const duration = /^(\d+(?:\.\d+)?)\s*(s|m|min|h|d)$/.exec(value);
  if (duration) {
    const unit = { s: 1_000, m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2] as "s" | "m" | "min" | "h" | "d"];
    const ms = Number(duration[1]) * unit;
    if (ms > 0 && ms <= 366 * 86_400_000) return { kind: "until", until: now + ms };
  }
  const date = Date.parse(text.trim());
  if (Number.isFinite(date) && date > now) return { kind: "until", until: date };
  return { error: `--until takes turn, session-end, keep, a duration (30m, 2h, 1d) or a later date, not "${text}"` };
}

/**
 * The lifetime a resource gets when nobody said: until its session ends, whatever it is. A dev server, a watcher, a
 * headless browser or a VM an agent brought up is for that agent's work, and the moment it ends is the moment to ask.
 */
export function inferredLifetime(_kind: ResourceKind): Lifetime {
  return { kind: "session", inferred: true };
}

export function lifetimeText(lifetime: Lifetime, now: number): string {
  switch (lifetime.kind) {
    case "turn": return "for its turn";
    case "session": return "until its session ends";
    case "keep": return "kept";
    case "until": return lifetime.until > now ? `until ${new Date(lifetime.until).toLocaleString()}` : "its time is up";
  }
}

// MARK: sessions

/** A live session, as the ledger needs it. */
export interface LedgerSession {
  /** conch's row id (a window key when two windows share an id). */
  sessionId: string;
  /** The agent's own id: what `CLAUDE_CODE_SESSION_ID` and `CODEX_THREAD_ID` name. */
  agentSessionId?: string;
  /** Its processes: the window's and, for a background job, the job's own. */
  pids: readonly number[];
  label: string;
  /** "busy" while it works on a turn (Claude Code's registry word); anything else, between turns. */
  status?: string;
  statusUpdatedAt?: number;
  /** The session that started this one, when one did (`withStartedBy`). */
  startedBySessionId?: string;
}

const agentId = (session: Pick<LedgerSession, "sessionId" | "agentSessionId">) => session.agentSessionId ?? session.sessionId;
const hasSession = (env: SessionEnvironment | undefined) => Boolean(env?.claudeSessionId || env?.codexThreadId);
/** Claude Code's registry says "busy" while a turn runs and "shell" while its Bash tool does; Codex's rows, "working". */
const working = (status: string | undefined) => status === "busy" || status === "shell" || status === "working";

export interface ResourceOwner {
  /** The agent's own session id: the one that outlives a window. */
  agentSessionId: string;
  /** The row it was on when conch last saw it live, if it did. */
  sessionId?: string;
  label: string;
  how: "declared" | "tree" | "environment" | "command";
}

// MARK: evidence the sampler fetches

/** What the ledger wants read before it can judge a sample: each read once per process, never again. */
export interface EvidenceWanted {
  /** Orphans' environments (`parseSessionEnvironments`). */
  environment: number[];
  /** Virtualization processes' open files, for which VM each runs (`parseLimaInstances`). */
  vmFiles: number[];
  /** New resources' working folders. */
  cwd: number[];
  /** Booted simulators whose names the ledger doesn't have. */
  simulators: string[];
}

export interface Evidence {
  /** Every listening TCP port, by pid; null when it couldn't be read this time, and the last answer stands. */
  listeners: ReadonlyMap<number, readonly number[]> | null;
  environment: ReadonlyMap<number, SessionEnvironment>;
  vmInstances: ReadonlyMap<number, string>;
  cwds: ReadonlyMap<number, string>;
  simulatorNames: ReadonlyMap<string, string>;
  /**
   * A process's memory as Activity Monitor counts it (its physical footprint), when it can be read; else its resident
   * size. Summed resident sizes count shared pages once per process: a simulator's ninety processes "used" 32 GB.
   */
  memoryOf?(row: ProcessRow): number;
}

// MARK: the persisted memory

export interface Declaration {
  owner: ResourceOwner;
  lifetime: Lifetime;
  why?: string;
  at: number;
}

export type Decision = { kind: "keep"; at: number } | { kind: "later"; at: number; until: number };

/** What survives a daemon restart: what conch learned that the Mac can't tell it again. */
export interface LedgerMemory {
  v: 1;
  /** When conch first looked: a process older than this, with nothing tying it to a session, was here before. */
  firstSampleAt?: number;
  /**
   * Owners learned from the tree, by process identity, kept while the process lives: only a resource's own processes,
   * so the file changes when the resources do, not with every command an agent runs.
   */
  owners: Record<string, ResourceOwner>;
  /** Each owner's name while it was live, so a row can still say whose it was once it is gone. */
  labels: Record<string, string>;
  /**
   * Owners that have ended (gone from two whole registry reads), by agent session id: when conch last saw each live,
   * the nearest it can say to when it ended, or 0 for one it never saw live.
   */
  ended: Record<string, number>;
  /** By resource identity (`identity` below). */
  declarations: Record<string, Declaration>;
  decisions: Record<string, Decision>;
  /** Sessions that named a simulator, by the device's identity: the first one, and when its command started. */
  simulatorTouches: Record<string, { owner: ResourceOwner; startedAt: number; users: string[] }>;
  /** Resources Tyler held (SIGSTOP), by identity, and when: a restart must still say they are paused. */
  held: Record<string, number>;
  /** Resources in the background band (`taskpolicy -b`), by identity: by Tyler, or by `agent-auto-background`. */
  lowered: Record<string, { at: number; by: "you" | "auto" }>;
  /** Sessions whose processes Tyler moved to the background band, by agent session id. */
  loweredSessions: Record<string, number>;
}

export function emptyLedgerMemory(): LedgerMemory {
  return { v: 1, owners: {}, labels: {}, ended: {}, declarations: {}, decisions: {}, simulatorTouches: {}, held: {}, lowered: {}, loweredSessions: {} };
}

/** A memory file read back: anything that isn't one is a fresh start, never an error. */
export function decodeLedgerMemory(value: unknown): LedgerMemory {
  const fresh = emptyLedgerMemory();
  if (!value || typeof value !== "object" || (value as { v?: unknown }).v !== 1) return fresh;
  const raw = value as Partial<LedgerMemory>;
  const record = <T>(field: unknown): Record<string, T> => (field && typeof field === "object" && !Array.isArray(field) ? field as Record<string, T> : {});
  return {
    v: 1,
    ...(typeof raw.firstSampleAt === "number" ? { firstSampleAt: raw.firstSampleAt } : {}),
    owners: record(raw.owners),
    labels: record(raw.labels),
    ended: record(raw.ended),
    declarations: record(raw.declarations),
    decisions: record(raw.decisions),
    simulatorTouches: record(raw.simulatorTouches),
    held: record(raw.held),
    lowered: record(raw.lowered),
    loweredSessions: record(raw.loweredSessions),
  };
}

// MARK: entries

/** One resource as the ledger holds it after a sample. */
export interface ResourceEntry {
  /** Short and typeable: `p<pid>` for a process group, `sim-<udid8>`, `vm-<name>`. */
  id: string;
  /** Its identity across samples and restarts: the anchor's process key, or the device's or VM's with its boot. */
  identity: string;
  kind: ResourceKind;
  title: string;
  /** The process it is named for, and the top of its group (what a stop signals, with everything under it). */
  anchor: { pid: number; startedAt: number };
  root: { pid: number; startedAt: number };
  startedAt: number;
  firstSeenAt: number;
  /** Every process in it this sample, by identity: the top of its group and everything under it. */
  members: string[];
  /** A VM's processes outside its group (its Virtualization process, its ssh mux), by identity. */
  extras: string[];
  cpu: number;
  rss: number;
  ports: number[];
  command: string;
  cwd?: string;
  udid?: string;
  vm?: { tool: "colima" | "lima"; name: string };
  owner?: ResourceOwner;
  /** Sessions seen using it that didn't start it (a simulator an agent's build ran on). */
  users: string[];
  lifetime?: Lifetime;
  why?: string;
  declaredAt?: number;
  /** Already running when conch first looked, with nothing tying it to a session. */
  preexisting?: true;
  /** How many samples running have seen it: one sample is a command, not yet a resource. */
  seen: number;
}

/** The ledger's state of a resource, as the apps show it. */
export type ResourceState =
  /** Running within its lifetime. */
  | "running"
  /** Its lifetime is over: conch asks. */
  | "asking"
  | "kept"
  /** Asked, and told to ask later. */
  | "later"
  | "stopping"
  | "unowned";

export interface PublishedResource {
  id: string;
  kind: ResourceKind;
  title: string;
  command: string;
  cwd?: string;
  ports?: number[];
  /** `key`: the agent's session id, as `sessions[].key` names it. */
  owner?: { key: string; sessionId?: string; label: string; live: boolean; how: ResourceOwner["how"]; endedAt?: number };
  users?: string[];
  startedAt: number;
  /** Per cent of one core, summed over its processes. */
  cpu: number;
  /** Resident bytes, summed over its processes. */
  memory: number;
  lifetime?: { kind: Lifetime["kind"]; until?: number; inferred?: true };
  why?: string;
  state: ResourceState;
  /** Why it is asking, or what its state means, in a few words. */
  reason?: string;
  /** For `later`: when it asks again. */
  asksAgainAt?: number;
  preexisting?: true;
  /** Green, yellow or red (resource-load.ts `resourceLevel`), and why. */
  level: Level;
  levelReasons?: string[];
  /** Its CPU, the mean over the last five minutes, once there are enough looks to say. */
  cpuSustained?: number;
  /** Paused (SIGSTOP) by Tyler. */
  held?: true;
  /** In the background band (`taskpolicy -b`): by Tyler, or by `agent-auto-background`. */
  lowered?: "you" | "auto";
}

export interface PublishedResources {
  v: 1;
  /** When the Mac was last looked at. */
  sampledAt: number;
  /** How many are asking, for a badge. */
  asking: number;
  items: PublishedResource[];
  /** What each session uses, its own processes and what it left running, and everything unowned; heaviest first. */
  sessions: SessionUsage[];
  /** Agents' usage against the budget (`agent-budget-cpu`, `agent-budget-memory`). */
  budget: PublishedBudget;
}

/** How long a resource shows as stopping after a stop that said it worked. */
const STOPPING_MS = 3 * 60_000;
/** How long "Ask later" waits. */
export const ASK_LATER_MS = 4 * 60 * 60_000;
/** A session gone from two whole registry reads in a row has ended; one could be a resume in flight. */
const ENDED_AFTER_MISSES = 2;

/**
 * Tyler's word on a resource: stop it, keep it, ask later; hold it (SIGSTOP) or let it go on (SIGCONT); move it to the
 * background band (`taskpolicy -b`) or back (`-B`). Every one only ever on his action, but for `agent-auto-background`.
 */
export type ResourceAction = "stop" | "keep" | "later" | "hold" | "resume" | "lower" | "restore";
export const RESOURCE_ACTIONS: readonly ResourceAction[] = ["stop", "keep", "later", "hold", "resume", "lower", "restore"];
/** The kinds that are a process group conch can pause or reprioritise; a VM or a simulator is stopped, never held. */
export const PROCESS_KINDS: ReadonlySet<ResourceKind> = new Set(["server", "browser", "container", "tmux", "watcher", "shell", "process"]);

// MARK: the forest: one sample's tree, walked once

interface Placement {
  /** The live session it runs under, when it does. */
  session?: LedgerSession;
  /** Its path down from the session passes through a shell: a command an agent ran, not its own MCP server. */
  viaShell: boolean;
  /** An agent process conch has no row for (a Codex app-server, a session conch doesn't know): its environment decides. */
  underAgent: boolean;
  /** Its walk reached launchd through nothing but its own: an orphan, or a daemon. */
  orphan: boolean;
  /** Its walk hit something that is not a session's: an app, a terminal's login, another user's process, conch. */
  foreign: boolean;
  /** The top of its group: the highest process above it that is still part of what was started. */
  root: ProcessRow;
}

export class ProcessForest {
  readonly byPid = new Map<number, ProcessRow>();
  readonly children = new Map<number, ProcessRow[]>();
  private readonly sessionByPid = new Map<number, LedgerSession>();
  private readonly placements = new Map<number, Placement | null>();
  /** Processes that have a live session under them: what hosts a session is never one of its resources. */
  private readonly hostsSession = new Set<number>();

  constructor(
    readonly table: ProcessTable,
    readonly sessions: readonly LedgerSession[],
    /** conch's own processes (the daemon, the app hosting it): nothing under them is anyone's resource. */
    private readonly ownPids: ReadonlySet<number> = new Set(),
    private readonly uid?: number,
  ) {
    for (const row of table) this.byPid.set(row.pid, row);
    for (const row of table) {
      const list = this.children.get(row.ppid) ?? [];
      list.push(row);
      this.children.set(row.ppid, list);
    }
    for (const session of sessions) for (const pid of session.pids) if (pid > 1) this.sessionByPid.set(pid, session);
    for (const pid of this.sessionByPid.keys()) {
      // Bounded, so a table read mid-fork can never walk in a circle.
      for (let up = this.byPid.get(pid)?.ppid, hops = 0; up && up > 1 && hops < 64; up = this.byPid.get(up)?.ppid, hops += 1) {
        this.hostsSession.add(up);
      }
    }
  }

  sessionAt(pid: number): LedgerSession | undefined {
    return this.sessionByPid.get(pid);
  }

  /** Not ours to judge at all: a session, an agent, conch, another user's, or something hosting a session. */
  private outOfScope(row: ProcessRow): boolean {
    return this.sessionByPid.has(row.pid) || this.ownPids.has(row.pid) || this.hostsSession.has(row.pid)
      || isAgentProcess(row.args) || (this.uid !== undefined && row.uid !== undefined && row.uid !== this.uid);
  }

  /** Where a process sits; null when it is out of scope. */
  place(pid: number): Placement | null {
    if (this.placements.has(pid)) return this.placements.get(pid)!;
    const row = this.byPid.get(pid);
    let placement: Placement | null = null;
    if (row && !this.outOfScope(row)) {
      let root = row;
      let viaShell = isShell(row.args);
      let up = this.byPid.get(row.ppid);
      let hops = 0;
      placement = { viaShell, underAgent: false, orphan: false, foreign: false, root };
      while (hops < 64) {
        hops += 1;
        if (!up || up.pid <= 1) {
          // launchd, or a parent the table doesn't have (gone mid-read): the group is what was walked.
          placement = { viaShell, underAgent: false, orphan: root.ppid <= 1, foreign: root.ppid > 1, root };
          break;
        }
        const session = this.sessionByPid.get(up.pid);
        if (session) {
          placement = { session, viaShell, underAgent: false, orphan: false, foreign: false, root };
          break;
        }
        if (isAgentProcess(up.args)) {
          placement = { viaShell, underAgent: true, orphan: false, foreign: false, root };
          break;
        }
        if (this.ownPids.has(up.pid) || isSystemOrApp(up.args) || (this.uid !== undefined && up.uid !== undefined && up.uid !== this.uid)
          || commandName(up.args) === "login" || commandName(up.args) === "sshd") {
          placement = { viaShell, underAgent: false, orphan: false, foreign: true, root };
          break;
        }
        root = up;
        viaShell ||= isShell(up.args);
        up = this.byPid.get(up.ppid);
      }
    }
    this.placements.set(pid, placement);
    return placement;
  }

  /**
   * Everything under a process, but never into another agent: a session a shell started is its own, with everything
   * under it, so a stop, a hold or a sum over one group never reaches into it.
   */
  descendants(pid: number): ProcessRow[] {
    const found: ProcessRow[] = [];
    const queue = [...(this.children.get(pid) ?? [])];
    const seen = new Set<number>([pid]);
    while (queue.length && found.length < 4096) {
      const next = queue.shift()!;
      if (seen.has(next.pid)) continue;
      seen.add(next.pid);
      if (this.sessionByPid.has(next.pid) || isAgentProcess(next.args)) continue;
      found.push(next);
      queue.push(...(this.children.get(next.pid) ?? []));
    }
    return found;
  }
}

// MARK: the ledger

export interface ResourceLedgerOptions {
  memory?: LedgerMemory;
  /** The budget's settings, read at each look (live settings). Absent: the settings' defaults, 75% of the cores, 60% of the memory, nothing automatic. */
  budget?(): BudgetSettings;
  /** This Mac's cores and memory. */
  machine?: Machine;
  /** A session's name when conch never saw it live (the daemon reads its transcript's title); asked once per session. */
  labelFor?(agentSessionId: string): string | undefined;
}

/**
 * The ledger itself. `wanted` says what to read, `observe` takes a sample with what was read, `published` is what the
 * apps draw. Holds no timers and reads nothing: the sampler does both.
 */
export class ResourceLedger {
  memory: LedgerMemory;
  private entries = new Map<string, ResourceEntry>();
  /** Every process seen under a live session through a shell, by identity; the resources' own go to `memory.owners`. */
  private treeOwners = new Map<string, ResourceOwner>();
  private environments = new Map<string, SessionEnvironment>();
  private vmInstances = new Map<string, string>();
  private cwds = new Map<string, string>();
  private simulatorNames = new Map<string, string>();
  private listeners = new Map<number, readonly number[]>();
  /** The last look's processes: an environment is read only for one that has lived through a look, never a passing command. */
  private previousKeys = new Set<string>();
  private misses = new Map<string, number>();
  /** When each owner was last seen live. Not in the memory file: it would change every look. */
  private lastLive = new Map<string, number>();
  private stopping = new Map<string, { at: number; error?: string }>();
  private live: LedgerSession[] = [];
  private sampledAt = 0;
  private readonly labelFor?: (agentSessionId: string) => string | undefined;
  private readonly budgetSettings: () => BudgetSettings;
  private readonly machine: Machine;
  private readonly history = new CpuHistory();
  /** What each owner used at the last look, before levels (`published` adds them). */
  private usage: Array<Omit<SessionUsage, "cpu" | "sustained" | "level" | "reasons"> & { cpuNow: number }> = [];

  constructor(options: ResourceLedgerOptions = {}) {
    this.memory = options.memory ?? emptyLedgerMemory();
    for (const [key, owner] of Object.entries(this.memory.owners)) this.treeOwners.set(key, owner);
    this.labelFor = options.labelFor;
    this.budgetSettings = options.budget ?? (() => ({ cpu: "75%", memory: "60%", autoBackground: false }));
    this.machine = options.machine ?? { cores: Math.max(1, cpus().length), memory: totalmem() };
  }

  /** What a sample's evidence should include for this forest: each thing read once in a process's life. */
  wanted(forest: ProcessForest): EvidenceWanted {
    const environment = new Set<number>();
    const vmFiles: number[] = [];
    const simulators = new Set<string>();
    for (const row of forest.table) {
      const key = processKey(row.pid, row.startedAt);
      if (/com\.apple\.Virtualization\.VirtualMachine/.test(row.args)) {
        if (!this.vmInstances.has(key)) vmFiles.push(row.pid);
        continue;
      }
      if (/(^|\/)launchd_sim\s/.test(row.args)) {
        const udid = UDID.exec(row.args)?.[0];
        if (udid && !this.simulatorNames.has(udid)) simulators.add(udid);
        continue;
      }
      const placement = forest.place(row.pid);
      if (!placement || placement.session || placement.foreign) continue;
      // An orphan's group, or one under an agent conch has no row for: its environment names the session. The top of
      // the group first; then, when that says nothing, what in it is a resource. A Bash tool's shell is started
      // without the session's id, which its own snapshot exports (2.1.309): the shell says nothing, its vite does.
      // Only for what has lived through a look (a passing `sleep 5` is never read), and never a simulator's own
      // processes, which CoreSimulator starts: measured 2026-11-11, those were 500 reads in one look.
      const root = placement.root;
      const rootKey = processKey(root.pid, root.startedAt);
      if (!this.previousKeys.has(rootKey) || /(^|\/)launchd_sim\s/.test(root.args)) continue;
      if (this.treeOwners.has(rootKey) || (isSystemOrApp(root.args) && !isDrivenBrowser(root.args))) continue;
      if (!this.environments.has(rootKey)) {
        environment.add(root.pid);
        continue;
      }
      if (row.pid === root.pid || hasSession(this.environments.get(rootKey))) continue;
      if (!this.previousKeys.has(key) || this.environments.has(key) || this.treeOwners.has(key) || isSystemOrApp(row.args)) continue;
      if (classifyProcess(row, this.listeners.get(row.pid)) || (isShell(root.args) && row.ppid === root.pid)) environment.add(row.pid);
    }
    const cwd: number[] = [];
    // A folder for what is listed (seen twice), not for every command passing through a session's shell.
    for (const entry of this.entries.values()) {
      const key = processKey(entry.root.pid, entry.root.startedAt);
      if (entry.seen >= 2 && !this.cwds.has(key) && entry.kind !== "vm" && entry.kind !== "simulator") cwd.push(entry.anchor.pid);
    }
    return { environment: [...environment], vmFiles, cwd, simulators: [...simulators] };
  }

  /**
   * Take one sample. `complete`: the registry read was whole, so a session missing from it may have ended. Returns
   * whether anything the apps show changed.
   */
  observe(forest: ProcessForest, evidence: Evidence, now: number, complete: boolean): boolean {
    const before = this.signature(now);
    this.sampledAt = now;
    this.memory.firstSampleAt ??= now;
    this.live = [...forest.sessions];
    for (const session of forest.sessions) {
      if (this.memory.labels[agentId(session)] !== session.label) this.memory.labels[agentId(session)] = session.label;
      this.lastLive.set(agentId(session), now);
    }
    if (evidence.listeners) this.listeners = new Map(evidence.listeners);
    for (const [pid, env] of evidence.environment) {
      const row = forest.byPid.get(pid);
      if (row) this.environments.set(processKey(pid, row.startedAt), env);
    }
    for (const [pid, instance] of evidence.vmInstances) {
      const row = forest.byPid.get(pid);
      if (row) this.vmInstances.set(processKey(pid, row.startedAt), instance);
    }
    for (const [udid, name] of evidence.simulatorNames) this.simulatorNames.set(udid, name);

    this.rememberTreeOwners(forest);
    this.rememberSimulatorTouches(forest);
    this.noteEndedOwners(forest.sessions, now, complete);

    // One footprint read per process a look, whoever asks for it.
    const footprints = new Map<number, number>();
    const memoryOf = (row: ProcessRow): number => {
      let bytes = footprints.get(row.pid);
      if (bytes === undefined) footprints.set(row.pid, bytes = evidence.memoryOf?.(row) ?? row.rss);
      return bytes;
    };
    const next = this.buildEntries(forest, now, memoryOf);
    for (const [pid, folder] of evidence.cwds) {
      const entry = [...next.values()].find((each) => each.anchor.pid === pid);
      if (entry) this.cwds.set(processKey(entry.root.pid, entry.root.startedAt), folder);
    }
    for (const entry of next.values()) {
      const folder = this.cwds.get(processKey(entry.root.pid, entry.root.startedAt));
      if (folder) entry.cwd = folder; // "" is asked and not answered: never asked again
    }
    this.entries = next;
    // The resources' own owners are what a restart must not forget.
    const owners: Record<string, ResourceOwner> = {};
    for (const entry of next.values()) {
      for (const key of entry.members) {
        const owner = this.treeOwners.get(key);
        if (owner) owners[key] = owner;
      }
    }
    this.memory.owners = owners;
    this.measure(forest, now, memoryOf);
    this.previousKeys = new Set(forest.table.map((row) => processKey(row.pid, row.startedAt)));
    this.prune(forest);
    return this.signature(now) !== before;
  }

  /**
   * What the apps would draw, coarsely: CPU to five points and memory to 64 MB, so a sample that only moved the
   * numbers a little doesn't rewrite the sessions file.
   */
  private signature(now: number): string {
    return JSON.stringify(this.published(now).items.map((item) => ({
      ...item, cpu: Math.round(item.cpu / 5), memory: Math.round(item.memory / (64 * 1024 ** 2)),
    })));
  }

  /** Every process under a live session through a shell, remembered by identity while it lives. */
  private rememberTreeOwners(forest: ProcessForest): void {
    for (const row of forest.table) {
      const placement = forest.place(row.pid);
      if (!placement?.session || !placement.viaShell) continue;
      const key = processKey(row.pid, row.startedAt);
      if (!this.treeOwners.has(key)) this.treeOwners.set(key, this.ownerOf(placement.session, "tree"));
    }
  }

  private rememberSimulatorTouches(forest: ProcessForest): void {
    const booted = forest.table.flatMap((row) => {
      if (!/(^|\/)launchd_sim\s/.test(row.args)) return [];
      const udid = UDID.exec(row.args)?.[0];
      return udid ? [{ udid, row }] : [];
    });
    if (!booted.length) return;
    for (const row of forest.table) {
      const placement = forest.place(row.pid);
      if (!placement?.session || !placement.viaShell) continue;
      for (const { udid, row: sim } of booted) {
        const name = this.simulatorNames.get(udid);
        const names = row.args.includes(udid)
          || (name !== undefined && new RegExp(`name=${escapeRegExp(name)}(?=[,'"\\s]|$)`).test(row.args));
        if (!names) continue;
        const identity = `sim:${udid}@${Math.floor(sim.startedAt / 1000)}`;
        const touch = this.memory.simulatorTouches[identity];
        const owner = this.ownerOf(placement.session, "command");
        if (!touch) this.memory.simulatorTouches[identity] = { owner, startedAt: row.startedAt, users: [owner.agentSessionId] };
        else if (!touch.users.includes(owner.agentSessionId)) touch.users.push(owner.agentSessionId);
      }
    }
  }

  /** A session gone from two whole reads in a row has ended; seen again (a resume keeps its id), it hasn't. */
  private noteEndedOwners(sessions: readonly LedgerSession[], now: number, complete: boolean): void {
    const liveIds = new Set(sessions.map(agentId));
    for (const id of liveIds) {
      this.misses.delete(id);
      delete this.memory.ended[id];
    }
    if (!complete) return;
    for (const entry of this.entries.values()) {
      const id = entry.owner?.agentSessionId;
      if (!id || liveIds.has(id) || id in this.memory.ended) continue;
      const missed = (this.misses.get(id) ?? 0) + 1;
      this.misses.set(id, missed);
      if (missed >= ENDED_AFTER_MISSES) this.memory.ended[id] = this.lastLive.get(id) ?? 0;
    }
  }

  private ownerOf(session: LedgerSession, how: ResourceOwner["how"]): ResourceOwner {
    return { agentSessionId: agentId(session), sessionId: session.sessionId, label: session.label, how };
  }

  /** A session named by its agent id: the live one if it is, else what conch remembers of it. */
  private ownerById(id: string, how: ResourceOwner["how"], preferPid?: number): ResourceOwner {
    const live = this.live.filter((session) => agentId(session) === id || session.sessionId === id);
    const session = live.find((each) => preferPid !== undefined && each.pids.includes(preferPid)) ?? live[0];
    if (session) return this.ownerOf(session, how);
    let label = this.memory.labels[id];
    if (!label && this.labelFor) {
      label = this.labelFor(id) ?? `session ${id.slice(0, 8)}`;
      this.memory.labels[id] = label;
    }
    return { agentSessionId: id, label: label ?? `session ${id.slice(0, 8)}`, how };
  }

  /** What a process's environment says, as an owner: the nearer agent when it names both (one started the other). */
  private ownerFromEnvironment(env: SessionEnvironment | undefined): ResourceOwner | undefined {
    if (!env) return undefined;
    const claude = env.claudeSessionId;
    const codex = env.codexThreadId;
    if (claude && codex) {
      const started = (child: string, parent: string) => this.live.some((session) => agentId(session) === child
        && this.live.some((other) => other.sessionId === session.startedBySessionId && agentId(other) === parent));
      // A Codex Claude started inherits Claude's id and adds its own; a Claude Codex started, the other way round.
      return this.ownerById(started(claude, codex) ? claude : codex, "environment", env.claudePid);
    }
    if (claude) return this.ownerById(claude, "environment", env.claudePid);
    if (codex) return this.ownerById(codex, "environment");
    return undefined;
  }

  /**
   * What each owner uses this look: a live session's own process and everything under it (its MCP servers, the commands
   * it runs, what runs in its tree), then whatever it left running outside it; an ended session's leftovers; everything
   * unowned. Each process counted once, for the nearest session: a Codex that Claude started is the Codex's.
   */
  private measure(forest: ProcessForest, now: number, memoryOf: (row: ProcessRow) => number): void {
    const counted = new Set<string>();
    const usage = new Map<string, { sessionId?: string; label: string; live: boolean; cpuNow: number; memory: number; resources: number }>();
    const add = (key: string, base: { sessionId?: string; label: string; live: boolean }, rows: readonly ProcessRow[], resources = 0) => {
      const owner = usage.get(key) ?? { ...base, cpuNow: 0, memory: 0, resources: 0 };
      for (const row of rows) {
        const processId = processKey(row.pid, row.startedAt);
        if (counted.has(processId)) continue;
        counted.add(processId);
        owner.cpuNow += row.cpu;
        owner.memory += memoryOf(row);
      }
      owner.resources += resources;
      usage.set(key, owner);
    };
    const depth = (pid: number) => {
      let hops = 0;
      for (let up = forest.byPid.get(pid)?.ppid; up && up > 1 && hops < 64; up = forest.byPid.get(up)?.ppid) hops += 1;
      return hops;
    };
    // Deepest first, so a session another started keeps its own tree.
    const sessions = [...forest.sessions].sort((a, b) => Math.max(...b.pids.map(depth), 0) - Math.max(...a.pids.map(depth), 0));
    for (const session of sessions) {
      const rows = session.pids.flatMap((pid) => {
        const row = forest.byPid.get(pid);
        return row ? [row, ...forest.descendants(pid)] : [];
      });
      add(agentId(session), { sessionId: session.sessionId, label: session.label, live: true }, rows);
    }
    const byKey = new Map(forest.table.map((row) => [processKey(row.pid, row.startedAt), row]));
    for (const entry of this.entries.values()) {
      if (entry.seen < 2 && entry.declaredAt === undefined) continue;
      const rows = [...entry.members, ...entry.extras].flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : []));
      const live = this.liveOwner(entry.owner);
      add(
        entry.owner?.agentSessionId ?? "unowned",
        entry.owner ? { ...(live ? { sessionId: live.sessionId } : {}), label: entry.owner.label, live: Boolean(live) } : { label: "Unowned", live: false },
        rows,
        1,
      );
    }
    const seenKeys = new Set<string>();
    let total = 0;
    for (const [key, owner] of usage) {
      this.history.record(`session:${key}`, now, owner.cpuNow);
      seenKeys.add(`session:${key}`);
      if (key !== "unowned") total += owner.cpuNow;
    }
    for (const entry of this.entries.values()) {
      this.history.record(entry.identity, now, entry.cpu);
      seenKeys.add(entry.identity);
    }
    this.history.record("budget", now, total);
    seenKeys.add("budget");
    this.history.keep(seenKeys);
    this.usage = [...usage].map(([key, owner]) => ({ key, ...owner }));
  }

  private buildEntries(forest: ProcessForest, now: number, memoryOf?: (row: ProcessRow) => number): Map<string, ResourceEntry> {
    type Candidate = { row: ProcessRow; kind: ResourceKind; title: string; placement: Placement };
    const groups = new Map<number, Candidate[]>();
    const add = (candidate: Candidate) => {
      const list = groups.get(candidate.placement.root.pid) ?? [];
      list.push(candidate);
      groups.set(candidate.placement.root.pid, list);
    };
    const vmExtras = new Map<string, ProcessRow[]>();
    const declaredKeys = new Set(Object.keys(this.memory.declarations).filter((key) => /^\d+@\d+$/.test(key)));

    for (const row of forest.table) {
      const key = processKey(row.pid, row.startedAt);
      // A VM's memory is in macOS's Virtualization process, and its ssh in a mux of its own: both join the VM.
      if (/com\.apple\.Virtualization\.VirtualMachine/.test(row.args)) {
        const instance = this.vmInstances.get(key);
        if (instance) vmExtras.set(instance, [...(vmExtras.get(instance) ?? []), row]);
        continue;
      }
      if (/^ssh: \S*\/_lima\//.test(row.args)) {
        const instance = limaInstance(row.args);
        if (instance) vmExtras.set(instance, [...(vmExtras.get(instance) ?? []), row]);
        continue;
      }
      const placement = forest.place(row.pid);
      if (!placement || placement.foreign) continue;
      if (placement.session && !placement.viaShell) continue;
      if (SHARED_PLUMBING.test(row.args)) continue;
      // An app's own server (a design tool's local port) is the app's; a driven browser is an agent's.
      if (isSystemOrApp(row.args) && !isDrivenBrowser(row.args)) continue;
      const found = classifyProcess(row, this.listeners.get(row.pid));
      if (found) add({ row, ...found, placement });
      else if (declaredKeys.has(key)) add({ row, kind: "process", title: serverName(row.args), placement });
      else if (placement.orphan && row.pid === placement.root.pid) {
        // An orphan with nothing more specific to say: listed when something ties it to a session (below).
        add({ row, kind: isShell(row.args) ? "shell" : "process", title: isShell(row.args) ? shortCommand(shellCommand(row.args), 48) : serverName(row.args), placement });
      }
    }

    const next = new Map<string, ResourceEntry>();
    for (const [rootPid, candidates] of groups) {
      candidates.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.row.startedAt - b.row.startedAt);
      const best = candidates[0]!;
      const root = forest.byPid.get(rootPid) ?? best.placement.root;
      const members = [root, ...forest.descendants(root.pid)];
      const memberKeys = members.map((member) => processKey(member.pid, member.startedAt));
      const udid = best.kind === "simulator" ? UDID.exec(best.row.args)?.[0] : undefined;
      const instance = best.kind === "vm" ? limaInstance(best.row.args) ?? best.row.args.trim().split(/\s+/).pop() : undefined;
      const extras = instance ? vmExtras.get(instance) ?? [] : [];
      const identity = udid ? `sim:${udid}@${Math.floor(best.row.startedAt / 1000)}`
        : instance ? `vm:${instance}@${Math.floor(best.row.startedAt / 1000)}`
          : processKey(best.row.pid, best.row.startedAt);

      // The owner, strongest evidence first (the module comment).
      const declaration = this.memory.declarations[identity]
        ?? memberKeys.map((key) => this.memory.declarations[key]).find(Boolean);
      const treeOwner = best.placement.session && best.placement.viaShell ? this.ownerOf(best.placement.session, "tree")
        : memberKeys.map((key) => this.treeOwners.get(key)).find(Boolean);
      const envOwner = treeOwner ? undefined : this.ownerFromEnvironment(
        [processKey(root.pid, root.startedAt), processKey(best.row.pid, best.row.startedAt), ...memberKeys]
          .map((key) => this.environments.get(key)).find(hasSession),
      );
      const touch = udid ? this.memory.simulatorTouches[identity] : undefined;
      // Booted no earlier than ten seconds before the command that named it started: that command started it.
      const commandOwner = touch && touch.startedAt <= best.row.startedAt + 10_000 ? touch.owner : undefined;
      const owner = declaration?.owner ?? treeOwner ?? envOwner ?? commandOwner;
      if (!owner && !UNOWNED_KINDS.has(best.kind)) continue;
      // A live owner's name, as it reads now, over the one remembered.
      const current = owner ? this.ownerById(owner.agentSessionId, owner.how) : undefined;
      const resolvedOwner = owner && current ? { ...owner, label: current.label, ...(current.sessionId ? { sessionId: current.sessionId } : {}) } : owner;

      const all = [...members, ...extras];
      const ports = [...new Set(members.flatMap((member) => this.listeners.get(member.pid) ?? []))].sort((a, b) => a - b);
      const previous = this.entries.get(identity);
      const id = udid ? `sim-${udid.slice(0, 8).toLowerCase()}` : instance ? `vm-${vmFromInstance(instance).name}` : `p${best.row.pid}`;
      let title = best.title;
      if (udid) title = this.simulatorNames.get(udid) ? `${this.simulatorNames.get(udid)} simulator` : best.title;
      else if (best.kind === "server" && ports.length) title = `${serverName(best.row.args)} ${ports.map((port) => `:${port}`).join(" ")}`;
      const users = touch?.users.filter((user) => user !== resolvedOwner?.agentSessionId)
        .map((user) => this.ownerById(user, "command").label) ?? [];
      const firstSampleAt = this.memory.firstSampleAt ?? now;
      next.set(identity, {
        id,
        identity,
        kind: best.kind,
        title,
        anchor: { pid: best.row.pid, startedAt: best.row.startedAt },
        root: { pid: root.pid, startedAt: root.startedAt },
        startedAt: Math.min(best.row.startedAt, root.startedAt),
        firstSeenAt: previous?.firstSeenAt ?? now,
        members: memberKeys,
        extras: extras.map((row) => processKey(row.pid, row.startedAt)),
        cpu: all.reduce((sum, member) => sum + member.cpu, 0),
        rss: all.reduce((sum, member) => sum + (memoryOf?.(member) ?? member.rss), 0),
        ports,
        command: shortCommand(best.kind === "shell" ? shellCommand(best.row.args) : best.row.args),
        ...(udid ? { udid } : {}),
        ...(instance ? { vm: vmFromInstance(instance) } : {}),
        ...(resolvedOwner ? { owner: resolvedOwner } : {}),
        users,
        ...(declaration ? { lifetime: declaration.lifetime, declaredAt: declaration.at, ...(declaration.why ? { why: declaration.why } : {}) }
          : resolvedOwner ? { lifetime: inferredLifetime(best.kind) } : {}),
        ...(!resolvedOwner && root.startedAt < firstSampleAt ? { preexisting: true as const } : {}),
        seen: (previous?.seen ?? 0) + 1,
      });
    }
    return next;
  }

  /** Forget what belongs to processes that are gone. Only from a table that was read, so a failed read forgets nothing. */
  private prune(forest: ProcessForest): void {
    const alive = new Set(forest.table.map((row) => processKey(row.pid, row.startedAt)));
    const identities = new Set([...this.entries.keys()]);
    for (const key of this.treeOwners.keys()) if (!alive.has(key)) this.treeOwners.delete(key);
    for (const map of [this.environments, this.vmInstances, this.cwds]) for (const key of map.keys()) if (!alive.has(key)) map.delete(key);
    const held = (key: string) => alive.has(key) || identities.has(key);
    for (const key of Object.keys(this.memory.declarations)) if (!held(key)) delete this.memory.declarations[key];
    for (const key of Object.keys(this.memory.decisions)) if (!held(key)) delete this.memory.decisions[key];
    for (const key of Object.keys(this.memory.simulatorTouches)) if (!identities.has(key)) delete this.memory.simulatorTouches[key];
    for (const key of this.stopping.keys()) if (!identities.has(key)) this.stopping.delete(key);
    for (const key of Object.keys(this.memory.held)) if (!identities.has(key)) delete this.memory.held[key];
    for (const key of Object.keys(this.memory.lowered)) if (!identities.has(key)) delete this.memory.lowered[key];
    // Names and ends only while something still points at them.
    const referenced = new Set<string>(this.live.map(agentId));
    for (const entry of this.entries.values()) if (entry.owner) referenced.add(entry.owner.agentSessionId);
    for (const owner of this.treeOwners.values()) referenced.add(owner.agentSessionId);
    for (const touch of Object.values(this.memory.simulatorTouches)) for (const user of touch.users) referenced.add(user);
    for (const key of Object.keys(this.memory.labels)) if (!referenced.has(key)) delete this.memory.labels[key];
    for (const key of Object.keys(this.memory.ended)) if (!referenced.has(key)) delete this.memory.ended[key];
    for (const key of this.lastLive.keys()) if (!referenced.has(key)) this.lastLive.delete(key);
    for (const key of Object.keys(this.memory.loweredSessions)) if (!this.live.some((session) => agentId(session) === key)) delete this.memory.loweredSessions[key];
  }

  /** One resource by its id or identity, for a stop or a decision. */
  find(idOrIdentity: string): ResourceEntry | undefined {
    for (const entry of this.entries.values()) if (entry.id === idOrIdentity || entry.identity === idOrIdentity) return entry;
    return undefined;
  }

  all(): ResourceEntry[] {
    return [...this.entries.values()];
  }

  /** The owner's live session, if it is live. */
  private liveOwner(owner: ResourceOwner | undefined): LedgerSession | undefined {
    if (!owner) return undefined;
    return this.live.find((session) => agentId(session) === owner.agentSessionId)
      ?? (owner.sessionId ? this.live.find((session) => session.sessionId === owner.sessionId) : undefined);
  }

  /** What a resource's state is now, and why. */
  stateOf(entry: ResourceEntry, now: number): { state: ResourceState; reason?: string; asksAgainAt?: number } {
    const stop = this.stopping.get(entry.identity);
    // Stopping until it is gone, or for three minutes: something that outlives its stop is running again, as it is.
    if (stop && !stop.error && now - stop.at < STOPPING_MS) return { state: "stopping", reason: "stopping" };
    const failed = stop?.error ? `couldn't stop it: ${stop.error}` : undefined;
    if (!entry.owner) {
      return { state: "unowned", reason: failed ?? (entry.preexisting ? "running before conch was watching" : "no session started it") };
    }
    const decision = this.memory.decisions[entry.identity];
    if (decision?.kind === "keep") return { state: "kept", reason: failed ?? "you kept it" };
    if (entry.lifetime?.kind === "keep") return { state: "kept", reason: failed ?? "its session said to keep it" };
    const due = this.due(entry, now);
    if (!due) return { state: "running", ...(failed ? { reason: failed } : {}) };
    if (decision?.kind === "later" && decision.until > now) return { state: "later", reason: failed ?? due.reason, asksAgainAt: decision.until };
    return { state: "asking", reason: failed ?? due.reason };
  }

  /** Why its lifetime is over and since when (as near as conch can say), or undefined while it isn't. */
  private due(entry: ResourceEntry, now: number): { reason: string; since?: number } | undefined {
    const lifetime = entry.lifetime;
    if (!lifetime || !entry.owner) return undefined;
    if (lifetime.kind === "until") return lifetime.until <= now ? { reason: "past the time it was started for", since: lifetime.until } : undefined;
    const live = this.liveOwner(entry.owner);
    if (!live) {
      const ended = this.memory.ended[entry.owner.agentSessionId];
      return ended === undefined ? undefined : { reason: "its session ended", ...(ended ? { since: ended } : {}) };
    }
    if (lifetime.kind === "turn" && entry.declaredAt !== undefined && !working(live.status)
      && (live.statusUpdatedAt ?? 0) > entry.declaredAt) return { reason: "its turn is over", since: live.statusUpdatedAt };
    return undefined;
  }

  /** The apps' view. Seen in two samples, or declared: one sample is a command running, not yet a loose end. */
  published(now: number = this.sampledAt): PublishedResources {
    const items: PublishedResource[] = [];
    for (const entry of this.entries.values()) {
      if (entry.seen < 2 && entry.declaredAt === undefined) continue;
      const { state, reason, asksAgainAt } = this.stateOf(entry, now);
      const live = this.liveOwner(entry.owner);
      // When it was last seen live, the nearest conch can say to when it ended; nothing for one it never saw.
      const ended = entry.owner && !live ? this.memory.ended[entry.owner.agentSessionId] || undefined : undefined;
      items.push({
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        command: entry.command,
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.ports.length ? { ports: entry.ports } : {}),
        ...(entry.owner ? {
          owner: {
            key: entry.owner.agentSessionId,
            ...(live ? { sessionId: live.sessionId } : entry.owner.sessionId ? { sessionId: entry.owner.sessionId } : {}),
            label: entry.owner.label,
            live: Boolean(live),
            how: entry.owner.how,
            ...(ended ? { endedAt: ended } : {}),
          },
        } : {}),
        ...(entry.users.length ? { users: entry.users } : {}),
        startedAt: entry.startedAt,
        cpu: Math.round(entry.cpu * 10) / 10,
        memory: entry.rss,
        ...(entry.lifetime ? {
          lifetime: {
            kind: entry.lifetime.kind,
            ...(entry.lifetime.kind === "until" ? { until: entry.lifetime.until } : {}),
            ...(entry.lifetime.inferred ? { inferred: true as const } : {}),
          },
        } : {}),
        ...(entry.why ? { why: entry.why } : {}),
        state,
        ...(reason ? { reason } : {}),
        ...(asksAgainAt ? { asksAgainAt } : {}),
        ...(entry.preexisting ? { preexisting: true as const } : {}),
        ...this.levelFields(entry, state, now),
        ...(this.memory.held[entry.identity] ? { held: true as const } : {}),
        ...(this.memory.lowered[entry.identity] ? { lowered: this.memory.lowered[entry.identity]!.by } : {}),
      });
    }
    const order: Record<ResourceState, number> = { asking: 0, stopping: 1, running: 2, later: 3, kept: 4, unowned: 5 };
    items.sort((a, b) => order[a.state] - order[b.state] || (a.owner?.label ?? "").localeCompare(b.owner?.label ?? "") || a.startedAt - b.startedAt);
    const { sessions, budget } = this.load(items, now);
    return { v: 1, sampledAt: this.sampledAt, asking: items.filter((item) => item.state === "asking").length, items, sessions, budget };
  }

  /** A resource's level and its sustained CPU (resource-load.ts `resourceLevel`). */
  private levelFields(entry: ResourceEntry, state: ResourceState, now: number): { level: Level; levelReasons?: string[]; cpuSustained?: number } {
    const cpu = this.history.sustained(entry.identity, now);
    const { level, reasons } = resourceLevel({ ...(cpu ? { cpu } : {}), memory: entry.rss, state, startedAt: entry.startedAt, dueSince: this.due(entry, now)?.since }, now);
    return { level, ...(reasons.length ? { levelReasons: reasons } : {}), ...(cpu?.sustained ? { cpuSustained: Math.round(cpu.cpu) } : {}) };
  }

  /** Each owner's usage with its level, heaviest first, and agents' usage against the budget. */
  private load(items: readonly PublishedResource[], now: number): { sessions: SessionUsage[]; budget: PublishedBudget } {
    const sessions: SessionUsage[] = this.usage.map((owner) => {
      const cpu = this.history.sustained(`session:${owner.key}`, now) ?? { cpu: owner.cpuNow, sustained: false };
      const mine = items.filter((item) => (owner.key === "unowned" ? !item.owner : item.owner?.key === owner.key));
      const load = loadLevel({ cpu, memory: owner.memory }, SESSION_THRESHOLDS);
      let level = load.level;
      const reasons = [...load.reasons];
      // Its worst leftover's level, and the first thing that one says.
      const worst = mine.reduce<PublishedResource | undefined>((found, item) => (!found || worse(found.level, item.level) !== found.level ? item : found), undefined);
      if (worst && worse(level, worst.level) !== level) {
        level = worst.level;
        reasons.push(`${worst.title}: ${worst.levelReasons?.[0] ?? worst.reason ?? worst.level}`);
      }
      return {
        key: owner.key,
        ...(owner.sessionId ? { sessionId: owner.sessionId } : {}),
        label: owner.label,
        live: owner.live,
        cpu: Math.round(cpu.cpu),
        sustained: cpu.sustained,
        memory: owner.memory,
        resources: owner.resources,
        level,
        reasons,
        ...(this.memory.loweredSessions[owner.key] ? { lowered: true as const } : {}),
      };
    });
    const total = this.history.sustained("budget", now) ?? { cpu: 0, sustained: false };
    const memory = sessions.filter((session) => session.key !== "unowned").reduce((sum, session) => sum + session.memory, 0);
    const budget = budgetOf(this.budgetSettings(), this.machine, sessions, { ...total, memory });
    for (const session of sessions) {
      if (!budget.over.includes(session.key)) continue;
      session.over = true;
      session.level = "red";
      session.reasons.unshift("over the agents' budget");
    }
    const rank = { red: 2, yellow: 1, green: 0 } as const;
    sessions.sort((a, b) => Number(a.key === "unowned") - Number(b.key === "unowned") || rank[b.level] - rank[a.level] || b.cpu - a.cpu || b.memory - a.memory);
    return { sessions, budget };
  }

  /** Each live row's worst level, for its "3 still running" line's mark; green rows are left out. */
  rowLevels(now: number = this.sampledAt): Map<string, Level> {
    const levels = new Map<string, Level>();
    for (const session of this.published(now).sessions) if (session.sessionId && session.live && session.level !== "green") levels.set(session.sessionId, session.level);
    return levels;
  }

  /** A live session by its row or agent id. */
  liveSession(id: string): LedgerSession | undefined {
    return this.live.find((session) => session.sessionId === id || agentId(session) === id);
  }

  markHeld(entry: ResourceEntry, held: boolean, now: number): void {
    if (held) this.memory.held[entry.identity] = now;
    else delete this.memory.held[entry.identity];
  }

  markLowered(entry: ResourceEntry, by: "you" | "auto" | null, now: number): void {
    if (by) this.memory.lowered[entry.identity] = { at: now, by };
    else delete this.memory.lowered[entry.identity];
  }

  markSessionLowered(session: LedgerSession, lowered: boolean, now: number): void {
    if (lowered) this.memory.loweredSessions[agentId(session)] = now;
    else delete this.memory.loweredSessions[agentId(session)];
  }

  /**
   * What `agent-auto-background` may move to the background band now: while agents are over their CPU budget, a
   * process group a session left running (never a VM, a simulator, something unowned or a session itself) that has
   * kept a core busy for five minutes, and that isn't already lowered or held.
   */
  autoBackgroundCandidates(now: number = this.sampledAt): ResourceEntry[] {
    const published = this.published(now);
    if (!published.budget.autoBackground || published.budget.level !== "red" || !published.budget.sustained || published.budget.cpu <= published.budget.cpuLimit) return [];
    return [...this.entries.values()].filter((entry) => {
      if (!entry.owner || !PROCESS_KINDS.has(entry.kind) || this.memory.lowered[entry.identity] || this.memory.held[entry.identity]) return false;
      const cpu = this.history.sustained(entry.identity, now);
      return Boolean(cpu?.sustained && cpu.cpu >= 100);
    });
  }

  /** How many of each live row's resources are running: its row's "3 still running". */
  rowCounts(now: number = this.sampledAt): Map<string, number> {
    const counts = new Map<string, number>();
    for (const item of this.published(now).items) {
      if (!item.owner?.live || !item.owner.sessionId || item.state === "stopping") continue;
      counts.set(item.owner.sessionId, (counts.get(item.owner.sessionId) ?? 0) + 1);
    }
    return counts;
  }

  /** Keep, or ask later. Stop is the sampler's (`stopResource`), which marks it here first. */
  decide(id: string, action: "keep" | "later", now: number): ResourceEntry | undefined {
    const entry = this.find(id);
    if (!entry) return undefined;
    this.memory.decisions[entry.identity] = action === "keep" ? { kind: "keep", at: now } : { kind: "later", at: now, until: now + ASK_LATER_MS };
    this.stopping.delete(entry.identity);
    return entry;
  }

  markStopping(entry: ResourceEntry, now: number): void {
    this.stopping.set(entry.identity, { at: now });
  }

  stopFailed(entry: ResourceEntry, error: string, now: number): void {
    this.stopping.set(entry.identity, { at: now, error });
  }

  /**
   * An agent's declaration: this process (or device, or VM) is mine, for this long, because. `target` is a process
   * key (`processKey`) or a device's or VM's identity as `find` reports it.
   */
  declare(target: string, declaration: Declaration): void {
    this.memory.declarations[target] = declaration;
    const entry = this.find(target);
    if (entry) {
      entry.owner = declaration.owner;
      entry.lifetime = declaration.lifetime;
      entry.declaredAt = declaration.at;
      if (declaration.why) entry.why = declaration.why;
    }
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// MARK: the published rows

/**
 * The published state's rows with each live session's `stillRunning` (how many things it left running) and
 * `resourceLevel` (yellow or red, what it uses all told; green is left out), by row id.
 */
export function withStillRunning<State extends { rows: readonly object[] }>(
  state: State,
  counts: ReadonlyMap<string, number>,
  levels: ReadonlyMap<string, Level> = new Map(),
): State {
  if (!counts.size && !levels.size && !state.rows.some((row) => "stillRunning" in row || "resourceLevel" in row)) return state;
  return {
    ...state,
    rows: state.rows.map((row) => {
      const id = (row as { id?: unknown }).id;
      const count = typeof id === "string" ? counts.get(id) : undefined;
      const level = typeof id === "string" ? levels.get(id) : undefined;
      const { stillRunning: _count, resourceLevel: _level, ...rest } = row as { stillRunning?: number; resourceLevel?: Level };
      return { ...rest, ...(count ? { stillRunning: count } : {}), ...(level && level !== "green" ? { resourceLevel: level } : {}) };
    }),
  };
}

// MARK: the control socket

export type ResourceTarget =
  | { pid: number }
  | { port: number }
  | { simulator: string }
  | { vm: string };

export type ResourceRequest =
  | { kind: "resources" }
  | { kind: "resource-decide"; id: string; action: ResourceAction; callerPid?: number }
  | { kind: "resource-session"; sessionId: string; action: "lower" | "restore"; callerPid?: number }
  | { kind: "resource-add"; target: ResourceTarget; until: string; why?: string; callerPid: number };

export type ResourceReply =
  | { kind: "resources"; resources: PublishedResources }
  | { kind: "resource-done"; id: string; action: ResourceAction | "add"; title: string; state?: ResourceState; message: string }
  | { kind: "resource-error"; error: string };

const ID = /^[a-z0-9][a-z0-9@:.-]{0,80}$/i;

/**
 * `{kind: "resources"}`, `{kind: "resource-decide", id, action}` and `{kind: "resource-add", target, until, why,
 * callerPid}`, checked strictly; null for any other message. The Mac app's and the CLI's: the phone bridge refuses them
 * (`MAC_APP_ONLY_DECODERS`), since a stop from there is a stop nobody at the Mac saw.
 */
export function decodeResourceRequest(body: unknown): ResourceRequest | { error: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (value.kind === "resources") return { kind: "resources" };
  const callerPid = typeof value.callerPid === "number" && Number.isSafeInteger(value.callerPid) && value.callerPid > 1 ? value.callerPid : undefined;
  if (value.kind === "resource-decide") {
    if (typeof value.id !== "string" || !ID.test(value.id)) return { error: "a resource id is what `conch resources` lists, like p4242 or sim-1a2b3c4d" };
    if (!RESOURCE_ACTIONS.includes(value.action as ResourceAction)) return { error: `action must be one of ${RESOURCE_ACTIONS.join(", ")}` };
    return { kind: "resource-decide", id: value.id, action: value.action as ResourceAction, ...(callerPid ? { callerPid } : {}) };
  }
  if (value.kind === "resource-session") {
    if (typeof value.sessionId !== "string" || !ID.test(value.sessionId)) return { error: "a session is its id, as the Mac app or `conch sessions` gives it" };
    if (value.action !== "lower" && value.action !== "restore") return { error: "a session's action is lower or restore" };
    return { kind: "resource-session", sessionId: value.sessionId, action: value.action, ...(callerPid ? { callerPid } : {}) };
  }
  if (value.kind !== "resource-add") return null;
  if (!callerPid) return { error: "callerPid must be the calling process's pid" };
  const target = value.target as Record<string, unknown> | undefined;
  let decoded: ResourceTarget | undefined;
  if (target && typeof target === "object") {
    if (typeof target.pid === "number" && Number.isSafeInteger(target.pid) && target.pid > 1) decoded = { pid: target.pid };
    else if (typeof target.port === "number" && Number.isInteger(target.port) && target.port > 0 && target.port < 65536) decoded = { port: target.port };
    else if (typeof target.simulator === "string" && /^[\w .()-]{1,80}$/.test(target.simulator)) decoded = { simulator: target.simulator };
    else if (typeof target.vm === "string" && /^[\w.-]{1,64}$/.test(target.vm)) decoded = { vm: target.vm };
  }
  if (!decoded) return { error: "say what it is: --pid <pid>, --port <port>, --simulator <udid|name|booted> or --vm <colima profile>" };
  if (typeof value.until !== "string" || !value.until.trim() || value.until.length > 64) return { error: "--until is required: turn, session-end, keep, or a duration like 2h" };
  if (value.why !== undefined && (typeof value.why !== "string" || value.why.length > 200)) return { error: "--why is one short line (200 characters at most)" };
  return {
    kind: "resource-add",
    target: decoded,
    until: value.until,
    ...(typeof value.why === "string" && value.why.trim() ? { why: value.why.trim() } : {}),
    callerPid,
  };
}

// MARK: words

export function ageText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export function memoryText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}
