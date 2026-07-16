import type { SessionInfo } from "./sessions.ts";

/** The three states a session row can show in the dashboard panel. */
export type SessionStatus = "working" | "waiting" | "needs";

/** A panel state latched from a hook event, with the epoch-ms it was latched. */
export interface LatchedState {
  status: SessionStatus;
  at: number;
}

export interface DashboardMode {
  muted: boolean;
  paused: boolean;
  holding: number;
}

/** Global mode occupies one permanent slot so rows never jump on toggle. */
export function dashboardModeBanner({ muted, paused, holding }: DashboardMode): string {
  if (muted) return "  \x1b[1;33m🔇 MUTED · press m to unmute\x1b[0m";
  if (paused) return `  \x1b[1;35m⏸ PAUSED · holding ${holding} · press p to resume\x1b[0m`;
  return "";
}

/** Compose the pinned panel chrome, including its always-reserved mode line. */
export function dashboardPanelLines(rows: string[], columns: number, mode: DashboardMode): string[] {
  const rule = "  \x1b[2m" + "─".repeat(Math.max(10, columns - 4)) + "\x1b[0m";
  return [
    "",
    "  \x1b[1m🐚 conch\x1b[0m",
    dashboardModeBanner(mode),
    rule,
    ...rows,
  ];
}

/**
 * Keep the newest per-session latch when LIFO handling delivers events out of
 * occurrence order. Equal timestamps accept the incoming event; only a known-
 * older event is stale.
 */
export function latestLatchedState(
  current: LatchedState | undefined,
  incoming: LatchedState,
): LatchedState {
  return current && current.at > incoming.at ? current : incoming;
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
 * Hook-originated latches carry their event time, so LIFO queue handling cannot
 * make an older state appear newer than either a later hook or registry update.
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
