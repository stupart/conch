import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addClaudeAccount, readClaudeAccounts } from "../src/claude-accounts.ts";
import { prepareClaudeHandoff, settleClaudeHandoff, claudeHandoffReceipt, supportsClaudeHandoff } from "../src/claude-account-handoff.ts";
import { terminalSessionCommand, type StartSessionRequest } from "../src/session-lifecycle.ts";
import { validateRuntimeControlMessage } from "../src/settings.ts";
import { RecordStore } from "../src/records-store.ts";
import { RECORD_MIGRATIONS } from "../src/records-schema.ts";

let root: string, cwd: string, file: string, request: StartSessionRequest;
let oldConfig: string | undefined, oldClaude: string | undefined;
const original = "00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "conch-handoff-")));
  oldConfig = process.env.CONCH_CONFIG_DIR; oldClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CONCH_CONFIG_DIR = join(root, "conch"); process.env.CLAUDE_CONFIG_DIR = join(root, "personal");
  cwd = join(root, "project with spaces"); mkdirSync(cwd);
  const project = join(root, "personal", "projects", "fixture"); mkdirSync(project, { recursive: true });
  file = join(project, `${original}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "user", uuid: "user-one", sessionId: original, cwd, message: { role: "user", content: "Retain this conversation" } }) + "\n");
  const destination = addClaudeAccount("Business");
  request = { backend: "claude", claudeSourceAccountId: "default", claudeAccountId: destination.id, resumeSessionId: original, cwd };
});
afterEach(() => {
  if (oldConfig === undefined) delete process.env.CONCH_CONFIG_DIR; else process.env.CONCH_CONFIG_DIR = oldConfig;
  if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
  rmSync(root, { recursive: true, force: true });
});
const prepare = (value = request) => prepareClaudeHandoff(value, { accounts: readClaudeAccounts(), configDir: process.env.CONCH_CONFIG_DIR!, ownerDeviceId: "this-mac" });

test("snapshot is byte-identical and private; official resume forks into the selected isolated account", async () => {
  const originalBytes = readFileSync(file);
  const result = await prepare();
  expect(readFileSync(file)).toEqual(originalBytes);
  expect(readFileSync(result.request.claudeHandoff!.transcriptPath)).toEqual(originalBytes);
  expect(statSync(result.directory).mode & 0o777).toBe(0o700);
  expect(statSync(result.request.claudeHandoff!.transcriptPath).mode & 0o777).toBe(0o600);
  expect(result.manifest.destination.nativeId).not.toBe(original);
  expect(result.manifest.source).toMatchObject({ accountId: "default", nativeId: original, bytes: originalBytes.length });
  const command = terminalSessionCommand(result.request);
  expect(command).toContain(`--resume '${result.request.claudeHandoff!.transcriptPath}'`);
  expect(command).toContain("--fork-session");
  expect(command).toContain(`--session-id '${result.manifest.destination.nativeId}'`);
  expect(command).toContain("-u ANTHROPIC_API_KEY");
  expect(command).toContain(readClaudeAccounts().find(a => a.id === request.claudeAccountId)!.configDir);
  await settleClaudeHandoff(result.directory, result.manifest, "terminal-opened");
  expect(JSON.parse(readFileSync(join(result.directory, "manifest.json"), "utf8")).state).toBe("terminal-opened");
});

test("wire requests choose registered identities, never an arbitrary transcript or destination UUID", () => {
  const validated = validateRuntimeControlMessage({ kind: "session-start", ...request, claudeHandoff: { transcriptPath: "/private/secret", sessionId: original } });
  expect(validated.ok).toBe(true);
  if (validated.ok) expect(validated.value).not.toHaveProperty("claudeHandoff");
  for (const changes of [ { backend: "codex" }, { claudeAccountId: "default" }, { claudeSourceAccountId: "../private" }, { resumeSessionId: "../secret" }, { teleportSessionId: "cloud" }, { cwd: undefined }, { claudeAccountId: undefined } ]) {
    expect(validateRuntimeControlMessage({ kind: "session-start", ...request, ...changes }).ok).toBe(false);
  }
  expect(() => terminalSessionCommand(request)).toThrow("prepared by the daemon");
});

test("missing, ambiguous, external symlink and incomplete histories are refused without rewriting them", async () => {
  const bytes = readFileSync(file);
  writeFileSync(file, bytes.subarray(0, bytes.length - 1));
  await expect(prepare()).rejects.toThrow("still being written");
  writeFileSync(file, bytes);
  const duplicate = join(root, "personal", "projects", "second"); mkdirSync(duplicate);
  writeFileSync(join(duplicate, `${original}.jsonl`), bytes);
  await expect(prepare()).rejects.toThrow("ambiguous");
  rmSync(duplicate, { recursive: true }); rmSync(file);
  const external = join(root, "outside.jsonl"); writeFileSync(external, bytes); symlinkSync(external, file);
  await expect(prepare()).rejects.toThrow("missing or ambiguous");
  expect(readFileSync(external)).toEqual(bytes);
});

test("account, conversation identity, and original working directory must still match", async () => {
  await expect(prepare({ ...request, claudeAccountId: "removed" })).rejects.toThrow("removed");
  await expect(prepare({ ...request, cwd: root })).rejects.toThrow("working folder changed");
  writeFileSync(file, JSON.stringify({ type: "user", sessionId: "different", cwd, message: { content: "wrong conversation" } }) + "\n");
  await expect(prepare()).rejects.toThrow("No resumable conversation");
});

test("handoff back to default strips inherited API credentials without changing default Keychain selection", async () => {
  const result = await prepare();
  delete process.env.CLAUDE_CONFIG_DIR;
  const command = terminalSessionCommand({ ...result.request, claudeAccountId: "default" });
  expect(command).toContain("-u ANTHROPIC_API_KEY");
  expect(command).toContain("-u CLAUDE_CONFIG_DIR");
  expect(command).not.toContain("CLAUDE_CONFIG_DIR=");
});

test("receipt migration preserves existing facts and records parent/account lineage through reindex", async () => {
  const result = await prepare();
  const records = join(root, "records-test", "records"); mkdirSync(records, { recursive: true });
  const old = new Database(join(records, "history.sqlite"));
  RECORD_MIGRATIONS.slice(0, -1).forEach(sql => old.exec(sql));
  old.exec(`PRAGMA user_version=${RECORD_MIGRATIONS.length - 1}`);
  old.query("INSERT INTO receipts VALUES (?,?,?,?,?,?,?,?,?,?)").run("older", "old-session", "old-action", null, null, null, "delivery", "delivered", 1, null);
  old.close();
  const store = new RecordStore({ configDir: join(root, "records-test") });
  try {
    const receipt = claudeHandoffReceipt(result.manifest, "accepted");
    expect(store.appendReceipt(receipt)).toBe(true);
    expect(store.appendReceipt(receipt)).toBe(false);
    store.reindex(receipt.sessionId);
    expect(store.receipts(result.manifest.id)[0]?.details?.handoff).toMatchObject({ sourceNativeId: original, destinationNativeId: result.manifest.id, ownerDeviceId: "this-mac" });
    expect(store.receipts("old-action")).toHaveLength(1);
    const db = new Database(store.path);
    expect(() => db.exec("DELETE FROM receipts")).toThrow("immutable");
    db.close();
  } finally { store.close(); }
});

test("unsupported CLI versions cannot be mistaken for the verified resume implementation", () => {
  expect(supportsClaudeHandoff("2.1.280 (Claude Code)")).toBe(true);
  expect(supportsClaudeHandoff("2.1.279 (Claude Code)")).toBe(false);
  expect(supportsClaudeHandoff("3.0.0")).toBe(true);
  expect(supportsClaudeHandoff("unavailable")).toBe(false);
});

test("the launch acknowledgement carries the fork identity through wire validation", async () => {
  const { dispatchRuntimeControlMessage } = await import("../src/control-server.ts");
  const { validateControlResponse } = await import("../src/settings.ts");
  const next = "00000000-0000-4000-8000-000000000002";
  const reply = await dispatchRuntimeControlMessage({ kind: "session-start", ...request }, {
    listResumable: () => ({ sessions: [], complete: true }),
    start: () => ({ sessionId: next }), close: () => {}, report: () => {},
  });
  expect(reply).toMatchObject({ handled: true, response: { sessionId: next, resumed: true } });
  // Check the public projection too: stripping this field makes the Mac follow the old session.
  expect(validateControlResponse({ kind: "session-started", backend: "claude", resumed: true, sessionId: next }))
    .toMatchObject({ ok: true, value: { sessionId: next } });
});
