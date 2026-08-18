import { createServer, connect } from "node:net";
import { appendFileSync } from "node:fs";
import { currentTurnText } from "./transcript-turn.ts";
import {
  chmodSync, existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
import { ManagedTtsWorker, resolveMlxAudioPython } from "./tts-worker.ts";
import {
  listenGap,
  listenOnce,
  armBargeRecorder,
  hasActiveRecorders,
  killActiveRecorders,
  createDictationSession,
  type ListenHooks,
  type RuntimeDictationSession,
} from "./listen.ts";
import type { RecorderHandle } from "./dictation-controller.ts";
import { injectText, injectKey, revealSessionWindow, toClipboard } from "./inject.ts";
import { classify, classifyReadingGap, parseNameAddress, wordOverlapRatio } from "./commands.ts";
import { isCodexTranscriptPath, lastAssistantText, splitSentences, stripMarkdown, firstSentences, countCoveredSentences, userRespondedSince, transcriptMark } from "./snippet.ts";
import { PhoneUploads } from "./phone-uploads.ts";
import { CONCH_DATA } from "./config.ts";
import {
  latestAnswerableQuestion,
  publishedConversation,
  readConversationTail,
  type Conversation,
} from "./conversation.ts";
import { readSessionContextUsage, type SessionContextUsage } from "./context-meter.ts";
import { appendConchError, clipboardFallbackError } from "./app-errors.ts";
import { closeTerminalSession, startTerminalSession } from "./session-lifecycle.ts";
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
import { recordTelemetry } from "./telemetry.ts";
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
import { askClaude, type AskClaude } from "./model.ts";
import { routeVoicePrompt } from "./voice-qa.ts";
import {
  whisperServerClient,
  type WhisperRecoveryReason,
} from "./transcribe.ts";
import {
  prepareLogFile,
  clearReadingProgress,
  clearTheaterSelection,
  configureRenderer,
  getLiveState,
  installRendererLifecycle,
  logAbove,
  logsShown,
  onLiveChange,
  onLiveDataChange,
  publishSessionsFile,
  renderPanel,
  resizeRenderer,
  scrollTheaterPane,
  setKeybar,
  setLogsVisible,
  setReadingProgress,
  setState,
  setTranscriptPrefix,
  shouldDispatchTerminalInput,
  theaterPointerEvent,
  type ConchState,
} from "./status.ts";
import {
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
  carriedReview,
  latestLatchedState,
  panelReplyText,
  numberPanelSessionRows,
  previewForPanelSelection,
  refreshPublishedConversationState,
  type NumberedPanelSessionRow,
  type PanelModel,
  type PublishedState,
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
  markQueuedWakesForControl,
  normalizeLegacyModeControl,
  type InstantAudioCommand,
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
  classifySpokenChoice,
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
  isControlMessageCandidate,
  loadSettingResolutions,
  loadSettingsFile,
  resolveSettingFromLoaded,
  settingsPathFor,
  unsetSetting,
  validateControlMessage,
  validateRuntimeControlMessage,
  validateSessionControlMessage,
  writeSetting,
  type ControlResponse,
  type ConfigAck,
  type ConfigControlMessage,
  type ConfigControlResponse,
  type ConfigSnapshot,
  type SettingKey,
  type SettingResolution,
  type SettingValue,
  type HandoffOrder,
  type SessionControlMessage,
  type SessionControlResponse,
  type RuntimeControlMessage,
} from "./settings.ts";
import { SettingsOverlay } from "./settings-overlay.ts";
import {
  invokeSessionAction,
  RestoreSessionsOverlay,
  SessionActionsOverlay,
  type SessionActionsController,
  type SessionActionsTarget,
} from "./session-actions-overlay.ts";
import { createPublishThrottle } from "./publish-throttle.ts";
import {
  readResumableSessionsResult,
  type ResumableSessionsRead,
} from "./resumable.ts";

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

export interface ConfigController {
  handle(message: ConfigControlMessage): ConfigControlResponse;
}

export interface ConfigControlPersistence {
  settingsPath: string;
  set(path: string, key: unknown, value: unknown): unknown;
  unset(path: string, key: unknown): unknown;
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

export type SocketControlDispatch =
  | { handled: false }
  | { handled: true; response: ControlResponse };

export interface SessionCommandPauseLifecycle {
  open(): void;
  close(): void;
}

export interface SessionCommandDispatchOptions {
  controller: SessionActionsController;
  pause: SessionCommandPauseLifecycle;
  targetForSessionId(sessionId: string): SessionActionsTarget | null;
  isDismissed?(sessionId: string): boolean;
}

function sessionCommandError(error: unknown): SessionControlResponse {
  return {
    kind: "session-error",
    error: error instanceof Error ? error.message : String(error),
  };
}

function sessionCommandAck(
  message: SessionControlMessage,
  changed: boolean,
  label?: string,
): SessionControlResponse {
  return {
    kind: "session-ack",
    sessionId: message.sessionId,
    command: message.command,
    ...(label ? { label } : {}),
    changed,
  };
}

/** Closed, synchronous routing through the same controller used by the terminal overlay. */
function applySessionControlMessage(
  message: SessionControlMessage,
  options: SessionCommandDispatchOptions,
): SessionControlResponse {
  const { controller } = options;
  const target = options.targetForSessionId(message.sessionId);

  if (message.command === "restore") {
    const result = invokeSessionAction(
      controller,
      target ?? { sessionId: message.sessionId, label: "" },
      { command: "restore" },
    );
    const restored = options.targetForSessionId(message.sessionId) ?? target;
    return sessionCommandAck(message, result === true, restored?.label);
  }
  if (!target) return sessionCommandAck(message, false);

  switch (message.command) {
    case "rename": {
      const stored = invokeSessionAction(
        controller,
        target,
        { command: "rename", label: message.label },
      );
      const current = options.targetForSessionId(message.sessionId);
      const label = current?.label
        ?? (typeof stored === "string" && stored.trim() ? stored : message.label);
      return sessionCommandAck(message, label !== target.label, label);
    }
    case "set-voice": {
      const result = invokeSessionAction(
        controller,
        target,
        { command: "set-voice", voice: message.voice },
      );
      const current = options.targetForSessionId(message.sessionId) ?? target;
      return sessionCommandAck(message, result !== false, current.label);
    }
    case "reset-voice": {
      const result = invokeSessionAction(
        controller,
        target,
        { command: "reset-voice" },
      );
      const current = options.targetForSessionId(message.sessionId) ?? target;
      return sessionCommandAck(message, result !== false, current.label);
    }
    case "prioritize": {
      const before = controller.isPrioritized(message.sessionId);
      const result = invokeSessionAction(
        controller,
        target,
        { command: "prioritize", value: message.value },
      );
      const after = controller.isPrioritized(message.sessionId);
      const current = options.targetForSessionId(message.sessionId) ?? target;
      return sessionCommandAck(
        message,
        typeof result === "boolean" ? result : before !== after,
        current.label,
      );
    }
    case "dismiss": {
      if (options.isDismissed?.(message.sessionId)) {
        return sessionCommandAck(message, false, target.label);
      }
      const result = invokeSessionAction(
        controller,
        target,
        { command: "dismiss" },
      );
      const current = options.targetForSessionId(message.sessionId) ?? target;
      return sessionCommandAck(message, result !== false, current.label);
    }
  }
}

/**
 * Validate hostile input and guarantee the owner-keyed silent pause is released,
 * including when a controller mutation throws.
 */
export function dispatchSessionControlMessage(
  value: unknown,
  options: SessionCommandDispatchOptions,
): SessionControlResponse {
  const validated = validateSessionControlMessage(value);
  if (!validated.ok) return { kind: "session-error", error: validated.err };

  try {
    options.pause.open();
    try {
      return applySessionControlMessage(validated.value, options);
    } finally {
      options.pause.close();
    }
  } catch (error) {
    return sessionCommandError(error);
  }
}

/** Distinguish config control before any value can be cast into TurnEvent. */
export function dispatchControlMessage(
  value: unknown,
  controller: ConfigController,
  sessionOptions?: SessionCommandDispatchOptions,
  configPersistence?: ConfigControlPersistence,
): SocketControlDispatch {
  if (!isControlMessageCandidate(value)) return { handled: false };
  const validated = validateControlMessage(value);
  if (!validated.ok) {
    const sessionCandidate = socketRecord(value) && value.kind === "session-command";
    return {
      handled: true,
      response: sessionCandidate
        ? { kind: "session-error", error: validated.err }
        : { kind: "config-error", error: validated.err },
    };
  }
  if (validated.value.kind === "session-command") {
    return {
      handled: true,
      response: sessionOptions
        ? dispatchSessionControlMessage(validated.value, sessionOptions)
        : { kind: "session-error", error: "session commands are unavailable" },
    };
  }
  if (
    validated.value.kind === "resumable"
    || validated.value.kind === "session-start"
    || validated.value.kind === "session-close"
    || validated.value.kind === "app-error"
  ) return { handled: false };

  if (validated.value.kind !== "get-config" && configPersistence) {
    try {
      if (validated.value.kind === "set-config") {
        configPersistence.set(
          configPersistence.settingsPath,
          validated.value.key,
          validated.value.value,
        );
      } else {
        configPersistence.unset(
          configPersistence.settingsPath,
          validated.value.key,
        );
      }
    } catch (error) {
      return {
        handled: true,
        response: {
          kind: "config-error",
          error: `not saved: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }
  return { handled: true, response: controller.handle(validated.value) };
}

export interface RuntimeControlDispatchOptions {
  listResumable(
    message: Extract<RuntimeControlMessage, { kind: "resumable" }>,
  ): ResumableSessionsRead | Promise<ResumableSessionsRead>;
  start(message: Extract<RuntimeControlMessage, { kind: "session-start" }>): void | Promise<void>;
  close(sessionId: string): void | Promise<void>;
  report(message: Extract<RuntimeControlMessage, { kind: "app-error" }>): void | Promise<void>;
}

/** Process/UI controls stay outside the synchronous settings controller so AppleScript cannot block config reads. */
export async function dispatchRuntimeControlMessage(
  value: unknown,
  options: RuntimeControlDispatchOptions,
): Promise<SocketControlDispatch> {
  if (!socketRecord(value) || (
    value.kind !== "session-start"
    && value.kind !== "session-close"
    && value.kind !== "app-error"
    && value.kind !== "resumable"
  )) return { handled: false };

  const validated = validateRuntimeControlMessage(value);
  if (!validated.ok) {
    return { handled: true, response: { kind: "session-error", error: validated.err } };
  }
  const message = validated.value;
  try {
    if (message.kind === "resumable") {
      const result = await options.listResumable(message);
      return {
        handled: true,
        response: {
          kind: "resumable",
          sessions: result.sessions,
          complete: result.complete,
        },
      };
    }
    if (message.kind === "session-start") {
      await options.start(message);
      return {
        handled: true,
        response: {
          kind: "session-started",
          backend: message.backend,
          resumed: Boolean(message.resumeSessionId),
        },
      };
    }
    if (message.kind === "session-close") {
      await options.close(message.sessionId);
      return {
        handled: true,
        response: { kind: "session-closed", sessionId: message.sessionId },
      };
    }
    await options.report(message);
    return { handled: true, response: { kind: "app-error-ack" } };
  } catch (error) {
    return { handled: true, response: sessionCommandError(error) };
  }
}

const TURN_EVENT_TYPES = new Set<TurnEvent["type"]>([
  "inject",
  "interrupt",
  "turn-end",
  "needs-you",
  "wake",
  "recite",
  "spacebar",
  "mute",
  "unmute",
  "pause",
  "resume",
  "speak",
  "working",
]);

const SPARSE_TURN_EVENT_TYPES = new Set<TurnEvent["type"]>([
  // Stopping a session needs only to know WHICH session; the label and the
  // announce text every other event carries would be ceremony.
  "interrupt",
  "wake",
  "recite",
  "spacebar",
  "mute",
  "unmute",
  "pause",
  "resume",
]);

export type SocketTurnEventValidation =
  | { ok: true; value: TurnEvent }
  | { ok: false; err: string };

export type AudioSink = "mac" | "phone";

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

/** Sink-aware reservation seam, exported so the post-await race stays tested. */
export async function reserveNormalMicForSink(options: {
  sink(): AudioSink;
  shuttingDown(): boolean;
  setReserved(value: boolean): void;
  quiescent(): Promise<void>;
}): Promise<boolean> {
  if (options.sink() === "phone") return false;
  options.setReserved(true);
  await options.quiescent();
  if (!options.shuttingDown() && options.sink() === "mac") return true;
  options.setReserved(false);
  return false;
}

export type PublishedInjectScope =
  | { ok: true; value: TurnEvent }
  | { ok: false; err: string };

/** Replace every caller-controlled routing field with daemon-owned session data. */
export function scopePublishedInjectEvent(
  event: TurnEvent,
  published: Pick<PublishedState, "rows"> | null,
  canonical: {
    label?: string;
    cwd?: string;
    pid?: number;
    transcriptPath?: string;
  } = {},
  now = Date.now(),
): PublishedInjectScope {
  const sessionId = event.sessionId.trim();
  const suppliedLabel = event.label.trim();
  const announce = event.announce.trim();
  if (!sessionId) return { ok: false, err: "sessionId is required for inject" };
  if (!suppliedLabel) return { ok: false, err: "label is required for inject" };
  if (!announce) return { ok: false, err: "announce is required for inject" };
  const row = published?.rows.find((candidate) => candidate.id === sessionId);
  if (!row) return { ok: false, err: "inject target is not a live published session" };

  const {
    pid: _callerPid,
    cwd: _callerCwd,
    transcriptPath: _callerTranscriptPath,
    eventAt: _callerEventAt,
    ...safe
  } = event;
  return {
    ok: true,
    value: {
      ...safe,
      sessionId,
      label: canonical.label?.trim() || row.label || suppliedLabel,
      announce,
      eventAt: now,
      ...(canonical.cwd ? { cwd: canonical.cwd } : {}),
      ...(canonical.pid !== undefined ? { pid: canonical.pid } : {}),
      ...(canonical.transcriptPath ? { transcriptPath: canonical.transcriptPath } : {}),
    },
  };
}

function socketRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate and normalize the newline-delimited TurnEvent wire shape. */
export function validateSocketTurnEvent(value: unknown): SocketTurnEventValidation {
  if (!socketRecord(value)) return { ok: false, err: "turn event must be a JSON object" };
  if (typeof value.type !== "string" || !TURN_EVENT_TYPES.has(value.type as TurnEvent["type"])) {
    return { ok: false, err: "turn event type is missing or unknown" };
  }
  const wireType = value.type as TurnEvent["type"];
  const type = normalizeLegacyModeControl(wireType);

  for (const field of ["sessionId", "label", "cwd", "announce", "transcriptPath", "ntype", "voice"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      return { ok: false, err: `${field} must be a string` };
    }
  }
  for (const field of ["pid", "mark", "eventAt"] as const) {
    if (
      value[field] !== undefined
      && (typeof value[field] !== "number" || !Number.isFinite(value[field]))
    ) {
      return { ok: false, err: `${field} must be a finite number` };
    }
  }
  if (value.backgroundWork !== undefined && value.backgroundWork !== true) {
    return { ok: false, err: "backgroundWork must be true when present" };
  }
  if (value.review !== undefined) {
    if (!socketRecord(value.review) || typeof value.review.summary !== "string") {
      return { ok: false, err: "review must contain a string summary" };
    }
    if (value.review.link !== undefined && typeof value.review.link !== "string") {
      return { ok: false, err: "review link must be a string" };
    }
  }

  // Hook/state traffic and explicit speech retain the original complete shape.
  // Dashboard controls are intentionally sparse and normalized for the daemon.
  if (!SPARSE_TURN_EVENT_TYPES.has(wireType)) {
    for (const field of ["sessionId", "label", "announce"] as const) {
      if (typeof value[field] !== "string") {
        return { ok: false, err: `${field} is required for ${type}` };
      }
      if (type === "inject" && value[field].trim().length === 0) {
        return { ok: false, err: `${field} must not be empty for inject` };
      }
    }
  } else if (
    (type === "wake" || type === "recite" || type === "interrupt")
    && typeof value.sessionId !== "string"
  ) {
    return { ok: false, err: `sessionId is required for ${type}` };
  }

  // `origin` decides whether manual mode will open the mic, so it is the one
  // field where a malformed value must not be carried through as truthy junk.
  if (value.origin !== undefined && value.origin !== "user" && value.origin !== "agent") {
    return { ok: false, err: "origin must be \"user\" or \"agent\"" };
  }

  return {
    ok: true,
    value: {
      ...value,
      type,
      sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
      label: typeof value.label === "string" ? value.label : "",
      announce: typeof value.announce === "string" ? value.announce : "",
    } as TurnEvent,
  };
}

/** One boundary for hostile socket input plus daemon-owned phone inject routing. */
export function validateAndScopeSocketTurnEvent(
  value: unknown,
  published: Pick<PublishedState, "rows"> | null,
  canonicalFor: (sessionId: string) => {
    cwd?: string;
    pid?: number;
    transcriptPath?: string;
  } = () => ({}),
  now = Date.now(),
): SocketTurnEventValidation {
  const validated = validateSocketTurnEvent(value);
  if (!validated.ok || validated.value.type !== "inject") return validated;
  const sessionId = validated.value.sessionId.trim();
  const row = published?.rows.find((candidate) => candidate.id === sessionId);
  return scopePublishedInjectEvent(
    validated.value,
    published,
    row ? { label: row.label, ...canonicalFor(sessionId) } : {},
    now,
  );
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
 * Mutate the queued object itself: ordering and manual-mode replay both
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

export interface TargetedAudioCommandContext {
  session?: Pick<SessionInfo, "cwd" | "pid"> | null;
  known?: TurnEvent | null;
  label?: string;
  transcriptPath?: string;
}

/** Fill the daemon-owned routing metadata omitted by lightweight dashboard clients. */
export function enrichTargetedAudioCommand(
  event: InstantAudioCommand,
  context: TargetedAudioCommandContext,
): InstantAudioCommand {
  const known = context.known ?? undefined;
  const session = context.session ?? undefined;
  const transcriptPath = event.transcriptPath
    || known?.transcriptPath
    || context.transcriptPath;
  return {
    ...known,
    ...event,
    label: event.label || context.label || known?.label || event.sessionId.slice(0, 8),
    announce: event.announce ?? "",
    cwd: event.cwd ?? session?.cwd ?? known?.cwd,
    pid: event.pid ?? session?.pid ?? known?.pid,
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(event.type === "recite" ? { mark: undefined } : {}),
  };
}

export interface SocketTurnEventCallbacks {
  busy(): boolean;
  stopSpacebar(): void;
  setSessionPaused(sessionId: string, paused: boolean): void;
  isDismissedSession?(sessionId: string): boolean;
  enrichAudioCommand(event: InstantAudioCommand): InstantAudioCommand;
  enqueueInstant(event: InstantAudioCommand): void;
  enqueue(event: TurnEvent): void;
}

/** Sparse dashboard commands carry only identity; CLI/MCP commands pre-resolve routing. */
export function isLightweightTargetedAudioCommand(event: InstantAudioCommand): boolean {
  return event.cwd === undefined
    && event.pid === undefined
    && event.transcriptPath === undefined
    && event.mark === undefined;
}

/** Route dashboard/CLI socket commands through the same instant seams as terminal keys. */
export function dispatchSocketTurnEvent(
  incoming: TurnEvent,
  callbacks: SocketTurnEventCallbacks,
): void {
  const event = incoming.type === normalizeLegacyModeControl(incoming.type)
    ? incoming
    : { ...incoming, type: normalizeLegacyModeControl(incoming.type) };
  if (event.type === "spacebar") {
    if (callbacks.busy()) callbacks.stopSpacebar();
    return;
  }

  if (event.sessionId) {
    if (callbacks.isDismissedSession?.(event.sessionId)) return;
    if (event.type === "pause" || event.type === "resume") {
      callbacks.setSessionPaused(event.sessionId, event.type === "pause");
      return;
    }
    if (event.type === "wake" || event.type === "recite") {
      const command = event as InstantAudioCommand;
      if (isLightweightTargetedAudioCommand(command)) {
        callbacks.enqueueInstant(callbacks.enrichAudioCommand(command));
      } else {
        callbacks.enqueue(command);
      }
      return;
    }
  }

  callbacks.enqueue(event);
}

/** Ordinals are safe to rewrite only while the transcript still contains an unanswered option row. */
export function choiceReplyForConversation(heard: string, conversation: Conversation): string {
  const question = latestAnswerableQuestion(conversation);
  if (!question) return heard;
  const selected = classifySpokenChoice(heard, question.options);
  return selected === null ? heard : question.options[selected]!.label;
}

export type NameAddressRoute = {
  kind: "deliver";
  event: TurnEvent;
  text: string;
  addressed?: { name: string; label: string };
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
    if (!candidate.rest) continue;

    const label = labelFor(session, session.cwd);
    const transcriptPath = transcriptFor(claudeDir, session.sessionId);
    const addressed = { name: candidate.name, label };

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
  const duplicateIndex = event.type === "inject" || (event.type === "speak" && !event.sessionId)
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

  prune(liveIds: ReadonlySet<string>): void {
    for (const id of this.#latest.keys()) {
      if (!liveIds.has(id)) this.#latest.delete(id);
    }
  }
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
  if (session.backend === "codex" && !session.pid) {
    if (reported.has(session.sessionId)) return false;
    reported.add(session.sessionId);
    return true;
  }
  reported.delete(session.sessionId);
  return false;
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
  // cannot publish another turn's committed prefix.
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
): PublishedState {
  return buildPublishedState(
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

/**
 * Is a live daemon already listening on this socket?
 *
 * The file existing means nothing — a unix socket outlives the process that
 * created it, which is why "unlink and rebind" felt safe and was not. Connect
 * instead: only an answer proves someone is home. A refusal (ECONNREFUSED)
 * means the file is a leftover and is safe to remove.
 */
export async function anotherDaemonIsListening(
  socketPath: string,
  timeoutMs = 500,
): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = connect({ path: socketPath });
    const finish = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      resolve(answer);
    };
    // A socket that accepts but never speaks is still an owner; treat a
    // timeout as OCCUPIED rather than stale, because deleting a live
    // daemon's socket is the failure this exists to prevent.
    const timer = setTimeout(() => finish(true), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function runDaemon(cfg: Config): Promise<void> {
  prepareLogFile();
  // Read cfg.haikuTimeoutSecs at call time — the config socket mutates cfg in
  // place for live settings, so a fresh read here honors `conch set haiku-timeout`
  // without a daemon restart.
  const askHaiku: AskClaude = (prompt, opts) =>
    askClaude(prompt, { timeoutMs: cfg.haikuTimeoutSecs * 1000, ...opts });
  const rendererSelection = configureRenderer();
  const rendererLifecycle = installRendererLifecycle(rendererSelection.renderer);
  const theaterMode = rendererSelection.kind === "theater";
  const resetConversationTranscriptPrefix = (): void => setTranscriptPrefix("");
  const resetReadingProgress = (): void => clearReadingProgress();
  const updateReadingProgress = (text: string, spokenChars: number): void => {
    setReadingProgress(text, spokenChars);
  };
  const diagnosticsEnabled = recorderDiagnosticsEnabled();
  const queue: TurnEvent[] = [];
  let busy = false;
  let busyLabel = "none";
  let lastTurn: TurnEvent | null = null;
  const persisted = readState(); // survives restarts — see STATE_FILE
  let pause!: PauseController; // "away" mode: quiet, but HOLD finished sessions to replay on resume
  let stopKey = false; // spacebar pressed while reciting — the guaranteed interrupt
  let micOpen = false; // true while a dictation/permission listen is in flight — spacebar closes it
  let activeDictation: {
    session: RuntimeDictationSession;
    requestExternal(action: ExternalDictationAction, barrierReason?: string): void;
    done: Promise<void>;
  } | null = null;
  const audioLease = new AudioSinkLease();
  let shuttingDown = false;
  let normalMicReserved = false;
  let bargeHandoffOpen = false;
  const injectedAt = new Map<string, number>(); // session -> last time conch drove it
  const pending = new Map<string, TurnEvent>(); // sessions that finished while paused — latest per session
  const resumeTransitions = new WeakMap<TurnEvent, Promise<PauseResumeResult>>();
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
  let numberedSessionRows: NumberedPanelSessionRow[] = [];
  let selectedId: string | null = null;
  let cursorAuto = true;
  let panelOpen = true;
  const theaterNavigation = new TheaterNavigation(() => void renderSessionPanel());
  const mouseParser = new SgrMouseParser();
  let settingsOverlay: SettingsOverlay | null = null;
  let sessionActionsOverlay: SessionActionsOverlay | null = null;
  let restoreSessionsOverlay: RestoreSessionsOverlay | null = null;
  let meetingMic: MicClaimPoller | null = null;
  // Per-session manual mode holds only the newest turn for replay.
  const pausedSessionIds = new Set<string>();
  // Sessions resumed by name out of a global pause. Cleared on every global
  // edge: a new pause pauses everything, and a global resume makes the
  // exemption meaningless.
  const resumedSessionIds = new Set<string>();
  const prioritizedSessionIds = new Set<string>();
  const dismissedSessionIds = new Set<string>();
  const sessionHeldTurns = new Map<string, TurnEvent>();
  const dismissedHeldTurns = new Map<string, TurnEvent>();
  const latestTurnBySession = new Map<string, TurnEvent>();
  const cancelledAudioCommands = new WeakSet<TurnEvent>();
  const instantQueueBarriers = new WeakSet<TurnEvent>();
  const cancelQueuedAudioCommand = (event: TurnEvent): void => {
    cancelledAudioCommands.add(event);
    instantQueueBarriers.delete(event);
  };
  // The turn currently being handled, used by PauseController's scoped edge.
  let recitingEvent: TurnEvent | null = null;
  let handlingEvent: TurnEvent | null = null;
  let handlingPauseGeneration: number | null = null;
  function labelForSessionId(id: string): string {
    const session = panelSessions.get(id);
    const known = latestTurnBySession.get(id)
      ?? (recitingEvent?.sessionId === id ? recitingEvent : null)
      ?? (handlingEvent?.sessionId === id ? handlingEvent : null)
      ?? (lastTurn?.sessionId === id ? lastTurn : null);
    return panelLabels.get(id)
      ?? sessionStates.get(id)?.label
      ?? known?.label
      ?? (session ? sessionLabel(session, session.cwd) : id.slice(0, 8));
  }
  function isKnownSessionId(id: string): boolean {
    return panelSessions.has(id)
      || sessionStates.has(id)
      || latestTurnBySession.has(id)
      || dismissedSessionIds.has(id)
      || pausedSessionIds.has(id)
      || prioritizedSessionIds.has(id)
      || sessionHeldTurns.has(id)
      || dismissedHeldTurns.has(id)
      || pending.has(id)
      || recitingEvent?.sessionId === id
      || handlingEvent?.sessionId === id;
  }
  function sessionActionTarget(sessionId: string): SessionActionsTarget | null {
    return isKnownSessionId(sessionId)
      ? { sessionId, label: labelForSessionId(sessionId) }
      : null;
  }
  const sessionModalOpen = (): boolean =>
    Boolean(
      settingsOverlay?.isOpen()
      || sessionActionsOverlay?.isOpen()
      || restoreSessionsOverlay?.isOpen()
    );
  const explicitQuietOverrideBlocked = (): boolean =>
    sessionModalOpen() || Boolean(meetingMic?.claimed);

  const normalMicOpen = (): boolean => Boolean(
    activeDictation?.session.micOpen || micOpen || normalMicReserved || bargeHandoffOpen
  );
  const assertNormalMicClosed = (operation: string): void => assertAudioGate(normalMicOpen, operation);
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
  const speech = new SpeechManager(
    { speakCancellable: backendSpeakCancellable, stopSpeaking: backendStopSpeaking },
    (operation, output) => withNormalMicClosed(
      normalMicOpen,
      operation,
      () => audioLease.sink === "phone"
        ? Promise.resolve(undefined as Awaited<ReturnType<typeof output>>)
        : output(),
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
    currentTurn: () => recitingEvent ?? handlingEvent,
    holdableTurn: (current) => current.type === "wake"
      ? latestTurnBySession.get(current.sessionId) ?? null
      : current,
    currentTurnGeneration: () => handlingPauseGeneration,
    activeSession: () => activeDictation?.session ?? null,
    cancelCurrentSpeech: () => speech.cancelCurrent(),
    cancelPendingAudio: () => speech.cancelPendingAudio(),
    persist: (paused) => writeState({ paused }),
    render: () => void renderSessionPanel(),
    setModeState: (paused) => setState(paused ? "paused" : "idle"),
    log,
    speak: (text) => speak(cfg, text),
    liveSessionIds: async () => (await registrySnapshot(cfg.claudeDir))?.liveIds ?? null,
    userRespondedSince: (event) => userRespondedSince(event.transcriptPath, event.mark),
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
    resumedSessionIds,
    sessionHeldTurns,
    enqueue,
    markInstantQueued: (event) => instantQueueBarriers.add(event),
    cancelQueuedWakes: (sessionId) =>
      markQueuedWakesForControl(
        queue,
        cancelQueuedAudioCommand,
        sessionId,
      ),
    labelFor: labelForSessionId,
    log,
    render: () => void renderSessionPanel(),
  });
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

  const reserveNormalMic = async (): Promise<boolean> => {
    // The phone holding the voice means it holds the EAR too. Gating only the
    // announce path left the Mac's mic opening anyway: it transcribed Tyler
    // from across the room, tried to inject, failed to the clipboard, and lost
    // the words — while the phone was delivering the same sentence correctly.
    // Two open mics is not a degraded mode, it is a broken one.
    return reserveNormalMicForSink({
      sink: () => audioLease.sink,
      shuttingDown: () => shuttingDown,
      setReserved: (value) => { normalMicReserved = value; },
      quiescent: () => speech.quiescent(),
    });
  };

  const speak = async (
    speechCfg: Config,
    text: string,
    label = "",
    // True when a person asked for this sound directly — a recite, an explicit
    // `conch speak`. Those are answers, not conch volunteering, so manual mode
    // does not silence them.
    volunteered = false,
  ): Promise<void> => {
    // The phone owning the voice has to mean it HERE, at the one place every
    // path funnels through. Gating the announce path alone left wake, recite,
    // explicit speak, mode acknowledgements and every error fallback
    // still talking — Tyler heard the Mac and the phone reading the same reply
    // simultaneously. A per-call-site gate is a list you can forget to add to;
    // this is not.
    // The state names the SESSION being read, not the device making the sound.
    // Moving it below the gate stopped the Mac claiming to read while silent,
    // but broke the thing that made it useful: liveGlyph is only set for the
    // ACTIVE row, active is only set when live.state is a live state, so with
    // the phone owning the audio no row was ever marked speaking and the
    // ledger said "Waiting for you" for a session being read aloud.
    //
    // Above the gate, so it is set on both paths. Known limit: while the phone
    // reads, the Mac cannot see when it finishes, so this clears when the Mac
    // would have stopped rather than when the phone actually does. The phone
    // reporting its own speech is the honest fix and is not this change.
    // Never talk over someone who is talking.
    //
    // conch has always guarded the other direction — the mic must not open
    // while TTS is speaking, or the loop hears itself — but nothing stopped
    // speech STARTING while a mic was already open. Tyler was mid-dictation
    // when another session's turn ended and conch began reading it to him,
    // over the top of the sentence he was still speaking.
    //
    // Dropped rather than deferred. The turn stays latched on its row and can
    // be recited whenever he wants it, so nothing is lost that cannot be asked
    // for again — whereas holding audio behind an open mic invites the deadlock
    // where each is waiting on the other.
    if (normalMicOpen()) {
      log(`held "${label || "announcement"}" — the mic is open`);
      return;
    }

    // Manual mode means conch does not speak FIRST. That has to be true here,
    // at the funnel, not only in the announcement queue.
    //
    // The queue is gated, so turn-ends hold correctly — but every direct
    // speak() call went around it: failure lines, acknowledgements, error
    // fallbacks. Tyler heard a session announce "a system dialog is open on the
    // Mac and it's blocking me" while in manual, and diagnosed it exactly:
    // "might be the clipboard thing doesn't listen to being in manual mode?"
    //
    // Deliberately not gated on `spoken`: an explicit `conch speak` and a
    // recite are things a person just asked for out loud, and manual is about
    // conch volunteering, not about refusing to answer.
    if (pause.paused && !volunteered) {
      log(`held "${label || "announcement"}" — manual mode`);
      return;
    }

    setState("speaking", label);
    if (audioLease.sink === "phone") {
      armPhoneSpeechLatch(text);
      return;
    }
    clearPhoneSpeechLatch();
    await speech.speak(speechCfg, text, label);
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
   * Raise a session window unless you're actively typing right now. Read at call
   * time so `conch set reveal-typing-grace` applies live. An unreadable idle
   * time reveals (the raise is the normal behavior; the gate is the exception).
   */
  const revealUnlessTyping = async (pid: number): Promise<void> => {
    if (cfg.revealTypingGraceSecs > 0) {
      const idle = await idleSeconds();
      if (idle !== null && idle < cfg.revealTypingGraceSecs) return;
    }
    await revealSessionWindow(pid);
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
  function latestVisibleTurn(): TurnEvent | null {
    return lastTurn && !dismissedSessionIds.has(lastTurn.sessionId) ? lastTurn : null;
  }

  function enqueue(incoming: TurnEvent): void {
    if (shuttingDown) return;
    const event = incoming.type === normalizeLegacyModeControl(incoming.type)
      ? incoming
      : { ...incoming, type: normalizeLegacyModeControl(incoming.type) };
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
      } else {
        silentPause.recordManualState(true);
      }
      const transition = instantControls.applyGlobal(event.type as "pause" | "resume");
      if (transition) resumeTransitions.set(event, transition);
    }
    insertQueuedEvent(queue, event, instantQueueBarriers);
    void drain();
  }

  async function drain(): Promise<void> {
    // The queue drains one event at a time behind a `busy` flag, so ONE event
    // that never settles silently strands every event after it — injects
    // included. That is what made a message look session-specific when it was
    // not: probes into two different idle sessions both hung, with nothing in
    // the log, because neither ever left the queue.
    traceQueue(busy ? `blocked behind "${busyLabel}" (${queue.length} waiting)` : `drain start (${queue.length})`);
    if (busy) return;
    busy = true;
    try {
      if (shuttingDown) return;
      if (stopKey && queue.length) {
        const skipped = takeNextQueuedEvent(queue, cfg.handoffOrder, prioritizedSessionIds)!;
        stopKey = false;
        log(`⏹ spacebar — skipped queued ${skipped.type} for "${skipped.label}" during TTS startup`);
      }
      while (queue.length) {
        const event = takeNextQueuedEvent(queue, cfg.handoffOrder, prioritizedSessionIds)!;
        try {
          busyLabel = `${event.type}:${event.label}`;
          traceQueue(`handle ${busyLabel}`);
          await handle(event);
          traceQueue(`done ${busyLabel}`);
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

  // The at-rest status reflects the one lossless quiet mode.
  const restState = (): ConchState => (pause.paused ? "paused" : "idle");

  let panelRenderVersion = 0;
  let lastPublishedPanelState: PublishedState | null = null;
  const reportedMissingCodexPid = new Set<string>();
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
            const turn = path ? await currentTurnText(path) : "";
            if (turn) return turn;
            // RAW, not stripMarkdown: the phone renders it, it doesn't speak it.
            const finalMessage = path ? await lastAssistantText(path) : "";
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
      (recitingEvent ?? lastTurn)?.sessionId ?? null,
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
          "Codex row has no pid",
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
      const trackedIds = new Set([
        ...sessionStates.keys(),
        ...pausedSessionIds,
        ...prioritizedSessionIds,
        ...dismissedSessionIds,
        ...sessionHeldTurns.keys(),
        ...dismissedHeldTurns.keys(),
        ...latestTurnBySession.keys(),
        ...pending.keys(),
      ]);
      for (const id of trackedIds) {
        if (liveIds.has(id)) continue;
        sessionStates.delete(id);
        eventOrder.forget(id);
        pausedSessionIds.delete(id);
        resumedSessionIds.delete(id);
        prioritizedSessionIds.delete(id);
        dismissedSessionIds.delete(id);
        sessionHeldTurns.delete(id);
        dismissedHeldTurns.delete(id);
        latestTurnBySession.delete(id);
        pending.delete(id);
      }
      eventOrder.prune(liveIds);
    }
    const live = withoutDismissedSessions(registryLive, dismissedSessionIds);
    const liveState = getLiveState(); // what conch is doing right now, if anything
    const orderedRows = buildPanelRows({
      sessions: live,
      sessionStates,
      pausedSessionIds,
      live: liveState,
      mode: { muted: false, paused: pause.paused, holding: pending.size },
      activeSessionId: null,
      navSelectedId: null,
    });
    const nextActiveSessionId = activeSessionIdForRows(orderedRows, liveState, {
      preferredSessionId: recitingEvent?.sessionId,
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
    const contentEvent = recitingEvent ?? lastTurn;
    // The RAW reply is fetched alongside the spoken one. stripMarkdown exists to
    // make text speakable; handing that same string to a GUI is what made every
    // list render as a literal "- " with no blocks at all.
    // The conversation is read from the same transcript, at the same moment, as
    // the flattened reply beside it — so a viewer can never show a stack that
    // disagrees with the line being spoken.
    const [transcriptReplyRaw, previewRaw, conversation] = await Promise.all([
      contentEvent?.transcriptPath
        ? lastAssistantText(contentEvent.transcriptPath)
        : Promise.resolve(""),
      previewPath ? lastAssistantText(previewPath) : Promise.resolve(""),
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
        const path = (contentEvent?.sessionId === sessionId && contentEvent.transcriptPath)
          || live.find((session) => session.sessionId === sessionId)?.transcriptPath
          || findTranscript(cfg.claudeDir, sessionId);
        if (!path) return Promise.resolve(null);
        return readConversationTail(
          path,
          sessionId,
          isCodexTranscriptPath(path) ? "codex" : "claude",
        ).catch(() => null);
      })(),
    ]);
    // One per visible row. The reads are tail-only and bounded, and doing them
    // together means a viewer can show whichever session it is focused on
    // without the daemon having to guess which that is.
    const conversationsBySession = Object.fromEntries(
      (await Promise.all(
        live.slice(0, MAX_PUBLISHED_CONVERSATIONS).map(async (session) => {
          const path = session.transcriptPath
            ?? findTranscript(cfg.claudeDir, session.sessionId);
          if (!path) return null;
          const read = await readConversationTail(
            path,
            session.sessionId,
            isCodexTranscriptPath(path) ? "codex" : "claude",
          ).catch(() => null);
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
        const context = await readSessionContextUsage(
          path,
          isCodexTranscriptPath(path) ? "codex" : "claude",
        ).catch(() => null);
        return context ? [session.sessionId, context] as const : null;
      }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    );
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
      });
      model.preview = previewForPanelSelection(
        navSelectedId,
        previewId,
        previewText,
        previewRaw,
      );
      model.conversation = conversation ? publishedConversation(conversation) : null;
      model.conversations = conversationsBySession;
      model.settingsOverlay = settingsOverlay?.model() ?? null;
      model.sessionActionsOverlay = sessionActionsOverlay?.model() ?? null;
      model.restoreSessionsOverlay = restoreSessionsOverlay?.model() ?? null;
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
      model.mode = { muted: false, paused: pause.paused, holding: pending.size };
      renderPanel(model);
      lastPublishedPanelState = buildDaemonPublishedState(
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
          live.flatMap((session) =>
            session.transcriptPath ? [[session.sessionId, session.transcriptPath] as const] : []
          ),
        ),
        sessionContexts,
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
        transcriptFor: (sessionId) => findTranscript(cfg.claudeDir, sessionId),
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

  /**
   * What a session actually wants from you.
   *
   * This used to print the notification's internal type with the underscores
   * swapped for spaces, so a session sat there saying "permission prompt". It
   * is wrong twice over: Claude Code fires `permission_prompt` for an
   * `AskUserQuestion` as well, so a plain multiple-choice question announced
   * itself as a permission request — Tyler saw exactly that and said so — and
   * even when it IS a permission prompt, the internal name is not the words a
   * person would use.
   *
   * "Needs an answer" is true of both, which is the point: one honest phrase
   * beats two guesses at which kind of asking this is.
   */
  function describeNeed(ntype: string | undefined): string | undefined {
    switch (ntype) {
      case "permission_prompt":
      case "elicitation_dialog":
        return "needs an answer";
      case "idle_prompt":
        // Already covered by the row being idle; saying it twice adds nothing.
        return undefined;
      default:
        return ntype ? ntype.replace(/_/g, " ") : undefined;
    }
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
    const prior = sessionStates.get(sessionId);
    const carried = carriedReview(prior, status, review);
    const incoming = {
      label,
      status,
      detail: detail ?? carried?.summary,
      at,
      ...(carried ? { review: carried } : {}),
    };
    if (latestLatchedState(prior, incoming) !== incoming) return false;
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
    stopKey = false; // a stale press from a past exchange must not skip this one
    micOpen = false; // no listen in flight yet for this event
    if (event.type === "interrupt") return void (await interruptSession(event));
    if (event.type === "pause") return pause.paused ? pause.announcePaused() : undefined;
    if (event.type === "resume") {
      if (sessionModalOpen() || pause.paused) return;
      const transition = resumeTransitions.get(event);
      const result = transition
        ? await transition
        : { replayed: 0, dropped: 0, cancelled: false };
      return pause.announceResumed(result);
    }
    if (event.type === "inject") {
      // Answering STOPS the reading.
      //
      // Typing into Claude Code directly interrupts a read, because conch
      // watches the transcript for a manual reply. A message sent through conch
      // did not: the reading paused while the keystrokes went in and then
      // carried on, so the one route conch fully controls behaved worse than
      // the one it merely observes. Tyler: "if i send a message via text to a
      // session it should stop reading".
      //
      // Sending IS the interruption — you have already moved on, and no answer
      // to the previous turn is worth hearing over your own next question.
      speech.cancelCurrent();

      // The phone's voice path: text transcribed ON the phone, delivered into
      // the named session through the exact machinery Mac dictation uses —
      // exact-pane focus, confirm-by-transcript, clipboard fallback, telemetry.
      // Name-addressing is deliberately disabled: the published session id is
      // the only target the phone is authorized to drive.
      const target: TurnEvent = {
        ...event,
        type: "turn-end",
      };
      const delivered = await deliver(target, event.announce, undefined, undefined, {
        allowNameAddressing: false,
        allowBlindFallback: false,
      });
      log(`phone inject into "${event.label}" ${delivered ? "delivered" : "failed"}`);
      return;
    }
    if (event.type === "speak") {
      const speechCfg = event.voice ? { ...cfg, ttsVoices: [event.voice] } : cfg;
      // Explicit previews bypass both modal pause gating and a label-keyed
      // persisted pin; an empty selection label makes the one-item ring win.
      // Asked for out loud, so manual does not silence it.
      return speak(speechCfg, event.announce, event.voice ? "" : event.label, true);
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

    // Quiet state belongs to the conversation, not the device currently
    // speaking it. The phone owns playback only; it must not bypass a scoped
    // manual/dismiss gate and make that session audible from another surface.
    const controlledTurn = shouldHandleTurnAudibly(event, cfg.workingMic);
    const audibleTurn = controlledTurn && audioLease.sink === "mac";
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
      resumedSessionIds.delete(event.sessionId);
      prioritizedSessionIds.delete(event.sessionId);
      dismissedSessionIds.delete(event.sessionId);
      sessionHeldTurns.delete(event.sessionId);
      dismissedHeldTurns.delete(event.sessionId);
      pending.delete(event.sessionId);
      if (lastTurn?.sessionId === event.sessionId) lastTurn = null;
      void renderSessionPanel();
      return;
    }
    if (shuttingDown || interruptedByPause() || consumeStopKey()) return;
    if (!eventOrder.isCurrent(event)) return;

    // Dashboard status — visual, and updated even while manual. Ordinary
    // `working` and all `needs-you` events are visual-only. A Stop reclassified
    // as background-working may opt back into the normal bell/voice/mic path.
    if (event.type === "working") {
      if (!setSessionState(event.sessionId, event.label, "working", undefined, event.eventAt)) return;
      if (!audibleTurn) return;
    }
    if (event.type === "needs-you") {
      const kind = describeNeed(event.ntype);
      setSessionState(event.sessionId, event.label, "needs", kind, event.eventAt);
      return; // stripped: no bell, no announcement, no permission mic
    }
    if (event.type === "turn-end" && !setSessionState(
      event.sessionId,
      event.label,
      "waiting",
      event.review?.summary,
      event.eventAt,
      event.review,
    )) return;

    if (cancelledAudioCommands.delete(event)) {
      return log(`cancelled queued ${event.type} for "${event.label}"`);
    }

    const controlDisposition = gateTurnForControls(event, controlledTurn, {
      globalPaused: pause.paused,
      settingsOpen: explicitQuietOverrideBlocked(),
      globalHeldTurns: pending,
      pausedSessionIds,
      resumedSessionIds,
      sessionHeldTurns,
      dismissedSessionIds,
      dismissedHeldTurns,
    });
    if (controlDisposition) {
      if (controlDisposition === "session-dismissed") {
        return log(`dismissed — holding latest turn for "${event.label}"`);
      }
      if (controlledTurn || event.ntype === "idle_prompt") lastTurn = event;
      if (controlDisposition === "session-paused") {
        return log(`⏸ "${event.label}" is manual — park it and press p for auto`);
      }
      void renderSessionPanel();
      return log(`manual — holding "${event.label}" (${pending.size} waiting)`);
    }

    // Nobody's there: don't announce to an empty room, don't open the mic,
    // don't burn battery on sox/whisper. Telegram (the other hook) still
    // pings the phone. `conch wake` always cuts through.
    // Only reach for ioreg when the away-timer is actually armed (default off) —
    if (event.type !== "wake" && event.type !== "recite" && cfg.awayAfterSecs) {
      const idle = await idleSeconds() ?? 0; // null probe → 0 → not away (fail safe)
      if (idle >= cfg.awayAfterSecs) {
        log(`away (idle ${Math.round(idle / 60)}m) — staying quiet for "${event.label}"`);
        if (audibleTurn || event.ntype === "idle_prompt") lastTurn = event; // wake still finds it
        return;
      }
    }

    if (event.type === "recite") {
      const rememberedTurn = latestVisibleTurn();
      const target: TurnEvent | null = event.sessionId
        ? event
        : rememberedTurn
          ? { ...rememberedTurn, type: "recite", announce: "" }
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
        await speak(cfg, `${target.label}:`, target.label, true);
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
      const target = resolveWakeTarget(event, latestVisibleTurn()); // named wake carries its own session
      if (!target) {
        log("wake with nothing to wake — no session has announced yet");
        return void (await speak(cfg, "Nothing to wake. No session has spoken yet.", "", true));
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
          return void (await speak(cfg, "That session is closed.", "", true));
        }
        // Manual mode is a promise that conch does nothing you did not ask
        // for, and opening the mic is the loudest thing it does. Anything conch
        // cannot attribute to a person pressing something is refused, exactly
        // like an announcement — not just agent calls, because the whole
        // complaint was a mic that opened with no visible cause. Default-deny
        // is what makes that a guarantee rather than a list of known senders.
        //
        // Per-session manual counts as manual. Wakes are otherwise treated as
        // explicit overrides that bypass `pausedSessionIds` entirely, which is
        // right for a person and wrong for everyone else: without this an agent
        // could open the mic on the one session you had specifically quieted.
        const sessionIsManual = pause.paused
          || pausedSessionIds.has(target.sessionId);
        if (sessionIsManual && event.origin !== "user") {
          // "refused", not "held": nothing is stored to replay later.
          log(
            `manual — refused wake for "${target.label}"`
            + ` (${event.origin ?? "no origin"}, not you)`,
          );
          return;
        }
        log(`wake -> "${target.label}" (${event.origin ?? "unattributed"})`);
        if (cfg.revealOnTurn && target.pid) void revealSessionWindow(target.pid); // surface it, no focus steal
        resetReadingProgress();
        // The courtesy line must never delay the thing it is announcing.
        //
        // The mic opens AFTER this resolves, so a sick TTS holds it shut:
        // Kokoro has been hard-restarting on this machine and falling back to
        // `say`, which itself has timed out at eighteen seconds. Tyler pressed
        // the mic button and "nothing happened" — the wake had arrived and been
        // handled, and conch was still busy telling him the mic was open.
        //
        // Bounded rather than dropped, and still awaited: opening the mic while
        // the confirmation plays is what makes the loop hear itself, which is
        // the one thing the audio gate exists to prevent. Three seconds is long
        // enough for four words and short enough to feel like a button.
        await Promise.race([
          speak(cfg, `Mic open for ${target.label}.`, target.label, true),
          Bun.sleep(3_000),
        ]);
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
      // you can watch, but WITHOUT stealing focus (AXRaise). Suppressed while
      // you're mid-keystroke: yanking a window forward as you type is the one
      // way a no-focus-steal raise still interrupts you. Explicit wake/recite
      // is never gated — you asked for those.
      if (event.type === "turn-end" && cfg.revealOnTurn && event.pid) {
        void revealUnlessTyping(event.pid);
      }

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
  /** Gated on the sink like `speak`: this one also arms the Mac's recorder. */
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
    // The phone owns the voice AND the ear: this path both speaks and arms the
    // Mac's recorder, so it must return before either.
    if (audioLease.isPhone()) return { heard: "", cut: false };
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
    if (audioLease.isPhone()) return { heard: "", cut: false };
    if (stopKey || interrupted()) return { heard: "", cut: true };
    assertNormalMicClosed("barge-in TTS");
    const result = await speech.runInterruptible(cfg, text, event.label, async (startSpeech) => {
      if (audioLease.isPhone()) return { heard: "", cut: false };
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
        // any completed turn's committed prefix before recording is visible.
        resetConversationTranscriptPrefix();
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
    options: {
      allowNameAddressing?: boolean;
      allowBlindFallback?: boolean;
    } = {},
  ): Promise<boolean> {
    if (event.transcriptPath) {
      try {
        const conversation = await readConversationTail(
          event.transcriptPath,
          event.sessionId,
          isCodexTranscriptPath(event.transcriptPath) ? "codex" : "claude",
        );
        const reply = choiceReplyForConversation(text, conversation);
        if (reply !== text) log(`matched spoken choice -> ${JSON.stringify(reply)}`);
        text = reply;
      } catch {}
    }
    if (options.allowNameAddressing !== false) {
      const addressed = await resolveNameAddressRoute(cfg.claudeDir, event, text);
      if (addressed.addressed) {
        log(`addressed "${addressed.addressed.name}" -> "${addressed.addressed.label}"`);
      }
      event = addressed.event;
      text = addressed.text;
    }

    return routeVoicePrompt(cfg.voiceQa, text, event.transcriptPath, {
      askClaude: askHaiku,
      speak: (answer) => speak(cfg, answer, event.label),
      inject: (prompt) => deliverToSession(
        event,
        prompt,
        diagnosticIds,
        beforeInject,
        options,
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
    options: { allowBlindFallback?: boolean } = {},
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
    const injectStartedAt = Date.now();
    const { via, interrupted, reason } = await injectText(
      cfg,
      event.pid,
      text,
      beforeInject ? commit : undefined,
      { allowBlindFallback: options.allowBlindFallback },
    );
    if (interrupted) return false;

    if (via === "clipboard") {
      // Name the cause: "keystroke-fallback-off" means the session isn't in a
      // tmux pane AND typing is disabled, so EVERY utterance lands here — a
      // config problem, not a transient one. Without this the log line is
      // identical either way and the real cause takes an hour to find.
      log(`injected into "${event.label}" via ${via}${reason ? ` (${reason})` : ""}`);
      recordTelemetry("inject", {
        route: via,
        confirmed: false,
        chars: text.length,
        ...(reason ? { reason } : {}),
      });
      const failure = clipboardFallbackError({
        sessionId: event.sessionId,
        label: event.label,
        cwd: event.cwd,
        reason,
      });
      recordDaemonError(
        failure.operation,
        failure.message,
        failure.sessionId,
        failure.state,
      );
      if (beforeInject && !(await beforeInject())) return false;
      // Name the actual obstacle. A modal dialog on the Mac blocks every
      // AppleScript call for as long as it is up, so this is not a session
      // problem and not something retrying fixes — it stays broken until
      // someone dismisses the popup, and saying so is the difference between
      // a fixable minute and a baffling one.
      await speak(
        cfg,
        reason === "automation-permission-denied"
          ? "macOS is blocking conch from controlling Terminal. Turn conch on under Privacy and Security, Automation."
          : reason === "system-dialog-blocking"
            ? "A system dialog is open on the Mac and it's blocking me. Dismiss it and send again."
            : "Couldn't reach the session's window — your words are on the clipboard, just paste.",
        event.label,
      );
      // NOT delivered. The words are on a clipboard, not in the session, and
      // saying otherwise is the failure that cost Tyler a real message: the
      // phone was told "delivered", cleared his draft, and the text existed
      // only on a Mac he was nowhere near. Whoever is standing at the machine
      // can still paste — that is what the spoken line above is for — but the
      // caller must not be told this reached the agent.
      return false;
    }
    if (via === "none") {
      log(`injected via ${via}`);
      if (beforeInject && !(await beforeInject())) return false;
      await speak(cfg, "Heard you, but I could not find the session's pane.", event.label);
      return false;
    }
    if (beforeCount === null) {
      log(`injected into "${event.label}" via ${via}`); // no transcript to confirm against — trust it
      return true;
    }

    // A busy session cannot be confirmed this way, and demanding it anyway is a
    // trap. Both agents accept typed input mid-turn and queue it themselves,
    // but neither writes the prompt to its transcript until it STARTS that
    // turn — so the mark cannot move, every retry re-presses Return into a
    // working session, and a message that queued perfectly gets reported as
    // failed. The phone then keeps the draft and you send it twice.
    //
    // Only routes that put real keystrokes into a real pane qualify: a blind
    // or clipboard fallback has no such evidence and must still be proven.
    const keysLanded = via === "tmux" || via === "osascript-focused";
    if (keysLanded && panelSessions.get(event.sessionId)?.status === "busy") {
      log(`injected into "${event.label}" via ${via} — queued behind the running turn`);
      recordTelemetry("inject", {
        route: via,
        confirmed: true,
        queued: true,
        chars: text.length,
        latencyMs: Date.now() - injectStartedAt,
      });
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
        log(`injected into "${event.label}" via ${via} — confirmed sent${attempt ? ` (after ${attempt} re-send${attempt > 1 ? "s" : ""})` : ""}`);
        recordTelemetry("inject", {
          route: via,
          confirmed: true,
          resends: attempt,
          chars: text.length,
          latencyMs: Date.now() - injectStartedAt,
        });
        return true;
      }
      if (attempt < 2) {
        log(`not confirmed yet — re-pressing Return (try ${attempt + 1})`);
        const retry = await injectKey(cfg, event.pid, "Enter", beforeInject ? commit : undefined);
        if (retry.interrupted) return false;
      }
    }
    if (beforeInject && !(await beforeInject())) return false;
    log(`⚠ inject into "${event.label}" via ${via} NOT confirmed — words placed on clipboard`);
    recordTelemetry("inject", {
      route: via,
      confirmed: false,
      resends: 2,
      chars: text.length,
      reason: "never-confirmed",
      latencyMs: Date.now() - injectStartedAt,
    });
    await toClipboard(text);
    if (beforeInject && !(await beforeInject())) return false;
    await speak(cfg, "I typed that but it didn't send. Your words are on the clipboard — just paste and press return.", event.label);
    // Three attempts and the transcript never grew, so the text is sitting
    // unsent in an input box at best. 15 of Tyler's sends landed here today
    // against 57 confirmed — a 21% failure rate reported to him as success.
    return false;
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
        // barging off (echo/noise) or disabled, it's the only voice interrupt,
        // so keep it real
        const noVoiceInterrupt = bargeOff || !cfg.bargeThresholdPct;
        const gapSecs = reciteOnly
          ? 0
          : noVoiceInterrupt ? Math.max(cfg.gapSecs, 0.6) : cfg.gapSecs;
        if (gapSecs > 0) {
          // A read gap precedes the conversation reducer/hooks, so it must not
          // briefly expose the previous completed turn's transcript prefix.
          resetConversationTranscriptPrefix();
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
      () => reducer.snapshot.buffer.map((segment) => segment.text).join(" "),
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

    // The phone owns the EAR as well as the voice. This is the main listen
    // path and it never consulted the lease: the log shows the claim landing
    // and the Mac opening its mic in the same second anyway, then both machines
    // transcribing Tyler and both injecting. The gap was that only the
    // reading-gap branch of this loop ever called reserveNormalMic.
    if (audioLease.isPhone()) {
      log(`mic held — the phone has the ear ("${event.label}")`);
      emitRecorderTraces(
        seededSegments.flatMap((segment) => segment.diagnosticIds),
        { intent: "text-handled", bufferCountAfterReduction: null },
      );
      return;
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
    log(`listening → "${event.label}" (start within ${initialWindow}s)${seededSegments.length ? " · holding" : ""}...`);
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
            if (trace.intent === "prompt") {
              session.setIdleWindowSecs(cfg.holdSubmitSecs, controllerEvent.finalizedAt);
            }
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
      listenHooks(event.label, () => ""),
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

  /**
   * Stop a session mid-turn.
   *
   * Escape is what a person presses, and it is the only signal both Claude Code
   * and Codex agree on — neither exposes a "cancel" an outside process could
   * call, so conch presses the key the same way you would. Watching an agent go
   * down the wrong path with no way to stop it from your phone was the gap.
   *
   * The pid comes from the registry rather than the caller: a phone knows a
   * session by its id, and nothing off-machine should be able to name a process
   * to send keystrokes to.
   */
  async function interruptSession(event: TurnEvent): Promise<void> {
    const known = panelSessions.get(event.sessionId);
    const label = known?.name || event.label || event.sessionId.slice(0, 8);
    const { via } = await injectKey(cfg, known?.pid, "Escape");
    if (via === "none") {
      log(`⚠ could not reach "${label}" to stop it`);
      await speak(cfg, `Couldn't reach ${label} to stop it.`, label);
      return;
    }
    log(`⏹ stopped "${label}" via ${via}`);
  }

  const daemonSettingsPath = settingsPathFor();
  const configController = createConfigController(cfg, {
    settingsPath: daemonSettingsPath,
    onLiveChange: (key, value) => {
      if (key === "meeting-autopause") meetingMic?.setEnabled(value === true);
      if (key === "phone" || key === "phone-port" || key === "phone-relay-url") syncPhoneBridge();
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
      void renderSessionPanel();
      return renamed.label;
    },
    dismiss: (target) => {
      dismissedSessionIds.add(target.sessionId);
      if (lastTurn?.sessionId === target.sessionId) lastTurn = null;
      panelOrder = panelOrder.filter((sessionId) => sessionId !== target.sessionId);
      panelLabels.delete(target.sessionId);
      pause.interrupt({
        sessionId: target.sessionId,
        hold: dismissedHeldTurns,
        preserveHeld: true,
      });
      for (let index = queue.length - 1; index >= 0; index--) {
        const queued = queue[index]!;
        if (queued.type === "speak" && queued.sessionId === target.sessionId) {
          queue.splice(index, 1);
        }
      }
      markQueuedWakesForControl(queue, cancelQueuedAudioCommand, target.sessionId);
      theaterNavigation.release();
      log(`dismissed "${target.label}" — announcements stopped; session keeps running`);
      void renderSessionPanel();
    },
    restore: restoreDismissedSession,
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
  const enrichSocketAudioCommand = (event: InstantAudioCommand): InstantAudioCommand => {
    const session = panelSessions.get(event.sessionId);
    const known = latestTurnBySession.get(event.sessionId)
      ?? (recitingEvent?.sessionId === event.sessionId ? recitingEvent : null)
      ?? (lastTurn?.sessionId === event.sessionId ? lastTurn : null);
    return enrichTargetedAudioCommand(event, {
      session,
      known,
      label: labelForSessionId(event.sessionId),
      transcriptPath: findTranscript(cfg.claudeDir, event.sessionId),
    });
  };
  const socketTurnCallbacks: SocketTurnEventCallbacks = {
    busy: () => busy,
    stopSpacebar: () => stopReciting("spacebar"),
    setSessionPaused: (sessionId, paused) => instantControls.setSessionPaused(sessionId, paused),
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
    start: (message) => startTerminalSession(message),
    close: async (sessionId) => {
      let session = panelSessions.get(sessionId);
      if (!session) {
        session = (await registrySnapshot(cfg.claudeDir))?.infos.find(
          (candidate) => candidate.sessionId === sessionId,
        );
      }
      if (!session) throw new Error("session is not live");
      if (!session.pid) {
        if (session.backend === "codex") {
          reportedMissingCodexPid.add(session.sessionId);
          recordDaemonError(
            "session-close",
            "Codex row has no pid",
            session.sessionId,
            { cwd: session.cwd ?? "", status: session.status ?? "unknown" },
          );
        }
        throw new Error("session has no routable pid");
      }
      await closeTerminalSession(session.pid);
      void renderSessionPanel();
    },
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
  const server = createServer({ allowHalfOpen: true }, (sock) => {
    let buf = "";
    let handled = false;
    sock.on("error", () => {}); // a hook killed mid-write (ECONNRESET) must not throw
    const handleLine = async (line: string): Promise<void> => {
      if (handled) return;
      handled = true;
      let response: ControlResponse | undefined;
      try {
        const value: unknown = JSON.parse(line);
        const runtime = await dispatchRuntimeControlMessage(
          value,
          runtimeControlDispatchOptions,
        );
        if (runtime.handled) {
          sock.end(JSON.stringify(runtime.response) + "\n");
          return;
        }
        // `conch pair` asks the RUNNING daemon to open a pairing window: the
        // bridge lives in that process, so only it can offer a code.
        if (
          typeof value === "object" && value !== null
          && (value as { kind?: unknown }).kind === "audio-sink"
        ) {
          const previous = audioLease.sink;
          const requested = (value as { sink?: unknown }).sink;
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
            activeDictation?.requestExternal("spacebar", "phone-audio-claim");
            void Promise.resolve(killActiveRecorders()).catch(() => {});
          }
          const wanted = audioLease.request(requested, connectedClients);
          if (wanted !== previous) {
            log(audioLease.sink === "phone"
              ? "phone has the audio — this Mac is quiet"
              : "audio back on this Mac");
            void renderSessionPanel();
          }
          sock.end(JSON.stringify({ kind: "audio-sink-ack", sink: audioLease.sink }) + "\n");
          return;
        }
        // The phone is the only thing that knows when the PHONE finishes
        // reading. With the audio lease held, speak() returns immediately, so
        // the Mac sets "speaking" and the caller clears it milliseconds later
        // — the glyph flashes and the ledger says "Waiting for you" for a
        // session being read aloud. Tyler: "the reason I can't tell which one
        // is speaking is cause the state is broken."
        // What conch costs the phone it runs on. Logged rather than acted on:
        // the point is to be able to answer "is this draining my phone" with a
        // reading instead of an opinion, and a trend across a session is what
        // answers it. Low Power Mode is called out because it throttles the
        // CPU and has already been mistaken for a conch bug once.
        if (
          typeof value === "object" && value !== null
          && (value as { kind?: unknown }).kind === "phone-device"
        ) {
          const sample = value as Record<string, unknown>;
          const mb = Number(sample.footprintMB ?? 0).toFixed(0);
          const battery = typeof sample.battery === "number"
            ? `${Math.round(sample.battery * 100)}% ${String(sample.batteryState ?? "")}`
            : String(sample.batteryState ?? "unknown");
          const minutes = Math.round(Number(sample.uptime ?? 0) / 60);
          const free = typeof sample.freeGB === "number" ? sample.freeGB : null;
          const flags = [
            sample.thermal !== "nominal" ? `thermal ${sample.thermal}` : "",
            sample.lowPower === true ? "LOW POWER MODE" : "",
            // Called out rather than merely reported. A nearly full phone slows
            // everything on it, and nothing else conch measures can say so —
            // memory, battery and thermal all read healthy while Tyler's phone
            // was crawling for exactly this reason.
            free !== null && free < 5 ? `ONLY ${free.toFixed(1)}GB FREE` : "",
          ].filter(Boolean).join(", ");
          const disk = free !== null ? ` · ${free.toFixed(1)}GB free` : "";
          log(`phone: ${mb}MB · battery ${battery}${disk} · up ${minutes}m${flags ? ` · ${flags}` : ""}`);
          sock.end(JSON.stringify({ kind: "phone-device-ack" }) + "\n");
          return;
        }
        // The Mac app telling us the machine woke.
        //
        // This is the honest signal: the app receives
        // NSWorkspace.didWakeNotification and the daemon is its child, so the
        // fact travels one socket write instead of being inferred. The polling
        // version of this asked the process to wake ten times a minute forever
        // to notice an event that happens twice a day, which is the shape of
        // thing conch keeps deciding not to do elsewhere.
        if (
          typeof value === "object" && value !== null
          && (value as { kind?: unknown }).kind === "system-woke"
        ) {
          log("the Mac woke — re-dialling the relay");
          try {
            phoneRelay?.reconnectNow();
          } catch (error) {
            log(`relay re-dial failed: ${error}`);
          }
          // Sessions may have come and gone while the lid was shut, and the
          // panel is the only thing that would notice.
          void renderSessionPanel();
          sock.end(JSON.stringify({ kind: "system-woke-ack" }) + "\n");
          return;
        }
        if (
          typeof value === "object" && value !== null
          && (value as { kind?: unknown }).kind === "phone-speaking"
        ) {
          const speaking = (value as { speaking?: unknown }).speaking === true;
          const rawLabel = (value as { label?: unknown }).label;
          const label = typeof rawLabel === "string" ? rawLabel.slice(0, 120) : "";
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
          sock.end(JSON.stringify({ kind: "phone-speaking-ack", speaking }) + "\n");
          return;
        }
        if (
          typeof value === "object" && value !== null
          && (value as { kind?: unknown }).kind === "open-pairing"
        ) {
          syncPhoneBridge();
          if (!phoneBridge) {
            response = { kind: "session-error", error: "phone bridge is off" };
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
            } as unknown as ControlResponse;
          }
          sock.end(JSON.stringify(response) + "\n");
          return;
        }
        const control = dispatchControlMessage(
          value,
          configController,
          sessionCommandDispatchOptions,
          {
            settingsPath: daemonSettingsPath,
            set: writeSetting,
            unset: unsetSetting,
          },
        );
        if (control.handled) response = control.response;
        else {
          const turn = validateAndScopeSocketTurnEvent(
            value,
            lastPublishedPanelState,
            (sessionId) => {
              const session = panelSessions.get(sessionId);
              return {
                cwd: session?.cwd,
                pid: session?.pid,
                transcriptPath: findTranscript(cfg.claudeDir, sessionId),
              };
            },
          );
          if (!turn.ok) {
            log(`ignoring malformed event: ${turn.err}`);
            if (socketRecord(value) && value.type === "inject") {
              response = { kind: "session-error", error: turn.err };
            }
          } else {
            dispatchSocketTurnEvent(turn.value, socketTurnCallbacks);
          }
        }
      } catch {
        log("ignoring malformed event");
      }
      if (response) sock.end(JSON.stringify(response) + "\n");
      else sock.end();
    };
    sock.on("data", (data) => {
      if (handled) return;
      // A peer that never sends a newline would otherwise grow this string
      // until the daemon OOMs. Cap the frame and drop the connection.
      if (buf.length > 64_000) {
        sock.destroy();
        return;
      }
      buf += data.toString();
      const newline = buf.indexOf("\n");
      if (newline !== -1) void handleLine(buf.slice(0, newline));
    });
    sock.on("end", () => {
      if (!handled && buf.trim()) void handleLine(buf.trim());
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
    onLiveDataChange(null);
    publishedStateWriter.flush();
    meetingMic?.close();
    phoneRelay?.stop();
    phoneBridge?.stop();
    queue.length = 0;
    speech.close(); // cancel and seal speech, cues, and in-flight/future canaries
    // Close the controller's rearm gate synchronously before taking the
    // recorder snapshot. No await is allowed before this request.
    const dictationAtShutdown = activeDictation;
    dictationAtShutdown?.requestExternal("spacebar", "shutdown");
    // A live sox capture would keep the mic hot after we die. Without
    // diagnostics we `process.exit(0)` a few lines down, so there is no later
    // moment in which a grace timer could fire — the kill has to land now.
    const recorderDrain = killActiveRecorders({ immediate: !diagnosticsEnabled });
    if (server.listening) server.close();
    whisperServerClient.cancelWarmRequests();
    whisperSupervisor?.close();
    ttsSupervisor?.close();
    ttsWorker.close();
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

  meetingMic = new MicClaimPoller({
    enabled: cfg.meetingAutopause,
    createWatcher: () => new MicClaimWatcher({
      inUse: readMicInUse,
      // CoreAudio exposes one aggregate bit. Skip it whenever Conch could own
      // that bit, including the pre-adoption SoX barge recorder.
      selfOwned: () => normalMicOpen() || hasActiveRecorders(),
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
  if (cfg.ttsEngine === "worker") {
    // Loading and the first Metal/G2P warmup may take seconds (or download on a
    // cold install). Do not hold the turn queue: say is live during startup.
    void ttsWorker.start().catch((error) => {
      if (!shuttingDown) log(`tts worker startup failed — voices via say: ${error}`);
    });
  } else if (cfg.ttsEngine === "server") {
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

  // ONE daemon. This used to unlink unconditionally, so a second daemon
  // silently stole the socket from a live one — which is how a supervisor
  // whose liveness check never matched could kill and recreate conch every
  // five seconds and still look like it was working. Two daemons also means
  // two mics, two speakers, and two writers to the same state file.
  //
  // A socket FILE proves nothing: it outlives the process that made it. Only
  // connecting proves someone is home.
  if (await anotherDaemonIsListening(cfg.socketPath)) {
    log(`another conch daemon already owns ${cfg.socketPath} — this one is exiting`);
    // 0, not 1: a supervisor treats a nonzero exit as a crash and retries
    // harder. Losing a race is the system working, not failing.
    process.exit(0);
  }
  if (existsSync(cfg.socketPath)) unlinkSync(cfg.socketPath); // genuinely stale
  server.listen(cfg.socketPath);
  syncPhoneBridge();
  void rehydrateFromTranscripts();
  // The socket accepts mic-opening, speech, and settings mutations, so it must
  // not be world-writable in /tmp. Darwin enforces socket mode on connect(2).
  try {
    chmodSync(cfg.socketPath, 0o600);
  } catch {}
  log(`listening on ${cfg.socketPath} — wire hooks with \`conch install\``);
  if (pause.paused) log("starting in manual mode (persisted) — p or `conch resume` turns auto on");
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
  if (cfg.whisperPort) {
    void whisperSupervisor.start().catch((error) => {
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
    logAbove(rows.map((r) => `  \x1b[36m${r.n}\x1b[0m ${r.label}${lastTurn?.sessionId === r.s.sessionId ? " \x1b[2m(space wakes this one)\x1b[0m" : ""}`).join("\n"));
  }

  /** Audition every live session in its assigned voice — `conch voice <session> <voice>` reassigns. */
  async function auditionVoices(): Promise<void> {
    if (busy) return log("busy — audition after the current exchange");
    if (pause.paused) return log("manual mode — resume before auditioning voices");
    busy = true;
    const controlGeneration = pause.capture();
    try {
      const rows = await numberedSessions();
      if (pause.interrupted(controlGeneration) || pause.paused) return;
      if (!rows.length) return log("no live sessions");
      for (const r of rows) {
        if (pause.interrupted(controlGeneration) || pause.paused) break;
        logAbove(`  \x1b[36m${r.n}\x1b[0m ${r.label} — \x1b[35m${voiceFor(cfg, r.label)}\x1b[0m`);
        await speak(cfg, `${r.label} sounds like this.`, r.label);
        if (pause.interrupted(controlGeneration) || pause.paused) break;
      }
      if (!pause.interrupted(controlGeneration) && !pause.paused) {
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

  /** Read a target session's latest assistant output from sentence zero. */
  function reciteBySessionId(id: string | null): void {
    if (!id) return log("nothing to recite — no session is parked or active");
    const known = latestTurnBySession.get(id)
      ?? (recitingEvent?.sessionId === id ? recitingEvent : null)
      ?? (lastTurn?.sessionId === id ? lastTurn : null);
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
  function stopReciting(src: string): void {
    stopKey = true;
    speech.cancelCurrent();
    speech.cancelPendingAudio();
    // Space remains the guaranteed stop even when an instant takeover is
    // queued behind the old exchange's deliberately un-killed Whisper job.
    markQueuedWakesForControl(queue, cancelQueuedAudioCommand);
    activeDictation?.requestExternal("spacebar");
    log(activeDictation?.session.micOpen || micOpen ? `⏹ ${src} — closing mic` : `⏹ ${src} — stopped`);
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
    setSessionPaused: (sessionId, paused) => instantControls.setSessionPaused(sessionId, paused),
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
      if (theaterMode && c === ",") {
        settingsOverlay?.open();
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
        if (busy) stopReciting("spacebar");
        else if (theaterMode && theaterActionTarget()) wakeBySessionId(theaterActionTarget()!);
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
  const t = new Date().toTimeString().slice(0, 8);
  logAbove(`[conch ${t}] ${msg}`);
}

/** Seconds since the user last touched keyboard or mouse (macOS HID idle time). */
/** Seconds since the last keyboard/mouse/trackpad event, or `null` if the HID probe
 *  couldn't be read — callers must fail SAFE (don't gate / don't auto-silence) on null. */
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
