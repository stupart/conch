import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import type { PublishedConversation } from "../src/conversation.ts";
import {
  ansiLines,
  checkDelivery,
  COMPOSE_SCRIPT,
  CUT_MINIMUM,
  DEFAULT_HISTORY_LINES,
  defaultParityDeps,
  excerpt,
  lastSentMessage,
  matchable,
  parseParityArgs,
  paritySpec,
  pngSize,
  resolveRow,
  runParity,
  sessionsFilePath,
  textLines,
  verdictLine,
  type ComposeSpec,
  type ParityDeps,
  type ParityRow,
} from "../src/parity.ts";
import type { TerminalScreenReply } from "../src/terminal-mirror.ts";

/**
 * `conch parity`: the delivery check an agent reads (is the message conch sent in the session's terminal?), and the
 * picture beside it. The terminal texts below are shaped like real captures: SGR colour mid-word, a TUI's own hard
 * wrapping inside a box, tmux's scrollback with its wrapping joined, a message longer than the screen.
 */

const ESC = "\x1b";
const ORANGE = `${ESC}[38;2;215;119;87m`;
const GREY = `${ESC}[38;2;153;153;153m`;
const RESET = `${ESC}[0m`;
const MESSAGE = "Please turn the Terminal tab into a button that brings the session's own window forward, and keep the mirror behind Debug.";

/** A Claude Code-like frame, `width` columns: the message hard-wrapped by the TUI (mid-word too) under its prompt. */
function frame(message: string | null, width = 40, rows = 24): string {
  const inner = width - 4;
  const lines: string[] = [
    `${ORANGE}╭${"─".repeat(width - 2)}╮${ESC}[39m`,
    `${ORANGE}│${ESC}[39m ${ORANGE}✻${ESC}[39m Welcome to ${ESC}[1mClaude Code${RESET}!${" ".repeat(Math.max(0, width - 29))}${ORANGE}│${ESC}[39m`,
    `${ORANGE}╰${"─".repeat(width - 2)}╯${ESC}[39m`,
    "",
  ];
  if (message !== null) {
    const chars = [...message];
    for (let start = 0; start < chars.length; start += inner) {
      // The first row carries the prompt; the rest are indented under it, the way the TUI draws a long prompt. A word
      // in the middle is coloured (a mention), so the text runs through an escape.
      const piece = chars.slice(start, start + inner).join("").replace("Terminal", `${ESC}[1;38;5;75mTermi${ESC}[22mnal${ESC}[39m`);
      lines.push(`${GREY}${start === 0 ? ">" : " "}${ESC}[39m ${piece}`);
    }
    lines.push("");
  }
  lines.push(`${ESC}[38;5;244m●${ESC}[39m Done. The strip's Terminal is a button now.`, "");
  lines.push(`${GREY}╭${"─".repeat(width - 2)}╮${ESC}[39m`);
  lines.push(`${GREY}│${ESC}[39m > ${ESC}[7m ${RESET}${" ".repeat(width - 6)}${GREY}│${ESC}[39m`);
  lines.push(`${GREY}╰${"─".repeat(width - 2)}╯${ESC}[39m`);
  while (lines.length < rows) lines.push("");
  return lines.slice(lines.length - rows).join("\n") + "\n";
}

/** A message longer than any screen: numbered sentences, so every stretch of it is its own. */
const LONG = Array.from({ length: 60 }, (_, n) => `Sentence ${n + 1} of the long brief says something specific.`).join(" ");

/** What `capture-pane -p -J` gives: plain, each prompt line as the TUI broke it, tmux's own wrapping joined. */
function scrollback(message: string, before = 30): string {
  return [
    ...Array.from({ length: before }, (_, n) => `earlier output ${n}`),
    `> ${message.slice(0, 1_000)}`,
    `  ${message.slice(1_000)}`,
    "",
    "● Done.",
  ].join("\n") + "\n";
}

describe("what is compared", () => {
  test("escapes, whitespace, box drawing and controls go; every other character stays, case too", () => {
    expect(matchable(`${ORANGE}│${ESC}[39m Hello, ${ESC}[1mWorld${RESET}!\n  ${ESC}]0;title${ESC}\\again\u0007`)).toBe("Hello,World!again");
    expect(matchable("a\u00a0b\u200bc\tD")).toBe("abcD");
    expect(matchable("▌ quoted ─ line ┃")).toBe("quotedline");
    expect(matchable("Hello")).not.toBe(matchable("hello"));
  });

  test("a message is named by its first 60 characters on one line", () => {
    expect(excerpt("short\n  message")).toBe("short message");
    expect(excerpt(MESSAGE)).toBe(`${MESSAGE.slice(0, 59)}…`);
    expect(excerpt(MESSAGE).length).toBe(60);
  });
});

describe("the delivery check", () => {
  test("on the screen, through the TUI's wrapping, indentation, border and a colour change mid-word", () => {
    const screen = frame(MESSAGE);
    // The fixture really does break the message across rows, mid-word, with escapes inside it.
    expect(screen).toContain(`${ESC}[1;38;5;75mTermi${ESC}[22mnal`);
    expect(screen.split("\n").filter((line) => line.startsWith(`${GREY} `)).length).toBeGreaterThan(1);
    expect(checkDelivery(MESSAGE, { screen })).toEqual({ pass: true, where: "screen", of: matchable(MESSAGE).length });
  });

  test("not there: FAIL, and a message one word off is not there either", () => {
    expect(checkDelivery(MESSAGE, { screen: frame(null) })).toEqual({ pass: false, of: matchable(MESSAGE).length });
    expect(checkDelivery(MESSAGE.replace("Debug", "Settings"), { screen: frame(MESSAGE) })).toMatchObject({ pass: false });
    expect(checkDelivery(MESSAGE, { screen: frame(MESSAGE.slice(0, 80)) })).toMatchObject({ pass: false });
  });

  test("scrolled off the screen but in the scrollback", () => {
    const history = scrollback(MESSAGE) + stripScreen(frame(null));
    expect(checkDelivery(MESSAGE, { screen: frame(null), history })).toEqual({ pass: true, where: "scrollback", of: matchable(MESSAGE).length });
    // The screen is looked at first.
    expect(checkDelivery(MESSAGE, { screen: frame(MESSAGE), history })).toMatchObject({ where: "screen" });
  });

  test("a message longer than the screen: whole in the scrollback", () => {
    const screen = frame(LONG, 80, 24);
    expect(matchable(screen)).not.toContain(matchable(LONG));
    expect(checkDelivery(LONG, { screen, history: scrollback(LONG) + stripScreen(screen) }))
      .toEqual({ pass: true, where: "scrollback", of: matchable(LONG).length });
  });

  test("a message longer than the screen, with only the screen to read: its end opens the screen, so it arrived", () => {
    // The top rows of this screen are the message's last ones: its start scrolled out, and nothing keeps it.
    const tail = [...LONG].slice(-600).join("");
    const screen = tail.match(/.{1,76}/g)!.map((row) => `  ${row}`).join("\n") + "\n\n● Done.\n";
    const verdict = checkDelivery(LONG, { screen });
    expect(verdict).toMatchObject({ pass: true, where: "cut", of: matchable(LONG).length });
    if (!verdict?.pass || verdict.where !== "cut") throw new Error("not cut");
    expect(verdict.kept).toBe(matchable(tail).length);
    // The same, where the scrollback is what begins partway through (tmux's history-limit, or a reply's 64 KiB).
    expect(checkDelivery(LONG, { screen: frame(null), history: `${tail}\n● Done.\n` })).toMatchObject({ pass: true, where: "cut" });
  });

  test("an end too short to be sure of, or one that doesn't open the text, is not a delivery", () => {
    const needle = matchable(LONG);
    const short = [...LONG].slice(-(CUT_MINIMUM - 10)).join("");
    expect(matchable(short).length).toBeLessThan(CUT_MINIMUM);
    expect(checkDelivery(LONG, { screen: `${short}\n● Done.\n` })).toMatchObject({ pass: false });
    // The message's end, but after something else: not where a cut would leave it.
    const tail = [...LONG].slice(-600).join("");
    expect(checkDelivery(LONG, { screen: `unrelated\n${tail}\n` })).toMatchObject({ pass: false });
    // Its start and its end, with the middle missing: never pieced together.
    expect(checkDelivery(LONG, { screen: `${LONG.slice(0, 400)}\n${tail}` })).toMatchObject({ pass: false });
    expect(needle.length).toBeGreaterThan(2_000);
  });

  test("a message with nothing in it is nothing to look for", () => {
    expect(checkDelivery("  \n\t", { screen: frame(MESSAGE) })).toBeNull();
    expect(checkDelivery(`${ESC}[1m${RESET}`, { screen: "x" })).toBeNull();
  });
});

/** A screen without its escapes, as plain scrollback would carry it. */
function stripScreen(screen: string): string {
  return screen.replace(/\x1b\[[0-9;:]*m/g, "");
}

describe("the verdict line", () => {
  const row: ParityRow = { id: "e2e0cafe-0000-4000-8000-000000000001", label: "parity e2e" };
  test("PASS, FAIL and SKIP each name the session and the message", () => {
    expect(verdictLine(row, "ship it", { pass: true, where: "screen", of: 6 }, "tmux %3 · 80×24"))
      .toBe(`PASS parity e2e (e2e0cafe): "ship it" is in its terminal's screen [tmux %3 · 80×24]`);
    expect(verdictLine(row, "ship it", { pass: true, where: "scrollback", of: 6 }, "tmux %3 · 80×24"))
      .toBe(`PASS parity e2e (e2e0cafe): "ship it" is in its terminal's scrollback [tmux %3 · 80×24]`);
    expect(verdictLine(row, "ship it", { pass: true, where: "cut", kept: 90, of: 400 }, "Terminal · ttys004"))
      .toBe(`PASS parity e2e (e2e0cafe): the last 90 of 400 characters of "ship it" begin what its terminal keeps; the start scrolled out [Terminal · ttys004]`);
    expect(verdictLine(row, "ship it", { pass: false, of: 6 }, "tmux %3 · 80×24"))
      .toBe(`FAIL parity e2e (e2e0cafe): "ship it" is not in its terminal's screen or scrollback [tmux %3 · 80×24]`);
    expect(verdictLine(row, null, null, "tmux %3")).toBe("SKIP parity e2e (e2e0cafe): no message to look for");
    expect(verdictLine(row, "ship it", null, "no terminal", "its terminal can't be read: gone"))
      .toBe("SKIP parity e2e (e2e0cafe): its terminal can't be read: gone");
  });
});

describe("whose session, and what conch sent it", () => {
  const rows: ParityRow[] = [
    { id: "aaaa1111-0000", label: "api work" },
    { id: "bbbb2222-0000", label: "api docs" },
    { id: "cccc3333-0000", label: "conch" },
    { id: "cccc3333-0000:agent", label: "conch", parentSessionId: "cccc3333-0000" },
  ];
  test("by id, label, id prefix, then part of a label; several at one step are refused, never guessed", () => {
    expect(resolveRow(rows, "bbbb2222-0000")).toEqual({ row: rows[1] });
    expect(resolveRow(rows, "API WORK")).toEqual({ row: rows[0] });
    expect(resolveRow(rows, "cccc")).toEqual({ row: rows[2] });
    expect(resolveRow(rows, "docs")).toEqual({ row: rows[1] });
    expect(resolveRow(rows, "api")).toEqual({ error: `"api" matches 2 sessions; name one by id: aaaa1111-0000 ("api work"), bbbb2222-0000 ("api docs")` });
    // A subagent runs in its session's terminal and is never a session of its own here.
    expect(resolveRow(rows, "conch")).toEqual({ row: rows[2] });
    expect(resolveRow(rows, "abc")).toEqual({ error: `no session conch shows matches "abc". Sessions: api work, api docs, conch` });
    expect(resolveRow(rows, "   ")).toEqual({ error: "name a session: its id or its label" });
    // A three-character id prefix is too short to mean anything.
    expect(resolveRow(rows, "aaa")).toMatchObject({ error: expect.stringContaining("no session") });
  });

  const item = (id: string, kind: "user" | "assistant" | "tool", text: string, at?: number) =>
    ({ id, rev: 1, kind, text, ...(at === undefined ? {} : { at }) }) as PublishedConversation["items"][number];
  test("the newest thing you sent, as conch's conversation shows it", () => {
    const conversation: PublishedConversation = { sessionId: "s", truncated: false, items: [
      item("1", "user", "first"), item("2", "assistant", "ok"), item("3", "user", "second", 42), item("4", "tool", "Bash"), item("5", "assistant", "done"),
    ] };
    expect(lastSentMessage(conversation)).toEqual({ text: "second", id: "3", at: 42 });
    expect(lastSentMessage({ ...conversation, items: [item("1", "assistant", "hi"), item("2", "user", "  ")] })).toBeNull();
    expect(lastSentMessage(undefined)).toBeNull();
  });

  test("a long one is published as its tail after a mark, and the tail is what is looked for", () => {
    const tail = "t".repeat(4_000);
    expect(lastSentMessage({ sessionId: "s", truncated: false, items: [item("9", "user", `…${tail}`)] })?.text).toBe(tail);
    // A short message that happens to start with the mark keeps it.
    expect(lastSentMessage({ sessionId: "s", truncated: false, items: [item("9", "user", "…and then")] })?.text).toBe("…and then");
  });
});

describe("the command's options", () => {
  test("a session, and the flags", () => {
    expect(parseParityArgs(["api", "work"])).toEqual({ query: "api work", app: true, history: DEFAULT_HISTORY_LINES });
    expect(parseParityArgs(["s1", "--no-app", "--text", "ship it", "--out", "/x/y.png", "--history", "50"]))
      .toEqual({ query: "s1", app: false, text: "ship it", out: "/x/y.png", history: 50 });
    for (const bad of [[], ["s", "--out", "y.jpg"], ["s", "--text"], ["s", "--text", " "], ["s", "--history", "0"], ["s", "--history", "10001"], ["s", "--screen"]]) {
      expect(parseParityArgs(bad)).toHaveProperty("error");
    }
  });

  test("the published state is read where the daemon writes it", () => {
    expect(sessionsFilePath({})).toBe("/tmp/conch-sessions.json");
    expect(sessionsFilePath({ CONCH_SESSIONS_FILE: "/t/s.json" })).toBe("/t/s.json");
    // The same rule as the daemon's own (status.ts), which the CLI can't import without its renderer.
    const status = readFileSync(join(import.meta.dir, "../src/status.ts"), "utf8");
    expect(status).toContain('export const SESSIONS_FILE = process.env.CONCH_SESSIONS_FILE || "/tmp/conch-sessions.json";');
  });

  test("the CLI runs it, and says so in its help", () => {
    const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8");
    const help = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "help"]).stdout.toString();
    expect(help).toContain("conch doctor | help-session | version | parity <session>");
    expect(help).toContain("(parity --help)");
    const detail = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "parity", "--help"]);
    expect(detail.exitCode).toBe(0);
    expect(detail.stdout.toString()).toStartWith("usage: conch parity <session> [--text <message>] [--out <file.png>] [--no-app] [--history <lines>]");
    for (const flag of ["--text <message>", "--out <file.png>", "--no-app", "--history <lines>", "PASS, FAIL or SKIP"]) {
      expect(detail.stdout.toString()).toContain(flag);
    }
    const parity = cli.slice(cli.indexOf('case "parity": {'), cli.indexOf('case "start": {'));
    expect(parity).toContain("defaultParityDeps({ socketPath: cfg.socketPath, sessionsPath: sessionsFilePath() })");
    expect(parity).toContain("process.exitCode = result.exitCode;");
  });
});

describe("drawing the terminal", () => {
  test("its colours: 24-bit, 256, the sixteen, inverse, dim, reset; OSC and other escapes dropped", () => {
    const lines = ansiLines(`${ORANGE}✻${ESC}[39m hi ${ESC}[38;5;196mred${ESC}[0m ${ESC}[7mX${ESC}[27m ${ESC}[2;32mdim${ESC}[0m${ESC}]0;t${ESC}\\${ESC}[?25l\n${ESC}[48:2::1:2:3mbg${ESC}[49m\n`);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual([
      { t: "✻", fg: "#d77757" },
      { t: " hi ", fg: "#e5e5e5" },
      { t: "red", fg: "#ff0000" },
      { t: " ", fg: "#e5e5e5" },
      { t: "X", fg: "#1e1e1e", bg: "#e5e5e5" },
      { t: " ", fg: "#e5e5e5" },
      // Green (0x00A600) half way to the ground (0x1E1E1E).
      { t: "dim", fg: "#0f620f" },
    ]);
    expect(lines[1]).toEqual([{ t: "bg", fg: "#e5e5e5", bg: "#010203" }]);
    // The style carries from one row to the next, as a terminal's does.
    expect(ansiLines(`${ESC}[1mA\nB${ESC}[0m`)).toEqual([[{ t: "A", fg: "#e5e5e5", b: 1 }], [{ t: "B", fg: "#e5e5e5", b: 1 }]]);
  });

  test("plain text wraps at the columns there are: at a space when there is one, else mid-word", () => {
    expect(textLines("abcdef\n\nxy", 4, "#fff")).toEqual([[{ t: "abcd", fg: "#fff" }], [{ t: "ef", fg: "#fff" }], [], [{ t: "xy", fg: "#fff" }]]);
    expect(textLines("the window forward", 12, "#fff").map((line) => line[0]?.t)).toEqual(["the window", "forward"]);
    expect(textLines("ab cdefghij", 4, "#fff", true)).toEqual([[{ t: "ab", fg: "#fff", b: 1 }], [{ t: "cdef", fg: "#fff", b: 1 }], [{ t: "ghij", fg: "#fff", b: 1 }]]);
  });

  test("a PNG's size from its header", () => {
    const header = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0, 0, 0, 2, 208]);
    expect(pngSize(header)).toEqual({ width: 1280, height: 720 });
    expect(pngSize(new Uint8Array(24))).toBeNull();
  });

  test("the layout: a header with the verdict, conch on the left, the terminal on the right", () => {
    const spec = paritySpec({
      out: "/tmp/x.png",
      heading: "conch parity · s",
      verdict: { line: "PASS s", colour: "#3fcf6a" },
      conch: { kind: "image", title: "conch · s", path: "/tmp/app.png", width: 2000, height: 1400 },
      terminal: { kind: "screen", title: "Claude Code in its terminal", columns: 120, rows: 40, lines: [] },
    });
    const header = spec.items[0]!;
    expect(header).toMatchObject({ kind: "text", lines: [[{ t: "conch parity · s" }], [{ t: "PASS s", fg: "#3fcf6a" }]] });
    const image = spec.items.find((item) => item.kind === "image")!;
    const screen = spec.items.filter((item) => item.kind === "text").at(-1)!;
    if (image.kind !== "image" || screen.kind !== "text") throw new Error("shape");
    expect(image.rect[0]).toBeLessThan(screen.at[0]);
    expect(image.rect[2] / image.rect[3]).toBeCloseTo(2000 / 1400, 2);
    // 120 columns fit the panel.
    expect(120 * screen.size * (1234 / 2048)).toBeLessThanOrEqual(820);
    expect(spec.height).toBeGreaterThan(image.rect[1] + image.rect[3]);
  });
});

/** A fake Mac for the command: the published state, the daemon's terminal read, the app, and the picture. */
function fakeDeps(options: {
  rows?: ParityRow[];
  conversation?: PublishedConversation;
  terminal?: TerminalScreenReply | { error: string };
  app?: { path: string; showing?: string | null } | { error: string };
  window?: string | null;
} = {}) {
  const calls = { terminal: [] as Array<[string, number]>, app: [] as string[], window: [] as number[], compose: [] as ComposeSpec[], cleanup: [] as string[] };
  const row = { id: "e2e0cafe-0000-4000-8000-000000000001", label: "parity e2e" };
  const deps: ParityDeps = {
    published: () => ({
      rows: options.rows ?? [row],
      conversations: { [row.id]: options.conversation ?? { sessionId: row.id, truncated: false, items: [
        { id: "u1", rev: 1, kind: "user", text: MESSAGE, at: 1_000 },
        { id: "a1", rev: 1, kind: "assistant", text: "Done." },
      ] } },
    }),
    async terminal(sessionId, history) {
      calls.terminal.push([sessionId, history]);
      return options.terminal ?? { kind: "terminal-screen", sessionId, host: "tmux", pane: "%3", columns: 40, rows: 24, screen: frame(MESSAGE), history: frame(MESSAGE) };
    },
    async appShot(sessionId) {
      calls.app.push(sessionId);
      return options.app ?? { error: "is the conch Mac app running?" };
    },
    async windowShot(window) {
      calls.window.push(window);
      return options.window ?? null;
    },
    async compose(spec) {
      calls.compose.push(spec);
      return null;
    },
    readPng: (path) => (path.includes("app") || path.includes("window")
      ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0, 0, 0, 3, 0])
      : null),
    now: () => 61_000,
    cleanup: (paths) => void calls.cleanup.push(...paths),
  };
  return { deps, calls, row };
}

describe("the command", () => {
  test("PASS: the picture's path, then the verdict; the scrollback asked for; exit 0", async () => {
    const { deps, calls, row } = fakeDeps();
    const result = await runParity({ query: "parity", app: false, history: 700, out: "/tmp/p.png" }, deps);
    expect(result.exitCode).toBe(0);
    expect(result.out).toEqual(["/tmp/p.png", `PASS parity e2e (e2e0cafe): "${excerpt(MESSAGE)}" is in its terminal's screen [tmux %3 · 40×24, 24 lines of scrollback read]`]);
    expect(calls.terminal).toEqual([[row.id, 700]]);
    expect(result.notes[0]).toBe("message: the newest thing you sent in conch's conversation for parity e2e (item u1, 60s ago)");
    // The picture says what the line says.
    const header = calls.compose[0]!.items[0]!;
    expect(header.kind === "text" && header.lines[1]![0]!.t).toBe(result.out[1]!);
  });

  test("--no-app never asks the Mac app for anything, and draws conch's published conversation", async () => {
    const { deps, calls } = fakeDeps();
    await runParity({ query: "parity", app: false, history: 10 }, deps);
    expect(calls.app).toEqual([]);
    const conch = calls.compose[0]!.items.filter((item) => item.kind === "text")[1]!;
    expect(conch.kind === "text" && conch.lines[1]![0]!.t).toContain("--no-app");
  });

  test("FAIL when the text isn't there: exit 1", async () => {
    const { deps } = fakeDeps({ terminal: { kind: "terminal-screen", sessionId: "x", host: "tmux", pane: "%3", columns: 40, rows: 24, screen: frame(null), history: frame(null) } });
    const result = await runParity({ query: "parity", app: false, history: 10 }, deps);
    expect(result.exitCode).toBe(1);
    expect(result.out.at(-1)).toStartWith("FAIL parity e2e (e2e0cafe): ");
  });

  test("--text is looked for instead of the conversation's", async () => {
    const { deps } = fakeDeps();
    const result = await runParity({ query: "parity", app: false, history: 10, text: "not on that screen" }, deps);
    expect(result.exitCode).toBe(1);
    expect(result.notes[0]).toBe("message: --text (15 characters to find)");
  });

  test("SKIP, exit 2: nothing sent, a terminal that can't be read, a session nobody has", async () => {
    const empty = fakeDeps({ conversation: { sessionId: "s", truncated: false, items: [] } });
    expect(await runParity({ query: "parity", app: false, history: 10 }, empty.deps))
      .toMatchObject({ exitCode: 2, out: [expect.any(String), "SKIP parity e2e (e2e0cafe): no message to look for"] });
    const none = fakeDeps({ terminal: { kind: "terminal-screen", sessionId: "s", host: "none", reason: "This session isn't running in a terminal conch can see." } });
    expect((await runParity({ query: "parity", app: false, history: 10 }, none.deps)).out.at(-1))
      .toBe("SKIP parity e2e (e2e0cafe): its terminal can't be read: This session isn't running in a terminal conch can see.");
    const down = fakeDeps({ terminal: { error: "conch's daemon isn't answering" } });
    expect(await runParity({ query: "parity", app: false, history: 10 }, down.deps)).toMatchObject({ exitCode: 2 });
    const nobody = fakeDeps();
    expect(await runParity({ query: "nobody", app: false, history: 10 }, nobody.deps))
      .toEqual({ exitCode: 2, out: [], notes: [`no session conch shows matches "nobody". Sessions: parity e2e`] });
    expect(nobody.calls.terminal).toEqual([]);
  });

  test("the app's picture is conch's side when it comes, and says so when it shows another session", async () => {
    const { deps, calls, row } = fakeDeps({ app: { path: "/tmp/conch-parity-app-1.png", showing: "someone-else" } });
    const result = await runParity({ query: "parity", app: true, history: 10 }, deps);
    expect(calls.app).toEqual([row.id]);
    const image = calls.compose[0]!.items.find((item) => item.kind === "image");
    expect(image).toMatchObject({ path: "/tmp/conch-parity-app-1.png" });
    expect(result.notes).toContain("conch's window was showing another session (someone-else)");
    // Its pieces are removed once composed.
    expect(calls.cleanup).toEqual(["/tmp/conch-parity-app-1.png", "/tmp/conch-parity-app-1.png.json"]);
  });

  test("an app that doesn't answer is said, and conch's conversation is drawn instead", async () => {
    const { deps } = fakeDeps({ app: { error: "is the conch Mac app running?" } });
    const result = await runParity({ query: "parity", app: true, history: 10 }, deps);
    expect(result.exitCode).toBe(0);
    expect(result.notes).toContain("conch's window: not photographed (is the conch Mac app running?); drew conch's published conversation instead");
  });

  test("a Terminal window is photographed when it can be, and read as text when it can't", async () => {
    const terminal = (minimized: boolean, selected = true): TerminalScreenReply =>
      ({ kind: "terminal-screen", sessionId: "s", host: "terminal", tty: "ttys004", window: 77, minimized, selected, text: frame(MESSAGE), history: frame(MESSAGE) });
    const shown = fakeDeps({ terminal: terminal(false), window: "/tmp/conch-parity-window-1.png" });
    expect((await runParity({ query: "parity", app: false, history: 10 }, shown.deps)).exitCode).toBe(0);
    expect(shown.calls.window).toEqual([77]);
    expect(shown.calls.compose[0]!.items.find((item) => item.kind === "image")).toMatchObject({ path: "/tmp/conch-parity-window-1.png" });
    for (const [minimized, selected] of [[true, true], [false, false]] as const) {
      const hidden = fakeDeps({ terminal: terminal(minimized, selected), window: "/tmp/never.png" });
      const result = await runParity({ query: "parity", app: false, history: 10 }, hidden.deps);
      expect(hidden.calls.window).toEqual([]);
      expect(result.out.at(-1)).toStartWith("PASS parity e2e (e2e0cafe): ");
      expect(result.out.at(-1)).toContain("[Terminal · ttys004");
    }
    // screencapture refused (no Screen Recording for this terminal): its text, still checked.
    const refused = fakeDeps({ terminal: terminal(false), window: null });
    const result = await runParity({ query: "parity", app: false, history: 10 }, refused.deps);
    expect(refused.calls.window).toEqual([77]);
    expect(result.exitCode).toBe(0);
    expect(refused.calls.compose[0]!.items.some((item) => item.kind === "image")).toBe(false);
  });
});

/** The pixels of an 8-bit RGBA, non-interlaced PNG (what NSBitmapImageRep writes). */
function decodePng(bytes: Uint8Array): { width: number; height: number; pixel(x: number, y: number): number[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { width, height } = pngSize(bytes)!;
  expect(bytes[24]).toBe(8);
  expect(bytes[25]).toBe(6);
  const chunks: Uint8Array[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === "IDAT") chunks.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= 4 ? out[y * stride + x - 4]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predicted = [0, a, b, (a + b) >> 1, paeth][filter]!;
      out[y * stride + x] = (value + predicted) & 0xff;
    }
  }
  return { width, height, pixel: (x, y) => [...out.subarray(y * stride + x * 4, y * stride + x * 4 + 4)] };
}

describe.skipIf(!Bun.which("osascript"))("the picture, drawn by AppKit", () => {
  test("at twice the points, a background only under its own run, and the image drawn where it is placed", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-parity-test-"));
    try {
      const out = join(root, "out.png");
      const spec: ComposeSpec = { out, width: 200, height: 60, scale: 2, background: "#000000", items: [
        { kind: "rect", rect: [150, 10, 40, 40], fill: "#0000ff" },
        { kind: "text", at: [0, 0], clip: [0, 0, 140, 60], size: 20, line: 30, mono: true, lines: [
          // One cell with a background, then plain spaces: the background must not run on under them.
          [{ t: "A", fg: "#ffffff" }, { t: " ", fg: "#000000", bg: "#ff0000" }, { t: "     ", fg: "#ffffff" }, { t: "|", fg: "#ffffff" }],
        ] },
      ] };
      expect(await defaultParityDeps({ socketPath: "", sessionsPath: "" }).compose(spec)).toBeNull();
      const png = decodePng(new Uint8Array(readFileSync(out)));
      expect([png.width, png.height]).toEqual([400, 120]);
      // SF Mono's advance at 20 pt is ~12 pt: the red cell is the second one, 12-24 pt in; the plain ones after it are not red.
      const red = (x: number) => { const [r, g, b] = png.pixel(x * 2, 15 * 2); return r! > 200 && g! < 60 && b! < 60; };
      expect(red(18)).toBe(true);
      expect(red(40)).toBe(false);
      expect(red(60)).toBe(false);
      expect(png.pixel(170 * 2, 30 * 2)).toEqual([0, 0, 255, 255]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a spec it can't write is an error in words, not a picture", async () => {
    const error = await defaultParityDeps({ socketPath: "", sessionsPath: "" }).compose({ out: "/nonexistent-dir/x.png", width: 10, height: 10, scale: 1, background: "#000000", items: [] });
    expect(error).toContain("could not write /nonexistent-dir/x.png");
    expect(existsSync("/nonexistent-dir/x.png")).toBe(false);
  });

  test("appended text never inherits the run before it", () => {
    for (const attribute of ["NSBackgroundColorAttributeName", "NSUnderlineStyleAttributeName", "NSStrikethroughStyleAttributeName"]) {
      expect(COMPOSE_SCRIPT).toContain(`else line.removeAttributeRange($.${attribute}, range);`);
    }
  });
});
