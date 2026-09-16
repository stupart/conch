import { afterAll, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { FRONT_TTY_SCRIPT, injectText, type InjectTextOptions } from "../src/inject.ts";
import { createPasteboard, runUICommand } from "../src/pasteboard.ts";

/**
 * The shipped JXA program, run for real by osascript, against a real AppKit pasteboard.
 *
 * Every other pasteboard test mocks `runUICommand`, so the program's JavaScript was never
 * once executed by JavaScriptCore's ObjC bridge — which is the only place the bug lived.
 * `data.length` and every `count` bridge to a STRING, so `bytes += data.length` concatenated
 * ("0" + "3883" + "35" + "24") and read as 38 million bytes: any clipboard with three or more
 * representations was refused, and every paste-based send failed with clipboard-unavailable.
 *
 * NEVER the general pasteboard. A uniquely named board is a separate, private board — Tyler
 * is working, and a test that captures and restores his clipboard is a test that can lose it.
 */
const BOARD = `com.conch.test.${process.pid}.${Date.now()}`;

/** Writes the representations onto the named board, and releases it afterwards. */
const HARNESS = `
ObjC.import('AppKit');
function run(argv) {
  var raw = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var input = JSON.parse($.NSString.alloc.initWithDataEncoding(raw, $.NSUTF8StringEncoding).js);
  var board = $.NSPasteboard.pasteboardWithName($(argv[0]));
  if (argv[1] === 'release') { board.releaseGlobally; return 'released'; }
  if (argv[1] === 'count') { return String(Number(board.changeCount)); }
  if (argv[1] === 'text') {
    var held = board.stringForType($('public.utf8-plain-text'));
    return JSON.stringify({ text: !held || held.isNil() ? null : held.js, changeCount: Number(board.changeCount) });
  }
  var item = $.NSPasteboardItem.alloc.init;
  Object.keys(input).forEach(function(type) {
    var data = $.NSData.alloc.initWithBase64EncodedStringOptions($(input[type]), 0);
    if (!item.setDataForType(data, $(type))) throw new Error('setup failed for ' + type);
  });
  board.clearContents;
  if (!board.writeObjects($.NSArray.arrayWithObject(item))) throw new Error('setup write failed');
  return 'ok';
}`;

const harness = (operation: string, input: object = {}) =>
  runUICommand(["osascript", "-l", "JavaScript", "-e", HARNESS, "--", BOARD, operation], JSON.stringify(input));

const b64 = (value: string) => Buffer.from(value).toString("base64");
// The exact shape of an ordinary Chrome copy, the one that broke Tyler's sends.
const original = {
  "public.html": b64("x".repeat(3883)),
  "public.utf8-plain-text": b64("y".repeat(35)),
  "org.chromium.internal.source-rfh-token": b64("z".repeat(24)),
  "org.chromium.source-url": b64("w".repeat(32)),
};

afterAll(async () => { await harness("release"); });

test("the real JXA program captures and restores a four-representation clipboard", async () => {
  expect((await harness("write", original)).exitCode).toBe(0);
  const pasteboard = createPasteboard(runUICommand, BOARD);

  const lease = await pasteboard.prepare("the words being sent");
  expect(lease.items).toEqual([original]);
  // A bridged changeCount arrives as a string; the lease's own type says number, and
  // inject.ts hands it to AppleScript as an integer to compare against.
  expect(typeof lease.changeCount).toBe("number");

  expect(await pasteboard.restore(lease)).toBe(true);
  // Read the board back through the program itself: every representation is there again.
  const after = await pasteboard.prepare("reading the board back");
  expect(after.items).toEqual([original]);
  await pasteboard.restore(after);
});

/**
 * The degraded paste path — the one taken when the pasteboard helper cannot preserve the
 * clipboard — driven against this private board with real change counts.
 *
 * Only Terminal is fake here. The focus scripts are answered locally and their System Events
 * lines never run, so no window is raised and nothing is ever typed into a real session.
 * Everything about the CLIPBOARD is real: conch's own AppKit lines are executed by osascript
 * against a real board whose changeCount a real copy really moves. That is the boundary the
 * defect lived on, and the boundary `test/inject-transactions.test.ts` replaces wholesale.
 */
const cfg = { autoSubmit: true, keystrokeFallback: true } as Config;
const TTY = "tty-fixture";
const USER_TEXT = "the user's own copy — conch must never submit this";
const SENT = `the words conch was asked to send\n${"and more of them ".repeat(20)}`;

const boardState = async (): Promise<{ text: string | null; changeCount: number }> =>
  JSON.parse((await harness("text")).text.trim());
const writeBoard = async (text: string) => {
  expect((await harness("write", { "public.utf8-plain-text": b64(text) })).exitCode).toBe(0);
};

/**
 * Run conch's own script against the private board, with the Terminal half removed.
 *
 * The clipboard lines are the shipped ones, character for character apart from which board
 * they name — so the comparison that decides whether someone else's copy gets pasted is the
 * real one, evaluated by AppleScript on real bridged values, not a fake's `!==`.
 */
async function conchScriptOnPrivateBoard(lines: string[], argv: string[]) {
  const script = lines
    .filter((line) => !/System Events|application "Terminal"|frontName|frontTty/.test(line))
    .map((line) => line.replace("generalPasteboard()", `pasteboardWithName:"${BOARD}"`));
  // If the shipped text ever stops matching, this must refuse to run rather than reach for
  // Tyler's actual clipboard. (A guard with no clipboard line — the Return after a paste —
  // names no board at all.)
  expect(script.join("\n")).not.toContain("generalPasteboard");
  if (script.join("\n").includes("NSPasteboard")) expect(script.join("\n")).toContain(BOARD);
  const result = await runUICommand(["osascript", ...script.flatMap((line) => ["-e", line]), ...(argv.length ? ["--", ...argv] : [])]);
  return { text: result.text, stderr: result.stderr, timedOut: result.timedOut, exitCode: result.exitCode };
}

function degradedPaste(overrides: Partial<InjectTextOptions> & { afterVersion?: () => Promise<void> } = {}) {
  const { afterVersion, ...options } = overrides;
  const pasted: string[] = [];
  const copied: string[] = [];
  return {
    pasted,
    copied,
    options: {
      findTmuxPane: async () => null,
      ttyForPid: async () => TTY,
      sleep: async () => {},
      copyToClipboard: async (text: string) => { await writeBoard(text); copied.push(text); },
      // A helper that broke, with nothing to say about the clipboard it could not capture.
      pasteboard: {
        prepare: async () => { throw new Error("Pasteboard helper failed"); },
        restore: async () => false,
      },
      osa: async (lines: string[], argv: string[] = []) => {
        const script = lines.join("\n");
        if (script === FRONT_TTY_SCRIPT) return { text: `/dev/${TTY}`, timedOut: false, exitCode: 0 };
        if (script.includes("conch-focus-guard")) {
          const result = await conchScriptOnPrivateBoard(lines, argv);
          // A paste takes whatever the board holds at that instant — the whole question.
          if (result.text.trim() === "ok" && script.includes('keystroke "v"')) pasted.push((await boardState()).text ?? "");
          return result;
        }
        if (script.includes("changeCount")) {
          const result = await conchScriptOnPrivateBoard(lines, argv);
          await afterVersion?.();
          return result;
        }
        if (script.includes("activate")) return { text: "ok", timedOut: false, exitCode: 0 };
        throw new Error(`unexpected script: ${script}`);
      },
      ...options,
    } satisfies InjectTextOptions,
  };
}

test("a broken helper still delivers, and the words pasted are conch's own", async () => {
  await writeBoard(USER_TEXT);
  const run = degradedPaste();
  expect(await injectText(cfg, 1, SENT, undefined, run.options)).toEqual({ via: "osascript-focused" });
  expect(run.pasted).toEqual([SENT]);
  expect((await boardState()).text).toBe(SENT);
}, 30_000);

test("a copy landing between conch's write and the paste is never submitted", async () => {
  await writeBoard("something conch replaces");
  // The real race: pbcopy is awaited, and the user copies while conch is raising the window.
  const run = degradedPaste({ afterVersion: () => writeBoard(USER_TEXT) });
  expect(await injectText(cfg, 1, SENT, undefined, run.options))
    .toEqual({ via: "none", failed: true, reason: "clipboard-changed" });
  // Nothing was pasted, and the user's copy is still theirs.
  expect(run.pasted).toEqual([]);
  expect((await boardState()).text).toBe(USER_TEXT);
}, 30_000);

test("a send cancelled while conch is writing the clipboard types nothing", async () => {
  await writeBoard("something conch replaces");
  let copied = false;
  const run = degradedPaste({
    copyToClipboard: async (text: string) => { await writeBoard(text); copied = true; },
  });
  expect(await injectText(cfg, 1, SENT, async () => !copied, run.options))
    .toMatchObject({ via: "none", interrupted: true });
  expect(run.pasted).toEqual([]);
}, 30_000);

test("a clipboard the helper protects is a refusal, not a copy over it", async () => {
  // Over 16 MiB: the real helper cannot put this board back afterwards, so it refuses to take
  // it. That refusal is the feature — it must never become "copy over it and paste anyway".
  const oversize = Buffer.alloc(17 * 1024 * 1024, 0x61).toString("base64");
  expect((await harness("write", { "public.utf8-plain-text": oversize })).exitCode).toBe(0);
  const before = (await harness("count")).text.trim();
  const run = degradedPaste({ pasteboard: createPasteboard(runUICommand, BOARD) });
  expect(await injectText(cfg, 1, SENT, undefined, run.options))
    .toEqual({ via: "none", failed: true, reason: "clipboard-unpreservable" });
  // Refused all the way down: nothing copied, nothing typed, and the board conch would not
  // capture is exactly as its owner left it.
  expect(run.copied).toEqual([]);
  expect(run.pasted).toEqual([]);
  expect((await harness("count")).text.trim()).toBe(before);
}, 30_000);
