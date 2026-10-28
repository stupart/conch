import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_FIX_DAILY_CAP,
  BRIEF_MAX,
  conchCheckout,
  decodeFailureTicketRequest,
  emptyFailureTicketStore,
  FailureDesk,
  type FailureDeskOptions,
  type FailurePr,
  fileOccurrence,
  fitFailureTicketList,
  fixBrief,
  listedTickets,
  LOOKBACK_MS,
  LOOP_OPERATION,
  occurrenceFromErrorRecord,
  occurrenceFromMcpRecord,
  readFailureTicketStore,
  readNewLines,
  type FailureTicketList,
} from "../src/failure-tickets.ts";
import { isMacAppOnlyRequest } from "../src/phone-bridge.ts";

// The loop's desk (docs/failure-tickets.md): records in, tickets out, and what a ticket's status does. Every name,
// folder and message here is made up; the real records hold the user's.

const HOUR = 60 * 60 * 1_000;
const NOW = Date.parse("2026-10-28T18:00:00Z");

function errorLine(fields: { at: number; source?: string; operation: string; message: string; sessionId?: string; label?: string; state?: Record<string, unknown> }): string {
  return `${JSON.stringify({
    v: 1,
    at: new Date(fields.at).toISOString(),
    source: fields.source ?? "daemon",
    operation: fields.operation,
    message: fields.message,
    ...(fields.sessionId ? { sessionId: fields.sessionId } : {}),
    state: { ...(fields.label ? { label: fields.label } : {}), ...fields.state },
    daemonState: null,
  })}\n`;
}

function mcpLine(fields: { ts: number; tool: string; outcome: string; error?: string; session?: string }): string {
  return `${JSON.stringify({ ...fields, backend: "claude", ms: 12, args: ["url"] })}\n`;
}

interface Harness {
  root: string;
  errors: string;
  mcp: string;
  store: string;
  now: { value: number };
  options: FailureDeskOptions;
  starts: Array<{ cwd: string; prompt: string }>;
  recorded: Array<{ operation: string; message: string }>;
  prs: Map<string, FailurePr | null | undefined>;
  alive: Map<string, boolean | undefined>;
  autoFix: { on: boolean };
  desk(): FailureDesk;
}

function harness(overrides: Partial<FailureDeskOptions> = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "conch-failure-tickets-"));
  const now = { value: NOW };
  const starts: Harness["starts"] = [];
  const recorded: Harness["recorded"] = [];
  const prs = new Map<string, FailurePr | null | undefined>();
  const alive = new Map<string, boolean | undefined>();
  const autoFix = { on: false };
  let launched = 0;
  const options: FailureDeskOptions = {
    storePath: join(root, "failure-tickets.json"),
    errorsPath: join(root, "errors.jsonl"),
    mcpUsagePath: join(root, "mcp-usage.jsonl"),
    daemonLogPath: join(root, "daemon.log"),
    now: () => now.value,
    codeSince: NOW - HOUR,
    log: () => {},
    autoFix: () => autoFix.on,
    fixFolder: () => ({ folder: "/checkouts/conch" }),
    startFix: async (request) => {
      starts.push(request);
      launched += 1;
      return { backgroundId: `conch-fix-${launched}` };
    },
    fixSessionAlive: async (name) => alive.get(name),
    findPr: async (_folder, branch) => prs.get(branch),
    recordFailure: (operation, message) => recorded.push({ operation, message }),
    ...overrides,
  };
  return {
    root,
    errors: options.errorsPath,
    mcp: options.mcpUsagePath,
    store: options.storePath!,
    now,
    options,
    starts,
    recorded,
    prs,
    alive,
    autoFix,
    desk: () => new FailureDesk(options),
  };
}

describe("records become tickets", () => {
  test("one ticket per kind of failure: counted, its sessions kept, its newest occurrence the example", () => {
    const h = harness();
    appendFileSync(h.errors, errorLine({ at: NOW - 3 * HOUR, operation: "open-deliverable", source: "mac", message: "Couldn't find plan-v1.md", sessionId: "s-1", label: "Plans" }));
    appendFileSync(h.errors, errorLine({ at: NOW - 2 * HOUR, operation: "open-deliverable", source: "mac", message: "Couldn't find clip.mp4", sessionId: "s-2", label: "Video" }));
    appendFileSync(h.errors, errorLine({ at: NOW - HOUR, operation: "inject", message: "Account profiles must have separate directories", sessionId: "s-1", state: { threw: true } }));
    appendFileSync(h.mcp, mcpLine({ ts: NOW - HOUR / 2, tool: "conch_capture", outcome: "failed", error: "failed: conch's Mac app isn't running, so it can't render pages; open it and try again.", session: "s-3" }));
    appendFileSync(h.mcp, mcpLine({ ts: NOW - HOUR / 3, tool: "review_to_front", outcome: "ok" }));
    const desk = h.desk();
    expect(desk.poll()).toBe(true);
    const tickets = desk.tickets();
    expect(tickets).toHaveLength(3);
    const missing = tickets.find((ticket) => ticket.operation === "open-deliverable")!;
    expect(missing).toMatchObject({ origin: "mac", title: "Couldn't find <file>", count: 2, status: "open", unseen: true, number: 1 });
    expect(missing.sessions.map((session) => session.label)).toEqual(["Video", "Plans"]);
    expect(missing.example.message).toBe("Couldn't find clip.mp4");
    const thrown = tickets.find((ticket) => ticket.operation === "inject")!;
    expect(thrown.example.state).toContain("\"threw\":true");
    expect(tickets.find((ticket) => ticket.origin === "mcp")).toMatchObject({ operation: "conch_capture failed", title: "conch's Mac app isn't running, so it can't render pages; open it and try again." });
    expect(desk.digest()).toEqual({ open: 3, fixing: 0, unseen: 3 });
    // Nothing new: nothing changes, nothing is written again.
    expect(desk.poll()).toBe(false);
  });

  test("the store is the owner's alone, and a desk started again picks up where the last one stopped", () => {
    const h = harness();
    appendFileSync(h.errors, errorLine({ at: NOW - HOUR, operation: "inject", message: "Typed, but the session never took it." }));
    h.desk().poll();
    expect(statSync(h.store).mode & 0o777).toBe(0o600);
    appendFileSync(h.errors, errorLine({ at: NOW - HOUR / 2, operation: "inject", message: "Typed, but the session never took it." }));
    const again = h.desk();
    again.poll();
    expect(again.tickets()).toHaveLength(1);
    expect(again.tickets()[0]!.count).toBe(2);
  });

  test("a first run reads back two weeks, not the whole history", () => {
    const h = harness();
    appendFileSync(h.errors, errorLine({ at: NOW - LOOKBACK_MS - HOUR, operation: "session-routing", message: "Codex row has no pid" }));
    appendFileSync(h.errors, errorLine({ at: NOW - HOUR, operation: "inject", message: "Could not deliver the prompt. Review the draft." }));
    const desk = h.desk();
    desk.poll();
    expect(desk.tickets().map((ticket) => ticket.operation)).toEqual(["inject"]);
  });

  test("a line still being written waits for its newline; a rotated file is finished before the new one is read", () => {
    const h = harness();
    const line = errorLine({ at: NOW - HOUR, operation: "inject", message: "first" });
    writeFileSync(h.errors, line.slice(0, 20));
    let read = readNewLines(h.errors, undefined);
    expect(read.lines).toEqual([]);
    expect(read.cursor!.offset).toBe(0);
    appendFileSync(h.errors, line.slice(20));
    read = readNewLines(h.errors, read.cursor);
    expect(read.lines).toHaveLength(1);
    // Rotation: one more line lands in the old file after the read, then it is renamed and a new one begun.
    appendFileSync(h.errors, errorLine({ at: NOW - HOUR, operation: "inject", message: "second" }));
    renameSync(h.errors, `${h.errors}.1`);
    writeFileSync(h.errors, errorLine({ at: NOW - HOUR, operation: "inject", message: "third" }));
    const rotated = readNewLines(h.errors, read.cursor);
    expect(rotated.lines.map((text) => JSON.parse(text).message)).toEqual(["second", "third"]);
  });

  test("records that aren't failures, or aren't records, are passed over", () => {
    expect(occurrenceFromMcpRecord(mcpLine({ ts: NOW, tool: "review_to_front", outcome: "ok" }))).toBeUndefined();
    expect(occurrenceFromMcpRecord("{not json")).toBeUndefined();
    expect(occurrenceFromErrorRecord(JSON.stringify({ at: "nope", source: "daemon", operation: "x", message: "y" }))).toBeUndefined();
    expect(occurrenceFromErrorRecord(JSON.stringify({ at: new Date(NOW).toISOString(), source: "elsewhere", operation: "x", message: "y" }))).toBeUndefined();
    // The label comes from the daemon's row for the session when the record's own state has none.
    const fromRow = occurrenceFromErrorRecord(JSON.stringify({
      at: new Date(NOW).toISOString(), source: "daemon", operation: "permission-answer", message: "Could not answer the permission",
      sessionId: "s-9", daemonState: { rows: [{ id: "s-9", label: "Billing" }] },
    }));
    expect(fromRow?.label).toBe("Billing");
  });

  test("a store that won't parse is set aside, never trusted", () => {
    const h = harness();
    writeFileSync(h.store, "{ half a store");
    expect(readFailureTicketStore(h.store).tickets).toEqual([]);
    expect(readdirSync(h.root).some((name) => name.startsWith("failure-tickets.json.unreadable-"))).toBe(true);
  });
});

describe("a ticket's status", () => {
  const occurrence = (at: number, message = "Typed, but the session never took it.") => ({
    at, origin: "daemon" as const, operation: "inject", message, source: "errors" as const,
  });

  test("a ticket a PR fixed opens again only for a failure seen by code from after the merge", () => {
    const store = emptyFailureTicketStore();
    const { ticket } = fileOccurrence(store, occurrence(NOW - 3 * HOUR), { codeSince: NOW - 4 * HOUR, autoFix: false });
    ticket.status = "fixed";
    ticket.fixedAt = NOW - 2 * HOUR;
    ticket.fixedBy = "pr";
    ticket.fix = { by: "you", startedAt: NOW - 3 * HOUR, branch: "fix/ticket-1", pr: { url: "https://github.test/pr/9", number: 9, state: "merged" } };
    // The daemon still runs code from before the merge: counted, not reopened.
    expect(fileOccurrence(store, occurrence(NOW - HOUR), { codeSince: NOW - 4 * HOUR, autoFix: false }).outcome).toBe("counted");
    expect(ticket.status).toBe("fixed");
    // Deployed (a daemon started after the merge): it came back.
    expect(fileOccurrence(store, occurrence(NOW), { codeSince: NOW - HOUR, autoFix: false }).outcome).toBe("reopened");
    expect(ticket).toMatchObject({ status: "open", unseen: true, reopened: 1, note: "Came back after #9 was merged." });
  });

  test("one Tyler marked fixed opens again on the next failure after he did", async () => {
    const h = harness();
    appendFileSync(h.errors, errorLine({ at: NOW - 2 * HOUR, operation: "inject", message: "Typed, but the session never took it." }));
    const desk = h.desk();
    desk.poll();
    const [ticket] = desk.tickets();
    await desk.act(ticket!.id, "mark-fixed");
    expect(ticket!.status).toBe("fixed");
    h.now.value = NOW + HOUR;
    appendFileSync(h.errors, errorLine({ at: NOW + HOUR / 2, operation: "inject", message: "Typed, but the session never took it." }));
    desk.poll();
    expect(ticket!.status).toBe("open");
    expect(desk.digest().unseen).toBe(1);
  });

  test("an ignored ticket stays quiet: counted, never unseen again", async () => {
    const h = harness();
    appendFileSync(h.errors, errorLine({ at: NOW - 2 * HOUR, operation: "session-settings", message: "Could not change \"X\" to sonnet: the session is waiting on you" }));
    const desk = h.desk();
    desk.poll();
    const [ticket] = desk.tickets();
    await desk.act(ticket!.id, "ignore");
    appendFileSync(h.errors, errorLine({ at: NOW - HOUR, operation: "session-settings", message: "Could not change \"Y\" to sonnet: the session is waiting on you" }));
    desk.poll();
    expect(ticket).toMatchObject({ status: "ignored", count: 2, unseen: false });
    expect(desk.digest()).toEqual({ open: 0, fixing: 0, unseen: 0 });
    await desk.act(ticket!.id, "reopen");
    expect(ticket!.status).toBe("open");
  });

  test("showing Failures marks every ticket seen", async () => {
    const h = harness();
    appendFileSync(h.errors, errorLine({ at: NOW - HOUR, operation: "a", message: "one" }));
    appendFileSync(h.errors, errorLine({ at: NOW - HOUR, operation: "b", message: "two" }));
    const desk = h.desk();
    desk.poll();
    expect(desk.digest().unseen).toBe(2);
    expect(await desk.act("all", "seen")).toEqual({ kind: "failure-ticket-ack" });
    expect(desk.digest().unseen).toBe(0);
  });
});

describe("Fix", () => {
  test("starts a session in the checkout with a brief: the evidence, and the rules, the repository's publicity first among them", async () => {
    const h = harness();
    appendFileSync(h.errors, errorLine({
      at: NOW - HOUR, operation: "inject", message: "Account profiles must have separate directories", sessionId: "s-7", label: "Client dashboard",
      state: { threw: true, stack: "at accountFor (~/conch/src/claude-account-sessions.ts:70:11)" },
    }));
    const desk = h.desk();
    desk.poll();
    const [ticket] = desk.tickets();
    const reply = await desk.act(ticket!.id, "fix");
    expect(reply.kind).toBe("failure-ticket");
    expect(ticket).toMatchObject({ status: "fixing", fix: { by: "you", branch: "fix/ticket-1", backgroundId: "conch-fix-1" } });
    expect(h.starts).toHaveLength(1);
    const { cwd, prompt } = h.starts[0]!;
    expect(cwd).toBe("/checkouts/conch");
    expect(prompt.startsWith("Fix conch failure ticket #1.")).toBe(true);
    expect(prompt).toContain("Account profiles must have separate directories");
    expect(prompt).toContain(`"Client dashboard" s-7`);
    expect(prompt).toContain("git worktree add .worktrees/ticket-1 -b fix/ticket-1 origin/main");
    expect(prompt).toContain("regression test");
    expect(prompt).toContain("Don't merge it, and don't deploy");
    expect(prompt).toContain("The repository is PUBLIC. Nothing from the evidence above goes into a commit, the PR");
    expect(prompt).toContain("never run bare tmux");
    expect(prompt).toContain("no GitHub issue");
    // Its own failures aren't Tyler's to hear about twice: a second press says it is under way.
    expect(await desk.act(ticket!.id, "fix")).toEqual({ kind: "failure-ticket-error", error: "#1 is already being fixed." });
  });

  test("two presses while the first launch is still under way start one session", async () => {
    let release: () => void = () => {};
    const h = harness({
      startFix: async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return { backgroundId: "conch-fix-1" };
      },
    });
    appendFileSync(h.errors, errorLine({ at: NOW - HOUR, operation: "inject", message: "Typed, but the session never took it." }));
    const desk = h.desk();
    desk.poll();
    const id = desk.tickets()[0]!.id;
    const first = desk.act(id, "fix");
    expect(await desk.act(id, "fix")).toEqual({ kind: "failure-ticket-error", error: "#1 is already being fixed." });
    release();
    expect((await first).kind).toBe("failure-ticket");
  });

  test("a brief never outgrows one command-line argument, and starts with a word, never a flag", () => {
    const store = emptyFailureTicketStore();
    const { ticket } = fileOccurrence(store, {
      at: NOW, origin: "daemon", operation: "inject", message: "x".repeat(5_000), source: "errors",
      state: { steps: Array.from({ length: 400 }, (_, index) => `step ${index}`) },
    }, { codeSince: NOW, autoFix: false });
    const brief = fixBrief(ticket, { errors: "/e", mcpUsage: "/m", daemonLog: "/l" }, NOW);
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX);
    expect(brief.startsWith("-")).toBe(false);
  });

  test("a fix that can't start says why, files the loop's own failure, and leaves the ticket open", async () => {
    const h = harness({ startFix: async () => { throw new Error("claude is not installed or is not on PATH"); } });
    appendFileSync(h.errors, errorLine({ at: NOW - HOUR, operation: "inject", message: "Typed, but the session never took it." }));
    const desk = h.desk();
    desk.poll();
    const [ticket] = desk.tickets();
    expect(await desk.act(ticket!.id, "fix")).toEqual({ kind: "failure-ticket-error", error: "The fix session didn't start: claude is not installed or is not on PATH" });
    expect(ticket!.status).toBe("open");
    expect(h.recorded).toEqual([{ operation: LOOP_OPERATION, message: "The fix session didn't start: claude is not installed or is not on PATH" }]);
  });

  test("without a checkout there is nowhere to fix from, and Fix says so", async () => {
    const h = harness({ fixFolder: () => ({ reason: "conch isn't running from a git checkout here." }) });
    appendFileSync(h.errors, errorLine({ at: NOW - HOUR, operation: "inject", message: "Typed, but the session never took it." }));
    const desk = h.desk();
    desk.poll();
    expect(await desk.act(desk.tickets()[0]!.id, "fix")).toEqual({ kind: "failure-ticket-error", error: "conch isn't running from a git checkout here." });
    expect(desk.list().fix).toEqual({ available: false, reason: "conch isn't running from a git checkout here." });
    expect(h.starts).toEqual([]);
  });

  test("the checkout is the one the daemon runs from, when it is a git checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "conch-checkout-"));
    expect(conchCheckout({}, root)).toEqual({ reason: "conch isn't running from a git checkout here, so a fix has nowhere to open a PR from." });
    writeFileSync(join(root, ".git"), "gitdir: elsewhere\n"); // a worktree's
    expect(conchCheckout({}, root)).toEqual({ folder: realpathSync(root) });
    expect(conchCheckout({ CONCH_FIX_FOLDER: join(root, "nowhere") }, root)).toEqual({ reason: `The fix folder ${join(root, "nowhere")} isn't there.` });
  });
});

describe("the fix's PR, found by its branch", () => {
  async function fixing(h: Harness) {
    appendFileSync(h.errors, errorLine({ at: NOW - HOUR, operation: "inject", message: "Typed, but the session never took it." }));
    const desk = h.desk();
    desk.poll();
    const ticket = desk.tickets()[0]!;
    await desk.act(ticket.id, "fix");
    return { desk, ticket };
  }

  test("an open PR is linked, a merged one fixes the ticket, a closed one sends it back", async () => {
    const h = harness();
    const { desk, ticket } = await fixing(h);
    h.prs.set("fix/ticket-1", { url: "https://github.test/pr/12", number: 12, state: "open" });
    await desk.checkFixes();
    expect(ticket).toMatchObject({ status: "fixing", fix: { pr: { url: "https://github.test/pr/12", state: "open" } } });
    h.prs.set("fix/ticket-1", { url: "https://github.test/pr/12", number: 12, state: "merged", mergedAt: NOW + HOUR });
    await desk.checkFixes();
    expect(ticket).toMatchObject({ status: "fixed", fixedAt: NOW + HOUR, fixedBy: "pr" });

    const other = harness();
    const second = await fixing(other);
    other.prs.set("fix/ticket-1", { url: "https://github.test/pr/13", number: 13, state: "closed" });
    await second.desk.checkFixes();
    expect(second.ticket).toMatchObject({ status: "open", unseen: true, note: "https://github.test/pr/13 was closed without merging." });
  });

  test("a fix session that ended with no PR leaves the ticket open again; one still working, or unknowable, is left be", async () => {
    const h = harness();
    const { desk, ticket } = await fixing(h);
    h.prs.set("fix/ticket-1", null);
    h.now.value = NOW + 10 * 60_000;
    h.alive.set("conch-fix-1", true);
    await desk.checkFixes();
    expect(ticket.status).toBe("fixing");
    h.alive.set("conch-fix-1", undefined);
    await desk.checkFixes();
    expect(ticket.status).toBe("fixing");
    h.prs.set("fix/ticket-1", undefined); // gh can't tell
    h.alive.set("conch-fix-1", false);
    await desk.checkFixes();
    expect(ticket.status).toBe("fixing");
    h.prs.set("fix/ticket-1", null);
    await desk.checkFixes();
    expect(ticket).toMatchObject({ status: "open", unseen: true, note: "The fix session ended without opening a PR." });
  });
});

describe("auto-fix", () => {
  const failure = (h: Harness, at: number, operation: string, message = "Typed, but the session never took it.") =>
    appendFileSync(h.errors, errorLine({ at, operation, message }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  test("is off unless turned on: nothing starts by itself", async () => {
    const h = harness();
    failure(h, NOW - HOUR, "inject");
    h.desk().poll();
    await settle();
    expect(h.starts).toEqual([]);
  });

  test("on, a ticket that opens gets a session; the backlog from before it was on does not", async () => {
    const h = harness();
    failure(h, NOW - 2 * HOUR, "backlog");
    const desk = h.desk();
    desk.poll();
    h.autoFix.on = true;
    failure(h, NOW - HOUR, "inject");
    desk.poll();
    await settle();
    expect(h.starts).toHaveLength(1);
    expect(h.starts[0]!.prompt).toContain("· inject:");
    expect(desk.tickets().find((ticket) => ticket.operation === "inject")).toMatchObject({ status: "fixing", fix: { by: "auto" } });
    expect(desk.tickets().find((ticket) => ticket.operation === "backlog")!.status).toBe("open");
  });

  test("one at a time: the next waits for the first's PR", async () => {
    const h = harness();
    h.autoFix.on = true;
    const desk = h.desk();
    failure(h, NOW - 3 * HOUR, "first");
    failure(h, NOW - 2 * HOUR, "second");
    desk.poll();
    await settle();
    expect(h.starts).toHaveLength(1);
    expect(desk.tickets().find((ticket) => ticket.operation === "second")!.status).toBe("open");
    h.prs.set("fix/ticket-1", { url: "https://github.test/pr/1", number: 1, state: "open" });
    await desk.checkFixes();
    await settle();
    expect(h.starts).toHaveLength(2);
    expect(desk.tickets().find((ticket) => ticket.operation === "second")!.status).toBe("fixing");
  });

  test(`at most ${AUTO_FIX_DAILY_CAP} a day`, async () => {
    const h = harness();
    h.autoFix.on = true;
    const desk = h.desk();
    for (let index = 0; index < AUTO_FIX_DAILY_CAP + 2; index += 1) {
      failure(h, NOW - HOUR + index, `op-${index}`);
      desk.poll();
      await settle();
      // Each one's PR opens, so the next may go.
      for (const ticket of desk.tickets()) {
        if (ticket.status === "fixing") h.prs.set(ticket.fix!.branch, { url: `https://github.test/pr/${ticket.number}`, state: "open" });
      }
      await desk.checkFixes();
      await settle();
    }
    expect(h.starts).toHaveLength(AUTO_FIX_DAILY_CAP);
    expect(desk.list().autoFix).toEqual({ on: true, today: AUTO_FIX_DAILY_CAP, cap: AUTO_FIX_DAILY_CAP });
  });

  test("never for the loop's own failures, nor for a ticket an auto-fix already fixed that came back", async () => {
    const h = harness();
    h.autoFix.on = true;
    const desk = h.desk();
    failure(h, NOW - 3 * HOUR, LOOP_OPERATION, "The fix session didn't start: no tmux");
    desk.poll();
    await settle();
    expect(h.starts).toEqual([]);

    failure(h, NOW - 2 * HOUR, "inject");
    desk.poll();
    await settle();
    expect(h.starts).toHaveLength(1);
    const ticket = desk.tickets().find((candidate) => candidate.operation === "inject")!;
    h.prs.set("fix/ticket-2", { url: "https://github.test/pr/5", number: 5, state: "merged", mergedAt: NOW - 90 * 60_000 });
    await desk.checkFixes();
    expect(ticket.status).toBe("fixed");
    failure(h, NOW - HOUR, "inject"); // the daemon started after the merge (codeSince): it came back
    desk.poll();
    await settle();
    expect(ticket.status).toBe("open");
    expect(h.starts).toHaveLength(1);
  });
});

describe("what a client is sent", () => {
  test("open first, then fixing, fixed for two weeks, ignored; evidence only on show", async () => {
    const store = emptyFailureTicketStore();
    const opts = { codeSince: NOW, autoFix: false };
    const make = (operation: string, at: number) => fileOccurrence(store, { at, origin: "daemon", operation, message: operation, source: "errors", sessionId: "s", label: "Secret client" }, opts).ticket;
    const open = make("open", NOW - HOUR);
    const fixing = make("fixing", NOW);
    fixing.status = "fixing";
    const recent = make("recent", NOW);
    recent.status = "fixed";
    recent.fixedAt = NOW - HOUR;
    const old = make("old", NOW);
    old.status = "fixed";
    old.fixedAt = NOW - 15 * 24 * HOUR;
    const ignored = make("ignored", NOW);
    ignored.status = "ignored";
    const listed = listedTickets(store.tickets, NOW);
    expect(listed.map((ticket) => ticket.operation)).toEqual(["open", "fixing", "recent", "ignored"]);
    expect(JSON.stringify(listed)).not.toContain("Secret client");
    expect(listed[0]).toMatchObject({ sessionCount: 1, count: 1, unseen: true });
  });

  test("a list too large for one frame drops the ignored, then the fixed, then the oldest, and says how many", () => {
    const ticket = (index: number, status: "open" | "fixed" | "ignored") => ({
      id: index.toString(16).padStart(12, "0"), number: index, origin: "daemon" as const, operation: "op", title: "t".repeat(150),
      status, statusAt: NOW, firstSeen: NOW, lastSeen: NOW, count: 1, sessionCount: 1, unseen: false,
    });
    const list: FailureTicketList = {
      kind: "failure-tickets",
      tickets: [...Array.from({ length: 200 }, (_, index) => ticket(index, "open")), ticket(900, "fixed"), ticket(901, "ignored")],
      autoFix: { on: false, today: 0, cap: 3 },
      fix: { available: true, folder: "/c" },
    };
    const fitted = fitFailureTicketList(list, 20_000);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(20_000);
    expect(fitted.tickets.every((listed) => listed.status === "open")).toBe(true);
    expect(fitted.hidden).toBe(list.tickets.length - fitted.tickets.length);
    expect(fitFailureTicketList({ ...list, tickets: list.tickets.slice(0, 3) })).toEqual({ ...list, tickets: list.tickets.slice(0, 3) });
  });

  test("the socket's requests are checked strictly, and are the Mac's alone", () => {
    expect(decodeFailureTicketRequest({ kind: "failure-tickets" })).toEqual({ kind: "failure-tickets" });
    expect(decodeFailureTicketRequest({ kind: "failure-ticket", id: "0123456789ab", action: "fix" })).toEqual({ kind: "failure-ticket", id: "0123456789ab", action: "fix" });
    expect(decodeFailureTicketRequest({ kind: "failure-ticket", id: "all", action: "seen" })).toEqual({ kind: "failure-ticket", id: "all", action: "seen" });
    expect(decodeFailureTicketRequest({ kind: "failure-ticket", id: "all", action: "fix" })).toEqual({ error: "only seen takes all" });
    expect(decodeFailureTicketRequest({ kind: "failure-ticket", id: "../x", action: "fix" })).toEqual({ error: "a ticket id is 12 hex characters, or all" });
    expect(decodeFailureTicketRequest({ kind: "failure-ticket", id: "0123456789ab", action: "merge" })).toEqual({ error: "action must be one of fix, ignore, reopen, mark-fixed, seen, show" });
    expect(decodeFailureTicketRequest({ kind: "ping" })).toBeNull();
    for (const body of [{ kind: "failure-tickets" }, { kind: "failure-ticket", id: "0123456789ab", action: "fix" }, { kind: "control-envelope", body: { kind: "failure-tickets" } }]) {
      expect(isMacAppOnlyRequest(body), JSON.stringify(body)).toBe(true);
    }
  });
});

describe("nothing leaves the Mac", () => {
  test("the desk's own code calls out to nothing but gh, read-only, and the mirror list is empty", async () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "failure-tickets.ts"), "utf8");
    expect(source).not.toMatch(/\bfetch\(|https?:\/\/(?!github\.test)/);
    // gh is asked one thing: the PR on a branch the loop named.
    const gh = [...source.matchAll(/\[gh, ([^\]]+)\]/g)].map((match) => match[1]);
    expect(gh).toEqual([`"pr", "list", "--head", branch, "--state", "all", "--json", "url,number,state,mergedAt", "--limit", "1"`]);
    const { FAILURE_MIRRORS } = await import("../src/failure-tickets.ts");
    expect(FAILURE_MIRRORS).toEqual([]);
  });
});
