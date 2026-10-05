import { basename } from "node:path";
import { userInfo } from "node:os";
import { statSync } from "node:fs";
import { resolveTmux, type ResolveTmuxOptions, type TmuxBinary } from "./tmux-binary.ts";
import { runUICommand, type UICommandResult, type UICommandScope } from "./pasteboard.ts";

/**
 * conch's own tmux server: where a session started "In conch" runs.
 *
 * A server of its own, on its own socket (`tmux -L conch`), never the user's default one: conch's options (no status
 * bar, no prefix key, Shift-Enter passed through) would change how their own tmux behaves, and their `~/.tmux.conf`
 * would change how conch's sessions do. The Mac app's Terminal tab attaches to the session here (SwiftTerm, the
 * `ignore-size` client below), "Open in Terminal" attaches a Terminal window to the same session, and the daemon types
 * into it with `send-keys`, so nothing is ever brought to the front to deliver a message.
 *
 * tmux daemonises its server (a new session and process group), so it outlives the daemon and the app: a restart of
 * either finds the sessions still running, and the daemon adopts them again by asking the server which panes it holds
 * (`readHostedTerminals`), with nothing of its own to remember. A Mac restart or logout ends the server and every
 * session in it; the restore list then resumes them, as it does sessions that were in Terminal.
 */

/** The label of conch's server, `tmux -L conch`: `$TMUX_TMPDIR/tmux-<uid>/conch`, beside the user's `default`. */
export const CONCH_TMUX_SOCKET = "conch";
const SOCKET_LABEL = /^[A-Za-z0-9._-]{1,64}$/;

/** The socket label: CONCH_TMUX_SOCKET when it names one (a test's throwaway server), else `conch`. */
export function conchTmuxSocket(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const named = env.CONCH_TMUX_SOCKET?.trim();
  return named && SOCKET_LABEL.test(named) ? named : CONCH_TMUX_SOCKET;
}

/**
 * The argv every command to conch's server starts with: its tmux (src/tmux-binary.ts: CONCH_TMUX, the app's own, then
 * Homebrew's, then PATH) and its socket. Null when there is no tmux at all, and then nothing can be hosted.
 */
export function conchTmuxArgv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  resolve: (options: ResolveTmuxOptions) => TmuxBinary = resolveTmux,
): string[] | null {
  const tmux = resolve({ env });
  return tmux.found ? [tmux.path, "-L", conchTmuxSocket(env)] : null;
}

/**
 * conch's tmux configuration, applied (with `-q`, so a tmux that lacks one option still starts the session) before
 * every new session, and to nothing else. The server is started with `-f /dev/null`, so neither `/etc/tmux.conf` nor
 * the user's `~/.tmux.conf` reaches it.
 *
 * - `extended-keys always` + `csi-u`: Shift-Enter reaches the agent as `ESC[13;2u`, which Claude Code reads as a
 *   newline. Measured on tmux 3.7c and Claude Code 2.1.280: Claude asks the terminal about the kitty protocol
 *   (`CSI ? u`), which tmux doesn't answer, and never asks for modifyOtherKeys, so with `on` tmux flattens Shift-Enter
 *   to a plain Return and the message is sent. `always` only holds for panes made after it is set, which is why it is
 *   set here, ahead of `new-session`, every time.
 * - `terminal-features[90]`: the Mac app's terminal (TERM xterm-256color) takes extended keys, 24-bit colour, OSC 52,
 *   hyperlinks, styled underlines and focus reports. Indexed, so applying it again replaces rather than grows.
 * - `escape-time 10`: Esc reaches the agent at once rather than waiting to see if it starts a sequence.
 * - `set-clipboard on`, `copy-command pbcopy`: a selection made in tmux (mouse drag) lands on the Mac's clipboard,
 *   and an agent's own OSC 52 copy does too.
 * - `focus-events on`: Claude Code asks for focus reports (`CSI ? 1004 h`).
 * - `status off`, `prefix None`: tmux is plumbing here. No status bar, and no prefix key to eat Ctrl-B, which Claude
 *   Code uses to background a command.
 * - `mouse on`: the wheel scrolls the session's history (tmux's copy mode), and a drag selects.
 * - `default-terminal screen-256color`: a TERM every macOS has (the app's own tmux is pinned to it too).
 * - `window-size latest`: sized by the client in use; conch's own client is `ignore-size` (`hostedAttachArgs`).
 */
export const CONCH_TMUX_OPTIONS: ReadonlyArray<readonly string[]> = [
  ["set-option", "-sq", "extended-keys", "always"],
  ["set-option", "-sq", "extended-keys-format", "csi-u"],
  ["set-option", "-sq", "terminal-features[90]", "xterm*:extkeys:RGB:clipboard:hyperlinks:usstyle:strikethrough:focus"],
  ["set-option", "-sq", "escape-time", "10"],
  ["set-option", "-sq", "set-clipboard", "on"],
  ["set-option", "-sq", "copy-command", "pbcopy"],
  ["set-option", "-sq", "focus-events", "on"],
  ["set-option", "-gq", "status", "off"],
  ["set-option", "-gq", "prefix", "None"],
  ["set-option", "-gq", "prefix2", "None"],
  ["set-option", "-gq", "mouse", "on"],
  ["set-option", "-gq", "history-limit", "50000"],
  ["set-option", "-gq", "default-terminal", "screen-256color"],
  ["set-option", "-gq", "window-size", "latest"],
];

/** What `new-session -P` and `list-panes` print for a hosted pane, tab-separated. */
export const HOSTED_FORMAT = "#{session_name}\t#{pane_id}\t#{pane_pid}\t#{socket_path}";

/** A pane in conch's server, as tmux describes it. */
export interface HostedPane {
  session: string;
  pane: string;
  panePid: number;
  socket: string;
}

/**
 * A session conch hosts, as the apps are told: enough to attach to it (`tmux -S <socket> attach -t =<session>`) with the
 * same tmux that started it.
 */
export interface HostedTerminal {
  /** The tmux binary conch's server runs (src/tmux-binary.ts). */
  tmux: string;
  /** The server's socket, absolute: `#{socket_path}`. */
  socket: string;
  /** The tmux session, `claude-conch-7k2f`. */
  session: string;
  /** The agent's pane, `%3`. */
  pane: string;
}

const PANE_ID = /^%\d+$/;
/** tmux refuses `.` and `:` in a session name; conch's own names are narrower still. */
const SESSION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function parseHostedPanes(text: string): HostedPane[] {
  const panes: HostedPane[] = [];
  for (const line of text.split("\n")) {
    const [session, pane, pid, socket] = line.split("\t");
    const panePid = Number(pid);
    if (!session || !pane || !PANE_ID.test(pane) || !Number.isSafeInteger(panePid) || panePid <= 1 || !socket?.startsWith("/")) continue;
    panes.push({ session, pane, panePid, socket: socket.trim() });
  }
  return panes;
}

/** The pane a process runs in: the one whose own process is the pid or one of its ancestors. */
export function paneHostingPid(pid: number, panes: readonly HostedPane[], parents: ReadonlyMap<number, number>): HostedPane | null {
  const byPid = new Map(panes.map((pane) => [pane.panePid, pane]));
  let current = pid;
  for (let step = 0; step < 64 && current > 1; step += 1) {
    const pane = byPid.get(current);
    if (pane) return pane;
    const parent = parents.get(current);
    if (parent === undefined || parent === current) break;
    current = parent;
  }
  return null;
}

/** A tmux session name for a new hosted session: the agent and the folder, and four random characters. */
export function hostedSessionName(backend: "claude" | "codex", cwd: string, random: () => number = Math.random): string {
  const folder = basename(cwd).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "home";
  const suffix = Array.from({ length: 4 }, () => "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(random() * 32) % 32]).join("");
  return `${backend}-${folder}-${suffix}`;
}

/**
 * The shell a hosted session runs its command in: the user's login shell, as Terminal opens one.
 * CONCH_SESSION_SHELL (an absolute path) replaces it, which only a test does, so no real agent is ever run.
 */
export function hostedShell(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env.CONCH_SESSION_SHELL?.trim();
  if (override?.startsWith("/")) return override;
  let shell: string | undefined;
  try { shell = userInfo().shell ?? undefined; } catch {}
  shell ||= env.SHELL;
  return shell?.startsWith("/") ? shell : "/bin/zsh";
}

/**
 * The environment conch's server is started with, and so every hosted session inherits: what Terminal gives a new
 * window, and nothing of the daemon's own (`CONCH_*`, a checkout's PATH, `TMUX`). The login shell then builds PATH from
 * the system's paths and the user's profile, as it does in Terminal. LANG defaults to UTF-8: an app launched from
 * Finder has none, and a tmux client without it draws everything past ASCII as `_`.
 */
export function hostedEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMUX_TMPDIR", "SSH_AUTH_SOCK", "__CF_USER_TEXT_ENCODING", "LANG", "LC_ALL", "LC_CTYPE"]) {
    const value = env[name];
    if (value) out[name] = value;
  }
  out.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  out.LANG ??= "en_US.UTF-8";
  return out;
}

/** The first size a new session has, before any client attaches and sizes it. */
export const HOSTED_INITIAL_SIZE = { columns: 120, rows: 40 } as const;

/**
 * The one tmux invocation that starts a hosted session: conch's server if it isn't running (with no config file), its
 * options, then the session, detached, in the folder, running `<login shell> -l -i -c <command>` — an interactive login
 * shell, as Terminal gives, so PATH and the rest match — and printing where it landed. `command` is
 * `terminalSessionCommand`'s, the same `cd … && exec <agent> <flags>` a Terminal window runs.
 */
export function hostedStartArgv(
  tmux: readonly string[],
  plan: { session: string; cwd: string; shell: string; command: string },
): string[] {
  if (!SESSION_NAME.test(plan.session)) throw new Error(`not a conch session name: ${plan.session}`);
  if (!plan.cwd.startsWith("/")) throw new Error("cwd must be an absolute path");
  if (!plan.shell.startsWith("/")) throw new Error("the session shell must be an absolute path");
  return [
    ...tmux, "-f", "/dev/null", "start-server",
    ...CONCH_TMUX_OPTIONS.flatMap((option) => [";", ...option]),
    ";", "new-session", "-d", "-P", "-F", HOSTED_FORMAT,
    "-s", plan.session, "-c", plan.cwd,
    "-x", String(HOSTED_INITIAL_SIZE.columns), "-y", String(HOSTED_INITIAL_SIZE.rows),
    "-e", "COLORTERM=truecolor",
    "--", plan.shell, "-l", "-i", "-c", plan.command,
  ];
}

/**
 * How the Mac app's Terminal tab attaches: UTF-8 (`-u`), the server by its socket path, the session by exact name,
 * and `ignore-size`. Measured on tmux 3.7c with two clients on one session: an `ignore-size` client alone sizes the
 * window as any client would; once another client (a Terminal window from "Open in Terminal") is attached, the window
 * follows that one, and typing in conch's view doesn't take it back. conch's view never resizes someone else's.
 */
export function hostedAttachArgs(hosted: Pick<HostedTerminal, "socket" | "session">, options: { ignoreSize: boolean }): string[] {
  if (!hosted.socket.startsWith("/")) throw new Error("socket must be an absolute path");
  if (!SESSION_NAME.test(hosted.session)) throw new Error(`not a conch session name: ${hosted.session}`);
  return ["-u", "-S", hosted.socket, "attach-session", ...(options.ignoreSize ? ["-f", "ignore-size"] : []), "-t", `=${hosted.session}`];
}

/**
 * "Open in Terminal" for a hosted session: a Terminal window attached to the same tmux session, so both views are live.
 * `exec`, so detaching (or the session ending) closes the tab rather than leaving a shell behind. A plain client, not
 * `ignore-size`: Terminal's window is one a person sized.
 */
export function hostedTerminalCommand(hosted: Pick<HostedTerminal, "tmux" | "socket" | "session">): string {
  if (!hosted.tmux.startsWith("/")) throw new Error("tmux must be an absolute path");
  return `exec ${[hosted.tmux, ...hostedAttachArgs(hosted, { ignoreSize: false })].map(shellQuote).join(" ")}`;
}

/** One POSIX shell word (agent-adapter.ts has the same; not imported, so the typing path stays light). */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Commands to conch's server that only read, in a scope of their own so they never hold up typing. */
const hostedScope: UICommandScope = { unreaped: new Set() };

export interface HostedReadDeps {
  /** conch's server argv (`conchTmuxArgv`); null when there is no tmux. */
  tmux: string[] | null;
  run(argv: string[]): Promise<UICommandResult>;
  parents(): Promise<ReadonlyMap<number, number> | null>;
}

export function defaultHostedReadDeps(tmux: string[] | null = conchTmuxArgv()): HostedReadDeps {
  return {
    tmux,
    run: (argv) => runUICommand(argv, undefined, { scope: hostedScope, timeoutMs: 2_000 }),
    parents: async () => {
      const result = await runUICommand(["ps", "-Ao", "pid=,ppid="], undefined, { scope: hostedScope, timeoutMs: 2_000 });
      if (result.timedOut || result.exitCode !== 0) return null;
      const table = new Map<number, number>();
      for (const line of result.text.split("\n")) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid!, ppid!);
      }
      return table;
    },
  };
}

/** Every pane in conch's server; empty when it isn't running (an instant non-zero exit) or can't be read. */
export async function listHostedPanes(deps: Pick<HostedReadDeps, "tmux" | "run">): Promise<HostedPane[]> {
  if (!deps.tmux) return [];
  const listed = await deps.run([...deps.tmux, "list-panes", "-a", "-F", HOSTED_FORMAT]);
  return listed.timedOut || listed.exitCode !== 0 ? [] : parseHostedPanes(listed.text);
}

/**
 * Which of these sessions conch hosts, and where: the pane of conch's server each one's process runs in. This is the
 * whole of re-adoption after a daemon restart. The server is the record; the daemon keeps nothing of its own.
 */
export async function readHostedTerminals(
  sessions: ReadonlyArray<{ sessionId: string; pid?: number }>,
  deps: HostedReadDeps,
): Promise<Map<string, HostedTerminal>> {
  const hosted = new Map<string, HostedTerminal>();
  const withPid = sessions.filter((session) => session.pid && session.pid > 1);
  if (!deps.tmux || withPid.length === 0) return hosted;
  const panes = await listHostedPanes(deps);
  if (panes.length === 0) return hosted;
  const parents = await deps.parents();
  if (!parents) return hosted;
  for (const session of withPid) {
    const pane = paneHostingPid(session.pid!, panes, parents);
    if (pane) hosted.set(session.sessionId, { tmux: deps.tmux[0]!, socket: pane.socket, session: pane.session, pane: pane.pane });
  }
  return hosted;
}

/** Is `path` a directory? A missing folder is refused before tmux is asked, with the same words Terminal's start uses. */
export function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/**
 * The daemon's view of which sessions it hosts, re-read from tmux at most every few seconds, or at once when the list
 * of sessions changes or a start or close says it must. A panel build can ask on every render without spawning tmux
 * and `ps` each time (#460 took an `lsof` per render out for the same reason).
 */
export class HostedTerminalCache {
  private map = new Map<string, HostedTerminal>();
  private at = Number.NEGATIVE_INFINITY;
  private signature = "";
  private stale = true;

  constructor(
    private readonly deps: HostedReadDeps,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 3_000,
  ) {}

  get(sessionId: string): HostedTerminal | undefined {
    return this.map.get(sessionId);
  }

  /** The next `refresh` reads tmux again. */
  invalidate(): void {
    this.stale = true;
  }

  async refresh(sessions: ReadonlyArray<{ sessionId: string; pid?: number }>): Promise<ReadonlyMap<string, HostedTerminal>> {
    const signature = sessions.map((session) => `${session.sessionId}:${session.pid ?? 0}`).sort().join(",");
    const now = this.now();
    if (!this.stale && signature === this.signature && now - this.at < this.ttlMs) return this.map;
    this.map = await readHostedTerminals(sessions, this.deps);
    this.at = now;
    this.signature = signature;
    this.stale = false;
    return this.map;
  }
}
