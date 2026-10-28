import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { failureIdentity, FAILURE_ORIGINS, type FailureOrigin } from "./failure-signature.ts";

/**
 * Failure tickets (docs/failure-tickets.md): every time an agent or conch lets Tyler down, one ticket per kind of
 * failure, kept in `~/.config/conch/failure-tickets.json`, with a Fix that starts a Claude session on it.
 *
 * 2026-10-28, right after an Allow he tapped never reached its session and said so only in the daemon's log: "there
 * should prob be a loop where a ticket is opened for any agent fail or something".
 *
 * The desk reads the two records conch keeps of what went wrong — `errors.jsonl` (`appendConchError`: the daemon's,
 * the apps', the hook's) and `mcp-usage.jsonl` (each agent's MCP server's, one line a call) — from where it last
 * stopped, and files each failure under its signature (failure-signature.ts). It owns the ticket's status from there:
 * open, fixing, fixed, ignored; a fixed one that comes back opens again.
 *
 * Nothing here sends anything anywhere. The records hold session names, folder paths, client names and the user's
 * words, and conch's repository is public: the store is the owner's alone (0600), and the one thing the loop lets out
 * is the PR a fix session opens, under the brief's rule that nothing from the evidence goes in it. `FAILURE_MIRRORS` is
 * where a private copy elsewhere would go, and it is empty.
 */

export type FailureTicketStatus = "open" | "fixing" | "fixed" | "ignored";
export const FAILURE_TICKET_STATUSES: readonly FailureTicketStatus[] = ["open", "fixing", "fixed", "ignored"];

/** Which of conch's records a failure was read from: the brief says where to find the rest of it. */
export type FailureSource = "errors" | "mcp-usage";

/** One failure, as read from a record. */
export interface FailureOccurrence {
  /** Epoch ms. */
  at: number;
  origin: FailureOrigin;
  operation: string;
  message: string;
  sessionId?: string;
  /** The session's label when the record said it (its own `state.label`, or the daemon's row for it). */
  label?: string;
  /** What the record kept of the moment: the route, the reason, the inject's steps; never the user's words. */
  state?: Record<string, unknown>;
  source: FailureSource;
}

/** A ticket's one example: its newest occurrence, the evidence a fix starts from. */
export interface FailureExample {
  at: number;
  /** The record's own message, whole (to `EXAMPLE_MESSAGE_MAX`): the title is only its first sentence. */
  message: string;
  sessionId?: string;
  label?: string;
  /** The record's state, as JSON, cut to `EXAMPLE_STATE_MAX` characters. */
  state?: string;
  source: FailureSource;
}

/** A pull request a fix session opened, found by its branch. */
export interface FailurePr {
  url: string;
  number?: number;
  state: "open" | "merged" | "closed";
  mergedAt?: number;
}

export interface FailureFix {
  /** Tyler pressing Fix, or the auto-fix setting. */
  by: "you" | "auto";
  startedAt: number;
  /** The fix session's background terminal (`conch-<uuid>` on conch's tmux server). */
  backgroundId?: string;
  /** The branch the brief names, by which the desk finds the PR. */
  branch: string;
  pr?: FailurePr;
  /** When the desk last looked for its PR and its session. */
  checkedAt?: number;
}

export interface FailureTicket {
  /** The signature's stable key (failure-signature.ts): the same failure, the same ticket, across restarts. */
  id: string;
  /** For saying aloud and for the branch: `#12`, `fix/ticket-12`. Never reused. */
  number: number;
  origin: FailureOrigin;
  operation: string;
  /** The normalized message. */
  title: string;
  signature: string;
  status: FailureTicketStatus;
  /** When the status last changed. */
  statusAt: number;
  /** Why conch changed it, when conch did ("The PR was closed without merging."); cleared when Tyler acts. */
  note?: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  /** The sessions it happened in, most recent first, at most `TICKET_SESSIONS_MAX`. */
  sessions: Array<{ id: string; label?: string }>;
  example: FailureExample;
  /** New, or back, and not yet looked at in Settings › Failures. */
  unseen: boolean;
  /** Opened while auto-fix was on and not yet tried: auto-fix's queue, one at a time. */
  autoFixPending?: boolean;
  fix?: FailureFix;
  fixedAt?: number;
  /** A merged PR, or Tyler's Mark fixed: his is taken as live at once, a PR only once the code running is newer. */
  fixedBy?: "pr" | "you";
  /** How many times it came back after it was fixed. */
  reopened?: number;
}

interface FileCursor {
  /** The file's inode: a different one means it was rotated (`errors.jsonl` → `errors.jsonl.1`). */
  ino: number;
  offset: number;
}

export interface FailureTicketStore {
  v: 1;
  next: number;
  cursors: Partial<Record<FailureSource, FileCursor>>;
  tickets: FailureTicket[];
  /** Auto-fixes started on one local day, for its daily cap. */
  autoFix: { day: string; started: number };
}

export const TICKET_SESSIONS_MAX = 20;
export const EXAMPLE_MESSAGE_MAX = 1_200;
export const EXAMPLE_STATE_MAX = 2_400;
/** Tickets kept: fixed and ignored ones go first, the longest unseen first. */
export const TICKETS_MAX = 400;
/**
 * Records older than this are never filed: a first run reads the whole file back, and the list should start with what
 * is happening now, not with September. Later reads only ever find new records, so it only matters then.
 */
export const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1_000;
/** At most this much of a record file in one pass: a huge backlog is read over several. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** Auto-fix's daily cap (docs/failure-tickets.md): enough to clear a bad morning, too few to run away. */
export const AUTO_FIX_DAILY_CAP = 3;
/** The loop's own failures: never auto-fixed, so a fix that can't start can't start fixes of itself. */
export const LOOP_OPERATION = "failure-fix";
/** How often a fixing ticket's PR and session are looked at. */
export const FIX_CHECK_INTERVAL_MS = 5 * 60 * 1_000;
/** A session just started has had no time to register or open a PR: it isn't looked for as gone before this. */
const FIX_SESSION_GRACE_MS = 2 * 60 * 1_000;
/** A brief longer than this is cut: it is one argument on a tmux command line, whose message tmux caps at 16 KiB. */
export const BRIEF_MAX = 7_000;

export function failureTicketsPath(env: NodeJS.ProcessEnv = process.env, configDir = env.CONCH_CONFIG_DIR): string {
  return join(configDir ?? join(env.CONCH_HOME ?? env.HOME ?? "", ".config", "conch"), "failure-tickets.json");
}

export function emptyFailureTicketStore(): FailureTicketStore {
  return { v: 1, next: 1, cursors: {}, tickets: [], autoFix: { day: "", started: 0 } };
}

/** The store as saved, or an empty one: a file that won't parse is set aside, never trusted and never thrown on. */
export function readFailureTicketStore(path: string): FailureTicketStore {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return emptyFailureTicketStore(); }
  try {
    const parsed = JSON.parse(raw) as FailureTicketStore;
    if (parsed?.v !== 1 || !Array.isArray(parsed.tickets) || typeof parsed.next !== "number") throw new Error("not a store");
    return {
      v: 1,
      next: parsed.next,
      cursors: parsed.cursors && typeof parsed.cursors === "object" ? parsed.cursors : {},
      tickets: parsed.tickets.filter((ticket) => ticket && typeof ticket.id === "string" && FAILURE_TICKET_STATUSES.includes(ticket.status)),
      autoFix: parsed.autoFix && typeof parsed.autoFix.day === "string" ? parsed.autoFix : { day: "", started: 0 },
    };
  } catch {
    try { renameSync(path, `${path}.unreadable-${Date.now()}`); } catch {}
    return emptyFailureTicketStore();
  }
}

/** Whole, through a temporary file and a rename, owner-only: a crash mid-write leaves the last good store. */
export function writeFailureTicketStore(path: string, store: FailureTicketStore): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(store)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

// MARK: Reading the records

/**
 * A line of `errors.jsonl` as a failure. The label is the record's own (`state.label`, which an inject's carries), or
 * the daemon's row for its session at the time (`daemonState.rows`): a ticket that says which session is worth more
 * than one that says which id.
 */
export function occurrenceFromErrorRecord(line: string): FailureOccurrence | undefined {
  let record: Record<string, unknown>;
  try { record = JSON.parse(line); } catch { return undefined; }
  if (!record || typeof record !== "object") return undefined;
  const origin = record.source;
  if (typeof origin !== "string" || !FAILURE_ORIGINS.includes(origin as FailureOrigin) || origin === "mcp") return undefined;
  if (typeof record.operation !== "string" || typeof record.message !== "string") return undefined;
  const at = Date.parse(String(record.at));
  if (!Number.isFinite(at)) return undefined;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
  const state = record.state && typeof record.state === "object" && !Array.isArray(record.state)
    ? record.state as Record<string, unknown>
    : undefined;
  const rows = (record.daemonState as { rows?: Array<{ id?: unknown; label?: unknown }> } | null)?.rows;
  const rowLabel = sessionId ? rows?.find((row) => row.id === sessionId)?.label : undefined;
  const label = typeof state?.label === "string" && state.label ? state.label : typeof rowLabel === "string" ? rowLabel : undefined;
  return {
    at,
    origin: origin as FailureOrigin,
    operation: record.operation,
    message: record.message,
    ...(sessionId ? { sessionId } : {}),
    ...(label ? { label } : {}),
    ...(state ? { state } : {}),
    source: "errors",
  };
}

/**
 * A line of `mcp-usage.jsonl` as a failure, when the call didn't end `ok`: `failed` (conch's tool broke), `refused`
 * (conch said no, so the agent couldn't show or do it), `input-error` (the agent called it wrong, which a tool's
 * description is there to prevent). The operation names the tool and the outcome, so one tool's refusals and its
 * crashes are two tickets.
 */
export function occurrenceFromMcpRecord(line: string): FailureOccurrence | undefined {
  let record: Record<string, unknown>;
  try { record = JSON.parse(line); } catch { return undefined; }
  if (!record || typeof record !== "object" || record.outcome === "ok") return undefined;
  if (typeof record.tool !== "string" || typeof record.outcome !== "string" || typeof record.ts !== "number") return undefined;
  const sessionId = typeof record.session === "string" ? record.session : undefined;
  return {
    at: record.ts,
    origin: "mcp",
    operation: `${record.tool} ${record.outcome}`,
    message: typeof record.error === "string" && record.error ? record.error : record.outcome,
    ...(sessionId ? { sessionId } : {}),
    state: {
      ...(typeof record.backend === "string" ? { backend: record.backend } : {}),
      ...(typeof record.ms === "number" ? { ms: record.ms } : {}),
      ...(Array.isArray(record.args) ? { args: record.args } : {}),
    },
    source: "mcp-usage",
  };
}

/**
 * The complete lines a record file has gained since `cursor`, and where the next read starts. Rotation (a new inode)
 * finishes the old file, now `<path>.1`, from where it was left, then reads the new one from its start; a file
 * shorter than the cursor was truncated and is read again from its start. Without a cursor, the whole file: the
 * caller keeps only what is recent (`LOOKBACK_MS`).
 */
export function readNewLines(path: string, cursor: FileCursor | undefined): { lines: string[]; cursor: FileCursor | undefined } {
  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(path); } catch { return { lines: [], cursor }; }
  const lines: string[] = [];
  let offset = cursor?.offset ?? 0;
  if (cursor && cursor.ino !== stat.ino) {
    try {
      const rotated = statSync(`${path}.1`);
      if (rotated.ino === cursor.ino && rotated.size > cursor.offset) lines.push(...readRange(`${path}.1`, cursor.offset, rotated.size).lines);
    } catch {}
    offset = 0;
  } else if (cursor && stat.size < cursor.offset) {
    offset = 0;
  }
  const read = readRange(path, offset, Math.min(stat.size, offset + READ_CHUNK_BYTES));
  lines.push(...read.lines);
  return { lines, cursor: { ino: stat.ino, offset: read.end } };
}

/** The complete lines between two offsets, and the offset after the last complete one. */
function readRange(path: string, start: number, end: number): { lines: string[]; end: number } {
  if (end <= start) return { lines: [], end: start };
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = Math.min(end, fstatSync(fd).size) - start;
    if (size <= 0) return { lines: [], end: start };
    const buffer = Buffer.alloc(size);
    const got = readSync(fd, buffer, 0, size, start);
    const last = buffer.subarray(0, got).lastIndexOf(0x0a);
    if (last < 0) return { lines: [], end: start };
    const text = buffer.subarray(0, last).toString("utf8");
    return { lines: text.split("\n").filter(Boolean), end: start + last + 1 };
  } catch {
    return { lines: [], end: start };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

// MARK: Filing

/** What filing one occurrence did to its ticket: the auto-fix queue and the mirrors care about a ticket that opened. */
export type FilingOutcome = "opened" | "reopened" | "counted";

function exampleOf(occurrence: FailureOccurrence): FailureExample {
  let state: string | undefined;
  if (occurrence.state && Object.keys(occurrence.state).length) {
    try {
      state = JSON.stringify(occurrence.state);
      if (state.length > EXAMPLE_STATE_MAX) state = `${state.slice(0, EXAMPLE_STATE_MAX - 1)}…`;
    } catch {}
  }
  return {
    at: occurrence.at,
    message: occurrence.message.length > EXAMPLE_MESSAGE_MAX ? `${occurrence.message.slice(0, EXAMPLE_MESSAGE_MAX - 1)}…` : occurrence.message,
    ...(occurrence.sessionId ? { sessionId: occurrence.sessionId } : {}),
    ...(occurrence.label ? { label: occurrence.label } : {}),
    ...(state ? { state } : {}),
    source: occurrence.source,
  };
}

/**
 * File one occurrence under its ticket, making the ticket if it is the first. `codeSince` is when the code that saw it
 * started (the daemon's start): a ticket a PR fixed opens again only for a failure seen by code from after the merge,
 * since a merged fix is not running until conch is deployed and restarted, and the same failure in between is the old
 * code's, not the fix's. One Tyler marked fixed himself opens again on the next failure after he did.
 */
export function fileOccurrence(
  store: FailureTicketStore,
  occurrence: FailureOccurrence,
  options: { codeSince: number; autoFix: boolean },
): { ticket: FailureTicket; outcome: FilingOutcome } {
  const identity = failureIdentity(occurrence.origin, occurrence.operation, occurrence.message);
  let ticket = store.tickets.find((candidate) => candidate.id === identity.key);
  if (!ticket) {
    ticket = {
      id: identity.key,
      number: store.next++,
      origin: identity.origin,
      operation: identity.operation,
      title: identity.title,
      signature: identity.signature,
      status: "open",
      statusAt: occurrence.at,
      firstSeen: occurrence.at,
      lastSeen: occurrence.at,
      count: 1,
      sessions: occurrence.sessionId ? [{ id: occurrence.sessionId, ...(occurrence.label ? { label: occurrence.label } : {}) }] : [],
      example: exampleOf(occurrence),
      unseen: true,
      ...(options.autoFix && identity.operation !== LOOP_OPERATION ? { autoFixPending: true } : {}),
    };
    store.tickets.push(ticket);
    return { ticket, outcome: "opened" };
  }
  ticket.count += 1;
  ticket.firstSeen = Math.min(ticket.firstSeen, occurrence.at);
  // Records from two files interleave out of order: only a newer one is the example and the last seen.
  if (occurrence.at >= ticket.lastSeen) {
    ticket.lastSeen = occurrence.at;
    ticket.example = exampleOf(occurrence);
  }
  if (occurrence.sessionId) {
    const already = ticket.sessions.findIndex((session) => session.id === occurrence.sessionId);
    const label = occurrence.label ?? (already >= 0 ? ticket.sessions[already]!.label : undefined);
    if (already >= 0) ticket.sessions.splice(already, 1);
    ticket.sessions.unshift({ id: occurrence.sessionId, ...(label ? { label } : {}) });
    ticket.sessions.length = Math.min(ticket.sessions.length, TICKET_SESSIONS_MAX);
  }
  const fixLanded = ticket.fixedAt ?? ticket.statusAt;
  const fixRunning = ticket.fixedBy === "you" || options.codeSince > fixLanded;
  if (ticket.status === "fixed" && occurrence.at > fixLanded && fixRunning) {
    ticket.status = "open";
    ticket.statusAt = occurrence.at;
    ticket.unseen = true;
    ticket.reopened = (ticket.reopened ?? 0) + 1;
    ticket.note = ticket.fix?.pr ? `Came back after #${ticket.fix.pr.number ?? "?"} was merged.` : "Came back after it was marked fixed.";
    // One an auto-fix "fixed" that came back waits for Tyler: two machines agreeing it's fixed proved nothing.
    if (options.autoFix && ticket.fix?.by !== "auto" && ticket.operation !== LOOP_OPERATION) ticket.autoFixPending = true;
    return { ticket, outcome: "reopened" };
  }
  return { ticket, outcome: "counted" };
}

/** Over the cap, fixed and ignored tickets go first, those seen longest ago first; open ones are never dropped. */
export function pruneTickets(store: FailureTicketStore, max = TICKETS_MAX): void {
  if (store.tickets.length <= max) return;
  const droppable = store.tickets
    .filter((ticket) => ticket.status === "fixed" || ticket.status === "ignored")
    .sort((a, b) => a.lastSeen - b.lastSeen);
  const drop = new Set(droppable.slice(0, store.tickets.length - max).map((ticket) => ticket.id));
  store.tickets = store.tickets.filter((ticket) => !drop.has(ticket.id));
}

// MARK: Fix

/** The branch a ticket's fix lives on, and by which its PR is found. */
export function fixBranch(ticket: Pick<FailureTicket, "number">): string {
  return `fix/ticket-${ticket.number}`;
}

export interface BriefPaths {
  errors: string;
  mcpUsage: string;
  daemonLog: string;
}

/**
 * The first message of a fix session: the failure, its evidence, and how to work. The evidence is the ticket's, which
 * means the user's session names, folders and sometimes words, so rule 5 says in as many words that none of it may
 * leave in the PR: the repository is public.
 */
export function fixBrief(ticket: FailureTicket, paths: BriefPaths, now = Date.now()): string {
  const branch = fixBranch(ticket);
  const worktree = `.worktrees/ticket-${ticket.number}`;
  const when = (ms: number) => new Date(ms).toISOString();
  const local = (ms: number) => new Date(ms).toLocaleString("en-US", { hour12: false });
  const example = ticket.example;
  const sessions = ticket.sessions.length;
  const record = example.source === "mcp-usage"
    ? `${paths.mcpUsage} (the line with "ts":${example.at})`
    : `${paths.errors} (the line with "at":"${when(example.at)}")`;
  const lines = [
    `Fix conch failure ticket #${ticket.number}.`,
    "",
    `What went wrong: ${ticket.origin} · ${ticket.operation}: ${ticket.title}`,
    `Seen ${ticket.count} ${ticket.count === 1 ? "time" : "times"}${sessions ? ` in ${sessions} ${sessions === 1 ? "session" : "sessions"}` : ""}, first ${when(ticket.firstSeen)}, last ${when(ticket.lastSeen)}.`,
    ...(ticket.reopened && ticket.fix?.pr ? [`It came back after ${ticket.fix.pr.url} was merged: that fix didn't hold.`] : []),
    "",
    "The latest occurrence, from conch's private failure records (it can hold session names, folder paths and the user's words):",
    `- when: ${when(example.at)} (${local(example.at)} local)`,
    `- message: ${example.message}`,
    ...(example.sessionId ? [`- session: ${example.label ? `"${example.label}" ` : ""}${example.sessionId}`] : []),
    ...(example.state ? [`- state: ${example.state}`] : []),
    `- the whole record: ${record}`,
    `- the daemon's log around then: ${paths.daemonLog} (it rotates; it may no longer reach back that far)`,
    "",
    "How to work:",
    `1. Work in a worktree: git fetch origin && git worktree add ${worktree} -b ${branch} origin/main. Never on main, and leave every other worktree alone.`,
    "2. Read CLAUDE.md first. Find the root cause. If it isn't a conch bug (an expected refusal, the Mac's environment, a file the user deleted), say so plainly and stop without a PR.",
    "3. Add a regression test that fails before the fix and passes after it. Run scripts/ci-local.sh and read its exit code (never pipe it through tail).",
    `4. Commit, push and open a PR from ${branch} with gh. Don't merge it, and don't deploy: no scripts/build-app.sh, no restarting conch's daemon or app.`,
    "5. The repository is PUBLIC. Nothing from the evidence above goes into a commit, the PR, a test, a fixture or a comment: no session names, folder paths, client or project names, or the user's words. Describe the bug in general terms and make the fixtures up.",
    "6. You run inside conch's own tmux: never run bare tmux, and never tmux kill-server.",
    "7. Don't file anything anywhere else: no GitHub issue, no other service. The PR is the only thing that leaves this Mac.",
    "",
    `conch links the PR to the ticket by its branch (${branch}) and marks the ticket fixed when the PR is merged.`,
  ];
  const brief = lines.join("\n");
  return brief.length > BRIEF_MAX ? `${brief.slice(0, BRIEF_MAX - 1)}…` : brief;
}

/** The local day, for auto-fix's daily cap: a cap that rolled over at UTC midnight would reset mid-evening here. */
export function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// MARK: The mirror seam

/**
 * A private place tickets could also be filed — Linear, say — once Tyler picks one. **None is built, and none is on.**
 *
 * A mirror, when there is one, must be: opt-in (a setting that ships off); private (never GitHub: conch's repository
 * is public, and so would be its issues); given what it needs and no more (the title, counts and status, never the
 * example's state or the user's words unless the owner chose that service for them); and best effort (a mirror that
 * fails never holds up the desk). `file` is called when a ticket opens or comes back.
 */
export interface FailureMirror {
  readonly name: string;
  file(ticket: Readonly<FailureTicket>): Promise<void>;
}

/** Empty, on purpose (above). */
export const FAILURE_MIRRORS: readonly FailureMirror[] = [];

// MARK: The desk

export interface FixRequest {
  /** The conch checkout the session starts in. */
  cwd: string;
  prompt: string;
}

export interface FailureDeskOptions {
  storePath?: string;
  errorsPath: string;
  mcpUsagePath: string;
  daemonLogPath: string;
  now?: () => number;
  /** When the running code started (the daemon's start): see `fileOccurrence`. */
  codeSince: number;
  log(line: string): void;
  /** The `failure-autofix` setting, read live. */
  autoFix(): boolean;
  /** The conch checkout a fix session works in, or why there is none (a Homebrew install has no git checkout). */
  fixFolder(): { folder: string } | { reason: string };
  /** Start a fix session: the daemon's own session start (`launchSession`), background, Default account. */
  startFix(request: FixRequest): Promise<{ backgroundId?: string }>;
  /** Whether a fix session's background terminal is still there; undefined when it can't be told. */
  fixSessionAlive?(backgroundId: string): Promise<boolean | undefined>;
  /** The PR on a branch, by reading GitHub (`gh pr list --head`), or null for none; undefined when it can't be told. */
  findPr?(folder: string, branch: string): Promise<FailurePr | null | undefined>;
  /** Record a failure of the loop itself (`failure-fix`), which comes back here as a ticket like any other. */
  recordFailure?(operation: string, message: string, state: Record<string, unknown>): void;
  /** Something a client shows changed: the published counts. */
  changed?(): void;
  mirrors?: readonly FailureMirror[];
}

export type FailureTicketAction = "fix" | "ignore" | "reopen" | "mark-fixed" | "seen" | "show";
export const FAILURE_TICKET_ACTIONS: readonly FailureTicketAction[] = ["fix", "ignore", "reopen", "mark-fixed", "seen", "show"];

/** What the published state carries: enough for the gear's dot and the section's count, nothing a phone needn't see. */
export interface FailureDigest {
  open: number;
  fixing: number;
  unseen: number;
}

export class FailureDesk {
  readonly storePath: string;
  private store: FailureTicketStore;
  private readonly now: () => number;
  /** A fix being started: auto-fix's one-at-a-time holds across the await. */
  private starting = false;
  /** Tickets whose fix is being started: a second press while the first launch is still under way starts nothing. */
  private readonly startingTickets = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private checkTimer: ReturnType<typeof setInterval> | undefined;
  private checking: Promise<void> | undefined;

  constructor(private readonly options: FailureDeskOptions) {
    this.storePath = options.storePath ?? failureTicketsPath();
    this.now = options.now ?? Date.now;
    this.store = readFailureTicketStore(this.storePath);
  }

  /** Read what the records gained since last time and file it. Returns whether anything changed. */
  poll(): boolean {
    const now = this.now();
    const autoFix = this.options.autoFix();
    let changed = false;
    const opened: FailureTicket[] = [];
    for (const [source, path, parse] of [
      ["errors", this.options.errorsPath, occurrenceFromErrorRecord],
      ["mcp-usage", this.options.mcpUsagePath, occurrenceFromMcpRecord],
    ] as const) {
      const { lines, cursor } = readNewLines(path, this.store.cursors[source]);
      if (cursor && (cursor.ino !== this.store.cursors[source]?.ino || cursor.offset !== this.store.cursors[source]?.offset)) {
        this.store.cursors[source] = cursor;
        changed = true;
      }
      for (const line of lines) {
        const occurrence = parse(line);
        if (!occurrence) continue;
        if (occurrence.at < now - LOOKBACK_MS) continue;
        const { ticket, outcome } = fileOccurrence(this.store, occurrence, { codeSince: this.options.codeSince, autoFix });
        if (outcome !== "counted" && !opened.includes(ticket)) opened.push(ticket);
        changed = true;
      }
    }
    if (!changed) return false;
    pruneTickets(this.store);
    this.save();
    for (const ticket of opened) {
      this.options.log(`failure ticket #${ticket.number} ${ticket.reopened && ticket.status === "open" ? "came back" : "opened"}: ${ticket.origin} · ${ticket.operation} · ${ticket.title}`);
      for (const mirror of this.options.mirrors ?? FAILURE_MIRRORS) {
        void mirror.file(ticket).catch((error) => this.options.log(`failure mirror ${mirror.name}: ${error}`));
      }
    }
    this.options.changed?.();
    void this.autoFixNext();
    return true;
  }

  digest(): FailureDigest {
    let open = 0;
    let fixing = 0;
    let unseen = 0;
    for (const ticket of this.store.tickets) {
      if (ticket.status === "open") open += 1;
      if (ticket.status === "fixing") fixing += 1;
      if (ticket.unseen && ticket.status === "open") unseen += 1;
    }
    return { open, fixing, unseen };
  }

  tickets(): readonly FailureTicket[] {
    return this.store.tickets;
  }

  /** The list a client shows (`failure-tickets`), compact enough for one control frame. */
  list(): FailureTicketList {
    const fix = this.options.fixFolder();
    const today = localDay(this.now());
    return fitFailureTicketList({
      kind: "failure-tickets",
      tickets: listedTickets(this.store.tickets, this.now()),
      autoFix: {
        on: this.options.autoFix(),
        today: this.store.autoFix.day === today ? this.store.autoFix.started : 0,
        cap: AUTO_FIX_DAILY_CAP,
      },
      fix: "folder" in fix ? { available: true, folder: fix.folder } : { available: false, reason: fix.reason },
    });
  }

  /** One of Tyler's actions on a ticket, or on every ticket for `seen` with id "all". */
  async act(id: string, action: FailureTicketAction): Promise<FailureTicketReply> {
    if (action === "seen") {
      let changed = false;
      for (const ticket of this.store.tickets) {
        if ((id === "all" || ticket.id === id) && ticket.unseen) {
          ticket.unseen = false;
          changed = true;
        }
      }
      if (changed) {
        this.save();
        this.options.changed?.();
      }
      return { kind: "failure-ticket-ack" };
    }
    const ticket = this.store.tickets.find((candidate) => candidate.id === id);
    if (!ticket) return { kind: "failure-ticket-error", error: "That ticket isn't here any more." };
    if (action === "show") return { kind: "failure-ticket", ticket: shownTicket(ticket) };
    const now = this.now();
    if (action === "fix") {
      if (ticket.status === "fixing" || this.startingTickets.has(ticket.id)) {
        return { kind: "failure-ticket-error", error: `#${ticket.number} is already being fixed.` };
      }
      const started = await this.startFix(ticket, "you");
      if (!started.ok) return { kind: "failure-ticket-error", error: started.error };
    } else if (action === "ignore") {
      this.setStatus(ticket, "ignored", now);
    } else if (action === "reopen") {
      this.setStatus(ticket, "open", now);
    } else if (action === "mark-fixed") {
      this.setStatus(ticket, "fixed", now);
      ticket.fixedAt = now;
      ticket.fixedBy = "you";
    }
    ticket.autoFixPending = undefined;
    ticket.note = undefined;
    ticket.unseen = false;
    this.save();
    this.options.changed?.();
    return { kind: "failure-ticket", ticket: shownTicket(ticket) };
  }

  /** Look at every fixing ticket's PR and session (`FIX_CHECK_INTERVAL_MS`); one look at a time. */
  checkFixes(): Promise<void> {
    this.checking ??= this.checkFixesOnce().finally(() => { this.checking = undefined; });
    return this.checking;
  }

  start(pollMs = 5_000, checkMs = FIX_CHECK_INTERVAL_MS): void {
    this.poll();
    this.pollTimer = setInterval(() => {
      try { this.poll(); } catch (error) { this.options.log(`failure tickets: ${error}`); }
    }, pollMs);
    this.checkTimer = setInterval(() => void this.checkFixes().catch((error) => this.options.log(`failure tickets: ${error}`)), checkMs);
    this.pollTimer.unref?.();
    this.checkTimer.unref?.();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.pollTimer = undefined;
    this.checkTimer = undefined;
  }

  private setStatus(ticket: FailureTicket, status: FailureTicketStatus, at: number): void {
    ticket.status = status;
    ticket.statusAt = at;
  }

  private save(): void {
    try { writeFailureTicketStore(this.storePath, this.store); }
    catch (error) { this.options.log(`could not save failure tickets: ${error}`); }
  }

  private async startFix(ticket: FailureTicket, by: FailureFix["by"]): Promise<{ ok: true } | { ok: false; error: string }> {
    const where = this.options.fixFolder();
    if (!("folder" in where)) return { ok: false, error: where.reason };
    const prompt = fixBrief(ticket, {
      errors: this.options.errorsPath,
      mcpUsage: this.options.mcpUsagePath,
      daemonLog: this.options.daemonLogPath,
    }, this.now());
    this.starting = true;
    this.startingTickets.add(ticket.id);
    try {
      const { backgroundId } = await this.options.startFix({ cwd: where.folder, prompt });
      const now = this.now();
      ticket.fix = { by, startedAt: now, branch: fixBranch(ticket), ...(backgroundId ? { backgroundId } : {}) };
      this.setStatus(ticket, "fixing", now);
      this.options.log(`failure ticket #${ticket.number}: fix session started${by === "auto" ? " (auto-fix)" : ""}${backgroundId ? ` in ${backgroundId}` : ""}`);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.log(`failure ticket #${ticket.number}: the fix session didn't start: ${message}`);
      this.options.recordFailure?.(LOOP_OPERATION, `The fix session didn't start: ${message}`, { ticket: ticket.number, by });
      return { ok: false, error: `The fix session didn't start: ${message}` };
    } finally {
      this.starting = false;
      this.startingTickets.delete(ticket.id);
    }
  }

  /**
   * Auto-fix (`failure-autofix`): the oldest ticket that opened while it was on, when no other fix is under way (a
   * fixing ticket with no PR yet, or one being started) and today's cap isn't spent. Never the loop's own failures,
   * never one an auto-fix already fixed that came back (`fileOccurrence`).
   */
  async autoFixNext(): Promise<void> {
    if (!this.options.autoFix() || this.starting) return;
    if (this.store.tickets.some((ticket) => ticket.status === "fixing" && !ticket.fix?.pr)) return;
    const today = localDay(this.now());
    if (this.store.autoFix.day !== today) this.store.autoFix = { day: today, started: 0 };
    if (this.store.autoFix.started >= AUTO_FIX_DAILY_CAP) return;
    const next = this.store.tickets
      .filter((ticket) => ticket.autoFixPending && ticket.status === "open" && ticket.operation !== LOOP_OPERATION)
      .sort((a, b) => a.statusAt - b.statusAt)[0];
    if (!next) return;
    next.autoFixPending = undefined;
    this.store.autoFix.started += 1;
    await this.startFix(next, "auto");
    this.save();
    this.options.changed?.();
  }

  private async checkFixesOnce(): Promise<void> {
    const where = this.options.fixFolder();
    const now = this.now();
    let changed = false;
    for (const ticket of this.store.tickets) {
      const fix = ticket.fix;
      if (ticket.status !== "fixing" || !fix) continue;
      fix.checkedAt = now;
      changed = true;
      const pr = "folder" in where ? await this.options.findPr?.(where.folder, fix.branch) : undefined;
      if (pr) {
        const linked = !fix.pr || fix.pr.url !== pr.url;
        fix.pr = pr;
        if (pr.state === "merged") {
          this.setStatus(ticket, "fixed", pr.mergedAt ?? now);
          ticket.fixedAt = pr.mergedAt ?? now;
          ticket.fixedBy = "pr";
          ticket.note = undefined;
          this.options.log(`failure ticket #${ticket.number}: fixed by ${pr.url}`);
        } else if (pr.state === "closed") {
          this.setStatus(ticket, "open", now);
          ticket.unseen = true;
          ticket.note = `${pr.url} was closed without merging.`;
        } else if (linked) {
          this.options.log(`failure ticket #${ticket.number}: ${pr.url}`);
        }
        continue;
      }
      // No PR (or none could be read): a fix session that has gone without one leaves the ticket open again.
      if (pr === null && fix.backgroundId && now - fix.startedAt > FIX_SESSION_GRACE_MS
        && await this.options.fixSessionAlive?.(fix.backgroundId) === false) {
        this.setStatus(ticket, "open", now);
        ticket.unseen = true;
        ticket.note = "The fix session ended without opening a PR.";
        this.options.log(`failure ticket #${ticket.number}: the fix session ended without a PR`);
      }
    }
    if (!changed) return;
    this.save();
    this.options.changed?.();
    void this.autoFixNext();
  }
}

// MARK: What clients see

/** A ticket in the list: everything but its example's evidence and its sessions' ids, which `show` gives. */
export interface ListedTicket {
  id: string;
  number: number;
  origin: FailureOrigin;
  operation: string;
  title: string;
  status: FailureTicketStatus;
  statusAt: number;
  note?: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  sessionCount: number;
  unseen: boolean;
  fix?: { by: FailureFix["by"]; startedAt: number; backgroundId?: string; branch: string; pr?: FailurePr };
  fixedAt?: number;
  reopened?: number;
}

export interface FailureTicketList {
  kind: "failure-tickets";
  tickets: ListedTicket[];
  /** Fixed tickets older than `LISTED_FIXED_MS`, and ignored ones over `LISTED_IGNORED_MAX`, left out. */
  hidden?: number;
  autoFix: { on: boolean; today: number; cap: number };
  fix: { available: true; folder: string } | { available: false; reason: string };
}

export type FailureTicketReply =
  | { kind: "failure-ticket"; ticket: FailureTicket }
  | { kind: "failure-ticket-ack" }
  | { kind: "failure-ticket-error"; error: string };

/** Fixed tickets stay listed this long after their fix; the store keeps them longer, to reopen. */
export const LISTED_FIXED_MS = 14 * 24 * 60 * 60 * 1_000;
export const LISTED_MAX = 120;

/** What `show` sends: the ticket whole, its evidence bounded already (`exampleOf`). */
function shownTicket(ticket: FailureTicket): FailureTicket {
  return structuredClone({ ...ticket, autoFixPending: undefined });
}

const STATUS_ORDER: Record<FailureTicketStatus, number> = { open: 0, fixing: 1, fixed: 2, ignored: 3 };

/** Open first (newest first), then fixing, fixed in the last two weeks, ignored; at most `LISTED_MAX`. */
export function listedTickets(tickets: readonly FailureTicket[], now: number): ListedTicket[] {
  return tickets
    .filter((ticket) => ticket.status !== "fixed" || now - (ticket.fixedAt ?? ticket.statusAt) < LISTED_FIXED_MS)
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastSeen - a.lastSeen)
    .slice(0, LISTED_MAX)
    .map((ticket) => ({
      id: ticket.id,
      number: ticket.number,
      origin: ticket.origin,
      operation: ticket.operation,
      title: ticket.title,
      status: ticket.status,
      statusAt: ticket.statusAt,
      ...(ticket.note ? { note: ticket.note } : {}),
      firstSeen: ticket.firstSeen,
      lastSeen: ticket.lastSeen,
      count: ticket.count,
      sessionCount: ticket.sessions.length,
      unseen: ticket.unseen,
      ...(ticket.fix ? {
        fix: {
          by: ticket.fix.by,
          startedAt: ticket.fix.startedAt,
          branch: ticket.fix.branch,
          ...(ticket.fix.backgroundId ? { backgroundId: ticket.fix.backgroundId } : {}),
          ...(ticket.fix.pr ? { pr: ticket.fix.pr } : {}),
        },
      } : {}),
      ...(ticket.fixedAt ? { fixedAt: ticket.fixedAt } : {}),
      ...(ticket.reopened ? { reopened: ticket.reopened } : {}),
    }));
}

/** One control frame is 64 KiB (control-framing.ts); the list keeps some room under it. */
export const LIST_FRAME_BUDGET = 60 * 1024;

/**
 * The list cut until it fits one frame: ignored tickets go first, then the fixed, then the oldest of what is left, and
 * `hidden` says how many went. A hundred and twenty tickets fit with room; this is for a very bad week.
 */
export function fitFailureTicketList(list: FailureTicketList, budget = LIST_FRAME_BUDGET): FailureTicketList {
  const size = (value: FailureTicketList) => Buffer.byteLength(JSON.stringify(value));
  if (size(list) <= budget) return list;
  let tickets = list.tickets.filter((ticket) => ticket.status !== "ignored");
  if (size({ ...list, tickets }) > budget) tickets = tickets.filter((ticket) => ticket.status !== "fixed");
  while (tickets.length && size({ ...list, tickets, hidden: list.tickets.length }) > budget) tickets = tickets.slice(0, Math.floor(tickets.length * 0.8));
  return { ...list, tickets, hidden: (list.hidden ?? 0) + list.tickets.length - tickets.length };
}

// MARK: Where fixes happen

/**
 * The conch checkout a fix session works in: the one this daemon runs from (`~/conch` → `~/Projects/Conch` here),
 * when it is a git checkout. A Homebrew install runs from the Cellar, which has no repository to open a PR from, and
 * says so rather than starting a session that can only fail. `CONCH_FIX_FOLDER` names another (tests, a sandbox).
 */
export function conchCheckout(env: NodeJS.ProcessEnv = process.env, root = join(import.meta.dir, "..")): { folder: string } | { reason: string } {
  const named = env.CONCH_FIX_FOLDER?.trim();
  let folder: string;
  try { folder = realpathSync(named || root); } catch { return { reason: `The fix folder ${named || root} isn't there.` }; }
  if (!existsSync(join(folder, ".git"))) {
    return { reason: "conch isn't running from a git checkout here, so a fix has nowhere to open a PR from." };
  }
  return { folder };
}

/** `gh`, where Homebrew puts it: the daemon the app starts may have a short PATH. `CONCH_GH` names another (tests). */
export function ghPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CONCH_GH) return env.CONCH_GH;
  return Bun.which("gh") ?? ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].find((candidate) => existsSync(candidate));
}

/**
 * The PR on a branch, read from GitHub with `gh pr list --head`, in the checkout so it is that repository's. Only ever
 * reads. Null when there is none; undefined when it can't be told (no gh, signed out, offline, too slow), which leaves
 * the ticket as it was.
 */
export async function ghBranchPr(folder: string, branch: string, gh = ghPath(), timeoutMs = 20_000): Promise<FailurePr | null | undefined> {
  if (!gh) return undefined;
  try {
    const child = Bun.spawn([gh, "pr", "list", "--head", branch, "--state", "all", "--json", "url,number,state,mergedAt", "--limit", "1"], {
      cwd: folder, stdout: "pipe", stderr: "ignore", stdin: "ignore",
    });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    clearTimeout(timer);
    if (code !== 0) return undefined;
    const rows = JSON.parse(text) as Array<{ url?: unknown; number?: unknown; state?: unknown; mergedAt?: unknown }>;
    const row = rows[0];
    if (!row) return null;
    if (typeof row.url !== "string") return undefined;
    const state = String(row.state).toUpperCase() === "MERGED" ? "merged" : String(row.state).toUpperCase() === "CLOSED" ? "closed" : "open";
    const mergedAt = typeof row.mergedAt === "string" ? Date.parse(row.mergedAt) : NaN;
    return {
      url: row.url,
      ...(typeof row.number === "number" ? { number: row.number } : {}),
      state,
      ...(Number.isFinite(mergedAt) ? { mergedAt } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether a background session's terminal is still on conch's tmux server: `has-session`, which answers 0 for there and
 * 1 for gone. Undefined for anything else (no tmux, a hang), which never sends a ticket back to open.
 */
export async function tmuxSessionAlive(tmux: readonly string[], name: string, timeoutMs = 4_000): Promise<boolean | undefined> {
  try {
    const child = Bun.spawn([...tmux, "has-session", "-t", `=${name}`], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    const code = await child.exited;
    clearTimeout(timer);
    return code === 0 ? true : code === 1 ? false : undefined;
  } catch {
    return undefined;
  }
}

// MARK: The socket

export type FailureTicketRequest =
  | { kind: "failure-tickets" }
  | { kind: "failure-ticket"; id: string; action: FailureTicketAction };

/**
 * `{kind: "failure-tickets"}` and `{kind: "failure-ticket", id, action}`, checked strictly; null for any other
 * message. The Mac app's and the CLI's alone: the phone bridge refuses both (`MAC_APP_ONLY_DECODERS`).
 */
export function decodeFailureTicketRequest(body: unknown): FailureTicketRequest | { error: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (value.kind === "failure-tickets") return { kind: "failure-tickets" };
  if (value.kind !== "failure-ticket") return null;
  if (typeof value.id !== "string" || !/^(?:[0-9a-f]{12}|all)$/.test(value.id)) return { error: "a ticket id is 12 hex characters, or all" };
  if (typeof value.action !== "string" || !FAILURE_TICKET_ACTIONS.includes(value.action as FailureTicketAction)) {
    return { error: `action must be one of ${FAILURE_TICKET_ACTIONS.join(", ")}` };
  }
  if (value.id === "all" && value.action !== "seen") return { error: "only seen takes all" };
  return { kind: "failure-ticket", id: value.id, action: value.action as FailureTicketAction };
}

// MARK: `conch failures`

/**
 * `conch failures [--all] [--json]`: the tickets, from the store, as Settings › Failures lists them. Reads only; the
 * daemon owns the store. `--from-logs` groups the records themselves without the store (and without the first run's
 * look-back), for seeing what the history would make.
 */
export function runFailuresCli(args: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  const all = args.includes("--all");
  const json = args.includes("--json");
  const now = Date.now();
  let tickets: FailureTicket[];
  if (args.includes("--from-logs")) {
    const configDir = env.CONCH_CONFIG_DIR ?? join(env.CONCH_HOME ?? env.HOME ?? "", ".config", "conch");
    const store = emptyFailureTicketStore();
    for (const [path, parse] of [
      [join(configDir, "errors.jsonl"), occurrenceFromErrorRecord],
      [env.CONCH_MCP_USAGE_FILE || join(configDir, "mcp-usage.jsonl"), occurrenceFromMcpRecord],
    ] as const) {
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const occurrence = line ? parse(line) : undefined;
        if (occurrence) fileOccurrence(store, occurrence, { codeSince: now, autoFix: false });
      }
    }
    tickets = store.tickets;
  } else {
    tickets = readFailureTicketStore(failureTicketsPath(env)).tickets;
  }
  const shown = all ? [...tickets].sort((a, b) => b.lastSeen - a.lastSeen) : listedTickets(tickets, now).map((listed) => tickets.find((ticket) => ticket.id === listed.id)!);
  if (json) {
    console.log(JSON.stringify(shown, null, 2));
    return 0;
  }
  if (!shown.length) {
    console.log("No failure tickets.");
    return 0;
  }
  const ago = (ms: number) => {
    const minutes = Math.max(0, Math.round((now - ms) / 60_000));
    return minutes < 60 ? `${minutes}m` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
  };
  for (const ticket of shown) {
    const pr = ticket.fix?.pr ? `  ${ticket.fix.pr.url} (${ticket.fix.pr.state})` : "";
    console.log(`#${String(ticket.number).padEnd(4)} ${ticket.status.padEnd(7)} ${String(ticket.count).padStart(4)}×  ${String(ticket.sessions.length).padStart(2)} sess  ${ago(ticket.lastSeen).padStart(4)} ago  ${ticket.origin} · ${ticket.operation} · ${ticket.title}${pr}`);
  }
  return 0;
}
