import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const voice = readFileSync(join(import.meta.dir, "..", "src", "voice-loop.ts"), "utf8");

/**
 * The courtesy sound must never gate the microphone.
 *
 * This was the entire remaining delay, and the daemon's own timing print is
 * what proved it: `mic cue took 3.9s` on a wake that reached `listening` 3.9s
 * after the press. Setup was free; the tink was the wait. It was also
 * backwards: a cue whose job is to say "the mic is open" played to completion
 * BEFORE that was true.
 *
 * Executed in voice-loop.test.ts since cut four: the open cue is fired, not
 * awaited; the mic still waits for it to finish sounding (the audio gate stays
 * — the fix is less noise, never a mic opened through sound); a composer
 * dictation plays no cue at all; and press-to-open is measured at the arm, once.
 */

/**
 * The 350ms decay went with it, deliberately.
 *
 * It existed to keep sox from arming while the cue was still audible — which
 * only makes sense while something awaits the cue. Left in place it would be a
 * bare sleep nobody waits on, which is worse than either choice: it would look
 * like a guarantee while providing none.
 */
test("no decay sleep is left behind pretending to guard anything", () => {
  const at = voice.indexOf("const micCue = async (");
  expect(at).toBeGreaterThan(-1);
  const cue = voice.slice(at);
  const end = cue.indexOf("\n  };");
  expect(end).toBeGreaterThan(-1);
  const body = cue.slice(0, end);
  // The cue itself is still awaitable — `close` and `sent` gate nothing and
  // reading their duration is how we learned this in the first place.
  expect(body).toContain("await speech.playCue(CUE_SOUND[kind]");
  expect(body).toContain("mic cue took");
  expect(body).not.toContain("Bun.sleep(350)");
});
