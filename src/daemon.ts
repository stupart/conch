import { createServer } from "node:net";
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "./config.ts";
import type { TurnEvent } from "./hook.ts";
import {
  speak as playSpeech,
  speakCancellable as playSpeechCancellable,
  stopSpeaking,
  probeTtsServer,
  voiceFor,
  bell as playBell,
} from "./speak.ts";
import {
  listenGap,
  armBargeRecorder,
  killActiveRecorders,
  createDictationSession,
  type ListenHooks,
  type RuntimeDictationSession,
} from "./listen.ts";
import type { RecorderHandle } from "./dictation-controller.ts";
import { injectText, injectKey } from "./inject.ts";
import { classify, classifyReadingGap, wordOverlapRatio } from "./commands.ts";
import { lastAssistantText, splitSentences, stripMarkdown, countCoveredSentences, userRespondedSince } from "./snippet.ts";
import { probeServer } from "./transcribe.ts";
import { setState, logAbove, type ConchState } from "./status.ts";
import { listSessions, sessionLabel, findTranscript, type SessionInfo } from "./sessions.ts";
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
 * session, newest first. A "wake" event (conch wake, or spacebar when the
 * daemon runs in a terminal) reopens the mic for the last announced session.
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

export async function runDaemon(cfg: Config): Promise<void> {
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
  const injectedAt = new Map<string, number>(); // session -> last time conch drove it
  const pending = new Map<string, TurnEvent>(); // sessions that finished while paused — latest per session

  const normalMicOpen = (): boolean => Boolean(activeDictation?.session.micOpen || micOpen);
  const assertNormalMicClosed = (operation: string): void => assertAudioGate(normalMicOpen, operation);

  const speak = async (speechCfg: Config, text: string, label = ""): Promise<void> => {
    await withNormalMicClosed(normalMicOpen, "TTS", () => playSpeech(speechCfg, text, label));
  };

  const micCue = async (cueCfg: Config, kind: "open" | "close" | "sent"): Promise<void> => {
    await withNormalMicClosed(normalMicOpen, `${kind} mic cue`, () => playMicCue(cueCfg, kind));
  };

  const ringBell = async (): Promise<void> => {
    await withNormalMicClosed(normalMicOpen, "attention bell", () => playBell(cfg));
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
    if ((event.type === "pause" || event.type === "mute") && activeDictation) {
      // Close the producer gate synchronously while this event waits behind
      // the busy conversation. The active loop drains/submits before the mode
      // event is allowed to speak its acknowledgement.
      activeDictation.requestExternal(event.type);
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
      while (queue.length) {
        const event = queue.pop()!; // newest first
        try {
          await handle(event);
        } catch (e) {
          // one bad event (closed pane, missing binary, socket reset, a throw
          // from any spawn) must not take the whole daemon down mid-exchange.
          log(`error handling ${event.type} "${event.label}": ${e}`);
          stopSpeaking();
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

  async function setMuted(next: boolean): Promise<void> {
    muted = next;
    writeState({ muted, paused }); // persist so a restart doesn't un-mute
    log(muted ? "muted — announcements and mic off (m or `conch unmute` to resume)" : "unmuted");
    setState(restState());
    await speak(cfg, muted ? "Muted." : "Back on.");
  }

  // "Away" mode: quiet like mute, but HOLD every session that finishes so they
  // replay on resume instead of being dropped. Persisted across restarts.
  async function setPaused(next: boolean): Promise<void> {
    paused = next;
    writeState({ muted, paused });
    if (paused) {
      log("paused — holding finished sessions until you resume (p or `conch resume`)");
      setState("paused");
      await speak(cfg, "Paused. I'll hold your queue.");
      return;
    }
    const held = [...pending.values()];
    pending.clear();
    log(`resumed — ${held.length} session(s) waited while you were away`);
    setState(restState());
    if (held.length) {
      await speak(cfg, `Back. ${held.length} session${held.length === 1 ? "" : "s"} finished while you were away.`);
      for (const ev of held) enqueue(ev); // replay: each announces in turn (barge/spacebar to skip)
    } else {
      await speak(cfg, "Back on.");
    }
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

    // Paused ("away"): hold whatever finishes so it replays on resume — the key
    // difference from mute, which drops it. `wake` always cuts through.
    if (paused && event.type !== "wake") {
      pending.set(event.sessionId, event); // latest per session
      lastTurn = event; // wake still finds the newest
      return log(`paused — holding "${event.label}" (${pending.size} waiting)`);
    }

    // Nobody's there: don't announce to an empty room, don't open the mic,
    // don't burn battery on sox/whisper. Telegram (the other hook) still
    // pings the phone. `conch wake` always cuts through.
    // Only reach for ioreg when the away-timer is actually armed (default off) —
    // muted short-circuits without spawning anything.
    if (event.type !== "wake" && (muted || cfg.awayAfterSecs)) {
      const idle = muted ? 0 : await idleSeconds();
      if (muted || idle >= cfg.awayAfterSecs) {
        log(`${muted ? "muted" : `away (idle ${Math.round(idle / 60)}m)`} — staying quiet for "${event.label}"`);
        if (event.type === "turn-end" || event.ntype === "idle_prompt") lastTurn = event; // wake still finds it
        return;
      }
    }

    if (event.type === "wake") {
      const target = event.sessionId ? event : lastTurn; // named wake carries its own session
      if (!target) {
        log("wake with nothing to wake — no session has announced yet");
        return void (await speak(cfg, "Nothing to wake. No session has spoken yet."));
      }
      log(`wake -> "${target.label}"`);
      setState("speaking", target.label);
      await speak(cfg, `Mic open for ${target.label}.`, target.label);
      await conversationLoop(target);
      return;
    }

    log(`${event.type}${event.ntype ? `/${event.ntype}` : ""} from "${event.label}" (${event.sessionId.slice(0, 8)})`);

    // Already handled it yourself: if you typed a reply to this session (so the
    // conversation moved on) since this fired, don't read it aloud or nag for
    // input. Covers the live path AND pause-replay (both flow through here).
    if ((event.type === "turn-end" || event.type === "needs-you") && (await userRespondedSince(event.transcriptPath, event.mark))) {
      return log(`skipping "${event.label}" — you already responded, conversation moved on`);
    }

    // Hooks hand the bell to the daemon so it cannot ring over a live normal
    // producer. drain() serializes events, and any external-stop barrier has
    // completed before this event reaches handle().
    if (event.type === "turn-end" || event.type === "needs-you") await ringBell();

    // Suppress a "needs you" for a session conch just drove — Claude Code can
    // fire an idle/needs-you the moment injected input lands, before the turn
    // starts, and nagging you for input you just gave is pure noise.
    if (event.type === "needs-you") {
      const since = Date.now() - (injectedAt.get(event.sessionId) ?? 0);
      if (since < cfg.recentInjectSuppressMs) {
        return log(`suppressed needs-you for "${event.label}" (drove it ${Math.round(since / 1000)}s ago)`);
      }
    }

    if (event.type === "needs-you" && event.ntype !== "idle_prompt") {
      setState("speaking", event.label);
      await speak(cfg, event.announce, event.label);
      await permissionLoop(event); // dialogs take Enter/Escape, not free text
      return;
    }

    // turn-end and idle_prompt are both "the session wants a prompt from
    // you" — and the announcement itself is barge-able: interrupting from
    // the very first sentence must work, not just mid-reading.
    const conversationParent = createRecorderParent("conversation");
    let conversationSequence = 0;
    const nextConversationSequence = () => ++conversationSequence;
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
      await speak(cfg, event.announce, event.label);
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
    );
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
      await speak(cfg, text, event.label);
      return { heard: "", cut: false };
    }
    // The barge recorder is the sole intentional during-TTS mic. The normal
    // producer must already be barrier-closed before this swap.
    assertNormalMicClosed("barge-in TTS");
    const barge = armBargeRecorder(cfg, traceParent, nextTraceSequence?.() ?? 1);
    const speech = playSpeechCancellable(cfg, text, event.label);
    let cut = false;
    const watch = setInterval(() => {
      if (barge.triggered()) {
        cut = true;
        speech.cancel(); // your voice wins mid-sentence
      }
    }, 120);
    try {
      await speech.done;
    } catch (error) {
      clearInterval(watch);
      await barge.abort();
      throw error;
    }
    clearInterval(watch);
    if (!barge.triggered()) {
      await barge.abort();
      return { heard: "", cut: false };
    }
    setState("recording", event.label);
    const initialCapture = barge.adopt();
    return {
      heard: "",
      cut,
      ...(initialCapture ? { initialCapture } : {}),
      captureParent: barge.parent,
    };
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
    const { via } = await injectText(cfg, event.pid, text);
    log(`injected via ${via}`);
    if (via === "clipboard") {
      await speak(cfg, "Couldn't reach the session's window — your words are on the clipboard, just paste.", event.label);
    } else if (via === "none") {
      await speak(cfg, "Heard you, but I could not find the session's pane.", event.label);
    }
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
  ): Promise<void> {
    let lastSpoken = event.announce;
    let sentences: string[] | null = null;
    let cursor = cfg.speakSentences; // the announcement already covered the first sentences
    let bargeOff = false; // set when the echo guard proves the threshold is too low for this room
    let falseTriggers = 0; // noise blips that cancelled speech but transcribed to nothing
    const seededSegments: Array<{
      text: string;
      diagnosticId?: string;
      diagnosticIds: string[];
    }> = [];
    // A wake just reopens the mic (per the README); it must NOT recite the last
    // message from the top — the user says "continue" if they want to hear it.
    let skipReading = event.type === "wake" || Boolean(announcedCapture);
    let initialDictationCapture = announcedCapture;
    let initialCaptureParent = announcedCaptureParent;
    let deferredInitialExternal: ExternalDictationAction | undefined;
    const traceParent = suppliedTraceParent ?? announcedCaptureParent ?? createRecorderParent("conversation");
    let localTraceSequence = 0;
    const nextTraceSequence = suppliedNextTraceSequence ?? (() => ++localTraceSequence);

    // Load + split the full message once, resuming after what the announcement
    // actually covered. Shared by the read-full phase and "continue".
    const ensureSentences = async (): Promise<string[]> => {
      if (!sentences) {
        sentences = splitSentences(stripMarkdown(await lastAssistantText(event.transcriptPath!)));
        cursor = countCoveredSentences(event.announce, sentences, cfg.speakSentences);
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
          return "resume";
        }
      }
    };

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
    const needsCapture = Boolean(initialDictationCapture) || !deferredInitialExternal;
    if (needsCapture) session.start(initialDictationCapture);
    micOpen = needsCapture;
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
            session.resume();
            micOpen = true;
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
        const result = await executeAction(action);
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
          session.resume();
          micOpen = true;
          activeDictation = { session, requestExternal, done: dictationDone };
          setState("listening", event.label);
        }
      }
    } finally {
      activeDictation = null;
      micOpen = false;
      if (session.state === "running" || session.state === "draining") {
        const ticket = session.requestBarrier("conversation-exit");
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
            if (pendingEvent.id === ticket.id) break;
          }
        }
        await ticket.done;
      }
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
    session.start();
    micOpen = true;
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
      activeDictation = null;
      micOpen = false;
      if (session.state === "running" || session.state === "draining") {
        const ticket = session.requestBarrier("permission-exit");
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
            if (pendingEvent.id === ticket.id) break;
          }
        }
        await ticket.done;
      }
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

  // Warm whisper-server: the daemon owns it so transcription (and live
  // partials) skip the seconds-long model reload of the cold cli path.
  let whisperServer: ReturnType<typeof Bun.spawn> | null = null;
  if (cfg.whisperPort && existsSync(cfg.whisperServerBin)) {
    // Adopt an already-running whisper-server (e.g. a prior daemon's, orphaned
    // by a hard restart) instead of spawning a duplicate that can't bind the
    // port and just leaks — same pattern as kokoro below. A 3-day-old orphan
    // holding the port was found in the wild before this.
    if (await probeServer(cfg, 1500)) {
      log(`whisper-server adopted on :${cfg.whisperPort} — fast transcription + live partials`);
    } else {
      whisperServer = Bun.spawn(
        [
          cfg.whisperServerBin,
          "-m", cfg.whisperModel,
          "-vm", cfg.vadModel,
          "--vad",
          "--vad-speech-pad-ms", "300", // default 30ms amputates quiet word tails
          "--host", "127.0.0.1",
          "--port", String(cfg.whisperPort),
          "-l", "en",
          "-t", "6",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      // 60s patience: whisper and kokoro load models simultaneously at startup
      // and contend for GPU/disk — observed pushing whisper past a 20s probe
      void probeServer(cfg, 60_000).then((up) => {
        log(up ? `whisper-server warm on :${cfg.whisperPort} — fast transcription + live partials` : "whisper-server failed to come up — using the cold cli path");
      });
    }
  } else if (cfg.whisperPort) {
    log(`whisper-server binary not found at ${cfg.whisperServerBin} — using the cold cli path`);
  }

  // Warm Kokoro TTS server (mlx-audio) — natural per-session voices.
  // Same ownership pattern as whisper-server; `say` remains the fallback.
  let ttsServer: ReturnType<typeof Bun.spawn> | null = null;
  if (cfg.ttsEngine !== "say" && cfg.ttsPort && Bun.which(cfg.ttsServerBin)) {
    // Adopt an already-running server (e.g. a prior daemon's, after a
    // launchd restart) instead of spawning a duplicate that can't bind the
    // port, dies silently, and leaves us talking to a stale instance.
    const already = await probeTtsServer(cfg, 1500);
    if (!already) {
      // logged (not discarded) so synthesis failures are diagnosable
      // stdout and stderr need SEPARATE files — the same Bun.file opened twice
      // has independent write offsets and the streams clobber each other.
      ttsServer = Bun.spawn([cfg.ttsServerBin, "--port", String(cfg.ttsPort)], {
        stdout: Bun.file("/tmp/conch-kokoro.log"),
        stderr: Bun.file("/tmp/conch-kokoro.err.log"),
      });
    }
    void probeTtsServer(cfg, 30_000).then(async (up) => {
      if (!up) return log("tts server didn't come up — voices via say");
      log(`kokoro ${already ? "adopted" : "warm"} on :${cfg.ttsPort} — per-session voices on`);
      // Preload EVERY ring voice off the hot path — a cold first-use of a
      // voice was a candidate for "first sentence in system voice". Sequential
      // (single-threaded server); each warms that voice's embedding.
      for (const v of cfg.ttsVoices) {
        await fetch(`http://127.0.0.1:${cfg.ttsPort}/v1/audio/speech`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: cfg.ttsModel, input: "ready", voice: v }),
          signal: AbortSignal.timeout(60_000),
        }).catch(() => {});
      }
      log(`kokoro warmed ${cfg.ttsVoices.length} voices`);
    });
  } else if (cfg.ttsEngine === "server") {
    log(`CONCH_TTS=server but ${cfg.ttsServerBin} not found (uv tool install "mlx-audio[server]") — voices via say`);
  }

  if (existsSync(cfg.socketPath)) unlinkSync(cfg.socketPath); // stale socket from a previous run

  const server = createServer((sock) => {
    let buf = "";
    sock.on("error", () => {}); // a hook killed mid-write (ECONNRESET) must not throw
    sock.on("data", (d) => (buf += d.toString()));
    sock.on("end", () => {
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          enqueue(JSON.parse(line) as TurnEvent);
        } catch {
          log("ignoring malformed event");
        }
      }
    });
  });

  server.on("error", (e) => log(`socket server error: ${e}`));
  server.listen(cfg.socketPath);
  log(`listening on ${cfg.socketPath} — wire hooks with \`conch install\``);
  if (muted) log("resuming muted (persisted) — m or `conch unmute` to turn on");
  if (paused) log("resuming paused (persisted) — p or `conch resume` to turn on");
  setState(restState());

  let diagnosticShutdownStarted = false;
  const shutdown = () => {
    if (diagnosticsEnabled && diagnosticShutdownStarted) return;
    diagnosticShutdownStarted = true;
    shuttingDown = true;
    stopSpeaking(); // never orphan a talking `say` — voices overlapped live
    // Close the controller's rearm gate synchronously before taking the
    // activeRecorders snapshot. Default-off still exits immediately below.
    const dictationAtShutdown = activeDictation;
    dictationAtShutdown?.requestExternal("spacebar", "shutdown");
    const recorderDrain = killActiveRecorders(); // a live sox capture would keep the mic hot after we die
    server.close();
    whisperServer?.kill();
    ttsServer?.kill();
    try {
      unlinkSync(cfg.socketPath);
    } catch {}
    if (!diagnosticsEnabled) process.exit(0);
    void Promise.all([
      Promise.resolve(recorderDrain),
      dictationAtShutdown?.done ?? Promise.resolve(),
    ]).finally(() => {
      flushPendingRecorderTraces();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

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

  // Interactive keys when running in a terminal.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (d) => {
      const c = d.toString();
      if (c === " ") {
        if (busy) {
          // reciting (or mid-exchange): space is the guaranteed stop
          stopKey = true;
          stopSpeaking();
          activeDictation?.requestExternal("spacebar");
          log(activeDictation?.session.micOpen || micOpen ? "⏹ spacebar — closing mic" : "⏹ spacebar — stopped");
        } else {
          enqueue({ type: "wake", sessionId: "", label: "", announce: "" });
        }
      }
      else if (c >= "1" && c <= "9") void wakeByNumber(Number(c));
      else if (c === "s" || c === "l") void printSessions();
      else if (c === "v") void auditionVoices();
      else if (c === "m") enqueue({ type: muted ? "unmute" : "mute", sessionId: "", label: "", announce: "" });
      else if (c === "p") enqueue({ type: paused ? "resume" : "pause", sessionId: "", label: "", announce: "" });
      else if (c === "?" || c === "h") printHelp();
      else if (c === "q" || c === "\u0003") shutdown();
    });
    printHelp();
  }
}

function printHelp(): void {
  logAbove(
    [
      "",
      "  \x1b[1mkeys\x1b[0m   \x1b[36mspace\x1b[0m stop reciting / open mic   \x1b[36ms\x1b[0m sessions   \x1b[36m1-9\x1b[0m mic to #   \x1b[36mv\x1b[0m voices   \x1b[36mm\x1b[0m mute   \x1b[36mp\x1b[0m pause (away)   \x1b[36m?\x1b[0m help   \x1b[36mq\x1b[0m quit",
      '  \x1b[1mvoice\x1b[0m  \x1b[36m"continue"\x1b[0m read more   \x1b[36m"repeat"\x1b[0m again   \x1b[36m"stop"\x1b[0m end reading   \x1b[36m"no response needed"\x1b[0m close mic',
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
async function idleSeconds(): Promise<number> {
  try {
    const proc = Bun.spawn(["ioreg", "-c", "IOHIDSystem"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const m = out.match(/HIDIdleTime"?\s*=\s*(\d+)/);
    return m ? Number(m[1]) / 1e9 : 0;
  } catch {
    return 0;
  }
}

const CUE_SOUND = {
  open: "/System/Library/Sounds/Tink.aiff", // mic opened, start talking
  close: "/System/Library/Sounds/Bottle.aiff", // window closed on silence
  sent: "/System/Library/Sounds/Pop.aiff", // dictation submitted
};

async function playMicCue(cfg: Config, kind: keyof typeof CUE_SOUND): Promise<void> {
  if (!cfg.micCues) return;
  await Bun.spawn(["afplay", CUE_SOUND[kind]], { stdout: "ignore", stderr: "ignore" }).exited;
  if (kind === "open") await Bun.sleep(350); // let the cue's tail decay before sox arms
}
