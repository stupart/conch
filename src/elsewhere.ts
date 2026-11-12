import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { probeCommand } from "./probe.ts";
import { isEngageable, type SessionInfo } from "./sessions.ts";
import { resumedCodexThread } from "./codex-terminal-sessions.ts";
import { conchHome } from "./home.ts";
import { latestProcessRows, readProcessRows, type ProcessRow } from "./process-table.ts";
import type { ClaudeAccount } from "./claude-accounts.ts";
import type { ClaudeSwapRun } from "./claude-swap-runs.ts";
import type { StartSessionRequest } from "./session-lifecycle.ts";

/**
 * Agents running on this Mac that conch has no row for: the sidebar's "Not in conch" (2026-11-12).
 *
 * Tyler: "what's the status of some agents missing from conch and how do we attach them? is there a way to see ones
 * that are active but not in conch and then move them in? maybe new section at bottom of left sidebar that's usually
 * collapsed?" A session started with `cswap run 3 -- claude --continue` ran in conch's own tmux for hours and was never
 * a row: claude-swap gives it a CLAUDE_CONFIG_DIR of its own, Claude Code writes its registry entry there, and conch
 * read only Default's and its profiles'. claude-swap's folders are now read with the rest (claude-swap-runs.ts); this
 * finds what is still left over, says why, and names the one thing that would bring each in.
 *
 * What counts: a `claude` or `codex` process of this user's, with a terminal, that no row carries and that no other
 * agent started. A headless one (`claude -p`, `codex exec`, anything with no terminal) comes and goes and is no session
 * to show; a child of a session is that session's business. The ChatGPT app's Codex is one entry for the app, shown
 * while no thread it hosts is a row.
 *
 * It reads, never touches: the process table the registry read already took (`latestProcessRows`, process-table.ts),
 * and for a new candidate only, once per process, its command line, its folder and, for Claude, the one variable that
 * says where its registry is. Nothing is typed into or signalled.
 */

/** Where an agent's terminal is, from the apps above it in the process tree. */
export type ElsewhereHost =
  | "terminal" | "iterm" | "tmux" | "vscode" | "cursor" | "warp" | "ghostty" | "ssh"
  | "chatgpt" | "claude-app" | "other-terminal" | "none";

/** The two conch types into: a tmux pane and a Terminal tab (inject.ts). */
const TYPEABLE: ReadonlySet<ElsewhereHost> = new Set(["terminal", "tmux"]);

const HOSTS: ReadonlyArray<[RegExp, ElsewhereHost]> = [
  [/\/ChatGPT\.app\//, "chatgpt"],
  [/\/Claude\.app\//, "claude-app"],
  [/\/Terminal\.app\//, "terminal"],
  [/\/iTerm\.app\/|(?:^|\/)iTerm2$/, "iterm"],
  [/(?:^|\/)tmux(?::.*)?$/, "tmux"],
  [/\/Visual Studio Code[^/]*\.app\/|(?:^|\/)Code Helper/, "vscode"],
  [/\/Cursor\.app\//, "cursor"],
  [/\/Warp\.app\//, "warp"],
  [/\/Ghostty\.app\/|(?:^|\/)ghostty$/, "ghostty"],
  [/\/(?:WezTerm|Hyper|Tabby|Alacritty|kitty)\.app\/|(?:^|\/)(?:wezterm-gui|kitty|alacritty)$/, "other-terminal"],
  [/(?:^|\/)sshd(?:-session)?$/, "ssh"],
];

export function hostOf(pid: number, byPid: ReadonlyMap<number, ProcessRow>): ElsewhereHost {
  let current = byPid.get(pid)?.ppid;
  // The bound is a cycle guard; a terminal is a handful of hops up (shell, login, the app).
  for (let hop = 0; hop < 24 && current && current > 1; hop += 1) {
    const row = byPid.get(current);
    if (!row) break;
    for (const [pattern, host] of HOSTS) if (pattern.test(row.comm)) return host;
    current = row.ppid;
  }
  return "none";
}

type Agent = "claude" | "codex" | "chatgpt";

function agentOf(comm: string): Agent | undefined {
  if (/\/ChatGPT\.app\/.*(?:^|\/)codex$/.test(comm)) return "chatgpt";
  const name = basename(comm);
  return name === "claude" || name === "codex" ? name : undefined;
}

/** Why conch has no row for it. */
export type ElsewhereReason =
  /** Claude, its registry in a profile folder conch doesn't read. */
  | "profile"
  /** Claude, with no registry entry anywhere conch could find. */
  | "no-registry"
  /** Codex, on no thread conch can see: none started yet, or one in a Codex home conch doesn't read. */
  | "codex-thread"
  /** The ChatGPT app's own Codex. */
  | "app";

/** The one thing that brings it in. */
export type ElsewhereRemedy =
  /** Read its profile folder as a Claude account: it becomes a row where it runs. */
  | "add-account"
  /** Open the same conversation in a conch terminal; the original keeps running until its owner quits it. */
  | "resume"
  /** Pick its conversation from New session › Resume: conch can't tell which one it is. */
  | "start-sheet"
  /** Nothing conch can do from here: start it again from conch. */
  | "none";

/** One agent, as the apps are sent it. A folder and labels, never a profile's path, which can hold an email. */
export interface ElsewhereAgent {
  /** `<backend>:<pid>`, stable while the process lives. */
  id: string;
  backend: "claude" | "codex";
  pid: number;
  host: ElsewhereHost;
  reason: ElsewhereReason;
  remedy: ElsewhereRemedy;
  /** Its name in its registry, when it has one. */
  label?: string;
  cwd?: string;
  /** The profile it runs in, as a short name. */
  account?: string;
  /** Its conversation, when conch can tell. */
  conversationId?: string;
  /** Epoch-ms, when its registry says. */
  startedAt?: number;
}

/** What the daemon keeps of an agent that isn't published: where its registry is, for an action on it. */
export interface ElsewhereFinding {
  agent: ElsewhereAgent;
  configDir?: string;
}

/** The facts discovery asks a process for once, cached by pid, and how. Injectable so the tests hand in fakes. */
export interface ElsewhereProbes {
  /** Each pid's command line (`ps -o pid=,args=`). */
  args(pids: number[]): Promise<Map<number, string> | null>;
  /** Each pid's CLAUDE_CONFIG_DIR, from its environment (`ps eww`); never anything else of it. */
  configDirs(pids: number[]): Promise<Map<number, string> | null>;
  /** Each pid's working folder (`lsof -d cwd`). */
  cwds(pids: number[]): Promise<Map<number, string> | null>;
  /** `<dir>/sessions/<pid>.json`, parsed, or undefined. */
  registry(configDir: string, pid: number): Record<string, unknown> | undefined;
}

export interface ElsewhereInput {
  rows: readonly ProcessRow[];
  uid: number;
  /** Every pid a row carries: a session's, a background job's agent, an app-server that hosts a thread. */
  covered: ReadonlySet<number>;
  /** The Claude config folders conch reads registries from. */
  roots: readonly string[];
  /** The accounts conch knows, by folder: a profile found here is named as it. */
  accountLabels?: ReadonlyMap<string, string>;
  probes: ElsewhereProbes;
  home?: string;
}

/** The pids a set of rows carries, for `covered`. An app-server's is only in its `noTerminal` (codex-threads.ts). */
export function coveredPids(infos: readonly Pick<SessionInfo, "pid" | "agentPid" | "noTerminal">[]): Set<number> {
  const pids = new Set<number>();
  for (const info of infos) {
    if (info.pid) pids.add(info.pid);
    if (info.agentPid) pids.add(info.agentPid);
    const hosted = info.noTerminal && /\(pid (\d+)\)/.exec(info.noTerminal);
    if (hosted) pids.add(Number(hosted[1]));
  }
  return pids;
}

/** Codex subcommands that are runs or servers, never a conversation in a terminal. */
const CODEX_HEADLESS = new Set(["exec", "e", "review", "mcp", "mcp-server", "app-server", "exec-server", "login", "logout", "apply", "a", "proto", "cloud", "completion", "debug", "sandbox", "features", "help"]);

/** `codex <subcommand>` as `ps` flattens it: the first word that isn't an option or an option's value. */
export function codexSubcommand(args: string): string | undefined {
  const words = args.trim().split(/\s+/).slice(1);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (/^(?:-c|--config|-m|--model|-p|--profile|-C|--cd|-s|--sandbox|-a|--ask-for-approval|--enable|--disable|-i|--image)$/.test(word)) { index += 1; continue; }
    if (word.startsWith("-")) continue;
    return word;
  }
  return undefined;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** `claude -p`, `--print`, or a pipe's `--output-format`: a run, not a session. */
export function claudeHeadless(args: string): boolean {
  return /(?:^|\s)(?:-p|--print)(?:\s|=|$)/.test(args);
}

/** The conversation a `claude` command line names: `--resume <id>`, `-r <id>` or `--session-id <id>`. */
export function claudeNamedConversation(args: string): string | undefined {
  const words = args.trim().split(/\s+/);
  for (let index = 0; index < words.length - 1; index += 1) {
    if (["--resume", "-r", "--session-id"].includes(words[index]!) && UUID.test(words[index + 1]!)) return words[index + 1]!.toLowerCase();
  }
  const inline = /--(?:resume|session-id)=([0-9a-f-]{36})(?:\s|$)/i.exec(args);
  return inline && UUID.test(inline[1]!) ? inline[1]!.toLowerCase() : undefined;
}

/**
 * A profile folder as a row can say it: the account's name when it is one, else the folder under home. A claude-swap
 * run folder is named for its account's email (`3-name_example.com`), so a part with an email in it is dropped.
 */
export function profileName(configDir: string, home: string, labels?: ReadonlyMap<string, string>): string {
  const known = labels?.get(configDir);
  if (known) return known;
  const parts = (configDir.startsWith(`${home}/`) ? configDir.slice(home.length + 1) : configDir).split("/").filter(Boolean);
  const kept = parts.filter((part) => !/@|_[a-z0-9-]+\.[a-z]{2,}$/i.test(part));
  return (configDir.startsWith(`${home}/`) ? "~/" : "/") + kept.slice(-2).join("/");
}

function within(pid: number, set: ReadonlySet<number>, byPid: ReadonlyMap<number, ProcessRow>): boolean {
  let current = byPid.get(pid)?.ppid;
  for (let hop = 0; hop < 24 && current && current > 1; hop += 1) {
    if (set.has(current)) return true;
    current = byPid.get(current)?.ppid;
  }
  return false;
}

function text(value: unknown, max = 200): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value.trim() : undefined;
}

/** Discovery itself, from one process table: everything above, as data, so it is tested without a Mac's processes. */
export async function findElsewhere(input: ElsewhereInput): Promise<ElsewhereFinding[]> {
  const home = input.home ?? conchHome();
  const byPid = new Map(input.rows.map((row) => [row.pid, row]));
  const agents = input.rows.filter((row) => row.uid === input.uid && agentOf(row.comm));
  const agentPids = new Set(agents.map((row) => row.pid));
  const findings: ElsewhereFinding[] = [];

  // The ChatGPT app: one entry per app, while no thread one of its Codex processes hosts is a row.
  const apps = new Map<number, ProcessRow[]>();
  for (const row of agents) {
    if (agentOf(row.comm) !== "chatgpt") continue;
    let app = row.ppid;
    for (let hop = 0; hop < 8; hop += 1) {
      const parent = byPid.get(app);
      if (!parent || /\/ChatGPT\.app\/Contents\/MacOS\/ChatGPT$/.test(parent.comm) || parent.ppid <= 1) break;
      app = parent.ppid;
    }
    apps.set(app, [...(apps.get(app) ?? []), row]);
  }
  for (const [app, codexes] of apps) {
    if (codexes.some((row) => input.covered.has(row.pid))) continue;
    const pid = Math.min(...codexes.map((row) => row.pid));
    findings.push({ agent: { id: `codex:${app}`, backend: "codex", pid, host: "chatgpt", reason: "app", remedy: "start-sheet" } });
  }

  // Everything else that has a terminal, no row, and no agent above it.
  const candidates = agents.filter((row) => agentOf(row.comm) !== "chatgpt"
    && !input.covered.has(row.pid)
    && row.tty !== "??" && row.tty !== "?"
    && !within(row.pid, agentPids, byPid) && !within(row.pid, input.covered, byPid));
  // A Claude whose registry entry is in a folder conch reads is that folder's to show: a row, a window folded into
  // another's row, or one the registry read set aside on purpose (a spare background job).
  const unread = candidates.filter((row) => agentOf(row.comm) !== "claude"
    || !input.roots.some((root) => existsSync(join(root, "sessions", `${row.pid}.json`))));
  if (!unread.length) return findings;

  const args = await input.probes.args(unread.map((row) => row.pid)) ?? new Map<number, string>();
  const live = unread.filter((row) => {
    const line = args.get(row.pid);
    if (line === undefined) return true;
    if (agentOf(row.comm) === "claude") return !claudeHeadless(line);
    const sub = codexSubcommand(line);
    return !sub || !CODEX_HEADLESS.has(sub);
  });
  const claudes = live.filter((row) => agentOf(row.comm) === "claude");
  const configDirs = claudes.length ? await input.probes.configDirs(claudes.map((row) => row.pid)) ?? new Map<number, string>() : new Map<number, string>();
  const registries = new Map<number, { dir: string; entry: Record<string, unknown> }>();
  for (const row of claudes) {
    const dir = configDirs.get(row.pid) ?? join(home, ".claude");
    const entry = input.probes.registry(dir, row.pid);
    if (entry) registries.set(row.pid, { dir, entry });
  }
  const needCwd = live.filter((row) => !text(registries.get(row.pid)?.entry.cwd, 4_096));
  const cwds = needCwd.length ? await input.probes.cwds(needCwd.map((row) => row.pid)) ?? new Map<number, string>() : new Map<number, string>();

  for (const row of live) {
    const host = hostOf(row.pid, byPid);
    const backend = agentOf(row.comm) as "claude" | "codex";
    const line = args.get(row.pid) ?? "";
    const found = registries.get(row.pid);
    if (found && !isEngageable(found.entry as Pick<SessionInfo, "kind" | "entrypoint">)) continue;
    const conversationId = backend === "claude"
      ? text(found?.entry.sessionId, 100) ?? claudeNamedConversation(line)
      : resumedCodexThread(line);
    const cwd = text(found?.entry.cwd, 4_096) ?? cwds.get(row.pid);
    const startedAt = typeof found?.entry.startedAt === "number" ? found.entry.startedAt : undefined;
    const label = text(found?.entry.name, 120);
    const reason: ElsewhereReason = backend === "codex" ? "codex-thread" : found ? "profile" : "no-registry";
    const remedy: ElsewhereRemedy = reason === "profile"
      ? (TYPEABLE.has(host) ? "add-account" : "resume")
      : conversationId ? "resume" : backend === "codex" ? "start-sheet" : "none";
    const configDir = found?.dir ?? configDirs.get(row.pid);
    findings.push({
      agent: {
        id: `${backend}:${row.pid}`, backend, pid: row.pid, host, reason, remedy,
        ...(label ? { label } : {}),
        ...(cwd ? { cwd } : {}),
        ...(configDir && backend === "claude" ? { account: profileName(configDir, home, input.accountLabels) } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(startedAt ? { startedAt } : {}),
      },
      ...(configDir ? { configDir } : {}),
    });
  }
  return findings;
}

// MARK: the probes, on this Mac

async function psColumn(pids: number[], argv: string[]): Promise<Map<number, string> | null> {
  if (!pids.length) return new Map();
  // `ps -p` exits 1 when none of them is alive any more: an answer, the empty one.
  const out = await probeCommand([...argv, "-p", pids.join(",")], [0, 1]);
  if (out === null) return null;
  const table = new Map<number, string>();
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) table.set(Number(match[1]), match[2]!);
  }
  return table;
}

/** The last CLAUDE_CONFIG_DIR in a `ps eww` line: the environment follows the arguments, which may mention one. */
export function configDirFromEnvironment(line: string): string | undefined {
  const all = [...line.matchAll(/(?:^|\s)CLAUDE_CONFIG_DIR=(\/\S+)/g)];
  return all.at(-1)?.[1];
}

function readRegistry(configDir: string, pid: number): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(configDir, "sessions", `${pid}.json`), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What discovery asks this Mac, once per process for as long as it lives (a process's command line, folder and
 * profile don't change). So a look that finds what the last one found runs nothing but `existsSync`.
 */
export function macProbes(): ElsewhereProbes {
  const cache = { args: new Map<number, string>(), dirs: new Map<number, string | null>(), cwds: new Map<number, string | null>() };
  const prune = (live: number[], map: Map<number, unknown>) => { if (map.size > 256) for (const pid of map.keys()) if (!live.includes(pid)) map.delete(pid); };
  return {
    async args(pids) {
      prune(pids, cache.args);
      const missing = pids.filter((pid) => !cache.args.has(pid));
      const read = await psColumn(missing, ["ps", "-o", "pid=,args="]);
      for (const [pid, line] of read ?? []) cache.args.set(pid, line);
      return new Map(pids.flatMap((pid) => cache.args.has(pid) ? [[pid, cache.args.get(pid)!] as const] : []));
    },
    async configDirs(pids) {
      prune(pids, cache.dirs);
      const missing = pids.filter((pid) => !cache.dirs.has(pid));
      // The environment is read for this one variable and dropped: it holds tokens as often as not, and nothing else of
      // it is kept, logged or published.
      const read = await psColumn(missing, ["ps", "eww", "-o", "pid=,command="]);
      if (read) for (const pid of missing) cache.dirs.set(pid, read.has(pid) ? configDirFromEnvironment(read.get(pid)!) ?? null : null);
      return new Map(pids.flatMap((pid) => cache.dirs.get(pid) ? [[pid, cache.dirs.get(pid)!] as const] : []));
    },
    async cwds(pids) {
      prune(pids, cache.cwds);
      const missing = pids.filter((pid) => !cache.cwds.has(pid));
      if (missing.length) {
        const out = await probeCommand(["lsof", "-a", "-d", "cwd", "-Fn", "-p", missing.join(",")], [0, 1]);
        if (out !== null) {
          let pid = 0;
          for (const line of out.split("\n")) {
            if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
            else if (pid && line.startsWith("n/")) cache.cwds.set(pid, line.slice(1));
          }
          for (const one of missing) if (!cache.cwds.has(one)) cache.cwds.set(one, null);
        }
      }
      return new Map(pids.flatMap((pid) => cache.cwds.get(pid) ? [[pid, cache.cwds.get(pid)!] as const] : []));
    },
    registry: readRegistry,
  };
}

/** A folder as one path, so `/var` and `/private/var` are one profile. */
export function canonicalDir(path: string): string {
  try { return realpathSync(resolve(path)); } catch { return resolve(path); }
}

// MARK: the daemon's watch

/** How often discovery looks at most, and how old a shared process table may be for it to use. */
export const ELSEWHERE_LOOK_MS = 10_000;
export const ELSEWHERE_TABLE_MAX_AGE_MS = 30_000;
/** How long an agent stays outside conch before it is listed: more than one look. */
export const ELSEWHERE_GRACE_MS = 15_000;

/**
 * Discovery as the daemon runs it: after a registry read, at most every ten seconds, on the process table that read
 * took. A Mac with one session or none takes no table in a registry read (`processParentTable` is only asked with two
 * pids to relate), so with none fresh enough the watch reads one itself, no more often than the table may be old.
 */
export class ElsewhereWatch {
  #findings: ElsewhereFinding[] = [];
  /** When each agent was first found outside conch: one is said only once it has stayed there `ELSEWHERE_GRACE_MS`. */
  #since = new Map<string, number>();
  #lastLook = -Infinity;
  #looking = false;
  /** What was last said to have changed, so a change is said once. */
  #said = "[]";
  readonly #probes: ElsewhereProbes;
  readonly #now: () => number;
  readonly #onChange: () => void;
  readonly #table: () => Promise<readonly ProcessRow[] | null>;
  readonly #uid: number | undefined;

  constructor(options: {
    onChange: () => void; probes?: ElsewhereProbes; now?: () => number;
    /** The process table; by default the one a registry read took, or a fresh one when that is too old. */
    table?: () => Promise<readonly ProcessRow[] | null>; uid?: number;
  }) {
    this.#onChange = options.onChange;
    this.#probes = options.probes ?? macProbes();
    this.#now = options.now ?? Date.now;
    this.#uid = options.uid ?? process.getuid?.();
    this.#table = options.table ?? (async () => {
      const latest = latestProcessRows();
      return latest && this.#now() - latest.at <= ELSEWHERE_TABLE_MAX_AGE_MS ? latest.rows : readProcessRows();
    });
  }

  /** What the apps are sent: none of the folders a finding keeps for itself. */
  published(): ElsewhereAgent[] {
    return this.#shown().map((finding) => finding.agent);
  }

  find(id: string): ElsewhereFinding | undefined {
    return this.#shown().find((finding) => finding.agent.id === id);
  }

  /**
   * The findings that have stayed outside conch a while. A session just started is found before Claude Code writes
   * its registry entry, and one conch started sits unregistered on Claude's trust question until it is answered: both
   * become rows on their own, and listing them for a look would only say something untrue.
   */
  #shown(): ElsewhereFinding[] {
    const now = this.#now();
    return this.#findings.filter((finding) => now - (this.#since.get(finding.agent.id) ?? now) >= ELSEWHERE_GRACE_MS);
  }

  observe(infos: readonly Pick<SessionInfo, "pid" | "agentPid" | "noTerminal">[], roots: readonly string[],
    accountLabels: ReadonlyMap<string, string>): void {
    const now = this.#now();
    if (this.#looking || now - this.#lastLook < ELSEWHERE_LOOK_MS) return;
    this.#looking = true;
    this.#lastLook = now;
    void this.#look(infos, roots, accountLabels).finally(() => { this.#looking = false; });
  }

  async #look(infos: readonly Pick<SessionInfo, "pid" | "agentPid" | "noTerminal">[], roots: readonly string[],
    accountLabels: ReadonlyMap<string, string>): Promise<void> {
    const rows = await this.#table().catch(() => null);
    const uid = this.#uid;
    if (!rows || uid === undefined) return;
    const findings = await findElsewhere({ rows, uid, covered: coveredPids(infos), roots, accountLabels, probes: this.#probes })
      .catch(() => null);
    if (!findings) return;
    const now = this.#now();
    const ids = new Set(findings.map((one) => one.agent.id));
    for (const id of this.#since.keys()) if (!ids.has(id)) this.#since.delete(id);
    for (const id of ids) if (!this.#since.has(id)) this.#since.set(id, now);
    this.#findings = findings;
    const said = JSON.stringify(this.published());
    if (said !== this.#said) {
      this.#said = said;
      this.#onChange();
    }
  }
}

// MARK: the apps' requests

export type ElsewhereAction = "resume" | "add-account";

export interface ElsewhereRequest {
  kind: "elsewhere";
  action: ElsewhereAction;
  /** An agent's `id`, as published. */
  id: string;
  /** Where a resume opens: conch's background terminal, or Terminal. */
  host?: "terminal" | "background";
}

/**
 * The Mac app's "Resume in conch" and "Add as an account" on an agent in Not in conch. Null for any other body. It
 * names an agent by the id the daemon published, never a folder or a conversation: what is resumed, and in which
 * profile, is what discovery found, so a request can't point a start at a folder of its choosing.
 */
export function decodeElsewhereRequest(body: unknown): ElsewhereRequest | { error: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (value.kind !== "elsewhere") return null;
  if (value.action !== "resume" && value.action !== "add-account") return { error: "action must be resume or add-account" };
  if (typeof value.id !== "string" || !/^(?:claude|codex):\d{1,10}$/.test(value.id)) return { error: "id is an agent's, as published" };
  if (value.host !== undefined && value.host !== "terminal" && value.host !== "background") return { error: "host must be terminal or background" };
  return { kind: "elsewhere", action: value.action, id: value.id, ...(value.host ? { host: value.host as "terminal" | "background" } : {}) };
}

/** The folder and the conch accounts an action reads: what discovery found against what conch knows now. */
export interface ElsewhereContext {
  accounts: readonly Pick<ClaudeAccount, "id" | "label" | "configDir">[];
  runs: readonly Pick<ClaudeSwapRun, "configDir">[];
  defaultDir: string;
}

/** The conch account a finding's folder already is, if any. */
export function registeredAccount(finding: ElsewhereFinding, context: ElsewhereContext): Pick<ClaudeAccount, "id" | "label" | "configDir"> | undefined {
  const dir = finding.configDir && canonicalDir(finding.configDir);
  return dir ? context.accounts.find((account) => canonicalDir(account.configDir) === dir) : undefined;
}

/**
 * Add: the name a Claude profile folder conch doesn't read is given as an account, from its folder (never an email),
 * made unique among the accounts there are. Undefined when the finding isn't one an Add applies to.
 */
export function elsewhereAccountLabel(finding: ElsewhereFinding, context: ElsewhereContext, home = conchHome()): string | undefined {
  if (finding.agent.backend !== "claude" || finding.agent.reason !== "profile" || !finding.configDir) return undefined;
  const base = profileName(finding.configDir, home).replace(/^~?\/+/, "").replace(/^\./, "").slice(0, 56) || "Claude profile";
  const taken = new Set(context.accounts.map((account) => account.label.toLowerCase()));
  let label = base;
  for (let n = 2; taken.has(label.toLowerCase()); n += 1) label = `${base} ${n}`;
  return label;
}

/**
 * Resume: the start that opens a finding's conversation in a conch terminal, in the profile it was found in. A conch
 * account by its id; claude-swap's run folder, or a folder conch doesn't read, by the folder, which only the daemon
 * names (session-lifecycle.ts `claudeConfigDir`); Default by nothing. Undefined with no conversation to resume.
 */
export function elsewhereResumeRequest(
  finding: ElsewhereFinding,
  context: ElsewhereContext,
  options: { host?: "terminal" | "background"; bypassPermissions?: boolean } = {},
): StartSessionRequest | undefined {
  const { agent, configDir } = finding;
  if (!agent.conversationId) return undefined;
  const claude = agent.backend === "claude";
  const registered = registeredAccount(finding, context);
  const run = configDir ? context.runs.find((one) => canonicalDir(one.configDir) === canonicalDir(configDir)) : undefined;
  const elsewhereDir = claude && configDir && !registered && canonicalDir(configDir) !== canonicalDir(context.defaultDir);
  return {
    backend: agent.backend,
    resumeSessionId: agent.conversationId,
    ...(options.host ? { host: options.host } : {}),
    ...(agent.cwd ? { cwd: agent.cwd } : {}),
    ...(options.bypassPermissions !== undefined ? { bypassPermissions: options.bypassPermissions } : {}),
    ...(claude && registered && registered.id !== "default" ? { claudeAccountId: registered.id } : {}),
    ...(elsewhereDir ? { claudeConfigDir: run?.configDir ?? configDir } : {}),
  };
}
