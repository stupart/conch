/**
 * See Codex sessions in conch without touching them.
 *
 * conch's other Codex path (`codex-sessions.ts`) is fed by `conch codex-hook`,
 * which needs hooks wired into ~/.codex — shared config that only takes effect
 * on session start. Tyler's constraint rules that out: "be careful not to mess
 * up my live working codex session but it would be nice to see them in the
 * apps... without turning them off or messing with them". You cannot wire a
 * hook into a session that is already running.
 *
 * Codex 0.147 keeps everything needed in two SQLite databases under ~/.codex,
 * so conch can simply LOOK. Opened read-only, this cannot take a write lock on
 * a database Codex is actively using, and a running session never learns conch
 * is there.
 *
 *   state_5.sqlite        threads      — id, cwd, name/agent_nickname/title
 *   thread_history_1.sqlite thread_turns — status: inProgress | completed
 *
 * `thread_turns.status` maps exactly onto the existing "busy" | "idle", so this
 * feeds the ledger conch already has rather than inventing a parallel one.
 */
import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexSessionEntry, CodexSessionRegistryRead } from "./codex-sessions.ts";

export interface CodexThreadsOptions {
  /**
   * Codex's home. Defaults to ~/.codex — but ONLY when the caller has not
   * redirected conch's own state via `configDir`.
   *
   * Anything that sets `configDir` (every test, and any sandboxed front-end)
   * is declaring it does not want to touch the real machine. Without this rule
   * a registry test running in a temp directory silently read the developer's
   * actual Codex sessions and asserted against whatever they happened to be
   * doing — which is how this was found: five unrelated tests started failing
   * because two live threads appeared in a snapshot built from an empty dir.
   */
  codexHome?: string;
  /** Set when conch's own state is redirected; suppresses the real-home default. */
  configDir?: string;
  /**
   * How recently a thread must have been touched to count as live.
   *
   * Claude's registry is per-pid files that vanish with the process. These rows
   * are permanent history — every conversation ever held — so without a window
   * the ledger fills with months of dead threads. Recency is the only liveness
   * signal available from disk.
   */
  liveWithinMs?: number;
  now?: number;
}

const DEFAULT_LIVE_WITHIN_MS = 30 * 60 * 1000;

/** Where Codex keeps thread metadata and per-turn status, respectively. */
export function codexThreadDbPaths(codexHome: string): { state: string; history: string } {
  return {
    state: join(codexHome, "state_5.sqlite"),
    history: join(codexHome, "thread_history_1.sqlite"),
  };
}

function openReadOnly(path: string): Database {
  // `readonly` is the whole safety story: Codex may be mid-write in another
  // process, and conch must never be the reason its database is locked.
  return new Database(path, { readonly: true });
}

/**
 * Label a Codex row from the THREAD, never from its directory.
 *
 * conch labels a Claude session by directory basename, which works because
 * those live in different repos. Every one of Tyler's Codex threads runs from
 * his home directory, so that rule would render every row "tylerstupart".
 */
export function codexThreadLabel(row: {
  name?: string | null;
  agent_nickname?: string | null;
  title?: string | null;
}): string | undefined {
  for (const candidate of [row.name, row.agent_nickname, row.title]) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed.length > 40 ? `${trimmed.slice(0, 39)}…` : trimmed;
  }
  return undefined;
}

/** How recently a thread must have been written to for recency to imply "working". */
const ACTIVE_WITHIN_MS = 20_000;

/**
 * Busy or idle, preferring the authoritative signal and falling back to recency.
 *
 * `thread_turns` states it outright, but only covers some threads. For the rest
 * the only stateless evidence is that Codex just wrote to the row.
 */
export function codexThreadStatus(
  projectedStatus: string | undefined,
  updatedAtMs: number,
  now: number,
): "busy" | "idle" {
  if (projectedStatus === "inProgress") return "busy";
  if (projectedStatus === "completed") return "idle";
  return now - updatedAtMs <= ACTIVE_WITHIN_MS ? "busy" : "idle";
}

/** A Codex thread's rollout file as it looked at one poll. */
export interface CodexTurnSnapshot {
  sessionId: string;
  label: string;
  cwd: string;
  transcriptPath: string;
  /** Growth is the only "still working" signal available without a hook. */
  size: number;
  /** Identity of the agent's most recent message, so a NEW one is detectable. */
  messageId: string;
  text: string;
}

/** Per-session poll memory: what was last announced, and how big the file was. */
export interface CodexTurnMemoryEntry {
  announcedMessageId: string;
  size: number;
}
export type CodexTurnMemory = Map<string, CodexTurnMemoryEntry>;

/**
 * Which Codex threads have just finished a turn.
 *
 * There is no Stop hook here, so "finished" has to be inferred from the file
 * Codex is writing. Two conditions together, and neither alone is enough:
 *
 *  - the agent's latest message is one conch has not announced, and
 *  - the rollout file has stopped growing since the previous poll.
 *
 * The stability half is what stops conch talking over a turn in progress: Codex
 * streams reasoning, command output and file changes into the same file, and an
 * agent_message frequently lands mid-turn with more work still to come. Waiting
 * for one quiet interval costs a few seconds of latency and buys never
 * interrupting.
 *
 * A session seen for the first time is seeded silently. These rollouts are
 * permanent history, so announcing on first sight would make every daemon
 * restart read out a backlog of turns that finished hours ago.
 */
export function detectCodexTurnEnds(
  memory: CodexTurnMemory,
  snapshots: readonly CodexTurnSnapshot[],
): CodexTurnSnapshot[] {
  const ended: CodexTurnSnapshot[] = [];
  for (const snapshot of snapshots) {
    const seen = memory.get(snapshot.sessionId);
    if (seen === undefined) {
      // First sighting: adopt the current message as already-announced.
      memory.set(snapshot.sessionId, {
        announcedMessageId: snapshot.messageId,
        size: snapshot.size,
      });
      continue;
    }
    const settled = seen.size === snapshot.size;
    const isNew = snapshot.messageId !== "" && snapshot.messageId !== seen.announcedMessageId;
    if (settled && isNew) {
      ended.push(snapshot);
      memory.set(snapshot.sessionId, {
        announcedMessageId: snapshot.messageId,
        size: snapshot.size,
      });
      continue;
    }
    // Still moving: record the new size but keep the announced id, so the turn
    // is announced once it settles rather than being forgotten.
    memory.set(snapshot.sessionId, {
      announcedMessageId: seen.announcedMessageId,
      size: snapshot.size,
    });
  }
  // Forget sessions that dropped out of the window, so one returning later is
  // seeded again rather than replaying its last turn.
  const live = new Set(snapshots.map((s) => s.sessionId));
  for (const sessionId of [...memory.keys()]) {
    if (!live.has(sessionId)) memory.delete(sessionId);
  }
  return ended;
}

/**
 * Is this message addressed to another agent rather than to the user?
 *
 * Subagent traffic rides the same `agent_message` stream as real replies, with
 * a header envelope. Matching the header rather than the word "FINAL_ANSWER"
 * anywhere keeps a genuine reply that happens to discuss it.
 */
export function isInterAgentEnvelope(text: string): boolean {
  const head = text.slice(0, 200);
  return /^\s*Message Type:\s*\w+/.test(head) && /\n\s*(Sender|Task name):/.test(head);
}

/** The agent's most recent message in a rollout, read from the tail only. */
export function readCodexRolloutTail(
  path: string,
  tailBytes = 256 * 1024,
): { size: number; messageId: string; text: string } | null {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  // These files reach tens of megabytes — one of Tyler's is 25 MB — and are
  // polled continuously, so only the tail is ever read.
  const start = Math.max(0, size - tailBytes);
  let chunk: string;
  try {
    const fd = openSync(path, "r");
    try {
      const length = size - start;
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, start);
      chunk = buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = chunk.split("\n");
  // A tail read almost always begins mid-line; that fragment is not JSON.
  if (start > 0) lines.shift();
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = parsed?.payload;
    if (parsed?.type !== "response_item" || payload?.type !== "agent_message") continue;
    const text = typeof payload.text === "string"
      ? payload.text
      : Array.isArray(payload.content)
        ? payload.content.map((part: any) => part?.text ?? "").join("")
        : "";
    // Skip machine-to-machine traffic and keep looking further back.
    //
    // A session that spawns subagents carries their protocol envelopes in the
    // same stream, as ordinary agent_message items. Tyler's "humain" thread
    // ended on "Message Type: FINAL_ANSWER / Task name: /root / Sender: ..."
    // — addressed to a parent agent, not to him. Reading that out loud is
    // worse than saying nothing.
    if (isInterAgentEnvelope(text)) continue;
    return { size, messageId: String(payload.id ?? `${size}:${text.length}`), text };
  }
  return { size, messageId: "", text: "" };
}

/** Every observable Codex thread's rollout tail, for turn-end detection. */
export function readCodexTurnSnapshots(
  options: CodexThreadsOptions = {},
): CodexTurnSnapshot[] {
  const read = readCodexThreads(options);
  if (!read.available) return [];
  const snapshots: CodexTurnSnapshot[] = [];
  for (const entry of read.entries) {
    if (!entry.transcriptPath) continue;
    const tail = readCodexRolloutTail(entry.transcriptPath);
    if (!tail) continue;
    snapshots.push({
      sessionId: entry.sessionId,
      label: (entry as any).name ?? entry.sessionId.slice(0, 8),
      cwd: entry.cwd,
      transcriptPath: entry.transcriptPath,
      size: tail.size,
      messageId: tail.messageId,
      text: tail.text,
    });
  }
  return snapshots;
}

export function readCodexThreads(
  options: CodexThreadsOptions = {},
): CodexSessionRegistryRead {
  // Redirection arrives two ways and both mean the same thing: this caller is
  // not running against the real machine. `codex-sessions.ts` resolves its own
  // directory from the env var, so honouring only the option would leave every
  // test that sets CONCH_CONFIG_DIR still reading the developer's live Codex.
  const redirected = options.configDir ?? process.env.CONCH_CONFIG_DIR;
  const codexHome = options.codexHome
    ?? (redirected ? undefined : join(homedir(), ".codex"));
  if (!codexHome) return { entries: [], complete: true, available: false };
  const { state, history } = codexThreadDbPaths(codexHome);
  // A machine with no Codex at all is known-empty, not an error — the same
  // distinction the Claude side draws between ENOENT and an unreadable dir.
  if (!existsSync(state)) return { entries: [], complete: true, available: false };

  const now = options.now ?? Date.now();
  const cutoff = now - (options.liveWithinMs ?? DEFAULT_LIVE_WITHIN_MS);

  let db: Database | undefined;
  try {
    db = openReadOnly(state);
    const threads = db
      .query(
        // `source` separates a session from a script. On this machine: 354
        // `exec` rows against 9 `cli` and 45 `vscode` — because every
        // non-interactive `codex exec` leaves a permanent row, including the
        // probes used to build this. Those are one-shot runs that already
        // exited; nobody is sitting in one waiting to be announced at. Only
        // interactive front-ends belong in a ledger of sessions you talk to.
        `SELECT id, cwd, name, agent_nickname, title, rollout_path, updated_at_ms
           FROM threads
          WHERE archived = 0
            AND source IN ('cli', 'vscode')
            AND updated_at_ms >= ?
          ORDER BY updated_at_ms DESC`,
      )
      .all(cutoff) as Array<Record<string, any>>;
    db.close();
    db = undefined;

    // Turn status lives in the OTHER database. Its absence is survivable: a
    // thread with no known turn is still a real session worth showing, just
    // without a confident busy/idle, so default to idle rather than drop it.
    const status = new Map<string, string>();
    if (existsSync(history)) {
      const hist = openReadOnly(history);
      try {
        for (
          const row of hist
            .query(
              `SELECT thread_id, status
                 FROM thread_turns t
                WHERE rollout_ordinal = (
                        SELECT MAX(rollout_ordinal) FROM thread_turns
                         WHERE thread_id = t.thread_id)`,
            )
            .all() as Array<Record<string, any>>
        ) {
          status.set(String(row.thread_id), String(row.status));
        }
      } finally {
        hist.close();
      }
    }

    const entries: CodexSessionEntry[] = threads.map((row) => ({
      sessionId: String(row.id),
      cwd: String(row.cwd ?? ""),
      // No pid exists on disk. These rows are observable, not yet addressable —
      // conch injects into a pane by pid, so a v1 Codex row can be SEEN but not
      // talked to. Better an honest read-only row than none at all.
      pid: 0,
      // `thread_turns` is authoritative but SPARSE — a projection that only
      // covers some threads (7 of them on this machine; "humain" has no rows at
      // all). Without a fallback those threads sit on "waiting" forever, even
      // mid-turn. Recency is the stateless stand-in: Codex touches
      // `updated_at_ms` as it works, so a thread written to within the last few
      // seconds is working, whatever the projection does or does not know.
      status: codexThreadStatus(
        status.get(String(row.id)),
        Number(row.updated_at_ms ?? 0),
        now,
      ),
      updatedAt: Number(row.updated_at_ms ?? 0),
      transcriptPath: String(row.rollout_path ?? ""),
      ...(codexThreadLabel(row) ? { name: codexThreadLabel(row) } : {}),
    })) as CodexSessionEntry[];

    return { entries, complete: true, available: true };
  } catch {
    // A torn read, a schema change in a future Codex, a locked file — report
    // incomplete so liveness logic never concludes a session is GONE on the
    // strength of a failed read.
    return { entries: [], complete: false, available: false };
  } finally {
    db?.close();
  }
}
