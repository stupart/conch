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
    const app = readFileSync(
      join(import.meta.dir, "..", "mobile", "conch-ios", "conch-ios", "ConchApp.swift"),
      "utf8",
    );
    const wiring = app.slice(app.indexOf("speech.captureOwnsAudio = {"));
    const closure = wiring.slice(0, wiring.indexOf("\n                }"));
    expect(closure).toMatch(/phase == \.listening/);
    expect(closure).toMatch(/phase == \.sending/);
    // In a view it died with the view, which is how it came to be dropped
    // mid-utterance in the first place.
    expect(session).not.toMatch(/captureOwnsAudio/);
  });

  test("the transcript is not reachable from the view lifecycle", () => {
    // A per-view @StateObject died with its view and `.onDisappear` called
    // cancel(), which clears `committed` — the entire transcript, mid-word,
    // on any redraw that tore the destination down. Nothing about which
    // screen is showing should be able to delete what you have said.
    expect(session).not.toMatch(/@StateObject private var talk/);
    expect(session).not.toMatch(/talk\.cancel\(\)/);
    expect(app("ConchApp.swift")).toMatch(/@StateObject private var talk = TalkController\(\)/);
  });

  test("only a confirmed send may clear the transcript", () => {
    // Three separate bugs deleted this string, each fix closing only the path
    // it knew about. The policy replaces the whack-a-mole: exactly one write
    // clears it, and it is the one that follows `deliver`.
    const talk = app("TalkController.swift");
    const clears = [...talk.matchAll(/committed = ""/g)].map((m) => m.index ?? 0);
    // One is the property's own initialiser; the other must be the send.
    expect(clears.length).toBe(2);
    const send = talk.lastIndexOf("let delivered = await deliver(text)");
    expect(send).toBeGreaterThan(-1);
    expect(clears[1]).toBeGreaterThan(send);
    // Starting a recording continues an unsent draft rather than wiping it.
    const begin = talk.indexOf("private func beginCapture()");
    const beginBody = talk.slice(begin, talk.indexOf("private func makeRequest", begin));
    expect(beginBody).not.toMatch(/committed = ""/);
  });

  test("the draft outlives the process", () => {
    // A relaunch or crash mid-utterance is not a decision to discard speech.
    const talk = app("TalkController.swift");
    expect(talk).toMatch(/didSet \{ UserDefaults\.standard\.set\(committed, forKey: Self\.draftKey\) \}/);
    expect(talk).toMatch(/committed = UserDefaults\.standard\.string\(forKey: Self\.draftKey\)/);
  });

  test("words in hand are sent even when recognition never signed off", () => {
    // Refusing to send text we already have, because the recogniser failed to
    // say "done", punishes you for its problem.
    const talk = app("TalkController.swift");
    expect(talk).not.toMatch(/guard self\.finalizationSucceeded else \{[\s\S]*?return\n            \}/);
    const guardEmpty = talk.indexOf("guard !text.isEmpty else {");
    const deliver = talk.indexOf("let delivered = await deliver(text)");
    expect(guardEmpty).toBeGreaterThan(-1);
    expect(deliver).toBeGreaterThan(guardEmpty);
  });

  test("a draft is shown only under the session it was spoken to", () => {
    // One controller now serves every session; without this the draft would
    // surface under a conversation you never said it to.
    expect(session).toMatch(/talk\.targetSessionId == sessionId/);
    expect(session).toMatch(/talk\.toggle\(session: sessionId\)/);
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
