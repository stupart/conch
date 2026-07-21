import { describe, expect, test } from "bun:test";
import { soxCaptureArgs } from "../src/listen.ts";

describe("sox capture arguments", () => {
  test("puts configured mic gain immediately before silence", () => {
    const args = soxCaptureArgs(
      { micGainDb: 12, endSilenceSecs: 3.5, endThresholdPct: 2 },
      "/tmp/conch-test.raw",
      2,
    );

    expect(args).toEqual([
      "sox", "-d", "-q",
      "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw",
      "/tmp/conch-test.raw",
      "gain", "12",
      "silence", "-l",
      "1", "0.15", "2%",
      "1", "3.5", "2%",
    ]);
  });

  test("keeps the existing arguments unchanged when mic gain is zero", () => {
    const args = soxCaptureArgs(
      { micGainDb: 0, endSilenceSecs: 3.5, endThresholdPct: 2 },
      "/tmp/conch-test.raw",
      2,
    );

    expect(args).toEqual([
      "sox", "-d", "-q",
      "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw",
      "/tmp/conch-test.raw",
      "silence", "-l",
      "1", "0.15", "2%",
      "1", "3.5", "2%",
    ]);
    expect(args).not.toContain("gain");
  });
});
