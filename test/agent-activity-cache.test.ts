import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_WINDOW_MS, liveBackgroundAgents } from "../src/agent-activity.ts";

// `liveBackgroundAgents` runs for every session on every render. It now lists a subagents folder again only when the
// folder moved, stats each file once a scan, and keeps its scan of the parent transcript and each agent's "inside a
// tool call" answer until the file they read moves. These pin that each of those still sees what changes.

const root = mkdtempSync(join(tmpdir(), "conch-agent-cache-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let sessions = 0;
function session() {
  const sessionId = `11111111-2222-4333-8444-${String(++sessions).padStart(12, "0")}`;
  const transcript = join(root, `${sessionId}.jsonl`);
  const sidechains = join(root, sessionId, "subagents");
  mkdirSync(sidechains, { recursive: true });
  writeFileSync(transcript, "");
  const write = (...entries: unknown[]) => appendFileSync(transcript, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  const agent = (id: string, ...entries: unknown[]) =>
    appendFileSync(join(sidechains, `agent-${id}.jsonl`), entries.map((entry) => `${JSON.stringify(entry)}\n`).join("") || "\n");
  const age = (path: string, ms: number) => {
    const then = new Date(Date.now() - ms);
    utimesSync(path, then, then);
  };
  return { transcript, sidechains, write, agent, age };
}

const launch = (id: string) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: `toolu_${id}`, content: "launched" }] },
  toolUseResult: { isAsync: true, agentId: id },
});
const finished = (id: string) => ({
  type: "queue-operation",
  content: `<task-notification><task-id>${id}</task-id><status>completed</status></task-notification>`,
});
const resumed = (id: string) => ({ type: "user", message: { content: "resumed" }, toolUseResult: { resumedAgentId: id } });
const live = (transcript: string) => liveBackgroundAgents(transcript).map((agent) => agent.agentId).sort();

describe("the scan sees what moved, and only that is read again", () => {
  test("an agent added to the folder, and one removed from it", () => {
    const s = session();
    s.agent("a1", { type: "user", message: { content: "go" } });
    s.write(launch("a1"));
    expect(live(s.transcript)).toEqual(["a1"]);
    expect(live(s.transcript)).toEqual(["a1"]);
    s.agent("a2", { type: "user", message: { content: "go" } });
    s.write(launch("a2"));
    expect(live(s.transcript)).toEqual(["a1", "a2"]);
    unlinkSync(join(s.sidechains, "agent-a1.jsonl"));
    expect(live(s.transcript)).toEqual(["a2"]);
  });

  test("an agent quiet for an hour, woken by SendMessage, is live again though its folder never moved", () => {
    const s = session();
    s.agent("old", { type: "user", message: { content: "go" } });
    s.write(launch("old"), finished("old"), resumed("old"));
    const agentFile = join(s.sidechains, "agent-old.jsonl");
    s.age(agentFile, 60 * 60 * 1000);
    // The folder settled long ago, so its listing is trusted from here on.
    s.age(s.sidechains, 60 * 60 * 1000);
    expect(live(s.transcript)).toEqual([]);
    const folder = statSync(s.sidechains).mtimeMs;
    s.agent("old", { type: "assistant", message: { content: [{ type: "text", text: "back at it" }] } });
    expect(statSync(s.sidechains).mtimeMs).toBe(folder);
    expect(live(s.transcript)).toEqual(["old"]);
  });

  test("the parent's newest word decides again whenever the parent moves, appended to or replaced", () => {
    const s = session();
    s.agent("p1", { type: "user", message: { content: "go" } });
    s.write(launch("p1"));
    expect(live(s.transcript)).toEqual(["p1"]);
    s.write(finished("p1"));
    expect(live(s.transcript)).toEqual([]);
    // Replaced by a file of the same length that launches it again: a new inode, so it is scanned again.
    const replacement = `${s.transcript}.next`;
    const lines = [launch("p1"), finished("p1")].map((entry) => JSON.stringify(entry));
    writeFileSync(replacement, `${[lines[1], lines[0]].join("\n")}\n`);
    expect(statSync(replacement).size).toBe(statSync(s.transcript).size);
    renameSync(replacement, s.transcript);
    expect(live(s.transcript)).toEqual(["p1"]);
  });

  test("an agent quiet past the live window counts while inside a tool call, and stops once the result lands", () => {
    const s = session();
    const agentFile = join(s.sidechains, "agent-busy.jsonl");
    s.agent("busy", { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } });
    s.write(launch("busy"));
    s.age(agentFile, LIVE_WINDOW_MS + 60_000);
    expect(live(s.transcript)).toEqual(["busy"]);
    expect(live(s.transcript)).toEqual(["busy"]);
    s.agent("busy", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] } });
    s.age(agentFile, LIVE_WINDOW_MS + 60_000);
    expect(live(s.transcript)).toEqual([]);
  });
});
