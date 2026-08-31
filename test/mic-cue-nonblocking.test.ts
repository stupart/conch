import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");

/**
 * The courtesy sound must never gate the microphone.
 *
 * This was the entire remaining delay, and the daemon's own timing print is
 * what proved it: `mic cue took 3.9s` on a wake that reached `listening` 3.9s
 * after the press. Setup was free; the tink was the wait. A 0.56s system sound
 * carries ~0.8s of fixed afplay overhead even in an idle shell, and more in the
 * daemon where it contends with the warm TTS worker for the audio device.
 *
 * It was also backwards: a cue whose job is to say "the mic is open" played to
 * completion BEFORE that was true.
 */
test("the open cue is fired, not awaited", () => {
  const loop = daemon.slice(daemon.indexOf("async function conversationLoop"));
  const beforeListening = loop.slice(0, loop.indexOf('log(`listening → '));

  expect(beforeListening).toContain('void micCue(cfg, "open")');
  // The await is the bug. Any form of it puts a sound in front of the mic.
  expect(beforeListening).not.toContain('await micCue(cfg, "open")');
});

/**
 * The 350ms decay went with it, deliberately.
 *
 * It existed to keep sox from arming while the cue was still audible — which
 * only makes sense while something awaits the cue. Left in place it would be a
 * bare sleep nobody waits on, which is worse than either choice: it would look
 * like a guarantee while providing none.
 */
test("no decay sleep is left behind pretending to guard anything", () => {
  const cue = daemon.slice(daemon.indexOf("const micCue = async ("));
  const body = cue.slice(0, cue.indexOf("\n  };"));
  expect(body).not.toContain("Bun.sleep(350)");
  // The cue itself is still awaitable — `close` and `sent` gate nothing and
  // reading their duration is how we learned this in the first place.
  expect(body).toContain("await speech.playCue(CUE_SOUND[kind]");
  expect(body).toContain("mic cue took");
});

/**
 * The press-to-open number stays reported. It is the only number the person
 * pressing the button actually experiences, and every delay so far has hidden
 * somewhere nobody was measuring.
 */
test("the mic still reports how long it took to open", () => {
  expect(daemon).toContain("micRequestedAt = Date.now();");
  expect(daemon).toContain("s after the press");
});
