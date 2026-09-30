import { lstatSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readTranscriptTailLines } from "./context-meter.ts";

/**
 * The folders a session's deliverable link may sit under: one rule for every way a link arrives.
 * The `conch:review` line (hook.ts, codex-hook.ts), `review_to_front` (mcp.ts), the daemon's own
 * check before it files one (voice-loop.ts), and the phone reading it later (phone-bridge.ts, from
 * the roots the daemon filed it with).
 *
 * Each of these checked one folder, and not the same one. The Stop hook used the folder the
 * session is in NOW, which moves: a session that started in ~/Projects/Blueprint/Internal and
 * cd'd into monorepo/.worktrees/<task> had its link to Internal/review-2026-09-30 dropped without
 * a word, three times on 2026-09-30 (`parsed.link: null` in /tmp/conch-hook.log). The daemon used
 * the folder it STARTED in, so a link under the current folder alone was dropped there instead.
 *
 * A link may now sit under any of these, or a temp folder (`checkLocalFile`):
 * - the folder the session is in now: the hook's `cwd`, or the last one its transcript records;
 * - the folder it started in: its registry entry's `cwd`;
 * - the folders it declared with `conch_working_folders`;
 * - the git checkout that holds the folder it is in now (and, for a linked worktree or a
 *   submodule, the checkout that holds that).
 * A folder the session merely moved into never widens past the home folder: neither `/`, nor
 * the home folder, nor anything above it, is a root for being where the session is or holding
 * its repository. Every other check (a symlink judged by where it leads, hidden files, keys,
 * executables, packages) is `checkLocalFile`'s and `checkLocalFolder`'s, unchanged.
 */
export interface SessionFolders {
  /** Where the session is now. Relative links resolve here. */
  now?: string;
  /** Where it started. */
  started?: string;
  /** What it declared with `conch_working_folders`. */
  workDirs?: readonly string[];
}

export interface LinkScope {
  /** What a relative link resolves against: where the session is now, else where it started. */
  cwd: string;
  /** Every folder a link may sit under, in the order a person reads them, none inside another. */
  roots: string[];
}

/** Whether `folder` is `/`, the home folder, or above it: never a root just because a session is there. */
function tooBroad(folder: string, home: string): boolean {
  return folder === "/" || folder === home || home.startsWith(`${folder}/`);
}

/**
 * The git checkouts that hold `folder`, nearest first: the one `git rev-parse --show-toplevel`
 * names, and, when that is a linked worktree or a submodule (its `.git` is a file), the ones
 * above it, up to the first real checkout. Read off the disk (`.git`), never by running git, so
 * a hook pays a few `lstat`s. Stops short of the home folder: a home folder kept in git (dotfiles)
 * would otherwise make every file you own a root.
 */
export function repositoryRoots(folder: string, home = homedir()): string[] {
  const found: string[] = [];
  for (let dir = resolve(folder); !tooBroad(dir, home); dir = dirname(dir)) {
    const git = (() => {
      try {
        return lstatSync(join(dir, ".git"));
      } catch {
        return null;
      }
    })();
    if (git) {
      found.push(dir);
      if (git.isDirectory()) break;
    }
    if (dirname(dir) === dir) break;
  }
  return found;
}

/**
 * The folder a session is in now, as its own transcript last recorded it: Claude Code writes `cwd`
 * on every record, Codex on each turn's context. Read from the tail, so a long session costs one
 * bounded read. Undefined when there is no transcript or no folder in its tail.
 */
export async function transcriptFolder(transcriptPath: string | undefined): Promise<string | undefined> {
  if (!transcriptPath) return undefined;
  const lines = await readTranscriptTailLines(transcriptPath).catch(() => null);
  for (let index = (lines?.length ?? 0) - 1; index >= 0; index -= 1) {
    const line = lines![index]!;
    if (!line.includes('"cwd"')) continue;
    try {
      const record = JSON.parse(line) as { cwd?: unknown; payload?: { cwd?: unknown } };
      const cwd = typeof record.cwd === "string" ? record.cwd : record.payload?.cwd;
      if (typeof cwd === "string" && isAbsolute(cwd)) return cwd;
    } catch {
      // A record cut by the tail's edge, or one mid-write.
    }
  }
  return undefined;
}

/**
 * The folders a session's link is checked against (see `SessionFolders`). Each is judged by its
 * real path, like the link itself: a folder that isn't there is left out, and one inside another
 * says nothing the outer one doesn't, so it is left out too. `fallback` is what a relative link
 * resolves against when nothing says where the session is.
 */
export async function reviewLinkScope(folders: SessionFolders, fallback: string = tmpdir(), home = homedir()): Promise<LinkScope> {
  const now = folders.now && isAbsolute(folders.now) ? folders.now : undefined;
  const started = folders.started && isAbsolute(folders.started) ? folders.started : undefined;
  const here = now ?? started;
  const candidates = [
    started,
    now && !tooBroad(resolve(now), home) ? now : undefined,
    ...(folders.workDirs ?? []).filter((folder) => isAbsolute(folder)),
    ...(here ? repositoryRoots(here, home) : []),
  ].filter((folder, index, all): folder is string => typeof folder === "string" && all.indexOf(folder) === index);
  const reals = await Promise.all(candidates.map((folder) => realpath(folder).catch(() => null)));
  const inside = (real: string, outer: string) => real.startsWith(outer.endsWith("/") ? outer : `${outer}/`);
  const roots = candidates.filter((_, index) => {
    const real = reals[index];
    return real !== null && !reals.some((other, at) =>
      other !== null && at !== index && (other === real ? at < index : inside(real, other)));
  });
  return { cwd: here ?? fallback, roots };
}

/**
 * Which of `roots` hold `paths` (by real path), leaving out any path the folder the session started
 * in already holds: what a filing carries for the phone (`SessionReview.roots`), which checks its
 * files against the row's own folders and these. A path under a temp folder alone needs none.
 */
export async function rootsHolding(paths: readonly string[], roots: readonly string[], started?: string): Promise<string[]> {
  const reals = await Promise.all(roots.map((root) => realpath(root).catch(() => null)));
  const origin = started ? await realpath(started).catch(() => null) : null;
  const held: string[] = [];
  for (const path of paths) {
    const real = await realpath(path).catch(() => null);
    if (!real) continue;
    const inside = (root: string) => real === root || real.startsWith(root.endsWith("/") ? root : `${root}/`);
    if (origin && inside(origin)) continue;
    const at = reals.findIndex((root) => root !== null && inside(root));
    if (at >= 0 && !held.includes(roots[at]!)) held.push(roots[at]!);
  }
  return held;
}
