import {
  createControlServer,
  type DeviceCommand,
  type DeviceControlResponse,
  type ConfigController,
  type SessionCommandDispatchOptions,
  type RuntimeControlDispatchOptions,
  type SocketTurnEventCallbacks,
  enrichTargetedAudioCommand,
  dispatchSocketTurnEvent,
  applySessionCommand,
  applyRuntimeControlMessage,
  applyConfigControlMessage,
} from "./control-server.ts";
export {
  type ConfigController,
  type ConfigControlPersistence,
  type SocketControlDispatch,
  type SessionCommandPauseLifecycle,
  type SessionCommandDispatchOptions,
  dispatchSessionControlMessage,
  dispatchControlMessage,
  type RuntimeControlDispatchOptions,
  dispatchRuntimeControlMessage,
  type SocketTurnEventValidation,
  type PublishedInjectScope,
  scopePublishedInjectEvent,
  validateSocketTurnEvent,
  validateAndScopeSocketTurnEvent,
  type TargetedAudioCommandContext,
  enrichTargetedAudioCommand,
  type SocketTurnEventCallbacks,
  isLightweightTargetedAudioCommand,
  dispatchSocketTurnEvent,
  anotherDaemonIsListening,
} from "./control-server.ts";
import {
  createVoiceLoop,
  lastReplyFor,
  shouldHandleTurnAudibly,
  type AudioSink,
} from "./voice-loop.ts";
export {
  type AudioSink,
  type NameAddressRoute,
  type NameAddressRouteOptions,
  choiceReplyForConversation,
  downgradeTurnWithLiveBackgroundWork,
  listenHooks,
  reserveNormalMicForSink,
  resolveNameAddressRoute,
  resolveWakeTarget,
  shouldHandleTurnAudibly,
  startsConversationByListening,
} from "./voice-loop.ts";
import { appendFileSync } from "node:fs";
import { currentTurnText } from "./transcript-turn.ts";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadDeviceId } from "./device-identity.ts";
import { clearIdentity, writeIdentity } from "./daemon-identity.ts";
import {
  AudioHolder,
  AudioOutbox,
  PresentedItems,
  speechAllowedHere,
  type AudioControl,
  type AudioOutboxItem,
} from "./audio-holder.ts";
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
import { reapOrphanedWhisper, recordSpawnedWhisper } from "./whisper-orphan.ts";
import { reapOrphanedSox } from "./sox-orphan.ts";
import { PauseOriginLedger } from "./pause-origin.ts";
import { TtsSupervisor } from "./tts-supervisor.ts";
import { ManagedTtsWorker, resolveMlxAudioPython } from "./tts-worker.ts";
import {
  listenOnce,
  hasActiveRecorders,
  killActiveRecorders,
} from "./listen.ts";
import { revealSessionWindow } from "./inject.ts";
import { adapterFor, transcriptFormatFor } from "./agent-adapter.ts";
import { injectProviderCommand, renameProviderSession } from "./provider-rename.ts";
import { classify } from "./commands.ts";
import {
  describeNotice,
  fetchLatestVersion,
  isCheckDue,
  readVersionCheck,
  runningFromSource,
  updateNotice,
  versionCheckPath,
  writeVersionCheck,
} from "./version-check.ts";
import { CONCH_VERSION } from "./version.ts";
import { lastAssistantText, stripMarkdown, firstSentences, userRespondedSince, transcriptMark } from "./snippet.ts";
import { PhoneUploads } from "./phone-uploads.ts";
import { CONCH_DATA } from "./config.ts";
import {
  publishedConversation,
  readConversationTail,
} from "./conversation.ts";
import { isWindowKey } from "./window-key.ts";
import { readSessionContextUsage, type SessionContextUsage } from "./context-meter.ts";
import { appendConchError } from "./app-errors.ts";
import { closeTerminalSession, startTerminalSession } from "./session-lifecycle.ts";
import { SessionStartOverlay } from "./session-start-overlay.ts";
import { TerminalComposer } from "./terminal-composer.ts";
import {
  answerableTerminalQuestion,
  TerminalQuestionController,
} from "./terminal-question.ts";
import {
  codexHomeDir,
  detectCodexTurnEnds,
  isInterAgentEnvelope,
  readCodexTurnSnapshots,
  type CodexTurnMemory,
} from "./codex-threads.ts";
import { watchSessionSources } from "./session-watch.ts";
import { daemonStateFromUnknown, readState, writeState } from "./daemon-state.ts";
export { daemonStateFromUnknown } from "./daemon-state.ts";
import {
  createPhoneBridgeApplication,
  createPhoneBridgeServer,
  ensurePhoneToken,
  forwardToDaemonSocket,
  mintPairingCode,
  type PhoneBridgeApplication,
  type PhoneBridgeHandle,
} from "./phone-bridge.ts";
import {
  createPhoneRelay,
  ensureRelayPairing,
  type PhoneRelayHandle,
  type RelayPairing,
} from "./phone-relay.ts";
import {
  whisperServerClient,
  type WhisperRecoveryReason,
} from "./transcribe.ts";
import {
  prepareLogFile,
  clearTheaterSelection,
  configureRenderer,
  getLiveState,
  installRendererLifecycle,
  logAbove,
  logsShown,
  onLiveChange,
  onLiveDataChange,
  openTheaterReview,
  publishSessionsFile,
  renderPanel,
  resizeRenderer,
  scrollTheaterPane,
  setKeybar,
  setLogsVisible,
  setState,
  shouldDispatchTerminalInput,
  theaterPointerEvent,
  type ConchState,
} from "./status.ts";
import {
  registrySnapshot,
  sessionGoneFromSnapshot,
  sessionLabel,
  findTranscript,
  renameSessionLabel,
  subagentSessions,
  type RegistrySnapshot,
  type SessionInfo,
} from "./sessions.ts";
import {
  SessionLedger,
} from "./session-ledger.ts";
export { TurnEventOrder } from "./session-ledger.ts";
import { EventQueue } from "./event-queue.ts";
export { insertQueuedEvent, takeNextQueuedEvent } from "./event-queue.ts";
import {
  activeSessionIdForRows,
  buildPanelModel,
  buildPanelRows,
  buildPublishedState,
  commitLatestPanelRender,
  panelReplyText,
  numberPanelSessionRows,
  previewForPanelSelection,
  refreshPublishedConversationState,
  type NumberedPanelSessionRow,
  type PanelModel,
  type PublishedState,
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
  InstantControls,
  markQueuedWakesForControl,
  type InstantAudioCommand,
} from "./instant-controls.ts";
import {
  flushPendingRecorderTraces,
  recorderDiagnosticsEnabled,
} from "./diagnostics.ts";
import { withNormalMicClosed } from "./audio-gate.ts";
import {
  PauseController,
  SilentPauseCoordinator,
  SettingsPauseLifecycle,
  type PauseResumeResult,
} from "./pause-controller.ts";
import {
  MicClaimPoller,
  MicClaimWatcher,
  readMicInUse,
} from "./mic-claim.ts";
import {
  SETTING_DESCRIPTORS,
  SETTING_REGISTRY,
  configSnapshotEntry,
  loadSettingResolutions,
  loadSettingsFile,
  resolveSettingFromLoaded,
  settingsPathFor,
  unsetSetting,
  writeSetting,
  type ConfigAck,
  type ConfigControlMessage,
  type ConfigControlResponse,
  type ConfigSnapshot,
  type SettingKey,
  type SettingResolution,
  type SettingValue,
} from "./settings.ts";
import { SettingsOverlay } from "./settings-overlay.ts";
import {
  RestoreSessionsOverlay,
  SessionActionsOverlay,
  type SessionActionsController,
  type SessionActionsTarget,
} from "./session-actions-overlay.ts";
import { createPublishThrottle } from "./publish-throttle.ts";
import {
  readResumableSessionsResult,
} from "./resumable.ts";
import {
  readAgentCapabilities,
  type AgentCapabilityObservation,
} from "./agent-capabilities.ts";

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
// Manual mode survives launchd/supervisor restarts. Old state files used a
export interface ConfigControllerOptions {
  env?: Readonly<Record<string, string | undefined>>;
  settingsPath?: string;
  onLiveChange?(key: SettingKey, value: SettingValue): void;
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
          snapshot[descriptor.key] = configSnapshotEntry(descriptor, resolution);
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
      options.onLiveChange?.(descriptor.key, resolution.value);
      return ack(message, resolution, message.kind === "set-config" && resolution.source === "env" ? "masked" : "applied");
    },
  };
}

/** Small state machine for the phone's client-backed audio lease. */
export class AudioSinkLease {
  #sink: AudioSink = "mac";

  get sink(): AudioSink {
    return this.#sink;
  }

  isPhone(): boolean {
    return this.#sink === "phone";
  }

  request(requested: unknown, connectedClients: number): AudioSink {
    this.#sink = requested === "phone" && connectedClients > 0 ? "phone" : "mac";
    return this.#sink;
  }

  clientsChanged(connectedClients: number): boolean {
    if (connectedClients > 0 || this.#sink === "mac") return false;
    this.#sink = "mac";
    return true;
  }
}

/** Stop a disabled or wrong-port bridge before any replacement is created. */
export function retainMatchingPhoneBridge(
  bridge: PhoneBridgeHandle | null,
  enabled: boolean,
  port: number,
): PhoneBridgeHandle | null {
  if (bridge && (!enabled || bridge.port !== port)) {
    bridge.stop();
    return null;
  }
  return bridge;
}

/** Keep dismissed sessions live in the registry while omitting their dashboard rows. */
export function withoutDismissedSessions<T extends Pick<SessionInfo, "sessionId">>(
  sessions: readonly T[],
  dismissedSessionIds: ReadonlySet<string>,
): T[] {
  return sessions.filter((session) => !dismissedSessionIds.has(session.sessionId));
}

/** Restoration only changes visibility; quiet mode is an independent choice. */
export function restoreDismissedSessionState(
  sessionId: string,
  dismissedSessionIds: Set<string>,
): boolean {
  return dismissedSessionIds.delete(sessionId);
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

/** One record per unresolved interval preserves the signal without adding the same row every 20 seconds. */
export function shouldReportMissingCodexPid(
  session: Pick<SessionInfo, "sessionId" | "backend" | "pid">,
  reported: Set<string>,
): boolean {
  if (adapterFor(session.backend).rowsMayLackPid && !session.pid) {
    if (reported.has(session.sessionId)) return false;
    reported.add(session.sessionId);
    return true;
  }
  reported.delete(session.sessionId);
  return false;
}

/** Build the external document with daemon-owned voice and priority resolution. */
/** How many sessions get a published conversation, newest-active first. */
const MAX_PUBLISHED_CONVERSATIONS = 8;
/** Per-session window. Smaller than the focused one: this is every row at once. */
const PUBLISHED_CONVERSATION_WINDOW = 30;

/**
 * How long to wait for the daemon to answer one control line.
 *
 * Injection does UI automation with confirm-and-retry; a status query does not.
 * Giving them the same budget meant the slow one reported failure while
 * succeeding.
 */
/** Queue tracing, always on: a stuck event is invisible without it. */
function traceQueue(message: string): void {
  try {
    appendFileSync(
      "/tmp/conch-inject-debug.log",
      `[${new Date().toISOString().slice(11, 23)}] queue: ${message}\n`,
    );
  } catch {}
}

export function injectTimeoutFor(line: string): number {
  try {
    const kind = JSON.parse(line)?.type ?? JSON.parse(line)?.kind;
    if (kind === "inject") return 25_000;
    // A truthful close waits for the agent pid to disappear after Ctrl-D; the
    // bridge must not invent a failure while that clean shutdown is in flight.
    if (kind === "session-close") return 12_000;
    if (kind === "session-start") return 8_000;
  } catch {}
  return 4_000;
}

export function buildDaemonPublishedState(
  ownerDeviceId: string,
  cfg: Config,
  model: PanelModel,
  snippets: ReadonlyMap<string, string>,
  dismissedSessionIds: ReadonlySet<string>,
  prioritizedSessionIds: ReadonlySet<string>,
  now: number,
  labelForSessionId?: (sessionId: string) => string | undefined,
  /** Codex rollouts live at paths only its database knows; Claude's are found by id. */
  sessionTranscriptPaths?: ReadonlyMap<string, string>,
  sessionContexts?: ReadonlyMap<string, SessionContextUsage>,
  /** C9b Cut B: the holder record and the outbox, published on every complete document. */
  audio?: { control: AudioControl; outbox: AudioOutboxItem[] },
): PublishedState {
  return buildPublishedState(
    ownerDeviceId,
    model,
    snippets,
    dismissedSessionIds,
    now,
    {
      transcriptPathForSessionId: (sessionId) =>
        sessionTranscriptPaths?.get(sessionId) ?? findTranscript(cfg.claudeDir, sessionId),
      voiceForLabel: (label) => voiceFor(cfg, label),
      labelForSessionId,
      prioritizedSessionIds,
      contextForSessionId: (sessionId) => sessionContexts?.get(sessionId),
      ...(audio ? { audio } : {}),
    },
  );
}

/**
 * Reconstruct dashboard-only turn summaries without ever entering the live
 * queue. The second map check is the startup race boundary: a hook that arrives
 * during transcript I/O always wins over reconstructed history.
 */
export async function rehydrateLatestTurns(options: {
  sessions: readonly SessionInfo[];
  latest: Map<string, TurnEvent>;
  transcriptFor(sessionId: string): string | undefined;
  readAssistant(path: string): Promise<string>;
  labelFor(session: SessionInfo): string;
  maxChars: number;
  stopping(): boolean;
  now?(): number;
}): Promise<number> {
  let restored = 0;
  for (const session of options.sessions) {
    if (options.stopping()) break;
    if (options.latest.has(session.sessionId)) continue;
    const transcriptPath = options.transcriptFor(session.sessionId);
    if (!transcriptPath) continue;
    const raw = await options.readAssistant(transcriptPath).catch(() => "");
    if (!raw || options.stopping()) continue;
    // A live hook may have arrived while readAssistant yielded.
    if (options.latest.has(session.sessionId)) continue;
    const announce = stripMarkdown(raw).slice(0, options.maxChars).trim();
    if (!announce) continue;
    options.latest.set(session.sessionId, {
      type: "turn-end",
      sessionId: session.sessionId,
      label: options.labelFor(session),
      cwd: session.cwd,
      announce,
      transcriptPath,
      eventAt: session.statusUpdatedAt ?? (options.now ?? Date.now)(),
    });
    restored += 1;
  }
  return restored;
}

export async function runDaemon(cfg: Config): Promise<void> {
  prepareLogFile();
  const daemonSettingsPath = settingsPathFor();
  const ownerDeviceId = await loadDeviceId(dirname(daemonSettingsPath), log);
  const rendererSelection = configureRenderer();
  const rendererLifecycle = installRendererLifecycle(rendererSelection.renderer);
  const theaterMode = rendererSelection.kind === "theater";
  const diagnosticsEnabled = recorderDiagnosticsEnabled();
  const persisted = readState(); // survives restarts — see STATE_FILE
  let pause!: PauseController; // "away" mode: quiet, but HOLD finished sessions to replay on resume
  const audioLease = new AudioSinkLease();
  // C9b Cut B: WHICH MAC makes this daemon's sound. The lease above stays the
  // phone's local sink selector (phone wins on its daemon, F2); the holder is
  // the identified, revisioned, expiring answer between Macs. Every
  // sound-making site consults both.
  const audioHolder = new AudioHolder();
  const audioOutbox = new AudioOutbox(Date.now());
  const presented = new PresentedItems(Date.now());
  let holderExpiry: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;
  const ledger = new SessionLedger();
  // The ledger owns the per-session/window runtime facts, but exposes the raw
  // collections so render and controller paths keep their existing shape.
  const {
    injectedAt,
    pending,
    sessionStates,
    eventOrder,
    pausedSessionIds,
    resumedSessionIds,
    prioritizedSessionIds,
    dismissedSessionIds,
    sessionHeldTurns,
    dismissedHeldTurns,
    latestTurnBySession,
    reportedMissingCodexPid,
  } = ledger;
  const eventQueue = new EventQueue({
    handle,
    handoffOrder: () => cfg.handoffOrder,
    prioritized: prioritizedSessionIds,
    shuttingDown: () => shuttingDown,
    consumeStopKey: () => voice.consumeStop(),
    onError: (event, error) => {
      log(`error handling ${event.type} "${event.label}": ${error}`);
      speech.cancelCurrent();
    },
    onIdle: () => setState(restState()),
    log,
    trace: traceQueue,
  });
  const cancelQueuedWakes = (sessionId?: string): void => {
    markQueuedWakesForControl(eventQueue.pending, (event) => eventQueue.cancel(event), sessionId);
  };
  const resumeTransitions = new WeakMap<TurnEvent, Promise<PauseResumeResult>>();
  // Footer mode keeps its established persistent picker untouched. Theater uses
  // a separate active anchor + explicitly released parked cursor below.
  let panelOrder: string[] = [];
  let panelLabels = new Map<string, string>();
  let panelSessions = new Map<string, SessionInfo>();
  let numberedSessionRows: NumberedPanelSessionRow[] = [];
  let selectedId: string | null = null;
  let cursorAuto = true;
  let panelOpen = true;
  const theaterNavigation = new TheaterNavigation(() => void renderSessionPanel());
  const mouseParser = new SgrMouseParser();
  let settingsOverlay: SettingsOverlay | null = null;
  let sessionActionsOverlay: SessionActionsOverlay | null = null;
  let restoreSessionsOverlay: RestoreSessionsOverlay | null = null;
  let sessionStartOverlay: SessionStartOverlay | null = null;
  let terminalComposer: TerminalComposer | null = null;
  let terminalQuestionController: TerminalQuestionController | null = null;
  let meetingMic: MicClaimPoller | null = null;
  function labelForSessionId(id: string): string {
    const session = panelSessions.get(id);
    const known = latestTurnBySession.get(id)
      ?? (voice.current().reciting?.sessionId === id ? voice.current().reciting : null)
      ?? (voice.current().handling?.sessionId === id ? voice.current().handling : null)
      ?? (ledger.lastTurn?.sessionId === id ? ledger.lastTurn : null);
    return panelLabels.get(id)
      ?? sessionStates.get(id)?.label
      ?? known?.label
      ?? (session ? sessionLabel(session, session.cwd) : id.slice(0, 8));
  }
  /**
   * Translate a session id at the door, when it names a session that conch is
   * addressing per window.
   *
   * Window keys are conch's own invention (see `window-key.ts`), so anything
   * from outside — an agent that knows its own `session_id`, a hand-typed
   * `conch wake <id>` — legitimately asks by the session. Nothing else in here
   * has to know: by the time a message is dispatched it names a window.
   */
  function addressWindow(value: unknown): unknown {
    if (typeof value !== "object" || value === null) return value;
    const id = (value as { sessionId?: unknown }).sessionId;
    if (typeof id !== "string" || !id || isKnownSessionId(id)) return value;
    const windows = [...panelSessions.values()]
      .filter((s) => s.agentSessionId === id)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    // Two windows and no way to tell which was meant: the newest, the same
    // answer `findSession` gives an ambiguous id.
    return windows[0] ? { ...value, sessionId: windows[0].sessionId } : value;
  }
  function isKnownSessionId(id: string): boolean {
    return panelSessions.has(id)
      || ledger.isKnown(id)
      || voice.current().reciting?.sessionId === id
      || voice.current().handling?.sessionId === id;
  }
  function sessionActionTarget(sessionId: string): SessionActionsTarget | null {
    if (!isKnownSessionId(sessionId)) return null;
    const session = panelSessions.get(sessionId);
    const known = latestTurnBySession.get(sessionId)
      ?? (voice.current().reciting?.sessionId === sessionId ? voice.current().reciting : null)
      ?? (voice.current().handling?.sessionId === sessionId ? voice.current().handling : null)
      ?? (ledger.lastTurn?.sessionId === sessionId ? ledger.lastTurn : null);
    const pid = session?.pid ?? known?.pid;
    return {
      sessionId,
      label: labelForSessionId(sessionId),
      backend: session?.backend ?? "claude",
      ...(pid ? { pid } : {}),
    };
  }
  const sessionModalOpen = (): boolean =>
    Boolean(
      settingsOverlay?.isOpen()
      || sessionActionsOverlay?.isOpen()
      || restoreSessionsOverlay?.isOpen()
      || sessionStartOverlay?.isOpen()
    );
  const explicitQuietOverrideBlocked = (): boolean =>
    sessionModalOpen() || Boolean(meetingMic?.claimed);

  let whisperSupervisor: ServerSupervisor<WhisperRecoveryReason> | null = null;
  let ttsSupervisor: TtsSupervisor | null = null;
  const ttsWorkerPython = resolveMlxAudioPython(cfg.ttsWorkerPython, cfg.ttsServerBin);
  const ttsWorker = new ManagedTtsWorker({
    enabled: cfg.ttsEngine === "worker" && Boolean(ttsWorkerPython),
    model: cfg.ttsModel,
    voices: cfg.ttsVoices,
    speed: cfg.ttsSpeed,
    python: ttsWorkerPython,
    log,
  });
  whisperServerClient.setRecoveryHandler((reason) => whisperSupervisor?.requestRecovery(reason));
  whisperServerClient.setNoteHandler((detail) => log(`whisper request failed — ${detail}`));
  // D2: every warm transcription (partials included) restarts the idle-unload clock.
  whisperServerClient.setServedHandler(() => whisperSupervisor?.armIdleUnload());
  // D1: Kokoro by mode. Manual mode volunteers nothing, so the owned Kokoro
  // (~650MB) is unloaded after a grace long enough that a quick p/p does not
  // thrash the model; auto mode warms it again. Explicit speech while it is
  // unloaded goes through `say`, exactly as while it is loading. Whichever
  // engine is live acts; the other is a no-op.
  const KOKORO_MANUAL_GRACE_MS = 60_000;
  const kokoroByMode = (paused: boolean, graceMs = KOKORO_MANUAL_GRACE_MS): void => {
    for (const engine of [ttsWorker, ttsSupervisor]) {
      if (paused) engine?.unloadAfter(graceMs, "unloaded — manual mode; reloads in auto mode");
      else engine?.prewarm("auto mode");
    }
  };
  const speech = new SpeechManager(
    { speakCancellable: backendSpeakCancellable, stopSpeaking: backendStopSpeaking },
    (operation, output) => withNormalMicClosed(
      () => voice.capturing(),
      operation,
      // The speech gate: local holder AND no phone, or the lane stays silent.
      () => speechAllowedHere(audioHolder.holder, audioLease.sink)
        ? output()
        : Promise.resolve(undefined as Awaited<ReturnType<typeof output>>),
    ),
    {
      warn: log,
      worker: cfg.ttsEngine === "worker" ? ttsWorker : null,
      onKokoroFailure: (reason) => {
        if (cfg.ttsEngine === "server") ttsSupervisor?.requestRecovery(reason);
        else if (cfg.ttsEngine === "worker") ttsWorker.requestRecovery(reason);
      },
    },
  );
  pause = new PauseController({
    initialPaused: persisted.paused,
    pending,
    currentTurn: () => voice.current().reciting ?? voice.current().handling,
    holdableTurn: (current) => current.type === "wake"
      ? latestTurnBySession.get(current.sessionId) ?? null
      : current,
    currentTurnGeneration: () => voice.current().handlingPauseGeneration,
    activeSession: () => voice.current().dictation,
    cancelCurrentSpeech: () => speech.cancelCurrent(),
    cancelPendingAudio: () => speech.cancelPendingAudio(),
    persist: (paused) => writeState({ paused }),
    render: () => void renderSessionPanel(),
    setModeState: (paused) => {
      setState(paused ? "paused" : "idle");
      kokoroByMode(paused);
    },
    log,
    speak: (text) => voice.speak(cfg, text),
    liveSessionIds: async () => (await registrySnapshot(cfg.claudeDir))?.liveIds ?? null,
    userRespondedSince: (event) => userRespondedSince(event.transcriptPath, event.mark),
    enqueue,
    onHold: (event) => {
      ledger.lastTurn = event;
    },
    onInterruptError: (error) => log(`control interrupt cleanup failed: ${error}`),
  });
  const instantControls = new InstantControls({
    pause,
    globalHeldTurns: pending,
    pausedSessionIds,
    resumedSessionIds,
    sessionHeldTurns,
    enqueue,
    markInstantQueued: (event) => eventQueue.markInstantQueued(event),
    cancelQueuedWakes,
    labelFor: labelForSessionId,
    log,
    render: () => void renderSessionPanel(),
  });
  const pauseOrigin = new PauseOriginLedger();
  /** Every scoped pause/resume, from the socket or the TUI, records who asked. */
  const setSessionPausedFrom = (sessionId: string, paused: boolean, origin?: TurnEvent["origin"]): void => {
    if (paused) {
      pauseOrigin.paused(sessionId, origin, pausedSessionIds.has(sessionId));
    } else {
      const refusal = pauseOrigin.refusal(sessionId, origin, {
        globalPaused: pause.paused,
        sessionPaused: pausedSessionIds.has(sessionId),
      });
      if (refusal) return log(`manual — refused resume for "${labelForSessionId(sessionId)}" (${refusal}: an agent asked, not you)`);
      pauseOrigin.resumed(sessionId);
    }
    instantControls.setSessionPaused(sessionId, paused);
  };
  // Meeting-mode's silent auto-pause and settings-pause share one coordinator.
  const silentPause = new SilentPauseCoordinator(
    pause,
    (error) => log(`settings pause transition failed: ${error}`),
  );
  const settingsPause = new SettingsPauseLifecycle(silentPause);
  const meetingPause = new SettingsPauseLifecycle(silentPause);
  const sessionCommandPause = new SettingsPauseLifecycle(silentPause);
  // Legacy server mode still gates its first event on a full-body canary.
  // Worker startup is deliberately asynchronous: speech uses say until ready.
  let ttsStartup: Promise<void> = Promise.resolve();

  /** Hand a line to the holder's Mac (C9b Cut B). The holder's app carries it over; this Mac stays silent. */
  const presentElsewhere = (holder: string, text: string, voice: string, label: string, localSessionKey: string): void => {
    const item = audioOutbox.push({ text, voice, label, session: { ownerDeviceId, localSessionKey } });
    log(`handed "${label || "announcement"}" to ${holder.slice(0, 8)} (#${item.seq})`);
    void renderSessionPanel();
  };

  /** Republish when a lease lapses so the window sees audio return (named simplification #1). */
  const armHolderExpiry = (expiresAt: number | null): void => {
    if (holderExpiry) clearTimeout(holderExpiry);
    holderExpiry = null;
    if (expiresAt === null) return;
    holderExpiry = setTimeout(() => {
      holderExpiry = null;
      if (!audioHolder.isLocal()) return; // renewed since
      log("audio lease expired — this Mac speaks again");
      void renderSessionPanel();
    }, Math.max(0, expiresAt - Date.now()) + 5);
    holderExpiry.unref?.();
  };

  /**
   * Bound how long conch will claim the phone is reading.
   *
   * When the phone owns the audio this Mac stays quiet and cannot hear when the
   * reading ends, so the phone reports it. That report is the honest signal and
   * stays the primary one — but it arrives over a relay that drops
   * ("heartbeat expired", "disconnected (4002)" repeatedly in one afternoon),
   * and a dropped stop-report latched the dashboard at "speaking" forever.
   * Tyler saw it as the app insisting it was reading aloud when nothing was.
   *
   * So: an upper bound, generous enough never to cut a real reading short, and
   * cancelled the moment the phone says it finished. A safety net, not a timer.
   */
  let phoneSpeechLatch: ReturnType<typeof setTimeout> | null = null;

  function clearPhoneSpeechLatch(): void {
    if (!phoneSpeechLatch) return;
    clearTimeout(phoneSpeechLatch);
    phoneSpeechLatch = null;
  }

  function armPhoneSpeechLatch(text?: string): void {
    clearPhoneSpeechLatch();
    // ~8 characters per second is roughly half real speaking pace, so this only
    // fires when a report genuinely went missing. When the phone announces
    // speech it started itself we never saw the text, so fall back to the cap.
    const estimateMs = text === undefined
      ? 120_000
      : Math.min(120_000, 5_000 + (text.length / 8) * 1_000);
    phoneSpeechLatch = setTimeout(() => {
      phoneSpeechLatch = null;
      if (getLiveState().state !== "speaking") return;
      log("phone never reported finishing — clearing the speaking state");
      setState("idle");
      void renderSessionPanel();
    }, estimateMs);
    phoneSpeechLatch.unref?.();
  }

  /**
   * The one door every window raise goes through, so each one leaves a line
   * in the log — the audit could not tell whether a reveal had run (3e).
   */
  const raiseWindow = async (pid: number, why: string): Promise<boolean> => {
    const raised = await revealSessionWindow(pid);
    if (raised) log(`raised Terminal window of pid ${pid} (${why})`);
    return raised;
  };

  function restoreDismissedSession(sessionId: string): boolean {
    const label = labelForSessionId(sessionId);
    if (!restoreDismissedSessionState(sessionId, dismissedSessionIds)) return false;
    const held = dismissedHeldTurns.get(sessionId);
    dismissedHeldTurns.delete(sessionId);
    log(`▶ restored "${label}" after dismiss`);
    void renderSessionPanel();
    if (held) enqueue(held);
    return true;
  }

  /** An unscoped audio command must never reopen the conversation the user hid. */
  /**
   * Pay a transcript's one expensive read in the background, before anything
   * needs it.
   *
   * `countUserPrompts` is the only reader that must see the WHOLE file: with no
   * cached prompt count it scans from byte zero (`snippet.ts`, the
   * `requirement === "prompts"` branch), which measured 3.77s on a 189MB
   * session. Every other read takes the cheap tail path — and that is exactly
   * what hid this, because reading replies aloud kept the cache warm for
   * `assistant` while leaving `userPrompts` undefined, so the first prompt
   * count still paid full price.
   *
   * Once it has been counted once, the reader resumes from the cached state and
   * parses only what was appended, so this is a one-off per session and every
   * later call is effectively free. Tyler: "or preload or idk theres a ton of
   * stuff we could do" — this is that, and it is a smaller change than making
   * the count unnecessary.
   *
   * Serialized deliberately. Restoring turns at startup can hand us several
   * sessions at once, and three simultaneous full scans of 200MB files is a
   * thundering herd on the exact machine that is already busy.
   */
  function warmTranscript(path: string | undefined): void {
    if (!path || warmedTranscripts.has(path)) return;
    warmedTranscripts.add(path);
    warmQueue = warmQueue
      .then(() => transcriptMark(path))
      .then(
        () => {},
        // Never fatal, and never sticky: a transcript that was not readable yet
        // must be retried the next time its session speaks.
        () => void warmedTranscripts.delete(path),
      );
  }

  function enqueue(incoming: TurnEvent): void {
    if (shuttingDown) return;
    const event = incoming;
    warmTranscript(event.transcriptPath);
    if (!eventOrder.accept(event)) return;

    // Answering a session must not wait for a DIFFERENT session to finish
    // being read aloud.
    //
    // The queue drains one event at a time, which is right for anything that
    // speaks — two turns talking over each other is unusable. But an inject
    // and an interrupt make no sound, and both are someone waiting with a
    // finger still on the key. Behind the barrier they inherited the whole
    // length of another session's spoken announcement: Tyler watched a message
    // sit unsent until an unrelated session stopped talking, and reasonably
    // read it as "the sessions might be blocking each other". They were.
    //
    // Running them off the queue is safe precisely because they are silent: the
    // barrier exists to serialise AUDIO, and neither of these produces any. An
    // inject cancels whatever is being read first, so it cannot race the very
    // speech it is meant to cut off.
    if (event.type === "inject" || event.type === "interrupt") {
      traceQueue(`immediate ${event.type}:${event.label}`);
      void handle(event).catch((error) => {
        log(`error handling ${event.type} "${event.label}": ${error}`);
      });
      return;
    }

    if (shouldHandleTurnAudibly(event, cfg.workingMic)) {
      latestTurnBySession.set(event.sessionId, event);
    }
    if (event.type === "resume") {
      // Settings owns its silent pause lifetime; an external resume cannot cut
      // through an open modal.
      if (sessionModalOpen()) return;
      // A person's manual mode is theirs to leave. An agent's `conch_mode
      // resume` used to flip the whole Mac back to auto (audit 5d).
      const refusal = pauseOrigin.refusal("", event.origin, { globalPaused: pause.paused, sessionPaused: false });
      if (refusal) return log(`manual — refused resume (${refusal}: an agent asked, not you)`);
    }
    if (
      event.type === "pause"
      || event.type === "resume"
    ) {
      // Apply every mode edge synchronously. The queued event owns only its
      // spoken acknowledgement after the aborted exchange closes its barrier.
      // Any GLOBAL pause/resume clears per-session exemptions: a fresh pause
      // pauses everything, and a global resume makes an exemption meaningless.
      if (!event.sessionId) resumedSessionIds.clear();
      if (event.type === "resume") {
        silentPause.recordManualState(false);
        pauseOrigin.resumed("");
      } else {
        silentPause.recordManualState(true);
        pauseOrigin.paused("", event.origin, pause.paused);
      }
      const transition = instantControls.applyGlobal(event.type as "pause" | "resume");
      if (transition) resumeTransitions.set(event, transition);
    }
    void eventQueue.submit(event);
  }

  // The at-rest status reflects the one lossless quiet mode.
  const restState = (): ConchState => (pause.paused ? "paused" : "idle");

  let panelRenderVersion = 0;
  let lastPublishedPanelState: PublishedState | null = null;
  let lastPanelModel: PanelModel | null = null;
  /**
   * Say once a day when the conch running is not the newest one published.
   *
   * Homebrew never upgrades an installed package by itself — `brew update` only
   * refreshes metadata — so without this a person stays on whatever they first
   * installed, forever. That is not hypothetical: the release that shipped a
   * microphone which could not hear would have sat on someone's machine with
   * the fix already published and nothing to tell them.
   *
   * Deliberately a notice and not an upgrade. conch holds a microphone and
   * drives other people's terminals; replacing the binary underneath a running
   * voice loop is not something it should do to someone mid-sentence.
   *
   * Never awaited, never fatal, and once a day even across restarts — the
   * record is written whether the check succeeded or not, so an outage cannot
   * turn into a request on every daemon start.
   */
  function checkForUpdate(): void {
    if (runningFromSource()) return; // a checkout upgrades with git pull
    const path = versionCheckPath();
    const state = readVersionCheck(path);
    const now = Date.now();
    if (!isCheckDue(state, now, 24 * 60 * 60 * 1000)) {
      const known = updateNotice(CONCH_VERSION, state?.latest, false);
      if (known) log(describeNotice(known));
      return;
    }
    void fetchLatestVersion().then((latest) => {
      writeVersionCheck(path, { checkedAt: Date.now(), ...(latest ? { latest } : {}) });
      const notice = updateNotice(CONCH_VERSION, latest ?? undefined, false);
      if (notice) log(describeNotice(notice));
    }).catch(() => {});
  }

  const warmedTranscripts = new Set<string>();
  let warmQueue: Promise<unknown> = Promise.resolve();
  const recordDaemonError = (
    operation: string,
    message: string,
    sessionId?: string,
    state?: Record<string, unknown>,
  ): void => {
    try {
      appendConchError(
        { source: "daemon", operation, message, ...(sessionId ? { sessionId } : {}), ...(state ? { state } : {}) },
        lastPublishedPanelState,
      );
    } catch (error) {
      log(`could not record daemon error: ${error}`);
    }
  };
  // Cut four: the voice loop owns wake → speak → listen → deliver. Built after
  // every daemon helper it is handed; the closures above reach it lazily.
  const voice = createVoiceLoop({
    cfg,
    log,
    ledger,
    pause,
    queue: eventQueue,
    speech,
    audio: { lease: audioLease, holder: audioHolder },
    quietOverrideBlocked: explicitQuietOverrideBlocked,
    window: (sessionId) => panelSessions.get(sessionId),
    sessionGone: async (sessionId) => sessionGoneFromSnapshot(await registrySnapshot(cfg.claudeDir), sessionId),
    render: () => void renderSessionPanel(),
    presentElsewhere,
    phoneLatch: { arm: armPhoneSpeechLatch, clear: clearPhoneSpeechLatch },
    raiseWindow,
    reportError: recordDaemonError,
    prewarmEar: () => whisperSupervisor?.prewarm(),
    control: handleControl,
  });
  // Publication is always on, independent of the selected terminal renderer.
  // Full ledger rebuilds and cheap conversation refreshes share this writer so
  // neither path can bypass the 10 Hz leading/trailing throttle.
  // The phone bridge shares the publish cadence: whatever the file gets, a
  // connected phone gets, from the same object at the same moment.
  /**
   * Where conch's voice comes out.
   *
   * Synthesis on the Mac is right when you are at the Mac. When a phone is
   * carrying the loop, the Mac speaking too is worse than useless: you hear it
   * from the next room, or not at all, and the phone's own voice collides with
   * it. Tyler, bluntly: "if I wanted headphones close enough to my laptop to
   * work, I wouldn't need the mobile app in the first place."
   *
   * So the phone claims the audio and the Mac goes quiet — announcements and
   * the Mac's mic both. Everything else runs unchanged: turns still queue, the
   * dashboard still updates, and the phone speaks and listens instead.
   *
   * It ALWAYS returns to the Mac when the phone disconnects. A phone that walks
   * out of the room must not leave the Mac permanently silent.
   */
  const phoneUploads = new PhoneUploads(join(CONCH_DATA, "uploads"));
  let phoneApplication: PhoneBridgeApplication | null = null;
  let phoneBridge: PhoneBridgeHandle | null = null;
  let phoneRelay: PhoneRelayHandle | null = null;
  let activeRelayEndpoint = "";
  let activeRelayPairing: RelayPairing | null = null;
  function syncPhoneBridge(): void {
    const wanted = cfg.phoneEnabled;
    const previousBridge = phoneBridge;
    phoneBridge = retainMatchingPhoneBridge(phoneBridge, wanted, cfg.phonePort);
    if (!wanted) {
      phoneRelay?.stop();
      phoneRelay = null;
      activeRelayEndpoint = "";
      activeRelayPairing = null;
      phoneApplication = null;
      if (previousBridge) log("phone bridge stopped");
      return;
    }
    if (!phoneApplication) {
      phoneApplication = createPhoneBridgeApplication(
        {
          getState: () => lastPublishedPanelState,
          forwardControl: (line) => forwardToDaemonSocket(
            cfg.socketPath,
            line,
            // An inject is not a query. It focuses a pane, types, CONFIRMS the
            // text landed and re-sends if it did not — UI automation that
            // routinely outlives a four-second budget. Measured: "confirmed
            // sent (after 1 re-send)" at 22:16:29 and the phone giving up two
            // seconds later, so a message that arrived perfectly reported
            // "couldn't reach your Mac".
            //
            // A false failure is the expensive kind here: it teaches you not to
            // trust a send that worked, and invites sending twice. Everything
            // else stays on the short budget, where a quick answer is the point.
            injectTimeoutFor(line),
          ),
          onClientsChanged: (count) => {
            if (audioLease.clientsChanged(count)) {
              log("phone disconnected — audio back on this Mac");
              // The phone that was reading is gone, so its finish report is
              // never coming. Leaving the latch armed would keep the dashboard
              // claiming something is being read aloud by a device that is no
              // longer here.
              clearPhoneSpeechLatch();
              if (getLiveState().state === "speaking") setState("idle");
              void renderSessionPanel();
            }
          },
          // Images land beside conch's own cache, not in /tmp: an agent may
          // read one long after it arrived, and /tmp is swept by the OS.
          acceptUpload: (chunk) => phoneUploads.accept(chunk),
          replyFor: async (sessionId) => {
            const path = findTranscript(cfg.claudeDir, sessionId);
            // The WHOLE turn in progress, the way the Mac dashboard shows it —
            // every assistant block back to the last genuine human turn. The
            // phone is showing, not speaking, so the rule that protects speech
            // (never announce half a turn) makes it show the wrong thing: it
            // fell through to an earlier turn's short spoken announce, which is
            // where "one random sentence idk where from" came from.
            // A window of a shared session reads its own branch (A8); the
            // whole-turn reader sees only the file, so it is skipped there.
            const turn = path && !isWindowKey(sessionId) ? await currentTurnText(path) : "";
            if (turn) return turn;
            // RAW, not stripMarkdown: the phone renders it, it doesn't speak it.
            const finalMessage = path ? (await lastReplyFor(path, sessionId, panelSessions.get(sessionId))).text : "";
            if (finalMessage) return finalMessage;
            // Empty means the session is MID-TURN — lastAssistantText returns
            // the final message of a turn, and deliberately nothing while a
            // tool call is outstanding, so speech never announces half a turn.
            // The phone still deserves the last thing it actually told you.
            return latestTurnBySession.get(sessionId)?.announce ?? "";
          },
          log,
        },
        { token: ensurePhoneToken() },
      );
    }
    if (!phoneBridge) {
      try {
        phoneBridge = createPhoneBridgeServer(
          phoneApplication,
          { log },
          { port: cfg.phonePort },
        );
      } catch (error) {
        log(`phone bridge failed to start: ${String(error)}`);
      }
    }

    const relayEndpoint = cfg.phoneRelayURL.trim();
    if (phoneRelay && relayEndpoint !== activeRelayEndpoint) {
      phoneRelay.stop();
      phoneRelay = null;
      activeRelayPairing = null;
    }
    if (!relayEndpoint) {
      phoneRelay?.stop();
      phoneRelay = null;
      activeRelayEndpoint = "";
      activeRelayPairing = null;
      return;
    }
    if (!phoneRelay) {
      try {
        activeRelayPairing = ensureRelayPairing(relayEndpoint);
        activeRelayEndpoint = relayEndpoint;
        phoneRelay = createPhoneRelay(phoneApplication, activeRelayPairing, { log });
      } catch (error) {
        activeRelayEndpoint = "";
        activeRelayPairing = null;
        log(`phone relay failed to start: ${String(error)}`);
      }
    }
  }

  /**
   * Notice that this Mac was asleep, and re-dial rather than wait out a backoff.
   *
   * The daemon is a Bun process, so it gets no `NSWorkspace.didWakeNotification`
   * — only the app does, and only for its own UI. Meanwhile the relay socket
   * dies during sleep without a close frame ever arriving, so on wake the
   * daemon is sitting inside an exponential backoff that can be thirty seconds
   * long, having noticed nothing. Tyler: "i let my computer sleep and turned it
   * back on and the app is having a tough time connecting".
   *
   * A timer is the honest detector available here. One that should fire every
   * ten seconds and fires after a much longer gap means wall-clock moved
   * without us — which is sleep, a suspended process, or a machine so wedged
   * that reconnecting is the right response anyway.
   */
  // A BACKSTOP, not the mechanism. The Mac app sends `system-woke` the moment
  // it wakes, which is instant and costs nothing; this only covers a daemon
  // running with no app to tell it — launchd, or a terminal. So it ticks
  // rarely: the worst case it protects against is the relay's own backoff,
  // which caps at thirty seconds, and paying a wakeup every ten seconds
  // forever to shave that is the trade conch refuses everywhere else.
  const WAKE_TICK_MS = 60_000;
  const WAKE_GAP_MS = 240_000;
  let lastWakeTick = Date.now();
  const wakeWatch = setInterval(() => {
    const now = Date.now();
    const gap = now - lastWakeTick;
    lastWakeTick = now;
    if (gap < WAKE_GAP_MS) return;
    log(`woke after ${Math.round(gap / 1000)}s asleep — re-dialling (no app told us)`);
    // The phone's own socket is equally stale; it reconnects itself when its
    // app comes forward. This end is the one nobody was going to fix.
    try {
      phoneRelay?.reconnectNow();
    } catch (error) {
      log(`relay re-dial failed: ${error}`);
    }
    // Sessions may have come and gone while the lid was shut, and the panel is
    // the only thing that would notice.
    void renderSessionPanel();
  }, WAKE_TICK_MS);
  wakeWatch.unref?.();

  const publishedStateWriter = createPublishThrottle(() => {
    if (lastPublishedPanelState) publishSessionsFile(lastPublishedPanelState);
    phoneApplication?.publish();
  });

  /** Publish progress against the last reconciled ledger without another registry scan. */
  function publishLiveConversationState(): void {
    if (!lastPublishedPanelState) return;
    lastPublishedPanelState = refreshPublishedConversationState(
      lastPublishedPanelState,
      getLiveState(),
      (voice.current().reciting ?? ledger.lastTurn)?.sessionId ?? null,
      Date.now(),
    );
    publishedStateWriter.request();
  }

  async function renderSessionPanel(): Promise<void> {
    if (shuttingDown) return;
    const version = ++panelRenderVersion;
    let snap: Awaited<ReturnType<typeof registrySnapshot>> = null;
    try {
      snap = await registrySnapshot(cfg.claudeDir);
    } catch {}
    const registryLive = snap?.infos ?? [];
    for (const session of registryLive) {
      if (shouldReportMissingCodexPid(session, reportedMissingCodexPid)) {
        recordDaemonError(
          "session-routing",
          `${adapterFor(session.backend).displayName} row has no pid`,
          session.sessionId,
          { cwd: session.cwd ?? "", status: session.status ?? "unknown" },
        );
      }
    }
    pruneSessionCommandSets(snap, prioritizedSessionIds, dismissedSessionIds);
    // Prune a latch only on a COMPLETE snapshot — a torn/unreadable file must not
    // delete a live session's latch (e.g. a pending "needs"), which never re-fires.
    if (snap?.complete) {
      const liveIds = new Set(registryLive.map((s) => s.sessionId));
      ledger.forgetGone(liveIds);
    }
    const live = withoutDismissedSessions(registryLive, dismissedSessionIds);
    // Live background subagents, nested under their parents (C4). Rows and
    // conversations only: `live` stays the set of sessions conch can address,
    // so nothing below can wake, inject into, announce for or latch one.
    const nested = live.flatMap((session) =>
      subagentSessions(session, session.transcriptPath ?? findTranscript(cfg.claudeDir, session.sessionId))
    );
    const visible = [...live, ...nested];
    const liveState = getLiveState(); // what conch is doing right now, if anything
    const orderedRows = buildPanelRows({
      sessions: visible,
      sessionStates,
      pausedSessionIds,
      live: liveState,
      mode: { muted: false, paused: pause.paused, holding: pending.size },
      activeSessionId: null,
      navSelectedId: null,
    });
    const nextActiveSessionId = activeSessionIdForRows(orderedRows, liveState, {
      preferredSessionId: voice.current().reciting?.sessionId,
      liveSessionIds: snap?.liveIds,
    });

    // Whose conversation to show, in the order a person would expect: the one
    // they parked the cursor on, else the one conch is about to speak for, else
    // the busiest row. Anything is better than nothing, which is what a fresh
    // daemon had before a first turn landed.
    // Deliberately NOT the terminal cursor, which drives `preview` instead.
    //
    // Two front-ends have independent cursors and only one conversation is
    // published, so if this followed the TUI's parked row the Mac app would ask
    // for one session and receive another — measured exactly that: the daemon
    // published client-dashboard while the app focused asset generator, and the
    // stack silently fell back to the old pane every time. This chain mirrors
    // the app's own fallback (active row, else the first), so they agree.
    const conversationSessionId = nextActiveSessionId
      ?? orderedRows[0]?.sessionId
      ?? null;

    // Capture either renderer's manual cursor before reading its transcript.
    // Preview production is part of the published model, not theater drawing.
    const previewId = theaterNavigation.manualSelectedId
      ?? (cursorAuto ? null : selectedId);
    const previewPath = previewId
      ? findTranscript(cfg.claudeDir, previewId)
      : undefined;
    const contentEvent = voice.current().reciting ?? ledger.lastTurn;
    // The RAW reply is fetched alongside the spoken one. stripMarkdown exists to
    // make text speakable; handing that same string to a GUI is what made every
    // list render as a literal "- " with no blocks at all.
    // The conversation is read from the same transcript, at the same moment, as
    // the flattened reply beside it — so a viewer can never show a stack that
    // disagrees with the line being spoken.
    const [transcriptReply, previewReply, conversation] = await Promise.all([
      contentEvent?.transcriptPath
        ? lastReplyFor(contentEvent.transcriptPath, contentEvent.sessionId, panelSessions.get(contentEvent.sessionId))
        : null,
      previewPath && previewId ? lastReplyFor(previewPath, previewId, panelSessions.get(previewId)) : null,
      // Not tied to `contentEvent` like the reply beside it. That is the last
      // turn conch SPOKE, which is null for a whole daemon lifetime until
      // something finishes — so on a fresh start the app would show an empty
      // stack even with sessions full of history sitting right there. The
      // conversation belongs to whichever session is showing.
      (() => {
        const sessionId = contentEvent?.sessionId ?? conversationSessionId;
        if (!sessionId) return Promise.resolve(null);
        // Prefer the session's OWN path. `findTranscript` searches Claude's
        // projects directory by id, which can never locate a Codex rollout —
        // so every Codex row resolved to nothing and showed no conversation at
        // all, even while its rows updated live.
        const session = live.find((candidate) => candidate.sessionId === sessionId);
        const path = (contentEvent?.sessionId === sessionId && contentEvent.transcriptPath)
          || session?.transcriptPath
          || findTranscript(cfg.claudeDir, sessionId);
        if (!path) return Promise.resolve(null);
        // The row's registry entry rides along: a window of a shared session
        // reads its own branch of the transcript, not the other's (A8).
        return readConversationTail(path, sessionId, transcriptFormatFor(path), { window: session }).catch(() => null);
      })(),
    ]);
    // One per visible row. The reads are tail-only and bounded, and doing them
    // together means a viewer can show whichever session it is focused on
    // without the daemon having to guess which that is.
    const conversationsBySession = Object.fromEntries(
      (await Promise.all(
        visible.slice(0, MAX_PUBLISHED_CONVERSATIONS).map(async (session) => {
          const path = session.transcriptPath
            ?? findTranscript(cfg.claudeDir, session.sessionId);
          if (!path) return null;
          const read = await readConversationTail(path, session.sessionId, transcriptFormatFor(path), { window: session })
            .catch(() => null);
          if (!read || read.order.length === 0) return null;
          return [
            session.sessionId,
            publishedConversation(read, { windowSize: PUBLISHED_CONVERSATION_WINDOW }),
          ] as const;
        }),
      )).filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    );
    const sessionContexts = new Map(
      (await Promise.all(live.map(async (session) => {
        const path = session.transcriptPath
          ?? findTranscript(cfg.claudeDir, session.sessionId);
        if (!path) return null;
        const context = await readSessionContextUsage(path, transcriptFormatFor(path)).catch(() => null);
        return context ? [session.sessionId, context] as const : null;
      }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    );
    const transcriptReplyRaw = transcriptReply?.text ?? "";
    const previewRaw = previewReply?.text ?? "";
    const transcriptReplyText = stripMarkdown(transcriptReplyRaw);
    const previewText = stripMarkdown(previewRaw);
    if (shuttingDown) return;
    // Registry and transcript reads can overlap; only the newest complete model
    // may reach the renderer.
    commitLatestPanelRender(version, panelRenderVersion, () => {
      // Partial transcription and reading progress can change while the registry
      // or transcript is being read. Sample at commit so an older full render
      // cannot overwrite the lightweight publisher with stale conversation data.
      const committedLiveState = getLiveState();
      terminalComposer?.applyDictation(committedLiveState.dictated);
      const shownReply = panelReplyText(committedLiveState, transcriptReplyText);
      // Absence is authoritative only for a complete registry read. A torn
      // per-session file must not release a cursor that was meant to stay put.
      if (snap?.complete) {
        theaterNavigation.reconcile(new Set(live.map((session) => session.sessionId)));
      }
      // Footer auto-follow state is maintained even when it is not the selected
      // renderer; it is harmless there and keeps model production ungated.
      if (cursorAuto) {
        selectedId = nextActiveSessionId;
      } else if (selectedId && !live.some((session) => session.sessionId === selectedId)) {
        selectedId = null;
      }
      const navSelectedId = theaterNavigation.manualSelectedId
        ?? (cursorAuto ? null : selectedId);

      const model = buildPanelModel({
        sessions: live,
        sessionStates,
        pausedSessionIds,
        live: committedLiveState,
        mode: { muted: false, paused: pause.paused, holding: pending.size },
        activeSessionId: nextActiveSessionId,
        navSelectedId,
        reply: contentEvent && shownReply.text
          ? {
            sessionId: contentEvent.sessionId,
            text: shownReply.text,
            spokenChars: shownReply.spokenChars,
            ...(transcriptReplyRaw ? { markdown: transcriptReplyRaw } : {}),
          }
          : null,
        panelOpen,
        contextBySessionId: sessionContexts,
      });
      model.preview = previewForPanelSelection(
        navSelectedId,
        previewId,
        previewText,
        previewRaw,
        previewReply?.shared,
      );
      model.conversation = conversation ? publishedConversation(conversation) : null;
      model.conversations = conversationsBySession;
      model.settingsOverlay = settingsOverlay?.model() ?? null;
      model.sessionActionsOverlay = sessionActionsOverlay?.model() ?? null;
      model.restoreSessionsOverlay = restoreSessionsOverlay?.model() ?? null;
      model.sessionStartOverlay = sessionStartOverlay?.model() ?? null;
      model.terminalComposer = terminalComposer?.model() ?? null;
      model.terminalQuestion = terminalQuestionController?.model(
        answerableTerminalQuestion(model),
      ) ?? null;
      panelOrder = model.rows.map((row) => row.sessionId);
      panelLabels = new Map(model.rows.map((row) => [row.sessionId, row.label]));
      // Keep dismissed metadata available for restore clients; visible rows and
      // numbered terminal actions remain derived from the filtered `live` list.
      // An incomplete registry is uncertainty, so merge what it proved instead
      // of discarding labels that only a later complete snapshot may prune.
      if (snap?.complete) {
        panelSessions = new Map(registryLive.map((session) => [session.sessionId, session]));
      } else {
        for (const session of registryLive) panelSessions.set(session.sessionId, session);
      }
      numberedSessionRows = numberPanelSessionRows(model.rows, live);
      // Read mode state after the async registry snapshot so a slow older redraw
      // cannot repaint a stale manual banner over a newer toggle.
      model.mode = {
        muted: false,
        paused: pause.paused,
        holding: pending.size,
        // Published so `conch_speak` can say an agent's speech was held (A17).
        ...(pause.paused && pauseOrigin.agentOwns("") ? { pausedByAgent: true } : {}),
      };
      lastPanelModel = model;
      renderPanel(model);
      lastPublishedPanelState = buildDaemonPublishedState(
        ownerDeviceId,
        cfg,
        model,
        new Map(
          [...latestTurnBySession].map(([sessionId, event]) => [sessionId, event.announce]),
        ),
        dismissedSessionIds,
        prioritizedSessionIds,
        Date.now(),
        labelForSessionId,
        new Map(
          visible.flatMap((session) =>
            session.transcriptPath ? [[session.sessionId, session.transcriptPath] as const] : []
          ),
        ),
        sessionContexts,
        { control: audioHolder.record, outbox: audioOutbox.items },
      );
      publishedStateWriter.request();
      if (theaterMode) theaterNavigation.commitFrame(nextActiveSessionId, navSelectedId);
    });
  }
  /**
   * Rebuild what each session last said, from disk, at startup.
   *
   * Turn history lived only in memory, so every daemon restart blanked the row
   * summaries and the reply pane until each session happened to finish another
   * turn — and a launchd-supervised daemon restarts for all sorts of reasons.
   * Twenty-eight restarts in one day of development made the dashboard look
   * like it was losing data, because it was.
   *
   * The transcripts are the durable record; this reads them once and seeds the
   * same state a turn-end would have. Best effort throughout: a session whose
   * transcript is unreadable simply stays blank, exactly as before.
   */
  async function rehydrateFromTranscripts(): Promise<void> {
    try {
      const snapshot = await registrySnapshot(cfg.claudeDir);
      const sessions = snapshot?.infos ?? [];
      const restored = await rehydrateLatestTurns({
        sessions,
        latest: latestTurnBySession,
        transcriptFor: (sessionId) => {
          const path = findTranscript(cfg.claudeDir, sessionId);
          // Startup is the case that actually hurt: reconstructed turns never
          // enter enqueue, so without this the FIRST wake after a daemon
          // restart still paid the whole scan — which is exactly what happened
          // on 08-30, twelve seconds between the click and the mic.
          warmTranscript(path ?? undefined);
          return path;
        },
        readAssistant: lastAssistantText,
        labelFor: (session) => sessionLabel(session, session.cwd),
        maxChars: cfg.speakMaxChars,
        stopping: () => shuttingDown,
      });
      // Reconstructed turns never enter enqueue/handle, so this can only repaint
      // row summaries — it cannot announce, ring, or open a recorder.
      if (!shuttingDown && restored) void renderSessionPanel();
    } catch {
      // Never let a cold-start convenience break the daemon coming up.
    }
  }

  function relabelRuntimeSession(
    sessionId: string,
    oldLabel: string,
    newLabel: string,
  ): void {
    const { reciting, handling } = voice.current();
    const events = new Set<TurnEvent>([
      ...eventQueue.pending,
      ...pending.values(),
      ...sessionHeldTurns.values(),
      ...latestTurnBySession.values(),
      ...(ledger.lastTurn ? [ledger.lastTurn] : []),
      ...(reciting ? [reciting] : []),
      ...(handling ? [handling] : []),
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
    numberedSessionRows = numberedSessionRows.map((row) =>
      row.s.sessionId === sessionId ? { ...row, label: newLabel } : row
    );
  }

  async function handle(event: TurnEvent): Promise<void> {
    // Wait for the voice engine only when this event will SPEAK.
    //
    // `drain` used to await it before touching the queue, which meant nothing
    // moved until Kokoro had warmed up — measured at 67 SECONDS on a cold start
    // ("warmup 66968ms"), and every daemon restart pays it again. An inject
    // does not speak, so it was queued behind a text-to-speech model for over a
    // minute, the socket never replied, and the phone reported "Couldn't reach
    // the Mac". Restarting the daemon to pick up a fix re-armed the same trap,
    // which is why this looked intermittent and session-specific for hours.
    // Neither an inject nor an interrupt speaks, and both are things a person
    // is waiting on right now — an interrupt most of all, since its whole value
    // is arriving before the agent does more of what you are stopping.
    if (event.type !== "inject" && event.type !== "interrupt") await ttsStartup;
    return voice.handle(event);
  }

  /** Pause, resume and an explicit speak, handed back by `voice.handle` after its per-event reset. */
  async function handleControl(event: TurnEvent): Promise<void> {
    if (event.type === "pause") return pause.paused ? pause.announcePaused() : undefined;
    if (event.type === "resume") {
      if (sessionModalOpen() || pause.paused) return;
      const transition = resumeTransitions.get(event);
      const result = transition
        ? await transition
        : { replayed: 0, dropped: 0, cancelled: false };
      return pause.announceResumed(result);
    }
    if (event.type === "speak") {
      const speechCfg = event.voice ? { ...cfg, ttsVoices: [event.voice] } : cfg;
      // Explicit previews bypass both modal pause gating and a label-keyed
      // persisted pin; an empty selection label makes the one-item ring win.
      // Asked for out loud, so manual does not silence it — unless an AGENT
      // asked (`conch_speak`) while conch is paused by anyone but an agent
      // (you, a meeting, a manual mode restored at boot): then it is held at
      // the funnel like every other volunteered line (audit 5d).
      const volunteered = !(event.origin === "agent" && pause.paused && !pauseOrigin.agentOwns(""));
      return voice.speak(speechCfg, event.announce, event.voice ? "" : event.label, volunteered, event.sessionId);
    }
  }

  const configController = createConfigController(cfg, {
    settingsPath: daemonSettingsPath,
    onLiveChange: (key, value) => {
      if (key === "meeting-autopause") meetingMic?.setEnabled(value === true);
      if (key === "phone" || key === "phone-port" || key === "phone-relay-url") syncPhoneBridge();
      if (key === "whisper-idle-unload") whisperSupervisor?.armIdleUnload(); // re-arm with the new window (cfg is already updated)
    },
  });
  // These controllers own settings/session-action data and side effects for
  // every external viewer. Theater mode only decides whether terminal keys can
  // open and draw their overlays.
  settingsOverlay = new SettingsOverlay({
    controller: configController,
    settingsPath: daemonSettingsPath,
    persist: writeSetting,
    onOpen: () => settingsPause.open(),
    onClose: () => settingsPause.close(),
    onChange: () => void renderSessionPanel(),
  });
  const injectTerminalPrompt = (
    target: Readonly<{ sessionId: string; label: string }>,
    text: string,
  ): boolean => {
    const session = panelSessions.get(target.sessionId);
    if (!session || dismissedSessionIds.has(target.sessionId)) return false;
    enqueue({
      type: "inject",
      sessionId: session.sessionId,
      label: labelForSessionId(session.sessionId),
      cwd: session.cwd,
      pid: session.pid,
      announce: text,
      transcriptPath: session.transcriptPath
        ?? findTranscript(cfg.claudeDir, session.sessionId),
      origin: "user",
    });
    log(`terminal prompt → "${labelForSessionId(session.sessionId)}"`);
    return true;
  };
  const closeLiveSession = async (sessionId: string): Promise<void> => {
    let session = panelSessions.get(sessionId);
    if (!session) {
      session = (await registrySnapshot(cfg.claudeDir))?.infos.find(
        (candidate) => candidate.sessionId === sessionId,
      );
    }
    if (!session) throw new Error("session is not live");
    if (!session.pid) {
      const agent = adapterFor(session.backend);
      if (agent.rowsMayLackPid) {
        reportedMissingCodexPid.add(session.sessionId);
        recordDaemonError(
          "session-close",
          `${agent.displayName} row has no pid`,
          session.sessionId,
          { cwd: session.cwd ?? "", status: session.status ?? "unknown" },
        );
      }
      throw new Error("session has no routable pid");
    }
    await closeTerminalSession(session.pid);
    void renderSessionPanel();
  };
  const sessionActions: SessionActionsController = {
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
      const changed = clearVoiceOverride(target.label);
      log(`voice reset to auto for "${target.label}"`);
      return changed;
    },
    isPrioritized: (sessionId) => prioritizedSessionIds.has(sessionId),
    setPrioritized: (sessionId, prioritized) => {
      if (prioritized) prioritizedSessionIds.add(sessionId);
      else prioritizedSessionIds.delete(sessionId);
      log(`${prioritized ? "★ prioritized" : "normal hand-off for"} "${
        labelForSessionId(sessionId)
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
      const agent = adapterFor(target.backend).displayName;
      void renameProviderSession(cfg, target, renamed.label).then((provider) => {
        if (provider.kind === "delivered") {
          log(`synced ${agent} label via ${provider.via}`);
        } else if (provider.kind === "unroutable") {
          recordDaemonError(
            "session-rename",
            `Conch renamed the session, but ${agent} did not: ${provider.reason}`,
            target.sessionId,
            { label: renamed.label, backend: target.backend ?? "claude" },
          );
        }
      }).catch((error) => {
        recordDaemonError(
          "session-rename",
          `Conch renamed the session, but ${agent} did not: ${
            error instanceof Error ? error.message : String(error)
          }`,
          target.sessionId,
          { label: renamed.label, backend: target.backend ?? "claude" },
        );
      });
      void renderSessionPanel();
      return renamed.label;
    },
    dismiss: (target) => {
      dismissedSessionIds.add(target.sessionId);
      if (ledger.lastTurn?.sessionId === target.sessionId) ledger.lastTurn = null;
      panelOrder = panelOrder.filter((sessionId) => sessionId !== target.sessionId);
      panelLabels.delete(target.sessionId);
      pause.interrupt({
        sessionId: target.sessionId,
        hold: dismissedHeldTurns,
        preserveHeld: true,
      });
      eventQueue.removePending((event) => event.type === "speak" && event.sessionId === target.sessionId);
      cancelQueuedWakes(target.sessionId);
      theaterNavigation.release();
      log(`dismissed "${target.label}" — announcements stopped; session keeps running`);
      void renderSessionPanel();
    },
    close: async (target) => {
      await closeLiveSession(target.sessionId);
      log(`closed "${target.label}" cleanly`);
    },
    restore: restoreDismissedSession,
    // Same raise `revealOnTurn` uses: Terminal.app by tty, no focus steal.
    reveal: (target) => target.pid ? raiseWindow(target.pid, "app") : Promise.resolve(false),
    // B2: `/model <model>` typed into the session's own prompt, the way the
    // `/rename` sync is — Claude Code or Codex handles it natively.
    setModel: (target, model) => injectProviderCommand(cfg, target, `/model ${model}`).then((delivery) => {
      if (delivery.kind === "delivered") {
        log(`sent /model ${model} to "${target.label}" via ${delivery.via}`);
        return true;
      }
      recordDaemonError(
        "session-model",
        `Could not send /model ${model} to the session: ${delivery.reason}`,
        target.sessionId,
        { model, backend: target.backend ?? "claude" },
      );
      return false;
    }),
  };
  sessionActionsOverlay = new SessionActionsOverlay({
    controller: sessionActions,
    onOpen: () => settingsPause.open(),
    onClose: () => settingsPause.close(),
    onChange: () => void renderSessionPanel(),
  });
  restoreSessionsOverlay = new RestoreSessionsOverlay({
    controller: sessionActions,
    onOpen: () => settingsPause.open(),
    onClose: () => settingsPause.close(),
    onChange: () => void renderSessionPanel(),
  });
  sessionStartOverlay = new SessionStartOverlay({
    controller: {
      start: async (request) => {
        await startTerminalSession(request);
        log(`started fresh ${request.backend} session in ${request.cwd ?? homedir()}`);
        void renderSessionPanel();
      },
    },
    defaultCwd: homedir(),
    // Read at open, so the toggle starts from the setting as it is now.
    bypassDefault: () => cfg.bypassPermissions,
    onOpen: () => settingsPause.open(),
    onClose: () => settingsPause.close(),
    onChange: () => void renderSessionPanel(),
  });
  terminalComposer = new TerminalComposer({
    controller: { submit: injectTerminalPrompt },
    onChange: () => void renderSessionPanel(),
  });
  terminalQuestionController = new TerminalQuestionController(
    () => void renderSessionPanel(),
  );
  const enrichSocketAudioCommand = (event: InstantAudioCommand): InstantAudioCommand => {
    const session = panelSessions.get(event.sessionId);
    const known = latestTurnBySession.get(event.sessionId)
      ?? (voice.current().reciting?.sessionId === event.sessionId ? voice.current().reciting : null)
      ?? (ledger.lastTurn?.sessionId === event.sessionId ? ledger.lastTurn : null);
    return enrichTargetedAudioCommand(event, {
      session,
      known,
      label: labelForSessionId(event.sessionId),
      transcriptPath: findTranscript(cfg.claudeDir, event.sessionId),
    });
  };
  const socketTurnCallbacks: SocketTurnEventCallbacks = {
    busy: () => eventQueue.busy(),
    capturing: () => voice.capturing(),
    stopSpacebar: () => stopReciting("spacebar"),
    droppedStop: () => log("stop arrived with nothing running — ignored"),
    setSessionPaused: setSessionPausedFrom,
    isDismissedSession: (sessionId) => dismissedSessionIds.has(sessionId),
    enrichAudioCommand: enrichSocketAudioCommand,
    enqueueInstant: (event) => instantControls.enqueueInstant(event),
    enqueue,
  };
  const sessionCommandDispatchOptions: SessionCommandDispatchOptions = {
    controller: sessionActions,
    pause: sessionCommandPause,
    targetForSessionId: sessionActionTarget,
    isDismissed: (sessionId) => dismissedSessionIds.has(sessionId),
  };
  const runtimeControlDispatchOptions: RuntimeControlDispatchOptions = {
    listResumable: (message) => readResumableSessionsResult({
      ...(message.query === undefined ? {} : { query: message.query }),
      ...(message.limit === undefined ? {} : { limit: message.limit }),
      ...(process.env.CONCH_CONFIG_DIR === undefined
        ? {}
        : { configDir: process.env.CONCH_CONFIG_DIR }),
      ...(process.env.CLAUDE_CONFIG_DIR === undefined
        ? {}
        : { claudeHome: cfg.claudeDir }),
    }),
    readCapabilities: (message) => {
      const observations: AgentCapabilityObservation[] = [];
      const conversation = message.sessionId
        ? lastPublishedPanelState?.conversations?.[message.sessionId]
        : undefined;
      for (const item of conversation?.items ?? []) {
        if (item.tool?.kind !== "mcp_tool_call") continue;
        const match = /^mcp__(.+?)__(.+)$/.exec(item.tool.wireName ?? "");
        if (!match) continue;
        observations.push({
          kind: "mcp-tool",
          serverName: match[1]!,
          toolName: match[2]!,
          sessionId: message.sessionId!,
          ...(item.at === undefined ? {} : { at: item.at }),
        });
      }
      // An empty cwd means "the session's own directory". A client that can
      // already name a session should not also have to know its filesystem
      // path — the daemon holds that, and making the app carry it would mean
      // publishing a path on every row for one deliberate lookup.
      //
      // But it FAILS rather than guessing. Falling back to the home directory
      // produced a coherent inventory of somewhere else, attributed to this
      // session and undetectable from the UI — the session may have no
      // recorded cwd, or may have exited between the app rendering its row and
      // this request arriving. A missing inventory is honest; another
      // directory's inventory wearing this session's name is not.
      const resolved = message.cwd.trim()
        || panelSessions.get(message.sessionId ?? "")?.cwd
        || "";
      if (!resolved) {
        throw new Error(
          "that session has no known working directory — conch will not "
          + "inventory a different one in its name",
        );
      }
      const cwd = resolved;
      return readAgentCapabilities({
        backend: message.backend,
        cwd,
        ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
        observations,
        ...(process.env.CONCH_CONFIG_DIR === undefined
          ? {}
          : { configDir: process.env.CONCH_CONFIG_DIR }),
        ...(process.env.CLAUDE_CONFIG_DIR === undefined
          ? {}
          : { claudeHome: cfg.claudeDir }),
      });
    },
    start: (message) => startTerminalSession({
      ...message,
      // Read at start time, so changing the setting affects the next session
      // you launch rather than needing a daemon restart.
      bypassPermissions: cfg.bypassPermissions,
      ...(message.trustFolder === true ? { trustFolder: true as const } : {}),
    }),
    folderTrusted: adapterFor("claude").folderTrusted,
    codexFolderTrusted: adapterFor("codex").folderTrusted,
    close: closeLiveSession,
    report: (message) => {
      appendConchError(
        {
          source: message.source,
          operation: message.operation,
          message: message.message,
          ...(message.sessionId ? { sessionId: message.sessionId } : {}),
          state: message.state,
        },
        lastPublishedPanelState,
      );
    },
  };
  // Device operations remain whole: the server decodes, the daemon owns effects.
  function deviceCommand(message: DeviceCommand): DeviceControlResponse {
    if (message.kind === "audio-sink") {
      const previous = audioLease.sink;
      const requested = message.sink;
      const connectedClients = phoneApplication?.clientCount() ?? 0;
      const claimingPhone = requested === "phone"
        && connectedClients > 0
        && previous !== "phone";
      if (claimingPhone) {
        // Tear down physical Mac audio before publishing phone ownership.
        // The callback is synchronous, so no new daemon work can enter the
        // old lease between this stop and request() below.
        speech.cancelCurrent();
        speech.cancelPendingAudio();
        voice.closeMic("phone-audio-claim");
        void Promise.resolve(killActiveRecorders()).catch(() => {});
      }
      const wanted = audioLease.request(requested, connectedClients);
      if (wanted !== previous) {
        log(audioLease.sink === "phone"
          ? "phone has the audio — this Mac is quiet"
          : "audio back on this Mac");
        void renderSessionPanel();
      }
      return { kind: "audio-sink-ack", sink: audioLease.sink };
    }
    // C9b Cut B: one voice across two Macs. `audio-take` is this Mac's own
    // app taking its audio back; `audio-release` is the holder's app handing it
    // back; both bump the revision so a stale claim loses.
    if (message.kind === "audio-take" || message.kind === "audio-release") {
      const wasLocal = audioHolder.isLocal();
      const record = message.kind === "audio-take" ? audioHolder.take() : audioHolder.release();
      armHolderExpiry(null);
      if (!wasLocal) {
        log(`audio ${message.kind === "audio-take" ? "taken back" : "released"} — this Mac speaks again (rev ${record.revision})`);
      }
      void renderSessionPanel();
      return { kind: "audio-ack", revision: record.revision };
    }
    if (message.kind === "audio-yield") {
      const { holder, revision, leaseMs } = message;
      const verdict = audioHolder.assess(holder, revision);
      if (verdict === "stale") {
        return { kind: "audio-error", code: "stale-revision", revision: audioHolder.record.revision };
      }
      if (verdict === "grant") {
        // The transfer is SYNCHRONOUS, mirroring the phone claim exactly (F5):
        // kill what is sounding, drop what is queued, close the mic, and only
        // THEN flip the record — in the same tick, so no drained turn can enter
        // `speak` with the holder still local. The recorder drain finishing
        // later does not conflict with the other Mac speaking.
        speech.cancelCurrent();
        speech.cancelPendingAudio();
        voice.closeMic("audio-yield");
        void Promise.resolve(killActiveRecorders()).catch(() => {});
      }
      const outcome = audioHolder.yield(holder, revision, leaseMs);
      if (outcome.kind === "stale") {
        return { kind: "audio-error", code: "stale-revision", revision: outcome.revision };
      }
      armHolderExpiry(outcome.record.expiresAt);
      if (verdict === "grant") {
        log(`audio yielded to ${holder.slice(0, 8)} — this Mac is silent (rev ${outcome.record.revision})`);
        void renderSessionPanel();
      }
      return { kind: "audio-ack", revision: outcome.record.revision, stopped: verdict === "grant" };
    }
    if (message.kind === "audio-present") {
      const { source, seq, text, voice: itemVoice, label, host, at } = message.item;
      const admission = presented.check(source, seq, at);
      if (admission !== "admit") return { kind: "audio-error", code: "dropped" };
      // Only what `speak` would actually enqueue is admitted (F4): a held item
      // is answered without being recorded, and the holder's app retries it.
      if (voice.speakBlocker(false) || !speechAllowedHere(audioHolder.holder, audioLease.sink)) {
        return { kind: "audio-error", code: "held" };
      }
      presented.record(source, seq);
      // Labelled for the other Mac so this window never matches it to a local row.
      const heading = `${host || source.slice(0, 8)} · ${label}`;
      log(`presenting "${heading}" (#${seq})`);
      // Through `speak`, never `speech.speak`: the mic-open guard and the
      // manager gate live there. A `say`-engine daemon ignores the voice.
      void voice.speak(itemVoice ? { ...cfg, ttsVoices: [itemVoice] } : cfg, text, heading)
        .catch((error) => log(`presenting "${heading}" failed: ${error}`));
      return { kind: "audio-ack", revision: audioHolder.record.revision, seq };
    }
    if (message.kind === "phone-spoke") {
      const { reason, text } = message;
      log(`phone spoke (${reason}): ${JSON.stringify(text)}`);
      return { kind: "ack" };
    }
    if (message.kind === "phone-device") {
      // Telemetry is logged, never acted on.
      log(message.summary);
      return { kind: "phone-device-ack" };
    }
    if (message.kind === "system-woke") {
      log("the Mac woke — re-dialling the relay");
      try {
        phoneRelay?.reconnectNow();
      } catch (error) {
        log(`relay re-dial failed: ${error}`);
      }
      // Sessions may have come and gone while the lid was shut, and the
      // panel is the only thing that would notice.
      void renderSessionPanel();
      return { kind: "system-woke-ack" };
    }
    if (message.kind === "phone-speaking") {
      const { speaking, label } = message;
      // Only while the phone actually owns the audio: a stale report from
      // a backgrounded phone must not silence or mislabel this Mac.
      if (audioLease.isPhone()) {
        if (speaking && label) {
          setState("speaking", label);
          // Bound it here too. This is the path that actually latched on
          // Tyler's phone: it reported that it had STARTED reading and the
          // matching stop never arrived, so the dashboard sat at "Reading
          // aloud" with nothing playing. Every route into the speaking
          // state needs a way back out that does not depend on a message
          // crossing a relay that drops.
          armPhoneSpeechLatch();
        } else if (!speaking) {
          clearPhoneSpeechLatch();
          setState("idle");
        }
        void renderSessionPanel();
      }
      return { kind: "phone-speaking-ack", speaking };
    }
    if (message.kind === "open-pairing") {
      let response: DeviceControlResponse;
      syncPhoneBridge();
      if (!phoneBridge) {
        response = {
          kind: "session-error",
          // Shown verbatim in the app's pairing tab and by `conch pair`, so
          // it has to carry the remedy: a fresh install has `phone` off.
          error: "Phone access is off. Turn on \"phone\" in Settings, or run: conch set phone true",
        };
      } else {
        const code = mintPairingCode();
        phoneBridge.offerPairingCode(code);
        log("pairing window open (2 min)");
        response = {
          kind: "pairing-open",
          code: code.code,
          expiresAt: code.expiresAt,
          port: phoneBridge.port,
          ...(activeRelayPairing ? { relay: activeRelayPairing } : {}),
        };
      }
      return response;
    }
    const exhaustive: never = message;
    return exhaustive;
  }
  const controlServer = createControlServer({
    socketPath: cfg.socketPath,
    ownerDeviceId,
    log,
    sessions: {
      resolve: addressWindow,
      current: (sessionId) => {
        const row = lastPublishedPanelState?.rows.find((candidate) => candidate.id === sessionId);
        if (!row) return { published: false };
        const session = panelSessions.get(sessionId);
        return {
          published: true,
          label: row.label,
          cwd: session?.cwd,
          pid: session?.pid,
          transcriptPath: findTranscript(cfg.claudeDir, sessionId),
        };
      },
    },
    application: {
      configuration: (message) => applyConfigControlMessage(message, configController, {
        settingsPath: daemonSettingsPath,
        set: writeSetting,
        unset: unsetSetting,
      }),
      session: (message) => applySessionCommand(message, sessionCommandDispatchOptions),
      runtime: (message) => applyRuntimeControlMessage(message, runtimeControlDispatchOptions),
      turn: (event) => dispatchSocketTurnEvent(event, socketTurnCallbacks),
      device: deviceCommand,
    },
  });

  let shutdownStarted = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    // Synchronous and first: no cancellation/cleanup failure may strand the
    // alternate screen or hidden cursor before either process.exit below.
    rendererLifecycle.restore();
    theaterNavigation.dispose();
    shuttingDown = true;
    onLiveDataChange(null);
    publishedStateWriter.flush();
    meetingMic?.close();
    phoneRelay?.stop();
    phoneBridge?.stop();
    eventQueue.clear();
    speech.close(); // cancel and seal speech, cues, and in-flight/future canaries
    // Close the controller's rearm gate synchronously before taking the
    // recorder snapshot. No await is allowed before this request.
    const dictationAtShutdown = voice.close();
    // A live sox capture would keep the mic hot after we die. Without
    // diagnostics we `process.exit(0)` a few lines down, so there is no later
    // moment in which a grace timer could fire — the kill has to land now.
    const recorderDrain = killActiveRecorders({ immediate: !diagnosticsEnabled });
    void controlServer.close();
    clearIdentity(); // the socket and the claim to it go together
    whisperServerClient.cancelWarmRequests();
    whisperSupervisor?.close();
    ttsSupervisor?.close();
    ttsWorker.close();
    // KEEP_RAW diagnostics are exact opt-in. The default path stays lean and
    // exits after synchronous cancellation instead of waiting on transcription.
    if (!diagnosticsEnabled) process.exit(0);
    await speech.quiescent().catch(() => {});
    await Promise.allSettled([
      Promise.resolve(recorderDrain),
      dictationAtShutdown ?? Promise.resolve(),
    ]);
    flushPendingRecorderTraces();
    process.exit(0);
  };
  // G8: the daemon owns its signal path before exposing the socket.
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGHUP", () => void shutdown());
  process.on("SIGQUIT", () => void shutdown());

  meetingMic = new MicClaimPoller({
    enabled: cfg.meetingAutopause,
    createWatcher: () => new MicClaimWatcher({
      inUse: readMicInUse,
      // CoreAudio exposes one running bit per device, and the read covers
      // every input device. Skip it whenever Conch could own one of those
      // bits, including the pre-adoption SoX barge recorder.
      selfOwned: () => voice.capturing() || hasActiveRecorders(),
      onClaim: () => {
        log("another app is using the microphone — auto-pausing");
        meetingPause.open();
      },
      onRelease: () => {
        log("microphone released — restoring pre-meeting pause state");
        meetingPause.close();
      },
      onError: (error) => log(`meeting microphone poll failed: ${error}`),
    }),
    onError: (error) => log(`meeting microphone watcher failed: ${error}`),
  });

  const ttsBinaryAvailable = Boolean(Bun.which(cfg.ttsServerBin));
  if (!ttsWorkerPython && cfg.ttsEngine === "worker") {
    log(
      `CONCH_TTS=worker but mlx-audio Python was not found via ${cfg.ttsServerBin} `
      + "or CONCH_TTS_WORKER_PYTHON — voices via say",
    );
  }
  if (!ttsBinaryAvailable && cfg.ttsEngine === "server") {
    log(`CONCH_TTS=server but ${cfg.ttsServerBin} not found (uv tool install "mlx-audio[server]") — voices via say`);
  }
  if (cfg.ttsEngine === "server") {
    ttsSupervisor = new TtsSupervisor({
      enabled: Boolean(cfg.ttsPort) && ttsBinaryAvailable,
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
  }
  // D1: a daemon booting in manual mode never loads Kokoro; auto mode will.
  if (pause.paused) kokoroByMode(true, 0);
  if (cfg.ttsEngine === "worker") {
    // Loading and the first Metal/G2P warmup may take seconds (or download on a
    // cold install). Do not hold the turn queue: say is live during startup.
    void ttsWorker.start().catch((error) => {
      if (!shuttingDown) log(`tts worker startup failed — voices via say: ${error}`);
    });
  } else if (ttsSupervisor) {
    // Assign synchronously before listen: early hook events queue behind this
    // one full-body compatibility canary. Later repair is fire-and-forget.
    ttsStartup = ttsSupervisor.start().then(() => {}).catch((error) => {
      if (!shuttingDown) log(`tts server startup gate failed — voices via say: ${error}`);
    });
  }

  const whisperBinaryAvailable = existsSync(cfg.whisperServerBin);
  whisperServerClient.resetHealth();
  whisperSupervisor = new ServerSupervisor<WhisperRecoveryReason>({
    enabled: Boolean(cfg.whisperPort),
    // D2: read live — the config controller assigns into this same cfg object.
    idleUnloadMs: () => cfg.whisperIdleUnloadMins * 60_000,
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
      const child = Bun.spawn(
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
      // So the next daemon can tell this server from a stranger on the port (D3).
      recordSpawnedWhisper(child.pid, cfg.whisperPort);
      return child;
    },
    resetReadiness: () => whisperServerClient.resetHealth(),
    exclusive: (task, signal) => whisperServerClient.runExclusive(task, signal),
    log,
  });

  if (!await controlServer.start()) {
    log(`another conch daemon already owns ${cfg.socketPath} — this one is exiting`);
    // Losing the ownership race is not a crash for the supervisor to retry.
    process.exit(0);
  }
  // Only the socket's owner may claim to be the daemon (A2): the Mac app reads
  // this to say who started what it adopted, and to tell its own child apart.
  writeIdentity();
  syncPhoneBridge();
  void rehydrateFromTranscripts();
  log(`listening on ${cfg.socketPath} — wire hooks with \`conch install\``);
  if (pause.paused) log("starting in manual mode (persisted) — p or `conch resume` turns auto on");
  checkForUpdate(); // fire and forget; never blocks the daemon coming up
  rendererLifecycle.enter();
  setState(restState());
  void renderSessionPanel(); // show the dashboard immediately
  setKeybar(theaterMode ? THEATER_KEYBAR : FOOTER_KEYBAR);
  onLiveChange(() => void renderSessionPanel()); // repaint when speaking/recording/… flips
  onLiveDataChange(publishLiveConversationState); // partials/progress reuse the reconciled ledger
  process.stdout.on("resize", () => {
    resizeRenderer();
    void renderSessionPanel(); // refresh the model and re-fit to the new width
  });
  // Refresh periodically so killed sessions drop off even with no new events.
  const panelTimer = setInterval(() => void renderSessionPanel(), 20_000);
  panelTimer.unref?.();
  // ...but the timer is only the backstop. Both agents publish liveness in a
  // directory, so a session opening or closing is an event conch can be told
  // about rather than one it has to wait up to 20s to notice.
  const codexHome = codexHomeDir();
  watchSessionSources(
    [
      join(cfg.claudeDir, "sessions"),
      ...(codexHome ? [join(codexHome, "thread-writer-locks")] : []),
    ],
    () => void renderSessionPanel(),
  );

  // Announce Codex turns, which have no hook to announce themselves.
  //
  // Claude Code tells conch a turn ended; Codex cannot, and wiring its hooks
  // would mean editing shared config that only takes effect on session start —
  // so it could never reach a session already running, which is exactly what
  // Tyler asked to leave alone. Polling the rollout files observes the same
  // event from outside, and a session never learns conch is watching.
  //
  // The announce text comes from `lastAssistantText`, not from the detector's
  // own tail read: that already knows how to walk a rollout back to the FINAL
  // message of a turn rather than the last text it happens to see, and routes
  // on the filename, so Codex and Claude produce the same shape of summary.
  const codexTurnMemory: CodexTurnMemory = new Map();
  const codexTimer = setInterval(() => {
    let ended: ReturnType<typeof detectCodexTurnEnds>;
    try {
      ended = detectCodexTurnEnds(codexTurnMemory, readCodexTurnSnapshots());
    } catch (error) {
      return log(`codex watch failed: ${error}`);
    }
    for (const snapshot of ended) {
      void (async () => {
        let text = snapshot.text;
        try {
          const full = await lastAssistantText(snapshot.transcriptPath);
          if (full && !isInterAgentEnvelope(full)) text = full;
        } catch {}
        const snippet = firstSentences(stripMarkdown(text), 2, 220);
        log(`codex turn ended — "${snapshot.label}"`);
        enqueue({
          type: "turn-end",
          sessionId: snapshot.sessionId,
          label: snapshot.label,
          cwd: snapshot.cwd,
          announce: `${snapshot.label}: ${snippet || "finished, ready for your next prompt"}`,
          transcriptPath: snapshot.transcriptPath,
          eventAt: Date.now(),
        });
      })();
    }
  }, 5_000);
  codexTimer.unref?.();

  // Warm Whisper independently after the socket and signal path are live.
  // Startup/recovery never blocks dictation: finals use the cold CLI until the
  // full inference canary marks this client healthy.
  if (cfg.whisperPort && !whisperBinaryAvailable) {
    log(`whisper-server binary not found at ${cfg.whisperServerBin} — using the cold cli path`);
  }
  // A hard-killed daemon also leaves its sox holding the mic, with a `silence`
  // gate waiting for speech that never comes (audit 1a). Same rule as below:
  // only pids a dead conch recorded as its own, and only while `ps` still
  // shows conch's own sox argv on them.
  void reapOrphanedSox().then(
    (pids) => { if (pids.length) log(`killed sox ${pids.join(", ")} — orphans of a dead conch daemon`); },
    (error) => log(`sox orphan check failed: ${error}`),
  );
  if (cfg.whisperPort) {
    const supervisor = whisperSupervisor;
    // A hard-killed daemon leaves its whisper-server listening, and the
    // supervisor would adopt it: never stopped, never replaced, never
    // reloaded after a model change (D3). Reap it first — only by the pid a
    // conch daemon recorded as its own spawn, and only if that daemon is dead.
    void reapOrphanedWhisper(cfg.whisperPort)
      .then(
        (pid) => { if (pid) log(`killed whisper-server ${pid}, orphan of a dead conch daemon — starting our own`); },
        (error) => log(`whisper-server orphan check failed — adopting whatever listens: ${error}`),
      )
      .then(() => supervisor.start())
      .catch((error) => {
        if (!shuttingDown) log(`whisper-server startup failed — using the cold cli: ${error}`);
      });
  }

  /** Make log-backed controls visible even after the content pane was collapsed. */
  function revealLogPane(): void {
    panelOpen = true;
    setLogsVisible(true);
    void renderSessionPanel();
  }

  /** Refresh, then reuse the exact numbered order committed to the visible panel. */
  async function numberedSessions(): Promise<NumberedPanelSessionRow[]> {
    await renderSessionPanel();
    return numberedSessionRows;
  }

  async function printSessions(): Promise<void> {
    revealLogPane();
    const rows = await numberedSessions();
    if (!rows.length) return log("no live sessions");
    logAbove(rows.map((r) => `  \x1b[36m${r.n}\x1b[0m ${r.label}${ledger.lastTurn?.sessionId === r.s.sessionId ? " \x1b[2m(space wakes this one)\x1b[0m" : ""}`).join("\n"));
  }

  /** Audition every live session in its assigned voice — `conch voice <session> <voice>` reassigns. */
  async function auditionVoices(): Promise<void> {
    if (eventQueue.busy()) return log("busy — audition after the current exchange");
    if (pause.paused) return log("manual mode — resume before auditioning voices");
    await eventQueue.exclusive(async () => {
      const controlGeneration = pause.capture();
      const rows = await numberedSessions();
      if (pause.interrupted(controlGeneration) || pause.paused) return;
      if (!rows.length) return log("no live sessions");
      for (const r of rows) {
        if (pause.interrupted(controlGeneration) || pause.paused) break;
        logAbove(`  \x1b[36m${r.n}\x1b[0m ${r.label} — \x1b[35m${voiceFor(cfg, r.label)}\x1b[0m`);
        await voice.speak(cfg, `${r.label} sounds like this.`, r.label);
        if (pause.interrupted(controlGeneration) || pause.paused) break;
      }
      if (!pause.interrupted(controlGeneration) && !pause.paused) {
        logAbove('  \x1b[2mreassign: conch voice <session> <kokoro-voice>\x1b[0m');
      }
    });
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
      origin: "user",
    });
  }

  /** Open the mic for a specific session by id (space on the parked cursor). */
  function wakeBySessionId(id: string): void {
    const s = panelSessions.get(id);
    if (!s) return log("that session is gone — press s to list");
    const label = labelForSessionId(id);
    log(`▸ talking to ${label}`);
    enqueue({
      type: "wake",
      sessionId: s.sessionId,
      label,
      cwd: s.cwd,
      pid: s.pid,
      announce: "",
      transcriptPath: findTranscript(cfg.claudeDir, s.sessionId),
      origin: "user",
    });
  }

  /** The TUI mic has the same contract as both apps: return words to the draft. */
  function dictateToTerminalComposer(id: string): void {
    const s = panelSessions.get(id);
    if (!s) return log("that session is gone — press s to list");
    terminalComposer?.open({
      sessionId: id,
      label: labelForSessionId(id),
    }, lastPanelModel?.live.dictated?.id ?? 0);
    enqueue({
      type: "wake",
      sessionId: s.sessionId,
      label: labelForSessionId(id),
      cwd: s.cwd,
      pid: s.pid,
      announce: "",
      transcriptPath: s.transcriptPath ?? findTranscript(cfg.claudeDir, id),
      origin: "user",
      compose: true,
    });
  }

  /** Read a target session's latest assistant output from sentence zero. */
  function reciteBySessionId(id: string | null): void {
    if (!id) return log("nothing to recite — no session is parked or active");
    const known = latestTurnBySession.get(id)
      ?? (voice.current().reciting?.sessionId === id ? voice.current().reciting : null)
      ?? (ledger.lastTurn?.sessionId === id ? ledger.lastTurn : null);
    const session = panelSessions.get(id);
    const label = labelForSessionId(id);
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
        ledger.lastTurn?.sessionId ?? null,
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
    const target = theaterNavigation.actionTarget(ledger.lastTurn?.sessionId ?? null);
    return target && !dismissedSessionIds.has(target) ? target : null;
  }

  // Space remains the guaranteed stop while reciting or mid-exchange. Unlike
  // mode controls, it intentionally drains/submits every already-captured tail.
  function stopReciting(src: string): void {
    // Space remains the guaranteed stop even when an instant takeover is
    // queued behind the old exchange's deliberately un-killed Whisper job.
    cancelQueuedWakes();
    voice.stop(src);
  }

  const theaterControls: TheaterControlCallbacks = {
    manualSessionId: () => theaterMode
      ? theaterNavigation.manualControlTarget()
      : cursorAuto ? null : selectedId,
    globalPaused: () => pause.paused,
    sessionPaused: (id) => pausedSessionIds.has(id),
    setGlobalPaused: (next) => enqueue({
      type: next ? "pause" : "resume",
      sessionId: "",
      label: "",
      announce: "",
    }),
    setSessionPaused: setSessionPausedFrom,
  };

  // Interactive keys when running in a terminal.
  const dispatchTerminalInput = shouldDispatchTerminalInput(rendererSelection.kind);
  // Raw input keeps Ctrl-C in the same explicit shutdown path as q. Both
  // rendered dashboards dispatch their advertised controls; headless does not.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (d) => {
      if (!dispatchTerminalInput) return;
      const { events, rest } = mouseParser.feed(d.toString());
      if (
        theaterMode
        && !settingsOverlay?.isOpen()
        && !sessionActionsOverlay?.isOpen()
        && !restoreSessionsOverlay?.isOpen()
        && !sessionStartOverlay?.isOpen()
        && !terminalComposer?.isOpen()
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
      if (restoreSessionsOverlay?.handleKey(c)) return;
      if (sessionStartOverlay?.handleKey(c)) return;
      if (terminalComposer?.isOpen() && c === " " && eventQueue.busy()) {
        stopReciting("spacebar");
        return;
      }
      if (terminalComposer?.isOpen() && c === "\x14") {
        const sessionId = terminalComposer.model()?.target.sessionId;
        if (sessionId) dictateToTerminalComposer(sessionId);
        return;
      }
      if (terminalComposer?.handleKey(c)) return;
      const terminalQuestion = answerableTerminalQuestion(lastPanelModel);
      if (terminalQuestionController?.handleKey(
        c,
        terminalQuestion,
        (text) => terminalQuestion
          ? injectTerminalPrompt(terminalQuestion, text)
          : false,
      )) return;
      if (theaterMode && c === ",") {
        settingsOverlay?.open();
        return;
      }
      if (theaterMode && c === "n") {
        sessionStartOverlay?.open();
        return;
      }
      if (theaterMode && c === "i") {
        const sessionId = theaterActionTarget();
        if (sessionId) {
          terminalComposer?.open({
            sessionId,
            label: labelForSessionId(sessionId),
          }, lastPanelModel?.live.dictated?.id ?? 0);
        } else {
          log("park a session before opening the prompt line");
        }
        return;
      }
      if (theaterMode && c === "\r") {
        const sessionId = theaterActionTarget();
        if (sessionId) {
          sessionActionsOverlay?.open({
            sessionId,
            label: labelForSessionId(sessionId),
          });
          return;
        }
      }
      if (theaterMode && c === "u") {
        restoreSessionsOverlay?.open(
          [...dismissedSessionIds].map((sessionId) => ({
            sessionId,
            label: labelForSessionId(sessionId),
          })),
        );
        return;
      }
      if (c === " ") {
        // Same question as the socket path: an open mic is what space closes,
        // and a mic opened by the instant path leaves `busy` false. Without
        // `voice.capturing()` this fell through and opened a SECOND wake while
        // the first was still listening.
        if (eventQueue.busy() || voice.capturing()) stopReciting("spacebar");
        else if (theaterMode && theaterActionTarget()) dictateToTerminalComposer(theaterActionTarget()!);
        else if (selectedId) wakeBySessionId(selectedId); // talk to the selected session
        else enqueue({ type: "wake", sessionId: "", label: "", announce: "", origin: "user" }); // else the last-announced
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
      else if (theaterMode && c === "x") {
        const sessionId = theaterActionTarget();
        if (!sessionId) log("nothing to interrupt — park a session first");
        else enqueue({
          type: "interrupt",
          sessionId,
          label: labelForSessionId(sessionId),
          announce: "",
          origin: "user",
        });
      }
      // The deliverable's link is the row's to consume: `o` hands it to macOS.
      else if (theaterMode && c === "o") log(openTheaterReview(theaterActionTarget()));
      else if (dispatchTheaterControlKey(c, theaterControls)) {}
      else if (c === "?" || c === "h") {
        revealLogPane();
        printHelp();
      }
      else if (c === "q" || c === "\u0003") void shutdown();
    });
  }
}

function printHelp(): void {
  logAbove(dashboardHelpText());
}

function log(msg: string): void {
  // Date first, because this file is not a session — it is five days long.
  //
  // It carried the time only, and the log is never rotated, so entries from
  // different days sat next to each other looking simultaneous. That is not
  // theoretical: investigating why conch spoke aloud, I read "manual — holding
  // honeyb" as current evidence twice, and both lines were from the previous
  // day. A timestamp that can mislead the person reading it is worse than no
  // timestamp, because it is trusted.
  const now = new Date();
  const day = `${now.getMonth() + 1}/${now.getDate()}`;
  const t = now.toTimeString().slice(0, 8);
  logAbove(`[conch ${day} ${t}] ${msg}`);
}
