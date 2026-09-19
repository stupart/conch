import { existsSync, watch, type FSWatcher } from "node:fs";

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
 * Re-arming wholesale on a changed set, rather than diffing it: the set changes
 * when a session opens or closes, which is rare, and a handful of watchers cost
 * nothing to replace. A path that does not exist yet cannot be watched, so an
 * incomplete arm is not cached — the next update tries it again.
 */
export function watchChangingPaths(
  onChange: () => void,
  options: { debounceMs?: number; watchFn?: typeof watch; exists?: (path: string) => boolean } = {},
): { update: (paths: readonly string[]) => void; stop: () => void } {
  const exists = options.exists ?? existsSync;
  let stop: (() => void) | undefined;
  let armed: string | null = null;
  return {
    update(paths: readonly string[]): void {
      const wanted = [...new Set(paths)].sort();
      const key = wanted.join("\n");
      if (armed === key) return;
      const live = wanted.filter((path) => exists(path));
      stop?.();
      stop = watchSessionSources(live, onChange, options);
      // Only a complete arm is cached. A transcript whose session registered
      // before its first line landed is picked up on the next render instead of
      // never being watched at all.
      armed = live.length === wanted.length ? key : null;
    },
    stop(): void {
      stop?.();
      stop = undefined;
      armed = null;
    },
  };
}
