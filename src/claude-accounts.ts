import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { conchHome } from "./home.ts";
import type { ExecutionCatalog } from "./execution-model.ts";
import type { SwapDashboard } from "./claude-swap.ts";

/** A local launch profile. Claude owns all credentials and subscription billing. */
export interface ClaudeAccount {
  id: string;
  label: string;
  configDir: string;
}

export interface ClaudeAccountStatus extends ClaudeAccount {
  status: "unchecked" | "signed-in" | "signed-out" | "unavailable";
  email?: string;
  subscription?: string;
  organizationId?: string;
}

export type ClaudeAccountRequest = {
  kind: "claude-accounts";
  action: "list" | "add" | "remove" | "login" | "refresh" | "usage";
  id?: string;
  label?: string;
  configDir?: string;
};
export interface ClaudeAccountsReply {
  kind: "claude-accounts";
  accounts: ClaudeAccountStatus[];
  loginOpened?: true;
  createdAccountId?: string;
  execution?: ExecutionCatalog;
  usage?: SwapDashboard;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
export const validAccountId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);

export function accountRequestError(value: Record<string, unknown>): string | undefined {
  if (!["list", "add", "remove", "login", "refresh", "usage"].includes(String(value.action))) return "Unknown account action";
  if (value.id !== undefined && !validAccountId(value.id)) return "Invalid Claude account id";
  if (["remove", "login", "refresh"].includes(String(value.action)) && !validAccountId(value.id)) return "Choose a Claude account";
  if (value.action === "add") {
    if (typeof value.label !== "string" || !value.label.trim() || value.label.trim().length > 60 || CONTROL.test(value.label)) return "Account name must be 1–60 printable characters";
    if (value.configDir !== undefined && (typeof value.configDir !== "string" || !isAbsolute(value.configDir) || value.configDir.length > 4096 || CONTROL.test(value.configDir))) return "Account directory must be an absolute path";
  }
}

export function accountStorePath(): string {
  return join(process.env.CONCH_CONFIG_DIR ?? join(conchHome(), ".config", "conch"), "claude-accounts.json");
}
export function defaultClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(conchHome(), ".claude");
}
function canonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  // Resolve existing ancestors too: /var and /private/var must remain the
  // same profile before and after Claude creates the leaf directory.
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
}

export function readClaudeAccounts(defaultDir = defaultClaudeDir(), file = accountStorePath()): ClaudeAccount[] {
  const defaults = { id: "default", label: "Default", configDir: resolve(defaultDir) };
  if (!existsSync(file)) return [defaults];
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(data) || data.length > 16) throw new Error("Cannot read Claude account profiles");
  const ids = new Set(["default"]);
  const dirs = new Set([canonical(defaults.configDir)]);
  const accounts = [defaults];
  for (const entry of data) {
    if (!entry || !validAccountId(entry.id) || ids.has(entry.id)
      || accountRequestError({ ...entry, action: "add" }) || typeof entry.configDir !== "string") throw new Error("Invalid Claude account profile");
    const configDir = canonical(entry.configDir);
    if (dirs.has(configDir)) throw new Error("Claude account profiles must have separate directories");
    ids.add(entry.id); dirs.add(configDir);
    accounts.push({ id: entry.id, label: entry.label.trim(), configDir });
  }
  return accounts;
}

function save(accounts: ClaudeAccount[], file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(accounts.filter((account) => account.id !== "default"), null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function addClaudeAccount(label: string, configDir?: string, file = accountStorePath(), defaultDir = defaultClaudeDir()): ClaudeAccount {
  const error = accountRequestError({ action: "add", label, ...(configDir ? { configDir } : {}) });
  if (error) throw new Error(error);
  const accounts = readClaudeAccounts(defaultDir, file);
  if (accounts.length >= 17) throw new Error("Conch supports up to 16 additional Claude accounts");
  if (accounts.some((account) => account.label.toLowerCase() === label.trim().toLowerCase())) throw new Error("Choose a different account name");
  const id = crypto.randomUUID();
  const account = { id, label: label.trim(), configDir: canonical(configDir ?? join(dirname(file), "claude", id)) };
  if (accounts.some((existing) => canonical(existing.configDir) === account.configDir)) throw new Error("That directory is already registered");
  save([...accounts, account], file);
  return account;
}

/** Remove only Conch's label/registration. Never remove Claude files or sign anyone out. */
export function removeClaudeAccount(id: string, file = accountStorePath(), defaultDir = defaultClaudeDir()): void {
  if (id === "default") throw new Error("The default account cannot be removed");
  const accounts = readClaudeAccounts(defaultDir, file);
  if (!accounts.some((account) => account.id === id)) throw new Error("Claude account was not found");
  save(accounts.filter((account) => account.id !== id), file);
}

export function requireClaudeAccount(id: string, defaultDir = defaultClaudeDir()): ClaudeAccount {
  const account = readClaudeAccounts(defaultDir).find((account) => account.id === id);
  if (!account) throw new Error("Claude account was removed or is unavailable. Choose an account again.");
  return account;
}

/** Additional profiles do not inherit API credentials from the launcher. */
export const CLAUDE_ACCOUNT_ENV_REMOVE = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_PROFILE",
] as const;

export function claudeAccountEnvironment(configDir: string, isolate = true): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  if (isolate) for (const key of CLAUDE_ACCOUNT_ENV_REMOVE) delete env[key];
  return env;
}

export function decodeClaudeAuth(account: ClaudeAccount, raw: string): ClaudeAccountStatus {
  try {
    const value = JSON.parse(raw);
    if (typeof value.loggedIn !== "boolean") throw new Error();
    const safeText = (input: unknown) => typeof input === "string" && input.length < 200 && !CONTROL.test(input) ? input : undefined;
    return { ...account, status: value.loggedIn ? "signed-in" : "signed-out",
      ...(safeText(value.email) ? { email: value.email } : {}),
      ...(safeText(value.subscriptionType) ? { subscription: value.subscriptionType } : {}),
      ...(safeText(value.orgId) ? { organizationId: value.orgId } : {}) };
  } catch { return { ...account, status: "unavailable" }; }
}

/** Read the official CLI's public status, never its credential files or Keychain. */
export async function readClaudeAccountStatus(account: ClaudeAccount): Promise<ClaudeAccountStatus> {
  try {
    const child = Bun.spawn(["claude", "auth", "status", "--json"], {
      env: account.id === "default" ? { ...process.env } : claudeAccountEnvironment(account.configDir), cwd: conchHome(), stdout: "pipe", stderr: "ignore",
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 5_000);
    try {
      const output = new Response(child.stdout).text();
      await child.exited;
      const raw = await output;
      return timedOut ? { ...account, status: "unavailable" } : decodeClaudeAuth(account, raw);
    } finally { clearTimeout(timer); }
  } catch { return { ...account, status: "unavailable" }; }
}

/** Keep provider-specific launch validation at the profile boundary. */
export function claudeAccountForLaunch(request: { backend: string; claudeAccountId?: string }): ClaudeAccount | undefined {
  if (request.claudeAccountId === undefined) return;
  if (request.backend !== "claude" || !validAccountId(request.claudeAccountId)) throw new Error("Account selection is only available for Claude");
  return requireClaudeAccount(request.claudeAccountId);
}

// Cache only public CLI status; credentials remain owned by Claude.
const statusCache = new Map<string, { time: number; value: Promise<ClaudeAccountStatus> }>();
export function invalidateClaudeAccountStatus(account: ClaudeAccount): void {
  statusCache.delete(JSON.stringify([account.id, account.configDir]));
}
export function cachedClaudeAccountStatus(account: ClaudeAccount, refresh = false): Promise<ClaudeAccountStatus> {
  const key = JSON.stringify([account.id, account.configDir]);
  const cached = statusCache.get(key);
  if (!refresh && cached && Date.now() - cached.time < 60_000) return cached.value;
  const value = readClaudeAccountStatus(account);
  statusCache.set(key, { time: Date.now(), value });
  return value;
}
