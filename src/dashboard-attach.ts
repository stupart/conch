import { anotherDaemonIsListening } from "./control-server.ts";
import { readIdentity, type DaemonIdentity } from "./daemon-identity.ts";
import { LOG_FILE } from "./status.ts";

/**
 * What `conch` and `conch dashboard` do: find the daemon's dashboard, and attach to it or say where it is (2026-11-11).
 *
 * They used to attach to a tmux session named `conch`, which the launchd install made. Nothing has made one since
 * launchd started running the daemon directly (2026-08-10), so with launchd's daemon up `conch` said the Mac app was
 * hosting it, and with none it waited for ever for `conch install`. The daemon draws its terminal dashboard only on a
 * terminal of its own, so the question is who started it, which its identity file says (daemon-identity.ts):
 *  - the Mac app: the app's window is the dashboard;
 *  - launchd: there is no terminal, so no dashboard to attach to; the app attaches to that daemon, and the log and
 *    `conch sessions` read it;
 *  - a terminal (`conch daemon` by hand): the dashboard is in that terminal, and when it is a tmux pane, `conch`
 *    attaches to it.
 */
export type DashboardTarget =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "app"; pid: number; answering: boolean }
  | { kind: "launchd"; pid: number; answering: boolean }
  | { kind: "terminal"; pid: number; answering: boolean; tty: string | null; tmuxSession: string | null };

export interface DashboardDeps {
  identity?: () => DaemonIdentity | null;
  answering?: (socketPath: string) => Promise<boolean>;
  /** The controlling terminal of a pid as `ps` names it (`ttys004`), or null for none. */
  ttyOf?: (pid: number) => string | null;
  /** The tmux session whose pane is on that terminal, or null. */
  tmuxSessionOn?: (tty: string) => string | null;
  say?: (text: string) => void;
}

export async function locateDashboard(socketPath: string, deps: DashboardDeps = {}): Promise<DashboardTarget> {
  const read = (deps.identity ?? readIdentity)();
  // The identity file is one per home; a daemon on another socket (a test's, an e2e's) is not this one.
  const identity = read && (!read.socketPath || read.socketPath === socketPath) ? read : null;
  const answering = await (deps.answering ?? anotherDaemonIsListening)(socketPath);
  if (!identity) return answering ? { kind: "unknown" } : { kind: "none" };
  const { pid, startedBy } = identity;
  if (startedBy !== "terminal") return { kind: startedBy, pid, answering };
  const tty = (deps.ttyOf ?? ttyOf)(pid);
  const tmuxSession = tty ? (deps.tmuxSessionOn ?? tmuxSessionOn)(tty) : null;
  return { kind: "terminal", pid, answering, tty, tmuxSession };
}

export function describeDashboard(target: DashboardTarget, socketPath: string, logFile = LOG_FILE): string {
  const watch = `\`conch sessions\` lists its sessions, and \`tail -f ${logFile}\` follows what it does.`;
  const quiet = (t: { answering: boolean }) => t.answering ? "" : ` It isn't answering on ${socketPath} yet.`;
  switch (target.kind) {
    case "none":
      return "conch's daemon isn't running, so there is no dashboard. Open conch.app: it hosts the daemon and is the"
        + " dashboard. Without the app, `conch service install` has launchd run it.";
    case "unknown":
      return `A daemon answers on ${socketPath}, but it left no note of who started it. conch.app shows it when the app`
        + ` is open; ${watch}`;
    case "app":
      return `The Mac app is hosting conch's daemon (pid ${target.pid}), and the app is the dashboard: look at conch.app.`
        + ` Nothing to attach to here.${quiet(target)}`;
    case "launchd":
      return `launchd is running conch's daemon (pid ${target.pid}, \`conch service\`). It has no terminal, so it draws`
        + ` no dashboard. conch.app attaches to it when you open the app; ${watch}${quiet(target)}`;
    case "terminal":
      if (target.tmuxSession) {
        return `conch dashboard  ·  the daemon (pid ${target.pid}) draws it in tmux session "${target.tmuxSession}"`
          + "  ·  ctrl-b d to detach (leaves the daemon running)";
      }
      return target.tty
        ? `conch's daemon (pid ${target.pid}) was started in a terminal, and its dashboard is in that terminal`
          + ` (${target.tty}). It isn't a tmux pane, so there is nothing to attach to from here.${quiet(target)}`
        : `conch's daemon (pid ${target.pid}) was started with no terminal, so it draws no dashboard. ${watch}`
          + quiet(target);
  }
}

/** `conch` / `conch dashboard`: attach where there is a dashboard to attach to, else say where to look. Exit code. */
export async function openDashboard(socketPath: string, deps: DashboardDeps = {}): Promise<number> {
  const target = await locateDashboard(socketPath, deps);
  (deps.say ?? console.log)(describeDashboard(target, socketPath));
  if (target.kind === "terminal" && target.tmuxSession) {
    const tmux = Bun.which("tmux");
    if (!tmux) return 1;
    // Inside tmux already, attaching would nest one tmux in another: switch this client instead.
    const verb = process.env.TMUX ? "switch-client" : "attach";
    return Bun.spawnSync([tmux, verb, "-t", `=${target.tmuxSession}`], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).exitCode ?? 1;
  }
  return target.kind === "none" ? 1 : 0;
}

function ttyOf(pid: number): string | null {
  try {
    const out = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(pid)]).stdout.toString().trim();
    return out && out !== "??" && out !== "?" ? out : null;
  } catch {
    return null;
  }
}

function tmuxSessionOn(tty: string): string | null {
  // The person's own tmux, where they would have run `conch daemon`, not the private server conch's background
  // sessions use. No tmux, no pane: never an error.
  const tmux = Bun.which("tmux");
  if (!tmux) return null;
  try {
    const listed = Bun.spawnSync([tmux, "list-panes", "-a", "-F", "#{pane_tty}\t#{session_name}"]);
    if (listed.exitCode !== 0) return null;
    for (const line of listed.stdout.toString().split("\n")) {
      const [paneTty, session] = line.split("\t");
      if (session && paneTty === `/dev/${tty}`) return session;
    }
  } catch {}
  return null;
}
