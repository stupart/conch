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
  voiceFor,
} from "./speak.ts";
import { SpeechManager } from "./speech-manager.ts";
import { ServerSupervisor } from "./server-supervisor.ts";
import { TtsSupervisor } from "./tts-supervisor.ts";
import {
  listenGap,
  armBargeRecorder,
  killActiveRecorders,
  createDictationSession,
  type ListenHooks,
  type RuntimeDictationSession,
} from "./listen.ts";
import type { RecorderHandle } from "./dictation-controller.ts";
import { injectText, injectKey, revealSessionWindow, toClipboard } from "./inject.ts";
import { classify, classifyReadingGap, wordOverlapRatio } from "./commands.ts";
import { lastAssistantText, splitSentences, stripMarkdown, countCoveredSentences, userRespondedSince, transcriptMark } from "./snippet.ts";
import {
  whisperServerClient,
  type WhisperRecoveryReason,
} from "./transcribe.ts";
import {
  clearReadingProgress,
  configureRenderer,
  getLiveState,
  installRendererLifecycle,
  logAbove,
  logsShown,
  onLiveChange,
  renderPanel,
  resizeRenderer,
  setKeybar,
  setLogsVisible,
  setReadingProgress,
  setState,
  type ConchState,
} from "./status.ts";
import { listSessions, registrySnapshot, sessionLabel, findTranscript, type SessionInfo } from "./sessions.ts";
import {
  buildPanelModel,
  latestLatchedState,
  type SessionStatus,
} from "./panel.ts";
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
  interruptForManualReply,
  ManualReplyInterrupt,
  watchManualReplyDuringSpeech,
} from "./manual-reply.ts";
import {
  SETTING_DESCRIPTORS,
  SETTING_REGISTRY,
  isControlMessageCandidate,
  loadSettingResolutions,
  loadSettingsFile,
  resolveSettingFromLoaded,
  settingsPathFor,
  validateControlMessage,
  type ConfigAck,
  type ConfigControlMessage,
  type ConfigControlResponse,
  type ConfigSnapshot,
  type SettingKey,
  type SettingResolution,
  type SettingValue,
  type HandoffOrder,
} from "./settings.ts";

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

/** Resolve a wake without carrying a prior turn's read-aloud discriminator forward. */
export function resolveWakeTarget(wake: TurnEvent, lastTurn: TurnEvent | null): TurnEvent | null {
  const target = wake.sessionId ? wake : lastTurn;
  return target ? { ...target, type: "wake" } : null;
}

/** Wake/adopted exchanges listen first; ordinary turns read the remaining response first. */
export function startsConversationByListening(event: Pick<TurnEvent, "type">, announcedCapture = false): boolean {
  return event.type === "wake" || announcedCapture;
}

type OrderedTurnEvent = Pick<TurnEvent, "type" | "sessionId" | "eventAt">;
const STATE_EVENT_TYPES = new Set<TurnEvent["type"]>(["working", "turn-end", "needs-you"]);
const HANDOFF_URGENCY: Partial<Record<TurnEvent["type"], number>> = {
  working: 1,
  "turn-end": 2,
  "needs-you": 3,
};

/**
 * Remove the next queued session event without sorting the queue. Imperative
 * events are LIFO barriers: only the state-event cohort newer than the latest
 * command is reordered, preserving wake/speak/mode command semantics.
 */
export function takeNextQueuedEvent(queue: TurnEvent[], order: HandoffOrder): TurnEvent | undefined {
  if (!queue.length) return undefined;
  if (order === "newest") return queue.pop(); // exact current/default behavior

  let latestCommand = -1;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (!STATE_EVENT_TYPES.has(queue[i]!.type)) {
      latestCommand = i;
      break;
    }
  }
  const cohortStart = latestCommand + 1;
  if (cohortStart === queue.length) return queue.pop();

  let selected = cohortStart;
  if (order === "urgency") {
    for (let i = cohortStart + 1; i < queue.length; i++) {
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

export async function runDaemon(cfg: Config): Promise<void> {
  const rendererSelection = configureRenderer();
  const rendererLifecycle = installRendererLifecycle(rendererSelection.renderer);
  const theaterMode = rendererSelection.kind === "theater";
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
  let paused = persisted.paused; // "away" mode: quiet, but HOLD finished sessions to replay on resume
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
  let pendingMicControl: "pause" | "mute" | null = null;
  const injectedAt = new Map<string, number>(); // session -> last time conch drove it
  const pending = new Map<string, TurnEvent>(); // sessions that finished while paused — latest per session
  // Live session status for the dashboard panel — replaces the spoken "needs you"
  // nag with a glanceable visual: working (you submitted a prompt) / waiting (turn
  // ended, ready for you) / needs (a permission/idle notification fired).
  const sessionStates = new Map<string, { label: string; status: SessionStatus; detail?: string; at: number }>();
  const eventOrder = new TurnEventOrder();
  // Arrow-key session picker: `panelOrder` mirrors the panel's on-screen order,
  // `selectedId` is the highlighted row. `cursorAuto` = the cursor follows whoever
  // conch is interacting with; arrowing takes manual control, and arrowing off
  // either end releases back to auto (no cursor when idle — so mute/pause read as
  // global, not "just this one").
  let panelOrder: string[] = [];
  let selectedId: string | null = null;
  let cursorAuto = true;
  // Per-session snooze: sessions you've paused to focus elsewhere. They stay on
  // the panel (marked ⏸) but never bell/read/open-mic until you resume them.
  const pausedSessions = new Set<string>();
  // The single most-recent turn-end held per snoozed session (overwritten, never
  // a backlog) so resuming can catch you up on just the latest — nothing older.
  const snoozedLatest = new Map<string, TurnEvent>();
  // The turn-end currently being read aloud (if any) — so snoozing THAT session
  // stops the read on the spot instead of letting it finish + open the mic.
  let recitingEvent: TurnEvent | null = null;

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
    if (!eventOrder.accept(event)) return;
    if ((event.type === "pause" || event.type === "mute") && activeDictation) {
      // Close the producer gate synchronously while this event waits behind
      // the busy conversation. The active loop drains/submits before the mode
      // event is allowed to speak its acknowledgement.
      activeDictation.requestExternal(event.type);
    } else if (
      (event.type === "pause" || event.type === "mute")
      && (normalMicReserved || bargeHandoffOpen)
    ) {
      // A control event can land in the atomic audio-to-mic handoff before a
      // concrete controller exists. Remember the first action so that boundary
      // closes without opening a normal producer.
      pendingMicControl ??= event.type;
    }
    const i = event.type === "speak"
      ? -1
      : queue.findIndex((e) => e.sessionId === event.sessionId && e.type === event.type);
    if (i !== -1) queue.splice(i, 1); // newer event for the same session supersedes
    if (event.type === "pause" || event.type === "mute") {
      queue.push(event); // control changes always run next after the drained conversation
    } else {
      const controlIndex = queue.findIndex((queued) => queued.type === "pause" || queued.type === "mute");
      if (controlIndex === -1) queue.push(event);
      else queue.splice(controlIndex, 0, event); // keep the control event at the pop() end
    }
    void drain();
  }

  async function drain(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await ttsStartup;
      if (shuttingDown) return;
      if (stopKey && queue.length) {
        const skipped = takeNextQueuedEvent(queue, cfg.handoffOrder)!;
        stopKey = false;
        log(`⏹ spacebar — skipped queued ${skipped.type} for "${skipped.label}" during TTS startup`);
      }
      while (queue.length) {
        const event = takeNextQueuedEvent(queue, cfg.handoffOrder)!;
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

  /** Wire listen-phase state + live partials into the status line. */
  function listenHooks(label: string): ListenHooks {
    return {
      onState: (s) => {
        if (s === "armed") setState("listening", label);
        else if (s === "capturing") setState("recording", label);
        else setState("transcribing", label);
      },
      onPartial: (text) => setState("recording", label, text),
    };
  }

  // The at-rest status when nothing's in flight: muted wins over paused for display.
  const restState = (): ConchState => (muted ? "muted" : paused ? "paused" : "idle");

  const ROW_LIVE_STATES = new Set<ConchState>(["listening", "recording", "speaking", "transcribing"]);
  let panelRenderVersion = 0;
  async function renderSessionPanel(): Promise<void> {
    const version = ++panelRenderVersion;
    let snap: Awaited<ReturnType<typeof registrySnapshot>> = null;
    try {
      snap = await registrySnapshot(cfg.claudeDir);
    } catch {}
    const live = snap?.infos ?? [];
    // Prune a latch only on a COMPLETE snapshot — a torn/unreadable file must not
    // delete a live session's latch (e.g. a pending "needs"), which never re-fires.
    if (snap?.complete) {
      const liveIds = new Set(live.map((s) => s.sessionId));
      for (const id of sessionStates.keys()) {
        if (liveIds.has(id)) continue;
        sessionStates.delete(id);
        eventOrder.forget(id);
      }
    }
    const liveState = getLiveState(); // what conch is doing right now, if anything
    const activeSessionId = ROW_LIVE_STATES.has(liveState.state)
      ? (
        theaterMode && recitingEvent && live.some((session) => session.sessionId === recitingEvent!.sessionId)
          ? recitingEvent.sessionId
          : live.find((session) => sessionLabel(session, session.cwd) === liveState.label)?.sessionId ?? null
      )
      : null;
    // Auto-follow: in auto mode the cursor tracks the session conch is engaged
    // with (or clears when nothing's live). Manual selection is left untouched.
    if (cursorAuto) {
      selectedId = activeSessionId;
    } else if (selectedId && !live.some((session) => session.sessionId === selectedId)) {
      selectedId = null; // manually-selected session closed
    }

    const contentEvent = recitingEvent ?? lastTurn;
    let replyText = liveState.reading?.text ?? "";
    if (theaterMode && !replyText && contentEvent?.transcriptPath) {
      replyText = stripMarkdown(await lastAssistantText(contentEvent.transcriptPath));
    }
    // Registry and transcript reads can overlap; only the newest complete model
    // may reach the renderer.
    if (version !== panelRenderVersion) return;
    const model = buildPanelModel({
      sessions: live,
      sessionStates,
      snoozedSessionIds: pausedSessions,
      live: liveState,
      mode: { muted, paused, holding: pending.size },
      activeSessionId,
      navSelectedId: cursorAuto ? null : selectedId,
      reply: contentEvent && replyText
        ? {
          sessionId: contentEvent.sessionId,
          text: replyText,
          spokenChars: liveState.reading?.spokenChars ?? 0,
        }
        : null,
    });
    panelOrder = model.rows.map((row) => row.sessionId);
    // Read mode state after the async registry snapshot so a slow older redraw
    // cannot repaint a stale pause/mute banner over a newer toggle.
    model.mode = { muted, paused, holding: pending.size };
    renderPanel(model);
  }
  function setSessionState(
    sessionId: string,
    label: string,
    status: SessionStatus,
    detail?: string,
    eventAt?: number,
  ): boolean {
    if (!sessionId) return true; // nothing to latch; preserve the event's non-panel behavior
    // Legacy clients without eventAt may still work, but their latch is oldest
    // possible truth and can never clobber a timestamped hook or registry state.
    const at = eventTimestamp(eventAt);
    const incoming = { label, status, detail, at };
    if (latestLatchedState(sessionStates.get(sessionId), incoming) !== incoming) return false;
    sessionStates.set(sessionId, incoming);
    void renderSessionPanel();
    return true;
  }

  async function setMuted(next: boolean): Promise<void> {
    muted = next;
    writeState({ muted, paused }); // persist so a restart doesn't un-mute
    void renderSessionPanel(); // visual feedback must not wait on fallible audio
    log(muted ? "muted — announcements and mic off (m or `conch unmute` to resume)" : "unmuted");
    setState(restState());
    await speak(cfg, muted ? "Muted." : "Back on.");
  }

  // "Away" mode: quiet like mute, but HOLD every session that finishes so they
  // replay on resume instead of being dropped. Persisted across restarts.
  async function setPaused(next: boolean): Promise<void> {
    paused = next;
    writeState({ muted, paused });
    void renderSessionPanel(); // clear/show immediately, before speech or registry work
    if (paused) {
      log("paused — holding finished sessions until you resume (p or `conch resume`)");
      setState("paused");
      await speak(cfg, "Paused. I'll hold your queue.");
      return;
    }
    const held = [...pending.values()];
    pending.clear(); // snapshot + clear synchronously, before any await
    // Drop entries that went stale while you were away: the session has since
    // closed, or you already replied in text so the conversation moved on. Tri-
    // state liveness — a registry READ FAILURE (null liveIds) must NOT be read as
    // "all closed" (that would nuke the whole queue); on that uncertainty we keep.
    const liveIds = (await registrySnapshot(cfg.claudeDir))?.liveIds ?? null;
    const fresh: TurnEvent[] = [];
    for (const ev of held) {
      if (liveIds && !liveIds.has(ev.sessionId)) continue; // session closed
      if (await userRespondedSince(ev.transcriptPath, ev.mark)) continue; // you moved on
      fresh.push(ev);
    }
    const dropped = held.length - fresh.length;
    log(`resumed — ${fresh.length} session(s) waited while you were away${dropped ? ` (${dropped} stale, dropped)` : ""}`);
    setState(restState());
    // Enqueue the replay BEFORE the (fallible) summary speak: (1) loss-safe — a
    // TTS throw can't discard the snapshot; (2) a newer same-session turn-end that
    // arrives during the summary correctly SUPERSEDES its replay (enqueue dedups to
    // the latest), instead of the old replay clobbering the newer event.
    for (const ev of fresh) enqueue(ev); // each announces in turn (barge/spacebar to skip)
    await speak(cfg, fresh.length
      ? `Back. ${fresh.length} session${fresh.length === 1 ? "" : "s"} finished while you were away.`
      : "Back on.");
  }

  async function handle(event: TurnEvent): Promise<void> {
    stopKey = false; // a stale press from a past exchange must not skip this one
    micOpen = false; // no listen in flight yet for this event
    if (event.type === "mute") return setMuted(true);
    if (event.type === "unmute") return setMuted(false);
    if (event.type === "pause") return setPaused(true);
    if (event.type === "resume") return setPaused(false);
    if (event.type === "speak") {
      const speechCfg = event.voice ? { ...cfg, ttsVoices: [event.voice] } : cfg;
      return speak(speechCfg, event.announce, event.label);
    }
    if (!eventOrder.isCurrent(event)) return;

    const audibleTurn = shouldHandleTurnAudibly(event, cfg.workingMic);

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
      "waiting",
      undefined,
      event.eventAt,
    )) return;

    // Per-session snooze: this project is paused so you can focus elsewhere. Keep
    // it on the panel (marked ⏸ by renderSessionPanel) but stay quiet — no bell,
    // no read, no mic — until you resume it. An explicit `wake` still cuts through.
    if (audibleTurn && pausedSessions.has(event.sessionId)) {
      lastTurn = event; // space/wake can still reach it
      snoozedLatest.set(event.sessionId, event); // keep ONLY the latest — resume replays this one
      return log(`⏸ "${event.label}" snoozed — enter on it (or conch wake) to resume`);
    }

    // Paused ("away"): hold whatever finishes so it replays on resume — the key
    // difference from mute, which drops it. `wake` always cuts through.
    if (paused && event.type !== "wake") {
      pending.set(event.sessionId, event); // latest per session
      lastTurn = event; // wake still finds the newest
      void renderSessionPanel(); // update the visible deduplicated holding count
      return log(`paused — holding "${event.label}" (${pending.size} waiting)`);
    }

    // Nobody's there: don't announce to an empty room, don't open the mic,
    // don't burn battery on sox/whisper. Telegram (the other hook) still
    // pings the phone. `conch wake` always cuts through.
    // Only reach for ioreg when the away-timer is actually armed (default off) —
    // muted short-circuits without spawning anything.
    if (event.type !== "wake" && (muted || cfg.awayAfterSecs)) {
      const idle = muted ? 0 : (await idleSeconds() ?? 0); // null probe → 0 → not away (fail safe)
      if (muted || idle >= cfg.awayAfterSecs) {
        log(`${muted ? "muted" : `away (idle ${Math.round(idle / 60)}m)`} — staying quiet for "${event.label}"`);
        if (audibleTurn || event.ntype === "idle_prompt") lastTurn = event; // wake still finds it
        return;
      }
    }

    if (event.type === "wake") {
      const target = resolveWakeTarget(event, lastTurn); // named wake carries its own session
      if (!target) {
        log("wake with nothing to wake — no session has announced yet");
        return void (await speak(cfg, "Nothing to wake. No session has spoken yet."));
      }
      log(`wake -> "${target.label}"`);
      if (cfg.revealOnTurn && target.pid) void revealSessionWindow(target.pid); // surface it, no focus steal
      resetReadingProgress();
      recitingEvent = target;
      try {
        setState("speaking", target.label);
        await speak(cfg, `Mic open for ${target.label}.`, target.label);
        await conversationLoop(target);
      } finally {
        recitingEvent = null;
      }
      return;
    }

    log(`${event.type}${event.ntype ? `/${event.ntype}` : ""} from "${event.label}" (${event.sessionId.slice(0, 8)})`);

    // Already handled it yourself: if you typed a reply to this session (so the
    // conversation moved on) since this fired, don't read it aloud or nag for
    // input. Covers the live path AND pause-replay (both flow through here).
    if (audibleTurn && (await userRespondedSince(event.transcriptPath, event.mark))) {
      return log(`skipping "${event.label}" — you already responded, conversation moved on`);
    }

    // The finished-turn attention bell (including opted-in background-working
    // Stops). The hook hands it to the daemon so it can't ring over a live mic.
    // The bell + the read-aloud below happen regardless of what you're doing — you
    // like the heads-up while you work. Only the MIC is gated (in conversationLoop):
    // it won't open if you're handling this session by text.
    if (audibleTurn) await ringBell();

    // Surface the session's window as conch starts talking to it — raised so you
    // can watch, but WITHOUT stealing focus from wherever you're typing (AXRaise).
    if (event.type === "turn-end" && cfg.revealOnTurn && event.pid) void revealSessionWindow(event.pid);

    // An audible Stop reads the reply, then opens the mic — barge-able from the
    // very first sentence.
    const conversationParent = createRecorderParent("conversation");
    let conversationSequence = 0;
    const nextConversationSequence = () => ++conversationSequence;
    resetReadingProgress();
    recitingEvent = event; // reading this project aloud now — snoozing it stops the read here
    try {
      const announce = await speakInterruptible(
        event,
        event.announce,
        false,
        conversationParent,
        nextConversationSequence,
      );
      if (shuttingDown) return;
      if (announce.cut && !announce.heard && !announce.initialCapture && !stopKey) {
        log("announce cut by a noise blip — re-speaking");
        await speakInterruptible(event, event.announce, true);
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
  ): Promise<{
    heard: string;
    cut: boolean;
    diagnosticId?: string;
    diagnosticIds?: string[];
    initialCapture?: RecorderHandle;
    captureParent?: string;
  }> {
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
    if (stopKey) return { heard: "", cut: true };
    assertNormalMicClosed("barge-in TTS");
    const result = await speech.runInterruptible(cfg, text, event.label, async (startSpeech) => {
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
  ): Promise<void> {
    if (typeof diagnosticIds === "string") {
      emitRecorderTrace(diagnosticIds, { finalSubmittedPayload: text });
    } else if (diagnosticIds) {
      emitRecorderTraces(diagnosticIds, { finalSubmittedPayload: text });
    }
    markInjected(event.sessionId);
    // Record the utterance itself, not just the route — a mis-fire used to be
    // unrecoverable because only "injected via X" was logged, never the words.
    log(`heard → ${JSON.stringify(text)}`);

    // Baseline the target session's user-prompt count so we can CONFIRM the
    // prompt actually submitted. null ⇒ no transcript to watch, skip confirmation.
    const beforeCount = event.transcriptPath ? await transcriptMark(event.transcriptPath) : null;
    const { via } = await injectText(cfg, event.pid, text);

    if (via === "clipboard") {
      log(`injected via ${via}`);
      await speak(cfg, "Couldn't reach the session's window — your words are on the clipboard, just paste.", event.label);
      return;
    }
    if (via === "none") {
      log(`injected via ${via}`);
      await speak(cfg, "Heard you, but I could not find the session's pane.", event.label);
      return;
    }
    if (beforeCount === null) {
      log(`injected via ${via}`); // no transcript to confirm against — trust it
      return;
    }

    // The osascript path can type the text without the Return landing ("typed but
    // didn't send"). Watch the transcript for a NEW user prompt; if it doesn't
    // appear, re-press Return (the text is sitting in the input) a couple of times;
    // if it still won't take, drop the words on the clipboard so they survive.
    for (let attempt = 0; attempt < 3; attempt++) {
      await Bun.sleep(900 + attempt * 600); // give Claude Code time to write the prompt entry
      if ((await transcriptMark(event.transcriptPath!)) > beforeCount) {
        log(`injected via ${via} — confirmed sent${attempt ? ` (after ${attempt} re-send${attempt > 1 ? "s" : ""})` : ""}`);
        return;
      }
      if (attempt < 2) {
        log(`not confirmed yet — re-pressing Return (try ${attempt + 1})`);
        await injectKey(cfg, event.pid, "Enter");
      }
    }
    log(`⚠ inject via ${via} NOT confirmed — words placed on clipboard`);
    await toClipboard(text);
    await speak(cfg, "I typed that but it didn't send. Your words are on the clipboard — just paste and press return.", event.label);
  }

  /** Shared handling for anything heard while reading aloud (gap or barge-in). */
  async function onReadingUtterance(
    event: TurnEvent,
    text: string,
    spokenChunk: string,
    diagnosticId?: string,
    diagnosticIds?: string[],
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
        await deliver(event, text, diagnosticIds ?? diagnosticId);
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
  ): Promise<void> {
    let lastSpoken = event.announce;
    let sentences: string[] | null = null;
    let cursor = 0; // derived from the actual announcement once the full reply is loaded
    let bargeOff = false; // set when the echo guard proves the threshold is too low for this room
    let falseTriggers = 0; // noise blips that cancelled speech but transcribed to nothing
    const seededSegments: Array<{
      text: string;
      diagnosticId?: string;
      diagnosticIds: string[];
    }> = [];
    // A wake just reopens the mic (per the README); it must NOT recite the last
    // message from the top — the user says "continue" if they want to hear it.
    let skipReading = startsConversationByListening(event, Boolean(announcedCapture));
    let initialDictationCapture = announcedCapture;
    let initialCaptureParent = announcedCaptureParent;
    let deferredInitialExternal: ExternalDictationAction | undefined;
    const traceParent = suppliedTraceParent ?? announcedCaptureParent ?? createRecorderParent("conversation");
    let localTraceSequence = 0;
    const nextTraceSequence = suppliedNextTraceSequence ?? (() => ++localTraceSequence);

    const interruptReadForManualReply = (): Promise<void> => interruptForManualReply(
      event,
      () => cfg.interruptOnManualReply,
    );

    // Load + split the full message once, resuming after what the announcement
    // actually covered. Shared by the read-full phase and "continue".
    const ensureSentences = async (): Promise<string[]> => {
      if (!sentences) {
        sentences = splitSentences(stripMarkdown(await lastAssistantText(event.transcriptPath!)));
        cursor = countCoveredSentences(event.announce, sentences);
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
      );
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

    if (!skipReading && cfg.readFull && event.type !== "needs-you" && event.transcriptPath) {
      sentences = await ensureSentences();
      reading: while (cursor < sentences.length) {
        await interruptReadForManualReply();
        // gap between chunks: with barging available it's just a beat; with
        // barging off (echo/noise) it's the only voice interrupt, so keep it real
        const gapSecs = bargeOff ? Math.max(cfg.gapSecs, 0.6) : cfg.gapSecs;
        if (gapSecs > 0) {
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
            if (stopKey || pendingMicControl) {
              deferredInitialExternal = pendingMicControl ?? "spacebar";
              pendingMicControl = null;
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
            const action = await onReadingUtterance(event, gapText, "", gapDiagnosticId, gapDiagnosticIds);
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
        const chunk = sentences.slice(cursor, cursor + cfg.continueSentences).join(" ");
        lastSpoken = chunk;
        const result = await speakInterruptible(event, chunk, bargeOff, traceParent, nextTraceSequence);
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
        const action = await onReadingUtterance(event, result.heard, chunk, result.diagnosticId, result.diagnosticIds);
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

    // One controller spans the whole dictation exchange. SoX keeps producing
    // ordered paths while the single worker transcribes older paths; only the
    // reducer mutates held text or authorizes a cue/TTS/injection at a barrier.
    const reducer = new DictationReducer({ holdSubmit: cfg.holdSubmit });
    const session = createDictationSession(cfg, listenHooks(event.label), {
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

    const executeAction = async (action: DictationActionReadyEffect): Promise<"resume" | "done"> => {
      if (shuttingDown) {
        emitRecorderTraces(expandDiagnosticIds([
          ...action.payloadDiagnosticIds,
          ...action.actionDiagnosticIds,
          ...action.discardedDiagnosticIds,
        ]));
        return "done";
      }
      switch (action.action) {
        case "send":
        case "timeout":
        case "spacebar":
        case "pause":
        case "mute": {
          if (action.payload) {
            await micCue(cfg, "sent");
            await deliver(event, action.payload, expandDiagnosticIds(action.finalSubmittedDiagnosticIds));
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
          return action.shouldResume ? "resume" : "done";
        }
        case "repeat":
          emitTerminalRows(action);
          setState("speaking", event.label);
          await speak(cfg, lastSpoken, event.label);
          return "resume";
        case "continue": {
          emitTerminalRows(action);
          if (!event.transcriptPath) {
            await speak(cfg, "I don't have the full message for this one.", event.label);
            return "resume";
          }
          const full = await ensureSentences();
          const chunk = full.slice(cursor, cursor + cfg.continueSentences).join(" ");
          if (!chunk) {
            await speak(cfg, "That's the whole message.", event.label);
            return "resume";
          }
          lastSpoken = chunk;
          setState("speaking", event.label);
          await speak(cfg, chunk, event.label);
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
      const activelyTyping = idle !== null && idle < cfg.typingGraceSecs;
      if (activelyTyping || (await userRespondedSince(event.transcriptPath, event.mark))) {
        emitRecorderTraces(
          seededSegments.flatMap((segment) => segment.diagnosticIds),
          { intent: "text-handled", bufferCountAfterReduction: null },
        );
        return log(activelyTyping
          ? `mic held — you're typing (space or \`conch wake\` to talk to "${event.label}")`
          : `mic held — you replied to "${event.label}" by text`);
      }
    }

    if (!initialDictationCapture && !deferredInitialExternal) {
      await micCue(cfg, "open");
      if (shuttingDown) {
        emitRecorderTraces(
          seededSegments.flatMap((segment) => segment.diagnosticIds),
          { intent: "shutdown", bufferCountAfterReduction: null },
        );
        return;
      }
    }
    const initialWindow = seededSegments.length ? cfg.holdSubmitSecs : cfg.listenWindowSecs;
    log(`listening (start within ${initialWindow}s)${seededSegments.length ? " · holding" : ""}...`);
    if (shuttingDown) return;
    let needsCapture = Boolean(initialDictationCapture) || !deferredInitialExternal;
    if (needsCapture) {
      if (!(await reserveNormalMic())) return;
      if (stopKey || pendingMicControl) {
        deferredInitialExternal ??= pendingMicControl ?? "spacebar";
        pendingMicControl = null;
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

    // Establish controller ownership before reducing a seed. Non-hold mode can
    // request a terminal barrier immediately; after a drained gap external-stop,
    // the closed controller supplies that FIFO sentinel without reopening SoX.
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

    try {
      while (!terminal) {
        const controllerEvent = await session.nextEvent();
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
            if (deferredExternal) {
              const external = deferredExternal;
              const barrierReason = deferredExternalBarrierReason;
              deferredExternal = undefined;
              deferredExternalBarrierReason = undefined;
              normalMicReserved = false;
              beginExternalAction(external, barrierReason);
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
        if (!action.shouldResume) activeDictation = null;
        let result: "resume" | "done";
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
          if (deferredExternal) {
            const external = deferredExternal;
            const barrierReason = deferredExternalBarrierReason;
            deferredExternal = undefined;
            deferredExternalBarrierReason = undefined;
            normalMicReserved = false;
            beginExternalAction(external, barrierReason);
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
        while (true) {
          const pendingEvent = await session.nextEvent();
          if (pendingEvent.kind === "transcript") {
            emitRecorderTrace(pendingEvent.diagnosticId, {
              intent: "conversation-exit",
              bufferCountAfterReduction: reducer.snapshot.buffer.length,
            });
          } else if (pendingEvent.kind === "short") {
            emitRecorderTrace(pendingEvent.diagnosticId, {
              intent: "conversation-exit-short",
              bufferCountAfterReduction: reducer.snapshot.buffer.length,
            });
          } else if (pendingEvent.kind === "error") {
            emitRecorderTrace(pendingEvent.diagnosticId, {
              intent: `${pendingEvent.stage}-error`,
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
      emitRecorderTraces(pendingIds);
      resolveDictationDone();
    }
  }

  /** Permission/elicitation dialogs: "yes" -> Enter (highlighted option), "no" -> Escape. Free text is refused on purpose. */
  async function permissionLoop(event: TurnEvent): Promise<void> {
    if (shuttingDown) return;
    await micCue(cfg, "open");
    if (shuttingDown) return;
    log("listening for yes or no...");
    const session = createDictationSession(cfg, listenHooks(event.label), { tag: "permission" });
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
    if (stopKey || pendingMicControl) {
      const control = pendingMicControl;
      pendingMicControl = null;
      normalMicReserved = false;
      if (!control) consumeStopKey();
      await micCue(cfg, "close");
      return log(control ? `${control} — permission mic stayed closed` : "⏹ spacebar — closed the permission mic");
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
    if (!verdict) return void (await speak(cfg, "For permission prompts, say yes or no. Ignoring.", event.label));
    const { via } = await injectKey(cfg, event.pid, verdict === "approve" ? "Enter" : "Escape");
    if (via === "none") await speak(cfg, "Could not reach the session's window to answer — do it by hand.", event.label);
    else log(`sent ${verdict === "approve" ? "Enter" : "Escape"} via ${via}`);
  }

  const configController = createConfigController(cfg);
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
  if (paused) log("resuming paused (persisted) — p or `conch resume` to turn on");
  rendererLifecycle.enter();
  setState(restState());
  void renderSessionPanel(); // show the dashboard immediately
  setKeybar("  \x1b[2m↑↓ select · space talk · enter snooze · m mute · p pause · l logs · ? help · q quit\x1b[0m");
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
  async function numberedSessions(): Promise<Array<{ n: number; s: SessionInfo; label: string }>> {
    const sessions = await listSessions(cfg.claudeDir);
    return sessions
      .map((s) => ({ s, label: sessionLabel(s, s.cwd) }))
      .sort((a, b) => a.label.localeCompare(b.label))
      .slice(0, 9)
      .map((x, i) => ({ n: i + 1, ...x }));
  }

  async function printSessions(): Promise<void> {
    const rows = await numberedSessions();
    if (!rows.length) return log("no live sessions");
    logAbove(rows.map((r) => `  \x1b[36m${r.n}\x1b[0m ${r.label}${lastTurn?.sessionId === r.s.sessionId ? " \x1b[2m(space wakes this one)\x1b[0m" : ""}`).join("\n"));
  }

  /** Audition every live session in its assigned voice — `conch voice <session> <voice>` reassigns. */
  async function auditionVoices(): Promise<void> {
    if (busy) return log("busy — audition after the current exchange");
    busy = true;
    try {
      const rows = await numberedSessions();
      if (!rows.length) return log("no live sessions");
      for (const r of rows) {
        logAbove(`  \x1b[36m${r.n}\x1b[0m ${r.label} — \x1b[35m${voiceFor(cfg, r.label)}\x1b[0m`);
        await speak(cfg, `${r.label} sounds like this.`, r.label);
      }
      logAbove('  \x1b[2mreassign: conch voice <session> <kokoro-voice>\x1b[0m');
    } finally {
      busy = false;
      setState(restState());
      void drain();
    }
  }

  async function wakeByNumber(n: number): Promise<void> {
    const rows = await numberedSessions();
    const row = rows.find((r) => r.n === n);
    if (!row) return log(`no session #${n} — press s to list`);
    enqueue({
      type: "wake",
      sessionId: row.s.sessionId,
      label: row.label,
      cwd: row.s.cwd,
      pid: row.s.pid,
      announce: "",
      transcriptPath: findTranscript(cfg.claudeDir, row.s.sessionId),
    });
  }

  /** Open the mic for a specific session by id (the arrow-key picker's Enter action). */
  async function wakeBySessionId(id: string): Promise<void> {
    const s = (await listSessions(cfg.claudeDir)).find((x) => x.sessionId === id);
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

  /** Move the panel selection by delta; off either end releases the cursor to auto. */
  function moveSelection(delta: number): void {
    if (!panelOrder.length) return;
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

  // The guaranteed stop while reciting or mid-exchange (space, Enter, and snooze
  // all share it). Cancels playback + closes the mic; the controller's FIFO
  // barrier still drains and submits every already-captured tail.
  const stopReciting = (src: string) => {
    stopKey = true;
    speech.cancelCurrent();
    speech.cancelPendingAudio();
    activeDictation?.requestExternal("spacebar");
    log(activeDictation?.session.micOpen || micOpen ? `⏹ ${src} — closing mic` : `⏹ ${src} — stopped`);
  };

  /** Snooze the selected session (goes quiet until resumed) or resume it if already snoozed. */
  function toggleSnooze(id: string): void {
    const label = sessionStates.get(id)?.label ?? id.slice(0, 8);
    if (pausedSessions.delete(id)) {
      log(`▶ resumed "${label}"`);
      const latest = snoozedLatest.get(id);
      snoozedLatest.delete(id);
      // Catch you up on JUST the latest turn from while it was snoozed. Re-entering
      // handle() means a text reply you already sent (userRespondedSince) correctly
      // skips it, and the typing gate still applies to its mic.
      if (latest) enqueue(latest);
    } else {
      pausedSessions.add(id);
      snoozedLatest.delete(id); // start the snooze clean
      log(`⏸ snoozed "${label}" — it stays quiet until you resume it`);
      // Snoozing the project it's reading aloud right now: stop the read here (don't
      // finish + open the mic) and hold this turn so resume picks up the latest.
      if (recitingEvent?.sessionId === id) {
        snoozedLatest.set(id, recitingEvent);
        stopReciting("snooze");
      }
    }
    void renderSessionPanel();
  }

  // Interactive keys when running in a terminal.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (d) => {
      const c = d.toString();
      if (c === " ") {
        if (busy) stopReciting("spacebar");
        else if (selectedId) void wakeBySessionId(selectedId); // talk to the selected session
        else enqueue({ type: "wake", sessionId: "", label: "", announce: "" }); // else the last-announced
      }
      // ↑/↓ move the panel cursor (normal `[` and application `O` escape forms).
      else if (c === "\x1b[A" || c === "\x1bOA") moveSelection(-1);
      else if (c === "\x1b[B" || c === "\x1bOB") moveSelection(1);
      // Enter: snooze / resume the selected session (per-session pause).
      else if (c === "\r" || c === "\n") {
        if (selectedId) toggleSnooze(selectedId);
        else void printSessions();
      }
      else if (c >= "1" && c <= "9") void wakeByNumber(Number(c));
      else if (c === "s") void printSessions();
      else if (c === "l") { const on = setLogsVisible(!logsShown()); log(on ? "logs on — press l to hide" : "logs off"); }
      else if (c === "v") void auditionVoices();
      else if (c === "m") enqueue({ type: muted ? "unmute" : "mute", sessionId: "", label: "", announce: "" });
      else if (c === "p") enqueue({ type: paused ? "resume" : "pause", sessionId: "", label: "", announce: "" });
      else if (c === "?" || c === "h") printHelp();
      else if (c === "q" || c === "\u0003") void shutdown();
    });
    printHelp();
  }
}

function printHelp(): void {
  logAbove(
    [
      "",
      "  \x1b[1mkeys\x1b[0m   \x1b[36m↑↓\x1b[0m select   \x1b[36mspace\x1b[0m talk / stop   \x1b[36menter\x1b[0m snooze/resume   \x1b[36ml\x1b[0m logs   \x1b[36mv\x1b[0m voices   \x1b[36mm\x1b[0m mute   \x1b[36mp\x1b[0m pause   \x1b[36mq\x1b[0m quit",
      "  \x1b[2m\x1b[36mm\x1b[0m\x1b[2m mute = quiet + mic off, forgets what finishes   ·   \x1b[36mp\x1b[0m\x1b[2m pause = quiet + mic off, HOLDS what finishes and replays it on resume\x1b[0m",
      '  \x1b[1mvoice\x1b[0m  \x1b[36m"continue"\x1b[0m read more   \x1b[36m"repeat"\x1b[0m again   \x1b[36m"stop"\x1b[0m end reading   \x1b[36m"no response needed"\x1b[0m close mic',
      "  \x1b[1msettings\x1b[0m  conch settings \x1b[2m(list)\x1b[0m · set <key> <value> · get <key> · unset <key>   \x1b[2m— e.g. conch set end-silence 2.5\x1b[0m",
      "  \x1b[1mcli\x1b[0m    conch wake [name] · sessions · voice <session> <voice> · mute · pause · doctor",
      "",
    ].join("\n"),
  );
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
