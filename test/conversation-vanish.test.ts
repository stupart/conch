import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionsToPublish } from "../src/daemon.ts";
import { historySessionFor } from "../src/records-routing.ts";
import { RecordStore } from "../src/records-store.ts";
import { recordKey, type RecordSession } from "../src/records-types.ts";
import type { SessionInfo } from "../src/sessions.ts";

/**
 * Tyler, 2026-09-28: "conversations have been disappearing from the Mac app sometimes and it says
 * there's nothing even when there's an entire convo in the terminal."
 *
 * The Mac drew a session's conversation only when the daemon had published a live window for it,
 * and the daemon published eight — the first eight in registry order, Claude's pid files and then
 * every Codex thread. A seventh Claude window took a Codex session's window away; the Mac fell back
 * to its single-reply pane, which says "Nothing from … yet. Send a message below to start." when
 * the newest turn has no reply. These pin the daemon's half.
 */

type Row = Pick<SessionInfo, "sessionId" | "status" | "statusUpdatedAt">;
const row = (sessionId: string, statusUpdatedAt: number, status = "idle"): Row => ({ sessionId, status, statusUpdatedAt });

test("the published conversations go to the sessions in use, not the first in registry order", () => {
  // Registry order: six Claude windows, then Codex — the order `registrySnapshot` builds.
  const registry = [
    row("claude-1", 1_000), row("claude-2", 2_000), row("claude-3", 3_000), row("claude-4", 4_000),
    row("claude-5", 5_000), row("claude-6", 6_000), row("claude-7", 7_000),
    row("codex-talking", 90_000), row("codex-old", 500),
  ];
  const published = sessionsToPublish(registry, 8).map((session) => session.sessionId);
  expect(published).toHaveLength(8);
  // The Codex session being talked to right now keeps its window; the one idle longest gives it up.
  expect(published).toContain("codex-talking");
  expect(published).not.toContain("codex-old");
  expect(published[0]).toBe("codex-talking");
});

test("a working session is published before an idle one, and conch's own latch counts as activity", () => {
  const sessions = [row("idle-recent", 9_000), row("working-long", 1_000, "busy"), row("latched", 100)];
  expect(sessionsToPublish(sessions, 2).map((s) => s.sessionId)).toEqual(["working-long", "idle-recent"]);
  // A turn conch saw end a moment ago is newer than whatever the registry last said.
  const latched = (id: string) => (id === "latched" ? 50_000 : undefined);
  expect(sessionsToPublish(sessions, 2, latched).map((s) => s.sessionId)).toEqual(["working-long", "latched"]);
});

test("equally quiet sessions keep the registry's order, so a still dashboard does not reshuffle", () => {
  const sessions = [row("a", 0), row("b", 0), row("c", 0)];
  expect(sessionsToPublish(sessions, 3).map((s) => s.sessionId)).toEqual(["a", "b", "c"]);
  expect(sessionsToPublish(sessions, 0)).toEqual([]);
});

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("an agent row's history read reaches the agent's own record, not session-not-found", () => {
  // Discovery records a Claude agent's sidechain as `<parent>/agent-<id>`; the row on screen is `agent-<id>`.
  const owner = "fixture-device";
  const parent = "11111111-2222-4333-8444-555555555555";
  const agentId = "agent-ab7c3a5f5b22cbff3";
  const nativeId = `${parent}/${agentId}`;
  const recorded: RecordSession = { id: recordKey(owner, "claude", nativeId), nativeId, ownerDeviceId: owner, provider: "claude",
    parentNativeId: parent };
  const dir = mkdtempSync(join(tmpdir(), "conch-agent-history-"));
  cleanup.push(dir);
  const store = new RecordStore({ configDir: dir });
  try {
    const bytes = Buffer.from([
      { type: "user", uuid: "u1", parentUuid: null, isSidechain: true, timestamp: "2026-09-28T06:00:00Z", message: { role: "user", content: "Lay out the amount field" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", isSidechain: true, timestamp: "2026-09-28T06:00:05Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Laid out." }] } },
    ].map((entry) => JSON.stringify(entry) + "\n").join(""));
    store.ingest({ session: recorded, source: { id: `${recorded.id}:source`, path: `/fixture/${parent}/subagents/${agentId}.jsonl`,
      device: "1", inode: "1", modifiedMs: 1, size: bytes.length, from: 0, bytes, prefix: bytes.subarray(0, 256),
      checkpoint: new Uint8Array(), expected: null } });

    const agent: SessionInfo = { sessionId: agentId, parentSessionId: parent, backend: "claude",
      transcriptPath: `/Users/fixture/.claude/projects/-work/${parent}/subagents/${agentId}.jsonl` } as SessionInfo;
    const live = { sessions: new Map<string, SessionInfo>(), agents: new Map([[agentId, agent]]) };
    const session = historySessionFor(owner, agentId, live);
    expect(session).toBe(recorded.id);
    const page = store.historyPage({ session }, owner);
    expect(page.kind).toBe("history-page");
    if (page.kind === "history-page") expect(page.items.map((item) => item.preview)).toEqual(["Lay out the amount field", "Laid out."]);

    // Resolved against the sessions alone — what the daemon did — the same read found nothing.
    const unresolved = historySessionFor(owner, agentId, { sessions: new Map(), agents: new Map() });
    expect(store.historyPage({ session: unresolved }, owner)).toMatchObject({ kind: "history-error", code: "session-not-found" });
  } finally {
    store.close();
  }
});
