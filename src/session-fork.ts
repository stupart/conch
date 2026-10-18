import type { PanelSessionState } from "./panel.ts";
import { restartRequest } from "./session-lifecycle.ts";
import type { SessionInfo } from "./sessions.ts";
import type { TabAgentState } from "./agent-alive.ts";

/**
 * Forking a session from conch (2026-10-09, Tyler: "we should make it easier to fork sessions in app and have them bring
 * over a snapshot of the current conch plugin review / deliverables that the last session had when u fork. (just did a
 * bunch of forks but had to do it through terminal)"). The daemon starts the fork (`forkLiveSession`) and adopts it when
 * Claude Code has given it an id (`adoptForks`); these are the decisions it makes, kept here to be tested.
 */

/** A fork conch started and has not yet seen appear. */
export interface PendingFork {
  parentId: string;
  /** The conversation it resumes: the original's Claude Code session id. */
  conversationId: string;
  /** The original's label, for the fork's. */
  label: string;
  /** When it was asked for (epoch ms). */
  at: number;
  /** The label asked for it (`conch_fork`'s `label`); else it is "<label> · fork". */
  forkLabel?: string;
}

/** How long a fork waits to be seen before conch stops looking for it. */
export const FORK_ADOPT_WITHIN_MS = 5 * 60_000;

/**
 * The agent's own fork of the conversation, built the way a restart relaunches (the same folder, account and flags),
 * with what couldn't be carried over:
 * - Claude Code: `--resume <id> --fork-session`;
 * - Codex: `codex fork <id>` (`forkArgs`);
 * - a Claude background job, whose flags live in Claude Code's own daemon where nothing can read them: its conversation,
 *   forked in conch's background host with the defaults a new session gets.
 */
export function forkRequest(
  session: Pick<SessionInfo, "sessionId" | "agentSessionId" | "backend" | "cwd" | "claudeAccountId" | "codexAccountId" | "jobId">,
  args: readonly string[],
): ReturnType<typeof restartRequest> {
  if (session.jobId) {
    return {
      request: {
        backend: "claude",
        host: "background",
        resumeSessionId: session.agentSessionId ?? session.sessionId,
        ...(session.cwd ? { cwd: session.cwd } : {}),
        ...(session.claudeAccountId ? { claudeAccountId: session.claudeAccountId } : {}),
        options: { "fork-session": true },
      },
      notCarriedOver: ["the flags it was started with (a background job's can't be read)"],
    };
  }
  const fork = restartRequest(session, args);
  if ((session.backend ?? "claude") === "codex") {
    fork.request.fork = true;
    return fork;
  }
  fork.request.options = { ...fork.request.options, "fork-session": true };
  return fork;
}

/**
 * The pending fork a new session is, if it is one: a process resuming that fork's conversation with --fork-session,
 * started no earlier than the fork was asked for (less a little clock slack), and not the original itself.
 */
export function pendingForkFor(
  session: Pick<SessionInfo, "sessionId" | "startedAt">,
  args: readonly string[] | null,
  pending: readonly PendingFork[],
): PendingFork | undefined {
  if (!args) return undefined;
  // Claude Code: `--resume <id> --fork-session`. Codex: `fork <id>`, a subcommand after any global flags.
  const flag = args.findIndex((arg) => arg === "--resume" || arg === "-r");
  const subcommand = args.indexOf("fork");
  const resumed = args.includes("--fork-session") && flag >= 0 ? args[flag + 1]
    : subcommand >= 0 ? args[subcommand + 1]
    : undefined;
  if (!resumed) return undefined;
  return pending.find((fork) => fork.conversationId === resumed && fork.parentId !== session.sessionId
    && (session.startedAt ?? 0) >= fork.at - 10_000);
}

/**
 * The fork's state once it holds its parent's deliverables: the same files and versions, each marked looked at (they
 * are the parent's news, not the fork's), the parent's current one current. With no state of its own yet, it gets the
 * oldest-truth latch a filed review gets, so the registry or the next hook decides its status. Undefined when the
 * parent holds nothing.
 */
export function inheritedState(
  parent: PanelSessionState | undefined,
  child: PanelSessionState | undefined,
  label: string,
  now: number,
): PanelSessionState | undefined {
  const held = parent?.reviews ?? (parent?.review ? [parent.review] : []);
  if (!parent || !held.length) return undefined;
  const reviews = held.map((review) => ({ ...review, viewedAt: review.viewedAt ?? now }));
  return {
    ...(child ?? { label, status: "waiting" as const, at: 0 }),
    reviews,
    review: reviews.find((review) => review.id === parent.review?.id) ?? reviews.at(-1)!,
    ...(parent.versions ? { versions: { ...parent.versions } } : {}),
  };
}

/**
 * How long a fork an agent asked for (`conch_fork`, the `wait` of a `session-fork`) is waited on before conch answers
 * that it is running but not yet seen. Under the MCP call's own budget (`CONCH_FORK_REPLY_MS` in mcp.ts), which is under
 * Codex's 60 s tool timeout.
 */
export const FORK_WAIT_MS = 25_000;

/** How long a tab running nothing is given, before conch has seen its agent in it, to count as gone: a slow Terminal's first look. */
export const FORK_START_GRACE_MS = 6_000;

export interface ForkStartWatch {
  /** Settles when `adoptForks` has seen the fork as a session of its own. */
  adopted: Promise<{ forkId: string; label: string }>;
  /** What its tab is running now (`tabAgentState`); "unknown" when it has no tab (conch's background host). */
  state(): Promise<TabAgentState>;
  /** What its tab shows, once the agent has gone. */
  lastWords(): Promise<string | undefined>;
  /** Ask for a registry read, so `adoptForks` looks again. */
  look(): void;
  /** Where it runs, in words: "Terminal (ttys012)". */
  where: string;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * Wait for a fork an agent asked for: its id once conch has adopted it; that it is running, and where, when it is
 * alive but not yet seen by the deadline; or an error with what its tab said when the agent exited. The 18 Oct
 * failure: `conch start --resume … --fork-session` said "opened" for a Claude Code that had died at once under the
 * wrong profile, and the agent told the user the fork was open.
 */
export async function awaitForkStart(
  watch: ForkStartWatch,
  options: { withinMs?: number; graceMs?: number; everyMs?: number } = {},
): Promise<{ forkId: string; label: string } | { running: string }> {
  const { withinMs = FORK_WAIT_MS, graceMs = FORK_START_GRACE_MS, everyMs = 1_000 } = options;
  const started = watch.now();
  let adopted: { forkId: string; label: string } | undefined;
  void watch.adopted.then((value) => { adopted = value; }, () => {});
  let seenRunning = false;
  const gone = async (how: string): Promise<never> => {
    const words = await watch.lastWords().catch(() => undefined);
    throw new Error(`${how}, in ${watch.where}${words ? `. Its tab shows:\n${words}` : ""}`);
  };
  for (;;) {
    await Promise.race([watch.adopted.catch(() => {}), watch.sleep(everyMs)]);
    if (adopted) return adopted;
    const waited = watch.now() - started;
    const state = await watch.state();
    if (state === "running") seenRunning = true;
    // Gone stays gone; a moment's grace only for a tab whose agent conch has not seen yet.
    if (state === "gone" && (seenRunning || waited >= graceMs)) await gone("the fork's agent exited as soon as it started");
    if (waited >= withinMs) {
      // Still only its shell: the command never ran (a folder that has gone, a shell that stopped on an error).
      if (state === "starting" && !seenRunning) await gone("the fork's tab never started its agent");
      return { running: watch.where };
    }
    watch.look();
  }
}
