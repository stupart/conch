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

describe("Claude session names match what /resume shows", () => {
  test("a renamed session shows the name, not its opening sentence", () => {
    // Tyler: "The resume names i see in conch are weird - they don't match what
    // i see when i run /resume in the apps". conch was labelling every row with
    // the first thing ever said in that session, so the ones he recognises —
    // conch, honeyb, arch site — each read as an ancient opening line.
    const home = mkdtempSync(join(tmpdir(), "conch-title-"));
    writeClaude(home, "proj", "s1", [
      { type: "user", cwd: "/work/thing", entrypoint: "cli", message: { role: "user", content: "please look at the thing i mentioned" } },
      { type: "ai-title", aiTitle: "Look at the mentioned thing" },
      { type: "custom-title", customTitle: "arch site" },
    ], Date.now());

    const rows = readResumableSessions({ configDir: home, claudeHome: home, codexHome: join(home, "nope") });
    expect(rows.map((r) => r.label)).toEqual(["arch site"]);
    rmSync(home, { recursive: true, force: true });
  });

  test("the latest rename wins, because both are rewritten as they change", () => {
    // Claude Code appends a fresh record on every rename — roughly two thousand
    // in a long transcript — so the CURRENT name is the last one, not the first.
    const home = mkdtempSync(join(tmpdir(), "conch-title-"));
    writeClaude(home, "proj", "s1", [
      { type: "user", cwd: "/work/thing", entrypoint: "cli", message: { role: "user", content: "hello" } },
      { type: "custom-title", customTitle: "first name" },
      { type: "custom-title", customTitle: "renamed later" },
    ], Date.now());

    const rows = readResumableSessions({ configDir: home, claudeHome: home, codexHome: join(home, "nope") });
    expect(rows[0]?.label).toBe("renamed later");
    rmSync(home, { recursive: true, force: true });
  });

  test("a generated title is used when nothing was renamed", () => {
    const home = mkdtempSync(join(tmpdir(), "conch-title-"));
    writeClaude(home, "proj", "s1", [
      { type: "user", cwd: "/work/thing", entrypoint: "cli", message: { role: "user", content: "some long opening request" } },
      { type: "ai-title", aiTitle: "Generated Title" },
    ], Date.now());

    const rows = readResumableSessions({ configDir: home, claudeHome: home, codexHome: join(home, "nope") });
    expect(rows[0]?.label).toBe("Generated Title");
    rmSync(home, { recursive: true, force: true });
  });

  test("headless routines are not sessions you resume", () => {
    // Boaker's cron runs were 15 of the 25 most recent transcripts on this
    // machine, so the list filled with rows reading "You are Boaker, Tyler's
    // standing boat-market watcher". Same rule isEngageable applies to live
    // sessions, and conservative in the same direction: only a positively
    // non-cli entrypoint is dropped.
    const home = mkdtempSync(join(tmpdir(), "conch-title-"));
    writeClaude(home, "proj", "cron", [
      { type: "user", cwd: "/work/thing", entrypoint: "sdk-cli", message: { role: "user", content: "You are Boaker, a standing watcher" } },
    ], Date.now());
    writeClaude(home, "proj", "human", [
      { type: "user", cwd: "/work/thing", entrypoint: "cli", message: { role: "user", content: "a real session" } },
    ], Date.now() - 1000);

    const rows = readResumableSessions({ configDir: home, claudeHome: home, codexHome: join(home, "nope") });
    expect(rows.map((r) => r.sessionId)).toEqual(["human"]);
    rmSync(home, { recursive: true, force: true });
  });

  test("an unmarked transcript still lists, rather than being dropped", () => {
    // Absence is not evidence of a routine. Over-dropping hides real work.
    const home = mkdtempSync(join(tmpdir(), "conch-title-"));
    writeClaude(home, "proj", "s1", [
      { type: "user", cwd: "/work/thing", message: { role: "user", content: "no entrypoint recorded" } },
    ], Date.now());

    const rows = readResumableSessions({ configDir: home, claudeHome: home, codexHome: join(home, "nope") });
    expect(rows).toHaveLength(1);
    rmSync(home, { recursive: true, force: true });
  });
});
