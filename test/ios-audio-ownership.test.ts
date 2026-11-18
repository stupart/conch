import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/// The iOS app has no test target, so these read its source: they are the only guard of the
/// phone's half of the invariant that the mic never opens while speech plays.
const app = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "mobile", "conch-ios", "conch-ios", name), "utf8");

describe("only one side of the phone owns the audio route", () => {
  test("speaking is gated on capture, at every entry point, through finalisation", () => {
    // `consider` is the automatic path and `speak` the manual one; a guard on either alone
    // leaves the other able to speak under a live capture.
    const speech = app("SpeechController.swift");
    for (const fn of ["func consider(", "func speak("]) {
      const start = speech.indexOf(fn);
      expect(start).toBeGreaterThan(-1);
      const guard = speech.indexOf("guard !captureOwnsAudio()", start);
      const configure = speech.indexOf("configureSession()", start);
      expect(guard).toBeGreaterThan(-1);
      if (configure > -1) expect(guard).toBeLessThan(configure);
    }
    // Capture owns the route while it finalises, not only while the mic is open.
    const conchApp = app("ConchApp.swift");
    const wiring = conchApp.slice(conchApp.indexOf("speech.captureOwnsAudio = {"));
    const closure = wiring.slice(0, wiring.indexOf("\n                }"));
    expect(closure).toMatch(/phase == \.listening/);
    expect(closure).toMatch(/phase == \.sending/);
  });

  test("the mic silences speech before it opens, not after", () => {
    const talk = app("TalkController.swift");
    const begin = talk.indexOf("private func beginCapture()");
    const silence = talk.indexOf("silenceSpeech()", begin);
    const route = talk.indexOf("session.setCategory(.record", begin);
    expect(silence).toBeGreaterThan(-1);
    expect(silence).toBeLessThan(route);
    expect(app("ConchApp.swift")).toMatch(/talk\.silenceSpeech = \{ \[weak speech\] in speech\?\.stop\(\) \}/);
  });
});
