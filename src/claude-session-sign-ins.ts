import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shellQuote } from "./agent-adapter.ts";
import { validAccountId } from "./claude-accounts.ts";
import { profileKeychainService } from "./claude-rotation.ts";
import { conchHome } from "./home.ts";

/**
 * Sign-ins for single sessions (2026-11-01, Tyler: "one profile, choose which account a new session signs in as").
 *
 * Default's own login is shared by every Default session and moves between your Max accounts (claude-rotation.ts), so
 * until now the only way to keep one session on one account was a second profile, a CLAUDE_CONFIG_DIR of its own, which
 * splits settings and memory in two. A sign-in is a long-lived token from `claude setup-token` instead: launched with
 * it in CLAUDE_CODE_OAUTH_TOKEN, Claude Code uses that account for that one process (`claude auth status` reports
 * `authMethod: oauth_token` and `configDirectory: ~/.claude`), while settings, projects and memory stay Default's.
 *
 * Where the token is, start to finish:
 *  - pasted into the Mac app's sheet, sent once over the daemon's local socket (`add`; the phone bridge refuses the
 *    kind, phone-bridge.ts `MAC_APP_ONLY_KINDS`), and written to the login Keychain by `/usr/bin/security -i`, the
 *    command on its STDIN (`addSessionSignIn`): never in any process's argv, never in conch's own files;
 *  - read back by the launched shell itself (`signInShellPrefix`) into a variable it never exports, and handed to Claude
 *    Code on a file descriptor (`signInTokenRedirect`, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR), never its environment:
 *    the command conch builds, tmux's arguments, the sessions file and the logs only ever hold the id, and what the
 *    agent runs can't read it either (below).
 *
 * Not CLAUDE_CODE_OAUTH_TOKEN, which is where it went first: every command the agent ran would have inherited a year's
 * credential in its environment, one `env` from its transcript, which conch publishes. Measured on Claude Code 2.1.309
 * with a fake token, 2026-11-01: handed over on fd 3, the API was sent it (401, "OAuth access token is invalid", where no
 * token at all says "Not logged in"), and a command Claude Code started saw no token, no descriptor variable and no
 * descriptor to read.
 * What conch keeps is the label and when it was added (`claude-session-sign-ins.json`), and which live session runs on
 * which sign-in (`SessionSignInLedger`), which the session's own hook says through a marker that is only the id.
 */

/** The Keychain service each sign-in's token is kept under: one generic password per sign-in, its account the id. */
export const SIGN_IN_KEYCHAIN_SERVICE = "conch.claude.session-sign-in";
/** Where Claude Code would read a token from its environment: never set by a sign-in launch, and stripped from it. */
export const SIGN_IN_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
/** Where a sign-in launch tells Claude Code to read the token from instead: a descriptor, `SIGN_IN_TOKEN_FD`. */
export const SIGN_IN_TOKEN_FD_ENV = "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR";
export const SIGN_IN_TOKEN_FD = 3;
/** The launched shell's own variable for the token: never exported, so nothing it starts inherits it. */
const SIGN_IN_SHELL_VARIABLE = "conch_sign_in";
/** The sign-in's id, beside the token: not secret, so the session's hook can say which sign-in it runs on. */
export const SIGN_IN_MARKER_ENV = "CONCH_CLAUDE_SIGN_IN";
/** What a sign-in launch keeps when it strips the launcher's other credentials (`claudeProfileCommandPrefix`). */
export const SIGN_IN_LAUNCH_ENV: readonly string[] = [SIGN_IN_TOKEN_FD_ENV, SIGN_IN_MARKER_ENV];

const MAX_SIGN_INS = 32;
const MAX_TOKEN_LENGTH = 1_024;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/**
 * A token from `claude setup-token`, loosely: it begins `sk-ant-oat01-` today, and nothing past this is assumed. Strict
 * on what can't be in one, so nothing `security -i` would read as a second word, a quote or a new line gets through.
 */
const TOKEN = /^sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{20,}$/;

export interface ClaudeSessionSignIn {
  /** conch's own, shell-safe (`validAccountId`): the Keychain item's account and the marker's value. */
  id: string;
  label: string;
  /** Epoch ms. */
  addedAt: number;
}

export type ClaudeSessionSignInRequest = {
  kind: "claude-session-sign-ins";
  /** `setup`: Terminal, running `claude setup-token` in a throwaway folder (`startClaudeSetupToken`). */
  action: "list" | "add" | "remove" | "setup";
  id?: string;
  label?: string;
  /** `add` only, held for as long as it takes to hand to the Keychain, and never in a reply, a log or an error. */
  token?: string;
};

export interface ClaudeSessionSignInsReply {
  kind: "claude-session-sign-ins";
  signIns: ClaudeSessionSignIn[];
  /** The sign-in `add` made. */
  added?: string;
  setupOpened?: true;
}

export const validSignInToken = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_TOKEN_LENGTH && TOKEN.test(value);

/** Said of a token that isn't one, without ever repeating what was pasted. */
export const SIGN_IN_TOKEN_ERROR = "That isn't a token from claude setup-token. Copy the whole line it printed (it starts with sk-ant-) and paste it again.";

/**
 * Why a sign-in's name won't do. 1–60 printable characters, and no double quote or backslash: the name goes into the
 * Keychain item's label, inside the double quotes of a `security -i` command line.
 */
export function signInLabelError(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 60 || CONTROL.test(value) || /["\\]/.test(value)) {
    return "Name the sign-in in 1–60 characters, without double quotes or backslashes";
  }
}

const ACTIONS = ["list", "add", "remove", "setup"];

/** Why a `claude-session-sign-ins` request is refused, or undefined. No reason repeats a token. */
export function sessionSignInRequestError(value: Record<string, unknown>): string | undefined {
  if (!ACTIONS.includes(String(value.action))) return "Unknown sign-in action";
  if (value.id !== undefined && !validAccountId(value.id)) return "Invalid sign-in id";
  if (value.action === "remove" && value.id === undefined) return "Choose a sign-in";
  if (value.token !== undefined && value.action !== "add") return "Only add carries a token";
  if (value.action === "add") {
    const label = signInLabelError(value.label);
    if (label) return label;
    if (!validSignInToken(value.token)) return SIGN_IN_TOKEN_ERROR;
  }
}

/** The decoded request: exactly the fields its action uses. */
export function decodeSessionSignInRequest(value: Record<string, unknown>): ClaudeSessionSignInRequest {
  const action = value.action as ClaudeSessionSignInRequest["action"];
  return {
    kind: "claude-session-sign-ins", action,
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(action === "add" ? { label: (value.label as string).trim(), token: value.token as string } : {}),
  };
}

/** A reply is the list and what the request did, and nothing else: one with any other field, anywhere, isn't one. */
export function isSessionSignInsReply(value: Record<string, unknown>): value is ClaudeSessionSignInsReply & Record<string, unknown> {
  return value.kind === "claude-session-sign-ins" && Array.isArray(value.signIns) && value.signIns.length <= MAX_SIGN_INS
    && value.signIns.every((one) => one && typeof one === "object" && validAccountId(one.id) && !signInLabelError(one.label)
      && Number.isSafeInteger(one.addedAt) && Object.keys(one).every((key) => ["id", "label", "addedAt"].includes(key)))
    && (value.added === undefined || validAccountId(value.added))
    && (value.setupOpened === undefined || value.setupOpened === true)
    && Object.keys(value).every((key) => ["kind", "signIns", "added", "setupOpened"].includes(key));
}

function conchConfigDir(home = conchHome()): string {
  return process.env.CONCH_CONFIG_DIR ?? join(home, ".config", "conch");
}

/** Resolved as `accountStorePath()` is. Not `claude-sign-ins`: that is where claude-rotation.ts adds an account. */
export function sessionSignInStorePath(): string {
  return join(conchConfigDir(), "claude-session-sign-ins.json");
}

/** conch's list: ids, names and dates, never a token. Empty when there is no list yet; throws when it can't be read. */
export function readSessionSignIns(file = sessionSignInStorePath()): ClaudeSessionSignIn[] {
  if (!existsSync(file)) return [];
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(data) || data.length > MAX_SIGN_INS) throw new Error("Cannot read conch's Claude sign-ins");
  const ids = new Set<string>();
  return data.map((entry) => {
    if (!entry || typeof entry !== "object" || !validAccountId(entry.id) || ids.has(entry.id) || signInLabelError(entry.label)
      || !Number.isSafeInteger(entry.addedAt) || entry.addedAt < 0) throw new Error("Invalid Claude sign-in in conch's list");
    ids.add(entry.id);
    return { id: entry.id, label: entry.label.trim(), addedAt: entry.addedAt };
  });
}

/** The list, or undefined when it can't be read: for labelling rows, which must not fail over it. */
export function readSessionSignInsQuietly(file = sessionSignInStorePath()): ClaudeSessionSignIn[] | undefined {
  try {
    return readSessionSignIns(file);
  } catch {
    return undefined;
  }
}

function save(signIns: readonly ClaudeSessionSignIn[], file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    // Only these three keys, whatever the objects carry.
    writeFileSync(temp, JSON.stringify(signIns.map(({ id, label, addedAt }) => ({ id, label, addedAt })), null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/**
 * `/usr/bin/security -i` given one command on its STDIN, and how it went: its exit code (44 is "not found") and the end
 * of what it said on stderr. Never its stdout. Injected in tests, which never touch a real Keychain.
 */
export type KeychainRunner = (command: string) => Promise<{ code: number; stderr: string }>;

/**
 * The real one. The command, and the token in it, go in on STDIN, so no process's argv ever holds a token. Refuses in
 * conch's own tests (`CONCH_TEST_ROOT`), as setup's installer does (setup.ts `installerSandboxRefusal`): one that
 * forgot to inject a runner must fail, not write the Mac's login Keychain.
 */
export const runKeychainCommand: KeychainRunner = async (command) => {
  if (process.env.CONCH_TEST_ROOT) throw new Error("conch is running its tests, so it won't touch the Keychain");
  const child = Bun.spawn(["/usr/bin/security", "-i"], { stdin: new Response(command), stdout: "ignore", stderr: "pipe" });
  // Long enough for the Keychain to ask to be unlocked, should it be locked.
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  try {
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    return { code, stderr: stderr.slice(-400) };
  } finally {
    clearTimeout(timer);
  }
};

/** What `security` said, fit for an error: anything token-shaped taken out, though it has never been seen to echo one. */
export function redactTokens(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]*/g, "sk-ant-…").replace(CONTROL, " ").trim().slice(0, 200);
}

/**
 * One `security -i` line. No keychain is named, so it is the login Keychain, the one the launched shell's lookup searches.
 * (Measured 2026-11-01: a keychain path that doesn't exist is not an error to `security`; it writes the default one.)
 */
function keychainLine(words: string): string {
  if (CONTROL.test(words)) throw new Error("A Keychain command must be one line");
  return `${words}\n`;
}

/** The Keychain line that saves a sign-in. Only for already-validated parts; exported for its test. */
export function addTokenLine(id: string, label: string, token: string): string {
  if (!validAccountId(id) || signInLabelError(label) || !validSignInToken(token)) throw new Error("Invalid sign-in");
  return keychainLine(`add-generic-password -U -s ${SIGN_IN_KEYCHAIN_SERVICE} -a ${id} -l "conch sign-in: ${label.trim()}" -w ${token}`);
}

function deleteTokenLine(id: string): string {
  if (!validAccountId(id)) throw new Error("Invalid sign-in id");
  return keychainLine(`delete-generic-password -s ${SIGN_IN_KEYCHAIN_SERVICE} -a ${id}`);
}

export interface SignInStoreOptions {
  file?: string;
  keychain?: KeychainRunner;
  now?: () => number;
  /** The new sign-in's id; conch's own otherwise. */
  newId?: () => string;
}

// One change at a time: two adds that both read the list before either wrote it would lose one.
let changing: Promise<unknown> = Promise.resolve();
function serially<T>(work: () => Promise<T>): Promise<T> {
  const next = changing.then(work, work);
  changing = next.catch(() => {});
  return next;
}

/**
 * Save a sign-in: its token in the Keychain first, then its name in conch's list. A list that can't be written takes
 * the Keychain item back out, so neither holds half a sign-in.
 */
export function addSessionSignIn(label: string, token: string, options: SignInStoreOptions = {}): Promise<ClaudeSessionSignIn> {
  const labelError = signInLabelError(label);
  if (labelError) return Promise.reject(new Error(labelError));
  if (!validSignInToken(token)) return Promise.reject(new Error(SIGN_IN_TOKEN_ERROR));
  return serially(async () => {
    const file = options.file ?? sessionSignInStorePath();
    const keychain = options.keychain ?? runKeychainCommand;
    const signIns = readSessionSignIns(file);
    if (signIns.length >= MAX_SIGN_INS) throw new Error(`conch keeps up to ${MAX_SIGN_INS} sign-ins; remove one first`);
    if (signIns.some((one) => one.label.toLowerCase() === label.trim().toLowerCase())) throw new Error("Choose a different name: a sign-in already has that one");
    const id = (options.newId ?? randomUUID)();
    const saved = await keychain(addTokenLine(id, label, token));
    if (saved.code !== 0) {
      const said = redactTokens(saved.stderr);
      throw new Error(`The Keychain didn't take the sign-in (security exited ${saved.code}${said ? `: ${said}` : ""}). Nothing was saved.`);
    }
    const signIn: ClaudeSessionSignIn = { id, label: label.trim(), addedAt: (options.now ?? Date.now)() };
    try {
      save([...signIns, signIn], file);
    } catch (error) {
      await keychain(deleteTokenLine(id)).catch(() => undefined);
      throw new Error(`conch couldn't save its list of sign-ins, so the sign-in wasn't added: ${(error as Error).message}`);
    }
    return signIn;
  });
}

/**
 * Remove a sign-in: its Keychain item, then its name. A session running on it keeps running (its token is already in
 * its environment); restarting one fails, saying so, rather than starting it on another account.
 */
export function removeSessionSignIn(id: string, options: SignInStoreOptions = {}): Promise<ClaudeSessionSignIn | undefined> {
  if (!validAccountId(id)) return Promise.reject(new Error("Invalid sign-in id"));
  return serially(async () => {
    const file = options.file ?? sessionSignInStorePath();
    const signIns = readSessionSignIns(file);
    const listed = signIns.find((one) => one.id === id);
    const deleted = await (options.keychain ?? runKeychainCommand)(deleteTokenLine(id));
    // 44: the Keychain has no such item, which is what removing it was for.
    if (deleted.code !== 0 && deleted.code !== 44) {
      const said = redactTokens(deleted.stderr);
      throw new Error(`The Keychain didn't let conch remove the sign-in (security exited ${deleted.code}${said ? `: ${said}` : ""})`);
    }
    if (!listed && deleted.code === 44) throw new Error("That sign-in was not found. Refresh the list.");
    if (listed) save(signIns.filter((one) => one.id !== id), file);
    return listed;
  });
}

/**
 * The sign-in a launch names, checked: Claude's, in the Default profile only (another profile has its own login), and
 * still in conch's list. A removed one is refused in words, never started on the rotating login instead.
 */
export function claudeSignInForLaunch(
  request: { backend: string; claudeAccountId?: string; claudeConfigDir?: string; claudeSignInId?: string },
  file = sessionSignInStorePath(),
): ClaudeSessionSignIn | undefined {
  if (request.claudeSignInId === undefined) return;
  if (request.backend !== "claude" || !validAccountId(request.claudeSignInId)) throw new Error("A sign-in is only for a Claude session");
  if ((request.claudeAccountId !== undefined && request.claudeAccountId !== "default") || request.claudeConfigDir !== undefined) {
    throw new Error("A sign-in runs in the Default profile only. Choose Default to use it.");
  }
  const signIn = readSessionSignIns(file).find((one) => one.id === request.claudeSignInId);
  if (!signIn) {
    throw new Error("The Claude sign-in this session uses has been removed, so conch won't start it on another account."
      + " Choose a sign-in again (or Default · rotating) and start it from Start.");
  }
  return signIn;
}

/**
 * What the launched shell reads the token with. `/usr/bin/security`, always, outside conch's tests. In them it is the
 * stand-in a test names in `CONCH_SIGN_IN_SECURITY`, or `/usr/bin/false`: a launch prefix a test runs never reads the
 * real Keychain.
 */
export function signInSecurityBinary(env: Record<string, string | undefined> = process.env): string {
  if (!env.CONCH_TEST_ROOT) return "/usr/bin/security";
  const stand = env.CONCH_SIGN_IN_SECURITY;
  return stand && /^\/[A-Za-z0-9._/-]+$/.test(stand) ? stand : "/usr/bin/false";
}

/**
 * The start of a launch with a sign-in, before its `exec`: the shell reads the token from the Keychain itself into a
 * variable it doesn't export, refuses to go on without one (an empty answer included, which would have Claude Code fall
 * back to the rotating login), and exports where to read it (`SIGN_IN_TOKEN_FD_ENV`) and the marker. Only the id is in
 * this text; the token never is. `signInTokenRedirect` ends the same command.
 */
export function signInShellPrefix(signIn: Pick<ClaudeSessionSignIn, "id" | "label">, security = signInSecurityBinary()): string {
  if (!validAccountId(signIn.id)) throw new Error("Invalid sign-in id");
  const missing = `conch: the Claude sign-in "${signIn.label}" isn't in your Keychain any more, so this session didn't start.`
    + " Add it again in conch's Settings > Providers, or start the session on Default.";
  return `{ ${SIGN_IN_SHELL_VARIABLE}="$(${security} find-generic-password -s ${SIGN_IN_KEYCHAIN_SERVICE} -a ${shellQuote(signIn.id)} -w 2>/dev/null)"`
    + ` && [ -n "$${SIGN_IN_SHELL_VARIABLE}" ] || { printf '%s\\n' ${shellQuote(missing)}; exit 1; }; }`
    + ` && export ${SIGN_IN_TOKEN_FD_ENV}=${SIGN_IN_TOKEN_FD} ${SIGN_IN_MARKER_ENV}=${shellQuote(signIn.id)} && `;
}

/**
 * The end of that command: the token on `SIGN_IN_TOKEN_FD`, from a pipe the shell fills with its builtin `printf` (no
 * process is started with it as an argument, and nothing touches the disk). Claude Code reads it to the end at start-up,
 * so the pipe is empty by the time anything it runs could look. zsh, as Terminal's shell and conch's tmux are.
 */
export function signInTokenRedirect(): string {
  return ` ${SIGN_IN_TOKEN_FD}< <(printf '%s' "$${SIGN_IN_SHELL_VARIABLE}")`;
}

/** Where `claude setup-token` runs: a folder of its own, so Default's login and the rotation's are never touched. */
export function setupTokenFolder(home = conchHome()): string {
  const root = join(conchConfigDir(home), "claude-session-sign-ins");
  // Anything a setup left behind (a Terminal closed before it finished) goes after a day.
  try {
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (name.startsWith("setup-") && Date.now() - statSync(path).mtimeMs > 24 * 60 * 60_000) rmSync(path, { recursive: true, force: true });
    }
  } catch {}
  const folder = join(root, `setup-${randomUUID()}`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return folder;
}

/**
 * The Terminal command for "Add a sign-in": `claude setup-token` in the throwaway folder (`environment` names it as
 * CLAUDE_CONFIG_DIR and drops any credential the shell has), then the folder goes, with any Keychain item Claude Code
 * kept for it (claude-rotation.ts `profileKeychainService`). The token it prints is cleared from the window, scrollback
 * too, once you've copied it.
 */
export function setupTokenCommand(configDir: string, environment: string): string {
  const said = "Paste the token into conch's sheet, then press Return here to clear it from this window.";
  return `${environment}claude setup-token; conch_status=$?; rm -rf -- ${shellQuote(configDir)};`
    + ` /usr/bin/security delete-generic-password -s ${shellQuote(profileKeychainService(configDir))} >/dev/null 2>&1;`
    + ` printf '\\n%s ' ${shellQuote(said)}; read -r conch_done; clear; printf '\\033[3J'; exit $conch_status`;
}

/** The sign-in a hook's session was launched with, from its marker: the id, never the token. */
export function signInMarker(env: Record<string, string | undefined> = process.env): string | undefined {
  const id = env[SIGN_IN_MARKER_ENV];
  return validAccountId(id) ? id : undefined;
}

const SESSION_KEY = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !CONTROL.test(value);
const MAX_LEDGER = 500;
/** A session its hook has just told of may not be in the registry yet: not forgotten for being absent this soon. */
const LEDGER_GRACE_MS = 10 * 60_000;

/**
 * Which sign-in each session runs on, by its hook's word (`signInMarker`, on `session-start` and `working`), kept across
 * daemon restarts: the row's label, and the sign-in a restart, fork or recovery relaunches with. Forgotten once the
 * session has gone (`prune`, on a complete registry read).
 */
export class SessionSignInLedger {
  readonly #file: string;
  #entries = new Map<string, { signIn: string; at: number }>();

  constructor(file: string) {
    this.#file = file;
    try {
      const stored = JSON.parse(readFileSync(file, "utf8")) as { sessions?: unknown };
      const sessions = stored.sessions && typeof stored.sessions === "object" ? stored.sessions as Record<string, unknown> : {};
      for (const [sessionId, entry] of Object.entries(sessions)) {
        const { signIn, at } = (entry ?? {}) as { signIn?: unknown; at?: unknown };
        if (SESSION_KEY(sessionId) && validAccountId(signIn) && Number.isSafeInteger(at)) this.#entries.set(sessionId, { signIn, at: at as number });
      }
    } catch {}
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * What a hook said of a session: the sign-in it runs on, or (`undefined`, from a `session-start` only) none, which a
   * resume outside a sign-in is. True when that changed anything.
   */
  note(sessionId: string, signIn: string | undefined, now = Date.now()): boolean {
    if (!SESSION_KEY(sessionId)) return false;
    const held = this.#entries.get(sessionId);
    if (signIn === undefined || !validAccountId(signIn)) {
      if (!held) return false;
      this.#entries.delete(sessionId);
      this.#save();
      return true;
    }
    const changed = held?.signIn !== signIn;
    // Re-dated each time, so a session still telling of it is never pruned as just-seen-and-gone.
    this.#entries.set(sessionId, { signIn, at: now });
    if (changed) {
      while (this.#entries.size > MAX_LEDGER) this.#entries.delete(this.#entries.keys().next().value!);
      this.#save();
    }
    return changed;
  }

  /** The sign-in a row runs on: by its own key, or by its agent's id when the hook named the session before the row's key. */
  for(session: { sessionId: string; agentSessionId?: string }): string | undefined {
    return this.#entries.get(session.sessionId)?.signIn
      ?? (session.agentSessionId ? this.#entries.get(session.agentSessionId)?.signIn : undefined);
  }

  /** After a complete registry read: forget sessions that have gone, past the grace a new one is given. */
  prune(live: ReadonlySet<string>, now = Date.now()): boolean {
    let changed = false;
    for (const [sessionId, entry] of this.#entries) {
      if (live.has(sessionId) || now - entry.at < LEDGER_GRACE_MS) continue;
      this.#entries.delete(sessionId);
      changed = true;
    }
    if (changed) this.#save();
    return changed;
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      const temp = `${this.#file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ sessions: Object.fromEntries(this.#entries) }, null, 2) + "\n", { mode: 0o600 });
      renameSync(temp, this.#file);
    } catch {}
  }
}

/**
 * A row as it runs: on the Default profile and a sign-in, it carries the sign-in and reads as it (`accountLabel`), so the
 * apps show which account it is on. One whose sign-in has since been removed still carries the id, so a restart says
 * so; `signIns` undefined (the list unreadable) leaves the profile's label.
 */
export function withSessionSignIn<T extends { claudeAccountId?: string; accountLabel?: string; claudeSignInId?: string }>(
  session: T,
  signInId: string | undefined,
  signIns: readonly ClaudeSessionSignIn[] | undefined,
): T {
  if (!signInId || session.claudeAccountId !== "default") return session;
  const label = signIns ? signIns.find((one) => one.id === signInId)?.label ?? "Removed sign-in" : session.accountLabel;
  return { ...session, claudeSignInId: signInId, ...(label ? { accountLabel: label } : {}) };
}
