import { basename } from "node:path";
import { classifyApproval } from "./commands.ts";
import { visitLinesNewestFirst } from "./agent-activity.ts";
import { isCodexTranscriptPath, windowBranch } from "./snippet.ts";
import type { WindowIdentity } from "./conversation.ts";

/**
 * Voice approvals (B5): what a permission prompt is asking, and what a spoken
 * answer means.
 *
 * Claude Code's `permission_prompt` notification carries no tool — only
 * "Claude needs your permission to use Bash" — and it fires for an
 * AskUserQuestion too. The transcript does know: the assistant entry with the
 * `tool_use` block is written before the dialog opens, and the `tool_result`
 * lands only after it is answered. So "what is being asked" is the newest
 * tool_use with no result, read from `transcript_path`.
 *
 * The dialog itself takes keys, not text: option one is highlighted (Enter
 * = "Yes"), the next row is "Yes, and don't ask again …" (Down, Enter), and
 * Escape is "No, and tell Claude what to do differently". conch presses
 * exactly those.
 *
 * ponytail: keystrokes through a menu conch cannot see. The protocol-grade
 * upgrade is Claude Code's `PermissionRequest` hook (tool_name + tool_input on
 * stdin, allow/deny on stdout, 600 s timeout) — it needs the hook to block on
 * the daemon's socket for a reply, which the control server does not do yet.
 */

export interface PendingApproval {
  id: string;
  name: string;
  /** One spoken line: the command, the path, the query — whatever names the action. */
  summary: string;
  /**
   * False when conch must not press keys at it. `APPROVAL_KEYS` are the rows of
   * Claude Code's dialog; Codex's approval UI is not that dialog, so its ask is
   * announced and shown as needing you, and answered by hand.
   */
  answerable?: false;
}

/** Tools whose prompt is a question, not a permission — the four-way answer does not apply. */
const NOT_A_PERMISSION = new Set(["AskUserQuestion"]);

/** Newest `tool_use` in the transcript with no `tool_result` yet, or null. */
export function pendingApprovalFromLines(linesNewestFirst: Iterable<string>): PendingApproval | null {
  const answered = new Set<string>();
  for (const line of linesNewestFirst) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // partial final line mid-write
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    if (entry.type === "user") {
      const results = content.filter((block: any) => block?.type === "tool_result");
      if (!results.length) {
        // A real prompt from you: the conversation moved on past any dialog.
        if (content.some((block: any) => block?.type === "text" && block.text?.trim())) return null;
        continue;
      }
      for (const block of results) if (typeof block.tool_use_id === "string") answered.add(block.tool_use_id);
      continue;
    }
    if (entry.type !== "assistant") continue;
    const uses = content.filter((block: any) => block?.type === "tool_use");
    if (!uses.length) {
      // A finished reply: nothing is waiting on a dialog. Thinking-only entries say nothing either way.
      if (content.some((block: any) => block?.type === "text")) return null;
      continue;
    }
    const pending = uses.find((block: any) => !answered.has(block.id));
    if (!pending || NOT_A_PERMISSION.has(pending.name)) return null;
    return { id: String(pending.id ?? ""), name: String(pending.name ?? "tool"), summary: summarizeToolUse(pending.name, pending.input) };
  }
  return null;
}

/**
 * Codex asks for permission inside the call itself.
 *
 * Codex has no permission notification and no hook conch can wire for one —
 * `conch install --codex` wires Stop, UserPromptSubmit and SessionStart, and
 * that is all Codex offers — so its rollout is the only place an open prompt is
 * visible. It writes the tool call when it asks and the matching `*_output`
 * only once you answer, exactly as Claude writes `tool_use` before a dialog and
 * `tool_result` after it.
 *
 * An unanswered call is NOT enough on its own: every command still running
 * looks exactly like that, and calling those "needs you" would mark every
 * working session blocked — the same bug in the other direction. The ask is the
 * escalation itself: Codex puts `sandbox_permissions:"require_escalated"` in
 * the call input, beside a `justification` written for a person, when and only
 * when it needs you to allow the command.
 *
 * Captured from Tyler's own rollout at 2026-09-19T11:51:31Z — a thread that sat
 * on an unanswered `bun install` escalation for hours while conch reported it
 * as working, which is the bug this exists to close.
 *
 * ponytail: `require_escalated` is the only spelling any rollout on this
 * machine uses. Upstream Codex's shell tool spells it
 * `with_escalated_permissions`; add that alternative here if one ever shows up.
 */
const CODEX_ESCALATION = /require_escalated/;

export function pendingCodexApprovalFromLines(
  linesNewestFirst: Iterable<string>,
): PendingApproval | null {
  const answered = new Set<string>();
  for (const line of linesNewestFirst) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // partial final line mid-write
    }
    const payload = entry?.payload;
    const type = payload?.type;
    if (type === "custom_tool_call_output" || type === "function_call_output") {
      if (typeof payload.call_id === "string") answered.add(payload.call_id);
      continue;
    }
    if (type !== "custom_tool_call" && type !== "function_call") continue;
    const callId = typeof payload.call_id === "string" ? payload.call_id : "";
    if (!callId || answered.has(callId)) continue;
    const input = typeof payload.input === "string"
      ? payload.input
      : typeof payload.arguments === "string" ? payload.arguments : "";
    // Newest first, so this unanswered call is the last word on the thread:
    // either it is the escalation you are being asked to allow, or it is
    // ordinary work in flight and nothing is waiting on you.
    if (!CODEX_ESCALATION.test(input)) return null;
    const name = String(payload.name ?? "exec");
    const command = codexCallField(input, "cmd") ?? codexCallField(input, "command");
    const justification = codexCallField(input, "justification");
    return {
      id: callId,
      name,
      summary: summarizeToolUse(name, {
        ...(command ? { command } : {}),
        ...(justification ? { description: justification } : {}),
      }),
      answerable: false,
    };
  }
  return null;
}

/** One `key:"value"` from a Codex call's input, whether written as JSON or as source. */
function codexCallField(input: string, key: string): string | undefined {
  const match = input.match(new RegExp(`"?\\b${key}"?\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  return match ? match[1]!.replace(/\\(.)/g, "$1") : undefined;
}

/**
 * Read the tail of a Claude Code transcript for the prompt currently waiting.
 * Never throws.
 *
 * Two windows of one session write one transcript (A8), so the file's newest
 * unresolved tool can be the OTHER window's dialog — and the same read decides
 * both what is announced and, every time it is re-read, whether the answer is
 * still for that ask. Pass the window's registry identity and only its own
 * branch is read. When nothing names the branch the ask is refused rather than
 * guessed at: a dialog left for the keyboard costs a keypress, one answered by
 * the wrong window's Enter costs whatever that window was asking about.
 */
export function pendingApproval(transcriptPath: string, window?: WindowIdentity): PendingApproval | null {
  const lines: string[] = [];
  try {
    visitLinesNewestFirst(transcriptPath, () => true, (line) => {
      lines.push(line.toString("utf8"));
      // A dialog is always within the last few entries; a hundred is generous.
      return lines.length >= 100;
    });
  } catch {
    return null;
  }
  // A Codex rollout is a different file in a different shape, and two windows
  // never share one: its own reader decides, without a branch to attribute.
  if (isCodexTranscriptPath(transcriptPath)) return pendingCodexApprovalFromLines(lines);
  if (!window) return pendingApprovalFromLines(lines);
  const branch = windowBranch([...lines].reverse(), window);
  return branch.shared ? null : pendingApprovalFromLines([...branch.lines].reverse());
}

const SUMMARY_MAX = 120;

/** One line a person can hear: the part of the input that names the action. */
export function summarizeToolUse(name: string, input: unknown): string {
  const fields = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const value = fields[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const path = text("file_path") ?? text("notebook_path") ?? text("path");
  const raw = text("command")
    ?? (path ? basename(path) : undefined)
    ?? text("url")
    ?? text("query")
    ?? text("pattern")
    ?? text("description")
    ?? text("prompt")
    ?? Object.entries(fields).map(([key, value]) => `${key} ${typeof value === "string" ? value : JSON.stringify(value)}`).join(", ");
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX - 1)}…` : oneLine || name;
}

/** The spoken ask: who, which tool, and what it wants to do. */
export function approvalAnnounce(
  label: string,
  ask: Pick<PendingApproval, "name" | "summary" | "answerable">,
): string {
  const head = `${label} needs permission for ${ask.name}: ${ask.summary}.`;
  // Only Claude Code's dialog takes the four-way answer conch can press.
  return ask.answerable === false ? `${head} Answer it in the session.` : `${head} Yes, or no?`;
}

/** The dashboard row's reason, so "needs an answer" says what for. */
export function approvalDetail(ask: Pick<PendingApproval, "name" | "summary">): string {
  return `permission: ${ask.name} — ${ask.summary}`;
}

export const APPROVAL_REASK = "Say yes for this once, no, or no followed by what to do instead.";
export const APPROVAL_KEYBOARD = "Leaving it for the keyboard.";
/**
 * Said instead of granting "always". Claude Code's second option grants something
 * different per tool (for a Bash command, measured on 2.1.280: "always allow access to
 * <folder> from this project", with accept-edits mode among the suggestions), reached by a
 * blind Down, Enter — nothing conch could truthfully announce before pressing it.
 */
export const APPROVAL_NO_ALWAYS = "Always isn't something conch can grant: it allows more than conch can tell you. Yes for this once, or no?";

export type ApprovalAnswer =
  | { kind: "once" }
  | { kind: "always" }
  | { kind: "deny" }
  | { kind: "instead"; text: string };

/** The dialog's rows, as keys: Enter takes the highlighted "Yes"; Down then Enter the "don't ask again" row; Escape is "No, and tell Claude what to do differently". */
export const APPROVAL_KEYS: Record<ApprovalAnswer["kind"], ReadonlyArray<"Enter" | "Down" | "Escape">> = {
  once: ["Enter"],
  always: ["Down", "Enter"],
  deny: ["Escape"],
  instead: ["Escape"],
};

const DENY_LEAD = /^\s*(?:no|nope|nah|don'?t|do not|stop|cancel|reject|deny|decline)\b[\s,.:;!-]*(?:and|but|instead|rather)?[\s,.:;!-]*/i;
const INSTEAD_LEAD = /^\s*(?:instead|rather|tell (?:it|claude|codex))\b[\s,.:;!-]*(?:to\s+)?/i;
const ALWAYS = /\b(?:always|(?:don'?t|do not|never) ask(?: me)? again|for (?:this|the) session)\b/i;
const ONCE = /^\s*(?:yes|yeah|yep|sure|ok|okay)?[\s,]*(?:just )?(?:once|this once|this time|one time|for now)[\s,.!]*$/i;

/**
 * Map what was heard onto the dialog's four outcomes. Whisper splits on
 * pauses, so segments are joined: "no," [pause] "use main" is one answer.
 *
 * Unclear is null on purpose — the daemon re-asks once and then leaves the
 * row for the keyboard, because pressing a key on a guess is worse than
 * pressing none.
 */
export function classifyApprovalAnswer(segments: Iterable<string>): ApprovalAnswer | null {
  const text = Array.from(segments).map((segment) => segment.trim()).filter(Boolean).join(" ");
  if (!text) return null;
  const words = (value: string): number => value.replace(/[^a-z0-9\s]/gi, " ").trim().split(/\s+/).filter(Boolean).length;

  const instead = text.match(INSTEAD_LEAD);
  if (instead) {
    const rest = text.slice(instead[0].length).trim();
    return words(rest) >= 2 ? { kind: "instead", text: rest } : null;
  }
  // Before the deny lead: "don't ask again" starts with a refusal word.
  if (ALWAYS.test(text)) {
    // "always" beside a refusal is not an instruction conch should guess at.
    return classifyApproval(text.replace(ALWAYS, " ").trim()) === "deny" ? null : { kind: "always" };
  }
  const deny = text.match(DENY_LEAD);
  if (deny) {
    const rest = text.slice(deny[0].length).trim();
    // "no thanks", "no, stop" are a plain no; two real words after it are the alternative.
    if (words(rest) >= 2 && classifyApproval(rest) === null) return { kind: "instead", text: rest };
    return { kind: "deny" };
  }
  if (ONCE.test(text)) return { kind: "once" };
  // Sentence by sentence, so "Yes. No." is a conflict rather than whichever
  // word the filler-stripping in classifyApproval happens to keep.
  const verdicts = new Set(text.split(/[.!?]+/).map((piece) => piece.trim()).filter(Boolean).map(classifyApproval));
  if (verdicts.size !== 1) return null;
  const [plain] = verdicts;
  if (plain === "approve") return { kind: "once" };
  if (plain === "deny") return { kind: "deny" };
  return null;
}

