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

  test("only a confirmed send or an explicit discard clears the transcript", () => {
    // Three separate bugs deleted this string, each fix closing only the path
    // it knew about. The policy replaces the whack-a-mole: the only writes
    // that empty it are the one after `deliver` and the one the user asked
    // for by name.
    const talk = app("TalkController.swift");
    const clears = [...talk.matchAll(/^\s*(?:self\.)?committed = ""$/gm)]
      .map((m) => m.index ?? 0);
    const send = talk.lastIndexOf("let delivered = await deliver(text)");
    const discard = talk.indexOf("func discard(session: String)");
    expect(send).toBeGreaterThan(-1);
    expect(discard).toBeGreaterThan(-1);
    for (const at of clears) {
      const inSend = at > send;
      const inDiscard = at > discard && at < talk.indexOf("\n    }", discard);
      expect(inSend || inDiscard).toBeTrue();
    }
    // Starting a recording continues an unsent draft rather than wiping it.
    const begin = talk.indexOf("private func beginCapture()");
    const beginBody = talk.slice(begin, talk.indexOf("private func makeRequest", begin));
    expect(beginBody).not.toMatch(/committed = ""/);
  });

  test("the draft outlives the process", () => {
    // A relaunch or crash mid-utterance is not a decision to discard speech.
    const talk = app("TalkController.swift");
    expect(talk).toMatch(/didSet \{ persistDrafts\(\) \}/);
    expect(talk).toMatch(/UserDefaults\.standard\.set\(all, forKey: Self\.draftKey\)/);
    expect(talk).toMatch(/parked = UserDefaults\.standard\.dictionary\(forKey: Self\.draftKey\)/);
  });

  test("a volatile partial can never shrink the visible transcript", () => {
    // Apple: a nonfinal transcription may represent only PART of the audio.
    // A pause makes the recogniser resegment and hand back "" or a stub for a
    // sentence it already reported whole — and assigning that wholesale is
    // what emptied the bubble with no Send, no navigation, nothing. Every
    // other guarantee in this file protects `committed`; the words on screen
    // are in `partial` until a result goes final.
    const talk = app("TalkController.swift");
    const absorb = talk.slice(talk.indexOf("private func absorbPartial("));
    const body = absorb.slice(0, absorb.indexOf("\n    }"));
    // Refusing a shorter hypothesis outright was the opposite failure: on a
    // pause the recogniser starts a NEW phrase, which is shorter, so the
    // transcript froze at its high-water mark and never grew again. A prefix
    // match is what separates "less of the same phrase" from "a new one".
    expect(body).toMatch(/hasPrefix/);
    expect(body).toMatch(/commit\(held\)/);
    // Silence is not a retraction.
    expect(body).toMatch(/if next\.isEmpty \{ return \}/);
    // Every hypothesis, nonfinal or final, goes through the same decision.
    const writes = [...talk.matchAll(/^\s*partial = (?!"").*$/gm)].map((m) => m[0]);
    for (const write of writes) {
      expect(write.includes("next") || write.includes("parked")).toBeTrue();
    }
    expect(talk.match(/absorbPartial\(removingCommittedOverlap\(from: text\)\)/g)?.length).toBe(2);
  });

  test("the mic silences speech before it opens, not after", () => {
    // The Mac has refused to open the mic while TTS speaks since day one; the
    // phone only ever had the other half. Capture opening on top of a live
    // utterance tore the playback route away mid-sentence, the synthesizer
    // stalled without calling didFinish, and the button sat showing
    // "speaking" while nothing played and the mic was live.
    const talk = app("TalkController.swift");
    const begin = talk.indexOf("private func beginCapture()");
    const silence = talk.indexOf("silenceSpeech()", begin);
    const route = talk.indexOf("session.setCategory(.record", begin);
    expect(silence).toBeGreaterThan(-1);
    expect(silence).toBeLessThan(route);
    // Installed beside its mirror image, where both objects outlive any view.
    expect(app("ConchApp.swift")).toMatch(/talk\.silenceSpeech = \{ \[weak speech\] in speech\?\.stop\(\) \}/);
  });

  test("overlap stripping is unconditional", () => {
    // Scoping it to rollover windows dropped its SECOND job — stopping a
    // resegmented phrase being appended again when the final for that same
    // audio arrives whole — and duplicated ~40 words of a real message into
    // a live session. Worse than the deliberate-repeat case it was fixing.
    const talk = app("TalkController.swift");
    expect(talk).not.toContain("expectsReplayOverlap");
    const start = talk.indexOf("private func removingCommittedOverlap");
    const fn = talk.slice(start, talk.indexOf("\n    }", start));
    expect(fn).toMatch(/guard !committed\.isEmpty, !candidate\.isEmpty else \{ return candidate \}/);
    // Nothing may short-circuit ahead of that guard.
    expect(fn.slice(0, fn.indexOf("guard !committed"))).not.toMatch(/return candidate/);
  });

  test("a transient overlay is not a handback of the audio", () => {
    // iOS reports .inactive for a context menu or system sheet. Releasing
    // there made the lease flap twice inside one second in the daemon log.
    const conchApp = app("ConchApp.swift");
    const inactive = conchApp.indexOf("case .inactive:");
    const background = conchApp.indexOf("case .background:");
    expect(inactive).toBeGreaterThan(-1);
    expect(conchApp.slice(background, inactive)).toMatch(/claimAudio\(false\)/);
    expect(conchApp.slice(inactive, inactive + 500)).not.toMatch(/claimAudio/);
  });

  test("a confirmed send clears only what it acknowledged", () => {
    // A late callback can append during the `await deliver`, and assigning
    // empty afterwards deletes words that were never sent to anyone.
    const talk = app("TalkController.swift");
    // Anchored to `finish`, not to the first delivery in the file. There are
    // two send paths now — a typed draft delivers directly — and the
    // generation guard below belongs to the one that tears down a capture.
    const finish = talk.indexOf("private func finish(deliver:");
    expect(finish).toBeGreaterThan(-1);
    const send = talk.indexOf("let delivered = await deliver(text)", finish);
    const after = talk.slice(send);
    expect(after).toMatch(/held\.hasPrefix\(text\)/);
    // Belt and braces: the capture's callbacks go inert before that await.
    const cleanup = talk.indexOf("self.finishingGeneration = nil");
    expect(talk.slice(cleanup, send)).toMatch(/self\.generation \+= 1/);
  });

  test("a draft belongs to its session, and cannot be sent to another", () => {
    // `deliver` comes from whichever screen is on top. Talking to A, walking
    // into B and tapping the button — which even said "Send" — would have
    // injected A's words into B, and an unsent draft would follow you in.
    const talk = app("TalkController.swift");
    const toggle = talk.slice(talk.indexOf("func toggle(session: String"));
    const body = toggle.slice(0, toggle.indexOf("\n    }"));
    expect(body).toMatch(/session == targetSessionId/);
    const finish = body.indexOf("finish(deliver: deliver)");
    const guardIndex = body.indexOf("session == targetSessionId");
    expect(guardIndex).toBeLessThan(finish);
    // Drafts are stored per session, not one string for the whole app.
    expect(talk).toMatch(/private var parked: \[String: String\]/);
    // Every talk affordance is scoped to the session on screen.
    expect(session).toMatch(/talk\.targetSessionId == sessionId && talk\.phase == \.listening/);
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
    // Every controller call names THIS session. The mic and send used to be one
    // `toggle`; they are separate now, so assert the property that matters —
    // scoping — rather than one method's name.
    expect(session).toMatch(/talk\.open\(session: sessionId\)/);
    expect(session).toMatch(/talk\.send\(session: sessionId\)/);
    // `closeMic()` is deliberately session-less: it closes whichever mic is
    // open, and the view only offers it while THIS session holds it.
    expect(session).not.toMatch(/talk\.(open|send)\((?!session: sessionId)/);
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
