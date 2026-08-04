import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordTelemetry, round } from "../src/telemetry.ts";

test("records one JSON object per line with a timestamp", () => {
  const dir = mkdtempSync("/tmp/conch-telemetry-test-");
  const path = join(dir, "t.jsonl");
  recordTelemetry("tts.synth", { voice: "af_sky", rms: 0.11 }, path);
  recordTelemetry("inject", { route: "tmux", confirmed: true }, path);

  const lines = readFileSync(path, "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  const first = JSON.parse(lines[0]!);
  expect(first.event).toBe("tts.synth");
  expect(first.voice).toBe("af_sky");
  expect(typeof first.ts).toBe("number");
  expect(JSON.parse(lines[1]!).route).toBe("tmux");
});

test("the file is not world-readable — it sits in a shared /tmp", () => {
  const dir = mkdtempSync("/tmp/conch-telemetry-test-");
  const path = join(dir, "t.jsonl");
  recordTelemetry("turn", { ms: 1 }, path);
  expect(statSync(path).mode & 0o077).toBe(0);
});

test("a broken path never throws — telemetry must not break the voice loop", () => {
  expect(() => recordTelemetry("turn", { ms: 1 }, "/nope/nowhere/t.jsonl")).not.toThrow();
});

test("rotates once past the size cap so it cannot grow without bound", () => {
  const dir = mkdtempSync("/tmp/conch-telemetry-test-");
  const path = join(dir, "t.jsonl");
  writeFileSync(path, "x".repeat(9 * 1024 * 1024));
  recordTelemetry("turn", { ms: 1 }, path);
  expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
  expect(statSync(`${path}.1`).size).toBeGreaterThan(8 * 1024 * 1024);
});

test("round keeps the file free of float noise", () => {
  expect(round(0.1 + 0.2)).toBe(0.3);
  expect(round(1 / 3, 5)).toBe(0.33333);
  expect(round(Number.NaN)).toBe(0);
});
