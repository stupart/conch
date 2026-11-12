import { readFileSync, statSync } from "node:fs";

/**
 * A small file conch reads far more often than anything writes it, parsed once per version of it.
 *
 * labels.json was read and parsed for every row's label on every render: 5,874 reads a minute in `conch evals`'
 * scripted load (12 sessions, four renders a second), 2026-11-11, for a file written when someone renames a session;
 * voices.json (2,915, and absent here, so each was an exception) and working-folders.json the same. Now each ask is
 * one `stat`, and the file is read again only when its inode, size or modification time moved.
 *
 * A version modified within `RACY_MS` of being read is not trusted to stay recognisable (git's "racily clean" rule): on
 * a volume with coarse timestamps a second write of the same length in the same tick would look unchanged. So such a
 * file is read again on the next ask, until its modification time is old enough to tell writes apart.
 */
const RACY_MS = 2_000;

interface Kept {
  ino: number;
  size: number;
  mtimeMs: number;
  racy: boolean;
  value: unknown;
}

const kept = new Map<string, Kept>();

/**
 * `parse(text)` of the file at `path`, or `fallback` when it can't be read or parsed: what the readers that call this
 * returned from their own `catch`. The parsed value is shared between asks, so callers copy what they change.
 */
export function readKeptFile<T>(path: string, parse: (text: string) => T, fallback: T): T {
  if (settled?.has(path)) return settled.get(path) as T;
  const value = readKeptFileNow(path, parse, fallback);
  settled?.set(path, value);
  return value;
}

/** What each file said, while `settleKeptFiles` holds: until the code running now yields. */
let settled: Map<string, unknown> | null = null;

/**
 * Until the code running now yields, each kept file is looked at once: a render builds every row's label and voice
 * in one synchronous pass, 34 `stat`s of these files a render in `conch evals`' scripted load (2026-11-11), and a
 * write that lands during the pass is seen by the next one, as one that landed just after it would be.
 */
export function settleKeptFiles(): void {
  if (settled) return;
  settled = new Map();
  queueMicrotask(() => {
    settled = null;
  });
}

function readKeptFileNow<T>(path: string, parse: (text: string) => T, fallback: T): T {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path, { throwIfNoEntry: false });
  } catch {
    kept.delete(path);
    return fallback;
  }
  if (!stat) {
    kept.delete(path);
    return fallback;
  }
  const known = kept.get(path);
  if (known && !known.racy && known.ino === stat.ino && known.size === stat.size && known.mtimeMs === stat.mtimeMs) {
    return known.value as T;
  }
  let value: T;
  try {
    value = parse(readFileSync(path, "utf8"));
  } catch {
    value = fallback;
  }
  kept.delete(path);
  kept.set(path, { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, racy: Date.now() - stat.mtimeMs < RACY_MS, value });
  // Three files in the daemon; a test's temporary ones are let go oldest first.
  if (kept.size > 64) kept.delete(kept.keys().next().value!);
  return value;
}

/** For tests: forget every kept file. */
export function forgetKeptFiles(): void {
  kept.clear();
}
