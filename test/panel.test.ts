import { expect, test, describe } from "bun:test";
import {
  activeSessionIdForRows,
  buildPanelModel,
  buildPanelRows,
  dashboardPanelLines,
  dashboardRowsForModel,
  latestLatchedState,
  reconcileStatus,
  registryToPanel,
} from "../src/panel.ts";
import { TheaterNavigation } from "../src/theater-navigation.ts";

describe("buildPanelModel — renderer seam", () => {
  test("builds sorted semantic rows with independent active and nav cursors", () => {
    const model = buildPanelModel({
      sessions: [
        { sessionId: "working", name: "Work", status: "busy", statusUpdatedAt: 30 },
        { sessionId: "waiting", name: "Wait", status: "idle", statusUpdatedAt: 30 },
        { sessionId: "needs", name: "Need", status: "busy", statusUpdatedAt: 10 },
      ],
      sessionStates: new Map([
        ["needs", { label: "Need", status: "needs" as const, detail: "permission", at: 40 }],
      ]),
      snoozedSessionIds: new Set(["waiting"]),
      live: { state: "speaking", label: "Work", partial: "" },
      mode: { muted: false, paused: true, holding: 2 },
      activeSessionId: "working",
      navSelectedId: "waiting",
      reply: { sessionId: "working", text: "A finished response.", spokenChars: 2 },
    });

    expect(model.rows.map((row) => row.sessionId)).toEqual(["needs", "waiting", "working"]);
    expect(model.rows[0]).toMatchObject({ status: "needs", detail: "permission" });
    expect(model.rows[1]).toMatchObject({ snoozed: true, active: false, navSelected: true });
    expect(model.rows[2]).toMatchObject({
      status: "working",
      liveGlyph: "speaking",
      active: true,
      navSelected: false,
    });
    expect(model.mode).toEqual({ muted: false, paused: true, holding: 2 });
    expect(model.live).toEqual({ state: "speaking", label: "Work", partial: "" });
    expect(model.reply).toEqual({ sessionId: "working", text: "A finished response.", spokenChars: 2 });
  });

  test("duplicate labels resolve highlight and action id from status-sorted row order", () => {
    const options = {
      sessions: [
        { sessionId: "raw-first", name: "same", status: "busy", statusUpdatedAt: 30 },
        { sessionId: "sorted-first", name: "same", status: "waiting", statusUpdatedAt: 30 },
      ],
      sessionStates: new Map(),
      snoozedSessionIds: new Set<string>(),
      live: { state: "speaking" as const, label: "same", partial: "" },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
    };
    const orderedRows = buildPanelRows(options);
    const actionTargetId = activeSessionIdForRows(orderedRows, options.live);
    const model = buildPanelModel({
      ...options,
      activeSessionId: actionTargetId,
      navSelectedId: actionTargetId,
    });
    const theaterNavigation = new TheaterNavigation(() => {});
    theaterNavigation.commitFrame(actionTargetId, null);

    expect(orderedRows.map((row) => row.sessionId)).toEqual(["sorted-first", "raw-first"]);
    expect(actionTargetId).toBe("sorted-first");
    expect(theaterNavigation.actionTarget("fallback")).toBe("sorted-first");
    expect(model.rows.find((row) => row.active)?.sessionId).toBe("sorted-first");
    expect(dashboardRowsForModel(model)[0]?.startsWith("\x1b[36m▸\x1b[0m ")).toBe(true);
  });
});

describe("dashboard global mode banner", () => {
  const active = dashboardPanelLines(["session row"], 80, { muted: false, paused: false, holding: 0 });
  const paused = dashboardPanelLines(["session row"], 80, { muted: false, paused: true, holding: 3 });
  const muted = dashboardPanelLines(["session row"], 80, { muted: true, paused: false, holding: 0 });

  test("uses a fixed slot under the header in every mode", () => {
    expect(active[1]).toContain("🐚 conch");
    expect(active[2]).toBe("");
    expect(active[3]).toContain("─");
    expect(active[4]).toBe("session row");
    expect(paused).toHaveLength(active.length);
    expect(muted).toHaveLength(active.length);
  });

  test("shows pause with the held-session count", () => {
    expect(paused[2]).toContain("⏸ PAUSED");
    expect(paused[2]).toContain("holding 3");
    expect(paused[2]).toContain("press p to resume");
  });

  test("shows mute and gives it precedence over a simultaneous pause", () => {
    expect(muted[2]).toContain("🔇 MUTED");
    expect(muted[2]).toContain("press m to unmute");
    const both = dashboardPanelLines([], 80, { muted: true, paused: true, holding: 2 });
    expect(both[2]).toContain("MUTED");
    expect(both[2]).not.toContain("PAUSED");
  });

  test("remains visible with no session rows", () => {
    const lines = dashboardPanelLines([], 80, { muted: false, paused: true, holding: 0 });
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("PAUSED");
  });
});

describe("registryToPanel — maps Claude Code's status vocabulary", () => {
  test("idle → waiting (turn done)", () => expect(registryToPanel("idle")).toBe("waiting"));
  test("busy/running/shell → working", () => {
    expect(registryToPanel("busy")).toBe("working");
    expect(registryToPanel("running")).toBe("working");
    expect(registryToPanel("shell")).toBe("working");
  });
  test("waiting/blocked → needs (blocked on input)", () => {
    expect(registryToPanel("waiting")).toBe("needs");
    expect(registryToPanel("blocked")).toBe("needs");
  });
  test("unknown/undefined → null (defer to the latch)", () => {
    expect(registryToPanel("something-new")).toBeNull();
    expect(registryToPanel(undefined)).toBeNull();
  });
});

describe("reconcileStatus — BUG A: newer signal wins, so the panel never sticks", () => {
  test("stale 'waiting' latch is overridden by a NEWER busy registry (the core bug)", () => {
    // Prior Stop latched "waiting" at 1000; session resumed (registry busy at 2000)
    // without firing UserPromptSubmit. Registry is newer → working.
    expect(reconcileStatus({ status: "busy", statusUpdatedAt: 2000 }, { status: "waiting", at: 1000 })).toBe("working");
  });

  test("a just-received 'working' latch wins over an older idle registry (no flicker)", () => {
    // You just submitted (working latched at 2000); registry hasn't flipped yet (idle at 1000).
    expect(reconcileStatus({ status: "idle", statusUpdatedAt: 1000 }, { status: "working", at: 2000 })).toBe("working");
  });

  test("a plain busy session with no latch shows working — never nags", () => {
    expect(reconcileStatus({ status: "busy", statusUpdatedAt: 1000 }, undefined)).toBe("working");
  });

  test("registry 'waiting'/'blocked' surfaces as needs even with no latch", () => {
    expect(reconcileStatus({ status: "waiting", statusUpdatedAt: 1000 }, undefined)).toBe("needs");
    expect(reconcileStatus({ status: "blocked", statusUpdatedAt: 1000 }, undefined)).toBe("needs");
  });

  test("idle registry (newer than latch) shows waiting", () => {
    expect(reconcileStatus({ status: "idle", statusUpdatedAt: 2000 }, { status: "working", at: 1000 })).toBe("waiting");
  });

  test("a fresh 'needs' latch wins over an older registry status", () => {
    expect(reconcileStatus({ status: "busy", statusUpdatedAt: 1500 }, { status: "needs", at: 2000 })).toBe("needs");
  });

  test("needs auto-clears once the session moves on (registry status is newer)", () => {
    expect(reconcileStatus({ status: "busy", statusUpdatedAt: 3000 }, { status: "needs", at: 2000 })).toBe("working");
  });

  test("tie (equal timestamps) goes to the latch", () => {
    expect(reconcileStatus({ status: "busy", statusUpdatedAt: 2000 }, { status: "needs", at: 2000 })).toBe("needs");
  });

  test("no registry status falls back to the latched value", () => {
    expect(reconcileStatus({}, { status: "working", at: 1000 })).toBe("working");
  });

  test("no registry status and no latch → null (dim idle)", () => {
    expect(reconcileStatus({}, undefined)).toBeNull();
  });
});

describe("latestLatchedState — event-time ordering", () => {
  test("an older working event cannot overwrite a newer turn-end latch", () => {
    const turnEnd = { status: "waiting" as const, at: 2_000 };
    const olderWorking = { status: "working" as const, at: 1_000 };

    expect(latestLatchedState(turnEnd, olderWorking)).toBe(turnEnd);
  });

  test("a newer event replaces the current latch", () => {
    const working = { status: "working" as const, at: 1_000 };
    const turnEnd = { status: "waiting" as const, at: 2_000 };

    expect(latestLatchedState(working, turnEnd)).toBe(turnEnd);
  });
});
