import { basename } from "node:path";
import type { Config } from "./config.ts";
import {
  sendToDaemon,
  type TurnEvent,
} from "./hook.ts";
import {
  writeCodexSession,
  type CodexSessionEntry,
} from "./codex-sessions.ts";
import {
  sessionLabel,
  type SessionInfo,
} from "./sessions.ts";
import {
  firstSentences,
  parseReviewRequest,
  stripMarkdown,
  transcriptMark,
} from "./snippet.ts";
import { bell, speak } from "./speak.ts";

export interface CodexHookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  turn_id?: string;
  last_assistant_message?: string;
  agent_type?: unknown | null;
  stop_hook_active?: boolean;
}

interface ProcessRecord {
  ppid: number;
  command: string;
}

type ProcessLookup = (pid: number) => ProcessRecord | null | Promise<ProcessRecord | null>;

function processRecord(pid: number): ProcessRecord | null {
  try {
    const result = Bun.spawnSync(
      ["ps", "-p", String(pid), "-o", "ppid=", "-o", "command="],
      { stdout: "pipe", stderr: "ignore" },
    );
    if (result.exitCode !== 0) return null;
    const match = result.stdout.toString().trim().match(/^(\d+)\s+(.*)$/s);
    if (!match) return null;
    return { ppid: Number(match[1]), command: match[2] ?? "" };
  } catch {
    return null;
  }
}

export function isCodexDesktopProcess(command: string): boolean {
  const argv = command.trim().split(/\s+/);
  const executable = basename(argv[0] ?? "").toLowerCase();
  return /Codex\.app(?:\/|$)/i.test(argv[0] ?? "")
    || executable === "app-server"
    || (executable === "codex" && argv[1]?.toLowerCase() === "app-server");
}

/**
 * Codex desktop sessions also emit the Claude-compatible hooks, but they are
 * not terminal sessions conch can safely inject into. Fail open when the
 * process tree cannot be inspected, matching the existing Claude filter.
 */
export async function hasCodexDesktopAncestor(
  startPid: number,
  lookup: ProcessLookup = processRecord,
): Promise<boolean> {
  const seen = new Set<number>();
  let pid = startPid;
  for (let depth = 0; depth < 32 && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid);
    let record: ProcessRecord | null;
    try {
      record = await lookup(pid);
    } catch {
      return false;
    }
    if (!record) return false;
    if (isCodexDesktopProcess(record.command)) return true;
    pid = record.ppid;
  }
  return false;
}

export interface CodexHookDependencies {
  parentPid(): number;
  now(): number;
  isDesktopOrigin(pid: number): Promise<boolean>;
  writeSession(entry: CodexSessionEntry): void | Promise<void>;
  sendToDaemon(socketPath: string, event: TurnEvent): Promise<boolean>;
  transcriptMark(transcriptPath: string): Promise<number>;
  labelFor(session: SessionInfo | null, cwd: string | undefined): string;
  bell(cfg: Config): Promise<void>;
  speak(cfg: Config, text: string, label?: string): Promise<void>;
}

export const defaultCodexHookDependencies: CodexHookDependencies = {
  parentPid: () => process.ppid,
  now: Date.now,
  isDesktopOrigin: hasCodexDesktopAncestor,
  writeSession: (entry) => {
    writeCodexSession(entry);
  },
  sendToDaemon,
  transcriptMark,
  labelFor: sessionLabel,
  bell,
  speak,
};

/**
 * Map one already-decoded Codex hook payload, update the conch-owned registry,
 * and hand any resulting TurnEvent to the daemon. Exported as an object-level
 * seam so tests never need stdin, sockets, process inspection, or real config.
 */
export async function handleCodexHookPayload(
  payload: CodexHookPayload,
  cfg: Config,
  dependencies: CodexHookDependencies = defaultCodexHookDependencies,
): Promise<TurnEvent | null> {
  // A non-null agent_type positively identifies a subagent hook.
  if (payload.agent_type != null) return null;

  const hookEvent = payload.hook_event_name ?? "";
  if (
    hookEvent !== "Stop"
    && hookEvent !== "UserPromptSubmit"
    && hookEvent !== "SessionStart"
  ) {
    return null;
  }

  const eventAt = dependencies.now();
  const pid = dependencies.parentPid();
  if (await dependencies.isDesktopOrigin(pid)) return null;

  const status = hookEvent === "UserPromptSubmit" ? "busy" : "idle";
  const registryEntry: CodexSessionEntry = {
    sessionId: payload.session_id ?? "",
    cwd: payload.cwd ?? "",
    pid,
    status,
    updatedAt: eventAt,
    transcriptPath: payload.transcript_path ?? "",
  };
  await dependencies.writeSession(registryEntry);

  if (hookEvent === "SessionStart") return null;

  const info: SessionInfo = {
    sessionId: registryEntry.sessionId,
    backend: "codex",
    cwd: payload.cwd,
    pid,
    status,
    statusUpdatedAt: eventAt,
  };
  const label = dependencies.labelFor(info, payload.cwd);

  if (hookEvent === "UserPromptSubmit") {
    const working: TurnEvent = {
      type: "working",
      sessionId: registryEntry.sessionId,
      label,
      cwd: payload.cwd,
      pid,
      announce: "",
      eventAt,
    };
    await dependencies.sendToDaemon(cfg.socketPath, working);
    return working;
  }

  const finalText = payload.last_assistant_message ?? "";
  const review = parseReviewRequest(finalText);
  const snippet = firstSentences(
    stripMarkdown(finalText),
    cfg.speakSentences,
    cfg.speakMaxChars,
  );
  const turn: TurnEvent = {
    type: "turn-end",
    sessionId: registryEntry.sessionId,
    label,
    cwd: payload.cwd,
    pid,
    announce: review
      ? `${label} has work ready for your review: ${review.summary}`
      : `${label}: ${snippet || "finished, ready for your next prompt"}`,
    transcriptPath: payload.transcript_path,
    mark: payload.transcript_path
      ? await dependencies.transcriptMark(payload.transcript_path)
      : undefined,
    eventAt,
    ...(review ? { review } : {}),
  };

  const handedOff = await dependencies.sendToDaemon(cfg.socketPath, turn);
  if (!handedOff) {
    await dependencies.bell(cfg);
    await dependencies.speak(cfg, turn.announce, turn.label);
  }
  return turn;
}

/** CLI entrypoint for `conch codex-hook`; reads one JSON payload from stdin. */
export async function runCodexHook(
  cfg: Config,
  dependencies: CodexHookDependencies = defaultCodexHookDependencies,
): Promise<void> {
  if (process.env.CONCH_INTERNAL) return;
  let payload: CodexHookPayload;
  try {
    payload = JSON.parse(await new Response(Bun.stdin.stream()).text());
  } catch {
    return;
  }
  await handleCodexHookPayload(payload, cfg, dependencies);
}
