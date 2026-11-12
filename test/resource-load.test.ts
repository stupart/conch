import { describe, expect, test } from "bun:test";
import {
  budgetOf,
  cpuBudgetText,
  cpuLimitOf,
  CpuHistory,
  loadLevel,
  memoryBudgetText,
  memoryLimitOf,
  parseCpuBudget,
  parseMemoryBudget,
  resourceLevel,
  RESOURCE_THRESHOLDS,
  SESSION_THRESHOLDS,
  type SessionUsage,
} from "../src/resource-load.ts";
import { getSettingDescriptor } from "../src/settings.ts";
import { processKey, ProcessForest, ResourceLedger, withStillRunning, type Evidence, type LedgerSession, type ProcessRow } from "../src/resource-ledger.ts";
import { controlResource, controlSession, ResourceSampler } from "../src/resource-sampler.ts";

// Fixtures are made up: ids, pids, ports and folders are nobody's.
const T0 = Date.parse("2026-11-01T09:00:00Z");
const MIN = 60_000;
const GB = 1024 ** 3;

describe("sustained, not one look", () => {
  test("CPU is the mean of the last five minutes, and says nothing until there are three looks", () => {
    const history = new CpuHistory();
    history.record("a", T0, 400);
    expect(history.sustained("a", T0)).toEqual({ cpu: 400, sustained: false });
    history.record("a", T0 + 30_000, 0);
    history.record("a", T0 + 60_000, 200);
    expect(history.sustained("a", T0 + 60_000)).toEqual({ cpu: 200, sustained: true });
    // Five minutes on, the first look has left the window.
    history.record("a", T0 + 5 * MIN + 1, 200);
    expect(history.sustained("a", T0 + 5 * MIN + 1)?.cpu).toBeCloseTo(400 / 3, 5);
    history.keep(new Set());
    expect(history.sustained("a", T0 + 5 * MIN + 1)).toBeUndefined();
  });

  test("a burst too short to be sustained stays green; memory counts at once", () => {
    expect(loadLevel({ cpu: { cpu: 900, sustained: false }, memory: 0 }, RESOURCE_THRESHOLDS).level).toBe("green");
    expect(loadLevel({ cpu: { cpu: 60, sustained: true }, memory: 0 }, RESOURCE_THRESHOLDS)).toEqual({ level: "yellow", reasons: ["60% of a core for 5 min"] });
    expect(loadLevel({ cpu: { cpu: 210, sustained: true }, memory: 9 * GB }, RESOURCE_THRESHOLDS)).toEqual({ level: "red", reasons: ["2.1 cores for 5 min", "9.0 GB of memory"] });
    expect(loadLevel({ memory: 5 * GB }, SESSION_THRESHOLDS)).toEqual({ level: "yellow", reasons: ["5.0 GB of memory"] });
  });

  test("past its time is yellow, a day past it red; unowned for a day is yellow", () => {
    expect(resourceLevel({ memory: 0, state: "asking", startedAt: T0, dueSince: T0 }, T0 + MIN)).toEqual({ level: "yellow", reasons: ["past its time"] });
    expect(resourceLevel({ memory: 0, state: "asking", startedAt: T0, dueSince: T0 }, T0 + 25 * 60 * MIN).level).toBe("red");
    expect(resourceLevel({ memory: 0, state: "unowned", startedAt: T0 }, T0 + 25 * 60 * MIN)).toEqual({ level: "yellow", reasons: ["no one's, for over a day"] });
    expect(resourceLevel({ memory: 0, state: "running", startedAt: T0 }, T0 + 25 * 60 * MIN).level).toBe("green");
  });
});

describe("the budget's settings: a share, or an amount", () => {
  // Tyler (2026-11-12): "should we make it 14 cores and 100GB just to be cleaner?" on an 18-core, 128 GB Mac.
  const mac = { cores: 18, memory: 128 * GB };

  test("CPU: a share, or a number of cores, kept in its own unit", () => {
    expect(parseCpuBudget("75%", mac)).toEqual({ ok: true, value: "75%" });
    expect(parseCpuBudget(" 75 % ", mac)).toEqual({ ok: true, value: "75%" });
    expect(parseCpuBudget("14", mac)).toEqual({ ok: true, value: "14 cores" });
    expect(parseCpuBudget("14 cores", mac)).toEqual({ ok: true, value: "14 cores" });
    expect(parseCpuBudget("13.5 Cores", mac)).toEqual({ ok: true, value: "13.5 cores" });
    expect(parseCpuBudget("1 core", mac)).toEqual({ ok: true, value: "1 core" });
    expect(parseCpuBudget(14, mac)).toEqual({ ok: true, value: "14 cores" });
    expect(parseCpuBudget("18", mac)).toEqual({ ok: true, value: "18 cores" });
  });

  test("CPU: zero, more than the Mac has, or nonsense is refused, and says why", () => {
    const refused = (raw: unknown) => {
      const parsed = parseCpuBudget(raw, mac);
      expect(parsed.ok, String(raw)).toBe(false);
      return parsed.ok ? "" : parsed.err;
    };
    expect(refused("20")).toContain("this Mac has 18 cores, not 20");
    expect(refused("0")).toContain("0 cores would leave agents nothing");
    expect(refused("0%")).toContain("more than 0% and at most 100%");
    expect(refused("120%")).toContain("at most 100%");
    expect(refused("lots")).toContain("a share of this Mac's 18 cores (like 75%) or a number of cores (like 14), at most 18");
    refused("-2");
    refused("14 GB");
  });

  test("memory: a share, or GB in any of its spellings (GiB), never a bare number", () => {
    expect(parseMemoryBudget("60%", mac)).toEqual({ ok: true, value: "60%" });
    for (const raw of ["100GB", "100 GB", "100G", "100 gib", "100 Gb"]) expect(parseMemoryBudget(raw, mac), raw).toEqual({ ok: true, value: "100 GB" });
    expect(parseMemoryBudget("128 GB", mac)).toEqual({ ok: true, value: "128 GB" });
    const err = (raw: unknown) => {
      const parsed = parseMemoryBudget(raw, mac);
      expect(parsed.ok, String(raw)).toBe(false);
      return parsed.ok ? "" : parsed.err;
    };
    expect(err("200 GB")).toContain("this Mac has 128 GB, not 200");
    expect(err("0 GB")).toContain("0 GB would leave agents nothing");
    expect(err("100")).toContain("an amount in GB (like 100 GB; GiB, as Activity Monitor counts), at most 128 GB");
    expect(err(100)).toContain("not \"100\"");
    err("101%");
  });

  test("shown in the unit it was set in, the other beside it", () => {
    expect(cpuBudgetText("14 cores", mac)).toBe("14 cores (78% of 18)");
    expect(cpuBudgetText("75%", mac)).toBe("75% of 18 cores (13.5)");
    expect(memoryBudgetText("100 GB", mac)).toBe("100 GB (78% of 128 GB)");
    expect(memoryBudgetText("60%", mac)).toBe("60% of 128 GB (76.8 GB)");
    expect(cpuLimitOf("14 cores", mac)).toBe(1400);
    expect(cpuLimitOf("75%", mac)).toBe(1350);
    expect(memoryLimitOf("100 GB", mac)).toBe(100 * GB);
    expect(memoryLimitOf("60%", mac)).toBeCloseTo(76.8 * GB, 0);
    // A kept value from another Mac, bigger than this one: never more than it has.
    expect(cpuLimitOf("32 cores", mac)).toBe(1800);
    expect(memoryLimitOf("512 GB", mac)).toBe(128 * GB);
  });

  test("the settings take both forms, and default to shares, 75% and 60%", () => {
    const cpu = getSettingDescriptor("agent-budget-cpu");
    const memory = getSettingDescriptor("agent-budget-memory");
    if (!cpu.ok || !memory.ok) throw new Error("the budget's settings are missing");
    expect(cpu.value.default).toBe("75%");
    expect(memory.value.default).toBe("60%");
    expect(cpu.value.parse("1 core")).toEqual({ ok: true, value: "1 core" });
    expect(memory.value.parse("1G")).toEqual({ ok: true, value: "1 GB" });
    expect(cpu.value.parse("0").ok).toBe(false);
    expect(cpu.value.help).toContain("a share of this Mac's cores, like 75%, or a number of cores, like 14");
    expect(memory.value.help).toContain("like 100 GB (GiB, as Activity Monitor counts)");
  });
});

describe("the budget", () => {
  const settings = { cpu: "25%", memory: "25%", autoBackground: false };
  const machine = { cores: 8, memory: 32 * GB };
  const session = (key: string, cpu: number, memory: number): SessionUsage =>
    ({ key, label: key, live: true, cpu, sustained: true, memory, resources: 0, level: "green", reasons: [] });

  test("a quarter of 8 cores is 2 cores; under three quarters of it is green, then yellow, then red", () => {
    expect(budgetOf(settings, machine, [], { cpu: 100, sustained: true, memory: GB })).toMatchObject({ cpuLimit: 200, memoryLimit: 8 * GB, level: "green", over: [], cpuText: "25% of 8 cores (2)", memoryText: "25% of 32 GB (8 GB)" });
    expect(budgetOf({ cpu: "3 cores", memory: "10 GB", autoBackground: false }, machine, [], { cpu: 100, sustained: true, memory: GB }))
      .toMatchObject({ cpuLimit: 300, memoryLimit: 10 * GB, cpuText: "3 cores (38% of 8)", memoryText: "10 GB (31% of 32 GB)", cpuSetting: "3 cores" });
    expect(budgetOf(settings, machine, [], { cpu: 160, sustained: true, memory: GB }).level).toBe("yellow");
    expect(budgetOf(settings, machine, [], { cpu: 260, sustained: true, memory: GB }).level).toBe("red");
    // CPU that isn't sustained yet doesn't count against it; memory does.
    expect(budgetOf(settings, machine, [], { cpu: 900, sustained: false, memory: GB }).level).toBe("green");
    expect(budgetOf(settings, machine, [], { cpu: 0, sustained: false, memory: 9 * GB }).level).toBe("red");
  });

  test("over it, the heaviest sessions are named until what is left fits", () => {
    const sessions = [session("a", 50, GB), session("b", 220, GB), session("c", 90, GB), { ...session("unowned", 500, 20 * GB), live: false }];
    const budget = budgetOf(settings, machine, sessions, { cpu: 360, sustained: true, memory: 3 * GB });
    expect(budget.level).toBe("red");
    expect(budget.over).toEqual(["b"]); // 360 − 220 = 140, under 200
    expect(budget.reason).toBe("agents are using 3.6 cores of 2.0 cores and 3.0 GB of 8.0 GB");
    expect(budgetOf(settings, machine, sessions, { cpu: 600, sustained: true, memory: 3 * GB }).over).toEqual(["b", "c", "a"]);
  });
});

let nextPid = 70_000;
const proc = (args: string, ppid: number, extra: Partial<ProcessRow> = {}): ProcessRow =>
  ({ pid: ++nextPid, ppid, uid: 501, startedAt: T0, cpu: 0, rss: 100 * 1024 ** 2, args, ...extra });
const SHELL = "/bin/zsh -c source /Users/dev/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'npm run dev'";
const evidence = (listeners: Map<number, number[]>): Evidence =>
  ({ listeners, environment: new Map(), vmInstances: new Map(), cwds: new Map(), simulatorNames: new Map() });

describe("what each session uses", () => {
  function farm(budget = { cpu: "25%", memory: "25%", autoBackground: false }) {
    const ledger = new ResourceLedger({ machine: { cores: 8, memory: 16 * GB }, budget: () => budget });
    const claude = proc("claude", 1, { cpu: 20 });
    const shell = proc(SHELL, claude.pid);
    const vite = proc("node node_modules/.bin/vite", shell.pid, { cpu: 150 });
    const codex = proc("codex", shell.pid, { cpu: 10 }); // a Codex this Claude started
    const build = proc("xcodebuild build", codex.pid, { cpu: 300 });
    const orphan = proc("python3 -m http.server 8000", 1, { cpu: 0, rss: 50 * 1024 ** 2 });
    const table = [claude, shell, vite, codex, build, orphan];
    const sessions: LedgerSession[] = [
      { sessionId: "claude-1", agentSessionId: "claude-1", pids: [claude.pid], label: "planner", status: "idle" },
      { sessionId: "codex-1", agentSessionId: "codex-1", pids: [codex.pid], label: "builder", status: "busy", startedBySessionId: "claude-1" },
    ];
    const listeners = new Map([[vite.pid, [5100]], [orphan.pid, [8000]]]);
    return { ledger, table, sessions, listeners, shell, vite, build, orphan };
  }

  test("each process once, for its nearest session; a leftover outside the tree is its owner's too", () => {
    const { ledger, table, sessions, listeners, vite } = farm();
    for (let look = 0; look < 4; look += 1) {
      ledger.observe(new ProcessForest(table, sessions, new Set(), 501), evidence(listeners), T0 + look * 30_000, true);
    }
    const published = ledger.published(T0 + 90_000);
    const byKey = new Map(published.sessions.map((session) => [session.key, session]));
    // The Codex's build is the Codex's, not the Claude that started it.
    expect(byKey.get("codex-1")).toMatchObject({ cpu: 310, sustained: true, level: "red" });
    expect(byKey.get("claude-1")).toMatchObject({ cpu: 170, resources: 1, level: "yellow" });
    expect(byKey.get("unowned")).toMatchObject({ resources: 1, label: "Unowned" });
    // The vite is a resource of the planner's, and yellow for its CPU.
    const item = published.items.find((each) => each.id === `p${vite.pid}`)!;
    expect(item).toMatchObject({ level: "yellow", cpuSustained: 150 });
    expect(item.levelReasons).toEqual(["1.5 cores for 5 min"]);
    // 4.8 cores against 2 (a quarter of 8): over, and the Codex alone makes up what is over.
    expect(published.budget).toMatchObject({ level: "red", over: ["codex-1"], cpuLimit: 200 });
    expect(byKey.get("codex-1")?.reasons[0]).toBe("over the agents' budget");
    // The rows: the planner's "1 still running" and both rows' marks.
    expect(ledger.rowLevels(T0 + 90_000)).toEqual(new Map([["codex-1", "red"], ["claude-1", "yellow"]]));
    const state = withStillRunning({ rows: [{ id: "claude-1" }, { id: "codex-1" }] }, ledger.rowCounts(T0 + 90_000), ledger.rowLevels(T0 + 90_000));
    expect(state.rows as unknown[]).toEqual([{ id: "claude-1", stillRunning: 1, resourceLevel: "yellow" }, { id: "codex-1", resourceLevel: "red" }]);
  });

  test("the automatic step is off unless turned on, and then only for a heavy leftover of a session's", () => {
    const off = farm();
    for (let look = 0; look < 4; look += 1) off.ledger.observe(new ProcessForest(off.table, off.sessions, new Set(), 501), evidence(off.listeners), T0 + look * 30_000, true);
    expect(off.ledger.autoBackgroundCandidates(T0 + 90_000)).toEqual([]);
    const on = farm({ cpu: "25%", memory: "25%", autoBackground: true });
    for (let look = 0; look < 4; look += 1) on.ledger.observe(new ProcessForest(on.table, on.sessions, new Set(), 501), evidence(on.listeners), T0 + look * 30_000, true);
    // The vite (1.5 cores for 5 min, the planner's), never the build (a session's own command) or the unowned server.
    expect(on.ledger.autoBackgroundCandidates(T0 + 90_000).map((entry) => entry.id)).toEqual([`p${on.vite.pid}`]);
    on.ledger.markLowered(on.ledger.find(`p${on.vite.pid}`)!, "auto", T0 + 90_000);
    expect(on.ledger.autoBackgroundCandidates(T0 + 90_000)).toEqual([]);
    expect(on.ledger.published(T0 + 90_000).items.find((item) => item.id === `p${on.vite.pid}`)?.lowered).toBe("auto");
  });

  test("the sampler takes the automatic step itself, with taskpolicy, and says so", async () => {
    const { ledger, table, sessions, shell, vite } = (() => {
      const made = farm({ cpu: "25%", memory: "25%", autoBackground: true });
      return made;
    })();
    const asked: string[] = [];
    const logged: string[] = [];
    let now = T0;
    const sampler = new ResourceSampler({
      ledger, sessions: () => ({ sessions, complete: true }), table: async () => table, uid: 501, now: () => now,
      probe: async (argv) => {
        asked.push(argv.join(" "));
        return argv[0] === "lsof" && argv.includes("-sTCP:LISTEN") ? `p${vite.pid}\nn*:5100\n` : "";
      },
      saveMemory: () => {}, memoryOf: () => undefined, readSimulatorName: () => undefined, log: (line) => logged.push(line),
    });
    for (let look = 0; look < 4; look += 1) {
      await sampler.sample();
      now += 30_000;
    }
    const lowered = asked.filter((argv) => argv.startsWith("taskpolicy"));
    // Its group: the background shell it runs in, and the vite. Never the Codex that shell started, nor its build.
    expect(lowered).toEqual([`taskpolicy -b -p ${shell.pid}`, `taskpolicy -b -p ${vite.pid}`]);
    expect(logged.some((line) => line.includes("over their CPU budget; lowered the priority of vite :5100"))).toBe(true);
  });
});

describe("holding and lowering, only when asked", () => {
  const entry = (extra: object = {}) => ({
    id: "p300", identity: "300@1", kind: "server" as const, title: "vite :5100",
    anchor: { pid: 302, startedAt: T0 }, root: { pid: 300, startedAt: T0 }, startedAt: T0, firstSeenAt: T0,
    members: [], extras: [], cpu: 0, rss: 0, ports: [5100], command: "vite", users: [], seen: 2, ...extra,
  });
  const table = [proc("npm run dev", 1, { pid: 300 }), proc("node vite", 300, { pid: 302 })];

  test("hold is SIGSTOP to the group as it runs now, resume SIGCONT; lower and restore are taskpolicy -b and -B", async () => {
    const signals: string[] = [];
    const asked: string[] = [];
    const deps = { table: async () => table, signal: (pid: number, name: string) => signals.push(`${name} ${pid}`), probe: async (argv: string[]) => { asked.push(argv.join(" ")); return ""; } };
    expect(await controlResource(entry(), "hold", deps)).toEqual({ ok: true });
    expect(await controlResource(entry(), "resume", deps)).toEqual({ ok: true });
    expect(signals).toEqual(["SIGSTOP 300", "SIGSTOP 302", "SIGCONT 300", "SIGCONT 302"]);
    expect(await controlResource(entry(), "lower", deps)).toEqual({ ok: true });
    expect(await controlResource(entry(), "restore", deps)).toEqual({ ok: true });
    expect(asked).toEqual(["taskpolicy -b -p 300", "taskpolicy -b -p 302", "taskpolicy -B -p 300", "taskpolicy -B -p 302"]);
  });

  test("a VM is stopped, never held; a process that isn't the one recorded is left alone", async () => {
    const signals: number[] = [];
    expect(await controlResource(entry({ kind: "vm" }), "hold", { table: async () => table, signal: (pid) => signals.push(pid) })).toMatchObject({ ok: false });
    expect(await controlResource(entry({ root: { pid: 300, startedAt: T0 + 99_000 }, anchor: { pid: 302, startedAt: T0 + 99_000 } }), "hold", { table: async () => table, signal: (pid) => signals.push(pid) })).toMatchObject({ ok: false });
    expect(signals).toEqual([]);
  });

  test("a whole session: its process and everything under it", async () => {
    const claude = proc("claude", 1, { pid: 500 });
    const mcp = proc("node mcp.js", 500, { pid: 501 });
    const asked: string[] = [];
    const done = await controlSession({ sessionId: "s", pids: [500], label: "x" }, "lower", { table: async () => [claude, mcp], probe: async (argv) => { asked.push(argv.join(" ")); return ""; } });
    expect(done).toEqual({ ok: true });
    expect(asked).toEqual(["taskpolicy -b -p 500", "taskpolicy -b -p 501"]);
    expect(processKey(500, T0)).toBe(`500@${Math.floor(T0 / 1000)}`);
  });
});
