import type { SessionBackend } from "./agent-adapter.ts";
import type { SessionInfo } from "./sessions.ts";

/**
 * Starting a session for an agent, and answering once it runs (`conch_start`; daemon.ts `startLiveSession`).
 *
 * 2026-11-10, Tyler, on choosing which account a session runs on: "one session [uses] another account to create a fable
 * agent using conch for me since [this one is] out of credits". The agent that asked waits for the new session's id, to
 * read its reply with `conch_transcript_tail`. A new conversation's id is the agent's own to choose, so conch knows the
 * session by where it runs: the Terminal tab or the background host this start opened. Both launch with `exec`, so the
 * agent is the tab's shell, or the pane's own process, by then. The wait itself is the fork's (`awaitForkStart`).
 */

/** A start conch is waiting to see: where it runs, and what was already running before it. */
export interface PendingStart {
  backend: SessionBackend;
  /** When it was asked for (epoch ms). */
  at: number;
  /** The sessions conch already had when it was asked for: none of them is the new one. */
  before: ReadonlySet<string>;
  /** The Terminal tab it opened (`ttys012`). */
  tty?: string;
  /** Or conch's background host's session for it (`conch-<uuid>`). */
  backgroundId?: string;
}

export interface StartLookups {
  /** A process's controlling tty, as `ps -o tty=` says it; empty or "??" when it has none. */
  ttyOf(pid: number): Promise<string>;
  /** The process a background host's session runs (its pane's), by the session's name. */
  backgroundPid(name: string): Promise<number | undefined>;
}

/** How much earlier than the ask a session may say it started and still be this one: the registry's clock slack. */
const CLOCK_SLACK_MS = 10_000;

const bareTty = (tty: string) => tty.trim().replace(/^\/dev\//, "");

/**
 * The session a start opened, once conch has it: not one it had before, of the same agent, a session of its own (not a
 * subagent's row), started no earlier than the ask, and running where the start opened (`tty`, or the background host's
 * pane). Undefined until then.
 */
export async function startedSessionFor(
  sessions: Iterable<SessionInfo>,
  pending: PendingStart,
  look: StartLookups,
): Promise<SessionInfo | undefined> {
  let backgroundPid: number | undefined;
  let lookedForPane = false;
  for (const session of sessions) {
    const pid = session.pid ?? session.agentPid;
    if (!pid || pending.before.has(session.sessionId) || session.parentSessionId) continue;
    if ((session.backend ?? "claude") !== pending.backend) continue;
    if (session.startedAt !== undefined && session.startedAt < pending.at - CLOCK_SLACK_MS) continue;
    if (pending.tty) {
      if (bareTty(await look.ttyOf(pid).catch(() => "")) === bareTty(pending.tty)) return session;
    } else if (pending.backgroundId) {
      if (!lookedForPane) {
        backgroundPid = await look.backgroundPid(pending.backgroundId).catch(() => undefined);
        lookedForPane = true;
      }
      if (backgroundPid === pid) return session;
    }
  }
}
