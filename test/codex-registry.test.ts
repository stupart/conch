import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCodexSessions,
  writeCodexSession,
} from "../src/codex-sessions.ts";
import {
  findTranscript,
  registrySnapshot,
  sessionGoneFromSnapshot,
} from "../src/sessions.ts";

test("Codex registry writes per pid and preserves a known transcript path on sparse updates", () => {
  const root = mkdtempSync(join(tmpdir(), "conch-codex-registry-write-"));
  const options = {
    configDir: root,
    isPidAlive: (pid: number) => pid === 4242,
  };
  const path = join(root, "codex-sessions", "4242.json");
  try {
    writeCodexSession({
      sessionId: "session-4242",
      cwd: "/work/project",
      pid: 4242,
      status: "idle",
      updatedAt: 100,
      transcriptPath: "/rollouts/rollout-session-4242.jsonl",
    }, options);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      sessionId: "session-4242",
      cwd: "/work/project",
      pid: 4242,
      status: "idle",
      updatedAt: 100,
      transcriptPath: "/rollouts/rollout-session-4242.jsonl",
    });

    writeCodexSession({
      sessionId: "session-4242",
      cwd: "/work/project",
      pid: 4242,
      status: "busy",
      updatedAt: 200,
    }, options);
    expect(readCodexSessions(options).entries).toEqual([{
      sessionId: "session-4242",
      cwd: "/work/project",
      pid: 4242,
      status: "busy",
      updatedAt: 200,
      transcriptPath: "/rollouts/rollout-session-4242.jsonl",
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Codex-only registry is a complete snapshot and dead sessions are pruned", async () => {
  const root = mkdtempSync(join(tmpdir(), "conch-codex-only-"));
  const configDir = join(root, "config");
  const claudeDir = join(root, "missing-claude");
  const path = join(configDir, "codex-sessions", "5252.json");
  try {
    writeCodexSession({
      sessionId: "codex-only",
      cwd: "/work/codex-only",
      pid: 5252,
      status: "idle",
      updatedAt: 300,
      transcriptPath: "/rollouts/rollout-codex-only.jsonl",
    }, { configDir });

    const live = await registrySnapshot(claudeDir, {
      configDir,
      isPidAlive: () => true,
    });
    expect(live?.complete).toBe(true);
    expect(live?.liveIds).toEqual(new Set(["codex-only"]));
    expect(sessionGoneFromSnapshot(live, "codex-only")).toBe(false);
    expect(findTranscript(claudeDir, "codex-only", {
      configDir,
      isPidAlive: () => true,
    })).toBe("/rollouts/rollout-codex-only.jsonl");

    const gone = await registrySnapshot(claudeDir, {
      configDir,
      isPidAlive: () => false,
    });
    expect(gone?.complete).toBe(true);
    expect(gone?.liveIds).toEqual(new Set());
    expect(sessionGoneFromSnapshot(gone, "codex-only")).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(findTranscript(claudeDir, "codex-only", {
      configDir,
      isPidAlive: () => false,
    })).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an existing but unreadable Codex registry source is incomplete, not missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "conch-codex-registry-invalid-"));
  try {
    writeFileSync(join(root, "codex-sessions"), "not a directory");
    expect(readCodexSessions({ configDir: root })).toEqual({
      entries: [],
      complete: false,
      available: false,
    });
    const claudeDir = join(root, "claude");
    mkdirSync(join(claudeDir, "sessions"), { recursive: true });
    expect((await registrySnapshot(claudeDir, { configDir: root }))?.complete).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
