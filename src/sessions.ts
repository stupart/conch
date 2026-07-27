import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";

export interface SessionInfo {
  sessionId: string;
  name?: string;
  cwd?: string;
  pid?: number;
  /** Claude Code's own live state: "busy" | "idle" | "shell" (authoritative for working-vs-waiting). */
  status?: string;
  /** epoch-ms the status was last set — compared against a latched panel state to pick the newer truth. */
  statusUpdatedAt?: number;
  /** "interactive" for a human-driven TUI; other kinds (headless/sdk) can't be talked to. */
  kind?: string;
  /** "cli" for a real terminal session; "sdk-cli" etc. are headless routines. */
  entrypoint?: string;
}

/**
 * A session a voice loop can actually engage — a top-level interactive CLI session.
 * Excludes headless/sdk-cli routines (e.g. boatker's cron runs) that would otherwise
 * get announced + open the mic. Conservative: a session is only dropped when we can
 * positively identify it as non-interactive, so older registries (missing the fields)
 * still pass.
 */
export function isEngageable(info: Pick<SessionInfo, "kind" | "entrypoint">): boolean {
  if (info.kind && info.kind !== "interactive") return false;
  if (info.entrypoint && info.entrypoint !== "cli") return false;
  return true;
}

/**
 * Look up a live session in Claude Code's registry (~/.claude/sessions/<pid>.json).
 * Gives us the /rename-able session name and the CLI pid for pane targeting.
 */
export async function findSession(claudeDir: string, sessionId: string): Promise<SessionInfo | null> {
  const dir = join(claudeDir, "sessions");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const entry = await Bun.file(join(dir, f)).json();
      if (entry.sessionId === sessionId) {
        return toInfo(entry);
      }
    } catch {
      // stale or mid-write registry file; skip
    }
  }
  return null;
}

/** Project a raw registry JSON entry onto SessionInfo (keeps the fields conch actually uses). */
function toInfo(entry: any): SessionInfo {
  return {
    sessionId: entry.sessionId,
    name: entry.name,
    cwd: entry.cwd,
    pid: entry.pid,
    status: entry.status,
    statusUpdatedAt: typeof entry.statusUpdatedAt === "number" ? entry.statusUpdatedAt : undefined,
    kind: entry.kind,
    entrypoint: entry.entrypoint,
  };
}

/** Session name if set, else the project folder name. */
export function sessionLabel(info: SessionInfo | null, cwd: string | undefined): string {
  if (info?.name) return info.name;
  const dir = cwd ?? info?.cwd ?? process.cwd();
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
 * Read the whole registry once. Returns `null` only when the registry directory
 * itself is unreadable (total uncertainty). A torn/unparseable individual file
 * sets `complete = false` but the snapshot is still returned, with that session's
 * id salvaged into `liveIds` so it is never mistaken for a closed session.
 */
export async function registrySnapshot(claudeDir: string): Promise<RegistrySnapshot | null> {
  const dir = join(claudeDir, "sessions");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null; // registry dir unreadable → uncertain; callers keep everything
  }
  const infos: SessionInfo[] = [];
  const liveIds = new Set<string>();
  let complete = true;
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
    if (isEngageable(entry)) infos.push(toInfo(entry));
  }
  return { infos, liveIds, complete };
}

/** All engageable (top-level interactive CLI) live sessions from the registry. */
export async function listSessions(claudeDir: string): Promise<SessionInfo[]> {
  return (await registrySnapshot(claudeDir))?.infos ?? [];
}

/** Match a spoken/typed query against session names, then project folder names. */
export async function findSessionByName(claudeDir: string, query: string): Promise<SessionInfo | null> {
  const q = query.toLowerCase().trim();
  const sessions = await listSessions(claudeDir);
  return (
    sessions.find((s) => s.name?.toLowerCase() === q) ??
    sessions.find((s) => s.name?.toLowerCase().includes(q)) ??
    sessions.find((s) => (s.cwd ?? "").split("/").pop()?.toLowerCase() === q) ??
    null
  );
}

/** Locate a session's transcript by id — project dirs encode the cwd, so search them all. */
export function findTranscript(claudeDir: string, sessionId: string): string | undefined {
  const projects = join(claudeDir, "projects");
  try {
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, `${sessionId}.jsonl`);
      try {
        statSync(candidate);
        return candidate;
      } catch {}
    }
  } catch {}
  return undefined;
}
