import { describe, expect, test } from "bun:test";
import { dispatchTheaterControlKey, type TheaterControlCallbacks } from "../src/theater-controls.ts";
import { shouldDispatchTerminalInput } from "../src/status.ts";

function harness() {
  let manualSessionId: string | null = null;
  let globalPaused = false;
  const pausedSessions = new Set<string>();
  const calls: string[] = [];
  const callbacks: TheaterControlCallbacks = {
    manualSessionId: () => manualSessionId,
    globalPaused: () => globalPaused,
    sessionPaused: (id) => pausedSessions.has(id),
    setGlobalPaused(next) {
      globalPaused = next;
      calls.push(`global:${next}`);
    },
    setSessionPaused(id, next) {
      if (next) pausedSessions.add(id);
      else pausedSessions.delete(id);
      calls.push(`session:${id}:${next}`);
    },
  };
  return {
    callbacks,
    calls,
    pausedSessions,
    setManual(id: string | null) { manualSessionId = id; },
    get globalPaused() { return globalPaused; },
  };
}

describe("dispatchTheaterControlKey", () => {
  test("p toggles global manual mode without a parked session", () => {
    const h = harness();
    expect(dispatchTheaterControlKey("p", h.callbacks)).toBeTrue();
    expect(h.globalPaused).toBeTrue();
    expect(dispatchTheaterControlKey("p", h.callbacks)).toBeTrue();
    expect(h.calls).toEqual(["global:true", "global:false"]);
  });

  test("p toggles only the parked session", () => {
    const h = harness();
    h.setManual("session-a");
    dispatchTheaterControlKey("p", h.callbacks);
    expect(h.pausedSessions).toEqual(new Set(["session-a"]));
    expect(h.globalPaused).toBeFalse();
  });

  test("retired and unrelated keys stay with daemon routing", () => {
    const h = harness();
    for (const key of ["m", "\r", " ", "x"]) {
      expect(dispatchTheaterControlKey(key, h.callbacks)).toBeFalse();
    }
    expect(h.calls).toEqual([]);
  });
});

test("footer input dispatches only in the theater and footer views, and only from a TTY", () => {
  expect(shouldDispatchTerminalInput("theater", true)).toBeTrue();
  expect(shouldDispatchTerminalInput("footer", true)).toBeTrue();
  expect(shouldDispatchTerminalInput("headless", true)).toBeFalse();
  expect(shouldDispatchTerminalInput("footer", false)).toBeFalse();
});
