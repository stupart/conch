import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodexTranscriptReader,
  lastAssistantText,
  TRANSCRIPT_READ_CHUNK_BYTES,
  transcriptMark,
  userRespondedSince,
  type TranscriptSource,
} from "../src/snippet.ts";

const encoder = new TextEncoder();

interface TranscriptReadRange {
  offset: number;
  length: number;
}

class RangeTrackedTranscriptSource implements TranscriptSource {
  readonly reads: TranscriptReadRange[] = [];
  private raw: string;
  private revision = 1;

  constructor(raw: string) {
    this.raw = raw;
  }

  get bytes(): Uint8Array {
    return encoder.encode(this.raw);
  }

  append(raw: string): void {
    this.raw += raw;
    this.revision++;
  }

  async open() {
    const bytes = this.bytes;
    const revision = this.revision;
    return {
      version: {
        size: bytes.length,
        mtimeNs: String(revision),
        dev: "1",
        ino: "1",
      },
      read: async (offset: number, length: number) => {
        this.reads.push({ offset, length });
        return bytes.slice(offset, offset + length);
      },
      close() {},
    };
  }
}

function withTranscript(
  filename: string,
  entries: Array<object | string>,
): { path: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "conch-codex-transcript-"));
  const path = join(root, filename);
  writeFileSync(
    path,
    entries
      .map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry))
      .join("\n"),
  );
  return {
    path,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("Codex rollout dispatch prefers task_complete and counts user prompts", async () => {
  const fixture = withTranscript(
    "rollout-2026-07-29T12-00-00-session-a.jsonl",
    [
      {
        timestamp: "2026-07-29T12:00:00Z",
        type: "session_meta",
        payload: { session_id: "session-a", cwd: "/work/conch" },
      },
      {
        timestamp: "2026-07-29T12:00:01Z",
        type: "event_msg",
        payload: { type: "user_message", message: "first prompt" },
      },
      {
        timestamp: "2026-07-29T12:00:02Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Checking the implementation.",
          phase: "commentary",
        },
      },
      {
        timestamp: "2026-07-29T12:00:03Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "An earlier final reply." },
      },
      {
        timestamp: "2026-07-29T12:00:04Z",
        type: "event_msg",
        payload: { type: "user_message", message: "second prompt" },
      },
      {
        timestamp: "2026-07-29T12:00:05Z",
        type: "event_msg",
        payload: { type: "user_message", message: "third prompt" },
      },
      {
        timestamp: "2026-07-29T12:00:06Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "This fallback must lose to task_complete.",
          phase: "final",
        },
      },
      {
        timestamp: "2026-07-29T12:00:07Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-a",
          last_agent_message: "The grounded Codex reply.",
        },
      },
    ],
  );

  try {
    expect(await lastAssistantText(fixture.path)).toBe("The grounded Codex reply.");
    expect(await transcriptMark(fixture.path)).toBe(3);
    expect(await userRespondedSince(fixture.path, 2)).toBe(true);
    expect(await userRespondedSince(fixture.path, 3)).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

test("Codex rollout fallback ignores commentary and returns the last final agent message", async () => {
  const fixture = withTranscript(
    "rollout-2026-07-29T12-30-00-session-b.jsonl",
    [
      {
        timestamp: "2026-07-29T12:30:00Z",
        type: "event_msg",
        payload: { type: "user_message", message: "do the work" },
      },
      {
        timestamp: "2026-07-29T12:30:01Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "First completed answer.",
        },
      },
      {
        timestamp: "2026-07-29T12:30:02Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "A later progress note that must not be announced.",
          phase: "commentary",
        },
      },
      {
        timestamp: "2026-07-29T12:30:03Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Newest completed answer.",
          phase: "final",
        },
      },
      {
        timestamp: "2026-07-29T12:30:04Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Trailing commentary is not a final answer.",
          phase: "commentary",
        },
      },
    ],
  );

  try {
    expect(await lastAssistantText(fixture.path)).toBe("Newest completed answer.");
    expect(await transcriptMark(fixture.path)).toBe(1);
  } finally {
    fixture.cleanup();
  }
});

test("Codex rollout preview reads only the tail while prompt counting streams bounded chunks", async () => {
  const filler = JSON.stringify({
    timestamp: "2026-07-29T12:00:02Z",
    type: "response_item",
    payload: { type: "reasoning", text: "x".repeat(1_000) },
  });
  const fillerCount = Math.ceil(
    (TRANSCRIPT_READ_CHUNK_BYTES * 4) / (encoder.encode(filler).length + 1),
  );
  const raw = [
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "build it" },
    }),
    ...Array.from({ length: fillerCount }, () => filler),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "agent_message",
        phase: "final",
        message: "Fallback reply.",
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        last_agent_message: "Tail-selected reply.",
      },
    }),
  ].join("\n");
  const source = new RangeTrackedTranscriptSource(raw);
  const reader = createCodexTranscriptReader(source);

  expect(await reader.lastAssistantText("rollout-large.jsonl")).toBe("Tail-selected reply.");
  expect(source.reads).toHaveLength(1);
  expect(source.reads[0]).toEqual({
    offset: source.bytes.length - TRANSCRIPT_READ_CHUNK_BYTES,
    length: TRANSCRIPT_READ_CHUNK_BYTES,
  });
  expect(source.reads[0]!.offset).toBeGreaterThan(0);
  expect(source.reads[0]!.length).toBeLessThan(source.bytes.length);

  const readsAfterPreview = source.reads.length;
  expect(await reader.countUserPrompts("rollout-large.jsonl")).toBe(1);
  const promptReads = source.reads.slice(readsAfterPreview);
  expect(promptReads[0]!.offset).toBe(0);
  expect(promptReads.every((read) => read.length <= TRANSCRIPT_READ_CHUNK_BYTES)).toBe(true);
  expect(promptReads.reduce((sum, read) => sum + read.length, 0)).toBe(source.bytes.length);
});

test("Codex rollout tail cache consumes only appended bytes after a provisional final line", async () => {
  const source = new RangeTrackedTranscriptSource([
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "first prompt" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        last_agent_message: "First completed reply.",
      },
    }),
  ].join("\n"));
  const reader = createCodexTranscriptReader(source);

  expect(await reader.lastAssistantText("rollout-growing.jsonl"))
    .toBe("First completed reply.");
  const oldSize = source.bytes.length;
  const readsBeforeAppend = source.reads.length;

  source.append(`\n${[
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "follow-up prompt" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        last_agent_message: "Second completed reply.",
      },
    }),
  ].join("\n")}`);

  expect(await reader.lastAssistantText("rollout-growing.jsonl"))
    .toBe("Second completed reply.");
  expect(source.reads.slice(readsBeforeAppend)).toEqual([{
    offset: oldSize,
    length: source.bytes.length - oldSize,
  }]);
  expect(await reader.countUserPrompts("rollout-growing.jsonl")).toBe(2);
});

test("a flat UUID transcript keeps the existing Claude Code reader behavior", async () => {
  const fixture = withTranscript(
    "123e4567-e89b-12d3-a456-426614174000.jsonl",
    [
      {
        type: "user",
        message: { content: [{ type: "text", text: "fix the bug" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "An interim reply." }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "The Claude final reply." }] },
      },
      {
        timestamp: "2026-07-29T13:00:00Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          last_agent_message: "Must not be parsed as Codex.",
        },
      },
    ],
  );

  try {
    expect(await lastAssistantText(fixture.path)).toBe("The Claude final reply.");
    expect(await transcriptMark(fixture.path)).toBe(1);
  } finally {
    fixture.cleanup();
  }
});
