/**
 * Daemon state, made visible twice over:
 *  - a live terminal renderer (the legacy footer or opt-in theater mode)
 *  - /tmp/conch-state.json for anything else (menu-bar apps, status bars)
 */
import { appendFileSync } from "node:fs";
import {
  dashboardPanelLines,
  dashboardRowsForModel,
  type PanelConchState,
  type PanelLiveState,
  type PanelModel,
  type PanelRowModel,
} from "./panel.ts";

export type ConchState = PanelConchState;
export type LiveState = PanelLiveState;

// Exported as a stable path for external consumers (menu-bar apps, status bars).
export const STATE_FILE = "/tmp/conch-state.json";
// Every log line is always appended here (for debugging) but only shown in the
// pane when logs are toggled on — the dashboard stays clean by default.
export const LOG_FILE = "/tmp/conch-daemon.log";

export const ALT_SCREEN_ENTER = "\x1b[?1049h\x1b[?25l";
export const ALT_SCREEN_RESTORE = "\x1b[?1049l\x1b[?25h";

let logsVisible = false;
/** Toggle the in-pane play-by-play log (off by default; `l` in the dashboard). */
export function setLogsVisible(v: boolean): boolean {
  logsVisible = v;
  if (activeRendererKind === "theater") activeRenderer.resize();
  return logsVisible;
}
export function logsShown(): boolean {
  return logsVisible;
}

const GLYPHS: Record<ConchState, string> = {
  idle: "\x1b[2m◌ idle · space=wake m=mute p=pause ?=help\x1b[0m",
  muted: "\x1b[33m◌ muted\x1b[0m\x1b[2m · m to unmute\x1b[0m",
  paused: "\x1b[35m⏸ paused (away)\x1b[0m\x1b[2m · p or `conch resume` — holding your queue\x1b[0m",
  speaking: "\x1b[33m▶ speaking\x1b[0m",
  listening: "\x1b[32m● mic open\x1b[0m",
  recording: "\x1b[31m● recording\x1b[0m",
  transcribing: "\x1b[36m… transcribing\x1b[0m",
};
void GLYPHS; // Kept as the stable state vocabulary for external status consumers.

export interface Renderer {
  panel(model: PanelModel): void;
  live(state: LiveState): void;
  keybar(line: string): void;
  log(line: string): void;
  resize(): void;
  enter(): void;
  shutdown(): void;
}

export interface RendererIO {
  stdoutTTY: boolean;
  stdinTTY: boolean;
  columns(): number;
  rows(): number;
  write(text: string): void;
  print(line: string): void;
}

function processRendererIO(): RendererIO {
  return {
    stdoutTTY: process.stdout.isTTY ?? false,
    stdinTTY: process.stdin.isTTY ?? false,
    columns: () => process.stdout.columns ?? 100,
    rows: () => process.stdout.rows ?? 24,
    write: (text) => process.stdout.write(text),
    print: (line) => console.log(line),
  };
}

/**
 * The default renderer is the old sticky footer state machine. Keep this dance
 * deliberately boring: theater is opt-in and must not perturb its output.
 */
export function createFooterRenderer(io: RendererIO = processRendererIO()): Renderer {
  const tty = io.stdoutTTY;
  let panelLines: string[] = []; // the pinned session-status panel
  let transcriptLine = ""; // your words as you speak them — shown only while dictating
  let keybar = ""; // the static key hints, always at the very bottom
  let drawnHeight = 0; // footer lines currently on screen, so a shrink can't leave orphans

  function footerLines(): string[] {
    // panel → a RESERVED transcription slot (blank when idle, your words while you
    // speak — always present so it never shifts the layout) → keybar (very bottom).
    return [...panelLines, transcriptLine, ...(keybar ? [keybar] : [])];
  }

  // Move to the top-left of the footer and wipe everything below it. `\x1b[0J`
  // clears to end of screen, so grow/shrink of the panel never leaves orphan rows.
  function clearFooter(): void {
    if (!tty || drawnHeight === 0) return;
    for (let i = 1; i < drawnHeight; i++) io.write("\x1b[1A");
    io.write("\r\x1b[0J");
    drawnHeight = 0;
  }

  function drawFooter(): void {
    if (!tty) return;
    // Fit EVERY line to the width — a line that wraps would make drawnHeight wrong
    // and re-introduce the scroll. (Re-fits on each draw, so resize just works.)
    const width = io.columns() - 1;
    const lines = footerLines().map((line) => fitToWidth(line, width));
    if (lines.length) io.write(lines.join("\n"));
    drawnHeight = lines.length;
  }

  return {
    panel(model): void {
      const lines = dashboardPanelLines(dashboardRowsForModel(model), io.columns(), model.mode);
      const width = io.columns() - 1;
      if (!tty) {
        panelLines = lines;
        return;
      }
      clearFooter();
      panelLines = lines.map((line) => fitToWidth(line, width));
      drawFooter();
    },
    live(state): void {
      if (!tty) return;
      // The bottom no longer duplicates the state (that's on the row now) — it just
      // shows your words as they land while you dictate. Empty when you're not.
      clearFooter();
      transcriptLine = state.partial
        ? fitToWidth(`  \x1b[2m🎙\x1b[0m  ${state.partial}`, io.columns() - 1)
        : "";
      drawFooter();
    },
    keybar(line): void {
      const same = line === keybar;
      keybar = line;
      if (tty && !same) {
        clearFooter();
        drawFooter();
      }
    },
    log(line): void {
      if (tty) clearFooter();
      io.print(line);
      if (tty) drawFooter();
    },
    resize(): void {},
    enter(): void {},
    shutdown(): void {},
  };
}

const ANSI_SGR = /\x1b\[[0-9;]*m/g;

function visibleLength(text: string): number {
  return text.replace(ANSI_SGR, "").length;
}

function padVisible(text: string, width: number): string {
  const fitted = fitToWidth(text, width);
  return fitted + " ".repeat(Math.max(0, width - visibleLength(fitted)));
}

function wrapPlainText(text: string, width: number): Array<{ text: string; start: number; end: number }> {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || width < 1) return [];
  const lines: Array<{ text: string; start: number; end: number }> = [];
  let offset = 0;
  while (offset < normalized.length) {
    const remaining = normalized.slice(offset);
    if (remaining.length <= width) {
      lines.push({ text: remaining, start: offset, end: normalized.length });
      break;
    }
    const candidate = remaining.slice(0, width + 1);
    const breakAt = candidate.lastIndexOf(" ");
    const take = breakAt > 0 ? breakAt : width;
    const line = remaining.slice(0, take);
    lines.push({ text: line, start: offset, end: offset + line.length });
    offset += take;
    while (normalized[offset] === " ") offset++;
  }
  return lines;
}

const THEATER_STATUS_ICON: Record<string, string> = {
  needs: "\x1b[33m❗\x1b[0m",
  waiting: "\x1b[32m○\x1b[0m",
  working: "\x1b[36m●\x1b[0m",
  idle: "\x1b[2m·\x1b[0m",
  snoozed: "\x1b[2m⏸\x1b[0m",
  listening: "\x1b[32m●\x1b[0m",
  recording: "\x1b[31m●\x1b[0m",
  speaking: "\x1b[33m▶\x1b[0m",
  transcribing: "\x1b[36m…\x1b[0m",
};

function rowState(row: PanelRowModel): string {
  if (row.snoozed) return "snoozed";
  return row.liveGlyph ?? row.status ?? "idle";
}

function fullStatus(row: PanelRowModel): string {
  if (row.snoozed) return "⏸ snoozed";
  switch (row.liveGlyph ?? row.status) {
    case "speaking": return "▶ speaking";
    case "listening": return "● mic open";
    case "recording": return "● recording";
    case "transcribing": return "… transcribing";
    case "needs": return "❗ needs a response";
    case "waiting": return "○ waiting for you";
    case "working": return "● working…";
    default: return "· idle";
  }
}

function theaterLedgerRow(row: PanelRowModel, width: number, compact: boolean): string {
  const cursor = row.navSelected ? "\x1b[38;2;88;201;212m▸\x1b[0m " : "  ";
  let body: string;
  if (compact) {
    const icon = THEATER_STATUS_ICON[rowState(row)] ?? THEATER_STATUS_ICON.idle!;
    const labelWidth = Math.max(1, width - visibleLength(cursor) - visibleLength(icon) - 2);
    const label = padVisible(row.label, labelWidth);
    body = `${cursor}${label} ${icon}`;
  } else {
    const status = fullStatus(row);
    const labelWidth = Math.max(1, Math.min(30, width - visibleLength(cursor) - visibleLength(status) - 2));
    body = `${cursor}${padVisible(row.label, labelWidth)} ${status}`;
    if (row.detail) body += ` \x1b[2m(${row.detail})\x1b[0m`;
  }
  body = padVisible(body, width);
  if (row.snoozed) body = `\x1b[2m${body}\x1b[0m`;
  if (!row.active) return body;
  // A steady brand accent + neutral fill anchors the live session. State color
  // belongs only to the icon, so the row does not strobe through an exchange.
  return `\x1b[38;2;88;201;212m▎\x1b[0m\x1b[48;2;28;32;36m${padVisible(body, Math.max(0, width - 1))}\x1b[0m`;
}

function readingLine(
  line: { text: string; start: number; end: number },
  spokenChars: number,
): string {
  if (spokenChars <= line.start) return line.text;
  if (spokenChars >= line.end) return `\x1b[2m${line.text}\x1b[0m`;
  const split = Math.max(0, spokenChars - line.start);
  return `\x1b[2m${line.text.slice(0, split)}\x1b[0m${line.text.slice(split)}`;
}

function theaterContentLines(model: PanelModel, width: number, height: number, logLines: readonly string[]): string[] {
  if (height <= 0 || width <= 0) return [];
  if (logsVisible) {
    return logLines
      .flatMap((line) => wrapPlainText(line, width).map((wrapped) => `\x1b[2m${wrapped.text}\x1b[0m`))
      .slice(-height);
  }

  const state = model.live.state;
  const note = state === "speaking"
    ? "space to cut in · the mic opens when it finishes"
    : state === "listening" || state === "recording"
      ? "pause to send · space to stop · say send to submit now"
      : "";
  const available = Math.max(0, height - (note ? 1 : 0));
  let lines: string[] = [];

  if (state === "listening" || state === "recording") {
    const partial = `${model.live.partial}▌`;
    lines = wrapPlainText(partial, width).map((line) => line.text);
  } else {
    const reading = model.live.reading;
    const text = reading?.text ?? model.reply?.text ?? "";
    const wrapped = wrapPlainText(text, width);
    if (state === "speaking") {
      const spokenChars = reading?.spokenChars ?? model.reply?.spokenChars ?? 0;
      lines = wrapped.map((line) => readingLine(line, spokenChars));
    } else {
      lines = wrapped.map((line) => `\x1b[2m${line.text}\x1b[0m`);
    }
  }

  lines = lines.slice(0, available);
  while (lines.length < available) lines.push("");
  if (note) lines.push(`\x1b[2m${note}\x1b[0m`);
  return lines;
}

/** Full-frame alternate-screen renderer. Its tests assert invariants, not pixels. */
export function createTheaterRenderer(io: RendererIO = processRendererIO()): Renderer {
  let entered = false;
  let model: PanelModel | null = null;
  let keybar = "";
  const logLines: string[] = [];

  const repaint = (): void => {
    if (!entered) return;
    const columns = Math.max(1, io.columns());
    const rows = Math.max(1, io.rows());
    const frame: string[] = [];
    const paneOpen = (model?.panelOpen ?? true) && columns >= 52;
    const ledgerWidth = paneOpen ? Math.min(34, Math.max(22, Math.floor(columns * 0.3))) : columns;
    const contentWidth = paneOpen ? Math.max(1, columns - ledgerWidth - 3) : 0;

    frame.push("  \x1b[1m🐚 conch\x1b[0m");
    if (rows > 1) {
      frame.push(`\x1b[2m${"─".repeat(Math.max(1, columns - 1))}\x1b[0m`);
    }
    const bodyHeight = Math.max(0, rows - 3);
    const content = model && paneOpen
      ? theaterContentLines(model, contentWidth, bodyHeight, logLines)
      : [];
    const ledgerRows = model?.rows ?? [];

    for (let index = 0; index < bodyHeight; index++) {
      let ledger = ledgerRows[index]
        ? theaterLedgerRow(ledgerRows[index]!, ledgerWidth, paneOpen)
        : " ".repeat(ledgerWidth);
      frame.push(paneOpen
        ? `${ledger} \x1b[2m│\x1b[0m ${content[index] ?? ""}`
        : ledger);
    }
    if (rows > 2) {
      const modeHint = model?.mode.muted
        ? "🔇 muted · "
        : model?.mode.paused
          ? `⏸ paused · holding ${model.mode.holding} · `
          : "";
      frame.push(`${modeHint}${keybar}`);
    }

    const bounded = frame.slice(0, rows);
    while (bounded.length < rows) bounded.push("");
    const width = Math.max(1, columns - 1); // never arm the terminal's wrap column
    const output = bounded.map((line) => `${fitToWidth(line, width)}\x1b[K`).join("\n");
    io.write(`\x1b[H${output}`);
  };

  return {
    panel(next): void {
      model = next;
      repaint();
    },
    live(next): void {
      if (model) model = { ...model, live: next };
      repaint(); // partial-only updates must remain live even without onLiveChange
    },
    keybar(line): void {
      keybar = line;
      repaint();
    },
    log(line): void {
      logLines.push(...line.split("\n"));
      if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
      repaint();
    },
    resize: repaint,
    enter(): void {
      if (entered) return;
      entered = true;
      io.write(ALT_SCREEN_ENTER);
    },
    shutdown(): void {
      if (!entered) return;
      entered = false; // make restoration idempotent before touching the writer
      io.write(ALT_SCREEN_RESTORE);
    },
  };
}

export interface RendererSelection {
  kind: "footer" | "theater";
  renderer: Renderer;
}

let activeRenderer: Renderer = createFooterRenderer();
let activeRendererKind: RendererSelection["kind"] = "footer";

export function shouldUseTheater(
  env: Readonly<Record<string, string | undefined>> = process.env,
  stdoutTTY = process.stdout.isTTY ?? false,
  stdinTTY = process.stdin.isTTY ?? false,
): boolean {
  return stdoutTTY && stdinTTY && env.CONCH_TUI === "theater";
}

/** Select once at daemon startup; importing status.ts never enters alt-screen. */
export function configureRenderer(
  env: Readonly<Record<string, string | undefined>> = process.env,
  io: RendererIO = processRendererIO(),
): RendererSelection {
  const theater = shouldUseTheater(env, io.stdoutTTY, io.stdinTTY);
  activeRendererKind = theater ? "theater" : "footer";
  activeRenderer = theater ? createTheaterRenderer(io) : createFooterRenderer(io);
  return { kind: activeRendererKind, renderer: activeRenderer };
}

export interface LifecycleInput {
  isTTY?: boolean;
  setRawMode?(enabled: boolean): unknown;
}

export interface LifecycleEvents {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface RendererLifecycle {
  enter(): void;
  restore(): void;
  dispose(): void;
}

/**
 * Process-lifetime ownership for the terminal. `runDaemon()` returns after it
 * wires listeners, so a lexical try/finally would restore far too early.
 */
export function installRendererLifecycle(
  renderer: Renderer,
  input: LifecycleInput = process.stdin,
  events: LifecycleEvents = process,
): RendererLifecycle {
  let entered = false;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    renderer.shutdown();
    if (input.isTTY && input.setRawMode) {
      try {
        input.setRawMode(false);
      } catch {}
    }
  };
  const onExit = (): void => restore();
  const onCrash = (): void => restore();
  events.on("exit", onExit);
  // This observes fatal exceptions without replacing the runtime's crash path.
  // Unhandled rejections that terminate are promoted to uncaught exceptions.
  events.on("uncaughtExceptionMonitor", onCrash);

  return {
    enter(): void {
      if (entered || restored) return;
      entered = true;
      renderer.enter();
    },
    restore,
    dispose(): void {
      events.off?.("exit", onExit);
      events.off?.("uncaughtExceptionMonitor", onCrash);
    },
  };
}

let live: LiveState = { state: "idle", label: "", partial: "" };
let onLive: (() => void) | null = null;
export function getLiveState(): LiveState {
  return live;
}
export function onLiveChange(cb: () => void): void {
  onLive = cb;
}

export function setReadingProgress(text: string, spokenChars: number): void {
  live = {
    ...live,
    reading: { text, spokenChars: Math.max(0, Math.min(spokenChars, text.length)) },
  };
  activeRenderer.live(live);
}

export function clearReadingProgress(): void {
  if (!live.reading) return;
  const { reading: _reading, ...rest } = live;
  live = rest;
  activeRenderer.live(live);
}

export function setState(state: ConchState, label = "", partial = ""): void {
  const transition = state !== live.state || label !== live.label; // ignore partial-only updates
  const reading = label && label === live.label ? live.reading : undefined;
  live = { state, label, partial, ...(reading ? { reading } : {}) };
  void Bun.write(STATE_FILE, JSON.stringify({ state, label, partial, ts: Date.now() }) + "\n");
  activeRenderer.live(live);
  if (transition) onLive?.(); // repaint the panel so the active row shows the new live state
}

/** The static key hints, pinned at the very bottom under everything. */
export function setKeybar(line: string): void {
  activeRenderer.keybar(line);
}

/** Render the semantic session panel through the selected view. */
export function renderPanel(model: PanelModel): void {
  activeRenderer.panel(model);
}

/** Print a log line without clobbering (or being clobbered by) terminal chrome.
 *  Always recorded to LOG_FILE; only shown in the pane when logs are toggled on. */
export function logAbove(msg: string): void {
  try {
    appendFileSync(LOG_FILE, msg.replace(ANSI_SGR, "") + "\n");
  } catch {}
  if (!logsVisible) return; // hidden by default — press `l`, or tail LOG_FILE
  activeRenderer.log(msg);
}

export function resizeRenderer(): void {
  activeRenderer.resize();
}

export function fitToWidth(text: string, width: number): string {
  const plain = text.replace(ANSI_SGR, "");
  if (plain.length <= width) return text;
  // overflow is always the partial-transcript tail; trim visible chars from the end
  let visible = 0;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\x1b") {
      const end = text.indexOf("m", i);
      out += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (visible >= width - 1) break;
    out += text[i];
    visible++;
  }
  return out + "…\x1b[0m";
}
