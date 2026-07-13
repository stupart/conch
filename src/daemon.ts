import { createServer } from "node:net";
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "./config.ts";
import type { TurnEvent } from "./hook.ts";
import { speak, speakCancellable, stopSpeaking, probeTtsServer, voiceFor } from "./speak.ts";
import { listenOnce, listenGap, armBargeRecorder, killActiveRecorders, abortListening, type ListenHooks } from "./listen.ts";
import { injectText, injectKey } from "./inject.ts";
import { classify, classifyApproval, classifyReadingGap, wordOverlapRatio, isSendCommand } from "./commands.ts";
import { lastAssistantText, splitSentences, stripMarkdown, countCoveredSentences } from "./snippet.ts";
import { probeServer } from "./transcribe.ts";
import { setState, logAbove, type ConchState } from "./status.ts";
import { listSessions, sessionLabel, findTranscript, type SessionInfo } from "./sessions.ts";
import {
  emitRecorderTrace,
  emitRecorderTraces,
  flushPendingRecorderTraces,
  recorderDiagnosticsEnabled,
  updateRecorderTrace,
} from "./diagnostics.ts";

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
  const injectedAt = new Map<string, number>(); // session -> last time conch drove it
  const pending = new Map<string, TurnEvent>(); // sessions that finished while paused — latest per session

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
    const i = queue.findIndex((e) => e.sessionId === event.sessionId && e.type === event.type);
    if (i !== -1) queue.splice(i, 1); // newer event for the same session supersedes
    queue.push(event);
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
    const announce = await speakInterruptible(event, event.announce, false);
    if (announce.cut && !announce.heard && !stopKey) {
      log("announce cut by a noise blip — re-speaking");
      await speak(cfg, event.announce, event.label);
    }
    lastTurn = event;
    await conversationLoop(event, announce.heard, announce.diagnosticId);
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
  ): Promise<{ heard: string; cut: boolean; diagnosticId?: string }> {
    setState("speaking", event.label);
    if (!cfg.bargeThresholdPct || disabled) {
      await speak(cfg, text, event.label);
      return { heard: "", cut: false };
    }
    const barge = armBargeRecorder(cfg);
    const speech = speakCancellable(cfg, text, event.label);
    let cut = false;
    const watch = setInterval(() => {
      if (barge.triggered()) {
        cut = true;
        speech.cancel(); // your voice wins mid-sentence
      }
    }, 120);
    if (diagnosticsEnabled) {
      try {
        await speech.done;
      } catch (e) {
        clearInterval(watch);
        await barge.abort();
        throw e;
      }
    } else {
      await speech.done;
    }
    clearInterval(watch);
    if (!barge.triggered()) {
      await barge.abort();
      return { heard: "", cut: false };
    }
    setState("recording", event.label);
    const { text: heard, error, diagnosticId } = await barge.finish();
    if (error) {
      emitRecorderTrace(diagnosticId, { intent: "transcription-error", bufferCountAfterReduction: 0 });
    } else if (!heard) {
      emitRecorderTrace(diagnosticId, { intent: "barge-empty", bufferCountAfterReduction: 0 });
    }
    return diagnosticId ? { heard, cut, diagnosticId } : { heard, cut };
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
      speak(cfg, "Couldn't reach the session's window — your words are on the clipboard, just paste.", event.label);
    } else if (via === "none") {
      speak(cfg, "Heard you, but I could not find the session's pane.", event.label);
    }
  }

  /** Shared handling for anything heard while reading aloud (gap or barge-in). */
  async function onReadingUtterance(
    event: TurnEvent,
    text: string,
    spokenChunk: string,
    diagnosticId?: string,
  ): Promise<"stop" | "handled" | "keep-reading" | "echo"> {
    const intent = classifyReadingGap(text);
    log(`heard mid-read: "${text}" -> ${intent}`);
    // Echo guard runs AFTER classification and ONLY for would-be prompts: a
    // command like "stop reading" naturally overlaps a message about reading,
    // and dismissing it as echo was exactly what broke stop (live). Commands
    // are always honored; only long injectable prose can be a real echo.
    if (intent === "prompt" && spokenChunk && wordOverlapRatio(text, spokenChunk) > 0.6) {
      log(`barge echo guard: mic heard the reading itself ("${text.slice(0, 60)}")`);
      emitRecorderTrace(diagnosticId, { intent: "echo", bufferCountAfterReduction: 0 });
      return "echo";
    }
    if (intent === "prompt" && text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length <= 3) {
      // a 1-3 word fragment mid-read ("I thought...") is someone starting
      // to talk, not a prompt — stop reading and hand them the mic instead
      // of injecting the fragment (observed live: killed the read AND sent junk)
      log("short mid-read fragment — pausing the reading to listen properly");
      emitRecorderTrace(diagnosticId, { intent: "short-fragment-stop", bufferCountAfterReduction: 0 });
      return "stop";
    }
    switch (intent) {
      case "stop":
        emitRecorderTrace(diagnosticId, { intent: "stop", bufferCountAfterReduction: 0 });
        return "stop";
      case "discard":
        emitRecorderTrace(diagnosticId, { intent: "discard", bufferCountAfterReduction: 0 });
        markInjected(event.sessionId); // "no response" also suppresses the follow-up needs-you nag
        await speak(cfg, "Okay.", event.label);
        return "handled";
      case "prompt":
        updateRecorderTrace(diagnosticId, { intent: "prompt", bufferCountAfterReduction: 0 });
        await deliver(event, text, diagnosticId);
        return "handled";
      default:
        emitRecorderTrace(diagnosticId, { intent, bufferCountAfterReduction: 0 });
        return "keep-reading"; // repeat/continue: just keep going
    }
  }

  /** Commands (continue/repeat/cancel) keep the mic cycling; a real prompt injects; silence idles. */
  async function conversationLoop(event: TurnEvent, pendingHeard = "", pendingDiagnosticId?: string): Promise<void> {
    let lastSpoken = event.announce;
    let sentences: string[] | null = null;
    let cursor = cfg.speakSentences; // the announcement already covered the first sentences
    let bargeOff = false; // set when the echo guard proves the threshold is too low for this room
    let falseTriggers = 0; // noise blips that cancelled speech but transcribed to nothing
    // A wake just reopens the mic (per the README); it must NOT recite the last
    // message from the top — the user says "continue" if they want to hear it.
    let skipReading = event.type === "wake";

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
      const action = await onReadingUtterance(event, pendingHeard, event.announce, pendingDiagnosticId);
      if (action === "handled") return;
      if (action === "stop") skipReading = true;
      if (action === "echo") bargeOff = true;
    }

    // Read-full phase: keep speaking chunks. You can interject two ways:
    // in the short gap between chunks, or by BARGING IN while it speaks —
    // a high-threshold recorder runs during playback and kills the speech
    // the moment your voice (louder than speaker bleed) starts.
    if (consumeStopKey()) skipReading = true; // spacebar during the announcement

    if (!skipReading && cfg.readFull && event.type !== "needs-you" && event.transcriptPath) {
      sentences = await ensureSentences();
      reading: while (cursor < sentences.length) {
        // gap between chunks: with barging available it's just a beat; with
        // barging off (echo/noise) it's the only voice interrupt, so keep it real
        const gapSecs = bargeOff ? Math.max(cfg.gapSecs, 0.6) : cfg.gapSecs;
        if (gapSecs > 0) {
          setState("listening", event.label);
          const { text: gapText, error: gapError, diagnosticId: gapDiagnosticId } = await listenGap(cfg, gapSecs);
          if (consumeStopKey()) {
            emitRecorderTrace(gapDiagnosticId, { intent: "gap-spacebar", bufferCountAfterReduction: 0 });
            break reading; // spacebar during the gap
          }
          if (gapError) {
            emitRecorderTrace(gapDiagnosticId, { intent: "transcription-error", bufferCountAfterReduction: 0 });
          } else if (gapText) {
            const action = await onReadingUtterance(event, gapText, "", gapDiagnosticId);
            if (action === "stop") break reading;
            if (action === "handled") return;
          } else {
            emitRecorderTrace(gapDiagnosticId, { intent: "gap-empty", bufferCountAfterReduction: 0 });
          }
        }
        const chunk = sentences.slice(cursor, cursor + cfg.continueSentences).join(" ");
        lastSpoken = chunk;
        const result = await speakInterruptible(event, chunk, bargeOff);
        // The cursor advances ONLY when a chunk is spoken in full (below). Every
        // early exit here leaves it at this chunk's start, so a "stop" followed
        // by "continue" re-reads this chunk rather than skipping ahead.
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
        const action = await onReadingUtterance(event, result.heard, chunk, result.diagnosticId);
        if (action === "stop") break reading;
        if (action === "handled") return;
        // interrupted for nothing (echo / keep-reading): re-speak the chunk,
        // with barging off for the rest of this read if it was echo
        if (action === "echo") bargeOff = true;
      }
    }

    // Hold-submit: accumulate dictated segments IN MEMORY (not typed into the
    // box one-by-one). A natural pause just ends a segment; nothing is
    // injected until you submit, so segments join cleanly with no per-segment
    // osascript delay (that delay was a mic-dead gap where words vanished).
    const buffer: string[] = [];
    const bufferDiagnosticIds: string[] | undefined = diagnosticsEnabled ? [] : undefined;
    let activeDiagnosticId: string | undefined;

    // Spacebar closed the mic: submit whatever's already held (don't lose
    // dictation) or just close if nothing's buffered. Carries the held ids.
    const closeMic = async (): Promise<void> => {
      if (buffer.length) {
        await micCue(cfg, "sent");
        await deliver(event, buffer.join(" "), bufferDiagnosticIds);
      } else {
        await micCue(cfg, "close");
      }
    };

    try {
      while (true) {
        // Spacebar between segments closes the mic (mid-listen is handled by the
        // `aborted` return below). Consuming the press also stops a stale stopKey
        // from being silently wiped by the next event's handle().
        if (consumeStopKey()) {
          await closeMic();
          return log("⏹ spacebar — closed the mic");
        }
        // Cue "open" only when the mic FIRST opens — not before every held
        // segment (tink-per-segment was disconcerting). Holding segments re-arm
        // silently; a "sent"/"close" cue marks the end.
        if (!buffer.length) await micCue(cfg, "open");
        const window = buffer.length ? cfg.holdSubmitSecs : cfg.listenWindowSecs;
        log(`listening (start within ${window}s)${buffer.length ? " · holding, say 'send' or pause to submit" : ""}...`);
        micOpen = true;
        const { text, error, aborted, diagnosticId } = await listenOnce({ ...cfg, listenWindowSecs: window }, listenHooks(event.label));
        micOpen = false;
        activeDiagnosticId = diagnosticId;
        if (aborted) {
          consumeStopKey(); // the spacebar press is handled right here
          await closeMic();
          return log("⏹ spacebar — closed the mic");
        }
        if (error) {
          emitRecorderTrace(diagnosticId, { intent: "listen-error", bufferCountAfterReduction: buffer.length });
          if (bufferDiagnosticIds) emitRecorderTraces(bufferDiagnosticIds);
          return log(`listen error: ${error}`);
        }
        if (!text) {
          if (buffer.length) {
            await micCue(cfg, "sent");
            log(`held dictation timed out — submitting ${buffer.length} segment(s)`);
            updateRecorderTrace(diagnosticId, { intent: "timeout-submit", bufferCountAfterReduction: 0 });
            await deliver(
              event,
              buffer.join(" "),
              bufferDiagnosticIds
                ? diagnosticId
                  ? [...bufferDiagnosticIds, diagnosticId]
                  : bufferDiagnosticIds
                : undefined,
            );
          } else {
            emitRecorderTrace(diagnosticId, { intent: "timeout-close", bufferCountAfterReduction: 0 });
            await micCue(cfg, "close");
          }
          return log("no speech — back to idle");
        }

        // In hold-submit mode, "send"/"go" submits what's been dictated.
        if (buffer.length && isSendCommand(text)) {
          await micCue(cfg, "sent");
          log(`heard: "${text}" -> send (${buffer.length} segment(s))`);
          updateRecorderTrace(diagnosticId, { intent: "send", bufferCountAfterReduction: 0 });
          await deliver(
            event,
            buffer.join(" "),
            bufferDiagnosticIds
              ? diagnosticId
                ? [...bufferDiagnosticIds, diagnosticId]
                : bufferDiagnosticIds
              : undefined,
          );
          return;
        }

        const intent = classify(text);
        log(`heard: "${text}" -> ${intent}${buffer.length ? " (holding)" : ""}`);

        switch (intent) {
          case "prompt": {
            if (!cfg.holdSubmit) {
              updateRecorderTrace(diagnosticId, { intent: "prompt", bufferCountAfterReduction: 0 });
              await deliver(event, text, diagnosticId);
              return;
            }
            buffer.push(text); // accumulate in memory; injected all at once on submit
            if (diagnosticId) bufferDiagnosticIds?.push(diagnosticId);
            updateRecorderTrace(diagnosticId, { intent: "prompt", bufferCountAfterReduction: buffer.length });
            break;
          }
          case "discard":
            if (buffer.length) log(`discarded ${buffer.length} held segment(s)`);
            emitRecorderTrace(diagnosticId, { intent: "discard", bufferCountAfterReduction: 0 });
            if (bufferDiagnosticIds) emitRecorderTraces(bufferDiagnosticIds);
            markInjected(event.sessionId); // suppress the follow-up needs-you nag
            await speak(cfg, "Okay.", event.label);
            return;
          case "repeat":
            emitRecorderTrace(diagnosticId, { intent: "repeat", bufferCountAfterReduction: buffer.length });
            setState("speaking", event.label);
            await speak(cfg, lastSpoken, event.label);
            break;
          case "continue": {
            emitRecorderTrace(diagnosticId, { intent: "continue", bufferCountAfterReduction: buffer.length });
            if (!event.transcriptPath) {
              await speak(cfg, "I don't have the full message for this one.", event.label);
              break;
            }
            const full = await ensureSentences();
            const chunk = full.slice(cursor, cursor + cfg.continueSentences).join(" ");
            if (!chunk) {
              await speak(cfg, "That's the whole message.", event.label);
              break;
            }
            lastSpoken = chunk;
            setState("speaking", event.label);
            await speak(cfg, chunk, event.label);
            cursor += cfg.continueSentences;
            break;
          }
        }
      }
    } finally {
      // A downstream cue/TTS/transcript/injection failure must not strand an
      // otherwise finalized recorder row in memory. Normal terminal paths
      // have already emitted these IDs, so the store's emit-once guard makes
      // this a no-op there.
      if (!activeDiagnosticId || !bufferDiagnosticIds?.includes(activeDiagnosticId)) {
        emitRecorderTrace(activeDiagnosticId, {
          intent: "conversation-exit",
          bufferCountAfterReduction: buffer.length,
        });
      }
      if (bufferDiagnosticIds) emitRecorderTraces(bufferDiagnosticIds);
    }
  }

  /** Permission/elicitation dialogs: "yes" -> Enter (highlighted option), "no" -> Escape. Free text is refused on purpose. */
  async function permissionLoop(event: TurnEvent): Promise<void> {
    await micCue(cfg, "open");
    log("listening for yes or no...");
    micOpen = true;
    const { text, error, aborted, diagnosticId } = await listenOnce(cfg, listenHooks(event.label));
    micOpen = false;
    if (aborted) {
      consumeStopKey();
      await micCue(cfg, "close");
      return log("⏹ spacebar — closed the mic");
    }
    if (error) {
      emitRecorderTrace(diagnosticId, { intent: "permission-error", bufferCountAfterReduction: 0 });
      return log(`listen error: ${error}`);
    }
    if (!text) {
      emitRecorderTrace(diagnosticId, { intent: "permission-timeout", bufferCountAfterReduction: 0 });
      await micCue(cfg, "close");
      return log("no speech — back to idle");
    }
    const verdict = classifyApproval(text);
    log(`heard: "${text}" -> ${verdict ?? "unclear"}`);
    emitRecorderTrace(diagnosticId, { intent: verdict ?? "permission-unclear", bufferCountAfterReduction: 0 });
    if (!verdict) return void (await speak(cfg, "For permission prompts, say yes or no. Ignoring.", event.label));
    const { via } = await injectKey(cfg, event.pid, verdict === "approve" ? "Enter" : "Escape");
    if (via === "none") speak(cfg, "Could not reach the session's window to answer — do it by hand.", event.label);
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
    stopSpeaking(); // never orphan a talking `say` — voices overlapped live
    const recorderDrain = killActiveRecorders(); // a live sox capture would keep the mic hot after we die
    server.close();
    whisperServer?.kill();
    ttsServer?.kill();
    try {
      unlinkSync(cfg.socketPath);
    } catch {}
    if (!diagnosticsEnabled) process.exit(0);
    void Promise.resolve(recorderDrain).finally(() => {
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
          if (micOpen) abortListening(); // close a live dictation capture right now
          log(micOpen ? "⏹ spacebar — closing mic" : "⏹ spacebar — stopped");
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
      "  \x1b[1mcli\x1b[0m    conch wake [name] · sessions · voice <session> <voice> · mute · doctor",
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

async function micCue(cfg: Config, kind: keyof typeof CUE_SOUND): Promise<void> {
  if (!cfg.micCues) return;
  await Bun.spawn(["afplay", CUE_SOUND[kind]], { stdout: "ignore", stderr: "ignore" }).exited;
  if (kind === "open") await Bun.sleep(350); // let the cue's tail decay before sox arms
}
