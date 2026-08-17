import { expect, test } from "bun:test";
import { watchSessionSources } from "../src/session-watch.ts";

/** A stand-in for fs.watch that hands back the listener so a test can fire it. */
function fakeWatch() {
  const listeners: Array<() => void> = [];
  const closed: boolean[] = [];
  const watchFn = ((_dir: string, listener: () => void) => {
    const index = listeners.push(listener) - 1;
    closed[index] = false;
    return {
      close: () => {
        closed[index] = true;
      },
      on: () => {},
      unref: () => {},
    };
  }) as never;
  return { watchFn, listeners, closed };
}

test("a burst of filesystem events re-renders the panel once", async () => {
  const { watchFn, listeners } = fakeWatch();
  let renders = 0;
  const stop = watchSessionSources(["/sessions"], () => renders++, {
    debounceMs: 5,
    watchFn,
  });

  // One session opening writes the file and then updates it; macOS coalesces on
  // its own schedule, so the listener fires several times for one transition.
  for (let i = 0; i < 4; i++) listeners[0]!();
  expect(renders).toBe(0); // nothing synchronous — the burst is still settling

  await Bun.sleep(25);
  expect(renders).toBe(1);
  stop();
});

test("both backends are watched, and either one alone triggers a render", async () => {
  const { watchFn, listeners } = fakeWatch();
  let renders = 0;
  const stop = watchSessionSources(
    ["/claude/sessions", "/codex/thread-writer-locks"],
    () => renders++,
    { debounceMs: 5, watchFn },
  );
  expect(listeners.length).toBe(2);

  listeners[1]!(); // a Codex lock released
  await Bun.sleep(25);
  expect(renders).toBe(1);
  stop();
});

test("stopping cancels a render that has not fired yet", async () => {
  const { watchFn, listeners, closed } = fakeWatch();
  let renders = 0;
  const stop = watchSessionSources(["/sessions"], () => renders++, {
    debounceMs: 20,
    watchFn,
  });

  listeners[0]!();
  stop();
  await Bun.sleep(40);
  expect(renders).toBe(0);
  expect(closed[0]).toBe(true);
});

test("a directory that does not exist is skipped, not fatal", async () => {
  // No Codex installed, or first run before the directory is created. The
  // caller's periodic refresh is the backstop; the daemon must still start.
  const missing = (() => {
    throw new Error("ENOENT");
  }) as never;
  let renders = 0;
  expect(() => watchSessionSources(["/nope"], () => renders++, {
    watchFn: missing,
  })).not.toThrow();
});
