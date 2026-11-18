import { expect, test } from "bun:test";
import { mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptMark, createTranscriptReader } from "../src/snippet.ts";

const prompt = (text: string) =>
  JSON.stringify({ type: "user", message: { content: text } }) + "\n";

/**
 * Counting prompts must not re-read the whole file every time.
 *
 * This is the mechanism the warm-up relies on, so it is worth a real test
 * rather than a source guard: once a transcript has been counted, later counts
 * resume from the cached state and parse only what was appended. If that ever
 * stops holding, warming buys nothing and the cost comes back — silently,
 * because the ANSWER stays correct either way. Only the reading is expensive.
 */
test("a counted transcript stays correct as it grows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conch-warm-"));
  const path = join(dir, "session.jsonl");

  writeFileSync(path, prompt("one") + prompt("two"));
  expect(await transcriptMark(path)).toBe(2);

  // Appended after the count — the incremental path has to pick these up.
  appendFileSync(path, prompt("three"));
  expect(await transcriptMark(path)).toBe(3);

  appendFileSync(path, prompt("four") + prompt("five"));
  expect(await transcriptMark(path)).toBe(5);

  // An append that adds no prompt must not move the count.
  appendFileSync(
    path,
    JSON.stringify({ type: "assistant", message: { content: "a reply" } }) + "\n",
  );
  expect(await transcriptMark(path)).toBe(5);
});

/**
 * Warming only pays off if the second read is INCREMENTAL — and correctness
 * cannot tell you whether it was.
 *
 * The count comes out right whether the reader resumes from cached state or
 * rescans from byte zero; only the reading is expensive. So a test that checks
 * the number proves nothing about the cost, and a mutation that disabled the
 * resume passed happily. This counts bytes instead, through the injectable
 * source, which is the only way to see the difference.
 */
test("counting again reads only what was appended", async () => {
  let content = Buffer.from(prompt("one") + prompt("two"));
  let bytesRead = 0;
  let generation = 0;

  const reader = createTranscriptReader({
    async open() {
      const snapshot = content;
      const version = {
        size: snapshot.length,
        mtimeNs: String(generation),
        dev: "1",
        ino: "1",
      };
      return {
        version,
        async read(offset: number, length: number) {
          const slice = snapshot.subarray(offset, offset + length);
          bytesRead += slice.length;
          return new Uint8Array(slice);
        },
        close() {},
      };
    },
  });

  expect(await reader.countUserPrompts("x")).toBe(2);
  const firstPass = bytesRead;
  expect(firstPass).toBeGreaterThanOrEqual(content.length);

  const appended = prompt("three");
  content = Buffer.concat([content, Buffer.from(appended)]);
  generation += 1;
  bytesRead = 0;

  expect(await reader.countUserPrompts("x")).toBe(3);
  // The whole point: the second count must not re-read the first two prompts.
  expect(bytesRead).toBeLessThan(firstPass);
  expect(bytesRead).toBeLessThanOrEqual(appended.length);
});
