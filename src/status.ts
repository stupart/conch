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
  /** Legacy panel chrome historically used an 80-column fallback. */
  dashboardColumns?(): number;
  rows(): number;
  write(text: string): void;
  print(line: string): void;
}

function processRendererIO(): RendererIO {
  return {
    stdoutTTY: process.stdout.isTTY ?? false,
    stdinTTY: process.stdin.isTTY ?? false,
    columns: () => process.stdout.columns ?? 100,
    dashboardColumns: () => process.stdout.columns ?? 80,
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
      const lines = dashboardPanelLines(
        dashboardRowsForModel(model),
        io.dashboardColumns?.() ?? io.columns(),
        model.mode,
      );
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

function codePointWidth(codePoint: number): number {
  if (
    codePoint === 0
    || codePoint === 0x200d
    || codePoint <= 0x1f
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || (codePoint >= 0x300 && codePoint <= 0x36f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
    || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
  ) return 0;
  if (
    codePoint === 0x2329
    || codePoint === 0x232a
    || codePoint === 0x23f8
    || codePoint === 0x2757
    || (codePoint >= 0x1100 && codePoint <= 0x115f)
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) return 2;
  return 1;
}

/** Conservative terminal-cell width; over-counting a joined emoji is scroll-safe. */
export function terminalCellWidth(text: string): number {
  let width = 0;
  for (const character of text.replace(ANSI_SGR, "")) {
    width += codePointWidth(character.codePointAt(0)!);
  }
  return width;
}

function visibleLength(text: string): number {
  return terminalCellWidth(text);
}

function padVisible(text: string, width: number): string {
  const fitted = fitTheaterLine(text, width);
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
  needs: "\x1b[33m❗\x1b[39m",
  waiting: "\x1b[32m○\x1b[39m",
  working: "\x1b[36m●\x1b[39m",
  idle: "\x1b[2m·\x1b[22m",
  snoozed: "\x1b[2m⏸\x1b[22m",
  listening: "\x1b[32m●\x1b[39m",
  recording: "\x1b[31m●\x1b[39m",
  speaking: "\x1b[33m▶\x1b[39m",
  transcribing: "\x1b[36m…\x1b[39m",
};

function rowState(row: PanelRowModel): string {
  if (row.snoozed) return "snoozed";
  return row.liveGlyph ?? row.status ?? "idle";
}

function fullStatus(row: PanelRowModel): string {
  if (row.snoozed) return "\x1b[2m⏸ snoozed\x1b[22m";
  switch (row.liveGlyph ?? row.status) {
    case "speaking": return "\x1b[33m▶ speaking\x1b[39m";
    case "listening": return "\x1b[32m● mic open\x1b[39m";
    case "recording": return "\x1b[31m● recording\x1b[39m";
    case "transcribing": return "\x1b[36m… transcribing\x1b[39m";
    case "needs": return "\x1b[33m❗ needs a response\x1b[39m";
    case "waiting": return "\x1b[32m○ waiting for you\x1b[39m";
    case "working": return "\x1b[36m● working…\x1b[39m";
    default: return "\x1b[2m· idle\x1b[22m";
  }
}

function theaterLedgerRow(row: PanelRowModel, width: number, compact: boolean): string {
  // Reserve a 1-col gutter on EVERY row (accent bar when active, blank space
  // otherwise) so a row's text never shifts as it gains or loses the highlight.
  const bodyWidth = Math.max(1, width - 1);
  const cursor = row.navSelected ? "\x1b[38;2;88;201;212m▸\x1b[39m " : "  ";
  let body: string;
  if (compact) {
    const icon = THEATER_STATUS_ICON[rowState(row)] ?? THEATER_STATUS_ICON.idle!;
    const labelWidth = Math.max(1, bodyWidth - visibleLength(cursor) - visibleLength(icon) - 2);
    const label = padVisible(row.label, labelWidth);
    body = `${cursor}${label} ${icon}`;
  } else {
    const status = fullStatus(row);
    const labelWidth = Math.max(1, Math.min(30, bodyWidth - visibleLength(cursor) - visibleLength(status) - 2));
    body = `${cursor}${padVisible(row.label, labelWidth)} ${status}`;
    if (row.detail) body += ` \x1b[2m(${row.detail})\x1b[22m`;
  }
  body = padVisible(body, bodyWidth);
  if (row.snoozed) body = `\x1b[2m${body}\x1b[22m`;
  if (!row.active) return ` ${body}`; // blank gutter — keeps text aligned with the active ▎
  // A steady brand accent + neutral fill anchors the live session. State color
  // belongs only to the icon, so the row does not strobe through an exchange.
  return `\x1b[38;2;88;201;212m▎\x1b[0m\x1b[48;2;28;32;36m${body}\x1b[0m`;
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
  const capturing = state === "listening" || state === "recording";
  const transcribing = state === "transcribing";
  const note = state === "speaking"
    ? "space to cut in · the mic opens when it finishes"
    : capturing
      ? "pause to send · space to stop · say send to submit now"
      : transcribing
        ? "transcribing…"
        : "";
  const available = Math.max(0, height - (note ? 1 : 0));
  let lines: string[] = [];

  if (capturing || transcribing) {
    // Keep the live transcript visible through the recording→transcribing
    // handoff — never flash back to the previous reply while finalizing.
    const prefix = model.live.transcriptPrefix;
    const transcript = `${prefix ? `${prefix} ` : ""}${model.live.partial}${capturing ? "▌" : ""}`;
    lines = wrapPlainText(transcript, width).map((line) => line.text).slice(-available);
  } else {
    const reading = model.live.reading;
    const text = reading?.text ?? model.reply?.text ?? "";
    const wrapped = wrapPlainText(text, width);
    if (state === "speaking") {
      const spokenChars = reading?.spokenChars ?? model.reply?.spokenChars ?? 0;
      const foundFrontier = wrapped.findIndex((line) => spokenChars <= line.end);
      const frontier = foundFrontier === -1 ? Math.max(0, wrapped.length - 1) : foundFrontier;
      const maxStart = Math.max(0, wrapped.length - available);
      const start = Math.max(0, Math.min(maxStart, frontier - Math.floor(available / 2)));
      lines = wrapped.slice(start, start + available).map((line) => readingLine(line, spokenChars));
    } else {
      lines = wrapped.map((line) => `\x1b[2m${line.text}\x1b[0m`);
    }
  }

  lines = lines.slice(0, available);
  while (lines.length < available) lines.push("");
  if (note) lines.push(`\x1b[2m${note}\x1b[0m`);
  return lines;
}

function theaterSettingsOverlay(
  base: string[],
  overlay: NonNullable<PanelModel["settingsOverlay"]>,
  width: number,
  height: number,
): string[] {
  if (width < 12 || height < 4) {
    const compact = [...base];
    while (compact.length < height) compact.push("");
    if (height) compact[Math.floor(height / 2)] = " settings · esc close";
    return compact.slice(0, height);
  }
  const output = [...base];
  while (output.length < height) output.push("");
  const boxWidth = Math.max(12, Math.min(width - 2, 88));
  const innerWidth = boxWidth - 2;
  const errorRows = overlay.error && height >= 6 ? 1 : 0;
  const visibleCount = Math.max(1, Math.min(overlay.rows.length, height - 3 - errorRows));
  const maxStart = Math.max(0, overlay.rows.length - visibleCount);
  const start = Math.max(0, Math.min(
    maxStart,
    overlay.selectedIndex - Math.floor(visibleCount / 2),
  ));
  const visibleRows = overlay.rows.slice(start, start + visibleCount);
  const keyWidth = Math.max(6, Math.min(22, ...overlay.rows.map((row) => row.key.length)));
  const valueWidth = Math.max(5, Math.min(12, ...overlay.rows.map((row) => row.value.length + (row.editing ? 1 : 0))));
  const lines: string[] = [];
  lines.push(`\x1b[2m╭${"─".repeat(innerWidth)}╮\x1b[0m`);
  lines.push(`\x1b[2m│\x1b[0m${padVisible(" settings · ←→/space adjust · type + enter · esc close", innerWidth)}\x1b[2m│\x1b[0m`);
  for (const row of visibleRows) {
    const cursor = row.selected ? "›" : " ";
    const value = `${row.value}${row.editing ? "▌" : ""}`;
    const ack = row.ack ? ` · \x1b[2m${row.ack}\x1b[22m` : "";
    const text = `${cursor} ${row.key.padEnd(keyWidth)} · ${value.padEnd(valueWidth)} · \x1b[2m[${row.source}]\x1b[22m${ack} · ${row.help}`;
    const fitted = padVisible(text, innerWidth);
    const styled = row.selected
      ? `\x1b[38;2;88;201;212m\x1b[48;2;28;32;36m${fitted}\x1b[0m`
      : fitted;
    lines.push(`\x1b[2m│\x1b[0m${styled}\x1b[2m│\x1b[0m`);
  }
  if (errorRows) {
    lines.push(`\x1b[2m│\x1b[0m${padVisible(` ${overlay.error}`, innerWidth)}\x1b[2m│\x1b[0m`);
  }
  lines.push(`\x1b[2m╰${"─".repeat(innerWidth)}╯\x1b[0m`);

  const top = Math.max(0, Math.floor((height - lines.length) / 2));
  const left = " ".repeat(Math.max(0, Math.floor((width - boxWidth) / 2)));
  for (let index = 0; index < lines.length && top + index < height; index++) {
    output[top + index] = left + lines[index]!;
  }
  return output.slice(0, height);
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
    const frameWidth = Math.max(1, columns - 1); // never arm the terminal's wrap column
    const frame: string[] = [];
    const overlayOpen = Boolean(model?.settingsOverlay);
    const overlayOnly = overlayOpen && columns < 36;
    const paneOpen = overlayOpen || ((model?.panelOpen ?? true) && columns >= 52);
    let ledgerWidth = frameWidth;
    if (overlayOnly) ledgerWidth = 0;
    else if (paneOpen && overlayOpen) {
      ledgerWidth = Math.min(28, Math.max(16, Math.floor(columns * 0.28)));
    } else if (paneOpen) {
      ledgerWidth = Math.min(34, Math.max(22, Math.floor(columns * 0.3)));
    }
    const contentWidth = paneOpen
      ? Math.max(1, frameWidth - ledgerWidth - (overlayOnly ? 0 : 3))
      : 0;

    frame.push("  \x1b[1m🐚 conch\x1b[0m");
    if (rows > 1) {
      frame.push(`\x1b[2m${"─".repeat(Math.max(1, columns - 1))}\x1b[0m`);
    }
    const bodyHeight = Math.max(0, rows - 3);
    let content = model && paneOpen
      ? theaterContentLines(model, contentWidth, bodyHeight, logLines)
      : [];
    if (model?.settingsOverlay && paneOpen) {
      content = theaterSettingsOverlay(content, model.settingsOverlay, contentWidth, bodyHeight);
    }
    const allLedgerRows = model?.rows ?? [];
    const navFocus = allLedgerRows.findIndex((row) => row.navSelected);
    const activeFocus = allLedgerRows.findIndex((row) => row.active);
    const ledgerFocus = navFocus >= 0 ? navFocus : Math.max(0, activeFocus);
    const ledgerStart = Math.max(0, Math.min(
      Math.max(0, allLedgerRows.length - bodyHeight),
      ledgerFocus - Math.floor(bodyHeight / 2),
    ));
    const ledgerRows = allLedgerRows.slice(ledgerStart, ledgerStart + bodyHeight);

    for (let index = 0; index < bodyHeight; index++) {
      let ledger = ledgerRows[index]
        ? theaterLedgerRow(ledgerRows[index]!, ledgerWidth, paneOpen)
        : " ".repeat(ledgerWidth);
      frame.push(overlayOnly
        ? content[index] ?? ""
        : paneOpen
        ? `${ledger} \x1b[2m│\x1b[0m ${content[index] ?? ""}`
        : ledger);
    }
    if (rows > 2) {
      const modeHint = model?.mode.muted
        ? "🔇 muted · "
        : model?.mode.paused
          ? `⏸ paused · holding ${model.mode.holding} · `
          : "";
      frame.push(model?.settingsOverlay
        ? "  \x1b[2msettings · esc close · ↑↓ choose · ←→ adjust · space toggle · enter commit\x1b[0m"
        : `${modeHint}${keybar}`);
    }

    const bounded = frame.slice(0, rows);
    while (bounded.length < rows) bounded.push("");
    const output = bounded.map((line) => `${fitTheaterLine(line, frameWidth)}\x1b[K`).join("\n");
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
  // Theater is the default on a full TTY (the dashboard); CONCH_TUI=footer opts out.
  return stdoutTTY && stdinTTY && env.CONCH_TUI !== "footer";
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
    try {
      renderer.shutdown();
    } finally {
      if (input.isTTY && input.setRawMode) {
        try {
          input.setRawMode(false);
        } catch {}
      }
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

/** Set the committed transcript rendered before the current theater partial. */
export function setTranscriptPrefix(prefix: string): void {
  live = { ...live, transcriptPrefix: prefix };
  activeRenderer.live(live);
}

export function setState(state: ConchState, label = "", partial = ""): void {
  const transition = state !== live.state || label !== live.label; // ignore partial-only updates
  const reading = label && label === live.label ? live.reading : undefined;
  const transcriptPrefix = live.transcriptPrefix;
  live = {
    state,
    label,
    partial,
    ...(transcriptPrefix !== undefined ? { transcriptPrefix } : {}),
    ...(reading ? { reading } : {}),
  };
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
      if (end === -1) continue; // malformed/untrusted escape: drop it and progress
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

function fitTheaterLine(text: string, width: number): string {
  // Preserve renderer-owned SGR while dropping all other terminal controls from
  // transcript/session text before it reaches the alternate screen.
  const safe = text
    .replace(/\x1b(?!\[[0-9;]*m)/g, "")
    .replace(/[\u0000-\u001a\u001c-\u001f\u007f]/g, "");
  if (terminalCellWidth(safe) <= width) return fitToWidth(safe, width);
  const target = Math.max(0, width - 1);
  let cells = 0;
  let out = "";
  for (let index = 0; index < safe.length;) {
    if (safe[index] === "\x1b") {
      const end = safe.indexOf("m", index);
      if (end === -1) break;
      out += safe.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const codePoint = safe.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    const cellWidth = codePointWidth(codePoint);
    if (cells + cellWidth > target) break;
    out += character;
    cells += cellWidth;
    index += character.length;
  }
  return fitToWidth(`${out}…\x1b[0m`, width);
}
