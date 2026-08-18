import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeHomeDir,
  readResumableSessions,
  readResumableSessionsResult,
} from "../src/resumable.ts";

const roots: string[] = [];

function fixture(): { root: string; codexHome: string; claudeHome: string } {
  const root = mkdtempSync(join(tmpdir(), "conch-resumable-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  const claudeHome = join(root, "claude");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(join(claudeHome, "projects"), { recursive: true });
  return { root, codexHome, claudeHome };
}

function writeCodex(
  home: string,
  threads: Array<Record<string, unknown>>,
): string {
  const path = join(home, "state_5.sqlite");
  const db = new Database(path);
  db.run(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, cwd TEXT, name TEXT, agent_nickname TEXT, title TEXT,
    updated_at_ms INTEGER, archived INTEGER, source TEXT)`);
  for (const thread of threads) {
    db.run(
      `INSERT INTO threads
        (id, cwd, name, agent_nickname, title, updated_at_ms, archived, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        thread.id,
        thread.cwd ?? "/tmp",
        thread.name ?? null,
        thread.agent_nickname ?? null,
        thread.title ?? null,
        thread.updated_at_ms ?? 0,
        thread.archived ?? 0,
        thread.source ?? "cli",
      ] as any,
    );
  }
  db.close();
  return path;
}

function writeClaude(
  home: string,
  project: string,
  sessionId: string,
  lines: unknown[],
  updatedAt: number,
): string {
  const dir = join(home, "projects", project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const when = new Date(updatedAt);
  utimesSync(path, when, when);
  return path;
}

async function runCli(
  root: string,
  claudeHome: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("CONCH_") || key === "CLAUDE_CONFIG_DIR") continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: root,
    CONCH_CONFIG_DIR: join(root, "config"),
    CLAUDE_CONFIG_DIR: claudeHome,
    NO_COLOR: "1",
  });
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), ...args],
    { cwd: join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resumable session discovery", () => {
  test("combines both backends newest-first without Codex liveness filtering", () => {
    const f = fixture();
    const state = writeCodex(f.codexHome, [
      {
        id: "codex-old",
        cwd: "/work/ancient",
        name: "Old but resumable",
        updated_at_ms: 1_000,
        source: "cli",
      },
      {
        id: "codex-mid",
        cwd: "/work/relay",
        title: "Relay reader",
        updated_at_ms: 3_000,
        source: "vscode",
      },
      {
        id: "codex-script",
        name: "not interactive",
        updated_at_ms: 9_000,
        source: "exec",
      },
      {
        id: "codex-archived",
        name: "archived",
        updated_at_ms: 8_000,
        archived: 1,
      },
    ]);
    const before = statSync(state).mtimeMs;
    writeClaude(f.claudeHome, "-work-conch", "claude-new", [
      { type: "mode" },
      { type: "permission-mode" },
      { type: "user", message: { content: "<system-reminder>ignore me</system-reminder>" } },
      { type: "assistant", cwd: "/work/conch" },
      { type: "user", message: { content: [{ type: "text", text: "Build the reader half" }] } },
    ], 4_000);
    writeClaude(f.claudeHome, "-work-fallback", "claude-old", [
      { type: "mode" },
      { type: "assistant", cwd: "/work/fallback" },
      { type: "user", message: { content: "<task-notification>background</task-notification>" } },
    ], 2_000);

    const result = readResumableSessionsResult({
      configDir: join(f.root, "config"),
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
      limit: 20,
    });

    expect(result.complete).toBe(true);
    expect(result.sessions).toEqual([
      {
        sessionId: "claude-new",
        backend: "claude",
        label: "Build the reader half",
        cwd: "/work/conch",
        updatedAt: 4_000,
      },
      {
        sessionId: "codex-mid",
        backend: "codex",
        label: "Relay reader",
        cwd: "/work/relay",
        updatedAt: 3_000,
      },
      {
        sessionId: "claude-old",
        backend: "claude",
        label: "fallback",
        cwd: "/work/fallback",
        updatedAt: 2_000,
      },
      {
        sessionId: "codex-old",
        backend: "codex",
        label: "Old but resumable",
        cwd: "/work/ancient",
        updatedAt: 1_000,
      },
    ]);
    expect(statSync(state).mtimeMs).toBe(before);
  });

  test("filters label and cwd case-insensitively, truncates labels, and reports a limited list", () => {
    const f = fixture();
    writeCodex(f.codexHome, [
      { id: "codex", cwd: "/other", name: "Needle Codex", updated_at_ms: 2_000 },
    ]);
    writeClaude(f.claudeHome, "project", "claude", [
      { type: "assistant", cwd: "/Projects/Needle-Haystack" },
      { type: "user", message: { content: `  ${"x".repeat(80)}  ` } },
    ], 3_000);
    writeClaude(f.claudeHome, "project", "later", [
      { type: "assistant", cwd: "/other/later" },
      { type: "user", message: { content: "does not match" } },
    ], 1_000);

    const options = {
      configDir: join(f.root, "config"),
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
      query: "nEeDlE",
    };
    const all = readResumableSessionsResult({ ...options, limit: 10 });
    expect(all.complete).toBe(true);
    expect(all.sessions.map((session) => session.sessionId)).toEqual(["claude", "codex"]);
    expect(all.sessions[0]?.label).toHaveLength(40);
    expect(all.sessions[0]?.label.endsWith("…")).toBe(true);

    const limited = readResumableSessionsResult({ ...options, limit: 1 });
    expect(limited.sessions.map((session) => session.sessionId)).toEqual(["claude"]);
    expect(limited.complete).toBe(false);
  });

  test("reads only the first 40 Claude records and falls back to the cwd basename", () => {
    const f = fixture();
    writeCodex(f.codexHome, []);
    writeClaude(f.claudeHome, "project", "bounded", [
      { type: "assistant", cwd: "/work/bounded" },
      ...Array.from({ length: 39 }, () => ({ type: "mode" })),
      { type: "user", message: { content: "too late to become the label" } },
    ], 5_000);

    expect(readResumableSessions({
      configDir: join(f.root, "config"),
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    })[0]?.label).toBe("bounded");
  });

  test("skips valid Claude metadata sidecars without losing resumable rows", () => {
    const f = fixture();
    writeCodex(f.codexHome, []);
    writeClaude(f.claudeHome, "project", "bad", [
      { type: "mode" },
      { type: "user", message: { content: "No cwd here" } },
    ], 2_000);
    writeClaude(f.claudeHome, "project", "good", [
      { type: "user", cwd: "/work/good", message: { content: "Good session" } },
    ], 1_000);

    const result = readResumableSessionsResult({
      configDir: join(f.root, "config"),
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    expect(result.sessions.map((session) => session.sessionId)).toEqual(["good"]);
    expect(result.complete).toBe(true);
  });

  test("marks a Claude file incomplete when cwd lies beyond the bounded head read", () => {
    const f = fixture();
    writeCodex(f.codexHome, []);
    writeClaude(f.claudeHome, "project", "too-deep", [
      ...Array.from({ length: 40 }, () => ({ type: "mode" })),
      { type: "user", cwd: "/work/too-deep", message: { content: "Too deep" } },
    ], 2_000);

    const result = readResumableSessionsResult({
      configDir: join(f.root, "config"),
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    expect(result.sessions).toEqual([]);
    expect(result.complete).toBe(false);
  });

  test("CONCH_CONFIG_DIR suppresses both real history homes unless explicitly redirected", () => {
    const previousConfig = process.env.CONCH_CONFIG_DIR;
    const previousClaude = process.env.CLAUDE_CONFIG_DIR;
    process.env.CONCH_CONFIG_DIR = "/tmp/conch-resumable-test-config";
    process.env.CLAUDE_CONFIG_DIR = "/tmp/should-not-be-read-without-an-option";
    try {
      expect(claudeHomeDir()).toBeNull();
      expect(readResumableSessions()).toEqual([]);
    } finally {
      if (previousConfig === undefined) delete process.env.CONCH_CONFIG_DIR;
      else process.env.CONCH_CONFIG_DIR = previousConfig;
      if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaude;
    }
  });

  test("conch resumable prints matching rows without a running daemon", async () => {
    const f = fixture();
    writeClaude(f.claudeHome, "project", "matching-id", [
      { type: "user", cwd: "/work/relay", message: { content: "Needle session" } },
    ], 6_000);
    writeClaude(f.claudeHome, "project", "other-id", [
      { type: "user", cwd: "/work/other", message: { content: "Other session" } },
    ], 5_000);

    const result = await runCli(f.root, f.claudeHome, ["resumable", "needle"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("claude");
    expect(result.stdout).toContain("Needle session");
    expect(result.stdout).toContain("/work/relay");
    expect(result.stdout).toContain("matching-id");
    expect(result.stdout).not.toContain("other-id");
  });
});
