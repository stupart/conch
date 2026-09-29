import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { accountStorePath, readClaudeAccountStatus, validAccountId, type ClaudeAccount, type ClaudeAccountStatus } from "./claude-accounts.ts";
import { conchInvocation } from "./install.ts";
import type { SwapDashboard, UsageWindow } from "./claude-swap.ts";

const marker = "usage-statusline";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function read(path: string): Record<string, unknown> | undefined {
  try { const value = JSON.parse(readFileSync(path, "utf8")); return object(value) ? value : undefined; } catch { return; }
}
function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); renameSync(temp, path); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
const statePath = (account: ClaudeAccount) => join(account.configDir, "conch-statusline.json");
const usagePath = (account: ClaudeAccount) => join(account.configDir, "conch-usage.json");
const identity = (account: ClaudeAccountStatus) => account.status === "signed-in" && account.email
  ? JSON.stringify([account.email, account.organizationId ?? ""]) : undefined;

/** Preserve the user's status line and forward its exact input/output. Only
 * official public rate-limit fields are persisted, never the full input. */
export function installAccountUsage(account: ClaudeAccount, invocation = conchInvocation()): void {
  const path = join(account.configDir, "settings.json");
  const settings = read(path);
  if (!settings && existsSync(path)) throw new Error("Claude settings are not valid JSON; fix them before connecting this account.");
  const current = settings?.statusLine;
  const command = `CONCH_CONFIG_DIR=${quote(dirname(accountStorePath()))} ${invocation} ${marker} ${quote(account.id)} ${quote(account.configDir)}`;
  const state = read(statePath(account));
  const managed = object(current) && current.command === state?.command;
  if (managed && current.command === command) return;
  // Never chain an orphaned Conch wrapper back into itself.
  const orphaned = object(current) && typeof current.command === "string" && current.command.includes(` ${marker} `);
  write(statePath(account), { accountId: account.id, command, original: managed ? state?.original ?? null : orphaned ? null : current ?? null });
  write(path, { ...settings, statusLine: { ...(object(current) ? current : {}), type: "command", command } });
}

export function clearAccountUsage(account: ClaudeAccount): void {
  if (existsSync(usagePath(account))) unlinkSync(usagePath(account));
}

/** Unregistering a profile restores its original status line if still ours. */
export function uninstallAccountUsage(account: ClaudeAccount): void {
  const path = join(account.configDir, "settings.json");
  const settings = read(path);
  const state = read(statePath(account));
  if (settings && state && object(settings.statusLine) && settings.statusLine.command === state.command) {
    if (state.original == null) delete settings.statusLine;
    else settings.statusLine = state.original;
    write(path, settings);
  }
}

export function decodeRateLimits(value: unknown, now = Date.now()): UsageWindow[] {
  if (!object(value)) return [];
  const windows: UsageWindow[] = [];
  for (const [key, name] of [["five_hour", "5 hour"], ["seven_day", "7 day"]] as const) {
    const window = value[key];
    if (!object(window) || typeof window.used_percentage !== "number" || !Number.isFinite(window.used_percentage)
      || window.used_percentage < 0 || window.used_percentage > 100 || typeof window.resets_at !== "number"
      || !Number.isFinite(window.resets_at) || window.resets_at * 1000 <= now || window.resets_at * 1000 > 8.64e15) continue;
    windows.push({ name, pct: window.used_percentage, resetsAt: new Date(window.resets_at * 1000).toISOString() });
  }
  return windows;
}

export function saveAccountUsage(account: ClaudeAccountStatus, rateLimits: unknown, now = Date.now()): void {
  const subject = identity(account);
  if (!subject) { clearAccountUsage(account); return; }
  write(usagePath(account), { identity: subject, rateLimits: Object.fromEntries(decodeRateLimits(rateLimits, now).map(window => [
    window.name === "5 hour" ? "five_hour" : "seven_day",
    { used_percentage: window.pct, resets_at: Date.parse(window.resetsAt!) / 1000 },
  ])), fetchedAt: new Date(now).toISOString() });
}

export function readAccountUsage(accounts: ClaudeAccountStatus[], now = Date.now()): SwapDashboard {
  return { source: "claude-statusline", state: "ready", accounts: accounts.map((account, index) => {
    const cache = read(usagePath(account));
    const valid = !!identity(account) && cache?.identity === identity(account);
    const fetchedAt = valid && typeof cache?.fetchedAt === "string" && Number.isFinite(Date.parse(cache.fetchedAt)) ? cache.fetchedAt : undefined;
    return { id: account.id, number: index + 1, label: account.label, email: account.email ?? "", defaultLogin: account.id === "default",
      status: account.status === "signed-out" ? "no_credentials" : "ok", windows: valid ? decodeRateLimits(cache?.rateLimits, now) : [],
      ...(fetchedAt ? { fetchedAt } : {}), lastGood: !fetchedAt || now - Date.parse(fetchedAt) > 300_000 };
  }) };
}

export async function runAccountStatusline(id: string | undefined, configDir: string | undefined): Promise<void> {
  try {
    if (!validAccountId(id) || !configDir || !isAbsolute(configDir)) return;
    // Claude invokes us with this profile's CLAUDE_CONFIG_DIR. Looking up the
    // registry's default here would mistake an extra profile for the default.
    const account: ClaudeAccount = { id, label: id, configDir };
    const state = read(statePath(account));
    if (state?.accountId !== id) return;
    const raw = await Bun.stdin.text();
    if (raw.length > 1_048_576) return;
    try {
      const payload: unknown = JSON.parse(raw);
      if (object(payload) && object(payload.rate_limits)) {
        const previous = read(usagePath(account));
        // The auth CLI is only consulted when usage changes or once a minute.
        // Checking the public identity prevents a manual login from inheriting another account's cache.
        if (JSON.stringify(decodeRateLimits(previous?.rateLimits)) !== JSON.stringify(decodeRateLimits(payload.rate_limits))
          || typeof previous?.fetchedAt !== "string" || Date.now() - Date.parse(previous.fetchedAt) >= 60_000) {
          saveAccountUsage(await readClaudeAccountStatus(account), payload.rate_limits);
        }
      }
    } catch { /* A malformed reading must not break the user's status line. */ }
    if (object(state?.original) && typeof state.original.command === "string") {
      const child = Bun.spawn(["/bin/sh", "-c", state.original.command], { stdin: new Blob([raw]), stdout: "inherit", stderr: "inherit" });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 4_000);
      try { await child.exited; } finally { clearTimeout(timeout); }
    }
  } catch { /* Optional telemetry must never interrupt Claude. */ }
}
