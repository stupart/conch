import { expect, test } from "bun:test";
import { applySessionCommand } from "../src/control-server.ts";
import type { SessionActionsController, SessionActionsTarget } from "../src/session-actions-overlay.ts";

function harness(target: SessionActionsTarget | null) {
  const revealed: SessionActionsTarget[] = [];
  const controller = {
    reveal: (t: SessionActionsTarget) => {
      revealed.push(t);
      return new Promise<boolean>(() => {}); // never settles: the reply must not wait on AppleScript
    },
  } as unknown as SessionActionsController;
  const pause = { open: () => {}, close: () => {} };
  return {
    revealed,
    reply: () => applySessionCommand(
      { kind: "session-command", sessionId: "s1", command: "reveal" },
      { controller, pause, targetForSessionId: () => target },
    ),
  };
}

/**
 * Passive reveals use `revealSessionWindow`, as `revealOnTurn` does. The
 * ack says whether there was a process to try —
 * a session conch only observes has nothing to raise — and it comes back
 * before the AppleScript does, because a click must not block on Terminal.
 */
test("reveal asks the controller and acks by whether there was a process to try", () => {
  const withPid = harness({ sessionId: "s1", label: "morrow", pid: 4242 });
  expect(withPid.reply()).toEqual({
    kind: "session-ack", sessionId: "s1", command: "reveal", changed: true, label: "morrow",
  });
  expect(withPid.revealed).toEqual([{ sessionId: "s1", label: "morrow", pid: 4242 }]);

  const observed = harness({ sessionId: "s1", label: "morrow" });
  expect(observed.reply().kind).toBe("session-ack");
  expect((observed.reply() as { changed: boolean }).changed).toBe(false);

  const unknown = harness(null);
  expect((unknown.reply() as { changed: boolean }).changed).toBe(false);
});
