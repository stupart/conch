import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lastAssistantText,
  transcriptMark,
  userRespondedSince,
} from "../src/snippet.ts";

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
