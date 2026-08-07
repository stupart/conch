import { expect, test, describe } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeSessionIdForRows,
  buildPanelModel,
  buildPanelRows,
  buildPublishedState,
  refreshPublishedConversationState,
  dashboardPanelLines,
  dashboardRowsForModel,
  carriedReview,
  latestLatchedState,
  numberPanelSessionRows,
  previewForPanelSelection,
  reconcileStatus,
  registryToPanel,
} from "../src/panel.ts";
import { TheaterNavigation } from "../src/theater-navigation.ts";
import { loadConfig } from "../src/config.ts";
import { buildDaemonPublishedState } from "../src/daemon.ts";
import {
  clearReadingProgress,
  configureRenderer,
  getLiveState,
  setReadingProgress,
  setState,
  setTranscriptPrefix,
} from "../src/status.ts";

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
      live: {
        state: "speaking",
        label: "Need",
        partial: "live dictation",
        transcriptPrefix: "committed words",
        reading: { text: "Reply being read aloud", spokenChars: 8 },
      },
      mode: { muted: false, paused: true, holding: 2 },
      activeSessionId: "needs",
      navSelectedId: "waiting",
      reply: { sessionId: "needs", text: "Reply being read aloud", spokenChars: 8 },
    });
    model.preview = {
      sessionId: "waiting",
      text: "Parked session preview",
      spokenChars: 0,
    };

    const published = buildPublishedState(
      model,
      new Map([
        ["needs", "Need: latest reply"],
        ["wrong-session", "must not attach"],
      ]),
      new Set(["dismissed-session"]),
      1_234_567,
      {
        transcriptPathForSessionId: (sessionId) => sessionId === "needs"
          ? "/transcripts/needs.jsonl"
          : undefined,
        // These are already-resolved effective voices; no explicit pin is needed.
        voiceForLabel: (label) => label === "Need" ? "af_heart" : "am_adam",
        labelForSessionId: (sessionId) => sessionId === "dismissed-session"
          ? "Dismissed"
          : undefined,
        prioritizedSessionIds: new Set(["needs"]),
      },
    );

    expect(published).toEqual({
      v: 1,
      ts: 1_234_567,
      mode: { muted: false, paused: true, holding: 2 },
      live: {
        state: "speaking",
        label: "Need",
        partial: "live dictation",
        transcriptPrefix: "committed words",
        reading: { text: "Reply being read aloud", spokenChars: 8 },
      },
      reply: { sessionId: "needs", text: "Reply being read aloud", spokenChars: 8 },
      preview: {
        sessionId: "waiting",
        text: "Parked session preview",
        spokenChars: 0,
      },
      rows: [
        {
          id: "needs",
          at: 40,
          label: "Need",
          status: "needs",
          transcriptPath: "/transcripts/needs.jsonl",
          voice: "af_heart",
          prioritized: true,
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
          at: 30,
          label: "Wait",
          status: "waiting",
          voice: "am_adam",
          navSelected: true,
          needsResponse: false,
          paused: false,
          muted: false,
          live: null,
          active: false,
        },
      ],
      dismissed: ["dismissed-session"],
      dismissedRows: [{ id: "dismissed-session", label: "Dismissed" }],
    });
    expect(published.rows.some((row) => row.id === "dismissed-session")).toBe(false);
    expect("snippet" in published.rows[1]!).toBe(false);
    expect(JSON.parse(JSON.stringify(published))).toEqual(published);
  });

  test("omits unresolved voices and false priority/navigation flags", () => {
    const model = buildPanelModel({
      sessions: [{ sessionId: "plain", name: "Plain", status: "idle" }],
      sessionStates: new Map(),
      pausedSessionIds: new Set(),
      mutedSessionIds: new Set(),
      live: { state: "idle", label: "", partial: "" },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
    });

    const published = buildPublishedState(
      model,
      new Map(),
      new Set(),
      10,
      {
        voiceForLabel: () => "   ",
        prioritizedSessionIds: new Set(),
      },
    );

    expect(published.rows[0]).not.toHaveProperty("voice");
    expect(published.rows[0]).not.toHaveProperty("transcriptPath");
    expect(published.rows[0]).not.toHaveProperty("prioritized");
    expect(published.rows[0]).not.toHaveProperty("navSelected");
  });

  test("omits absent conversation fields", () => {
    const model = buildPanelModel({
      sessions: [],
      sessionStates: new Map(),
      pausedSessionIds: new Set(),
      mutedSessionIds: new Set(),
      live: { state: "idle", label: "", partial: "" },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
      reply: null,
    });
    model.preview = null;

    const published = buildPublishedState(model, new Map(), new Set(), 10);

    expect(published.live).toEqual({ state: "idle", label: "" });
    expect("partial" in published.live).toBe(false);
    expect("transcriptPrefix" in published.live).toBe(false);
    expect("reading" in published.live).toBe(false);
    expect("reply" in published).toBe(false);
    expect("preview" in published).toBe(false);
  });

  test("a non-theater renderer still produces the complete published conversation", () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "conch-published-transcripts-"));
    const projectDir = join(claudeDir, "projects", "fixture");
    mkdirSync(projectDir, { recursive: true });
    const activeTranscriptPath = join(projectDir, "active.jsonl");
    const parkedTranscriptPath = join(projectDir, "parked.jsonl");
    writeFileSync(activeTranscriptPath, "");
    writeFileSync(parkedTranscriptPath, "");
    const selection = configureRenderer(
      { CONCH_TUI: "footer" },
      {
        stdoutTTY: false,
        stdinTTY: false,
        columns: () => 100,
        rows: () => 24,
        write: () => {},
        print: () => {},
      },
    );
    expect(selection.kind).toBe("footer");

    try {
      setTranscriptPrefix("committed words");
      setState("speaking", "Active", "live words");
      setReadingProgress("Assistant reply", 9);
      const live = getLiveState();
      const model = buildPanelModel({
        sessions: [
          { sessionId: "active", name: "Active", status: "busy" },
          { sessionId: "parked", name: "Parked", status: "idle" },
        ],
        sessionStates: new Map(),
        pausedSessionIds: new Set(),
        mutedSessionIds: new Set(),
        live,
        mode: { muted: false, paused: false, holding: 0 },
        activeSessionId: "active",
        navSelectedId: "parked",
        reply: {
          sessionId: "active",
          text: live.reading!.text,
          spokenChars: live.reading!.spokenChars,
        },
      });
      model.preview = previewForPanelSelection(
        "parked",
        "parked",
        "Parked output",
      );

      const published = buildDaemonPublishedState(
        loadConfig({ env: { CLAUDE_CONFIG_DIR: claudeDir } }),
        model,
        new Map(),
        new Set(),
        new Set(["parked"]),
        20,
      );
      expect(published.live).toEqual({
        state: "speaking",
        label: "Active",
        partial: "live words",
        transcriptPrefix: "committed words",
        reading: { text: "Assistant reply", spokenChars: 9 },
      });
      expect(published.reply).toEqual({
        sessionId: "active",
        text: "Assistant reply",
        spokenChars: 9,
      });
      expect(published.preview).toEqual({
        sessionId: "parked",
        text: "Parked output",
        spokenChars: 0,
      });
      expect(published.rows.find((row) => row.id === "parked")).toMatchObject({
        transcriptPath: parkedTranscriptPath,
        voice: expect.any(String),
        prioritized: true,
        navSelected: true,
      });
      expect(published.rows.find((row) => row.id === "active")).toMatchObject({
        transcriptPath: activeTranscriptPath,
      });
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
      setTranscriptPrefix("");
      clearReadingProgress();
      setState("idle");
    }
  });

  test("caps large published replies at the end and rebases spoken progress", () => {
    const discarded = "discarded-prefix";
    const retained = "x".repeat(4_000);
    const text = discarded + retained;
    const model = buildPanelModel({
      sessions: [],
      sessionStates: new Map(),
      pausedSessionIds: new Set(),
      mutedSessionIds: new Set(),
      live: {
        state: "speaking",
        label: "Long",
        partial: "",
        reading: { text, spokenChars: discarded.length + 125 },
      },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
      reply: {
        sessionId: "long",
        text,
        spokenChars: discarded.length + 250,
      },
    });
    model.preview = { sessionId: "parked", text, spokenChars: text.length };

    const published = buildPublishedState(model, new Map(), new Set(), 10);

    // The reading text is capped by the same function, so it carries the same
    // flag — a viewer tracking reading progress is looking at a tail too.
    expect(published.live.reading).toEqual({
      text: retained,
      spokenChars: 125,
      truncated: true,
    });
    // The flag is the point: this keeps the TAIL, so a client holding the
    // result cannot tell a truncated long reply from a complete short one by
    // looking. The phone showed people the middle of an answer for weeks.
    expect(published.reply).toEqual({
      sessionId: "long",
      text: retained,
      spokenChars: 250,
      truncated: true,
    });
    expect(published.preview).toEqual({
      sessionId: "parked",
      text: retained,
      spokenChars: retained.length,
      truncated: true,
    });
  });

  test("a reply that fits is not marked truncated", () => {
    // Otherwise the phone refetches every short reply over the relay for
    // nothing, and "truncated" stops meaning anything.
    const model = buildPanelModel({
      sessions: [],
      sessionStates: new Map(),
      pausedSessionIds: new Set(),
      mutedSessionIds: new Set(),
      live: { state: "idle", label: "", partial: "" },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
      reply: { sessionId: "short", text: "all of it", spokenChars: 9 },
    });
    const published = buildPublishedState(model, new Map(), new Set(), 10);
    expect(published.reply).toEqual({
      sessionId: "short",
      text: "all of it",
      spokenChars: 9,
    });
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
});

describe("review attribute reconciliation", () => {
  function reviewRow(registryStatus: string, statusUpdatedAt: number) {
    return buildPanelRows({
      sessions: [{
        sessionId: "review",
        name: "Review",
        status: registryStatus,
        statusUpdatedAt,
      }],
      sessionStates: new Map([
        ["review", {
          label: "Review",
          status: "waiting" as const,
          at: 2_000,
          review: { summary: "Ready to inspect" },
        }],
      ]),
      pausedSessionIds: new Set(),
      mutedSessionIds: new Set(),
      live: { state: "idle", label: "", partial: "" },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
    })[0]!;
  }

  test("a review attribute survives a newer idle registry refresh", () => {
    expect(reviewRow("idle", 3_000)).toMatchObject({
      status: "waiting",
      at: 3_000,
      detail: "Ready to inspect",
      review: { summary: "Ready to inspect", at: 2_000 },
    });
  });

  test("a newer busy registry suppresses the stale review attribute", () => {
    const row = reviewRow("busy", 3_000);
    expect(row.status).toBe("working");
    expect(row.review).toBeUndefined();
  });

  test("an equal-timestamp review latch wins the boundary tie", () => {
    expect(reviewRow("busy", 2_000)).toMatchObject({
      status: "waiting",
      at: 2_000,
      review: { summary: "Ready to inspect", at: 2_000 },
    });
  });
});

test("a review keeps its natural waiting position — the marker doesn't reorder the dashboard", () => {
  const rows = buildPanelRows({
    sessions: [
      { sessionId: "working", name: "Working", status: "busy", statusUpdatedAt: 10 },
      { sessionId: "waiting", name: "Alpha waiting", status: "idle", statusUpdatedAt: 10 },
      { sessionId: "needs", name: "Needs", status: "waiting", statusUpdatedAt: 10 },
      { sessionId: "review", name: "Zulu review", status: "idle", statusUpdatedAt: 10 },
    ],
    sessionStates: new Map([
      ["review", {
        label: "Zulu review",
        status: "waiting",
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
    "waiting",
    "review",
    "working",
  ]);
  expect(rows.find((row) => row.sessionId === "review")).toMatchObject({
    status: "waiting",
    review: { summary: "Ready to inspect", at: 20 },
  });
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
        status: "waiting",
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
    status: "waiting",
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
        status: "waiting",
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
    expect(previewForPanelSelection("b", "a", "A's latest output")).toBeNull();
    expect(previewForPanelSelection("b", "b", "B's latest output")).toEqual({
      sessionId: "b",
      text: "B's latest output",
      spokenChars: 0,
    });
  });

  test("selection owns the pane even for the active session or an empty reply", () => {
    expect(previewForPanelSelection("b", "b", "live output")).toEqual({
      sessionId: "b",
      text: "live output",
      spokenChars: 0,
    });
    expect(previewForPanelSelection("b", "b", "")).toEqual({
      sessionId: "b",
      text: "",
      spokenChars: 0,
    });
    expect(previewForPanelSelection(null, "b", "output")).toBeNull();
  });

  test("daemon captures the requested id before await and commits through the guard", async () => {
    const source = await Bun.file(new URL("../src/daemon.ts", import.meta.url)).text();
    const render = source.slice(
      source.indexOf("async function renderSessionPanel"),
      source.indexOf("function setSessionState"),
    );
    expect(render).toContain(
      `const previewId = theaterNavigation.manualSelectedId
      ?? (cursorAuto ? null : selectedId)`,
    );
    expect(render.slice(
      render.indexOf("const previewId"),
      render.indexOf("const previewPath"),
    )).not.toContain("theaterMode");
    expect(render).toContain(
      `const previewPath = previewId
      ? findTranscript(cfg.claudeDir, previewId)
      : undefined`,
    );
    expect(render).toContain(
      `model.preview = previewForPanelSelection(
        navSelectedId,
        previewId,
        previewText,
        previewRaw,
      )`,
    );
    expect(render).toContain(
      "theaterNavigation.reconcile(new Set(live.map((session) => session.sessionId)))",
    );
    expect(render.indexOf("const previewId")).toBeLessThan(
      render.indexOf("await Promise.all"),
    );
    expect(render.indexOf("model.preview = previewForPanelSelection(")).toBeGreaterThan(
      render.indexOf("const navSelectedId = theaterNavigation.manualSelectedId"),
    );
    expect(render.indexOf("model.preview = previewForPanelSelection(")).toBeGreaterThan(
      render.indexOf("commitLatestPanelRender("),
    );
  });

  test("refreshes live conversation fields without rebuilding the ledger", () => {
    const model = buildPanelModel({
      sessions: [{ sessionId: "active", name: "Active" }],
      sessionStates: new Map(),
      pausedSessionIds: new Set(),
      mutedSessionIds: new Set(),
      live: { state: "speaking", label: "Active", partial: "" },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: "active",
      navSelectedId: null,
      reply: { sessionId: "active", text: "Earlier reply", spokenChars: 0 },
    });
    model.preview = { sessionId: "parked", text: "Parked preview", spokenChars: 0 };
    const initial = buildPublishedState(model, new Map(), new Set(), 10);

    const progressed = refreshPublishedConversationState(
      initial,
      {
        state: "recording",
        label: "Active",
        partial: "words arriving",
        transcriptPrefix: "already committed",
        reading: { text: "Current reply", spokenChars: 7 },
      },
      "active",
      11,
    );

    expect(progressed.ts).toBe(11);
    expect(progressed.live).toEqual({
      state: "recording",
      label: "Active",
      partial: "words arriving",
      transcriptPrefix: "already committed",
      reading: { text: "Current reply", spokenChars: 7 },
    });
    expect(progressed.reply).toEqual({
      sessionId: "active",
      text: "Current reply",
      spokenChars: 7,
    });
    expect(progressed.rows).toBe(initial.rows);
    expect(progressed.preview).toEqual(initial.preview);

    const betweenChunks = refreshPublishedConversationState(
      progressed,
      { state: "listening", label: "Active", partial: "" },
      "active",
      12,
    );
    expect(betweenChunks.reply).toEqual(progressed.reply);

    const switched = refreshPublishedConversationState(
      betweenChunks,
      { state: "speaking", label: "Other", partial: "" },
      "other",
      13,
    );
    expect("reply" in switched).toBe(false);
  });

});

describe("a review outlives the turn that produced it", () => {
  // `review_to_front` defaults `session` to the caller and REFUSES to name a
  // sibling, so surfacing your own work is the only supported use of the tool.
  // But the caller's own Stop hook then lands a review-less `turn-end`, and the
  // latch replaced the whole record — so every self-issued review was erased
  // within a second of being filed. The plugin documented the marker as the
  // workaround; this makes the tool actually work.
  const review = { summary: "the landing page is ready", link: "https://x.test" };
  const latched = { label: "conch", status: "waiting" as const, at: 1, review };

  test("a review-less turn-end does not erase a just-filed review", () => {
    expect(carriedReview(latched, "waiting", undefined)).toEqual(review);
  });

  test("a needs-you notification does not erase it either", () => {
    expect(carriedReview(latched, "needs", undefined)).toEqual(review);
  });

  test("starting a new turn clears it", () => {
    expect(carriedReview(latched, "working", undefined)).toBeUndefined();
  });

  test("a newer review replaces the old one rather than being ignored", () => {
    const next = { summary: "second deliverable" };
    expect(carriedReview(latched, "waiting", next)).toEqual(next);
    expect(carriedReview(latched, "working", next)).toEqual(next);
  });

  test("a session that never had one stays without one", () => {
    expect(carriedReview(undefined, "waiting", undefined)).toBeUndefined();
  });
});
