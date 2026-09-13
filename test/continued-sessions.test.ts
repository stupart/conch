import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BG_NO_TERMINAL,
  findHookWindow,
  findTranscript,
  isEngageable,
  registrySnapshot,
} from "../src/sessions.ts";
import { lastAssistantReply, readConversationTail } from "../src/conversation.ts";

/**
 * The shapes Claude Code 2.1.266 leaves when a conversation is backgrounded:
 * the window (interactive, old id, `parkedJobId`) stays live, a `bg` process
 * carries the conversation on under a new id, and the old transcript ends in
 * `continued-in` followed by metadata that keeps its mtime fresh.
 */
const CWD = "/Users/t";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const claudeDir = mkdtempSync(join(tmpdir(), "conch-continued-"));
  roots.push(claudeDir);
  mkdirSync(join(claudeDir, "sessions"), { recursive: true });
  const projects = join(claudeDir, "projects", CWD.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(projects, { recursive: true });
  return {
    claudeDir,
    registry(pid: number, entry: object) {
      writeFileSync(join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({
        pid, cwd: CWD, entrypoint: "cli", status: "busy", ...entry,
      }));
    },
    transcript(id: string, records: object[]) {
      writeFileSync(join(projects, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    },
    // Hermetic: no Codex home, no `ps`.
    options: { configDir: join(claudeDir, "conch-config"), codexHome: join(claudeDir, "codex"), processParents: async () => null },
  };
}

const said = (id: string, uuid: string, parentUuid: string | null, role: "user" | "assistant", text: string) => ({
  type: role,
  uuid,
  parentUuid,
  sessionId: id,
  timestamp: "2026-09-10T01:00:00.000Z",
  message: role === "user"
    ? { role, content: text }
    : { role, content: [{ type: "text", text }], stop_reason: "end_turn" },
});

const movedTo = (from: string, to: string) => [
  { type: "cost-state", sessionId: from, totalCostUSD: 1 },
  { type: "bridge-session", sessionId: from, bridgeSessionId: "cse_01Moved" },
  { type: "continued-in", timestamp: "2026-09-10T01:59:06.338Z", sessionId: from, continuedInSessionId: to },
];

/** The real shape: window 61637 on `pred`, bg 72858 on `succ`. */
function backgrounded() {
  const f = fixture();
  f.registry(61637, { sessionId: "pred", kind: "interactive", name: "conch", nameSource: "user", parkedJobId: "succjob", bridgeSessionId: null, startedAt: 1 });
  f.registry(72858, { sessionId: "succ", kind: "bg", name: "conch", jobId: "succjob", bridgeSessionId: "session_01Moved", startedAt: 2 });
  f.transcript("pred", [
    { type: "custom-title", customTitle: "frozen title", sessionId: "pred" },
    said("pred", "u1", null, "user", "start"),
    said("pred", "a1", "u1", "assistant", "frozen on the tenth"),
    ...movedTo("pred", "succ"),
  ]);
  f.transcript("succ", [
    { type: "custom-title", customTitle: "live title", sessionId: "succ" },
    { type: "mode", mode: "normal", sessionId: "succ" },
    { type: "permission-mode", permissionMode: "bypassPermissions", sessionId: "succ" },
    said("succ", "u1", null, "user", "start"),
    said("succ", "a1", "u1", "assistant", "frozen on the tenth"),
    said("succ", "u2", "a1", "user", "keep going"),
    said("succ", "a2", "u2", "assistant", "still going days later"),
  ]);
  return f;
}

describe("a conversation moved to a background session", () => {
  test("is one row: the live successor, with its own title and conversation", async () => {
    const f = backgrounded();
    const snap = (await registrySnapshot(f.claudeDir, f.options))!;
    const claude = snap.infos.filter((s) => s.backend !== "codex");
    expect(claude.map((s) => s.sessionId)).toEqual(["succ"]);
    const row = claude[0]!;
    expect(row.name).toBe("live title");
    // The window it left is still alive — just not a second row.
    expect(snap.liveIds.has("pred")).toBe(true);

    const path = findTranscript(f.claudeDir, row.sessionId)!;
    expect(path.endsWith("succ.jsonl")).toBe(true);
    const conversation = await readConversationTail(path, row.sessionId, "claude");
    expect(lastAssistantReply(conversation)).toBe("still going days later");
  });

  test("the background row has no terminal and no pid to route by", async () => {
    const f = backgrounded();
    const row = (await registrySnapshot(f.claudeDir, f.options))!.infos.find((s) => s.sessionId === "succ")!;
    expect(row.noTerminal).toBe(BG_NO_TERMINAL);
    // 72858 descends from 61637's window: a pid here could type into it.
    expect(row.pid).toBe(0);
    expect(isEngageable({ kind: "bg", entrypoint: "cli" })).toBe(true);
    expect(isEngageable({ kind: "bg", entrypoint: "claude-desktop" })).toBe(false);
  });

  test("a hook the successor fires lands on the row the app shows", async () => {
    const f = backgrounded();
    const window = await findHookWindow(f.claudeDir, "succ");
    expect(window?.sessionId).toBe("succ");
    expect(isEngageable(window!)).toBe(true);
    expect(window?.pid).toBe(0);
    expect(window?.noTerminal).toBe(BG_NO_TERMINAL);
  });

  test("a successor that is not live leaves the window as its own row", async () => {
    const f = backgrounded();
    rmSync(join(f.claudeDir, "sessions", "72858.json"));
    const claude = (await registrySnapshot(f.claudeDir, f.options))!.infos;
    expect(claude.map((s) => s.sessionId)).toEqual(["pred"]);
    // It is what that terminal holds, so it keeps its pid and its own title.
    expect(claude[0]!.pid).toBe(61637);
    expect(claude[0]!.noTerminal).toBeUndefined();
    expect(claude[0]!.name).toBe("frozen title");
  });

  test("a chain is followed through a successor that is no longer live", async () => {
    const f = backgrounded();
    // pred → mid (gone) → succ (live)
    f.transcript("pred", [said("pred", "u1", null, "user", "start"), ...movedTo("pred", "mid")]);
    f.transcript("mid", [said("mid", "u1", null, "user", "start"), ...movedTo("mid", "succ")]);
    const ids = (await registrySnapshot(f.claudeDir, f.options))!.infos.map((s) => s.sessionId);
    expect(ids).toEqual(["succ"]);
  });

  test("a cycle in continued-in terminates and hides nothing", async () => {
    const f = backgrounded();
    rmSync(join(f.claudeDir, "sessions", "72858.json"));
    f.transcript("pred", [said("pred", "u1", null, "user", "start"), ...movedTo("pred", "a")]);
    f.transcript("a", movedTo("a", "b"));
    f.transcript("b", movedTo("b", "a"));
    const ids = (await registrySnapshot(f.claudeDir, f.options))!.infos.map((s) => s.sessionId);
    expect(ids).toEqual(["pred"]);
  });

  test("a conversation that carried on in its window after moving is not hidden", async () => {
    const f = backgrounded();
    f.transcript("pred", [
      said("pred", "u1", null, "user", "start"),
      ...movedTo("pred", "succ"),
      said("pred", "u2", "u1", "user", "typed here anyway"),
    ]);
    const ids = (await registrySnapshot(f.claudeDir, f.options))!.infos.map((s) => s.sessionId).sort();
    expect(ids).toEqual(["pred", "succ"]);
  });

  test("a background window sharing an id with a terminal keeps its own key", async () => {
    const f = fixture();
    f.registry(111, { sessionId: "shared", kind: "interactive", startedAt: 1 });
    f.registry(222, { sessionId: "shared", kind: "bg", startedAt: 2 });
    const ids = (await registrySnapshot(f.claudeDir, f.options))!.infos.map((s) => s.sessionId).sort();
    expect(ids).toEqual(["shared#111", "shared#222"]);
  });
});
