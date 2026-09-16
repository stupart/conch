import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONCH_CONFIG_DIR, type Config } from "./config.ts";
import { recordFingerprint, SOURCE_PROBE_BYTES } from "./records-source.ts";
import type { StoredPromptCursor } from "./records-store.ts";
import { transcriptMark, type PromptCursor, type PromptResume } from "./snippet.ts";

/**
 * Prompt counts that survive the process that made them.
 *
 * Claude Code and Codex run a hook on EVERY turn, each one a fresh process with
 * an empty cache, and a prompt count is the one transcript read that has to see
 * the whole file — 3.77s on a 189MB session (daemon.ts's warm-up note). The
 * daemon's warm reader never helped a hook, because it is a different process.
 *
 * So the daemon commits the cursor it already reached into the record store,
 * and a hook resumes from it: one stat, two 256-byte probes, then only the
 * bytes appended since. With records off — the default for everyone but this
 * Mac — there is no database, no lookup, and the original byte-zero scan.
 */

/** `<configDir>/records/history.sqlite` — the database the record worker owns. */
export function recordDatabasePath(configDir: string = CONCH_CONFIG_DIR): string {
  return join(configDir, "records", "history.sqlite");
}

interface ProbedFile {
  device: string;
  inode: string;
  size: number;
  mtimeNs: string;
  prefixHash: string;
  checkpointHash: string;
}

/**
 * File identity plus the record store's own two 256-byte probes, taken around
 * `offset`: the first bytes of the file, and the bytes immediately before the
 * cursor.
 *
 * ponytail: short probes, the same ceiling `docs/records-foundation.md` already
 * documents for ingestion — an interior rewrite that preserves both probe
 * windows is not detected. The upgrade path is hashing the whole counted
 * prefix, which costs exactly the read this exists to avoid.
 */
function probeFile(transcriptPath: string, offset: number): ProbedFile | null {
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const observed = fstatSync(fd, { bigint: true });
    if (!observed.isFile() || offset > Number(observed.size)) return null;
    const length = Math.min(SOURCE_PROBE_BYTES, offset);
    const range = (from: number): Uint8Array => {
      if (!length) return new Uint8Array();
      const bytes = Buffer.alloc(length);
      return bytes.subarray(0, readSync(fd!, bytes, 0, length, from));
    };
    return {
      device: String(observed.dev),
      inode: String(observed.ino),
      size: Number(observed.size),
      mtimeNs: String(observed.mtimeNs),
      prefixHash: recordFingerprint(range(0)),
      checkpointHash: recordFingerprint(range(offset - length)),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

interface CursorDatabase {
  query(sql: string): { get(...parameters: unknown[]): unknown };
  close(): void;
}

function openReadOnly(path: string): CursorDatabase {
  const db = new Database(path, { readonly: true, strict: true });
  // Never queue behind the record worker's writer. A hook that waits delays the
  // user's next turn, and a missed cursor only costs one scan.
  db.exec("PRAGMA busy_timeout = 0");
  return db;
}

export interface PromptCursorReadOptions {
  configDir?: string;
  /** Give up and scan instead of waiting longer than this for the database. */
  budgetMs?: number;
  openDatabase?: (path: string) => CursorDatabase;
  now?: () => number;
}

const DEFAULT_CURSOR_BUDGET_MS = 50;

/**
 * Where this transcript's prompt count may resume, or null to scan from zero.
 *
 * Opens the database read-only in this process rather than asking the daemon:
 * the hook must not block on another process, and a reader that fails for any
 * reason — no database, no row, a lock, a rewritten file — simply falls back.
 */
export function readPromptCursor(
  transcriptPath: string,
  options: PromptCursorReadOptions = {},
): PromptResume | null {
  const now = options.now ?? (() => performance.now());
  const budget = options.budgetMs ?? DEFAULT_CURSOR_BUDGET_MS;
  const started = now();
  let db: CursorDatabase | undefined;
  try {
    const observed = statSync(transcriptPath, { bigint: true });
    const device = String(observed.dev);
    const inode = String(observed.ino);
    db = (options.openDatabase ?? openReadOnly)(recordDatabasePath(options.configDir));
    if (now() - started > budget) return null;
    const row = db.query(`SELECT committed_offset, prompt_count, prefix_hash, checkpoint_hash
      FROM prompt_cursors WHERE device=? AND inode=?`).get(device, inode) as {
        committed_offset: number; prompt_count: number; prefix_hash: string; checkpoint_hash: string;
      } | null | undefined;
    if (!row || now() - started > budget) return null;
    const from = Number(row.committed_offset);
    const count = Number(row.prompt_count);
    if (!Number.isSafeInteger(from) || from <= 0 || !Number.isSafeInteger(count) || count < 0) return null;
    if (from > Number(observed.size)) return null;
    const probe = probeFile(transcriptPath, from);
    if (!probe || probe.device !== device || probe.inode !== inode) return null;
    if (probe.prefixHash !== row.prefix_hash || probe.checkpointHash !== row.checkpoint_hash) return null;
    return { from, count };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

export type PromptCursorWriter = (cursor: StoredPromptCursor) => void;

/**
 * Commit a count the daemon already performed, if the file still matches it.
 *
 * The probes must describe the same snapshot the count read: the same file, and
 * either unchanged or only appended to. Anything else is a file that was
 * rewritten mid-count, and publishing it would hand the next hook a cursor that
 * passes its probes while describing bytes that are gone.
 */
export function publishPromptCursor(
  transcriptPath: string,
  cursor: PromptCursor,
  write: PromptCursorWriter,
): void {
  if (cursor.from <= 0) return;
  const probe = probeFile(transcriptPath, cursor.from);
  if (!probe) return;
  const { version } = cursor;
  const sameFile = (version.dev === undefined || probe.device === version.dev)
    && (version.ino === undefined || probe.inode === version.ino);
  const appendedOnly = probe.size > version.size
    || (probe.size === version.size && probe.mtimeNs === version.mtimeNs);
  if (!sameFile || !appendedOnly) return;
  write({
    device: probe.device, inode: probe.inode, offset: cursor.from, count: cursor.count,
    prefixHash: probe.prefixHash, checkpointHash: probe.checkpointHash, updatedAt: Date.now(),
  });
}

const PUBLISHED_PATHS = 256;

/**
 * The sink the daemon installs on the transcript reader.
 *
 * Deduplicated by committed offset: repeated counts of an unchanged file — the
 * common case, since several daemon paths count per turn — write nothing.
 */
export function promptCursorPublisher(
  write: PromptCursorWriter,
): (transcriptPath: string, cursor: PromptCursor) => void {
  const published = new Map<string, number>();
  return (transcriptPath, cursor) => {
    if (published.get(transcriptPath) === cursor.from) return;
    publishPromptCursor(transcriptPath, cursor, (stored) => {
      published.delete(transcriptPath);
      published.set(transcriptPath, stored.offset);
      while (published.size > PUBLISHED_PATHS) {
        const oldest = published.keys().next().value;
        if (oldest === undefined) break;
        published.delete(oldest);
      }
      write(stored);
    });
  };
}

export interface BoundedMarkOptions extends PromptCursorReadOptions {
  mark?: (transcriptPath: string, resume?: PromptResume) => Promise<number>;
  readCursor?: (transcriptPath: string, options: PromptCursorReadOptions) => PromptResume | null;
}

/**
 * A hook's prompt mark, bounded when a committed cursor says where to resume.
 *
 * The number is the same either way. The cursor decides only how many bytes are
 * read to reach it, so the record store being off, empty, stale or unreadable
 * is never a correctness question — it is the original scan.
 */
export async function boundedMark(
  config: Pick<Config, "recordsEnabled">,
  transcriptPath: string,
  options: BoundedMarkOptions = {},
): Promise<number> {
  const mark = options.mark ?? transcriptMark;
  if (!config.recordsEnabled) return mark(transcriptPath);
  let resume: PromptResume | null = null;
  try {
    resume = (options.readCursor ?? readPromptCursor)(transcriptPath, options);
  } catch {
    resume = null;
  }
  return mark(transcriptPath, resume ?? undefined);
}
