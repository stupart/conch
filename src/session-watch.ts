import { existsSync, watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import { breadcrumb } from "./loop-watchdog.ts";

/**
 * Notice a session opening or closing when it happens, not on the next tick.
 *
 * Watches a directory or a plain file — `fs.watch` takes either, and a live
 * transcript is watched exactly the way a liveness directory is.
 *
 * The session panel used to refresh only on a 20-second timer, so quitting an
 * agent left a dead row on screen for up to that long — Tyler: "as i turn
 * session off and close them it doesn't update in conch quickly either ...
 * there seems to be some general issues in knowing which sessions are on and
 * which ones are off and its slow to react."
 *
 * Both backends already publish liveness in a directory, and both keep it
 * honest: Claude Code writes `~/.claude/sessions/<pid>.json` and removes it on
 * exit, and Codex holds `~/.codex/thread-writer-locks/<id>.lock` for exactly as
 * long as the thread lives (1857 rollout files on this machine, 2 locks). The
 * data was never stale — only conch's reading of it was. Watching the
 * directories turns a poll into an event, at no cost when nothing changes.
 *
 * The timer stays as a backstop: a directory that does not exist yet cannot be
 * watched, and FSEvents can drop under load.
 */
export function watchSessionSources(
  dirs: string[],
  onChange: () => void,
  options: { debounceMs?: number; watchFn?: typeof watch } = {},
): () => void {
  const debounceMs = options.debounceMs ?? 150;
  const watchFn = options.watchFn ?? watch;
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  // One transition is several filesystem events — a start writes the file then
  // updates it, and macOS coalesces on its own schedule. Without this, a single
  // session opening would re-render the panel three or four times.
  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, debounceMs);
    timer.unref?.();
  };

  for (const dir of dirs) {
    try {
      const watcher = watchFn(dir, fire);
      // A directory that is removed while watched raises on the watcher, and an
      // unhandled 'error' on an EventEmitter takes the daemon down with it.
      watcher.on?.("error", () => {});
      watcher.unref?.();
      watchers.push(watcher);
    } catch {
      // Not installed, or first run before the directory exists. The caller's
      // periodic refresh still covers this case.
    }
  }

  return () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    for (const watcher of watchers) watcher.close();
  };
}

/**
 * The same watch, over a set of paths that changes as sessions come and go.
 *
 * Conch learned what an agent had said only when a turn ENDED — a Claude `Stop`
 * hook, or the 5s Codex poll. Both transcripts are appended mid-turn, one whole
 * message at a time, so the content was on disk the entire time and nothing was
 * looking at it. Pointing this watch at the live transcripts turns each of those
 * appends into the render conch was already doing on a timer.
 *
 * Changed one path at a time, one watcher per turn of the event loop. It used to
 * re-arm wholesale — close every watcher and open them all again — on the theory
 * that a handful of watchers cost nothing to replace. They don't: Bun's `watch()`
 * and `close()` run on the calling thread, and on Tyler's Mac (fseventsd at 96%
 * CPU after 56 days up) each took anywhere from nothing to 2 s. Re-arming 18 idle
 * files measured 1.9–9.4 s, and re-arming the 18 live transcripts on a changed
 * set 6–17 s. The set changes whenever a session or a background sub-agent starts
 * or finishes, and any path not there yet (a sub-agent's meta file lands before
 * its transcript) left the arm incomplete, so every render re-armed the lot until
 * it appeared. That was the daemon's 5–13 s freeze from 10-19 on (70 of the 75
 * stalls in the log by 10-23), named "records: handing the indexer its
 * priorities" only because that breadcrumb is set just before this runs. Now a
 * session opening costs one `watch()`, one closing costs one `close()`, a missing
 * path costs an `existsSync` until it appears, and none of them shares a turn
 * with the render or with each other, so the heartbeat gets in between.
 */
export function watchChangingPaths(
  onChange: () => void,
  options: {
    debounceMs?: number;
    watchFn?: typeof watch;
    exists?: (path: string) => boolean;
    /** Runs one watch or close on a later turn of the event loop. Tests step it by hand. */
    schedule?: (step: () => void) => void;
  } = {},
): { update: (paths: readonly string[]) => void; stop: () => void } {
  const debounceMs = options.debounceMs ?? 150;
  const watchFn = options.watchFn ?? watch;
  const exists = options.exists ?? existsSync;
  const schedule = options.schedule ?? ((step: () => void) => { setTimeout(step, 0).unref?.(); });
  const watchers = new Map<string, FSWatcher>();
  let wanted = new Set<string>();
  // Wanted, but not watchable on this pass: not there yet (a session registers
  // before its first line lands), or the watch threw. Each update tries again.
  let skipped = new Set<string>();
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, debounceMs);
    timer.unref?.();
  };
  const pending = (): boolean => [...wanted].some((path) => !watchers.has(path) && !skipped.has(path))
    || [...watchers.keys()].some((path) => !wanted.has(path));
  const next = (): void => {
    if (scheduled || !pending()) return;
    scheduled = true;
    schedule(step);
  };
  function step(): void {
    scheduled = false;
    for (const path of wanted) {
      if (watchers.has(path) || skipped.has(path)) continue;
      if (!exists(path)) {
        skipped.add(path);
        continue;
      }
      breadcrumb(`watch: watching ${basename(path)}`);
      try {
        // A watcher whose path has left the set stays open until its own turn to
        // close comes; it must not render for a session that is gone.
        const watcher = watchFn(path, () => { if (wanted.has(path)) fire(); });
        // A file removed while watched raises on the watcher, and an unhandled
        // 'error' on an EventEmitter takes the daemon down with it.
        watcher.on?.("error", () => {});
        watcher.unref?.();
        watchers.set(path, watcher);
      } catch {
        skipped.add(path);
      }
      return next();
    }
    for (const [path, watcher] of watchers) {
      if (wanted.has(path)) continue;
      breadcrumb(`watch: releasing ${basename(path)}`);
      watchers.delete(path);
      try {
        watcher.close();
      } catch {}
      return next();
    }
  }

  return {
    update(paths: readonly string[]): void {
      wanted = new Set(paths);
      skipped = new Set();
      next();
    },
    // Released the same way, a turn each: shutdown has 5 s before the app's
    // SIGKILL, and closing 18 watchers at once measured up to 6.7 s.
    stop(): void {
      wanted = new Set();
      skipped = new Set();
      if (timer) clearTimeout(timer);
      timer = undefined;
      next();
    },
  };
}
