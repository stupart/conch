import { expect, test } from "bun:test";
import { mkdtempSync, appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptMark, createTranscriptReader } from "../src/snippet.ts";

const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");

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
 * The expensive read happens before anything waits on it.
 *
 * `countUserPrompts` is the only reader that must see the whole file — with no
 * cached prompt count it scans from byte zero, measured at 3.77s on a 189MB
 * session. Everything else takes the cheap tail path, which is what hid it:
 * reading replies aloud kept the cache warm for `assistant` while leaving the
 * prompt count unset, so the first count still paid full price.
 */
test("every event warms its session's transcript, once and off the hot path", () => {
  const enqueue = daemon.slice(daemon.indexOf("function enqueue(incoming: TurnEvent): void {"));
  const body = enqueue.slice(0, enqueue.indexOf("\n  }"));
  // Present at all — `indexOf` returns -1 for a MISSING line, and -1 is less
  // than any real index, so an ordering assertion alone passes when the call
  // has been deleted. That exact trap survived a mutation here once already.
  expect(body).toContain("warmTranscript(event.transcriptPath)");
  // ...and before the ordering check, so an event dropped as stale still warms.
  expect(body.indexOf("warmTranscript(event.transcriptPath)"))
    .toBeLessThan(body.indexOf("eventOrder.accept(event)"));

  const warm = daemon.slice(daemon.indexOf("function warmTranscript(path: string | undefined): void {"));
  const warmBody = warm.slice(0, warm.indexOf("\n  }"));
  // Once per path...
  expect(warmBody).toContain("if (!path || warmedTranscripts.has(path)) return;");
  // ...serialized, because restoring turns at startup hands us several at once
  // and simultaneous full scans of 200MB files is a herd on a busy machine...
  expect(warmBody).toContain("warmQueue = warmQueue");
  // ...never awaited by the caller...
  expect(body).not.toContain("await warmTranscript");
  // ...and a failure is retried rather than remembered as done.
  expect(warmBody).toContain("warmedTranscripts.delete(path)");
});

/**
 * Startup is the case that actually hurt.
 *
 * Reconstructed turns deliberately never enter `enqueue` — they may only
 * repaint rows, never announce or open a recorder — so warming from `enqueue`
 * alone would leave the FIRST wake after a daemon restart paying the whole
 * scan. That is precisely the 08-30 failure: daemon up at 23:05, click at
 * 23:18:44, mic at 23:18:56.
 */
test("a restarted daemon warms the sessions it restores", () => {
  const rehydrate = daemon.slice(daemon.indexOf("async function rehydrateFromTranscripts()"));
  const body = rehydrate.slice(0, rehydrate.indexOf("\n  }"));
  expect(body).toContain("warmTranscript(path ?? undefined)");
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
