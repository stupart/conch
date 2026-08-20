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

  test("taking the phone audio path arms a bound", () => {
    const branch = source.slice(source.indexOf('if (audioLease.sink === "phone")'));
    expect(branch.slice(0, 200)).toContain("armPhoneSpeechLatch(text)");
  });

  test("the phone reporting it finished cancels the bound", () => {
    const handler = source.slice(source.indexOf("const speaking = (value as"));
    expect(handler.slice(0, 1200)).toContain("clearPhoneSpeechLatch()");
  });

  // The phone that was reading is gone, so its finish report is never coming.
  test("losing the phone clears a stuck speaking state", () => {
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
    const handler = source.slice(source.indexOf("if (speaking && label)"));
    expect(handler.slice(0, 800)).toContain("armPhoneSpeechLatch()");
  });

  test("no speaking transition is left unbounded", () => {
    // Three exist: the daemon speaking, the Mac's own playback (bounded by the
    // playback itself), and the phone's report. Any NEW one is a latch waiting
    // to happen, so this fails loudly when a fourth appears.
    const transitions = source.split('setState("speaking"').length - 1;
    expect(transitions).toBe(3);
  });
});
