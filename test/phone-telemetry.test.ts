import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * "Is conch draining my phone" has to be answerable with a reading.
 *
 * Tyler asked for numbers rather than an opinion. Everything sampled is read
 * from the OS about conch's own process and travels only between his two
 * devices — no profiler, no third party, nothing that leaves the pair.
 */
describe("phone telemetry", () => {
  const root = new URL("../mobile/conch-ios/conch-ios/", import.meta.url);
  const telemetry = readFileSync(new URL("DeviceTelemetry.swift", root), "utf8");
  const daemon = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");

  // resident_size flatters the app by excluding dirty pages that still count
  // against it; phys_footprint is what iOS measures against the jetsam limit,
  // so it is the figure that predicts a termination.
  test("memory is measured the way iOS measures it", () => {
    expect(telemetry).toContain("phys_footprint");
    expect(telemetry).toContain("TASK_VM_INFO");
  });

  // A telemetry loop that wakes often enough to matter is itself the drain it
  // claims to measure.
  test("sampling is too slow to be the drain it measures", () => {
    const match = /interval: TimeInterval = (\d+)/.exec(telemetry);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(120);
    expect(telemetry).toContain("tolerance");
  });

  // A drain reading means nothing without knowing whether it was on a cable,
  // and Low Power Mode throttles the CPU — it has already been mistaken for a
  // conch bug once.
  test("the readings that make a number interpretable are carried", () => {
    for (const field of ["batteryState", "thermal", "lowPower", "uptime"]) {
      expect(telemetry).toContain(field);
    }
  });

  // The reading that explains the phone AROUND conch. When Tyler's phone was
  // crawling, memory, battery and thermal all read healthy the entire time —
  // it was nearly out of storage, and nothing conch measured could say so.
  test("free storage is carried, and called out when it is low", () => {
    expect(telemetry).toContain("freeGB");
    // What iOS will actually let an app have, counting space it would purge,
    // rather than the raw free bytes.
    expect(telemetry).toContain("volumeAvailableCapacityForImportantUsage");
    expect(daemon).toContain("GB FREE");
  });

  test("the daemon logs a sample rather than acting on it", () => {
    expect(daemon).toContain('kind === "phone-device"');
    expect(daemon).toContain("LOW POWER MODE");
  });
});
