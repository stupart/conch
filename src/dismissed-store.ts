import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Dismissed sessions, kept across daemon restarts.
 *
 * Dismissal lived in the daemon's memory alone, so every restart — an update, a crash, the app relaunching its
 * daemon — brought every dismissed session back to the list (2026-10-02: four of them reappeared after one).
 * The ids are written here when the set changes, and read back at start. A dismissed session that has ended is
 * still pruned on a complete registry read (`pruneSessionCommandSets`), so this never grows past the live ones.
 */
export function loadDismissed(file: string): Set<string> {
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as { dismissed?: unknown };
    return new Set(Array.isArray(stored.dismissed) ? stored.dismissed.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256) : []);
  } catch {
    return new Set();
  }
}

/** A writer that writes only when the set has changed since it last wrote. */
export function dismissedWriter(file: string, initial: ReadonlySet<string>): (ids: ReadonlySet<string>) => void {
  let written = [...initial].sort().join("\n");
  return (ids) => {
    const now = [...ids].sort().join("\n");
    if (now === written) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ dismissed: [...ids].sort() }, null, 2) + "\n", { mode: 0o600 });
      renameSync(temp, file);
      written = now;
    } catch {}
  };
}
