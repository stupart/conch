import { createServer } from "node:net";
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "./config.ts";
import type { TurnEvent } from "./hook.ts";
import {
  speakCancellable as backendSpeakCancellable,
  stopSpeaking as backendStopSpeaking,
  probeTtsServer,
  probeTtsServerPresence,
  resetTtsReadiness,
  availableVoiceRing,
  clearVoiceOverride,
  setVoiceOverride,
  voiceFor,
} from "./speak.ts";
import { SpeechManager } from "./speech-manager.ts";
import { ServerSupervisor } from "./server-supervisor.ts";
import { TtsSupervisor } from "./tts-supervisor.ts";
import {
  listenGap,
  listenOnce,
  armBargeRecorder,
  killActiveRecorders,
  createDictationSession,
  type ListenHooks,
  type RuntimeDictationSession,
} from "./listen.ts";
import type { RecorderHandle } from "./dictation-controller.ts";
import { injectText, injectKey, revealSessionWindow, toClipboard } from "./inject.ts";
import { classify, classifyReadingGap, parseNameAddress, wordOverlapRatio } from "./commands.ts";
import { lastAssistantText, splitSentences, stripMarkdown, countCoveredSentences, userRespondedSince, transcriptMark } from "./snippet.ts";
import { askClaude } from "./model.ts";
import { routeVoicePrompt } from "./voice-qa.ts";
import {
  composeResumeBriefing,
  ResumeDigestEscrow,
  runResumeDigest,
  shouldUseResumeDigest,
} from "./resume-digest.ts";
import {
  whisperServerClient,
  type WhisperRecoveryReason,
} from "./transcribe.ts";
import {
  clearReadingProgress,
  clearTheaterSelection,
  configureRenderer,
  getLiveState,
  installRendererLifecycle,
  logAbove,
  logsShown,
  onLiveChange,
  publishSessionsFile,
  renderPanel,
  resizeRenderer,
  scrollTheaterPane,
  setKeybar,
  setLogsVisible,
  setReadingProgress,
  setState,
  setTranscriptPrefix,
  theaterPointerEvent,
  type ConchState,
} from "./status.ts";
import {
  listSessions,
  registrySnapshot,
  sessionGoneFromSnapshot,
  sessionLabel,
  findSessionBySpokenName,
  findTranscript,
  renameSessionLabel,
  type RegistrySnapshot,
  type SessionInfo,
} from "./sessions.ts";
import { sessionHasLiveBackgroundWork } from "./agent-activity.ts";
import {
  activeSessionIdForRows,
  buildPanelModel,
  buildPanelRows,
  buildPublishedState,
  commitLatestPanelRender,
  latestLatchedState,
  previewForPanelSelection,
  type SessionStatus,
} from "./panel.ts";
import { TheaterNavigation } from "./theater-navigation.ts";
import { SgrMouseParser } from "./theater-mouse.ts";
import {
  FOOTER_KEYBAR,
  THEATER_KEYBAR,
  dashboardHelpText,
  dispatchTheaterControlKey,
  type TheaterControlCallbacks,
} from "./theater-controls.ts";
import {
  gateTurnForControls,
  InstantControls,
  markQueuedTurnsForMute,
  markQueuedWakesForControl,
  muteAcknowledgement,
  shouldForgetMutedArrival,
} from "./instant-controls.ts";
import {
  emitRecorderTrace,
  emitRecorderTraces,
  createRecorderParent,
  flushPendingRecorderTraces,
  recorderDiagnosticsEnabled,
  updateRecorderTrace,
} from "./diagnostics.ts";
import {
  DictationReducer,
  classifyPermissionDecision,
  type DictationActionReadyEffect,
  type DictationReducerEffect,
  type ExternalDictationAction,
} from "./dictation-reducer.ts";
import { assertNormalMicClosed as assertAudioGate, withNormalMicClosed } from "./audio-gate.ts";
import {
  createManualReplyListenGuard,
  interruptForManualReply,
  manualReplyListenBaseline,
  ManualReplyInterrupt,
  watchManualReplyDuringSpeech,
  type ManualReplyListenGuard,
} from "./manual-reply.ts";
import {
  PauseController,
  SettingsPauseLifecycle,
  type PauseResumeResult,
} from "./pause-controller.ts";
import {
  SETTING_DESCRIPTORS,
  SETTING_REGISTRY,
  isControlMessageCandidate,
  loadSettingResolutions,
  loadSettingsFile,
  resolveSettingFromLoaded,
  settingsPathFor,
  validateControlMessage,
  writeSetting,
  type ConfigAck,
  type ConfigControlMessage,
  type ConfigControlResponse,
  type ConfigSnapshot,
  type SettingKey,
  type SettingResolution,
  type SettingValue,
  type HandoffOrder,
} from "./settings.ts";
import { SettingsOverlay } from "./settings-overlay.ts";
import { SessionActionsOverlay } from "./session-actions-overlay.ts";

/**
 * The turn-based voice loop.
 *
 *   IDLE -> (hook: turn ended) -> SPEAK announcement -> LISTEN (VAD window)
 *        -> INJECT transcript into that session -> IDLE
 *
 * Routing is "the mic follows the voice": whichever session most recently
 * announced owns the next utterance. The mic never opens while speaking, so
 * the loop can't hear itself. Events queue while an exchange is in flight —
 * multiple sessions finishing at once take turns, one pending event per
 * session, ordered by the live handoff policy (newest first by default). A
 * "wake" event (conch wake, or spacebar when the daemon runs in a terminal)
 * reopens the mic for the last announced session.
 */
// Mute + pause are persisted so a daemon restart (launchd/supervisor respawn)
// doesn't silently turn conch back ON — "muted for the night" / "paused while
// away" must survive.
const STATE_FILE = join(homedir(), ".config/conch/state.json");

interface DaemonState {
  muted: boolean;
  paused: boolean;
}

function readState(): DaemonState {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return { muted: s.muted === true, paused: s.paused === true };
  } catch {
    return { muted: false, paused: false };
  }
}

function writeState(state: DaemonState): void {
  try {
    mkdirSync(join(homedir(), ".config/conch"), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state) + "\n");
  } catch {}
}

export interface ConfigControllerOptions {
  env?: Readonly<Record<string, string | undefined>>;
  settingsPath?: string;
}

export interface ConfigController {
  handle(message: ConfigControlMessage): ConfigControlResponse;
}

function withHookDiagnostic(resolution: SettingResolution, env: string): SettingResolution {
  const caveat = `next hook — hook env (${env}) may override`;
  return {
    ...resolution,
    diagnostic: resolution.diagnostic ? `${resolution.diagnostic}; ${caveat}` : caveat,
  };
}

/**
 * Owns the daemon's authoritative live provenance. Values are assigned into the
 * existing Config object so every already-closed-over call site sees updates.
 */
export function createConfigController(cfg: Config, options: ConfigControllerOptions = {}): ConfigController {
  const env = options.env ?? process.env;
  const settingsPath = options.settingsPath ?? settingsPathFor(env);
  const initial = loadSettingResolutions({ env, settingsPath });
  const live = new Map<SettingKey, SettingResolution>();

  for (const descriptor of SETTING_DESCRIPTORS) {
    if (descriptor.apply !== "live") continue;
    live.set(descriptor.key, {
      ...initial[descriptor.key],
      value: cfg[descriptor.field] as SettingValue,
    });
  }

  const hookResolution = (key: SettingKey): SettingResolution => {
    const descriptor = SETTING_REGISTRY.get(key)!;
    const loaded = loadSettingsFile(settingsPath);
    return withHookDiagnostic(resolveSettingFromLoaded(descriptor, env, loaded, false, true), descriptor.env);
  };

  const ack = (
    message: Extract<ConfigControlMessage, { kind: "set-config" | "unset-config" }>,
    resolution: SettingResolution,
    status: ConfigAck["status"],
  ): ConfigAck => {
    const descriptor = SETTING_REGISTRY.get(message.key)!;
    return {
      kind: "config-ack",
      key: message.key,
      action: message.kind === "set-config" ? "set" : "unset",
      status,
      effective: resolution.value,
      source: resolution.source,
      ...(status === "masked" ? { env: descriptor.env } : {}),
      ...(resolution.diagnostic ? { diagnostic: resolution.diagnostic } : {}),
    };
  };

  return {
    handle(message): ConfigControlResponse {
      if (message.kind === "get-config") {
        const snapshot = Object.create(null) as ConfigSnapshot;
        for (const descriptor of SETTING_DESCRIPTORS) {
          const resolution = descriptor.apply === "hook"
            ? hookResolution(descriptor.key)
            : live.get(descriptor.key)!;
          snapshot[descriptor.key] = { ...resolution };
        }
        return { kind: "config-snapshot", snapshot };
      }

      const descriptor = SETTING_REGISTRY.get(message.key);
      if (!descriptor) return { kind: "config-error", error: `unknown setting "${message.key}"` };

      if (descriptor.apply === "hook") {
        const resolution = message.kind === "set-config"
          ? withHookDiagnostic(
            resolveSettingFromLoaded(
              descriptor,
              env,
              { path: settingsPath, exists: true, values: { [descriptor.key]: message.value } },
              false,
              true,
            ),
            descriptor.env,
          )
          : withHookDiagnostic(
            resolveSettingFromLoaded(
              descriptor,
              env,
              { path: settingsPath, exists: false, values: Object.create(null) as Record<string, unknown> },
              false,
              true,
            ),
            descriptor.env,
          );
        return ack(message, resolution, "hook-next");
      }

      const loaded = message.kind === "set-config"
        ? { path: settingsPath, exists: true, values: { [descriptor.key]: message.value } }
        : { path: settingsPath, exists: false, values: Object.create(null) as Record<string, unknown> };
      const resolution = resolveSettingFromLoaded(descriptor, env, loaded, true, true);
      Object.assign(cfg, { [descriptor.field]: resolution.value });
      live.set(descriptor.key, resolution);
      return ack(message, resolution, message.kind === "set-config" && resolution.source === "env" ? "masked" : "applied");
    },
  };
}

export type SocketControlDispatch =
  | { handled: false }
  | { handled: true; response: ConfigControlResponse };

/** Distinguish config control before any value can be cast into TurnEvent. */
export function dispatchControlMessage(value: unknown, controller: ConfigController): SocketControlDispatch {
  if (!isControlMessageCandidate(value)) return { handled: false };
  const validated = validateControlMessage(value);
  if (!validated.ok) return { handled: true, response: { kind: "config-error", error: validated.err } };
  return { handled: true, response: controller.handle(validated.value) };
}

/** Only a genuine turn end, or an explicitly opted-in reclassified Stop, owns audio. */
export function shouldHandleTurnAudibly(
  event: Pick<TurnEvent, "type" | "backgroundWork">,
  workingMic: boolean,
): boolean {
  return event.type === "turn-end"
    || (event.type === "working" && event.backgroundWork === true && workingMic);
}

/**
 * A daemon-time background-work check may learn more than the hook-time scan.
 * Mutate the queued object itself: ordering, mute-forget, and pause replay all
 * retain this exact reference.
 */
export function downgradeTurnWithLiveBackgroundWork(
  event: TurnEvent,
  hasLiveWork: boolean,
): TurnEvent {
  if (event.type === "turn-end" && hasLiveWork && !event.review) {
    event.type = "working";
    event.backgroundWork = true;
  }
  return event;
}

/** Resolve a wake without carrying a prior turn's read-aloud discriminator forward. */
export function resolveWakeTarget(wake: TurnEvent, lastTurn: TurnEvent | null): TurnEvent | null {
  const target = wake.sessionId ? wake : lastTurn;
  return target ? { ...target, type: "wake" } : null;
}

/** Wake/adopted exchanges listen first; ordinary turns read the remaining response first. */
export function startsConversationByListening(event: Pick<TurnEvent, "type">, announcedCapture = false): boolean {
  return event.type === "wake" || announcedCapture;
}

export type NameAddressRoute =
  | {
    kind: "deliver";
    event: TurnEvent;
    text: string;
    addressed?: { name: string; label: string };
  }
  | {
    kind: "wake";
    event: TurnEvent;
    addressed: { name: string; label: string };
  };

export interface NameAddressRouteOptions {
  findSession?: (claudeDir: string, name: string) => Promise<SessionInfo | null>;
  labelFor?: (session: SessionInfo, cwd: string | undefined) => string;
  transcriptFor?: (claudeDir: string, sessionId: string) => string | undefined;
}

/** Resolve a raw spoken address without mutating the event held by daemon state. */
export async function resolveNameAddressRoute(
  claudeDir: string,
  event: TurnEvent,
  text: string,
  options: NameAddressRouteOptions = {},
): Promise<NameAddressRoute> {
  const findSession = options.findSession ?? findSessionBySpokenName;
  const labelFor = options.labelFor ?? sessionLabel;
  const transcriptFor = options.transcriptFor ?? findTranscript;

  for (const candidate of parseNameAddress(text)) {
    let session: SessionInfo | null;
    try {
      session = await findSession(claudeDir, candidate.name);
    } catch {
      continue;
    }
    if (!session) continue;

    const label = labelFor(session, session.cwd);
    const transcriptPath = transcriptFor(claudeDir, session.sessionId);
    const addressed = { name: candidate.name, label };
    if (!candidate.rest) {
      return {
        kind: "wake",
        addressed,
        event: {
          type: "wake",
          sessionId: session.sessionId,
          label,
          cwd: session.cwd,
          pid: session.pid,
          announce: "",
          transcriptPath,
        },
      };
    }

    return {
      kind: "deliver",
      addressed,
      event: event.sessionId === session.sessionId
        ? event
        : {
          ...event,
          sessionId: session.sessionId,
          label,
          cwd: session.cwd,
          pid: session.pid,
          transcriptPath,
        },
      text: candidate.rest,
    };
  }

  return { kind: "deliver", event, text };
}

type OrderedTurnEvent = Pick<TurnEvent, "type" | "sessionId" | "eventAt">;
interface NumberedSessionRow {
  n: number;
  s: SessionInfo;
  label: string;
}
const STATE_EVENT_TYPES = new Set<TurnEvent["type"]>(["working", "turn-end", "needs-you"]);
const HANDOFF_URGENCY: Partial<Record<TurnEvent["type"], number>> = {
  working: 1,
  "turn-end": 2,
  "needs-you": 3,
};
const MODE_CONTROL_TYPES = new Set<TurnEvent["type"]>(["mute", "unmute", "pause", "resume"]);
const NO_INSTANT_QUEUE_BARRIERS = { has: (_event: TurnEvent): boolean => false };

/**
 * Keep mode acknowledgements last as before, while an opt-in dashboard
 * takeover stays ahead of every ordinary command/state arrival that follows it.
 */
export function insertQueuedEvent(
  queue: TurnEvent[],
  event: TurnEvent,
  instantBarriers: { has(event: TurnEvent): boolean } = NO_INSTANT_QUEUE_BARRIERS,
): boolean {
  const instant = instantBarriers.has(event);
  const duplicateIndex = event.type === "speak" && !event.sessionId
    ? -1
    : queue.findIndex(
      (queued) => queued.sessionId === event.sessionId && queued.type === event.type,
    );
  if (duplicateIndex !== -1) {
    const duplicate = queue[duplicateIndex]!;
    // An ordinary socket command cannot silently dislodge the dashboard
    // takeover that already interrupted the active exchange. A later instant
    // edge or mode/space cancellation removes that protection explicitly.
    if (instantBarriers.has(duplicate) && !instant) return false;
    queue.splice(duplicateIndex, 1);
  }

  if (MODE_CONTROL_TYPES.has(event.type)) {
    queue.push(event);
    return true;
  }

  const modeIndex = queue.findIndex((queued) => MODE_CONTROL_TYPES.has(queued.type));
  if (instant) {
    if (modeIndex === -1) queue.push(event);
    else queue.splice(modeIndex, 0, event);
    return true;
  }

  const barrierIndex = queue.findIndex(
    (queued) => MODE_CONTROL_TYPES.has(queued.type) || instantBarriers.has(queued),
  );
  if (barrierIndex === -1) queue.push(event);
  else queue.splice(barrierIndex, 0, event);
  return true;
}

/**
 * Remove the next queued session event without sorting the queue. Imperative
 * events are LIFO barriers: only the state-event cohort newer than the latest
 * command is reordered, preserving wake/speak/mode command semantics. Session
 * priority narrows that eligible cohort but can never reach below the barrier.
 */
export function takeNextQueuedEvent(
  queue: TurnEvent[],
  order: HandoffOrder,
  prioritized: ReadonlySet<string> = new Set(),
): TurnEvent | undefined {
  if (!queue.length) return undefined;

  let latestCommand = -1;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (!STATE_EVENT_TYPES.has(queue[i]!.type)) {
      latestCommand = i;
      break;
    }
  }
  const cohortStart = latestCommand + 1;
  if (cohortStart === queue.length) return queue.pop();

  const prioritizedIndices: number[] = [];
  if (prioritized.size) {
    for (let i = cohortStart; i < queue.length; i++) {
      if (prioritized.has(queue[i]!.sessionId)) prioritizedIndices.push(i);
    }
  }
  const candidates = prioritizedIndices.length
    ? prioritizedIndices
    : Array.from({ length: queue.length - cohortStart }, (_, index) => cohortStart + index);

  let selected = order === "newest"
    ? candidates[candidates.length - 1]!
    : candidates[0]!;
  if (order === "urgency") {
    for (const i of candidates.slice(1)) {
      const candidate = HANDOFF_URGENCY[queue[i]!.type] ?? 0;
      const current = HANDOFF_URGENCY[queue[selected]!.type] ?? 0;
      if (candidate >= current) selected = i; // equal urgency => newer arrival
    }
  }
  return queue.splice(selected, 1)[0];
}

function eventTimestamp(eventAt: unknown): number {
  return typeof eventAt === "number" && Number.isFinite(eventAt) && eventAt > 0 ? eventAt : 0;
}

/**
 * Arrival can invert occurrence order because separate hooks do different I/O.
 * Keep the newest state event seen for each session before queued handling, and
 * use object identity to invalidate an older event already sitting in the queue.
 */
export class TurnEventOrder {
  readonly #latest = new Map<string, { at: number; event: OrderedTurnEvent }>();

  accept(event: OrderedTurnEvent): boolean {
    if (!event.sessionId || !STATE_EVENT_TYPES.has(event.type)) return true;
    const at = eventTimestamp(event.eventAt);
    const current = this.#latest.get(event.sessionId);
    if (current && current.at > at) return false;
    this.#latest.set(event.sessionId, { at, event });
    return true;
  }

  isCurrent(event: OrderedTurnEvent): boolean {
    if (!event.sessionId || !STATE_EVENT_TYPES.has(event.type)) return true;
    return this.#latest.get(event.sessionId)?.event === event;
  }

  forget(sessionId: string): void {
    this.#latest.delete(sessionId);
  }
}

/** Keep dismissed sessions live in the registry while omitting their dashboard rows. */
export function withoutDismissedSessions<T extends Pick<SessionInfo, "sessionId">>(
  sessions: readonly T[],
  dismissedSessionIds: ReadonlySet<string>,
): T[] {
  return sessions.filter((session) => !dismissedSessionIds.has(session.sessionId));
}

/** Transient command state dies only when a complete registry proves the session exited. */
export function pruneSessionCommandSets(
  snapshot: Pick<RegistrySnapshot, "complete" | "liveIds"> | null,
  prioritizedSessionIds: Set<string>,
  dismissedSessionIds: Set<string>,
): void {
  if (!snapshot?.complete) return;
  for (const ids of [prioritizedSessionIds, dismissedSessionIds]) {
    for (const sessionId of ids) {
      if (!snapshot.liveIds.has(sessionId)) ids.delete(sessionId);
    }
  }
}

/**
 * Wire listen-phase state and live partials into the status renderer.
 *
 * The prefix provider is conversation-scoped. Reading it at render events keeps
 * the theater transcript aligned with the reducer's accepted buffer instead of
 * guessing which final transcriptions will survive command reduction.
 */
export function listenHooks(
  label: string,
  transcriptPrefix?: () => string,
  status: {
    setState(state: ConchState, label?: string, partial?: string): void;
    setTranscriptPrefix(prefix: string): void;
  } = { setState, setTranscriptPrefix },
): ListenHooks {
  const refreshTranscriptPrefix = (): void => {
    if (transcriptPrefix) status.setTranscriptPrefix(transcriptPrefix());
  };
  // A newly-created conversation may adopt an already-open barge recorder, in
  // which case no initial "armed" transition fires. Reset eagerly so that path
  // cannot inherit another turn's theater-only prefix.
  refreshTranscriptPrefix();
  return {
    onState: (state) => {
      // Refresh before the visible state transition: setState intentionally
      // preserves the prefix, so theater never paints a stale one in between.
      refreshTranscriptPrefix();
      if (state === "armed") status.setState("listening", label);
      else if (state === "capturing") status.setState("recording", label);
      else status.setState("transcribing", label);
    },
    onPartial: (text) => {
      // Footer remains the current capture only; theater separately reads the
      // authoritative committed prefix installed immediately afterward.
      status.setState("recording", label, text);
      refreshTranscriptPrefix();
    },
  };
}

export async function runDaemon(cfg: Config): Promise<void> {
  const rendererSelection = configureRenderer();
  const rendererLifecycle = installRendererLifecycle(rendererSelection.renderer);
  const theaterMode = rendererSelection.kind === "theater";
  const resetTheaterTranscriptPrefix = (): void => {
    if (theaterMode) setTranscriptPrefix("");
  };
  const resetReadingProgress = (): void => {
    if (theaterMode) clearReadingProgress();
  };
  const updateReadingProgress = (text: string, spokenChars: number): void => {
    if (theaterMode) setReadingProgress(text, spokenChars);
  };
  const diagnosticsEnabled = recorderDiagnosticsEnabled();
  const queue: TurnEvent[] = [];
  let busy = false;
  let lastTurn: TurnEvent | null = null;
  const persisted = readState(); // survives restarts — see STATE_FILE
  let muted = persisted.muted;
  let pause!: PauseController; // "away" mode: quiet, but HOLD finished sessions to replay on resume
  let stopKey = false; // spacebar pressed while reciting — the guaranteed interrupt
  let micOpen = false; // true while a dictation/permission listen is in flight — spacebar closes it
  let activeDictation: {
    session: RuntimeDictationSession;
    requestExternal(action: ExternalDictationAction, barrierReason?: string): void;
    done: Promise<void>;
  } | null = null;
  let shuttingDown = false;
  let normalMicReserved = false;
  let bargeHandoffOpen = false;
  const injectedAt = new Map<string, number>(); // session -> last time conch drove it
  const pending = new Map<string, TurnEvent>(); // sessions that finished while paused — latest per session
  const resumeTransitions = new WeakMap<TurnEvent, Promise<PauseResumeResult>>();
  const resumeDigestEscrow = new ResumeDigestEscrow<TurnEvent>();
  let resumeDigestArm: {
    owner: TurnEvent;
    generation: number | null;
  } | null = null;
  const restorePreparedResumeDigest = (): void => {
    for (const event of resumeDigestEscrow.restore()) {
      if (!pending.has(event.sessionId)) pending.set(event.sessionId, event);
    }
  };
  // Live session status for the dashboard panel — replaces the spoken "needs you"
  // nag with a glanceable visual: working (you submitted a prompt) / waiting (turn
  // ended, ready for you) / needs (a permission/idle notification fired).
  const sessionStates = new Map<string, {
    label: string;
    status: SessionStatus;
    detail?: string;
    at: number;
    review?: { summary: string; link?: string };
  }>();
  const eventOrder = new TurnEventOrder();
  // Footer mode keeps its established persistent picker untouched. Theater uses
  // a separate active anchor + explicitly released parked cursor below.
  let panelOrder: string[] = [];
  let panelLabels = new Map<string, string>();
  let panelSessions = new Map<string, SessionInfo>();
  let numberedSessionRows: NumberedSessionRow[] = [];
  let selectedId: string | null = null;
  let cursorAuto = true;
  let panelOpen = true;
  const theaterNavigation = new TheaterNavigation(() => void renderSessionPanel());
  const mouseParser = new SgrMouseParser();
  let settingsOverlay: SettingsOverlay | null = null;
  let sessionActionsOverlay: SessionActionsOverlay | null = null;
  // Per-session modes are transient dashboard state. Pause holds only the newest
  // turn for replay; mute deliberately forgets.
  const pausedSessionIds = new Set<string>();
  const mutedSessionIds = new Set<string>();
  const prioritizedSessionIds = new Set<string>();
  const dismissedSessionIds = new Set<string>();
  const sessionHeldTurns = new Map<string, TurnEvent>();
  const latestTurnBySession = new Map<string, TurnEvent>();
  const forgottenTurns = new WeakSet<TurnEvent>();
  const instantQueueBarriers = new WeakSet<TurnEvent>();
  const forgetQueuedAudioCommand = (event: TurnEvent): void => {
    forgottenTurns.add(event);
    instantQueueBarriers.delete(event);
  };
  // The turn currently being handled, used by PauseController's scoped edge.
  let recitingEvent: TurnEvent | null = null;
  let handlingEvent: TurnEvent | null = null;
  let handlingPauseGeneration: number | null = null;
  const sessionModalOpen = (): boolean =>
    Boolean(settingsOverlay?.isOpen() || sessionActionsOverlay?.isOpen());

  const normalMicOpen = (): boolean => Boolean(
    activeDictation?.session.micOpen || micOpen || normalMicReserved || bargeHandoffOpen
  );
  const assertNormalMicClosed = (operation: string): void => assertAudioGate(normalMicOpen, operation);
  let whisperSupervisor: ServerSupervisor<WhisperRecoveryReason> | null = null;
  let ttsSupervisor: TtsSupervisor | null = null;
  whisperServerClient.setRecoveryHandler((reason) => whisperSupervisor?.requestRecovery(reason));
  const speech = new SpeechManager(
    { speakCancellable: backendSpeakCancellable, stopSpeaking: backendStopSpeaking },
    (operation, output) => withNormalMicClosed(normalMicOpen, operation, output),
    {
      warn: log,
      onKokoroFailure: (reason) => ttsSupervisor?.requestRecovery(reason),
    },
  );
  pause = new PauseController({
    initialPaused: persisted.paused,
    pending,
    currentTurn: () => recitingEvent ?? handlingEvent,
    holdableTurn: (current) => current.type === "wake"
      ? latestTurnBySession.get(current.sessionId) ?? null
      : current,
    currentTurnGeneration: () => handlingPauseGeneration,
    activeSession: () => activeDictation?.session ?? null,
    cancelCurrentSpeech: () => speech.cancelCurrent(),
    cancelPendingAudio: () => speech.cancelPendingAudio(),
    persist: (paused) => writeState({ muted, paused }),
    render: () => void renderSessionPanel(),
    setModeState: (paused) => setState(muted ? "muted" : paused ? "paused" : "idle"),
    log,
    speak: (text) => speak(cfg, text),
    liveSessionIds: async () => (await registrySnapshot(cfg.claudeDir))?.liveIds ?? null,
    userRespondedSince: (event) => userRespondedSince(event.transcriptPath, event.mark),
    replayOverride: async (events) => {
      const arm = resumeDigestArm;
      resumeDigestArm = null;
      if (
        !arm
        || arm.generation === null
        || pause.interrupted(arm.generation)
        || !shouldUseResumeDigest(cfg.resumeDigest, events, pausedSessionIds)
      ) {
        return false;
      }
      const briefing = await composeResumeBriefing(events, askClaude);
      if (
        pause.interrupted(arm.generation)
        || !shouldUseResumeDigest(cfg.resumeDigest, events, pausedSessionIds)
      ) {
        return false;
      }
      return Boolean(resumeDigestEscrow.prepare(
        arm.owner,
        events,
        briefing,
        arm.generation,
      ));
    },
    enqueue,
    onHold: (event) => {
      lastTurn = event;
    },
    onInterruptError: (error) => log(`control interrupt cleanup failed: ${error}`),
  });
  const instantControls = new InstantControls({
    pause,
    globalHeldTurns: pending,
    pausedSessionIds,
    mutedSessionIds,
    sessionHeldTurns,
    setMuted,
    enqueue,
    markInstantQueued: (event) => instantQueueBarriers.add(event),
    forgetQueued: (sessionId) =>
      markQueuedTurnsForMute(queue, (event) => forgottenTurns.add(event), sessionId),
    forgetLatest: (sessionId) => {
      if (sessionId === undefined) latestTurnBySession.clear();
      else latestTurnBySession.delete(sessionId);
    },
    cancelQueuedWakes: (sessionId) =>
      markQueuedWakesForControl(
        queue,
        forgetQueuedAudioCommand,
        sessionId,
      ),
    labelFor: (id) => sessionStates.get(id)?.label ?? id.slice(0, 8),
    log,
    render: () => void renderSessionPanel(),
  });
  const cancelConsumingResumeDigest = (reason: string): void => {
    try {
      speech.cancelCurrent();
    } catch (error) {
      log(`resume digest speech cancellation failed: ${error}`);
    }
    try {
      speech.cancelPendingAudio();
    } catch (error) {
      log(`resume digest pending-audio cancellation failed: ${error}`);
    }
    try {
      activeDictation?.requestExternal("spacebar", reason);
    } catch (error) {
      log(`resume digest mic cancellation failed: ${error}`);
    }
  };
  const setSessionMutedWithDigest = (sessionId: string, next: boolean): void => {
    let digestWasConsuming = false;
    if (next) {
      const forgotten = resumeDigestEscrow.forget(sessionId);
      digestWasConsuming = forgotten.consuming;
    }
    instantControls.setSessionMuted(sessionId, next);
    if (digestWasConsuming) {
      cancelConsumingResumeDigest("resume-digest-session-muted");
    }
  };
  const setSessionPausedWithDigest = (sessionId: string, next: boolean): void => {
    const digestWasConsuming = next
      ? resumeDigestEscrow.invalidate(sessionId).consuming
      : false;
    instantControls.setSessionPaused(sessionId, next);
    if (digestWasConsuming) {
      cancelConsumingResumeDigest("resume-digest-session-paused");
    }
  };
  const settingsPause = new SettingsPauseLifecycle(
    {
      get paused() {
        return pause.paused;
      },
      setPaused(next, options) {
        if (next) {
          resumeDigestArm = null;
          restorePreparedResumeDigest();
        }
        return pause.setPaused(next, options);
      },
    },
    (error) => log(`settings pause transition failed: ${error}`),
  );
  // Hooks may connect while model startup is in flight; drain() holds their
  // events behind this fully-consumed readiness probe.
  let ttsStartup: Promise<void> = Promise.resolve();

  const reserveNormalMic = async (): Promise<boolean> => {
    // Close the gate before yielding. Already-admitted audio may finish; every
    // queued/new task now fails its actual-start check until the controller is
    // synchronously started or resumed.
    normalMicReserved = true;
    await speech.quiescent();
    if (!shuttingDown) return true;
    normalMicReserved = false;
    return false;
  };

  const speak = async (speechCfg: Config, text: string, label = ""): Promise<void> => {
    await speech.speak(speechCfg, text, label);
  };

  const micCue = async (cueCfg: Config, kind: "open" | "close" | "sent"): Promise<void> => {
    if (!cueCfg.micCues) return;
    await speech.playCue(CUE_SOUND[kind], `${kind} mic cue`);
    if (kind === "open") await Bun.sleep(350); // let the cue's tail decay before sox arms
  };

  const ringBell = async (): Promise<void> => {
    if (cfg.bell) await speech.playCue(cfg.bellSound, "attention bell");
  };

  // Record that conch just drove a session, and prune stale entries so this
  // map can't grow without bound over a long-lived daemon. Anything older than
  // the suppress window is irrelevant (the needs-you guard won't consult it).
  function markInjected(sessionId: string): void {
    const now = Date.now();
    injectedAt.set(sessionId, now);
    if (injectedAt.size > 64) {
      for (const [id, t] of injectedAt) {
        if (now - t > cfg.recentInjectSuppressMs) injectedAt.delete(id);
      }
    }
  }

  const consumeStopKey = () => {
    const s = stopKey;
    stopKey = false;
    return s;
  };

  function enqueue(event: TurnEvent): void {
    if (shuttingDown) return;
    // A named wake is the deliberate escape hatch from safe dismiss. Clear the
    // hidden/muted state before arrival stamping so the wake and future turns
    // are both usable again; an unnamed wake cannot identify a dismissed owner.
    if (
      event.type === "wake"
      && event.sessionId
      && dismissedSessionIds.delete(event.sessionId)
    ) {
      mutedSessionIds.delete(event.sessionId);
      log(`▶ restored "${event.label}" after dismiss`);
      void renderSessionPanel();
    }
    if (!eventOrder.accept(event)) return;
    const forgetOnArrival = shouldForgetMutedArrival(
      event,
      muted,
      Boolean(event.sessionId && mutedSessionIds.has(event.sessionId)),
    );
    if (forgetOnArrival) {
      forgottenTurns.add(event);
    } else if (shouldHandleTurnAudibly(event, cfg.workingMic)) {
      latestTurnBySession.set(event.sessionId, event);
    }
    if (event.type === "resume") {
      // Settings owns its silent pause lifetime; an external resume cannot cut
      // through an open modal.
      if (sessionModalOpen()) return;
    }
    if (
      event.type === "pause"
      || event.type === "resume"
      || event.type === "mute"
      || event.type === "unmute"
    ) {
      // Apply every mode edge synchronously. The queued event owns only its
      // spoken acknowledgement after the aborted exchange closes its barrier.
      if (event.type === "resume") {
        // A second resume can overtake a prepared-but-not-yet-spoken digest.
        // Put its exact work back under PauseController before snapshotting.
        restorePreparedResumeDigest();
        resumeDigestArm = { owner: event, generation: null };
      } else if (event.type === "pause") {
        restorePreparedResumeDigest();
        resumeDigestArm = null;
      } else if (event.type === "mute") {
        // Global mute deliberately forgets every held turn.
        resumeDigestEscrow.restore();
        resumeDigestArm = null;
      } else {
        // An intervening global edge makes a not-yet-started model plan stale.
        resumeDigestArm = null;
      }
      const transition = instantControls.applyGlobal(event.type);
      if (transition) {
        if (resumeDigestArm?.owner === event) {
          resumeDigestArm.generation = pause.capture();
        }
        const tracked = transition.then(
          (result) => {
            resumeDigestEscrow.settle(event, result.digested === true);
            return result;
          },
          (error) => {
            resumeDigestEscrow.settle(event, false);
            throw error;
          },
        );
        resumeTransitions.set(event, tracked);
      }
    }
    insertQueuedEvent(queue, event, instantQueueBarriers);
    void drain();
  }

  async function drain(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await ttsStartup;
      if (shuttingDown) return;
      if (stopKey && queue.length) {
        const skipped = takeNextQueuedEvent(queue, cfg.handoffOrder, prioritizedSessionIds)!;
        stopKey = false;
        log(`⏹ spacebar — skipped queued ${skipped.type} for "${skipped.label}" during TTS startup`);
      }
      while (queue.length) {
        const event = takeNextQueuedEvent(queue, cfg.handoffOrder, prioritizedSessionIds)!;
        try {
          await handle(event);
        } catch (e) {
          // one bad event (closed pane, missing binary, socket reset, a throw
          // from any spawn) must not take the whole daemon down mid-exchange.
          log(`error handling ${event.type} "${event.label}": ${e}`);
          speech.cancelCurrent();
        }
      }
    } finally {
      busy = false;
      setState(restState());
    }
  }

  // The at-rest status when nothing's in flight: muted wins over paused for display.
  const restState = (): ConchState => (muted ? "muted" : pause.paused ? "paused" : "idle");

  let panelRenderVersion = 0;
  async function renderSessionPanel(): Promise<void> {
    const version = ++panelRenderVersion;
    let snap: Awaited<ReturnType<typeof registrySnapshot>> = null;
    try {
      snap = await registrySnapshot(cfg.claudeDir);
    } catch {}
    const registryLive = snap?.infos ?? [];
    pruneSessionCommandSets(snap, prioritizedSessionIds, dismissedSessionIds);
    // Prune a latch only on a COMPLETE snapshot — a torn/unreadable file must not
    // delete a live session's latch (e.g. a pending "needs"), which never re-fires.
    if (snap?.complete) {
      const liveIds = new Set(registryLive.map((s) => s.sessionId));
      const trackedIds = new Set([
        ...sessionStates.keys(),
        ...pausedSessionIds,
        ...mutedSessionIds,
        ...prioritizedSessionIds,
        ...dismissedSessionIds,
        ...sessionHeldTurns.keys(),
        ...latestTurnBySession.keys(),
      ]);
      for (const id of trackedIds) {
        if (liveIds.has(id)) continue;
        sessionStates.delete(id);
        eventOrder.forget(id);
        pausedSessionIds.delete(id);
        mutedSessionIds.delete(id);
        prioritizedSessionIds.delete(id);
        dismissedSessionIds.delete(id);
        sessionHeldTurns.delete(id);
        latestTurnBySession.delete(id);
      }
    }
    const live = withoutDismissedSessions(registryLive, dismissedSessionIds);
    const liveState = getLiveState(); // what conch is doing right now, if anything
    const orderedRows = buildPanelRows({
      sessions: live,
      sessionStates,
      pausedSessionIds,
      mutedSessionIds,
      live: liveState,
      mode: { muted, paused: pause.paused, holding: pending.size },
      activeSessionId: null,
      navSelectedId: null,
    });
    const nextActiveSessionId = activeSessionIdForRows(orderedRows, liveState, {
      preferredSessionId: theaterMode ? recitingEvent?.sessionId : null,
      liveSessionIds: snap?.liveIds,
    });

    const previewId = theaterMode ? theaterNavigation.manualSelectedId : null;
    const previewPath = previewId && previewId !== nextActiveSessionId
      ? findTranscript(cfg.claudeDir, previewId)
      : undefined;
    const contentEvent = recitingEvent ?? lastTurn;
    const liveReplyText = liveState.reading?.text ?? "";
    const [transcriptReplyText, previewText] = await Promise.all([
      theaterMode && !liveReplyText && contentEvent?.transcriptPath
        ? lastAssistantText(contentEvent.transcriptPath).then(stripMarkdown)
        : Promise.resolve(""),
      previewPath
        ? lastAssistantText(previewPath).then(stripMarkdown)
        : Promise.resolve(""),
    ]);
    const replyText = liveReplyText || transcriptReplyText;
    // Registry and transcript reads can overlap; only the newest complete model
    // may reach the renderer.
    commitLatestPanelRender(version, panelRenderVersion, () => {
      let navSelectedId: string | null;
      if (theaterMode) {
        // Absence is authoritative only for a complete registry read. A torn
        // per-session file must not release a cursor that was meant to stay put.
        if (snap?.complete) {
          theaterNavigation.reconcile(new Set(live.map((session) => session.sessionId)));
        }
        navSelectedId = theaterNavigation.manualSelectedId;
      } else {
        // Legacy auto-follow: selectedId also owns the action target, but its cursor
        // is hidden until arrowing explicitly turns cursorAuto off.
        if (cursorAuto) {
          selectedId = nextActiveSessionId;
        } else if (selectedId && !live.some((session) => session.sessionId === selectedId)) {
          selectedId = null;
        }
        navSelectedId = cursorAuto ? null : selectedId;
      }

      const model = buildPanelModel({
        sessions: live,
        sessionStates,
        pausedSessionIds,
        mutedSessionIds,
        live: liveState,
        mode: { muted, paused: pause.paused, holding: pending.size },
        activeSessionId: nextActiveSessionId,
        navSelectedId,
        reply: contentEvent && replyText
          ? {
            sessionId: contentEvent.sessionId,
            text: replyText,
            spokenChars: liveState.reading?.spokenChars ?? 0,
          }
          : null,
        panelOpen,
      });
      model.preview = previewForPanelSelection(
        navSelectedId,
        previewId,
        nextActiveSessionId,
        previewText,
      );
      model.settingsOverlay = settingsOverlay?.model() ?? null;
      model.sessionActionsOverlay = sessionActionsOverlay?.model() ?? null;
      panelOrder = model.rows.map((row) => row.sessionId);
      panelLabels = new Map(model.rows.map((row) => [row.sessionId, row.label]));
      panelSessions = new Map(live.map((session) => [session.sessionId, session]));
      numberedSessionRows = numberSessionRows(live);
      // Read mode state after the async registry snapshot so a slow older redraw
      // cannot repaint a stale pause/mute banner over a newer toggle.
      model.mode = { muted, paused: pause.paused, holding: pending.size };
      renderPanel(model);
      publishSessionsFile(buildPublishedState(
        model,
        new Map(
          [...latestTurnBySession].map(([sessionId, event]) => [sessionId, event.announce]),
        ),
        dismissedSessionIds,
        Date.now(),
      ));
      if (theaterMode) theaterNavigation.commitFrame(nextActiveSessionId, navSelectedId);
    });
  }
  function setSessionState(
    sessionId: string,
    label: string,
    status: SessionStatus,
    detail?: string,
    eventAt?: number,
    review?: { summary: string; link?: string },
  ): boolean {
    if (!sessionId) return true; // nothing to latch; preserve the event's non-panel behavior
    // Legacy clients without eventAt may still work, but their latch is oldest
    // possible truth and can never clobber a timestamped hook or registry state.
    const at = eventTimestamp(eventAt);
    const incoming = { label, status, detail, at, ...(review ? { review } : {}) };
    if (latestLatchedState(sessionStates.get(sessionId), incoming) !== incoming) return false;
    sessionStates.set(sessionId, incoming);
    void renderSessionPanel();
    return true;
  }

  function relabelRuntimeSession(
    sessionId: string,
    oldLabel: string,
    newLabel: string,
  ): void {
    const events = new Set<TurnEvent>([
      ...queue,
      ...pending.values(),
      ...sessionHeldTurns.values(),
      ...latestTurnBySession.values(),
      ...(lastTurn ? [lastTurn] : []),
      ...(recitingEvent ? [recitingEvent] : []),
      ...(handlingEvent ? [handlingEvent] : []),
      ...resumeDigestEscrow.events(),
    ]);
    const oldPrefix = `${oldLabel}:`;
    for (const event of events) {
      if (event.sessionId !== sessionId) continue;
      event.label = newLabel;
      if (event.announce.startsWith(oldPrefix)) {
        event.announce = `${newLabel}:${event.announce.slice(oldPrefix.length)}`;
      } else if (event.announce.startsWith(`${oldLabel} `)) {
        event.announce = `${newLabel} ${event.announce.slice(oldLabel.length + 1)}`;
      }
    }
    const latched = sessionStates.get(sessionId);
    if (latched) sessionStates.set(sessionId, { ...latched, label: newLabel });
    if (panelLabels.has(sessionId)) panelLabels.set(sessionId, newLabel);
    numberedSessionRows = numberSessionRows([...panelSessions.values()]);
  }

  function setMuted(next: boolean): void {
    muted = next;
    writeState({ muted, paused: pause.paused }); // persist so a restart doesn't un-mute
    void renderSessionPanel(); // visual feedback must not wait on fallible audio
    log(muted ? "muted — announcements and mic off (m or `conch unmute` to resume)" : "unmuted");
    setState(restState());
  }

  async function announceMuted(next: boolean): Promise<void> {
    await speak(cfg, muteAcknowledgement(next));
  }

  async function listenForResumeDigest(
    generation: number,
    canContinue: () => boolean,
  ): Promise<{ text: string; error?: string }> {
    let digestActive: typeof activeDictation = null;
    let closing = false;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    if (!canContinue() || !(await reserveNormalMic())) {
      return { text: "", error: "daemon is shutting down" };
    }
    if (!canContinue() || pause.interrupted(generation)) {
      normalMicReserved = false;
      return { text: "", error: "resume was interrupted" };
    }

    resetTheaterTranscriptPrefix();
    setState("listening", "who first");
    micOpen = true;
    try {
      return await listenOnce(
        {
          ...cfg,
          listenWindowSecs: Math.min(cfg.listenWindowSecs, 10),
        },
        listenHooks("who first", theaterMode ? () => "" : undefined),
        {
          tag: "digest",
          onSessionStarted(session) {
            digestActive = {
              session,
              requestExternal(_action, barrierReason) {
                if (closing || session.state !== "running") return;
                closing = true;
                session.requestBarrier(barrierReason ?? "resume-digest-spacebar");
              },
              done,
            };
            activeDictation = digestActive;
            normalMicReserved = false;
            micOpen = true;
          },
        },
      );
    } catch (error) {
      return {
        text: "",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      normalMicReserved = false;
      if (activeDictation === digestActive) activeDictation = null;
      micOpen = false;
      resolveDone();
    }
  }

  async function handlePreparedResumeDigest(
    owner: TurnEvent,
    result: PauseResumeResult,
  ): Promise<void> {
    const plan = resumeDigestEscrow.begin(owner);
    if (!plan) {
      // A newer pause/resume or settings modal already restored/consumed this
      // stale resume's escrow. Its acknowledgement must not speak twice.
      log("resume digest plan already restored or consumed");
      return;
    }

    for (const sessionId of pausedSessionIds) {
      resumeDigestEscrow.invalidate(sessionId);
    }
    for (const sessionId of mutedSessionIds) {
      resumeDigestEscrow.forget(sessionId);
    }
    const events = plan.events;
    let digestStopRequested = false;
    const digestInterrupted = (): boolean => {
      if (consumeStopKey()) digestStopRequested = true;
      return digestStopRequested
        || plan.cancelled
        || plan.invalidated
        || shuttingDown
        || pause.interrupted(plan.generation);
    };
    const enqueueFullReplay = async (fallbackEvents: readonly TurnEvent[]) => {
      // A newer pause/resume restored this same plan to pending; it now owns
      // the work, so this stale handler must neither duplicate nor announce it.
      if (plan.cancelled) return;
      resumeDigestEscrow.finish(plan);
      // Queue first: even if the spoken count fails, the exact held work stays
      // reachable and will resume after this handler unwinds.
      for (const event of fallbackEvents) enqueue(event);
      if (
        !digestStopRequested
        && !pause.paused
        && !muted
        && !shuttingDown
      ) {
        await pause.announceResumed({
          replayed: fallbackEvents.length,
          dropped: result.dropped + (result.replayed - fallbackEvents.length),
          cancelled: false,
        });
      }
    };

    try {
      if (
        digestInterrupted()
        || !shouldUseResumeDigest(cfg.resumeDigest, events, pausedSessionIds)
      ) {
        await enqueueFullReplay(events);
        return;
      }

      await runResumeDigest(events, plan.briefing, {
        speak: async (text) => {
          setState("speaking");
          await speak(cfg, text);
        },
        listen: async () => {
          await micCue(cfg, "open");
          if (digestInterrupted()) {
            return { text: "", error: "resume was interrupted" };
          }
          return listenForResumeDigest(
            plan.generation,
            () => !digestInterrupted(),
          );
        },
        enqueue,
        fallback: enqueueFullReplay,
        interrupted: digestInterrupted,
      });
    } finally {
      resumeDigestEscrow.finish(plan);
    }
  }

  async function handle(event: TurnEvent): Promise<void> {
    stopKey = false; // a stale press from a past exchange must not skip this one
    micOpen = false; // no listen in flight yet for this event
    if (event.type === "mute") return muted ? announceMuted(true) : undefined;
    if (event.type === "unmute") return !muted ? announceMuted(false) : undefined;
    if (event.type === "pause") return pause.paused ? pause.announcePaused() : undefined;
    if (event.type === "resume") {
      if (sessionModalOpen() || pause.paused) return;
      const transition = resumeTransitions.get(event);
      const result = transition
        ? await transition
        : { replayed: 0, dropped: 0, cancelled: false };
      if (result.digested) return handlePreparedResumeDigest(event, result);
      return pause.announceResumed(result);
    }
    if (event.type === "speak") {
      const speechCfg = event.voice ? { ...cfg, ttsVoices: [event.voice] } : cfg;
      // Explicit previews bypass both modal pause gating and a label-keyed
      // persisted pin; an empty selection label makes the one-item ring win.
      return speak(speechCfg, event.announce, event.voice ? "" : event.label);
    }
    handlingEvent = event;
    handlingPauseGeneration = pause.capture();
    try {
      await handleTurn(event, handlingPauseGeneration);
    } finally {
      if (handlingEvent === event) {
        handlingEvent = null;
        handlingPauseGeneration = null;
      }
    }
  }

  async function handleTurn(event: TurnEvent, pauseGeneration: number): Promise<void> {
    const interruptedByPause = (): boolean => pause.interrupted(pauseGeneration);
    if (!eventOrder.isCurrent(event)) return;

    if (
      event.type === "turn-end"
      && event.transcriptPath
      && sessionHasLiveBackgroundWork(event.transcriptPath)
    ) {
      downgradeTurnWithLiveBackgroundWork(event, true);
      log(`"${event.label}" still has live background work — downgrading to working`);
    }

    const audibleTurn = shouldHandleTurnAudibly(event, cfg.workingMic);
    if (
      audibleTurn
      && sessionGoneFromSnapshot(
        await registrySnapshot(cfg.claudeDir),
        event.sessionId,
      )
    ) {
      log(`skipping "${event.label}" — session closed`);
      sessionStates.delete(event.sessionId);
      eventOrder.forget(event.sessionId);
      latestTurnBySession.delete(event.sessionId);
      pausedSessionIds.delete(event.sessionId);
      mutedSessionIds.delete(event.sessionId);
      prioritizedSessionIds.delete(event.sessionId);
      dismissedSessionIds.delete(event.sessionId);
      sessionHeldTurns.delete(event.sessionId);
      if (lastTurn?.sessionId === event.sessionId) lastTurn = null;
      void renderSessionPanel();
      return;
    }
    if (shuttingDown || interruptedByPause() || consumeStopKey()) return;
    if (!eventOrder.isCurrent(event)) return;

    // Dashboard status — visual, and updated even while muted/paused. Ordinary
    // `working` and all `needs-you` events are visual-only. A Stop reclassified
    // as background-working may opt back into the normal bell/voice/mic path.
    if (event.type === "working") {
      if (!setSessionState(event.sessionId, event.label, "working", undefined, event.eventAt)) return;
      if (!audibleTurn) return;
    }
    if (event.type === "needs-you") {
      const kind = event.ntype && event.ntype !== "idle_prompt" ? event.ntype.replace(/_/g, " ") : undefined;
      setSessionState(event.sessionId, event.label, "needs", kind, event.eventAt);
      return; // stripped: no bell, no announcement, no permission mic
    }
    if (event.type === "turn-end" && !setSessionState(
      event.sessionId,
      event.label,
      event.review ? "review" : "waiting",
      event.review?.summary,
      event.eventAt,
      event.review,
    )) return;

    // Mute stamps at enqueue/control time, so a quick unmute cannot resurrect a
    // turn that completed while quiet. Keep the status update above visible.
    if (forgottenTurns.delete(event)) {
      if (event.type === "wake" || event.type === "recite") {
        return log(`cancelled queued ${event.type} for "${event.label}"`);
      }
      if (audibleTurn) lastTurn = event;
      return log(`muted — forgot queued turn for "${event.label}"`);
    }

    const controlDisposition = gateTurnForControls(event, audibleTurn, {
      globalMuted: muted,
      globalPaused: pause.paused,
      settingsOpen: sessionModalOpen(),
      globalHeldTurns: pending,
      pausedSessionIds,
      mutedSessionIds,
      sessionHeldTurns,
    });
    if (controlDisposition) {
      if (audibleTurn || event.ntype === "idle_prompt") lastTurn = event;
      if (controlDisposition === "session-muted") {
        return log(`🔇 "${event.label}" muted — staying quiet`);
      }
      if (controlDisposition === "global-muted") {
        return log(`muted — staying quiet for "${event.label}"`);
      }
      if (controlDisposition === "session-paused") {
        return log(`⏸ "${event.label}" paused — park it and press p to resume`);
      }
      void renderSessionPanel();
      return log(`paused — holding "${event.label}" (${pending.size} waiting)`);
    }

    // Nobody's there: don't announce to an empty room, don't open the mic,
    // don't burn battery on sox/whisper. Telegram (the other hook) still
    // pings the phone. `conch wake` always cuts through.
    // Only reach for ioreg when the away-timer is actually armed (default off) —
    // muted short-circuits without spawning anything.
    if (event.type !== "wake" && event.type !== "recite" && (muted || cfg.awayAfterSecs)) {
      const idle = muted ? 0 : (await idleSeconds() ?? 0); // null probe → 0 → not away (fail safe)
      if (muted || idle >= cfg.awayAfterSecs) {
        log(`${muted ? "muted" : `away (idle ${Math.round(idle / 60)}m)`} — staying quiet for "${event.label}"`);
        if (audibleTurn || event.ntype === "idle_prompt") lastTurn = event; // wake still finds it
        return;
      }
    }

    if (event.type === "recite") {
      const target: TurnEvent | null = event.sessionId
        ? event
        : lastTurn
          ? { ...lastTurn, type: "recite", announce: "" }
          : null;
      if (!target) {
        log("nothing to recite — no session has spoken yet");
        return;
      }
      recitingEvent = target;
      try {
        const targetGone = sessionGoneFromSnapshot(
          await registrySnapshot(cfg.claudeDir),
          target.sessionId,
        );
        if (shuttingDown || interruptedByPause() || consumeStopKey()) return;
        if (targetGone) {
          log(`nothing to recite — "${target.label}" is closed`);
          return;
        }
        if (!target.transcriptPath) {
          log(`nothing to recite for "${target.label}" — transcript not found`);
          return;
        }
        const [latestReply, currentMark] = await Promise.all([
          lastAssistantText(target.transcriptPath),
          transcriptMark(target.transcriptPath),
        ]);
        const latest = stripMarkdown(latestReply);
        target.mark = currentMark;
        if (shuttingDown || interruptedByPause() || consumeStopKey()) return;
        if (!latest.trim()) {
          log(`nothing to recite for "${target.label}" — no assistant output`);
          return;
        }

        log(`recite -> "${target.label}"`);
        if (cfg.revealOnTurn && target.pid) void revealSessionWindow(target.pid);
        resetReadingProgress();
        setState("speaking", target.label);
        await speak(cfg, `${target.label}:`, target.label);
        if (shuttingDown || interruptedByPause()) return;
        // event.announce is intentionally empty, so conversationLoop starts at
        // sentence zero. autoTurn=false avoids the keyboard-activity mic gate.
        await conversationLoop(
          target,
          "",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          pauseGeneration,
        );
      } finally {
        recitingEvent = null;
      }
      return;
    }

    if (event.type === "wake") {
      const target = resolveWakeTarget(event, lastTurn); // named wake carries its own session
      if (!target) {
        log("wake with nothing to wake — no session has announced yet");
        return void (await speak(cfg, "Nothing to wake. No session has spoken yet."));
      }
      recitingEvent = target;
      try {
        const targetGone = sessionGoneFromSnapshot(
          await registrySnapshot(cfg.claudeDir),
          target.sessionId,
        );
        if (shuttingDown || interruptedByPause()) return;
        if (consumeStopKey()) return;
        if (targetGone) {
          if (lastTurn?.sessionId === target.sessionId) lastTurn = null;
          log("wake target closed");
          return void (await speak(cfg, "That session is closed."));
        }
        log(`wake -> "${target.label}"`);
        if (cfg.revealOnTurn && target.pid) void revealSessionWindow(target.pid); // surface it, no focus steal
        resetReadingProgress();
        setState("speaking", target.label);
        await speak(cfg, `Mic open for ${target.label}.`, target.label);
        if (interruptedByPause()) return;
        await conversationLoop(target, "", undefined, undefined, undefined, undefined, undefined, undefined, false, pauseGeneration);
      } finally {
        recitingEvent = null;
      }
      return;
    }

    log(`${event.type}${event.ntype ? `/${event.ntype}` : ""} from "${event.label}" (${event.sessionId.slice(0, 8)})`);
    recitingEvent = event;
    try {
      // Already handled it yourself: if you typed a reply to this session (so the
      // conversation moved on) since this fired, don't read it aloud or nag for
      // input. Covers the live path AND pause-replay (both flow through here).
      if (audibleTurn && (await userRespondedSince(event.transcriptPath, event.mark))) {
        return log(`skipping "${event.label}" — you already responded, conversation moved on`);
      }
      if (interruptedByPause()) return;

      // An audible Stop reads the reply, then opens the mic — barge-able from the
      // very first sentence.
      const conversationParent = createRecorderParent("conversation");
      let conversationSequence = 0;
      const nextConversationSequence = () => ++conversationSequence;
      resetReadingProgress();
      // The hook hands the bell to the daemon so it cannot ring over a live mic.
      // Track the exact turn before this first cancellable audio boundary.
      if (audibleTurn) await ringBell();
      if (interruptedByPause()) return;

      // Surface the session's window as conch starts talking to it — raised so
      // you can watch, but WITHOUT stealing focus (AXRaise).
      if (event.type === "turn-end" && cfg.revealOnTurn && event.pid) void revealSessionWindow(event.pid);

      const announce = await speakInterruptible(
        event,
        event.announce,
        false,
        conversationParent,
        nextConversationSequence,
        interruptedByPause,
      );
      if (shuttingDown) return;
      if (interruptedByPause()) {
        // A triggered barge may already have transferred recorder ownership.
        // Let conversationLoop attach and abort that capture instead of orphaning it.
        if (announce.initialCapture) {
          await conversationLoop(
            event,
            "",
            undefined,
            undefined,
            announce.initialCapture,
            announce.captureParent,
            conversationParent,
            nextConversationSequence,
            true,
            pauseGeneration,
          );
        }
        return;
      }
      if (announce.cut && !announce.heard && !announce.initialCapture && !stopKey) {
        log("announce cut by a noise blip — re-speaking");
        await speakInterruptible(event, event.announce, true, undefined, undefined, interruptedByPause);
        if (interruptedByPause()) return;
      }
      lastTurn = event;
      await conversationLoop(
        event,
        announce.heard,
        announce.diagnosticId,
        announce.diagnosticIds,
        announce.initialCapture,
        announce.captureParent,
        conversationParent,
        nextConversationSequence,
        true, // autoTurn — the mic here is gate-able (skips if you're handling it by text)
        pauseGeneration,
      );
    } catch (error) {
      if (error instanceof ManualReplyInterrupt) {
        lastTurn = event;
        log(`stopped reading "${event.label}" — you replied by text`);
        return;
      }
      throw error;
    } finally {
      recitingEvent = null;
    }
  }

  /**
   * Speak with the barge-in recorder armed: your voice (above speaker
   * bleed) kills playback mid-word. `cut` distinguishes "finished cleanly"
   * from "cancelled" — a cancellation with an empty transcript is a false
   * trigger (noise blip) and the caller should re-speak, not skip content.
   */
  async function speakInterruptible(
    event: TurnEvent,
    text: string,
    disabled: boolean,
    traceParent?: string,
    nextTraceSequence?: () => number,
    interrupted: () => boolean = () => false,
  ): Promise<{
    heard: string;
    cut: boolean;
    diagnosticId?: string;
    diagnosticIds?: string[];
    initialCapture?: RecorderHandle;
    captureParent?: string;
  }> {
    if (interrupted()) return { heard: "", cut: true };
    setState("speaking", event.label);
    if (!cfg.bargeThresholdPct || disabled) {
      const playback = speech.speakCancellable(cfg, text, event.label);
      await watchManualReplyDuringSpeech(
        event,
        playback,
        () => cfg.interruptOnManualReply,
      );
      return { heard: "", cut: false };
    }
    // Finish any canary already admitted while the mic was closed, then enter
    // the manager's audio FIFO. Its actual-start gate checks this precondition
    // again before the intentional high-threshold barge recorder is armed.
    await speech.quiescent();
    if (stopKey || interrupted()) return { heard: "", cut: true };
    assertNormalMicClosed("barge-in TTS");
    const result = await speech.runInterruptible(cfg, text, event.label, async (startSpeech) => {
      if (interrupted()) return { heard: "", cut: true };
      const barge = armBargeRecorder(cfg, traceParent, nextTraceSequence?.() ?? 1);
      const speechRun = startSpeech();
      let cut = false;
      let disposed = false;
      const watch = setInterval(() => {
        if (barge.triggered()) {
          cut = true;
          speechRun.cancel(); // your voice wins mid-sentence
        }
      }, 120);
      try {
        await watchManualReplyDuringSpeech(
          event,
          speechRun,
          () => cfg.interruptOnManualReply,
        );
        if (!barge.triggered()) {
          await barge.abort();
          disposed = true;
          return { heard: "", cut: false };
        }
        // This fresh barge capture becomes a new reducer session below. Clear
        // any completed turn's theater-only prefix before recording is visible.
        resetTheaterTranscriptPrefix();
        setState("recording", event.label);
        const initialCapture = barge.adopt();
        disposed = Boolean(initialCapture);
        // Keep the authoritative gate conservatively closed between adoption
        // and the controller's synchronous attached() handshake.
        bargeHandoffOpen = Boolean(initialCapture);
        return {
          heard: "",
          cut,
          ...(initialCapture ? { initialCapture } : {}),
          captureParent: barge.parent,
        };
      } finally {
        clearInterval(watch);
        if (!disposed) await barge.abort().catch(() => {});
      }
    });
    return result ?? { heard: "", cut: true };
  }

  /** Inject a prompt utterance and report how it went. */
  async function deliver(
    event: TurnEvent,
    text: string,
    diagnosticIds?: string | Iterable<string | undefined>,
    beforeInject?: () => boolean | Promise<boolean>,
  ): Promise<boolean> {
    const addressed = await resolveNameAddressRoute(cfg.claudeDir, event, text);
    if (addressed.addressed) {
      log(`addressed "${addressed.addressed.name}" -> "${addressed.addressed.label}"`);
    }
    if (addressed.kind === "wake") {
      if (beforeInject && !(await beforeInject())) return false;
      enqueue(addressed.event);
      return true;
    }
    event = addressed.event;
    text = addressed.text;

    return routeVoicePrompt(cfg.voiceQa, text, event.transcriptPath, {
      askClaude,
      speak: (answer) => speak(cfg, answer, event.label),
      inject: (prompt) => deliverToSession(
        event,
        prompt,
        diagnosticIds,
        beforeInject,
      ),
      ...(beforeInject ? { canContinue: beforeInject } : {}),
    });
  }

  /** The original session delivery path, reached only after local voice routing. */
  async function deliverToSession(
    event: TurnEvent,
    text: string,
    diagnosticIds?: string | Iterable<string | undefined>,
    beforeInject?: () => boolean | Promise<boolean>,
  ): Promise<boolean> {
    let committed = false;
    const commit = async (): Promise<boolean> => {
      if (beforeInject && !(await beforeInject())) return false;
      if (committed) return true;
      committed = true;
      if (typeof diagnosticIds === "string") {
        emitRecorderTrace(diagnosticIds, { finalSubmittedPayload: text });
      } else if (diagnosticIds) {
        emitRecorderTraces(diagnosticIds, { finalSubmittedPayload: text });
      }
      markInjected(event.sessionId);
      // Record the utterance itself, not just the route — a mis-fire used to be
      // unrecoverable because only "injected via X" was logged, never the words.
      log(`heard → ${JSON.stringify(text)}`);
      return true;
    };
    // Reading-phase delivery has no live listen watcher; retain its established
    // annotation timing. Dictation commits inside injectText at the actual route.
    if (!beforeInject) await commit();

    // Baseline the target session's user-prompt count so we can CONFIRM the
    // prompt actually submitted. null ⇒ no transcript to watch, skip confirmation.
    const beforeCount = event.transcriptPath ? await transcriptMark(event.transcriptPath) : null;
    const { via, interrupted } = await injectText(
      cfg,
      event.pid,
      text,
      beforeInject ? commit : undefined,
    );
    if (interrupted) return false;

    if (via === "clipboard") {
      log(`injected via ${via}`);
      if (beforeInject && !(await beforeInject())) return false;
      await speak(cfg, "Couldn't reach the session's window — your words are on the clipboard, just paste.", event.label);
      return true;
    }
    if (via === "none") {
      log(`injected via ${via}`);
      if (beforeInject && !(await beforeInject())) return false;
      await speak(cfg, "Heard you, but I could not find the session's pane.", event.label);
      return true;
    }
    if (beforeCount === null) {
      log(`injected via ${via}`); // no transcript to confirm against — trust it
      return true;
    }

    // The osascript path can type the text without the Return landing ("typed but
    // didn't send"). Watch the transcript for a NEW user prompt; if it doesn't
    // appear, re-press Return (the text is sitting in the input) a couple of times;
    // if it still won't take, drop the words on the clipboard so they survive.
    for (let attempt = 0; attempt < 3; attempt++) {
      await Bun.sleep(900 + attempt * 600); // give Claude Code time to write the prompt entry
      if (beforeInject && !(await beforeInject())) return false;
      if ((await transcriptMark(event.transcriptPath!)) > beforeCount) {
        log(`injected via ${via} — confirmed sent${attempt ? ` (after ${attempt} re-send${attempt > 1 ? "s" : ""})` : ""}`);
        return true;
      }
      if (attempt < 2) {
        log(`not confirmed yet — re-pressing Return (try ${attempt + 1})`);
        const retry = await injectKey(cfg, event.pid, "Enter", beforeInject ? commit : undefined);
        if (retry.interrupted) return false;
      }
    }
    if (beforeInject && !(await beforeInject())) return false;
    log(`⚠ inject via ${via} NOT confirmed — words placed on clipboard`);
    await toClipboard(text);
    if (beforeInject && !(await beforeInject())) return false;
    await speak(cfg, "I typed that but it didn't send. Your words are on the clipboard — just paste and press return.", event.label);
    return true;
  }

  /** Shared handling for anything heard while reading aloud (gap or barge-in). */
  async function onReadingUtterance(
    event: TurnEvent,
    text: string,
    spokenChunk: string,
    diagnosticId?: string,
    diagnosticIds?: string[],
    beforeInject?: () => boolean | Promise<boolean>,
  ): Promise<"stop" | "seed" | "handled" | "keep-reading" | "echo"> {
    const traceIds = diagnosticIds ?? [diagnosticId];
    const intent = classifyReadingGap(text);
    log(`heard mid-read: "${text}" -> ${intent}`);
    // Echo guard runs AFTER classification and ONLY for would-be prompts: a
    // command like "stop reading" naturally overlaps a message about reading,
    // and dismissing it as echo was exactly what broke stop (live). Commands
    // are always honored; only long injectable prose can be a real echo.
    if (intent === "prompt" && spokenChunk && wordOverlapRatio(text, spokenChunk) > 0.6) {
      log(`barge echo guard: mic heard the reading itself ("${text.slice(0, 60)}")`);
      emitRecorderTraces(traceIds, { intent: "echo", bufferCountAfterReduction: 0 });
      return "echo";
    }
    if (intent === "prompt" && text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length <= 3) {
      // a 1-3 word fragment mid-read ("I thought...") is someone starting
      // to talk, not a prompt — stop reading and hand them the mic instead
      // of injecting the fragment (observed live: killed the read AND sent junk)
      log("short mid-read fragment — pausing the reading to listen properly");
      for (const id of traceIds) updateRecorderTrace(id, { intent: "prompt", bufferCountAfterReduction: 1 });
      return "seed";
    }
    switch (intent) {
      case "stop":
        emitRecorderTraces(traceIds, { intent: "stop", bufferCountAfterReduction: 0 });
        return "stop";
      case "discard":
        emitRecorderTraces(traceIds, { intent: "discard", bufferCountAfterReduction: 0 });
        markInjected(event.sessionId); // "no response" also suppresses the follow-up needs-you nag
        await speak(cfg, "Okay.", event.label);
        return "handled";
      case "prompt":
        for (const id of traceIds) updateRecorderTrace(id, { intent: "prompt", bufferCountAfterReduction: 0 });
        await deliver(event, text, diagnosticIds ?? diagnosticId, beforeInject);
        return "handled";
      default:
        emitRecorderTraces(traceIds, { intent, bufferCountAfterReduction: 0 });
        return "keep-reading"; // repeat/continue: just keep going
    }
  }

  /** Commands (continue/repeat/cancel) keep the mic cycling; a real prompt injects; silence idles. */
  async function conversationLoop(
    event: TurnEvent,
    pendingHeard = "",
    pendingDiagnosticId?: string,
    pendingDiagnosticIds?: string[],
    announcedCapture?: RecorderHandle,
    announcedCaptureParent?: string,
    suppliedTraceParent?: string,
    suppliedNextTraceSequence?: () => number,
    autoTurn = false, // true only for the automatic turn-end path — the mic is gate-able; a wake is not
    pauseGeneration = pause.capture(),
  ): Promise<void> {
    const interruptedByPause = (): boolean => pause.interrupted(pauseGeneration);
    const reciteOnly = event.type === "recite";
    let lastSpoken = event.announce;
    let sentences: string[] | null = null;
    let cursor = 0; // derived from the actual announcement once the full reply is loaded
    // Recite is read-only: keyboard controls may still cancel it, but it never
    // arms a barge/gap recorder or transitions into a normal dictation session.
    let bargeOff = reciteOnly; // also set when the echo guard proves the threshold is too low for this room
    let falseTriggers = 0; // noise blips that cancelled speech but transcribed to nothing
    const seededSegments: Array<{
      text: string;
      diagnosticId?: string;
      diagnosticIds: string[];
    }> = [];
    // A wake just reopens the mic (per the README); it must NOT recite the last
    // message from the top — the user says "continue" if they want to hear it.
    let skipReading = startsConversationByListening(event, Boolean(announcedCapture)) || interruptedByPause();
    let initialDictationCapture = announcedCapture;
    let initialCaptureParent = announcedCaptureParent;
    let deferredInitialExternal: ExternalDictationAction | undefined;
    const traceParent = suppliedTraceParent ?? announcedCaptureParent ?? createRecorderParent("conversation");
    let localTraceSequence = 0;
    const nextTraceSequence = suppliedNextTraceSequence ?? (() => ++localTraceSequence);

    // A normal cancelled read has no recorder ownership to settle. An adopted
    // barge capture is the exception: attach it below, then abort the session.
    if (interruptedByPause() && !announcedCapture) return;

    const interruptReadForManualReply = (): Promise<void> => interruptForManualReply(
      event,
      () => cfg.interruptOnManualReply,
    );

    // Load + split the full message once, resuming after what the announcement
    // actually covered. Shared by the read-full phase and "continue".
    const ensureSentences = async (): Promise<string[]> => {
      if (!sentences) {
        sentences = splitSentences(stripMarkdown(await lastAssistantText(event.transcriptPath!)));
        cursor = autoTurn
          ? event.review ? sentences.length : countCoveredSentences(event.announce, sentences)
          : countCoveredSentences(event.announce, sentences);
        const text = sentences.join(" ");
        updateReadingProgress(text, sentences.slice(0, cursor).join(" ").length);
      }
      return sentences;
    };

    // Something said while the announcement was playing (announce barge-in)
    if (pendingHeard) {
      const action = await onReadingUtterance(
        event,
        pendingHeard,
        event.announce,
        pendingDiagnosticId,
        pendingDiagnosticIds,
        () => !interruptedByPause(),
      );
      if (interruptedByPause()) return;
      if (action === "handled") return;
      if (action === "stop") skipReading = true;
      if (action === "seed") {
        const diagnosticIds = (pendingDiagnosticIds ?? [pendingDiagnosticId])
          .filter((id): id is string => Boolean(id));
        const diagnosticId = pendingDiagnosticId ?? diagnosticIds[0];
        seededSegments.push({
          text: pendingHeard,
          ...(diagnosticId ? { diagnosticId } : {}),
          diagnosticIds,
        });
        skipReading = true;
      }
      if (action === "echo") bargeOff = true;
    }

    // Read-full phase: keep speaking chunks. You can interject two ways:
    // in the short gap between chunks, or by BARGING IN while it speaks —
    // a high-threshold recorder runs during playback and kills the speech
    // the moment your voice (louder than speaker bleed) starts.
    if (consumeStopKey()) {
      skipReading = true; // spacebar during the announcement
      if (initialDictationCapture) deferredInitialExternal = "spacebar";
    }

    if (
      !skipReading
      && (cfg.readFull || reciteOnly)
      && event.type !== "needs-you"
      && event.transcriptPath
    ) {
      sentences = await ensureSentences();
      if (interruptedByPause()) return;
      reading: while (cursor < sentences.length) {
        if (interruptedByPause()) return;
        await interruptReadForManualReply();
        if (interruptedByPause()) return;
        // gap between chunks: with barging available it's just a beat; with
        // barging off (echo/noise) it's the only voice interrupt, so keep it real
        const gapSecs = reciteOnly
          ? 0
          : bargeOff ? Math.max(cfg.gapSecs, 0.6) : cfg.gapSecs;
        if (gapSecs > 0) {
          // A read gap precedes the conversation reducer/hooks, so it must not
          // briefly expose the previous completed turn's transcript prefix.
          resetTheaterTranscriptPrefix();
          setState("listening", event.label);
          let gapExternal: ExternalDictationAction | undefined;
          let resolveGapDone!: () => void;
          const gapDone = new Promise<void>((resolve) => {
            resolveGapDone = resolve;
          });
          let gapActive: typeof activeDictation = null;
          let gapResult!: Awaited<ReturnType<typeof listenGap>>;
          try {
            if (!(await reserveNormalMic())) break reading;
            if (interruptedByPause()) {
              normalMicReserved = false;
              return;
            }
            if (stopKey) {
              deferredInitialExternal = "spacebar";
              normalMicReserved = false;
              break reading;
            }
            // Conservative before listenGap synchronously starts its controller;
            // onSessionStarted replaces this flag with the concrete session.
            micOpen = true;
            normalMicReserved = false;
            gapResult = await listenGap(cfg, gapSecs, {
              parent: traceParent,
              traceSequence: nextTraceSequence,
              onSessionStarted(gapSession) {
                let closing = false;
                gapActive = {
                  session: gapSession,
                  requestExternal(action, barrierReason) {
                    gapExternal ??= action;
                    if (closing || gapSession.state !== "running") return;
                    closing = true;
                    gapSession.requestBarrier(barrierReason ?? `gap-${action}`);
                  },
                  done: gapDone,
                };
                activeDictation = gapActive;
                micOpen = true;
              },
            });
          } finally {
            normalMicReserved = false;
            if (activeDictation === gapActive) activeDictation = null;
            micOpen = false;
            resolveGapDone();
          }
          if (interruptedByPause()) {
            emitRecorderTraces(
              gapResult.diagnosticIds ?? [gapResult.diagnosticId],
              { intent: "pause", bufferCountAfterReduction: 0 },
            );
            return;
          }
          const {
            text: gapText,
            error: gapError,
            diagnosticId: gapDiagnosticId,
            diagnosticIds: gapDiagnosticIds,
          } = gapResult;
          const stoppedByKey = consumeStopKey();
          const external = gapExternal ?? (stoppedByKey ? "spacebar" : undefined);
          if (external) {
            const diagnosticIds = (gapDiagnosticIds ?? [gapDiagnosticId])
              .filter((id): id is string => Boolean(id));
            if (gapText) {
              for (const id of diagnosticIds) {
                updateRecorderTrace(id, { intent: "prompt", bufferCountAfterReduction: 1 });
              }
              const diagnosticId = gapDiagnosticId ?? diagnosticIds[0];
              seededSegments.push({
                text: gapText,
                ...(diagnosticId ? { diagnosticId } : {}),
                diagnosticIds,
              });
            } else {
              emitRecorderTraces(diagnosticIds, {
                intent: `gap-${external}`,
                bufferCountAfterReduction: 0,
              });
            }
            deferredInitialExternal = external;
            break reading; // spacebar during the gap
          }
          if (gapError) {
            emitRecorderTraces(gapDiagnosticIds ?? [gapDiagnosticId], { intent: "transcription-error", bufferCountAfterReduction: 0 });
          } else if (gapText) {
            const action = await onReadingUtterance(
              event,
              gapText,
              "",
              gapDiagnosticId,
              gapDiagnosticIds,
              () => !interruptedByPause(),
            );
            if (interruptedByPause()) return;
            if (action === "stop") break reading;
            if (action === "seed") {
              const diagnosticIds = (gapDiagnosticIds ?? [gapDiagnosticId])
                .filter((id): id is string => Boolean(id));
              const diagnosticId = gapDiagnosticId ?? diagnosticIds[0];
              seededSegments.push({
                text: gapText,
                ...(diagnosticId ? { diagnosticId } : {}),
                diagnosticIds,
              });
              break reading;
            }
            if (action === "handled") return;
          } else {
            emitRecorderTraces(gapDiagnosticIds ?? [gapDiagnosticId], { intent: "gap-empty", bufferCountAfterReduction: 0 });
          }
        }
        await interruptReadForManualReply();
        if (interruptedByPause()) return;
        const chunk = sentences.slice(cursor, cursor + cfg.continueSentences).join(" ");
        lastSpoken = chunk;
        const result = await speakInterruptible(
          event,
          chunk,
          bargeOff,
          traceParent,
          nextTraceSequence,
          interruptedByPause,
        );
        if (shuttingDown) return;
        // The cursor advances ONLY when a chunk is spoken in full (below). Every
        // early exit here leaves it at this chunk's start, so a "stop" followed
        // by "continue" re-reads this chunk rather than skipping ahead.
        if (result.initialCapture) {
          initialDictationCapture = result.initialCapture;
          initialCaptureParent = result.captureParent;
          // The capture has already been adopted, so it must enter the
          // controller even when the same keypress also cancelled playback.
          if (consumeStopKey()) deferredInitialExternal = "spacebar";
          break reading;
        }
        if (interruptedByPause()) return;
        if (consumeStopKey()) {
          emitRecorderTrace(result.diagnosticId, { intent: "spacebar", bufferCountAfterReduction: 0 });
          break reading; // spacebar: guaranteed stop
        }
        if (result.cut && !result.heard) {
          // false trigger: re-speak the same chunk (cursor unmoved);
          // a second blip in one read means the room is noisy, gaps only
          falseTriggers++;
          if (falseTriggers >= 2) {
            bargeOff = true;
            log("two noise blips cancelled speech — barge-in off for this read");
          }
          continue;
        }
        if (!result.heard) {
          cursor += cfg.continueSentences; // spoken in full — advance to the next chunk
          updateReadingProgress(
            sentences.join(" "),
            sentences.slice(0, Math.min(cursor, sentences.length)).join(" ").length,
          );
          continue;
        }
        const action = await onReadingUtterance(
          event,
          result.heard,
          chunk,
          result.diagnosticId,
          result.diagnosticIds,
          () => !interruptedByPause(),
        );
        if (interruptedByPause()) return;
        if (action === "stop") break reading;
        if (action === "seed") {
          seededSegments.push({
            text: result.heard,
            ...(result.diagnosticId ? { diagnosticId: result.diagnosticId } : {}),
            diagnosticIds: (result.diagnosticIds ?? [result.diagnosticId])
              .filter((id): id is string => Boolean(id)),
          });
          break reading;
        }
        if (action === "handled") return;
        // interrupted for nothing (echo / keep-reading): re-speak the chunk,
        // with barging off for the rest of this read if it was echo
        if (action === "echo") bargeOff = true;
      }
    }

    if (reciteOnly) return;

    // A shutdown can complete an active read-gap barrier while this function is
    // awaiting it. Never open a fresh controller after shutdown took its
    // recorder/controller snapshot.
    if (shuttingDown) {
      emitRecorderTraces(
        seededSegments.flatMap((segment) => segment.diagnosticIds),
        { intent: "shutdown", bufferCountAfterReduction: null },
      );
      return;
    }
    if (interruptedByPause() && !initialDictationCapture) {
      emitRecorderTraces(
        seededSegments.flatMap((segment) => segment.diagnosticIds),
        { intent: "pause", bufferCountAfterReduction: 0 },
      );
      return;
    }

    // One controller spans the whole dictation exchange. SoX keeps producing
    // ordered paths while the single worker transcribes older paths; only the
    // reducer mutates held text or authorizes a cue/TTS/injection at a barrier.
    const reducer = new DictationReducer({ holdSubmit: cfg.holdSubmit });
    const session = createDictationSession(cfg, listenHooks(
      event.label,
      theaterMode
        ? () => reducer.snapshot.buffer.map((segment) => segment.text).join(" ")
        : undefined,
    ), {
      parent: traceParent ?? initialCaptureParent,
      traceSequence: nextTraceSequence,
    });
    const barrierRequests = new Map<number, number>();
    let timeoutRequestId: number | undefined;
    let reductionSequence = 0;
    let terminal = false;
    let deferredExternal: ExternalDictationAction | undefined;
    let deferredExternalBarrierReason: string | undefined;
    let awaitingInitialBarge = Boolean(initialDictationCapture);
    let emptyBargeBarrierId: number | undefined;
    const pendingTimeoutDiagnosticIds: string[] = [];
    const seedDiagnosticGroups = new Map<string, string[]>();
    let resolveDictationDone!: () => void;
    const dictationDone = new Promise<void>((resolve) => {
      resolveDictationDone = resolve;
    });
    let manualReplyEvent!: Pick<TurnEvent, "transcriptPath" | "mark">;
    let manualReplyGuard: ManualReplyListenGuard | null = null;
    let manualReplyWatch: Promise<void> | null = null;
    let manualReplyWatchError: unknown;
    const interruptedByManualReply = (): boolean => manualReplyGuard?.interrupted === true;

    const applyEffects = (
      effects: DictationReducerEffect[],
      options: { timeoutOwnsBarrier?: boolean } = {},
    ): DictationActionReadyEffect | undefined => {
      let ready: DictationActionReadyEffect | undefined;
      for (const effect of effects) {
        if (effect.type === "trace") {
          const tracePatch = {
            intent: effect.intent,
            bufferCountAfterReduction: effect.bufferCountAfterReduction,
          };
          for (const diagnosticId of expandDiagnosticIds([effect.diagnosticId])) {
            if (effect.intent === "empty-transcript") emitRecorderTrace(diagnosticId, tracePatch);
            else updateRecorderTrace(diagnosticId, tracePatch);
          }
        } else if (effect.type === "request-barrier") {
          if (options.timeoutOwnsBarrier) {
            timeoutRequestId = effect.requestId;
          } else {
            const ticket = session.requestBarrier(effect.reason);
            barrierRequests.set(ticket.id, effect.requestId);
          }
        } else if (effect.type === "action-ready") {
          ready = effect;
        }
      }
      return ready;
    };

    const beginExternalAction = (action: ExternalDictationAction, barrierReason?: string): void => {
      const effects = reducer.requestExternalAction(action);
      if (!effects.length) {
        deferredExternal ??= action;
        deferredExternalBarrierReason ??= barrierReason;
        return;
      }
      if (barrierReason) {
        for (const effect of effects) {
          if (effect.type === "request-barrier") effect.reason = barrierReason;
        }
      }
      applyEffects(effects);
    };

    const requestExternal = (action: ExternalDictationAction, barrierReason?: string): void => {
      // An idle session here means executeAction is speaking. Queue the stop;
      // the event loop will create its FIFO barrier after playback completes.
      if (session.state !== "running" || reducer.snapshot.pendingAction) {
        deferredExternal ??= action;
        deferredExternalBarrierReason ??= barrierReason;
        return;
      }
      beginExternalAction(action, barrierReason);
    };
    let attachedInitialCapture = false;
    if (initialDictationCapture) {
      // Ownership was transferred out of the barge helper already. Attach and
      // establish controller ownership synchronously before any transcript or
      // audio-gate await can leave this adopted SoX process hot.
      micOpen = true;
      try {
        session.start(initialDictationCapture);
        attachedInitialCapture = true;
        bargeHandoffOpen = false;
      } catch (error) {
        micOpen = false;
        void Promise.resolve(killActiveRecorders()).catch(() => {});
        bargeHandoffOpen = false;
        throw error;
      }
      activeDictation = { session, requestExternal, done: dictationDone };
      if (interruptedByPause()) {
        void session.abort().catch((error) => log(`pause interrupt cleanup failed: ${error}`));
      }
    }
    manualReplyEvent = interruptedByPause()
      ? { transcriptPath: event.transcriptPath, mark: event.mark }
      : await manualReplyListenBaseline(event);
    if (interruptedByPause() && !initialDictationCapture) return;

    const expandDiagnosticIds = (ids: Iterable<string>): string[] => {
      const expanded: string[] = [];
      const seen = new Set<string>();
      for (const id of ids) {
        for (const grouped of seedDiagnosticGroups.get(id) ?? [id]) {
          if (!seen.has(grouped)) {
            seen.add(grouped);
            expanded.push(grouped);
          }
        }
      }
      return expanded;
    };

    const emitTerminalRows = (action: DictationActionReadyEffect): void => {
      emitRecorderTraces(expandDiagnosticIds(action.actionDiagnosticIds));
      emitRecorderTraces(expandDiagnosticIds(action.discardedDiagnosticIds));
    };

    const executeAction = async (
      action: DictationActionReadyEffect,
    ): Promise<"resume" | "done" | "manual-reply"> => {
      if (shuttingDown || interruptedByPause()) {
        emitRecorderTraces(expandDiagnosticIds([
          ...action.payloadDiagnosticIds,
          ...action.actionDiagnosticIds,
          ...action.discardedDiagnosticIds,
        ]), interruptedByPause() ? { intent: "pause", bufferCountAfterReduction: 0 } : {});
        return "done";
      }
      switch (action.action) {
        case "send":
        case "timeout":
        case "spacebar": {
          if (action.payload) {
            await micCue(cfg, "sent");
            if (interruptedByPause()) return "done";
            const delivered = await deliver(
              event,
              action.payload,
              expandDiagnosticIds(action.finalSubmittedDiagnosticIds),
              async () => {
                if (interruptedByPause()) return false;
                if (manualReplyGuard && !(await manualReplyGuard.closeBeforeSubmit())) return false;
                return !interruptedByPause();
              },
            );
            if (!delivered) return interruptedByPause() ? "done" : "manual-reply";
          } else {
            emitTerminalRows(action);
            await micCue(cfg, "close");
          }
          if (action.action === "spacebar") consumeStopKey();
          return "done";
        }
        case "discard": {
          emitTerminalRows(action);
          markInjected(event.sessionId);
          await speak(cfg, "Okay.", event.label);
          if (interruptedByPause()) return "done";
          return action.shouldResume ? "resume" : "done";
        }
        case "repeat":
          emitTerminalRows(action);
          setState("speaking", event.label);
          await speak(cfg, lastSpoken, event.label);
          if (interruptedByPause()) return "done";
          return "resume";
        case "continue": {
          emitTerminalRows(action);
          if (!event.transcriptPath) {
            await speak(cfg, "I don't have the full message for this one.", event.label);
            if (interruptedByPause()) return "done";
            return "resume";
          }
          const full = await ensureSentences();
          if (interruptedByPause()) return "done";
          const chunk = full.slice(cursor, cursor + cfg.continueSentences).join(" ");
          if (!chunk) {
            await speak(cfg, "That's the whole message.", event.label);
            if (interruptedByPause()) return "done";
            return "resume";
          }
          lastSpoken = chunk;
          setState("speaking", event.label);
          await speak(cfg, chunk, event.label);
          if (interruptedByPause()) return "done";
          cursor += cfg.continueSentences;
          updateReadingProgress(
            full.join(" "),
            full.slice(0, Math.min(cursor, full.length)).join(" ").length,
          );
          return "resume";
        }
      }
    };

    // Mic gate (auto turns only): the bell + read already happened — you got the
    // heads-up. Now, only open the mic if you're NOT handling this by keyboard.
    // Skip it when you're actively typing (idle < grace) OR you already sent a text
    // reply to this session (userRespondedSince). A wake is explicit and never gated.
    if (autoTurn && !initialDictationCapture && !deferredInitialExternal) {
      const idle = cfg.typingGraceSecs > 0 ? await idleSeconds() : null;
      if (interruptedByPause()) return;
      const activelyTyping = idle !== null && idle < cfg.typingGraceSecs;
      const responded = activelyTyping ? false : await userRespondedSince(event.transcriptPath, event.mark);
      if (interruptedByPause()) return;
      const gone = sessionGoneFromSnapshot(
        await registrySnapshot(cfg.claudeDir),
        event.sessionId,
      );
      if (interruptedByPause()) return;
      if (activelyTyping || responded || gone) {
        emitRecorderTraces(
          seededSegments.flatMap((segment) => segment.diagnosticIds),
          { intent: "text-handled", bufferCountAfterReduction: null },
        );
        if (gone) return log(`mic held — "${event.label}" closed`);
        return log(activelyTyping
          ? `mic held — you're typing (space or \`conch wake\` to talk to "${event.label}")`
          : `mic held — you replied to "${event.label}" by text`);
      }
    }

    if (!initialDictationCapture && !deferredInitialExternal) {
      await micCue(cfg, "open");
      if (shuttingDown || interruptedByPause()) {
        emitRecorderTraces(
          seededSegments.flatMap((segment) => segment.diagnosticIds),
          {
            intent: interruptedByPause() ? "pause" : "shutdown",
            bufferCountAfterReduction: interruptedByPause() ? 0 : null,
          },
        );
        return;
      }
    }
    const initialWindow = seededSegments.length ? cfg.holdSubmitSecs : cfg.listenWindowSecs;
    log(`listening (start within ${initialWindow}s)${seededSegments.length ? " · holding" : ""}...`);
    if (shuttingDown || (interruptedByPause() && !initialDictationCapture)) return;
    let needsCapture = attachedInitialCapture || Boolean(initialDictationCapture)
      || (!deferredInitialExternal && !interruptedByPause());
    if (needsCapture && !attachedInitialCapture) {
      if (!(await reserveNormalMic())) return;
      if (interruptedByPause() && !initialDictationCapture) {
        normalMicReserved = false;
        return;
      }
      if (stopKey) {
        deferredInitialExternal ??= "spacebar";
        needsCapture = Boolean(initialDictationCapture); // an adopted barge must still attach, then drain
      }
      if (needsCapture) {
        micOpen = true;
        try {
          session.start(initialDictationCapture);
          bargeHandoffOpen = false;
        } catch (error) {
          micOpen = false;
          await Promise.resolve(killActiveRecorders()).catch(() => {});
          bargeHandoffOpen = false;
          throw error;
        } finally {
          normalMicReserved = false;
        }
      } else {
        normalMicReserved = false;
      }
    }
    activeDictation = { session, requestExternal, done: dictationDone };
    if (interruptedByPause() && session.state === "running") {
      void session.abort().catch((error) => log(`pause interrupt cleanup failed: ${error}`));
    } else if (session.state === "running") {
      manualReplyGuard = createManualReplyListenGuard(
        manualReplyEvent,
        session,
        dictationDone,
        () => cfg.interruptOnManualReply,
        () => {
          // Synchronous and before session.abort(): even a voice-submit barrier
          // already ahead in FIFO must not authorize an injection now.
          terminal = true;
        },
      );
      manualReplyWatch = manualReplyGuard.done.catch((error) => {
        manualReplyWatchError = error;
      });
    }

    // Establish controller ownership before reducing a seed. Non-hold mode can
    // request a terminal barrier immediately; after a drained gap external-stop,
    // the closed controller supplies that FIFO sentinel without reopening SoX.
    if (!interruptedByPause()) {
      for (const seed of seededSegments) {
        if (seed.diagnosticId) seedDiagnosticGroups.set(seed.diagnosticId, seed.diagnosticIds);
        applyEffects(reducer.consume({
          type: "transcript",
          sequence: ++reductionSequence,
          text: seed.text,
          ...(seed.diagnosticId ? { diagnosticId: seed.diagnosticId } : {}),
        }));
      }
      if (seededSegments.length) session.setIdleWindowSecs(cfg.holdSubmitSecs);
      if (deferredInitialExternal) {
        if (needsCapture) requestExternal(deferredInitialExternal);
        else beginExternalAction(deferredInitialExternal);
      }
    }

    try {
      while (!terminal) {
        const controllerEvent = await session.nextEvent();
        const pauseDisposition = pause.interceptDictationEvent(
          pauseGeneration,
          controllerEvent,
          session,
          (dropped) => {
            if (dropped.kind === "timeout") return;
            emitRecorderTrace(dropped.diagnosticId, {
              intent: "pause",
              bufferCountAfterReduction: 0,
            });
          },
        );
        if (pauseDisposition.intercepted) {
          terminal = pauseDisposition.terminal;
          continue;
        }
        if (interruptedByManualReply()) {
          if (controllerEvent.kind === "barrier") {
            session.acknowledge(controllerEvent);
          } else if (controllerEvent.kind !== "timeout") {
            emitRecorderTrace(controllerEvent.diagnosticId, {
              intent: "manual-reply",
              bufferCountAfterReduction: reducer.snapshot.buffer.length,
            });
          }
          continue;
        }
        let effects: DictationReducerEffect[] = [];

        if (controllerEvent.kind === "transcript") {
          const initialBargeResult = awaitingInitialBarge;
          awaitingInitialBarge = false;
          if (controllerEvent.cause === "timeout" && !controllerEvent.text) {
            if (controllerEvent.diagnosticId) pendingTimeoutDiagnosticIds.push(controllerEvent.diagnosticId);
            continue;
          }
          if (initialBargeResult && controllerEvent.text) {
            const readingIntent = classifyReadingGap(controllerEvent.text);
            const isEcho = readingIntent === "prompt"
              && lastSpoken
              && wordOverlapRatio(controllerEvent.text, lastSpoken) > 0.6;
            if (isEcho) {
              emitRecorderTrace(controllerEvent.diagnosticId, { intent: "echo", bufferCountAfterReduction: 0 });
              emptyBargeBarrierId = session.requestBarrier("barge-echo").id;
              continue;
            }
            if (readingIntent === "stop") {
              emitRecorderTrace(controllerEvent.diagnosticId, { intent: "stop", bufferCountAfterReduction: 0 });
              log(`heard mid-read: "${controllerEvent.text}" -> stop`);
              continue; // reading is already stopped; keep the continuous mic open
            }
          }
          effects = reducer.consume({
            type: "transcript",
            sequence: ++reductionSequence,
            text: controllerEvent.text,
            ...(controllerEvent.diagnosticId ? { diagnosticId: controllerEvent.diagnosticId } : {}),
          });
          const trace = effects.find((effect) => effect.type === "trace");
          if (trace?.type === "trace") {
            log(`heard: "${controllerEvent.text}" -> ${trace.intent}${reducer.snapshot.buffer.length ? " (holding)" : ""}`);
            if (trace.intent === "prompt") session.setIdleWindowSecs(cfg.holdSubmitSecs);
          }
          if (initialBargeResult && !controllerEvent.text) {
            emptyBargeBarrierId = session.requestBarrier("barge-empty").id;
          }
        } else if (controllerEvent.kind === "short") {
          if (controllerEvent.cause === "timeout" && controllerEvent.diagnosticId) {
            pendingTimeoutDiagnosticIds.push(controllerEvent.diagnosticId);
          } else {
            emitRecorderTrace(controllerEvent.diagnosticId, {
              intent: "false-start",
              bufferCountAfterReduction: reducer.snapshot.buffer.length,
            });
          }
          if (awaitingInitialBarge) {
            awaitingInitialBarge = false;
            emptyBargeBarrierId = session.requestBarrier("barge-empty").id;
          }
          continue;
        } else if (controllerEvent.kind === "timeout") {
          const diagnosticId = pendingTimeoutDiagnosticIds[0];
          if (diagnosticId) seedDiagnosticGroups.set(diagnosticId, [...pendingTimeoutDiagnosticIds]);
          effects = reducer.consume({
            type: "timeout",
            sequence: ++reductionSequence,
            ...(diagnosticId ? { diagnosticId } : {}),
          });
          pendingTimeoutDiagnosticIds.length = 0;
          applyEffects(effects, { timeoutOwnsBarrier: true });
          continue;
        } else if (controllerEvent.kind === "error") {
          emitRecorderTrace(controllerEvent.diagnosticId, {
            intent: `${controllerEvent.stage}-error`,
            bufferCountAfterReduction: reducer.snapshot.buffer.length,
          });
          log(`listen error: ${controllerEvent.error}`);
          if (!reducer.snapshot.pendingAction) {
            applyEffects(reducer.requestExternalAction("spacebar"));
          }
          continue;
        } else {
          const requestId = barrierRequests.get(controllerEvent.id)
            ?? (controllerEvent.reason === "timeout" ? timeoutRequestId : undefined);
          effects = reducer.consume({
            type: "barrier",
            sequence: ++reductionSequence,
            id: String(controllerEvent.id),
            reason: controllerEvent.reason,
            ...(requestId !== undefined ? { requestId } : {}),
          });
          session.acknowledge(controllerEvent);
          barrierRequests.delete(controllerEvent.id);
          if (controllerEvent.reason === "timeout") timeoutRequestId = undefined;
        }

        const action = applyEffects(effects);
        if (!action && controllerEvent.kind === "barrier" && controllerEvent.id === emptyBargeBarrierId) {
          emptyBargeBarrierId = undefined;
          micOpen = false;
          // A hot successor can reduce a real command before this older
          // echo/empty barrier. Its correlated barrier owns the next action;
          // never resume through it or the controller still has an unacked gate.
          if (reducer.snapshot.pendingAction) continue;

          // Real prompt-like tail also disproves the false trigger. Keep it in
          // the held buffer and resume silently instead of self-hearing a replay.
          if (!shuttingDown && reducer.snapshot.buffer.length === 0) {
            await speak(cfg, lastSpoken, event.label);
          }
          if (interruptedByPause()) {
            terminal = true;
            continue;
          }
          if (interruptedByManualReply()) continue;
          if (deferredExternal) {
            const external = deferredExternal;
            const barrierReason = deferredExternalBarrierReason;
            deferredExternal = undefined;
            deferredExternalBarrierReason = undefined;
            beginExternalAction(external, barrierReason);
          } else {
            if (!(await reserveNormalMic())) {
              terminal = true;
              continue;
            }
            if (interruptedByPause()) {
              normalMicReserved = false;
              terminal = true;
              continue;
            }
            if (interruptedByManualReply()) {
              normalMicReserved = false;
              continue;
            }
            if (deferredExternal) {
              const external = deferredExternal;
              const barrierReason = deferredExternalBarrierReason;
              deferredExternal = undefined;
              deferredExternalBarrierReason = undefined;
              normalMicReserved = false;
              beginExternalAction(external, barrierReason);
              continue;
            }
            if (interruptedByPause()) {
              normalMicReserved = false;
              terminal = true;
              continue;
            }
            micOpen = true;
            try {
              session.resume();
            } catch (error) {
              micOpen = false;
              throw error;
            } finally {
              normalMicReserved = false;
            }
            setState("listening", event.label);
          }
          continue;
        }
        if (!action && controllerEvent.kind === "barrier" && deferredExternal && session.state === "idle") {
          const external = deferredExternal;
          const barrierReason = deferredExternalBarrierReason;
          deferredExternal = undefined;
          deferredExternalBarrierReason = undefined;
          beginExternalAction(external, barrierReason);
          continue;
        }
        if (!action) continue;
        micOpen = false;
        if (interruptedByPause()) {
          terminal = true;
          continue;
        }
        if (!action.shouldResume && !action.payload && manualReplyGuard) {
          if (!(await manualReplyGuard.closeBeforeSubmit())) {
            emitRecorderTraces(expandDiagnosticIds([
              ...action.payloadDiagnosticIds,
              ...action.actionDiagnosticIds,
              ...action.discardedDiagnosticIds,
            ]), { intent: "manual-reply", bufferCountAfterReduction: 0 });
            continue;
          }
          if (interruptedByPause()) {
            terminal = true;
            continue;
          }
        }
        if (!action.shouldResume) activeDictation = null;
        let result: "resume" | "done" | "manual-reply";
        try {
          result = await executeAction(action);
        } catch (error) {
          // A cue/playback/injection failure must not strand rows after the
          // reducer has cleared its buffer. deliver() remains the only path
          // that annotates finalSubmittedPayload; this is disposition only.
          emitRecorderTraces(expandDiagnosticIds([
            ...action.payloadDiagnosticIds,
            ...action.actionDiagnosticIds,
            ...action.discardedDiagnosticIds,
          ]));
          throw error;
        }
        if (interruptedByPause()) {
          terminal = true;
          continue;
        }
        if (result === "manual-reply") {
          emitRecorderTraces(expandDiagnosticIds([
            ...action.payloadDiagnosticIds,
            ...action.actionDiagnosticIds,
            ...action.discardedDiagnosticIds,
          ]), { intent: "manual-reply", bufferCountAfterReduction: 0 });
        }
        if (result === "manual-reply" || interruptedByManualReply()) {
          terminal = true;
          continue;
        }
        if (result === "done") {
          terminal = true;
        } else {
          if (deferredExternal) {
            const external = deferredExternal;
            const barrierReason = deferredExternalBarrierReason;
            deferredExternal = undefined;
            deferredExternalBarrierReason = undefined;
            beginExternalAction(external, barrierReason);
            continue;
          }
          session.setIdleWindowSecs(cfg.holdSubmitSecs);
          if (!(await reserveNormalMic())) {
            terminal = true;
            continue;
          }
          if (interruptedByPause()) {
            normalMicReserved = false;
            terminal = true;
            continue;
          }
          if (interruptedByManualReply()) {
            normalMicReserved = false;
            terminal = true;
            continue;
          }
          if (deferredExternal) {
            const external = deferredExternal;
            const barrierReason = deferredExternalBarrierReason;
            deferredExternal = undefined;
            deferredExternalBarrierReason = undefined;
            normalMicReserved = false;
            beginExternalAction(external, barrierReason);
            continue;
          }
          if (interruptedByPause()) {
            normalMicReserved = false;
            terminal = true;
            continue;
          }
          micOpen = true;
          try {
            session.resume();
          } catch (error) {
            micOpen = false;
            throw error;
          } finally {
            normalMicReserved = false;
          }
          activeDictation = { session, requestExternal, done: dictationDone };
          setState("listening", event.label);
        }
      }
    } finally {
      if (session.state === "running" || session.state === "draining") {
        const ticket = session.requestBarrier("conversation-exit");
        let exitBarrierReached = false;
        const exitIntent = interruptedByPause()
          ? "pause"
          : interruptedByManualReply()
            ? "manual-reply"
            : "conversation-exit";
        while (true) {
          const pendingEvent = await session.nextEvent();
          if (pendingEvent.kind === "transcript") {
            emitRecorderTrace(pendingEvent.diagnosticId, {
              intent: exitIntent,
              bufferCountAfterReduction: reducer.snapshot.buffer.length,
            });
          } else if (pendingEvent.kind === "short") {
            emitRecorderTrace(pendingEvent.diagnosticId, {
              intent: interruptedByPause()
                ? "pause"
                : interruptedByManualReply()
                  ? "manual-reply"
                  : "conversation-exit-short",
              bufferCountAfterReduction: reducer.snapshot.buffer.length,
            });
          } else if (pendingEvent.kind === "error") {
            emitRecorderTrace(pendingEvent.diagnosticId, {
              intent: interruptedByPause()
                ? "pause"
                : interruptedByManualReply()
                  ? "manual-reply"
                  : `${pendingEvent.stage}-error`,
              bufferCountAfterReduction: reducer.snapshot.buffer.length,
            });
          } else if (pendingEvent.kind === "barrier") {
            session.acknowledge(pendingEvent);
            if (pendingEvent.id === ticket.id) exitBarrierReached = true;
            if (exitBarrierReached && session.state !== "draining") break;
          }
        }
        await ticket.done;
      }
      activeDictation = null;
      micOpen = false;
      bargeHandoffOpen = false;
      const pendingIds = expandDiagnosticIds(
        reducer.snapshot.buffer.flatMap((segment) => segment.diagnosticId ? [segment.diagnosticId] : []),
      );
      if (interruptedByPause()) {
        emitRecorderTraces(pendingIds, { intent: "pause", bufferCountAfterReduction: 0 });
      } else if (interruptedByManualReply()) {
        emitRecorderTraces(pendingIds, { intent: "manual-reply", bufferCountAfterReduction: 0 });
      } else {
        emitRecorderTraces(pendingIds);
      }
      resolveDictationDone();
    }
    if (manualReplyWatch) await manualReplyWatch;
    if (manualReplyWatchError && !(manualReplyWatchError instanceof ManualReplyInterrupt)) {
      throw manualReplyWatchError;
    }
    if (interruptedByManualReply() || manualReplyWatchError instanceof ManualReplyInterrupt) {
      log(`closed mic for "${event.label}" — you replied by text`);
    }
  }

  /** Permission/elicitation dialogs: "yes" -> Enter (highlighted option), "no" -> Escape. Free text is refused on purpose. */
  async function permissionLoop(event: TurnEvent): Promise<void> {
    const pauseGeneration = pause.capture();
    const interruptedByPause = (): boolean => pause.interrupted(pauseGeneration);
    if (shuttingDown) return;
    await micCue(cfg, "open");
    if (shuttingDown || interruptedByPause()) return;
    log("listening for yes or no...");
    const session = createDictationSession(
      cfg,
      listenHooks(event.label, theaterMode ? () => "" : undefined),
      { tag: "permission" },
    );
    const texts: string[] = [];
    const diagnosticIds: string[] = [];
    let closing = false;
    let externalReason: ExternalDictationAction | undefined;
    let listenError: string | undefined;
    let resolvePermissionDone!: () => void;
    const permissionDone = new Promise<void>((resolve) => {
      resolvePermissionDone = resolve;
    });

    const requestExternal = (action: ExternalDictationAction, barrierReason?: string): void => {
      externalReason ??= action;
      if (closing) return;
      closing = true;
      session.requestBarrier(barrierReason ?? `permission-${action}`);
    };

    if (shuttingDown) return;
    if (!(await reserveNormalMic())) return;
    if (interruptedByPause()) {
      normalMicReserved = false;
      return;
    }
    if (stopKey) {
      normalMicReserved = false;
      consumeStopKey();
      await micCue(cfg, "close");
      return log("⏹ spacebar — closed the permission mic");
    }
    micOpen = true;
    try {
      session.start();
    } catch (error) {
      micOpen = false;
      throw error;
    } finally {
      normalMicReserved = false;
    }
    activeDictation = { session, requestExternal, done: permissionDone };
    try {
      while (true) {
        const controllerEvent = await session.nextEvent();
        const pauseDisposition = pause.interceptDictationEvent(
          pauseGeneration,
          controllerEvent,
          session,
          (dropped) => {
            if (dropped.kind === "timeout") return;
            emitRecorderTrace(dropped.diagnosticId, {
              intent: "pause",
              bufferCountAfterReduction: 0,
            });
          },
        );
        if (pauseDisposition.intercepted) {
          if (pauseDisposition.terminal) break;
          continue;
        }
        if (controllerEvent.kind === "transcript") {
          if (controllerEvent.diagnosticId) diagnosticIds.push(controllerEvent.diagnosticId);
          if (controllerEvent.text) texts.push(controllerEvent.text);
          if (controllerEvent.text && !closing) {
            closing = true;
            session.requestBarrier("permission-decision");
          }
          continue;
        }
        if (controllerEvent.kind === "short") {
          emitRecorderTrace(controllerEvent.diagnosticId, {
            intent: controllerEvent.cause === "timeout" ? "permission-timeout" : "false-start",
            bufferCountAfterReduction: 0,
          });
          continue;
        }
        if (controllerEvent.kind === "timeout") {
          closing = true;
          continue;
        }
        if (controllerEvent.kind === "error") {
          listenError ??= controllerEvent.error;
          emitRecorderTrace(controllerEvent.diagnosticId, { intent: "permission-error", bufferCountAfterReduction: 0 });
          if (!closing) {
            closing = true;
            session.requestBarrier("permission-error");
          }
          continue;
        }
        session.acknowledge(controllerEvent);
        break;
      }
    } finally {
      if (session.state === "running" || session.state === "draining") {
        const ticket = session.requestBarrier("permission-exit");
        let exitBarrierReached = false;
        while (true) {
          const pendingEvent = await session.nextEvent();
          if (pendingEvent.kind === "transcript" && pendingEvent.diagnosticId) {
            diagnosticIds.push(pendingEvent.diagnosticId);
            if (pendingEvent.text) texts.push(pendingEvent.text);
          } else if (pendingEvent.kind === "short") {
            emitRecorderTrace(pendingEvent.diagnosticId, { intent: "permission-exit-short", bufferCountAfterReduction: 0 });
          } else if (pendingEvent.kind === "error") {
            emitRecorderTrace(pendingEvent.diagnosticId, { intent: "permission-error", bufferCountAfterReduction: 0 });
          } else if (pendingEvent.kind === "barrier") {
            session.acknowledge(pendingEvent);
            if (pendingEvent.id === ticket.id) exitBarrierReached = true;
            if (exitBarrierReached && session.state !== "draining") break;
          }
        }
        await ticket.done;
      }
      activeDictation = null;
      micOpen = false;
      resolvePermissionDone();
    }

    if (interruptedByPause()) {
      emitRecorderTraces(diagnosticIds, { intent: "pause", bufferCountAfterReduction: 0 });
      return;
    }
    if (externalReason) {
      emitRecorderTraces(diagnosticIds, { intent: `permission-${externalReason}`, bufferCountAfterReduction: 0 });
      if (externalReason === "spacebar") consumeStopKey();
      if (shuttingDown) return;
      await micCue(cfg, "close");
      return log("⏹ closed the permission mic");
    }
    if (listenError) {
      emitRecorderTraces(diagnosticIds, { intent: "permission-error", bufferCountAfterReduction: 0 });
      return log(`listen error: ${listenError}`);
    }
    if (!texts.length) {
      emitRecorderTraces(diagnosticIds, { intent: "permission-timeout", bufferCountAfterReduction: 0 });
      await micCue(cfg, "close");
      return log("no speech — back to idle");
    }
    const verdict = classifyPermissionDecision(texts);
    const heard = texts.join(" ");
    log(`heard: "${heard}" -> ${verdict ?? "unclear"}`);
    emitRecorderTraces(diagnosticIds, { intent: verdict ?? "permission-unclear", bufferCountAfterReduction: 0 });
    if (interruptedByPause()) return;
    if (!verdict) return void (await speak(cfg, "For permission prompts, say yes or no. Ignoring.", event.label));
    const { via, interrupted } = await injectKey(
      cfg,
      event.pid,
      verdict === "approve" ? "Enter" : "Escape",
      () => !interruptedByPause(),
    );
    if (interrupted || interruptedByPause()) return;
    if (via === "none") await speak(cfg, "Could not reach the session's window to answer — do it by hand.", event.label);
    else log(`sent ${verdict === "approve" ? "Enter" : "Escape"} via ${via}`);
  }

  const configController = createConfigController(cfg);
  if (theaterMode) {
    settingsOverlay = new SettingsOverlay({
      controller: configController,
      settingsPath: settingsPathFor(),
      persist: writeSetting,
      onOpen: () => settingsPause.open(),
      onClose: () => settingsPause.close(),
      onChange: () => void renderSessionPanel(),
    });
    sessionActionsOverlay = new SessionActionsOverlay({
      controller: {
        voiceCandidates: () => availableVoiceRing(cfg),
        effectiveVoice: (target) => voiceFor(cfg, target.label),
        previewVoice: (target, voice) => {
          speech.cancelCurrent();
          enqueue({
            type: "speak",
            sessionId: target.sessionId,
            label: "",
            announce: `${target.label} sounds like this.`,
            voice,
          });
        },
        setVoice: (target, voice) => {
          setVoiceOverride(target.label, voice);
          log(`voice pinned for "${target.label}" -> ${voice}`);
        },
        resetVoice: (target) => {
          clearVoiceOverride(target.label);
          log(`voice reset to auto for "${target.label}"`);
        },
        isPrioritized: (sessionId) => prioritizedSessionIds.has(sessionId),
        setPrioritized: (sessionId, prioritized) => {
          if (prioritized) prioritizedSessionIds.add(sessionId);
          else prioritizedSessionIds.delete(sessionId);
          log(`${prioritized ? "★ prioritized" : "normal hand-off for"} "${
            panelLabels.get(sessionId) ?? sessionId.slice(0, 8)
          }"`);
          void renderSessionPanel();
        },
        rename: (target, label) => {
          const renamed = renameSessionLabel(
            target.sessionId,
            target.label,
            label,
          );
          relabelRuntimeSession(target.sessionId, target.label, renamed.label);
          log(`renamed "${target.label}" -> "${renamed.label}"${
            renamed.voiceMigrated ? " (voice pin migrated)" : ""
          }`);
          void renderSessionPanel();
          return renamed.label;
        },
        dismiss: (target) => {
          // Hide before the mute helper repaints, so no intermediate
          // muted-but-visible row flashes behind the closing modal.
          dismissedSessionIds.add(target.sessionId);
          panelOrder = panelOrder.filter((sessionId) => sessionId !== target.sessionId);
          panelLabels.delete(target.sessionId);
          numberedSessionRows = numberSessionRows([...panelSessions.values()]);
          speech.cancelCurrent();
          for (let index = queue.length - 1; index >= 0; index--) {
            const queued = queue[index]!;
            if (queued.type === "speak" && queued.sessionId === target.sessionId) {
              queue.splice(index, 1);
            }
          }
          theaterNavigation.release();
          setSessionMutedWithDigest(target.sessionId, true);
          log(`dismissed "${target.label}" — announcements stopped; session keeps running`);
        },
      },
      onOpen: () => settingsPause.open(),
      onClose: () => settingsPause.close(),
      onChange: () => void renderSessionPanel(),
    });
  }
  const server = createServer({ allowHalfOpen: true }, (sock) => {
    let buf = "";
    let handled = false;
    sock.on("error", () => {}); // a hook killed mid-write (ECONNRESET) must not throw
    const handleLine = (line: string): void => {
      if (handled) return;
      handled = true;
      let response: ConfigControlResponse | undefined;
      try {
        const value: unknown = JSON.parse(line);
        const control = dispatchControlMessage(value, configController);
        if (control.handled) response = control.response;
        else enqueue(value as TurnEvent);
      } catch {
        log("ignoring malformed event");
      }
      if (response) sock.end(JSON.stringify(response) + "\n");
      else sock.end();
    };
    sock.on("data", (data) => {
      buf += data.toString();
      const newline = buf.indexOf("\n");
      if (newline !== -1) handleLine(buf.slice(0, newline));
    });
    sock.on("end", () => {
      if (!handled && buf.trim()) handleLine(buf.trim());
      else if (!handled) sock.end();
    });
  });

  server.on("error", (e) => log(`socket server error: ${e}`));

  let shutdownStarted = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    // Synchronous and first: no cancellation/cleanup failure may strand the
    // alternate screen or hidden cursor before either process.exit below.
    rendererLifecycle.restore();
    theaterNavigation.dispose();
    shuttingDown = true;
    queue.length = 0;
    speech.close(); // cancel and seal speech, cues, and in-flight/future canaries
    // Close the controller's rearm gate synchronously before taking the
    // recorder snapshot. No await is allowed before this request.
    const dictationAtShutdown = activeDictation;
    dictationAtShutdown?.requestExternal("spacebar", "shutdown");
    const recorderDrain = killActiveRecorders(); // a live sox capture would keep the mic hot after we die
    if (server.listening) server.close();
    whisperServerClient.cancelWarmRequests();
    whisperSupervisor?.close();
    ttsSupervisor?.close();
    try {
      unlinkSync(cfg.socketPath);
    } catch {}
    // KEEP_RAW diagnostics are exact opt-in. The default path stays lean and
    // exits after synchronous cancellation instead of waiting on transcription.
    if (!diagnosticsEnabled) process.exit(0);
    await speech.quiescent().catch(() => {});
    await Promise.allSettled([
      Promise.resolve(recorderDrain),
      dictationAtShutdown?.done ?? Promise.resolve(),
    ]);
    flushPendingRecorderTraces();
    process.exit(0);
  };
  // G8: the daemon owns its signal path before exposing the socket.
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGHUP", () => void shutdown());
  process.on("SIGQUIT", () => void shutdown());

  const ttsBinaryAvailable = Boolean(Bun.which(cfg.ttsServerBin));
  const ttsEnabled = cfg.ttsEngine !== "say" && Boolean(cfg.ttsPort) && ttsBinaryAvailable;
  if (!ttsBinaryAvailable && cfg.ttsEngine === "server") {
    log(`CONCH_TTS=server but ${cfg.ttsServerBin} not found (uv tool install "mlx-audio[server]") — voices via say`);
  }
  ttsSupervisor = new TtsSupervisor({
    enabled: ttsEnabled,
    probePresence: (signal) => probeTtsServerPresence(cfg, 1_500, signal),
    probeReady: (signal) => probeTtsServer(cfg, 30_000, signal, log),
    spawn: () => Bun.spawn([cfg.ttsServerBin, "--port", String(cfg.ttsPort)], {
      // Separate handles avoid independent offsets clobbering one log file.
      stdout: Bun.file("/tmp/conch-kokoro.log"),
      stderr: Bun.file("/tmp/conch-kokoro.err.log"),
    }),
    resetReadiness: resetTtsReadiness,
    exclusive: (task, outerSignal) => speech.runProbe((laneSignal) => {
      return task(AbortSignal.any([outerSignal, laneSignal]));
    }),
    log,
  });

  // Assign synchronously before listen: early hook events queue behind this
  // one full-body capability canary. Every later repair is fire-and-forget.
  ttsStartup = ttsSupervisor.start().then(() => {}).catch((error) => {
    if (!shuttingDown) log(`tts startup gate failed — voices via say: ${error}`);
  });

  const whisperBinaryAvailable = existsSync(cfg.whisperServerBin);
  whisperServerClient.resetHealth();
  whisperSupervisor = new ServerSupervisor<WhisperRecoveryReason>({
    enabled: Boolean(cfg.whisperPort),
    language: {
      service: "whisper-server",
      readiness: "transcription-ready",
      fallback: "using the cold cli",
    },
    probePresence: (signal) => whisperServerClient.probePresenceUnlocked(cfg, 1_500, signal),
    probeReady: (signal) => whisperServerClient.probeReadyUnlocked(cfg, 60_000, signal),
    spawn: () => {
      if (!existsSync(cfg.whisperServerBin)) {
        throw new Error(`binary not found at ${cfg.whisperServerBin}`);
      }
      return Bun.spawn(
        [
          cfg.whisperServerBin,
          "-m", cfg.whisperModel,
          "-vm", cfg.vadModel,
          "--vad",
          "--vad-speech-pad-ms", "300",
          "--host", "127.0.0.1",
          "--port", String(cfg.whisperPort),
          "-l", "en",
          "-t", "6",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
    },
    resetReadiness: () => whisperServerClient.resetHealth(),
    exclusive: (task, signal) => whisperServerClient.runExclusive(task, signal),
    log,
  });

  if (existsSync(cfg.socketPath)) unlinkSync(cfg.socketPath); // stale socket from a previous run
  server.listen(cfg.socketPath);
  log(`listening on ${cfg.socketPath} — wire hooks with \`conch install\``);
  if (muted) log("resuming muted (persisted) — m or `conch unmute` to turn on");
  if (pause.paused) log("resuming paused (persisted) — p or `conch resume` to turn on");
  rendererLifecycle.enter();
  setState(restState());
  void renderSessionPanel(); // show the dashboard immediately
  setKeybar(theaterMode ? THEATER_KEYBAR : FOOTER_KEYBAR);
  onLiveChange(() => void renderSessionPanel()); // repaint when speaking/recording/… flips
  process.stdout.on("resize", () => {
    resizeRenderer();
    void renderSessionPanel(); // refresh the model and re-fit to the new width
  });
  // Refresh periodically so killed sessions drop off even with no new events.
  const panelTimer = setInterval(() => void renderSessionPanel(), 20_000);
  panelTimer.unref?.();

  // Warm Whisper independently after the socket and signal path are live.
  // Startup/recovery never blocks dictation: finals use the cold CLI until the
  // full inference canary marks this client healthy.
  if (cfg.whisperPort && !whisperBinaryAvailable) {
    log(`whisper-server binary not found at ${cfg.whisperServerBin} — using the cold cli path`);
  }
  if (cfg.whisperPort) {
    void whisperSupervisor.start().catch((error) => {
      if (!shuttingDown) log(`whisper-server startup failed — using the cold cli: ${error}`);
    });
  }

  /** Live sessions in a stable order so number keys mean the same thing between glances. */
  function numberSessionRows(sessions: readonly SessionInfo[]): NumberedSessionRow[] {
    return sessions
      .filter((session) => !dismissedSessionIds.has(session.sessionId))
      .map((s) => ({ s, label: sessionLabel(s, s.cwd) }))
      .sort((a, b) => a.label.localeCompare(b.label))
      .slice(0, 9)
      .map((x, i) => ({ n: i + 1, ...x }));
  }

  async function numberedSessions(): Promise<NumberedSessionRow[]> {
    return numberSessionRows(await listSessions(cfg.claudeDir));
  }

  async function printSessions(): Promise<void> {
    const rows = await numberedSessions();
    numberedSessionRows = rows;
    if (!rows.length) return log("no live sessions");
    logAbove(rows.map((r) => `  \x1b[36m${r.n}\x1b[0m ${r.label}${lastTurn?.sessionId === r.s.sessionId ? " \x1b[2m(space wakes this one)\x1b[0m" : ""}`).join("\n"));
  }

  /** Audition every live session in its assigned voice — `conch voice <session> <voice>` reassigns. */
  async function auditionVoices(): Promise<void> {
    if (busy) return log("busy — audition after the current exchange");
    if (muted || pause.paused) return log("quiet mode — unmute/resume before auditioning voices");
    busy = true;
    const controlGeneration = pause.capture();
    try {
      const rows = await numberedSessions();
      if (pause.interrupted(controlGeneration) || muted || pause.paused) return;
      if (!rows.length) return log("no live sessions");
      for (const r of rows) {
        if (pause.interrupted(controlGeneration) || muted || pause.paused) break;
        logAbove(`  \x1b[36m${r.n}\x1b[0m ${r.label} — \x1b[35m${voiceFor(cfg, r.label)}\x1b[0m`);
        await speak(cfg, `${r.label} sounds like this.`, r.label);
        if (pause.interrupted(controlGeneration) || muted || pause.paused) break;
      }
      if (!pause.interrupted(controlGeneration) && !muted && !pause.paused) {
        logAbove('  \x1b[2mreassign: conch voice <session> <kokoro-voice>\x1b[0m');
      }
    } finally {
      busy = false;
      setState(restState());
      void drain();
    }
  }

  function wakeByNumber(n: number): void {
    const row = numberedSessionRows.find(
      (candidate) => candidate.n === n && !dismissedSessionIds.has(candidate.s.sessionId),
    );
    if (!row) return log(`no session #${n} — press s to list`);
    instantControls.enqueueInstant({
      type: "wake",
      sessionId: row.s.sessionId,
      label: row.label,
      cwd: row.s.cwd,
      pid: row.s.pid,
      announce: "",
      transcriptPath: findTranscript(cfg.claudeDir, row.s.sessionId),
    });
  }

  /** Open the mic for a specific session by id (space on the parked cursor). */
  function wakeBySessionId(id: string): void {
    const s = panelSessions.get(id);
    if (!s) return log("that session is gone — press s to list");
    const label = sessionLabel(s, s.cwd);
    log(`▸ talking to ${label}`);
    enqueue({
      type: "wake",
      sessionId: s.sessionId,
      label,
      cwd: s.cwd,
      pid: s.pid,
      announce: "",
      transcriptPath: findTranscript(cfg.claudeDir, s.sessionId),
    });
  }

  /** Read a target session's latest assistant output from sentence zero. */
  function reciteBySessionId(id: string | null): void {
    if (!id) return log("nothing to recite — no session is parked or active");
    const known = latestTurnBySession.get(id)
      ?? (recitingEvent?.sessionId === id ? recitingEvent : null)
      ?? (lastTurn?.sessionId === id ? lastTurn : null);
    const session = panelSessions.get(id);
    const label = panelLabels.get(id)
      ?? sessionStates.get(id)?.label
      ?? known?.label
      ?? sessionLabel(session ?? null, session?.cwd);
    const transcriptPath = known?.transcriptPath ?? findTranscript(cfg.claudeDir, id);
    if (!transcriptPath) return log(`nothing to recite for "${label}" — transcript not found`);
    instantControls.enqueueInstant({
      ...known,
      type: "recite",
      sessionId: id,
      label,
      cwd: session?.cwd ?? known?.cwd,
      pid: session?.pid ?? known?.pid,
      announce: "",
      transcriptPath,
      mark: undefined,
    });
  }

  /** Move the panel selection by delta; off either end releases the cursor to auto. */
  function moveSelection(delta: number): void {
    if (!panelOrder.length) return;
    if (theaterMode) {
      theaterNavigation.move(
        panelOrder,
        delta < 0 ? -1 : 1,
        lastTurn?.sessionId ?? null,
      );
      return;
    }
    // From no cursor: ↓ enters at the top, ↑ enters at the bottom.
    const cur = selectedId ? panelOrder.indexOf(selectedId) : (delta > 0 ? -1 : panelOrder.length);
    const next = cur + delta;
    if (next < 0 || next >= panelOrder.length) {
      cursorAuto = true; // off the end → back to auto-follow (no manual selection)
      selectedId = null;
    } else {
      cursorAuto = false; // took manual control
      selectedId = panelOrder[next]!;
    }
    void renderSessionPanel();
  }

  function theaterActionTarget(): string | null {
    const target = theaterNavigation.actionTarget(lastTurn?.sessionId ?? null);
    return target && !dismissedSessionIds.has(target) ? target : null;
  }

  // Space remains the guaranteed stop while reciting or mid-exchange. Unlike
  // mode controls, it intentionally drains/submits every already-captured tail.
  const stopReciting = (src: string) => {
    stopKey = true;
    speech.cancelCurrent();
    speech.cancelPendingAudio();
    // Space remains the guaranteed stop even when an instant takeover is
    // queued behind the old exchange's deliberately un-killed Whisper job.
    markQueuedWakesForControl(queue, forgetQueuedAudioCommand);
    activeDictation?.requestExternal("spacebar");
    log(activeDictation?.session.micOpen || micOpen ? `⏹ ${src} — closing mic` : `⏹ ${src} — stopped`);
  };

  const theaterControls: TheaterControlCallbacks = {
    manualSessionId: () => theaterMode
      ? theaterNavigation.manualControlTarget()
      : cursorAuto ? null : selectedId,
    globalPaused: () => pause.paused,
    globalMuted: () => muted,
    sessionPaused: (id) => pausedSessionIds.has(id),
    sessionMuted: (id) => mutedSessionIds.has(id),
    setGlobalPaused: (next) => enqueue({
      type: next ? "pause" : "resume",
      sessionId: "",
      label: "",
      announce: "",
    }),
    setGlobalMuted: (next) => enqueue({
      type: next ? "mute" : "unmute",
      sessionId: "",
      label: "",
      announce: "",
    }),
    setSessionPaused: setSessionPausedWithDigest,
    setSessionMuted: setSessionMutedWithDigest,
  };

  // Interactive keys when running in a terminal.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (d) => {
      const { events, rest } = mouseParser.feed(d.toString());
      if (
        theaterMode
        && !settingsOverlay?.isOpen()
        && !sessionActionsOverlay?.isOpen()
      ) {
        let wheel = 0;
        for (const event of events) {
          if (event.kind === "wheel") wheel += event.delta;
          else theaterPointerEvent(event);
        }
        if (wheel) scrollTheaterPane(wheel * 3);
      }
      if (!rest) return;
      // Ctrl-C is terminal-safety critical. Even malformed mouse-looking
      // residue must not make an adjacent interrupt miss the equality router.
      const c = rest.includes("\u0003") ? "\u0003" : rest;
      // Modal routing owns every key first. Raw Ctrl-C is the one intentional
      // fallthrough so terminal-safe daemon shutdown can always run.
      if (settingsOverlay?.handleKey(c)) return;
      if (sessionActionsOverlay?.handleKey(c)) return;
      if (theaterMode && c === ",") {
        settingsOverlay?.open();
        return;
      }
      if (theaterMode && c === "\r") {
        const sessionId = theaterNavigation.manualControlTarget();
        if (sessionId) {
          sessionActionsOverlay?.open({
            sessionId,
            label: panelLabels.get(sessionId)
              ?? sessionStates.get(sessionId)?.label
              ?? sessionId.slice(0, 8),
          });
          return;
        }
      }
      if (c === " ") {
        if (busy) stopReciting("spacebar");
        else if (theaterMode && theaterActionTarget()) wakeBySessionId(theaterActionTarget()!);
        else if (selectedId) wakeBySessionId(selectedId); // talk to the selected session
        else enqueue({ type: "wake", sessionId: "", label: "", announce: "" }); // else the last-announced
      }
      // ↑/↓ move the panel cursor (normal `[` and application `O` escape forms).
      else if (c === "\x1b[A" || c === "\x1bOA") moveSelection(-1);
      else if (c === "\x1b[B" || c === "\x1bOB") moveSelection(1);
      else if (c === "\x1b") {
        if (theaterMode) {
          if (!clearTheaterSelection()) theaterNavigation.release();
        } else {
          cursorAuto = true;
          selectedId = null;
          void renderSessionPanel();
        }
      }
      else if (theaterMode && c === "\\") {
        panelOpen = !panelOpen;
        void renderSessionPanel();
      }
      else if (c >= "1" && c <= "9") wakeByNumber(Number(c));
      else if (c === "s") void printSessions();
      else if (c === "l") { const on = setLogsVisible(!logsShown()); log(on ? "logs on — press l to hide" : "logs off"); }
      else if (c === "v") void auditionVoices();
      else if (theaterMode && c === "r") reciteBySessionId(theaterActionTarget());
      else if (dispatchTheaterControlKey(c, theaterControls)) {}
      else if (c === "?" || c === "h") printHelp();
      else if (c === "q" || c === "\u0003") void shutdown();
    });
    printHelp();
  }
}

function printHelp(): void {
  logAbove(dashboardHelpText());
}

function log(msg: string): void {
  const t = new Date().toTimeString().slice(0, 8);
  logAbove(`[conch ${t}] ${msg}`);
}

/** Seconds since the user last touched keyboard or mouse (macOS HID idle time). */
/** Seconds since the last keyboard/mouse/trackpad event, or `null` if the HID probe
 *  couldn't be read — callers must fail SAFE (don't gate / don't auto-mute) on null. */
async function idleSeconds(): Promise<number | null> {
  try {
    const proc = Bun.spawn(["ioreg", "-c", "IOHIDSystem"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const m = out.match(/HIDIdleTime"?\s*=\s*(\d+)/);
    return m ? Number(m[1]) / 1e9 : null;
  } catch {
    return null;
  }
}

const CUE_SOUND = {
  open: "/System/Library/Sounds/Tink.aiff", // mic opened, start talking
  close: "/System/Library/Sounds/Bottle.aiff", // window closed on silence
  sent: "/System/Library/Sounds/Pop.aiff", // dictation submitted
};
