import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublishedState } from "../src/panel.ts";
import {
  noticeableState,
  publishSessionsFile,
  SessionsFilePublisher,
} from "../src/status.ts";

function publishedState(ts: number, label: string): PublishedState {
  return {
    v: 1,
    features: { deliverables: 4, viewedState: 1 },
    ownerDeviceId: "test-device",
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
    dismissedRows: [],
    seaGlass: 0,
  };
}

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

test("the sessions file is not rewritten to say what it already says, but is to say it again after the heartbeat", () => {
  const directory = mkdtempSync(join(tmpdir(), "conch-session-state-"));
  const path = join(directory, "sessions.json");
  let now = 1_000;
  const publisher = new SessionsFilePublisher(path, 15_000, () => now);
  try {
    expect(publisher.publish(publishedState(1, "first"))).toBe(true);
    const written = statSync(path);
    // Only the timestamp moved.
    now += 500;
    expect(publisher.publish(publishedState(2, "first"))).toBe(false);
    expect(statSync(path).mtimeMs).toBe(written.mtimeMs);
    expect(JSON.parse(readFileSync(path, "utf8")).ts).toBe(1);
    // Something a reader can see moved.
    expect(publisher.publish(publishedState(3, "renamed"))).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).rows[0].label).toBe("renamed");
    // The heartbeat: the Mac app counts a snapshot older than 45 s as a daemon that may be gone.
    now += 15_000;
    expect(publisher.publish(publishedState(4, "renamed"))).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).ts).toBe(4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a sessions file removed or replaced under the publisher is written again", () => {
  const directory = mkdtempSync(join(tmpdir(), "conch-session-state-"));
  const path = join(directory, "sessions.json");
  const publisher = new SessionsFilePublisher(path, 15_000, () => 1_000);
  try {
    expect(publisher.publish(publishedState(1, "first"))).toBe(true);
    rmSync(path);
    expect(publisher.publish(publishedState(2, "first"))).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).ts).toBe(2);
    writeFileSync(path, "{}\n");
    expect(publisher.publish(publishedState(3, "first"))).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).ts).toBe(3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("what a person would notice: a row's status or name, manual mode, the voice; not the clock", () => {
  const base = publishedState(1, "first");
  expect(noticeableState(publishedState(2, "first"))).toBe(noticeableState(base));
  expect(noticeableState({ ...base, rows: [{ ...base.rows[0]!, status: "working" }] })).not.toBe(noticeableState(base));
  expect(noticeableState(publishedState(1, "renamed"))).not.toBe(noticeableState(base));
  expect(noticeableState({ ...base, mode: { ...base.mode, paused: true } })).not.toBe(noticeableState(base));
  expect(noticeableState({ ...base, live: { state: "speaking", label: "first" } })).not.toBe(noticeableState(base));
  expect(noticeableState({ ...base, rows: [] })).not.toBe(noticeableState(base));
  expect(noticeableState({ ...base, conversations: { session: { order: [], items: {} } as never } })).toBe(noticeableState(base));
});
