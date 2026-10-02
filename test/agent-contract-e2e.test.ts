import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * scripts/agent-contract-e2e.ts, run by the suite: the real MCP server over stdio against a real daemon from this
 * checkout, both in a temporary home (their own socket, config, state, sessions and reviews files), never the live
 * daemon's. It takes under a second, so the gate runs it rather than leaving it for someone to remember.
 *
 * Spawned with an explicit environment: the suite's own variables (CONCH_USER_TEMP_DIR, its CONCH_HOME) are not the
 * script's, and nothing from a tmux pane reaches it. HOME is the real one only so the script's guard can refuse a path
 * that would land in the live ~/.config/conch; it writes nothing there.
 */
test("the agent contract end to end: instructions, the daemon's verdict and surfaces, temp copies that outlive the temp folder", async () => {
  const run = Bun.spawn([process.execPath, join(import.meta.dir, "..", "scripts", "agent-contract-e2e.ts")], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir() },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  const failed = out.split("\n").filter((line) => line.includes("✗"));
  expect(failed, `${out}\n${err}`).toEqual([]);
  expect(out).toContain("✓ all passed");
  expect(exit).toBe(0);
  // Every promise the script makes is checked, not skipped.
  expect(out.split("\n").filter((line) => line.includes("✓")).length).toBeGreaterThanOrEqual(30);
}, 120_000);
