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

  // Off screen, an active audio session is the only thing keeping conch alive.
  // Releasing it after every utterance means a pocket goes quiet after exactly
  // one reply.
  test("the session is only handed back while the app is on screen", () => {
    const finish = speech.slice(speech.indexOf("Hand audio back FIRST"));
    const branch = finish.slice(0, 1400);
    expect(branch).toContain("UIApplication.shared.applicationState == .active");
    const deactivate = branch.indexOf("setActive(");
    const guard = branch.indexOf("applicationState == .active");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(deactivate); // the guard wraps it, not the reverse
  });
});
