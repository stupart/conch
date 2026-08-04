import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/// The iOS app has no test target, and standing one up to assert three lines
/// of wiring costs more than it protects. These read the source the same way
/// `daemon-boundaries` does — because wiring is exactly what regressed here,
/// twice, and both times the logic either side of it was already correct.
const app = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "mobile", "conch-ios", "conch-ios", name), "utf8");

/** Return the complete brace-delimited Swift block following `marker`. */
const swiftBlock = (source: string, marker: string) => {
  const markerIndex = source.indexOf(marker);
  expect(markerIndex).toBeGreaterThan(-1);
  const open = source.indexOf("{", markerIndex);
  expect(open).toBeGreaterThan(markerIndex);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`unterminated Swift block after ${marker}`);
};

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

  test("only a confirmed send or an explicit discard removes final segments", () => {
    // Final recognizer results are the durable source of truth. Starting,
    // switching, finalization failure, and teardown may change the live
    // display hypothesis, but must not erase an immutable segment.
    const talk = app("TalkController.swift");
    expect(talk).toMatch(/@Published private\(set\) var segments: \[String\]/);
    expect(swiftBlock(talk, "func discard(session: String)")).toMatch(/segments\.removeAll\(\)/);

    const acknowledged = swiftBlock(talk, "if delivered {");
    expect(acknowledged).toMatch(/segments\.removeFirst\(/);
    expect(acknowledged).toMatch(
      /segments\.starts\(with: sentSegments\)|Array\((?:self\.)?segments\.prefix\(sentSegments\.count\)\) == sentSegments/,
    );
    expect(acknowledged).not.toMatch(/segments\.removeAll\(\)|segments = \[\]|hasPrefix/);

    // One deliberate clear, one acknowledged-prefix consumption, no other
    // destructive mutation of the active segment buffer.
    expect([...talk.matchAll(/segments\.(?:removeAll|removeFirst)\(/g)]).toHaveLength(2);
    // Starting a recording continues an unsent draft rather than wiping it.
    const begin = talk.indexOf("private func beginCapture()");
    const beginBody = talk.slice(begin, talk.indexOf("private func makeRequest", begin));
    expect(beginBody).not.toMatch(/segments\.(?:removeAll|removeFirst)\(|segments = \[\]/);
  });

  test("the draft outlives the process", () => {
    // A relaunch or crash is not a decision to discard finalized speech.
    const talk = app("TalkController.swift");
    expect(talk).toMatch(/didSet \{ persistDrafts\(\) \}/);
    expect(talk).toMatch(/UserDefaults\.standard\.set\(/);
    expect(talk).toMatch(/forKey: Self\.draftKey/);
    expect(talk).toMatch(/(?:UserDefaults\.standard|defaults)\.(?:data|dictionary)\(forKey: Self\.draftKey\)/);
    // c8dcead shipped the first durable draft under this key. Changing the
    // schema without reading it makes an already-preserved user message
    // disappear on upgrade.
    expect(talk).toContain('"conch.draft.committed"');
  });

  test("only final results append immutable segments; partial is display-only", () => {
    // SFSpeech nonfinal results are revisable hypotheses. They may replace the
    // live line as often as needed, but they cannot revise or append the
    // reducer-like finalized segment buffer.
    const talk = app("TalkController.swift");
    expect(talk).toMatch(/var transcript: String[\s\S]*segments\.joined\(separator: " "\)/);
    expect(talk).toMatch(/didFinishRecognition[\s\S]*finalText = recognitionResult\.bestTranscription/);
    const finished = swiftBlock(talk, "private func recognitionFinished(");
    expect(finished).toMatch(/immutableFinal[\s\S]*appendFinalSegment\(/);
    const partial = swiftBlock(talk, "private func receivePartial(");
    expect(partial).toMatch(/partial = text/);
    expect(partial).not.toMatch(/segments\.|appendFinalSegment/);
    const appendCalls = [...talk.matchAll(/appendFinalSegment\(/g)].length;
    expect(appendCalls).toBeGreaterThan(1); // declaration plus final callback
    expect(talk).not.toMatch(/absorbPartial|\bricher\b/);
  });

  test("phrase audio has no replay, cursor, or text-overlap path", () => {
    // Every captured buffer belongs to exactly one phrase. Replaying audio
    // requires heuristic text deletion, which cannot distinguish duplicated
    // audio from a deliberate repeated phrase.
    const talk = app("TalkController.swift");
    for (const obsolete of [
      "RecognitionAudioRelay",
      "replayCursor",
      "replayAfterSequence",
      "discard(through:",
      "expectsReplayOverlap",
      "removingCommittedOverlap",
    ]) expect(talk).not.toContain(obsolete);
  });

  test("phrase rollover assigns every tap buffer exactly once with no handoff gap", () => {
    // AVAudioEngine's tap is concurrent with MainActor. The sink replacement
    // therefore has to be one locked operation: seal the old phrase and make
    // its successor current before returning it for endAudio/finalization.
    // Stopping/reinstalling the tap between phrases would create a real hole.
    const talk = app("TalkController.swift");
    expect(talk).toContain("private final class PhraseAudioRouter");
    const router = swiftBlock(talk, "private final class PhraseAudioRouter");
    expect(router).toContain("NSLock()");
    expect(router).toMatch(/func append\(_ source: AVAudioPCMBuffer\)/);
    expect(router).toMatch(/func seal/);
    expect(router).toMatch(/nextPhraseID/);

    // Rollover itself never stops the engine or removes/reinstalls the tap.
    const rollover = swiftBlock(talk, "private func sealCurrentPhrase");
    expect(rollover).not.toMatch(/engine\.stop|removeTap|installTap/);
    const swap = rollover.search(/(?:audioRouter|router)\.seal/);
    const end = rollover.indexOf("endAudio()", swap);
    expect(swap).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(swap);

    // The router retains phrase identity and a serial FIFO. This prevents an
    // older task's late final from overtaking a newer phrase, and avoids
    // starting task N+1 while task N is still active (Speech error 1100).
    expect(talk).toMatch(/(?:struct|class) (?:Buffered)?Phrase[\s\S]*\b(?:id|sequence): Int/);
    expect(talk).toMatch(/(?:pending|sealed|queued)Phrases/);
    expect(talk).toMatch(/removeFirst\(\)/);

    // Speech/the system may finalize before the RMS timer. Its final callback
    // must rotate the still-active phrase synchronously; otherwise `complete`
    // removes the phrase while the tap targets its stale id and drops buffers.
    const didFinish = swiftBlock(talk, "didFinishRecognition recognitionResult:");
    expect(didFinish).toMatch(/onFinalDetected\(phraseID\)/);
    const nativeFinal = swiftBlock(talk, "func recognizerDidFinalize(");
    expect(nativeFinal).toMatch(/activePhraseID == phraseID/);
    expect(nativeFinal).toMatch(/sealLocked\(/);
    expect(nativeFinal).toMatch(/createSuccessor: true/);
  });

  test("silence segmentation is voiced-gated and bounded below the task limit", () => {
    const talk = app("TalkController.swift");
    // The 2% threshold matches the Mac recorder's default end threshold. The
    // phone uses a deliberately shorter 800 ms phrase boundary (not the Mac's
    // 3.5 s whole-utterance boundary) so it forces a final before Speech's own
    // pause endpoint can strand a task. A sub-minute cap covers uninterrupted
    // speech, so no recognizer task approaches the roughly one-minute limit.
    expect(talk).toMatch(/bufferSize: 1024/);
    expect(talk).toMatch(/silenceThreshold[^\n]*0\.02/);
    expect(talk).toMatch(/trailingSilence[^\n]*0\.8/);
    const maximum = talk.match(/(?:maxPhrase|maximumPhraseDuration)[^=\n]*=\s*([\d.]+)/);
    expect(maximum).not.toBeNull();
    expect(Number(maximum?.[1])).toBeLessThan(60);
    expect(talk).toMatch(/hasVoice|hasVoicedAudio|heardVoice/);
    expect(talk).toMatch(/(?:voice|voiced)[\s\S]*trailingSilence/);
    expect(talk).toMatch(/maximumPhraseDuration[\s\S]*(?:sealCurrentPhrase|seal\()/);
  });

  test("send is a phrase-finalization barrier", () => {
    const talk = app("TalkController.swift");
    const finish = swiftBlock(talk, "private func finish(");
    const seal = finish.search(/sealCurrentPhrase|audioRouter\.(?:seal|closeAndSeal)/);
    const wait = finish.search(/await .*Final/);
    const snapshot = finish.search(/let sentSegments|let acknowledgedSegments/);
    const deliver = finish.indexOf("await deliver");
    expect(seal).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(seal);
    expect(snapshot).toBeGreaterThan(wait);
    expect(deliver).toBeGreaterThan(snapshot);
  });

  test("a confirmed send clears only what it acknowledged", () => {
    // A late/future capture may append segments beyond the immutable send
    // snapshot. Acknowledgement consumes that exact array prefix, never a
    // String prefix and never the whole current draft.
    const talk = app("TalkController.swift");
    const send = talk.indexOf("let delivered = await deliver(text)");
    const after = talk.slice(send);
    expect(after).toMatch(/segments\.removeFirst\(/);
    expect(after).toMatch(/segments\.starts\(with: sentSegments\)|Array\((?:self\.)?segments\.prefix\(sentSegments\.count\)\) == sentSegments/);
    expect(after).not.toMatch(/hasPrefix\(text\)|segments\.removeAll\(\)/);
    // Belt and braces: the capture's callbacks go inert before that await.
    const beforeSend = talk.slice(0, send);
    expect(beforeSend).toMatch(/self\.(?:generation|captureEpoch) \+= 1/);
  });

  test("bridge success means transcript-confirmed delivery, not queue acceptance", () => {
    const bridge = app("BridgeClient.swift");
    const daemon = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
    const inject = swiftBlock(bridge, "func inject(sessionId:");
    expect(inject).toMatch(/UUID\(\)\.uuidString/);
    expect(inject).toMatch(/"requestId": requestId/);
    expect(inject).toMatch(/confirmedRequestId: requestId/);

    const post = swiftBlock(bridge, "private func post(");
    expect(post).toMatch(/"kind"\] as\? String == "inject-result"/);
    expect(post).toMatch(/"requestId"\] as\? String == confirmedRequestId/);
    expect(post).toMatch(/"delivered"\] as\? Bool == true/);

    // The daemon holds the control socket until the target transcript advances.
    expect(daemon).toMatch(/waitForInjectResult\(requestId\)[\s\S]*kind: "inject-result"/);
    expect(daemon).toMatch(/allowBlindFallback: false,[\s\S]*requireConfirmed: true/);
    const delivery = daemon.slice(daemon.indexOf("async function deliverToSession("));
    expect(delivery).toMatch(/transcriptMark\(event\.transcriptPath!\)[\s\S]*> beforeCount/);
    expect(delivery).toMatch(/return options\.requireConfirmed !== true/);
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
    // A volatile hypothesis is not a finalized segment and cannot be parked
    // as though it were one when changing conversations.
    expect(body).not.toMatch(/appendFinalSegment\(partial\)|commit\(partial\)/);
    // Switching destinations during a live phrase cannot cancel/drop that
    // phrase. The UI may ignore the second-session tap or force-finalize A,
    // but the old cancel-and-start path is forbidden.
    expect(body).not.toMatch(/if phase == \.listening \{[\s\S]*?cancel\(\)/);
    // Drafts are stored per session, not one string for the whole app.
    expect(talk).toMatch(/private var parked: \[String: \[String\]\]/);
    // Every talk affordance is scoped to the session on screen.
    expect(session).toMatch(/talk\.targetSessionId == sessionId && talk\.phase == \.listening/);
  });

  test("finalized words in hand are sent even when the last phrase fails", () => {
    // A failed last final must not block already-finalized immutable segments.
    // The volatile partial remains display-only; this preserves the original
    // guarantee without promoting a revisable hypothesis into durable truth.
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
