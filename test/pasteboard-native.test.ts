import { afterAll, expect, test } from "bun:test";
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
