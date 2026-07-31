import { expect, test, describe } from "bun:test";
import {
  activeSessionIdForRows,
  buildPanelModel,
  buildPanelRows,
  buildPublishedState,
  dashboardPanelLines,
  dashboardRowsForModel,
  latestLatchedState,
  numberPanelSessionRows,
  previewForPanelSelection,
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
      pausedSessionIds: new Set(["waiting"]),
      mutedSessionIds: new Set(["needs"]),
      live: { state: "speaking", label: "Work", partial: "" },
      mode: { muted: false, paused: true, holding: 2 },
      activeSessionId: "working",
      navSelectedId: "waiting",
      reply: { sessionId: "working", text: "A finished response.", spokenChars: 2 },
    });

    expect(model.rows.map((row) => row.sessionId)).toEqual(["needs", "waiting", "working"]);
    expect(model.rows[0]).toMatchObject({
      status: "needs",
      at: 40,
      detail: "permission",
      paused: false,
      muted: true,
    });
    expect(model.rows[1]).toMatchObject({
      at: 30,
      paused: true,
      muted: false,
      active: false,
      navSelected: true,
    });
    expect(model.rows[2]).toMatchObject({
      status: "working",
      at: 30,
      paused: false,
      muted: false,
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
      pausedSessionIds: new Set<string>(),
      mutedSessionIds: new Set<string>(),
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

  test("renders per-session mute ahead of pause without legacy snooze wording", () => {
    const model = buildPanelModel({
      sessions: [{ sessionId: "quiet", name: "Quiet", status: "idle", statusUpdatedAt: 30 }],
      sessionStates: new Map(),
      pausedSessionIds: new Set(["quiet"]),
      mutedSessionIds: new Set(["quiet"]),
      live: { state: "idle", label: "", partial: "" },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
    });

    const row = dashboardRowsForModel(model)[0]!;
    expect(row).toContain("\x1b[2m");
    expect(row).toContain("🔇 muted");
    expect(row).not.toContain("⏸ paused");
    expect(row.toLowerCase()).not.toContain("snooz");
  });
});

describe("buildPublishedState — external session snapshot", () => {
  test("maps semantic rows, snippets, dismissed ids, and version metadata", () => {
    const model = buildPanelModel({
      sessions: [
        { sessionId: "waiting", name: "Wait", status: "idle", statusUpdatedAt: 30 },
        { sessionId: "needs", name: "Need", status: "busy", statusUpdatedAt: 10 },
      ],
      sessionStates: new Map([
        ["needs", { label: "Need", status: "needs" as const, detail: "permission", at: 40 }],
      ]),
      pausedSessionIds: new Set(["needs"]),
      mutedSessionIds: new Set(["needs"]),
      live: { state: "speaking", label: "Need", partial: "TUI-only partial" },
      mode: { muted: false, paused: true, holding: 2 },
      activeSessionId: "needs",
      navSelectedId: "waiting",
    });

    const published = buildPublishedState(
      model,
      new Map([
        ["needs", "Need: latest reply"],
        ["wrong-session", "must not attach"],
      ]),
      new Set(["dismissed-session"]),
      1_234_567,
    );

    expect(published).toEqual({
      v: 1,
      ts: 1_234_567,
      mode: { muted: false, paused: true, holding: 2 },
      live: { state: "speaking", label: "Need" },
      rows: [
        {
          id: "needs",
          label: "Need",
          status: "needs",
          needsResponse: true,
          detail: "permission",
          paused: true,
          muted: true,
          live: "speaking",
          active: true,
          snippet: "Need: latest reply",
        },
        {
          id: "waiting",
          label: "Wait",
          status: "waiting",
          needsResponse: false,
          paused: false,
          muted: false,
          live: null,
          active: false,
        },
      ],
      dismissed: ["dismissed-session"],
    });
    expect(published.rows.some((row) => row.id === "dismissed-session")).toBe(false);
    expect("snippet" in published.rows[1]!).toBe(false);
    expect(JSON.parse(JSON.stringify(published))).toEqual(published);
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
    expect(paused[2]).toContain("no parked cursor: p to resume");
  });

  test("shows mute and gives it precedence over a simultaneous pause", () => {
    expect(muted[2]).toContain("🔇 MUTED");
    expect(muted[2]).toContain("no parked cursor: m to unmute");
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

  test("a review latch survives a newer idle registry refresh", () => {
    expect(reconcileStatus(
      { status: "idle", statusUpdatedAt: 3_000 },
      { status: "review", at: 2_000 },
    )).toBe("review");
  });

  test("the review exception is waiting-only, so newer busy clears it", () => {
    expect(reconcileStatus(
      { status: "busy", statusUpdatedAt: 3_000 },
      { status: "review", at: 2_000 },
    )).toBe("working");
  });

  test("an equal-timestamp review latch wins the boundary tie", () => {
    expect(reconcileStatus(
      { status: "busy", statusUpdatedAt: 2_000 },
      { status: "review", at: 2_000 },
    )).toBe("review");
  });
});

test("a review keeps its natural waiting position — the marker doesn't reorder the dashboard", () => {
  const rows = buildPanelRows({
    sessions: [
      { sessionId: "working", name: "Working", status: "busy", statusUpdatedAt: 10 },
      { sessionId: "waiting", name: "Waiting", status: "idle", statusUpdatedAt: 10 },
      { sessionId: "needs", name: "Needs", status: "waiting", statusUpdatedAt: 10 },
      { sessionId: "review", name: "Review", status: "idle", statusUpdatedAt: 10 },
    ],
    sessionStates: new Map([
      ["review", {
        label: "Review",
        status: "review",
        at: 20,
        review: { summary: "Ready to inspect" },
      }],
    ]),
    pausedSessionIds: new Set(),
    mutedSessionIds: new Set(),
    live: { state: "idle", label: "", partial: "" },
    mode: { muted: false, paused: false, holding: 0 },
    activeSessionId: null,
    navSelectedId: null,
  });

  // "needs" still leads (it's blocking you); the review sits among waiting rows
  // exactly where an idle session would, ordered by label — no jump to the top.
  expect(rows.map((row) => row.sessionId)).toEqual([
    "needs",
    "review",
    "waiting",
    "working",
  ]);
});

test("number shortcuts map to the same status-sorted positions the ledger renders", () => {
  const sessions = [
    {
      sessionId: "alpha-working",
      name: "Alpha",
      status: "busy",
      statusUpdatedAt: 30,
      cwd: "/alpha",
      pid: 101,
    },
    {
      sessionId: "bravo-waiting",
      name: "Bravo",
      status: "idle",
      statusUpdatedAt: 30,
      cwd: "/bravo",
      pid: 102,
    },
    {
      sessionId: "zulu-needs",
      name: "Zulu",
      status: "waiting",
      statusUpdatedAt: 30,
      cwd: "/zulu",
      pid: 103,
    },
  ];
  const rows = buildPanelRows({
    sessions,
    sessionStates: new Map(),
    pausedSessionIds: new Set(),
    mutedSessionIds: new Set(),
    live: { state: "idle", label: "", partial: "" },
    mode: { muted: false, paused: false, holding: 0 },
    activeSessionId: null,
    navSelectedId: null,
  });

  expect(rows.map((row) => row.sessionId)).toEqual([
    "zulu-needs",
    "bravo-waiting",
    "alpha-working",
  ]);
  expect(numberPanelSessionRows(rows, sessions).map((row) => [
    row.n,
    row.s.sessionId,
    row.s.cwd,
    row.s.pid,
  ])).toEqual([
    [1, "zulu-needs", "/zulu", 103],
    [2, "bravo-waiting", "/bravo", 102],
    [3, "alpha-working", "/alpha", 101],
  ]);
});

test("buildPanelRows carries review detail and timestamped metadata", () => {
  const [row] = buildPanelRows({
    sessions: [{ sessionId: "review", name: "Review", status: "idle", statusUpdatedAt: 10 }],
    sessionStates: new Map([
      ["review", {
        label: "Review",
        status: "review",
        detail: "PR ready to inspect",
        at: 20,
        review: { summary: "PR ready to inspect", link: "https://example.com/pr/1" },
      }],
    ]),
    pausedSessionIds: new Set(),
    mutedSessionIds: new Set(),
    live: { state: "idle", label: "", partial: "" },
    mode: { muted: false, paused: false, holding: 0 },
    activeSessionId: null,
    navSelectedId: null,
  });

  expect(row).toMatchObject({
    status: "review",
    at: 20,
    detail: "PR ready to inspect",
    review: {
      summary: "PR ready to inspect",
      link: "https://example.com/pr/1",
      at: 20,
    },
  });
});

test("dashboardRowsForModel renders the review star and dimmed summary detail", () => {
  const model = buildPanelModel({
    sessions: [{ sessionId: "review", name: "Review", status: "idle", statusUpdatedAt: 10 }],
    sessionStates: new Map([
      ["review", {
        label: "Review",
        status: "review",
        detail: "PR ready to inspect",
        at: 20,
        review: { summary: "PR ready to inspect" },
      }],
    ]),
    pausedSessionIds: new Set(),
    mutedSessionIds: new Set(),
    live: { state: "idle", label: "", partial: "" },
    mode: { muted: false, paused: false, holding: 0 },
    activeSessionId: null,
    navSelectedId: null,
  });

  const row = dashboardRowsForModel(model)[0]!;
  expect(row).toContain("\x1b[33m⭐ needs review\x1b[0m");
  expect(row).toContain("\x1b[2m(PR ready to inspect)\x1b[0m");
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

describe("previewForPanelSelection — async cursor stale guard", () => {
  test("never attaches A's completed read beneath a cursor that moved to B", () => {
    expect(previewForPanelSelection("b", "a", null, "A's latest output")).toBeNull();
    expect(previewForPanelSelection("b", "b", null, "B's latest output")).toEqual({
      sessionId: "b",
      text: "B's latest output",
      spokenChars: 0,
    });
  });

  test("suppresses empty and active-session previews", () => {
    expect(previewForPanelSelection("b", "b", "b", "live output")).toBeNull();
    expect(previewForPanelSelection("b", "b", null, "")).toBeNull();
    expect(previewForPanelSelection(null, "b", null, "output")).toBeNull();
  });

  test("daemon captures the requested id before await and commits through the guard", async () => {
    const source = await Bun.file(new URL("../src/daemon.ts", import.meta.url)).text();
    const render = source.slice(
      source.indexOf("async function renderSessionPanel"),
      source.indexOf("function setSessionState"),
    );
    expect(render).toContain(
      "const previewId = theaterMode ? theaterNavigation.manualSelectedId : null",
    );
    expect(render).toContain(
      `model.preview = previewForPanelSelection(
        navSelectedId,
        previewId,
        nextActiveSessionId,
        previewText,
      )`,
    );
    expect(render).toContain(
      `if (snap?.complete) {
          theaterNavigation.reconcile(new Set(live.map((session) => session.sessionId)));
        }`,
    );
    expect(render.indexOf("const previewId")).toBeLessThan(
      render.indexOf("await Promise.all"),
    );
    expect(render.indexOf("model.preview = previewForPanelSelection(")).toBeGreaterThan(
      render.indexOf("navSelectedId = theaterNavigation.manualSelectedId"),
    );
    expect(render.indexOf("model.preview = previewForPanelSelection(")).toBeGreaterThan(
      render.indexOf("commitLatestPanelRender("),
    );
  });
});
