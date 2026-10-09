import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_ACCOUNT_ENV_REMOVE, type ClaudeAccount } from "./claude-accounts.ts";

/**
 * Claude's sign-in, inside conch rather than your browser (2026-10-09). Tyler's Default profile ended up signed in as
 * his other account because Claude's sign-in page uses whichever claude.ai login the browser already has; he asked for
 * "popup ui for me too in the deliverables area and i can login there".
 *
 * `claude auth login` is Anthropic's own flow, unchanged: it opens its authorize URL with `open`, and listens on
 * `http://localhost:<port>/callback` for the code. Here `open` is a shim that hands the URL to conch instead, the Mac shows
 * it in a web view with no cookies of its own, and the callback reaches Claude's listener from there, which finishes the
 * sign-in and writes the credential where it always does. conch never sees a password or a token: only the authorize
 * URL, which carries a PKCE challenge, not a secret.
 */

/** Only Anthropic's own sign-in pages are shown. */
const SIGN_IN_HOSTS = new Set(["claude.com", "claude.ai", "platform.claude.com", "console.anthropic.com"]);

export function isClaudeSignInURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && SIGN_IN_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** The authorize URL among the arguments `open` was called with: the last https argument on an Anthropic host. */
export function signInURLFrom(recorded: string): string | undefined {
  const urls = recorded.split(/\s+/).filter((word) => word.startsWith("https://"));
  return urls.reverse().find(isClaudeSignInURL);
}

/**
 * The environment the login runs in: the profile's, as a session for this account gets it (`claudeProfileCommandPrefix`),
 * with `open` and `BROWSER` pointing at the shim.
 */
export function claudeWebLoginEnvironment(
  account: Pick<ClaudeAccount, "id" | "configDir">,
  shimDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (account.id !== "default") for (const key of CLAUDE_ACCOUNT_ENV_REMOVE) delete env[key];
  // An unset default stays unset: naming ~/.claude explicitly can select a different Keychain entry.
  if (account.id === "default" && base.CLAUDE_CONFIG_DIR === undefined) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = account.configDir;
  env.PATH = `${shimDir}:${base.PATH ?? "/usr/bin:/bin"}`;
  env.BROWSER = join(shimDir, "open");
  return env;
}

export interface ClaudeWebLogin {
  /** Anthropic's authorize URL, for the Mac to show. */
  url: string;
  /** Resolves with `claude auth login`'s exit code: 0 once the sign-in has finished. */
  done: Promise<number>;
  cancel(): void;
}

const running = new Map<string, ClaudeWebLogin>();

/**
 * Starts `claude auth login` for this account and returns its authorize URL once `open` is called with it, or null if it
 * never is (the caller falls back to Terminal). One per account: a new one cancels the last. The login gives up after
 * `timeoutMs` if nobody signs in.
 */
export async function startClaudeWebLogin(
  account: ClaudeAccount,
  options: { executable?: string; email?: string; urlWithinMs?: number; timeoutMs?: number; spawn?: typeof Bun.spawn } = {},
): Promise<ClaudeWebLogin | null> {
  running.get(account.id)?.cancel();
  const dir = mkdtempSync(join(tmpdir(), "conch-signin-"));
  chmodSync(dir, 0o700);
  const recorded = join(dir, "opened");
  const shim = join(dir, "open");
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${recorded.replace(/'/g, "'\\''")}'\n`, { mode: 0o700 });
  const spawn = options.spawn ?? Bun.spawn;
  const child = spawn([options.executable ?? "claude", "auth", "login", "--claudeai", ...(options.email ? ["--email", options.email] : [])], {
    env: claudeWebLoginEnvironment(account, dir),
    // Kept open: Claude also offers to read a pasted code from here, and must not see end of input.
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  let finished = false;
  const cleanup = () => {
    finished = true;
    rmSync(dir, { recursive: true, force: true });
    if (running.get(account.id) === login) running.delete(account.id);
  };
  const cancel = () => {
    if (!finished) child.kill();
  };
  const done = child.exited.then((code) => {
    cleanup();
    return code;
  });
  const login: ClaudeWebLogin = { url: "", done, cancel };
  const deadline = Date.now() + (options.urlWithinMs ?? 10_000);
  while (Date.now() < deadline && !finished) {
    const url = existsSync(recorded) ? signInURLFrom(readFileSync(recorded, "utf8")) : undefined;
    if (url) {
      login.url = url;
      running.set(account.id, login);
      const timer = setTimeout(cancel, options.timeoutMs ?? 10 * 60_000);
      timer.unref?.();
      void done.then(() => clearTimeout(timer));
      return login;
    }
    await Bun.sleep(100);
  }
  cancel();
  return null;
}

/** Stops a sign-in in progress for this account (the sheet was closed). */
export function cancelClaudeWebLogin(accountId: string): boolean {
  const login = running.get(accountId);
  login?.cancel();
  return Boolean(login);
}
