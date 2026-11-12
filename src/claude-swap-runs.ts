import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { conchHome } from "./home.ts";

/**
 * claude-swap's "run as account N, this terminal only" folders, read as Claude registries like conch's own profiles
 * (2026-11-12).
 *
 * `cswap run 3 -- claude …` gives that one process `CLAUDE_CONFIG_DIR=~/.claude-swap-backup/sessions/<n>-<account>/`,
 * and Claude Code writes the session's registry entry there. conch read only Default's and its profiles', so a session
 * started that way ran in conch's own tmux for hours as no row at all: nothing announced, nothing typed in, no history
 * (Tyler: "what's the status of some agents missing from conch and how do we attach them?"). conch already runs
 * claude-swap for rotation (claude-rotation.ts), so its folders are read without asking, as long as a session in one is
 * alive. A row from one names its account by claude-swap's number or alias, never by the email the folder is named for.
 */
export interface ClaudeSwapRun {
  /** claude-swap's account number. */
  number: number;
  /** What the row says it runs as: claude-swap's alias, else its number. */
  label: string;
  configDir: string;
}

export function claudeSwapRoot(home = conchHome()): string {
  return join(home, ".claude-swap-backup");
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** claude-swap's own names for its accounts (`cswap alias`), by number: never anything else of its store. */
function aliases(root: string): Map<number, string> {
  const names = new Map<number, string>();
  try {
    const accounts = JSON.parse(readFileSync(join(root, "sequence.json"), "utf8"))?.accounts;
    if (accounts && typeof accounts === "object") {
      for (const [key, value] of Object.entries(accounts as Record<string, { alias?: unknown }>)) {
        const alias = value?.alias;
        if (/^\d+$/.test(key) && typeof alias === "string" && /^[^\u0000-\u001f@]{1,40}$/.test(alias.trim())) names.set(Number(key), alias.trim());
      }
    }
  } catch { /* no store, or one in another shape: the numbers name them */ }
  return names;
}

/**
 * Every claude-swap run folder with a live session in it. A folder whose sessions have all ended is left alone: its
 * entries would only be dead ones, which Claude Code prunes in the profiles it starts in and nobody prunes here.
 */
export function claudeSwapRuns(home = conchHome(), isAlive: (pid: number) => boolean = alive): ClaudeSwapRun[] {
  const root = claudeSwapRoot(home);
  let folders: string[];
  try { folders = readdirSync(join(root, "sessions")); } catch { return []; }
  const runs: ClaudeSwapRun[] = [];
  let names: Map<number, string> | undefined;
  for (const folder of folders.sort()) {
    const number = /^(\d+)-/.exec(folder)?.[1];
    if (!number) continue;
    const configDir = join(root, "sessions", folder);
    let entries: string[];
    try { entries = readdirSync(join(configDir, "sessions")); } catch { continue; }
    if (!entries.some((name) => /^\d+\.json$/.test(name) && isAlive(Number(name.slice(0, -5))))) continue;
    names ??= aliases(root);
    runs.push({ number: Number(number), label: names.get(Number(number)) ?? `claude-swap ${number}`, configDir });
  }
  return runs;
}
