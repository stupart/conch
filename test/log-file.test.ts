import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { LOG_FILE, MAX_LOG_BYTES, STATE_FILE, logAbove, setState } from "../src/status.ts";

/**
 * The suite must never write into the live daemon's log. A7 was exactly
 * that: ~90 "copied N chars" lines a day, all from the theater tests, with
 * UTC timestamps because bun test runs in UTC. The preload points LOG_FILE
 * at a temp file before status.ts is imported; this proves the redirect
 * took and that logAbove honours it, without inspecting the running daemon.
 */
test("under test, logAbove writes to the redirected log, not the daemon's", () => {
  expect(LOG_FILE).not.toBe("/tmp/conch-daemon.log");
  expect(LOG_FILE).toBe(process.env.CONCH_LOG_FILE ?? "");
  logAbove("log-file test marker 7f3a");
  expect(readFileSync(LOG_FILE, "utf8")).toContain("log-file test marker 7f3a");
});

// Same class, the state file: every setState in the suite rewrote the live
// daemon's /tmp/conch-state.json. Check the actual redirected destination;
// reading the running daemon's state would make this test non-isolated.
test("under test, setState writes to the redirected state file, not the daemon's", async () => {
  expect(STATE_FILE).not.toBe("/tmp/conch-state.json");
  expect(STATE_FILE).toBe(process.env.CONCH_STATE_FILE ?? "");
  const marker = `state-file test marker ${process.pid}`;
  setState("idle", marker);
  const deadline = Date.now() + 2_000;
  while (!(existsSync(STATE_FILE) && readFileSync(STATE_FILE, "utf8").includes(marker))) {
    if (Date.now() > deadline) throw new Error("the redirected state file never got the write");
    await Bun.sleep(5);
  }
  setState("idle");
});

// The daemon runs for weeks; rolling over only at startup let the log grow
// without bound in between (review finding 22).
test("the log rolls over at its size limit while running, keeping one private old file", () => {
  rmSync(`${LOG_FILE}.1`, { force: true });
  const line = "x".repeat(256 * 1024);
  for (let written = 0; written <= MAX_LOG_BYTES + line.length; written += line.length + 1) logAbove(line);
  logAbove("after the roll 9c1d");
  expect(existsSync(`${LOG_FILE}.1`)).toBe(true);
  expect(statSync(LOG_FILE).size).toBeLessThan(MAX_LOG_BYTES);
  expect(statSync(LOG_FILE).mode & 0o777).toBe(0o600);
  expect(readFileSync(LOG_FILE, "utf8")).toContain("after the roll 9c1d");
  expect(readFileSync(`${LOG_FILE}.1`, "utf8")).not.toContain("after the roll 9c1d");
  rmSync(`${LOG_FILE}.1`, { force: true });
});
