import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCodexAccount, readCodexAccounts, removeCodexAccount, codexAccountEnvironment, codexAccountStorePath, decodeCodexAccount, decodeCodexUsage, readCodexAccount } from "../src/codex-accounts.ts";
import { accountRegistrySnapshot, accountResumableSessions, assertCodexAccountIdle } from "../src/claude-account-sessions.ts";
import { readCodexSessions, writeCodexSession } from "../src/codex-sessions.ts";
import { restartRequest, startCodexAccountTerminal, startRequestFromArgv, terminalSessionCommand } from "../src/session-lifecycle.ts";
import { validateControlResponse, validateRuntimeControlMessage } from "../src/settings.ts";
import { deviceExecutionCatalog, sessionExecution } from "../src/execution-model.ts";
import { recordsRoots } from "../src/records-discovery.ts";
let root: string;
let old: NodeJS.ProcessEnv;
beforeEach(() => {
  old = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "conch-codex-accounts-"));
  process.env.CONCH_CONFIG_DIR = join(root, "conch");
  process.env.CODEX_HOME = join(root, "default");
});
afterEach(() => {
  for (const key of ["CONCH_CONFIG_DIR", "CODEX_HOME", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"]) {
    if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
  }
  rmSync(root, { recursive: true, force: true });
});

test("Codex metadata and terminal launch keep credentials, resume and restart in the chosen home", async () => {
  const account = addCodexAccount("Work", join(root, "work's codex"));
  expect(readCodexAccounts().map(a => a.label)).toEqual(["Default", "Work"]);
  expect(Object.keys(JSON.parse(readFileSync(codexAccountStorePath(), "utf8"))[0]).sort()).toEqual(["configDir", "id", "label"]);
  process.env.OPENAI_API_KEY = "fixture-key";
  process.env.CODEX_ACCESS_TOKEN = "fixture-token";
  const env = codexAccountEnvironment(account);
  expect(env.CODEX_HOME).toBe(account.configDir);
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
  expect(process.env.OPENAI_API_KEY).toBe("fixture-key");
  const request = { backend: "codex" as const, codexAccountId: account.id, cwd: "/work/demo" };
  const command = terminalSessionCommand(request);
  expect(command).toContain("-u OPENAI_API_KEY");
  expect(command).toContain("work'\\''s codex'");
  expect(command).not.toContain("CLAUDE_CONFIG_DIR");
  expect(terminalSessionCommand({ ...request, resumeSessionId: "abc" })).toContain("codex resume 'abc'");
  expect(startRequestFromArgv(["codex", "--account", account.id]).codexAccountId).toBe(account.id);
  expect(restartRequest({ ...request, sessionId: "abc" }, []).request.codexAccountId).toBe(account.id);
  for (const action of ["login", "cloud"] as const) {
    let script = "";
    await startCodexAccountTerminal(account, action, { which: () => "/bin/codex", isDirectory: () => true,
      spawn: args => { script = args.at(-1)!; return { exited: Promise.resolve(0), cancel() {} }; } });
    expect(script).toContain(`codex ${action}`);
    expect(script).toContain("CODEX_HOME=");
    expect(script).toContain("-u OPENAI_API_KEY");
  }
  mkdirSync(account.configDir, { recursive: true });
  writeFileSync(join(account.configDir, "keep.txt"), "history stays");
  removeCodexAccount(account.id);
  expect(readFileSync(join(account.configDir, "keep.txt"), "utf8")).toBe("history stays");
  expect(() => terminalSessionCommand(request)).toThrow("removed");
});

test("public identity and quota projection preserves unknowns and discards credentials", () => {
  const profile = readCodexAccounts()[0]!;
  const account = decodeCodexAccount(profile, { account: { type: "chatgpt", email: "person@example.com", planType: "pro", accessToken: "never publish" } });
  expect(account).toEqual({ ...profile, status: "signed-in", authType: "chatgpt", email: "person@example.com", subscription: "pro" });
  expect(decodeCodexAccount(profile, { account: null }).status).toBe("signed-out");
  expect(decodeCodexAccount(profile, {}).status).toBe("unavailable");
  const now = Date.now();
  const usage = decodeCodexUsage(account, { rateLimitsByLimitId: { codex: { primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: (now + 10000) / 1000 }, secondary: { usedPercent: 12, windowDurationMins: 10080 } } } }, now);
  expect(usage.windows.map(w => [w.name, w.pct])).toEqual([["5 hour", 37], ["7 day", 12]]);
  expect(decodeCodexUsage(account, undefined).windows).toEqual([]);
  expect(decodeCodexUsage(account, { rateLimits: { primary: { usedPercent: null, windowDurationMins: 300 } } }).windows).toEqual([]);
  expect(decodeCodexUsage(account, { rateLimits: { primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 1 } } }).windows).toEqual([]);
  expect(decodeCodexUsage(decodeCodexAccount(profile, { account: { type: "apiKey" } }), undefined).status).toBe("api_key");
});

test("read-only app-server handshake requests only identity and limits; failed usage retains identity", async () => {
  const profile = addCodexAccount("Probe");
  const executable = join(root, "mock-codex");
  writeFileSync(executable, `#!${process.execPath}\nimport { createInterface } from 'node:readline';\nimport { appendFileSync } from 'node:fs';\nfor await (const line of createInterface({input: process.stdin})) {\nconst msg = JSON.parse(line);\nappendFileSync(process.env.CODEX_HOME+'/calls', msg.method+'\\n');\nif(!msg.id) continue;\nconsole.log(JSON.stringify(msg.method === 'account/rateLimits/read' ? {id:msg.id,error:{message:'offline'}} : {id:msg.id,result:msg.method === 'account/read' ? {account:{type:'chatgpt',email:'fixture@example.com',planType:'pro',token:'never publish'}} : {}}));\n}\n`);
  chmodSync(executable, 0o700);
  const result = await readCodexAccount(profile, executable, 3000);
  expect(result.account.status).toBe("signed-in");
  expect(result.usage.status).toBe("unavailable");
  expect(JSON.stringify(result)).not.toContain("never publish");
  expect(readFileSync(join(profile.configDir, "calls"), "utf8")).toBe("initialize\ninitialized\naccount/read\naccount/rateLimits/read\n");
  const stalled = join(root, "stalled-codex");
  writeFileSync(stalled, `#!${process.execPath}\nsetInterval(() => {},1000);`);
  chmodSync(stalled, 0o700);
  expect((await readCodexAccount(profile, stalled, 100)).account.status).toBe("unavailable");
});

test("live discovery isolates profiles and prevents reauthentication while a profile is active", async () => {
  const work = addCodexAccount("Work");
  const defaultProfile = readCodexAccounts()[0]!;
  writeCodexSession({ sessionId: "work-thread", pid: process.pid, cwd: "/work", status: "idle", updatedAt: Date.now(), transcriptPath: "", codexHome: work.configDir });
  expect(readCodexSessions({ codexHome: defaultProfile.configDir }).entries).toHaveLength(0);
  expect(readCodexSessions({ codexHome: work.configDir }).entries).toHaveLength(1);
  const snapshot = await accountRegistrySnapshot(join(root, "claude"), [], readCodexAccounts());
  expect(snapshot?.infos).toHaveLength(1);
  expect(snapshot?.infos[0]).toMatchObject({ codexAccountId: work.id, accountLabel: "Work", backend: "codex" });
  await expect(assertCodexAccountIdle(work)).rejects.toThrow("live sessions");
  await expect(assertCodexAccountIdle(defaultProfile)).resolves.toBeUndefined();
  writeFileSync(join(process.env.CONCH_CONFIG_DIR!, "codex-sessions", "broken.json"), "{");
  await expect(assertCodexAccountIdle(defaultProfile)).rejects.toThrow("Could not check");
});

test("history, records roots, and execution connections retain provider plus profile identity", () => {
  const work = addCodexAccount("Work");
  for (const profile of readCodexAccounts()) {
    mkdirSync(profile.configDir, { recursive: true });
    const db = new Database(join(profile.configDir, "state_5.sqlite"));
    db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, updated_at_ms INTEGER, archived INTEGER, source TEXT)");
    db.run("INSERT INTO threads VALUES ('same-id', '/work', ?, 1000, 0, 'cli')", [profile.label]);
    db.close();
  }
  const read = accountResumableSessions({ configDir: process.env.CONCH_CONFIG_DIR }, [], readCodexAccounts());
  expect(read.sessions.map(s => s.codexAccountId).sort()).toEqual(["default", work.id].sort());
  expect(read.sessions.every(s => !s.claudeAccountId)).toBe(true);
  const roots = recordsRoots({ codexHome: readCodexAccounts()[0]!.configDir, codexHomes: readCodexAccounts().map(a => a.configDir) });
  expect(roots).toHaveLength(4);
  expect(roots.some(r => r.path === join(work.configDir, "sessions"))).toBe(true);
  const catalog = deviceExecutionCatalog("mac", "This Mac", [{ id: "default", label: "Default" }], readCodexAccounts());
  expect(new Set(catalog.accounts.map(a => a.id)).size).toBe(3);
  expect(catalog.connections.find(c => c.id === sessionExecution("mac", "codex", work.id).connectionId)?.providerId).toBe("codex");
});

test("wire protocol accepts Codex routing and cloud actions, rejects wrong-provider routes, strips secrets", () => {
  expect(validateRuntimeControlMessage({ kind: "codex-accounts", action: "cloud", id: "default" })).toMatchObject({ ok: true, value: { kind: "codex-accounts", action: "cloud" } });
  expect(validateRuntimeControlMessage({ kind: "claude-accounts", action: "cloud", id: "default" }).ok).toBe(false);
  expect(validateRuntimeControlMessage({ kind: "session-start", backend: "codex", codexAccountId: "default" })).toMatchObject({ ok: true, value: { codexAccountId: "default" } });
  expect(validateRuntimeControlMessage({ kind: "session-start", backend: "claude", codexAccountId: "default" }).ok).toBe(false);
  const reply = validateControlResponse({ kind: "codex-accounts", accounts: [{ ...readCodexAccounts()[0], status: "signed-in", authType: "chatgpt", token: "never publish" }], usage: { source: "codex-app-server", state: "ready", accounts: [] } });
  expect(reply.ok).toBe(true);
  expect(JSON.stringify(reply)).not.toContain("never publish");
});
