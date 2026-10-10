import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { conchHome } from "./home.ts";
import { startClaudeWebLogin } from "./claude-web-login.ts";

/**
 * One Claude login that rotates across your Max accounts (2026-10-09, Tyler: "ideally its like one account that just
 * rotates to the next max account via logout and login when one hits its limit").
 *
 * claude-swap (MIT, realiti4/claude-swap; its dashboard is already adapted in claude-swap.ts) does the switching. It keeps
 * each account's credential and swaps the Default profile's login under Claude Code's own credential locks, so a swap
 * never collides with a token refresh, and a running session picks the new account up when Claude Code's Keychain cache
 * expires (about 30 s on macOS). conch installs it with the uv it carries, runs its auto-switcher while `claude-rotation`
 * is on, and says when it switched. Rotation is the Default profile's alone: conch's other profiles keep their own logins.
 *
 * claude-swap's store is the list of accounts (2026-10-11, Tyler: "we should probably have the store be in the app and be
 * self correcting"): each account's sign-in in its own Keychain item, renewed before it's switched to, held out when its
 * sign-in dies, and saved back after a session renews it. The app shows that store, not whoever this Mac is signed in as.
 * Adding an account signs in in a folder of its own (`startAddingAccount`), so the login your sessions use never changes
 * while you add one; that's the step that used to sign Default in as someone else.
 */

/** Where `cswap` is: on PATH, or uv's tool bin, where `uv tool install` puts it. */
export function swapExecutable(which: (name: string) => string | null = Bun.which, home = conchHome()): string | undefined {
  const onPath = which("cswap");
  if (onPath) return onPath;
  const installed = join(home, ".local", "bin", "cswap");
  return existsSync(installed) ? installed : undefined;
}

/**
 * The Default profile's environment, which is the one rotation swaps: no CLAUDE_CONFIG_DIR (naming ~/.claude can select a
 * different Keychain entry), and nothing that would sign in another way.
 */
export function rotationEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

export interface CommandOutcome { ok: boolean; output: string }

async function run(argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number, input?: string): Promise<CommandOutcome> {
  const child = Bun.spawn(argv, { env, stdin: input === undefined ? "ignore" : new Response(input), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { ok: code === 0, output: `${out}${err}`.trim().slice(-2_000) };
  } finally {
    clearTimeout(timer);
  }
}

/** `uv tool install claude-swap`, with the uv conch carries (CONCH_UV) or the one on PATH. */
export async function installClaudeSwap(uv = process.env.CONCH_UV || Bun.which("uv") || ""): Promise<CommandOutcome> {
  if (!uv) return { ok: false, output: "conch couldn't find uv to install claude-swap with." };
  return run([uv, "tool", "install", "claude-swap"], process.env, 180_000);
}

/** `cswap add`: the account Default is signed in as now joins the rotation (updated in place if it's already there). */
export async function addSignedInAccountToRotation(cswap = swapExecutable()): Promise<CommandOutcome> {
  if (!cswap) return { ok: false, output: "claude-swap isn't installed." };
  return run([cswap, "add"], rotationEnvironment(), 60_000);
}

/** `cswap add` reading a profile folder's sign-in instead of Default's (claude-swap follows CLAUDE_CONFIG_DIR for both the
 * identity and the credential). Already in the list: its sign-in is replaced in place, which is how "Sign in again" works. */
export async function addProfileToRotation(configDir: string, cswap = swapExecutable()): Promise<CommandOutcome> {
  if (!cswap) return { ok: false, output: "claude-swap isn't installed." };
  return run([cswap, "add"], { ...rotationEnvironment(), CLAUDE_CONFIG_DIR: configDir }, 60_000);
}

/** `cswap switch <n>`: Default signs in as that account now. Running sessions follow within about 30 s. */
export async function switchRotation(slot: number, cswap = swapExecutable()): Promise<CommandOutcome> {
  if (!cswap) return { ok: false, output: "claude-swap isn't installed." };
  return run([cswap, "switch", String(slot)], rotationEnvironment(), 60_000);
}

/** `cswap remove <n>`, answering its "are you sure" (the app has asked). Default stays signed in as whoever it is. */
export async function removeFromRotation(slot: number, cswap = swapExecutable()): Promise<CommandOutcome> {
  if (!cswap) return { ok: false, output: "claude-swap isn't installed." };
  return run([cswap, "remove", String(slot)], rotationEnvironment(), 60_000, "y\n");
}

/** The Keychain item Claude Code keeps a profile folder's sign-in in (claude-swap `session.keychain_service_name`). */
export function profileKeychainService(configDir: string): string {
  return `Claude Code-credentials-${createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, 8)}`;
}

/** Who a profile folder is signed in as, from Claude's own `.claude.json` there. */
export function profileEmail(configDir: string): string | undefined {
  return profileEmailIn(join(configDir, ".claude.json"));
}

function profileEmailIn(file: string): string | undefined {
  try {
    const email = JSON.parse(readFileSync(file, "utf8"))?.oauthAccount?.emailAddress;
    return typeof email === "string" && email ? email : undefined;
  } catch {
    return undefined;
  }
}

type AddResult = CommandOutcome & { email?: string };
interface AddingAccount { result: Promise<AddResult>; cancel(): void }
const adding = new Map<string, AddingAccount>();

/** Where an account being added signs in: a folder of its own, gone once it has joined the list. */
export function addingDirectory(id: string, home = conchHome()): string {
  return join(process.env.CONCH_CONFIG_DIR ?? join(home, ".config", "conch"), "claude-sign-ins", id);
}

export interface AddingOptions {
  executable?: string;
  /** Pre-fills Claude's sign-in (an account signing in again). */
  email?: string;
  home?: string;
  cswap?: string;
  start?: typeof startClaudeWebLogin;
  forget?: (service: string) => Promise<void>;
  resync?: () => Promise<unknown>;
  report?: (line: string) => void;
}

/**
 * "Add a Claude account": Claude's sign-in in a new folder, and its authorize URL for the Mac to show. The login your
 * sessions use doesn't change. Null when Claude's sign-in couldn't be started.
 *
 * Once the sign-in finishes (in the app's sheet, or wherever its page was opened) the account goes in the list, whether
 * or not the app is still waiting. The folder and its Keychain item go afterwards, so claude-swap holds the only copy, as
 * its README asks (a second copy of a sign-in goes stale once either renews it). Then the list is pointed back at the
 * account Default is actually signed in as, since `cswap add` records the account it adds as the one in use.
 */
export async function startAddingAccount(options: AddingOptions = {}): Promise<{ id: string; url: string } | null> {
  const id = `add-${randomUUID()}`;
  const configDir = addingDirectory(id, options.home);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const login = await (options.start ?? startClaudeWebLogin)({ id, label: "New account", configDir },
    { executable: options.executable ?? Bun.which("claude") ?? "claude", ...(options.email ? { email: options.email } : {}) });
  if (!login) {
    rmSync(configDir, { recursive: true, force: true });
    return null;
  }
  const result = login.done.then(async (code): Promise<AddResult> => {
    if (code !== 0) {
      rmSync(configDir, { recursive: true, force: true });
      return { ok: false, output: "Claude's sign-in didn't finish." };
    }
    const email = profileEmail(configDir);
    const outcome = await addProfileToRotation(configDir, options.cswap ?? swapExecutable());
    await (options.forget ?? forgetKeychainItem)(profileKeychainService(configDir)).catch(() => {});
    rmSync(configDir, { recursive: true, force: true });
    if (outcome.ok) await (options.resync ?? (() => addSignedInAccountToRotationIfListed(options.cswap)))().catch(() => {});
    options.report?.(outcome.ok ? `added ${email ?? "a Claude account"} to the Claude accounts`
      : `couldn't add ${email ?? "a Claude account"} to the Claude accounts: ${outcome.output.slice(-200)}`);
    return { ...outcome, ...(email ? { email } : {}) };
  });
  adding.set(id, { result, cancel: login.cancel });
  // Kept a while after, for an app that asks late how it went.
  void result.finally(() => setTimeout(() => adding.delete(id), 10 * 60_000).unref?.());
  return { id, url: login.url };
}

/** How adding that account went, once its sign-in is over; "hasn't finished" after `waitMs`. */
export async function finishAddingAccount(id: string, waitMs = 11 * 60_000): Promise<AddResult> {
  const add = adding.get(id);
  if (!add) return { ok: false, output: "That sign-in has ended. Choose Add a Claude account to start again." };
  const result = await Promise.race([add.result, Bun.sleep(waitMs).then(() => undefined)]);
  return result ?? { ok: false, output: "Claude's sign-in hasn't finished." };
}

/** Stops adding that account (the sheet was closed). */
export function cancelAddingAccount(id: string): boolean {
  const add = adding.get(id);
  add?.cancel();
  return Boolean(add);
}

async function forgetKeychainItem(service: string): Promise<void> {
  // Only this Mac's copy of a sign-in claude-swap now holds; nothing is signed out.
  await run(["/usr/bin/security", "delete-generic-password", "-s", service, "-a", userInfo().username], process.env, 10_000);
}

/** `cswap add` for Default, only when Default's account is in the list already: re-records it as the one in use. */
async function addSignedInAccountToRotationIfListed(cswap = swapExecutable()): Promise<void> {
  const current = defaultLoginEmail();
  if (!cswap || !current) return;
  if ((await listedEmails(cswap))?.includes(current)) await addSignedInAccountToRotation(cswap);
}

/** The emails in claude-swap's list, from `cswap list --json`; undefined when it can't be read. */
export async function listedEmails(cswap: string): Promise<string[] | undefined> {
  const child = Bun.spawn([cswap, "list", "--json"], { env: rotationEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const accounts: unknown = code === 0 ? JSON.parse(out)?.accounts : undefined;
    if (!Array.isArray(accounts)) return undefined;
    return accounts.map((account) => account?.email).filter((email): email is string => typeof email === "string");
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Who Default is signed in as, from `~/.claude.json` (where Claude keeps it when CLAUDE_CONFIG_DIR is unset). */
export function defaultLoginEmail(home = conchHome()): string | undefined {
  return profileEmailIn(join(home, ".claude.json"));
}

/** One line of `cswap auto --json` worth telling you about, or undefined for the rest (polls, sleeps, no-switch). */
export function describeSwapEvent(line: string): string | undefined {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  const who = (ref: unknown): string => {
    if (!ref || typeof ref !== "object") return "another account";
    const value = ref as Record<string, unknown>;
    return typeof value.email === "string" ? value.email : typeof value.number === "number" ? `account ${value.number}` : "another account";
  };
  switch (event.event) {
    case "switch": {
      if (event.dry_run === true || event.dryRun === true) return undefined;
      const why = event.trigger === "at-limit" ? "at its limit" : event.trigger === "failover" ? "unusable" : "near its limit";
      return `switched Claude from ${who(event.from)} (${why}) to ${who(event.to)}`;
    }
    case "all-exhausted":
      return "every Claude account in the rotation is at its limit; waiting for the first reset";
    case "account-quarantined":
      return `${who(event)} left the rotation: its sign-in has expired (sign it in again to bring it back)`;
    case "error":
      return event.transient === true ? undefined : `claude-swap: ${typeof event.message === "string" ? event.message.slice(0, 200) : "an error"}`;
    default:
      return undefined;
  }
}

/**
 * `cswap auto --json` while rotation is on: started, restarted with a growing pause if it stops on its own, stopped when
 * rotation goes off or the daemon does.
 */
export class RotationSupervisor {
  #child: ReturnType<typeof Bun.spawn> | undefined;
  #wanted = false;
  #restarts = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly report: (line: string) => void,
    private readonly executable: () => string | undefined = () => swapExecutable(),
  ) {}

  get running(): boolean {
    return this.#child !== undefined;
  }

  set(on: boolean): void {
    this.#wanted = on;
    if (on) this.#start();
    else this.stop();
  }

  stop(): void {
    this.#wanted = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#child?.kill();
    this.#child = undefined;
  }

  #start(): void {
    if (this.#child || !this.#wanted) return;
    const cswap = this.executable();
    if (!cswap) {
      this.report("account rotation is on, but claude-swap isn't installed");
      return;
    }
    const child = Bun.spawn([cswap, "auto", "--json"], { env: rotationEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    this.#child = child;
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end; (end = buffer.indexOf("\n")) >= 0;) {
          const said = describeSwapEvent(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (said) this.report(said);
        }
      }
    })().catch(() => {});
    void child.exited.then((code) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      if (!this.#wanted) return;
      this.#restarts += 1;
      const pause = Math.min(300_000, 5_000 * 2 ** Math.min(this.#restarts, 6));
      this.report(`claude-swap's switcher stopped (exit ${code}); starting it again in ${Math.round(pause / 1000)} s`);
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#start();
      }, pause);
      this.#timer.unref?.();
    });
  }
}
