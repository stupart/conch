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

/**
 * The reported number has to be the one a person feels.
 *
 * "0.0s after the press" was true and useless: it was printed where conch
 * DECIDES to listen, before the recorder is armed, so it measured the daemon
 * agreeing with itself. Tyler pressed the button and said "it's still a while"
 * against a log claiming instant. The honest instant is the arm — sox open on
 * the device and able to hear you — so that is where it is measured.
 */
test("press-to-open is measured at the arm, not at the decision", () => {
  const loop = daemon.slice(daemon.indexOf("async function conversationLoop"));
  // The statement itself, not everything preceding it — `reportArmed` is
  // defined earlier in this function and legitimately contains the phrase.
  const start = loop.indexOf('log(`listening → ');
  expect(start).toBeGreaterThan(-1);
  const decision = loop.slice(start, loop.indexOf("\n", start));

  // The decision line must not carry a timing claim any more.
  expect(decision).not.toContain("after the press");

  // The arm callback owns it, and clears the stamp so a later arm in the same
  // exchange cannot re-report a press that already opened.
  const report = daemon.slice(daemon.indexOf("const reportArmed = ()"));
  const body = report.slice(0, report.indexOf("\n    };"));
  expect(body).toContain("micRequestedAt = null;");
  expect(body).toContain("mic armed ");

  // ...and it is actually wired into the recorder's armed transition.
  expect(daemon).toContain("onArmed?.();");
  expect(loop).toContain("reportArmed,");
});

/**
 * A composer dictation makes no sound at all before the mic opens.
 *
 * Firing the cue instead of awaiting it did NOT decouple them, and the
 * measurements said so exactly: `mic cue took 1.4s` beside `mic armed 1.4s
 * after the press`. The next thing on this path is `reserveNormalMic`, which
 * awaits `quiescent()` — the audio gate that keeps the mic shut while conch is
 * making any sound, and the reason the loop cannot hear itself. The cue is a
 * sound, so the gate correctly waited for it.
 *
 * The gate stays. The sound goes — for the visual exchange only, on the same
 * argument as the spoken announcement: you pressed a mic beside a text field
 * and you are watching it.
 */
test("no cue is played before a composer dictation's mic opens", () => {
  const loop = daemon.slice(daemon.indexOf("async function conversationLoop"));
  const beforeListening = loop.slice(0, loop.indexOf('log(`listening → '));

  expect(beforeListening).toContain('if (!event.compose) void micCue(cfg, "open")');

  // The gate itself must remain ON THIS PATH — `reserveNormalMic` is called
  // from several branches, so asserting it merely exists lets the main one be
  // deleted while the test still passes. It sits between the decision to listen
  // and the recorder starting, which is the window that matters: it is what
  // stops the loop hearing itself, and the fix here is to make less noise,
  // never to open the mic through sound.
  const afterDecision = loop.slice(loop.indexOf('log(`listening → '));
  const gate = afterDecision.indexOf("await reserveNormalMic()");
  const start = afterDecision.indexOf("session.start(");
  expect(gate).toBeGreaterThan(-1);
  expect(start).toBeGreaterThan(-1);
  expect(gate).toBeLessThan(start);
});
