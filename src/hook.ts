import { connect } from "node:net";
import type { Config } from "./config.ts";
import { bell, speak } from "./speak.ts";
import { spokenSnippet, lastAssistantText, stripMarkdown, looksLikeAwaitingReply } from "./snippet.ts";
import { findSession, sessionLabel } from "./sessions.ts";

interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  message?: string;
  notification_type?: string;
}

export interface TurnEvent {
  type: "turn-end" | "needs-you" | "wake" | "mute" | "unmute" | "pause" | "resume";
  sessionId: string;
  label: string;
  cwd?: string;
  pid?: number;
  announce: string;
  /** full reply lives here — the daemon reads it for the "continue" command */
  transcriptPath?: string;
  /** notification_type for needs-you events (permission_prompt, idle_prompt, ...) */
  ntype?: string;
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

  const event = payload.hook_event_name ?? "";
  const session = await findSession(cfg.claudeDir, payload.session_id ?? "");
  const label = sessionLabel(session, payload.cwd);

  let turn: TurnEvent;
  if (event === "Stop" || event === "SubagentStop") {
    const snippet = payload.transcript_path
      ? await spokenSnippet(payload.transcript_path, cfg.speakSentences, cfg.speakMaxChars)
      : "";
    turn = {
      type: "turn-end",
      sessionId: payload.session_id ?? "",
      label,
      cwd: payload.cwd,
      pid: session?.pid,
      announce: `${label}: ${snippet || "finished, ready for your next prompt"}`,
      transcriptPath: payload.transcript_path,
    };
  } else {
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
    };
  }

  bell(cfg);

  // Daemon owns the voice loop when it's up; otherwise speak standalone
  // (awaited: the server TTS path dies with the process, and `say` is
  // spawned either way before we return).
  const handedOff = await sendToDaemon(cfg.socketPath, turn);
  if (!handedOff) await speak(cfg, turn.announce, turn.label);
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
