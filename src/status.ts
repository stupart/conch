/**
 * Daemon state, made visible through:
 *  - a live terminal renderer (the legacy footer or opt-in theater mode)
 *  - /tmp/conch-state.json for anything else (menu-bar apps, status bars)
 *  - /tmp/conch-sessions.json for versioned per-session snapshots
 */
import {
  appendFileSync,
  closeSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  dashboardPanelLines,
  dashboardRowsForModel,
  type PanelConchState,
  type PanelLiveState,
  type PanelModel,
  type PanelRowModel,
  type PublishedState,
} from "./panel.ts";
import { toClipboard } from "./inject.ts";
import { buildClipboardEscape, type MouseEvent } from "./theater-mouse.ts";
import {
  TheaterSelection,
  type SelectionDocumentLine,
} from "./theater-selection.ts";

export type ConchState = PanelConchState;
export type LiveState = PanelLiveState;

// Exported as a stable path for external consumers (menu-bar apps, status bars).
export const STATE_FILE = "/tmp/conch-state.json";
export const SESSIONS_FILE = "/tmp/conch-sessions.json";
// Every log line is always appended here (for debugging) but only shown in the
// pane when logs are toggled on — the dashboard stays clean by default.
export const LOG_FILE = "/tmp/conch-daemon.log";

/**
 * Publish a whole session snapshot with a same-directory atomic rename.
 * State publication is best-effort and must never interrupt the live renderer.
 */
export function publishSessionsFile(
  state: PublishedState,
  path: string = SESSIONS_FILE,
): void {
  const directory = dirname(path);
  const temp = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(state) + "\n", "utf8");
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } catch {
    // External state is advisory; a missing/unwritable /tmp must not break conch.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      unlinkSync(temp);
    } catch {}
  }
}

export const ALT_SCREEN_ENTER = "\x1b[?1049h\x1b[?25l";
export const ALT_SCREEN_RESTORE = "\x1b[?1049l\x1b[?25h";
// DECSET 1000 reports press/release/wheel, 1002 adds button-motion,
// 1003 adds passive motion, and 1006 selects the unambiguous SGR encoding.
export const MOUSE_TRACKING_ENABLE =
  "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";
export const MOUSE_TRACKING_DISABLE =
  "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

export type TheaterPointerInput = Extract<
  MouseEvent,
  { kind: "down" | "drag" | "up" }
>;

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
  /** Theater-only interaction seams; absent on the byte-frozen footer. */
  scrollPane?(deltaLines: number): void;
  pointerEvent?(event: TheaterPointerInput): void;
  clearSelection?(): boolean;
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
  /** Native clipboard safety net; omitted by renderer tests. */
  copy?(text: string): void | Promise<void>;
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
    copy: (text) => toClipboard(text),
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

function stringIndexAtCell(text: string, targetCell: number): number {
  const target = Math.max(0, Math.trunc(targetCell));
  let cells = 0;
  let index = 0;
  for (const character of text) {
    const nextCells = cells + codePointWidth(character.codePointAt(0)!);
    if (nextCells > target) break;
    cells = nextCells;
    index += character.length;
  }
  return index;
}

function wrapPlainText(text: string, width: number): Array<{ text: string; start: number; end: number }> {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || width < 1) return [];
  const lines: Array<{ text: string; start: number; end: number }> = [];
  let offset = 0;
  while (offset < normalized.length) {
    const remaining = normalized.slice(offset);
    if (terminalCellWidth(remaining) <= width) {
      lines.push({ text: remaining, start: offset, end: normalized.length });
      break;
    }

    let cells = 0;
    let boundary = 0;
    let lastSpace = -1;
    for (const character of remaining) {
      const characterWidth = codePointWidth(character.codePointAt(0)!);
      if (cells + characterWidth > width) break;
      if (character === " ") lastSpace = boundary;
      cells += characterWidth;
      boundary += character.length;
    }
    // Always make progress for an unexpectedly narrow pane containing a wide
    // glyph. fitTheaterLine will safely elide that glyph if it cannot fit.
    if (boundary === 0) boundary = remaining.codePointAt(0)! > 0xffff ? 2 : 1;
    const take = lastSpace > 0 ? lastSpace : boundary;
    const line = remaining.slice(0, take);
    lines.push({ text: line, start: offset, end: offset + line.length });
    offset += take;
    while (normalized[offset] === " ") offset++;
  }
  return lines;
}

const THEATER_STATUS_ICON: Record<string, string> = {
  review: "\x1b[33m⭐\x1b[39m",
  needs: "\x1b[33m❗\x1b[39m",
  waiting: "\x1b[32m○\x1b[39m",
  working: "\x1b[36m●\x1b[39m",
  idle: "\x1b[2m·\x1b[22m",
  paused: "\x1b[2m⏸\x1b[22m",
  muted: "\x1b[2m🔇\x1b[22m",
};

const THEATER_STATUS_COPY = {
  needs: "need you",
  review: "review",
  waiting: "waiting",
  working: "working",
} as const;

/** One quiet, live summary for the theater's top status line. */
export function theaterStatusHeader(model: PanelModel): string {
  const counts: Record<keyof typeof THEATER_STATUS_COPY, number> = {
    needs: 0,
    review: 0,
    waiting: 0,
    working: 0,
  };
  for (const row of model.rows) {
    if (row.status) counts[row.status]++;
  }

  const parts = ["conch"];
  for (const status of ["needs", "review", "waiting", "working"] as const) {
    const count = counts[status];
    if (!count) continue;
    parts.push(`${THEATER_STATUS_ICON[status]} ${count} ${THEATER_STATUS_COPY[status]}`);
  }
  const liveStateIsMuted = model.live.state === "muted";
  const liveStateIsPaused = model.live.state === "paused";
  if (model.mode.muted || liveStateIsMuted) parts.push("muted");
  if (model.mode.paused || liveStateIsPaused) parts.push("paused");
  if (model.mode.holding > 0) parts.push(`holding ${model.mode.holding}`);
  if (
    model.live.state !== "idle"
    && !liveStateIsMuted
    && !liveStateIsPaused
  ) {
    parts.push(
      `${model.live.state}${model.live.label ? ` ‹${model.live.label}›` : ""}`,
    );
  }
  return `  ${parts.join(" · ")}`;
}

/** Compact age for a latched epoch-ms timestamp. */
export function relativeAge(at: number, now: number): string {
  const elapsed = Number.isFinite(at) && Number.isFinite(now)
    ? Math.max(0, now - at)
    : 0;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return "<1m";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`;
  return `${Math.floor(elapsed / day)}d`;
}

function rowState(row: PanelRowModel): string {
  if (row.muted) return "muted";
  if (row.paused) return "paused";
  // The top line owns conch's live activity; the ledger keeps each session's
  // underlying status so speaking/recording is never announced twice.
  return row.status ?? "idle";
}

function fullStatus(row: PanelRowModel): string {
  if (row.muted) return "\x1b[2m🔇 muted\x1b[22m";
  if (row.paused) return "\x1b[2m⏸ paused\x1b[22m";
  switch (row.status) {
    case "review": return "\x1b[33m⭐ needs review\x1b[39m";
    case "needs": return "\x1b[33m❗ needs a response\x1b[39m";
    case "waiting": return "\x1b[32m○ waiting for you\x1b[39m";
    case "working": return "\x1b[36m● working…\x1b[39m";
    default: return "\x1b[2m· idle\x1b[22m";
  }
}

function inlineRowDetail(row: PanelRowModel): string {
  if (row.status === "review") return row.review?.summary ?? row.detail ?? "";
  if (row.status === "needs") return row.detail ?? "";
  return "";
}

function rowLead(row: PanelRowModel): string {
  const cursor = row.navSelected
    ? "\x1b[38;2;88;201;212m▸\x1b[39m"
    : " ";
  return `${cursor} `;
}

function appendRelativeAge(
  left: string,
  age: string,
  width: number,
): string {
  if (!age) return padVisible(left, width);
  const ageWidth = visibleLength(age);
  const leftWidth = Math.max(0, width - ageWidth - 1);
  if (leftWidth < 1) return padVisible(`\x1b[2m${age}\x1b[22m`, width);
  return `${padVisible(left, leftWidth)} \x1b[2m${age}\x1b[22m`;
}

function compactLedgerLeft(
  row: PanelRowModel,
  width: number,
  lead: string,
): string {
  const icon = THEATER_STATUS_ICON[rowState(row)] ?? THEATER_STATUS_ICON.idle!;
  const detail = inlineRowDetail(row);
  const leadWidth = visibleLength(lead);
  const iconWidth = visibleLength(icon);
  if (!detail) {
    const labelWidth = Math.max(1, width - leadWidth - iconWidth - 1);
    return `${lead}${padVisible(row.label, labelWidth)} ${icon}`;
  }

  const fieldsWidth = Math.max(2, width - leadWidth - iconWidth - 2);
  const labelWidth = Math.max(1, Math.min(12, Math.floor(fieldsWidth / 2)));
  const detailWidth = Math.max(1, fieldsWidth - labelWidth);
  return `${lead}${padVisible(row.label, labelWidth)} ${icon} ${fitTheaterLine(detail, detailWidth)}`;
}

function fullLedgerLeft(
  row: PanelRowModel,
  width: number,
  lead: string,
): string {
  const status = fullStatus(row);
  const detail = inlineRowDetail(row);
  const labelWidth = Math.max(
    1,
    Math.min(30, width - visibleLength(lead) - visibleLength(status) - 2),
  );
  return `${lead}${padVisible(row.label, labelWidth)} ${status}${
    detail ? ` \x1b[2m(${detail})\x1b[22m` : ""
  }`;
}

function theaterLedgerRow(
  row: PanelRowModel,
  width: number,
  compact: boolean,
  now: number,
): string {
  // Reserve a 1-col gutter on EVERY row (accent bar when active, blank space
  // otherwise) so a row's text never shifts as it gains or loses the highlight.
  const bodyWidth = Math.max(1, width - 1);
  const age = row.status && row.at !== undefined && row.at > 0
    ? relativeAge(row.at, now)
    : "";
  const leftWidth = Math.max(1, bodyWidth - (age ? visibleLength(age) + 1 : 0));
  const lead = rowLead(row);
  const left = compact
    ? compactLedgerLeft(row, leftWidth, lead)
    : fullLedgerLeft(row, leftWidth, lead);
  let body = appendRelativeAge(left, age, bodyWidth);
  if (row.muted || row.paused) body = `\x1b[2m${body}\x1b[22m`;
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

interface TheaterContentView {
  lines: string[];
  doc: SelectionDocumentLine[];
  contentKey: string;
  fingerprint: string;
  viewStart: number;
  maxOffset: number;
  offset: number;
  viewportHeight: number;
  scrollable: boolean;
  bottomAnchored: boolean;
}

function clampPaneOffset(value: number, maximum: number): number {
  return Math.max(0, Math.min(Math.trunc(value), Math.max(0, maximum)));
}

/** Selection/copy documents never retain terminal controls from logs/transcripts. */
function plainTheaterDocumentText(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b./g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, "");
}

/** Collision-free identity: stale coordinates must fail closed for every document rewrite. */
function theaterDocumentFingerprint(
  contentKey: string,
  width: number,
  doc: readonly SelectionDocumentLine[],
): string {
  return `${contentKey}\u0000${width}\u0000${
    doc.map((line) => `${line.text.length}:${line.text}`).join("")
  }`;
}

function selectedContentLine(
  text: string,
  lineIndex: number,
  fingerprint: string,
  selection: TheaterSelection,
): string {
  const span = selection.matchesFingerprint(fingerprint)
    ? selection.spanFor(lineIndex, text.length)
    : null;
  if (!span) return `\x1b[2m${text}\x1b[0m`;
  return `\x1b[2m${text.slice(0, span.start)}\x1b[7m${text.slice(span.start, span.end)}\x1b[27m${text.slice(span.end)}\x1b[0m`;
}

function scrollableTheaterContent(
  doc: SelectionDocumentLine[],
  contentKey: string,
  width: number,
  height: number,
  paneOffset: number,
  selection: TheaterSelection,
  options: { note?: string; bottomAnchored?: boolean } = {},
): TheaterContentView {
  const note = options.note ?? "";
  const viewportHeight = Math.max(0, height - (note ? 1 : 0));
  const maxOffset = Math.max(0, doc.length - viewportHeight);
  const offset = clampPaneOffset(paneOffset, maxOffset);
  const bottomAnchored = options.bottomAnchored ?? false;
  const viewStart = bottomAnchored ? maxOffset - offset : offset;
  const fingerprint = theaterDocumentFingerprint(contentKey, width, doc);
  const lines = doc
    .slice(viewStart, viewStart + viewportHeight)
    .map((line, index) =>
      selectedContentLine(line.text, viewStart + index, fingerprint, selection)
    );
  while (lines.length < viewportHeight) lines.push("");
  if (note) lines.push(`\x1b[2m${note}\x1b[0m`);
  return {
    lines,
    doc,
    contentKey,
    fingerprint,
    viewStart,
    maxOffset,
    offset,
    viewportHeight,
    scrollable: true,
    bottomAnchored,
  };
}

function staticTheaterContent(
  lines: string[],
  doc: SelectionDocumentLine[],
  contentKey: string,
  width: number,
  height: number,
  viewStart: number,
  viewportHeight: number,
  note: string,
): TheaterContentView {
  const visible = lines.slice(0, viewportHeight);
  while (visible.length < viewportHeight) visible.push("");
  if (note) visible.push(`\x1b[2m${note}\x1b[0m`);
  while (visible.length < height) visible.push("");
  return {
    lines: visible.slice(0, height),
    doc,
    contentKey,
    fingerprint: theaterDocumentFingerprint(contentKey, width, doc),
    viewStart,
    maxOffset: 0,
    offset: 0,
    viewportHeight,
    scrollable: false,
    bottomAnchored: false,
  };
}

function theaterContentLines(
  model: PanelModel,
  width: number,
  height: number,
  logLines: readonly string[],
  paneOffset: number,
  selection: TheaterSelection,
): TheaterContentView {
  if (height <= 0 || width <= 0) {
    return staticTheaterContent([], [], "closed", width, 0, 0, 0, "");
  }
  if (logsVisible) {
    const doc = logLines.flatMap((line) =>
      wrapPlainText(plainTheaterDocumentText(line), width).map(({ text }) => ({ text }))
    );
    return scrollableTheaterContent(
      doc,
      "logs",
      width,
      height,
      paneOffset,
      selection,
      { bottomAnchored: true },
    );
  }

  const state = model.live.state;
  const selectedRow = model.rows.find((row) => row.navSelected);
  if (selectedRow) {
    const selectedPreview = model.preview?.sessionId === selectedRow.sessionId
      ? model.preview
      : null;
    const selectedReply = model.reply?.sessionId === selectedRow.sessionId
      ? model.reply
      : null;
    const selectedText = selectedRow.active && state === "speaking" && selectedReply
      ? model.live.reading?.text || selectedReply.text
      : selectedPreview?.text || selectedReply?.text || "";
    const doc = wrapPlainText(
      plainTheaterDocumentText(selectedText),
      width,
    ).map(({ text }) => ({ text }));
    return scrollableTheaterContent(
      doc,
      `selected:${selectedRow.sessionId}`,
      width,
      height,
      paneOffset,
      selection,
      { note: `‹${selectedRow.label}› · esc back · space talk` },
    );
  }

  const capturing = state === "listening" || state === "recording";
  const transcribing = state === "transcribing";
  const note = state === "speaking"
    ? "space to cut in · the mic opens when it finishes"
    : capturing
      ? "pause to send · space to stop · say send to submit now"
      : "";

  if (capturing || transcribing) {
    // With no parked selection, keep the words currently headed toward the
    // active session visible while the mic is open or finalizing.
    const prefix = model.live.transcriptPrefix;
    const transcript = `${prefix ? `${prefix} ` : ""}${model.live.partial}${capturing ? "▌" : ""}`;
    const transcriptDoc = wrapPlainText(transcript, width).map(({ text }) => ({ text }));
    const reply = plainTheaterDocumentText(model.reply?.text ?? "");
    const replyDoc = reply
      ? wrapPlainText(`↪ replying to · ${reply}`, width).map(({ text }) => ({ text }))
      : [];
    const minimumConversationHeight =
      (replyDoc.length ? 1 : 0) + (transcriptDoc.length ? 1 : 0);
    // Help text yields before either side of the conversation. Two rows can
    // therefore show quote + transcript; one row always belongs to dictation.
    const conversationNote = note && (
      minimumConversationHeight === 0 || height > minimumConversationHeight
    ) ? note : "";
    const available = Math.max(0, height - (conversationNote ? 1 : 0));
    // Give the live transcript every row it needs when it fits. If it does not,
    // retain only one quoted row and keep the transcript tail beside the cursor.
    // At a one-row extreme the quote yields entirely to current dictation.
    const minimumTranscriptHeight = transcriptDoc.length ? 1 : 0;
    const replyHeight = replyDoc.length && available > minimumTranscriptHeight
      ? Math.min(replyDoc.length, Math.max(1, available - Math.max(1, transcriptDoc.length)))
      : 0;
    const transcriptHeight = Math.max(0, available - replyHeight);
    const transcriptStart = Math.max(0, transcriptDoc.length - transcriptHeight);
    const visibleReply = replyDoc.slice(0, replyHeight);
    const visibleTranscript = transcriptDoc.slice(transcriptStart);
    const visibleDoc = [...visibleReply, ...visibleTranscript];
    return staticTheaterContent(
      [
        ...visibleReply.map((line) => `\x1b[2m${line.text}\x1b[0m`),
        ...visibleTranscript.map((line) => line.text),
      ],
      visibleDoc,
      `live:${state}:${model.live.label}`,
      width,
      height,
      0,
      available,
      conversationNote,
    );
  }

  const reading = model.live.reading;
  const text = plainTheaterDocumentText(reading?.text ?? model.reply?.text ?? "");
  const wrapped = wrapPlainText(text, width);
  const doc = wrapped.map(({ text: line }) => ({ text: line }));
  if (state === "speaking") {
    const available = Math.max(0, height - (note ? 1 : 0));
    const spokenChars = reading?.spokenChars ?? model.reply?.spokenChars ?? 0;
    const foundFrontier = wrapped.findIndex((line) => spokenChars <= line.end);
    const frontier = foundFrontier === -1 ? Math.max(0, wrapped.length - 1) : foundFrontier;
    const maxStart = Math.max(0, wrapped.length - available);
    const start = Math.max(0, Math.min(maxStart, frontier - Math.floor(available / 2)));
    return staticTheaterContent(
      wrapped.slice(start, start + available).map((line) => readingLine(line, spokenChars)),
      doc,
      `live:speaking:${model.reply?.sessionId ?? model.live.label}`,
      width,
      height,
      start,
      available,
      note,
    );
  }

  return scrollableTheaterContent(
    doc,
    `reply:${model.reply?.sessionId ?? ""}`,
    width,
    height,
    paneOffset,
    selection,
  );
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

function theaterSessionActionsOverlay(
  base: string[],
  overlay: NonNullable<PanelModel["sessionActionsOverlay"]>,
  width: number,
  height: number,
): string[] {
  if (width < 12 || height < 4) {
    const compact = [...base];
    while (compact.length < height) compact.push("");
    if (height) compact[Math.floor(height / 2)] = " actions · esc close";
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
  const keyWidth = Math.max(6, Math.min(14, ...overlay.rows.map((row) => row.key.length)));
  const valueWidth = Math.max(5, Math.min(
    20,
    ...overlay.rows.map((row) => row.value.length + (row.editing ? 1 : 0)),
  ));
  const lines: string[] = [];
  lines.push(`\x1b[2m╭${"─".repeat(innerWidth)}╮\x1b[0m`);
  lines.push(`\x1b[2m│\x1b[0m${padVisible(
    ` actions · ${overlay.target.label} · ↑↓ choose · esc close`,
    innerWidth,
  )}\x1b[2m│\x1b[0m`);
  for (const row of visibleRows) {
    const cursor = row.selected ? "›" : " ";
    const value = `${row.value}${row.editing ? "▌" : ""}`;
    const ack = row.ack ? ` · \x1b[2m${row.ack}\x1b[22m` : "";
    const text = `${cursor} ${row.key.padEnd(keyWidth)} · ${value.padEnd(valueWidth)}${ack} · ${row.help}`;
    const fitted = padVisible(text, innerWidth);
    const styled = row.confirming
      ? `\x1b[1;31m\x1b[48;2;48;24;24m${fitted}\x1b[0m`
      : row.selected
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
export function createTheaterRenderer(
  io: RendererIO = processRendererIO(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Renderer {
  interface PaneLayout {
    left: number;
    top: number;
    width: number;
    height: number;
    viewStart: number;
    maxOffset: number;
    doc: SelectionDocumentLine[];
    fingerprint: string;
    scrollable: boolean;
    bottomAnchored: boolean;
  }

  const mouseEnabled = env.CONCH_NO_MOUSE !== "1";
  let entered = false;
  let model: PanelModel | null = null;
  let keybar = "";
  let paneOffset = 0;
  let paneContentKey = "";
  let paneLayout: PaneLayout | null = null;
  const selection = new TheaterSelection();
  const logLines: string[] = [];

  const repaint = (): void => {
    if (!entered) return;
    const columns = Math.max(1, io.columns());
    const rows = Math.max(1, io.rows());
    const frameWidth = Math.max(1, columns - 1); // never arm the terminal's wrap column
    const frame: string[] = [];
    const overlayOpen = Boolean(model?.settingsOverlay || model?.sessionActionsOverlay);
    // Forced logs/help must remain visible on narrow terminals; below the normal
    // split threshold they temporarily own the body, like a narrow modal.
    const contentOnly = (overlayOpen && columns < 36) || (logsVisible && columns < 52);
    const paneOpen =
      overlayOpen || logsVisible || ((model?.panelOpen ?? true) && columns >= 52);
    let ledgerWidth = frameWidth;
    if (contentOnly) ledgerWidth = 0;
    else if (paneOpen && overlayOpen) {
      ledgerWidth = Math.min(28, Math.max(16, Math.floor(columns * 0.28)));
    } else if (paneOpen) {
      ledgerWidth = Math.min(34, Math.max(22, Math.floor(columns * 0.3)));
    }
    const contentWidth = paneOpen
      ? Math.max(1, frameWidth - ledgerWidth - (contentOnly ? 0 : 3))
      : 0;

    frame.push(model ? theaterStatusHeader(model) : "  conch");
    if (rows > 1) {
      frame.push(`\x1b[2m${"─".repeat(Math.max(1, columns - 1))}\x1b[0m`);
    }
    const bodyHeight = Math.max(0, rows - 3);
    let content: string[] = [];
    if (model && paneOpen) {
      let view = theaterContentLines(
        model,
        contentWidth,
        bodyHeight,
        logLines,
        paneOffset,
        selection,
      );
      if (view.contentKey !== paneContentKey) {
        paneContentKey = view.contentKey;
        paneOffset = 0;
        selection.clear();
        view = theaterContentLines(
          model,
          contentWidth,
          bodyHeight,
          logLines,
          paneOffset,
          selection,
        );
      }
      paneOffset = view.offset; // clamp after content shrink or terminal resize
      selection.clearIfFingerprintChanged(view.fingerprint);
      content = view.lines;
      paneLayout = {
        left: contentOnly ? 0 : ledgerWidth + 3,
        top: 2,
        width: contentWidth,
        height: view.viewportHeight,
        viewStart: view.viewStart,
        maxOffset: view.maxOffset,
        doc: view.doc,
        fingerprint: view.fingerprint,
        scrollable: view.scrollable,
        bottomAnchored: view.bottomAnchored,
      };
    } else {
      paneLayout = null;
      selection.clear();
    }
    if (model?.settingsOverlay && paneOpen) {
      content = theaterSettingsOverlay(content, model.settingsOverlay, contentWidth, bodyHeight);
    } else if (model?.sessionActionsOverlay && paneOpen) {
      content = theaterSessionActionsOverlay(
        content,
        model.sessionActionsOverlay,
        contentWidth,
        bodyHeight,
      );
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
    const now = Date.now();

    for (let index = 0; index < bodyHeight; index++) {
      const ledger = !contentOnly && ledgerRows[index]
        ? theaterLedgerRow(
          ledgerRows[index]!,
          ledgerWidth,
          paneOpen,
          now,
        )
        : " ".repeat(ledgerWidth);
      frame.push(contentOnly
        ? content[index] ?? ""
        : paneOpen
        ? `${ledger} \x1b[2m│\x1b[0m ${content[index] ?? ""}`
        : ledger);
    }
    if (rows > 2) {
      frame.push(
        model?.settingsOverlay
          ? "  \x1b[2msettings · esc close · ↑↓ choose · ←→ adjust · space toggle · enter commit\x1b[0m"
          : model?.sessionActionsOverlay
            ? "  \x1b[2mactions · esc close · ↑↓ choose · ←→ adjust · enter select\x1b[0m"
            : keybar,
      );
    }

    const bounded = frame.slice(0, rows);
    while (bounded.length < rows) bounded.push("");
    const output = bounded.map((line) => `${fitTheaterLine(line, frameWidth)}\x1b[K`).join("\n");
    io.write(`\x1b[H${output}`);
  };

  const shiftPaneOffset = (deltaLines: number): boolean => {
    const layout = paneLayout;
    if (
      !layout?.scrollable
      || layout.maxOffset <= 0
      || !Number.isFinite(deltaLines)
      || deltaLines === 0
    ) return false;
    const logicalDelta = layout.bottomAnchored ? -deltaLines : deltaLines;
    const next = clampPaneOffset(paneOffset + logicalDelta, layout.maxOffset);
    if (next === paneOffset) return false;
    paneOffset = next;
    return true;
  };

  const currentViewStart = (layout: PaneLayout): number =>
    layout.bottomAnchored ? layout.maxOffset - paneOffset : paneOffset;

  const pointInPane = (
    event: TheaterPointerInput,
    layout: PaneLayout,
    clampHorizontal = false,
  ): { line: number; column: number } | null => {
    const row = event.row - 1;
    const column = event.column - 1;
    if (row < layout.top || row >= layout.top + layout.height) return null;
    if (!clampHorizontal && (column < layout.left || column >= layout.left + layout.width)) {
      return null;
    }
    const line = layout.viewStart + row - layout.top;
    const documentLine = layout.doc[line];
    if (!documentLine) return null;
    return {
      line,
      column: stringIndexAtCell(
        documentLine.text,
        Math.max(0, column - layout.left),
      ),
    };
  };

  const copySelection = (layout: PaneLayout): void => {
    const text = selection.extract(layout.doc, layout.fingerprint);
    if (!text) return;
    try {
      void Promise.resolve(io.copy?.(text)).catch(() => {});
    } catch {}
    const escape = buildClipboardEscape(text, Boolean(env.TMUX));
    if (escape) {
      try {
        io.write(escape);
      } catch {}
    }
    logAbove(`copied ${text.length} chars`);
  };

  const pointerEvent = (event: TheaterPointerInput): void => {
    if (!mouseEnabled || !entered) return;
    const layout = paneLayout;

    if (event.kind === "down") {
      if (event.button !== 0 || !layout?.scrollable) {
        if (selection.clear()) repaint();
        return;
      }
      const point = pointInPane(event, layout);
      if (!point) {
        if (selection.clear()) repaint();
        return;
      }
      selection.begin(point, layout.fingerprint);
      repaint();
      return;
    }

    if (event.kind === "drag") {
      if (event.button !== 0 || !layout?.scrollable || !selection.dragging) return;
      const row = event.row - 1;
      let changed = false;
      if (row < layout.top || row >= layout.top + layout.height) {
        const above = row < layout.top;
        changed = shiftPaneOffset(above ? -1 : 1);
        const viewStart = currentViewStart(layout);
        const line = above
          ? viewStart
          : Math.min(layout.doc.length - 1, viewStart + Math.max(0, layout.height - 1));
        const documentLine = layout.doc[line];
        if (documentLine) {
          changed = selection.update({
            line,
            column: above ? 0 : documentLine.text.length,
          }) || changed;
        }
      } else {
        const point = pointInPane(event, layout, true);
        if (point) changed = selection.update(point);
      }
      if (changed) repaint();
      return;
    }

    if (!selection.dragging || !layout) return;
    const point = pointInPane(event, layout, true);
    const changed = point ? selection.update(point) : false;
    selection.end();
    if (selection.active) copySelection(layout);
    if (changed) repaint();
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
    scrollPane(deltaLines): void {
      if (!mouseEnabled || !shiftPaneOffset(deltaLines)) return;
      repaint();
    },
    pointerEvent,
    clearSelection(): boolean {
      const changed = selection.clear();
      if (changed) repaint();
      return changed;
    },
    enter(): void {
      if (entered) return;
      entered = true;
      io.write(ALT_SCREEN_ENTER);
      if (mouseEnabled) io.write(MOUSE_TRACKING_ENABLE);
    },
    shutdown(): void {
      if (!entered) return;
      entered = false; // make restoration idempotent before touching the writer
      paneLayout = null;
      selection.clear();
      try {
        if (mouseEnabled) io.write(MOUSE_TRACKING_DISABLE);
      } finally {
        io.write(ALT_SCREEN_RESTORE);
      }
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
  activeRenderer = theater ? createTheaterRenderer(io, env) : createFooterRenderer(io);
  return { kind: activeRendererKind, renderer: activeRenderer };
}

/** Scroll the current theater document in screen-line direction. */
export function scrollTheaterPane(deltaLines: number): void {
  if (activeRendererKind !== "theater") return;
  activeRenderer.scrollPane?.(deltaLines);
}

/** Route one decoded SGR press/drag/release into the current theater pane. */
export function theaterPointerEvent(event: TheaterPointerInput): void {
  if (activeRendererKind !== "theater") return;
  activeRenderer.pointerEvent?.(event);
}

/** Clear the in-app highlight; true lets Escape keep a parked cursor for one press. */
export function clearTheaterSelection(): boolean {
  if (activeRendererKind !== "theater") return false;
  return activeRenderer.clearSelection?.() ?? false;
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
let onLiveData: (() => void) | null = null;

function sameLiveData(left: LiveState, right: LiveState): boolean {
  return left.state === right.state
    && left.label === right.label
    && left.partial === right.partial
    && left.transcriptPrefix === right.transcriptPrefix
    && (
      left.reading === right.reading
      || (
        left.reading !== undefined
        && right.reading !== undefined
        && left.reading.text === right.reading.text
        && Object.is(left.reading.spokenChars, right.reading.spokenChars)
      )
    );
}

export function getLiveState(): LiveState {
  return live;
}
export function onLiveChange(cb: () => void): void {
  onLive = cb;
}

/** Observe every live-data mutation, including same-state partial/progress updates. */
export function onLiveDataChange(cb: (() => void) | null): void {
  onLiveData = cb;
}

export function setReadingProgress(text: string, spokenChars: number): void {
  const next: LiveState = {
    ...live,
    reading: { text, spokenChars: Math.max(0, Math.min(spokenChars, text.length)) },
  };
  if (sameLiveData(live, next)) return;
  live = next;
  // Daemon capture is renderer-independent. Preserve footer's established byte
  // output while the theater continues repainting its read-along pane.
  if (activeRendererKind === "theater") activeRenderer.live(live);
  onLiveData?.();
}

export function clearReadingProgress(): void {
  if (!live.reading) return;
  const { reading: _reading, ...rest } = live;
  live = rest;
  if (activeRendererKind === "theater") activeRenderer.live(live);
  onLiveData?.();
}

/** Set the committed transcript published alongside the current live partial. */
export function setTranscriptPrefix(prefix: string): void {
  const next: LiveState = { ...live, transcriptPrefix: prefix };
  if (sameLiveData(live, next)) return;
  live = next;
  if (activeRendererKind === "theater") activeRenderer.live(live);
  onLiveData?.();
}

export function setState(state: ConchState, label = "", partial = ""): void {
  // Full panel reconstruction is transition-only; onLiveData below still sees
  // every meaningful same-state partial update.
  const transition = state !== live.state || label !== live.label;
  const reading = label && label === live.label ? live.reading : undefined;
  const transcriptPrefix = live.transcriptPrefix;
  const next: LiveState = {
    state,
    label,
    partial,
    ...(transcriptPrefix !== undefined ? { transcriptPrefix } : {}),
    ...(reading ? { reading } : {}),
  };
  const dataChanged = !sameLiveData(live, next);
  live = next;
  void Bun.write(STATE_FILE, JSON.stringify({ state, label, partial, ts: Date.now() }) + "\n");
  activeRenderer.live(live);
  if (transition) onLive?.(); // repaint the panel so the active row shows the new live state
  if (dataChanged) onLiveData?.();
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
