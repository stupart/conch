import type { SessionInfo } from "./sessions.ts";
import { runUICommand, type UICommandResult } from "./pasteboard.ts";
import { withUITransaction } from "./inject.ts";

export interface SessionAppOpenReply {
  kind: "session-open-app";
  sessionId: string;
  /** Launch Services accepted the exact chat link; not confirmation of window focus. */
  opened: boolean;
  reason?: string;
}

type AppSession = Pick<SessionInfo, "sessionId" | "agentSessionId" | "backend" | "messageRoute" | "parentSessionId">;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only known desktop sessions have an app destination. Never open a client-supplied URL. */
export async function openSessionApp(
  sessionId: string,
  session: AppSession | undefined,
  open: (argv: string[]) => Promise<UICommandResult> = (argv) =>
    withUITransaction(() => runUICommand(argv, undefined, { timeoutMs: 4_000 })),
): Promise<SessionAppOpenReply> {
  const failure = (reason: string): SessionAppOpenReply => ({ kind: "session-open-app", sessionId, opened: false, reason });
  if (!session || session.sessionId !== sessionId) return failure("That session is no longer available in conch.");
  if (session.parentSessionId || session.backend !== "codex" || session.messageRoute !== "codex-app") {
    return failure("This session has no supported app window to open.");
  }
  const threadId = session.agentSessionId ?? session.sessionId;
  if (!THREAD_ID.test(threadId)) return failure("This session has no valid Codex chat link.");
  try {
    const result = await open(["/usr/bin/open", `codex://threads/${threadId}`]);
    if (result.timedOut) return failure("Codex took too long to open. Try again.");
    if (result.exitCode !== 0) return failure("Couldn't open Codex. Check that the desktop app is installed on this Mac.");
    return { kind: "session-open-app", sessionId, opened: true };
  } catch {
    return failure("Couldn't open Codex on this Mac.");
  }
}
