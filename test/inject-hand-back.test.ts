import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");

/**
 * The app clears its draft when the daemon ACCEPTS a send — before anything
 * is typed anywhere. So an inject that then stops, or lands on the clipboard,
 * had already erased the only copy on screen (A8). The daemon hands the text
 * back through the dictation channel, which the composer applies once by id.
 * `deliver` runs in no test, so the two hand-backs are pinned as text.
 */
test("undelivered text is handed back to the composer on both failure paths", () => {
  const at = daemon.indexOf("const { via, interrupted, reason } = await injectText(");
  expect(at).toBeGreaterThan(-1);
  const tail = daemon.slice(at, at + 1_800);
  const interruptedAt = tail.indexOf("if (interrupted) {\n      publishDictation(text, event.sessionId);\n      return false;\n    }");
  const clipboardAt = tail.indexOf('if (via === "clipboard") {\n      publishDictation(text, event.sessionId);');
  expect(interruptedAt).toBeGreaterThan(-1);
  expect(clipboardAt).toBeGreaterThan(-1);
  expect(interruptedAt).toBeLessThan(clipboardAt);
});
