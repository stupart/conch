import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountStorePath, addClaudeAccount, offeredClaudeAccounts, readClaudeAccounts, requireClaudeAccount, retireClaudeAccount, type ClaudeAccount } from "../src/claude-accounts.ts";
import { accountResumableSessions, findAccountTranscript } from "../src/claude-account-sessions.ts";
import { bringConversationAcross, bringFileAcross, launchOffRetiredProfiles } from "../src/retired-profile.ts";
import { resumeAccountFor, type ResumeLookup } from "../src/resume-account.ts";
import { terminalSessionCommand } from "../src/session-lifecycle.ts";

/**
 * 2026-10-28, Tyler: "we should have one account for all of conch I thought? (at least for mine)". His Blueprint profile
 * was signed in to the same subscription rotation already covers as Default's first account. Retiring it keeps its
 * folder and its sessions seen, and launches everything in Default, bringing each conversation across as it goes.
 */

const ID = "162f2800-09b3-42b2-a462-850ad1a9a1e9";
const line = (n: number, text = `turn ${n}`) => JSON.stringify({ type: n % 2 ? "user" : "assistant", sessionId: ID, cwd: "/work/demo", uuid: `u${n}`, message: { content: text } }) + "\n";

let root: string;
let oldConfig: string | undefined;
let oldClaude: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "conch-retired-"));
  oldConfig = process.env.CONCH_CONFIG_DIR;
  oldClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CONCH_CONFIG_DIR = join(root, "conch");
  process.env.CLAUDE_CONFIG_DIR = join(root, "default");
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
});
afterEach(() => {
  if (oldConfig === undefined) delete process.env.CONCH_CONFIG_DIR; else process.env.CONCH_CONFIG_DIR = oldConfig;
  if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
  rmSync(root, { recursive: true, force: true });
});

function transcript(home: string, text: string, id = ID): string {
  const directory = join(home, "projects", "-work-demo");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${id}.jsonl`);
  writeFileSync(path, text);
  return path;
}

describe("one file brought across", () => {
  const files = () => ({ source: join(root, "a", `${ID}.jsonl`), destination: join(root, "b", "deep", `${ID}.jsonl`) });

  test("copied when Default lacks it, with the original's time, and the original untouched", async () => {
    const { source, destination } = files();
    mkdirSync(join(root, "a"));
    writeFileSync(source, line(1) + line(2));
    utimesSync(source, new Date("2026-10-20T10:00:00Z"), new Date("2026-10-20T10:00:00Z"));
    expect(await bringFileAcross(source, destination)).toBe("copied");
    expect(readFileSync(destination, "utf8")).toBe(line(1) + line(2));
    expect(statSync(destination).mtime.toISOString()).toBe("2026-10-20T10:00:00.000Z");
    expect(readFileSync(source, "utf8")).toBe(line(1) + line(2));
    // No temporary file left beside it.
    expect(readdirSync(join(root, "b", "deep"))).toEqual([`${ID}.jsonl`]);
    expect(await bringFileAcross(source, destination)).toBe("same");
  });

  test("extended when the original went on, kept when Default's went on, never overwritten when both did", async () => {
    const { source, destination } = files();
    mkdirSync(join(root, "a"));
    writeFileSync(source, line(1));
    await bringFileAcross(source, destination);
    appendFileSync(source, line(2) + line(3));
    expect(await bringFileAcross(source, destination)).toBe("extended");
    expect(readFileSync(destination, "utf8")).toBe(line(1) + line(2) + line(3));
    appendFileSync(destination, line(4));
    expect(await bringFileAcross(source, destination)).toBe("kept");
    expect(readFileSync(destination, "utf8")).toBe(line(1) + line(2) + line(3) + line(4));
    appendFileSync(source, line(5, "said only in the retired profile") + line(6));
    expect(await bringFileAcross(source, destination)).toBe("diverged");
    expect(readFileSync(destination, "utf8")).toBe(line(1) + line(2) + line(3) + line(4));
  });

  test("a transcript caught mid-line comes across to its last whole line, and the rest with the next look", async () => {
    const { source, destination } = files();
    mkdirSync(join(root, "a"));
    const half = line(2).slice(0, 20);
    writeFileSync(source, line(1) + half);
    expect(await bringFileAcross(source, destination)).toBe("copied");
    expect(readFileSync(destination, "utf8")).toBe(line(1));
    expect(await bringFileAcross(source, destination)).toBe("same");
    appendFileSync(source, line(2).slice(20));
    expect(await bringFileAcross(source, destination)).toBe("extended");
    expect(readFileSync(destination, "utf8")).toBe(line(1) + line(2));
  });
});

test("a conversation comes across with its folder, edit checkpoints and task list, and the retired folder keeps all of it", async () => {
  const blueprint: ClaudeAccount = { id: "bp", label: "Blueprint", configDir: join(root, "blueprint"), retired: true };
  const home: ClaudeAccount = { id: "default", label: "Default", configDir: join(root, "default") };
  const source = transcript(blueprint.configDir, line(1) + line(2));
  mkdirSync(join(blueprint.configDir, "projects", "-work-demo", ID, "subagents"), { recursive: true });
  writeFileSync(join(blueprint.configDir, "projects", "-work-demo", ID, "subagents", "agent-a1.jsonl"), line(1));
  mkdirSync(join(blueprint.configDir, "file-history", ID), { recursive: true });
  writeFileSync(join(blueprint.configDir, "file-history", ID, "abc@v1"), "before the edit");
  mkdirSync(join(blueprint.configDir, "tasks", ID), { recursive: true });
  writeFileSync(join(blueprint.configDir, "tasks", ID, "1.json"), "{}");

  expect(await bringConversationAcross("not-an-id", blueprint, home)).toBeUndefined();
  expect(await bringConversationAcross("00000000-0000-4000-8000-000000000000", blueprint, home)).toBeUndefined();
  const brought = await bringConversationAcross(ID, blueprint, home);
  expect(brought).toMatchObject({ transcript: "copied", files: 3 });
  expect(readFileSync(join(home.configDir, "projects", "-work-demo", `${ID}.jsonl`), "utf8")).toBe(line(1) + line(2));
  expect(readFileSync(join(home.configDir, "projects", "-work-demo", ID, "subagents", "agent-a1.jsonl"), "utf8")).toBe(line(1));
  expect(readFileSync(join(home.configDir, "file-history", ID, "abc@v1"), "utf8")).toBe("before the edit");
  expect(existsSync(join(home.configDir, "tasks", ID, "1.json"))).toBe(true);
  expect(readFileSync(source, "utf8")).toBe(line(1) + line(2));
  expect(await bringConversationAcross(ID, blueprint, home)).toMatchObject({ transcript: "same", files: 0 });
});

describe("a retired profile", () => {
  test("is kept, not offered, still resolves for its live sessions, and comes back when asked", () => {
    const blueprint = addClaudeAccount("Blueprint");
    mkdirSync(blueprint.configDir, { recursive: true });
    writeFileSync(join(blueprint.configDir, ".claude.json"), "{}");
    expect(() => retireClaudeAccount("default")).toThrow("cannot be retired");
    expect(() => retireClaudeAccount("nobody")).toThrow("not found");
    retireClaudeAccount(blueprint.id);
    expect(JSON.parse(readFileSync(accountStorePath(), "utf8"))).toEqual([{ ...blueprint, retired: true }]);
    expect(readClaudeAccounts().map((one) => [one.label, one.retired])).toEqual([["Default", undefined], ["Blueprint", true]]);
    expect(offeredClaudeAccounts(readClaudeAccounts()).map((one) => one.label)).toEqual(["Default"]);
    // Attach and stop for a session still running there name it as before.
    expect(requireClaudeAccount(blueprint.id).configDir).toBe(blueprint.configDir);
    expect(terminalSessionCommand({ backend: "claude", claudeAccountId: blueprint.id })).toContain(`CLAUDE_CONFIG_DIR='${blueprint.configDir}'`);
    // Another account added later keeps it retired.
    addClaudeAccount("Work");
    expect(readClaudeAccounts().find((one) => one.id === blueprint.id)?.retired).toBe(true);
    retireClaudeAccount(blueprint.id, false);
    expect(readClaudeAccounts().find((one) => one.id === blueprint.id)?.retired).toBeUndefined();
    expect(readFileSync(join(blueprint.configDir, ".claude.json"), "utf8")).toBe("{}");
  });

  test("a start, restart or fork that names it runs in Default, with the conversation brought across first", async () => {
    const blueprint = addClaudeAccount("Blueprint");
    retireClaudeAccount(blueprint.id);
    const accounts = readClaudeAccounts();
    transcript(blueprint.configDir, line(1) + line(2));

    const fresh = await launchOffRetiredProfiles({ backend: "claude", cwd: "/work/demo", claudeAccountId: blueprint.id }, accounts);
    expect(fresh).toEqual({ request: { backend: "claude", cwd: "/work/demo", claudeAccountId: "default" }, said: ['"Blueprint" is retired, so this runs in Default'] });

    const restart = await launchOffRetiredProfiles({ backend: "claude", cwd: "/work/demo", claudeAccountId: blueprint.id, resumeSessionId: ID, options: { "fork-session": true } }, accounts);
    expect(restart.request).toEqual({ backend: "claude", cwd: "/work/demo", claudeAccountId: "default", resumeSessionId: ID, options: { "fork-session": true } });
    expect(restart.said).toEqual(['"Blueprint" is retired, so this runs in Default', `brought conversation ${ID} across from the retired "Blueprint" profile to "Default"`]);
    expect(readFileSync(join(root, "default", "projects", "-work-demo", `${ID}.jsonl`), "utf8")).toBe(line(1) + line(2));
    expect(terminalSessionCommand(restart.request)).toContain(`CLAUDE_CONFIG_DIR='${join(root, "default")}' claude --resume '${ID}' --fork-session`);

    // Resumed from the list, where it shows as Default's: brought across when there's more, quiet when there isn't.
    expect((await launchOffRetiredProfiles({ backend: "claude", resumeSessionId: ID, claudeAccountId: "default" }, accounts)).said).toEqual([]);
    appendFileSync(join(blueprint.configDir, "projects", "-work-demo", `${ID}.jsonl`), line(3));
    expect((await launchOffRetiredProfiles({ backend: "claude", resumeSessionId: ID }, accounts)).said).toHaveLength(1);
    expect(readFileSync(join(root, "default", "projects", "-work-demo", `${ID}.jsonl`), "utf8")).toBe(line(1) + line(2) + line(3));
  });

  test("nothing changes for Codex, a handoff, a folder conch doesn't know, or when nothing is retired", async () => {
    const blueprint = addClaudeAccount("Blueprint");
    transcript(blueprint.configDir, line(1));
    const unretired = await launchOffRetiredProfiles({ backend: "claude", claudeAccountId: blueprint.id, resumeSessionId: ID }, readClaudeAccounts());
    expect(unretired).toEqual({ request: { backend: "claude", claudeAccountId: blueprint.id, resumeSessionId: ID }, said: [] });
    retireClaudeAccount(blueprint.id);
    const accounts = readClaudeAccounts();
    for (const request of [
      { backend: "codex" as const, resumeSessionId: ID },
      { backend: "claude" as const, resumeSessionId: ID, claudeConfigDir: join(root, "elsewhere") },
      { backend: "claude" as const, resumeSessionId: ID, claudeAccountId: "default", claudeSourceAccountId: blueprint.id, cwd: "/work/demo" },
    ]) expect(await launchOffRetiredProfiles(request, accounts)).toEqual({ request, said: [] });
    expect(existsSync(join(root, "default", "projects"))).toBe(false);
  });

  test("its conversations are listed once, as Default's, and an unscoped look finds the copy going on", () => {
    const blueprint = addClaudeAccount("Blueprint");
    const other = "33333333-3333-4333-8333-333333333333";
    const original = transcript(blueprint.configDir, line(1));
    transcript(blueprint.configDir, JSON.stringify({ type: "user", sessionId: other, cwd: "/work/demo", message: { content: "only there" } }) + "\n", other);
    const copy = transcript(join(root, "default"), line(1));
    // Registered and offered, the same id in two profiles is ambiguous, as it always was.
    expect(findAccountTranscript(join(root, "default"), ID)).toBeUndefined();
    retireClaudeAccount(blueprint.id);
    const listed = accountResumableSessions({ configDir: join(root, "conch"), codexHome: "" }, readClaudeAccounts()).sessions;
    expect(listed.map((one) => [one.sessionId, one.claudeAccountId, one.accountLabel]).sort()).toEqual([
      [ID, "default", "Default"],
      [other, "default", "Default"],
    ]);
    utimesSync(original, new Date(1_000_000), new Date(1_000_000));
    expect(findAccountTranscript(join(root, "default"), ID)).toBe(copy);
    // A session still running in the retired profile writes its copy last.
    utimesSync(original, new Date(), new Date(Date.now() + 60_000));
    expect(findAccountTranscript(join(root, "default"), ID)).toBe(original);
    expect(findAccountTranscript(join(root, "default"), other)).toBe(join(blueprint.configDir, "projects", "-work-demo", `${other}.jsonl`));
  });
});

describe("which profile a resume starts in, with one retired", () => {
  const DEFAULT: ClaudeAccount = { id: "default", label: "Default", configDir: "/Users/alex/.claude" };
  const BLUEPRINT: ClaudeAccount = { id: "39b4dccc", label: "Blueprint", configDir: "/Users/alex/.config/conch/claude/39b4dccc", retired: true };
  const lookup = (held: Record<string, number>, callerConfigDir?: string): ResumeLookup => ({
    accounts: [DEFAULT, BLUEPRINT],
    ...(callerConfigDir ? { callerConfigDir } : {}),
    heldAt: (dir, id) => (id === ID ? held[dir] : undefined),
    canonical: (path) => path,
  });

  test("its conversation resumes in Default, which brings it across, for an agent of its own too", () => {
    const resolved = resumeAccountFor({ backend: "claude", resumeSessionId: ID }, lookup({ [BLUEPRINT.configDir]: 5 }, BLUEPRINT.configDir));
    expect(resolved).toEqual({
      ok: true,
      request: { backend: "claude", resumeSessionId: ID, claudeAccountId: "default" },
      said: `resuming in the "Default" account profile, bringing conversation ${ID} across from the retired "Blueprint" profile`,
    });
    const both = resumeAccountFor({ backend: "claude", resumeSessionId: ID }, lookup({ [DEFAULT.configDir]: 3, [BLUEPRINT.configDir]: 5 }, BLUEPRINT.configDir));
    expect(both).toEqual({ ok: true, request: { backend: "claude", resumeSessionId: ID, claudeAccountId: "default" }, said: `resuming in the "Default" account profile, which has conversation ${ID}` });
  });

  test("--account naming it, or naming Default for a conversation only it has, runs in Default", () => {
    for (const claudeAccountId of [BLUEPRINT.id, "default"]) {
      expect(resumeAccountFor({ backend: "claude", resumeSessionId: ID, claudeAccountId }, lookup({ [BLUEPRINT.configDir]: 5 }))).toEqual({
        ok: true,
        request: { backend: "claude", resumeSessionId: ID, claudeAccountId: "default" },
        said: `resuming in the "Default" account profile, bringing conversation ${ID} across from the retired "Blueprint" profile`,
      });
    }
    expect(resumeAccountFor({ backend: "claude", resumeSessionId: ID, claudeAccountId: "default" }, lookup({ [DEFAULT.configDir]: 5 })))
      .toEqual({ ok: true, request: { backend: "claude", resumeSessionId: ID, claudeAccountId: "default" } });
  });
});
