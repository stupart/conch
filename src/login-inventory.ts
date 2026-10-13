import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { accountCapabilities } from "./account-tools.ts";
import type { AgentCapabilityEntity } from "./agent-capabilities.ts";
import { readBrowserProfiles, type BrowserProfile } from "./browser-profiles.ts";
import { cachedClaudeAccountStatus, defaultClaudeDir, readClaudeAccounts, type ClaudeAccount, type ClaudeAccountStatus } from "./claude-accounts.ts";
import { cachedCodexAccount, defaultCodexDir, readCodexAccounts, type CodexAccountStatus } from "./codex-accounts.ts";
import { CONTROL_FRAME_MAX_BYTES } from "./control-framing.ts";
import { conchHome } from "./home.ts";

/**
 * The logins inventory (phase 2 of accounts and logins, 2026-10-14): which CLIs, agents, MCP servers, plugins and
 * browser profiles this Mac has, and which are signed in, as whom. Tyler, 2026-10-09: "all logins are annoying; it
 * should know which CLIs, plugins and MCPs are installed and logged in."
 *
 * Read only. Nothing here signs in, signs out or changes a setting. Each record is shaped so it can later be reported to
 * Atlas as a row of its `logins` table (`account`, `device`, `surface`, `state`, `checked_at`): `kind` and `configDir`,
 * `via` or `scope` say which surface, and `state` and `checkedAt` are the rest.
 *
 * What it will never do:
 * - Put a secret anywhere. A CLI's answer is parsed inside its probe for the account alone and dropped; no flag that
 *   prints a token is ever passed; an account that looks like a token is refused (`identity`); nothing is logged but
 *   counts.
 * - Run anything that could ask. Each CLI runs with stdin closed, no terminal, a clean environment (no tokens from the
 *   daemon's) and an 8 s limit. 1Password's `op` can raise Touch ID, so it is only looked for. Supabase has no status
 *   command, so it is only looked for. AWS is only run when a profile is configured and none of them uses a credential
 *   process or MFA, which can ask.
 * - Read a credential store. MCP sign-ins are the agent's own, in the Keychain or its credentials file; where that can't
 *   be known without reading them, the state is `unknown`. Claude Code's record of the servers that asked it for sign-in
 *   (`mcp-needs-auth-cache.json`, server names and times only) is read; nothing else.
 */

export const LOGIN_KINDS = ["agent", "cli", "browser-profile", "mcp", "plugin"] as const;
export type LoginKind = (typeof LOGIN_KINDS)[number];
export const LOGIN_STATES = ["signed-in", "signed-out", "expired", "unknown"] as const;
export type LoginState = (typeof LOGIN_STATES)[number];

export interface LoginRecord {
  /** Stable for this login, so a row can be refreshed alone. */
  id: string;
  kind: LoginKind;
  /** The CLI's command, the agent (`claude`, `codex`), the MCP server's name, the plugin's id, or the profile's name. */
  tool: string;
  installed: boolean;
  state: LoginState;
  /** Who it is signed in as: an email or a username. Never a token. */
  account?: string;
  /** Where in the tool: a GitHub host, a Stripe profile, an agent profile, or an MCP server's or plugin's scope. */
  scope?: string;
  /** The folder the login lives in (`GH_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`, …). */
  configDir?: string;
  /** For an MCP server or a plugin: the agent profile it belongs to, as "Claude Code · Work". */
  via?: string;
  /** For an MCP server: stdio, http, sse, websocket. */
  transport?: string;
  /** Epoch ms this record was read. */
  checkedAt: number;
  detail?: string;
}

export interface LoginInventoryRequest {
  kind: "login-inventory";
  action: "list" | "refresh";
  /** With `refresh`: one row's id; only what produced it is read again. */
  id?: string;
}

export interface LoginInventoryReply {
  kind: "login-inventory";
  items: LoginRecord[];
  checkedAt: number;
  /** The list was cut to fit one control frame. */
  truncated?: true;
}

export const LOGIN_ITEMS_MAX = 600;
const LOGIN_ID_MAX = 512;
const TEXT_MAX = 300;
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * A token's shapes: GitHub's, Stripe's, Slack's, a JWT, an AWS key id, npm's, or any long unbroken run of key-like
 * characters. A parsed account or detail that matches is dropped, so a CLI that prints a token where its account
 * belongs can't put one on the wire.
 */
const TOKENISH = /\b(?:gh[opusr]_[A-Za-z0-9]{8,}|github_pat_|(?:sk|rk|pk)_(?:live|test)_|xox[abprs]-|eyJ[A-Za-z0-9_-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{12,}|npm_[A-Za-z0-9]{16,})|[A-Za-z0-9_\-+/=]{40,}/;

/** One printable line, trimmed, at most `max` characters. */
export function safeText(value: unknown, max = TEXT_MAX): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= max && !UNPRINTABLE.test(text) ? text : undefined;
}

/** An account or a detail as it may cross the wire: printable, short, and not shaped like a token. */
export function identity(value: unknown, max = 160): string | undefined {
  const text = safeText(value, max);
  return text && !TOKENISH.test(text) ? text : undefined;
}

const joinDetail = (...parts: Array<string | undefined | false>): string | undefined =>
  identity(parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" · "), TEXT_MAX);

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// MARK: - The wire

const validLoginId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= LOGIN_ID_MAX && !UNPRINTABLE.test(value);

export function loginInventoryRequestError(value: Record<string, unknown>): string | undefined {
  if (value.action !== "list" && value.action !== "refresh") return 'login-inventory action must be "list" or "refresh"';
  if (value.id !== undefined && (value.action !== "refresh" || !validLoginId(value.id))) return "login-inventory id names one login, to refresh it";
}

function isLoginRecord(value: unknown): value is LoginRecord {
  if (!record(value)) return false;
  const optional = (key: string, max = TEXT_MAX) => value[key] === undefined || safeText(value[key], max) !== undefined;
  return validLoginId(value.id)
    && (LOGIN_KINDS as readonly string[]).includes(String(value.kind))
    && safeText(value.tool, 200) !== undefined
    && typeof value.installed === "boolean"
    && (LOGIN_STATES as readonly string[]).includes(String(value.state))
    && typeof value.checkedAt === "number" && Number.isFinite(value.checkedAt)
    && optional("account", 200) && optional("scope", 200) && optional("configDir", 4096)
    && optional("via", 200) && optional("transport", 40) && optional("detail");
}

export function isLoginInventoryReply(value: unknown): value is LoginInventoryReply {
  return record(value) && value.kind === "login-inventory"
    && Array.isArray(value.items) && value.items.length <= LOGIN_ITEMS_MAX && value.items.every(isLoginRecord)
    && typeof value.checkedAt === "number" && Number.isFinite(value.checkedAt)
    && (value.truncated === undefined || value.truncated === true);
}

/** Small enough for one control frame (64 KiB): details go first, then rows from the end (plugins, then MCP servers). */
export function fitLoginInventoryReply(reply: LoginInventoryReply, maxBytes = CONTROL_FRAME_MAX_BYTES - 1024): LoginInventoryReply {
  const size = (value: LoginInventoryReply) => Buffer.byteLength(JSON.stringify(value)) + 1;
  let items = reply.items.slice(0, LOGIN_ITEMS_MAX);
  let fitted: LoginInventoryReply = items.length === reply.items.length ? reply : { ...reply, items, truncated: true };
  if (size(fitted) <= maxBytes) return fitted;
  items = items.map(({ detail: _detail, ...rest }) => rest);
  fitted = { ...reply, items, truncated: true };
  while (items.length && size(fitted) > maxBytes) {
    items = items.slice(0, Math.floor(items.length * 0.9));
    fitted = { ...reply, items, truncated: true };
  }
  return fitted;
}

const KIND_ORDER = new Map<LoginKind, number>(LOGIN_KINDS.map((kind, index) => [kind, index]));
export function sortLogins(items: readonly LoginRecord[]): LoginRecord[] {
  return [...items].sort((a, b) => (KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)!)
    || Number(b.installed) - Number(a.installed)
    || a.tool.localeCompare(b.tool)
    || (a.via ?? "").localeCompare(b.via ?? "")
    || (a.scope ?? "").localeCompare(b.scope ?? "")
    || (a.account ?? "").localeCompare(b.account ?? ""));
}

// MARK: - Running a CLI

export interface ProbeOutput {
  /** Null when it was killed or couldn't start. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ProbeRunner = (binary: string, args: readonly string[], env: Record<string, string>) => Promise<ProbeOutput>;

export const PROBE_TIMEOUT_MS = 8_000;
const PROBE_OUTPUT_MAX = 256 * 1024;

/**
 * Not secrets: where each CLI keeps its config, so a login moved by one of these is still found. Every token variable
 * (`GH_TOKEN`, `VERCEL_TOKEN`, `NPM_TOKEN`, `AWS_ACCESS_KEY_ID`, …) is left out: what is reported is the login a CLI
 * keeps, not one the daemon happened to inherit.
 */
const PASSED_THROUGH = [
  "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "GH_CONFIG_DIR", "CLOUDSDK_CONFIG", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "NPM_CONFIG_USERCONFIG",
] as const;

/** Every CLI here, told not to ask, not to colour, not to check for updates and not to page. */
const QUIET: Record<string, string> = {
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  TERM: "dumb",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_SPINNER_DISABLED: "1",
  NO_UPDATE_NOTIFIER: "1",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
  AWS_PAGER: "",
  FLY_NO_UPDATE_CHECK: "1",
  WRANGLER_SEND_METRICS: "false",
  VERCEL_TELEMETRY_DISABLED: "1",
  NETLIFY_TELEMETRY_DISABLED: "1",
};

/** Where a CLI may be installed beyond the daemon's PATH: Homebrew, npm and pnpm globals, Volta, fly's and gcloud's own. */
export function probeSearchPath(env: NodeJS.ProcessEnv = process.env, home: string = conchHome()): string[] {
  const extra = [
    "/opt/homebrew/bin", "/usr/local/bin", join(home, ".local/bin"), join(home, ".bun/bin"), join(home, ".fly/bin"),
    join(home, ".npm-global/bin"), join(home, ".volta/bin"), join(home, "Library/pnpm"), join(home, ".local/share/pnpm"),
    join(home, ".yarn/bin"), join(home, "google-cloud-sdk/bin"), "/opt/homebrew/share/google-cloud-sdk/bin",
    "/usr/local/share/google-cloud-sdk/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ];
  return [...new Set([...(env.PATH ?? "").split(":").filter((dir) => dir.startsWith("/")), ...extra])];
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}

export function findBinary(names: readonly string[], dirs: readonly string[], executable: (path: string) => boolean = isExecutable): string | undefined {
  for (const name of names) for (const dir of dirs) {
    const path = join(dir, name);
    if (executable(path)) return path;
  }
  return undefined;
}

/** A CLI's environment: HOME, a PATH with its own folder first (an npm-installed CLI finds its node), and nothing secret. */
export function probeEnvironment(binary: string, dirs: readonly string[], env: NodeJS.ProcessEnv = process.env, home: string = conchHome()): Record<string, string> {
  const clean: Record<string, string> = { HOME: home, PATH: [...new Set([dirname(binary), ...dirs])].join(":") };
  for (const key of PASSED_THROUGH) {
    const value = env[key];
    if (typeof value === "string" && value) clean[key] = value;
  }
  return { ...clean, ...QUIET };
}

async function readCapped(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for await (const chunk of stream) {
    // Keep draining past the cap, so a chatty CLI never blocks on a full pipe; only the first part is kept.
    if (size < PROBE_OUTPUT_MAX) text += decoder.decode(chunk.subarray(0, PROBE_OUTPUT_MAX - size), { stream: true });
    size += chunk.byteLength;
  }
  return text + decoder.decode();
}

/**
 * One run: stdin closed (/dev/null, so a prompt reads end-of-file), no terminal, the clean environment, killed at the
 * limit. What it printed goes only to its parser.
 */
export async function runProbe(binary: string, args: readonly string[], env: Record<string, string>, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeOutput> {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc?.kill("SIGKILL"); }, timeoutMs);
  try {
    proc = Bun.spawn([binary, ...args], { cwd: tmpdir(), env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      readCapped(proc.stdout as ReadableStream<Uint8Array>),
      readCapped(proc.stderr as ReadableStream<Uint8Array>),
    ]);
    const code = await proc.exited;
    return { code: timedOut ? null : code, stdout, stderr, timedOut };
  } catch {
    return { code: null, stdout: "", stderr: "", timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** Colours, cursor moves and links a CLI printed anyway. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

// MARK: - What each CLI says

export interface CliFinding {
  state: LoginState;
  account?: string;
  scope?: string;
  detail?: string;
}

function parseJson(text: string): unknown {
  const trimmed = stripAnsi(text).trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

const said = (out: ProbeOutput) => stripAnsi(`${out.stdout}\n${out.stderr}`);
/** An IAM or STS ARN: an identity, not a secret, though an SSO role's name is a long unbroken run. */
const ARN = /^arn:aws[\w-]*:(?:iam|sts)::\d{12}:[\w+=,.@/-]{1,200}$/;
/** A finding, every field checked: printable, short, and (but for an ARN) not shaped like a token. */
const finding = (state: LoginState, fields: { account?: unknown; scope?: unknown; detail?: unknown } = {}): CliFinding => {
  const account = typeof fields.account === "string" && ARN.test(fields.account) ? safeText(fields.account) : identity(fields.account);
  const scope = identity(fields.scope, 120);
  const detail = identity(fields.detail, TEXT_MAX);
  return { state, ...(account ? { account } : {}), ...(scope ? { scope } : {}), ...(detail ? { detail } : {}) };
};

/** A failure in words: signed out, expired, or not recognised (null). */
function failure(out: ProbeOutput, signedOut: RegExp, expired: RegExp): CliFinding[] | null {
  const text = said(out);
  if (expired.test(text)) return [finding("expired", { detail: "its login has expired; sign in again" })];
  if (signedOut.test(text)) return [finding("signed-out")];
  return null;
}

const UNKNOWN_FLAG = /unknown (?:or unexpected )?(?:flag|option)|unrecognized (?:flag|option)|invalid option/i;

/** `gh auth status --json hosts`: every account on every host, which is active, and whether its token still works. */
export function parseGhAuthJson(out: ProbeOutput): CliFinding[] | null {
  if (UNKNOWN_FLAG.test(out.stderr)) return null;
  const value = parseJson(out.stdout);
  if (!record(value) || !record(value.hosts)) {
    return /not logged in(?:to)? any/i.test(said(out)) ? [finding("signed-out")] : null;
  }
  const found: CliFinding[] = [];
  for (const [host, entries] of Object.entries(value.hosts)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!record(entry)) continue;
      const state: LoginState = entry.state === "success" ? "signed-in" : entry.state === "error" ? "expired" : "unknown";
      found.push(finding(state, {
        account: entry.login,
        scope: typeof entry.host === "string" ? entry.host : host,
        detail: joinDetail(entry.active === true ? "active" : "not active",
          state === "expired" ? "its token no longer works; run gh auth login" : state === "unknown" ? "GitHub didn't answer" : undefined),
      }));
    }
  }
  return found.length ? found : [finding("signed-out")];
}

/** `gh auth status` from before `--json`: the ✓ and X lines, never the token line. */
export function parseGhAuthText(out: ProbeOutput): CliFinding[] | null {
  const text = said(out);
  if (/not logged in(?:to)? any/i.test(text)) return [finding("signed-out")];
  const found: CliFinding[] = [];
  for (const line of text.split("\n")) {
    const ok = /^\s*[✓✔]\s+Logged in to (\S+) (?:account|as) ([^\s(]+)/.exec(line);
    const bad = /^\s*[X✗×]\s+(?:Failed to log in to|Authentication failed for) (\S+?)(?: account ([^\s(]+))?(?:\s|$)/.exec(line);
    if (ok) found.push(finding("signed-in", { account: ok[2], scope: ok[1] }));
    else if (bad) found.push(finding("expired", { account: bad[2], scope: bad[1], detail: "its token no longer works; run gh auth login" }));
    else if (/^\s*-\s*Active account:\s*true/i.test(line) && found.length) {
      const last = found[found.length - 1]!;
      found[found.length - 1] = { ...last, detail: joinDetail("active", last.detail) ?? "active" };
    }
  }
  return found.length ? found : null;
}

const VERCEL_OUT = /No existing credentials|not (?:currently )?logged in|run `?vercel login|You must (?:first )?log in/i;
const VERCEL_EXPIRED = /token (?:is )?(?:not valid|invalid|expired)|has expired|re-?authenticate/i;

/** `vercel whoami --format json`, then plain `vercel whoami` for a CLI from before `--format`. */
export function parseVercelWhoami(out: ProbeOutput, attempt: number): CliFinding[] | null {
  if (attempt === 0) {
    if (UNKNOWN_FLAG.test(said(out))) return null;
    const value = parseJson(out.stdout);
    if (out.code === 0 && record(value) && (typeof value.username === "string" || typeof value.email === "string")) {
      const team = record(value.team) ? safeText(value.team.slug, 100) ?? safeText(value.team.name, 100) : undefined;
      const email = identity(value.email);
      const username = identity(value.username);
      return [finding("signed-in", { account: email ?? username, detail: joinDetail(email && username ? username : undefined, team && `team ${team}`) })];
    }
    return failure(out, VERCEL_OUT, VERCEL_EXPIRED);
  }
  const last = stripAnsi(out.stdout).trim().split("\n").pop()?.trim();
  if (out.code === 0 && last && /^[\w.@+-]{1,100}$/.test(last)) return [finding("signed-in", { account: last })];
  return failure(out, VERCEL_OUT, VERCEL_EXPIRED);
}

/** `wrangler whoami`: "You are logged in with an OAuth Token, associated with the email alex@example.com." */
export function parseWranglerWhoami(out: ProbeOutput): CliFinding[] | null {
  const text = said(out);
  if (/not authenticated|not logged in|run `?wrangler login/i.test(text)) return [finding("signed-out")];
  if (/(?:token|login) (?:has )?expired|failed to refresh/i.test(text)) return [finding("expired", { detail: "its login has expired; run wrangler login" })];
  const email = /associated with the email ([^\s@]+@[^\s]+?)\.?(?:\s|$)/i.exec(text)?.[1];
  const how = /logged in with an? ((?:[A-Za-z]+ )*?(?:Token|API Key))/i.exec(text)?.[1];
  if (email || how) return [finding("signed-in", { account: email, detail: how && how.replace(/\s+/g, " ") })];
  return null;
}

/** `fly auth whoami --json`: `{"email": …}`. */
export function parseFlyWhoami(out: ProbeOutput): CliFinding[] | null {
  const value = parseJson(out.stdout);
  if (out.code === 0 && record(value) && typeof value.email === "string") return [finding("signed-in", { account: value.email })];
  return failure(out, /no access token|not logged in|(?:fly|flyctl) auth login|please log ?in/i, /unauthori[sz]ed|token (?:has )?expired|invalid token|\b401\b/i);
}

/** `npm whoami`: the username for the default registry, or ENEEDAUTH, or E401 for a token npm refused. */
export function parseNpmWhoami(out: ProbeOutput): CliFinding[] | null {
  const name = stripAnsi(out.stdout).trim();
  if (out.code === 0 && /^[a-z0-9][\w.-]{0,213}$/i.test(name)) return [finding("signed-in", { account: name })];
  return failure(out, /\bENEEDAUTH\b|not logged in/i, /\bE40[13]\b|unauthori[sz]ed|token (?:has )?expired/i);
}

/** `gcloud auth list --format=json`: each credentialed account, and which is active. */
export function parseGcloudAuthList(out: ProbeOutput): CliFinding[] | null {
  const value = parseJson(out.stdout);
  if (out.code !== 0 || !Array.isArray(value)) return null;
  const found = value.filter(record).map((entry) => finding("signed-in", { account: entry.account, detail: entry.status === "ACTIVE" ? "active" : undefined }));
  return found.length ? found : [finding("signed-out")];
}

/** `aws sts get-caller-identity`: the ARN it runs as. */
export function parseAwsCallerIdentity(out: ProbeOutput): CliFinding[] | null {
  const value = parseJson(out.stdout);
  if (out.code === 0 && record(value) && typeof value.Arn === "string") {
    return [finding("signed-in", { account: value.Arn, scope: "default", detail: typeof value.Account === "string" ? `account ${value.Account}` : undefined })];
  }
  return failure(out, /Unable to locate credentials|could not be found|no credentials/i, /ExpiredToken|has expired|refresh failed|UnauthorizedSSOToken|sso session .* (?:invalid|expired)/i);
}

/** `railway whoami`: "Logged in as Alex (alex@example.com) 👋". */
export function parseRailwayWhoami(out: ProbeOutput): CliFinding[] | null {
  const text = said(out);
  const match = /Logged in as\s+(.+?)\s*(?:\(([^()\s]+@[^()\s]+)\))?\s*(?:👋)?\s*$/m.exec(text);
  if (match) return [finding("signed-in", { account: match[2] ?? match[1], detail: match[2] ? match[1] : undefined })];
  return failure(out, /unauthori[sz]ed|not logged in|please login|railway login/i, /(?:token|session) (?:has )?expired/i);
}

/** `netlify status`: its "Current Netlify User" block, or "Not logged in". */
export function parseNetlifyStatus(out: ProbeOutput): CliFinding[] | null {
  const value = parseJson(out.stdout);
  if (record(value) && record(value.account) && (typeof value.account.Email === "string" || typeof value.account.Name === "string")) {
    return [finding("signed-in", { account: value.account.Email ?? value.account.Name, detail: typeof value.account.Email === "string" ? value.account.Name as string : undefined })];
  }
  const text = said(out);
  if (/Not logged in|netlify login/i.test(text)) return [finding("signed-out")];
  const email = /^\s*Email:\s*(\S+@\S+)\s*$/m.exec(text)?.[1];
  if (email) return [finding("signed-in", { account: email, detail: /^\s*Name:\s*(.+?)\s*$/m.exec(text)?.[1] })];
  return null;
}

/** The fields of the Stripe CLI's config that name an account. The keys (`*_api_key`, `*_pub_key`) are never read. */
const STRIPE_FIELDS = new Set(["account_id", "display_name", "test_mode_key_expires_at", "live_mode_key_expires_at", "project-name"]);

/**
 * The Stripe CLI's `config.toml`, what `stripe config --list` prints, read line by line for STRIPE_FIELDS alone: each
 * profile with an account, which is active, and whether its login keys have expired (they last 90 days).
 */
export function parseStripeConfig(text: string, now: number): CliFinding[] {
  let section = "";
  let active = "default";
  const profiles = new Map<string, Record<string, string>>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) { section = header[1]!.replace(/^["']|["']$/g, ""); continue; }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!pair || !STRIPE_FIELDS.has(pair[1]!)) continue;
    const value = pair[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
    if (!section) { if (pair[1] === "project-name") active = value; continue; }
    const fields = profiles.get(section) ?? {};
    fields[pair[1]!] = value;
    profiles.set(section, fields);
  }
  const found: CliFinding[] = [];
  for (const [name, fields] of profiles) {
    if (!fields.account_id && !fields.display_name) continue;
    const expiries = [fields.test_mode_key_expires_at, fields.live_mode_key_expires_at]
      .map((date) => (date ? Date.parse(date) : NaN)).filter(Number.isFinite);
    const expired = expiries.length > 0 && expiries.every((at) => at < now);
    found.push(finding(expired ? "expired" : "signed-in", {
      account: fields.display_name || fields.account_id,
      scope: name,
      detail: joinDetail(name === active ? "active" : undefined, fields.display_name ? fields.account_id : undefined,
        expired ? "its keys have expired; run stripe login" : undefined),
    }));
  }
  return found.length ? found : [finding("signed-out")];
}

export interface ProbeContext {
  home: string;
  env: NodeJS.ProcessEnv;
  now: number;
  readText(path: string): string | undefined;
  exists(path: string): boolean;
}

/**
 * Whether `aws` may run: only with a profile configured, and never when any profile gets its credentials from a process
 * (which can be anything, 1Password's `op` among them) or asks for an MFA code. Undefined: run it.
 */
export function awsSkip(context: ProbeContext): CliFinding[] | undefined {
  const config = context.env.AWS_CONFIG_FILE ?? join(context.home, ".aws", "config");
  const credentials = context.env.AWS_SHARED_CREDENTIALS_FILE ?? join(context.home, ".aws", "credentials");
  const texts = [context.readText(config), context.readText(credentials)];
  if (texts.every((text) => text === undefined || !/^\s*\[[^\]]+\]/m.test(text))) return [finding("signed-out", { detail: "no profile configured" })];
  if (texts.some((text) => text !== undefined && /^\s*(?:credential_process|mfa_serial)\s*=/m.test(text))) {
    return [finding("unknown", { detail: "a profile uses a credential process or MFA, which can ask, so conch doesn't run aws" })];
  }
  const hasDefault = /^\s*\[\s*(?:profile\s+)?default\s*\]/m.test(texts[0] ?? "") || /^\s*\[\s*default\s*\]/m.test(texts[1] ?? "");
  if (!hasDefault) return [finding("unknown", { detail: "no default profile, so conch doesn't pick one to check" })];
  return undefined;
}

export interface CliProbe {
  tool: string;
  binaries: readonly string[];
  /** Each run's arguments, in order; a parse that answers null moves on to the next. */
  attempts?: readonly (readonly string[])[];
  parse?(out: ProbeOutput, attempt: number): CliFinding[] | null;
  /** Answered without running it: from its config file, or just that it's installed. */
  read?(context: ProbeContext): CliFinding[];
  /** Why not to run it now. */
  skip?(context: ProbeContext): CliFinding[] | undefined;
  configDir?(context: ProbeContext): string | undefined;
}

const firstExisting = (context: ProbeContext, ...paths: string[]): string | undefined => paths.find((path) => context.exists(path));
const xdgConfig = (context: ProbeContext) => context.env.XDG_CONFIG_HOME || join(context.home, ".config");

/** Every CLI conch looks for, and how each one's login is read. None is passed a flag that would print a token. */
export const CLI_PROBES: readonly CliProbe[] = [
  {
    tool: "gh", binaries: ["gh"],
    attempts: [["auth", "status", "--json", "hosts"], ["auth", "status"]],
    parse: (out, attempt) => (attempt === 0 ? parseGhAuthJson(out) : parseGhAuthText(out)),
    configDir: (c) => firstExisting(c, c.env.GH_CONFIG_DIR || join(xdgConfig(c), "gh")),
  },
  {
    tool: "vercel", binaries: ["vercel"],
    attempts: [["whoami", "--format", "json", "--non-interactive", "--no-color"], ["whoami", "--no-color"]],
    parse: parseVercelWhoami,
    configDir: (c) => firstExisting(c, join(c.home, "Library/Application Support/com.vercel.cli"), join(c.home, ".vercel")),
  },
  {
    tool: "wrangler", binaries: ["wrangler"],
    attempts: [["whoami"]], parse: parseWranglerWhoami,
    configDir: (c) => firstExisting(c, join(c.home, "Library/Preferences/.wrangler"), join(c.home, ".wrangler")),
  },
  {
    tool: "fly", binaries: ["fly", "flyctl"],
    attempts: [["auth", "whoami", "--json"]], parse: parseFlyWhoami,
    configDir: (c) => firstExisting(c, join(c.home, ".fly")),
  },
  {
    tool: "npm", binaries: ["npm"],
    attempts: [["whoami"]], parse: parseNpmWhoami,
    configDir: (c) => firstExisting(c, c.env.NPM_CONFIG_USERCONFIG || join(c.home, ".npmrc")),
  },
  {
    tool: "supabase", binaries: ["supabase"],
    read: () => [finding("unknown", { detail: "Supabase has no status command that can't ask, so conch only checks it's installed" })],
    configDir: (c) => firstExisting(c, join(c.home, ".supabase")),
  },
  {
    tool: "stripe", binaries: ["stripe"],
    // The file `stripe config --list` prints, read directly: no process, and so nothing that could reach the Keychain.
    read: (c) => {
      const text = c.readText(join(xdgConfig(c), "stripe", "config.toml"));
      return text === undefined ? [finding("signed-out")] : parseStripeConfig(text, c.now);
    },
    configDir: (c) => firstExisting(c, join(xdgConfig(c), "stripe")),
  },
  {
    tool: "gcloud", binaries: ["gcloud"],
    attempts: [["auth", "list", "--format=json"]], parse: parseGcloudAuthList,
    configDir: (c) => firstExisting(c, c.env.CLOUDSDK_CONFIG || join(c.home, ".config", "gcloud")),
  },
  {
    tool: "aws", binaries: ["aws"],
    attempts: [["sts", "get-caller-identity", "--output", "json", "--no-cli-pager"]], parse: parseAwsCallerIdentity, skip: awsSkip,
    configDir: (c) => firstExisting(c, join(c.home, ".aws")),
  },
  {
    tool: "railway", binaries: ["railway"],
    attempts: [["whoami"]], parse: parseRailwayWhoami,
    configDir: (c) => firstExisting(c, join(c.home, ".railway")),
  },
  {
    tool: "netlify", binaries: ["netlify", "ntl"],
    attempts: [["status"]], parse: parseNetlifyStatus,
    configDir: (c) => firstExisting(c, join(c.home, "Library/Preferences/netlify"), join(c.home, ".netlify")),
  },
  {
    tool: "op", binaries: ["op"],
    read: () => [finding("unknown", { detail: "1Password's op can ask for Touch ID, so conch only checks it's installed" })],
    configDir: (c) => firstExisting(c, join(xdgConfig(c), "op"), join(c.home, ".op")),
  },
];

function readTextFile(path: string): string | undefined {
  try {
    if (statSync(path).size > 1024 * 1024) return undefined;
    return readFileSync(path, "utf8");
  } catch { return undefined; }
}

export interface CliProbeDeps {
  run?: ProbeRunner;
  dirs?: readonly string[];
  executable?: (path: string) => boolean;
  context?: Partial<ProbeContext>;
}

/** One CLI's logins: not installed, answered without running it, or run and parsed. */
export async function probeCli(probe: CliProbe, deps: CliProbeDeps = {}): Promise<LoginRecord[]> {
  const context: ProbeContext = {
    home: conchHome(), env: process.env, now: Date.now(), readText: readTextFile, exists: existsSync, ...deps.context,
  };
  const dirs = deps.dirs ?? probeSearchPath(context.env, context.home);
  const binary = findBinary(probe.binaries, dirs, deps.executable);
  const base = { kind: "cli" as const, tool: probe.tool, checkedAt: context.now };
  if (!binary) return [{ ...base, id: `cli:${probe.tool}`, installed: false, state: "signed-out", detail: "not installed" }];
  const configDir = probe.configDir?.(context);
  let findings: CliFinding[] | undefined = probe.read?.(context) ?? probe.skip?.(context);
  if (!findings) {
    const run = deps.run ?? runProbe;
    const env = probeEnvironment(binary, dirs, context.env, context.home);
    let last: ProbeOutput | undefined;
    for (const [attempt, args] of (probe.attempts ?? []).entries()) {
      last = await run(binary, args, env);
      const parsed = probe.parse?.(last, attempt) ?? null;
      if (parsed !== null) { findings = parsed; break; }
      if (last.timedOut) break;
    }
    if (!findings?.length) {
      findings = [finding("unknown", { detail: last?.timedOut ? `didn't answer within ${PROBE_TIMEOUT_MS / 1000} s` : "conch couldn't read its answer" })];
    }
  }
  const checkedAt = context.now;
  return findings.map((found) => ({
    ...base,
    id: ["cli", probe.tool, found.scope, found.account].filter(Boolean).join(":").slice(0, LOGIN_ID_MAX),
    installed: true,
    state: found.state,
    ...(found.account ? { account: found.account } : {}),
    ...(found.scope ? { scope: found.scope } : {}),
    ...(configDir ? { configDir } : {}),
    checkedAt,
    ...(found.detail ? { detail: found.detail } : {}),
  }));
}

// MARK: - Agents, and their MCP servers and plugins

type Backend = "claude" | "codex";
const agentName = (backend: Backend) => (backend === "claude" ? "Claude Code" : "Codex");

/**
 * Claude Code's record of the MCP servers that asked it to sign in: `{ "<server>": { "timestamp": <ms> } }`, server
 * names and times only, in the profile's config folder. Written when a server answers that it needs authorization, and
 * the entry deleted when it's authorized. Anything else in the file is ignored.
 */
export function readNeedsAuth(configDir: string, read: (path: string) => string | undefined = readTextFile): Map<string, number> {
  const found = new Map<string, number>();
  let value: unknown;
  try { value = JSON.parse(read(join(configDir, "mcp-needs-auth-cache.json")) ?? "null"); } catch { return found; }
  if (!record(value)) return found;
  for (const [name, entry] of Object.entries(value).slice(0, 500)) {
    if (safeText(name, 200) && record(entry) && typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) found.set(name, entry.timestamp);
  }
  return found;
}

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function host(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).host || undefined; } catch { return undefined; }
}

const hash = (text: string) => Bun.hash(text).toString(36);

export interface CapabilityContext {
  backend: Backend;
  profile: Pick<ClaudeAccount, "id" | "label" | "configDir">;
  /** Claude Code's servers that asked to sign in (`readNeedsAuth`). */
  needsAuth: ReadonlyMap<string, number>;
  now: number;
  /** A project read: only its own servers and plugins are taken, the account's are in the account read. */
  project?: string;
}

/** An MCP server's sign-in, as far as it can be known without reading the token. */
function mcpLogin(entity: Extract<AgentCapabilityEntity, { kind: "mcp-server" }>, context: CapabilityContext): Pick<LoginRecord, "state" | "detail"> {
  const server = entity.mcpServer;
  const disabled = server.enabledForNextSession === false ? "disabled" : undefined;
  const where = host(server.url);
  const envs = server.credentialSources.filter((source) => source.startsWith("env:")).map((source) => source.slice(4));
  const headers = server.credentialSources.some((source) => source.startsWith("header:"));
  // Claude Code's own word that the server asked it to sign in comes first: a plugin's stdio server can ask too, and a
  // server with a key in its headers can still be refused.
  if (context.backend === "claude") {
    const plugin = server.ownerPluginId?.split("@")[0];
    const asked = context.needsAuth.get(entity.name) ?? (plugin ? context.needsAuth.get(`plugin:${plugin}:${entity.name}`) : undefined);
    if (asked !== undefined) {
      return { state: "signed-out", detail: joinDetail(disabled, where, `asked Claude Code to sign in ${ago(asked, context.now)}; use /mcp in a session`) };
    }
  }
  if (server.transport === "stdio") {
    return { state: "unknown", detail: joinDetail(disabled, "runs on this Mac", envs.length ? `keys from ${envs.slice(0, 3).join(", ")}` : "no sign-in of its own") };
  }
  if (envs.length || headers) {
    return { state: "unknown", detail: joinDetail(disabled, where, headers ? "a key in its headers" : `a key from ${envs.slice(0, 3).join(", ")}`) };
  }
  return { state: "unknown", detail: joinDetail(disabled, where, `OAuth if it asks; ${agentName(context.backend)} keeps the token, which conch doesn't read`) };
}

/** The inspector's plugins and MCP servers, as logins. Skills and tool policies aren't logins. */
export function capabilityLogins(entities: readonly AgentCapabilityEntity[], context: CapabilityContext): LoginRecord[] {
  const via = identity(`${agentName(context.backend)} · ${context.profile.label}`, 200);
  const folder = context.project ? identity(basename(context.project), 100) : undefined;
  const records: LoginRecord[] = [];
  const seen = new Set<string>();
  // The inspector's id is unique and stable (a plugin installed twice, a server from each install), but long: a hash of
  // it keeps this row's id unique and short.
  const idFor = (kind: "plugin" | "mcp", tool: string, entity: AgentCapabilityEntity) =>
    `${kind}:${context.backend}:${context.profile.id}:${tool}:${hash(entity.id)}`.slice(0, LOGIN_ID_MAX);
  for (const entity of entities) {
    // A project read takes that project's own servers. Plugins are the account's ledger, whatever the folder: they are
    // in the account read already, a project-scoped one too.
    if (context.project && (entity.kind === "plugin" || (entity.scope !== "project" && entity.scope !== "local"))) continue;
    const scope = identity(entity.scope, 40);
    if (entity.kind === "plugin") {
      const plugin = entity.plugin;
      const tool = identity(plugin.pluginId, 200);
      if (!tool) continue;
      const enabled = plugin.enabledForNextSession === true ? "enabled" : plugin.enabledForNextSession === false ? "disabled" : undefined;
      records.push({
        id: idFor("plugin", tool, entity),
        kind: "plugin", tool, installed: plugin.installed, state: "unknown",
        ...(scope ? { scope } : {}), configDir: context.profile.configDir, ...(via ? { via } : {}), checkedAt: context.now,
        ...optionalDetail(joinDetail(folder, plugin.version && `v${plugin.version}`, enabled,
          plugin.components.mcpServers ? `signs in through its ${plugin.components.mcpServers === 1 ? "MCP server" : `${plugin.components.mcpServers} MCP servers`}` : "no sign-in of its own")),
      });
    } else if (entity.kind === "mcp-server") {
      const tool = identity(entity.name, 200);
      if (!tool) continue;
      const login = mcpLogin(entity, context);
      records.push({
        id: idFor("mcp", tool, entity),
        kind: "mcp", tool, installed: true, state: login.state,
        ...(scope ? { scope } : {}), configDir: context.profile.configDir, ...(via ? { via } : {}),
        transport: entity.mcpServer.transport, checkedAt: context.now,
        ...optionalDetail(joinDetail(folder, entity.mcpServer.ownerPluginId && `from ${entity.mcpServer.ownerPluginId.split("@")[0]}`, login.detail)),
      });
    }
  }
  return records.filter((item) => !seen.has(item.id) && seen.add(item.id));
}

const optionalDetail = (detail: string | undefined) => (detail ? { detail } : {});

const CODEX_AUTH: Record<string, string> = { chatgpt: "ChatGPT", apiKey: "API key", amazonBedrock: "Amazon Bedrock" };

/** One agent profile's own sign-in, from the status the Providers section already reads. */
export function agentLogin(backend: Backend, status: ClaudeAccountStatus | CodexAccountStatus, installed: boolean, now: number): LoginRecord {
  const state: LoginState = status.status === "signed-in" ? "signed-in" : status.status === "signed-out" ? "signed-out" : "unknown";
  const account = identity(status.email) ?? (backend === "codex" && status.authType === "apiKey" && state === "signed-in" ? "API key" : undefined);
  const scope = identity(status.label, 100);
  return {
    id: `agent:${backend}:${status.id}`,
    kind: "agent", tool: backend, installed, state,
    ...(account ? { account } : {}), ...(scope ? { scope } : {}), configDir: status.configDir, checkedAt: now,
    ...optionalDetail(installed
      ? joinDetail(backend === "codex" && status.authType ? CODEX_AUTH[status.authType] : undefined, identity(status.subscription, 60),
        state === "unknown" ? "couldn't read its status" : undefined)
      : "not installed"),
  };
}

// MARK: - The inventory

export interface LoginSource {
  key: string;
  run(refresh: boolean): Promise<LoginRecord[]>;
}

/** A session conch is running: its account's project-scoped servers are read for its folder. */
export interface LoginProject {
  backend: Backend;
  accountId: string;
  cwd: string;
}

/** The live sessions' folders, each with the account its agent runs as. */
export function loginProjects(sessions: Iterable<{ backend?: Backend; claudeAccountId?: string; codexAccountId?: string; cwd?: string }>): LoginProject[] {
  const projects: LoginProject[] = [];
  for (const session of sessions) {
    if (!session.cwd) continue;
    const backend = session.backend ?? "claude";
    projects.push({ backend, accountId: (backend === "codex" ? session.codexAccountId : session.claudeAccountId) ?? "default", cwd: session.cwd });
  }
  return projects;
}

export interface LoginSourceDeps {
  claudeDir?: string;
  claudeAccounts?(): ClaudeAccount[];
  codexAccounts?(): ClaudeAccount[];
  claudeStatus?(account: ClaudeAccount, refresh: boolean): Promise<ClaudeAccountStatus>;
  codexStatus?(account: ClaudeAccount, refresh: boolean): Promise<CodexAccountStatus>;
  capabilities?(backend: Backend, account: ClaudeAccount, cwd?: string): readonly AgentCapabilityEntity[];
  needsAuth?(configDir: string): Map<string, number>;
  browserProfiles?(): BrowserProfile[];
  projects?(): LoginProject[];
  probes?: readonly CliProbe[];
  cli?: CliProbeDeps;
  now?(): number;
}

/** Let the event loop turn between synchronous reads, so a long inventory never holds it. */
const yieldToLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const PROJECTS_MAX = 12;

/** Everything the inventory reads, one source per CLI, per agent profile, and the browser profiles. */
export function loginSources(deps: LoginSourceDeps = {}): LoginSource[] {
  const now = deps.now ?? Date.now;
  const capabilities = deps.capabilities ?? ((backend, account, cwd) => accountCapabilities(backend, account, cwd).entities);
  const needsAuth = deps.needsAuth ?? ((dir) => readNeedsAuth(dir));
  const dirs = deps.cli?.dirs ?? probeSearchPath();
  const installed = (name: string) => findBinary([name], dirs, deps.cli?.executable) !== undefined;
  const sources: LoginSource[] = (deps.probes ?? CLI_PROBES).map((probe) => ({
    key: `cli:${probe.tool}`,
    run: () => probeCli(probe, { ...deps.cli, dirs, context: { ...deps.cli?.context, now: now() } }),
  }));
  const profiles = (backend: Backend): ClaudeAccount[] => {
    try {
      return backend === "claude" ? (deps.claudeAccounts ?? (() => readClaudeAccounts(deps.claudeDir)))() : (deps.codexAccounts ?? (() => readCodexAccounts()))();
    } catch {
      // A profile list Providers can't read either (it says why there): the default profile is still this Mac's.
      return [{ id: "default", label: "Default", configDir: resolve(backend === "claude" ? deps.claudeDir ?? defaultClaudeDir() : defaultCodexDir()) }];
    }
  };
  for (const backend of ["claude", "codex"] as const) {
    const has = installed(backend);
    for (const profile of profiles(backend)) {
      sources.push({
        key: `agent:${backend}:${profile.id}`,
        run: async (refresh) => {
          let status: ClaudeAccountStatus | CodexAccountStatus = { ...profile, status: "unavailable" };
          if (has) {
            try {
              status = backend === "claude"
                ? await (deps.claudeStatus ?? cachedClaudeAccountStatus)(profile, refresh)
                : await (deps.codexStatus ?? (async (account, again) => (await cachedCodexAccount(account, again)).account))(profile, refresh);
            } catch { /* unknown, as an unavailable status */ }
          }
          const at = now();
          const records = [agentLogin(backend, status, has, at)];
          const asked = backend === "claude" ? needsAuth(profile.configDir) : new Map<string, number>();
          await yieldToLoop();
          try {
            records.push(...capabilityLogins(capabilities(backend, profile), { backend, profile, needsAuth: asked, now: at }));
          } catch { /* the account's own row still stands */ }
          const folders = [...new Set((deps.projects?.() ?? [])
            .filter((project) => project.backend === backend && project.accountId === profile.id && project.cwd.startsWith("/"))
            .map((project) => project.cwd))].slice(0, PROJECTS_MAX);
          const seen = new Set(records.map((item) => item.id));
          for (const project of folders) {
            await yieldToLoop();
            try {
              for (const item of capabilityLogins(capabilities(backend, profile, project), { backend, profile, needsAuth: asked, now: at, project })) {
                if (!seen.has(item.id)) { seen.add(item.id); records.push(item); }
              }
            } catch { /* one folder unreadable is that folder's */ }
          }
          return records;
        },
      });
    }
  }
  sources.push({
    key: "browser-profiles",
    run: async () => {
      const at = now();
      return (deps.browserProfiles ?? (() => readBrowserProfiles()))().map((profile) => ({
        id: `browser-profile:${profile.id}`,
        kind: "browser-profile" as const,
        tool: profile.name,
        installed: true,
        state: "unknown" as const,
        ...(profile.id === "default" ? { scope: "default" } : {}),
        checkedAt: at,
        detail: profile.id === "default"
          ? "conch's own browser and review pane; who it's signed in as stays in its cookies"
          : "its own cookies; who it's signed in as stays in them",
      }));
    },
  });
  return sources;
}

/** Up to `limit` at once, results in the order given. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(lanes);
  return results;
}

export interface LoginInventoryOptions {
  sources(): LoginSource[];
  now?(): number;
  /** How long `list` answers from the cache. */
  ttlMs?: number;
  /** A refresh of everything this soon after the last is answered from the cache (a double click, two windows). */
  minRefreshMs?: number;
  /** Probes at once. */
  concurrency?: number;
  log?(line: string): void;
}

export const LOGIN_INVENTORY_TTL_MS = 5 * 60_000;
export const LOGIN_INVENTORY_MIN_REFRESH_MS = 15_000;
export const LOGIN_INVENTORY_CONCURRENCY = 4;

export interface LoginInventory {
  handle(request: LoginInventoryRequest): Promise<LoginInventoryReply>;
}

/**
 * The cache: `list` reads everything once and then answers from memory for five minutes; `refresh` reads again (not
 * within 15 s of the last full read), or, with an id, reads only the source that row came from. One read at a time per
 * source: a second ask while one runs waits for it.
 */
export function createLoginInventory(options: LoginInventoryOptions): LoginInventory {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? LOGIN_INVENTORY_TTL_MS;
  const minRefresh = options.minRefreshMs ?? LOGIN_INVENTORY_MIN_REFRESH_MS;
  const limit = options.concurrency ?? LOGIN_INVENTORY_CONCURRENCY;
  let items = new Map<string, LoginRecord[]>();
  let checkedAt: number | undefined;
  let scanning: Promise<void> | undefined;
  const running = new Map<string, Promise<LoginRecord[]>>();

  const runSource = (source: LoginSource, refresh: boolean): Promise<LoginRecord[]> => {
    const current = running.get(source.key);
    if (current) return current;
    const run = source.run(refresh)
      .catch(() => items.get(source.key) ?? [])
      .finally(() => running.delete(source.key));
    running.set(source.key, run);
    return run;
  };

  const scan = (refresh: boolean): Promise<void> => {
    scanning ??= (async () => {
      const started = now();
      const sources = options.sources();
      const results = await mapLimit(sources, limit, async (source) => [source.key, await runSource(source, refresh)] as const);
      items = new Map(results);
      checkedAt = now();
      const count = results.reduce((total, [, found]) => total + found.length, 0);
      options.log?.(`login inventory: ${count} logins from ${sources.length} sources in ${checkedAt - started} ms`);
    })().finally(() => { scanning = undefined; });
    return scanning;
  };

  const reply = (): LoginInventoryReply => fitLoginInventoryReply({
    kind: "login-inventory",
    items: sortLogins([...items.values()].flat()),
    checkedAt: checkedAt ?? now(),
  });

  return {
    async handle(request) {
      if (request.action === "refresh" && request.id !== undefined && checkedAt !== undefined) {
        const key = [...items].find(([, found]) => found.some((item) => item.id === request.id))?.[0];
        const source = key ? options.sources().find((candidate) => candidate.key === key) : undefined;
        if (source) {
          items.set(source.key, await runSource(source, true));
          return reply();
        }
      }
      const age = checkedAt === undefined ? Infinity : now() - checkedAt;
      if (age >= (request.action === "refresh" ? minRefresh : ttl)) await scan(request.action === "refresh");
      else if (scanning) await scanning;
      return reply();
    },
  };
}

// MARK: - `conch logins`

const GROUP_TITLES: Record<LoginKind, string> = {
  agent: "Agents", cli: "CLIs", "browser-profile": "Browser profiles", mcp: "MCP servers", plugin: "Plugins",
};
const STATE_WORDS: Record<LoginState, string> = { "signed-in": "signed in", "signed-out": "signed out", expired: "expired", unknown: "unknown" };

const clip = (text: string, width: number) => (text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`);

/** The inventory as a table for a terminal: a block per kind, its rows' tool, where, account, state and detail. */
export function formatLoginTable(reply: LoginInventoryReply, now: number = Date.now()): string[] {
  const lines = [`Logins on this Mac · checked ${ago(reply.checkedAt, now)}${reply.truncated ? " · cut to fit; see the Mac app" : ""}`];
  for (const kind of LOGIN_KINDS) {
    const all = reply.items.filter((item) => item.kind === kind);
    if (!all.length) continue;
    const rows = all.filter((item) => item.installed);
    const missing = all.filter((item) => !item.installed).map((item) => item.tool);
    lines.push("", GROUP_TITLES[kind]);
    const cells = rows.map((item) => [
      item.tool,
      [item.via, item.scope, item.transport].filter(Boolean).join(" · "),
      item.account ?? "—",
      STATE_WORDS[item.state],
      item.detail ?? "",
    ]);
    const widths = [28, 42, 34, 10].map((max, column) => Math.min(max, Math.max(0, ...cells.map((cell) => cell[column]!.length))));
    for (const cell of cells) {
      lines.push(`  ${cell.slice(0, 4).map((text, column) => clip(text, widths[column]!).padEnd(widths[column]!)).join("  ")}  ${clip(cell[4]!, 90)}`.trimEnd());
    }
    if (!rows.length) lines.push("  none installed");
    if (missing.length) lines.push(`  not installed: ${missing.join(", ")}`);
  }
  return lines;
}
