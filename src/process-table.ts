import { probeCommand } from "./probe.ts";

/**
 * The process table, read once and shared (2026-11-12).
 *
 * A registry read already ran one `ps` for each process's parent (`processParentTable`, window-key.ts). Finding the
 * agents running outside conch (elsewhere.ts) needs each one's terminal and executable as well, so that same `ps` now
 * lists them, and the table it read is kept for discovery to use: no `ps` of its own.
 */
/** One process as `ps -Ao pid=,ppid=,uid=,tty=,stat=,comm=` lists it. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  uid: number;
  /** `??` for none. */
  tty: string;
  stat: string;
  /** The executable as it was run: a bare name or a whole path, spaces and all. */
  comm: string;
}

export const PROCESS_TABLE_ARGV = ["ps", "-Ao", "pid=,ppid=,uid=,tty=,stat=,comm="] as const;

export function parseProcessRows(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), tty: match[4]!, stat: match[5]!, comm: match[6]! });
  }
  return rows;
}

let kept: { rows: readonly ProcessRow[]; at: number } | null = null;

/**
 * The process table, from the one `ps` a registry read takes for its parent links (`processParentTable`), kept for
 * discovery so that finding what isn't in conch adds no `ps` of its own. Null when `ps` can't be read.
 */
export async function readProcessRows(now: () => number = Date.now): Promise<readonly ProcessRow[] | null> {
  const text = await probeCommand([...PROCESS_TABLE_ARGV], [0], 6_000);
  if (text === null) return null;
  const rows = parseProcessRows(text);
  if (!rows.length) return null;
  kept = { rows, at: now() };
  return rows;
}

/** The last table any reader took, and when; null before one was. Never runs `ps`. */
export function latestProcessRows(): { rows: readonly ProcessRow[]; at: number } | null {
  return kept;
}
