import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { LOG_FILE, logAbove } from "../src/status.ts";

/**
 * The suite must never write into the live daemon's log. A7 was exactly
 * that: ~90 "copied N chars" lines a day, all from the theater tests, with
 * UTC timestamps because bun test runs in UTC. The preload points LOG_FILE
 * at a temp file before status.ts is imported; this proves the redirect
 * took and that logAbove honours it.
 */
test("under test, logAbove writes to the redirected log, not the daemon's", () => {
  expect(LOG_FILE).not.toBe("/tmp/conch-daemon.log");
  expect(LOG_FILE).toBe(process.env.CONCH_LOG_FILE ?? "");
  const liveBytes = existsSync("/tmp/conch-daemon.log") ? statSync("/tmp/conch-daemon.log").size : 0;
  logAbove("log-file test marker 7f3a");
  expect(readFileSync(LOG_FILE, "utf8")).toContain("log-file test marker 7f3a");
  const liveAfter = existsSync("/tmp/conch-daemon.log") ? statSync("/tmp/conch-daemon.log").size : 0;
  expect(liveAfter).toBe(liveBytes);
});
