import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { DictationReducer } from "../src/dictation-reducer.ts";
import {
  clearReadingProgress,
  configureRenderer,
  createFooterRenderer,
  createTheaterRenderer,
  getLiveState,
  installRendererLifecycle,
  onLiveDataChange,
  relativeAge,
  scrollTheaterPane,
  setReadingProgress,
  setLogsVisible,
  setState,
  setTranscriptPrefix,
  shouldDispatchTerminalInput,
  shouldUseTheater,
  terminalCellWidth,
  theaterStatusHeader,
  theaterPointerEvent,
  type LiveState,
  type RendererIO,
} from "../src/status.ts";
import {
  type PanelModel,
} from "../src/panel.ts";

const ACTIVE_FOOTER_GOLDEN = "\n"
  + "  \x1b[1m🐚 conch\x1b[0m\n"
  + "\n"
  + "  \x1b[2m────────────────────────────────────────────────────────────────────────────\x1b[0m\n"
  + "  project-one                \x1b[33m▶ speaking\x1b[0m\n";

const PAUSED_FOOTER_GOLDEN = "\n"
  + "  \x1b[1m🐚 conch\x1b[0m\n"
  + "  \x1b[1;35m⏸ PAUSED · holding 2 · no parked cursor: p to resume\x1b[0m\n"
  + "  \x1b[2m────────────────────────────────────────────────────────────────────────────\x1b[0m\n"
  + "\x1b[36m▸\x1b[0m alpha                      \x1b[33m❗ needs a response\x1b[0m \x1b[2m(permission)\x1b[0m\n"
  + "  \x1b[2mbeta                       ⏸ paused\x1b[0m\n"
  + "  \x1b[2mgamma                      🔇 muted\x1b[0m\n";

function sampleModel(overrides: Partial<PanelModel> = {}): PanelModel {
  return {
    rows: [
      {
        sessionId: "one",
        label: "project-one",
        status: "waiting",
        paused: false,
        muted: false,
        liveGlyph: "speaking",
        active: true,
        navSelected: false,
      },
    ],
    mode: { muted: false, paused: false, holding: 0 },
    live: { state: "speaking", label: "project-one", partial: "" },
    reply: { sessionId: "one", text: "A response long enough to exercise the content pane.", spokenChars: 11 },
    panelOpen: true,
    ...overrides,
  };
}

function recordingIO(options: { columns?: number; rows?: number; tty?: boolean } = {}) {
  const writes: string[] = [];
  const prints: string[] = [];
  const copies: string[] = [];
  const io: RendererIO = {
    stdoutTTY: options.tty ?? true,
    stdinTTY: options.tty ?? true,
    columns: () => options.columns ?? 80,
    rows: () => options.rows ?? 8,
    write: (text) => writes.push(text),
    print: (line) => prints.push(line),
    copy: (text) => {
      copies.push(text);
    },
  };
  return { io, writes, prints, copies };
}

describe("theater status formatting", () => {
  test("relativeAge formats minute, hour, and day boundaries", () => {
    const now = 10 * 24 * 60 * 60 * 1_000;
    const cases: Array<[number, string]> = [
      [now + 1_000, "<1m"],
      [now, "<1m"],
      [now - 59_999, "<1m"],
      [now - 60_000, "1m"],
      [now - (59 * 60_000 + 59_999), "59m"],
      [now - 60 * 60_000, "1h"],
      [now - (23 * 60 * 60_000 + 59 * 60_000), "23h"],
      [now - 24 * 60 * 60_000, "1d"],
      [now - 49 * 60 * 60_000, "2d"],
    ];

    for (const [at, expected] of cases) {
      expect(relativeAge(at, now)).toBe(expected);
    }
  });

  test("builds one live header from existing status glyphs and omits zeroes", () => {
    const statuses = [
      "needs",
      "needs",
      "waiting",
      "waiting",
      "waiting",
      "working",
    ] as const;
    const rows: PanelModel["rows"] = statuses.map((status, index) => ({
      sessionId: `session-${index}`,
      label: `session-${index}`,
      status,
      paused: false,
      muted: false,
      liveGlyph: null,
      active: false,
      navSelected: false,
    }));
    rows.splice(2, 0, {
      sessionId: "review",
      label: "review",
      status: "waiting",
      review: { summary: "Ready to inspect", at: 1 },
      paused: false,
      muted: false,
      liveGlyph: null,
      active: false,
      navSelected: false,
    });
    const header = theaterStatusHeader(sampleModel({
      rows,
      live: { state: "speaking", label: "dayloop", partial: "" },
    }));
    const plain = header.replace(/\x1b\[[0-9;]*m/g, "");

    expect(plain).toBe(
      "  conch · ❗ 2 need you · ○ 4 waiting · ⭐1 to look at · ● 1 working · speaking ‹dayloop›",
    );
    expect(header).toContain("\x1b[91m❗\x1b[39m"); // needs is now red — it outranks waiting
    expect(header).toContain("\x1b[33m⭐\x1b[39m");
    expect(header).toContain("\x1b[33m○\x1b[39m"); // waiting is now yellow — a finished turn is sitting on you
    expect(header).toContain("\x1b[36m●\x1b[39m");
    expect(header).not.toContain("\n");

    const idle = theaterStatusHeader(sampleModel({
      rows: [rows[2]!],
      live: { state: "idle", label: "", partial: "" },
    })).replace(/\x1b\[[0-9;]*m/g, "");
    expect(idle).toBe("  conch · ○ 1 waiting · ⭐1 to look at");
    expect(idle).not.toContain("0 ");
    expect(idle).not.toContain("‹");

    const quiet = theaterStatusHeader(sampleModel({
      rows: [],
      mode: { muted: true, paused: true, holding: 2 },
      live: { state: "muted", label: "", partial: "" },
    })).replace(/\x1b\[[0-9;]*m/g, "");
    expect(quiet).toBe("  conch · muted · paused · holding 2");
    expect(quiet.match(/muted/g)).toHaveLength(1);
    expect(quiet.match(/paused/g)).toHaveLength(1);
    expect(quiet.match(/holding 2/g)).toHaveLength(1);
  });
});

describe("footer renderer seam", () => {
  test("matches the frozen active footer bytes", () => {
    const { io, writes } = recordingIO({ columns: 80 });
    createFooterRenderer(io).panel(sampleModel());

    expect(writes).toEqual([ACTIVE_FOOTER_GOLDEN]);
  });

  test("matches frozen paused, muted, selected, and detailed footer bytes", () => {
    const { io, writes } = recordingIO({ columns: 80 });
    createFooterRenderer(io).panel(sampleModel({
      rows: [
        {
          sessionId: "need",
          label: "alpha",
          status: "needs",
          detail: "permission",
          paused: false,
          muted: false,
          liveGlyph: null,
          active: false,
          navSelected: true,
        },
        {
          sessionId: "sleep",
          label: "beta",
          status: "working",
          paused: true,
          muted: false,
          liveGlyph: null,
          active: false,
          navSelected: false,
        },
        {
          sessionId: "quiet",
          label: "gamma",
          status: "waiting",
          paused: true,
          muted: true,
          liveGlyph: null,
          active: false,
          navSelected: false,
        },
      ],
      mode: { muted: false, paused: true, holding: 2 },
      live: { state: "paused", label: "", partial: "" },
      reply: null,
    }));

    expect(writes).toEqual([PAUSED_FOOTER_GOLDEN]);
    expect(writes.join("").toLowerCase()).not.toContain("snooz");
  });

  test("keeps the legacy 80-column dashboard fallback separate from line fitting", () => {
    const { io, writes } = recordingIO({ columns: 100 });
    io.dashboardColumns = () => 80;
    createFooterRenderer(io).panel(sampleModel());

    expect(writes).toEqual([ACTIVE_FOOTER_GOLDEN]);
  });

  test("ignores the theater-only transcript prefix byte-for-byte", () => {
    const render = (live: LiveState): string => {
      const { io, writes } = recordingIO({ columns: 80 });
      const renderer = createFooterRenderer(io);
      renderer.panel(sampleModel({ live }));
      renderer.live(live);
      return writes.join("");
    };
    const current = { state: "recording", label: "project-one", partial: "current words" } as const;

    expect(render({ ...current, transcriptPrefix: "prior kept segment" })).toBe(render(current));
  });

  test("ignores a theater-only parked preview byte-for-byte", () => {
    const { io, writes } = recordingIO({ columns: 80 });
    createFooterRenderer(io).panel(sampleModel({
      preview: {
        sessionId: "parked",
        text: "footer must never render this",
        spokenChars: 0,
      },
    }));

    expect(writes).toEqual([ACTIVE_FOOTER_GOLDEN]);
  });

  test("ignores the theater-only session actions overlay byte-for-byte", () => {
    const { io, writes } = recordingIO({ columns: 80 });
    createFooterRenderer(io).panel(sampleModel({
      sessionActionsOverlay: {
        target: { sessionId: "one", label: "project-one" },
        selectedIndex: 0,
        rows: [{
          key: "voice",
          value: "Nova",
          help: "preview voice",
          selected: true,
          editing: false,
        }],
      },
    }));

    expect(writes).toEqual([ACTIVE_FOOTER_GOLDEN]);
  });
});

describe("theater renderer lifecycle", () => {
  test("enters and restores alt-screen exactly once", () => {
    const { io, writes } = recordingIO();
    const renderer = createTheaterRenderer(io);

    renderer.enter();
    renderer.enter();
    renderer.shutdown();
    renderer.shutdown();

    expect(writes).toEqual([
      "\x1b[?1049h\x1b[?25l",
      "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h",
      "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l",
      "\x1b[?1049l\x1b[?25h",
    ]);
  });

  test("CONCH_NO_MOUSE leaves lifecycle bytes and interaction entry points inert", () => {
    const dimensions = { columns: 72, rows: 7 };
    const { io, writes, copies } = recordingIO(dimensions);
    const configured = configureRenderer({ CONCH_NO_MOUSE: "1" }, io);
    const renderer = configured.renderer;
    try {
      expect(configured.kind).toBe("theater");
      renderer.enter();
      renderer.panel(sampleModel({
        live: { state: "idle", label: "", partial: "" },
        reply: {
          sessionId: "one",
          text: `${"first ".repeat(40)}last`,
          spokenChars: 0,
        },
      }));
      const frame = writes.at(-1)!;

      renderer.scrollPane?.(100);
      renderer.pointerEvent?.({ kind: "down", button: 0, column: 26, row: 3 });
      scrollTheaterPane(100);
      theaterPointerEvent({ kind: "drag", button: 0, column: 34, row: 3 });
      theaterPointerEvent({ kind: "up", button: 0, column: 34, row: 3 });
      renderer.shutdown();

      expect(writes.join("")).not.toMatch(/\x1b\[\?100[0236][hl]/);
      expect(writes).toEqual([
        "\x1b[?1049h\x1b[?25l",
        frame,
        "\x1b[?1049l\x1b[?25h",
      ]);
      expect(copies).toEqual([]);
    } finally {
      renderer.shutdown();
      configureRenderer({ CONCH_TUI: "footer" }, recordingIO().io);
    }
  });

  test("full frames cannot scroll by construction", () => {
    const { io, writes } = recordingIO({ columns: 64, rows: 7 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    renderer.panel(sampleModel({
      live: { state: "recording", label: "project-one", partial: "x".repeat(200) },
    }));

    const frame = writes.at(-1)!;
    expect(frame.startsWith("\x1b[H")).toBe(true);
    expect(frame).not.toContain("▶");
    expect(frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").match(/recording/g)).toHaveLength(1);
    expect(frame.match(/\x1b\[K/g)).toHaveLength(7);
    expect(frame.match(/\n/g)).toHaveLength(6);
    expect(frame.endsWith("\n")).toBe(false);
  });

  test("global quiet mode appears once in the top line, never beside the keybar", () => {
    const { io, writes } = recordingIO({ columns: 80, rows: 7 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    renderer.keybar("  keys");
    renderer.panel(sampleModel({
      rows: [],
      mode: { muted: false, paused: true, holding: 3 },
      live: { state: "paused", label: "", partial: "" },
      reply: null,
    }));

    const plain = writes.at(-1)!.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    expect(plain.match(/paused/g)).toHaveLength(1);
    expect(plain.match(/holding 3/g)).toHaveLength(1);
    expect(plain).not.toContain("⏸");
    expect(plain.split("\n").at(-1)).toContain("keys");
  });

  test("the top line is the only live-activity indicator", () => {
    const { io, writes } = recordingIO({ columns: 80, rows: 7 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    renderer.panel(sampleModel({ panelOpen: false }));

    const plain = writes.at(-1)!.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    expect(plain.match(/speaking/g)).toHaveLength(1);
    expect(plain).toContain("waiting for you");
    expect(plain).not.toContain("▶");
  });

  test("collapsed frames use the full-width status-word ledger", () => {
    const { io, writes } = recordingIO({ columns: 80, rows: 7 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    renderer.panel(sampleModel({
      panelOpen: false,
      live: { state: "idle", label: "", partial: "" },
      rows: [{
        sessionId: "one",
        label: "project-one",
        status: "needs",
        paused: false,
        muted: false,
        liveGlyph: null,
        active: false,
        navSelected: false,
      }, {
        sessionId: "review",
        label: "review-project",
        status: "waiting",
        review: { summary: "PR ready to inspect", at: 20 },
        paused: false,
        muted: false,
        liveGlyph: null,
        active: false,
        navSelected: false,
      }],
    }));

    const frame = writes.at(-1)!;
    expect(frame).toContain("needs a response");
    expect(frame).toContain("⭐ needs review");
    expect(frame).toContain("(PR ready to inspect)");
    expect(frame).not.toContain("│");
    expect(frame).not.toContain("…");
  });

  test("default ledger omits shortcut indices while keeping review text and right-aligned ages", () => {
    const now = Date.now();
    const { io, writes } = recordingIO({ columns: 120, rows: 8 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    renderer.panel(sampleModel({
      panelOpen: true,
      live: { state: "idle", label: "", partial: "" },
      reply: null,
      rows: [
        {
          sessionId: "needs",
          label: "zulu-needs",
          status: "needs",
          at: now - 17 * 60_000 - 5_000,
          detail: "permission prompt",
          paused: false,
          muted: false,
          liveGlyph: null,
          active: false,
          navSelected: false,
        },
        {
          sessionId: "review",
          label: "beta-review",
          status: "waiting",
          at: now - 30_000,
          review: {
            summary: "Review the terminal dashboard deliverable",
            at: now - 2 * 60_000 - 5_000,
          },
          paused: false,
          muted: false,
          liveGlyph: null,
          active: false,
          navSelected: false,
        },
        {
          sessionId: "waiting",
          label: "alpha-waiting",
          status: "waiting",
          at: now - 65 * 60_000,
          paused: false,
          muted: false,
          liveGlyph: null,
          active: false,
          navSelected: false,
        },
        {
          sessionId: "working",
          label: "delta-working",
          status: "working",
          at: now - 49 * 60 * 60_000,
          paused: false,
          muted: false,
          liveGlyph: null,
          active: false,
          navSelected: false,
        },
      ],
    }));

    const frame = writes.at(-1)!;
    const plainLines = frame
      .replace(/^\x1b\[H/, "")
      .split("\n")
      .map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
    const needs = plainLines.find((line) => line.includes("zulu"))!;
    const review = plainLines.find((line) => line.includes("beta"))!;
    const waiting = plainLines.find((line) => line.includes("alpha"))!;
    const working = plainLines.find((line) => line.includes("delta"))!;

    expect(needs).not.toMatch(/\b1\s+zulu/);
    expect(review).not.toMatch(/\b2\s+beta/);
    expect(waiting).not.toMatch(/\b3\s+alpha/);
    expect(working).not.toMatch(/\b4\s+delta/);
    expect(review).toContain("⭐");
    expect(review).toContain("Review the");
    expect(review).toContain("…");
    expect(review).not.toContain("Review the terminal dashboard deliverable");
    expect(needs).toMatch(/17m\s+│/);
    expect(review).toMatch(/2m\s+│/);
    expect(waiting).toMatch(/1h\s+│/);
    expect(working).toMatch(/2d\s+│/);
    expect(frame).toContain("\x1b[2m2m\x1b[22m");
    expect(plainLines[0]).toContain(
      "conch · ❗ 1 need you · ○ 2 waiting · ⭐1 to look at · ● 1 working",
    );
    expect(plainLines[0]).not.toContain("🐚");
    expect(plainLines.every((line) => terminalCellWidth(line) <= 119)).toBe(true);
  });

  test("quiet session rows show mute ahead of pause without legacy snooze wording", () => {
    const { io, writes } = recordingIO({ columns: 80, rows: 7 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    renderer.panel(sampleModel({
      panelOpen: false,
      live: { state: "idle", label: "", partial: "" },
      rows: [
        {
          sessionId: "paused",
          label: "paused-only",
          status: "waiting",
          paused: true,
          muted: false,
          liveGlyph: null,
          active: false,
          navSelected: false,
        },
        {
          sessionId: "muted",
          label: "muted-and-paused",
          status: "needs",
          paused: true,
          muted: true,
          liveGlyph: "speaking",
          active: true,
          navSelected: false,
        },
      ],
    }));

    const frame = writes.at(-1)!;
    const plain = frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const mutedLine = plain.split("\n").find((line) => line.includes("muted-and-paused"));
    expect(plain).toContain("⏸ paused");
    expect(mutedLine).toContain("🔇 muted");
    expect(mutedLine).not.toContain("⏸ paused");
    expect(plain.toLowerCase()).not.toContain("snooz");
  });

  test("settings temporarily opens a collapsed content pane", () => {
    const { io, writes } = recordingIO({ columns: 80, rows: 10 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    renderer.panel(sampleModel({
      panelOpen: false,
      settingsOverlay: {
        selectedIndex: 0,
        rows: [{
          key: "end-silence",
          value: "3.5",
          source: "default",
          help: "pause that ends an utterance",
          selected: true,
          editing: false,
        }],
      },
    }));

    const frame = writes.at(-1)!;
    expect(frame).toContain("settings");
    expect(frame).toContain("end-silence");
    expect(frame).toContain("│");
  });

  test("a narrow settings overlay remains visible and explains how to close it", () => {
    const { io, writes } = recordingIO({ columns: 30, rows: 6 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    renderer.panel(sampleModel({
      panelOpen: false,
      settingsOverlay: {
        selectedIndex: 0,
        rows: [{
          key: "end-silence",
          value: "3.5",
          source: "default",
          help: "pause that ends an utterance",
          selected: true,
          editing: false,
        }],
      },
    }));

    const frame = writes.at(-1)!;
    expect(frame).toContain("settings");
    expect(frame).toContain("esc close");
  });

  test("session actions temporarily open the pane and render the captured target and safe dismiss copy", () => {
    const { io, writes } = recordingIO({ columns: 140, rows: 10 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    renderer.panel(sampleModel({
      panelOpen: false,
      sessionActionsOverlay: {
        target: { sessionId: "parked", label: "Parked Project" },
        selectedIndex: 3,
        rows: [
          {
            key: "voice",
            value: "Nova",
            help: "←/→ preview · enter pin · a reset to auto",
            selected: false,
            editing: false,
          },
          {
            key: "prioritize",
            value: "off",
            help: "← off · → on · space/enter toggle hand-off priority",
            selected: false,
            editing: false,
          },
          {
            key: "rename",
            value: "Parked Project",
            help: "enter edit/commit · esc cancel",
            selected: false,
            editing: false,
          },
          {
            key: "dismiss",
            value: "CONFIRM",
            help: "enter twice · stops announcements; session keeps running",
            selected: true,
            editing: false,
            confirming: true,
          },
        ],
      },
    }));

    const frame = writes.at(-1)!;
    expect(frame).toContain("actions");
    expect(frame).toContain("Parked Project");
    expect(frame).toContain("voice");
    expect(frame).toContain("prioritize");
    expect(frame).toContain("rename");
    expect(frame).toContain("dismiss");
    expect(frame).toContain("session keeps running");
    expect(frame).toContain("│");
  });

  test("a narrow session actions overlay remains visible and explains how to close it", () => {
    const { io, writes } = recordingIO({ columns: 30, rows: 6 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    renderer.panel(sampleModel({
      panelOpen: false,
      sessionActionsOverlay: {
        target: { sessionId: "parked", label: "Parked Project" },
        selectedIndex: 0,
        rows: [{
          key: "voice",
          value: "Nova",
          help: "preview voice",
          selected: true,
          editing: false,
        }],
      },
    }));

    const frame = writes.at(-1)!;
    expect(frame).toContain("actions");
    expect(frame).toContain("esc close");
  });

  test("wide labels stay within frame cells and cannot move the ledger seam", () => {
    const { io, writes } = recordingIO({ columns: 64, rows: 7 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    renderer.panel(sampleModel({
      rows: [{
        sessionId: "wide",
        label: `漢字漢字漢字漢字漢字漢字漢字\x1b]2;unsafe\u0007`,
        status: "working",
        paused: false,
        muted: false,
        liveGlyph: "recording",
        active: true,
        navSelected: false,
      }],
      live: { state: "recording", label: "wide", partial: "hello" },
    }));

    const frame = writes.at(-1)!;
    const lines = frame
      .replace(/^\x1b\[H/, "")
      .split("\n")
      .map((line) => line.replace(/\x1b\[K$/, ""));
    expect(lines.every((line) => terminalCellWidth(line) <= 63)).toBe(true);
    expect(frame).not.toContain("\x1b]");
    expect(frame).toContain("●");
  });

  test("ledger and content viewports follow the manual cursor and its latest reply", () => {
    const { io, writes } = recordingIO({ columns: 72, rows: 7 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    const rows = Array.from({ length: 10 }, (_, index) => ({
      sessionId: `row-${index}`,
      label: index === 8 ? "manual-eight" : `row-${index}`,
      status: "working" as const,
      paused: false,
      muted: false,
      liveGlyph: index === 0 ? "recording" as const : null,
      active: index === 0,
      navSelected: index === 8,
    }));
    renderer.panel(sampleModel({
      rows,
      preview: {
        sessionId: "row-8",
        text: "selected-session-latest-reply",
        spokenChars: 0,
      },
      live: {
        state: "recording",
        label: "row-0",
        partial: `${"older words ".repeat(30)}latest-tail`,
      },
    }));

    const frame = writes.at(-1)!;
    const plain = frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const manualLine = plain.split("\n").find((line) => line.includes("manual-eight"))!;
    expect(frame).toContain("manual-eight");
    expect(manualLine).toMatch(/▸\s+manual-eight/);
    expect(manualLine).not.toMatch(/\b9\s+▸/);
    expect(frame).toContain("selected-session-latest-reply");
    expect(frame).not.toContain("latest-tail");
    expect(frame).not.toContain("▌");
  });

  test("wheel offset clamps on resize and resets when the pane source changes", () => {
    const dimensions = { columns: 72, rows: 7 };
    const { io, writes } = recordingIO(dimensions);
    const renderer = createTheaterRenderer(io);
    const longReply = `start-token ${Array.from({ length: 90 }, (_, i) => `word-${i}`).join(" ")} end-token`;
    renderer.enter();
    renderer.panel(sampleModel({
      live: { state: "idle", label: "", partial: "" },
      reply: { sessionId: "one", text: longReply, spokenChars: 0 },
    }));
    expect(writes.at(-1)).toContain("start-token");
    expect(writes.at(-1)).not.toContain("end-token");

    renderer.scrollPane?.(10_000);
    expect(writes.at(-1)).toContain("end-token");
    expect(writes.at(-1)).not.toContain("start-token");

    dimensions.rows = 30;
    renderer.resize();
    expect(writes.at(-1)).toContain("start-token");

    dimensions.rows = 7;
    renderer.resize();
    expect(writes.at(-1)).toContain("start-token");
    expect(writes.at(-1)).not.toContain("end-token");
    renderer.scrollPane?.(10_000);
    expect(writes.at(-1)).toContain("end-token");
    renderer.panel(sampleModel({
      live: { state: "idle", label: "", partial: "" },
      reply: {
        sessionId: "new-session",
        text: `new-source ${"fresh ".repeat(90)}new-tail`,
        spokenChars: 0,
      },
    }));
    expect(writes.at(-1)).toContain("new-source");
    expect(writes.at(-1)).not.toContain("new-tail");
  });

  test("preview targets and log toggles reset stale offsets to their natural edge", () => {
    const { io, writes } = recordingIO({ columns: 72, rows: 7 });
    const renderer = createTheaterRenderer(io);
    const preview = (sessionId: string, head: string, tail: string): PanelModel =>
      sampleModel({
        live: { state: "idle", label: "", partial: "" },
        rows: sampleModel().rows.map((row) => ({
          ...row,
          sessionId,
          label: sessionId,
          liveGlyph: null,
          active: false,
          navSelected: true,
        })),
        preview: {
          sessionId,
          text: `${head} ${"preview ".repeat(90)}${tail}`,
          spokenChars: 0,
        },
      });

    renderer.enter();
    renderer.panel(preview("parked-a", "preview-a-head", "preview-a-tail"));
    renderer.scrollPane?.(10_000);
    expect(writes.at(-1)).toContain("preview-a-tail");

    renderer.panel(preview("parked-b", "preview-b-head", "preview-b-tail"));
    expect(writes.at(-1)).toContain("preview-b-head");
    expect(writes.at(-1)).not.toContain("preview-b-tail");

    renderer.log([
      "oldest-log-token",
      ...Array.from({ length: 12 }, (_, index) => `middle-log-${index}`),
      "newest-log-token",
    ].join("\n"));
    try {
      setLogsVisible(true);
      renderer.resize();
      expect(writes.at(-1)).toContain("newest-log-token");
      expect(writes.at(-1)).not.toContain("oldest-log-token");

      renderer.scrollPane?.(-10_000);
      expect(writes.at(-1)).toContain("oldest-log-token");
      expect(writes.at(-1)).not.toContain("newest-log-token");

      setLogsVisible(false);
      renderer.resize();
      expect(writes.at(-1)).toContain("preview-b-head");
      expect(writes.at(-1)).not.toContain("preview-b-tail");

      setLogsVisible(true);
      renderer.resize();
      expect(writes.at(-1)).toContain("newest-log-token");
      expect(writes.at(-1)).not.toContain("oldest-log-token");
    } finally {
      setLogsVisible(false);
    }
  });

  test("forced logs own a narrow collapsed body so help-style output stays visible", () => {
    const { io, writes } = recordingIO({ columns: 40, rows: 6 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    renderer.panel(sampleModel({
      panelOpen: false,
      live: { state: "idle", label: "", partial: "" },
      reply: null,
    }));
    expect(writes.at(-1)).not.toContain("narrow-help-token");

    try {
      setLogsVisible(true);
      renderer.log("narrow-help-token");
      const frame = writes.at(-1)!;
      expect(frame).toContain("narrow-help-token");
      expect(frame).not.toContain("│");
      expect(frame.match(/\n/g)).toHaveLength(5);
    } finally {
      setLogsVisible(false);
      renderer.resize();
    }
  });

  test("parked selection owns the pane across other live activity", () => {
    const { io, writes } = recordingIO({ columns: 100, rows: 8 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    renderer.panel(sampleModel({
      live: { state: "idle", label: "", partial: "" },
      preview: {
        sessionId: "parked",
        text: "parked-only-output",
        spokenChars: 0,
      },
      rows: [
        ...sampleModel().rows.map((row) => ({ ...row, active: false })),
        {
          sessionId: "parked",
          label: "parked-project",
          status: "waiting",
          paused: false,
          muted: false,
          liveGlyph: null,
          active: false,
          navSelected: true,
        },
      ],
    }));
    expect(writes.at(-1)).toContain("parked-only-output");
    expect(writes.at(-1)).toContain("‹parked-project› · esc back · space talk");

    renderer.panel(sampleModel({
      live: { state: "idle", label: "", partial: "" },
      preview: { sessionId: "parked", text: "", spokenChars: 0 },
      reply: {
        sessionId: "parked",
        text: "same-session-hook-path-reply",
        spokenChars: 0,
      },
      rows: [{
        sessionId: "parked",
        label: "parked-project",
        status: "waiting",
        paused: false,
        muted: false,
        liveGlyph: null,
        active: false,
        navSelected: true,
      }],
    }));
    expect(writes.at(-1)).toContain("same-session-hook-path-reply");

    renderer.panel(sampleModel({
      live: {
        state: "speaking",
        label: "project-one",
        partial: "",
        reading: { text: "other-session-live-output", spokenChars: 0 },
      },
      preview: {
        sessionId: "parked",
        text: "parked-stays-during-other-speech",
        spokenChars: 0,
      },
      rows: [
        ...sampleModel().rows,
        {
          sessionId: "parked",
          label: "parked-project",
          status: "waiting",
          paused: false,
          muted: false,
          liveGlyph: null,
          active: false,
          navSelected: true,
        },
      ],
    }));
    expect(writes.at(-1)).toContain("parked-stays-during-other-speech");
    expect(writes.at(-1)).not.toContain("other-session-live-output");

    renderer.panel(sampleModel({
      live: {
        state: "speaking",
        label: "parked-project",
        partial: "",
        reading: { text: "parked-session-is-live-now", spokenChars: 0 },
      },
      preview: {
        sessionId: "parked",
        text: "stale-parked-preview",
        spokenChars: 0,
      },
      rows: [{
        sessionId: "parked",
        label: "parked-project",
        status: "working",
        paused: false,
        muted: false,
        liveGlyph: "speaking",
        active: true,
        navSelected: true,
      }],
      reply: {
        sessionId: "parked",
        text: "parked-session-is-live-now",
        spokenChars: 0,
      },
    }));
    expect(writes.at(-1)).toContain("parked-session-is-live-now");
    expect(writes.at(-1)).not.toContain("stale-parked-preview");

    renderer.panel(sampleModel({
      live: {
        state: "recording",
        label: "project-one",
        partial: "live-dictation-wins",
      },
      preview: {
        sessionId: "parked",
        text: "parked-wins-during-dictation",
        spokenChars: 0,
      },
      rows: [
        ...sampleModel().rows,
        {
          sessionId: "parked",
          label: "parked-project",
          status: "waiting",
          paused: false,
          muted: false,
          liveGlyph: null,
          active: false,
          navSelected: true,
        },
      ],
    }));
    expect(writes.at(-1)).toContain("parked-wins-during-dictation");
    expect(writes.at(-1)).not.toContain("live-dictation-wins");
  });

  test("selection plus non-zero offset preserves frame bounds and copies highlighted text", () => {
    const dimensions = { columns: 72, rows: 7 };
    const { io, writes, copies } = recordingIO(dimensions);
    const renderer = createTheaterRenderer(io, {});
    renderer.enter();
    renderer.panel(sampleModel({
      live: { state: "idle", label: "", partial: "" },
      reply: {
        sessionId: "one",
        text: `zero-one-two ${"middle ".repeat(60)}final-tail`,
        spokenChars: 0,
      },
    }));
    renderer.scrollPane?.(3);
    // At 72 columns the content pane begins at zero-based column 25, row 2.
    renderer.pointerEvent?.({ kind: "down", button: 0, column: 26, row: 3 });
    renderer.pointerEvent?.({ kind: "drag", button: 0, column: 36, row: 5 });

    const frame = writes.at(-1)!;
    const lines = frame
      .replace(/^\x1b\[H/, "")
      .split("\n")
      .map((line) => line.replace(/\x1b\[K$/, ""));
    expect(frame).toContain("\x1b[7m");
    expect(frame.match(/\x1b\[K/g)).toHaveLength(7);
    expect(frame.match(/\n/g)).toHaveLength(6);
    expect(lines.every((line) => terminalCellWidth(line) <= 71)).toBe(true);

    renderer.pointerEvent?.({ kind: "up", button: 0, column: 36, row: 5 });
    expect(copies).toHaveLength(1);
    expect(copies[0]?.length).toBeGreaterThan(0);
    expect(writes.some((write) => write.startsWith("\x1b]52;c;"))).toBe(true);
  });

  test("selection maps terminal cells to Unicode boundaries and copies plain text only", () => {
    const { io, copies } = recordingIO({ columns: 72, rows: 7 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    renderer.panel(sampleModel({
      live: { state: "idle", label: "", partial: "" },
      reply: {
        sessionId: "one",
        text: `\x1b[31m${"漢".repeat(30)}\x1b[0m`,
        spokenChars: 0,
      },
    }));

    // Pane starts at one-based column 26. Ten terminal cells contain five
    // double-width glyphs, not ten JavaScript string indices.
    renderer.pointerEvent?.({ kind: "down", button: 0, column: 26, row: 3 });
    renderer.pointerEvent?.({ kind: "drag", button: 0, column: 36, row: 3 });
    renderer.pointerEvent?.({ kind: "up", button: 0, column: 36, row: 3 });

    expect(copies).toEqual(["漢".repeat(5)]);
    expect(copies[0]).not.toContain("\x1b");
  });

  test("dragging beyond the pane auto-scrolls and selects off-viewport rows", () => {
    const { io, copies } = recordingIO({ columns: 72, rows: 7 });
    const renderer = createTheaterRenderer(io, {});
    renderer.enter();
    renderer.panel(sampleModel({
      live: { state: "idle", label: "", partial: "" },
      reply: {
        sessionId: "one",
        text: Array.from({ length: 120 }, (_, index) => `token-${index}`).join(" "),
        spokenChars: 0,
      },
    }));
    renderer.pointerEvent?.({ kind: "down", button: 0, column: 26, row: 3 });
    for (let index = 0; index < 12; index++) {
      renderer.pointerEvent?.({ kind: "drag", button: 0, column: 70, row: 8 });
    }
    renderer.pointerEvent?.({ kind: "up", button: 0, column: 70, row: 8 });

    expect(copies).toHaveLength(1);
    expect(copies[0]!.split("\n").length).toBeGreaterThan(4);
    expect(copies[0]).toContain("token-0");
    expect(copies[0]).toContain("token-40");
  });

  test("a same-length document rewrite clears stale coordinates before mouse-up", () => {
    const { io, copies } = recordingIO({ columns: 72, rows: 7 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    renderer.panel(sampleModel({
      live: { state: "idle", label: "", partial: "" },
      reply: { sessionId: "one", text: "alpha bravo charlie", spokenChars: 0 },
    }));
    renderer.pointerEvent?.({ kind: "down", button: 0, column: 26, row: 3 });
    renderer.pointerEvent?.({ kind: "drag", button: 0, column: 31, row: 3 });

    renderer.panel(sampleModel({
      live: { state: "idle", label: "", partial: "" },
      // Deliberately equal length: a length-only fingerprint copies the wrong bytes.
      reply: { sessionId: "one", text: "xxxxx yyyyy zzzzzzz", spokenChars: 0 },
    }));
    renderer.pointerEvent?.({ kind: "up", button: 0, column: 31, row: 3 });

    expect(copies).toEqual([]);
  });

  test("live dictation renders the dimmed assistant reply above the transcript through transcription", () => {
    const { io, writes } = recordingIO({ columns: 140, rows: 8 });
    const renderer = createTheaterRenderer(io);
    const reply = "The assistant context that this spoken response is answering.";
    const partial = "Here is my live spoken response";
    renderer.enter();
    renderer.panel(sampleModel({
      live: {
        state: "recording",
        label: "project-one",
        partial,
      },
      reply: {
        sessionId: "one",
        text: reply,
        spokenChars: reply.length,
      },
    }));

    for (const state of ["listening", "recording", "transcribing"] as const) {
      renderer.live({ state, label: "project-one", partial });
      const frame = writes.at(-1)!;
      expect(frame).toContain(`\x1b[2m↪ replying to · ${reply}\x1b[0m`);
      expect(frame).toContain(partial);
      if (state === "transcribing") expect(frame).not.toContain(`${partial}▌`);
      else expect(frame).toContain(`${partial}▌`);
      if (state === "transcribing") {
        const plain = frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
        expect(plain.match(/transcribing/g)).toHaveLength(1);
        expect(frame).not.toContain("transcribing…");
      } else {
        expect(frame).toContain("pause to send · space to stop · say send to submit now");
      }
      expect(frame).not.toContain("‹project-one› · pause to send");
      expect(frame.indexOf(reply)).toBeLessThan(frame.indexOf(partial));
    }
  });

  test("tight conversation panes drop help then truncate the quote before the transcript", () => {
    const dimensions = { columns: 72, rows: 6 };
    const { io, writes } = recordingIO(dimensions);
    const renderer = createTheaterRenderer(io);
    const reply = `quote-start ${"assistant context ".repeat(40)}quote-tail`;
    const partial = `${"earlier transcript ".repeat(30)}latest-live-tail`;
    renderer.enter();
    renderer.panel(sampleModel({
      live: {
        state: "recording",
        label: "project-one",
        partial,
      },
      reply: {
        sessionId: "one",
        text: reply,
        spokenChars: reply.length,
      },
    }));

    const tightFrame = writes.at(-1)!;
    expect(tightFrame).toContain("↪ replying to · quote-start");
    expect(tightFrame).not.toContain("quote-tail");
    expect(tightFrame).toContain("latest-live-tail▌");
    expect(tightFrame.indexOf("quote-start")).toBeLessThan(
      tightFrame.indexOf("latest-live-tail▌"),
    );

    dimensions.rows = 5;
    renderer.resize();
    const conversationOnlyFrame = writes.at(-1)!;
    expect(conversationOnlyFrame).toContain("↪ replying to · quote-start");
    expect(conversationOnlyFrame).toContain("latest-live-tail▌");
    expect(conversationOnlyFrame).not.toContain("pause to send");

    dimensions.rows = 4;
    renderer.resize();
    const transcriptOnlyFrame = writes.at(-1)!;
    expect(transcriptOnlyFrame).toContain("latest-live-tail▌");
    expect(transcriptOnlyFrame).not.toContain("↪ replying to");
    expect(transcriptOnlyFrame).not.toContain("quote-start");
    expect(transcriptOnlyFrame).not.toContain("pause to send");
  });

  test("shows the reducer-kept transcript before the live partial through transcription", () => {
    const { io, writes } = recordingIO({ columns: 120, rows: 7 });
    const renderer = createTheaterRenderer(io);
    const reducer = new DictationReducer({ holdSubmit: true });
    reducer.consume({ type: "transcript", sequence: 1, text: "first kept segment" });
    reducer.consume({ type: "transcript", sequence: 2, text: "second kept segment" });
    reducer.consume({ type: "transcript", sequence: 3, text: "repeat" });
    const transcriptPrefix = reducer.snapshot.buffer.map((segment) => segment.text).join(" ");

    renderer.enter();
    renderer.panel(sampleModel({
      live: {
        state: "recording",
        label: "project-one",
        partial: "current words",
        transcriptPrefix,
      },
    }));

    expect(writes.at(-1)).toContain("first kept segment second kept segment current words▌");
    expect(writes.at(-1)).not.toContain("repeat");

    renderer.live({
      state: "transcribing",
      label: "project-one",
      partial: "current words",
      transcriptPrefix,
    });
    expect(writes.at(-1)).toContain("first kept segment second kept segment current words");
    expect(writes.at(-1)).not.toContain("▌");
  });

  test("long speaking replies keep the dim/bright frontier in view", () => {
    const { io, writes } = recordingIO({ columns: 72, rows: 7 });
    const renderer = createTheaterRenderer(io);
    const text = `${"before ".repeat(50)}frontier-word ${"after ".repeat(50)}`;
    renderer.enter();
    renderer.panel(sampleModel({
      live: {
        state: "speaking",
        label: "project-one",
        partial: "",
        reading: { text, spokenChars: text.indexOf("frontier-word") + 3 },
      },
    }));
    expect(writes.at(-1)?.replace(/\x1b\[[0-9;]*m/g, "")).toContain("frontier-word");
    expect(writes.at(-1)).toContain("space to cut in");
    expect(writes.at(-1)).not.toContain("‹project-one› · space to cut in");
  });

  test("fatal-process and explicit restore paths share one idempotent cleanup", () => {
    const { io, writes } = recordingIO();
    const raw: boolean[] = [];
    const renderer = createTheaterRenderer(io);
    const events = new EventEmitter();
    const lifecycle = installRendererLifecycle(
      renderer,
      { isTTY: true, setRawMode: (enabled) => raw.push(enabled) },
      events,
    );

    lifecycle.enter();
    events.emit("uncaughtExceptionMonitor", new Error("boom"));
    events.emit("exit", 1);
    lifecycle.restore();

    expect(writes).toEqual([
      "\x1b[?1049h\x1b[?25l",
      "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h",
      "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l",
      "\x1b[?1049l\x1b[?25h",
    ]);
    expect(raw).toEqual([false]);
    lifecycle.dispose();
  });

  test("raw mode is restored even if the terminal writer throws during shutdown", () => {
    const { io: baseIO } = recordingIO();
    const writes: string[] = [];
    const raw: boolean[] = [];
    const io: RendererIO = {
      ...baseIO,
      write(text) {
        writes.push(text);
        if (text === "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l") {
          throw new Error("writer closed");
        }
      },
    };
    const renderer = createTheaterRenderer(io);
    const events = new EventEmitter();
    const lifecycle = installRendererLifecycle(
      renderer,
      { isTTY: true, setRawMode: (enabled) => raw.push(enabled) },
      events,
    );
    lifecycle.enter();
    expect(() => lifecycle.restore()).toThrow("writer closed");
    lifecycle.restore();
    events.emit("exit", 1);
    expect(writes).toEqual([
      "\x1b[?1049h\x1b[?25l",
      "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h",
      "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l",
      "\x1b[?1049l\x1b[?25h",
    ]);
    expect(raw).toEqual([false]);
    lifecycle.dispose();
  });
});

test("setState preserves the transcript prefix across partials and transitions", () => {
  setTranscriptPrefix("prior kept segment");
  setState("recording", "project-one", "current");
  expect(getLiveState().transcriptPrefix).toBe("prior kept segment");

  setState("transcribing", "project-one", "current finalized");
  expect(getLiveState()).toMatchObject({
    state: "transcribing",
    partial: "current finalized",
    transcriptPrefix: "prior kept segment",
  });

  setTranscriptPrefix("");
  setState("idle");
});

test("live-data observers receive every distinct state, partial, prefix, and reading mutation", () => {
  setTranscriptPrefix("");
  clearReadingProgress();
  setState("idle");
  const seen: LiveState[] = [];
  onLiveDataChange(() => {
    const current = getLiveState();
    seen.push({
      ...current,
      ...(current.reading ? { reading: { ...current.reading } } : {}),
    });
  });

  try {
    setState("listening", "project-live");
    setState("recording", "project-live", "first");
    // State and label are unchanged: this is the path that used to skip panel
    // publication even though the theater renderer updated live.
    setState("recording", "project-live", "second");
    setTranscriptPrefix("committed");
    setReadingProgress("Assistant reply", 9);
    clearReadingProgress();

    expect(seen).toHaveLength(6);
    expect(seen[0]).toMatchObject({
      state: "listening",
      label: "project-live",
      partial: "",
    });
    expect(seen[1]).toMatchObject({
      state: "recording",
      label: "project-live",
      partial: "first",
    });
    expect(seen[2]?.partial).toBe("second");
    expect(seen[3]?.transcriptPrefix).toBe("committed");
    expect(seen[4]?.reading).toEqual({ text: "Assistant reply", spokenChars: 9 });
    expect(seen[5]?.reading).toBeUndefined();
  } finally {
    onLiveDataChange(null);
    setTranscriptPrefix("");
    clearReadingProgress();
    setState("idle");
  }
});

test("live-data observers suppress normalized no-op setter calls", () => {
  setTranscriptPrefix("committed");
  setState("speaking", "project-live");
  setReadingProgress("reply", 5);
  let notifications = 0;
  onLiveDataChange(() => notifications++);

  try {
    setState("speaking", "project-live");
    setTranscriptPrefix("committed");
    setReadingProgress("reply", 99); // both 5 and 99 clamp to reply.length
    expect(notifications).toBe(0);

    clearReadingProgress();
    clearReadingProgress();
    expect(notifications).toBe(1);
  } finally {
    onLiveDataChange(null);
    setTranscriptPrefix("");
    clearReadingProgress();
    setState("idle");
  }
});

test("renderer-independent conversation capture does not repaint the footer", () => {
  const { io, writes } = recordingIO();
  configureRenderer({ CONCH_TUI: "footer" }, io);
  setState("speaking", "project-footer");
  writes.length = 0;

  setTranscriptPrefix("committed words");
  setReadingProgress("Assistant reply", 4);
  clearReadingProgress();

  expect(writes).toEqual([]);
  setTranscriptPrefix("");
  setState("idle");
});

test("theater is the default on a full TTY; footer is the opt-out", () => {
  expect(shouldUseTheater({}, true, true)).toBe(true);
  expect(shouldUseTheater({ CONCH_TUI: "theater" }, true, true)).toBe(true);
  expect(shouldUseTheater({ CONCH_TUI: "footer" }, true, true)).toBe(false);
  expect(shouldUseTheater({}, true, false)).toBe(false);
  expect(shouldUseTheater({}, false, true)).toBe(false);
});

test("only the selected theater renderer dispatches destructive terminal controls", () => {
  expect(shouldDispatchTerminalInput("theater", true)).toBe(true);
  expect(shouldDispatchTerminalInput("theater", false)).toBe(false);
  expect(shouldDispatchTerminalInput("footer", true)).toBe(false);
});
