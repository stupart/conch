import { ControlFrameError, ControlFrameReader, encodeControlFrame } from "./control-framing.ts";
import type { HistoryPageRequest, HistoryItemRequest, HistoryResponse } from "./history.ts";
import { createServer, connect } from "node:net";
import { chmodSync, existsSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { lockSocketPath, type SocketOwnership } from "./socket-ownership.ts";
import type { TurnEvent } from "./hook.ts";
import type { SendFailure } from "./inject.ts";
import { checkReviewScene } from "./snippet.ts";
import { agentQuestions } from "./conversation.ts";
import type { PublishedDelivery, PublishedState } from "./panel.ts";
import type { SessionInfo } from "./sessions.ts";
import type { SessionBackend } from "./agent-adapter.ts";
import type { InstantAudioCommand } from "./instant-controls.ts";
import {
  invokeSessionAction,
  type SessionDelivery,
  type SessionActionsController,
  type SessionActionsTarget,
} from "./session-actions-overlay.ts";
import type { ResumableSessionsRead } from "./resumable.ts";
import { validateScreenObservation, type ScreenObservation } from "./screen-context.ts";
import type { AgentCapabilitiesRead } from "./agent-capabilities.ts";
import type { AgentInstall } from "./agent-install.ts";
import { applyPlan, planToggle, rollbackFile, type ConfigWriteHomes, type ConfigWriteIo } from "./config-write.ts";
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
  delivered?: SessionDelivery,
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
        { command: "rename", label: message.label, delivered },
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
      // The typing is handed back for a sender that asked to hear it finish.
      const typing = invokeSessionAction(controller, target, { command: "set-model", model: message.model });
      delivered?.(Promise.resolve(typing));
      return sessionCommandAck(message, target.pid !== undefined, target.label);
    }
    case "attach": {
      // Fire and forget, like reveal: opening Terminal is AppleScript. `changed`
      // means "there is a background job to attach"; failures are logged.
      void invokeSessionAction(controller, target, { command: "attach" });
      return sessionCommandAck(message, target.jobId !== undefined, target.label);
    }
    case "review-viewed": {
      const marked = invokeSessionAction(
        controller,
        target,
        { command: "review-viewed", review: message.review },
      );
      return sessionCommandAck(message, marked === true, target.label);
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
  delivered?: SessionDelivery,
): SessionControlResponse {
  try {
    options.pause.open();
    try {
      return applySessionControlMessage(message, options, delivered);
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
    || validated.value.kind === "history-page" || validated.value.kind === "history-item"
    || validated.value.kind === "agent-capabilities"
    || validated.value.kind === "session-start"
    || validated.value.kind === "session-close"
    || validated.value.kind === "app-error"
    || validated.value.kind === "config-toggle"
    || validated.value.kind === "config-rollback"
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
  historyPage?(message: HistoryPageRequest): HistoryResponse | Promise<HistoryResponse>;
  historyItem?(message: HistoryItemRequest): HistoryResponse | Promise<HistoryResponse>;
  listResumable(
    message: Extract<RuntimeControlMessage, { kind: "resumable" }>,
  ): ResumableSessionsRead | Promise<ResumableSessionsRead>;
  readCapabilities?(
    message: Extract<RuntimeControlMessage, { kind: "agent-capabilities" }>,
  ): AgentCapabilitiesRead | Promise<AgentCapabilitiesRead>;
  /** This session's own binary and whether a newer copy of the same agent is running elsewhere on this Mac. Undefined when the process identity is unknown — never guessed. */
  readInstall?(
    message: Extract<RuntimeControlMessage, { kind: "agent-capabilities" }>,
  ): AgentInstall | undefined | Promise<AgentInstall | undefined>;
  start(message: Extract<RuntimeControlMessage, { kind: "session-start" }>): void | Promise<void>;
  /** Whether the agent already trusts a folder; absent or null means unknown. */
  folderTrusted?(backend: SessionBackend, cwd: string): boolean | null;
  /** Resolves to the flags a restart did not carry over; nothing for a plain close. */
  close(sessionId: string, restart?: boolean): void | Promise<void | { notCarriedOver: string[] }>;
  report(message: Extract<RuntimeControlMessage, { kind: "app-error" }>): void | Promise<void>;
  /** Where the agents' config files live and how they are written; absent means the real homes (B3). */
  configWrite?: { homes?: ConfigWriteHomes; io?: ConfigWriteIo };
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
    if (socketRecord(value) && (value.kind === "history-page" || value.kind === "history-item")) {
      return { handled: true, response: { kind: "history-error", code: "invalid-request", error: validated.err } };
    }
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
    if (message.kind === "history-page") {
      const { kind, ...request } = message;
      return await options.historyPage?.(request) ?? { kind: "history-off", error: "history is off" };
    }
    if (message.kind === "history-item") {
      const { kind, ...request } = message;
      return await options.historyItem?.(request) ?? { kind: "history-off", error: "history is off" };
    }
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
      const inventory = await options.readCapabilities(message);
      const install = await options.readInstall?.(message);
      return {
        kind: "agent-capabilities",
        inventory,
        ...(install ? { install } : {}),
      };
    }
    if (message.kind === "session-start") {
      // Ask before launching, not after. Codex stops on a full-screen trust
      // prompt in a directory it has not been told about, and a session held
      // there never starts and never registers — indistinguishable, from
      // outside, from one that failed. Unlike Claude's equivalent, this answer
      // CAN be supplied at launch, so conch offers the choice instead of
      // starting something that will sit there.
      //
      // Claude asks the same, and takes no answer at launch — so a yes here is typed into its
      // prompt once it appears (acceptClaudeTrust). Before, conch launched it anyway and the
      // app waited on a session that couldn't register until someone found the Terminal.
      if (message.trustFolder !== true && message.cwd && options.folderTrusted?.(message.backend, message.cwd) === false) {
        return { kind: "session-needs-trust", backend: message.backend, cwd: message.cwd };
      }
      await options.start(message);
      return {
        kind: "session-started",
        backend: message.backend,
        resumed: Boolean(message.resumeSessionId),
        ...(message.teleportSessionId ? { teleported: true as const } : {}),
      };
    }
    if (message.kind === "session-close") {
      const restarted = await options.close(message.sessionId, message.restart === true);
      return {
        kind: "session-closed",
        sessionId: message.sessionId,
        ...(message.restart ? { restarted: true as const } : {}),
        ...(restarted?.notCarriedOver.length ? { notCarriedOver: restarted.notCarriedOver } : {}),
      };
    }
    if (message.kind === "config-toggle") {
      // Planned fresh on every request, so the diff is against the file as it
      // is now. An apply that carries the preview's hash refuses when the file
      // moved in between — the preview is then a stale promise, not a plan.
      const plan = planToggle(message, options.configWrite?.homes);
      if (!message.preview && message.expectBeforeHash !== undefined && message.expectBeforeHash !== plan.beforeHash) {
        throw new Error(`${plan.file} changed since the preview; ask for a new preview.`);
      }
      const applied = message.preview ? null : applyPlan(plan, options.configWrite?.io);
      return {
        kind: "config-toggle",
        file: plan.file,
        diff: plan.diff,
        beforeHash: plan.beforeHash,
        applied: applied !== null,
        ...(applied?.backup ? { backup: applied.backup } : {}),
        appliesNextSession: true,
      };
    }
    if (message.kind === "config-rollback") {
      return { kind: "config-rollback", ...rollbackFile(message.file, options.configWrite?.io) };
    }
    await options.report(message);
    return { kind: "app-error-ack" };
  } catch (error) {
    if (message.kind === "history-page" || message.kind === "history-item") {
      return { kind: "history-error", code: "unavailable", error: "history is unavailable" };
    }
    return sessionCommandError(error);
  }
}

const TURN_EVENT_TYPES = new Set<TurnEvent["type"]>([
  "inject",
  "interrupt",
  "turn-end",
  "review-published",
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

/**
 * An AskUserQuestion call carries at most 4 questions of at most 4 options;
 * the bounds leave room without letting a picker's digits run past 9. Typed
 * words are one line: a newline would be a Return.
 */
function questionAnswersError(answers: unknown): string | undefined {
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > 8) return "answers must be 1-8 answers";
  for (const answer of answers) {
    if (!socketRecord(answer)) return "each answer must be an object";
    const hasChoices = answer.choices !== undefined;
    if (hasChoices === (answer.text !== undefined)) return "each answer has choices or text, not both";
    if (hasChoices) {
      const choices = answer.choices;
      if (!Array.isArray(choices) || choices.length < 1 || choices.length > 8
        || !choices.every((choice) => Number.isInteger(choice) && choice >= 0 && choice <= 7)
        || new Set(choices).size !== choices.length) {
        return "choices must be 1-8 distinct option indexes from 0 to 7";
      }
    } else if (typeof answer.text !== "string" || !answer.text.trim() || answer.text.length > 4000
      || /[\u0000-\u001f\u007f]/.test(answer.text)) {
      return "text must be one line of 1-4000 characters";
    }
  }
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
    if (value.review.scene !== undefined) {
      const scene = checkReviewScene(value.review.scene, value.review.link !== undefined);
      if (!scene.ok) return { ok: false, err: `review ${scene.reason}` };
    }
  }
  if (type === "review-published" && value.review === undefined) {
    return { ok: false, err: "review is required for review-published" };
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
  if (value.awaitDelivery !== undefined && value.awaitDelivery !== true) {
    return { ok: false, err: "awaitDelivery must be true when present" };
  }
  if (value.approval !== undefined) {
    // From the PermissionRequest hook: what a dialog is asking, shown and spoken, never typed.
    const approval = value.approval;
    if (type !== "needs-you" || !socketRecord(approval)
      || !["id", "name", "summary"].every((field) => typeof approval[field] === "string"
        && (approval[field] as string).length > 0 && (approval[field] as string).length <= 2000)) {
      return { ok: false, err: "approval must be { id, name, summary } on needs-you" };
    }
  }
  if (value.asking !== undefined) {
    // From the PermissionRequest hook: the questions a picker on screen is asking.
    const asking = value.asking;
    const questions = socketRecord(asking) && Array.isArray(asking.questions) ? asking.questions : null;
    if (type !== "needs-you" || !socketRecord(asking) || typeof asking.id !== "string" || !asking.id
      || asking.id.length > 200 || !questions || questions.length < 1 || questions.length > 8
      || agentQuestions({ questions }).length !== questions.length) {
      return { ok: false, err: "asking must be { id, questions } on needs-you" };
    }
  }
  if (value.approve !== undefined) {
    const approve = value.approve;
    if (type !== "inject") return { ok: false, err: "approve is only for inject" };
    if (value.answers !== undefined) return { ok: false, err: "an inject answers a question or a permission, not both" };
    // No "always": what it grants differs per tool and can't be shown before it is pressed.
    if (!socketRecord(approve) || !["once", "deny"].includes(approve.kind as string)
      || typeof approve.id !== "string" || !approve.id || approve.id.length > 200) {
      return { ok: false, err: "approve must be { kind: once | deny, id }" };
    }
  }
  if (value.answers !== undefined) {
    const err = type === "inject" ? questionAnswersError(value.answers) : "answers are only for inject";
    if (err) return { ok: false, err };
  }
  if (value.questionId !== undefined && (value.answers === undefined || typeof value.questionId !== "string"
    || !value.questionId || value.questionId.length > 300)) {
    return { ok: false, err: "questionId names the question answers are for" };
  }
  // Bounded and plain, because this id is echoed into published state, which every client
  // this Mac serves can read. A send may carry one; hooks and the CLI never do.
  if (value.opId !== undefined
    && (typeof value.opId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value.opId))) {
    return { ok: false, err: "opId must be 1-64 characters of letters, digits, dot, dash or underscore" };
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

export type SocketTurnOutcome = boolean | "staged" | SendFailure | void;

/**
 * A failure that names its cause, as `voice.handle` returns for an inject that did not land.
 * `delivered: false` is the discriminator, so a plain `false` and a named failure stay distinct.
 */
export function isSendFailure(value: unknown): value is SendFailure {
  return typeof value === "object" && value !== null && (value as SendFailure).delivered === false;
}

/**
 * The delivery answer, from whatever `voice.handle` returned.
 *
 * One mapping, used for the reply on the socket AND for the outcome published later against
 * the sender's `opId`, so a message can never be described two ways. A failure carries its
 * cause out to the client, which turns it into a sentence (ConchSendFailure); unnamed stays
 * unnamed, since an invented cause sends someone to fix the wrong thing.
 */
export function injectDeliveryReceipt(outcome: unknown): {
  kind: "inject-done";
  delivered: boolean;
  staged?: true;
  reason?: string;
  onClipboard?: true;
  error?: string;
} {
  if (outcome === "staged") return { kind: "inject-done", delivered: false, staged: true };
  if (typeof outcome === "boolean") return { kind: "inject-done", delivered: outcome };
  if (isSendFailure(outcome)) {
    return {
      kind: "inject-done",
      delivered: false,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.onClipboard ? { onClipboard: true as const } : {}),
    };
  }
  return { kind: "inject-done", delivered: false, error: "delivery outcome is unknown" };
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
  /** Resolves when an immediate event (inject, interrupt) has been handled; an inject with whether it landed. */
  enqueue(event: TurnEvent): void | Promise<SocketTurnOutcome>;
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
): void | Promise<SocketTurnOutcome> {
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

  return callbacks.enqueue(event);
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
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code !== "ENOENT" && error.code !== "ECONNREFUSED" && error.code !== "ENOTSOCK");
    });
  });
}

/** Claim before starting children; the probe also respects older daemons without a lock. */
export async function acquireControlOwnership(socketPath: string): Promise<SocketOwnership | null> {
  const ownership = lockSocketPath(socketPath);
  if (!ownership) return null;
  try {
    if (await anotherDaemonIsListening(socketPath)) {
      ownership.release();
      return null;
    }
    return ownership;
  } catch (error) {
    ownership.release();
    throw error;
  }
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
  /**
   * Resolve an incoming local address (including an agent id that names a
   * window, or a stale id that names a window parked on a background job).
   */
  resolve(value: unknown): unknown | Promise<unknown>;
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
  /** `delivered` receives the typing a command set off; only an `awaitDelivery` command passes it. */
  session(message: SessionControlMessage, delivered?: SessionDelivery): SessionControlResponse;
  runtime(message: RuntimeControlMessage): SessionControlResponse | Promise<SessionControlResponse>;
  /**
   * Accept synchronously; completion of injection/interrupt is owned by the
   * daemon. The returned work is awaited only for an `awaitDelivery` inject.
   */
  turn(event: TurnEvent): void | Promise<unknown>;
  device(message: DeviceCommand): DeviceControlResponse;
}

export interface ControlServerOptions {
  socketPath: string;
  ownerDeviceId: string;
  log(message: string): void;
  sessions: LocalControlSessions;
  application: ControlApplication;
  /** How long an `awaitDelivery` inject is held open. Tests shorten it. */
  deliveryWaitMs?: number;
  /**
   * Told what became of a send that carried an `opId`, including one that settles after its
   * request was answered and closed. The daemon publishes it; nothing retries on its own.
   */
  onDelivery?(delivery: PublishedDelivery): void;
  /** Told what an observer saw on screen (`screen-observation`), once it has been validated. */
  onScreenObservation?(observation: ScreenObservation): void;
  ownership?: SocketOwnership;
}

/**
 * The longest an `awaitDelivery` inject holds its socket before answering
 * `inject-accepted` (taken, still delivering). Under the phone bridge's 25 s
 * forward budget (`injectTimeoutFor`), so a slow delivery reads as "sent, not
 * yet confirmed" on the phone rather than a false "couldn't reach the Mac".
 */
export const INJECT_DELIVERY_WAIT_MS = 20_000;

export interface ControlServer {
  /** False means another daemon already owns the path; exiting is the caller's decision. */
  start(): Promise<boolean>;
  /** Stop accepting and release the path synchronously; resolve when connections close. */
  close(): Promise<void>;
}

function isRuntimeControlCandidate(value: unknown): boolean {
  return socketRecord(value) && (
    value.kind === "session-start" || value.kind === "session-close"
    || value.kind === "history-page" || value.kind === "history-item"
    || value.kind === "app-error" || value.kind === "resumable"
    || value.kind === "agent-capabilities"
    || value.kind === "config-toggle" || value.kind === "config-rollback"
  );
}

export function createControlServer(options: ControlServerOptions): ControlServer {
  const { socketPath, log, sessions, application } = options;
  let ownership: SocketOwnership | undefined;
  let socketIdentity: { dev: number; ino: number } | undefined;
  let starting: Promise<boolean> | undefined;
  // Bind privately then rename: Node's close must never unlink a successor's path.
  const bindPath = join(dirname(socketPath), `.conch-${process.pid}-${crypto.randomUUID().slice(0, 8)}.sock`);
  const unlinkOwnedSocket = (): void => {
    try {
      const current = lstatSync(socketPath);
      if (socketIdentity && current.dev === socketIdentity.dev && current.ino === socketIdentity.ino) unlinkSync(socketPath);
    } catch {}
    socketIdentity = undefined;
  };
  const server = createServer({ allowHalfOpen: true }, (sock) => {
    const frame = new ControlFrameReader();
    let handled = false;
    const framingError = (error: unknown): void => {
      handled = true;
      const failure = error instanceof ControlFrameError ? error : new ControlFrameError("invalid-json", "control frame is not valid JSON");
      sock.end(JSON.stringify({ kind: "protocol-error", code: failure.code, error: failure.message }) + "\n", () => sock.destroy());
    };
    sock.on("error", () => {}); // a hook killed mid-write (ECONNRESET) must not throw
    const handleLine = async (line: string): Promise<void> => {
      if (handled) return;
      handled = true;
      let response:
        | ControlResponse | DeviceControlResponse | RoutingRefusal
        | {
          kind: "inject-done"; delivered: boolean; staged?: true; error?: string;
          /** Why it did not land, and whether the words are on the Mac's clipboard. */
          reason?: string; onClipboard?: true;
        }
        | { kind: "inject-accepted" }
        | { kind: "session-delivered" } | undefined;
      try {
        let body: unknown;
        try { body = JSON.parse(line); } catch (error) { framingError(error); return; }
        // C9b seam: refuse foreign owners BEFORE consulting any local state.
        // No client sends this yet. Untargeted commands still name one daemon.
        if (socketRecord(body) && body.kind === "control-envelope") {
          if (body.ownerDeviceId !== undefined && typeof body.ownerDeviceId !== "string") {
            const refusal: RoutingRefusal = {
              kind: "routing-error", code: "invalid-envelope", error: "ownerDeviceId must be a string",
            };
            sock.end(encodeControlFrame(JSON.stringify(refusal)));
            return;
          }
          if (body.ownerDeviceId !== undefined && body.ownerDeviceId !== options.ownerDeviceId) {
            const refusal: RoutingRefusal = {
              kind: "routing-error", code: "foreign-owner", ownerDeviceId: body.ownerDeviceId,
              error: "this daemon cannot route to a foreign owner",
            };
            let frame: Buffer;
            try { frame = encodeControlFrame(JSON.stringify(refusal)); }
            catch {
              // The owner ID may fill the request. Its echo must not overflow the refusal.
              const { ownerDeviceId, ...bounded } = refusal;
              frame = encodeControlFrame(JSON.stringify(bounded));
            }
            sock.end(frame);
            return;
          }
          body = body.body;
        }
        // History uses durable record identities, including sessions no longer in live state.
        if (socketRecord(body) && (body.kind === "history-page" || body.kind === "history-item")) {
          try {
            const history = await dispatchRuntimeRequest(body, (message) => application.runtime(message));
            if (history.handled) sock.end(encodeControlFrame(JSON.stringify(history.response)));
          } catch (error) {
            sock.end(encodeControlFrame(JSON.stringify({ kind: "history-error",
              code: error instanceof ControlFrameError ? "response-too-large" : "unavailable", error: "history response unavailable" })));
          }
          return;
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
        // Evidence of what is on screen, not a command to any session: validated here, before
        // session resolution, and answered at once. An observer never waits on the resolvers.
        if (socketRecord(body) && body.kind === "screen-observation") {
          const observed = validateScreenObservation(body.observation);
          let answer: { kind: "screen-ack" } | { kind: "screen-error"; error: string };
          if (!observed.ok) answer = { kind: "screen-error", error: observed.err };
          else if (!options.onScreenObservation) answer = { kind: "screen-error", error: "screen context is unavailable" };
          else {
            options.onScreenObservation(observed.value);
            answer = { kind: "screen-ack" };
          }
          sock.end(JSON.stringify(answer) + "\n");
          return;
        }
        const value = await sessions.resolve(body);
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
              const typing: Promise<unknown>[] = [];
              const awaitDelivery = "awaitDelivery" in control.value && control.value.awaitDelivery === true;
              response = application.session(
                control.value,
                awaitDelivery ? (work) => void typing.push(work) : undefined,
              );
              // A `/model` or `/rename` from the Mac app raises Terminal to type,
              // like its sends (`inject-done` below). The ack still goes out at
              // once, since the app shows it; then the socket waits for the typing
              // and says so, and the app takes the front back. Every other
              // sender (the CLI, the phone) keeps the lone immediate ack.
              if (typing.length > 0) {
                sock.write(JSON.stringify(response) + "\n");
                await Promise.allSettled(typing);
                response = { kind: "session-delivered" };
              }
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
              response = { kind: "session-error", error: turn.err };
            } else {
              const work = application.turn(turn.value);
              // The Mac app and the phone ask to hear when the keystrokes are
              // DONE: the app to take the front back from the Terminal window
              // conch raised, the phone to show "delivered" or "not delivered".
              // Hooks and the CLI keep an immediate explicit ack. The wait is
              // bounded; past it the inject is still running and says so.
              if (turn.value.type === "inject" && turn.value.awaitDelivery) {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const stillRunning = Symbol("still running");
                let outcome: unknown;
                try {
                  outcome = await Promise.race([
                    Promise.resolve(work),
                    new Promise<typeof stillRunning>((resolve) => {
                      timer = setTimeout(() => resolve(stillRunning), options.deliveryWaitMs ?? INJECT_DELIVERY_WAIT_MS);
                    }),
                  ]);
                } finally {
                  clearTimeout(timer);
                }
                // `inject-accepted` says the words were TAKEN. It has never meant they
                // landed, and the request closes here with the delivery still running — so
                // on 2026-09-16 three sends that failed afterwards had no way to say so, and
                // the phone showed them as sent. Whatever this settles as is now published
                // against the sender's own id (daemon.ts), which reaches a client long
                // after nothing is listening on this socket.
                const opId = turn.value.opId;
                const deliverySessionId = turn.value.sessionId;
                const settle = (settled: unknown): void => {
                  if (!opId) return;
                  options.onDelivery?.({
                    opId,
                    sessionId: deliverySessionId,
                    at: Date.now(),
                    ...injectDeliveryReceipt(settled),
                  });
                };
                if (outcome === stillRunning) {
                  // Not awaited: the answer goes out now and the truth follows it.
                  void Promise.resolve(work).then(settle, () => settle(undefined));
                  response = { kind: "inject-accepted", ...(opId ? { opId } : {}) };
                } else {
                  settle(outcome);
                  response = { ...injectDeliveryReceipt(outcome), ...(opId ? { opId } : {}) };
                }
              }
            }
          }
        }
      } catch {
        log("control request failed");
        response = { kind: "session-error", error: "control request failed" };
      }
      sock.end(JSON.stringify(response ?? { kind: "ack" }) + "\n");
    };
    sock.on("data", (data) => {
      if (handled) return;
      try {
        const line = frame.push(typeof data === "string" ? Buffer.from(data) : data);
        if (line !== undefined) void handleLine(line);
      } catch (error) { framingError(error); }
    });
    sock.on("end", () => {
      if (handled || sock.destroyed) return;
      try { frame.end(); } catch (error) { framingError(error); }
    });
  });
  server.on("error", (e) => log(`socket server error: ${e}`));

  const start = async (): Promise<boolean> => {
    ownership = options.ownership?.active ? options.ownership : await acquireControlOwnership(socketPath) ?? undefined;
    if (!ownership) return false;
    try {
      if (ownership.socketPath !== socketPath) throw new Error("socket ownership path mismatch");
      if (existsSync(socketPath)) unlinkSync(socketPath);
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => { reject(error); };
        server.once("error", failed);
        server.listen(bindPath, () => {
          server.off("error", failed);
          resolve();
        });
      });
      chmodSync(bindPath, 0o600);
      socketIdentity = lstatSync(bindPath);
      renameSync(bindPath, socketPath);
      return true;
    } catch (error) {
      if (server.listening) server.close();
      unlinkOwnedSocket();
      ownership.release();
      ownership = undefined;
      throw error;
    }
  };
  return {
    start() {
      if (starting) return starting;
      if (server.listening) return Promise.resolve(true);
      return starting ??= start().finally(() => { starting = undefined; });
    },
    async close() {
      if (starting) await starting.catch(() => {});
      const closed = server.listening
        ? new Promise<void>((resolve) => server.close(() => resolve()))
        : Promise.resolve();
      unlinkOwnedSocket();
      ownership?.release();
      ownership = undefined;
      return closed;
    },
  };
}
