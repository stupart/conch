import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/// The iOS app has no test target, and standing one up to assert three lines
/// of wiring costs more than it protects. These read the source the same way
/// `daemon-boundaries` does — because wiring is exactly what regressed here,
/// twice, and both times the logic either side of it was already correct.
const app = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "mobile", "conch-ios", "conch-ios", name), "utf8");

describe("only one side of the phone owns the audio route", () => {
  const speech = app("SpeechController.swift");
  const session = app("SessionView.swift");

  test("speaking is gated on capture, at every entry point", () => {
    // Speaking flips the shared AVAudioSession to .playback and reactivates
    // it. Doing that under a live capture tears down recognition and the
    // words are lost. `consider` is the automatic path and `speak` the
    // manual one; a guard on either alone leaves the other lethal.
    for (const fn of ["func consider(", "func speak("]) {
      const start = speech.indexOf(fn);
      expect(start).toBeGreaterThan(-1);
      const guard = speech.indexOf("guard !captureOwnsAudio()", start);
      const configure = speech.indexOf("configureSession()", start);
      expect(guard).toBeGreaterThan(-1);
      if (configure > -1) expect(guard).toBeLessThan(configure);
    }
  });

  test("a deferred reply is not marked spoken", () => {
    // Marking it would drop it permanently: `consider` never revisits a
    // reply it believes it has read, so the words you were owed while
    // talking would simply never be said.
    const guard = speech.indexOf("guard !captureOwnsAudio()");
    const mark = speech.indexOf("spoken[reply.sessionId] = text", guard);
    expect(mark).toBeGreaterThan(guard);
  });

  test("capture owns the route through finalisation, not just the open mic", () => {
    // `finish()` sets `.sending`, THEN ends audio and waits up to three
    // seconds for the final result. Gating on `.listening` alone opened that
    // window at the exact moment a queue of unread replies was released.
    const wiring = session.slice(session.indexOf("speech.captureOwnsAudio = {"));
    expect(wiring).toMatch(/talk\.phase == \.listening/);
    expect(wiring.slice(0, wiring.indexOf("}"))).toMatch(/talk\.phase == \.sending/);
  });

  test("the reply is released before the mic opens", () => {
    // didFinish once opened the mic and then deactivated the session — that
    // deactivation could land on the recording it had just started, breaking
    // the auto-open path the whole loop rests on.
    const deactivate = speech.indexOf("setActive(\n                false");
    const open = speech.indexOf("self.onFinishedReading?()");
    expect(deactivate).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(-1);
    expect(deactivate).toBeLessThan(open);
  });
});
