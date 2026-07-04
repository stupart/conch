import { join } from "node:path";
import { readdirSync } from "node:fs";

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
