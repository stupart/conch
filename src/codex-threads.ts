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
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
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
  try {
    return new Database(path, { readonly: true });
  } catch (error) {
    // A WAL database with no `-shm` cannot be opened read-only at all: SQLite
    // needs to CREATE that file and read-only forbids it. That is the state
    // Codex leaves behind after a clean shutdown, so this failed exactly when
    // Codex was not holding the database open — and because the optional
    // history read shared a try block with the thread list, every Codex row
    // disappeared whenever Codex was merely idle.
    //
    // `immutable=1` reads without any shared-memory index. It is only sound
    // when nobody is writing, which is precisely the case that gets here: a
    // live Codex holds the `-shm` and the read-only open above succeeds.
    return new Database(`file:${path}?immutable=1`, { readonly: true });
  }
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
 * The threads Codex currently has OPEN, from the writer locks it holds.
 *
 * This is the signal that was missing. Claude lists a session for as long as its
 * PROCESS lives, however idle — but a Codex thread had only recency to go on, so
 * conch hid one Tyler still had open simply because he had not typed in it for
 * twelve hours. Two tools, same session, different rules.
 *
 * `~/.codex/thread-writer-locks/<thread-id>.lock` is Codex's own answer.
 * Verified against a live machine: the lock for the open thread was held by
 * codex pid 69776, while a thread closed hours earlier had no lock at all.
 *
 * Presence only — never `flock`. Testing a lock by taking one risks excluding
 * the process that owns it, and not disturbing Codex is the whole premise here.
 * The cost is that a crashed Codex leaves a stale lock and one dead row until it
 * next opens that thread, which is a far better failure than hiding live work.
 */
export function readCodexOpenThreadIds(codexHome: string): Set<string> {
  try {
    return new Set(
      readdirSync(join(codexHome, "thread-writer-locks"))
        .filter((name) => name.endsWith(".lock") && !name.startsWith("."))
        .map((name) => name.slice(0, -".lock".length)),
    );
  } catch {
    return new Set();
  }
}

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
  size: number;
  /** Codex's own turn identity, from its `task_complete` event. */
  turnId: string;
  /** Whether the thread is mid-turn, per `task_started` / `task_complete`. */
  status: "busy" | "idle";
  text: string;
}

/** Per-session poll memory: what was last announced, and how big the file was. */
export interface CodexTurnMemoryEntry {
  /** The last `task_complete` turn conch has already spoken for. */
  announcedTurnId: string;
}
export type CodexTurnMemory = Map<string, CodexTurnMemoryEntry>;

/**
 * Which Codex threads have just finished a turn.
 *
 * Codex declares its own turn boundaries, so nothing here is inferred: a
 * `task_complete` event carries a `turn_id` and the `last_agent_message`
 * verbatim. A turn has ended when conch sees a `turn_id` it has not spoken for.
 *
 * This replaced a heuristic — "the newest agent_message, once the file stops
 * growing" — that was not merely uglier but never fired at all. It hunted for
 * an `agent_message` in a 256 KB tail, and a turn heavy with tool use pushes
 * that far outside any sane window; Tyler ran two Codex sessions for half an
 * hour with conch silent throughout. The lesson is the one this file keeps
 * teaching: look for the signal the system already publishes before inventing
 * one from side-effects.
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
    const finished = snapshot.status === "idle" && snapshot.turnId !== "";
    // First sighting adopts whatever is there as already-announced.
    if (seen === undefined) {
      memory.set(snapshot.sessionId, { announcedTurnId: snapshot.turnId });
      continue;
    }
    if (finished && snapshot.turnId !== seen.announcedTurnId) {
      memory.set(snapshot.sessionId, { announcedTurnId: snapshot.turnId });
      // An aborted turn is over but said nothing; announcing it would put the
      // previous turn's words in its mouth.
      if (snapshot.text) ended.push(snapshot);
      continue;
    }
    memory.set(snapshot.sessionId, { announcedTurnId: seen.announcedTurnId });
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

/**
 * The turn state at the end of a rollout, read from the tail only.
 *
 * Codex announces its own turn boundaries — `task_started`, `task_complete`,
 * `turn_aborted` — and `task_complete` carries both a `turn_id` and the
 * `last_agent_message` verbatim. That is a hook in all but name, and it
 * replaced an earlier heuristic here that inferred "finished" from the file
 * having stopped growing. The heuristic was not merely uglier, it never fired:
 * it hunted for an `agent_message` in the tail, and a turn heavy with tool use
 * pushes that far out of any sane window, so Tyler's two live sessions ran for
 * half an hour without conch ever announcing one.
 *
 * A megabyte of tail because these files are enormous — 25 MB on this machine,
 * and openai/codex#24948 reports 732 MB / 170k records. `task_complete` is the
 * last thing written for a turn, so it is near the end when a turn has just
 * ended; the window only has to cover whatever the NEXT turn wrote before the
 * poll noticed.
 */
export function readCodexRolloutTail(
  path: string,
  tailBytes = 1024 * 1024,
): { size: number; turnId: string; status: "busy" | "idle"; text: string } | null {
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
    if (parsed?.type !== "event_msg") continue;
    const payload = parsed.payload;
    if (payload?.type === "task_started") {
      return { size, turnId: String(payload.turn_id ?? ""), status: "busy", text: "" };
    }
    if (payload?.type === "turn_aborted") {
      // Ended, but nothing was said: an abort must not announce a stale reply.
      return { size, turnId: String(payload.turn_id ?? ""), status: "idle", text: "" };
    }
    if (payload?.type !== "task_complete") continue;
    const text = typeof payload.last_agent_message === "string"
      ? payload.last_agent_message
      : "";
    return {
      size,
      turnId: String(payload.turn_id ?? `${size}`),
      status: "idle",
      // Machine-to-machine traffic is not a reply. A session that spawns
      // subagents carries their protocol envelopes in the same stream; Tyler's
      // "humain" thread ended on "Message Type: FINAL_ANSWER / Task name:
      // /root / Sender: ...", addressed to a parent agent rather than to him.
      text: isInterAgentEnvelope(text) ? "" : text,
    };
  }
  return { size, turnId: "", status: "idle", text: "" };
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
      turnId: tail.turnId,
      status: tail.status,
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
    // An open thread is live no matter how long ago it was last touched; the
    // window only has to catch threads Codex has since closed.
    const openIds = readCodexOpenThreadIds(codexHome);
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
          ORDER BY updated_at_ms DESC
          LIMIT 200`,
      )
      .all() as Array<Record<string, any>>;
    db.close();
    db = undefined;

    // Turn status lives in the OTHER database. Its absence is survivable: a
    // thread with no known turn is still a real session worth showing, just
    // without a confident busy/idle, so default to idle rather than drop it.
    const status = new Map<string, string>();
    if (existsSync(history)) {
      // Its own try: a thread with no known turn is still a real session worth
      // showing, so losing this must never cost the thread list.
      try {
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
      } catch {}
    }

    const entries: CodexSessionEntry[] = threads
      .filter((row) =>
        openIds.has(String(row.id)) || Number(row.updated_at_ms ?? 0) >= cutoff
      )
      .map((row) => ({
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
