import type { Config } from "./config.ts";
import type { TurnEvent } from "./hook.ts";
import { presentedTo, type AudioHolder } from "./audio-holder.ts";
import { voiceFor } from "./speak.ts";
import type { SpeechManager } from "./speech-manager.ts";
import * as listen from "./listen.ts";
import type { ListenHooks, RuntimeDictationSession } from "./listen.ts";
import type { RecorderHandle } from "./dictation-controller.ts";
import * as inject from "./inject.ts";
import {
  APPROVAL_KEYBOARD,
  APPROVAL_KEYS,
  APPROVAL_REASK,
  approvalAnnounce,
  approvalDetail,
  classifyApprovalAnswer,
  confirmAlwaysPrompt,
  confirmsAlways,
  pendingApproval,
  type PendingApproval,
} from "./approval.ts";
import { transcriptFormatFor } from "./agent-adapter.ts";
import { injectProviderCommand as providerCommand, isProviderCommandLine } from "./provider-rename.ts";
import { classifyReadingGap, parseNameAddress, wordOverlapRatio } from "./commands.ts";
import { lastAssistantText, splitSentences, stripMarkdown, countCoveredSentences, userRespondedSince, transcriptMark } from "./snippet.ts";
import {
  lastAssistantReply,
  latestAnswerableQuestion,
  readConversationTail,
  withSharedNote,
  type Conversation,
} from "./conversation.ts";
import { isWindowKey } from "./window-key.ts";
import { clipboardFallbackError } from "./app-errors.ts";
import { recordTelemetry } from "./telemetry.ts";
import { askClaude, type AskClaude } from "./model.ts";
import { routeVoicePrompt } from "./voice-qa.ts";
import {
  clearReadingProgress,
  publishDictation,
  setMicLevel,
  setReadingProgress,
  setState,
  setTranscriptPrefix,
  type ConchState,
} from "./status.ts";
import { findSessionBySpokenName, findTranscript, sessionLabel, type SessionInfo } from "./sessions.ts";
import { eventTimestamp, type SessionLedger } from "./session-ledger.ts";
import type { EventQueue } from "./event-queue.ts";
import { sessionHasLiveBackgroundWork } from "./agent-activity.ts";
import { carriedReview, latestLatchedState, type SessionStatus } from "./panel.ts";
import { gateTurnForControls } from "./instant-controls.ts";
import {
  emitRecorderTrace,
  emitRecorderTraces,
  createRecorderParent,
  updateRecorderTrace,
} from "./diagnostics.ts";
import {
  DictationReducer,
  classifySpokenChoice,
  classifySpokenChoices,
  type DictationActionReadyEffect,
  type DictationReducerEffect,
  type ExternalDictationAction,
} from "./dictation-reducer.ts";
import { assertNormalMicClosed as assertAudioGate } from "./audio-gate.ts";
import {
  createManualReplyListenGuard,
  interruptForManualReply,
  manualReplyListenBaseline,
  ManualReplyInterrupt,
  watchManualReplyDuringSpeech,
  type ManualReplyListenGuard,
} from "./manual-reply.ts";
import type { PauseController } from "./pause-controller.ts";

/**
 * The voice loop: wake → speak → listen → deliver (cut four of the daemon
 * split, see docs/architecture.md).
 *
 * Everything that makes sound, opens the mic or types into a session for a
 * turn lives here, closing over its own state instead of `runDaemon`'s. The
 * daemon keeps intake (`enqueue`), the audio lease and holder, the phone
 * speech latch, the one window-raise door, device commands and shutdown, and
 * hands the loop what it needs as `VoiceLoopDeps`. This module must never
 * import `daemon.ts`; the daemon re-exports the helpers below.
 *
 * The mic must never open while TTS is speaking: every capture start sits
 * behind `reserveNormalMic()` → `speech.quiescent()`, and the speech manager's
 * gate asks `capturing()` — the same four-term answer the stop contract uses.
 */

export type AudioSink = "mac" | "phone";

/** Sink-aware reservation seam, exported so the post-await race stays tested. */
export async function reserveNormalMicForSink(options: {
  sink(): AudioSink;
  /** C9b Cut B: false while another Mac holds this daemon's audio. Re-checked after the await, like the sink. */
  voicedHere?(): boolean;
  shuttingDown(): boolean;
  setReserved(value: boolean): void;
  quiescent(): Promise<void>;
}): Promise<boolean> {
  const here = (): boolean => options.sink() === "mac" && (options.voicedHere?.() ?? true);
  if (!here()) return false;
  options.setReserved(true);
  await options.quiescent();
  if (!options.shuttingDown() && here()) return true;
  options.setReserved(false);
  return false;
}

/** Only a genuine turn end, or an explicitly opted-in reclassified Stop, owns audio. */
export function shouldHandleTurnAudibly(
  event: Pick<TurnEvent, "type" | "backgroundWork" | "approval">,
  workingMic: boolean,
): boolean {
  return event.type === "turn-end"
    || (event.type === "working" && event.backgroundWork === true && workingMic)
    // A permission dialog with a voice is an announced turn: same gates, same holds (B5).
    || (event.type === "needs-you" && event.approval !== undefined);
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
  if (!target) return null;
  // Intent belongs to the REQUEST, not to whichever session it resolves to.
  // A bare wake resolves to the last session that spoke, and that remembered
  // event knows nothing about the button just pressed — so asking for the
  // composer and being answered into the session is exactly the confusion
  // this whole change exists to remove.
  return {
    ...target,
    type: "wake",
    ...(wake.compose ? { compose: true as const } : {}),
  };
}

/** Wake/adopted exchanges listen first; ordinary turns read the remaining response first. */
export function startsConversationByListening(event: Pick<TurnEvent, "type">, announcedCapture = false): boolean {
  return event.type === "wake" || announcedCapture;
}

/** Ordinals are safe to rewrite only while the transcript still contains an unanswered option row. */
export function choiceReplyForConversation(heard: string, conversation: Conversation): string {
  const question = latestAnswerableQuestion(conversation);
  if (!question) return heard;
  if (question.multiSelect) {
    const selected = classifySpokenChoices(heard, question.options);
    if (!selected) return heard;
    return question.options
      .filter((_, index) => selected.has(index))
      .map((option) => option.label)
      .join(", ");
  }
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
    setMicLevel?(level: number): void;
  } = { setState, setTranscriptPrefix, setMicLevel },
  /** Called the first time the recorder actually arms — the honest "you can talk now". */
  onArmed?: () => void,
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
      if (state === "armed") {
        onArmed?.();
        status.setState("listening", label);
      }
      else if (state === "capturing") status.setState("recording", label);
      else status.setState("transcribing", label);
    },
    onPartial: (text) => {
      // Footer remains the current capture only; theater separately reads the
      // authoritative committed prefix installed immediately afterward.
      status.setState("recording", label, text);
      refreshTranscriptPrefix();
    },
    onLevel: (level) => status.setMicLevel?.(level),
  };
}

/**
 * A session's last reply, for showing or saying. A window of a shared
 * session reads its own branch through the conversation loader, with its
 * registry entry (A8) — the file-level reader returns whichever window wrote
 * last. Anything else keeps the cached reader it always used. `shared` is
 * the loader's word that the branch could not be told apart, so the whole
 * file came back: the TUI preview and the voice say so, as the apps do.
 */
export async function lastReplyFor(
  path: string,
  sessionId: string,
  window: SessionInfo | undefined,
): Promise<{ text: string; shared: boolean }> {
  if (!isWindowKey(sessionId)) return { text: await lastAssistantText(path), shared: false };
  const conversation = await readConversationTail(path, sessionId, transcriptFormatFor(path), {
    window,
  });
  return { text: lastAssistantReply(conversation), shared: conversation.shared === true };
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

export interface VoiceLoopDeps {
  cfg: Config;
  log(message: string): void;
  /** Carries `lastTurn`, which both the loop and the daemon write. */
  ledger: SessionLedger;
  pause: PauseController;
  queue: Pick<EventQueue, "consumeCancellation">;
  speech: SpeechManager;
  /** Read-only here: the daemon owns the phone lease and the holder record. */
  audio: {
    lease: { readonly sink: AudioSink; isPhone(): boolean };
    holder: Pick<AudioHolder, "holder" | "isLocal">;
  };
  /** A modal or a meeting holds quiet. */
  quietOverrideBlocked(): boolean;
  /** The registry entry the dashboard last committed for this session or window. */
  window(sessionId: string): SessionInfo | undefined;
  /** The registry check: true when a complete snapshot says the session exited. */
  sessionGone(sessionId: string): Promise<boolean>;
  render(): void;
  // Property signatures, not methods, for these two: the exact-site guards count their calls by name and open paren.
  presentElsewhere: (holder: string, text: string, voice: string, label: string, localSessionKey: string) => void;
  phoneLatch: { arm(text?: string): void; clear(): void };
  raiseWindow: (pid: number, why: string) => Promise<boolean>;
  reportError(operation: string, message: string, sessionId?: string, state?: Record<string, unknown>): void;
  /** Reload an idle-unloaded whisper-server under whatever plays before the mic opens. */
  prewarmEar(): void;
  /** Pause, resume and an explicit speak, called after the loop's per-event reset. */
  control(event: TurnEvent): Promise<void>;
  terminal?: {
    injectText: typeof inject.injectText;
    injectKey: typeof inject.injectKey;
    injectProviderCommand: typeof providerCommand;
    toClipboard: typeof inject.toClipboard;
  };
  ear?: {
    createDictationSession: typeof listen.createDictationSession;
    listenGap: typeof listen.listenGap;
    armBargeRecorder: typeof listen.armBargeRecorder;
    killActiveRecorders: typeof listen.killActiveRecorders;
  };
}

export interface VoiceLoop {
  handle(event: TurnEvent): Promise<void>;
  speak(speechCfg: Config, text: string, label?: string, volunteered?: boolean, sessionId?: string): Promise<void>;
  speakBlocker(volunteered: boolean): "mic-open" | "manual" | null;
  /** Exactly the four-term mic gate — never just `micOpen` (see the stop contract in control-server.ts). */
  capturing(): boolean;
  /** Space: the guaranteed stop. Drains and submits whatever was already captured. */
  stop(src: string): void;
  consumeStop(): boolean;
  /** Synchronous, never awaits: a device transfer cancels, flips and acks in one tick (F5). */
  closeMic(reason: string): void;
  /** Seal the loop for shutdown; resolves when the open dictation, if any, has drained. */
  close(): Promise<void> | undefined;
  current(): {
    reciting: TurnEvent | null;
    handling: TurnEvent | null;
    handlingPauseGeneration: number | null;
    dictation: RuntimeDictationSession | null;
  };
}

export function createVoiceLoop(deps: VoiceLoopDeps): VoiceLoop {
  const { cfg, log, ledger, pause, speech, presentElsewhere, raiseWindow, sessionGone, prewarmEar, control } = deps;
  const eventQueue = deps.queue;
  const audioLease = deps.audio.lease;
  const audioHolder = deps.audio.holder;
  const explicitQuietOverrideBlocked = deps.quietOverrideBlocked;
  const renderSessionPanel = deps.render;
  const recordDaemonError = deps.reportError;
  const armPhoneSpeechLatch = (text: string): void => deps.phoneLatch.arm(text);
  const clearPhoneSpeechLatch = (): void => deps.phoneLatch.clear();
  const {
    injectedAt,
    pending,
    sessionStates,
    eventOrder,
    pausedSessionIds,
    resumedSessionIds,
    dismissedSessionIds,
    sessionHeldTurns,
    dismissedHeldTurns,
  } = ledger;
  // The moved bodies call these by name; tests swap in terminals and ears that touch nothing.
  const { injectText, injectKey, injectProviderCommand, toClipboard } = deps.terminal ?? {
    injectText: inject.injectText,
    injectKey: inject.injectKey,
    injectProviderCommand: providerCommand,
    toClipboard: inject.toClipboard,
  };
  const { createDictationSession, listenGap, armBargeRecorder, killActiveRecorders } = deps.ear ?? listen;
  // Read cfg.haikuTimeoutSecs at call time — the config socket mutates cfg in
  // place for live settings, so a fresh read here honors `conch set haiku-timeout`
  // without a daemon restart.
  const askHaiku: AskClaude = (prompt, opts) =>
    askClaude(prompt, { timeoutMs: cfg.haikuTimeoutSecs * 1000, ...opts });
  const resetConversationTranscriptPrefix = (): void => setTranscriptPrefix("");
  const resetReadingProgress = (): void => clearReadingProgress();
  const updateReadingProgress = (text: string, spokenChars: number): void => {
    setReadingProgress(text, spokenChars);
  };
  let stopKey = false; // spacebar pressed while reciting — the guaranteed interrupt
  let micOpen = false; // true while a dictation/permission listen is in flight — spacebar closes it
  let micRequestedAt: number | null = null; // set when a wake is accepted, cleared when the mic opens
  let activeDictation: {
    session: RuntimeDictationSession;
    requestExternal(action: ExternalDictationAction, barrierReason?: string): void;
    done: Promise<void>;
  } | null = null;
  let shuttingDown = false; // set by close(): no fresh mic, no fresh speech past shutdown
  let normalMicReserved = false;
  let bargeHandoffOpen = false;
  // The turn currently being handled, used by PauseController's scoped edge.
  let recitingEvent: TurnEvent | null = null;
  let handlingEvent: TurnEvent | null = null;
  let handlingPauseGeneration: number | null = null;

  const normalMicOpen = (): boolean => Boolean(
    activeDictation?.session.micOpen || micOpen || normalMicReserved || bargeHandoffOpen
  );
  const assertNormalMicClosed = (operation: string): void => assertAudioGate(normalMicOpen, operation);

  const reserveNormalMic = async (): Promise<boolean> => {
    // The phone holding the voice means it holds the EAR too. Gating only the
    // announce path left the Mac's mic opening anyway: it transcribed Tyler
    // from across the room, tried to inject, failed to the clipboard, and lost
    // the words — while the phone was delivering the same sentence correctly.
    // Two open mics is not a degraded mode, it is a broken one.
    return reserveNormalMicForSink({
      sink: () => audioLease.sink,
      voicedHere: () => audioHolder.isLocal(),
      shuttingDown: () => shuttingDown,
      setReserved: (value) => { normalMicReserved = value; },
      quiescent: () => speech.quiescent(),
    });
  };

  /**
   * Why `speak` would drop a line right now, or null when it will reach the
   * speech lane. Kept in step with the two checks at the top of `speak` — the
   * synchronous `audio-present` entry has to answer "held" without awaiting.
   */
  const speakBlocker = (volunteered: boolean): "mic-open" | "manual" | null =>
    normalMicOpen() ? "mic-open" : pause.paused && !volunteered ? "manual" : null;

  const speak = async (
    speechCfg: Config,
    text: string,
    label = "",
    // True when a person asked for this sound directly — a recite, an explicit
    // `conch speak`. Those are answers, not conch volunteering, so manual mode
    // does not silence them.
    volunteered = false,
    // The session this line belongs to, when the caller knows it; a yielded
    // daemon tags the outbox item with it so the holder can name it (C9b).
    sessionId = "",
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

    // C9b Cut B, outbox site 2 of 2 (F6): another Mac holds this daemon's
    // audio. Only what a person asked for out loud travels — a recite, an
    // explicit `conch speak`; every other line returns silently, exactly as
    // the phone branch below does. Between the manual check and the state
    // change, so nothing is ever left latched "speaking" (F3).
    const holder = presentedTo(audioHolder.holder, audioLease.sink);
    if (holder) {
      if (volunteered) presentElsewhere(holder, text, voiceFor(speechCfg, label), label, sessionId);
      else log(`held "${label || "announcement"}" — ${holder.slice(0, 8)} has the audio`);
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
   * Raise a session window unless you're actively typing right now. Read at call
   * time so `conch set reveal-typing-grace` applies live. An unreadable idle
   * time reveals (the raise is the normal behavior; the gate is the exception).
   */
  const revealUnlessTyping = async (pid: number): Promise<void> => {
    if (cfg.revealTypingGraceSecs > 0) {
      const idle = await idleSeconds();
      if (idle !== null && idle < cfg.revealTypingGraceSecs) return;
    }
    await raiseWindow(pid, "turn-end");
  };

  const micCue = async (cueCfg: Config, kind: "open" | "close" | "sent"): Promise<void> => {
    if (!cueCfg.micCues) return;
    const started = Date.now();
    await speech.playCue(CUE_SOUND[kind], `${kind} mic cue`);
    // Reported only when it is slow enough to be felt. The cue is a sound plus
    // a deliberate settle, so it is never free — but if it grows into seconds
    // it is indistinguishable from the mic being broken, which is exactly how
    // the last two delays were experienced.
    const took = Date.now() - started;
    if (kind === "open" && took > 700) log(`mic cue took ${(took / 1000).toFixed(1)}s`);
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

  function latestVisibleTurn(): TurnEvent | null {
    return ledger.lastTurn && !dismissedSessionIds.has(ledger.lastTurn.sessionId) ? ledger.lastTurn : null;
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

  async function handle(event: TurnEvent): Promise<void> {
    stopKey = false; // a stale press from a past exchange must not skip this one
    micOpen = false; // no listen in flight yet for this event
    if (event.type === "interrupt") return void (await interruptSession(event));
    // Pause, resume and an explicit speak stay in the daemon: they need its
    // resume transitions, the modal check and the pause origins.
    if (event.type === "pause" || event.type === "resume" || event.type === "speak") return control(event);
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

      // A slash line IS the agent's own command (B4), so it takes the door B2
      // built for `/model` rather than the message route below: no spoken-
      // choice matching, no voice Q&A, submitted even with auto-submit off,
      // and no confirm-by-transcript loop — that loop re-presses Return when
      // the transcript does not grow, and a bare `/model` is a picker, so the
      // retries would choose for you.
      if (isProviderCommandLine(event.announce)) {
        const line = event.announce.trim();
        const delivery = await injectProviderCommand(cfg, { pid: event.pid }, line);
        if (delivery.kind === "delivered") {
          log(`typed ${line} into "${event.label}" via ${delivery.via}`);
        } else {
          log(`could not type ${line} into "${event.label}": ${delivery.reason}`);
          recordDaemonError(
            "session-command",
            `Could not type ${line} into the session: ${delivery.reason}`,
            event.sessionId,
            { line },
          );
        }
        return;
      }

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
      });
      log(`phone inject into "${event.label}" ${delivered ? "delivered" : "failed"}`);
      return;
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
    // B5: a permission dialog is the one needs-you that gets a voice — unless
    // the setting already skips every prompt, and only when the transcript
    // names a tool still waiting on its result (an AskUserQuestion fires the
    // same notification and is not a permission).
    const approval = event.type === "needs-you"
      && event.ntype === "permission_prompt"
      && !cfg.bypassPermissions
      && event.transcriptPath
      ? pendingApproval(event.transcriptPath)
      : null;
    // On the event, so the audibility predicate and every gate below see it;
    // cleared on a replay whose dialog was answered meanwhile.
    if (approval) event.approval = approval;
    else delete event.approval;
    const controlledTurn = shouldHandleTurnAudibly(event, cfg.workingMic);
    const audibleTurn = controlledTurn && audioLease.sink === "mac";
    // C9b Cut B (F1): a yielded turn is audible SOMEWHERE, so the checks
    // below keep running on `audibleTurn`. Only the sound is gated on HERE.
    const voicedHere = audibleTurn && audioHolder.isLocal();
    if (
      audibleTurn
      && await sessionGone(event.sessionId)
    ) {
      log(`skipping "${event.label}" — session closed`);
      ledger.forget(event.sessionId);
      if (ledger.lastTurn?.sessionId === event.sessionId) ledger.lastTurn = null;
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
      const kind = approval ? approvalDetail(approval) : describeNeed(event.ntype);
      setSessionState(event.sessionId, event.label, "needs", kind, event.eventAt);
      if (!approval) return; // stripped: no bell, no announcement, no permission mic
    }
    if (event.type === "turn-end" && !setSessionState(
      event.sessionId,
      event.label,
      "waiting",
      event.review?.summary,
      event.eventAt,
      event.review,
    )) return;

    if (eventQueue.consumeCancellation(event)) {
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
      if (controlledTurn || event.ntype === "idle_prompt") ledger.lastTurn = event;
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
    // and never while another Mac holds the audio: HID idle is THIS Mac's
    // physical presence, not the session's (C9b Cut B, F7).
    if (event.type !== "wake" && event.type !== "recite" && cfg.awayAfterSecs && audioHolder.isLocal()) {
      const idle = await idleSeconds() ?? 0; // null probe → 0 → not away (fail safe)
      if (idle >= cfg.awayAfterSecs) {
        log(`away (idle ${Math.round(idle / 60)}m) — staying quiet for "${event.label}"`);
        if (audibleTurn || event.ntype === "idle_prompt") ledger.lastTurn = event; // wake still finds it
        return;
      }
    }

    if (approval) {
      await permissionLoop(event, approval, pauseGeneration);
      return;
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
        const targetGone = await sessionGone(target.sessionId);
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
          lastReplyFor(target.transcriptPath, target.sessionId, deps.window(target.sessionId)),
          transcriptMark(target.transcriptPath),
        ]);
        const latest = stripMarkdown(latestReply.text);
        target.mark = currentMark;
        if (shuttingDown || interruptedByPause() || consumeStopKey()) return;
        if (!latest.trim()) {
          log(`nothing to recite for "${target.label}" — no assistant output`);
          return;
        }

        log(`recite -> "${target.label}"`);
        if (cfg.revealOnTurn && target.pid) void raiseWindow(target.pid, "recite");
        resetReadingProgress();
        await speak(cfg, `${target.label}:`, target.label, true, target.sessionId);
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
      // C9b Cut B: the ear is on the other Mac. Refused before the courtesy
      // line, so nothing below can speak or open a mic here (F6).
      const heldBy = presentedTo(audioHolder.holder, audioLease.sink);
      if (heldBy) return log(`wake refused — ${heldBy.slice(0, 8)} has the audio`);
      const target = resolveWakeTarget(event, latestVisibleTurn()); // named wake carries its own session
      if (!target) {
        log("wake with nothing to wake — no session has announced yet");
        return void (await speak(cfg, "Nothing to wake. No session has spoken yet.", "", true));
      }
      recitingEvent = target;
      try {
        const targetGone = await sessionGone(target.sessionId);
        if (shuttingDown || interruptedByPause()) return;
        if (consumeStopKey()) return;
        if (targetGone) {
          if (ledger.lastTurn?.sessionId === target.sessionId) ledger.lastTurn = null;
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
        // Stamped so the mic can report how long it took to open. A person
        // pressing a button experiences ONE number — click to "listening" —
        // and every time that number grew, the cause was somewhere nobody was
        // measuring: a TTS announcement, then a cold transcript scan. It is
        // cheap to make the path say so itself rather than reconstruct it from
        // two log timestamps after the fact.
        micRequestedAt = Date.now();
        // D2: the mic WILL open. Reload an idle-unloaded whisper-server under
        // the courtesy line below rather than under the first utterance.
        prewarmEar();
        if (cfg.revealOnTurn && target.pid) void raiseWindow(target.pid, "wake"); // surface it, no focus steal
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
        // Not for a dictation into the composer. That exchange is VISUAL —
        // you clicked a mic beside a text field and you are watching it — so
        // the spoken line buys nothing and costs the two things that make a
        // button feel broken. It delays the mic (this wake announced for three
        // seconds and the mic opened five seconds after the click, because TTS
        // had fallen back to `say` again), and while it plays the live state is
        // `speaking`, which the composer renders as "reading" — so the control
        // you pressed to talk reports that conch is reading TO you. Tyler:
        // "clicking it turns it on (but it says reading first for some reason)".
        // A voice wake still announces: there, the speech IS the interface.
        if (!target.compose) {
          await Promise.race([
            speak(cfg, `Mic open for ${target.label}.`, target.label, true),
            Bun.sleep(3_000),
          ]);
        }
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
      // D2: every gate has passed, so the mic will open once the reply is read.
      // Reload an idle-unloaded whisper-server now, under the bell and the
      // announcement, so the first utterance after a long quiet is warm.
      if (audibleTurn) prewarmEar();
      // The hook hands the bell to the daemon so it cannot ring over a live mic.
      // Track the exact turn before this first cancellable audio boundary.
      if (voicedHere) await ringBell();
      if (interruptedByPause()) return;

      // C9b Cut B, outbox site 1 of 2 (F6): audible somewhere, but not here.
      // The announcement goes to the holder's Mac; no reading, no mic, and
      // the turn stays latched so a later wake or recite still finds it.
      if (audibleTurn && !voicedHere) {
        presentElsewhere(audioHolder.holder, event.announce, voiceFor(cfg, event.label), event.label, event.sessionId);
        ledger.lastTurn = event;
        return;
      }

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
      ledger.lastTurn = event;
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
        ledger.lastTurn = event;
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
    // Mac's recorder, so it must return before either. So does another Mac
    // holding this daemon's audio (C9b Cut B) — the announcement itself was
    // handed over at the turn site; the remaining chunks stay silent here.
    if (audioLease.isPhone() || !audioHolder.isLocal()) return { heard: "", cut: false };
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
    if (audioLease.isPhone() || !audioHolder.isLocal()) return { heard: "", cut: false };
    if (stopKey || interrupted()) return { heard: "", cut: true };
    assertNormalMicClosed("barge-in TTS");
    const result = await speech.runInterruptible(cfg, text, event.label, async (startSpeech) => {
      if (audioLease.isPhone() || !audioHolder.isLocal()) return { heard: "", cut: false };
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
    } = {},
  ): Promise<boolean> {
    if (event.transcriptPath) {
      try {
        const conversation = await readConversationTail(
          event.transcriptPath,
          event.sessionId,
          transcriptFormatFor(event.transcriptPath),
          { window: deps.window(event.sessionId) },
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
    const injectStartedAt = Date.now();
    const { via, interrupted, reason } = await injectText(
      cfg,
      event.pid,
      text,
      beforeInject ? commit : undefined,
    );
    // Undelivered words go back to the composer (A8). The app clears its
    // draft the moment the daemon ACCEPTS a send, which is before anything is
    // typed anywhere — so an inject that then stops (interrupted) or lands
    // on the clipboard had already erased the only copy on screen. The
    // dictation channel exists to hand text to a composer once, by id, for
    // exactly one session; a failed delivery is the same shape.
    if (interrupted) {
      publishDictation(text, event.sessionId);
      return false;
    }

    if (via === "clipboard") {
      publishDictation(text, event.sessionId);
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
    if (keysLanded && deps.window(event.sessionId)?.status === "busy") {
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
        // A composer dictation goes BACK to the app, not into the session.
        // Same capture, same transcription, different destination — which is
        // the whole feature: it lets spoken and typed text be one message
        // instead of two, and lets you edit what you said before sending it.
        if (event.compose) {
          publishDictation(text, event.sessionId);
          log(`dictated → composer ${JSON.stringify(text)}`);
          return "handled";
        }
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
        const reply = await lastReplyFor(event.transcriptPath!, event.sessionId, deps.window(event.sessionId));
        sentences = splitSentences(stripMarkdown(reply.text));
        cursor = autoTurn
          ? event.review ? sentences.length : countCoveredSentences(event.announce, sentences)
          : countCoveredSentences(event.announce, sentences);
        // Said once, before what is left, when the branch was not told apart (A8).
        if (reply.shared) sentences = withSharedNote(sentences, cursor);
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
    const reportArmed = (): void => {
      if (!micRequestedAt) return;
      const took = Date.now() - micRequestedAt;
      micRequestedAt = null;
      log(`mic armed ${(took / 1000).toFixed(1)}s after the press`);
    };
    const session = createDictationSession(cfg, listenHooks(
      event.label,
      () => reducer.snapshot.buffer.map((segment) => segment.text).join(" "),
      undefined,
      reportArmed,
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
    // Started here, awaited where it is USED — never before the mic opens.
    //
    // The baseline calls countUserPrompts, which on a cold cache reads the
    // whole transcript: measured at 3.8s on Tyler's 189MB conch session. The
    // daemon log shows what that costs from the outside — a wake at 23:18:44
    // and `listening` at 23:18:56, TWELVE seconds after the click, then three
    // on the next wake once the cache was warm. The reader is incremental for
    // appends, so only the first scan is expensive; the bug is that the first
    // scan sat between arming the recorder and telling anyone it was listening.
    //
    // Nothing needs it to OPEN a microphone. It is needed when the manual-reply
    // guard is built, which is after listening has begun, so it is awaited
    // there. It cannot reject into an unhandled rejection while it waits: a
    // failure degrades to the event's own values, the same shape the paused
    // branch already uses.
    const manualReplyBaseline: Promise<Pick<TurnEvent, "transcriptPath" | "mark">> =
      interruptedByPause()
        ? Promise.resolve({ transcriptPath: event.transcriptPath, mark: event.mark })
        : manualReplyListenBaseline(event).catch((error) => {
          log(`transcript baseline failed, replies may not interrupt: ${error}`);
          return { transcriptPath: event.transcriptPath, mark: event.mark };
        });
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
      const gone = await sessionGone(event.sessionId);
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
    // Another Mac holding this daemon's audio holds the ear too (C9b Cut B).
    if (audioLease.isPhone() || !audioHolder.isLocal()) {
      log(`mic held — ${audioLease.isPhone() ? "the phone" : "the other Mac"} has the ear ("${event.label}")`);
      emitRecorderTraces(
        seededSegments.flatMap((segment) => segment.diagnosticIds),
        { intent: "text-handled", bufferCountAfterReduction: null },
      );
      return;
    }
    if (!initialDictationCapture && !deferredInitialExternal) {
      // Fired, not awaited. This was the whole delay: the daemon's own timing
      // print says `mic cue took 3.9s` on a 3.9s open, so the courtesy sound
      // WAS the wait. A 0.56s tink costs ~0.8s of fixed afplay overhead in a
      // shell and considerably more here, where it contends with the warm TTS
      // worker for the audio device.
      //
      // It also read as dishonest: the cue's job is to tell you the mic is
      // open, and it was playing to completion BEFORE that was true. Firing it
      // means it now sounds at roughly the moment it describes.
      //
      // The trade, stated plainly: sox may arm while the tink is still audible
      // and capture a little of it, which the awaited 350ms decay used to
      // prevent. That is a short system sound, not speech, and VAD is there to
      // find speech — against a guaranteed multi-second delay on every single
      // press, which is what made the button feel broken. If a stray leading
      // token ever shows up in a transcript, this is the line that did it.
      // ...and not at all for a composer dictation, which is why the mic still
      // waited 1.4s after the await was removed. Firing the cue does not
      // decouple it: the very next thing on this path is reserveNormalMic,
      // which awaits `quiescent()` — the audio gate that keeps the mic shut
      // while conch is making any sound, and the reason the loop cannot hear
      // itself. The cue is a sound, so the gate correctly waits for it. The
      // measurements agreed exactly: `mic cue took 1.4s`, `mic armed 1.4s
      // after the press`.
      //
      // So the gate stays and the sound goes. Pressing a mic beside a text
      // field and watching it is already the feedback; a tink that costs a
      // second and a half of latency to say what the button just said is a bad
      // trade. A voice wake still cues, because there nothing is being watched.
      if (!event.compose) void micCue(cfg, "open");
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
    // Deliberately carries no timing. This line prints when conch DECIDES to
    // listen, and the recorder has not been armed yet — so the "0.0s after the
    // press" it used to claim was true and useless: it measured the daemon
    // agreeing with itself. The number a person feels is press to armed, and
    // that is reported from the arm itself, below.
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
      manualReplyEvent = await manualReplyBaseline;
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

  /**
   * The four-way decision, by voice (B5).
   *
   * Announce the tool and what it wants, listen, and press what a person
   * would press: "yes" is Enter on the highlighted row, "no" is Escape, "no,
   * use main instead" is Escape and then the alternative typed as the next
   * prompt, and "always" walks Down to the don't-ask-again row — after a
   * second spoken yes, because that one outlives the prompt and is the only
   * blind two-key walk through a menu conch cannot see. Unclear is re-asked
   * once, then left for the keyboard with the row still saying what it needs.
   */
  async function permissionLoop(event: TurnEvent, ask: PendingApproval, pauseGeneration: number): Promise<void> {
    const interruptedByPause = (): boolean => pause.interrupted(pauseGeneration);
    const say = (text: string): Promise<void> => speak(cfg, text, event.label, false, event.sessionId);
    log(`permission from "${event.label}": ${ask.name} — ${ask.summary}`);
    if (cfg.revealOnTurn && event.pid) void raiseWindow(event.pid, "permission");
    await ringBell();
    await say(approvalAnnounce(event.label, ask));
    if (shuttingDown || interruptedByPause() || consumeStopKey()) return;
    // The same holds as an announced turn: the ear is elsewhere, or you are typing.
    if (audioLease.isPhone() || !audioHolder.isLocal()) {
      return log(`mic held — ${audioLease.isPhone() ? "the phone" : "the other Mac"} has the ear ("${event.label}")`);
    }
    const idle = cfg.typingGraceSecs > 0 ? await idleSeconds() : null;
    if (idle !== null && idle < cfg.typingGraceSecs) {
      return log(`mic held — you're typing (answer "${event.label}" by keyboard)`);
    }
    let heard = await listenForApproval(event);
    if (!heard) return;
    let answer = classifyApprovalAnswer(heard);
    if (!answer) {
      log(`heard: "${heard.join(" ")}" -> unclear, asking once more`);
      await say(APPROVAL_REASK);
      if (shuttingDown || interruptedByPause()) return;
      heard = await listenForApproval(event);
      if (!heard) return;
      answer = classifyApprovalAnswer(heard);
    }
    if (!answer) {
      log(`heard: "${heard.join(" ")}" -> unclear, leaving "${event.label}" for the keyboard`);
      return void (await say(APPROVAL_KEYBOARD));
    }
    log(`heard: "${heard.join(" ")}" -> ${answer.kind}`);
    if (answer.kind === "always") {
      await say(confirmAlwaysPrompt(ask));
      if (shuttingDown || interruptedByPause()) return;
      const confirmation = await listenForApproval(event);
      if (!confirmation) return;
      if (!confirmsAlways(confirmation)) {
        log(`heard: "${confirmation.join(" ")}" -> not confirmed`);
        return void (await say(`Not confirmed. ${APPROVAL_KEYBOARD}`));
      }
    }
    if (interruptedByPause()) return;
    for (const key of APPROVAL_KEYS[answer.kind]) {
      const { via, interrupted } = await injectKey(cfg, event.pid, key, () => !interruptedByPause());
      if (interrupted || interruptedByPause()) return;
      if (via === "none") return void (await say("Could not reach the session's window to answer — do it by hand."));
      log(`sent ${key} via ${via}`);
      await Bun.sleep(150); // let the dialog move before the next key
    }
    if (answer.kind === "instead") {
      // Escape left the cursor in the prompt; the alternative is the next message.
      await Bun.sleep(400);
      const { via } = await injectText(cfg, event.pid, answer.text, () => !interruptedByPause());
      if (via === "none") return void (await say("Could not type the alternative — do it by hand."));
      if (via === "clipboard") return void (await say("The alternative is on the clipboard — paste it into the session."));
      markInjected(event.sessionId);
      log(`told "${event.label}" instead: "${answer.text}" via ${via}`);
    }
  }

  /** One mic window for a permission answer: what was heard, or null when the window closed with nothing to decide (interrupted, spacebar, error, silence). */
  async function listenForApproval(event: TurnEvent): Promise<string[] | null> {
    const pauseGeneration = pause.capture();
    const interruptedByPause = (): boolean => pause.interrupted(pauseGeneration);
    if (shuttingDown) return null;
    await micCue(cfg, "open");
    if (shuttingDown || interruptedByPause()) return null;
    log("listening for yes, always, or no...");
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

    if (shuttingDown) return null;
    if (!(await reserveNormalMic())) return null;
    if (interruptedByPause()) {
      normalMicReserved = false;
      return null;
    }
    if (stopKey) {
      normalMicReserved = false;
      consumeStopKey();
      await micCue(cfg, "close");
      log("⏹ spacebar — closed the permission mic");
      return null;
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
      return null;
    }
    if (externalReason) {
      emitRecorderTraces(diagnosticIds, { intent: `permission-${externalReason}`, bufferCountAfterReduction: 0 });
      if (externalReason === "spacebar") consumeStopKey();
      if (shuttingDown) return null;
      await micCue(cfg, "close");
      log("⏹ closed the permission mic");
      return null;
    }
    if (listenError) {
      emitRecorderTraces(diagnosticIds, { intent: "permission-error", bufferCountAfterReduction: 0 });
      log(`listen error: ${listenError}`);
      return null;
    }
    if (!texts.length) {
      emitRecorderTraces(diagnosticIds, { intent: "permission-timeout", bufferCountAfterReduction: 0 });
      await micCue(cfg, "close");
      log("no speech — back to idle");
      return null;
    }
    emitRecorderTraces(diagnosticIds, { intent: "permission-answer", bufferCountAfterReduction: 0 });
    return texts;
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
    const known = deps.window(event.sessionId);
    const label = known?.name || event.label || event.sessionId.slice(0, 8);
    const { via } = await injectKey(cfg, known?.pid, "Escape");
    if (via === "none") {
      log(`⚠ could not reach "${label}" to stop it`);
      await speak(cfg, `Couldn't reach ${label} to stop it.`, label);
      return;
    }
    log(`⏹ stopped "${label}" via ${via}`);
  }

  // Space remains the guaranteed stop while reciting or mid-exchange. Unlike
  // mode controls, it intentionally drains/submits every already-captured tail.
  function stop(src: string): void {
    stopKey = true;
    speech.cancelCurrent();
    speech.cancelPendingAudio();
    activeDictation?.requestExternal("spacebar");
    log(activeDictation?.session.micOpen || micOpen ? `⏹ ${src} — closing mic` : `⏹ ${src} — stopped`);
  }

  return {
    handle,
    speak,
    speakBlocker,
    capturing: normalMicOpen,
    stop,
    consumeStop: consumeStopKey,
    closeMic: (reason) => activeDictation?.requestExternal("spacebar", reason),
    close() {
      shuttingDown = true;
      // Close the controller's rearm gate synchronously before the daemon takes
      // its recorder snapshot. No await is allowed before this request.
      const dictationAtShutdown = activeDictation;
      dictationAtShutdown?.requestExternal("spacebar", "shutdown");
      return dictationAtShutdown?.done;
    },
    current: () => ({
      reciting: recitingEvent,
      handling: handlingEvent,
      handlingPauseGeneration,
      dictation: activeDictation?.session ?? null,
    }),
  };
}
