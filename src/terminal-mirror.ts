import { runUICommand, type UICommandResult, type UICommandScope } from "./pasteboard.ts";
import { withUITransaction } from "./inject.ts";

/**
 * The agent's own terminal, for the Mac app's Terminal tab: where the session's Claude Code or Codex is running, and
 * what that terminal shows, read without touching focus.
 *
 * Two hosts, and each is read the cheapest exact way it allows:
 *  - a tmux pane: its screen as text with every colour and attribute (`capture-pane -e`), one short-lived tmux call per
 *    read. Exact text, so the app can select and copy it.
 *  - a Terminal.app tab: WHICH WINDOW holds it (Terminal's window id is the window server's), for the app to picture
 *    with ScreenCaptureKit. On request, also the tab's own text (`contents of tab`) — no colour and no attributes, so it
 *    is only what the app shows while it can't take the picture (Screen Recording not yet allowed, the session's tab
 *    behind another in its window, the window minimised).
 *
 * Nothing here types, raises or selects anything, except `focus`, which runs only on a press of "Open in Terminal".
 *
 * Its reads run in their own command scope, never the typing paths' one: a tmux or `ps` that hung here must never be
 * what suspends conch's keystrokes ("Previous UI child has not exited"), and a read every few hundred milliseconds
 * must never queue behind a delivery.
 */

export type TerminalScreenReply =
  | {
    kind: "terminal-screen";
    sessionId: string;
    host: "tmux";
    /** tmux's pane id, `%12`. */
    pane: string;
    columns: number;
    rows: number;
    /** Where the pane's cursor is, when the program shows one. */
    cursor?: { x: number; y: number };
    /** On the alternate screen (a full-screen TUI). */
    alternate?: true;
    /** `capture-pane -p -e -N`: one line per row, SGR sequences for colour and attributes. */
    screen: string;
  }
  | {
    kind: "terminal-screen";
    sessionId: string;
    host: "terminal";
    /** The session's tty, `ttys012`. */
    tty: string;
    /** Terminal's `id of window`, which is the window server's window number: what ScreenCaptureKit names it by. */
    window: number;
    minimized: boolean;
    /** Is the session's tab the one its window is showing? A picture of the window is of that tab. */
    selected: boolean;
    /** `contents of tab`, when asked for: the tab's text, without colour. */
    text?: string;
  }
  | {
    kind: "terminal-screen";
    sessionId: string;
    host: "none";
    /** Why there is nothing to show, in words the tab can say as they are. */
    reason: string;
  };

export interface TerminalFocusReply {
  kind: "terminal-focus";
  sessionId: string;
  focused: boolean;
  reason?: string;
}

/** What the daemon knows about the session asked for: its process, or why it has no terminal. */
export interface TerminalMirrorSession {
  pid?: number;
  noTerminal?: string;
}

export interface TerminalMirrorDeps {
  /** A read-only command (tmux, ps), in the mirror's own scope. */
  run(argv: string[]): Promise<UICommandResult>;
  /** A read-only AppleScript, in the mirror's own scope. */
  osa(script: string): Promise<UICommandResult>;
  /** An AppleScript that changes what is in front: `focus` only, inside the typing paths' transaction. */
  focusOsa(script: string): Promise<UICommandResult>;
  /** Serialise with every other UI action (typing, reveal). */
  transaction<T>(work: () => Promise<T>): Promise<T>;
  now(): number;
  /** The tmux command, with any socket flags, as argv. */
  tmux: string[];
}

/**
 * A pid's host, as found. A pane is kept until reading it fails: a process never changes pane. Anything else is looked
 * for again after a while, so one slow `tmux list-panes` can't leave a tmux session read as a bare tty for good.
 */
type Host = { kind: "tmux"; pane: string } | { kind: "tty"; tty: string } | { kind: "none"; reason: string };

/** How long "not in tmux" is believed before looking again. */
export const HOST_RETRY_MS = 15_000;
/** Entries for pids nobody has asked about for this long are dropped. */
export const HOST_FORGET_MS = 120_000;

const TMUX_META = "#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{cursor_flag} #{alternate_on}";
const TTY = /^ttys?\d+$/;
const PANE = /^%\d+$/;

export const NOT_IN_TERMINAL = "This session isn't running in a terminal conch can see: only Terminal and tmux are mirrored here.";
export const NO_PROCESS = "conch doesn't know this session's process, so it can't find its terminal.";
export const UNKNOWN_SESSION = "conch doesn't know this session.";

const mirrorScope: UICommandScope = { unreaped: new Set() };

/** osascript's argv for a script given line by line. */
function osaArgv(script: string): string[] {
  return ["osascript", ...script.split("\n").filter((line) => line.trim()).flatMap((line) => ["-e", line])];
}

export function defaultTerminalMirrorDeps(): TerminalMirrorDeps {
  return {
    run: (argv) => runUICommand(argv, undefined, { scope: mirrorScope, timeoutMs: 2_000 }),
    osa: (script) => runUICommand(osaArgv(script), undefined, { scope: mirrorScope, timeoutMs: 3_000 }),
    focusOsa: (script) => runUICommand(osaArgv(script), undefined, { timeoutMs: 4_000 }),
    transaction: withUITransaction,
    now: () => Date.now(),
    tmux: ["tmux"],
  };
}

/**
 * Terminal's window and tab for a tty, read without launching Terminal: a `tell` to an app that isn't running opens
 * it, so that is asked first. `character id 9` because inside Terminal's `tell`, `tab` names its tab class.
 */
export function terminalLocateScript(tty: string, withText: boolean): string {
  if (!TTY.test(tty)) throw new Error(`not a tty: ${tty}`);
  return `
if application "Terminal" is not running then return "conch:notrunning"
tell application "Terminal"
repeat with wi from 1 to count windows
repeat with ti from 1 to count tabs of window wi
if tty of tab ti of window wi is "/dev/${tty}" then
set found to (id of window wi as text) & (character id 9) & (miniaturized of window wi as text) & (character id 9) & (selected of tab ti of window wi as text)
${withText ? "return found & (character id 10) & (contents of tab ti of window wi)" : "return found"}
end if
end repeat
end repeat
end tell
return "conch:notfound"`;
}

/**
 * Bring the Terminal tab on this tty forward to type in: out of the Dock if minimised, its tab selected, its window
 * first, Terminal active. Only ever run on a press.
 */
export function terminalFocusScript(tty: string): string {
  if (!TTY.test(tty)) throw new Error(`not a tty: ${tty}`);
  return `
if application "Terminal" is not running then return "conch:notrunning"
tell application "Terminal"
repeat with w in windows
repeat with t in tabs of w
if tty of t is "/dev/${tty}" then
if miniaturized of w then set miniaturized of w to false
set selected tab of w to t
set index of w to 1
activate
return "ok"
end if
end repeat
end repeat
end tell
return "conch:notfound"`;
}

/** `display-message` then `capture-pane`, as one tmux call: the size line first, then the screen. */
export function tmuxCaptureArgv(tmux: string[], pane: string): string[] {
  if (!PANE.test(pane)) throw new Error(`not a tmux pane: ${pane}`);
  return [...tmux, "display-message", "-p", "-t", pane, TMUX_META, ";", "capture-pane", "-p", "-e", "-N", "-t", pane];
}

/** The size line and the screen, out of one capture. Null when the first line isn't the size line. */
export function parseTmuxCapture(output: string): {
  columns: number; rows: number; cursor?: { x: number; y: number }; alternate: boolean; screen: string;
} | null {
  const newline = output.indexOf("\n");
  const head = newline < 0 ? output : output.slice(0, newline);
  const fields = head.trim().split(" ").map(Number);
  if (fields.length !== 6 || fields.some((value) => !Number.isSafeInteger(value) || value < 0)) return null;
  const [columns, rows, x, y, cursorShown, alternate] = fields as [number, number, number, number, number, number];
  if (columns < 1 || rows < 1) return null;
  return {
    columns,
    rows,
    ...(cursorShown === 1 && x < columns && y < rows ? { cursor: { x, y } } : {}),
    alternate: alternate === 1,
    screen: newline < 0 ? "" : output.slice(newline + 1),
  };
}

/** Terminal's answer to `terminalLocateScript`, or why there isn't one. */
export function parseTerminalLocate(output: string): { window: number; minimized: boolean; selected: boolean; text?: string } | "notrunning" | "notfound" | null {
  const trimmed = output.replace(/\n$/, "");
  if (trimmed.trim() === "conch:notrunning") return "notrunning";
  if (trimmed.trim() === "conch:notfound") return "notfound";
  const newline = trimmed.indexOf("\n");
  const head = newline < 0 ? trimmed : trimmed.slice(0, newline);
  const [id, minimized, selected] = head.split("\t");
  const window = Number(id);
  if (!Number.isSafeInteger(window) || window <= 0) return null;
  if ((minimized !== "true" && minimized !== "false") || (selected !== "true" && selected !== "false")) return null;
  return {
    window,
    minimized: minimized === "true",
    selected: selected === "true",
    ...(newline < 0 ? {} : { text: trimmed.slice(newline + 1) }),
  };
}

/** The pane whose process is an ancestor of `pid`, from one `list-panes` and one `ps` of every process. */
export function paneForPid(pid: number, panes: string, processes: string): string | null {
  const byPid = new Map<number, string>();
  for (const line of panes.split("\n")) {
    const [panePid, pane] = line.trim().split(" ");
    if (panePid && pane && PANE.test(pane)) byPid.set(Number(panePid), pane);
  }
  if (!byPid.size) return null;
  const parent = new Map<number, number>();
  for (const line of processes.split("\n")) {
    const [child, parentPid] = line.trim().split(/\s+/).map(Number);
    if (child && parentPid !== undefined && Number.isSafeInteger(parentPid)) parent.set(child, parentPid);
  }
  // Bounded, so a cycle in a bogus table ends rather than spinning; no real tree is 64 deep.
  let current = pid;
  for (let step = 0; step < 64 && current > 1; step++) {
    const pane = byPid.get(current);
    if (pane) return pane;
    const next = parent.get(current);
    if (!next) break;
    current = next;
  }
  return null;
}

export interface TerminalMirror {
  screen(sessionId: string, session: TerminalMirrorSession | undefined, options?: { text?: boolean }): Promise<TerminalScreenReply>;
  focus(sessionId: string, session: TerminalMirrorSession | undefined): Promise<TerminalFocusReply>;
}

export function createTerminalMirror(deps: TerminalMirrorDeps = defaultTerminalMirrorDeps()): TerminalMirror {
  const hosts = new Map<number, { host: Host; at: number; used: number }>();

  const ok = (result: UICommandResult): boolean => !result.timedOut && result.exitCode === 0;

  const forgetIdle = (now: number): void => {
    for (const [pid, entry] of hosts) if (now - entry.used > HOST_FORGET_MS) hosts.delete(pid);
  };

  const locate = async (pid: number): Promise<Host> => {
    const now = deps.now();
    forgetIdle(now);
    const known = hosts.get(pid);
    if (known && (known.host.kind === "tmux" || now - known.at < HOST_RETRY_MS)) {
      known.used = now;
      return known.host;
    }
    let host: Host = { kind: "none", reason: NOT_IN_TERMINAL };
    // No tmux server is the common case, and an instant non-zero exit.
    const panes = await deps.run([...deps.tmux, "list-panes", "-a", "-F", "#{pane_pid} #{pane_id}"]);
    if (ok(panes) && panes.text.trim()) {
      const processes = await deps.run(["ps", "-A", "-o", "pid=,ppid="]);
      const pane = ok(processes) ? paneForPid(pid, panes.text, processes.text) : null;
      if (pane) host = { kind: "tmux", pane };
    }
    if (host.kind === "none") {
      const tty = await deps.run(["ps", "-o", "tty=", "-p", String(pid)]);
      const name = ok(tty) ? tty.text.trim() : "";
      if (TTY.test(name)) host = { kind: "tty", tty: name };
    }
    hosts.set(pid, { host, at: now, used: now });
    return host;
  };

  const none = (sessionId: string, reason: string): TerminalScreenReply => ({ kind: "terminal-screen", sessionId, host: "none", reason });

  const captureTmux = async (sessionId: string, pane: string): Promise<TerminalScreenReply | null> => {
    const result = await deps.run(tmuxCaptureArgv(deps.tmux, pane));
    if (!ok(result)) return null;
    const parsed = parseTmuxCapture(result.text);
    if (!parsed) return null;
    return {
      kind: "terminal-screen",
      sessionId,
      host: "tmux",
      pane,
      columns: parsed.columns,
      rows: parsed.rows,
      ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
      ...(parsed.alternate ? { alternate: true as const } : {}),
      screen: parsed.screen,
    };
  };

  const locateTerminal = async (sessionId: string, tty: string, text: boolean): Promise<TerminalScreenReply> => {
    const result = await deps.osa(terminalLocateScript(tty, text));
    if (!ok(result)) {
      return none(sessionId, /-1743|not allowed|not authori[sz]ed/i.test(result.stderr)
        ? "conch isn't allowed to control Terminal: allow conch in Automation."
        : "Terminal didn't answer conch just now.");
    }
    const found = parseTerminalLocate(result.text);
    if (found === "notrunning" || found === "notfound" || found === null) return none(sessionId, NOT_IN_TERMINAL);
    return {
      kind: "terminal-screen",
      sessionId,
      host: "terminal",
      tty,
      window: found.window,
      minimized: found.minimized,
      selected: found.selected,
      ...(text && found.text !== undefined ? { text: found.text } : {}),
    };
  };

  return {
    async screen(sessionId, session, options = {}) {
      if (!session) return none(sessionId, UNKNOWN_SESSION);
      if (session.noTerminal) return none(sessionId, session.noTerminal);
      if (!session.pid) return none(sessionId, NO_PROCESS);
      let host = await locate(session.pid);
      if (host.kind === "tmux") {
        const shown = await captureTmux(sessionId, host.pane);
        if (shown) return shown;
        // The pane is gone (the session moved out of tmux, or the server restarted): find it again, once.
        hosts.delete(session.pid);
        host = await locate(session.pid);
        if (host.kind === "tmux") return await captureTmux(sessionId, host.pane) ?? none(sessionId, "tmux didn't answer conch just now.");
      }
      if (host.kind === "tty") return await locateTerminal(sessionId, host.tty, options.text === true);
      return none(sessionId, host.reason);
    },

    async focus(sessionId, session) {
      const refused = (reason: string): TerminalFocusReply => ({ kind: "terminal-focus", sessionId, focused: false, reason });
      if (!session) return refused(UNKNOWN_SESSION);
      if (session.noTerminal) return refused(session.noTerminal);
      if (!session.pid) return refused(NO_PROCESS);
      const host = await locate(session.pid);
      if (host.kind === "none") return refused(host.reason);
      return deps.transaction(async () => {
        let tty: string;
        if (host.kind === "tmux") {
          // The terminal tmux is attached in: the most recently used client of the pane's own session.
          const owner = await deps.run([...deps.tmux, "display-message", "-p", "-t", host.pane, "#{session_id}"]);
          const clientsOf = ok(owner) ? owner.text.trim() : "";
          if (!clientsOf) return refused("tmux didn't answer conch just now.");
          const clients = await deps.run([...deps.tmux, "list-clients", "-t", clientsOf, "-F", "#{client_activity} #{client_tty}"]);
          const newest = (ok(clients) ? clients.text : "").split("\n")
            .map((line) => line.trim().split(" "))
            .filter(([activity, path]) => activity && path?.startsWith("/dev/"))
            .sort((a, b) => Number(b[0]) - Number(a[0]))[0];
          if (!newest) return refused("No terminal window is attached to this session's tmux.");
          // Its window and pane, so the terminal that comes forward is showing the session.
          await deps.run([...deps.tmux, "select-window", "-t", host.pane, ";", "select-pane", "-t", host.pane]);
          tty = newest[1]!.slice("/dev/".length);
          if (!TTY.test(tty)) return refused(NOT_IN_TERMINAL);
        } else {
          tty = host.tty;
        }
        const result = await deps.focusOsa(terminalFocusScript(tty));
        if (ok(result) && result.text.trim() === "ok") return { kind: "terminal-focus", sessionId, focused: true };
        if (!ok(result) && /-1743|not allowed|not authori[sz]ed/i.test(result.stderr)) {
          return refused("conch isn't allowed to control Terminal: allow conch in Automation.");
        }
        return refused(host.kind === "tmux"
          ? "tmux is attached in a terminal conch can't bring forward: only Terminal is."
          : "conch couldn't find this session's Terminal window.");
      });
    },
  };
}
