import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { readClaudeAccounts } from "../src/claude-accounts.ts";
import { applyMigration, describePlan, mergeMemoryIndex, planMigration, planSettings, type MigrationPaths } from "../scripts/one-account.ts";

/**
 * scripts/one-account.ts folds Tyler's Blueprint profile into Default (2026-10-28). Played here on a made-up home: the
 * dry run writes nothing, the real run copies and merges with a backup first, and the folded profile's folder, sign-in
 * included, is the same afterwards, byte for byte.
 */

const BP = "39b4dccc-1262-45cd-86aa-69038e482db6";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const turn = (id: string, text: string) => JSON.stringify({ type: "user", sessionId: id, cwd: "/work/demo", message: { content: text } }) + "\n";

let root: string;
let paths: MigrationPaths;
let blueprint: string;

function put(path: string, text: string, at?: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  if (at !== undefined) utimesSync(path, new Date(at), new Date(at));
}

/** Every file under a folder with its contents' hash: the folded profile must come out of the run the same. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "conch-one-account-"));
  const home = join(root, "home");
  const conch = join(home, ".config", "conch");
  blueprint = join(conch, "claude", BP);
  paths = {
    home, defaultDir: join(home, ".claude"), defaultConfig: join(home, ".claude.json"), conchConfigDir: conch,
    swapSequence: join(home, ".claude-swap-backup", "sequence.json"), sessionsFile: join(root, "conch-sessions.json"),
  };
  put(join(conch, "claude-accounts.json"), JSON.stringify([{ id: BP, label: "Blueprint", configDir: blueprint }]));
  put(join(conch, "settings.json"), JSON.stringify({ "claude-rotation": true }));
  put(paths.swapSequence, JSON.stringify({ accounts: { 1: { email: "tyler@example.com" }, 2: { email: "dao@example.com" } } }));
  put(paths.defaultConfig, JSON.stringify({ mcpServers: { mobbin: { type: "http", url: "https://mobbin" } } }));
  put(join(paths.defaultDir, "settings.json"), JSON.stringify({ theme: "auto", enabledPlugins: { "studio@market": false } }));
  put(join(paths.defaultDir, "projects", "-work-demo", "memory", "MEMORY.md"), "- [Ours](ours.md) — Default's\n- [Shared](shared.md) — old words\n", 1_000);
  put(join(paths.defaultDir, "projects", "-work-demo", "memory", "ours.md"), "ours");
  put(join(paths.defaultDir, "projects", "-work-demo", "memory", "both.md"), "Default's, older", 1_000);

  put(join(blueprint, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "tyler@example.com" },
    mcpServers: { mobbin: { type: "http", url: "https://mobbin" }, seashell: { type: "stdio", command: "/opt/homebrew/bin/seashell", args: ["mcp"] } } }));
  put(join(blueprint, ".credentials.json"), "a sign-in nobody copies");
  put(join(blueprint, "settings.json"), JSON.stringify({ theme: "dark", enabledPlugins: { "studio@market": true, "telemetry@builtin": false },
    statusLine: { command: "conch usage-statusline bp" }, env: { ANTHROPIC_API_KEY: "never carried" } }));
  put(join(blueprint, "projects", "-work-demo", `${A}.jsonl`), turn(A, "one") + turn(A, "two"));
  put(join(blueprint, "projects", "-work-demo", A, "tool-results", "r1.txt"), "big output");
  put(join(blueprint, "projects", "-other", `${B}.jsonl`), turn(B, "three"));
  put(join(blueprint, "projects", "-work-demo", "memory", "MEMORY.md"), "- [Theirs](theirs.md) — Blueprint's\n- [Shared](shared.md) — new words\n", 2_000);
  put(join(blueprint, "projects", "-work-demo", "memory", "theirs.md"), "theirs");
  put(join(blueprint, "projects", "-work-demo", "memory", "both.md"), "Blueprint's, newer", 2_000);
  put(join(blueprint, "skills", "mine", "SKILL.md"), "a skill");
  put(join(blueprint, "skills", "synced", "x", "SKILL.md"), "synced by Claude");
  // Itself, still running in Blueprint (this test's process stands in for its Claude), and shown in conch.
  put(join(blueprint, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: A, cwd: "/work/demo", kind: "interactive" }));
  put(join(blueprint, "sessions", "999999.json"), JSON.stringify({ pid: 999_999, sessionId: B, cwd: "/other", kind: "interactive" }));
  put(paths.sessionsFile, JSON.stringify({ rows: [{ id: A, label: "Client dashboard" }] }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("memory indexes join: Default's lines stay, the other's are added, and the newer one's words win a shared memory", () => {
  const ours = "- [A](a.md) — ours\n- [S](s.md) — old\n";
  const theirs = "- [B](b.md) — theirs\n\n- [S](s.md) — new\n";
  expect(mergeMemoryIndex(ours, theirs, true)).toBe("- [A](a.md) — ours\n- [S](s.md) — new\n- [B](b.md) — theirs\n");
  expect(mergeMemoryIndex(ours, theirs, false)).toBe("- [A](a.md) — ours\n- [S](s.md) — old\n- [B](b.md) — theirs\n");
  expect(mergeMemoryIndex(ours, ours, true)).toBe(ours);
});

test("settings: what Default lacks is carried, what both say stays Default's, sign-in and per-profile settings stay put", () => {
  const plan = planSettings({ theme: "auto", enabledPlugins: { a: false } }, { theme: "dark", enabledPlugins: { a: true, b: false }, tui: "fullscreen", env: { X: "1" }, statusLine: {} });
  expect(plan.merged).toEqual({ theme: "auto", enabledPlugins: { a: false, b: false }, tui: "fullscreen" });
  expect(plan.carried).toEqual(["enabledPlugins.b: false", 'tui: "fullscreen"']);
  expect(plan.conflicts.map((one) => one.key)).toEqual(["theme", "enabledPlugins.a"]);
  expect(plan.left).toEqual(["env", "statusLine"]);
});

test("the dry run says everything and writes nothing", async () => {
  const before = tree(root);
  const plan = await planMigration(paths);
  expect(tree(root)).toEqual(before);
  expect(plan.from.id).toBe(BP);
  expect(plan.rotation).toEqual({ on: true, emails: ["tyler@example.com", "dao@example.com"], covers: true });
  expect(plan.conversations.map((one) => [one.id, one.transcript, one.files]).sort()).toEqual([[A, "copied", 1], [B, "copied", 0]]);
  expect(plan.memory.map((one) => [one.file, one.action]).sort()).toEqual([["MEMORY.md", "merge"], ["both.md", "replace"], ["theirs.md", "copy"]]);
  expect(plan.mcp.add.map((one) => one.name)).toEqual(["seashell"]);
  expect(plan.userFiles).toEqual({ copy: [join("skills", "mine", "SKILL.md")], conflicts: [] });
  expect(plan.live.map((one) => [one.id, one.label, one.hidden])).toEqual([[A, "Client dashboard", false]]);
  const said = describePlan(plan).join("\n");
  expect(said).toContain("Its subscription is already in the rotation");
  expect(said).toContain("would copy 2 new ones");
  expect(said).toContain("+ enabledPlugins.telemetry@builtin: false");
  expect(said).toContain('= enabledPlugins.studio@market: Default\'s false stays (the other has true)');
  expect(said).toContain("would add seashell to Default");
  expect(said).toContain('"Client dashboard" (aaaaaaaa, pid');
  expect(said).toContain("its session menu → Restart");
  expect(said).not.toContain("never carried");
});

test("the real run copies, merges and retires with a backup first, leaves the profile untouched, and a second run finds nothing new", async () => {
  const blueprintBefore = tree(blueprint);
  const added: string[] = [];
  const addMcpServer = async (name: string, config: unknown) => {
    added.push(name);
    const file = JSON.parse(readFileSync(paths.defaultConfig, "utf8"));
    writeFileSync(paths.defaultConfig, JSON.stringify({ ...file, mcpServers: { ...file.mcpServers, [name]: config } }));
    return { ok: true, output: "" };
  };
  const done = await applyMigration(await planMigration(paths), paths, { addMcpServer, now: () => new Date("2026-10-28T12:00:00Z") });

  const claude = paths.defaultDir;
  expect(readFileSync(join(claude, "projects", "-work-demo", `${A}.jsonl`), "utf8")).toBe(turn(A, "one") + turn(A, "two"));
  expect(readFileSync(join(claude, "projects", "-work-demo", A, "tool-results", "r1.txt"), "utf8")).toBe("big output");
  expect(readFileSync(join(claude, "projects", "-other", `${B}.jsonl`), "utf8")).toBe(turn(B, "three"));
  const memory = join(claude, "projects", "-work-demo", "memory");
  expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toBe("- [Ours](ours.md) — Default's\n- [Shared](shared.md) — new words\n- [Theirs](theirs.md) — Blueprint's\n");
  expect(readFileSync(join(memory, "theirs.md"), "utf8")).toBe("theirs");
  expect(readFileSync(join(memory, "both.md"), "utf8")).toBe("Blueprint's, newer");
  expect(readFileSync(join(memory, "ours.md"), "utf8")).toBe("ours");
  expect(JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"))).toEqual({ theme: "auto", enabledPlugins: { "studio@market": false, "telemetry@builtin": false } });
  expect(added).toEqual(["seashell"]);
  expect(readFileSync(join(claude, "skills", "mine", "SKILL.md"), "utf8")).toBe("a skill");
  expect(existsSync(join(claude, "skills", "synced"))).toBe(false);
  expect(existsSync(join(claude, ".credentials.json"))).toBe(false);

  // Retired: kept, not offered.
  expect(readClaudeAccounts(claude, join(paths.conchConfigDir, "claude-accounts.json")).find((one) => one.id === BP)?.retired).toBe(true);
  // Everything it changed, as it was, first.
  const backup = join(paths.conchConfigDir, "one-account-backups", "2026-10-28T12-00-00-000Z");
  expect(done.backup).toBe(backup);
  const kept = (path: string) => join(backup, relative("/", path));
  expect(readFileSync(kept(join(memory, "MEMORY.md")), "utf8")).toBe("- [Ours](ours.md) — Default's\n- [Shared](shared.md) — old words\n");
  expect(readFileSync(kept(join(memory, "both.md")), "utf8")).toBe("Default's, older");
  expect(JSON.parse(readFileSync(kept(join(claude, "settings.json")), "utf8")).theme).toBe("auto");
  expect(JSON.parse(readFileSync(kept(join(paths.conchConfigDir, "claude-accounts.json")), "utf8"))[0].retired).toBeUndefined();
  expect(existsSync(kept(paths.defaultConfig))).toBe(true);
  expect(readFileSync(join(backup, "plan.txt"), "utf8")).toContain("Fold the \"Blueprint\" Claude profile");
  const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8"));
  expect(manifest.writes.map((one: { action: string }) => one.action)).toContain("retire");
  expect(statSync(join(backup, "manifest.json")).mode & 0o777).toBe(0o600);
  // The folded profile, sign-in and all, is exactly as it was.
  expect(tree(blueprint)).toEqual(blueprintBefore);

  // The session that was still running wrote one more turn before it moved: a second run brings only that.
  writeFileSync(join(blueprint, "projects", "-work-demo", `${A}.jsonl`), turn(A, "one") + turn(A, "two") + turn(A, "four"));
  const again = await planMigration(paths);
  expect(again.from.retired).toBe(true);
  expect(again.conversations.map((one) => [one.id, one.transcript]).sort()).toEqual([[A, "extended"], [B, "same"]]);
  expect(again.memory.every((one) => one.action === "same")).toBe(true);
  expect(again.settings.carried).toEqual([]);
  expect(again.mcp.add).toEqual([]);
  expect(again.userFiles.copy).toEqual([]);
  const second = await applyMigration(again, paths, { addMcpServer, now: () => new Date("2026-10-28T13:00:00Z") });
  expect(second.lines).toContain("conversations: copied 0, extended 1");
  expect(readFileSync(join(claude, "projects", "-work-demo", `${A}.jsonl`), "utf8")).toBe(turn(A, "one") + turn(A, "two") + turn(A, "four"));
  expect(readFileSync(join(second.backup, relative("/", join(claude, "projects", "-work-demo", `${A}.jsonl`))), "utf8")).toBe(turn(A, "one") + turn(A, "two"));
});

test("it won't retire a profile whose subscription rotation doesn't cover, unless told to", async () => {
  writeFileSync(join(paths.conchConfigDir, "settings.json"), JSON.stringify({ "claude-rotation": false }));
  const plan = await planMigration(paths);
  expect(plan.rotation.covers).toBe(false);
  expect(describePlan(plan).join("\n")).toContain("NOT in the rotation (rotation is off)");
  const addMcpServer = async () => ({ ok: true, output: "" });
  await expect(applyMigration(plan, paths, { addMcpServer })).rejects.toThrow("rotation doesn't cover tyler@example.com");
  expect(existsSync(join(paths.conchConfigDir, "one-account-backups"))).toBe(false);
  await applyMigration(plan, paths, { addMcpServer }, { evenIfNotRotated: true });
  expect(readClaudeAccounts(paths.defaultDir, join(paths.conchConfigDir, "claude-accounts.json"))[1]?.retired).toBe(true);
});
