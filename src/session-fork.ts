import type { PanelSessionState } from "./panel.ts";
import { restartRequest } from "./session-lifecycle.ts";
import type { SessionInfo } from "./sessions.ts";

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
}

/** How long a fork waits to be seen before conch stops looking for it. */
export const FORK_ADOPT_WITHIN_MS = 5 * 60_000;

/**
 * Claude Code's own fork, `--resume <id> --fork-session`, built the way a restart relaunches (the same folder, account
 * and flags), with what couldn't be carried over. Codex and Claude background jobs aren't forked from conch yet.
 */
export function forkRequest(
  session: Pick<SessionInfo, "sessionId" | "agentSessionId" | "backend" | "cwd" | "claudeAccountId" | "codexAccountId" | "jobId">,
  args: readonly string[],
): ReturnType<typeof restartRequest> {
  if (session.backend === "codex") throw new Error("Codex sessions can't be forked from conch yet: fork it in Codex with `codex fork`");
  if (session.jobId) throw new Error("a background job can't be forked from conch yet: fork it from its terminal");
  const fork = restartRequest(session, args);
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
  if (!args?.includes("--fork-session")) return undefined;
  const flag = args.findIndex((arg) => arg === "--resume" || arg === "-r");
  const resumed = flag >= 0 ? args[flag + 1] : undefined;
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
