import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { conchHome } from "./home.ts";
import { accountStorePath, addClaudeAccount, readClaudeAccounts, removeClaudeAccount, validAccountId, type ClaudeAccount, type ClaudeAccountStatus } from "./claude-accounts.ts";
import type { SwapUsageAccount, UsageWindow } from "./claude-swap.ts";

export type CodexAccount = ClaudeAccount;
export type CodexAccountStatus = ClaudeAccountStatus & {
  authType?: string;
  /**
   * Why the status is "unavailable", in a sentence the app shows under it and the daemon files. Every failure here was
   * one bare "Status unavailable" until 2026-11-12, when Tyler said "my codex accounts … broken" and nothing anywhere
   * said what had gone wrong: not the app, not the daemon's log, not errors.jsonl.
   */
  statusDetail?: string;
  /** Why usage couldn't be read when the account could. */
  usageDetail?: string;
};
export interface CodexAccountRead { account: CodexAccountStatus; usage: SwapUsageAccount }
export const codexAccountStorePath = () => join(dirname(accountStorePath()), "codex-accounts.json");
export const defaultCodexDir = () => process.env.CODEX_HOME ?? join(conchHome(), ".codex");
export const readCodexAccounts = (defaultDir = defaultCodexDir(), file = codexAccountStorePath()) => readClaudeAccounts(defaultDir, file);
export const addCodexAccount = (label: string, configDir?: string) => addClaudeAccount(label, configDir, codexAccountStorePath(), defaultCodexDir(), "codex");
export const removeCodexAccount = (id: string) => removeClaudeAccount(id, codexAccountStorePath(), defaultCodexDir());
export function requireCodexAccount(id: string): CodexAccount {
  const account = readCodexAccounts().find(account => account.id === id);
  if (!account) throw new Error("Codex account was removed or is unavailable. Choose an account again.");
  return account;
}
export function codexAccountForLaunch(request: { backend: string; codexAccountId?: string }): CodexAccount | undefined {
  if (request.codexAccountId === undefined) return;
  if (request.backend !== "codex" || !validAccountId(request.codexAccountId)) throw new Error("Choose a valid Codex account");
  return requireCodexAccount(request.codexAccountId);
}
export const CODEX_ACCOUNT_ENV_REMOVE = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "CODEX_AUTH_ID_TOKEN", "CODEX_WIF_PROVIDER", "CODEX_WIF_TOKEN_FILE"] as const;
export function codexAccountEnvironment(account: CodexAccount): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: account.configDir };
  if (account.id !== "default") {
    for (const key of CODEX_ACCOUNT_ENV_REMOVE) delete env[key];
  }
  return env;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const safeText = (v: unknown, max = 200): string | undefined => typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(v) ? v : undefined;

/**
 * The account types `account/read` answers with. `gcp` (Google Cloud Vertex AI, credentials managed outside Codex) is
 * new in codex-cli 0.167.2 (`app-server-protocol/src/protocol/v2/account.rs`); an account of a type conch doesn't know
 * is "unavailable" with the type named, never signed out.
 */
const CODEX_ACCOUNT_TYPES = ["chatgpt", "apiKey", "amazonBedrock", "gcp"];

/** Only official public account fields cross the daemon boundary. */
export function decodeCodexAccount(profile: CodexAccount, raw: unknown): CodexAccountStatus {
  if (!object(raw) || !("account" in raw)) {
    return { ...profile, status: "unavailable", statusDetail: "Codex answered account/read without an account field." };
  }
  if (raw.account === null) return { ...profile, status: "signed-out" };
  if (!object(raw.account) || !CODEX_ACCOUNT_TYPES.includes(String(raw.account.type))) {
    const type = object(raw.account) ? safeText(raw.account.type, 40) : undefined;
    return { ...profile, status: "unavailable",
      statusDetail: `Codex reports a kind of sign-in conch doesn't know${type ? ` ("${type}")` : ""}.` };
  }
  const email = safeText(raw.account.email);
  const plan = safeText(raw.account.planType);
  return { ...profile, status: "signed-in", authType: String(raw.account.type),
    ...(email ? { email } : {}), ...(plan ? { subscription: plan } : {}) };
}
export function decodeCodexUsage(account: CodexAccountStatus, raw: unknown, now = Date.now()): SwapUsageAccount {
  const windows: UsageWindow[] = [];
  if (object(raw)) {
    const buckets = object(raw.rateLimitsByLimitId) && Object.keys(raw.rateLimitsByLimitId).length
      ? Object.entries(raw.rateLimitsByLimitId).sort(([a], [b]) => a === "codex" ? -1 : b === "codex" ? 1 : a.localeCompare(b))
      : [["codex", raw.rateLimits]];
    for (const [id, bucket] of buckets.slice(0, 8)) {
      if (!object(bucket)) continue;
      for (const key of ["primary", "secondary"]) {
        const window = bucket[key];
        if (!object(window) || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0
          || typeof window.windowDurationMins !== "number" || !Number.isFinite(window.windowDurationMins) || window.windowDurationMins <= 0) continue;
        const minutes = window.windowDurationMins;
        const label = minutes % 1440 === 0 ? `${minutes / 1440} day` : minutes % 60 === 0 ? `${minutes / 60} hour` : `${minutes} min`;
        const reset = typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt) && window.resetsAt * 1000 > now && window.resetsAt * 1000 <= 8.64e15 ? new Date(window.resetsAt * 1000).toISOString() : undefined;
        if (typeof window.resetsAt === "number" && !reset) continue;
        windows.push({ name: id === "codex" ? label : `${safeText(bucket.limitName, 28) ?? safeText(id, 28) ?? "Model"} · ${label}`,
          pct: window.usedPercent, ...(reset ? { resetsAt: reset } : {}) });
      }
    }
  }
  return { id: account.id, number: 1, label: account.label, email: account.email ?? "", defaultLogin: account.id === "default",
    status: account.status === "signed-out" ? "no_credentials" : account.authType === "apiKey" ? "api_key" : windows.length ? "ok" : "unavailable",
    windows, ...(object(raw) ? { fetchedAt: new Date(now).toISOString() } : {}), lastGood: false };
}

/** Short-lived read-only app-server connection. Never starts/resumes a thread
 * or opens credential files. All account/usage network access stays in Codex. */
export async function readCodexAccount(profile: CodexAccount, executable = "codex", timeoutMs = 12_000): Promise<CodexAccountRead> {
  let account: CodexAccountStatus | undefined;
  let usage: unknown;
  let usageDetail: string | undefined;
  try {
    await withCodexAppServer(profile, "conch_accounts", async (call) => {
      account = decodeCodexAccount(profile, await call("account/read", { refreshToken: false }));
      if (account.authType === "chatgpt") {
        usage = await call("account/rateLimits/read").catch((error: Error) => { usageDetail = error.message; return undefined; });
      }
    }, { executable, timeoutMs });
  } catch (error) {
    // A successful identity read stands if only what came after it failed.
    if (!account) account = { ...profile, status: "unavailable", statusDetail: (error as Error).message };
  }
  const read = account ?? { ...profile, status: "unavailable" as const, statusDetail: "Codex closed before it answered account/read." };
  return { account: usageDetail ? { ...read, usageDetail } : read, usage: decodeCodexUsage(read, usage) };
}

/**
 * A short-lived app-server on stdio, in `profile`'s home: `talk` is handed `call` once it has initialized, and the
 * server is gone when `talk` settles or `timeoutMs` runs out, whichever is first. Throws when it couldn't be asked.
 * Never starts or resumes a thread; what is asked is the caller's (`readCodexAccount`, `readCodexHooks`).
 */
export async function withCodexAppServer<T>(
  profile: CodexAccount,
  clientName: string,
  talk: (call: (method: string, params?: unknown) => Promise<unknown>) => Promise<T>,
  { executable = "codex", timeoutMs = 12_000 }: { executable?: string; timeoutMs?: number } = {},
): Promise<T> {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (why?: string) => void }>();
  let failed = false;
  // Why the connection ended, for whatever was still waiting on it: a timeout, or Codex exiting (with the last line it
  // printed). Each used to reject with nothing, and the caller turned that into a bare "unavailable".
  let ended: string | undefined;
  const fail = (why?: string) => {
    if (!failed) ended = why;
    failed = true;
    for (const entry of pending.values()) entry.reject(ended);
    pending.clear();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastError = "";
  try {
    mkdirSync(profile.configDir, { recursive: true, mode: 0o700 });
    const start = () => Bun.spawn([executable, "app-server", "--listen", "stdio://"],
      { cwd: conchHome(), env: codexAccountEnvironment(profile), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    let proc: ReturnType<typeof start>;
    try {
      proc = start();
    } catch (error) {
      throw new Error((error as NodeJS.ErrnoException).code === "ENOENT"
        ? `conch couldn't find Codex to ask it (no \`${executable}\` on the daemon's PATH).`
        : `conch couldn't start Codex to ask it: ${(error as Error).message}`);
    }
    child = proc;
    timer = setTimeout(() => { fail(`Codex didn't answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}.`); proc.kill("SIGKILL"); }, timeoutMs);
    // Only its last line, and only to say why it stopped: Codex prints its own error there and nothing else conch needs.
    void (async () => {
      const decoder = new TextDecoder();
      let tail = "";
      try {
        for await (const chunk of proc.stderr) {
          tail = (tail + decoder.decode(chunk, { stream: true })).slice(-2_000);
          lastError = tail.split("\n").map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter(Boolean).pop() ?? "";
        }
      } catch {}
    })();
    let unreadable = false;
    const reading = (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      try {
        for await (const chunk of proc.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 1_048_576) throw new Error();
          for (let end; (end = buffer.indexOf("\n")) >= 0;) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            const message: unknown = JSON.parse(line);
            if (!object(message) || typeof message.id !== "number") continue;
            const entry = pending.get(message.id); pending.delete(message.id);
            if (message.error) {
              const said = object(message.error) ? safeText(message.error.message, 300) : undefined;
              entry?.reject(said ? `Codex refused it: ${said}` : "Codex refused it.");
            } else entry?.resolve(message.result);
          }
        }
      } catch {
        unreadable = true;
      } finally {
        // Give its last words a moment to arrive: stderr and stdout close in either order.
        await Bun.sleep(20);
        const said = lastError ? `: ${safeText(lastError.slice(0, 200), 200) ?? "(unreadable)"}` : ".";
        fail(unreadable ? "Codex answered with something that isn't JSON-RPC." : `Codex exited before it answered${said}`);
      }
    })();
    let id = 0;
    const call = (method: string, params: unknown = {}) => new Promise<unknown>((resolve, reject) => {
      const failure = (why?: string) => new Error(`Codex ${method} failed. ${why ?? "Codex closed the connection."}`);
      if (failed) { reject(failure(ended)); return; }
      const key = ++id;
      pending.set(key, { resolve, reject: (why) => reject(failure(why)) });
      proc.stdin.write(JSON.stringify({ id: key, method, params }) + "\n"); proc.stdin.flush();
    });
    await call("initialize", { clientInfo: { name: clientName, version: "1" }, capabilities: { experimentalApi: false, explicitGatewayOauth: true } });
    proc.stdin.write('{"method":"initialized"}\n'); proc.stdin.flush();
    const result = await talk(call);
    proc.kill(); await reading;
    return result;
  } finally { if (timer) clearTimeout(timer); child?.kill("SIGKILL"); if (child) await child.exited; }
}
const cache = new Map<string, { at: number; read: Promise<CodexAccountRead> }>();
export const invalidateCodexAccount = (account: CodexAccount) => cache.delete(JSON.stringify([account.id, account.configDir]));
export function cachedCodexAccount(account: CodexAccount, refresh = false): Promise<CodexAccountRead> {
  const key = JSON.stringify([account.id, account.configDir]);
  const old = cache.get(key);
  if (!refresh && old && Date.now() - old.at < 60_000) return old.read;
  const read = readCodexAccount(account);
  cache.set(key, { at: Date.now(), read });
  return read;
}
