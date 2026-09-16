import { homedir } from "node:os";

/**
 * The home directory every user-owned conch path is resolved against.
 *
 * Bun caches `os.homedir()` at process start, so a test preload cannot redirect
 * it by assigning `process.env.HOME` — proven, not assumed: setting HOME before
 * the very first `homedir()` call still returns the real home. That left the
 * suite one bad default away from writing Tyler's live `~/.claude/settings.json`
 * hooks, `~/.codex/config.toml` or `~/Library/LaunchAgents` from a throwaway
 * worktree.
 *
 * CONCH_HOME is the one seam that closes all of them. `test/preload.ts` points
 * it at a temp root and asserts nothing escaped. Read at CALL time so the
 * preload — which runs before any of this module's callers are imported — wins.
 */
export function conchHome(): string {
  return process.env.CONCH_HOME || homedir();
}
