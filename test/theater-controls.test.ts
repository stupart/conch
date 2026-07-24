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

function harness() {
  let manualSessionId: string | null = null;
  let globalPaused = false;
  let globalMuted = false;
  const pausedSessions = new Set<string>();
  const mutedSessions = new Set<string>();
  const calls: string[] = [];

  const callbacks: TheaterControlCallbacks = {
    manualSessionId: () => manualSessionId,
    globalPaused: () => globalPaused,
    globalMuted: () => globalMuted,
    sessionPaused: (sessionId) => pausedSessions.has(sessionId),
    sessionMuted: (sessionId) => mutedSessions.has(sessionId),
    setGlobalPaused(next) {
      globalPaused = next;
      calls.push(`global-pause:${next}`);
    },
    setGlobalMuted(next) {
      globalMuted = next;
      calls.push(`global-mute:${next}`);
    },
    setSessionPaused(sessionId, next) {
      if (next) pausedSessions.add(sessionId);
      else pausedSessions.delete(sessionId);
      calls.push(`session-pause:${sessionId}:${next}`);
    },
    setSessionMuted(sessionId, next) {
      if (next) mutedSessions.add(sessionId);
      else mutedSessions.delete(sessionId);
      calls.push(`session-mute:${sessionId}:${next}`);
    },
  };

  return {
    callbacks,
    calls,
    pausedSessions,
    mutedSessions,
    setManualSessionId(sessionId: string | null) {
      manualSessionId = sessionId;
    },
    get globalPaused() {
      return globalPaused;
    },
    get globalMuted() {
      return globalMuted;
    },
  };
}

describe("dispatchTheaterControlKey", () => {
  test("p toggles global pause when no session is parked", () => {
    const h = harness();

    expect(dispatchTheaterControlKey("p", h.callbacks)).toBeTrue();
    expect(h.globalPaused).toBeTrue();
    expect(dispatchTheaterControlKey("p", h.callbacks)).toBeTrue();
    expect(h.globalPaused).toBeFalse();
    expect(h.calls).toEqual(["global-pause:true", "global-pause:false"]);
  });

  test("p toggles only the parked session", () => {
    const h = harness();
    h.setManualSessionId("session-a");

    expect(dispatchTheaterControlKey("p", h.callbacks)).toBeTrue();
    expect(h.pausedSessions).toEqual(new Set(["session-a"]));
    expect(h.globalPaused).toBeFalse();
    expect(dispatchTheaterControlKey("p", h.callbacks)).toBeTrue();
    expect(h.pausedSessions).toEqual(new Set());
    expect(h.calls).toEqual([
      "session-pause:session-a:true",
      "session-pause:session-a:false",
    ]);
  });

  test("m toggles globally or only the parked session by the same rule", () => {
    const h = harness();

    expect(dispatchTheaterControlKey("m", h.callbacks)).toBeTrue();
    expect(h.globalMuted).toBeTrue();
    expect(dispatchTheaterControlKey("m", h.callbacks)).toBeTrue();
    expect(h.globalMuted).toBeFalse();

    h.setManualSessionId("session-b");
    expect(dispatchTheaterControlKey("m", h.callbacks)).toBeTrue();
    expect(h.mutedSessions).toEqual(new Set(["session-b"]));
    expect(h.globalMuted).toBeFalse();
    expect(dispatchTheaterControlKey("m", h.callbacks)).toBeTrue();
    expect(h.mutedSessions).toEqual(new Set());
    expect(h.calls).toEqual([
      "global-mute:true",
      "global-mute:false",
      "session-mute:session-b:true",
      "session-mute:session-b:false",
    ]);
  });

  test("Enter is unbound and space remains owned by talk/stop", () => {
    const h = harness();
    h.setManualSessionId("session-a");

    for (const key of ["\r", "\n", " ", "x"]) {
      expect(dispatchTheaterControlKey(key, h.callbacks)).toBeFalse();
    }
    expect(h.calls).toEqual([]);
  });
});

describe("dashboard control copy", () => {
  test("keybars and help agree on space, p, m with no snooze binding", () => {
    const plain = (text: string): string =>
      text.replace(/\x1b\[[0-9;]*m/g, "").toLowerCase();
    const copy = [
      THEATER_KEYBAR,
      FOOTER_KEYBAR,
      DASHBOARD_HELP_KEYS,
      DASHBOARD_HELP_CONTROLS,
      dashboardHelpText(),
    ];

    for (const text of copy) {
      expect(plain(text)).not.toContain("snooze");
      expect(plain(text)).not.toContain("enter");
    }

    for (const keybar of [THEATER_KEYBAR, FOOTER_KEYBAR]) {
      const text = plain(keybar);
      expect(text).toContain("space talk");
      expect(text).toContain("p pause");
      expect(text).toContain("m mute");
      expect(text.indexOf("space talk")).toBeLessThan(text.indexOf("p pause"));
      expect(text.indexOf("p pause")).toBeLessThan(text.indexOf("m mute"));
    }

    const keys = plain(DASHBOARD_HELP_KEYS);
    expect(keys).toContain("space talk / stop");
    expect(keys).toContain("p pause/resume");
    expect(keys).toContain("m mute/unmute");
    expect(keys.indexOf("space talk / stop")).toBeLessThan(keys.indexOf("p pause/resume"));
    expect(keys.indexOf("p pause/resume")).toBeLessThan(keys.indexOf("m mute/unmute"));

    const controls = plain(DASHBOARD_HELP_CONTROLS);
    expect(controls).toContain("parked cursor");
    expect(controls).toContain("affect that session");
    expect(controls).toContain("affect the whole app");
    expect(controls).toContain("holds + replays");
    expect(controls).toContain("forgets");
  });

  test("README dashboard documents the same context-sensitive keymap", async () => {
    const readme = (await Bun.file(new URL("../README.md", import.meta.url)).text()).toLowerCase();
    const dashboard = readme.slice(readme.indexOf("## the dashboard"));

    expect(dashboard).toContain("space talk · p pause · m mute");
    expect(dashboard).toContain("while the cursor is live and the whole app otherwise");
    expect(dashboard).toContain("**q** quits");
    expect(dashboard).not.toContain("enter snooze");
    expect(dashboard).not.toContain("enter** snooze");
  });

  test("daemon composition routes raw controls through the tested instant seams", async () => {
    const source = await Bun.file(new URL("../src/daemon.ts", import.meta.url)).text();
    const rawKeys = source.slice(
      source.indexOf('process.stdin.on("data"'),
      source.indexOf("function printHelp"),
    );
    const enqueue = source.slice(
      source.indexOf("function enqueue"),
      source.indexOf("async function drain"),
    );
    const callbacks = source.slice(
      source.indexOf("const theaterControls"),
      source.indexOf("// Interactive keys"),
    );

    expect(rawKeys).toContain("dispatchTheaterControlKey(c, theaterControls)");
    expect(rawKeys).not.toContain('c === "\\r"');
    expect(rawKeys).not.toContain('c === "\\n"');
    expect(callbacks).toContain("theaterNavigation.manualControlTarget()");
    expect(callbacks).not.toContain("theaterActionTarget()");
    expect(enqueue).toContain("instantControls.applyGlobal(event.type)");
    expect(enqueue).toContain("if (forgetOnArrival)");
    expect(enqueue).toContain("else if (shouldHandleTurnAudibly(event, cfg.workingMic))");
    expect(enqueue.indexOf("instantControls.applyGlobal(event.type)")).toBeLessThan(
      enqueue.indexOf("void drain()"),
    );
    expect(source).toContain("if (sessionId === undefined) latestTurnBySession.clear()");
    expect(source).toContain("else latestTurnBySession.delete(sessionId)");
    expect(source).not.toContain('requestExternal("mute")');
    expect(source).not.toContain('requestExternal("pause")');
    expect(source).toContain('if (event.type === "mute") return muted ? announceMuted(true)');
    expect(source).toContain('if (event.type === "unmute") return !muted ? announceMuted(false)');
    expect(source).toContain("muted || cfg.awayAfterSecs");
    expect(source).toContain("setKeybar(theaterMode ? THEATER_KEYBAR : FOOTER_KEYBAR)");
    expect(source).toContain("logAbove(dashboardHelpText())");
  });
});
