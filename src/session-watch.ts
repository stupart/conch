import { watch, type FSWatcher } from "node:fs";

/**
 * Notice a session opening or closing when it happens, not on the next tick.
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
