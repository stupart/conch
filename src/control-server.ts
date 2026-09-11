import { createServer, connect } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import type { TurnEvent } from "./hook.ts";
import type { PublishedState } from "./panel.ts";
import type { SessionInfo } from "./sessions.ts";
import type { InstantAudioCommand } from "./instant-controls.ts";
import {
  invokeSessionAction,
  type SessionActionsController,
  type SessionActionsTarget,
} from "./session-actions-overlay.ts";
import type { ResumableSessionsRead } from "./resumable.ts";
import type { AgentCapabilitiesRead } from "./agent-capabilities.ts";
import {
  isControlMessageCandidate,
  validateControlMessage,
  validateRuntimeControlMessage,
  validateSessionControlMessage,
  type ControlResponse,
  type ConfigControlMessage,
  type ConfigControlResponse,
  type SessionControlMessage,
  type SessionControlResponse,
  type RuntimeControlMessage,
  type PairingOpen,
  type SessionError,
} from "./settings.ts";

export interface ConfigController {
  handle(message: ConfigControlMessage): ConfigControlResponse;
}

export interface ConfigControlPersistence {
  settingsPath: string;
  set(path: string, key: unknown, value: unknown): unknown;
  unset(path: string, key: unknown): unknown;
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
    case "reveal": {
      // Fire and forget: the raise is AppleScript against Terminal.app, and
      // the reply must not wait on it. `changed` means "there is a process to
      // try" — a session conch only observes has nothing to raise.
      void invokeSessionAction(controller, target, { command: "reveal" });
      return sessionCommandAck(message, target.pid !== undefined, target.label);
    }
    case "set-model": {
      // Same shape as reveal: the typing is tmux/AppleScript against the
      // session's window and the reply must not wait on it. `changed` means
      // "there is a window to deliver to"; the daemon logs the delivery itself.
      void invokeSessionAction(controller, target, { command: "set-model", model: message.model });
      return sessionCommandAck(message, target.pid !== undefined, target.label);
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
  return applySessionCommand(validated.value, options);
}

export function applySessionCommand(
  message: SessionControlMessage,
  options: SessionCommandDispatchOptions,
): SessionControlResponse {
  try {
    options.pause.open();
    try {
      return applySessionControlMessage(message, options);
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
    || validated.value.kind === "agent-capabilities"
    || validated.value.kind === "session-start"
    || validated.value.kind === "session-close"
    || validated.value.kind === "app-error"
  ) return { handled: false };

  return { handled: true, response: applyConfigControlMessage(validated.value, controller, configPersistence) };
}

/** Apply a decoded configuration request, persisting before changing live state. */
export function applyConfigControlMessage(
  message: ConfigControlMessage,
  controller: ConfigController,
  configPersistence?: ConfigControlPersistence,
): ConfigControlResponse {
  if (message.kind !== "get-config" && configPersistence) {
    try {
      if (message.kind === "set-config") {
        configPersistence.set(
          configPersistence.settingsPath,
          message.key,
          message.value,
        );
      } else {
        configPersistence.unset(
          configPersistence.settingsPath,
          message.key,
        );
      }
    } catch (error) {
      return {
        kind: "config-error",
        error: `not saved: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return controller.handle(message);
}

export interface RuntimeControlDispatchOptions {
  listResumable(
    message: Extract<RuntimeControlMessage, { kind: "resumable" }>,
  ): ResumableSessionsRead | Promise<ResumableSessionsRead>;
  readCapabilities?(
    message: Extract<RuntimeControlMessage, { kind: "agent-capabilities" }>,
  ): AgentCapabilitiesRead | Promise<AgentCapabilitiesRead>;
  start(message: Extract<RuntimeControlMessage, { kind: "session-start" }>): void | Promise<void>;
  /** Whether Claude Code already trusts a folder; absent or null means unknown. */
  folderTrusted?(cwd: string): boolean | null;
  /** Whether Codex already trusts a folder; absent or null means unknown. */
  codexFolderTrusted?(cwd: string): boolean | null;
  close(sessionId: string): void | Promise<void>;
  report(message: Extract<RuntimeControlMessage, { kind: "app-error" }>): void | Promise<void>;
}

/** Process/UI controls stay outside the synchronous settings controller so AppleScript cannot block config reads. */
export async function dispatchRuntimeControlMessage(
  value: unknown,
  options: RuntimeControlDispatchOptions,
): Promise<SocketControlDispatch> {
  return dispatchRuntimeRequest(value, (message) => applyRuntimeControlMessage(message, options));
}

async function dispatchRuntimeRequest(
  value: unknown,
  runtime: ControlApplication["runtime"],
): Promise<SocketControlDispatch> {
  if (!isRuntimeControlCandidate(value)) return { handled: false };

  const validated = validateRuntimeControlMessage(value);
  if (!validated.ok) {
    return { handled: true, response: { kind: "session-error", error: validated.err } };
  }
  return { handled: true, response: await runtime(validated.value) };
}

/** Apply a decoded runtime command using the daemon's process/UI operations. */
export async function applyRuntimeControlMessage(
  message: RuntimeControlMessage,
  options: RuntimeControlDispatchOptions,
): Promise<SessionControlResponse> {
  try {
    if (message.kind === "resumable") {
      const result = await options.listResumable(message);
      return {
        kind: "resumable",
        sessions: result.sessions,
        complete: result.complete,
      };
    }
    if (message.kind === "agent-capabilities") {
      if (!options.readCapabilities) {
        throw new Error("agent capability inventory is unavailable");
      }
      return {
        kind: "agent-capabilities",
        inventory: await options.readCapabilities(message),
      };
    }
    if (message.kind === "session-start") {
      // Ask before launching, not after. Codex stops on a full-screen trust
      // prompt in a directory it has not been told about, and a session held
      // there never starts and never registers — indistinguishable, from
      // outside, from one that failed. Unlike Claude's equivalent, this answer
      // CAN be supplied at launch, so conch offers the choice instead of
      // starting something that will sit there.
      if (
        message.backend === "codex"
        && message.trustFolder !== true
        && message.cwd
        && options.codexFolderTrusted?.(message.cwd) === false
      ) {
        return { kind: "session-needs-trust", backend: "codex", cwd: message.cwd };
      }
      // Answered BEFORE launching, because afterwards it is unanswerable: a
      // session held on the trust prompt writes no registry file, so conch
      // cannot tell "still deciding" from "never started" from the outside.
      const awaitingTrust = message.backend === "claude"
        && message.cwd !== undefined
        && options.folderTrusted?.(message.cwd) === false;
      await options.start(message);
      return {
        kind: "session-started",
        backend: message.backend,
        resumed: Boolean(message.resumeSessionId),
        ...(message.teleportSessionId ? { teleported: true as const } : {}),
        ...(awaitingTrust ? { awaitingTrust: true } : {}),
      };
    }
    if (message.kind === "session-close") {
      await options.close(message.sessionId);
      return { kind: "session-closed", sessionId: message.sessionId };
    }
    await options.report(message);
    return { kind: "app-error-ack" };
  } catch (error) {
    return sessionCommandError(error);
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
  "pause",
  "resume",
]);

export type SocketTurnEventValidation =
  | { ok: true; value: TurnEvent }
  | { ok: false; err: string };

export type PublishedInjectScope =
  | { ok: true; value: TurnEvent }
  | { ok: false; err: string };

type PublishedInjectRows = { rows: ReadonlyArray<Pick<PublishedState["rows"][number], "id" | "label">> };

/** Replace every caller-controlled routing field with daemon-owned session data. */
export function scopePublishedInjectEvent(
  event: TurnEvent,
  published: PublishedInjectRows | null,
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
  const type = value.type as TurnEvent["type"];

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
  if (!SPARSE_TURN_EVENT_TYPES.has(type)) {
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
  if (value.compose !== undefined && value.compose !== true) {
    return { ok: false, err: "compose must be true when present" };
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
  /** Is a microphone actually open? Not the same question as `busy`. */
  capturing?(): boolean;
  stopSpacebar(): void;
  /** Told when a stop arrived with nothing running, so it leaves a trace. */
  droppedStop?(): void;
  setSessionPaused(sessionId: string, paused: boolean, origin?: TurnEvent["origin"]): void;
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
  const event = incoming;
  if (event.type === "spacebar") {
    // `busy` is the DRAIN LOOP's flag, and a microphone can be open while it is
    // false — observed, not inferred: six stops in one attempt logged as
    // ignored by the line below while the mic was audibly listening. So this
    // asked "is the queue working?" when the only question that matters is
    // "is the microphone open?". (An earlier version of this comment blamed an
    // instant path that bypasses the queue; `enqueueInstant` in fact calls
    // `enqueue`, so that was wrong — the fix stands on the log, not on that
    // story.) `capturing` is the daemon's own `normalMicOpen()`, the same
    // predicate `stopReciting` uses to decide whether it is closing a mic.
    if (callbacks.busy() || callbacks.capturing?.()) callbacks.stopSpacebar();
    else callbacks.droppedStop?.();
    return;
  }

  if (event.sessionId) {
    if (callbacks.isDismissedSession?.(event.sessionId)) return;
    if (event.type === "pause" || event.type === "resume") {
      callbacks.setSessionPaused(event.sessionId, event.type === "pause", event.origin);
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

/** Reserved outside the legacy body so reconstructing validators cannot lose routing. */
export interface ControlEnvelope {
  kind: "control-envelope";
  ownerDeviceId?: string;
  body: unknown;
}

export type RoutingRefusal = {
  kind: "routing-error";
  code: "foreign-owner" | "invalid-envelope";
  ownerDeviceId?: string;
  error: string;
};

/** A label is presentation only; a future report may carry a separate session reference. */
export interface ControlSessionReference {
  ownerDeviceId: string;
  localSessionKey: string;
}

/** An announcement another Mac could not make itself, carried by the holder's app (C9b Cut B). */
export interface AudioPresentItem {
  /** The yielded daemon's ownerDeviceId. */
  source: string;
  seq: number;
  text: string;
  voice: string;
  label: string;
  /** The holder's app names the host; the daemon only knows the owner id. */
  host: string;
  at: number;
  session: ControlSessionReference;
}

export type DeviceCommand =
  | { kind: "audio-sink"; sink: "phone" | "mac" }
  | { kind: "phone-spoke"; reason: string; text: string }
  | { kind: "phone-device"; summary: string }
  | { kind: "system-woke" }
  | { kind: "phone-speaking"; speaking: boolean; label: string; session?: ControlSessionReference }
  | { kind: "open-pairing" }
  | { kind: "audio-take" }
  | { kind: "audio-yield"; holder: string; revision: number; leaseMs: number }
  | { kind: "audio-release" }
  | { kind: "audio-present"; item: AudioPresentItem };

export type AudioControlResponse =
  | { kind: "audio-ack"; revision: number; stopped?: boolean; seq?: number }
  | { kind: "audio-error"; code: "stale-revision" | "held" | "dropped" | "invalid"; revision?: number; error?: string };

export type DeviceControlResponse =
  | { kind: "audio-sink-ack"; sink: "phone" | "mac" }
  | { kind: "ack" | "phone-device-ack" | "system-woke-ack" }
  | { kind: "phone-speaking-ack"; speaking: boolean }
  | AudioControlResponse
  | PairingOpen
  | SessionError;

const AUDIO_COMMAND_KINDS = new Set(["audio-take", "audio-yield", "audio-release", "audio-present"]);

export type AudioCommandDecode =
  | { ok: true; value: Extract<DeviceCommand, { kind: `audio-${"take" | "yield" | "release" | "present"}` }> }
  | { ok: false; err: string };

/**
 * The audio-holder commands name a DEVICE, never a session, so they are decoded
 * after the owner check and before any session resolution. Strict, unlike the
 * legacy coercions below: a malformed revision must not become a grant.
 */
export function decodeAudioCommand(value: unknown): AudioCommandDecode | null {
  if (!socketRecord(value) || typeof value.kind !== "string" || !AUDIO_COMMAND_KINDS.has(value.kind)) return null;
  if (value.kind === "audio-take" || value.kind === "audio-release") return { ok: true, value: { kind: value.kind } };
  if (value.kind === "audio-yield") {
    const holder = typeof value.holder === "string" ? value.holder.trim() : "";
    if (!holder || holder === "local" || holder.length > 120) return { ok: false, err: "holder must name a device" };
    if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
      return { ok: false, err: "revision must be a non-negative integer" };
    }
    if (typeof value.leaseMs !== "number" || !Number.isFinite(value.leaseMs) || value.leaseMs <= 0) {
      return { ok: false, err: "leaseMs must be a positive number" };
    }
    return { ok: true, value: { kind: "audio-yield", holder, revision: value.revision as number, leaseMs: value.leaseMs } };
  }
  const source = typeof value.source === "string" ? value.source.trim() : "";
  if (!source || source.length > 120) return { ok: false, err: "source must name a device" };
  if (!Number.isSafeInteger(value.seq)) return { ok: false, err: "seq must be an integer" };
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!text || text.length > 8_000) return { ok: false, err: "text must be a non-empty string" };
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return { ok: false, err: "at must be a finite number" };
  const session = socketRecord(value.session) ? value.session : {};
  const ownerDeviceId = typeof session.ownerDeviceId === "string" ? session.ownerDeviceId : "";
  const localSessionKey = typeof session.localSessionKey === "string" ? session.localSessionKey : "";
  return {
    ok: true,
    value: {
      kind: "audio-present",
      item: {
        source,
        seq: value.seq as number,
        text,
        voice: typeof value.voice === "string" ? value.voice.slice(0, 120) : "",
        label: typeof value.label === "string" ? value.label.slice(0, 120) : "",
        host: typeof value.host === "string" ? value.host.slice(0, 120) : "",
        at: value.at,
        session: { ownerDeviceId, localSessionKey },
      },
    },
  };
}

/** Keep these legacy coercions permissive: this is decoding, not a protocol upgrade. */
function decodeDeviceCommand(value: unknown): DeviceCommand | null {
  if (!socketRecord(value)) return null;
  if (value.kind === "audio-sink") {
    return { kind: value.kind, sink: value.sink === "phone" ? "phone" : "mac" };
  }
  if (value.kind === "phone-spoke") {
    return {
      kind: value.kind,
      reason: typeof value.reason === "string" ? value.reason : "unknown",
      text: typeof value.text === "string" ? value.text.slice(0, 60) : "",
    };
  }
  if (value.kind === "phone-device") {
    const sample = value;
    const mb = Number(sample.footprintMB ?? 0).toFixed(0);
    const battery = typeof sample.battery === "number"
      ? `${Math.round(sample.battery * 100)}% ${String(sample.batteryState ?? "")}`
      : String(sample.batteryState ?? "unknown");
    const minutes = Math.round(Number(sample.uptime ?? 0) / 60);
    const free = typeof sample.freeGB === "number" ? sample.freeGB : null;
    const flags = [
      sample.thermal !== "nominal" ? `thermal ${sample.thermal}` : "",
      sample.lowPower === true ? "LOW POWER MODE" : "",
      // A nearly full phone slows everything while its other readings look healthy.
      free !== null && free < 5 ? `ONLY ${free.toFixed(1)}GB FREE` : "",
    ].filter(Boolean).join(", ");
    const disk = free !== null ? ` · ${free.toFixed(1)}GB free` : "";
    return {
      kind: value.kind,
      summary: `phone: ${mb}MB · battery ${battery}${disk} · up ${minutes}m${flags ? ` · ${flags}` : ""}`,
    };
  }
  if (value.kind === "phone-speaking") {
    const speaking = value.speaking === true;
    const rawLabel = value.label;
    const label = typeof rawLabel === "string" ? rawLabel.slice(0, 120) : "";
    return { kind: value.kind, speaking, label };
  }
  if (value.kind === "system-woke" || value.kind === "open-pairing") {
    return { kind: value.kind };
  }
  return null;
}

export interface LocalControlSessions {
  /** Resolve an incoming local address (including an agent id that names a window). */
  resolve(value: unknown): unknown;
  /** Current publication eligibility and canonical metadata for this local address. */
  current(sessionId: string): {
    published: boolean;
    label?: string;
    cwd?: string;
    pid?: number;
    transcriptPath?: string;
  };
}

export interface ControlApplication {
  configuration(message: ConfigControlMessage): ConfigControlResponse;
  session(message: SessionControlMessage): SessionControlResponse;
  runtime(message: RuntimeControlMessage): SessionControlResponse | Promise<SessionControlResponse>;
  /** Accept synchronously; completion of injection/interrupt is owned by the daemon. */
  turn(event: TurnEvent): void;
  device(message: DeviceCommand): DeviceControlResponse;
}

export interface ControlServerOptions {
  socketPath: string;
  ownerDeviceId: string;
  log(message: string): void;
  sessions: LocalControlSessions;
  application: ControlApplication;
}

export interface ControlServer {
  /** False means another daemon already owns the path; exiting is the caller's decision. */
  start(): Promise<boolean>;
  /** Stop accepting and release the path synchronously; resolve when connections close. */
  close(): Promise<void>;
}

function isRuntimeControlCandidate(value: unknown): boolean {
  return socketRecord(value) && (
    value.kind === "session-start" || value.kind === "session-close"
    || value.kind === "app-error" || value.kind === "resumable"
    || value.kind === "agent-capabilities"
  );
}

export function createControlServer(options: ControlServerOptions): ControlServer {
  const { socketPath, log, sessions, application } = options;
  const server = createServer({ allowHalfOpen: true }, (sock) => {
    let buf = "";
    let handled = false;
    sock.on("error", () => {}); // a hook killed mid-write (ECONNRESET) must not throw
    const handleLine = async (line: string): Promise<void> => {
      if (handled) return;
      handled = true;
      let response: ControlResponse | DeviceControlResponse | RoutingRefusal | undefined;
      try {
        let body: unknown = JSON.parse(line);
        // C9b seam: refuse foreign owners BEFORE consulting any local state.
        // No client sends this yet. Untargeted commands still name one daemon.
        if (socketRecord(body) && body.kind === "control-envelope") {
          if (body.ownerDeviceId !== undefined && typeof body.ownerDeviceId !== "string") {
            const refusal: RoutingRefusal = {
              kind: "routing-error", code: "invalid-envelope", error: "ownerDeviceId must be a string",
            };
            sock.end(JSON.stringify(refusal) + "\n");
            return;
          }
          if (body.ownerDeviceId !== undefined && body.ownerDeviceId !== options.ownerDeviceId) {
            const refusal: RoutingRefusal = {
              kind: "routing-error", code: "foreign-owner", ownerDeviceId: body.ownerDeviceId,
              error: "this daemon cannot route to a foreign owner",
            };
            sock.end(JSON.stringify(refusal) + "\n");
            return;
          }
          body = body.body;
        }
        // C9b Cut B: the audio-holder commands are decoded here, after the
        // owner check and BEFORE any session resolution — they name a device.
        // The device entry is synchronous, so the transfer flips in one tick.
        const audio = decodeAudioCommand(body);
        if (audio) {
          response = audio.ok
            ? application.device(audio.value)
            : { kind: "audio-error", code: "invalid", error: audio.err };
          sock.end(JSON.stringify(response) + "\n");
          return;
        }
        const value = sessions.resolve(body);
        // Retain the legacy runtime-first async boundary even for other kinds.
        const runtime = await dispatchRuntimeRequest(value, (message) => application.runtime(message));
        if (runtime.handled) {
          response = runtime.response;
        } else {
          const device = decodeDeviceCommand(value);
          if (device) response = application.device(device);
          else if (isControlMessageCandidate(value)) {
            const control = validateControlMessage(value);
            if (!control.ok) {
              response = {
                kind: socketRecord(value) && value.kind === "session-command" ? "session-error" : "config-error",
                error: control.err,
              };
            } else if (control.value.kind === "session-command") {
              response = application.session(control.value);
            } else if (
              control.value.kind === "get-config" || control.value.kind === "set-config"
              || control.value.kind === "unset-config"
            ) {
              response = application.configuration(control.value);
            }
          } else {
            let turn = validateSocketTurnEvent(value);
            if (turn.ok && turn.value.type === "inject") {
              const sessionId = turn.value.sessionId.trim();
              const current = sessions.current(sessionId);
              turn = scopePublishedInjectEvent(
                turn.value,
                { rows: current.published ? [{ id: sessionId, label: current.label ?? "" }] : [] },
                current,
              );
            }
            if (!turn.ok) {
              log(`ignoring malformed event: ${turn.err}`);
              if (socketRecord(value) && value.type === "inject") {
                response = { kind: "session-error", error: turn.err };
              }
            } else {
              application.turn(turn.value);
            }
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
      //
      // Append FIRST. The check used to run on the buffer before the incoming
      // chunk was added, so a single oversized chunk that happened to end in a
      // newline was appended and parsed anyway — the cap only ever caught the
      // slow-drip case. Found by Codex during the split recon.
      buf += data.toString();
      if (buf.length > 64_000) {
        sock.destroy();
        return;
      }
      const newline = buf.indexOf("\n");
      if (newline !== -1) void handleLine(buf.slice(0, newline));
    });
    sock.on("end", () => {
      // Bun 1.4 emits `end` after `destroy()`, and the cap above destroys with
      // `handled` still false — so the oversized frame it just refused was
      // parsed and dispatched from here, unacknowledged (A16). A destroyed
      // connection has nothing left to answer.
      if (sock.destroyed) return;
      if (!handled && buf.trim()) void handleLine(buf.trim());
      else if (!handled) sock.end();
    });
  });
  server.on("error", (e) => log(`socket server error: ${e}`));

  return {
    async start() {
      if (server.listening) return true;
      // Only a connection proves ownership; a leftover socket file proves nothing.
      if (await anotherDaemonIsListening(socketPath)) return false;
      if (existsSync(socketPath)) unlinkSync(socketPath); // genuinely stale
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => { reject(error); };
        server.once("error", failed);
        server.listen(socketPath, () => {
          server.off("error", failed);
          // The socket accepts mic, speech and settings mutations. Darwin
          // enforces socket mode on connect(2); keep it private in /tmp.
          try { chmodSync(socketPath, 0o600); } catch {}
          resolve();
        });
      });
      return true;
    },
    close() {
      if (!server.listening) return Promise.resolve();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Synchronous release also serves the daemon's immediate process.exit path.
      try { unlinkSync(socketPath); } catch {}
      return closed;
    },
  };
}
