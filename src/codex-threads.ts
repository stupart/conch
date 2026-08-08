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
import { existsSync } from "node:fs";
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
      status: status.get(String(row.id)) === "inProgress" ? "busy" : "idle",
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
