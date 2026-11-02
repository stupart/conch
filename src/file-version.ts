import { statSync } from "node:fs";

/**
 * What says a file has not moved since it was last read: its inode, size and modification time, one `stat`.
 *
 * All three, because each misses something alone: an append moves size and mtime, a file replaced by a rename moves
 * the inode, and a rewrite to the same length moves only the mtime. live-activity.ts keys its reads the same way.
 */
export interface FileVersion {
  ino: number;
  size: number;
  mtimeMs: number;
}

export function fileVersion(path: string): FileVersion | null {
  try {
    const stat = statSync(path);
    return { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

export function sameFileVersion(a: FileVersion | null | undefined, b: FileVersion | null | undefined): boolean {
  return !!a && !!b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Something worked out from a file, per id, kept until the file moves or `key` (whatever else it was worked out
 * with) changes. A `compute` that gives null kept nothing (a read that failed is tried again next time), and that
 * null is what `get` returns. The version is taken before `compute` runs, so a file that moves during it reads as
 * moved next time, never as the version it was taken at.
 */
export class FileMemo<Value> {
  readonly #kept = new Map<string, { key: string; version: FileVersion; value: Value }>();

  async get(id: string, path: string | undefined, key: string, compute: () => Promise<Value | null>): Promise<Value | null> {
    const version = path ? fileVersion(path) : null;
    const known = this.#kept.get(id);
    if (known && known.key === key && sameFileVersion(known.version, version)) return known.value;
    const value = await compute();
    if (value !== null && version) this.#kept.set(id, { key, version, value });
    else this.#kept.delete(id);
    return value;
  }

  /** Forget every id but these. */
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.#kept.keys()) if (!ids.has(id)) this.#kept.delete(id);
  }
}
