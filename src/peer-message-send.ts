/**
 * `conch message`: one agent session's message into another's prompt, through conch's own delivery (2026-11-12).
 *
 * Tyler: "is there a way for agents to effectively message each other now in conch and how does it show in my convo
 * when they do?" Claude Code's SendMessage reaches another Claude session on this Mac and nothing else: a Codex
 * session can neither send one nor be sent one. conch already types into every kind of session it shows, so this
 * is that path, with what makes it one agent speaking to another rather than Tyler typing:
 *
 *   - It is framed as Claude Code frames its own (`conchPeerFraming`): the receiver is told who sent it, that it
 *     isn't its user, and how to answer; and both ends of conch show it as a message between sessions.
 *   - Only a session conch can name sends it (the caller's process, walked up to its session), and only to one it
 *     names exactly: an id, a label, a registry or folder name, never part of one, never two at once.
 *   - It is refused, never typed, while the target has a dialog open, as Tyler's sends are; and delivered without
 *     touching what he is doing (voice-loop `deliverPeerMessage`).
 *   - It is limited, per sender and per pair, so two agents thanking each other can't run all night.
 *   - Each message has an id, kept with who sent it to whom (never the words), so `--reply <id>` finds the sender.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CallerBinding } from "./caller-session.ts";
import { conchHome } from "./home.ts";
import type { TurnEvent } from "./hook.ts";
import type { SendFailure } from "./inject.ts";
import { transcriptFormatFor } from "./agent-adapter.ts";
import { readConversationTail, type WindowIdentity } from "./conversation.ts";
import { conchPeerFraming } from "./peer-messages.ts";
import { Breaker, type BreakerPolicy } from "./runaway.ts";
import { assistantTail, tailCursor } from "./transcript-tail.ts";

/** The longest message: a long brief fits, and the framed message stays far inside a 64 KiB control frame. */
export const PEER_MESSAGE_MAX_CHARS = 16_000;

/** One sender to one session: a conversation's worth in ten minutes, then a pause that grows if it keeps on. */
export const PEER_PAIR_POLICY: BreakerPolicy = {
  limit: 8,
  windowMs: 10 * 60_000,
  cooldownsMs: [10 * 60_000, 30 * 60_000, 60 * 60_000],
  calmMs: 2 * 60 * 60_000,
};

/** One sender to everyone. */
export const PEER_SENDER_POLICY: BreakerPolicy = {
  limit: 24,
  windowMs: 10 * 60_000,
  cooldownsMs: [10 * 60_000, 30 * 60_000, 60 * 60_000],
  calmMs: 2 * 60 * 60_000,
};

/** What `conch message` asks the daemon. */
export interface PeerMessageRequest {
  kind: "peer-message";
  /** The process that ran `conch message` (its shell): walked up to the session it belongs to. */
  callerPid: number;
  /** The session it is for, as the sender named it. Absent with `replyTo`: the message's sender. */
  to?: string;
  /** The message this answers. */
  replyTo?: string;
  text: string;
  /** Answer with the target's reply cursor from before delivery, for `--wait`. */
  wait?: true;
}

/** Why a message was not sent. */
export type PeerRefusal =
  | "invalid"
  | "unsupported"
  | "unverified-caller"
  | "no-such-session"
  | "ambiguous"
  | "partial-name"
  | "self"
  | "not-addressable"
  | "unknown-message"
  | "not-yours"
  | "rate-limited"
  | "auto-submit-off"
  | "not-delivered";

export type PeerMessageReply =
  | {
    kind: "peer-message-sent";
    msgId: string;
    session: string;
    label: string;
    /** For `--wait`: the target's transcript and its reply's cursor from before delivery (transcript-tail.ts). */
    transcriptPath?: string;
    cursor?: string;
  }
  | {
    kind: "peer-message-refused";
    code: PeerRefusal;
    error: string;
    /** For `not-delivered`: the delivery's own reason (`session-awaiting-permission`, `would-take-focus`, …). */
    reason?: string;
    /** For `rate-limited`: when it may send again. */
    retryAt?: number;
  };

/** The request as the control server reads it; null for any other body, `error` for a malformed one. */
export function decodePeerMessageRequest(value: unknown): PeerMessageRequest | { error: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.kind !== "peer-message") return null;
  if (typeof body.callerPid !== "number" || !Number.isSafeInteger(body.callerPid) || body.callerPid <= 1) {
    return { error: "callerPid must be the calling process's pid" };
  }
  const to = typeof body.to === "string" ? body.to.trim() : undefined;
  const replyTo = typeof body.replyTo === "string" ? body.replyTo.trim() : undefined;
  if (body.to !== undefined && (to === undefined || !to || to.length > 300)) return { error: "to names a session" };
  if (body.replyTo !== undefined && (!replyTo || !/^[\w-]{1,80}$/.test(replyTo))) return { error: "replyTo is a message id" };
  if (!to && !replyTo) return { error: "name the session to message, or the message to reply to" };
  if (typeof body.text !== "string" || !body.text.trim()) return { error: "the message is empty" };
  if (body.text.length > PEER_MESSAGE_MAX_CHARS) {
    return { error: `the message is ${body.text.length} characters; the most is ${PEER_MESSAGE_MAX_CHARS}` };
  }
  if (body.wait !== undefined && body.wait !== true) return { error: "wait is true when present" };
  return {
    kind: "peer-message",
    callerPid: body.callerPid,
    ...(to ? { to } : {}),
    ...(replyTo ? { replyTo } : {}),
    text: body.text,
    ...(body.wait ? { wait: true as const } : {}),
  };
}

/** A live session a message may name, with conch's label for it. */
export interface PeerMessageSession {
  sessionId: string;
  label: string;
  agentSessionId?: string;
  name?: string;
  cwd?: string;
  pid?: number;
  /** A subagent's row: nothing can be typed into it. */
  parentSessionId?: string;
  transcriptPath?: string;
}

/**
 * The one session a name means, exactly: its id, the agent's own id, its label, its registry name, its folder's name.
 * The first of those with a match decides; two matches there are refused, as is a name that is only part of one.
 */
export function resolvePeerTarget(
  query: string,
  sessions: readonly PeerMessageSession[],
): { session: PeerMessageSession } | { code: "no-such-session" | "ambiguous" | "partial-name"; error: string } {
  const q = query.trim().toLowerCase();
  const is = (value: string | undefined) => value !== undefined && value.toLowerCase() === q;
  const steps: Array<(session: PeerMessageSession) => boolean> = [
    (session) => is(session.sessionId),
    (session) => is(session.agentSessionId),
    (session) => is(session.label),
    (session) => is(session.name) || is(session.cwd?.split("/").filter(Boolean).pop()),
  ];
  const named = (session: PeerMessageSession) => `${session.sessionId} ("${session.label}")`;
  for (const step of steps) {
    const matches = sessions.filter(step);
    if (matches.length === 1) return { session: matches[0]! };
    if (matches.length > 1) {
      return {
        code: "ambiguous",
        error: `"${query.trim()}" names ${matches.length} live sessions, so none was sent to; name one by id: ${matches.map(named).join(", ")}`,
      };
    }
  }
  const partial = sessions.filter((session) => session.label.toLowerCase().includes(q) || session.name?.toLowerCase().includes(q));
  if (partial.length) {
    return {
      code: "partial-name",
      error: `"${query.trim()}" is only part of a name, and a message goes only to a session named exactly: ${partial.map(named).join(", ")}`,
    };
  }
  const live = sessions.filter((session) => !session.parentSessionId).map((session) => `"${session.label}"`);
  return { code: "no-such-session", error: `no live session is named "${query.trim()}". Live: ${live.join(", ") || "none"}` };
}

/** A message conch delivered: who to whom and when, never the words. */
export interface PeerJournalEntry {
  msgId: string;
  from: string;
  fromLabel: string;
  to: string;
  toLabel: string;
  at: number;
  replyTo?: string;
}

/** Where messages are remembered, for `--reply`. */
export interface PeerJournal {
  add(entry: PeerJournalEntry): void;
  find(msgId: string): PeerJournalEntry | undefined;
}

const JOURNAL_KEEP = 1_000;

export function peerJournalPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CONCH_CONFIG_DIR ?? join(conchHome(), ".config", "conch"), "peer-messages.jsonl");
}

/** The journal in a file, one entry a line, the newest `JOURNAL_KEEP` kept; a line that doesn't read is skipped. */
export function fileJournal(path = peerJournalPath()): PeerJournal {
  let entries: PeerJournalEntry[] | undefined;
  const load = (): PeerJournalEntry[] => {
    if (entries) return entries;
    entries = [];
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as PeerJournalEntry;
          if (typeof entry?.msgId === "string" && typeof entry.from === "string" && typeof entry.to === "string") entries.push(entry);
        } catch {}
      }
    } catch {}
    entries = entries.slice(-JOURNAL_KEEP);
    return entries;
  };
  return {
    add(entry) {
      const kept = load();
      kept.push(entry);
      try {
        if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        if (kept.length > JOURNAL_KEEP * 1.25) {
          entries = kept.slice(-JOURNAL_KEEP);
          writeFileSync(path, entries.map((line) => JSON.stringify(line)).join("\n") + "\n", { mode: 0o600 });
        } else {
          appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
        }
      } catch {}
    },
    find(msgId) {
      return load().findLast((entry) => entry.msgId === msgId);
    },
  };
}

export function memoryJournal(): PeerJournal {
  const entries: PeerJournalEntry[] = [];
  return {
    add: (entry) => void entries.push(entry),
    find: (msgId) => entries.findLast((entry) => entry.msgId === msgId),
  };
}

export interface PeerMessengerDeps {
  /** Which session a process belongs to (caller-session.ts `sessionForCallerPid`). */
  caller(pid: number): Promise<CallerBinding>;
  /** The live sessions conch publishes, with its labels: the only ones a message may name or come from. */
  sessions(): readonly PeerMessageSession[];
  /** Deliver the framed message through the inject path; the voice loop's answer (`deliverPeerMessage`). */
  deliver(event: TurnEvent): Promise<unknown>;
  /** For `wait`: the target's reply cursor now, before delivery. */
  replyCursor?(session: PeerMessageSession): Promise<{ transcriptPath: string; cursor: string } | undefined>;
  autoSubmit(): boolean;
  journal: PeerJournal;
  log(message: string): void;
  now?: () => number;
  newId?: () => string;
}

/**
 * A session's reply as it stands, as `conch_transcript_tail`'s cursor names it, so `--wait` can tell its next one from
 * this. Read with the row's registry entry, so a window of a shared session reads its own branch.
 */
export async function replyCursorOf(transcriptPath: string, sessionId: string, window?: WindowIdentity): Promise<string> {
  const conversation = await readConversationTail(transcriptPath, sessionId, transcriptFormatFor(transcriptPath), { window });
  return tailCursor(assistantTail(conversation));
}

/** A message id short enough to type in a reply: twelve hex digits. */
export function newPeerMessageId(): string {
  return randomBytes(6).toString("hex");
}

/** What the inject path answered, as delivered or not and why. */
function deliveryOutcome(outcome: unknown): { delivered: true } | { delivered: false; reason: string } {
  if (outcome === true || outcome === "staged") return { delivered: true };
  const failure = outcome as SendFailure | null | undefined;
  return { delivered: false, reason: (failure && typeof failure === "object" && failure.reason) || "delivery-failed" };
}

/** A delivery's reason, as a sentence for the sender. */
export function peerDeliveryReason(reason: string, label: string): string {
  switch (reason) {
    case "session-awaiting-permission":
      return `"${label}" is waiting on a permission prompt, and keys typed now would answer it. Send it again once that is settled.`;
    case "session-awaiting-answer":
      return `"${label}" has a question or dialog open, and keys typed now would answer it. Send it again once that is settled.`;
    case "would-take-focus":
      return `"${label}" runs in a Terminal window, and typing there would bring it to the front while someone is using the Mac. Try again in a few minutes; between two Claude Code sessions, SendMessage reaches it without a window.`;
    case "session-not-routable":
    case "window-not-focusable":
      return `conch can't reach "${label}"'s terminal to type into it.`;
    default:
      return `conch couldn't deliver it to "${label}" (${reason}).`;
  }
}

/**
 * The messenger: one `send` per `conch message`. Every refusal says why in words for the sending agent; nothing is
 * typed anywhere unless every check passed.
 */
export function createPeerMessenger(deps: PeerMessengerDeps) {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? newPeerMessageId;
  const breakers = new Map<string, Breaker>();
  const breaker = (key: string, what: string, policy: BreakerPolicy): Breaker => {
    let found = breakers.get(key);
    if (!found) {
      found = new Breaker({ name: key, what, policy, now });
      breakers.set(key, found);
      // One per sender and pair seen, which is a handful; bounded all the same.
      if (breakers.size > 512) breakers.delete(breakers.keys().next().value!);
    }
    return found;
  };
  const refused = (code: PeerRefusal, error: string, extra: { reason?: string; retryAt?: number } = {}): PeerMessageReply =>
    ({ kind: "peer-message-refused", code, error, ...extra });

  async function send(request: PeerMessageRequest): Promise<PeerMessageReply> {
    const sessions = deps.sessions();
    const binding = await deps.caller(request.callerPid);
    if (binding.status !== "verified") {
      return refused("unverified-caller", `conch can't tell which session is sending this (${binding.reason}), and a message has to say who it is from. Run conch message from a session's own shell.`);
    }
    const sender = sessions.find((session) => session.sessionId === binding.session.sessionId);
    if (!sender) return refused("unverified-caller", "the sending session isn't one conch shows, so the message couldn't say who it is from.");

    let target: PeerMessageSession | undefined;
    let replyTo = request.replyTo;
    if (request.to) {
      const found = resolvePeerTarget(request.to, sessions);
      if (!("session" in found)) return refused(found.code, found.error);
      target = found.session;
    } else if (replyTo) {
      const original = deps.journal.find(replyTo);
      if (!original) {
        return refused("unknown-message", `conch delivered no message ${replyTo}. A message Claude Code delivered (SendMessage) is answered with SendMessage to its sender; or name the session: conch message <session> --reply ${replyTo} "…"`);
      }
      // The receiver answers the sender; the sender may follow up its own message.
      const other = original.to === sender.sessionId ? original.from : original.from === sender.sessionId ? original.to : undefined;
      if (!other) return refused("not-yours", `message ${replyTo} was between two other sessions.`);
      target = sessions.find((session) => session.sessionId === other);
      if (!target) {
        const label = original.to === sender.sessionId ? original.fromLabel : original.toLabel;
        return refused("no-such-session", `"${label}", which message ${replyTo} was ${original.to === sender.sessionId ? "from" : "to"}, isn't live now.`);
      }
    }
    if (!target) return refused("no-such-session", "name the session to message, or the message to reply to");
    if (target.sessionId === sender.sessionId) return refused("self", "that is this session; a message goes to another one.");
    if (target.parentSessionId) {
      return refused("not-addressable", `"${target.label}" is a subagent inside another session, and nothing can be typed into it; message its session, or use SendMessage from inside it.`);
    }
    if (!deps.autoSubmit()) {
      return refused("auto-submit-off", "auto-submit is off, so conch types only what its user sends.");
    }

    const pair = breaker(`peer-message:${sender.sessionId}>${target.sessionId}`, `messages from "${sender.label}" to "${target.label}"`, PEER_PAIR_POLICY);
    const all = breaker(`peer-message:${sender.sessionId}`, `messages from "${sender.label}"`, PEER_SENDER_POLICY);
    const blocked = [pair, all].find((guard) => !guard.allows());
    if (blocked) {
      const retryAt = now() + blocked.waitMs();
      return refused("rate-limited", `too many ${blocked.what} in the last ${Math.round(blocked.policy.windowMs / 60_000)} minutes; conch will take another after ${new Date(retryAt).toLocaleTimeString()}. If the two of you are going back and forth, stop and tell your user what you need.`, { retryAt });
    }
    pair.record();
    all.record();

    const msgId = newId();
    const before = request.wait ? await deps.replyCursor?.(target).catch(() => undefined) : undefined;
    const framed = conchPeerFraming({
      fromSession: sender.sessionId,
      fromName: sender.label,
      msgId,
      ...(replyTo ? { replyTo } : {}),
      text: request.text,
    });
    const event: TurnEvent = {
      type: "inject",
      sessionId: target.sessionId,
      label: target.label,
      announce: framed,
      peer: true,
    };
    const outcome = deliveryOutcome(await deps.deliver(event).catch(() => ({ delivered: false, reason: "delivery-failed" })));
    deps.log(`message ${msgId} from "${sender.label}" to "${target.label}" (${request.text.length} chars): ${outcome.delivered ? "delivered" : `not delivered (${outcome.reason})`}`);
    if (!outcome.delivered) {
      return refused("not-delivered", peerDeliveryReason(outcome.reason, target.label), { reason: outcome.reason });
    }
    deps.journal.add({
      msgId, from: sender.sessionId, fromLabel: sender.label, to: target.sessionId, toLabel: target.label, at: now(),
      ...(replyTo ? { replyTo } : {}),
    });
    return {
      kind: "peer-message-sent",
      msgId,
      session: target.sessionId,
      label: target.label,
      ...(before ? { transcriptPath: before.transcriptPath, cursor: before.cursor } : {}),
    };
  }

  return { send };
}
