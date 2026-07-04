import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";

export interface SessionInfo {
  sessionId: string;
  name?: string;
  cwd?: string;
  pid?: number;
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
        return { sessionId, name: entry.name, cwd: entry.cwd, pid: entry.pid };
      }
    } catch {
      // stale or mid-write registry file; skip
    }
  }
  return null;
}

/** Session name if set, else the project folder name. */
export function sessionLabel(info: SessionInfo | null, cwd: string | undefined): string {
  if (info?.name) return info.name;
  const dir = cwd ?? info?.cwd ?? process.cwd();
  return dir.split("/").filter(Boolean).pop() ?? "claude";
}

/** All live sessions from the registry. */
export async function listSessions(claudeDir: string): Promise<SessionInfo[]> {
  const dir = join(claudeDir, "sessions");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const sessions: SessionInfo[] = [];
  for (const f of files) {
    try {
      const entry = await Bun.file(join(dir, f)).json();
      if (entry.sessionId) sessions.push({ sessionId: entry.sessionId, name: entry.name, cwd: entry.cwd, pid: entry.pid });
    } catch {}
  }
  return sessions;
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
