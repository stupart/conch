import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { appendConchError } from "../src/app-errors.ts";
import {
  BUG_REPORTS_PER_HOUR,
  BugReportDesk,
  bugRecord,
  checkBugReport,
  decodeBugReportRequest,
  requestBugReport,
  type BugReportRequest,
} from "../src/bug-report.ts";
import { createControlServer, type ControlServer } from "../src/control-server.ts";
import { FailureDesk, fixBrief } from "../src/failure-tickets.ts";
import { isMacAppOnlyRequest } from "../src/phone-bridge.ts";

/**
 * `conch bug` (bug-report.ts). 2026-11-11, Tyler: "Also tool for them to submit bugs if possible." A report is a record
 * like any failure's, filed by the desk at once into a ticket of origin `bug`, private to the Mac, deduped and limited
 * per session, and answered with the ticket's number.
 */

const NOW = Date.parse("2026-11-11T12:00:00Z");
const HOUR = 60 * 60_000;

function harness() {
  const root = mkdtempSync(join(tmpdir(), "conch-bug-report-"));
  const errors = join(root, "errors.jsonl");
  const now = { value: NOW };
  const failures = new FailureDesk({
    storePath: join(root, "failure-tickets.json"),
    errorsPath: errors,
    mcpUsagePath: join(root, "mcp-usage.jsonl"),
    daemonLogPath: join(root, "daemon.log"),
    now: () => now.value,
    codeSince: NOW - HOUR,
    log: () => {},
    autoFix: () => false,
    fixFolder: () => ({ folder: "/checkouts/conch" }),
    startFix: async () => ({}),
  });
  const bugs = new BugReportDesk({
    record: (input) => void appendConchError(input, null, errors, new Date(now.value)),
    poll: () => void failures.poll(),
    ticket: (key) => failures.tickets().find((ticket) => ticket.id === key),
    now: () => now.value,
  });
  return { root, errors, now, failures, bugs };
}

const request = (from: string, extra: Partial<BugReportRequest["report"]> = {}): BugReportRequest => ({
  kind: "bug-report",
  from,
  version: "0.0.0-test",
  via: "process tree: this shell runs under pid 500, the session's own process",
  backend: "claude",
  report: { title: "The pill never lit after a publish", happened: "publish said filed; no pill on the Mac", expected: "the Ready pill", area: "publish", ...extra },
});

describe("a report's words", () => {
  test("a title on one line, what happened and what was expected, an area word, a few pieces of evidence", () => {
    expect(checkBugReport({ title: "  The pill   never lit ", happened: "a\r\nb", expected: "c" })).toEqual({
      ok: true, report: { title: "The pill never lit", happened: "a\nb", expected: "c", area: "conch" },
    });
    expect(checkBugReport({ title: "x", happened: "y", expected: "z", area: " Capture ", evidence: [" /tmp/a.png ", "exit 1"] })).toEqual({
      ok: true, report: { title: "x", happened: "y", expected: "z", area: "capture", evidence: ["/tmp/a.png", "exit 1"] },
    });
    expect(checkBugReport({ happened: "y", expected: "z" })).toEqual({ ok: false, error: "title is missing: one line saying what went wrong" });
    expect(checkBugReport({ title: "x", happened: "y" })).toEqual({ ok: false, error: "expected is missing: --expected says what should have happened" });
    expect(checkBugReport({ title: "x".repeat(121), happened: "y", expected: "z" })).toMatchObject({ ok: false, error: expect.stringContaining("at most 120, and it is not cut for you") });
    expect(checkBugReport({ title: "x", happened: "y", expected: "z", area: "two words" })).toMatchObject({ ok: false, error: expect.stringContaining("area is one word") });
    expect(checkBugReport({ title: "x", happened: "y", expected: "z", evidence: Array(7).fill("a") })).toEqual({ ok: false, error: "evidence is at most 6 paths or lines" });
    expect(checkBugReport({ title: "x", happened: "y\u0007", expected: "z" })).toMatchObject({ ok: false, error: "happened must be printable" });
  });

  test("on the wire: checked again by the daemon, and the Mac's alone, never a phone's", () => {
    expect(decodeBugReportRequest({ kind: "notify-user" })).toBeNull();
    expect(decodeBugReportRequest(request("s-1"))).toEqual({ ok: true, value: request("s-1") });
    expect(decodeBugReportRequest({ ...request("s-1"), from: "" })).toEqual({ ok: false, error: "from must name the session filing it, or unverified" });
    expect(decodeBugReportRequest({ ...request("s-1"), report: { title: "x" } })).toMatchObject({ ok: false });
    expect(isMacAppOnlyRequest(request("s-1"))).toBe(true);
  });

  test("its record is a failure record of origin bug: the area its operation, the title its message, the rest evidence", () => {
    expect(bugRecord(request("s-1", { evidence: ["/tmp/shot.png"] }))).toEqual({
      source: "bug",
      operation: "publish",
      message: "The pill never lit after a publish",
      sessionId: "s-1",
      state: {
        happened: "publish said filed; no pill on the Mac",
        expected: "the Ready pill",
        evidence: ["/tmp/shot.png"],
        filedBy: "an agent, with conch bug",
        via: "process tree: this shell runs under pid 500, the session's own process",
        backend: "claude",
        version: "0.0.0-test",
      },
    });
    expect(bugRecord(request("unverified")).sessionId).toBeUndefined();
  });
});

describe("filing it", () => {
  test("a new bug is a new ticket, with its number; the same bug from another session counts on it", () => {
    const h = harness();
    const first = h.bugs.file(request("s-1"));
    expect(first).toMatchObject({ kind: "bug-filed", outcome: "opened", ticket: 1, status: "open", count: 1, sessions: 1 });
    expect(first.kind === "bug-filed" && first.said).toContain("filed as #1, a new ticket in Settings › Failures on this Mac");
    expect(first.kind === "bug-filed" && first.said).toContain("it never goes anywhere public");
    const ticket = h.failures.tickets()[0]!;
    expect(ticket).toMatchObject({ origin: "bug", operation: "publish", title: "The pill never lit after a publish", status: "open", unseen: true });
    expect(ticket.sessions).toEqual([{ id: "s-1" }]);
    expect(JSON.parse(ticket.example.state!)).toMatchObject({ happened: "publish said filed; no pill on the Mac", expected: "the Ready pill" });
    // The record went where every failure record goes, for the desk to read like any other.
    const record = JSON.parse(readFileSync(h.errors, "utf8").trim());
    expect(record).toMatchObject({ source: "bug", operation: "publish", sessionId: "s-1" });

    h.now.value += 60_000;
    // Numbers and quoted words don't make it another bug.
    const second = h.bugs.file(request("s-2", { title: "The pill never lit after a publish", happened: "same, a minute later" }));
    expect(second).toMatchObject({ kind: "bug-filed", outcome: "counted", ticket: 1, count: 2, sessions: 2 });
    expect(h.failures.tickets()).toHaveLength(1);
  });

  test("the same bug from the same session is answered with its ticket, not filed again", () => {
    const h = harness();
    h.bugs.file(request("s-1"));
    h.now.value += 5 * 60_000;
    const again = h.bugs.file(request("s-1"));
    expect(again).toMatchObject({ kind: "bug-filed", outcome: "duplicate", ticket: 1, count: 1 });
    expect(again.kind === "bug-filed" && again.said).toContain("you filed this as #1 5 min ago; it is open");
    expect(readFileSync(h.errors, "utf8").trim().split("\n")).toHaveLength(1);
    // An hour on, it is a new occurrence.
    h.now.value += HOUR;
    expect(h.bugs.file(request("s-1"))).toMatchObject({ outcome: "counted", count: 2 });
  });

  test("a session files a few an hour; the terminal's reports share one allowance", () => {
    const h = harness();
    for (let index = 0; index < BUG_REPORTS_PER_HOUR; index += 1) {
      expect(h.bugs.file(request("s-1", { title: `Bug number ${"abcdefgh"[index]} broke` }))).toMatchObject({ outcome: "opened" });
    }
    const over = h.bugs.file(request("s-1", { title: "One more thing broke" }));
    expect(over).toEqual({ kind: "bug-error", refused: true, error: expect.stringContaining("refused: this session has filed 5 bugs in the last hour") });
    // Another session is its own.
    expect(h.bugs.file(request("s-2", { title: "One more thing broke" }))).toMatchObject({ outcome: "opened" });
    for (let index = 0; index < BUG_REPORTS_PER_HOUR; index += 1) h.bugs.file(request("unverified", { title: `Terminal bug ${"abcdefgh"[index]}` }));
    expect(h.bugs.file(request("unverified", { title: "Terminal bug z" }))).toMatchObject({ kind: "bug-error", error: expect.stringContaining("the terminal has filed 5") });
  });

  test("a fixed bug filed again opens again, and its fix brief says it is a report to reproduce", async () => {
    const h = harness();
    h.bugs.file(request("s-1"));
    const ticket = h.failures.tickets()[0]!;
    await h.failures.act(ticket.id, "mark-fixed");
    h.now.value += 2 * HOUR;
    expect(h.bugs.file(request("s-2"))).toMatchObject({ outcome: "reopened", ticket: 1, status: "open" });
    const brief = fixBrief(h.failures.tickets()[0]!, { errors: h.errors, mcpUsage: "/m", daemonLog: "/d" }, h.now.value);
    expect(brief).toContain("What went wrong: bug · publish: The pill never lit after a publish");
    expect(brief).toContain("This is a bug report filed with `conch bug` by an agent or the user");
    expect(brief).toContain("Reproduce it before you fix it.");
    expect(brief).toContain("The repository is PUBLIC.");
  });
});

describe("through a real control server", () => {
  const servers: ControlServer[] = [];
  afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

  test("a report reaches the daemon's desk as sent, and its ticket comes back; one the daemon can't read is refused", async () => {
    const dir = mkdtempSync("/tmp/conch-bug-");
    const socketPath = join(dir, "c.sock");
    const filed: BugReportRequest[] = [];
    const server = createControlServer({
      socketPath,
      ownerDeviceId: "this-mac",
      log: () => {},
      sessions: { resolve: (value) => value, current: () => ({ published: true, label: "demo" }) },
      application: {
        configuration: () => ({ kind: "config-error", error: "stub" }),
        session: () => ({ kind: "session-error", error: "stub" }),
        runtime: () => ({ kind: "session-error", error: "stub" }),
        turn: () => {},
        device: () => ({ kind: "ack" }),
      },
      bugReports: (report) => {
        filed.push(report);
        return { kind: "bug-filed", outcome: "opened", ticket: 7, status: "open", count: 1, sessions: 1, said: "filed as #7" };
      },
    } as Parameters<typeof createControlServer>[0]);
    servers.push(server);
    expect(await server.start()).toBe(true);
    try {
      expect(await requestBugReport(socketPath, request("s-1"))).toEqual({
        ok: true, reply: { kind: "bug-filed", outcome: "opened", ticket: 7, status: "open", count: 1, sessions: 1, said: "filed as #7" },
      });
      expect(filed).toEqual([request("s-1")]);
      const bad = await requestBugReport(socketPath, { ...request("s-1"), report: { title: "", happened: "", expected: "", area: "x" } });
      expect(bad).toMatchObject({ ok: true, reply: { kind: "bug-error", refused: true, error: expect.stringContaining("refused: title is missing") } });
      expect(filed).toHaveLength(1);
      expect(await requestBugReport(join(dir, "none.sock"), request("s-1"), 1_000)).toMatchObject({ ok: false, reason: "daemon-down" });
      // A daemon from before it reads the request as a malformed turn (control-server.ts' last branch): older, not filed.
      const older = createServer((socket) => socket.once("data", () => socket.end(`${JSON.stringify({ kind: "session-error", error: "type is required" })}\n`)));
      await new Promise<void>((resolve) => older.listen(join(dir, "old.sock"), resolve));
      try {
        expect(await requestBugReport(join(dir, "old.sock"), request("s-1"))).toMatchObject({ ok: false, reason: "older" });
      } finally {
        older.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The daemon's half, pinned in its source as browser-workbench.test.ts pins the Workbench's: the record and the desk's
// poll on one path, its answer on the socket, and nothing that leaves the Mac.
describe("in the daemon", () => {
  test("a report is written as a record, filed by the failure desk at once, and answered on the socket", () => {
    const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");
    expect(daemon).toContain("record: (input) => void appendConchError(input, lastPublishedPanelState),");
    expect(daemon).toContain("poll: () => void failureDesk.poll(),");
    expect(daemon).toContain("ticket: (key) => failureDesk.tickets().find((ticket) => ticket.id === key),");
    expect(daemon).toContain("bugReports: (request) => {");
    const source = readFileSync(join(import.meta.dir, "..", "src", "bug-report.ts"), "utf8");
    for (const away of ["gh issue", "fetch(", "api.github.com", "linear"]) expect(source.toLowerCase()).not.toContain(away);
  });
});
