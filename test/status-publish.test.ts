import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublishedState } from "../src/panel.ts";
import {
  publishSessionsFile,
  SESSIONS_FILE,
} from "../src/status.ts";

function publishedState(ts: number, label: string): PublishedState {
  return {
    v: 1,
    ts,
    mode: { muted: false, paused: false, holding: 0 },
    live: { state: "idle", label: "" },
    rows: [{
      id: "session",
      label,
      status: "waiting",
      needsResponse: false,
      paused: false,
      muted: false,
      live: null,
      active: false,
    }],
    dismissed: [],
  };
}

test("session state uses its stable external path", () => {
  expect(SESSIONS_FILE).toBe("/tmp/conch-sessions.json");
});

test("publishSessionsFile atomically replaces a complete JSON snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "conch-session-state-"));
  const path = join(directory, "sessions.json");
  try {
    writeFileSync(path, `{"stale":true,"padding":"${"x".repeat(8_192)}"}\n`);

    const first = publishedState(1, "first");
    first.live = {
      ...first.live,
      partial: "live words",
      transcriptPrefix: "committed words",
      reading: { text: "reply in progress", spokenChars: 7 },
    };
    first.reply = { sessionId: "session", text: "reply in progress", spokenChars: 7 };
    first.preview = { sessionId: "parked", text: "parked reply", spokenChars: 0 };
    publishSessionsFile(first, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(first);
    expect(readdirSync(directory)).toEqual(["sessions.json"]);

    const replacement = publishedState(2, "replacement");
    publishSessionsFile(replacement, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(replacement);
    expect(readFileSync(path, "utf8")).not.toContain("padding");
    expect(readdirSync(directory)).toEqual(["sessions.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("session publication failures never escape to the renderer", () => {
  const directory = mkdtempSync(join(tmpdir(), "conch-session-state-"));
  try {
    expect(() => publishSessionsFile(
      publishedState(1, "unwritable"),
      join(directory, "missing", "sessions.json"),
    )).not.toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
