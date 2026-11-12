import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountRegistrySnapshot } from "../src/claude-account-sessions.ts";
import type { TurnEvent } from "../src/hook.ts";
import {
  PARKED_WINDOW_MS,
  ParkedJobAttacher,
  ParkedJobReader,
  parkedJobFromState,
  parkedSessions,
  type ParkedAccount,
} from "../src/parked-jobs.ts";
import type { SessionInfo } from "../src/sessions.ts";

/**
 * Claude Code background agents parked waiting on you (parked-jobs.ts). On 2026-10-24 Tyler found two that had waited
 * on him since Oct 21: Claude Code stops a background agent's process when it asks, and conch listed only sessions
 * with a live process. The records below are shaped like those two (`~/.claude/jobs/<shortId>/state.json`).
 */

const ID = "5e5e5e03-0003-4000-8000-000000000003";
const NOW = Date.parse("2026-10-24T18:00:00.000Z");
const blocked = (over: Record<string, unknown> = {}) => ({
  state: "blocked",
  tempo: "blocked",
  detail: "critic loop live in production; awaiting go-ahead for onboarding",
  needs: "confirm: start onboarding walkthrough or next step?",
  suggestedReply: "yea start on the onboarding walkthrough",
  template: "bg",
  respawnFlags: ["--permission-mode", "bypassPermissions"],
  intent: "it's alright we're in deep",
  name: "Agent - Settings page a",
  nameSource: "user",
  sessionId: ID,
  resumeSessionId: ID,
  daemonShort: "5e5e5e03",
  cwd: "/work/studio",
  createdAt: "2026-10-09T06:52:07.829Z",
  updatedAt: "2026-10-22T00:57:48.431Z",
  backend: "daemon",
  ...over,
});

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "conch-parked-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function job(claudeDir: string, folder: string, state: unknown): string {
  const dir = join(claudeDir, "jobs", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "state.json");
  writeFileSync(path, typeof state === "string" ? state : JSON.stringify(state));
  return path;
}

function conversation(claudeDir: string, cwd: string, id: string, lines: unknown[] = [{ type: "user", message: { role: "user", content: "go" } }]): string {
  const dir = join(claudeDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

describe("which job records are waiting on you", () => {
  test("a blocked agent is, with its question as one line and its record's time", () => {
    expect(parkedJobFromState("5e5e5e03", blocked())).toEqual({
      jobId: "5e5e5e03",
      sessionId: ID,
      since: Date.parse("2026-10-22T00:57:48.431Z"),
      name: "Agent - Settings page a",
      cwd: "/work/studio",
      needs: "confirm: start onboarding walkthrough or next step?",
    });
    // No `needs`: what it last said it was doing. A long one is cut to a row's line.
    expect(parkedJobFromState("5e5e5e03", blocked({ needs: undefined }))?.needs)
      .toBe("critic loop live in production; awaiting go-ahead for onboarding");
    const long = parkedJobFromState("5e5e5e03", blocked({ needs: `1. "Go on the critic";\n2. ${"who pays ".repeat(60)}` }))!.needs!;
    expect(long.length).toBe(280);
    expect(long).toStartWith('1. "Go on the critic"; 2. who pays');
    expect(long).toEndWith("…");
  });

  test("anything else is not: working, done, stopped, a spare, a job that can't be woken, another backend", () => {
    for (const state of ["working", "done", "stopped", "failed"]) expect(parkedJobFromState("5e5e5e03", blocked({ state }))).toBeNull();
    // Claude Code's own exceptions (2.1.309): never prompted, and an `exec` job with nothing to respawn it with.
    expect(parkedJobFromState("5e5e5e03", blocked({ intent: "", needs: "send a prompt to start" }))).toBeNull();
    expect(parkedJobFromState("5e5e5e03", blocked({ template: "exec", respawnFlags: [] }))).toBeNull();
    expect(parkedJobFromState("5e5e5e03", blocked({ template: "exec", respawnFlags: ["--model", "opus"] }))).not.toBeNull();
    expect(parkedJobFromState("5e5e5e03", blocked({ backend: "cloud" }))).toBeNull();
    // Nothing to attach or key a row by.
    expect(parkedJobFromState("5e5e5e03", blocked({ sessionId: undefined }))).toBeNull();
    expect(parkedJobFromState("../x", blocked({ daemonShort: undefined }))).toBeNull();
    expect(parkedJobFromState("5e5e5e03", blocked({ daemonShort: "-rf" }))).toBeNull();
    expect(parkedJobFromState("5e5e5e03", "blocked")).toBeNull();
  });

  test("a record with no readable time takes its file's", () => {
    expect(parkedJobFromState("5e5e5e03", blocked({ updatedAt: "soon" }), 1_234)?.since).toBe(1_234);
    expect(parkedJobFromState("5e5e5e03", blocked({ updatedAt: undefined }))).toBeNull();
  });
});

describe("reading the jobs folder", () => {
  test("only what changed is read again, and a record caught mid-write keeps its last reading", () => {
    const dir = join(root, "claude");
    const path = job(dir, "5e5e5e03", blocked());
    job(dir, "5e5e5e02", blocked({ state: "done", sessionId: "5e5e5e02-0002-4000-8000-000000000002", daemonShort: "5e5e5e02" }));
    mkdirSync(join(dir, "jobs", "6ecd6a14")); // a folder with no record yet
    writeFileSync(join(dir, "jobs", "pins.json"), "[]");
    const reader = new ParkedJobReader();
    expect(reader.read(dir).map((one) => one.jobId)).toEqual(["5e5e5e03"]);

    // Same mtime and size: not parsed again, so garbage written in place without either moving is never seen.
    const stamp = new Date("2026-10-22T01:00:00Z");
    utimesSync(path, stamp, stamp);
    expect(reader.read(dir)).toHaveLength(1);
    const same = JSON.stringify(blocked()).replace("blocked", "BLOCKED");
    writeFileSync(path, same);
    utimesSync(path, stamp, stamp);
    expect(reader.read(dir)).toHaveLength(1);

    // A torn write (its size moved): the last good reading stands until a whole one lands.
    writeFileSync(path, '{"state":"blo');
    expect(reader.read(dir).map((one) => one.jobId)).toEqual(["5e5e5e03"]);
    writeFileSync(path, JSON.stringify(blocked({ state: "working" })));
    expect(reader.read(dir)).toEqual([]);
  });

  test("no jobs folder is no jobs", () => {
    expect(new ParkedJobReader().read(join(root, "nowhere"))).toEqual([]);
  });
});

describe("parked rows beside the live ones", () => {
  const account = (configDir: string, id = "default", label = "Default"): ParkedAccount => ({ id, label, configDir });
  const nothingLive = { infos: [] as SessionInfo[], liveIds: new Set<string>() };
  const options = { now: NOW, reader: new ParkedJobReader() };

  test("a parked job is a row: pid 0, its job, its account, its question, named as its live row will be", () => {
    const dir = join(root, "claude");
    job(dir, "5e5e5e03", blocked());
    const path = conversation(dir, "/work/studio", ID, [
      { type: "user", message: { role: "user", content: "go" } },
      { type: "custom-title", customTitle: "Agent - Settings page ⑂" },
    ]);
    const [row, ...rest] = parkedSessions([account(dir)], nothingLive, options);
    expect(rest).toEqual([]);
    expect(row).toEqual({
      sessionId: ID,
      name: "Agent - Settings page ⑂",
      cwd: "/work/studio",
      pid: 0,
      jobId: "5e5e5e03",
      kind: "bg",
      entrypoint: "cli",
      status: "idle",
      statusUpdatedAt: Date.parse("2026-10-22T00:57:48.431Z"),
      claudeAccountId: "default",
      claudeConfigDir: dir,
      accountLabel: "Default",
      transcriptPath: path,
      parked: { since: Date.parse("2026-10-22T00:57:48.431Z"), needs: "confirm: start onboarding walkthrough or next step?" },
    });
    expect(row!.noTerminal).toBeUndefined();
  });

  test("never beside a live row of its conversation or its job", () => {
    const dir = join(root, "claude");
    job(dir, "5e5e5e03", blocked());
    conversation(dir, "/work/studio", ID);
    const live = { sessionId: ID, pid: 42934, jobId: "5e5e5e03", claudeAccountId: "default" } as SessionInfo;
    expect(parkedSessions([account(dir)], { infos: [live], liveIds: new Set([ID]) }, options)).toEqual([]);
    // Two windows on one id are keyed by window; the conversation is still the live one.
    const window = { sessionId: `${ID}@42934`, agentSessionId: ID, pid: 42934 } as SessionInfo;
    expect(parkedSessions([account(dir)], { infos: [window], liveIds: new Set() }, options)).toEqual([]);
    // A torn registry file's id is salvaged into the live ids.
    expect(parkedSessions([account(dir)], { infos: [], liveIds: new Set([ID]) }, options)).toEqual([]);
    // Its job, coming back, under an id the record doesn't know yet.
    const job2 = { sessionId: "other", pid: 1, jobId: "5e5e5e03", claudeAccountId: "default" } as SessionInfo;
    expect(parkedSessions([account(dir)], { infos: [job2], liveIds: new Set() }, options)).toEqual([]);
  });

  test("a job is a row for two weeks after its record last changed", () => {
    const dir = join(root, "claude");
    job(dir, "5e5e5e03", blocked());
    conversation(dir, "/work/studio", ID);
    const since = Date.parse("2026-10-22T00:57:48.431Z");
    expect(parkedSessions([account(dir)], nothingLive, { ...options, now: since + PARKED_WINDOW_MS })).toHaveLength(1);
    expect(parkedSessions([account(dir)], nothingLive, { ...options, now: since + PARKED_WINDOW_MS + 1 })).toEqual([]);
  });

  test("a job whose transcript holds no conversation is a spare, as a live one is; one with no transcript found still shows", () => {
    const dir = join(root, "claude");
    job(dir, "5e5e5e03", blocked());
    conversation(dir, "/work/studio", ID, [{ type: "ai-title", aiTitle: "About page wireframe" }]);
    expect(parkedSessions([account(dir)], nothingLive, options)).toEqual([]);
    const elsewhere = join(root, "other");
    job(elsewhere, "5e5e5e03", blocked());
    expect(parkedSessions([account(elsewhere)], nothingLive, options).map((row) => row.sessionId)).toEqual([ID]);
  });

  test("each account's jobs are its own, and one conversation is one row", () => {
    const home = join(root, "claude");
    const work = join(root, "work");
    job(home, "5e5e5e03", blocked());
    job(work, "5e5e5e01", blocked({ sessionId: "5e5e5e01-0001-4000-8000-000000000001", daemonShort: "5e5e5e01", name: "Copy edits" }));
    job(work, "5e5e5e03", blocked()); // a copied history: the same conversation in a second profile
    const rows = parkedSessions([account(home), account(work, "a7a7a7a7", "Studio")], nothingLive, options);
    expect(rows.map((row) => [row.sessionId, row.claudeAccountId, row.accountLabel])).toEqual([
      [ID, "default", "Default"],
      ["5e5e5e01-0001-4000-8000-000000000001", "a7a7a7a7", "Studio"],
    ]);
  });
});

describe("the account snapshot conch's rows come from", () => {
  let oldConfig: string | undefined;
  let oldClaude: string | undefined;
  let claudeDir: string;
  beforeEach(() => {
    oldConfig = process.env.CONCH_CONFIG_DIR;
    oldClaude = process.env.CLAUDE_CONFIG_DIR;
    process.env.CONCH_CONFIG_DIR = join(root, "conch");
    claudeDir = process.env.CLAUDE_CONFIG_DIR = join(root, "default");
    mkdirSync(join(claudeDir, "sessions"), { recursive: true });
  });
  afterEach(() => {
    if (oldConfig === undefined) delete process.env.CONCH_CONFIG_DIR; else process.env.CONCH_CONFIG_DIR = oldConfig;
    if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
  });

  // A job id no real `claude attach` on this Mac names: the live row's window is looked for with a real `ps`.
  const SHORT = "a0b1c2d3";
  const SESSION = "a0b1c2d3-0000-4000-8000-000000000001";

  test("a parked job is a row and a live id; attached, the same id is one live row, never two", async () => {
    job(claudeDir, SHORT, blocked({ sessionId: SESSION, daemonShort: SHORT, updatedAt: new Date(Date.now() - 60_000).toISOString() }));
    conversation(claudeDir, "/work/studio", SESSION);
    const parkedOptions = { reader: new ParkedJobReader() };

    const parked = (await accountRegistrySnapshot(claudeDir, undefined, [], parkedOptions))!;
    const row = parked.infos.find((info) => info.sessionId === SESSION);
    expect(row).toMatchObject({ pid: 0, jobId: SHORT, claudeAccountId: "default", accountLabel: "Default", parked: { needs: "confirm: start onboarding walkthrough or next step?" } });
    expect(parked.liveIds.has(SESSION)).toBe(true);

    // `claude attach` brought it back: Claude Code's own registry entry for the job, under the same conversation.
    writeFileSync(join(claudeDir, "sessions", "42979.json"), JSON.stringify({
      pid: process.pid, sessionId: SESSION, cwd: "/work/studio", kind: "bg", entrypoint: "cli", jobId: SHORT,
      status: "idle", statusUpdatedAt: Date.now(), name: "Agent - Settings page a",
    }));
    const live = (await accountRegistrySnapshot(claudeDir, undefined, [], parkedOptions))!;
    const rows = live.infos.filter((info) => info.sessionId === SESSION);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.parked).toBeUndefined();
    expect(rows[0]!.jobId).toBe(SHORT);
  });
});

describe("bringing a parked job back for a reply", () => {
  const parkedRow: SessionInfo = {
    sessionId: ID, pid: 0, jobId: "5e5e5e03", kind: "bg", status: "idle", cwd: "/work/studio",
    claudeAccountId: "default", claudeConfigDir: "/claude", parked: { since: 1, needs: "confirm?" },
  };
  const liveRow: SessionInfo = { sessionId: ID, pid: 42934, agentPid: 42979, jobId: "5e5e5e03", kind: "bg", status: "idle", cwd: "/work/studio/.worktrees/design-agent" };
  const reply: TurnEvent = { type: "inject", sessionId: ID, label: "Agent", announce: "go on the critic", pid: 0, cwd: "/work/studio" };
  const BOX = ["  done.", "─".repeat(40), "❯ ", "─".repeat(40), "  ⏵⏵ bypass permissions on"].join("\n");

  /** A tmux server and a registry that brings the job back after `upAfter` reads, its screen ready after `boxAfter`. */
  function world(over: { upAfter?: number; boxAfter?: number; windows?: string[]; attachExits?: boolean; running?: boolean } = {}) {
    const calls: string[][] = [];
    const logs: string[] = [];
    let row: SessionInfo = parkedRow;
    let reads = 0;
    let captures = 0;
    let clock = 0;
    const windows = new Set(over.windows ?? []);
    const attacher = new ParkedJobAttacher({
      row: () => row,
      refresh: async () => {
        reads++;
        if (reads >= (over.upAfter ?? 2)) row = liveRow;
      },
      label: () => "Agent - Settings page ⑂",
      log: (line) => void logs.push(line),
      tmux: () => ["tmux", "-L", "conch-test"],
      tmuxFound: () => true,
      jobLive: () => over.running === true,
      attachCommand: (jobId, cwd, accountId) => `cd -- ${cwd ?? "~"} && env -u CLAUDE_CONFIG_DIR claude attach ${jobId} # ${accountId}`,
      probe: async (argv) => {
        calls.push(argv.slice(3));
        const verb = argv[3];
        if (verb === "list-sessions") return [...windows].join("\n");
        if (verb === "new-session") { if (!over.attachExits) windows.add(argv[argv.indexOf("-s") + 1]!); return ""; }
        if (verb === "capture-pane") return ++captures >= (over.boxAfter ?? 1) ? BOX : "  Resuming…";
        return "";
      },
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      waitMs: 10_000,
      intervalMs: 500,
    });
    return { attacher, calls, logs, reads: () => reads };
  }

  test("attaches it in a hidden window on conch's server, waits for its row and its input box, then routes the reply there", async () => {
    const w = world({ upAfter: 3, boxAfter: 2 });
    const routed = await w.attacher.forDelivery(reply);
    expect(routed).toEqual({ ...reply, pid: 42934, cwd: "/work/studio/.worktrees/design-agent" });
    const opened = w.calls.find((call) => call[0] === "new-session")!;
    expect(opened.slice(0, 7)).toEqual(["new-session", "-d", "-s", "conch-attach-5e5e5e03", "-x", "200", "-y"]);
    // The folder is passed only when it exists on this Mac (here it doesn't), and the shell drops tmux's own variables.
    expect(opened).not.toContain("-c");
    expect(opened.slice(-3)).toEqual(["/bin/zsh", "-lc", "unset TMUX TMUX_PANE; cd -- ~ && env -u CLAUDE_CONFIG_DIR claude attach 5e5e5e03 # default"]);
    expect(w.calls).toContainEqual(["set-option", "-g", "exit-empty", "off"]);
    expect(w.calls.filter((call) => call[0] === "capture-pane")).toEqual([
      ["capture-pane", "-p", "-t", "=conch-attach-5e5e5e03:"],
      ["capture-pane", "-p", "-t", "=conch-attach-5e5e5e03:"],
    ]);
    expect(w.logs).toEqual([
      'brought back parked "Agent - Settings page ⑂" for a reply (claude attach 5e5e5e03, hidden in tmux conch-attach-5e5e5e03): live in 1.5s',
    ]);
  });

  test("a row that isn't parked is left as it was, and nothing is started", async () => {
    const w = world();
    const attacher = new ParkedJobAttacher({ row: () => liveRow, refresh: async () => {}, label: () => "x", log: () => {}, probe: async (argv) => { w.calls.push(argv); return ""; } });
    expect(await attacher.forDelivery({ ...reply, pid: 42934 })).toEqual({ ...reply, pid: 42934 });
    expect(w.calls).toEqual([]);
  });

  test("two replies while it comes back share one attach", async () => {
    const w = world({ upAfter: 4 });
    const [a, b] = await Promise.all([w.attacher.forDelivery(reply), w.attacher.forDelivery({ ...reply, announce: "and ship 485" })]);
    expect([a.pid, b.pid]).toEqual([42934, 42934]);
    expect(w.calls.filter((call) => call[0] === "new-session")).toHaveLength(1);
  });

  test("a window left on the job after it stopped is started again, not trusted", async () => {
    const w = world({ windows: ["conch-attach-5e5e5e03"] });
    await w.attacher.forDelivery(reply);
    expect(w.calls.find((call) => call[0] === "new-session")).toBeUndefined();
    expect(w.calls.find((call) => call[0] === "respawn-pane")?.slice(0, 4)).toEqual(["respawn-pane", "-k", "-t", "=conch-attach-5e5e5e03:"]);
    expect(w.logs[0]).toContain("restarted the attach in tmux conch-attach-5e5e5e03");
  });

  test("one Claude Code is already bringing back (a Terminal window from the app) is only waited for", async () => {
    const w = world({ running: true });
    expect((await w.attacher.forDelivery(reply)).pid).toBe(42934);
    expect(w.calls).toEqual([]);
    expect(w.logs[0]).toContain("already coming back");
  });

  test("an attach that ends before the job comes back says so, and nothing is typed", async () => {
    const w = world({ upAfter: 99, attachExits: true });
    await expect(w.attacher.forDelivery(reply)).rejects.toThrow(
      "couldn't bring the parked session back: claude attach 5e5e5e03 exited before the session came back. Open it in Terminal and send again",
    );
    expect(w.logs).toEqual([
      'could not bring back parked "Agent - Settings page ⑂" for a reply (claude attach 5e5e5e03): claude attach 5e5e5e03 exited before the session came back',
    ]);
  });

  test("one that never comes back gives up when the wait runs out", async () => {
    const w = world({ upAfter: 99 });
    await expect(w.attacher.forDelivery(reply)).rejects.toThrow("it didn't come back within 10 seconds");
    expect(w.reads()).toBe(21);
  });

  test("a live row whose screen never shows the box still takes the words once it has been live a while", async () => {
    const w = world({ upAfter: 1, boxAfter: 99 });
    const attacher = w.attacher;
    expect((await attacher.forDelivery(reply)).pid).toBe(42934);
    expect(w.logs[0]).toContain("live in 10.0s");
  });
});
