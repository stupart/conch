import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Manual mode, on disk, so a process without the daemon can still honour it.
 *
 * This used to live inside `daemon.ts`, which meant only the daemon could read
 * it — and a hook cannot import the daemon without dragging the whole thing
 * into a short-lived process. That gap had a voice: with no daemon running,
 * every Claude Code hook fell back to speaking for itself, and since manual
 * mode was daemon state, it announced turns aloud on a Mac whose owner had
 * explicitly asked for silence. Tyler heard conch talking with the app closed.
 *
 * It is one boolean in one file. Both sides read it from here now.
 */
const STATE_FILE = join(homedir(), ".config/conch/state.json");

export interface DaemonState {
  paused: boolean;
}

/** Legacy quiet state upgrades to the only lossless mode before runtime sees it. */
export function daemonStateFromUnknown(value: unknown): DaemonState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { paused: false };
  }
  const state = value as { paused?: unknown; muted?: unknown };
  return { paused: state.paused === true || state.muted === true };
}

export function readState(): DaemonState {
  try {
    const decoded: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    const state = daemonStateFromUnknown(decoded);
    if (typeof decoded === "object" && decoded !== null && "muted" in decoded) writeState(state);
    return state;
  } catch {
    return { paused: false };
  }
}

export function writeState(state: DaemonState): void {
  try {
    mkdirSync(join(homedir(), ".config/conch"), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state) + "\n");
  } catch {}
}
