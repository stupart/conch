import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findSessionByName,
  listSessions,
  registrySnapshot,
} from "../src/sessions.ts";

const RELIABLY_DEAD_PID = 2_147_483_647;

test("registrySnapshot merges live Codex sessions and prunes dead pid records", async () => {
  const root = mkdtempSync(join(tmpdir(), "conch-codex-registry-"));
  const claudeDir = join(root, "claude");
  const configDir = join(root, "config");
  const claudeSessionsDir = join(claudeDir, "sessions");
  const codexSessionsDir = join(configDir, "codex-sessions");
  const labelsPath = join(configDir, "labels.json");
  const previousConfigDir = process.env.CONCH_CONFIG_DIR;

  mkdirSync(claudeSessionsDir, { recursive: true });
  mkdirSync(codexSessionsDir, { recursive: true });
  writeFileSync(join(claudeSessionsDir, "111.json"), JSON.stringify({
    sessionId: "claude-live",
    name: "Claude Project",
    cwd: "/work/claude-project",
    pid: process.pid,
    status: "busy",
    statusUpdatedAt: 100,
    kind: "interactive",
    entrypoint: "cli",
  }));

  const updatedAt = 1_722_268_800_000;
  writeFileSync(join(codexSessionsDir, `${process.pid}.json`), JSON.stringify({
    sessionId: "codex-live",
    cwd: "/work/codex-project",
    pid: process.pid,
    status: "idle",
    updatedAt,
    transcriptPath: "/tmp/rollout-codex-live.jsonl",
  }));

  const deadPath = join(codexSessionsDir, `${RELIABLY_DEAD_PID}.json`);
  writeFileSync(deadPath, JSON.stringify({
    sessionId: "codex-dead",
    cwd: "/work/dead-project",
    pid: RELIABLY_DEAD_PID,
    status: "busy",
    updatedAt: updatedAt + 1,
    transcriptPath: "/tmp/rollout-codex-dead.jsonl",
  }));

  process.env.CONCH_CONFIG_DIR = configDir;
  try {
    const snapshot = await registrySnapshot(claudeDir);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.complete).toBe(true);
    expect(snapshot!.liveIds).toEqual(new Set(["claude-live", "codex-live"]));

    const claude = snapshot!.infos.find((session) =>
      session.sessionId === "claude-live"
    );
    expect(claude).toMatchObject({
      sessionId: "claude-live",
      status: "busy",
      statusUpdatedAt: 100,
    });

    const codex = snapshot!.infos.find((session) =>
      session.sessionId === "codex-live"
    );
    expect(codex).toMatchObject({
      sessionId: "codex-live",
      cwd: "/work/codex-project",
      pid: process.pid,
      status: "idle",
      statusUpdatedAt: updatedAt,
      backend: "codex",
    });
    expect(snapshot!.infos.some((session) => session.sessionId === "codex-dead"))
      .toBe(false);
    expect(existsSync(deadPath)).toBe(false);

    const listed = await listSessions(claudeDir);
    expect(listed.map((session) => session.sessionId).sort()).toEqual([
      "claude-live",
      "codex-live",
    ]);

    const found = await findSessionByName(claudeDir, "codex-project", {
      labelsPath,
    });
    expect(found?.sessionId).toBe("codex-live");
    expect(found?.backend).toBe("codex");
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.CONCH_CONFIG_DIR;
    } else {
      process.env.CONCH_CONFIG_DIR = previousConfigDir;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
