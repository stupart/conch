import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  LIVE_WINDOW_MS,
  sessionHasLiveBackgroundWork,
} from "../src/agent-activity.ts";

const AGENT_ACTIVITY = join(import.meta.dir, "..", "src", "agent-activity.ts");
/** The reverse scan's read size (`READ_CHUNK_BYTES` in agent-activity.ts). */
const READ_CHUNK = 256 * 1024;

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

function agentMetaArtifact(f: Fixture, id: string): string {
  const path = join(dirname(f.transcript), f.sessionId, "subagents", `agent-${id}.meta.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}\n");
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

  test("IGNORES a background Bash task (a dev server must never silence the session)", () => {
    const f = fixture();
    const id = "b44444444";
    f.lines.push(genuinePrompt("start the dev server"), ...bashLaunch(id));
    writeTranscript(f);
    bashArtifact(f, id); // even a freshly-written, still-running output is ignored — agents only
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

  test("accepts fresh spawn metadata before the Agent transcript exists", () => {
    const f = fixture();
    const id = "a6767676767676767";
    f.lines.push(genuinePrompt("delegate this"), ...agentLaunch(id));
    writeTranscript(f);
    agentMetaArtifact(f, id);
    expect(sessionHasLiveBackgroundWork(f.transcript)).toBe(true);
  });

  test("does not let spawn metadata resurrect a completed Agent", () => {
    const f = fixture();
    const id = "a6868686868686868";
    f.lines.push(genuinePrompt("delegate this"), ...agentLaunch(id), completion(id));
    writeTranscript(f);
    agentMetaArtifact(f, id);
    expect(sessionHasLiveBackgroundWork(f.transcript)).toBe(false);
  });

  test("fails safe when the transcript cannot be read", () => {
    const f = fixture();
    agentArtifact(f, "a7777777777777777"); // force the detector to try opening the missing transcript
    expect(sessionHasLiveBackgroundWork(f.transcript)).toBe(false);
  });
});

/**
 * A transcript whose newest 256 KiB read starts exactly on a newline: `older` ends on the byte before the boundary,
 * and the newest chunk is the newline that ends it, then `newer`, then a filler line that makes the chunk exactly
 * `READ_CHUNK` bytes. The reverse scan used to reach index 0 of that chunk, ask `lastIndexOf(0x0a, -1)`, get the
 * chunk's LAST newline back, and go round forever — synchronously, which is how the daemon froze on 2026-09-28.
 */
function boundaryTranscript(f: Fixture, older: unknown[], newer: unknown[]): string[] {
  const olderText = older.map((line) => JSON.stringify(line)).join("\n");
  let newest = "\n" + newer.map((line) => JSON.stringify(line) + "\n").join("");
  const pad = READ_CHUNK - newest.length - JSON.stringify({ type: "system", filler: "" }).length - 1;
  if (pad < 0) throw new Error("newer lines do not fit in one read");
  const filler = { type: "system", filler: "f".repeat(pad) };
  newest += JSON.stringify(filler) + "\n";
  if (Buffer.byteLength(newest) !== READ_CHUNK) throw new Error(`newest chunk is ${Buffer.byteLength(newest)} bytes`);
  writeFileSync(f.transcript, olderText + newest);
  return [...older, ...newer, filler].map((line) => JSON.stringify(line));
}

/**
 * Run `body` in its own process with a deadline. A regression here is an infinite synchronous loop, which no
 * in-process test timeout can interrupt: it would hang the whole suite instead of failing this test.
 */
async function isolated(body: string, timeoutMs = 10_000): Promise<{ timedOut: boolean; exitCode: number | null; out: string; err: string }> {
  // `ulimit -t`: a child this suite loses track of still stops itself after 20 s of CPU, spinning or not.
  const child = Bun.spawn(["/bin/sh", "-c", 'ulimit -t 20; exec "$0" --eval "$1"', process.execPath, body], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  return { timedOut, exitCode, out, err };
}

describe("the reverse scan across a read boundary that lands on a newline (the 2026-09-28 daemon freeze)", () => {
  test("visits every line once, newest first, and returns", async () => {
    const f = fixture();
    const older = Array.from({ length: 40 }, (_, i) => ({ type: "user", n: i, text: "o".repeat(9_000) }));
    const newer = Array.from({ length: 5 }, (_, i) => ({ type: "assistant", n: i }));
    const lines = boundaryTranscript(f, older, newer);
    expect(Bun.file(f.transcript).size).toBeGreaterThan(READ_CHUNK);
    const run = await isolated(`
      const { visitLinesNewestFirst } = await import(${JSON.stringify(AGENT_ACTIVITY)});
      const seen = [];
      // Going round again is the bug; stop after a third lap so it fails as a wrong answer, not a hang.
      visitLinesNewestFirst(${JSON.stringify(f.transcript)}, () => true, (line) => { seen.push(line.toString("utf8")); return seen.length >= ${lines.length * 3}; });
      console.log(JSON.stringify(seen));
    `);
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.out)).toEqual([...lines].reverse());
  }, 30_000);

  test("a live agent whose newest mention sits in that chunk is found, not scanned forever", async () => {
    const f = fixture();
    const id = "a9191919191919191";
    // The launch is older than the boundary; the newest chunk only mentions the id, so it is relevant and resolves
    // nothing: the scan has to leave it and read on.
    const older = [genuinePrompt("delegate this"), ...agentLaunch(id), ...Array.from({ length: 30 }, (_, i) => ({ type: "user", n: i, text: "o".repeat(9_000) }))];
    boundaryTranscript(f, older, [genuinePrompt(`how is agent ${id} doing?`)]);
    agentArtifact(f, id);
    const run = await isolated(`
      const { liveBackgroundAgents } = await import(${JSON.stringify(AGENT_ACTIVITY)});
      console.log(JSON.stringify(liveBackgroundAgents(${JSON.stringify(f.transcript)}).map((agent) => agent.agentId)));
    `);
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.out)).toEqual([id]);
  }, 30_000);
});
