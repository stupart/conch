import { expect, test } from "bun:test";
import { resolveWakeTarget } from "../src/daemon.ts";
import type { TurnEvent } from "../src/hook.ts";

const wake = (over: Partial<TurnEvent> = {}): TurnEvent => ({
  type: "wake",
  sessionId: "",
  label: "",
  announce: "",
  ...over,
});

test("a composer wake keeps its intent when it resolves to the last session", () => {
  // A bare wake resolves to whichever session last spoke, and that remembered
  // event knows nothing about the button just pressed. Losing the intent here
  // means asking for the composer and being answered into the session — the
  // exact confusion this feature removes.
  const last = wake({ type: "turn-end", sessionId: "s1", label: "conch" });
  const resolved = resolveWakeTarget(wake({ compose: true }), last);

  expect(resolved?.sessionId).toBe("s1");
  expect(resolved?.compose).toBe(true);
});

test("an ordinary wake stays ordinary", () => {
  // The voice loop must not change: an announced turn opens the mic to REPLY,
  // and that reply belongs in the session.
  const resolved = resolveWakeTarget(
    wake({ sessionId: "s1", label: "conch" }),
    null,
  );
  expect(resolved?.compose).toBeUndefined();
});
