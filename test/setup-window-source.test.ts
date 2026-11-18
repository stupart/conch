import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Setup's microphone check opens the mic only through the voice loop's one reservation (`VoiceLoop.holdMic`, which
// voice-loop.test.ts drives), so it can never record while conch is speaking. The wiring lives in daemon.ts.
const daemon = readFileSync(join(import.meta.dir, "..", "src/daemon.ts"), "utf8");

test("the microphone check holds the mic through the voice loop's reservation", () => {
  expect(daemon).toContain('hold: (stop) => voice.holdMic(MIC_CHECK_QUIET_WITHIN_MS, stop, "Microphone check"),');
});
