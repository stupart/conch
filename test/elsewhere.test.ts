import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountRegistrySnapshot } from "../src/claude-account-sessions.ts";
import { addClaudeAccount, readClaudeAccounts } from "../src/claude-accounts.ts";
import { claudeSwapRuns } from "../src/claude-swap-runs.ts";
import {
  claudeHeadless, claudeNamedConversation, codexSubcommand, configDirFromEnvironment, coveredPids, decodeElsewhereRequest,
  ElsewhereWatch, findElsewhere, hostOf, profileName, type ElsewhereProbes,
} from "../src/elsewhere.ts";
import { isMacAppOnlyRequest } from "../src/phone-bridge.ts";
import { parseProcessRows, type ProcessRow } from "../src/process-table.ts";
import { restartRequest } from "../src/session-lifecycle.ts";

// 2026-11-12, Tyler: "what's the status of some agents missing from conch and how do we attach them? is there a way to
// see ones that are active but not in conch and then move them in?" A `cswap run 3 -- claude --continue` session ran
// in conch's own tmux as no row at all, its registry in claude-swap's folder.

let root: string;
let oldConfig: string | undefined;
let oldClaude: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "conch-elsewhere-"));
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

const ID = "5f1c2a7e-3b9d-4c60-9e21-7a8b4d6c0f13";

function registry(dir: string, pid: number, fields: Record<string, unknown> = {}) {
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: ID, cwd: "/work/harbor", kind: "interactive", entrypoint: "cli", ...fields }));
}

function swapRun(home: string, number: number, account = "someone_example.com"): string {
  const dir = join(home, ".claude-swap-backup", "sessions", `${number}-${account}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("claude-swap's run folders are read while a session in one lives, named by number or alias, never by email", () => {
  const home = join(root, "home");
  const live = swapRun(home, 3);
  registry(live, process.pid);
  const ended = swapRun(home, 2, "other_example.org");
  registry(ended, 999_999_991);
  mkdirSync(join(home, ".claude-swap-backup", "sessions", "not-a-run"), { recursive: true });
  const runs = claudeSwapRuns(home, (pid) => pid === process.pid);
  expect(runs).toEqual([{ number: 3, label: "claude-swap 3", configDir: live }]);
  writeFileSync(join(home, ".claude-swap-backup", "sequence.json"), JSON.stringify({ accounts: { "3": { email: "someone@example.com", alias: "studio" } } }));
  expect(claudeSwapRuns(home, (pid) => pid === process.pid)[0]?.label).toBe("studio");
  // An alias that is an email is no name for a row.
  writeFileSync(join(home, ".claude-swap-backup", "sequence.json"), JSON.stringify({ accounts: { "3": { alias: "someone@example.com" } } }));
  expect(claudeSwapRuns(home, (pid) => pid === process.pid)[0]?.label).toBe("claude-swap 3");
  expect(claudeSwapRuns(join(root, "nobody"))).toEqual([]);
});

test("a claude-swap run's live session is a row with its folder and account label, and no conch account", async () => {
  const home = readClaudeAccounts()[0]!.configDir;
  const run = swapRun(join(root, "home"), 3);
  registry(run, process.pid);
  registry(run, 999_999_992, { sessionId: "99999999-9999-4999-8999-999999999999" });
  mkdirSync(join(run, "projects", "-work-harbor"), { recursive: true });
  const transcript = join(run, "projects", "-work-harbor", `${ID}.jsonl`);
  writeFileSync(transcript, JSON.stringify({ type: "user", sessionId: ID, message: { role: "user", content: "hi" } }) + "\n");
  const runs = [{ number: 3, label: "claude-swap 3", configDir: run }];
  const snapshot = await accountRegistrySnapshot(home, readClaudeAccounts(), undefined, undefined, runs);
  const rows = snapshot!.infos.filter((info) => info.backend !== "codex");
  // The dead entry beside it is debris nobody prunes, never a row.
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ sessionId: ID, pid: process.pid, accountLabel: "claude-swap 3", claudeConfigDir: run, transcriptPath: transcript });
  expect(rows[0]!.claudeAccountId).toBeUndefined();
  expect(snapshot!.liveIds.has(ID)).toBe(true);
  // A run folder already registered as an account is read once, as the account.
  const account = addClaudeAccount("Studio", run);
  const again = await accountRegistrySnapshot(home, readClaudeAccounts(), undefined, undefined, runs);
  expect(again!.infos.filter((info) => info.sessionId === ID)).toHaveLength(1);
  expect(again!.infos.find((info) => info.sessionId === ID)?.claudeAccountId).toBe(account.id);
});

test("a run's restart and fork come back in its folder; a profile's by its account, as before", () => {
  const run = restartRequest({ sessionId: ID, backend: "claude", cwd: "/work", claudeConfigDir: "/runs/3-x" }, []);
  expect(run.request.claudeConfigDir).toBe("/runs/3-x");
  expect(run.request.claudeAccountId).toBeUndefined();
  const profile = restartRequest({ sessionId: ID, backend: "claude", cwd: "/work", claudeAccountId: "work", claudeConfigDir: "/profiles/work" }, []);
  expect(profile.request).toMatchObject({ claudeAccountId: "work" });
  expect(profile.request.claudeConfigDir).toBeUndefined();
});

// A process table shaped like Tyler's Mac on 2026-11-12: conch's tmux, Terminal, iTerm and the ChatGPT app.
const ME = 501;
function table(extra: string[] = []): ProcessRow[] {
  return parseProcessRows([
    "    1     0     0 ??       Ss   /sbin/launchd",
    "  700     1   501 ??       S    /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    "  701   700     0 ttys017  Ss   login",
    "  702   701   501 ttys017  S    -zsh",
    "  724     1   501 ??       S    /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    " 2192   724   501 ??       S    /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "53165   724   501 ??       S    /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    " 1039     1   501 ??       Ss   /Applications/conch.app/Contents/Helpers/tmux",
    " 1040  1039   501 ttys001  Ss+  claude",
    " 4927  1039   501 ttys015  Ss+  /opt/homebrew/bin/claude",
    " 5520  4927   501 ??       Ss   /bin/zsh",
    " 5535  5520   501 ??       S    codex",
    "  800     1   501 ??       S    /Applications/iTerm.app/Contents/MacOS/iTerm2",
    "  801   800   501 ttys020  Ss   /bin/zsh",
    "  802   801   501 ttys020  S+   claude",
    "  900     1   502 ttys030  S+   claude",
    ...extra,
  ].join("\n"));
}

function probes(facts: { args?: Record<number, string>; dirs?: Record<number, string>; cwds?: Record<number, string>; registries?: Record<string, Record<string, unknown>> }): ElsewhereProbes & { asked: string[] } {
  const asked: string[] = [];
  const pick = (map: Record<number, string> | undefined, pids: number[]) => new Map(pids.flatMap((pid) => map?.[pid] ? [[pid, map[pid]!] as const] : []));
  return {
    asked,
    args: async (pids) => { asked.push(`args ${pids.join(",")}`); return pick(facts.args, pids); },
    configDirs: async (pids) => { asked.push(`env ${pids.join(",")}`); return pick(facts.dirs, pids); },
    cwds: async (pids) => { asked.push(`cwd ${pids.join(",")}`); return pick(facts.cwds, pids); },
    registry: (dir, pid) => facts.registries?.[`${dir}#${pid}`],
  };
}

test("process rows keep an executable's whole path, spaces and all", () => {
  const [row] = parseProcessRows("  7   1   501 ??   S    /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n");
  expect(row).toEqual({ pid: 7, ppid: 1, uid: 501, tty: "??", stat: "S", comm: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron" });
});

test("an agent's terminal is the app above it", () => {
  const rows = table();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  expect(hostOf(4927, byPid)).toBe("tmux");
  expect(hostOf(802, byPid)).toBe("iterm");
  expect(hostOf(702, byPid)).toBe("terminal");
  expect(hostOf(2192, byPid)).toBe("chatgpt");
  expect(hostOf(1, byPid)).toBe("none");
});

test("a claude in a profile conch doesn't read: added as an account where conch can type, resumed where it can't", async () => {
  const facts = probes({
    args: { 4927: "/opt/homebrew/bin/claude --continue --model fable", 802: "claude" },
    dirs: { 4927: "/Users/me/.claude-swap-backup/sessions/3-me_example.com", 802: "/Users/me/.claude-work" },
    registries: {
      [`/Users/me/.claude-swap-backup/sessions/3-me_example.com#4927`]: { sessionId: ID, cwd: "/work/harbor", name: "harbor-12", kind: "interactive", entrypoint: "cli", startedAt: 5 },
      [`/Users/me/.claude-work#802`]: { sessionId: "11111111-1111-4111-8111-111111111111", cwd: "/work/site", kind: "interactive" },
    },
  });
  // 1040 is a row; the ChatGPT app's app-server hosts one too.
  const found = await findElsewhere({ rows: table(), uid: ME, covered: new Set([1040, 2192]), roots: [], probes: facts, home: "/Users/me" });
  expect(found.map((one) => one.agent)).toEqual([
    { id: "claude:4927", backend: "claude", pid: 4927, host: "tmux", reason: "profile", remedy: "add-account", label: "harbor-12", cwd: "/work/harbor",
      account: "~/.claude-swap-backup/sessions", conversationId: ID, startedAt: 5 },
    { id: "claude:802", backend: "claude", pid: 802, host: "iterm", reason: "profile", remedy: "resume", cwd: "/work/site",
      account: "~/.claude-work", conversationId: "11111111-1111-4111-8111-111111111111" },
  ]);
  // The folder an action needs stays with the daemon; the apps get the account's short name, with no email in it.
  expect(found[0]!.configDir).toBe("/Users/me/.claude-swap-backup/sessions/3-me_example.com");
  expect(JSON.stringify(found.map((one) => one.agent))).not.toContain("example.com");
  // Only what had no answer was asked about, once each; another user's claude (900) never.
  expect(facts.asked).toEqual(["args 4927,802", "env 4927,802"]);
});

test("headless runs, an agent's own children and another user's processes are no one's to show", async () => {
  const rows = table([
    " 950   702   501 ttys017  S+   claude",
    " 960   702   501 ttys017  S+   codex",
    " 961   702   501 ttys017  S+   codex",
  ]);
  const facts = probes({
    args: { 4927: "claude", 950: "claude -p summarise this", 960: "codex exec --skip-git-repo-check fix it", 961: "codex -m gpt-6 review" },
    dirs: { 4927: "/w" },
    registries: { "/w#4927": { sessionId: ID, kind: "interactive", entrypoint: "sdk-cli" } },
  });
  const found = await findElsewhere({ rows, uid: ME, covered: new Set([1040, 2192, 802]), roots: [], probes: facts, home: "/Users/me" });
  // 5535 (`codex exec` under 4927's Bash) has no terminal and an agent above it; 950–961 are runs; 4927's registry says
  // it is an SDK run; 900 isn't this user's.
  expect(found).toEqual([]);
});

test("a claude whose registry conch already reads is that folder's to show", async () => {
  const dir = join(root, "default");
  registry(dir, 4927);
  registry(dir, 802);
  const facts = probes({});
  const found = await findElsewhere({ rows: table(), uid: ME, covered: new Set([1040, 2192]), roots: [dir], probes: facts, home: "/Users/me" });
  expect(found).toEqual([]);
  expect(facts.asked).toEqual([]);
});

test("the ChatGPT app is one entry while no thread it hosts is a row", async () => {
  const facts = probes({});
  const found = await findElsewhere({ rows: table(), uid: ME, covered: new Set([1040, 4927, 802]), roots: [], probes: facts, home: "/Users/me" });
  expect(found.map((one) => one.agent)).toEqual([{ id: "codex:724", backend: "codex", pid: 2192, host: "chatgpt", reason: "app", remedy: "start-sheet" }]);
  const hosted = coveredPids([{ pid: 0, noTerminal: "hosted by codex app-server (pid 2192), which has no terminal to type into" }]);
  expect(await findElsewhere({ rows: table(), uid: ME, covered: new Set([...hosted, 1040, 4927, 802]), roots: [], probes: facts, home: "/Users/me" })).toEqual([]);
});

test("with no registry anywhere, a conversation the command line names is resumable; otherwise conch says so", async () => {
  const rows = table([" 970   702   501 ttys017  S+   codex", " 971   702   501 ttys017  S+   codex"]);
  const facts = probes({
    args: { 4927: `claude --resume ${ID}`, 802: "claude", 970: "codex resume 22222222-2222-4222-8222-222222222222", 971: "codex --full-auto" },
    cwds: { 4927: "/work/a", 802: "/work/b", 970: "/work/c", 971: "/work/d" },
  });
  const found = await findElsewhere({ rows, uid: ME, covered: new Set([1040, 2192]), roots: [], probes: facts, home: "/Users/me" });
  expect(found.map(({ agent }) => [agent.id, agent.reason, agent.remedy, agent.conversationId, agent.cwd])).toEqual([
    ["claude:4927", "no-registry", "resume", ID, "/work/a"],
    ["claude:802", "no-registry", "none", undefined, "/work/b"],
    ["codex:970", "codex-thread", "resume", "22222222-2222-4222-8222-222222222222", "/work/c"],
    ["codex:971", "codex-thread", "start-sheet", undefined, "/work/d"],
  ]);
});

test("command lines and environments are read for the one thing each is asked", () => {
  expect(claudeHeadless("claude -p hi")).toBe(true);
  expect(claudeHeadless("claude --print")).toBe(true);
  expect(claudeHeadless("claude --permission-mode plan fix the -parser")).toBe(false);
  expect(claudeNamedConversation(`claude --model x -r ${ID.toUpperCase()}`)).toBe(ID);
  expect(claudeNamedConversation(`claude --session-id=${ID}`)).toBe(ID);
  expect(claudeNamedConversation("claude --resume")).toBeUndefined();
  expect(codexSubcommand("codex -c model=x -m gpt exec do it")).toBe("exec");
  expect(codexSubcommand("codex --full-auto")).toBeUndefined();
  // The environment follows the arguments, which may quote the variable themselves.
  expect(configDirFromEnvironment("claude say CLAUDE_CONFIG_DIR=/fake PATH=/bin CLAUDE_CONFIG_DIR=/real/one HOME=/h")).toBe("/real/one");
  expect(configDirFromEnvironment("claude PATH=/bin")).toBeUndefined();
});

test("a profile is named by its account, else by its folder with any email dropped", () => {
  expect(profileName("/Users/me/.claude-work", "/Users/me")).toBe("~/.claude-work");
  expect(profileName("/Users/me/.claude-swap-backup/sessions/3-me_example.com", "/Users/me")).toBe("~/.claude-swap-backup/sessions");
  expect(profileName("/opt/a@b.c/claude", "/Users/me")).toBe("/opt/claude");
  expect(profileName("/Users/me/p", "/Users/me", new Map([["/Users/me/p", "Work"]]))).toBe("Work");
});

test("the watch looks at most every ten seconds, lists an agent once it has stayed outside a while, and publishes no folder", async () => {
  let now = 100_000;
  let changes = 0;
  let looks = 0;
  const facts = probes({ args: { 802: "claude" }, dirs: { 802: "/Users/me/.claude-work" },
    registries: { "/Users/me/.claude-work#802": { sessionId: ID, cwd: "/work/site", kind: "interactive" } } });
  const watch = new ElsewhereWatch({ onChange: () => { changes += 1; }, now: () => now, probes: facts, uid: ME,
    table: async () => { looks += 1; return table(); } });
  const covered = [{ pid: 1040 }, { pid: 4927 }, { pid: 0, noTerminal: "hosted by codex app-server (pid 2192), which has no terminal to type into" }];
  watch.observe(covered, [], new Map());
  await Bun.sleep(10);
  // Found, but not yet said: a session just started is found before its registry entry is written.
  expect(watch.published()).toEqual([]);
  expect(changes).toBe(0);
  now += 5_000;
  watch.observe(covered, [], new Map());
  await Bun.sleep(10);
  expect(looks).toBe(1);
  now += 10_000;
  watch.observe(covered, [], new Map());
  await Bun.sleep(10);
  expect(looks).toBe(2);
  expect(watch.published().map((agent) => agent.id)).toEqual(["claude:802"]);
  expect(changes).toBe(1);
  expect(Object.keys(watch.published()[0]!)).not.toContain("configDir");
  expect(watch.find("claude:802")?.configDir).toBe("/Users/me/.claude-work");
  // Once a row carries it, it goes.
  now += 10_000;
  watch.observe([...covered, { pid: 802 }], [], new Map());
  await Bun.sleep(10);
  expect(watch.published()).toEqual([]);
  expect(changes).toBe(2);
});

test("Not in conch's actions name a published agent, and are the Mac app's alone", () => {
  expect(decodeElsewhereRequest({ kind: "elsewhere", action: "resume", id: "claude:4927", host: "background" }))
    .toEqual({ kind: "elsewhere", action: "resume", id: "claude:4927", host: "background" });
  expect(decodeElsewhereRequest({ kind: "elsewhere", action: "resume", id: "/Users/me/.claude" })).toHaveProperty("error");
  expect(decodeElsewhereRequest({ kind: "elsewhere", action: "kill", id: "claude:1" })).toHaveProperty("error");
  expect(decodeElsewhereRequest({ kind: "session-start" })).toBeNull();
  expect(isMacAppOnlyRequest({ kind: "elsewhere", action: "resume", id: "claude:4927" })).toBe(true);
  expect(isMacAppOnlyRequest({ kind: "sidebar-groups", layout: { v: 1, groups: [], placements: {}, rows: {}, sections: [] } })).toBe(true);
});

test("Resume opens the conversation in the profile it was found in; Add names the folder, never an email", async () => {
  const { elsewhereAccountLabel, elsewhereResumeRequest } = await import("../src/elsewhere.ts");
  const agent = { id: "claude:4927", backend: "claude" as const, pid: 4927, host: "iterm" as const, reason: "profile" as const,
    remedy: "resume" as const, cwd: "/work/harbor", conversationId: ID };
  const context = { accounts: [{ id: "default", label: "Default", configDir: "/Users/me/.claude" }, { id: "work", label: "Work", configDir: "/Users/me/.claude-work" }],
    runs: [{ configDir: "/Users/me/.claude-swap-backup/sessions/3-me_example.com" }], defaultDir: "/Users/me/.claude" };
  // A conch account by its id.
  expect(elsewhereResumeRequest({ agent, configDir: "/Users/me/.claude-work" }, context, { host: "background", bypassPermissions: false }))
    .toEqual({ backend: "claude", resumeSessionId: ID, host: "background", cwd: "/work/harbor", bypassPermissions: false, claudeAccountId: "work" });
  // claude-swap's run folder, or one conch doesn't read, by the folder; Default by nothing.
  expect(elsewhereResumeRequest({ agent, configDir: "/Users/me/.claude-swap-backup/sessions/3-me_example.com" }, context)?.claudeConfigDir)
    .toBe("/Users/me/.claude-swap-backup/sessions/3-me_example.com");
  expect(elsewhereResumeRequest({ agent, configDir: "/Users/me/.other" }, context)?.claudeConfigDir).toBe("/Users/me/.other");
  const plain = elsewhereResumeRequest({ agent }, context)!;
  expect(plain.claudeAccountId).toBeUndefined();
  expect(plain.claudeConfigDir).toBeUndefined();
  expect(elsewhereResumeRequest({ agent: { ...agent, conversationId: undefined } }, context)).toBeUndefined();
  // Codex resumes its thread, by the thread id its command line named.
  expect(elsewhereResumeRequest({ agent: { ...agent, backend: "codex", id: "codex:9" } }, context)).toEqual({ backend: "codex", resumeSessionId: ID, cwd: "/work/harbor" });

  expect(elsewhereAccountLabel({ agent, configDir: "/Users/me/.claude-studio" }, context, "/Users/me")).toBe("claude-studio");
  expect(elsewhereAccountLabel({ agent, configDir: "/Users/me/work" }, { ...context, accounts: [...context.accounts, { id: "x", label: "work", configDir: "/x" }] }, "/Users/me")).toBe("work 2");
  expect(elsewhereAccountLabel({ agent, configDir: "/Users/me/p/3-me_example.com" }, context, "/Users/me")).toBe("p");
  expect(elsewhereAccountLabel({ agent: { ...agent, reason: "no-registry" } }, context, "/Users/me")).toBeUndefined();
});
