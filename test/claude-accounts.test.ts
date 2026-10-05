import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClaudeAccount, accountStorePath, claudeAccountEnvironment, decodeClaudeAuth, readClaudeAccounts, removeClaudeAccount } from "../src/claude-accounts.ts";
import { accountRegistrySnapshot, accountResumableSessions, assertClaudeAccountIdle, findAccountTranscript, sessionTranscript } from "../src/claude-account-sessions.ts";
import { attachTerminalCommand, closeSession, restartRequest, startClaudeAccountLogin, startRequestFromArgv, terminalSessionCommand } from "../src/session-lifecycle.ts";
import { validateControlResponse, validateRuntimeControlMessage } from "../src/settings.ts";

let root: string;
let oldConfig: string | undefined;
let oldClaude: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "conch-accounts-"));
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

function history(home: string, id: string, text: string) {
  const directory = join(home, "projects", "-work-demo");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "user", cwd: "/work/demo", sessionId: id, message: { role: "user", content: text } }) + "\n");
  return path;
}
function registry(home: string, id: string, pid = 42) {
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "sessions", `${pid}.json`), JSON.stringify({ sessionId: id, pid, cwd: "/work/demo", kind: "interactive", entrypoint: "cli", status: "idle" }));
}

test("profiles persist only metadata, reject duplicates, and removal preserves Claude files", () => {
  const account = addClaudeAccount("Work");
  expect(readClaudeAccounts().map((a) => a.label)).toEqual(["Default", "Work"]);
  expect(statSync(accountStorePath()).mode & 0o777).toBe(0o600);
  expect(Object.keys(JSON.parse(readFileSync(accountStorePath(), "utf8"))[0]).sort()).toEqual(["configDir", "id", "label"]);
  expect(() => addClaudeAccount("work")).toThrow("different account name");
  mkdirSync(account.configDir, { recursive: true });
  const credential = join(account.configDir, ".credentials.json");
  writeFileSync(credential, "do not copy or remove");
  const link = join(root, "linked");
  symlinkSync(account.configDir, link);
  expect(() => addClaudeAccount("Duplicate", link)).toThrow("already registered");
  expect(() => removeClaudeAccount("default")).toThrow("cannot be removed");
  removeClaudeAccount(account.id);
  expect(readFileSync(credential, "utf8")).toBe("do not copy or remove");
  expect(readClaudeAccounts()).toHaveLength(1);
  expect(() => terminalSessionCommand({ backend: "claude", claudeAccountId: account.id })).toThrow("removed");
});

test("new, resume, attach, stop and restart retain the chosen profile, with quoted terminal arguments", async () => {
  const account = addClaudeAccount("Work", join(root, "work's account"));
  const start = { backend: "claude" as const, cwd: "/work/demo", claudeAccountId: account.id };
  const command = terminalSessionCommand(start);
  expect(command).toContain("-u ANTHROPIC_API_KEY");
  expect(command).toContain("-u CLAUDE_CODE_OAUTH_TOKEN");
  expect(command).toContain("work'\\''s account'");
  expect(command).not.toContain("HOME=");
  expect(terminalSessionCommand({ ...start, resumeSessionId: "abc" })).toBe(command + " --resume 'abc'");
  expect(startRequestFromArgv(["claude", "--account", account.id]).claudeAccountId).toBe(account.id);
  expect(restartRequest({ ...start, sessionId: "abc" }, []).request.claudeAccountId).toBe(account.id);
  expect(attachTerminalCommand("bg-123", "/work/demo", account.id)).toContain("CLAUDE_CONFIG_DIR=");
  let argv: string[] = [];
  await closeSession({ backend: "claude", pid: 0, jobId: "bg-123", claudeAccountId: account.id }, {
    which: () => "/bin/claude", spawn: (args) => { argv = args; return { exited: Promise.resolve(0), cancel() {} }; },
  });
  expect(argv).toContain(`CLAUDE_CONFIG_DIR=${account.configDir}`);
  expect(argv.slice(-3)).toEqual(["/bin/claude", "stop", "bg-123"]);
  expect(terminalSessionCommand({ backend: "claude", cwd: "/work/demo" })).toBe("cd -- '/work/demo' && exec claude");
  expect(terminalSessionCommand({ backend: "claude", claudeAccountId: "default" })).not.toContain("-u ANTHROPIC_API_KEY");
});

test("sign-in opens the official CLI in its isolated profile without reading credentials", async () => {
  const account = addClaudeAccount("Work");
  let command = "";
  await startClaudeAccountLogin(account, {
    which: () => "/bin/claude", isDirectory: () => true,
    spawn: (args) => { command = args.at(-1)!; return { exited: Promise.resolve(0), cancel() {} }; },
  });
  expect(command).toContain(`CLAUDE_CONFIG_DIR='${account.configDir}' claude auth login`);
  expect(command).not.toContain("credentials");
  expect(existsSync(account.configDir)).toBe(false);
});

test("status drops tokens and inherited API credentials, without changing the parent environment", () => {
  const account = addClaudeAccount("Work");
  const status = decodeClaudeAuth(account, JSON.stringify({ loggedIn: true, email: "person@example.com", subscriptionType: "max", accessToken: "secret", refreshToken: "secret" }));
  expect(status).toEqual({ ...account, status: "signed-in", email: "person@example.com", subscription: "max" });
  expect(decodeClaudeAuth(account, "bad json").status).toBe("unavailable");
  expect(decodeClaudeAuth(account, '{"loggedIn":false}').status).toBe("signed-out");
  const oldKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-only";
  try {
    expect(claudeAccountEnvironment(account.configDir).ANTHROPIC_API_KEY).toBeUndefined();
    expect(claudeAccountEnvironment(account.configDir, false).ANTHROPIC_API_KEY).toBe("test-only");
    expect(process.env.ANTHROPIC_API_KEY).toBe("test-only");
  } finally {
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey;
  }
});

test("live and resumable sessions keep account identity and ambiguous transcripts never fall through", async () => {
  const work = addClaudeAccount("Work");
  const accounts = readClaudeAccounts();
  const home = accounts[0]!.configDir;
  const id = "11111111-1111-4111-8111-111111111111";
  history(home, id, "Personal task");
  const workPath = history(work.configDir, id, "Work task");
  registry(home, id, 41);
  registry(work.configDir, id, 42);
  const live = await accountRegistrySnapshot(home);
  const claude = live!.infos.filter((s) => s.backend !== "codex");
  expect(claude).toHaveLength(2);
  expect(new Set(claude.map((s) => s.sessionId)).size).toBe(2);
  expect(claude.find((s) => s.claudeAccountId === work.id)?.transcriptPath).toBe(workPath);
  expect(findAccountTranscript(home, id)).toBeUndefined();
  const historyRows = accountResumableSessions({ configDir: join(root, "conch"), codexHome: "" }, accounts).sessions;
  expect(historyRows).toHaveLength(2);
  expect(new Set(historyRows.map((s) => s.claudeAccountId))).toEqual(new Set(["default", work.id]));
  await expect(assertClaudeAccountIdle(work)).rejects.toThrow("live sessions");
  rmSync(join(work.configDir, "sessions"), { recursive: true });
  await expect(assertClaudeAccountIdle(work)).resolves.toBeUndefined();
  mkdirSync(join(work.configDir, "sessions"));
  writeFileSync(join(work.configDir, "sessions", "broken.json"), "{");
  await expect(assertClaudeAccountIdle(work)).rejects.toThrow("Could not check");
});

// 2026-10-05: the first message to a new session on a second account. Its row named the account's own folder, and
// the daemon handed that folder to the account-aware lookup as the DEFAULT one, which read the account list, found
// the folder twice, and threw after the words were typed. Tyler: "part of my message sent somehow and i had to go
// to the terminal and send the full one".
test("a session's transcript is looked for in its own account's folder, and the look never throws", () => {
  const work = addClaudeAccount("Work");
  const home = readClaudeAccounts()[0]!.configDir;
  const id = "22222222-2222-4222-8222-222222222222";
  // The cause, kept on record: an account's folder is not a default one.
  expect(() => findAccountTranscript(work.configDir, id)).toThrow("Account profiles must have separate directories");
  // A new session has written nothing yet: not found, and no throw.
  expect(sessionTranscript(home, id, { claudeConfigDir: work.configDir })).toBeUndefined();
  const workPath = history(work.configDir, id, "Work task");
  expect(sessionTranscript(home, id, { claudeConfigDir: work.configDir })).toBe(workPath);
  // Only that account's folder: the same id under another account is not this session's.
  const homePath = history(home, id, "Personal task");
  expect(sessionTranscript(home, id, { claudeConfigDir: home })).toBe(homePath);
  expect(sessionTranscript(home, id, { claudeConfigDir: work.configDir })).toBe(workPath);
  // A path the row already knows wins; a row with no account searches every one, ambiguity refused as before.
  expect(sessionTranscript(home, id, { transcriptPath: "/known/path.jsonl", claudeConfigDir: work.configDir })).toBe("/known/path.jsonl");
  expect(sessionTranscript(home, id)).toBeUndefined();
});

test("wire validation rejects unsafe paths, invalid ids, and accounts on Codex", () => {
  expect(validateRuntimeControlMessage({ kind: "claude-accounts", action: "add", label: "Work", configDir: "relative" }).ok).toBe(false);
  expect(validateRuntimeControlMessage({ kind: "claude-accounts", action: "remove", id: "../../secret" }).ok).toBe(false);
  expect(validateRuntimeControlMessage({ kind: "session-start", backend: "codex", claudeAccountId: "default" }).ok).toBe(false);
  expect(validateRuntimeControlMessage({ kind: "session-start", backend: "claude", claudeAccountId: "default" })).toMatchObject({ ok: true, value: { claudeAccountId: "default" } });
  const parsed = validateControlResponse({ kind: "claude-accounts", accounts: [{ ...readClaudeAccounts()[0], status: "unchecked", token: "never return this" }] });
  expect(parsed.ok).toBe(true);
  expect(JSON.stringify(parsed)).not.toContain("never return this");
});


test("an unset default config stays unset so the existing Keychain login is retained", () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  const command = terminalSessionCommand({ backend: "claude", claudeAccountId: "default", cwd: "/work/demo" });
  expect(command).toBe("cd -- '/work/demo' && exec env -u CLAUDE_CONFIG_DIR claude");
});
