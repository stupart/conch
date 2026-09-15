import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { LOG_FILE, STATE_FILE, logAbove, setState } from "../src/status.ts";

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
