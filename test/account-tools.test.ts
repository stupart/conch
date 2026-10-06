import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyToolsAction, accountToolsRequestError, toolsItems, type AccountToolsRequest } from "../src/account-tools.ts";
import { validateControlResponse, validateRuntimeControlMessage } from "../src/settings.ts";
import { readAgentCapabilities } from "../src/agent-capabilities.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function profile() { const dir = mkdtempSync(join(tmpdir(), "conch-tools-")); dirs.push(dir); return { id: "business", label: "Business", configDir: dir }; }
const request = (extra: Partial<AccountToolsRequest> = {}): AccountToolsRequest => ({ kind: "account-tools", backend: "claude", accountId: "business", action: "install-plugin", requestId: "unique", id: "conch@conch", ...extra });
test("wire validation refuses flags, pasted commands and credential URLs", () => {
  expect(validateRuntimeControlMessage(request()).ok).toBe(true);
  for (const extra of [{ id: "--help" }, { source: "--help" }, { source: "/tmp/plugin /plugin install conch@conch" }, { requestId: undefined }, { accountId: "../personal" }, { action: "add-mcp", id: "server", url: "https://user:password@example.com/mcp" }]) {
    expect(accountToolsRequestError(request(extra as any) as any)).toBeDefined();
  }
  expect(validateControlResponse({ kind: "account-tools", backend: "claude", accountId: "business", accounts: [], items: [], library: [] }).ok).toBe(true);
  expect(validateControlResponse({ kind: "account-tools", backend: "claude", accountId: "business", accounts: [], items: [{ id: "x" }], library: [] }).ok).toBe(false);
});
test("marketplace registration precedes installation in exactly the selected account", async () => {
  const account = profile(); const calls: unknown[] = [];
  await applyToolsAction(request({ source: account.configDir }), account, [], async (backend, selected, args) => { calls.push({ backend, selected, args }); });
  expect(calls).toEqual([
    { backend: "claude", selected: account, args: ["plugin", "marketplace", "add", account.configDir, "--scope", "user"] },
    { backend: "claude", selected: account, args: ["plugin", "install", "conch@conch", "--scope", "user"] },
  ]);
  let attempts = 0;
  await expect(applyToolsAction(request({ source: account.configDir }), account, [], async () => { attempts++; throw new Error("offline"); })).rejects.toThrow("offline");
  expect(attempts).toBe(1);
});
test("plugin toggles preserve the other profile and unrelated settings, with a backup", async () => {
  const business = profile(), personal = profile();
  const original = { enabledPlugins: { "conch@conch": true, "notes@notes-local": true }, model: "opus" };
  for (const account of [business, personal]) writeFileSync(join(account.configDir, "settings.json"), JSON.stringify(original));
  mkdirSync(join(business.configDir, "plugins"));
  writeFileSync(join(business.configDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "conch@conch": [{ scope: "user", installPath: business.configDir }] } }));
  await applyToolsAction(request({ action: "toggle-plugin", enabled: false }), business, [{ id: "conch@conch", name: "Conch", kind: "plugin", managed: false, enabled: true, detail: "user" }]);
  expect(JSON.parse(readFileSync(join(business.configDir, "settings.json"), "utf8"))).toEqual({ ...original, enabledPlugins: { ...original.enabledPlugins, "conch@conch": false } });
  expect(JSON.parse(readFileSync(join(personal.configDir, "settings.json"), "utf8"))).toEqual(original);
  expect(readdirSync(business.configDir).some(x => x.includes("conch-backup"))).toBe(true);
});
test("plugin-owned servers cannot be removed, and inventory never includes secrets", async () => {
  const account = profile();
  await expect(applyToolsAction(request({ action: "remove-mcp", id: "owned" }), account, [{ id: "owned", name: "Owned", kind: "mcp-server", managed: true, detail: "plugin" }])).rejects.toThrow("belongs to a plugin");
  writeFileSync(join(account.configDir, ".claude.json"), JSON.stringify({ mcpServers: { private: { type: "http", url: "https://example.com/private?token=secret", headers: { Authorization: "Bearer secret" } } } }));
  const items = toolsItems(readAgentCapabilities({ backend: "claude", cwd: account.configDir, configDir: account.configDir, claudeHome: account.configDir, claudeStatePath: join(account.configDir, ".claude.json") }).entities);
  expect(items.some(x => x.id === "private")).toBe(true);
  expect(JSON.stringify(items)).not.toContain("secret");
  expect(JSON.stringify(items)).not.toContain("/private?");
});
test("local MCP commands preserve argument boundaries without shell interpolation", async () => {
  const account = profile(), calls: string[][] = [];
  for (const backend of ["claude", "codex"] as const) {
    await applyToolsAction(request({ backend, action: "add-mcp", id: "local", command: "npx", args: ["-y", "some-server", "a path with spaces", "$(not-executed)"] }), account, [], async (_, __, args) => { calls.push(args); });
  }
  expect(calls[0]).toEqual(["mcp", "add", "--scope", "user", "local", "--", "npx", "-y", "some-server", "a path with spaces", "$(not-executed)"]);
  expect(calls[1]).toEqual(["mcp", "add", "local", "--", "npx", "-y", "some-server", "a path with spaces", "$(not-executed)"]);
  expect(accountToolsRequestError(request({ action: "add-mcp", id: "local", command: "npx -y evil", args: [] }) as any)).toBeDefined();
});
