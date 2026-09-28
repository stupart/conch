import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublishedConversation } from "./conversation.ts";
import { sendControlMessage } from "./settings.ts";
import type { TerminalScreenReply } from "./terminal-mirror.ts";

/**
 * `conch parity <session>`: one picture of a session's own terminal beside conch's view of the same conversation, and
 * a delivery check — is the last message conch sent to that session in its terminal's screen or scrollback?
 *
 * Tyler: "it is useful for u to make sure the terminal matches conch in one image. And that messages are properly
 * sent." It is a debugging command for agents working on conch, run only on explicit invocation, locally:
 *
 *  - The terminal comes from the daemon's `terminal-screen` (terminal-mirror.ts), the same read the Mac app's Terminal
 *    Mirror makes, with the scrollback as well. A tmux pane is drawn from its own text in its own colours; a Terminal
 *    window is photographed by `screencapture -l` (this process's Screen Recording, never the app's), or drawn from its
 *    text when it can't be.
 *  - conch's side is the Mac app's own picture of its window, the file-sentinel `conch shot` uses, after the app is
 *    asked to show this session. Without the app (`--no-app`, or it isn't running) it is conch's published conversation
 *    for the session, drawn as text: the same record the app draws from.
 *  - The message is `--text`, else the newest thing you sent in conch's conversation for the session.
 *  - The picture is composed by AppKit through `osascript -l JavaScript`: no dependency, like everything else here.
 *
 * The last line printed is the verdict, `PASS`, `FAIL` or `SKIP` and the session and message, for an agent to read.
 * Exit 0 on PASS, 1 on FAIL, 2 when nothing could be checked.
 */

// MARK: - Matching a message against a terminal

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;

/** A terminal's text without its escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * What is compared: no escapes, no whitespace (a TUI wraps a message wherever its box ends, mid-word too, and indents
 * the rest), no box drawing or block elements (the borders and gutters it draws those lines between), no controls.
 * Everything else is kept exactly, case included.
 */
const NOISE = /[\s\u0000-\u001f\u007f\u00a0\u200b-\u200d\u2060\ufeff\ufe0e\ufe0f\u2500-\u259f]/gu;
export function matchable(text: string): string {
  return stripAnsi(text).normalize("NFC").replace(NOISE, "");
}

/**
 * The fewest characters of a message's END that count, when the terminal's kept text begins partway through it: the
 * start scrolled out of what the terminal keeps (or past what one reply can carry), and the rest is there.
 */
export const CUT_MINIMUM = 64;

export type DeliveryVerdict =
  | { pass: true; where: "screen" | "scrollback"; of: number }
  | { pass: true; where: "cut"; kept: number; of: number }
  | { pass: false; of: number };

/**
 * Is `message` in the terminal? Its screen first, then its scrollback (which, from tmux, runs on through the screen).
 * Null when the message has nothing in it to look for.
 */
export function checkDelivery(message: string, terminal: { screen?: string; history?: string }): DeliveryVerdict | null {
  const needle = matchable(message);
  if (!needle) return null;
  const of = needle.length;
  const screen = matchable(terminal.screen ?? "");
  if (screen.includes(needle)) return { pass: true, where: "screen", of };
  const kept = terminal.history === undefined ? screen : matchable(terminal.history);
  if (kept.includes(needle)) return { pass: true, where: "scrollback", of };
  for (let length = Math.min(needle.length - 1, kept.length); length >= CUT_MINIMUM; length--) {
    if (needle[needle.length - length] !== kept[0]) continue;
    if (kept.startsWith(needle.slice(needle.length - length))) return { pass: true, where: "cut", kept: length, of };
  }
  return { pass: false, of };
}

/** A message, short enough to name on one line. */
export function excerpt(message: string, length = 60): string {
  const flat = stripAnsi(message).replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

// MARK: - Whose session, and what conch sent it

export interface ParityRow {
  id: string;
  label: string;
  backend?: string;
  revealable?: boolean;
  noTerminal?: string;
  parentSessionId?: string;
}

/**
 * The session a query names, among the rows conch publishes: its id, then its label, then the start of its id, then
 * part of its label. More than one at the first step that matches is refused with the candidates, never guessed.
 */
export function resolveRow(rows: readonly ParityRow[], query: string): { row: ParityRow } | { error: string } {
  const q = query.trim().toLowerCase();
  if (!q) return { error: "name a session: its id or its label" };
  const sessions = rows.filter((row) => !row.parentSessionId);
  const steps: Array<(row: ParityRow) => boolean> = [
    (row) => row.id.toLowerCase() === q,
    (row) => row.label.toLowerCase() === q,
    (row) => q.length >= 4 && row.id.toLowerCase().startsWith(q),
    (row) => row.label.toLowerCase().includes(q),
  ];
  for (const step of steps) {
    const found = sessions.filter(step);
    if (found.length === 1) return { row: found[0]! };
    if (found.length > 1) {
      return { error: `"${query.trim()}" matches ${found.length} sessions; name one by id: ${found.map((row) => `${row.id} ("${row.label}")`).join(", ")}` };
    }
  }
  const live = sessions.map((row) => row.label).join(", ") || "none";
  return { error: `no session conch shows matches "${query.trim()}". Sessions: ${live}` };
}

/**
 * The newest thing you sent the session, as conch's own conversation shows it. A long one is published as its tail
 * after a "…" (`publishedConversation`), which is still a stretch of the message and is searched as one.
 */
export function lastSentMessage(conversation: PublishedConversation | undefined): { text: string; id: string; at?: number } | null {
  const items = conversation?.items ?? [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind !== "user" || !item.text.trim()) continue;
    const text = item.text.length > 4_000 && item.text.startsWith("…") ? item.text.slice(1) : item.text;
    return { text, id: item.id, ...(item.at === undefined ? {} : { at: item.at }) };
  }
  return null;
}

// MARK: - Drawing a terminal screen

/** One stretch of a line in one look, colours as `#rrggbb`. */
export interface DrawRun {
  t: string;
  fg: string;
  bg?: string;
  b?: 1;
  i?: 1;
  u?: 1;
  s?: 1;
}

/** Terminal's Basic profile in dark, as the Mac app's mirror draws it (ConchTerminalTheme.dark). */
export const TERMINAL_FOREGROUND = 0xE5E5E5;
export const TERMINAL_BACKGROUND = 0x1E1E1E;
const BASIC = [
  0x000000, 0x990000, 0x00A600, 0x999900, 0x0000B2, 0xB200B2, 0x00A6B2, 0xBFBFBF,
  0x666666, 0xE50000, 0x00D900, 0xE5E500, 0x0000FF, 0xE500E5, 0x00E5E5, 0xE5E5E5,
];

/** xterm's 256: the sixteen, the 6x6x6 cube, the greys. */
export function indexedColour(index: number): number {
  if (index < 16) return BASIC[index]!;
  if (index >= 232) {
    const level = 8 + 10 * (index - 232);
    return (level << 16) | (level << 8) | level;
  }
  const cube = index - 16;
  const step = (value: number) => (value === 0 ? 0 : 55 + 40 * value);
  return (step(Math.floor(cube / 36)) << 16) | (step(Math.floor(cube / 6) % 6) << 8) | step(cube % 6);
}

interface CellStyle {
  fg: number | null;
  bg: number | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  hidden: boolean;
  strike: boolean;
}

const plain = (): CellStyle => ({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, hidden: false, strike: false });

/** `5;n` or `2;r;g;b` (the colon form may carry an empty colour-space id before r). */
function extended(parts: Array<number | undefined>): number | null {
  const byte = (value: number | undefined) => (value !== undefined && Number.isInteger(value) && value >= 0 && value <= 255 ? value : null);
  if (parts[0] === 5 && parts.length >= 2) {
    const index = byte(parts[1]);
    return index === null ? null : indexedColour(index);
  }
  if (parts[0] === 2 && parts.length >= 4) {
    const [r, g, b] = parts.slice(-3).map(byte);
    return r === null || g === null || b === null ? null : (r! << 16) | (g! << 8) | b!;
  }
  return null;
}

/** One `ESC[…m`, in order: the same reading as ConchTerminalCellStyle.apply. */
function applySgr(style: CellStyle, parameters: string): CellStyle {
  if (/^[<=>?]/.test(parameters)) return style;
  let next = { ...style };
  const groups = parameters === "" ? [""] : parameters.split(";");
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    if (group.includes(":")) {
      const parts = group.split(":").map((part) => (part === "" ? undefined : Number(part)));
      if (parts[0] === 38) next.fg = extended(parts.slice(1)) ?? next.fg;
      else if (parts[0] === 48) next.bg = extended(parts.slice(1)) ?? next.bg;
      else if (parts[0] === 4) next.underline = (parts[1] ?? 1) !== 0;
      continue;
    }
    const code = group === "" ? 0 : Number(group);
    if (code === 0) next = plain();
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4 || code === 21) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 8) next.hidden = true;
    else if (code === 9) next.strike = true;
    else if (code === 22) { next.bold = false; next.dim = false; }
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code === 28) next.hidden = false;
    else if (code === 29) next.strike = false;
    else if (code >= 30 && code <= 37) next.fg = BASIC[code - 30]!;
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = BASIC[code - 40]!;
    else if (code === 49) next.bg = null;
    else if (code >= 90 && code <= 97) next.fg = BASIC[code - 90 + 8]!;
    else if (code >= 100 && code <= 107) next.bg = BASIC[code - 100 + 8]!;
    else if (code === 38 || code === 48 || code === 58) {
      // The colour's parts follow as codes of their own and are consumed here, so a `2` meant as green is never dim.
      const rest = groups.slice(index + 1).map((part) => (part === "" ? undefined : Number(part)));
      const taken = rest[0] === 5 ? 2 : rest[0] === 2 ? 4 : 0;
      const colour = extended(rest.slice(0, taken));
      index += Math.min(taken, rest.length);
      if (code === 38 && colour !== null) next.fg = colour;
      if (code === 48 && colour !== null) next.bg = colour;
    }
  }
  return next;
}

const hex = (value: number) => `#${value.toString(16).padStart(6, "0")}`;
const blend = (fore: number, ground: number) => {
  const channel = (shift: number) => Math.round((((fore >> shift) & 0xff) + ((ground >> shift) & 0xff)) / 2);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
};

/** A style as it is drawn: inverse swaps, dim is half way to the ground, hidden is the ground's own colour. */
function resolve(style: CellStyle): Omit<DrawRun, "t"> {
  let fore = style.fg ?? TERMINAL_FOREGROUND;
  let back = style.bg;
  if (style.inverse) {
    const ground = back ?? TERMINAL_BACKGROUND;
    back = fore;
    fore = ground;
  }
  const ground = back ?? TERMINAL_BACKGROUND;
  if (style.dim) fore = blend(fore, ground);
  if (style.hidden) fore = ground;
  return {
    fg: hex(fore),
    ...(back === null ? {} : { bg: hex(back) }),
    ...(style.bold ? { b: 1 as const } : {}),
    ...(style.italic ? { i: 1 as const } : {}),
    ...(style.underline ? { u: 1 as const } : {}),
    ...(style.strike ? { s: 1 as const } : {}),
  };
}

/** A `capture-pane -e` screen as drawable lines: SGR kept, every other escape and control dropped. */
export function ansiLines(capture: string): DrawRun[][] {
  const lines: DrawRun[][] = [];
  let style = plain();
  for (const line of capture.replace(/\n$/, "").split("\n")) {
    const runs: DrawRun[] = [];
    let text = "";
    const flush = () => {
      if (!text) return;
      const look = resolve(style);
      const last = runs.at(-1);
      if (last && JSON.stringify({ ...last, t: "" }) === JSON.stringify({ t: "", ...look })) last.t += text;
      else runs.push({ t: text, ...look });
      text = "";
    };
    for (let index = 0; index < line.length;) {
      const char = line[index]!;
      if (char === "\x1b") {
        flush();
        const next = line[index + 1];
        if (next === "[") {
          let end = index + 2;
          while (end < line.length && !/[@-~]/.test(line[end]!)) end++;
          if (line[end] === "m") style = applySgr(style, line.slice(index + 2, end));
          index = end + 1;
        } else if (next === "]") {
          let end = index + 2;
          while (end < line.length && line[end] !== "\x07" && !(line[end] === "\x1b" && line[end + 1] === "\\")) end++;
          index = line[end] === "\x07" ? end + 1 : end + 2;
        } else {
          index += 2;
        }
        continue;
      }
      if (char === "\t") text += "    ";
      else if (char.charCodeAt(0) >= 0x20 && char !== "\x7f") text += char;
      index++;
    }
    flush();
    lines.push(runs);
  }
  return lines;
}

/** Plain text as drawable lines in one colour, wrapped at `columns`: at a space where there is one, else mid-word. */
export function textLines(text: string, columns: number, fg: string, bold = false): DrawRun[][] {
  const width = Math.max(1, columns);
  const lines: DrawRun[][] = [];
  const push = (chars: string[]) => lines.push([{ t: chars.join(""), fg, ...(bold ? { b: 1 as const } : {}) }]);
  for (const raw of stripAnsi(text).replace(/\t/g, "    ").split("\n")) {
    let chars = [...raw.replace(/[\u0000-\u001f\u007f]/g, "")];
    if (!chars.length) lines.push([]);
    while (chars.length > width) {
      const space = chars.lastIndexOf(" ", width);
      const cut = space > 0 ? space : width;
      push(chars.slice(0, cut));
      chars = chars.slice(space > 0 ? cut + 1 : cut);
    }
    if (chars.length) push(chars);
  }
  return lines;
}

// MARK: - The picture

/** What the compose script draws, top-left origin, in points. */
export interface ComposeSpec {
  out: string;
  width: number;
  height: number;
  scale: number;
  background: string;
  items: ComposeItem[];
}
export type ComposeItem =
  | { kind: "rect"; rect: [number, number, number, number]; fill: string }
  | { kind: "image"; rect: [number, number, number, number]; path: string }
  | { kind: "text"; at: [number, number]; clip: [number, number, number, number]; size: number; line: number; mono: boolean; lines: DrawRun[][] };

/** A PNG's pixel size from its header, or null. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** SF Mono's advance as a share of its size (ConchTerminalMetrics.advance). */
const ADVANCE = 1234 / 2048;

export type ParitySide =
  | { kind: "image"; path: string; width: number; height: number; title: string; note?: string }
  | { kind: "screen"; lines: DrawRun[][]; columns: number; rows: number; title: string; note?: string }
  | { kind: "text"; lines: DrawRun[][]; title: string; note?: string };

const PANEL = 820;
const MARGIN = 24;
const HEADER = 78;
const TITLE = 44;
const MAX_CONTENT = 1_600;

/** The two sides and a header saying what was checked, laid out for the compose script. */
export function paritySpec(options: {
  out: string;
  heading: string;
  verdict: { line: string; colour: string };
  conch: ParitySide;
  terminal: ParitySide;
}): ComposeSpec {
  const items: ComposeItem[] = [];
  const top = MARGIN + HEADER;
  const place = (side: ParitySide, x: number): number => {
    let height: number;
    items.push({ kind: "text", at: [x, top], clip: [x, top, PANEL, TITLE], size: 13, line: 18, mono: false, lines: [
      [{ t: side.title, fg: "#f2f2f2", b: 1 }],
      ...(side.note ? [[{ t: side.note, fg: "#9a9a9a" }]] : []),
    ] });
    const y = top + TITLE;
    if (side.kind === "image") {
      height = Math.min(MAX_CONTENT, Math.round(PANEL * side.height / side.width));
      const width = Math.round(height * side.width / side.height);
      items.push({ kind: "image", rect: [x, y, width, height], path: side.path });
    } else if (side.kind === "screen") {
      const size = Math.min(13, Math.max(6, Math.floor((PANEL - 16) / (side.columns * ADVANCE) * 10) / 10));
      const line = Math.round(size * 1.28 * 10) / 10;
      height = Math.min(MAX_CONTENT, Math.ceil(side.rows * line + 16));
      items.push({ kind: "rect", rect: [x, y, PANEL, height], fill: hex(TERMINAL_BACKGROUND) });
      items.push({ kind: "text", at: [x + 8, y + 8], clip: [x, y, PANEL, height], size, line, mono: true, lines: side.lines.slice(0, side.rows) });
    } else {
      const line = 16;
      height = Math.min(MAX_CONTENT, side.lines.length * line + 16);
      items.push({ kind: "rect", rect: [x, y, PANEL, height], fill: "#202020" });
      items.push({ kind: "text", at: [x + 10, y + 8], clip: [x, y, PANEL, height], size: 12, line, mono: true, lines: side.lines });
    }
    return height;
  };
  const left = place(options.conch, MARGIN);
  const right = place(options.terminal, MARGIN * 2 + PANEL);
  const width = MARGIN * 3 + PANEL * 2;
  items.unshift({ kind: "text", at: [MARGIN, MARGIN], clip: [MARGIN, MARGIN, width - MARGIN * 2, HEADER], size: 15, line: 24, mono: false, lines: [
    [{ t: options.heading, fg: "#f2f2f2", b: 1 }],
    [{ t: options.verdict.line, fg: options.verdict.colour, b: 1 }],
  ] });
  return {
    out: options.out,
    width,
    height: top + TITLE + Math.max(left, right) + MARGIN,
    scale: 2,
    background: "#151515",
    items,
  };
}

/**
 * AppKit, from `osascript -l JavaScript`: a bitmap at `scale`, the items drawn in order, written as a PNG. JXA can't
 * reach `-[NSAttributedString initWithString:attributes:]`, so each line is built as a mutable string.
 */
export const COMPOSE_SCRIPT = String.raw`
ObjC.import("AppKit");
function colour(hex) {
  const value = parseInt(hex.slice(1), 16);
  return $.NSColor.colorWithSRGBRedGreenBlueAlpha(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255, 1);
}
function run(argv) {
  const spec = JSON.parse($.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null).js);
  const W = spec.width, H = spec.height;
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, Math.round(W * spec.scale), Math.round(H * spec.scale), 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  rep.setSize($.NSMakeSize(W, H));
  const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(context);
  context.setImageInterpolation(3);
  const flip = (rect) => $.NSMakeRect(rect[0], H - rect[1] - rect[3], rect[2], rect[3]);
  colour(spec.background).setFill;
  $.NSRectFill($.NSMakeRect(0, 0, W, H));
  const fonts = {};
  const font = (mono, size, bold, italic) => {
    const key = [mono, size, bold, italic].join(",");
    if (!fonts[key]) {
      let made = mono ? $.NSFont.monospacedSystemFontOfSizeWeight(size, bold ? 0.4 : 0) : $.NSFont.systemFontOfSizeWeight(size, bold ? 0.4 : 0);
      if (italic) made = $.NSFontManager.sharedFontManager.convertFontToHaveTrait(made, $.NSItalicFontMask);
      fonts[key] = made;
    }
    return fonts[key];
  };
  for (const item of spec.items) {
    if (item.kind === "rect") {
      colour(item.fill).setFill;
      $.NSRectFill(flip(item.rect));
    } else if (item.kind === "image") {
      const image = $.NSImage.alloc.initWithContentsOfFile(item.path);
      if (image && !image.isNil()) image.drawInRectFromRectOperationFraction(flip(item.rect), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
    } else if (item.kind === "text") {
      $.NSGraphicsContext.saveGraphicsState;
      $.NSBezierPath.clipRect(flip(item.clip));
      item.lines.forEach((runs, index) => {
        if (!runs.length) return;
        const line = $.NSMutableAttributedString.new;
        for (const run of runs) {
          const start = line.length;
          line.mutableString.appendString(run.t);
          const range = $.NSMakeRange(start, line.length - start);
          line.addAttributeValueRange($.NSFontAttributeName, font(item.mono, item.size, run.b, run.i), range);
          line.addAttributeValueRange($.NSForegroundColorAttributeName, colour(run.fg), range);
          // Appended characters take the attributes of the one before them, so what a run doesn't have is removed.
          if (run.bg) line.addAttributeValueRange($.NSBackgroundColorAttributeName, colour(run.bg), range);
          else line.removeAttributeRange($.NSBackgroundColorAttributeName, range);
          if (run.u) line.addAttributeValueRange($.NSUnderlineStyleAttributeName, $.NSNumber.numberWithInt(1), range);
          else line.removeAttributeRange($.NSUnderlineStyleAttributeName, range);
          if (run.s) line.addAttributeValueRange($.NSStrikethroughStyleAttributeName, $.NSNumber.numberWithInt(1), range);
          else line.removeAttributeRange($.NSStrikethroughStyleAttributeName, range);
        }
        line.drawAtPoint($.NSMakePoint(item.at[0], H - item.at[1] - (index + 1) * item.line));
      });
      $.NSGraphicsContext.restoreGraphicsState;
    }
  }
  context.flushGraphics;
  $.NSGraphicsContext.restoreGraphicsState;
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  if (!png || png.isNil() || !png.writeToFileAtomically(spec.out, true)) throw new Error("could not write " + spec.out);
  return "ok";
}
`;

// MARK: - The command

export interface ParityOptions {
  query: string;
  /** Where the picture goes; any `.png` path. */
  out?: string;
  /** The message to look for, instead of the newest one in conch's conversation. */
  text?: string;
  /** Photograph the Mac app's window (default), or draw conch's published conversation instead. */
  app: boolean;
  /** Scrollback lines to search. */
  history: number;
}

export const DEFAULT_HISTORY_LINES = 2_000;
export const PARITY_USAGE = "usage: conch parity <session> [--text <message>] [--out <file.png>] [--no-app] [--history <lines>]";
export const PARITY_HELP = `${PARITY_USAGE}

A debugging command, run locally and only when asked. One picture of conch's view of the session beside its own
terminal (a tmux pane drawn from its text in its colours; a Terminal window photographed), and a delivery check:
is the last message you sent the session through conch (or --text) in that terminal's screen or scrollback?

Prints the picture's path, then one line: PASS, FAIL or SKIP, naming the session and the message. Exits 0, 1 or 2.

  <session>          its id, the start of its id, or its label (or part of it)
  --text <message>   look for this instead of the newest message in conch's conversation for the session
  --out <file.png>   where the picture goes (default /tmp/conch-parity-<time>.png)
  --no-app           leave the Mac app alone: draw conch's published conversation instead of photographing its
                     window (by default the app is asked to show the session, then photographs itself)
  --history <lines>  scrollback lines to search (default ${DEFAULT_HISTORY_LINES}, at most 10000)`;

export function parseParityArgs(argv: readonly string[]): ParityOptions | { error: string } {
  const words: string[] = [];
  const options: ParityOptions = { query: "", app: true, history: DEFAULT_HISTORY_LINES };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) return null;
      index++;
      return next;
    };
    if (arg === "--no-app") options.app = false;
    else if (arg === "--text") {
      const text = value();
      if (text === null || !text.trim()) return { error: `${PARITY_USAGE}\n  --text takes the message to look for` };
      options.text = text;
    } else if (arg === "--out") {
      const out = value();
      if (out === null || !out.endsWith(".png")) return { error: `${PARITY_USAGE}\n  --out takes a .png path` };
      options.out = out;
    } else if (arg === "--history") {
      const lines = Number(value());
      if (!Number.isSafeInteger(lines) || lines < 1 || lines > 10_000) return { error: `${PARITY_USAGE}\n  --history takes 1 to 10000 lines` };
      options.history = lines;
    } else if (arg.startsWith("--")) {
      return { error: `${PARITY_USAGE}\n  unknown option ${arg}` };
    } else {
      words.push(arg);
    }
  }
  options.query = words.join(" ").trim();
  if (!options.query) return { error: PARITY_USAGE };
  return options;
}

export interface ParityDeps {
  /** The daemon's published state (the sessions file), parsed, or null. */
  published(): { rows?: ParityRow[]; conversations?: Record<string, PublishedConversation> } | null;
  /** `terminal-screen`, with its scrollback. */
  terminal(sessionId: string, history: number): Promise<TerminalScreenReply | { error: string }>;
  /** The Mac app's own picture of its window, showing this session: a PNG path, or why not. */
  appShot(sessionId: string): Promise<{ path: string; showing?: string | null } | { error: string }>;
  /** A Terminal window, by the window server's id: a PNG path, or null. */
  windowShot(window: number): Promise<string | null>;
  /** Draw the spec; null when written, else why not. */
  compose(spec: ComposeSpec): Promise<string | null>;
  readPng(path: string): Uint8Array | null;
  now(): number;
  /** Temporary files made along the way, removed at the end. */
  cleanup(paths: string[]): void;
}

export interface ParityResult {
  exitCode: 0 | 1 | 2;
  /** Printed on stdout: the picture's path, then the verdict. */
  out: string[];
  /** Printed on stderr: what was compared, and anything that fell back. */
  notes: string[];
}

const PASS = "#3fcf6a";
const FAIL = "#ff5f57";
const SKIP = "#c9a227";

function ago(at: number | undefined, now: number): string {
  if (at === undefined) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 90) return `, ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `, ${minutes}m ago` : `, ${Math.round(minutes / 60)}h ago`;
}

/** Where the terminal is, in a few words. */
export function terminalPlace(reply: TerminalScreenReply): string {
  if (reply.host === "tmux") return `tmux ${reply.pane} · ${reply.columns}×${reply.rows}`;
  if (reply.host === "terminal") return `Terminal · ${reply.tty}`;
  return "no terminal";
}

/** The verdict line: PASS, FAIL or SKIP, the session, the message, and where it was or wasn't. */
export function verdictLine(row: ParityRow, message: string | null, verdict: DeliveryVerdict | null, place: string, skip?: string): string {
  const who = `${row.label} (${row.id.slice(0, 8)})`;
  if (skip !== undefined || message === null || verdict === null) return `SKIP ${who}: ${skip ?? "no message to look for"}`;
  const said = `"${excerpt(message)}"`;
  if (!verdict.pass) return `FAIL ${who}: ${said} is not in its terminal's screen or scrollback [${place}]`;
  if (verdict.where === "cut") {
    return `PASS ${who}: the last ${verdict.kept} of ${verdict.of} characters of ${said} begin what its terminal keeps; the start scrolled out [${place}]`;
  }
  return `PASS ${who}: ${said} is in its terminal's ${verdict.where} [${place}]`;
}

/** conch's published conversation as text, newest last, for when the app's window can't be photographed. */
export function conversationLines(conversation: PublishedConversation | undefined, agent: string, columns: number, maxLines: number): DrawRun[][] {
  const lines: DrawRun[][] = [];
  for (const item of conversation?.items ?? []) {
    const who = item.kind === "user" ? "You" : item.kind === "assistant" ? agent : item.kind === "tool" ? `· ${item.tool?.name ?? "tool"}` : `· ${item.kind}`;
    const colour = item.kind === "user" ? "#7cc4ff" : item.kind === "assistant" ? "#f2f2f2" : "#8a8a8a";
    const body = item.kind === "tool" ? "" : item.text.length > 1_200 ? `${item.text.slice(0, 1_199)}…` : item.text;
    lines.push([{ t: who, fg: colour, b: 1 }]);
    if (body.trim()) lines.push(...textLines(body.trim(), columns, item.kind === "user" ? "#d6ecff" : "#d8d8d8"));
    lines.push([]);
  }
  return lines.slice(Math.max(0, lines.length - maxLines));
}

export async function runParity(options: ParityOptions, deps: ParityDeps): Promise<ParityResult> {
  const notes: string[] = [];
  const temporary: string[] = [];
  const published = deps.published();
  if (!published?.rows) return { exitCode: 2, out: [], notes: ["conch's published state isn't there: is conch running?"] };
  const found = resolveRow(published.rows, options.query);
  if ("error" in found) return { exitCode: 2, out: [], notes: [found.error] };
  const row = found.row;
  const conversation = published.conversations?.[row.id];
  const agent = row.backend === "codex" ? "Codex" : "Claude Code";

  // What to look for.
  const sent = options.text === undefined ? lastSentMessage(conversation) : null;
  const message = options.text ?? sent?.text ?? null;
  notes.push(options.text !== undefined
    ? `message: --text (${matchable(options.text).length} characters to find)`
    : sent
      ? `message: the newest thing you sent in conch's conversation for ${row.label} (item ${sent.id}${ago(sent.at, deps.now())})`
      : `message: none — conch's conversation for ${row.label} has nothing you sent`);

  // The terminal.
  const screen = await deps.terminal(row.id, options.history);
  let skip: string | undefined;
  let place = "no terminal";
  let terminalSide: ParitySide;
  let verdict: DeliveryVerdict | null = null;
  if ("error" in screen || screen.host === "none") {
    skip = `its terminal can't be read: ${"error" in screen ? screen.error : screen.reason}`;
    terminalSide = { kind: "text", title: "Terminal", lines: textLines(skip, 100, "#c9a227") };
  } else {
    place = terminalPlace(screen);
    if (screen.host === "tmux") {
      terminalSide = { kind: "screen", title: `${agent} in its terminal · ${place}`, columns: screen.columns, rows: screen.rows, lines: ansiLines(screen.screen) };
      if (message !== null) verdict = checkDelivery(message, { screen: screen.screen, ...(screen.history === undefined ? {} : { history: screen.history }) });
    } else {
      const shot = screen.minimized || !screen.selected ? null : await deps.windowShot(screen.window);
      const size = shot ? pngSize(deps.readPng(shot) ?? new Uint8Array()) : null;
      if (shot) temporary.push(shot);
      if (shot && size) {
        terminalSide = { kind: "image", title: `${agent} in its terminal · ${place}`, path: shot, ...size };
      } else {
        const why = screen.minimized ? "the window is in the Dock" : !screen.selected ? "another tab is in front" : "screencapture couldn't picture it (Screen Recording for this terminal?)";
        terminalSide = { kind: "text", title: `${agent} in its terminal · ${place}`, note: `its text, without colour: ${why}`, lines: textLines(screen.text ?? "", 110, "#e5e5e5") };
      }
      if (message !== null) verdict = checkDelivery(message, { ...(screen.text === undefined ? {} : { screen: screen.text }), ...(screen.history === undefined ? {} : { history: screen.history }) });
    }
    if (screen.history !== undefined) place += `, ${screen.history.replace(/\n$/, "").split("\n").length} lines of scrollback read`;
  }

  // conch's side.
  let conchSide: ParitySide | null = null;
  if (options.app) {
    const shot = await deps.appShot(row.id);
    if ("error" in shot) {
      notes.push(`conch's window: not photographed (${shot.error}); drew conch's published conversation instead`);
    } else {
      temporary.push(shot.path, `${shot.path}.json`);
      const size = pngSize(deps.readPng(shot.path) ?? new Uint8Array());
      if (size) {
        const elsewhere = shot.showing && shot.showing !== row.id ? `conch's window was showing another session (${shot.showing})` : undefined;
        if (elsewhere) notes.push(elsewhere);
        conchSide = { kind: "image", title: `conch · ${row.label}`, path: shot.path, ...size, ...(elsewhere ? { note: elsewhere } : {}) };
      } else {
        notes.push("conch's window: the app's picture couldn't be read; drew conch's published conversation instead");
      }
    }
  }
  conchSide ??= {
    kind: "text",
    title: `conch · ${row.label}`,
    note: options.app ? "conch's published conversation (the app's window couldn't be photographed)" : "conch's published conversation (--no-app)",
    lines: conversationLines(conversation, agent, 100, 96),
  };

  const line = verdictLine(row, message, verdict, place, skip);
  const colour = line.startsWith("PASS") ? PASS : line.startsWith("FAIL") ? FAIL : SKIP;
  const out = options.out ?? `/tmp/conch-parity-${deps.now()}.png`;
  const drawn = await deps.compose(paritySpec({
    out,
    heading: `conch parity · ${row.label} · ${row.id} · ${new Date(deps.now()).toISOString()}`,
    verdict: { line, colour },
    conch: conchSide,
    terminal: terminalSide,
  }));
  deps.cleanup(temporary);
  if (drawn !== null) notes.push(`no picture: ${drawn}`);
  return {
    exitCode: line.startsWith("PASS") ? 0 : line.startsWith("FAIL") ? 1 : 2,
    out: [...(drawn === null ? [out] : []), line],
    notes,
  };
}

// MARK: - The real Mac

/** The Mac app's sentinels (mac-app/conch-mac/DebugSnapshot.swift): show a session, then photograph a window. */
export const APP_SELECT_REQUEST = "/tmp/conch-select.request";
export const APP_SHOT_REQUEST = "/tmp/conch-shot.request";

/** The published state's path, as the daemon writes it (status.ts `SESSIONS_FILE`, which this can't import cheaply). */
export function sessionsFilePath(env: Record<string, string | undefined> = process.env): string {
  return env.CONCH_SESSIONS_FILE || "/tmp/conch-sessions.json";
}

async function until(probe: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await Bun.sleep(100);
  }
  return probe();
}

const remove = (path: string) => {
  try { unlinkSync(path); } catch {}
};

export function defaultParityDeps(options: { socketPath: string; sessionsPath: string }): ParityDeps {
  return {
    published() {
      try { return JSON.parse(readFileSync(options.sessionsPath, "utf8")); } catch { return null; }
    },
    async terminal(sessionId, history) {
      const result = await sendControlMessage(options.socketPath, { kind: "terminal-screen", sessionId, text: true, history }, 10_000);
      if (!result.ok) {
        return { error: result.reason === "daemon-down" ? "conch's daemon isn't answering" : `the daemon's answer couldn't be read (${result.diagnostic ?? result.reason})` };
      }
      if (result.response.kind === "terminal-screen") return result.response;
      if (result.response.kind === "session-error") return { error: result.response.error };
      return { error: `the daemon answered ${result.response.kind}: an older conch, which can't read terminals` };
    },
    async appShot(sessionId) {
      // The app may only write a PNG under /tmp; this one is removed once the picture is composed.
      const png = `/tmp/conch-parity-app-${Date.now()}.png`;
      for (const stale of [png, `${png}.json`, `${png}.error`]) remove(stale);
      // This session first: the app shows it on one poll and is photographed on a later one. An app from before the
      // select request leaves the file, which is taken back, and photographs whatever it shows.
      writeFileSync(APP_SELECT_REQUEST, sessionId);
      if (await until(() => !existsSync(APP_SELECT_REQUEST), 2_000)) await Bun.sleep(700);
      else remove(APP_SELECT_REQUEST);
      writeFileSync(APP_SHOT_REQUEST, `${png}\ndashboard`);
      await until(() => existsSync(png) || existsSync(`${png}.error`), 5_000);
      if (!existsSync(png)) {
        remove(APP_SHOT_REQUEST);
        const reason = existsSync(`${png}.error`) ? readFileSync(`${png}.error`, "utf8").trim() : "is the conch Mac app running?";
        remove(`${png}.error`);
        return { error: reason };
      }
      let showing: string | null = null;
      try { showing = JSON.parse(readFileSync(`${png}.json`, "utf8")).viewing ?? null; } catch {}
      return { path: png, showing };
    },
    async windowShot(window) {
      const png = `/tmp/conch-parity-terminal-${Date.now()}.png`;
      // -l: that window alone, as the window server has it, behind others too; -o: no shadow; -x: no sound.
      const shot = Bun.spawn(["screencapture", "-x", "-o", "-l", String(window), png], { stdout: "ignore", stderr: "ignore" });
      return (await shot.exited) === 0 && existsSync(png) ? png : null;
    },
    async compose(spec) {
      const folder = mkdtempSync(join(tmpdir(), "conch-parity-"));
      try {
        writeFileSync(join(folder, "compose.js"), COMPOSE_SCRIPT);
        writeFileSync(join(folder, "spec.json"), JSON.stringify(spec));
        const run = Bun.spawn(["osascript", "-l", "JavaScript", join(folder, "compose.js"), join(folder, "spec.json")], { stdout: "pipe", stderr: "pipe" });
        const [code, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);
        return code === 0 && existsSync(spec.out) ? null : (stderr.trim() || `osascript exited ${code}`);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
    readPng(path) {
      try { return new Uint8Array(readFileSync(path)); } catch { return null; }
    },
    now: () => Date.now(),
    cleanup(paths) {
      for (const path of paths) remove(path);
    },
  };
}
