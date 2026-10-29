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
  /**
   * Kept but no longer offered (`retireClaudeAccount`): its live sessions are still seen, answered and closed, and
   * nothing launches in it again. A start, restart, fork or resume that names it runs in Default, bringing the
   * conversation across (retired-profile.ts).
   */
  retired?: true;
}

export interface ClaudeAccountStatus extends ClaudeAccount {
  status: "unchecked" | "signed-in" | "signed-out" | "unavailable";
  email?: string;
  subscription?: string;
  organizationId?: string;
  authType?: string;
}

export type ClaudeAccountRequest = ({ kind: "claude-accounts" } | { kind: "codex-accounts" }) & {
  action: "list" | "add" | "remove" | "login" | "refresh" | "usage" | "cloud" | "cancel-login"
    | "rotation-status" | "rotation-install" | "rotation-add"
    | "rotation-add-account" | "rotation-finish-add" | "rotation-switch" | "rotation-remove";
  id?: string;
  label?: string;
  configDir?: string;
  /** An account in claude-swap's list, by its number (`rotation-switch`, `rotation-remove`). */
  slot?: number;
  /** Pre-fills Claude's sign-in (`rotation-add-account` for an account signing in again). */
  email?: string;
  /** A login the Mac shows itself (`claude-web-login.ts`): the reply carries `loginUrl` instead of opening Terminal. */
  inApp?: true;
};
export interface ClaudeAccountsReply {
  kind: "claude-accounts" | "codex-accounts";
  accounts: ClaudeAccountStatus[];
  loginOpened?: true;
  /** Anthropic's authorize URL for an in-app sign-in (`inApp`), shown in a web view with no cookies of its own. */
  loginUrl?: string;
  /** Account rotation (claude-rotation.ts), on the rotation actions. `added`: the account `rotation-finish-add` put in the
   * list. */
  rotation?: { installed: boolean; on: boolean; running: boolean; dashboard?: SwapDashboard; output?: string; ok?: boolean; added?: string };
  /** `rotation-add-account`: the sign-in under way, for the Mac to show and then finish (`rotation-finish-add` with `id`). */
  adding?: { id: string; url: string };
  createdAccountId?: string;
  cloudOpened?: true;
  execution?: ExecutionCatalog;
  usage?: SwapDashboard;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
export const validAccountId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);

const ROTATION_ACTIONS = ["rotation-status", "rotation-install", "rotation-add", "rotation-add-account", "rotation-finish-add", "rotation-switch", "rotation-remove"];

export function accountRequestError(value: Record<string, unknown>): string | undefined {
  if (!["list", "add", "remove", "login", "refresh", "usage", ...(value.kind === "codex-accounts" ? ["cloud"] : ["cancel-login", ...ROTATION_ACTIONS])].includes(String(value.action))) return "Unknown account action";
  if (value.id !== undefined && !validAccountId(value.id)) return "Invalid account id";
  if (["remove", "login", "refresh", "cloud", "cancel-login", "rotation-finish-add"].includes(String(value.action)) && !validAccountId(value.id)) return "Choose an account";
  if (value.slot !== undefined && !(Number.isSafeInteger(value.slot) && (value.slot as number) >= 1 && (value.slot as number) <= 999)) return "Invalid account number";
  if (["rotation-switch", "rotation-remove"].includes(String(value.action)) && value.slot === undefined) return "Choose an account";
  if (value.email !== undefined && (typeof value.email !== "string" || !/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(value.email) || CONTROL.test(value.email))) return "Invalid email";
  if (value.inApp !== undefined && value.inApp !== true) return "inApp must be true when present";
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
  if (!Array.isArray(data) || data.length > 16) throw new Error("Cannot read account profiles");
  const ids = new Set(["default"]);
  const dirs = new Set([canonical(defaults.configDir)]);
  const accounts = [defaults];
  for (const entry of data) {
    if (!entry || !validAccountId(entry.id) || ids.has(entry.id)
      || accountRequestError({ ...entry, action: "add" }) || typeof entry.configDir !== "string") throw new Error("Invalid account profile");
    const configDir = canonical(entry.configDir);
    if (dirs.has(configDir)) throw new Error("Account profiles must have separate directories");
    ids.add(entry.id); dirs.add(configDir);
    accounts.push({ id: entry.id, label: entry.label.trim(), configDir, ...(entry.retired === true ? { retired: true as const } : {}) });
  }
  return accounts;
}

/** The profiles a person can choose: every one but the retired. */
export function offeredClaudeAccounts<T extends ClaudeAccount>(accounts: readonly T[]): T[] {
  return accounts.filter((account) => !account.retired);
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

export function addClaudeAccount(label: string, configDir?: string, file = accountStorePath(), defaultDir = defaultClaudeDir(), provider: "claude" | "codex" = "claude"): ClaudeAccount {
  const error = accountRequestError({ action: "add", label, ...(configDir ? { configDir } : {}) });
  if (error) throw new Error(error);
  const accounts = readClaudeAccounts(defaultDir, file);
  if (accounts.length >= 17) throw new Error("Conch supports up to 16 additional accounts per provider");
  if (accounts.some((account) => account.label.toLowerCase() === label.trim().toLowerCase())) throw new Error("Choose a different account name");
  const id = crypto.randomUUID();
  const account = { id, label: label.trim(), configDir: canonical(configDir ?? join(dirname(file), provider, id)) };
  if (accounts.some((existing) => canonical(existing.configDir) === account.configDir)) throw new Error("That directory is already registered");
  save([...accounts, account], file);
  return account;
}

/** Remove only Conch's label/registration. Never remove Claude files or sign anyone out. */
export function removeClaudeAccount(id: string, file = accountStorePath(), defaultDir = defaultClaudeDir()): void {
  if (id === "default") throw new Error("The default account cannot be removed");
  const accounts = readClaudeAccounts(defaultDir, file);
  if (!accounts.some((account) => account.id === id)) throw new Error("Account was not found");
  save(accounts.filter((account) => account.id !== id), file);
}

/**
 * Stop offering a profile, or offer it again (`retired` false). 2026-10-28, Tyler: "we should have one account for all
 * of conch I thought? (at least for mine)". Like removal it changes only conch's registration, never Claude's files or
 * sign-in; unlike removal its live sessions stay seen until they move, and its conversations stay resumable, in Default.
 */
export function retireClaudeAccount(id: string, retired = true, file = accountStorePath(), defaultDir = defaultClaudeDir()): ClaudeAccount {
  if (id === "default") throw new Error("The default account cannot be retired");
  const accounts = readClaudeAccounts(defaultDir, file);
  const account = accounts.find((one) => one.id === id);
  if (!account) throw new Error("Account was not found");
  const { retired: _, ...rest } = account;
  const changed: ClaudeAccount = retired ? { ...rest, retired: true } : rest;
  save(accounts.map((one) => one.id === id ? changed : one), file);
  return changed;
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
export async function readClaudeAccountStatus(account: ClaudeAccount, isolate = false): Promise<ClaudeAccountStatus> {
  try {
    const env = account.id === "default" ? { ...process.env } : claudeAccountEnvironment(account.configDir);
    if (isolate) for (const key of CLAUDE_ACCOUNT_ENV_REMOVE) delete env[key];
    const child = Bun.spawn(["claude", "auth", "status", "--json"], {
      env, cwd: conchHome(), stdout: "pipe", stderr: "ignore",
    });
    let timedOut = false;
    // SIGKILL, not SIGTERM: this awaits the exit, and a `claude` that ignored a TERM held its caller (a status line,
    // Settings' account list) for as long as it liked.
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 5_000);
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
