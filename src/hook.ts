import { connect } from "node:net";
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
import { findSession, sessionLabel, isEngageable } from "./sessions.ts";
import { sessionHasLiveBackgroundWork } from "./agent-activity.ts";

interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  message?: string;
  notification_type?: string;
}

export interface TurnEvent {
  type: "turn-end" | "needs-you" | "wake" | "recite" | "mute" | "unmute" | "pause" | "resume" | "speak" | "working";
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
}

// Notification types that actually need a human; everything else stays silent.
const ACTIONABLE = new Set(["permission_prompt", "idle_prompt", "elicitation_dialog", ""]);

/**
 * Hook entrypoint: wire `conch hook` to the Stop and Notification hooks in
 * ~/.claude/settings.json (see `conch install`). Reads the hook payload from
 * stdin, rings the bell, and either hands the event to a running daemon
 * (which owns speak -> listen -> inject) or speaks the announcement itself.
 */
export async function runHook(cfg: Config): Promise<void> {
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
    const review = parseReviewRequest(finalText);
    const backgroundWork = !review && payload.transcript_path
      ? sessionHasLiveBackgroundWork(payload.transcript_path)
      : false;
    const snippet = payload.transcript_path
      ? await spokenSnippet(payload.transcript_path, cfg.speakSentences, cfg.speakMaxChars)
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

  // Daemon owns the voice loop when it's up; otherwise speak standalone
  // (awaited: the server TTS path dies with the process, and `say` is
  // spawned either way before we return).
  const handedOff = await sendToDaemon(cfg.socketPath, turn);
  if (!handedOff) {
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
