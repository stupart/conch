import { expect, test } from "bun:test";

/**
 * The only automated thing that reads `runDaemon`.
 *
 * `bun test` does not typecheck, and nothing else ran `tsc` — the script in
 * package.json existed and depended on somebody remembering. That is a thin
 * gate anywhere, and for `src/daemon.ts` it is the ONLY one: `runDaemon` is
 * four thousand lines that no test executes, so the suite's coverage of it is
 * guard tests reading the file as TEXT. Source text cannot tell you that an
 * identifier no longer resolves.
 *
 * It caught exactly that within a day of being needed. Extracting the session
 * ledger moved `eventTimestamp` into `session-ledger.ts` without exporting it,
 * and left `setSessionState` in `daemon.ts` still calling it — a `ReferenceError`
 * on the first state event, which is to say on essentially every turn. All 1138
 * tests passed, because none of them run that function.
 *
 * Two seconds against a seven-second suite, for the one check that reads the
 * daemon the way the runtime does.
 */
test("the project typechecks", async () => {
  const tsc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(tsc.stdout).text(),
    new Response(tsc.stderr).text(),
    tsc.exited,
  ]);
  // The diagnostics ARE the failure message: a bare "expected 0, got 2" would
  // send you back to the terminal to find out what broke.
  expect(`${code}\n${out}${err}`.trim()).toBe("0");
}, 120_000);
