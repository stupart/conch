import { expect, test } from "bun:test";
import { assertNormalMicClosed, withNormalMicClosed } from "../src/audio-gate.ts";

test("audio output cannot begin while the normal producer owns the mic", async () => {
  let called = false;
  await expect(withNormalMicClosed(
    () => true,
    "TTS",
    () => {
      called = true;
    },
  )).rejects.toThrow("audio gate violation");
  expect(called).toBe(false);
});

test("audio gate awaits playback before allowing the caller to resume", async () => {
  let release!: () => void;
  const playback = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = false;
  const gated = withNormalMicClosed(() => false, "cue", async () => {
    await playback;
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  release();
  await gated;
  expect(finished).toBe(true);
});

test("exclusive barge precondition rejects an already-open normal producer", () => {
  expect(() => assertNormalMicClosed(() => true, "barge-in TTS")).toThrow("barge-in TTS");
  expect(() => assertNormalMicClosed(() => false, "barge-in TTS")).not.toThrow();
});
