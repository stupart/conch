import { describe, expect, test } from "bun:test";
import {
  DASHBOARD_HELP_CONTROLS,
  DASHBOARD_HELP_KEYS,
  FOOTER_KEYBAR,
  THEATER_KEYBAR,
  dashboardHelpText,
  dispatchTheaterControlKey,
  type TheaterControlCallbacks,
} from "../src/theater-controls.ts";
import { shouldDispatchTerminalInput, terminalCellWidth } from "../src/status.ts";

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

describe("dashboard control copy", () => {
  const plain = (text: string): string =>
    text.replace(/\x1b\[[0-9;]*m/g, "").toLowerCase();

  test("advertises auto/manual and the all-session restore selector", () => {
    const all = plain([
      THEATER_KEYBAR,
      FOOTER_KEYBAR,
      DASHBOARD_HELP_KEYS,
      DASHBOARD_HELP_CONTROLS,
      dashboardHelpText(),
    ].join("\n"));
    expect(all).toContain("auto/manual");
    expect(all).toContain("u restore");
    expect(all).not.toContain("m mute");
    expect(all).not.toContain("unmute");
    expect(terminalCellWidth(THEATER_KEYBAR)).toBeLessThanOrEqual(119);
  });

  test("footer input dispatch matches every rendered keybar", () => {
    expect(shouldDispatchTerminalInput("theater", true)).toBeTrue();
    expect(shouldDispatchTerminalInput("footer", true)).toBeTrue();
    expect(shouldDispatchTerminalInput("headless", true)).toBeFalse();
    expect(shouldDispatchTerminalInput("footer", false)).toBeFalse();
    expect(plain(FOOTER_KEYBAR)).not.toContain("l logs");
  });

  test("daemon routes restore before ordinary theater controls", async () => {
    const source = await Bun.file(new URL("../src/daemon.ts", import.meta.url)).text();
    const raw = source.slice(
      source.indexOf('process.stdin.on("data"'),
      source.indexOf("function printHelp"),
    );
    expect(raw).toContain("restoreSessionsOverlay?.handleKey(c)");
    expect(raw).toContain('theaterMode && c === "u"');
    expect(raw.indexOf("restoreSessionsOverlay?.handleKey(c)")).toBeLessThan(
      raw.indexOf("dispatchTheaterControlKey(c, theaterControls)"),
    );
    expect(source).toContain("setKeybar(theaterMode ? THEATER_KEYBAR : FOOTER_KEYBAR)");
    expect(source).not.toContain('c === "m"');
  });
});
