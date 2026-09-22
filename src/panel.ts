import { sessionLabel, type SessionInfo } from "./sessions.ts";
import type { PublishedConversation } from "./conversation.ts";
import type { SessionContextUsage } from "./context-meter.ts";
import type { AudioControl, AudioOutboxItem } from "./audio-holder.ts";
import type { ReviewScene } from "./snippet.ts";

export type PanelConchState = "idle" | "muted" | "paused" | "speaking" | "listening" | "recording" | "transcribing";

export interface PanelLiveState {
  state: PanelConchState;
  label: string;
  partial: string;
  /** Mic input level 0..1 while listening or recording; absent otherwise. */
  level?: number;
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
  /** A Stop that saw live background agents latched `working`; Claude's registry does not correct it. */
  backgroundWork?: true;
}

export interface DashboardMode {
  muted: boolean;
  paused: boolean;
  holding: number;
  /**
   * The global pause is an agent's own (`PauseOriginLedger`, A17). Absent is
   * anyone else's — yours, a meeting's, one restored at boot — and that pause
   * holds an agent's `conch_speak`, which the MCP server reads here to say so.
   */
  pausedByAgent?: boolean;
}

export interface PanelRowModel {
  sessionId: string;
  label: string;
  /** Which agent runs this session; absent means Claude. */
  backend?: "claude" | "codex";
  /** A subagent row: nested under this session, never the active one (C4). */
  parentSessionId?: string;
  /** A full session another session's process started (C15): nested under its starter, otherwise ordinary. */
  startedBySessionId?: string;
  /** Known context usage for the TUI row; absent is unknown, never zero. */
  context?: SessionContextUsage;
  status: SessionStatus | null;
  /** Epoch-ms for the status currently visible on this row. */
  at?: number;
  detail?: string;
  /** `opened` exists only on the terminal renderer's own copy, set once `o` has
   * handed the link to macOS — its equivalent of the Mac app's seen set. The
   * publisher copies summary/link/at explicitly, so it never reaches the wire. */
  review?: {
    summary: string;
    link?: string;
    scene?: ReviewScene;
    at: number;
    id: string;
    viewedAt?: number;
    opened?: boolean;
  };
  /** Every deliverable the session holds, oldest first; `review` is the last of them. */
  reviews?: SessionReview[];
  paused: boolean;
  /**
   * Exempted from a GLOBAL pause by a scoped resume (`resumedSessionIds`,
   * checked ahead of the global gate) — this session is auto even though
   * `mode.paused` is true. Absent means false: no exemption, so `paused`
   * combined with the global mode is the whole answer, same as before this
   * field existed.
   */
  pauseExempt?: boolean;
  muted: boolean;
  liveGlyph: PanelConchState | null;
  active: boolean;
  navSelected: boolean;
  /** The daemon knows the session's process, so a click on the title can try to raise its terminal. */
  revealable?: boolean;
  /** Why this row has no terminal to type into or raise: a closed Codex thread, or one an app-server hosts. */
  noTerminal?: string;
  /** A background job with no window attached: "Open in Terminal" can attach one. */
  attachable?: boolean;
  /** The folder the session runs in; what a relative link in its prose is relative to. */
  cwd?: string;
  /** The folder(s) its agent said it actually works in, when not `cwd`: what the file tree and the sidebar follow. */
  workDirs?: string[];
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
  /** A window whose branch could not be told from the other's (A8); the TUI preview says so. */
  shared?: boolean;
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
  /** A fixed row, or a start option's name from the agent's table. */
  key: SessionStartKey | (string & {});
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
  /**
   * Present on a subagent row: the session it runs inside. A viewer indents
   * it under that row and never treats it as a session of its own — it has
   * no process to type into or raise, and it is never the one being announced.
   */
  parentSessionId?: string;
  /**
   * Present when another listed session's process started this one (C15). A
   * viewer indents it under that row and says so; everything else about it —
   * composer, announcement, close — is that of any session.
   */
  startedBySessionId?: string;
  context?: SessionContextUsage;
  status: SessionStatus | null;
  /** Epoch-ms for the status currently visible on this row. */
  at?: number;
  /** Resolved transcript file for on-demand history viewers. */
  transcriptPath?: string;
  /**
   * The folder the session runs in. An agent writes links the way it writes
   * paths — `output/x/review-guide.md` — and a viewer that opens one has to
   * know what that is relative to (A13: handed to LaunchServices unresolved,
   * a Codex reply's link answered -50 in a Finder alert).
   */
  cwd?: string;
  /** The folder(s) its agent said it actually works in, when not `cwd` (`conch_working_folders`). */
  workDirs?: string[];
  /** Resolved effective voice, whether pinned or automatically assigned. */
  voice?: string;
  /** Present only for sessions explicitly promoted in the hand-off order. */
  prioritized?: boolean;
  /** Present only for the row currently selected by external navigation. */
  navSelected?: boolean;
  needsResponse: boolean;
  detail?: string;
  paused: boolean;
  /** Same field as `PanelRowModel.pauseExempt`, carried onto the wire. Absent means false. */
  pauseExempt?: boolean;
  muted: boolean;
  live: PanelConchState | null;
  active: boolean;
  /** Present when the daemon knows the session's process and can try to raise its terminal (C10). */
  revealable?: boolean;
  /** Why the row has no terminal to type into or raise: a closed Codex thread, or one an app-server hosts. */
  noTerminal?: string;
  /** A Claude Code background job with no window attached; an app can offer "Open in Terminal". Older apps ignore it. */
  attachable?: boolean;
  snippet?: string;
  /** A finished deliverable attached to this waiting row. Carries the link so
   * external consumers can render it, not just the summary. */
  review?: {
    summary: string;
    link?: string;
    scene?: ReviewScene;
    at?: number;
    /** The identity it was filed with. Absent from an older daemon, which is why every
     * reader still falls back to recomputing its own key. */
    id?: string;
    /** When it was looked at; absent means nobody has. */
    viewedAt?: number;
  };
  /**
   * Every deliverable the session is still holding, oldest first, the last of which is
   * `review`. Absent from an older daemon; an app that wants them all and finds none reads
   * `review` alone, which is exactly what it does today.
   */
  reviews?: Array<
    { summary: string; link?: string; scene?: ReviewScene; at?: number; id?: string; viewedAt?: number }
  >;
}

/**
 * What became of one send, against the id its sender gave it.
 *
 * `inject-accepted` closes the request with the delivery still running, so the answer that
 * matters is usually known only after nothing is listening. Publishing it here is how a
 * terminal outcome reaches a client that has already hung up, reconnected, or been
 * relaunched: it reads the snapshot it gets anyway and matches on `opId`.
 *
 * The fields after `at` are exactly the socket answer's (`injectDeliveryReceipt`), so the
 * late outcome and the immediate one cannot describe the same send differently.
 */
export interface PublishedDelivery {
  opId: string;
  sessionId: string;
  /** Epoch-ms the outcome was observed. */
  at: number;
  kind: "inject-done";
  delivered: boolean;
  staged?: true;
  reason?: string;
  onClipboard?: true;
  error?: string;
}

export interface PublishedState {
  v: 1;
  /**
   * What this daemon can do, versioned per capability and separate from `v`.
   *
   * An app that finds no `features` is talking to a daemon from before them: it must show an
   * honest latest-deliverable-only view rather than presenting local guesses as shared truth.
   * Unknown means unknown.
   */
  features: { deliverables: 1; viewedState: 1 };
  /** Stable identity of the daemon installation that owns every local session key. */
  ownerDeviceId: string;
  ts: number;
  mode: DashboardMode;
  live: {
    state: PanelConchState;
    label: string;
    partial?: string;
    level?: number;
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
  /** Recent terminal delivery outcomes, so an accepted send can still be resolved. */
  deliveries?: PublishedDelivery[];
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
  /** C9b Cut B: who makes this daemon's sound. Absent from older daemons means local. */
  audioControl?: AudioControl;
  /** What a yielded daemon could not say itself; the holder's app carries it over. */
  audioOutbox?: AudioOutboxItem[];
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
    ...(live.level !== undefined ? { level: live.level } : {}),
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
  ownerDeviceId: string,
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
    audio?: { control: AudioControl; outbox: AudioOutboxItem[] };
    /** Terminal delivery outcomes recent enough for a client to still be waiting on one. */
    deliveries?: readonly PublishedDelivery[];
  } = {},
): PublishedState {
  return {
    v: 1,
    features: { deliverables: 1, viewedState: 1 },
    ownerDeviceId,
    ts: now,
    ...(options.audio ? { audioControl: options.audio.control, audioOutbox: options.audio.outbox } : {}),
    ...(options.deliveries?.length ? { deliveries: [...options.deliveries] } : {}),
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
        ...(row.parentSessionId ? { parentSessionId: row.parentSessionId } : {}),
        ...(row.startedBySessionId ? { startedBySessionId: row.startedBySessionId } : {}),
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
        ...(row.pauseExempt ? { pauseExempt: true as const } : {}),
        muted: row.muted,
        live: row.liveGlyph,
        active: row.active,
        ...(row.revealable ? { revealable: true as const } : {}),
        ...(row.noTerminal ? { noTerminal: row.noTerminal } : {}),
        ...(row.attachable ? { attachable: true as const } : {}),
        ...(row.cwd ? { cwd: row.cwd } : {}),
        ...(row.workDirs ? { workDirs: row.workDirs } : {}),
        ...(snippets.has(row.sessionId)
          ? { snippet: snippets.get(row.sessionId)! }
          : {}),
        ...(row.review
          ? {
            review: {
              summary: row.review.summary,
              ...(row.review.link ? { link: row.review.link } : {}),
              // What the pill brings forward and what to check there, as published.
              ...(row.review.scene ? { scene: row.review.scene } : {}),
              // Latch time — external viewers need it to pick the NEWEST review
              // when more than one is pending, instead of guessing.
              ...(row.review.at !== undefined ? { at: row.review.at } : {}),
              // The identity the deliverable was filed with. Older apps ignore it and keep
              // recomputing their own key; newer ones stop guessing.
              ...(row.review.id ? { id: row.review.id } : {}),
              ...(row.review.viewedAt !== undefined ? { viewedAt: row.review.viewedAt } : {}),
            },
          }
          : {}),
        // Beside `review`, never instead of it: an older app keeps reading the newest one and
        // behaves exactly as it does now.
        ...(row.reviews?.length
          ? {
            reviews: row.reviews.map((held) => ({
              summary: held.summary,
              ...(held.link ? { link: held.link } : {}),
              ...(held.scene ? { scene: held.scene } : {}),
              ...(held.at !== undefined ? { at: held.at } : {}),
              ...(held.id ? { id: held.id } : {}),
              ...(held.viewedAt !== undefined ? { viewedAt: held.viewedAt } : {}),
            })),
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
  /** The NEWEST deliverable. Everything that shows one still reads this. */
  review?: SessionReview;
  /** Every deliverable this session is still holding, oldest first. */
  reviews?: SessionReview[];
}

export interface BuildPanelModelOptions {
  sessions: readonly SessionInfo[];
  sessionStates: ReadonlyMap<string, PanelSessionState>;
  pausedSessionIds: ReadonlySet<string>;
  /** Sessions resumed by name out of a global pause (`SessionLedger.resumedSessionIds`); optional so an older caller that never passed one still builds rows, all reading `pauseExempt` false. */
  resumedSessionIds?: ReadonlySet<string>;
  /** Accepted while older model builders migrate; rows never expose destructive state. */
  mutedSessionIds?: ReadonlySet<string>;
  live: PanelLiveState;
  mode: DashboardMode;
  activeSessionId: string | null;
  navSelectedId: string | null;
  reply?: PanelReplyModel | null;
  panelOpen?: boolean;
  contextBySessionId?: ReadonlyMap<string, SessionContextUsage>;
  /** Epoch-ms the rows are built for; decides whether a latch is past `LATCH_GRACE_MS`. */
  now?: number;
}

const ROW_LIVE_STATES = new Set<PanelConchState>(["listening", "recording", "speaking", "transcribing"]);

/** Build rows in the canonical panel order used by rendering and interaction. */
export function buildPanelRows(options: BuildPanelModelOptions): PanelRowModel[] {
  const now = options.now ?? Date.now();
  const rows = options.sessions
    .map((session): PanelRowModel => {
      const latched = options.sessionStates.get(session.sessionId);
      const visibleState = reconcilePanelState(session, latched, now);
      const status = visibleState?.status ?? null;
      // A deliverable is an attribute of a row, not a fourth status, and it is
      // published for as long as the latch holds one — whatever the status.
      // Hiding it while the session worked meant replying to the agent (which
      // starts a turn) pulled the thing you were reading out of both apps.
      // Whether it is READY to look at is `reviewReady`, derived from status.
      //
      // Its `at` is the FILING time, carried unchanged through every later
      // latch. It used to be `latched.at`, the time of the session's latest
      // event, so every turn-end or notification gave the same deliverable a
      // new identity: the Mac snapped back to the conversation mid-read and the
      // terminal's "opened" mark reset.
      //
      // It was once hidden unless `waiting` (so it vanished whenever the
      // registry said `needs`), then hidden while `working`. Neither status
      // makes a deliverable stale; only a newer one does (`carriedReview`).
      const review = latched?.review ? { ...latched.review } : undefined;
      const reviews = latched?.reviews?.map((held) => ({ ...held }));
      // A subagent is never the active session: it is part of its parent's
      // turn, and the announcement that follows belongs to the parent.
      const active = !session.parentSessionId && session.sessionId === options.activeSessionId;
      return {
        sessionId: session.sessionId,
        label: sessionLabel(session, session.cwd),
        ...(session.backend ? { backend: session.backend } : {}),
        ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
        ...(session.startedBySessionId ? { startedBySessionId: session.startedBySessionId } : {}),
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
        ...(reviews?.length ? { reviews } : {}),
        paused: options.pausedSessionIds.has(session.sessionId),
        ...(options.resumedSessionIds?.has(session.sessionId) ? { pauseExempt: true as const } : {}),
        // Kept on the v1 wire until every installed viewer has moved past it.
        // No runtime mode may make this true again.
        muted: false,
        liveGlyph: active && ROW_LIVE_STATES.has(options.live.state) ? options.live.state : null,
        active,
        navSelected: session.sessionId === options.navSelectedId,
        // A known process is what the title's click can try to raise (C10).
        ...(session.pid ? { revealable: true } : {}),
        ...(session.noTerminal ? { noTerminal: session.noTerminal } : {}),
        ...(session.jobId && !session.pid ? { attachable: true } : {}),
        ...(session.cwd ? { cwd: session.cwd } : {}),
        ...(session.workDirs ? { workDirs: session.workDirs } : {}),
      };
    });
  const top = rows
    .filter((row) => !row.parentSessionId)
    .sort((a, b) => (
      STATUS_RANK[a.status ?? "working"] - STATUS_RANK[b.status ?? "working"]
      || a.label.localeCompare(b.label)
    ));
  // Folder-style: a subagent sits directly under its parent, oldest first,
  // rather than competing with sessions on status. One whose parent is not in
  // the list has nowhere to sit and is dropped, not promoted to a session.
  // A session another session started (C15) sits under its starter too, after
  // the starter's subagents and in status order among its siblings — but it IS
  // a session, so one whose starter is not listed simply stays at the top.
  const listed = new Set(top.map((row) => row.sessionId));
  const placed = new Set<string>();
  const place = (parent: PanelRowModel): PanelRowModel[] => {
    if (placed.has(parent.sessionId)) return [];
    placed.add(parent.sessionId);
    return [
      parent,
      ...rows
        .filter((row) => row.parentSessionId === parent.sessionId)
        .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.label.localeCompare(b.label)),
      ...top.filter((row) => row.startedBySessionId === parent.sessionId).flatMap(place),
    ];
  };
  const roots = top.filter((row) => !row.startedBySessionId || !listed.has(row.startedBySessionId));
  // `placed` also makes this total: a cycle in a bogus tree has no root, and
  // its rows still land at the end rather than vanishing.
  return [...roots, ...top].flatMap(place);
}

/** The row this one is drawn under, if any: its parent session (C4) or its starter (C15). */
export function nestedUnder(
  row: Pick<PanelRowModel, "parentSessionId" | "startedBySessionId">,
): string | undefined {
  return row.parentSessionId ?? row.startedBySessionId;
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
  rows: readonly Pick<PanelRowModel, "sessionId" | "label" | "parentSessionId">[],
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
  // Never a subagent row: conch speaks for sessions, and a subagent's label
  // is its task description, which is no address at all.
  return rows.find((row) => !row.parentSessionId && row.label === live.label)?.sessionId ?? null;
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
  shared = false,
): PanelReplyModel | null {
  if (
    !navSelectedId
    || navSelectedId !== requestedSessionId
  ) return null;
  return {
    sessionId: navSelectedId,
    text,
    spokenChars: 0,
    ...(markdown ? { markdown } : {}),
    ...(shared ? { shared } : {}),
  };
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

const REVIEW_GLYPH = "\x1b[32m✓ needs review\x1b[0m";

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
    // A subagent (C4) or a started session (C15) is indented under its row; every other row is unchanged.
    const label = nestedUnder(row) ? `  ↳ ${row.label}` : row.label;
    if (row.paused) {
      return `${cursor}\x1b[2m${label.slice(0, 26).padEnd(27)}⏸ manual\x1b[0m`;
    }
    // Footer mode historically keyed its live glyph by label. Keep that exact
    // behavior here; theater uses the unambiguous active/liveGlyph model fields.
    const legacyLiveGlyph = row.label === model.live.label ? LIVE_GLYPH[model.live.state] : undefined;
    const glyph = legacyLiveGlyph
      ?? (reviewReady(row)
        ? REVIEW_GLYPH
        : row.status
          ? STATUS_GLYPH[row.status]
          : "\x1b[2m· idle\x1b[0m");
    const detail = row.review?.summary ?? row.detail;
    return `${cursor}${label.slice(0, 26).padEnd(27)}${glyph}${detail ? ` \x1b[2m(${detail})\x1b[0m` : ""}`;
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
    "  \x1b[1mconch\x1b[0m",
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
  scene?: ReviewScene;
  /** Epoch-ms the deliverable was filed. */
  at: number;
  /**
   * Minted once at filing (`reviewIdentity`), and carried unchanged from there: through the
   * latch, the reviews file, a daemon restart, and onto the wire. Every surface that needs to
   * say "this deliverable, the one I already looked at" keys on this rather than recomputing
   * a key of its own.
   */
  id: string;
  /**
   * When this deliverable was looked at, epoch-ms; absent means nobody has.
   *
   * It lives on the record, not in whichever window happened to show it. Four surfaces each
   * kept their own set — the terminal's, the Mac pill's, the phone sheet's, and the Mac's
   * notification set — all of them in memory, so every relaunch marked everything unread and
   * the Mac and the phone never agreed. A panel of tabs that greys what you have already
   * reviewed cannot be built on that.
   */
  viewedAt?: number;
}

/**
 * Whether a row's deliverable is work waiting to be LOOKED at: the star, the
 * "to look at" count. A deliverable stays on a working row (it is still the
 * session's artifact) but a session that went back to work is not waiting on
 * you. Derived from `status` rather than published as a field, so every app
 * applies the same rule to old and new daemons alike — an old daemon never
 * publishes a review on a working row, so the rule holds there unchanged.
 */
export function reviewReady(row: { status: SessionStatus | null; review?: unknown }): boolean {
  return row.review !== undefined && row.status !== "working";
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
/**
 * How many deliverables one session keeps.
 *
 * Measured, not guessed. Eight sessions each publishing this many — with a scene and a long
 * link on every one — is 34.6 KB, 53% of the 64 KiB control frame, which leaves room for
 * everything else a row carries. Eight each would be 67%, twelve 97%.
 *
 * The oldest fall off. `review` is always the newest, so nothing that reads one deliverable
 * is affected by this at all.
 */
export const MAX_SESSION_REVIEWS = 6;

/**
 * Every deliverable a session is still holding, oldest first.
 *
 * `carriedReview` answers "which ONE", and is unchanged — the row, the star and the pill all
 * still mean the newest. This answers "which ones", which is what a panel of tabs needs and
 * what the model could not say before: `incoming ?? prior?.review` kept exactly one, so a
 * session that filed three deliverables had destroyed two of them.
 *
 * Identity decides what is a second deliverable, not arrival: republishing the same one is
 * the same one. That is why #268 had to land first.
 */
export function carriedReviews(
  prior: readonly SessionReview[] | undefined,
  incoming: SessionReview | undefined,
): SessionReview[] | undefined {
  const kept = prior ?? [];
  if (!incoming) return kept.length ? [...kept] : undefined;
  const others = kept.filter((review) => review.id !== incoming.id);
  const next = [...others, incoming].sort((a, b) => a.at - b.at);
  return next.slice(Math.max(0, next.length - MAX_SESSION_REVIEWS));
}

/**
 * Mark one held deliverable as looked at, or nothing if there was nothing to change.
 *
 * Here rather than in the daemon because the interesting parts are rules, not effects.
 * Marking one that is ALREADY marked must not restamp it — a second window opening the same
 * deliverable would otherwise make it look freshly read — and an identity this session does
 * not hold must change nothing at all, rather than marking whatever is nearest.
 *
 * `undefined` means nothing changed, so the caller knows not to persist or republish.
 */
export function markReviewViewed(
  held: readonly SessionReview[] | undefined,
  review: string,
  now: number,
): SessionReview[] | undefined {
  if (!held?.length) return undefined;
  const index = held.findIndex((one) => one.id === review);
  if (index < 0 || held[index]!.viewedAt !== undefined) return undefined;
  return held.map((one, at) => at === index ? { ...one, viewedAt: now } : one);
}

export function carriedReview(
  prior: { review?: SessionReview } | undefined,
  _status: SessionStatus,
  incoming: SessionReview | undefined,
): SessionReview | undefined {
  // An artifact outlives the turn that produced it. It used to be cleared the
  // moment the session went back to work, which meant REPLYING to the agent
  // that filed it destroyed the thing you were replying about — Tyler asked
  // where the artifact was, and it had been deleted by his own question.
  //
  // That also contradicted what conch tells agents, verbatim: "conch's apps
  // show ONE artifact per session beside the conversation... it stays there
  // until you send another." Only a newer artifact replaces it now, which is
  // what the contract always said and what `review_to_front` is for.
  //
  // The status rule was right about one thing and wrong about the other: a
  // session going back to work should stop ADVERTISING a finished deliverable
  // as the reason it needs you, and that lives in the row's status, not here.
  return incoming ?? prior?.review;
}

/**
 * Map Claude Code's registry `status` onto a panel state. The registry is the
 * authoritative source of "is this session working or waiting on me". Claude
 * Code writes exactly four values:
 *  - `idle` → the turn is done, ready for your next prompt (waiting)
 *  - `shell` → the turn is done too; a `run_in_background` Bash (a dev server,
 *    a watcher) is still running beside it. That command never finishes on its
 *    own, so reading it as working left rows "working" for hours (waiting)
 *  - `busy` → a turn is running, including while background subagents do (working)
 *  - `waiting` → a permission prompt, dialog or elicitation is open (needs)
 *  - anything else (unknown/future status) → null, i.e. defer to the latched value
 */
export function registryToPanel(status: string | undefined): SessionStatus | null {
  switch (status) {
    case "idle":
    case "shell":
      return "waiting";
    case "busy":
      return "working";
    case "waiting":
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
 *
 * One exception to newest-wins: Claude Code rewrites its registry only when the
 * status CHANGES, so a correct, stable `busy` keeps an old timestamp and a
 * mistaken newer latch (a Stop while the session is still busy) would beat it
 * forever. Once a latch is `LATCH_GRACE_MS` old, a disagreeing registry status
 * wins outright, whatever the latch says.
 */
export function reconcileStatus(
  session: Pick<SessionInfo, "status" | "statusUpdatedAt" | "backend" | "parentSessionId">,
  latched: LatchedState | undefined,
  now: number,
): SessionStatus | null {
  return reconcilePanelState(session, latched, now)?.status ?? null;
}

/**
 * How long a latch that disagrees with Claude Code's registry stands before the
 * registry corrects it. A hook and Claude's own registry write for the same
 * transition land milliseconds apart (Claude writes after a blocking hook
 * returns), so this only has to let a just-latched event show before that write
 * lands. 5 s covers the gap with room to spare and still clears a wrong latch
 * before anyone acts on it.
 */
export const LATCH_GRACE_MS = 5_000;

function reconcilePanelState(
  session: Pick<SessionInfo, "status" | "statusUpdatedAt" | "backend" | "parentSessionId">,
  latched: LatchedState | undefined,
  now: number,
): { status: SessionStatus; at?: number } | null {
  const reg = registryToPanel(session.status);
  const regAt = session.statusUpdatedAt ?? 0;
  // Past the grace, Claude Code's registry corrects any disagreeing latch, a
  // needs included (an idle_prompt question reads `idle` there, and needs vs
  // waiting asks the same of you). Never a Stop that saw live background
  // agents. Only Claude Code's own registry is authoritative: a Codex row's
  // status is written by conch's hook with the latch's own timestamp or guessed
  // from thread activity, and a subagent row's `busy` is conch's, not Claude's.
  const registryCorrects = latched !== undefined
    && latched.status !== reg
    && !latched.backgroundWork
    && session.backend !== "codex"
    && !session.parentSessionId
    && now - latched.at > LATCH_GRACE_MS;
  if (latched && latched.at >= regAt && !registryCorrects) return latched;
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
 * an attribute of a waiting row, so its ✓ never changes the natural order.
 */
export const STATUS_RANK: Record<SessionStatus, number> = {
  needs: 1,
  waiting: 2,
  working: 3,
};
