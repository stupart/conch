import { sessionLabel, type SessionInfo } from "./sessions.ts";
import type { PublishedConversation } from "./conversation.ts";
import type { SessionContextUsage } from "./context-meter.ts";

export type PanelConchState = "idle" | "muted" | "paused" | "speaking" | "listening" | "recording" | "transcribing";

export interface PanelLiveState {
  state: PanelConchState;
  label: string;
  partial: string;
  /** Published committed transcript; theater draws it before the current live partial. */
  transcriptPrefix?: string;
  /** Chunk-level reading progress. The audio backend does not expose word timing. */
  reading?: { text: string; spokenChars: number };
  /**
   * A finished dictation meant for the COMPOSER rather than the session.
   *
   * Pressing the mic beside a text field and watching the spoken half vanish
   * into the agent is the bug this exists to fix: typed and spoken text could
   * not be combined at all, because the daemon's only destination for a
   * transcript was `deliver()`.
   *
   * `id` increments per dictation and is the whole mechanism. State is
   * republished several times a second, so an app that appended on sight of
   * text would append it again on every frame; it applies an id it has not
   * seen and ignores the rest.
   */
  dictated?: { text: string; id: number; sessionId: string };
}

/** The states a session row can show in the dashboard panel. */
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
  /** Which agent runs this session; absent means Claude. */
  backend?: "claude" | "codex";
  /** Known context usage for the TUI row; absent is unknown, never zero. */
  context?: SessionContextUsage;
  status: SessionStatus | null;
  /** Epoch-ms for the status currently visible on this row. */
  at?: number;
  detail?: string;
  review?: { summary: string; link?: string; at: number };
  paused: boolean;
  muted: boolean;
  liveGlyph: PanelConchState | null;
  active: boolean;
  navSelected: boolean;
}

export interface PanelReplyModel {
  sessionId: string;
  /** Speech text: markdown stripped and flattened. spokenChars indexes THIS. */
  text: string;
  spokenChars: number;
  /**
   * The same reply with its markdown intact, for viewers that render rather
   * than speak. Without it a GUI receives text already flattened for TTS, so
   * every list marker shows up as a literal "- " and no block survives.
   */
  markdown?: string;
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

export type SessionActionKey = "voice" | "prioritize" | "rename" | "dismiss" | "close";

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

export interface RestoreSessionsOverlayRowModel {
  id: string;
  label: string;
  selected: boolean;
}

export interface RestoreSessionsOverlayModel {
  rows: RestoreSessionsOverlayRowModel[];
  selectedIndex: number;
  error?: string;
}

export interface TerminalComposerModel {
  target: { sessionId: string; label: string };
  text: string;
  error?: string;
}

export type SessionStartKey = "backend" | "cwd" | "start";

export interface SessionStartOverlayRowModel {
  key: SessionStartKey;
  value: string;
  help: string;
  selected: boolean;
  editing: boolean;
}

export interface SessionStartOverlayModel {
  rows: SessionStartOverlayRowModel[];
  selectedIndex: number;
  starting: boolean;
  error?: string;
}

export interface TerminalQuestionState {
  sessionId: string;
  itemId: string;
  selectedIndices: number[];
  submitted: boolean;
}

export interface PanelModel {
  rows: PanelRowModel[];
  mode: DashboardMode;
  live: PanelLiveState;
  reply: PanelReplyModel | null;
  /**
   * The conversation for whichever session is showing, as an ordered stack of
   * items. `reply` is the same turn flattened to one string and stays until both
   * apps render this instead.
   */
  conversation?: PublishedConversation | null;
  /** Every visible session's conversation, so a viewer never depends on the daemon's cursor. */
  conversations?: Record<string, PublishedConversation> | null;
  /** Theater-only parked-session output. Footer rendering intentionally ignores it. */
  preview?: PanelReplyModel | null;
  /** Theater-only presentation state. Footer rendering intentionally ignores it. */
  panelOpen: boolean;
  settingsOverlay?: SettingsOverlayModel | null;
  sessionActionsOverlay?: SessionActionsOverlayModel | null;
  restoreSessionsOverlay?: RestoreSessionsOverlayModel | null;
  terminalComposer?: TerminalComposerModel | null;
  sessionStartOverlay?: SessionStartOverlayModel | null;
  terminalQuestion?: TerminalQuestionState | null;
}

export interface PublishedSessionRow {
  id: string;
  label: string;
  /**
   * Which agent this session runs, because the answer changes what a client
   * should send it. Images are the first case: Claude resizes anything past
   * 1568px on the long edge, while OpenAI's tile models fit to 2048 — so a
   * phone that assumes one ceiling either wastes bytes or throws away detail
   * the model would have used.
   */
  backend?: "claude" | "codex";
  context?: SessionContextUsage;
  status: SessionStatus | null;
  /** Epoch-ms for the status currently visible on this row. */
  at?: number;
  /** Resolved transcript file for on-demand history viewers. */
  transcriptPath?: string;
  /** Resolved effective voice, whether pinned or automatically assigned. */
  voice?: string;
  /** Present only for sessions explicitly promoted in the hand-off order. */
  prioritized?: boolean;
  /** Present only for the row currently selected by external navigation. */
  navSelected?: boolean;
  needsResponse: boolean;
  detail?: string;
  paused: boolean;
  muted: boolean;
  live: PanelConchState | null;
  active: boolean;
  snippet?: string;
  /** A finished deliverable attached to this waiting row. Carries the link so
   * external consumers can render it, not just the summary. */
  review?: { summary: string; link?: string; at?: number };
}

export interface PublishedState {
  v: 1;
  ts: number;
  mode: DashboardMode;
  live: {
    state: PanelConchState;
    label: string;
    partial?: string;
    transcriptPrefix?: string;
    /// `truncated` marks a tail: the publisher caps long text and keeps the
    /// END, so a client cannot tell a capped long reply from a short whole one
    /// by looking. Declared on the PUBLISHED shape only — the in-memory model
    /// is never capped and must not imply it might be.
    reading?: { text: string; spokenChars: number; truncated?: boolean };
    /// A finished dictation for the composer. Applied once, by `id`, and only
    /// to the session that ASKED for it.
    dictated?: { text: string; id: number; sessionId: string };
  };
  reply?: PanelReplyModel & { truncated?: boolean };
  preview?: PanelReplyModel & { truncated?: boolean };
  /** The showing session's conversation, windowed and capped for the wire. */
  conversation?: PublishedConversation;
  /**
   * Every visible session's conversation, keyed by id.
   *
   * Published for all rows rather than for "the one that is showing" because
   * there is no such thing: the terminal dashboard and the Mac app hold
   * INDEPENDENT cursors, so any single choice is wrong for one of them. Trying
   * to make them agree produced a stack that silently fell back to the old pane
   * whenever the two disagreed, which was most of the time. A viewer should ask
   * for the session it is showing and always find it.
   */
  conversations?: Record<string, PublishedConversation>;
  rows: PublishedSessionRow[];
  dismissed: string[];
  dismissedRows: Array<{ id: string; label: string }>;
}

const MAX_PUBLISHED_CONVERSATION_CHARS = 4_000;

/**
 * The snapshot is rewritten on every panel render. Keep reply-sized fields
 * bounded to the final 4,000 characters (the part being read next), and rebase
 * spoken progress so it remains meaningful within the published suffix.
 */
function publishedReply<T extends { text: string; spokenChars: number; markdown?: string }>(
  reply: T,
): T {
  if (reply.text.length <= MAX_PUBLISHED_CONVERSATION_CHARS) return { ...reply };

  const removedChars = reply.text.length - MAX_PUBLISHED_CONVERSATION_CHARS;
  return {
    ...reply,
    // Say so. This keeps the TAIL, so a long reply reaches a client with its
    // beginning missing — which reads as a random snippet rather than as a
    // truncation, and a client cannot tell the difference by looking. The Mac
    // panel wants the bound; the phone can fetch the whole thing from /reply,
    // but only if it knows there is more to fetch.
    truncated: true,
    // The markdown copy is capped to its own tail. It cannot align exactly with
    // the speech text (markdown syntax has no spoken counterpart), so viewers
    // locate reading progress by PROPORTION rather than by character offset.
    ...(reply.markdown && reply.markdown.length > MAX_PUBLISHED_CONVERSATION_CHARS
      ? { markdown: reply.markdown.slice(reply.markdown.length - MAX_PUBLISHED_CONVERSATION_CHARS) }
      : {}),
    text: reply.text.slice(removedChars),
    spokenChars: Math.max(
      0,
      Math.min(MAX_PUBLISHED_CONVERSATION_CHARS, reply.spokenChars - removedChars),
    ),
  };
}

function publishedLiveState(live: PanelLiveState): PublishedState["live"] {
  return {
    state: live.state,
    label: live.label,
    ...(live.partial ? { partial: live.partial } : {}),
    ...(live.transcriptPrefix
      ? { transcriptPrefix: live.transcriptPrefix }
      : {}),
    ...(live.dictated ? { dictated: live.dictated } : {}),
    ...(live.reading
      ? { reading: publishedReply(live.reading) }
      : {}),
  };
}

/**
 * Patch conversation-only progress onto the last complete panel snapshot.
 * Registry/session reconciliation stays on the full render path; live partials
 * and chunk progress can therefore publish without rescanning every session.
 */
export function refreshPublishedConversationState(
  current: PublishedState,
  live: PanelLiveState,
  contentSessionId: string | null,
  now: number,
): PublishedState {
  const { reply: previousReply, ...withoutReply } = current;
  const reply = contentSessionId && live.reading?.text
    ? publishedReply({
      sessionId: contentSessionId,
      text: live.reading.text,
      spokenChars: live.reading.spokenChars,
    })
    : contentSessionId && previousReply?.sessionId === contentSessionId
      ? { ...previousReply }
      : undefined;

  return {
    ...withoutReply,
    ts: now,
    live: publishedLiveState(live),
    ...(reply ? { reply } : {}),
  };
}

/**
 * Which text the reply pane should show, and how far speech has got through it.
 *
 * These are two different strings and conflating them is a bug Tyler has
 * reported repeatedly: "only shows first line of last response instead of full
 * response". What conch SPEAKS for a finished turn is a one-line announce; what
 * the pane should SHOW is the whole reply. The old rule preferred the spoken
 * text whenever it existed, so the moment a turn was announced the pane
 * collapsed to that single line and stayed there.
 *
 * Speaking is the only time the two must agree, because `spokenChars` indexes
 * the spoken string to highlight progress. Otherwise the transcript wins, and
 * progress resets to zero rather than pointing into a string it does not index.
 */
export function panelReplyText(
  live: Pick<PanelLiveState, "state" | "reading">,
  transcriptText: string,
): { text: string; spokenChars: number } {
  if (live.state === "speaking" && live.reading?.text) {
    return { text: live.reading.text, spokenChars: live.reading.spokenChars };
  }
  if (transcriptText) return { text: transcriptText, spokenChars: 0 };
  return {
    text: live.reading?.text ?? "",
    spokenChars: live.reading?.spokenChars ?? 0,
  };
}

/** Build the versioned, renderer-independent state exposed to external consumers. */
export function buildPublishedState(
  model: PanelModel,
  snippets: ReadonlyMap<string, string>,
  dismissed: ReadonlySet<string>,
  now: number,
  options: {
    transcriptPathForSessionId?(sessionId: string): string | undefined;
    /** Resolve the effective voice, including stable automatic assignment. */
    voiceForLabel?(label: string): string | undefined;
    /** Resolve labels for dismissed sessions, which are intentionally absent from rows. */
    labelForSessionId?(sessionId: string): string | undefined;
    prioritizedSessionIds?: ReadonlySet<string>;
    contextForSessionId?(sessionId: string): SessionContextUsage | undefined;
  } = {},
): PublishedState {
  return {
    v: 1,
    ts: now,
    mode: { ...model.mode },
    live: publishedLiveState(model.live),
    ...(model.reply ? { reply: publishedReply(model.reply) } : {}),
    ...(model.conversation ? { conversation: model.conversation } : {}),
    ...(model.conversations && Object.keys(model.conversations).length
      ? { conversations: model.conversations }
      : {}),
    ...(model.preview ? { preview: publishedReply(model.preview) } : {}),
    rows: model.rows.map((row) => {
      const transcriptPath = options.transcriptPathForSessionId?.(row.sessionId);
      const voice = options.voiceForLabel?.(row.label)?.trim();
      const context = options.contextForSessionId?.(row.sessionId);
      return {
        id: row.sessionId,
        label: row.label,
        ...(row.backend ? { backend: row.backend } : {}),
        status: row.status,
        ...(row.at !== undefined ? { at: row.at } : {}),
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(voice ? { voice } : {}),
        ...(context ? { context: { ...context } } : {}),
        ...(options.prioritizedSessionIds?.has(row.sessionId)
          ? { prioritized: true as const }
          : {}),
        ...(row.navSelected ? { navSelected: true as const } : {}),
        needsResponse: row.status === "needs",
        ...(row.detail !== undefined ? { detail: row.detail } : {}),
        paused: row.paused,
        muted: row.muted,
        live: row.liveGlyph,
        active: row.active,
        ...(snippets.has(row.sessionId)
          ? { snippet: snippets.get(row.sessionId)! }
          : {}),
        ...(row.review
          ? {
            review: {
              summary: row.review.summary,
              ...(row.review.link ? { link: row.review.link } : {}),
              // Latch time — external viewers need it to pick the NEWEST review
              // when more than one is pending, instead of guessing.
              ...(row.review.at !== undefined ? { at: row.review.at } : {}),
            },
          }
          : {}),
      };
    }),
    dismissed: [...dismissed],
    dismissedRows: [...dismissed].map((id) => ({
      id,
      label: options.labelForSessionId?.(id)?.trim() || id.slice(0, 8),
    })),
  };
}

export interface PanelSessionState extends LatchedState {
  label: string;
  detail?: string;
  review?: { summary: string; link?: string };
}

export interface BuildPanelModelOptions {
  sessions: readonly SessionInfo[];
  sessionStates: ReadonlyMap<string, PanelSessionState>;
  pausedSessionIds: ReadonlySet<string>;
  /** Accepted while older model builders migrate; rows never expose destructive state. */
  mutedSessionIds?: ReadonlySet<string>;
  live: PanelLiveState;
  mode: DashboardMode;
  activeSessionId: string | null;
  navSelectedId: string | null;
  reply?: PanelReplyModel | null;
  panelOpen?: boolean;
  contextBySessionId?: ReadonlyMap<string, SessionContextUsage>;
}

const ROW_LIVE_STATES = new Set<PanelConchState>(["listening", "recording", "speaking", "transcribing"]);

/** Build rows in the canonical panel order used by rendering and interaction. */
export function buildPanelRows(options: BuildPanelModelOptions): PanelRowModel[] {
  return options.sessions
    .map((session): PanelRowModel => {
      const latched = options.sessionStates.get(session.sessionId);
      const visibleState = reconcilePanelState(session, latched);
      const status = visibleState?.status ?? null;
      // A finished deliverable is an attribute of a row, not a fourth status —
      // and it is suppressed by exactly one thing: the session going back to
      // work. `carriedReview` uses the same rule on the latch.
      //
      // This used to require `status === "waiting"`, which made the star
      // vanish almost every time it was filed. `reconcilePanelState` lets the
      // REGISTRY outvote the latch whenever it is newer, and a session that has
      // just filed a review is by definition sitting waiting for the user —
      // which Claude Code registers as blocked/waiting, i.e. `needs`. So the
      // review landed, rendered for as long as it took the registry to catch
      // up, and then disappeared. Measured on a live session: latched at
      // 19:27:36 and visible, gone at 19:29:26 the moment status flipped to
      // `needs`, with the review still sitting in the latch untouched. Needing
      // input does not make a finished deliverable stale; starting a new turn
      // does.
      const review = status !== "working" && latched?.review
        ? { ...latched.review, at: latched.at }
        : undefined;
      const active = session.sessionId === options.activeSessionId;
      return {
        sessionId: session.sessionId,
        label: sessionLabel(session, session.cwd),
        ...(session.backend ? { backend: session.backend } : {}),
        ...(options.contextBySessionId?.get(session.sessionId)
          ? { context: { ...options.contextBySessionId.get(session.sessionId)! } }
          : {}),
        status,
        ...(visibleState?.at !== undefined ? { at: visibleState.at } : {}),
        ...(status === "needs" && latched?.detail
          ? { detail: latched.detail }
          : review
            ? { detail: review.summary }
            : {}),
        ...(review ? { review } : {}),
        paused: options.pausedSessionIds.has(session.sessionId),
        // Kept on the v1 wire until every installed viewer has moved past it.
        // No runtime mode may make this true again.
        muted: false,
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

export interface NumberedPanelSessionRow {
  n: number;
  s: SessionInfo;
  label: string;
}

/**
 * Pair number shortcuts with the exact status-sorted rows the panel paints.
 * Missing session metadata leaves a hole instead of shifting later shortcuts.
 */
export function numberPanelSessionRows(
  rows: readonly Pick<PanelRowModel, "sessionId" | "label">[],
  sessions: readonly SessionInfo[],
): NumberedPanelSessionRow[] {
  const sessionsById = new Map(sessions.map((session) => [session.sessionId, session]));
  return rows.slice(0, 9).flatMap((row, index) => {
    const session = sessionsById.get(row.sessionId);
    return session
      ? [{ n: index + 1, s: session, label: row.label }]
      : [];
  });
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
 * painted. Empty output is still a real selected view: it must not fall through
 * to another session's live content. The daemon captures `requestedSessionId`
 * before its async read, so a later cursor move cannot mislabel stale text.
 */
export function previewForPanelSelection(
  navSelectedId: string | null,
  requestedSessionId: string | null,
  text: string,
  markdown?: string,
): PanelReplyModel | null {
  if (
    !navSelectedId
    || navSelectedId !== requestedSessionId
  ) return null;
  return { sessionId: navSelectedId, text, spokenChars: 0, ...(markdown ? { markdown } : {}) };
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

const REVIEW_GLYPH = "\x1b[33m⭐ needs review\x1b[0m";

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
    if (row.paused) {
      return `${cursor}\x1b[2m${row.label.slice(0, 26).padEnd(27)}⏸ manual\x1b[0m`;
    }
    // Footer mode historically keyed its live glyph by label. Keep that exact
    // behavior here; theater uses the unambiguous active/liveGlyph model fields.
    const legacyLiveGlyph = row.label === model.live.label ? LIVE_GLYPH[model.live.state] : undefined;
    const glyph = legacyLiveGlyph
      ?? (row.review
        ? REVIEW_GLYPH
        : row.status
          ? STATUS_GLYPH[row.status]
          : "\x1b[2m· idle\x1b[0m");
    const detail = row.review?.summary ?? row.detail;
    return `${cursor}${row.label.slice(0, 26).padEnd(27)}${glyph}${detail ? ` \x1b[2m(${detail})\x1b[0m` : ""}`;
  });
}

/** Global mode occupies one permanent slot so rows never jump on toggle. */
export function dashboardModeBanner({ muted, paused, holding }: DashboardMode): string {
  void muted; // v1 wire compatibility; runtime mode is exclusively auto/manual.
  if (paused) return `  \x1b[1;35m⏸ MANUAL · holding ${holding} · no parked cursor: p for auto\x1b[0m`;
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

export interface SessionReview {
  summary: string;
  link?: string;
}

/**
 * Which review a session's next latched state should carry.
 *
 * A review outlives the event that happens to arrive after it. `review_to_front`
 * latches one, and moments later that same session's Stop hook lands a
 * review-less `turn-end` — and because the latch REPLACES the whole record, the
 * review was erased within a second of being filed. That was the only reason a
 * session could not surface its own finished work through the tool, even though
 * `requiredReviewSession` defaults `session` to the caller and refuses to name
 * anyone else; the plugin documented the `conch:review` marker as the
 * workaround for a tool that could not keep its own result.
 *
 * A review belongs to the finished deliverable, not to the last message about
 * the session, so it survives until the session starts a new turn — which is
 * also the only status the panel refuses to draw a review row in.
 */
export function carriedReview(
  prior: { review?: SessionReview } | undefined,
  status: SessionStatus,
  incoming: SessionReview | undefined,
): SessionReview | undefined {
  if (incoming) return incoming;
  return status === "working" ? undefined : prior?.review;
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
  return reconcilePanelState(session, latched)?.status ?? null;
}

function reconcilePanelState(
  session: Pick<SessionInfo, "status" | "statusUpdatedAt">,
  latched: LatchedState | undefined,
): { status: SessionStatus; at?: number } | null {
  const reg = registryToPanel(session.status);
  const regAt = session.statusUpdatedAt ?? 0;
  if (latched && latched.at >= regAt) return latched;
  if (reg) {
    return {
      status: reg,
      ...(session.statusUpdatedAt !== undefined ? { at: session.statusUpdatedAt } : {}),
    };
  }
  return latched ?? null;
}

/**
 * Sort order: what needs you first, then waiting, then working. A deliverable is
 * an attribute of a waiting row, so its ⭐ never changes the natural order.
 */
export const STATUS_RANK: Record<SessionStatus, number> = {
  needs: 1,
  waiting: 2,
  working: 3,
};
