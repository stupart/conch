import type { SessionInfo } from "./sessions.ts";

/** The three states a session row can show in the dashboard panel. */
export type SessionStatus = "working" | "waiting" | "needs";

/** A panel state latched from a hook event, with the epoch-ms it was latched. */
export interface LatchedState {
  status: SessionStatus;
  at: number;
}

/**
 * Map Claude Code's registry `status` onto a panel state. The registry is the
 * authoritative source of "is this session working or waiting on me":
 *  - `idle` → the turn is done, ready for your next prompt (waiting)
 *  - `busy` / `running` / `shell` → actively doing something (working)
 *  - `waiting` / `blocked` → blocked needing input: a permission prompt, dialog,
 *    or sandbox/worker request (needs a response)
 *  - anything else (unknown/future status) → null, i.e. defer to the latched value
 */
export function registryToPanel(status: string | undefined): SessionStatus | null {
  switch (status) {
    case "idle":
      return "waiting";
    case "busy":
    case "running":
    case "shell":
      return "working";
    case "waiting":
    case "blocked":
      return "needs";
    default:
      return null;
  }
}

/**
 * Reconcile a panel row from two signals — the latched hook event and the
 * registry status — by trusting whichever is NEWER. This is the core of BUG A
 * ("says waiting while it's actually working"):
 *
 *  - The registry updates on real state changes, so when a session resumes work
 *    WITHOUT firing UserPromptSubmit (auto-compaction continue, background-
 *    subagent auto-continue, /resume, steering input) its newer `busy` status
 *    overrides the stale "waiting" latch.
 *  - A just-received latch (e.g. "working" the instant you submit) is newer than
 *    the last registry snapshot, so it wins — no "waiting" flicker before the
 *    registry catches up.
 *
 * A "needs" (permission prompt) therefore shows while it's the newest signal and
 * auto-clears the moment a newer event or status change lands. Ties go to the
 * latch (an event we were explicitly handed). With neither signal, null → dim idle.
 *
 * NOTE: the latch timestamp is stamped when the daemon HANDLES the event, not
 * when it occurred; under heavy LIFO-queue reordering that can make a "needs"
 * stickier than ideal (never falsely clears — it errs safe). Event-time stamping
 * is a deferred refinement.
 */
export function reconcileStatus(
  session: Pick<SessionInfo, "status" | "statusUpdatedAt">,
  latched: LatchedState | undefined,
): SessionStatus | null {
  const reg = registryToPanel(session.status);
  const regAt = session.statusUpdatedAt ?? 0;
  if (latched && latched.at >= regAt) return latched.status;
  if (reg) return reg;
  return latched?.status ?? null;
}

/** Sort order: what needs you first, then waiting, then working. */
export const STATUS_RANK: Record<SessionStatus, number> = { needs: 0, waiting: 1, working: 2 };
