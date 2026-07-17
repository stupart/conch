import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  ALT_SCREEN_ENTER,
  ALT_SCREEN_RESTORE,
  createFooterRenderer,
  createTheaterRenderer,
  fitToWidth,
  installRendererLifecycle,
  shouldUseTheater,
  terminalCellWidth,
  type Renderer,
  type RendererIO,
} from "../src/status.ts";
import {
  dashboardPanelLines,
  dashboardRowsForModel,
  type PanelModel,
} from "../src/panel.ts";

function sampleModel(overrides: Partial<PanelModel> = {}): PanelModel {
  return {
    rows: [
      {
        sessionId: "one",
        label: "project-one",
        status: "waiting",
        snoozed: false,
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
  const io: RendererIO = {
    stdoutTTY: options.tty ?? true,
    stdinTTY: options.tty ?? true,
    columns: () => options.columns ?? 80,
    rows: () => options.rows ?? 8,
    write: (text) => writes.push(text),
    print: (line) => prints.push(line),
  };
  return { io, writes, prints };
}

describe("footer renderer seam", () => {
  test("renders a semantic model through the unchanged dashboard/footer view", () => {
    const { io, writes } = recordingIO({ columns: 80 });
    const model = sampleModel();
    createFooterRenderer(io).panel(model);

    const legacyPanel = dashboardPanelLines(dashboardRowsForModel(model), 80, model.mode)
      .map((line) => fitToWidth(line, 79));
    const expected = [...legacyPanel, ""].map((line) => fitToWidth(line, 79)).join("\n");
    expect(writes).toEqual([expected]);
  });

  test("keeps the legacy 80-column dashboard fallback separate from line fitting", () => {
    const { io, writes } = recordingIO({ columns: 100 });
    io.dashboardColumns = () => 80;
    const model = sampleModel();
    createFooterRenderer(io).panel(model);

    const legacyPanel = dashboardPanelLines(dashboardRowsForModel(model), 80, model.mode)
      .map((line) => fitToWidth(line, 99));
    expect(writes).toEqual([[...legacyPanel, ""].join("\n")]);
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

    expect(writes).toEqual([ALT_SCREEN_ENTER, ALT_SCREEN_RESTORE]);
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
    expect(frame).toContain("▶");
    expect(frame.match(/\x1b\[K/g)).toHaveLength(7);
    expect(frame.match(/\n/g)).toHaveLength(6);
    expect(frame.endsWith("\n")).toBe(false);
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
        snoozed: false,
        liveGlyph: null,
        active: false,
        navSelected: false,
      }],
    }));

    const frame = writes.at(-1)!;
    expect(frame).toContain("needs a response");
    expect(frame).not.toContain("│");
    expect(frame).not.toContain("…");
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

  test("wide labels stay within frame cells and cannot move the ledger seam", () => {
    const { io, writes } = recordingIO({ columns: 64, rows: 7 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    renderer.panel(sampleModel({
      rows: [{
        sessionId: "wide",
        label: `漢字漢字漢字漢字漢字漢字漢字\x1b]2;unsafe\u0007`,
        status: "working",
        snoozed: false,
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

  test("ledger and live content viewports follow the manual cursor and latest speech", () => {
    const { io, writes } = recordingIO({ columns: 72, rows: 7 });
    const renderer = createTheaterRenderer(io);
    renderer.enter();
    const rows = Array.from({ length: 10 }, (_, index) => ({
      sessionId: `row-${index}`,
      label: index === 8 ? "manual-eight" : `row-${index}`,
      status: "working" as const,
      snoozed: false,
      liveGlyph: index === 0 ? "recording" as const : null,
      active: index === 0,
      navSelected: index === 8,
    }));
    renderer.panel(sampleModel({
      rows,
      live: {
        state: "recording",
        label: "row-0",
        partial: `${"older words ".repeat(30)}latest-tail`,
      },
    }));

    const frame = writes.at(-1)!;
    expect(frame).toContain("manual-eight");
    expect(frame).toContain("latest-tail");
    expect(frame).toContain("▌");
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
  });

  test("fatal-process and explicit restore paths share one idempotent cleanup", () => {
    const calls: string[] = [];
    const renderer: Renderer = {
      panel() {}, live() {}, keybar() {}, log() {}, resize() {},
      enter: () => calls.push("enter"),
      shutdown: () => calls.push("shutdown"),
    };
    const events = new EventEmitter();
    const lifecycle = installRendererLifecycle(
      renderer,
      { isTTY: true, setRawMode: (enabled) => calls.push(`raw:${enabled}`) },
      events,
    );

    lifecycle.enter();
    events.emit("uncaughtExceptionMonitor", new Error("boom"));
    events.emit("exit", 1);
    lifecycle.restore();

    expect(calls).toEqual(["enter", "shutdown", "raw:false"]);
    lifecycle.dispose();
  });

  test("raw mode is restored even if the terminal writer throws during shutdown", () => {
    const calls: string[] = [];
    const renderer: Renderer = {
      panel() {}, live() {}, keybar() {}, log() {}, resize() {}, enter() {},
      shutdown() {
        calls.push("shutdown");
        throw new Error("writer closed");
      },
    };
    const events = new EventEmitter();
    const lifecycle = installRendererLifecycle(
      renderer,
      { isTTY: true, setRawMode: (enabled) => calls.push(`raw:${enabled}`) },
      events,
    );
    expect(() => lifecycle.restore()).toThrow("writer closed");
    expect(calls).toEqual(["shutdown", "raw:false"]);
    lifecycle.dispose();
  });
});

test("theater requires the exact opt-in and both terminal sides", () => {
  expect(shouldUseTheater({ CONCH_TUI: "theater" }, true, true)).toBe(true);
  expect(shouldUseTheater({ CONCH_TUI: "theater" }, true, false)).toBe(false);
  expect(shouldUseTheater({ CONCH_TUI: "theater" }, false, true)).toBe(false);
  expect(shouldUseTheater({ CONCH_TUI: "footer" }, true, true)).toBe(false);
});
