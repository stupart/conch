import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendConchError, clipboardFallbackError } from "../src/app-errors.ts";

let temp = "";
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

describe("structured app errors", () => {
  test("clipboard delivery failures retain their routing cause without transcript text", () => {
    expect(clipboardFallbackError({
      sessionId: "c1",
      label: "backend",
      cwd: "/tmp/repo",
      reason: "session-not-routable",
    })).toEqual({
      source: "daemon",
      operation: "inject",
      message: "message landed on clipboard (session-not-routable)",
      sessionId: "c1",
      state: {
        label: "backend",
        cwd: "/tmp/repo",
        route: "clipboard",
        reason: "session-not-routable",
      },
    });
  });

  test("appends client and daemon state as one private JSONL record", () => {
    temp = mkdtempSync(join(tmpdir(), "conch-errors-"));
    const path = join(temp, "errors.jsonl");
    appendConchError(
      {
        source: "ios",
        operation: "send",
        message: "relay closed",
        sessionId: "s1",
        state: { connected: false, draftChars: 12 },
      },
      { v: 1, ts: 7, mode: { muted: false, paused: false, holding: 0 }, live: { state: "idle", label: "" }, rows: [], dismissed: [], dismissedRows: [] },
      path,
      new Date("2026-08-16T12:00:00Z"),
    );
    const record = JSON.parse(readFileSync(path, "utf8"));
    expect(record).toMatchObject({
      v: 1,
      at: "2026-08-16T12:00:00.000Z",
      source: "ios",
      operation: "send",
      sessionId: "s1",
      state: { connected: false, draftChars: 12 },
      daemonState: { v: 1, ts: 7 },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("rotates a bounded history before appending the next record", () => {
    temp = mkdtempSync(join(tmpdir(), "conch-errors-"));
    const path = join(temp, "errors.jsonl");
    writeFileSync(path, Buffer.alloc(8 * 1024 * 1024));
    appendConchError({ source: "daemon", operation: "inject", message: "clipboard" }, null, path);
    expect(statSync(`${path}.1`).size).toBe(8 * 1024 * 1024);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ source: "daemon", operation: "inject" });
  });
});
