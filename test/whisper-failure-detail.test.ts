import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
const transcribe = read("src/transcribe.ts");
const daemon = read("src/daemon.ts");

/**
 * A failure that will not say what it was cannot be fixed.
 *
 * `whisper-server recovery requested: request-failed` appeared on nearly every
 * capture for hours while the catch that produced it threw the error away. It
 * is not free noise either: the same catch resets health, and an unhealthy
 * client makes the NEXT transcription take the slow cold path — so a silent
 * failure here is paid for twice, once in diagnosis and once in latency.
 */
test("a failed whisper request reports the underlying error", () => {
  const warm = transcribe.slice(transcribe.indexOf("async transcribeWarm("));
  // Bound, not swallowed: `catch {}` is how the cause was lost.
  expect(warm).toContain("} catch (error) {");
  expect(warm).toContain("this.note(detail)");
  expect(warm).toContain("error instanceof Error ? `${error.name}: ${error.message}`");

  // ...and the daemon actually routes it somewhere a person will read.
  expect(daemon).toContain("setNoteHandler((detail) => log(`whisper request failed — ${detail}`))");
});

/**
 * Reporting must not replace recovering. The supervisor still runs: the point
 * is to learn the cause, not to stop reacting to it.
 */
test("reporting the cause does not disable recovery", () => {
  const warm = transcribe.slice(transcribe.indexOf("async transcribeWarm("));
  expect(warm).toContain('this.recovery("request-failed")');
  expect(warm).toContain("this.resetHealth();");
});
