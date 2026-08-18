import { connect } from "node:net";
import { readState } from "./daemon-state.ts";
import type { Config } from "./config.ts";
import { bell, speak } from "./speak.ts";
import {
  spokenSnippet,
  lastAssistantText,
  stripMarkdown,
  looksLikeAwaitingReply,
  transcriptMark,
  parseReviewRequest,
} from "./snippet.ts";
import { currentTurnText } from "./transcript-turn.ts";
import { findSession, sessionLabel, isEngageable } from "./sessions.ts";
import { sessionHasLiveBackgroundWork } from "./agent-activity.ts";
import { askClaude } from "./model.ts";

interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  message?: string;
  notification_type?: string;
}

export interface TurnEvent {
  type: "turn-end" | "needs-you" | "wake" | "recite" | "spacebar" | "mute" | "unmute" | "pause" | "resume" | "speak" | "working" | "inject" | "interrupt";
  sessionId: string;
  label: string;
  cwd?: string;
  pid?: number;
  announce: string;
  /** full reply lives here — the daemon reads it for the "continue" command */
  transcriptPath?: string;
  /** notification_type for needs-you events (permission_prompt, idle_prompt, ...) */
  ntype?: string;
  /** transcript line count when this fired — used to detect you already responded since */
  mark?: number;
  /** Optional explicit voice for daemon-routed CLI auditions. */
  voice?: string;
  /** Epoch-ms when the hook observed this event, before any async processing. */
  eventAt?: number;
  /** This working state came from a Stop reclassified for live background work. */
  backgroundWork?: true;
  /** Set when the final reply carried a conch:review marker. */
  review?: { summary: string; link?: string };
  /**
   * Who asked for this wake.
   *
   * The mic opened by itself in manual mode and the log could only say
   * `wake -> "conch"` — Tyler: "why did the app just change to 'listening'
   * state when im in manual mode and didn't hit the mic button?" Five different
   * things enqueue an identical bare wake (the Mac button, the phone, the TUI
   * spacebar, `conch wake`, and the `conch_wake` MCP tool an agent can call),
   * so an unexplained one was unattributable after the fact.
   *
   * It also decides behaviour, not just logging: manual mode means conch does
   * nothing you did not ask for, so only a wake you personally initiated may
   * open the mic. An agent asking for attention gets held like any other
   * announcement.
   */
  origin?: "user" | "agent";
}

// Notification types that actually need a human; everything else stays silent.
const ACTIONABLE = new Set(["permission_prompt", "idle_prompt", "elicitation_dialog", ""]);

/**
 * Hook entrypoint: wire `conch hook` to the Stop and Notification hooks in
 * ~/.claude/settings.json (see `conch install`). Reads the hook payload from
 * stdin, rings the bell, and either hands the event to a running daemon
 * (which owns speak -> listen -> inject) or speaks the announcement itself.
 */
/**
 * One line per Stop hook, appended next to the daemon's log.
 *
 * The hook runs as its own short-lived process with nowhere to speak, so when
 * `conch:review` stopped producing rows there was no way to see what it read
 * or decided — only to infer it from outside, which was wrong twice. Failures
 * here are silent by construction unless something writes them down.
 *
 * Best-effort and never throws: a diagnostic must not be able to break the
 * hook it is diagnosing.
 */
async function appendHookTrace(
  cfg: Config,
  fields: Record<string, unknown>,
): Promise<void> {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), ...fields });
    const path = (cfg as { hookTracePath?: string }).hookTracePath ?? "/tmp/conch-hook.log";
    const file = Bun.file(path);
    const existing = await file.exists() ? await file.text() : "";
    // Bounded: this is a diagnostic, not an archive.
    const kept = (existing + line + "\n").split("\n").slice(-500).join("\n");
    await Bun.write(path, kept);
  } catch {
    // Deliberately silent.
  }
}

export async function runHook(cfg: Config): Promise<void> {
  if (process.env.CONCH_INTERNAL) return; // conch's own model shell-outs must never announce
  let payload: HookPayload;
  try {
    payload = JSON.parse(await new Response(Bun.stdin.stream()).text());
  } catch {
    return;
  }
  // Fractional epoch-ms avoids same-millisecond ties between short-lived hook
  // processes while remaining directly comparable with registry timestamps.
  const eventAt = performance.timeOrigin + performance.now();

  // Registry-independent backstop: a hook runs as a child of the Claude process,
  // inheriting CLAUDE_CODE_ENTRYPOINT ("cli" for an interactive terminal, "sdk-cli"
  // etc. for headless routines). This closes the leak even when the session's
  // registry file is mid-write/unreadable at hook time (the isEngageable check
  // below then can't see kind/entrypoint). Absent env → assume cli (conservative).
  if ((process.env.CLAUDE_CODE_ENTRYPOINT ?? "cli") !== "cli") return;

  const event = payload.hook_event_name ?? "";
  const session = await findSession(cfg.claudeDir, payload.session_id ?? "");
  const label = sessionLabel(session, payload.cwd);

  // Belt-and-braces: also drop by the registry entry when we can read it.
  // Headless/sdk-cli routines (e.g. boatker's cron runs) otherwise get announced
  // and steal the mic. An absent/unknown session falls through (don't over-drop).
  if (session && !isEngageable(session)) return;

  // SubagentStop isn't wired today, but if it ever is: a finishing background
  // subagent is NOT the main turn ending. Drop it explicitly — never let it
  // reach the Stop path (→ false "waiting") or the else branch (→ false needs-you).
  if (event === "SubagentStop") return;

  // UserPromptSubmit: the session just STARTED working — a visual-only status
  // signal for the dashboard panel. No bell, no speech; if the daemon is down
  // there's nothing to show, so just return.
  if (event === "UserPromptSubmit") {
    await sendToDaemon(cfg.socketPath, {
      type: "working",
      sessionId: payload.session_id ?? "",
      label,
      cwd: payload.cwd,
      pid: session?.pid,
      announce: "",
      eventAt,
    });
    return;
  }

  let turn: TurnEvent;
  if (event === "Stop") {
    const finalText = payload.transcript_path
      ? await lastAssistantText(payload.transcript_path)
      : "";
    // Parse the review from the WHOLE turn, not lastAssistantText.
    //
    // That returns the final message of a completed turn and deliberately
    // nothing while a tool call is outstanding — right for speech, which must
    // never announce half a turn. But it meant the marker was parsed out of an
    // EMPTY STRING, so `conch:review …` lines never became rows at all.
    // Measured on a live transcript: length 0, contains "conch:review" false,
    // parse null — while the same turn read 2,381 characters through
    // currentTurnText. The marker is the LAST such line in the turn, so
    // reading more text can only find it, never resurrect an older one.
    // Wait for the turn to actually LAND in the transcript.
    //
    // Stop fires before Claude Code has flushed the final assistant message.
    // Measured: at Stop the file held 1,410 characters of this turn ending
    // mid-narration, and lastAssistantText read 0 — so the `conch:review`
    // marker, which is written on the LAST line of the last message, was never
    // findable at Stop time no matter how it was parsed. Three previous
    // attempts fixed the parser and the text source; the text simply was not
    // there yet.
    //
    // A settled turn is one where lastAssistantText returns something: that
    // function deliberately yields nothing until the turn completes. Bounded
    // to about a second, and skipped entirely once it settles — most turns
    // pay nothing.
    let settledText = finalText;
    for (let attempt = 0; attempt < 6 && !settledText && payload.transcript_path; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      settledText = await lastAssistantText(payload.transcript_path);
    }
    const reviewSource = payload.transcript_path
      ? await currentTurnText(payload.transcript_path)
      : "";
    const review = parseReviewRequest(reviewSource || settledText || finalText);
    // The hook is a separate short-lived process with no terminal and no log,
    // so every failure here has been invisible — three rounds of reasoning
    // about reviews from OUTSIDE the process that decides. Record what it
    // actually read and what it made of it, next to the daemon's own log.
    void appendHookTrace(cfg, {
      event: "Stop",
      turnChars: reviewSource.length,
      finalChars: finalText.length,
      settledChars: settledText.length,
      sawMarker: reviewSource.includes("conch:review") || finalText.includes("conch:review"),
      // The shape of what it read, so the next failure names itself instead
      // of being inferred. 291 characters told me the scan stopped early; it
      // could not tell me WHERE.
      head: reviewSource.slice(0, 90),
      tail: reviewSource.slice(-90),
      parsed: review ? { summary: review.summary.slice(0, 60), link: review.link ?? null } : null,
    });
    const backgroundWork = !review && payload.transcript_path
      ? sessionHasLiveBackgroundWork(payload.transcript_path)
      : false;
    const snippet = payload.transcript_path
      ? await spokenSnippet(
        payload.transcript_path,
        cfg.speakSentences,
        cfg.speakMaxChars,
        {
          summarize: cfg.announceSummary,
          askClaude: (prompt, opts) =>
            askClaude(prompt, { timeoutMs: cfg.haikuTimeoutSecs * 1000, ...opts }),
        },
      )
      : "";
    turn = {
      type: backgroundWork ? "working" : "turn-end",
      sessionId: payload.session_id ?? "",
      label,
      cwd: payload.cwd,
      pid: session?.pid,
      announce: review
        ? `${label} has work ready for your review: ${review.summary}`
        : `${label}: ${snippet || "finished, ready for your next prompt"}`,
      transcriptPath: payload.transcript_path,
      mark: payload.transcript_path ? await transcriptMark(payload.transcript_path) : undefined,
      eventAt,
      ...(backgroundWork ? { backgroundWork: true } : {}),
      ...(review ? { review } : {}),
    };
  } else if (event === "Notification") {
    const ntype = payload.notification_type ?? "";
    if (!ACTIONABLE.has(ntype)) return;
    // idle_prompt fires on ANY idle session; only nag when the last reply
    // actually asked for something
    if (ntype === "idle_prompt" && payload.transcript_path) {
      const tail = stripMarkdown(await lastAssistantText(payload.transcript_path));
      if (tail && !looksLikeAwaitingReply(tail)) return;
    }
    turn = {
      type: "needs-you",
      sessionId: payload.session_id ?? "",
      label,
      cwd: payload.cwd,
      pid: session?.pid,
      announce: `${label} needs you: ${payload.message ?? "waiting for your input"}`,
      transcriptPath: payload.transcript_path,
      ntype,
      mark: payload.transcript_path ? await transcriptMark(payload.transcript_path) : undefined,
      eventAt,
    };
  } else {
    return; // unknown/unhandled hook event — never treat it as a needs-you nag
  }

  // The daemon owns the warm worker and voice loop when up. Otherwise speak
  // standalone; worker mode intentionally reaches the awaited say fallback.
  const handedOff = await sendToDaemon(cfg.socketPath, turn);
  if (!handedOff) {
    // Manual mode is a promise the daemon normally keeps, and with no daemon
    // there was nobody keeping it: every hook announced its own turn aloud on a
    // Mac explicitly set to silent. Tyler heard conch talking with the app shut
    // and nothing running. The mode is one boolean on disk, so read it — a
    // process speaking on conch's behalf answers to conch's mode.
    if (readState().paused) return;
    // A reclassified Stop is visual-only by default. The opt-in can still bell
    // and announce without a daemon, though only the daemon owns a listening loop.
    if (turn.backgroundWork && !cfg.workingMic) return;
    // A live daemon owns playback ordering around its microphone. Ring here
    // only when no daemon accepted the event; otherwise the daemon rings once
    // the preceding dictation controller is fully drained.
    await bell(cfg);
    await speak(cfg, turn.announce, turn.label);
  }
}

export function sendToDaemon(socketPath: string, event: TurnEvent): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 500);
    sock.on("connect", () => {
      sock.end(JSON.stringify(event) + "\n");
      clearTimeout(timer);
      resolve(true);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
