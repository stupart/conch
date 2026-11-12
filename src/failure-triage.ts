import type { FailureOrigin } from "./failure-signature.ts";

/**
 * Whose failure a ticket is (docs/failure-tickets.md, "Triage"): conch's own, or an agent's call to one of conch's
 * tools that conch answered correctly.
 *
 * 2026-11-11, Tyler, of Settings › Failures: "what are we doing that the issues pile up? … do u see the issues in the
 * settings of the app?" 47 tickets were open, none being fixed. 25 of them were agents calling a tool wrong (an argument
 * it rejected, a selector that matched nothing, a seventh tab) in the same list, with the same Fix button and the same
 * dot on the gear, as the 22 that were conch letting him down. Those 25 are real signal, but for the tools' descriptions
 * and the agent CLI, not for him: they are listed apart, grouped by tool, and never light the gear or start an auto-fix.
 *
 * By the ticket's identity (origin, operation, normalized title), never its evidence, so a rule changed here re-sorts
 * the tickets already in the store the next time it is read.
 */
export type FailureBlame = "conch" | "agent";

/**
 * A tool call that ended `failed` although conch did what it should: the agent's target wasn't there, its selector
 * wasn't one, it was over a limit the tool states, or the page or the app it needed wasn't there to use. Matched on the
 * normalized title (failure-signature.ts), lower-cased. Anything not here that ended `failed` is conch's until shown
 * otherwise: a daemon that didn't answer, a target conch found but couldn't scroll to.
 */
const AGENT_FAILED: readonly RegExp[] = [
  // browser_click / browser_type: the agent's target matched nothing, or was stale.
  /^nothing (?:on the page matches|you can click says)\b/,
  /isn't a valid css selector/,
  /isn't a field you can type in/,
  /read it again\b.*\bfresh refs/,
  /is gone from the page \(it changed\)/,
  // browser_open: the tab limit, which the tool says and names the way out of.
  /tabs open; close one\b/,
  // conch_capture: a quote the agent gave that isn't on the page; a page that wouldn't load (its certificate, its server).
  /^the words .* aren't (?:visible )?on the page/,
  /^the page didn't load:/,
  // review_remove: nothing held under the artifact it named.
  /^nothing removed:/,
  // The browser and capture need conch's Mac app, and the tool says so: the app closed is a state, not a bug.
  /mac app isn't running/,
];

/** An MCP ticket's tool: its operation is the tool's name and how the call ended (`browser_click failed`). */
export function failureTool(origin: FailureOrigin, operation: string): string | undefined {
  if (origin !== "mcp") return undefined;
  return operation.split(" ")[0] || undefined;
}

/**
 * Whose failure it is. Only MCP calls can be an agent's: an `input-error` is an argument the tool rejected, a `refused`
 * one conch understood and declined (mcp.ts `ToolInputError`), and a `failed` one is the agent's only by `AGENT_FAILED`.
 * Every record from the daemon, the apps and the hook is conch's: a refusal conch is right to make there is fixed by not
 * filing it (docs/failure-tickets.md, "Not captured, on purpose").
 */
export function failureBlame(ticket: { origin: FailureOrigin; operation: string; title: string }): FailureBlame {
  if (ticket.origin !== "mcp") return "conch";
  const outcome = ticket.operation.split(" ").at(-1);
  if (outcome === "input-error" || outcome === "refused") return "agent";
  const title = ticket.title.toLowerCase();
  return AGENT_FAILED.some((rule) => rule.test(title)) ? "agent" : "conch";
}

/** Operations whose failure means something Tyler said or tapped never reached its session. */
const DELIVERY_OPERATIONS: ReadonlySet<string> = new Set(["inject", "permission-answer", "question-answer", "session-start", "hook"]);
/** A conch ticket seen this many times is worth telling him about, whatever it is. */
export const ALERT_AT_COUNT = 3;

/**
 * Whether a conch ticket is worth an alert beyond the gear's dot (docs/failure-tickets.md, "Showing it"): a failure to
 * deliver what he said or tapped, one that keeps happening, or one that came back after its fix. Agents' calls never
 * are; nor is a ticket that went quiet, or one he has put away.
 */
export function alertWorthy(ticket: {
  blame?: FailureBlame;
  status: string;
  staleAt?: number;
  operation: string;
  count: number;
  reopened?: number;
}): boolean {
  if ((ticket.blame ?? "conch") !== "conch" || ticket.status !== "open" || ticket.staleAt) return false;
  return DELIVERY_OPERATIONS.has(ticket.operation) || ticket.count >= ALERT_AT_COUNT || Boolean(ticket.reopened);
}

/**
 * A send's outcome that is no failure of conch's (docs/failure-tickets.md, "Not captured, on purpose"), by the receipt
 * code the inject's record carries (`state.code`): it went in, or conch declined on purpose and said why.
 *
 * - Delivered: the transcript moved, a hook confirmed it, the provider queued or steered it or started a turn on it, or
 *   Claude Code took it into a new session from that window. "The Return was lost; the prompt went in after 1
 *   re-send" was a ticket of its own: the recovery working.
 * - Declined: a dialog or a permission prompt was open, where a Return would have answered it (it once approved a
 *   command). The apps say so and the words stay in the draft; 17 of the 37 "Could not deliver the prompt" records.
 *
 * The record stays in errors.jsonl for diagnosis; only the ticket is passed over. A rule here, not at the send's call
 * site in voice-loop.ts, so the record keeps every step it took.
 */
const SEND_NOT_A_FAILURE: ReadonlySet<string> = new Set([
  "transcript-advanced", "prompt-hook-confirmed", "provider-input-queued", "provider-input-steered", "provider-turn-started",
  "prompt-new-session", "transport-submitted",
  "session-awaiting-answer", "session-awaiting-permission",
]);

/**
 * A permission or a question answered from a card after it had stopped waiting: answered in the terminal first, replaced
 * by a newer one, or closed. conch refusing to press keys at what is up now is the point (voice-loop.ts
 * `answerApproval`), and the card says why. A prompt conch can't answer at all is still filed: that one is a gap.
 */
const ANSWER_RACE = /^Could not answer the (?:permission|question): (?:that permission is no longer waiting|the permission dialog is not open|the permission changed before conch could answer it|the session is no longer waiting on a question|that question is no longer the one waiting|the question is no longer open)\b/;

/**
 * A close or restart that stopped to ask, as Claude Code itself does before it ends background tasks: the row says so
 * and a second Close stops them. The Mac app files the reply it was given; it is the close working.
 */
const CLOSE_ASKED = /^Claude Code is asking before it stops\b/;

/**
 * A model change the session's own state refused (session-settings.ts `declined`), which the daemon no longer files;
 * passed over here too, so an older daemon's record makes no ticket and the ones it made retire.
 */
const SETTINGS_DECLINED = /: (?:the session is working; change it when its turn is over|the session is waiting on you; answer it first|a picker is already open in the session|its prompt isn't on screen \(a dialog may be open\)|its prompt holds unsent words, so conch took back what it typed and left them alone)$/;

/** Whether a record from the daemon, the apps or the hook is passed over rather than filed (see above). */
export function notAFailure(record: { operation: string; message: string; state?: Record<string, unknown> }): boolean {
  if ((record.operation === "inject" || record.operation === "session-command") && typeof record.state?.code === "string") {
    return SEND_NOT_A_FAILURE.has(record.state.code);
  }
  if (record.operation === "permission-answer" || record.operation === "question-answer") return ANSWER_RACE.test(record.message);
  if (record.operation === "session-close" || record.operation === "session-restart") return CLOSE_ASKED.test(record.message);
  return record.operation === "session-settings" && SETTINGS_DECLINED.test(record.message);
}

/**
 * Whether an open ticket's newest example is one `notAFailure` now passes over: filed before the rule, it is retired
 * (gone quiet) when the desk starts rather than sitting open for the two weeks that would take. Its state is the
 * example's bounded JSON, which may be cut short; only its receipt code is read from it.
 */
export function retiredByRule(ticket: { operation: string; example: { message: string; state?: string } }): boolean {
  const code = /"code":"([a-z][a-z-]*)"/.exec(ticket.example.state ?? "")?.[1];
  return notAFailure({ operation: ticket.operation, message: ticket.example.message, ...(code ? { state: { code } } : {}) });
}

/**
 * The words a send's failure is filed under: "Could not deliver the prompt." says nothing of why, and five causes shared
 * that one ticket (a clipboard conch couldn't put back, a window that changed under it, a hosted session not open…).
 * With its receipt code in its first sentence each cause is its own ticket, as "message landed on clipboard (reason)"
 * always was.
 */
export function sendFailureMessage(message: string, code: unknown): string {
  if (typeof code !== "string" || !/^[a-z][a-z-]{2,40}$/.test(code)) return message;
  return message.replace(/^Could not deliver the prompt\./, `Could not deliver the prompt (${code}).`);
}
