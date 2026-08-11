import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * conch on a phone in your pocket.
 *
 * Without the audio background mode iOS suspends the app the moment the screen
 * locks: the synthesizer makes no sound, and the app cannot even send its
 * "stopped speaking" report — the dropped report that latched the Mac's
 * dashboard at "speaking". Tyler, from his phone: "it's saying it's speaking
 * and not speaking and also not hearing it speak".
 *
 * These live in the Bun suite because it is the one that runs on every change;
 * an Xcode test target would not have caught a missing Info.plist key anyway.
 */
describe("the phone can speak with the screen off", () => {
  const root = new URL("../mobile/conch-ios/conch-ios/", import.meta.url);
  const plist = readFileSync(new URL("Info.plist", root), "utf8");
  const speech = readFileSync(new URL("SpeechController.swift", root), "utf8");

  test("the app declares background audio", () => {
    expect(plist).toContain("UIBackgroundModes");
    const modes = plist.slice(plist.indexOf("UIBackgroundModes"));
    expect(modes.slice(0, 200)).toContain("<string>audio</string>");
  });

  // Tyler chose queue-until-you-open over read-from-a-pocket: "make sure it
  // like pauses or what not the phone app when I background it and new ones
  // are queued and dont start until I open it". Holding an audio session to
  // stay resident is the most expensive thing a phone app can do, so the
  // session is released on every path — the entitlement above is what lets an
  // utterance ALREADY under way finish when the screen locks.
  test("the audio session is released even in the background", () => {
    const finish = speech.slice(speech.indexOf("Hand audio back FIRST"));
    const branch = finish.slice(0, 1400);
    expect(branch).toContain("setActive(");
    expect(branch).not.toContain("applicationState == .active");
  });

  // Not marking it spoken is what makes this a queue rather than a silent
  // drop: the same state republishes when the app comes forward.
  test("a reply arriving off screen waits instead of being read or dropped", () => {
    const consider = speech.slice(speech.indexOf("func consider(state:"));
    const body = consider.slice(0, consider.indexOf("func speak("));
    const gate = body.indexOf("applicationState == .active");
    const marked = body.indexOf("spoken[reply.sessionId] = text", gate);
    expect(gate).toBeGreaterThan(-1);
    // The gate must come BEFORE the line that would mark it already read.
    expect(marked).toBeGreaterThan(gate);
  });
});

describe("nothing keeps running with the screen off", () => {
  const root = new URL("../mobile/conch-ios/conch-ios/", import.meta.url);
  const app = readFileSync(new URL("ConchApp.swift", root), "utf8");
  const speech = readFileSync(new URL("SpeechController.swift", root), "utf8");

  // Handing the audio lease back tells the Mac to speak; it does nothing about
  // a recording session still running here. Declaring background audio removed
  // the backstop that used to make that survivable — iOS suspending a silent
  // app — so an open mic could keep capture, speech recognition and the socket
  // alive indefinitely.
  test("backgrounding closes the mic, not just the lease", () => {
    const background = app.slice(app.indexOf("case .background:"));
    const branch = background.slice(0, background.indexOf("case .inactive:"));
    expect(branch).toContain("talk.closeMic()");
    expect(branch).toContain("claimAudio(false)");
  });

  // Only didFinish released the route, so stopping by hand, cancelling, or the
  // watchdog noticing a reading never started each left a session active.
  test("every way a reading can end releases the audio route", () => {
    expect(speech).toContain("private func releaseSession()");
    // stop(), didCancel, the watchdog, and the definition itself.
    expect(speech.split("releaseSession()").length - 1).toBeGreaterThanOrEqual(4);
  });
});
