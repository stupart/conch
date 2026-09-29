import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountUsage, decodeRateLimits, installAccountUsage, readAccountUsage, saveAccountUsage, uninstallAccountUsage } from "../src/claude-account-usage.ts";
import type { ClaudeAccountStatus } from "../src/claude-accounts.ts";
import { validateControlResponse } from "../src/settings.ts";
import { removeHooksFile } from "../src/uninstall.ts";

let root: string;
let account: ClaudeAccountStatus;
const now = Date.parse("2026-09-29T00:00:00Z");
const limits = { five_hour: { used_percentage: 43, resets_at: now / 1000 + 3600 }, seven_day: { used_percentage: 87, resets_at: now / 1000 + 86400 } };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "conch-usage-"));
  account = { id: "work", label: "Work", configDir: join(root, "work's folder"), status: "signed-in", email: "work@example.com", organizationId: "org-a" };
  mkdirSync(account.configDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("status line installation preserves settings, the original command, and repeated installs", () => {
  const path = join(account.configDir, "settings.json");
  const original = { type: "command", command: "jq -r .model.display_name", padding: 3 };
  writeFileSync(path, JSON.stringify({ statusLine: original, permissions: { deny: ["Bash(rm *)"] } }));
  installAccountUsage(account, "'/opt/conch'");
  const first = readFileSync(path, "utf8");
  installAccountUsage(account, "'/opt/conch'");
  expect(readFileSync(path, "utf8")).toBe(first);
  expect(JSON.parse(first).permissions).toEqual({ deny: ["Bash(rm *)"] });
  expect(JSON.parse(first).statusLine.padding).toBe(3);
  expect(JSON.parse(readFileSync(join(account.configDir, "conch-statusline.json"), "utf8")).original).toEqual(original);
  expect(statSync(join(account.configDir, "conch-statusline.json")).mode & 0o777).toBe(0o600);
  installAccountUsage(account, "'/Applications/conch'");
  uninstallAccountUsage(account);
  expect(JSON.parse(readFileSync(path, "utf8")).statusLine).toEqual(original);
});

test("removal preserves a later user change and malformed settings are never overwritten", () => {
  const path = join(account.configDir, "settings.json");
  installAccountUsage(account, "conch");
  const settings = { statusLine: { type: "command", command: "echo custom" } };
  writeFileSync(path, JSON.stringify(settings));
  uninstallAccountUsage(account);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(settings);
  writeFileSync(path, "broken");
  expect(() => installAccountUsage(account)).toThrow("valid JSON");
  expect(readFileSync(path, "utf8")).toBe("broken");
});

test("uninstalling Claude hooks also restores its existing status line", async () => {
  const path = join(account.configDir, "settings.json");
  const original = { type: "command", command: "echo hello" };
  writeFileSync(path, JSON.stringify({ statusLine: original }));
  installAccountUsage(account, "conch");
  await removeHooksFile(path, "claude");
  expect(JSON.parse(readFileSync(path, "utf8")).statusLine).toEqual(original);
});

test("only current public rate windows persist; identity and organization changes hide the cache", () => {
  saveAccountUsage(account, { ...limits, token: "secret", five_hour: { ...limits.five_hour, access_token: "secret" } }, now);
  const raw = readFileSync(join(account.configDir, "conch-usage.json"), "utf8");
  expect(raw).not.toContain("secret");
  expect(readAccountUsage([account], now).accounts[0]!.windows.map(w => w.pct)).toEqual([43, 87]);
  expect(readAccountUsage([{ ...account, organizationId: "org-b" }], now).accounts[0]!.windows).toEqual([]);
  expect(readAccountUsage([{ ...account, email: "different@example.com" }], now).accounts[0]!.windows).toEqual([]);
  expect(readAccountUsage([{ ...account, status: "signed-out" }], now).accounts[0]!.windows).toEqual([]);
  expect(readAccountUsage([account], now + 3600_000).accounts[0]!.windows.map(w => w.name)).toEqual(["7 day"]);
  expect(readAccountUsage([account], now + 301_000).accounts[0]!.lastGood).toBe(true);
  clearAccountUsage(account);
  expect(existsSync(join(account.configDir, "conch-usage.json"))).toBe(false);
});

test("missing, expired, and invalid windows remain unknown, not zero", () => {
  expect(decodeRateLimits(undefined, now)).toEqual([]);
  for (const pct of [-1, NaN, Infinity, 101, "5"]) expect(decodeRateLimits({ five_hour: { ...limits.five_hour, used_percentage: pct } }, now)).toEqual([]);
  expect(decodeRateLimits({ five_hour: { ...limits.five_hour, resets_at: now / 1000 } }, now)).toEqual([]);
  expect(decodeRateLimits({ seven_day: limits.seven_day }, now).map(w => w.name)).toEqual(["7 day"]);
  expect(decodeRateLimits({ five_hour: { ...limits.five_hour, used_percentage: 0 } }, now)[0]!.pct).toBe(0);
});

test("the control boundary preserves created account identity and native usage", () => {
  const reply = validateControlResponse({ kind: "claude-accounts", accounts: [account], createdAccountId: account.id, usage: readAccountUsage([account], now) });
  expect(reply.ok).toBe(true);
  if (reply.ok && reply.value.kind === "claude-accounts") {
    expect(reply.value.createdAccountId).toBe(account.id);
    expect(reply.value.usage?.source).toBe("claude-statusline");
  }
});

test("the installed command works inside an extra profile and forwards the original status line", async () => {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), '#!/bin/sh\nprintf \'%s\' \'{"loggedIn":true,"email":"work@example.com","orgId":"org-a","subscriptionType":"max"}\'\n', { mode: 0o700 });
  const path = join(account.configDir, "settings.json");
  writeFileSync(path, JSON.stringify({ statusLine: { type: "command", command: "cat" } }));
  installAccountUsage(account);
  const command = JSON.parse(readFileSync(path, "utf8")).statusLine.command;
  const time = Date.now();
  const raw = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 37, resets_at: time / 1000 + 3600 } }, model: { display_name: "Test" }, arbitrary: "must-not-persist" });
  const child = Bun.spawn(["/bin/sh", "-c", command], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: account.configDir },
    stdin: new Blob([raw]), stdout: "pipe", stderr: "pipe",
  });
  expect(await new Response(child.stdout).text()).toBe(raw);
  expect(await child.exited).toBe(0);
  expect(readAccountUsage([account], time).accounts[0]!.windows[0]!.pct).toBe(37);
  expect(readFileSync(join(account.configDir, "conch-usage.json"), "utf8")).not.toContain("must-not-persist");
});
