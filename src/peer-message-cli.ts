/**
 * `conch message`, as the sending agent runs it from its shell (peer-message-send.ts has the why).
 *
 * Exit codes as `conch agent` uses them (PR #610): 0 sent, 1 conch failed (no daemon, no answer), 2 the command was
 * wrong, 3 conch refused (and said why). What it prints on a send starts `[conch] sent to`, which the sender's own row
 * reads back as delivered (peer-messages.ts `conchMessageDelivery`).
 */

import { waitForTail, type AssistantTail } from "./transcript-tail.ts";
import { MESSAGE_WAIT_DEFAULT_S, MESSAGE_WAIT_MAX_S, parseMessageArgs } from "./peer-messages.ts";
import { PEER_MESSAGE_MAX_CHARS, type PeerMessageReply } from "./peer-message-send.ts";

export const MESSAGE_USAGE = `usage: conch message <session> "<text>"          send another session a message, into its prompt
       conch message <session> -                 the message from stdin (or pipe it in and give no text)
       conch message --reply <msg-id> "<text>"   answer a message conch delivered, to whoever sent it
  <session>          its id, label, registry name or folder name, exactly; one session only
  --wait [seconds]   then wait for that session's reply (${MESSAGE_WAIT_DEFAULT_S} s, at most ${MESSAGE_WAIT_MAX_S}) and print it

The other session sees who it is from and how to answer. Refused while it has a dialog open, while someone is
using the Mac and it runs in a Terminal window, and past a few messages in ten minutes. Between two Claude Code
sessions, SendMessage also works and needs no window.`;

export interface MessageCliDeps {
  /** One request line to the daemon, its one reply line (phone-bridge.ts `forwardToDaemonSocket`). */
  request(line: string, timeoutMs: number): Promise<string>;
  stdin(): Promise<string>;
  stdinIsTTY: boolean;
  /** The process that ran this: the agent's shell, walked up to its session by the daemon. */
  callerPid: number;
  /** For `--wait`: the target's newest reply, read from its transcript. */
  readTail(transcriptPath: string, sessionId: string): Promise<AssistantTail>;
  out(line: string): void;
  err(line: string): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

/** Past the inject's own 20 s wait for delivery, so the daemon's answer, not this, decides what happened. */
const SEND_TIMEOUT_MS = 30_000;

export async function runMessageCommand(argv: readonly string[], deps: MessageCliDeps): Promise<number> {
  const args = parseMessageArgs(argv);
  if (args.help) {
    deps.out(MESSAGE_USAGE);
    return 0;
  }
  const usage = (problem: string): number => {
    deps.err(`[conch] ${problem}\n${MESSAGE_USAGE}`);
    return 2;
  };
  if (args.error) return usage(args.error);
  if (!args.target && !args.replyTo) return usage("name the session to message, or --reply <msg-id>");
  let text = args.text;
  if (text === undefined && (args.stdin || !deps.stdinIsTTY)) text = await deps.stdin();
  if (!text?.trim()) return usage("the message is empty");
  if (text.length > PEER_MESSAGE_MAX_CHARS) return usage(`the message is ${text.length} characters; the most is ${PEER_MESSAGE_MAX_CHARS}`);

  let reply: PeerMessageReply;
  try {
    reply = JSON.parse(await deps.request(JSON.stringify({
      kind: "peer-message",
      callerPid: deps.callerPid,
      ...(args.target ? { to: args.target } : {}),
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
      text,
      ...(args.wait ? { wait: true } : {}),
    }), SEND_TIMEOUT_MS)) as PeerMessageReply;
  } catch (error) {
    deps.err(`[conch] not sent: conch isn't answering (${error instanceof Error ? error.message : String(error)}). Is conch running?`);
    return 1;
  }
  if (reply?.kind === "peer-message-refused") {
    deps.err(`[conch] not sent: ${reply.error}`);
    return reply.code === "invalid" ? 2 : 3;
  }
  if (reply?.kind !== "peer-message-sent") {
    deps.err("[conch] not sent: this conch doesn't deliver messages between sessions yet; update it.");
    return 1;
  }
  deps.out(`[conch] sent to "${reply.label}" (msg ${reply.msgId}). Its answer comes back into this session as a message from it.`);
  if (!args.wait) return 0;
  if (!reply.transcriptPath || !reply.cursor) {
    deps.out(`[conch] can't wait: conch can't read "${reply.label}"'s transcript.`);
    return 0;
  }
  return waitForReply(reply.label, reply.session, reply.transcriptPath, reply.cursor, args.wait * 1000, deps);
}

/** Until the other session ends a turn with new words, or the wait runs out. */
async function waitForReply(
  label: string,
  sessionId: string,
  transcriptPath: string,
  before: string,
  waitMs: number,
  deps: MessageCliDeps,
): Promise<number> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? Bun.sleep;
  const started = now();
  let since = before;
  while (now() - started < waitMs) {
    const read = await waitForTail(() => deps.readTail(transcriptPath, sessionId), {
      since, waitMs: waitMs - (now() - started), sleep, now,
    });
    since = read.cursor;
    // Words mid-turn are its working, not its answer: wait for the turn to end.
    if (!read.unchanged && !read.tail.midTurn && read.tail.text) {
      deps.out(`[conch] "${label}" answered:\n${read.tail.text}`);
      return 0;
    }
    if (read.unchanged) break;
  }
  deps.out(`[conch] no answer from "${label}" in ${Math.round(waitMs / 1000)} s; it may still answer, as a message into this session.`);
  return 0;
}
