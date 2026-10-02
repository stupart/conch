import { appendFileSync, chmodSync, existsSync, renameSync, statSync } from "node:fs";
import { connect } from "node:net";
import { readState } from "./daemon-state.ts";
import { agentQuestions, type AgentQuestion, type QuestionAnswer } from "./conversation.ts";
import type { Config } from "./config.ts";
import { bell, speak } from "./speak.ts";
import {
  spokenSnippet,
  lastAssistantText,
  stripMarkdown,
  looksLikeAwaitingReply,
  linkRefusalNote,
  parsePublishableReview,
  parseReviewRequest,
  SAFE_REVIEW_LINK,
  type ReviewScene,
} from "./snippet.ts";
import { reviewLinkScope, type LinkScope, type SessionFolders } from "./review-roots.ts";
import { clearAgentNote, saveAgentNote, takeAgentNote, userPromptContext } from "./agent-notes.ts";
import { boundedMark } from "./prompt-cursor.ts";
import type { DeliverableKind } from "./deliverables.ts";
import { createHash } from "node:crypto";
import { promptDigest } from "./delivery-evidence.ts";
import { summarizeToolUse } from "./approval.ts";
import { currentTurnText } from "./transcript-turn.ts";
import { findHookWindow, sessionLabel, isEngageable, workingFolderOverrides, type SessionInfo } from "./sessions.ts";
import { sessionHasLiveBackgroundWork } from "./agent-activity.ts";
import { askClaude } from "./model.ts";

interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  message?: string;
  notification_type?: string;
  /** PermissionRequest: the tool call its dialog is asking about. */
  tool_name?: string;
  tool_input?: unknown;
  /** SessionStart: why the session started (`SESSION_START_SOURCES`). */
  source?: string;
  /** UserPromptSubmit: what was submitted. Only its fingerprint leaves this process. */
  prompt?: string;
}

/** What Claude Code's SessionStart hook says started the session. */
export const SESSION_START_SOURCES = ["startup", "resume", "clear", "compact"] as const;
export type SessionStartSource = (typeof SESSION_START_SOURCES)[number];

export function isSessionStartSource(value: unknown): value is SessionStartSource {
  return typeof value === "string" && (SESSION_START_SOURCES as readonly string[]).includes(value);
}

export interface TurnEvent {
  type: "turn-end" | "review-published" | "needs-you" | "wake" | "recite" | "spacebar" | "pause" | "resume" | "speak" | "working" | "inject" | "interrupt" | "session-start";
  sessionId: string;
  label: string;
  cwd?: string;
  pid?: number;
  announce: string;
  /** full reply lives here — the daemon reads it for the "continue" command */
  transcriptPath?: string;
  /**
   * On `working` from UserPromptSubmit: the submitted prompt's fingerprint (`promptDigest`), never its words.
   * A send conch typed is confirmed by its own words coming back this way (`delivery-evidence.ts`).
   */
  promptDigest?: string;
  /** notification_type for needs-you events (permission_prompt, idle_prompt, ...) */
  ntype?: string;
  /** transcript line count when this fired — used to detect you already responded since */
  mark?: number;
  /** Optional explicit voice for daemon-routed CLI auditions. */
  voice?: string;
  /** Epoch-ms when the hook observed this event, before any async processing. */
  eventAt?: number;
  /**
   * The SENDER's own id for this delivery, echoed back with whatever becomes of it.
   *
   * `inject-accepted` means the daemon took the words, not that they landed, and the
   * request that carried them is closed long before the truth is known. A client that
   * holds the words holds this id too, so a terminal outcome — minutes later, after a
   * reconnect, after a relaunch — can still be matched to the message it belongs to.
   */
  opId?: string;
  /** This working state came from a Stop reclassified for live background work. */
  backgroundWork?: true;
  /**
   * Set when the final reply carried a conch:review marker, and always on `review-published`.
   * `kind` and `key` travel only when the agent gave them; the daemon infers the rest
   * (`deliverableFacts`). `focus` is a folder deliverable's paths to point at, relative to it
   * (`checkFocusShape`); the daemon resolves them on the disk again before filing.
   * `linkRefused` says, to the person, why a link the marker gave was not published
   * (`linkRefusalNote`); it travels only when the hook dropped one. `roots` is never sent (the
   * socket refuses it): the daemon sets it on what it files (voice-loop `filedRoots`).
   */
  review?: {
    summary: string;
    link?: string;
    scene?: ReviewScene;
    kind?: DeliverableKind;
    key?: string;
    focus?: string[];
    linkRefused?: string;
    roots?: string[];
  };
  /**
   * The tool a permission dialog is waiting on (B5). Attached by the daemon
   * at handle time from the transcript, never by the hook: the dialog may
   * have been answered by hand while the event sat in the queue.
   */
  approval?: { id: string; name: string; summary: string };
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
  /**
   * Where this dictation should LAND: the composer, not the session.
   *
   * The mic beside a text field used to send straight past it — press it
   * expecting to add to what you had typed and the spoken half went into the
   * agent instead, so typed and spoken text could not be combined at all. A
   * wake carrying this asks for the transcript back rather than delivered.
   *
   * Absent means the voice loop's own behaviour, which must not change: an
   * announced turn opens the mic to REPLY, and that reply belongs in the
   * session.
   */
  compose?: true;
  /**
   * Answer this inject only once delivery has finished — keystrokes typed,
   * confirmed or fallen back to the clipboard — with `{"kind":"inject-done"}`.
   * Only the Mac app asks: it hands the front back from the Terminal window
   * conch raised to type. Absent (the phone, hooks, CLI) keeps the immediate
   * empty ack.
   */
  awaitDelivery?: true;
  /**
   * An inject that answers the question the session is waiting on: one answer
   * per question, in order. Typed into the agent's picker as its own keys;
   * `announce` is then only the readable summary.
   */
  answers?: QuestionAnswer[];
  /** The question row `answers` were chosen for (its conversation item id). */
  questionId?: string;
  /**
   * An inject that answers the permission prompt (`approval.id`) the session
   * is showing: its dialog's keys, pressed only while that same prompt is up.
   */
  approve?: { kind: "once" | "deny"; id: string };
  /**
   * The questions an AskUserQuestion picker on screen is asking, from Claude
   * Code's PermissionRequest hook: on 2.1.280 the transcript may not hold them
   * until they are answered.
   */
  asking?: { id: string; questions: AgentQuestion[] };
  /** On `session-start`: what started it. Absent when Claude Code named nothing conch knows. */
  startSource?: SessionStartSource;
}

/**
 * Claude Code's SessionStart hook, as the daemon hears it.
 *
 * A session stopped and resumed (`claude --resume`, same id) runs as a NEW
 * process, usually in a new Terminal tab. Until something told the daemon, it
 * kept the old process's window: conch learned about a session only from its
 * first prompt, so a message sent from conch in between was typed into the old
 * terminal and landed on the clipboard (2026-09-26, the "conch" session).
 *
 * This carries the same identity a UserPromptSubmit does — the window's key,
 * label, folder and pid, from Claude Code's registry — and nothing to say. It
 * is never a finished turn: the daemon refreshes who the session is and shows
 * it idle.
 */
export function sessionStartEvent(
  payload: Pick<HookPayload, "session_id" | "cwd" | "transcript_path" | "source">,
  session: Pick<SessionInfo, "sessionId" | "pid"> | null,
  label: string,
  eventAt: number,
): TurnEvent {
  return {
    type: "session-start",
    sessionId: session?.sessionId ?? payload.session_id ?? "",
    label,
    cwd: payload.cwd,
    pid: session?.pid,
    announce: "",
    transcriptPath: payload.transcript_path,
    eventAt,
    ...(isSessionStartSource(payload.source) ? { startSource: payload.source } : {}),
  };
}

/**
 * Where a hook's session is and has been, for its deliverable link (review-roots.ts): the folder
 * the hook fired in, the one its registry entry says it started in, and the folders it declared
 * (`conch_working_folders`, by the window's id, then the id two windows share, then the hook's).
 */
export function hookSessionFolders(
  cwd: string | undefined,
  session: Pick<SessionInfo, "sessionId" | "agentSessionId" | "cwd"> | null,
  sessionId: string | undefined,
  declared: Readonly<Record<string, string[]>> = workingFolderOverrides(),
): SessionFolders {
  const workDirs = (session ? declared[session.sessionId] ?? (session.agentSessionId ? declared[session.agentSessionId] : undefined) : undefined)
    ?? (sessionId ? declared[sessionId] : undefined);
  return { now: cwd, started: session?.cwd, ...(workDirs ? { workDirs } : {}) };
}

/** What a Stop made of a turn's `conch:review` line: the review it files, and the link it refused. */
export interface StopReview {
  review: NonNullable<TurnEvent["review"]> | null;
  /** The folders a link was checked against, for the trace; absent when the line gave none. */
  scope?: LinkScope;
  /** A link the line gave and the hook refused, with what to tell the agent about it. */
  refused?: { link: string; reason: string; agentNote: string };
}

/**
 * The `conch:review` line in `text`, its link checked against the session's folders. A refused
 * link no longer vanishes: the review carries why (`linkRefused`, for the Mac and the phone), and
 * so does `refused` (for the trace, and the agent's next prompt).
 */
export async function stopReview(text: string, folders: SessionFolders): Promise<StopReview> {
  // Most turns carry no line, and a line with no link has nothing to check.
  const request = parseReviewRequest(text);
  if (!request?.link) return { review: request };
  const scope = await reviewLinkScope(folders, process.cwd());
  const parsed = (await parsePublishableReview(text, scope.cwd, scope.roots))!;
  const refused = parsed.refused;
  return {
    review: {
      summary: parsed.summary,
      ...(parsed.link ? { link: parsed.link } : {}),
      ...(refused ? { linkRefused: linkRefusalNote(refused.link, refused.why) } : {}),
    },
    scope,
    ...(refused
      ? {
        refused: {
          link: refused.link,
          reason: refused.reason,
          // The bare rule says what a link must be; the agent also needs which link, and what was wrong with it.
          agentNote: `Your last conch:review link was not published: ${refused.reason === SAFE_REVIEW_LINK
            ? `${refused.link}: ${refused.why}; ${SAFE_REVIEW_LINK}`
            : refused.reason}.`,
        },
      }
      : {}),
  };
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
export const HOOK_TRACE_PATH = "/tmp/conch-hook.log";
const MAX_HOOK_TRACE_BYTES = 1024 * 1024;

export function appendHookTrace(
  cfg: Pick<Config, never> & { hookTracePath?: string },
  fields: Record<string, unknown>,
): void {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), ...fields });
    const path = cfg.hookTracePath ?? HOOK_TRACE_PATH;
    // 0600 and rolled over like the daemon log (status.ts prepareLogFile): it
    // carries the head and tail of every turn's text, and was the one
    // world-readable file in /tmp that did (audit 4a). Bounded: a diagnostic,
    // not an archive.
    try {
      if (existsSync(path) && statSync(path).size > MAX_HOOK_TRACE_BYTES) renameSync(path, `${path}.1`);
    } catch {}
    appendFileSync(path, line + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
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
  const session = await findHookWindow(cfg.claudeDir, payload.session_id ?? "");
  const label = sessionLabel(session, payload.cwd);

  // Belt-and-braces: also drop by the registry entry when we can read it.
  // Headless/sdk-cli routines (e.g. boatker's cron runs) otherwise get announced
  // and steal the mic. An absent/unknown session falls through (don't over-drop).
  if (session && !isEngageable(session)) return;

  // SubagentStop isn't wired today, but if it ever is: a finishing background
  // subagent is NOT the main turn ending. Drop it explicitly — never let it
  // reach the Stop path (→ false "waiting") or the else branch (→ false needs-you).
  if (event === "SubagentStop") return;

  // SessionStart: a session started, resumed, cleared or compacted, perhaps as a
  // new process in a new terminal. Identity only, like UserPromptSubmit: no bell,
  // no speech, no daemonless fallback. Claude Code adds a SessionStart hook's
  // stdout to the session's context, so this prints nothing either.
  if (event === "SessionStart") {
    await sendToDaemon(cfg.socketPath, sessionStartEvent(payload, session, label, eventAt));
    return;
  }

  // UserPromptSubmit: the session just STARTED working — a visual-only status
  // signal for the dashboard panel. No bell, no speech; if the daemon is down
  // there's nothing to show, so just return. It prints nothing either, except a
  // note the last Stop left for this agent (`agent-notes.ts`): Claude Code adds
  // that to the turn's context, once.
  if (event === "UserPromptSubmit") {
    const note = takeAgentNote(payload.session_id ?? "");
    if (note) process.stdout.write(userPromptContext(note));
    await sendToDaemon(cfg.socketPath, {
      type: "working",
      sessionId: session?.sessionId ?? payload.session_id ?? "",
      label,
      cwd: payload.cwd,
      pid: session?.pid,
      announce: "",
      eventAt,
      ...(typeof payload.prompt === "string" && payload.prompt.trim() ? { promptDigest: promptDigest(payload.prompt) } : {}),
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
    // Checked against every folder the session is and has been in, not only the one it is in
    // now: that moves, and a link into the folder it started in was dropped (review-roots.ts).
    const checked = await stopReview(
      reviewSource || settledText || finalText,
      hookSessionFolders(payload.cwd, session, payload.session_id),
    );
    const review = checked.review;
    // The agent is told at its next prompt, once; a line whose link passed takes back any old note.
    if (checked.refused) saveAgentNote(payload.session_id ?? "", checked.refused.agentNote);
    else if (review) clearAgentNote(payload.session_id ?? "");
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
      parsed: review
        ? {
          summary: review.summary.slice(0, 60),
          link: review.link ?? null,
          // Why a link the line gave was dropped: before this, a refusal read as a line with no link.
          ...(checked.refused ? { refused: { link: checked.refused.link, reason: checked.refused.reason } } : {}),
          // The folders the link was checked against, and what a relative one resolved against.
          ...(checked.scope ? { roots: checked.scope.roots, cwd: checked.scope.cwd } : {}),
        }
        : null,
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
      sessionId: session?.sessionId ?? payload.session_id ?? "",
      label,
      cwd: payload.cwd,
      pid: session?.pid,
      announce: review
        ? `${label} has work ready for your review: ${review.summary}`
        : `${label}: ${snippet || "finished, ready for your next prompt"}`,
      transcriptPath: payload.transcript_path,
      mark: payload.transcript_path ? await boundedMark(cfg, payload.transcript_path) : undefined,
      eventAt,
      ...(backgroundWork ? { backgroundWork: true } : {}),
      ...(review ? { review } : {}),
    };
  } else if (event === "PermissionRequest") {
    // The one moment a pending permission is knowable on Claude Code 2.1.280:
    // it writes the tool call to the transcript only once the dialog resolves
    // (measured: no assistant record at all while it is up), so the transcript
    // read this used to depend on found nothing, and every prompt reached conch
    // as a bare needs mark — no card, no bell, no voice. It fires just before
    // the dialog opens. conch prints nothing, so the dialog still shows.
    const name = String(payload.tool_name ?? "tool");
    const sessionId = session?.sessionId ?? payload.session_id ?? "";
    const id = `hook:${createHash("sha1").update(`${sessionId}\n${name}\n${JSON.stringify(payload.tool_input ?? null)}\n${eventAt}`).digest("hex").slice(0, 16)}`;
    // Claude Code asks this hook about its question picker too (measured: tool_name
    // AskUserQuestion, the questions in tool_input). A question is not a permission:
    // Allow would press Enter and pick whichever option is highlighted. So it becomes
    // the questions themselves, which the transcript may not hold while they are open.
    if (name === "AskUserQuestion") {
      const questions = agentQuestions(payload.tool_input);
      if (!questions.length) return;
      await sendToDaemon(cfg.socketPath, {
        type: "needs-you",
        sessionId,
        label,
        cwd: payload.cwd,
        pid: session?.pid,
        announce: `${label} is asking: ${questions[0]!.question}`,
        transcriptPath: payload.transcript_path,
        ntype: "elicitation_dialog",
        eventAt,
        asking: { id, questions },
      });
      return;
    }
    // Plan mode's exit dialog is not a yes/no either, and conch doesn't know its keys.
    if (name === "ExitPlanMode") return;
    const summary = summarizeToolUse(name, payload.tool_input);
    turn = {
      type: "needs-you",
      sessionId,
      label,
      cwd: payload.cwd,
      pid: session?.pid,
      announce: `${label} needs you: ${name} — ${summary}`,
      transcriptPath: payload.transcript_path,
      ntype: "permission_prompt",
      mark: payload.transcript_path ? await boundedMark(cfg, payload.transcript_path) : undefined,
      eventAt,
      approval: { id, name, summary },
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
      sessionId: session?.sessionId ?? payload.session_id ?? "",
      label,
      cwd: payload.cwd,
      pid: session?.pid,
      announce: `${label} needs you: ${payload.message ?? "waiting for your input"}`,
      transcriptPath: payload.transcript_path,
      ntype,
      mark: payload.transcript_path ? await boundedMark(cfg, payload.transcript_path) : undefined,
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
