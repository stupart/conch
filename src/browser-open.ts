import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { ControlFrameReader, encodeControlFrame } from "./control-framing.ts";
import { conchHome } from "./home.ts";

/**
 * Links a session opens land in conch's Workbench, not the default browser (2026-10-09, Tyler: "even tho the terminals
 * everywhere problem was solved I now have browser windows and tabs everywhere").
 *
 * Every session conch starts gets a folder of conch's first on its PATH, holding an `open` that hands http(s) links to
 * `conch browse`, and `BROWSER` naming that folder's `conch-browser`. `conch browse` asks the daemon to open the link
 * for the session it was called from (`browser-open`, below), and fails when it can't, so the shim falls back to
 * macOS's own `/usr/bin/open` and a link is never lost. Everything that isn't a plain link (`open -a`, a file, `-R`)
 * goes to `/usr/bin/open` untouched, as does every link while `CONCH_OPEN_EXTERNAL=1` is set.
 *
 * A login shell puts `/usr/bin` back ahead of a PATH it inherited: `/etc/zprofile` runs path_helper, which lists the
 * system's folders first and appends the rest (measured: `PATH=/tmp/x:$PATH zsh -lc 'echo $PATH'` puts /tmp/x after
 * /usr/bin). Claude Code runs its Bash commands from a snapshot of exactly such a shell, so for Claude the folder is
 * also put first by a `CLAUDE_ENV_FILE` script, which Claude runs before each command, after that snapshot. Codex runs
 * each command in `zsh -lc` and has no such hook: there `$BROWSER` reaches its commands, `open` does not.
 *
 * A leaf module: `session-lifecycle.ts` and the CLI import it, and `settings.ts` imports those.
 */

export const BROWSER_OPEN_KIND = "browser-open";

/** What `conch browse` sends. `callerPid` is the shim's process, under the agent the daemon looks for. */
export interface BrowserOpenRequest {
  kind: typeof BROWSER_OPEN_KIND;
  url: string;
  callerPid: number;
  profile?: string;
}

/** What the daemon answers. Anything but `browser-opened` sends the link to the default browser instead. */
export type BrowserOpenReply =
  | { kind: "browser-opened"; tabId: string; sessionId: string }
  | { kind: "browser-error"; error: string };

const MAX_URL_LENGTH = 32 * 1024;
const MAX_PROFILE_LENGTH = 128;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** An absolute http(s) URL, as `open` would be handed one. */
export function isBrowserURL(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

/** Null when `value` is not this request; an error when it is one, malformed. */
export function decodeBrowserOpenRequest(value: unknown): BrowserOpenRequest | { error: string } | null {
  if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== BROWSER_OPEN_KIND) return null;
  const { url, callerPid, profile } = value as Record<string, unknown>;
  if (typeof url !== "string" || url.length > MAX_URL_LENGTH || CONTROL_CHARS.test(url) || !isBrowserURL(url)) {
    return { error: "url must be an http or https link" };
  }
  if (typeof callerPid !== "number" || !Number.isSafeInteger(callerPid) || callerPid <= 1) {
    return { error: "callerPid must be the calling process's pid" };
  }
  if (profile !== undefined) {
    if (typeof profile !== "string" || !profile.trim() || profile.length > MAX_PROFILE_LENGTH || CONTROL_CHARS.test(profile)) {
      return { error: `profile must be a name of at most ${MAX_PROFILE_LENGTH} characters` };
    }
    return { kind: BROWSER_OPEN_KIND, url, callerPid, profile: profile.trim() };
  }
  return { kind: BROWSER_OPEN_KIND, url, callerPid };
}

export const BROWSE_USAGE = "usage: conch browse <url> [--profile <name>]";

/** `conch browse`'s arguments, as the request it sends, or why not. */
export function browseRequest(argv: readonly string[], callerPid: number): BrowserOpenRequest | { error: string } {
  let url: string | undefined;
  let profile: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--profile") {
      profile = argv[++i];
      if (profile === undefined) return { error: `--profile needs a name\n${BROWSE_USAGE}` };
    } else if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
    } else if (url === undefined && !arg.startsWith("-")) {
      url = arg;
    } else {
      return { error: `unexpected argument ${arg}\n${BROWSE_USAGE}` };
    }
  }
  if (url === undefined) return { error: BROWSE_USAGE };
  const request = decodeBrowserOpenRequest({ kind: BROWSER_OPEN_KIND, url, callerPid, ...(profile === undefined ? {} : { profile }) });
  return request ?? { error: BROWSE_USAGE };
}

export type BrowserOpenOutcome = { ok: true } | { ok: false; error: string };

/**
 * How long `conch browse` waits for the daemon. The shim's `open` waits with it, so not long; a link the daemon has
 * not taken by then goes to the default browser.
 */
export const BROWSER_OPEN_REPLY_MS = 15_000;

/** One request on the control socket, held open for the daemon's answer. */
export function requestBrowserOpen(socketPath: string, request: BrowserOpenRequest, timeoutMs = BROWSER_OPEN_REPLY_MS): Promise<BrowserOpenOutcome> {
  return new Promise((resolve) => {
    let frame: Buffer;
    try {
      frame = encodeControlFrame(JSON.stringify(request));
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    const reader = new ControlFrameReader();
    let connected = false;
    let settled = false;
    const finish = (outcome: BrowserOpenOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const gone = () => (connected ? "the daemon did not answer" : "conch's daemon is not running");
    const timer = setTimeout(() => finish({ ok: false, error: `${gone()} (timed out)` }), timeoutMs);
    socket.on("connect", () => {
      connected = true;
      socket.write(frame);
    });
    socket.on("data", (data) => {
      if (settled) return;
      try {
        const line = reader.push(typeof data === "string" ? Buffer.from(data) : data);
        if (line !== undefined) finish(browserOpenOutcome(JSON.parse(line)));
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.on("error", () => finish({ ok: false, error: gone() }));
    socket.on("close", () => finish({ ok: false, error: gone() }));
  });
}

/** Only `browser-opened` is a success: anything else, the link is opened again elsewhere. */
export function browserOpenOutcome(reply: unknown): BrowserOpenOutcome {
  if (!reply || typeof reply !== "object") return { ok: false, error: "the daemon's answer was not a browser reply" };
  const { kind, error } = reply as { kind?: unknown; error?: unknown };
  if (kind === "browser-opened") return { ok: true };
  if (kind === "browser-error") return { ok: false, error: typeof error === "string" && error ? error : "the daemon could not open it" };
  // An older daemon, which knows no `browser-open`, answers with an error of another kind.
  return { ok: false, error: typeof error === "string" && error ? error : `the daemon answered ${String(kind)}` };
}

// ---- The shim folder ----

export const OPEN_SHIM = "open";
export const BROWSER_SHIM = "conch-browser";
export const CLAUDE_ENV_SCRIPT = "claude-env.sh";
/** Present while `browser-open-in-conch` is off: shims already on a session's PATH pass everything to macOS. */
export const SHIMS_OFF_MARKER = "off";
export const SYSTEM_OPEN = "/usr/bin/open";

type Env = Readonly<Record<string, string | undefined>>;

/** Under the config dir, so `CONCH_CONFIG_DIR` moves it with everything else. */
export function browserShimDir(env: Env = process.env): string {
  return join(env.CONCH_CONFIG_DIR ?? join(conchHome(), ".config", "conch"), "bin");
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const URL_PATTERN = "[Hh][Tt][Tt][Pp]://*|[Hh][Tt][Tt][Pp][Ss]://*";

/**
 * `open`, as conch's: every http(s) argument to `conch browse`, when that is all there is (with flags that only say how
 * a browser is brought up). Anything else is `open`'s own business: an app (`-a`, `-b`), an editor (`-e`, `-t`, `-f`),
 * Finder (`-R`), a file, `--args`, a wait (`-W`), a flag this doesn't know. A link `conch browse` can't place goes to
 * `/usr/bin/open` with the same flags.
 */
export function openShimScript(options: { dir: string; invocation: string; systemOpen?: string }): string {
  const system = quote(options.systemOpen ?? SYSTEM_OPEN);
  return `#!/bin/sh
# conch's open (src/browser-open.ts), written by conch's daemon; edits are overwritten. An http(s) link opens in conch's
# Workbench; anything else, and every link while CONCH_OPEN_EXTERNAL=1 is set, goes to macOS's open unchanged.
if [ "\${CONCH_OPEN_EXTERNAL:-}" = 1 ] || [ -e ${quote(join(options.dir, SHIMS_OFF_MARKER))} ] || [ "$#" -eq 0 ]; then
  exec ${system} "$@"
fi
flags=
links=0
want_link=
for arg do
  if [ -n "$want_link" ]; then
    want_link=
    case $arg in ${URL_PATTERN}) links=$((links + 1)); continue ;; *) exec ${system} "$@" ;; esac
  fi
  case $arg in
    -g|-n|-F|-j|--background|--new|--fresh|--hide) flags="$flags $arg" ;;
    -u|--url) want_link=1 ;;
    ${URL_PATTERN}) links=$((links + 1)) ;;
    *) exec ${system} "$@" ;;
  esac
done
if [ "$links" -eq 0 ] || [ -n "$want_link" ]; then exec ${system} "$@"; fi
status=0
for arg do
  case $arg in
    ${URL_PATTERN})
      ${options.invocation} browse "$arg" </dev/null >/dev/null 2>&1 || ${system} $flags "$arg" || status=$?
      ;;
  esac
done
exit "$status"
`;
}

/** `$BROWSER`: the same for its one link. */
export function browserShimScript(options: { dir: string; invocation: string; systemOpen?: string }): string {
  const system = quote(options.systemOpen ?? SYSTEM_OPEN);
  return `#!/bin/sh
# conch's $BROWSER (src/browser-open.ts), written by conch's daemon; edits are overwritten. A link opens in conch's
# Workbench; with CONCH_OPEN_EXTERNAL=1, or when conch can't take it, in macOS's default browser.
if [ "$#" -eq 1 ] && [ "\${CONCH_OPEN_EXTERNAL:-}" != 1 ] && [ ! -e ${quote(join(options.dir, SHIMS_OFF_MARKER))} ]; then
  case $1 in
    ${URL_PATTERN}) ${options.invocation} browse "$1" </dev/null >/dev/null 2>&1 && exit 0 ;;
  esac
fi
exec ${system} "$@"
`;
}

/**
 * Claude Code's `CLAUDE_ENV_FILE`: run before each Bash command, after the login-shell snapshot that put /usr/bin
 * ahead of conch's folder. A file the session was started with is run first, as Claude would have.
 */
export function claudeEnvScript(dir: string): string {
  const self = join(dir, CLAUDE_ENV_SCRIPT);
  return `# conch's (src/browser-open.ts), written by conch's daemon; edits are overwritten. Claude Code runs this before each
# Bash command: conch's open first on PATH, which the login shell's path_helper had put after /usr/bin.
if [ -n "\${CONCH_CLAUDE_ENV_FILE:-}" ] && [ "$CONCH_CLAUDE_ENV_FILE" != ${quote(self)} ] && [ -r "$CONCH_CLAUDE_ENV_FILE" ]; then
  . "$CONCH_CLAUDE_ENV_FILE"
fi
case ":$PATH:" in
  ${quote(`:${dir}:`)}*) ;;
  *) PATH=${quote(dir)}:"$PATH"; export PATH ;;
esac
`;
}

/** Written whole and renamed into place, so a shim that is running is never half a file. Whether it changed. */
function writeIfChanged(path: string, content: string, mode: number): boolean {
  try {
    if (readFileSync(path, "utf8") === content) {
      chmodSync(path, mode);
      return false;
    }
  } catch {}
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, { mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  return true;
}

/**
 * The shim folder, as the setting has it: the scripts always (a session started while it was on still has them on
 * PATH), and the off marker while it is off. Idempotent: an unchanged script is not rewritten. Whether anything changed.
 */
export function writeBrowserShims(options: { dir: string; invocation: string; enabled: boolean; systemOpen?: string }): boolean {
  mkdirSync(options.dir, { recursive: true, mode: 0o755 });
  let changed = false;
  changed = writeIfChanged(join(options.dir, OPEN_SHIM), openShimScript(options), 0o755) || changed;
  changed = writeIfChanged(join(options.dir, BROWSER_SHIM), browserShimScript(options), 0o755) || changed;
  changed = writeIfChanged(join(options.dir, CLAUDE_ENV_SCRIPT), claudeEnvScript(options.dir), 0o644) || changed;
  const marker = join(options.dir, SHIMS_OFF_MARKER);
  if (options.enabled && existsSync(marker)) {
    rmSync(marker, { force: true });
    changed = true;
  } else if (!options.enabled && !existsSync(marker)) {
    writeFileSync(marker, "browser-open-in-conch is off: conch's open passes every link to macOS's\n");
    changed = true;
  }
  return changed;
}

/** The daemon has written the folder (`conch start` from a terminal routes through it only then). */
export function browserShimsReady(dir: string = browserShimDir()): boolean {
  return [OPEN_SHIM, BROWSER_SHIM, CLAUDE_ENV_SCRIPT].every((name) => existsSync(join(dir, name)));
}

// ---- Which sessions get it ----

let routedDir: string | undefined;

/** Sessions started from now on get this folder first on PATH, or (undefined) the environment they had. */
export function routeSessionBrowsers(dir: string | undefined): void {
  routedDir = dir;
}

/**
 * The daemon's side: the folder written for the setting's value, and the sessions it starts routed through it while
 * the setting is on. A folder that can't be written routes nothing; the error is for the log.
 */
export function setUpSessionBrowsers(enabled: boolean, invocation: string, dir: string = browserShimDir()): string | undefined {
  try {
    writeBrowserShims({ dir, invocation, enabled });
    routeSessionBrowsers(enabled ? dir : undefined);
  } catch (error) {
    routeSessionBrowsers(undefined);
    return `could not write conch's open shim in ${dir}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * The `env` assignments a session's command line gets, each followed by a space, or "" while nothing is routed. `$PATH`
 * and `$CLAUDE_ENV_FILE` are left for the shell that runs the command line (Terminal's, or tmux's `zsh -lc`) to expand,
 * so they are the session's own.
 */
export function sessionBrowserAssignments(backend: string): string {
  const dir = routedDir;
  if (!dir) return "";
  const path = `PATH=${quote(dir)}:"$PATH" BROWSER=${quote(join(dir, BROWSER_SHIM))} `;
  if (backend !== "claude") return path;
  return `${path}CONCH_CLAUDE_ENV_FILE="$CLAUDE_ENV_FILE" CLAUDE_ENV_FILE=${quote(join(dir, CLAUDE_ENV_SCRIPT))} `;
}
