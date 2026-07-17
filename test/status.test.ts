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
});

test("theater requires the exact opt-in and both terminal sides", () => {
  expect(shouldUseTheater({ CONCH_TUI: "theater" }, true, true)).toBe(true);
  expect(shouldUseTheater({ CONCH_TUI: "theater" }, true, false)).toBe(false);
  expect(shouldUseTheater({ CONCH_TUI: "theater" }, false, true)).toBe(false);
  expect(shouldUseTheater({ CONCH_TUI: "footer" }, true, true)).toBe(false);
});
