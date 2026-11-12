import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processKey, ResourceLedger, type LedgerSession, type ProcessRow } from "../src/resource-ledger.ts";
import {
  handleResourceRequest,
  LISTENERS_REFRESH_MS,
  loadResourceMemory,
  resolveTarget,
  ResourceSampler,
  saveResourceMemory,
  simulatorName,
  stopResource,
  type ResourceRequestDependencies,
} from "../src/resource-sampler.ts";
import { parseResourcesArgs, renderResources } from "../src/resources-cli.ts";

// Fixtures are made up: ids, pids, ports and folders are nobody's.
const T0 = Date.parse("2026-11-01T09:00:00Z");
const MIN = 60_000;
const SNAPSHOT = "/bin/zsh -c source /Users/dev/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'npm run dev'";

function row(pid: number, ppid: number, args: string, extra: Partial<ProcessRow> = {}): ProcessRow {
  return { pid, ppid, uid: 501, startedAt: T0, cpu: 1, rss: 1024 ** 2, args, ...extra };
}

/** A Mac with one live session running a dev server, and a probe that records what it was asked. */
function mac() {
  const table: ProcessRow[] = [
    row(100, 1, "claude"),
    row(101, 100, SNAPSHOT),
    row(102, 101, "node node_modules/.bin/vite"),
    row(200, 1, "node orphan-server.js"),
  ];
  const calls: string[][] = [];
  const probe = async (argv: string[]) => {
    calls.push(argv);
    if (argv[0] === "lsof" && argv.includes("-sTCP:LISTEN")) return "p102\nn*:5100\np200\nn*:5200\n";
    if (argv[0] === "ps" && argv[1] === "-Eww") return "  200 node orphan-server.js CLAUDE_CODE_SESSION_ID=aaaaaaaa-0000-4000-8000-00000000000a TOKEN=x\n";
    if (argv[0] === "lsof" && argv.includes("cwd")) return "p102\nn/tmp/site\n";
    return "";
  };
  const sessions: LedgerSession[] = [{ sessionId: "s-live", agentSessionId: "s-live", pids: [100], label: "site", status: "idle" }];
  let now = T0;
  let tableReads = 0;
  const saved: string[] = [];
  const changes: number[] = [];
  const ledger = new ResourceLedger();
  const sampler = new ResourceSampler({
    ledger,
    sessions: () => ({ sessions, complete: true }),
    table: async () => { tableReads += 1; return table; },
    probe,
    uid: 501,
    now: () => now,
    saveMemory: (memory) => saved.push(JSON.stringify(memory)),
    onChange: () => changes.push(now),
    memoryOf: () => undefined,
    readSimulatorName: () => undefined,
  });
  return { table, calls, sessions, ledger, sampler, saved, changes, setNow: (at: number) => { now = at; }, reads: () => tableReads };
}

describe("the cost of looking", () => {
  test("at most one look per interval, however often it is asked", async () => {
    const m = mac();
    await Promise.all([m.sampler.sample(), m.sampler.sample(), m.sampler.sample()]);
    m.setNow(T0 + 10_000);
    await m.sampler.sample();
    expect(m.reads()).toBe(1);
    m.setNow(T0 + 30_000);
    await m.sampler.sample();
    expect(m.reads()).toBe(2);
    // Tyler's own stop forces one, once.
    await m.sampler.sample(true);
    expect(m.reads()).toBe(3);
  });

  test("ports again only when something new could be owned, or after a while; an environment once in a process's life", async () => {
    const m = mac();
    const listenerReads = () => m.calls.filter((argv) => argv.includes("-sTCP:LISTEN")).length;
    const envReads = () => m.calls.filter((argv) => argv[1] === "-Eww").length;
    await m.sampler.sample();
    expect(listenerReads()).toBe(1);
    expect(envReads()).toBe(0); // an orphan is read once it has lived through a look
    m.setNow(T0 + 30_000);
    await m.sampler.sample();
    expect(listenerReads()).toBe(1); // nothing new
    expect(envReads()).toBe(1);
    expect(m.calls.find((argv) => argv[1] === "-Eww")).toEqual(["ps", "-Eww", "-o", "pid=,command=", "-p", "200"]);
    m.setNow(T0 + 60_000);
    await m.sampler.sample();
    expect(envReads()).toBe(1); // once in its life
    // A command that comes and goes between looks never costs a port read.
    m.table.push(row(104, 101, "git status"));
    m.setNow(T0 + 90_000);
    await m.sampler.sample();
    m.table.pop();
    m.setNow(T0 + 120_000);
    await m.sampler.sample();
    expect(listenerReads()).toBe(1);
    // One that lives through a look may have started listening.
    m.table.push(row(103, 101, "node node_modules/.bin/esbuild --service"));
    m.setNow(T0 + 150_000);
    await m.sampler.sample();
    expect(listenerReads()).toBe(1);
    m.setNow(T0 + 180_000);
    await m.sampler.sample();
    expect(listenerReads()).toBe(2);
    m.setNow(T0 + 180_000 + LISTENERS_REFRESH_MS);
    await m.sampler.sample();
    expect(listenerReads()).toBe(3); // a while
    // The folder of a new resource, once.
    expect(m.calls.filter((argv) => argv.includes("cwd"))).toHaveLength(1);
    expect(m.ledger.published().items.find((item) => item.id === "p102")?.cwd).toBe("/tmp/site");
  });

  test("the memory file is written when it changes, not every look", async () => {
    const m = mac();
    await m.sampler.sample();
    const afterFirst = m.saved.length;
    expect(afterFirst).toBeGreaterThan(0);
    for (let at = 1; at <= 4; at += 1) {
      m.setNow(T0 + at * 30_000);
      await m.sampler.sample();
    }
    const steady = m.saved.length;
    m.setNow(T0 + 10 * 30_000);
    await m.sampler.sample();
    expect(m.saved.length).toBe(steady);
    // And the environment's other keys never reach it.
    expect(m.saved.join("")).not.toContain("TOKEN");
  });

  test("the memory file round-trips, and a missing or broken one is a fresh start", () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-resources-"));
    const path = join(dir, "resources.json");
    expect(loadResourceMemory(path).owners).toEqual({});
    const ledger = new ResourceLedger();
    ledger.memory.labels.x = "a label";
    saveResourceMemory(ledger.memory, path);
    expect(existsSync(path)).toBe(true);
    expect(loadResourceMemory(path).labels).toEqual({ x: "a label" });
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });

  test("a simulator's name is read from its device.plist", () => {
    const plist = "<?xml version=\"1.0\"?><plist><dict><key>UDID</key><string>X</string><key>name</key><string>Test &amp; Phone</string></dict></plist>";
    expect(simulatorName("X", () => plist)).toBe("Test & Phone");
    expect(simulatorName("X", () => { throw new Error("gone"); })).toBeUndefined();
  });
});

describe("stopping, only when asked", () => {
  const entry = (extra: object = {}) => ({
    id: "p300", identity: "300@1", kind: "server" as const, title: "vite :5100",
    anchor: { pid: 302, startedAt: T0 }, root: { pid: 300, startedAt: T0 }, startedAt: T0, firstSeenAt: T0,
    members: [], extras: [], cpu: 0, rss: 0, ports: [5100], command: "vite", users: [], seen: 2, ...extra,
  });

  test("SIGTERM to the group as it runs now, SIGKILL after the wait to what is still the same process", async () => {
    const table = [row(300, 1, "npm run dev"), row(301, 300, "sh -c vite"), row(302, 301, "node vite"), row(303, 302, "esbuild")];
    const signals: string[] = [];
    const alive = new Set([300, 301, 302, 303]);
    let reads = 0;
    const result = await stopResource(entry(), {
      table: async () => {
        reads += 1;
        // By the second read, 303's pid is a different process: same pid, another start. It is never SIGKILLed.
        return reads === 1 ? table : table.map((each) => (each.pid === 303 ? { ...each, startedAt: T0 + 99_000 } : each));
      },
      alive: (pid) => alive.has(pid),
      signal: (pid, name) => {
        signals.push(`${name} ${pid}`);
        if (name === "SIGTERM" && pid !== 302 && pid !== 303) alive.delete(pid);
        if (name === "SIGKILL") alive.delete(pid);
      },
      graceMs: 500,
      sleep: async () => {},
    });
    expect(result).toEqual({ ok: true });
    expect(signals).toEqual(["SIGTERM 300", "SIGTERM 301", "SIGTERM 302", "SIGTERM 303", "SIGKILL 302"]);
  });

  test("nothing is signalled when the process conch recorded is gone", async () => {
    const signals: number[] = [];
    const result = await stopResource(entry(), {
      table: async () => [row(300, 1, "something else", { startedAt: T0 + 60 * MIN })],
      signal: (pid) => signals.push(pid),
    });
    expect(result.ok).toBe(false);
    expect(signals).toEqual([]);
  });

  test("a VM by colima or limactl, a simulator by simctl", async () => {
    const asked: string[][] = [];
    const probe = async (argv: string[]) => { asked.push(argv); return ""; };
    const none = async () => null;
    await stopResource(entry({ kind: "vm", vm: { tool: "colima", name: "ci" } }), { table: none, probe });
    await stopResource(entry({ kind: "vm", vm: { tool: "colima", name: "default" } }), { table: none, probe });
    await stopResource(entry({ kind: "vm", vm: { tool: "lima", name: "dev" } }), { table: none, probe });
    await stopResource(entry({ kind: "simulator", udid: "11111111-2222-4333-8444-555555555555" }), { table: none, probe });
    expect(asked).toEqual([
      ["colima", "stop", "--profile", "ci"],
      ["colima", "stop"],
      ["limactl", "stop", "dev"],
      ["xcrun", "simctl", "shutdown", "11111111-2222-4333-8444-555555555555"],
    ]);
  });
});

describe("requests", () => {
  async function setup() {
    const m = mac();
    await m.sampler.sample();
    m.setNow(T0 + 30_000);
    await m.sampler.sample();
    const stops: string[] = [];
    const lines: string[] = [];
    let caller: Awaited<ReturnType<ResourceRequestDependencies["caller"]>> = { person: true };
    const deps: ResourceRequestDependencies = {
      ledger: m.ledger,
      sampler: m.sampler,
      caller: async () => caller,
      stop: async (entry) => { stops.push(entry.id); return { ok: true }; },
      control: async (entry, action) => { stops.push(`${action} ${entry.id}`); return { ok: true }; },
      controlSession: async (session, action) => { stops.push(`${action} session ${session.sessionId}`); return { ok: true }; },
      onChange: () => {},
      log: (line) => lines.push(line),
      now: () => T0 + 31_000,
    };
    return { m, deps, stops, lines, as: (next: typeof caller) => { caller = next; } };
  }

  test("an agent may decide for its own session's, not another's; a person for any", async () => {
    const { deps, stops, as } = await setup();
    const other: LedgerSession = { sessionId: "s-other", pids: [900], label: "other" };
    as({ session: other });
    const refused = await handleResourceRequest({ kind: "resource-decide", id: "p102", action: "stop", callerPid: 5 }, deps);
    expect(refused).toMatchObject({ kind: "resource-error" });
    expect((refused as { error: string }).error).toContain("site's");
    expect(stops).toEqual([]);
    as({ session: { sessionId: "s-live", agentSessionId: "s-live", pids: [100], label: "site" } });
    expect(await handleResourceRequest({ kind: "resource-decide", id: "p102", action: "keep", callerPid: 5 }, deps)).toMatchObject({ kind: "resource-done", state: "kept" });
    as({ person: true });
    expect(await handleResourceRequest({ kind: "resource-decide", id: "p102", action: "stop" }, deps)).toMatchObject({ kind: "resource-done", action: "stop" });
    expect(stops).toEqual(["p102"]);
  });

  test("a stop that fails says why, and the row says so too", async () => {
    const { deps, m } = await setup();
    deps.stop = async () => ({ ok: false, error: "it is no longer running as the process conch recorded" });
    const reply = await handleResourceRequest({ kind: "resource-decide", id: "p102", action: "stop" }, deps);
    expect(reply).toMatchObject({ kind: "resource-error" });
    expect(m.ledger.published(T0 + 31_000).items.find((item) => item.id === "p102")?.reason).toContain("couldn't stop it");
  });

  test("a declaration comes from a session's shell, names a running thing, and a lifetime that parses", async () => {
    const { deps, m, as } = await setup();
    as({ reason: "pid 5 is a Codex app-server" });
    expect(await handleResourceRequest({ kind: "resource-add", target: { pid: 102 }, until: "2h", callerPid: 5 }, deps)).toMatchObject({ kind: "resource-error" });
    as({ session: { sessionId: "s-live", agentSessionId: "s-live", pids: [100], label: "site" } });
    expect(await handleResourceRequest({ kind: "resource-add", target: { pid: 102 }, until: "whenever", callerPid: 5 }, deps)).toMatchObject({ kind: "resource-error" });
    const done = await handleResourceRequest({ kind: "resource-add", target: { pid: 102 }, until: "2h", why: "preview for the review", callerPid: 5 }, deps);
    expect(done).toMatchObject({ kind: "resource-done", action: "add" });
    expect(m.ledger.published(T0 + 31_000).items.find((item) => item.id === "p102")).toMatchObject({ why: "preview for the review", lifetime: { kind: "until" }, owner: { how: "declared" } });
  });

  test("hold, resume, lower and restore are the user's, or a session's for its own; a whole session's priority only the user's", async () => {
    const { deps, stops, m, as } = await setup();
    as({ session: { sessionId: "s-other", pids: [900], label: "other" } });
    expect(await handleResourceRequest({ kind: "resource-decide", id: "p102", action: "hold", callerPid: 5 }, deps)).toMatchObject({ kind: "resource-error" });
    as({ person: true });
    expect(await handleResourceRequest({ kind: "resource-decide", id: "p102", action: "hold" }, deps)).toMatchObject({ kind: "resource-done", action: "hold" });
    expect(m.ledger.published(T0 + 31_000).items.find((item) => item.id === "p102")?.held).toBe(true);
    expect(await handleResourceRequest({ kind: "resource-decide", id: "p102", action: "resume" }, deps)).toMatchObject({ kind: "resource-done" });
    expect(m.ledger.published(T0 + 31_000).items.find((item) => item.id === "p102")?.held).toBeUndefined();
    expect(await handleResourceRequest({ kind: "resource-decide", id: "p102", action: "lower" }, deps)).toMatchObject({ kind: "resource-done" });
    expect(m.ledger.published(T0 + 31_000).items.find((item) => item.id === "p102")?.lowered).toBe("you");
    // A whole session: refused to an agent, done for the user, and said on its usage.
    as({ session: { sessionId: "s-live", agentSessionId: "s-live", pids: [100], label: "site" } });
    expect(await handleResourceRequest({ kind: "resource-session", sessionId: "s-live", action: "lower", callerPid: 5 }, deps)).toMatchObject({ kind: "resource-error" });
    as({ person: true });
    expect(await handleResourceRequest({ kind: "resource-session", sessionId: "s-live", action: "lower" }, deps)).toMatchObject({ kind: "resource-done" });
    expect(m.ledger.published(T0 + 31_000).sessions.find((session) => session.key === "s-live")?.lowered).toBe(true);
    expect(await handleResourceRequest({ kind: "resource-session", sessionId: "nobody", action: "lower" }, deps)).toMatchObject({ kind: "resource-error" });
    expect(stops).toEqual(["hold p102", "resume p102", "lower p102", "lower session s-live"]);
  });

  test("targets: a port's listener, a booted simulator by name, a colima profile", async () => {
    const table = [
      row(500, 1, "/opt/homebrew/bin/limactl hostagent --pidfile /Users/dev/.colima/_lima/colima-ci/ha.pid colima-ci"),
      row(600, 1, "launchd_sim /Users/dev/Library/Developer/CoreSimulator/Devices/11111111-2222-4333-8444-555555555555/data/x.plist"),
      row(700, 1, "node serve.js"),
    ];
    expect(await resolveTarget({ port: 5300 }, table, async () => 700)).toEqual({ identity: processKey(700, T0), title: "pid 700 (node)" });
    expect(await resolveTarget({ port: 5301 }, table, async () => undefined)).toHaveProperty("error");
    expect(await resolveTarget({ vm: "ci" }, table)).toEqual({ identity: `vm:colima-ci@${Math.floor(T0 / 1000)}`, title: "colima ci" });
    expect(await resolveTarget({ vm: "nope" }, table)).toHaveProperty("error");
    expect((await resolveTarget({ simulator: "booted" }, table) as { identity: string }).identity).toBe(`sim:11111111-2222-4333-8444-555555555555@${Math.floor(T0 / 1000)}`);
    expect(await resolveTarget({ pid: 4321 }, table, undefined, () => undefined)).toHaveProperty("error");
  });
});

describe("conch resources", () => {
  test("arguments", () => {
    expect(parseResourcesArgs([], 42)).toEqual({ request: { kind: "resources" }, json: false, long: false });
    expect(parseResourcesArgs(["--json"], 42)).toMatchObject({ json: true });
    expect(parseResourcesArgs(["stop", "p102"], 42)).toMatchObject({ request: { kind: "resource-decide", id: "p102", action: "stop", callerPid: 42 } });
    expect(parseResourcesArgs(["stop"], 42)).toHaveProperty("error");
    expect(parseResourcesArgs(["add", "--port", "5100", "--until", "session-end", "--why", "the preview"], 42))
      .toMatchObject({ request: { kind: "resource-add", target: { port: 5100 }, until: "session-end", why: "the preview", callerPid: 42 } });
    expect(parseResourcesArgs(["add", "--sim", "booted", "--until", "turn"], 42)).toMatchObject({ request: { target: { simulator: "booted" } } });
    expect(parseResourcesArgs(["add", "--pid", "1", "--port", "2", "--until", "2h"], 42)).toHaveProperty("error");
    expect(parseResourcesArgs(["add", "--pid", "5", "--until"], 42)).toHaveProperty("error");
    expect(parseResourcesArgs(["frobnicate"], 42)).toHaveProperty("error");
    expect(parseResourcesArgs(["hold", "p102"], 42)).toMatchObject({ request: { kind: "resource-decide", action: "hold" } });
    expect(parseResourcesArgs(["lower", "--session", "abc-123"], 42)).toMatchObject({ request: { kind: "resource-session", sessionId: "abc-123", action: "lower", callerPid: 42 } });
    expect(parseResourcesArgs(["hold", "--session", "abc-123"], 42)).toHaveProperty("error");
  });

  test("the budget, each session's load, then the list grouped as the Mac app groups it", () => {
    const budget = { cpuSetting: "25%", memorySetting: "8 GB", cpuText: "25% of 8 cores (2)", memoryText: "8 GB (25% of 32 GB)", memoryTotal: 32 * 1024 ** 3, autoBackground: false, cores: 8, cpuLimit: 200, memoryLimit: 8 * 1024 ** 3, cpu: 410, sustained: true, memory: 15 * 1024 ** 3, level: "red" as const, over: ["s1"], reason: "agents are using 4.1 cores of 2.0 cores and 15.0 GB of 8.0 GB" };
    const lines = renderResources({
      v: 1, sampledAt: T0, asking: 1, budget,
      sessions: [
        { key: "s1", sessionId: "s1", label: "infra", live: true, cpu: 400, sustained: true, memory: 13 * 1024 ** 3, resources: 1, level: "red", reasons: ["over the agents' budget"], over: true },
        { key: "old", label: "old prototype", live: false, cpu: 0, sustained: true, memory: 200 * 1024 ** 2, resources: 1, level: "red", reasons: ["vite :5100: past its time for over a day"] },
        { key: "unowned", label: "Unowned", live: false, cpu: 1, sustained: false, memory: 3 * 1024 ** 3, resources: 1, level: "yellow", reasons: ["3.0 GB of memory"] },
      ],
      items: [
        { id: "p1", kind: "server", title: "vite :5100", command: "node vite", startedAt: T0 - 2 * 24 * 60 * MIN, cpu: 0.4, memory: 200 * 1024 ** 2, state: "asking", reason: "its session ended", level: "red", owner: { key: "old", label: "old prototype", live: false, how: "environment", endedAt: T0 - 24 * 60 * MIN } },
        { id: "vm-ci", kind: "vm", title: "colima ci", command: "limactl hostagent", startedAt: T0 - 45 * MIN, cpu: 133, cpuSustained: 140, memory: 12 * 1024 ** 3, state: "running", level: "red", owner: { key: "s1", label: "infra", live: true, how: "environment", sessionId: "s1" } },
        { id: "sim-1111", kind: "simulator", title: "Test Phone simulator", command: "launchd_sim", startedAt: T0 - 3 * 60 * MIN, cpu: 1, memory: 3 * 1024 ** 3, state: "unowned", reason: "no session started it", level: "yellow", lowered: "auto" },
      ],
    }, T0);
    const text = lines.join("\n");
    expect(lines[0]).toBe("[red] Budget (25% of 8 cores (2); 8 GB (25% of 32 GB)): agents are using 4.1 cores of 2.0 cores and 15.0 GB of 8.0 GB · over: infra");
    expect(text).toContain("  [red] infra                  4.0 cores · 13.0 GB · 1 left running  over the agents' budget");
    expect(text).toContain("old prototype (ended)");
    expect(text).toContain("* not yet five minutes of looks");
    expect(text).toContain("Asking (1)");
    expect(text).toContain("[red] p1        vite :5100  ·  old prototype, ended 24 h ago  ·  up 2 d · 0% CPU · 200 MB · its session ended");
    expect(text).toContain("[red] vm-ci     colima ci  ·  infra  ·  up 45 min · 140% CPU · 12.0 GB");
    expect(text).toContain("Test Phone simulator  ·  unowned  ·  up 3 h · 1% CPU · 3.0 GB · lowered (budget)");
    expect(lines.at(-1)).toContain("nothing is stopped or held unless you ask");
    expect(renderResources({ v: 1, sampledAt: T0, asking: 0, items: [], sessions: [], budget: { ...budget, level: "green", over: [] } }, T0).at(-1)).toBe("Nothing a session started is running.");
    // On a terminal, a dot in the level's colour.
    expect(renderResources({ v: 1, sampledAt: T0, asking: 0, items: [], sessions: [], budget }, T0, false, true)[0]).toStartWith("\x1b[31m●\x1b[0m Budget");
  });

});
