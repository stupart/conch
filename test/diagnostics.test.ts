import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiagnosticsSession,
  classifyRecorderExit,
  keepRawDiagnosticsEnabled,
  type RecorderExitFacts,
} from "../src/diagnostics.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("recorder exit classification preserves every diagnostic disposition", () => {
  const base: RecorderExitFacts = { killCause: null, finalBytesAfterExit: 32_000, minimumBytes: 16_000 };
  expect(classifyRecorderExit(base)).toBe("natural");
  expect(classifyRecorderExit({ ...base, finalBytesAfterExit: 4_000 })).toBe("short");
  expect(classifyRecorderExit({ ...base, finalBytesAfterExit: 0 })).toBe("never-started");
  expect(classifyRecorderExit({ ...base, killCause: "window", finalBytesAfterExit: 1 })).toBe("short");
  expect(classifyRecorderExit({ ...base, killCause: "window" })).toBe("window-kill");
  expect(classifyRecorderExit({ ...base, killCause: "max" })).toBe("max-kill");
  expect(classifyRecorderExit({ ...base, killCause: "disarmed-next", finalBytesAfterExit: 0 })).toBe("disarmed-next");
  expect(classifyRecorderExit({ ...base, killCause: "shutdown", error: "signal" })).toBe("shutdown");
  expect(classifyRecorderExit({ ...base, error: "sox failed" })).toBe("error");
});

test("raw retention is enabled only by the exact opt-in value", () => {
  expect(keepRawDiagnosticsEnabled(undefined)).toBe(false);
  expect(keepRawDiagnosticsEnabled("0")).toBe(false);
  expect(keepRawDiagnosticsEnabled("true")).toBe(false);
  expect(keepRawDiagnosticsEnabled("1")).toBe(true);
});

test("diagnostics session is private, warns about sensitivity, and emits one complete row", () => {
  const root = mkdtempSync(join(tmpdir(), "conch-diag-test-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const session = new DiagnosticsSession({ baseDir: root, pid: 42, runstamp: "run", announce: false });
  const parent = session.createParent("listen");
  const record = session.startRecorder("utt", parent, 1);
  session.update(record.id, {
    exitedAt: new Date(0).toISOString(),
    exitReason: "error",
    finalBytesAfterExit: 32_000,
    engine: "warm",
    transcript: "finish quietly",
    error: "sox failed",
  });
  session.update(record.id, { error: "whisper failed" });
  session.update(record.id, { error: null });
  session.emit(record.id, {
    intent: "prompt",
    bufferCountAfterReduction: 1,
    finalSubmittedPayload: "finish quietly",
  });
  session.emit(record.id, { intent: "duplicate" });

  expect(statSync(session.runDir).mode & 0o777).toBe(0o700);
  expect(statSync(session.logPath).mode & 0o777).toBe(0o600);
  const lines = readFileSync(session.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(lines).toHaveLength(2);
  expect(lines[0].warning).toContain("SENSITIVE");
  expect(lines[0].cleanup).toContain("rm -rf --");
  expect(lines[1]).toEqual({
    type: "recorder",
    id: "rec-0001",
    tag: "utt",
    parent: "listen-0001",
    sequence: 1,
    openedAt: expect.any(String),
    exitedAt: new Date(0).toISOString(),
    exitReason: "error",
    killCause: null,
    sizeAtKill: null,
    finalBytesAfterExit: 32_000,
    engine: "warm",
    transcript: "finish quietly",
    error: "sox failed | whisper failed",
    intent: "prompt",
    bufferCountAfterReduction: 1,
    finalSubmittedPayload: "finish quietly",
    rawPath: join(session.runDir, "rec-0001-utt.raw"),
  });
});

test("parent and recorder sequences are monotonic", () => {
  const root = mkdtempSync(join(tmpdir(), "conch-diag-test-"));
  roots.push(root);
  const session = new DiagnosticsSession({ baseDir: root, pid: 7, runstamp: "seq", announce: false });
  expect(session.createParent("listen")).toBe("listen-0001");
  expect(session.createParent("gap")).toBe("gap-0002");
  const parent = session.createParent("barge");
  expect(session.startRecorder("barge", parent, 1).id).toBe("rec-0001");
  expect(session.startRecorder("barge", parent, 2).id).toBe("rec-0002");
});
