import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  migrateVoiceOverride,
  type VoiceOverrideOptions,
} from "./speak.ts";
import { adapterFor, agentAdapters } from "./agent-adapter.ts";
import {
  defaultIsPidAlive,
  readCodexSessions,
  type CodexSessionRegistryOptions,
} from "./codex-sessions.ts";
import { readCodexThreads } from "./codex-threads.ts";
import { liveTranscriptPath, readClaudeTitles, readContinuedIn } from "./claude-title.ts";
import { parseWindowKey, processParentTable, windowKey, windowPidFromAncestry } from "./window-key.ts";
import { HELP_SESSION_LABEL, helpSessionDir } from "./help-session.ts";

const LABELS_FILE = join(homedir(), ".config/conch/labels.json");
const MAX_SESSION_LABEL_LENGTH = 40;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export interface LabelOverrideOptions {
  /** Injectable so tests and alternate front-ends never need to touch the real home directory. */
  labelsPath?: string;
}

export interface RenameSessionLabelOptions extends LabelOverrideOptions, VoiceOverrideOptions {}
export interface SessionLookupOptions extends LabelOverrideOptions, CodexSessionRegistryOptions {}

export interface RegistrySnapshotOptions extends CodexSessionRegistryOptions {
  /** Every process's parent pid; injectable so a test can hand in a fake tree. Defaults to one `ps`. */
  processParents?: () => Promise<ReadonlyMap<number, number> | null>;
}

export interface SessionInfo {
  /**
   * What conch addresses this by — the agent's session id, unless that id is
   * shared by two live windows, in which case it names the window. See
   * `window-key.ts`.
   */
  sessionId: string;
  /** The agent's own id, for resuming the session or asking if it is alive. */
  agentSessionId?: string;
  /** When this window started — the tie-break when one id has two of them. */
  startedAt?: number;
  /**
   * This window's bridge session (`session_<s>`, Claude Code 2.1.266). The
   * transcript's `bridge-session` records carry `cse_<s>`, which is how a
   * window of a shared transcript is matched to its own branch (A8).
   */
  bridgeSessionId?: string;
  /** Session implementation; absent on legacy Claude registry projections. */
  backend?: "claude" | "codex";
  /**
   * Present on a subagent row: the session it runs inside (C4). Such a row
   * never comes from the registry — Claude Code writes no entry for a
   * subagent — so nothing can wake, inject into or announce for it; it is
   * shown nested under its parent, and its transcript can be read.
   */
  parentSessionId?: string;
  /**
   * Present when another live session's process is an ancestor of this one's
   * (C15): a `codex` that Claude Code's Bash tool started, or a `claude` that
   * Codex's shell did. Read from the process tree and the registries' pids —
   * never from labels or timing. Unlike `parentSessionId` this row is a full
   * session: it has its own pid, is announced, and can be typed into.
   */
  startedBySessionId?: string;
  name?: string;
  /**
   * Who chose `name`. Claude Code 2.1.25x+ writes a registry name at start
   * whether or not anyone typed one: `"derived"` is its own cwd-slug-plus-hex
   * (`arch-e9`), `"user"` is a /rename. Absent on older versions, where a
   * registry name only ever came from a person — so absent reads as "user".
   */
  nameSource?: "user" | "derived";
  cwd?: string;
  pid?: number;
  /** Claude Code's own live state: "busy" | "idle" | "shell" | "waiting" (authoritative for working-vs-waiting; see `registryToPanel`). */
  status?: string;
  /** epoch-ms the status was last set — compared against a latched panel state to pick the newer truth. */
  statusUpdatedAt?: number;
  /** "interactive" for a human-driven TUI; other kinds (headless/sdk) can't be talked to. */
  kind?: string;
  /** "cli" for a real terminal session; "sdk-cli" etc. are headless routines. */
  entrypoint?: string;
  /**
   * The session's own transcript, when it carries one.
   *
   * Claude sessions are found by id under the projects directory, so this stays
   * empty for them. A Codex thread cannot be: its rollout lives at a path only
   * Codex's database knows, and dropping it here meant every Codex row reached
   * the apps with no transcript at all — no conversation, no reply, nothing to
   * read.
   */
  transcriptPath?: string;
  /**
   * Why nothing can type into or raise this row, when nothing can (Codex): the
   * thread is closed — no process holds its writer lock — or its holder is an
   * app-server with no terminal. The pid is 0 either way; this says which, so
   * neither is reported as a pid conch failed to find.
   */
  noTerminal?: string;
  /**
   * A Claude Code background job's short id (`claude attach <jobId>`). Present
   * on a `bg` row: it is what `claude stop` and "Open in Terminal" name.
   */
  jobId?: string;
  /**
   * The agent's own process when `pid` routes somewhere else: a background
   * job's `pid` is the window attached to it, and this is the job itself.
   * Only the process tree needs it (C15).
   */
  agentPid?: number;
}

/**
 * A session a voice loop can actually engage — a top-level CLI conversation.
 * Excludes headless/sdk-cli routines (e.g. boatker's cron runs) that would otherwise
 * get announced + open the mic. Conservative: a session is only dropped when we can
 * positively identify it as non-interactive, so older registries (missing the fields)
 * still pass.
 *
 * `bg` passes: it is a conversation Claude Code moved out of its window to keep
 * running in the background — the same two kinds Claude Code itself counts as
 * live sessions. Dropping it froze the row on the moment it moved and left its
 * MCP calls with no caller. Its terminal is the window attached to it; see
 * `attachedWindow`.
 */
export function isEngageable(info: Pick<SessionInfo, "kind" | "entrypoint">): boolean {
  if (info.kind && info.kind !== "interactive" && info.kind !== "bg") return false;
  if (info.entrypoint && info.entrypoint !== "cli") return false;
  return true;
}

/**
 * Why a background Claude Code session's row has no terminal: no live window
 * is attached to it. The row carries pid 0, the way a Codex row with no
 * terminal does, so every existing "no routable pid" refusal applies; its
 * `jobId` is what "Open in Terminal" attaches.
 */
export const BG_NO_TERMINAL = "running in the background, not open in a terminal";

/**
 * The terminal window attached to a background job, if one is live.
 *
 * Claude Code 2.1.266 runs a background job under its own daemon (`claude
 * daemon run` → `claude --bg-pty-host` → the job), in a hidden pty. A window
 * attached to the job is a viewer: what is typed there is forwarded to the
 * job. conch's inject log proves it — text typed into window 61637 arrived in
 * job f31f0d15's transcript, same length, seconds later. So the window is the
 * route for everything conch types, stops, reveals or renames. The job's own
 * pid is not: its pty is hidden, and its ancestry runs through the daemon.
 *
 * Nothing documents which terminal is attached. The window's registry entry
 * carries `parkedJobId` naming the job, which is how Claude Code's own session
 * list pairs them (and it clears the field when the window takes its own
 * conversation back), so that is the signal — undocumented, read defensively.
 * Several windows on one job (a second `claude attach`): the most recently
 * started live one, the terminal a person most likely has in front of them.
 */
function attachedWindow(job: any, entries: readonly any[]): any {
  if (job?.kind !== "bg" || typeof job.jobId !== "string" || !job.jobId) return undefined;
  let window: any;
  for (const entry of entries) {
    if (entry?.kind !== "interactive" || entry.parkedJobId !== job.jobId) continue;
    if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0 || !defaultIsPidAlive(entry.pid)) continue;
    window = newer(window, entry);
  }
  return window;
}

/**
 * The background job a window is parked on, if its registry entry is there. A
 * hook or MCP call from that window names the window's own stale id; the job
 * holds the conversation now.
 */
function parkedJob(window: any, entries: readonly any[]): any {
  if (window?.kind !== "interactive" || typeof window.parkedJobId !== "string" || !window.parkedJobId) {
    return undefined;
  }
  return entries.find((entry) => entry?.kind === "bg" && entry.jobId === window.parkedJobId);
}

/**
 * Look up a live session in Claude Code's registry (~/.claude/sessions/<pid>.json).
 * Gives us the /rename-able session name and the CLI pid for pane targeting.
 */
export async function findSession(claudeDir: string, sessionId: string): Promise<SessionInfo | null> {
  const wanted = parseWindowKey(sessionId);
  const all = await registryEntries(join(claudeDir, "sessions"));
  let match: any;
  for (const entry of all) {
    if (entry.sessionId !== wanted.sessionId) continue;
    // A key naming a window asks for that window, and only that one.
    if (wanted.pid !== undefined && entry.pid !== wanted.pid) continue;
    match = newer(match, entry);
  }
  // A window parked on a job answers for the job.
  match = parkedJob(match, all) ?? match;
  return match ? currentName(toInfo(match, undefined, all), claudeDir) : null;
}

/**
 * The background job's row, when an address names a window parked on it.
 *
 * A process that started before conch knew about background jobs — a hook, a
 * conch MCP server, the window's own children — still names the window's
 * stale session id, or only its pid. conch hides that window, so the id is no
 * row, and a review sent to it landed nowhere (`da29d3fa`, pid 61637, while
 * the conch row was job `f31f0d15`). An id the registry knows decides alone;
 * the pid is asked only when no entry has that id. Anything else: null.
 */
export async function parkedWindowJob(
  claudeDir: string,
  sessionId: string,
  pid?: number,
): Promise<SessionInfo | null> {
  const wanted = parseWindowKey(sessionId);
  if (!wanted.sessionId) return null;
  const all = await registryEntries(join(claudeDir, "sessions"));
  const named = all.filter((entry) => entry.sessionId === wanted.sessionId
    && (wanted.pid === undefined || entry.pid === wanted.pid));
  const windows = named.length > 0
    ? named
    : pid && pid > 0 ? all.filter((entry) => entry.pid === pid) : [];
  for (const window of windows) {
    const job = parkedJob(window, all);
    if (job) return currentName(toInfo(job, undefined, all), claudeDir);
  }
  return null;
}

/**
 * Re-address a socket message whose `sessionId` names a parked window (or
 * whose pid does) to the job's row. `isRow` short-circuits the registry read
 * for an address that is already a row, which is nearly every message.
 */
export async function addressParkedWindow(
  claudeDir: string,
  value: unknown,
  isRow: (sessionId: string) => boolean,
): Promise<unknown> {
  if (typeof value !== "object" || value === null) return value;
  const { sessionId, pid } = value as { sessionId?: unknown; pid?: unknown };
  if (typeof sessionId !== "string" || !sessionId || isRow(sessionId)) return value;
  const job = await parkedWindowJob(claudeDir, sessionId, typeof pid === "number" ? pid : undefined);
  return job ? { ...value, sessionId: job.sessionId } : value;
}

/** Every readable registry entry. */
async function registryEntries(dir: string): Promise<any[]> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const entries: any[] = [];
  for (const f of files) {
    try {
      const entry = await Bun.file(join(dir, f)).json();
      if (entry && typeof entry === "object") entries.push(entry);
    } catch {
      // stale or mid-write registry file; skip
    }
  }
  return entries;
}

/**
 * The window a hook came from, not just the session it names.
 *
 * Claude Code tells a hook its `session_id` and nothing about which window ran
 * it, so with two windows on one id conch was attributing every turn to
 * whichever entry it happened to read first — the wrong terminal half the time,
 * for speech, status and the reply that follows. The process tree knows: the
 * hook is a descendant of its own window.
 */
export async function findHookWindow(
  claudeDir: string,
  agentSessionId: string,
): Promise<SessionInfo | null> {
  if (!agentSessionId) return null;
  const all = await registryEntries(join(claudeDir, "sessions"));
  const entries = all.filter((entry) => entry.sessionId === agentSessionId);
  if (entries.length === 0) return null;
  if (entries.length === 1) {
    // A window parked on a job speaks for the job's row, not its stale id.
    const entry = parkedJob(entries[0], all) ?? entries[0];
    return currentName(toInfo(entry, undefined, all), claudeDir);
  }

  const pids = new Set<number>(
    entries.map((e) => e.pid).filter((pid): pid is number => Number.isInteger(pid)),
  );
  const pid = await windowPidFromAncestry(pids);
  // Ancestry can come back empty (a `ps` that failed, a hook re-parented). The
  // newest window is then the same guess as before, and no worse.
  const chosen = entries.find((e) => e.pid === pid) ?? entries.reduce(newer, undefined);
  return {
    ...toInfo(chosen, undefined, all),
    sessionId: windowKey(agentSessionId, chosen.pid, true),
    agentSessionId,
  };
}

/**
 * One id, two windows — and both of them are real.
 *
 * `claude --resume <id>` in a second terminal keeps the id, so the registry can
 * describe two live processes that share one. conch briefly collapsed them,
 * reasoning that one transcript meant one session. Tyler: "ive been using both
 * in the claude code tui - theyre both open and seem to have diverged with no
 * problems". He was right, and the transcript proves it — the same file carries
 * records from ~/arch-website and ~/arch-swap, on separate branches, minutes
 * apart. Claude Code chains messages by parentUuid, so two windows write one
 * file and neither sees the other's work.
 *
 * So both stay listed. This picks a target only where something must resolve an
 * ambiguous id to ONE process, and it picks the newest so the answer is at
 * least stable — the directory order it replaced was an APFS hash.
 */
function newer(current: any, candidate: any): any {
  if (!current) return candidate;
  return startedAt(candidate) >= startedAt(current) ? candidate : current;
}

function startedAt(entry: any): number {
  return typeof entry?.startedAt === "number" ? entry.startedAt : 0;
}

/**
 * The registry's `name` is a snapshot of the title taken when the process
 * started, and nothing refreshes it, so a session renamed today keeps
 * yesterday's name until it restarts. The transcript's own `custom-title` is
 * the current answer, and the one `/resume` shows.
 *
 * Only for a session with ONE window, though. Two windows sharing an id each
 * hold their own name, and the transcript keeps just the last one written — so
 * refreshing from it there would rename both to whatever one window is called,
 * which is exactly how `arch site` briefly became a second `arch-prime`.
 *
 * A generated title never displaces a registry name: the name a person typed
 * outranks the one a model wrote, whichever is more recent.
 */
function currentName(info: SessionInfo, claudeDir: string): SessionInfo {
  const path = info.transcriptPath
    ?? liveTranscriptPath(claudeDir, info.cwd, info.sessionId);
  if (!path) return info;
  const titles = readClaudeTitles(path);
  // A registry name Claude Code DERIVED is a fallback, not a choice. It used to
  // outrank the generated title — correct when a registry name could only come
  // from a person, wrong once Claude Code started writing `arch-e9` at startup
  // for every session: the slug masked real titles, and where none existed it
  // beat the plain directory name. Tyler: "the mac app names of sessions are a
  // bit off". A typed name still wins over a generated title, as before.
  const typed = info.nameSource === "derived" ? undefined : info.name;
  const name = titles.custom ?? typed ?? titles.generated;
  // `undefined` here is deliberate: sessionLabel then falls to the directory,
  // which says where the work is; `arch-e9` says the same with noise attached.
  return name === info.name ? info : { ...info, name };
}

/**
 * Project a raw registry JSON entry onto SessionInfo (keeps the fields conch
 * actually uses). `entries` is the rest of the registry, where a background
 * job finds the window attached to it.
 */
function toInfo(entry: any, backend?: SessionInfo["backend"], entries: readonly any[] = []): SessionInfo {
  const background = !backend && entry.kind === "bg";
  // Only the route comes from the window. Id, status, name and startedAt stay
  // the job's: the window's entry froze the moment it parked.
  const window = background ? attachedWindow(entry, entries) : undefined;
  return {
    sessionId: entry.sessionId,
    ...(backend ? { backend } : {}),
    name: entry.name,
    ...(entry.nameSource === "user" || entry.nameSource === "derived"
      ? { nameSource: entry.nameSource }
      : {}),
    cwd: entry.cwd,
    ...(typeof entry.startedAt === "number" ? { startedAt: entry.startedAt } : {}),
    // Null while the window's job is parked elsewhere; absent before 2.1.26x.
    ...(typeof entry.bridgeSessionId === "string" && entry.bridgeSessionId
      ? { bridgeSessionId: entry.bridgeSessionId }
      : {}),
    pid: background ? window?.pid ?? 0 : entry.pid,
    ...(background && typeof entry.jobId === "string" && entry.jobId ? { jobId: entry.jobId } : {}),
    ...(background && Number.isSafeInteger(entry.pid) ? { agentPid: entry.pid } : {}),
    // A window parked on a job stopped writing its status the moment it parked,
    // usually mid-turn, so a frozen `busy` read as working forever once the job
    // was gone and the window became its own row again. Its conversation is not
    // running there: idle at the freeze time, so any newer latch still wins and
    // a pre-park "working" latch does not.
    status: !backend && entry.kind === "interactive" && typeof entry.parkedJobId === "string" && entry.parkedJobId
      ? "idle"
      : entry.status,
    statusUpdatedAt: typeof entry.statusUpdatedAt === "number"
      ? entry.statusUpdatedAt
      : backend === "codex" && typeof entry.updatedAt === "number"
        ? entry.updatedAt
        : undefined,
    kind: entry.kind,
    entrypoint: entry.entrypoint,
    ...(typeof entry.transcriptPath === "string" && entry.transcriptPath
      ? { transcriptPath: entry.transcriptPath }
      : {}),
    ...(typeof entry.noTerminal === "string" && entry.noTerminal
      ? { noTerminal: entry.noTerminal }
      : background && !window
        ? { noTerminal: BG_NO_TERMINAL }
        : {}),
  };
}

function labelOverridePath(options: LabelOverrideOptions): string {
  return options.labelsPath ?? LABELS_FILE;
}

/** Canonical persisted form: printable, trimmed, non-empty, and dashboard-sized. */
export function normalizeSessionLabel(label: string): string {
  const printable = label.replace(CONTROL_CHARS, "").trim();
  const capped = Array.from(printable).slice(0, MAX_SESSION_LABEL_LENGTH).join("").trim();
  if (!capped) throw new Error("Session label cannot be empty");
  return capped;
}

/** Read conch-owned labels; Claude's frequently rewritten registry remains read-only. */
export function labelOverrides(options: LabelOverrideOptions = {}): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(labelOverridePath(options), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries: Array<[string, string]> = [];
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (!sessionId || typeof value !== "string") continue;
      try {
        entries.push([sessionId, normalizeSessionLabel(value)]);
      } catch {}
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function writeLabelOverrides(
  overrides: Readonly<Record<string, string>>,
  options: LabelOverrideOptions,
): void {
  const path = labelOverridePath(options);
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(
    dirname(path),
    `.labels.json.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(overrides, null, 2) + "\n", "utf8");
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {}
  }
}

/** Persist one session-id-keyed display label without modifying Claude's registry. */
export function setLabelOverride(
  sessionId: string,
  label: string,
  options: LabelOverrideOptions = {},
): string {
  const id = sessionId.trim();
  if (!id || id.replace(CONTROL_CHARS, "") !== id) {
    throw new Error("Session id cannot be empty or contain control characters");
  }
  const canonical = normalizeSessionLabel(label);
  const map = new Map(Object.entries(labelOverrides(options)));
  map.set(id, canonical);
  writeLabelOverrides(Object.fromEntries(map), options);
  return canonical;
}

/**
 * The one rename operation for UI/CLI callers: persist the canonical label and
 * carry its label-keyed voice pin along. If the voice write fails, restore the
 * previous label map so callers never report a half-completed rename.
 */
export function renameSessionLabel(
  sessionId: string,
  oldLabel: string,
  newLabel: string,
  options: RenameSessionLabelOptions = {},
): { label: string; voiceMigrated: boolean } {
  const canonical = normalizeSessionLabel(newLabel);
  const originalLabels = labelOverrides(options);
  setLabelOverride(sessionId, canonical, options);
  try {
    return {
      label: canonical,
      voiceMigrated: migrateVoiceOverride(oldLabel, canonical, options),
    };
  } catch (error) {
    writeLabelOverrides(originalLabels, options);
    throw error;
  }
}

/**
 * Will Claude Code stop and ask before it starts here?
 *
 * A session launched into a folder Claude Code has not seen sits on "Is this a
 * project you trust?" and does NOT write its registry file until that is
 * answered — so conch cannot see it, and the app looks broken. Tyler hit
 * exactly this: "it sucessdully made a new session btu that session didn't
 * then show in the conch app."
 *
 * `~/.claude.json` records `hasTrustDialogAccepted` per project, so this is
 * knowable BEFORE launching rather than inferred from a session that never
 * arrives. Returns null when the answer cannot be read, which must be treated
 * as "say nothing" — warning about a folder that is actually fine is its own
 * small lie.
 */
export function claudeFolderTrusted(
  cwd: string,
  configPath = join(homedir(), ".claude.json"),
): boolean | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const projects = (parsed as { projects?: unknown }).projects;
    if (typeof projects !== "object" || projects === null) return null;
    const entry = (projects as Record<string, unknown>)[cwd];
    if (typeof entry !== "object" || entry === null) return false; // never opened here
    const accepted = (entry as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted;
    return accepted === true;
  } catch {
    return null;
  }
}

/** Session label precedence: conch override, registry name, then project folder. */
export function sessionLabel(
  info: SessionInfo | null,
  cwd: string | undefined,
  options: LabelOverrideOptions = {},
): string {
  if (info?.sessionId) {
    const overrides = labelOverrides(options);
    // The window's own name first, then the session's — a rename made while one
    // window owned the id keeps naming it after a second window re-keys it.
    for (const key of [info.sessionId, info.agentSessionId]) {
      const override = key && Object.hasOwn(overrides, key) ? overrides[key] : undefined;
      if (override) return override;
    }
  }
  const dir = cwd ?? info?.cwd ?? process.cwd();
  // conch's own session keeps conch's name: above the registry name, because a
  // title Claude generates from the first question would otherwise replace it
  // after one turn; below the override, so `conch rename` still works on it.
  if (dir === helpSessionDir()) return HELP_SESSION_LABEL;
  if (info?.name) return info.name;
  return dir.split("/").filter(Boolean).pop() ?? "claude";
}

/**
 * A single read of the session registry.
 *  - `infos`: engageable (top-level interactive CLI) sessions, for the panel + wake.
 *  - `liveIds`: EVERY live sessionId (engageable or not, plus ids salvaged from a
 *    torn mid-write file), for liveness/"has this closed?" checks.
 *  - `complete`: false if any file was unreadable/unparseable — callers deciding
 *    "closed" or pruning latches must NOT treat an absence as authoritative.
 */
export interface RegistrySnapshot {
  infos: SessionInfo[];
  liveIds: Set<string>;
  complete: boolean;
}

/**
 * True only when a complete registry read positively lacks this session.
 * A missing/incomplete snapshot or empty id is uncertain, so it must fail open.
 */
export function sessionGoneFromSnapshot(
  snap: RegistrySnapshot | null,
  sessionId: string,
): boolean {
  if (!sessionId || !snap || !snap.complete) return false;
  return !snap.liveIds.has(sessionId);
}

/**
 * Read both live-session registries once. Returns `null` only when neither
 * source can be enumerated (total uncertainty). A torn/unparseable individual
 * file sets `complete = false`; Claude ids are salvaged from torn files so a
 * live session is never mistaken for closed.
 */
export async function registrySnapshot(
  claudeDir: string,
  options: RegistrySnapshotOptions = {},
): Promise<RegistrySnapshot | null> {
  const dir = join(claudeDir, "sessions");
  let files: string[] = [];
  let claudeAvailable = true;
  let claudeMissing = false;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (error) {
    claudeAvailable = false;
    claudeMissing = (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  let infos: SessionInfo[] = [];
  const claudeEntries: any[] = [];
  const allEntries: any[] = [];
  const liveIds = new Set<string>();
  let complete = claudeAvailable || claudeMissing;
  for (const f of files) {
    const raw = await Bun.file(join(dir, f)).text().catch(() => null);
    if (raw == null) {
      complete = false;
      continue;
    }
    let entry: any;
    try {
      entry = JSON.parse(raw);
    } catch {
      // torn mid-write file — Claude rewrites <pid>.json on every status change,
      // and the Stop hook fires at that same moment, so this race is real. Salvage
      // the id so a live session is never dropped as "closed".
      complete = false;
      const m = raw.match(/"sessionId"\s*:\s*"([^"]+)"/);
      if (m) liveIds.add(m[1]);
      continue;
    }
    if (!entry.sessionId) continue;
    liveIds.add(entry.sessionId);
    allEntries.push(entry);
    if (isEngageable(entry)) claudeEntries.push(entry);
  }
  // One conversation is one row. The window a conversation moved out of stays
  // live under the old id; the live session it moved to is the row. A window
  // parked on a job that is listed is that job's terminal, part of its row,
  // whether or not its own transcript says so (a `claude attach` window).
  const engaged = new Set(claudeEntries.map((entry) => entry.sessionId));
  const moved = new Set(
    claudeEntries.filter((entry) =>
      parkedJob(entry, claudeEntries) !== undefined
      || movedToLiveSession(claudeDir, entry, engaged)),
  );
  // A session id is not a window. `claude --resume <id>` in a second terminal
  // keeps the id, so two windows can share one — see `newer` below.
  const windows = new Map<string, number>();
  for (const entry of claudeEntries) {
    if (moved.has(entry)) continue;
    windows.set(entry.sessionId, (windows.get(entry.sessionId) ?? 0) + 1);
  }
  for (const entry of claudeEntries) {
    if (moved.has(entry)) continue;
    const info = toInfo(entry, undefined, allEntries);
    if (windows.get(entry.sessionId) === 1) {
      infos.push(currentName(info, claudeDir));
      continue;
    }
    // Two windows on one id: address each by the window, and keep the id itself
    // live so "has this session closed?" still answers for either form.
    const keyed = {
      ...info,
      // The registry's pid, not the row's: a background row's is 0.
      sessionId: windowKey(info.sessionId, entry.pid, true),
      agentSessionId: info.sessionId,
    };
    liveIds.add(keyed.sessionId);
    infos.push(keyed);
  }

  const codex = readCodexSessions(options);
  for (const entry of codex.entries) {
    liveIds.add(entry.sessionId);
    infos.push(toInfo(entry, "codex"));
  }
  if (!codex.complete) complete = false;

  // Codex sessions nobody wired a hook into.
  //
  // The registry above is written by `conch codex-hook`, which requires hooks
  // in ~/.codex — shared config that only takes effect on session start, so it
  // can never reach a session already running. Reading Codex's own databases
  // observes those sessions without them participating at all. Hook-fed
  // entries win on conflict: they carry a real pid, so they can be TALKED to,
  // where an observed row can only be seen.
  const observed = readCodexThreads(options);
  for (const entry of observed.entries) {
    if (liveIds.has(entry.sessionId)) continue;
    liveIds.add(entry.sessionId);
    infos.push(toInfo(entry, "codex"));
  }
  if (!observed.complete) complete = false;

  // Sessions one of the others started (C15). One `ps` per snapshot, and only
  // when two known processes exist to relate — a lone session has no starter.
  // ponytail: ~30 ms per read on a 1200-process Mac; cache the table by pid
  // set if a profile ever shows it.
  if (infos.filter((info) => info.pid).length >= 2) {
    const parents = await (options.processParents ?? processParentTable)();
    if (parents) infos = withStartedBy(infos, parents);
  }

  // No readable source at all retains the legacy "total uncertainty" result.
  // A readable Codex registry can still supply useful sessions when Claude's
  // directory is absent. ENOENT is known-empty; other Claude read failures
  // make the combined liveness view incomplete.
  if (!claudeAvailable && !codex.available) return null;
  return { infos, liveIds, complete };
}

/**
 * Did this window's conversation move to a session that is live now?
 *
 * Follows `continued-in` from transcript tail to transcript tail. A successor
 * that is not live leaves the window as its own row, reading its own
 * transcript: that is what its terminal holds, and it is the only terminal
 * left to type into.
 */
function movedToLiveSession(
  claudeDir: string,
  entry: any,
  live: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>([entry.sessionId]);
  let path = liveTranscriptPath(claudeDir, entry.cwd, entry.sessionId);
  // ponytail: a second 64KB tail read per session per snapshot (currentName
  // reads one too); fold them into one read if a profile ever shows it. The
  // hop bound is a guard for a bogus chain — each real hop is a backgrounding.
  for (let hop = 0; hop < 8 && path; hop += 1) {
    const next = readContinuedIn(path);
    if (!next || seen.has(next)) return false;
    if (live.has(next)) return true;
    seen.add(next);
    path = adapterFor("claude").findTranscript(next, { claudeDir });
  }
  return false;
}

/**
 * Which session started which, from the process tree alone.
 *
 * Claude Code's Bash tool runs `codex` as claude → zsh → codex, and Codex's
 * shell runs `claude` as codex → (sandbox) → zsh → claude, so the started
 * session's ancestor chain reaches the starter's pid. Both registries carry
 * pids: Claude's `<pid>.json`, Codex's hook registry, and an observed Codex
 * thread's lock holder (`codexThreadRoute`). A row without a pid — a Codex
 * thread whose lock nobody holds, or an app-server holds — can be neither
 * starter nor started, and a
 * chain that leaves the table (a `ps` mid-exit) marks nothing. Nearest known
 * ancestor wins, so a chain of three nests each under the one just above it.
 */
export function withStartedBy(
  infos: readonly SessionInfo[],
  parents: ReadonlyMap<number, number>,
): SessionInfo[] {
  const byPid = new Map<number, SessionInfo>();
  for (const info of infos) if (info.pid && info.pid > 0) byPid.set(info.pid, info);
  // A background job's own process is where its Bash tool starts things, and
  // its ancestry runs through Claude Code's shared daemon up to whichever
  // window started that daemon — so it must be met before the walk reaches
  // that window, or a session one job started is filed under another's row.
  for (const info of infos) if (info.agentPid && info.agentPid > 0) byPid.set(info.agentPid, info);
  return infos.map((info) => {
    if (!info.pid || !byPid.has(info.pid)) return info;
    let pid = parents.get(info.pid);
    // The bound is only a cycle guard for a bogus table; a real tree ends at 1.
    for (let hop = 0; hop < 32 && pid !== undefined && pid > 1; hop += 1) {
      const starter = byPid.get(pid);
      if (starter && starter.sessionId !== info.sessionId) {
        return { ...info, startedBySessionId: starter.sessionId };
      }
      pid = parents.get(pid);
    }
    return info;
  });
}

/**
 * A Claude session's live background subagents, as rows nested under it.
 *
 * There is no registry entry to read: a subagent runs inside the parent's
 * process and Claude Code records it only as a sidechain transcript under the
 * parent's project directory, plus the launch and completion lines in the
 * parent's own transcript. `liveBackgroundAgents` reads exactly those, so a
 * row here is one Claude Code itself still considers in flight — never a
 * guess from a label or a timestamp. The row carries the sidechain as its
 * transcript, which is the same JSONL shape as any session's, so the
 * conversation reader shows it unchanged.
 */
export function subagentSessions(
  parent: SessionInfo,
  transcriptPath: string | undefined,
): SessionInfo[] {
  if (!transcriptPath || parent.parentSessionId) return [];
  return adapterFor(parent.backend).subagentSessions(parent, transcriptPath);
}

/** All engageable (top-level interactive CLI) live sessions from the registry. */
export async function listSessions(
  claudeDir: string,
  options: CodexSessionRegistryOptions = {},
): Promise<SessionInfo[]> {
  return (await registrySnapshot(claudeDir, options))?.infos ?? [];
}

/** Match an exact id, then conch overrides, registry names, and project folders. */
export async function findSessionByName(
  claudeDir: string,
  query: string,
  options: SessionLookupOptions = {},
): Promise<SessionInfo | null> {
  const q = query.toLowerCase().trim();
  if (!q) return null;
  const sessions = await listSessions(claudeDir, options);
  const overrides = labelOverrides(options);
  const overrideFor = (session: SessionInfo): string | undefined => {
    return Object.hasOwn(overrides, session.sessionId)
      ? overrides[session.sessionId]
      : undefined;
  };
  return (
    sessions.find((s) => s.sessionId.toLowerCase() === q) ??
    sessions.find((s) => overrideFor(s)?.toLowerCase() === q) ??
    sessions.find((s) => s.name?.toLowerCase() === q) ??
    sessions.find((s) => s.name?.toLowerCase().includes(q)) ??
    sessions.find((s) => (s.cwd ?? "").split("/").pop()?.toLowerCase() === q) ??
    (await parkedJobRow(claudeDir, query.trim(), sessions)) ??
    null
  );
}

/** A hidden window's stale id, answered by its job's row. Last: it reads the registry again. */
async function parkedJobRow(
  claudeDir: string,
  query: string,
  sessions: readonly SessionInfo[],
): Promise<SessionInfo | undefined> {
  const job = await parkedWindowJob(claudeDir, query);
  return job
    ? sessions.find((s) => s.sessionId === job.sessionId || s.agentSessionId === job.sessionId)
    : undefined;
}

/** Find by the spoken form, retrying without spaces ("day loop" -> "dayloop"). */
export async function findSessionBySpokenName(
  claudeDir: string,
  query: string,
  options: SessionLookupOptions = {},
): Promise<SessionInfo | null> {
  const direct = await findSessionByName(claudeDir, query, options);
  if (direct) return direct;
  const collapsed = query.replace(/\s+/g, "");
  return collapsed === query
    ? null
    : findSessionByName(claudeDir, collapsed, options);
}

/** Each agent's own lookup, in table order: Claude's project directory, then Codex's registry. */
export function findTranscript(
  claudeDir: string,
  sessionId: string,
  options: CodexSessionRegistryOptions = {},
): string | undefined {
  // Two windows on one session read one transcript, so a key naming a window
  // still asks for the session's file. Stripped here rather than at the ten
  // call sites, all of which mean the same thing by it.
  sessionId = parseWindowKey(sessionId).sessionId;
  for (const adapter of agentAdapters()) {
    const path = adapter.findTranscript(sessionId, { claudeDir, ...options });
    if (path) return path;
  }
  return undefined;
}
