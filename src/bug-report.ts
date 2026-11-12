import { connect } from "node:net";
import { ControlFrameReader, encodeControlFrame } from "./control-framing.ts";
import { failureIdentity } from "./failure-signature.ts";
import type { FailureTicket } from "./failure-tickets.ts";

/**
 * `conch bug`: a bug about conch, filed by an agent (or the owner, from a terminal) as a failure ticket of its own
 * origin, `bug` (docs/failure-tickets.md).
 *
 * 2026-11-11, Tyler: "Also tool for them to submit bugs if possible." conch already files what its own records show (a
 * tool that failed, an inject the daemon refused); what an agent sees go wrong that no record holds (a pill that never
 * lit, a tab that opened under the wrong session, a wrong answer from a command) had nowhere to go but the agent's reply.
 *
 * It takes the one path every failure takes: a record through `appendConchError` into `errors.jsonl`, which the desk
 * files by its signature (`bug · <area> · <title>`), so the same bug from two sessions is one ticket that counts both.
 * The daemon writes it and polls the desk at once, so the answer gives the ticket's number. Nothing leaves the Mac:
 * conch's repository is public, and a ticket holds session names and the user's words. A session files a few an hour,
 * and the same bug once.
 */

export const BUG_REPORT_KIND = "bug-report";
export const BUG_TITLE_MAX = 120;
export const BUG_HAPPENED_MAX = 1_500;
export const BUG_EXPECTED_MAX = 600;
export const BUG_EVIDENCE_MAX = 6;
export const BUG_EVIDENCE_ITEM_MAX = 400;
/** What a report is filed under when it names no area: conch itself. */
export const BUG_DEFAULT_AREA = "conch";
const AREA = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** Reports from one session (or from the terminal, all of them together) in an hour. */
export const BUG_REPORTS_PER_HOUR = 5;
export const BUG_REPORT_WINDOW_MS = 60 * 60_000;
/** How long the daemon has to file one and say its number. */
export const BUG_REPORT_REPLY_MS = 10_000;

// Printable, one line: what a title is. A body may have line breaks; neither may have other control characters.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

export interface BugReport {
  title: string;
  happened: string;
  expected: string;
  area: string;
  evidence?: string[];
}

/** A report's own words, checked: one line of title, the two texts, an area word, a few pieces of evidence. */
export function checkBugReport(value: unknown): { ok: true; report: BugReport } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "a bug report is {title, happened, expected, area?, evidence?}" };
  const body = value as Record<string, unknown>;
  const text = (key: string, max: number, oneLine: boolean): string | { error: string } => {
    const raw = body[key];
    if (typeof raw !== "string" || !raw.trim()) return { error: `${key} is missing: ${key === "title" ? "one line saying what went wrong" : key === "happened" ? "--happened says what you saw" : "--expected says what should have happened"}` };
    const said = (oneLine ? raw.replace(/\s+/g, " ") : raw.replace(/\r\n?/g, "\n")).trim();
    if (CONTROL.test(said) || (oneLine && /\n/.test(said))) return { error: `${key} must be printable${oneLine ? ", on one line" : ""}` };
    if (said.length > max) return { error: `${key} is ${said.length} characters; at most ${max}, and it is not cut for you` };
    return said;
  };
  const title = text("title", BUG_TITLE_MAX, true);
  if (typeof title !== "string") return { ok: false, error: title.error };
  const happened = text("happened", BUG_HAPPENED_MAX, false);
  if (typeof happened !== "string") return { ok: false, error: happened.error };
  const expected = text("expected", BUG_EXPECTED_MAX, false);
  if (typeof expected !== "string") return { ok: false, error: expected.error };
  let area = BUG_DEFAULT_AREA;
  if (body.area !== undefined) {
    if (typeof body.area !== "string" || !AREA.test(body.area.trim().toLowerCase())) {
      return { ok: false, error: "area is one word (letters, digits, - or _): the command or tool it is about, like capture or browser" };
    }
    area = body.area.trim().toLowerCase();
  }
  let evidence: string[] | undefined;
  if (body.evidence !== undefined) {
    if (!Array.isArray(body.evidence) || body.evidence.length > BUG_EVIDENCE_MAX) return { ok: false, error: `evidence is at most ${BUG_EVIDENCE_MAX} paths or lines` };
    evidence = [];
    for (const item of body.evidence) {
      if (typeof item !== "string" || !item.trim() || CONTROL.test(item) || /\n/.test(item.trim())) return { ok: false, error: "each piece of evidence is a path or one line" };
      if (item.trim().length > BUG_EVIDENCE_ITEM_MAX) return { ok: false, error: `a piece of evidence is at most ${BUG_EVIDENCE_ITEM_MAX} characters: point at a file instead` };
      evidence.push(item.trim());
    }
  }
  return { ok: true, report: { title, happened, expected, area, ...(evidence?.length ? { evidence } : {}) } };
}

/** What crosses the socket: the report, who filed it (`from`: a verified session's id, or "unverified"), and its version. */
export interface BugReportRequest {
  kind: typeof BUG_REPORT_KIND;
  report: BugReport;
  from: string;
  /** How conch knew who filed it (`conch agent whoami`'s via), or why it couldn't. */
  via?: string;
  backend?: "claude" | "codex";
  /** The conch that filed it. */
  version: string;
}

export type BugReportReply =
  | {
    kind: "bug-filed";
    /** opened: a new ticket. counted: one that was there, now counting this. reopened: one fixed, back. duplicate: you filed it already. */
    outcome: "opened" | "counted" | "reopened" | "duplicate";
    ticket: number;
    status: FailureTicket["status"];
    count: number;
    sessions: number;
    pr?: string;
    said: string;
  }
  | { kind: "bug-error"; error: string; refused?: true };

/** A session's id as conch keys it (a window's carries its pid after a separator), or "unverified". */
const SESSION = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f\s]/.test(value);

/** A bug report, checked: null for any other kind. The Mac's own (phone-bridge.ts `MAC_APP_ONLY_DECODERS`). */
export function decodeBugReportRequest(value: unknown): { ok: true; value: BugReportRequest } | { ok: false; error: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.kind !== BUG_REPORT_KIND) return null;
  const checked = checkBugReport(body.report);
  if (!checked.ok) return checked;
  if (!SESSION(body.from)) return { ok: false, error: "from must name the session filing it, or unverified" };
  if (typeof body.version !== "string" || !body.version || body.version.length > 40) return { ok: false, error: "version must be the filing conch's" };
  if (body.via !== undefined && (typeof body.via !== "string" || body.via.length > 300 || CONTROL.test(body.via))) return { ok: false, error: "via must be a line" };
  if (body.backend !== undefined && body.backend !== "claude" && body.backend !== "codex") return { ok: false, error: "backend must be claude or codex" };
  return {
    ok: true,
    value: {
      kind: BUG_REPORT_KIND,
      report: checked.report,
      from: body.from,
      version: body.version,
      ...(typeof body.via === "string" ? { via: body.via } : {}),
      ...(body.backend === "claude" || body.backend === "codex" ? { backend: body.backend } : {}),
    },
  };
}

/** The record a report is, for `appendConchError`: its area the operation, its title the message, the rest evidence. */
export function bugRecord(request: BugReportRequest): { source: "bug"; operation: string; message: string; sessionId?: string; state: Record<string, unknown> } {
  return {
    source: "bug",
    operation: request.report.area,
    message: request.report.title,
    ...(request.from !== "unverified" ? { sessionId: request.from } : {}),
    state: {
      happened: request.report.happened,
      expected: request.report.expected,
      ...(request.report.evidence ? { evidence: request.report.evidence } : {}),
      filedBy: request.from === "unverified" ? "a shell conch couldn't tie to a session (the owner's terminal, or an agent it couldn't verify)" : "an agent, with conch bug",
      ...(request.via ? { via: request.via } : {}),
      ...(request.backend ? { backend: request.backend } : {}),
      version: request.version,
    },
  };
}

export interface BugReportDeskOptions {
  /** Write the record (`appendConchError`, with the daemon's state). */
  record(input: ReturnType<typeof bugRecord>): void;
  /** File what the records gained now (`FailureDesk.poll`). */
  poll(): void;
  /** The ticket a signature's key names (`FailureDesk.tickets`). */
  ticket(key: string): FailureTicket | undefined;
  now?: () => number;
  perHour?: number;
}

/**
 * The daemon's side: a report's limits, its record, and its ticket. The limits are kept by who filed it (`from`), as
 * `conch_notify`'s are: a few an hour from one session, and one report of the same bug from it.
 */
export class BugReportDesk {
  private readonly filed = new Map<string, Array<{ at: number; key: string; ticket: number }>>();
  private readonly now: () => number;

  constructor(private readonly options: BugReportDeskOptions) {
    this.now = options.now ?? Date.now;
  }

  file(request: BugReportRequest): BugReportReply {
    const now = this.now();
    const identity = failureIdentity("bug", request.report.area, request.report.title);
    const recent = (this.filed.get(request.from) ?? []).filter((one) => now - one.at < BUG_REPORT_WINDOW_MS);
    const again = recent.find((one) => one.key === identity.key);
    const before = this.options.ticket(identity.key);
    if (again && before) {
      this.filed.set(request.from, recent);
      return this.reply("duplicate", before, `you filed this as #${before.number} ${Math.max(1, Math.round((now - again.at) / 60_000))} min ago; it is ${statusWords(before)}`);
    }
    const cap = this.options.perHour ?? BUG_REPORTS_PER_HOUR;
    if (recent.length >= cap) {
      this.filed.set(request.from, recent);
      return { kind: "bug-error", refused: true, error: `refused: ${request.from === "unverified" ? "the terminal has" : "this session has"} filed ${recent.length} bugs in the last hour, the most it may. Put the rest in your reply; conch's failure tickets already hold what its own records showed` };
    }
    const countBefore = before?.count ?? 0;
    const statusBefore = before?.status;
    try {
      this.options.record(bugRecord(request));
      this.options.poll();
    } catch (error) {
      return { kind: "bug-error", error: `failed: conch couldn't file it: ${error instanceof Error ? error.message : String(error)}` };
    }
    const ticket = this.options.ticket(identity.key);
    if (!ticket || ticket.count <= countBefore) {
      return { kind: "bug-error", error: "failed: conch wrote the report but its failure desk didn't file it; it is in errors.jsonl and will be filed at the desk's next look" };
    }
    recent.push({ at: now, key: identity.key, ticket: ticket.number });
    this.filed.set(request.from, recent);
    const outcome = !before ? "opened" : statusBefore === "fixed" && ticket.status === "open" ? "reopened" : "counted";
    const said = outcome === "opened"
      ? `filed as #${ticket.number}, a new ticket in Settings › Failures on this Mac`
      : outcome === "reopened"
        ? `#${ticket.number} was fixed and is open again: it came back`
        : `#${ticket.number} already held this bug; it now counts ${ticket.count}, and it is ${statusWords(ticket)}`;
    return this.reply(outcome, ticket, said);
  }

  private reply(outcome: "opened" | "counted" | "reopened" | "duplicate", ticket: FailureTicket, said: string): BugReportReply {
    return {
      kind: "bug-filed",
      outcome,
      ticket: ticket.number,
      status: ticket.status,
      count: ticket.count,
      sessions: ticket.sessions.length,
      ...(ticket.fix?.pr ? { pr: ticket.fix.pr.url } : {}),
      said: `${said}. Only the user sees it: it never goes anywhere public`,
    };
  }
}

function statusWords(ticket: FailureTicket): string {
  if (ticket.status === "fixing") return ticket.fix?.pr ? `being fixed (${ticket.fix.pr.url})` : "being fixed";
  if (ticket.status === "fixed") return "marked fixed";
  if (ticket.status === "ignored") return "ignored by the user";
  return "open";
}

/** A report and its answer over the socket. */
export function requestBugReport(
  socketPath: string,
  request: BugReportRequest,
  timeoutMs = BUG_REPORT_REPLY_MS,
): Promise<{ ok: true; reply: BugReportReply } | { ok: false; reason: "daemon-down" | "no-reply" | "older"; diagnostic?: string }> {
  return new Promise((resolve) => {
    const frame = encodeControlFrame(JSON.stringify(request));
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    const reader = new ControlFrameReader();
    let connected = false;
    let settled = false;
    const finish = (result: Awaited<ReturnType<typeof requestBugReport>>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: connected ? "no-reply" : "daemon-down", diagnostic: "timed out" }), timeoutMs);
    socket.on("connect", () => {
      connected = true;
      socket.write(frame);
    });
    socket.on("data", (data) => {
      if (settled) return;
      try {
        const line = reader.push(typeof data === "string" ? Buffer.from(data) : data);
        if (line === undefined) return;
        const reply = JSON.parse(line) as BugReportReply;
        // A daemon from before `conch bug` reads the request as a malformed turn and says so (`session-error`).
        finish(reply && (reply.kind === "bug-filed" || reply.kind === "bug-error")
          ? { ok: true, reply }
          : { ok: false, reason: "older", diagnostic: "the daemon's answer wasn't a bug report's" });
      } catch (error) {
        finish({ ok: false, reason: "no-reply", diagnostic: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.on("error", (error) => finish({ ok: false, reason: connected ? "no-reply" : "daemon-down", diagnostic: error.message }));
    socket.on("close", () => finish({ ok: false, reason: connected ? "no-reply" : "daemon-down" }));
  });
}
