import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  BASH_LIVE_WINDOW_MS,
  LIVE_WINDOW_MS,
  sessionHasLiveBackgroundWork,
} from "../src/agent-activity.ts";

const roots: string[] = [];
const taskRoots: string[] = [];

interface Fixture {
  transcript: string;
  sessionId: string;
  lines: unknown[];
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "conch-agent-activity-"));
  roots.push(root);
  return {
    transcript: join(root, "11111111-2222-4333-8444-555555555555.jsonl"),
    sessionId: "11111111-2222-4333-8444-555555555555",
    lines: [],
  };
}

function genuinePrompt(text: string) {
  return {
    type: "user",
    message: { role: "user", content: text },
    promptSource: "typed",
    origin: { kind: "human" },
  };
}

function agentLaunch(id: string, toolUseId = `toolu_${id}`): unknown[] {
  return [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Agent", id: toolUseId, input: { description: "inspect it" } }],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolUseId,
          content: [{ type: "text", text: `Async agent launched successfully.\nagentId: ${id}` }],
        }],
      },
      toolUseResult: { isAsync: true, status: "async_launched", agentId: id },
    },
  ];
}

function bashLaunch(id: string, toolUseId = `toolu_${id}`): unknown[] {
  return [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          name: "Bash",
          id: toolUseId,
          input: { command: "sleep 30", run_in_background: true },
        }],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: `Command running in background with ID: ${id}.` }],
      },
      toolUseResult: { stdout: "", stderr: "", backgroundTaskId: id },
    },
  ];
}

function completion(id: string, status: "completed" | "failed" | "killed" = "completed") {
  return {
    type: "user",
    message: {
      role: "user",
      content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n</task-notification>`,
    },
    promptSource: "system",
    origin: { kind: "task-notification" },
  };
}

function queuedCompletion(id: string, carrier: "queue-operation" | "attachment") {
  const content = `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`;
  return carrier === "queue-operation"
    ? { type: "queue-operation", operation: "enqueue", content }
    : { type: "attachment", attachment: { type: "queued_command", prompt: content } };
}

function writeTranscript(f: Fixture): void {
  writeFileSync(f.transcript, f.lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

function agentArtifact(f: Fixture, id: string, stale = false): string {
  const path = join(dirname(f.transcript), f.sessionId, "subagents", `agent-${id}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}\n");
  if (stale) {
    const old = new Date(Date.now() - LIVE_WINDOW_MS - 5_000);
    utimesSync(path, old, old);
  }
  return path;
}

function bashArtifact(f: Fixture, id: string, ageMs = 0): string {
  if (process.getuid === undefined) throw new Error("test requires a Unix uid");
  const root = join("/private/tmp", `claude-${process.getuid()}`, basename(dirname(f.transcript)), f.sessionId);
  taskRoots.push(root);
  const path = join(root, "tasks", `${id}.output`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "still running\n");
  if (ageMs) {
    const old = new Date(Date.now() - ageMs);
    utimesSync(path, old, old);
  }
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const root of taskRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("sessionHasLiveBackgroundWork", () => {
  test("finds an in-flight async Agent from its real tool_result shape", () => {
    const f = fixture();
    const id = "a1111111111111111";
    f.lines.push(genuinePrompt("delegate this"), ...agentLaunch(id));
    writeTranscript(f);
    agentArtifact(f, id);
    expect(sessionHasLiveBackgroundWork(f.transcript)).toBe(true);
  });

  test("handles a launch JSONL entry spanning multiple read chunks", () => {
    const f = fixture();
    const id = "a1212121212121212";
    const launch = agentLaunch(id) as any[];
    launch[1].toolUseResult.prompt = "x".repeat(300_000);
    f.lines.push(genuinePrompt("delegate a large prompt"), ...launch);
    writeTranscript(f);
    agentArtifact(f, id);
    expect(sessionHasLiveBackgroundWork(f.transcript)).toBe(true);
  });

  test.each(["completed", "failed", "killed"] as const)(
    "subtracts a %s task-notification",
    (status) => {
      const f = fixture();
      const id = status === "completed"
        ? "a2222222222222222"
        : status === "failed"
          ? "a2222222222222223"
          : "a2222222222222224";
      f.lines.push(genuinePrompt("delegate this"), ...agentLaunch(id), completion(id, status));
      writeTranscript(f);
      agentArtifact(f, id);
      expect(sessionHasLiveBackgroundWork(f.transcript)).toBe(false);
    },
  );

  test.each(["queue-operation", "attachment"] as const)(
    "subtracts a completion carried by a real %s entry",
    (carrier) => {
      const f = fixture();
      const id = carrier === "queue-operation" ? "a2323232323232323" : "a2424242424242424";
      f.lines.push(genuinePrompt("delegate this"), ...agentLaunch(id), queuedCompletion(id, carrier));
      writeTranscript(f);
      agentArtifact(f, id);
      expect(sessionHasLiveBackgroundWork(f.transcript)).toBe(false);
    },
  );

  test("rejects an orphaned Agent launch once its transcript is stale", () => {
    const f = fixture();
    const id = "a3333333333333333";
    f.lines.push(genuinePrompt("delegate this"), ...agentLaunch(id));
    writeTranscript(f);
    agentArtifact(f, id, true);
    expect(sessionHasLiveBackgroundWork(f.transcript)).toBe(false);
  });

  test("finds an in-flight background Bash task", () => {
    const f = fixture();
    const id = "b44444444";
    f.lines.push(genuinePrompt("run this"), ...bashLaunch(id));
    writeTranscript(f);
    bashArtifact(f, id);
    expect(sessionHasLiveBackgroundWork(f.transcript)).toBe(true);
  });

  test("allows a live background Bash task to stay quiet longer than an Agent", () => {
    const f = fixture();
    const id = "b45454545";
    f.lines.push(genuinePrompt("run a quiet command"), ...bashLaunch(id));
    writeTranscript(f);
    bashArtifact(f, id, LIVE_WINDOW_MS + 5_000);
    expect(sessionHasLiveBackgroundWork(f.transcript)).toBe(true);
  });

  test("ages out a background Bash orphan at its longer bound", () => {
    const f = fixture();
    const id = "b46464646";
    f.lines.push(genuinePrompt("run a quiet command"), ...bashLaunch(id));
    writeTranscript(f);
    bashArtifact(f, id, BASH_LIVE_WINDOW_MS + 5_000);
    expect(sessionHasLiveBackgroundWork(f.transcript)).toBe(false);
  });

  test("does not resurrect a stale prior-turn orphan", () => {
    const f = fixture();
    const id = "a5555555555555555";
    f.lines.push(genuinePrompt("first turn"), ...agentLaunch(id), genuinePrompt("second turn"));
    writeTranscript(f);
    agentArtifact(f, id, true);
    expect(sessionHasLiveBackgroundWork(f.transcript)).toBe(false);
  });

  test("keeps a genuinely live Agent visible across user turns", () => {
    const f = fixture();
    const id = "a6666666666666666";
    f.lines.push(genuinePrompt("first turn"), ...agentLaunch(id), genuinePrompt("second turn"));
    writeTranscript(f);
    agentArtifact(f, id);
    expect(sessionHasLiveBackgroundWork(f.transcript)).toBe(true);
  });

  test("fails safe when the transcript cannot be read", () => {
    const f = fixture();
    agentArtifact(f, "a7777777777777777"); // force the detector to try opening the missing transcript
    expect(sessionHasLiveBackgroundWork(f.transcript)).toBe(false);
  });
});
