import { sessionLabel, type SessionInfo } from "./sessions.ts";

export type PanelConchState = "idle" | "muted" | "paused" | "speaking" | "listening" | "recording" | "transcribing";

export interface PanelLiveState {
  state: PanelConchState;
  label: string;
  partial: string;
  /** Theater-only committed transcript shown before the current live partial. */
  transcriptPrefix?: string;
  /** Chunk-level reading progress. The audio backend does not expose word timing. */
  reading?: { text: string; spokenChars: number };
}

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

export interface PanelRowModel {
  sessionId: string;
  label: string;
  status: SessionStatus | null;
  detail?: string;
  paused: boolean;
  muted: boolean;
  liveGlyph: PanelConchState | null;
  active: boolean;
  navSelected: boolean;
}

export interface PanelReplyModel {
  sessionId: string;
  text: string;
  spokenChars: number;
}

export interface SettingsOverlayRowModel {
  key: string;
  value: string;
  source: "env" | "file" | "default";
  help: string;
  selected: boolean;
  editing: boolean;
  ack?: string;
}

export interface SettingsOverlayModel {
  rows: SettingsOverlayRowModel[];
  selectedIndex: number;
  error?: string;
}

export type SessionActionKey = "voice" | "prioritize" | "rename" | "dismiss";

export interface SessionActionsOverlayRowModel {
  key: SessionActionKey;
  value: string;
  help: string;
  selected: boolean;
  editing: boolean;
  ack?: string;
  /** The dismiss row is armed only between its first and confirming Enter. */
  confirming?: boolean;
}

export interface SessionActionsOverlayModel {
  /** Captured when the modal opens; never derived from the fading theater cursor. */
  target: {
    sessionId: string;
    label: string;
  };
  rows: SessionActionsOverlayRowModel[];
  selectedIndex: number;
  error?: string;
}

export interface PanelModel {
  rows: PanelRowModel[];
  mode: DashboardMode;
  live: PanelLiveState;
  reply: PanelReplyModel | null;
  /** Theater-only parked-session output. Footer rendering intentionally ignores it. */
  preview?: PanelReplyModel | null;
  /** Theater-only presentation state. Footer rendering intentionally ignores it. */
  panelOpen: boolean;
  settingsOverlay?: SettingsOverlayModel | null;
  sessionActionsOverlay?: SessionActionsOverlayModel | null;
}

export interface PanelSessionState extends LatchedState {
  label: string;
  detail?: string;
}

export interface BuildPanelModelOptions {
  sessions: readonly SessionInfo[];
  sessionStates: ReadonlyMap<string, PanelSessionState>;
  pausedSessionIds: ReadonlySet<string>;
  mutedSessionIds: ReadonlySet<string>;
  live: PanelLiveState;
  mode: DashboardMode;
  activeSessionId: string | null;
  navSelectedId: string | null;
  reply?: PanelReplyModel | null;
  panelOpen?: boolean;
}

const ROW_LIVE_STATES = new Set<PanelConchState>(["listening", "recording", "speaking", "transcribing"]);

/** Build rows in the canonical panel order used by rendering and interaction. */
export function buildPanelRows(options: BuildPanelModelOptions): PanelRowModel[] {
  return options.sessions
    .map((session): PanelRowModel => {
      const latched = options.sessionStates.get(session.sessionId);
      const status = reconcileStatus(session, latched);
      const active = session.sessionId === options.activeSessionId;
      return {
        sessionId: session.sessionId,
        label: sessionLabel(session, session.cwd),
        status,
        ...(status === "needs" && latched?.detail ? { detail: latched.detail } : {}),
        paused: options.pausedSessionIds.has(session.sessionId),
        muted: options.mutedSessionIds.has(session.sessionId),
        liveGlyph: active && ROW_LIVE_STATES.has(options.live.state) ? options.live.state : null,
        active,
        navSelected: session.sessionId === options.navSelectedId,
      };
    })
    .sort((a, b) => (
      STATUS_RANK[a.status ?? "working"] - STATUS_RANK[b.status ?? "working"]
      || a.label.localeCompare(b.label)
    ));
}

/** Resolve label-based auto-follow against the exact order visible in the panel. */
export function activeSessionIdForRows(
  rows: readonly Pick<PanelRowModel, "sessionId" | "label">[],
  live: Pick<PanelLiveState, "state" | "label">,
  options: {
    preferredSessionId?: string | null;
    liveSessionIds?: ReadonlySet<string>;
  } = {},
): string | null {
  if (!ROW_LIVE_STATES.has(live.state)) return null;
  if (options.preferredSessionId && options.liveSessionIds?.has(options.preferredSessionId)) {
    return options.preferredSessionId;
  }
  return rows.find((row) => row.label === live.label)?.sessionId ?? null;
}

/** Run a panel commit only when its async inputs still belong to the newest render. */
export function commitLatestPanelRender(
  generation: number,
  latestGeneration: number,
  commit: () => void,
): boolean {
  if (generation !== latestGeneration) return false;
  commit();
  return true;
}

/**
 * Attach transcript text only when it still belongs to the cursor that will be
 * painted. The daemon captures `requestedSessionId` before its async read; a
 * later cursor move must never put that stale text under a different row.
 */
export function previewForPanelSelection(
  navSelectedId: string | null,
  requestedSessionId: string | null,
  activeSessionId: string | null,
  text: string,
): PanelReplyModel | null {
  if (
    !text
    || !navSelectedId
    || navSelectedId !== requestedSessionId
    || navSelectedId === activeSessionId
  ) return null;
  return { sessionId: navSelectedId, text, spokenChars: 0 };
}

/** Build the semantic dashboard once; renderers decide how it looks. */
export function buildPanelModel(options: BuildPanelModelOptions): PanelModel {
  const rows = buildPanelRows(options);

  return {
    rows,
    mode: { ...options.mode },
    live: {
      ...options.live,
      ...(options.live.reading ? { reading: { ...options.live.reading } } : {}),
    },
    reply: options.reply ? { ...options.reply } : null,
    panelOpen: options.panelOpen ?? true,
  };
}

const STATUS_GLYPH: Record<SessionStatus, string> = {
  needs: "\x1b[33m❗ needs a response\x1b[0m",
  waiting: "\x1b[32m○ waiting for you\x1b[0m",
  working: "\x1b[36m● working…\x1b[0m",
};

const LIVE_GLYPH: Partial<Record<PanelConchState, string>> = {
  listening: "\x1b[32m● mic open\x1b[0m",
  recording: "\x1b[31m● recording\x1b[0m",
  speaking: "\x1b[33m▶ speaking\x1b[0m",
  transcribing: "\x1b[36m… transcribing\x1b[0m",
};

/** The legacy row view, kept byte-for-byte so footer mode does not drift. */
export function dashboardRowsForModel(model: PanelModel): string[] {
  return model.rows.map((row) => {
    const cursor = row.navSelected ? "\x1b[36m▸\x1b[0m " : "  ";
    if (row.muted) {
      return `${cursor}\x1b[2m${row.label.slice(0, 26).padEnd(27)}🔇 muted\x1b[0m`;
    }
    if (row.paused) {
      return `${cursor}\x1b[2m${row.label.slice(0, 26).padEnd(27)}⏸ paused\x1b[0m`;
    }
    // Footer mode historically keyed its live glyph by label. Keep that exact
    // behavior here; theater uses the unambiguous active/liveGlyph model fields.
    const legacyLiveGlyph = row.label === model.live.label ? LIVE_GLYPH[model.live.state] : undefined;
    const glyph = legacyLiveGlyph
      ?? (row.status ? STATUS_GLYPH[row.status] : "\x1b[2m· idle\x1b[0m");
    return `${cursor}${row.label.slice(0, 26).padEnd(27)}${glyph}${row.detail ? ` \x1b[2m(${row.detail})\x1b[0m` : ""}`;
  });
}

/** Global mode occupies one permanent slot so rows never jump on toggle. */
export function dashboardModeBanner({ muted, paused, holding }: DashboardMode): string {
  if (muted) return "  \x1b[1;33m🔇 MUTED · no parked cursor: m to unmute\x1b[0m";
  if (paused) return `  \x1b[1;35m⏸ PAUSED · holding ${holding} · no parked cursor: p to resume\x1b[0m`;
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
