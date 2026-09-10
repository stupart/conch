import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");

/**
 * The socket server is tested end to end against a STUB application; the
 * daemon's real wiring of the five entries is executed by nothing. A mutation
 * proved it: replacing the turn entry with `() => {}` — every socket wake,
 * inject and interrupt silently dropped — passed all 1,233 tests, because
 * `runDaemon` runs in no test and the typecheck cannot tell an unused
 * parameter from a used one.
 *
 * Text is the only gate `runDaemon` has, so this pins each entry to the
 * helper that owns its behaviour. Presence is asserted first: `indexOf`
 * returns -1 for a missing marker and -1 sorts before everything.
 */
test("the daemon wires all five control-server entries to their owners", () => {
  const at = daemon.indexOf("const controlServer = createControlServer({");
  expect(at).toBeGreaterThan(-1);
  const wiring = daemon.slice(at, daemon.indexOf("\n  });", at));
  expect(wiring).toContain("configuration: (message) => applyConfigControlMessage(message, configController, {");
  expect(wiring).toContain("session: (message) => applySessionCommand(message, sessionCommandDispatchOptions),");
  expect(wiring).toContain("runtime: (message) => applyRuntimeControlMessage(message, runtimeControlDispatchOptions),");
  expect(wiring).toContain("turn: (event) => dispatchSocketTurnEvent(event, socketTurnCallbacks),");
  expect(wiring).toContain("device: deviceCommand,");
  // Local reads: address translation and the published-row check that
  // authorises an inject. Both must come from the daemon's own state.
  expect(wiring).toContain("resolve: addressWindow,");
  expect(wiring).toContain("if (!row) return { published: false };");
});
