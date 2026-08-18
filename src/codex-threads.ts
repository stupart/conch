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
  /** Epoch-ms of the last boot; nothing older can still be running. */
  bootedAt?: number | null;
  /** Which lock paths are actually held. Injectable so tests can hold one. */
  lockProbe?: (paths: string[]) => string | null;
}

/**
 * How long a Codex thread stays listed after its last activity.
 *
 * Eight hours, not thirty minutes. The lock tells us which single thread Codex
 * has OPEN, but a person works across several in a day and Codex locks only the
 * one it is writing — measured exactly that: "asset generator" held the lock
 * after fourteen idle hours while "humain", used seventy-one minutes earlier,
 * had none and vanished. Tyler noticed immediately, and he was right to: a
 * session he had been in an hour ago is obviously still his.
 *
 * A Claude session is listed for as long as its process lives, which is usually
 * a working day, so this is the closer analogue. The cost of being generous is
 * an extra row or two from this morning; the cost of being strict is hiding
 * work someone is in the middle of. `CODEX_ROW_LIMIT` bounds the noise.
 */
const DEFAULT_LIVE_WITHIN_MS = 8 * 60 * 60 * 1000;

/**
 * When this machine last booted, in epoch-ms, or null if it cannot be read.
 *
 * Cached: it cannot change while this process lives.
 */
let bootedAtCache: number | null | undefined;
export function machineBootedAtMs(): number | null {
  if (bootedAtCache !== undefined) return bootedAtCache;
  try {
    const out = Bun.spawnSync(["sysctl", "-n", "kern.boottime"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    // "{ sec = 1787012345, usec = 123456 } Mon Aug 17 20:40:12 2026"
    const sec = new TextDecoder().decode(out.stdout).match(/sec\s*=\s*(\d+)/)?.[1];
    bootedAtCache = sec ? Number(sec) * 1000 : null;
  } catch {
    bootedAtCache = null;
  }
  return bootedAtCache;
}

/** Most-recent Codex threads to list, so a heavy day cannot flood the ledger. */
const CODEX_ROW_LIMIT = 6;

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
    const db = new Database(path, { readonly: true });
    // Force the open. `new Database(...)` is LAZY in Bun: it returns happily and
    // SQLITE_CANTOPEN surfaces on the first query instead, so a try/catch around
    // the constructor alone catches nothing and the fallback below was dead code
    // — which is why Codex rows kept vanishing even after this was "fixed".
    db.query("SELECT 1").get();
    return db;
  } catch (error) {
    // Codex's live databases intermittently refuse a READ-ONLY open with
    // SQLITE_CANTOPEN while a plain or `immutable=1` open of the same file
    // succeeds. Measured repeatedly on the real files; the cause is NOT what it
    // first looked like — a synthetic WAL database opens read-only fine, and
    // `state_5.sqlite` reports journal_mode `delete` anyway. Whatever the
    // mechanism, it is transient and correlated with Codex writing, and it cost
    // every Codex row in both apps twice.
    //
    // `immutable=1` promises SQLite the file will not change. That is a real
    // risk against a live writer — a torn read — which is why it is the
    // FALLBACK and never the first choice, and why the caller treats any failure
    // here as "incomplete" rather than "no sessions".
    const fallback = new Database(`file:${path}?immutable=1`, { readonly: true });
    fallback.query("SELECT 1").get();
    return fallback;
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
export function readCodexOpenThreadIds(
  codexHome: string,
  probe: ((paths: string[]) => string | null) | undefined = probeHeldLocks,
): Set<string> {
  const dir = join(codexHome, "thread-writer-locks");
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".lock") && !name.startsWith("."));
  } catch {
    return new Set();
  }
  if (!names.length) return new Set();
  const idOf = (name: string) => name.slice(0, -".lock".length);

  // A lock FILE is not a lock. Codex holds an exclusive lock for as long as the
  // session lives and removes the file on a clean exit — but a reboot is not a
  // clean exit, and the files it leaves behind made conch report sessions that
  // died with the machine. Tyler saw six rows for one session; five were these
  // and a stale recency window, every one already resolving to pid 0.
  //
  // One `lsof` for every lock at once, not one per file: this runs on the
  // render path, and the count is small but the cost is not.
  const held = (probe ?? probeHeldLocks)(names.map((name) => join(dir, name)));
  if (held === null) {
    // The probe itself failed — lsof missing, or something unexpected. Fall
    // back to the old assumption rather than silently emptying the ledger:
    // showing a session that has gone is a smaller failure than hiding one
    // that has not.
    return new Set(names.map(idOf));
  }
  return new Set(names.filter((name) => held.includes(join(dir, name))).map(idOf));
}

/** Names of the lock paths some process currently holds open, or null if unknown. */
function probeHeldLocks(paths: string[]): string | null {
  try {
    const child = Bun.spawnSync(["lsof", "-F", "n", "--", ...paths], {
      stdout: "pipe",
      stderr: "ignore",
    });
    // Exit 1 means "none of these are open", which is an answer, not a failure.
    if (child.exitCode !== 0 && child.exitCode !== 1) return null;
    return new TextDecoder().decode(child.stdout);
  } catch {
    return null;
  }
}

/**
 * Which process is running a Codex thread.
 *
 * Codex publishes no pid anywhere conch can read, so a Codex row arrived with
 * `pid=0` and injection had no pane to aim at: every message typed at a Codex
 * session fell through to the clipboard as "session-not-routable", while
 * Claude sessions worked. Same composer, same button, silently different
 * outcome depending on which agent you happened to be talking to.
 *
 * The lock the live process holds on its own thread file answers it. Codex
 * takes an exclusive lock in `thread-writer-locks/<id>.lock` for as long as the
 * session is alive, so whoever holds it IS the session — read, never taken, so
 * conch cannot interfere with a session it is only observing.
 *
 * Cached: a thread's owner cannot change without the lock being released, and
 * `lsof` is far too expensive to run per row per render.
 */
const threadPidCache = new Map<string, { pid: number; at: number }>();
const PID_CACHE_MS = 30_000;

export function readCodexThreadPid(
  codexHome: string,
  threadId: string,
  now = Date.now(),
): number | undefined {
  const cached = threadPidCache.get(threadId);
  if (cached && now - cached.at < PID_CACHE_MS) {
    return cached.pid || undefined;
  }
  try {
    const lock = join(codexHome, "thread-writer-locks", `${threadId}.lock`);
    if (!existsSync(lock)) {
      threadPidCache.set(threadId, { pid: 0, at: now });
      return undefined;
    }
    const out = Bun.spawnSync(["lsof", "-t", lock], { stdout: "pipe", stderr: "ignore" });
    const pid = Number(out.stdout.toString().trim().split("\n")[0]);
    const valid = Number.isFinite(pid) && pid > 0 ? pid : 0;
    threadPidCache.set(threadId, { pid: valid, at: now });
    return valid || undefined;
  } catch {
    return undefined;
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

/**
 * Where this process should read Codex from, or null when it must not read the
 * real one.
 *
 * Redirection arrives two ways and both mean the same thing: this caller is not
 * running against the real machine. `codex-sessions.ts` resolves its own
 * directory from the env var, so honouring only the option would leave every
 * test that sets CONCH_CONFIG_DIR still reading the developer's live Codex.
 */
export function codexHomeDir(options: CodexThreadsOptions = {}): string | null {
  const redirected = options.configDir ?? process.env.CONCH_CONFIG_DIR;
  return options.codexHome
    ?? (redirected ? null : join(homedir(), ".codex"));
}

export function readCodexThreads(
  options: CodexThreadsOptions = {},
): CodexSessionRegistryRead {
  const codexHome = codexHomeDir(options);
  if (!codexHome) return { entries: [], complete: true, available: false };
  const { state, history } = codexThreadDbPaths(codexHome);
  // A machine with no Codex at all is known-empty, not an error — the same
  // distinction the Claude side draws between ENOENT and an unreadable dir.
  if (!existsSync(state)) return { entries: [], complete: true, available: false };

  const now = options.now ?? Date.now();
  // Floor the recency window at the last boot. Nothing that was last written
  // before this machine started can still be running on it, however recent the
  // timestamp looks — and after a reboot the whole 8h window is full of threads
  // that died with the machine. Tyler saw six sessions for one real one.
  // A caller supplying its own clock is not on this machine's timeline — every
  // test does, with timestamps long predating the real boot — so the floor
  // applies only when we are reading the real machine at the real time.
  const bootedAt = options.bootedAt
    ?? (options.now === undefined ? machineBootedAtMs() : null);
  const cutoff = Math.max(
    now - (options.liveWithinMs ?? DEFAULT_LIVE_WITHIN_MS),
    bootedAt ?? 0,
  );

  let db: Database | undefined;
  try {
    db = openReadOnly(state);
    // An open thread is live no matter how long ago it was last touched; the
    // window only has to catch threads Codex has since closed.
    const openIds = readCodexOpenThreadIds(codexHome, options.lockProbe);
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
      .slice(0, CODEX_ROW_LIMIT)
      .map((row) => ({
      sessionId: String(row.id),
      cwd: String(row.cwd ?? ""),
      // The live process, resolved from the lock it holds on its own thread
      // file. Codex publishes no pid anywhere, so these rows used to arrive
      // with pid 0 — observable but not addressable. Every message typed at a
      // Codex session fell through to the clipboard as "session-not-routable"
      // while Claude sessions worked: same composer, same button, silently
      // different outcome depending on which agent you were talking to.
      pid: readCodexThreadPid(codexHome, String(row.id), now) ?? 0,
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
  } catch (error) {
    // A torn read, a schema change in a future Codex, an unopenable file —
    // report incomplete so liveness logic never concludes a session is GONE on
    // the strength of a failed read. CONCH_DEBUG_CODEX surfaces it, because
    // this catch silently hid two separate bugs for hours.
    if (process.env.CONCH_DEBUG_CODEX) console.error("codex read failed:", error);
    return { entries: [], complete: false, available: false };
  } finally {
    db?.close();
  }
}
