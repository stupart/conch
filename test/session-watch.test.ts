import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublishThrottle } from "../src/publish-throttle.ts";
import { watchChangingPaths, watchSessionSources } from "../src/session-watch.ts";

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

// ── watching transcript CONTENT, not just liveness ────────────────────────────

test("the watch set is re-armed only when it changes", () => {
  const { watchFn, listeners, closed } = fakeWatch();
  const watch = watchChangingPaths(() => {}, { watchFn, exists: () => true });

  watch.update(["/a.jsonl", "/b.jsonl"]);
  expect(listeners.length).toBe(2);

  // Same set, different order: nothing is torn down and rebuilt.
  watch.update(["/b.jsonl", "/a.jsonl"]);
  expect(listeners.length).toBe(2);
  expect(closed).toEqual([false, false]);

  // A session closes: the old watchers go, the new set is armed.
  watch.update(["/a.jsonl"]);
  expect(closed[0]).toBe(true);
  expect(closed[1]).toBe(true);
  expect(listeners.length).toBe(3);
  watch.stop();
});

test("a transcript that does not exist yet is retried, not cached as armed", () => {
  const { watchFn, listeners } = fakeWatch();
  const present = new Set(["/there.jsonl"]);
  const watch = watchChangingPaths(() => {}, { watchFn, exists: (p) => present.has(p) });

  // A session can register before its first line lands. The missing path must
  // not be cached as armed, or it would never be watched at all.
  watch.update(["/there.jsonl", "/pending.jsonl"]);
  expect(listeners.length).toBe(1); // only the one that exists

  watch.update(["/there.jsonl", "/pending.jsonl"]);
  expect(listeners.length).toBe(2); // retried, still missing, still not cached

  present.add("/pending.jsonl");
  watch.update(["/there.jsonl", "/pending.jsonl"]);
  expect(listeners.length).toBe(4); // both armed now

  const before = listeners.length;
  watch.update(["/there.jsonl", "/pending.jsonl"]);
  expect(listeners.length).toBe(before); // complete arm is cached
  watch.stop();
});

test("an append to a watched transcript reaches the renderer", async () => {
  const { watchFn, listeners } = fakeWatch();
  let renders = 0;
  const watch = watchChangingPaths(() => renders++, {
    debounceMs: 5,
    watchFn,
    exists: () => true,
  });
  watch.update(["/live.jsonl"]);

  listeners[0]!(); // the agent appended a message mid-turn
  await Bun.sleep(25);
  expect(renders).toBe(1);
  watch.stop();
});

test("stopping closes the transcript watchers", () => {
  const { watchFn, closed } = fakeWatch();
  const watch = watchChangingPaths(() => {}, { watchFn, exists: () => true });
  watch.update(["/a.jsonl"]);
  watch.stop();
  expect(closed[0]).toBe(true);
});

/**
 * A turn mid-flight appends steadily, and a resetting debounce restarts on every
 * append — so the longer the debounce, the likelier it never fires while the
 * agent is actually working. Measured against a real file appended every 10ms
 * for 2s: a 150ms debounce rendered ONCE, while 0/25/50ms rendered ten times.
 * Hence the throttle downstream, which has a leading edge and a ceiling.
 */
test("a transcript appended to steadily keeps rendering instead of starving", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conch-busy-"));
  try {
    const path = join(dir, "live.jsonl");
    writeFileSync(path, "");
    let renders = 0;
    const render = createPublishThrottle(() => renders++, { intervalMs: 50 });
    const watch = watchChangingPaths(() => render.request(), { debounceMs: 50 });
    watch.update([path]);
    await Bun.sleep(50);

    const until = Date.now() + 600;
    for (let i = 0; Date.now() < until; i++) {
      appendFileSync(path, `{"i":${i}}\n`);
      await Bun.sleep(10);
    }
    await Bun.sleep(150);
    // Not "exactly n": FSEvents coalesces on its own schedule. The point is that
    // a still-running turn produces renders, rather than one at the very end.
    expect(renders).toBeGreaterThan(1);
    watch.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the daemon watches live transcripts and releases them on shutdown", () => {
  const daemon = readFileSync(join(import.meta.dir, "../src/daemon.ts"), "utf8");
  expect(daemon).toContain("transcriptWatch.update(");
  expect(daemon).toContain("transcriptWatch.stop();");
  // Throttled, never a bare debounce — see the starvation test above.
  expect(daemon).toContain("createPublishThrottle(() => void renderSessionPanel()");
});
