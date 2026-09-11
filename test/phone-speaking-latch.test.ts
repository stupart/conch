import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * conch must not claim the phone is reading aloud when it isn't.
 *
 * While the phone owns the audio this Mac stays quiet and cannot hear when a
 * reading ends, so the phone reports it. That report is the honest signal —
 * but it crosses a relay that drops ("heartbeat expired", "disconnected
 * (4002)" repeatedly in one afternoon), and a dropped report latched the
 * dashboard at "speaking" indefinitely. Tyler: "app says its reading aloud but
 * its not".
 */
describe("the speaking state is always bounded", () => {
  const source = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");

  // Taking the phone audio path arms the bound: executed in voice-loop.test.ts
  // ("the phone owning the voice"), since `speak` moved into the voice loop.

  test("the phone reporting it finished cancels the bound", () => {
    const control = readFileSync(new URL("../src/control-server.ts", import.meta.url), "utf8");
    const decodeAt = control.indexOf('if (value.kind === "phone-speaking")');
    expect(decodeAt).toBeGreaterThan(-1);
    const decoded = control.slice(decodeAt, decodeAt + 400);
    expect(decoded).toContain("const speaking = value.speaking === true;");
    expect(decoded).toContain('rawLabel.slice(0, 120)');
    const handlerAt = source.indexOf('if (message.kind === "phone-speaking")');
    expect(handlerAt).toBeGreaterThan(-1);
    const handler = source.slice(handlerAt);
    expect(handler.slice(0, 1200)).toContain("clearPhoneSpeechLatch()");
  });

  // The phone that was reading is gone, so its finish report is never coming.
  test("losing the phone clears a stuck speaking state", () => {
    expect(source).toContain("phone disconnected — audio back on this Mac");
    const disconnect = source.slice(source.indexOf("phone disconnected — audio back on this Mac"));
    expect(disconnect.slice(0, 700)).toContain("clearPhoneSpeechLatch()");
    expect(disconnect.slice(0, 700)).toContain('setState("idle")');
  });

  test("the bound is generous enough never to cut a real reading short", () => {
    const match = /Math\.min\((\d+)_000, 5_000 \+ \(text\.length \/ 8\)/.exec(source);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(60);
  });
});

describe("every route into speaking has a way back out", () => {
  const source = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");

  // This is the one that latched in the wild. The phone reported that it had
  // STARTED reading, the matching stop never arrived, and the dashboard sat at
  // "Reading aloud" with nothing playing — while the first fix only bounded
  // the path where the DAEMON initiates phone speech.
  test("the phone announcing its own speech is bounded", () => {
    expect(source).toContain("if (speaking && label)");
    const handler = source.slice(source.indexOf("if (speaking && label)"));
    expect(handler.slice(0, 800)).toContain("armPhoneSpeechLatch()");
  });

  test("no speaking transition is left unbounded", () => {
    // Three exist: `speak` and the Mac's own playback (both in the voice loop;
    // playback is bounded by itself), and the phone's report (the daemon). Any
    // NEW one is a latch waiting to happen, so this fails loudly when a fourth
    // appears — in either file.
    const voice = readFileSync(new URL("../src/voice-loop.ts", import.meta.url), "utf8");
    const transitions = source.split('setState("speaking"').length - 1
      + voice.split('setState("speaking"').length - 1;
    expect(transitions).toBe(3);
  });
});
