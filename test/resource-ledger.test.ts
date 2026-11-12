import { describe, expect, test } from "bun:test";
import {
  classifyProcess,
  decodeLedgerMemory,
  decodeResourceRequest,
  isSystemOrApp,
  parseCwds,
  parseLifetime,
  parseLimaInstances,
  parseListenerPorts,
  parsePsTable,
  parseSessionEnvironments,
  processKey,
  ProcessForest,
  ResourceLedger,
  serverName,
  shellCommand,
  withStillRunning,
  type Evidence,
  type LedgerSession,
  type ProcessRow,
  type SessionEnvironment,
} from "../src/resource-ledger.ts";
import { isMacAppOnlyRequest } from "../src/phone-bridge.ts";

// Fixtures are made up: ids, pids, ports and folders are nobody's.
const T0 = Date.parse("2026-11-01T09:00:00Z");
const MIN = 60_000;
const UID = 501;
const UDID = "11111111-2222-4333-8444-555555555555";

let nextPid = 40_000;
function proc(args: string, ppid: number, extra: Partial<ProcessRow> = {}): ProcessRow {
  nextPid += 1;
  return { pid: nextPid, ppid, uid: UID, startedAt: T0, cpu: 0, rss: 10 * 1024 ** 2, args, ...extra };
}

const SNAPSHOT = "/bin/zsh -c source /Users/dev/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'npm run dev' < /dev/null";

function session(sessionId: string, pid: number, extra: Partial<LedgerSession> = {}): LedgerSession {
  return { sessionId, agentSessionId: sessionId, pids: [pid], label: `label ${sessionId.slice(0, 4)}`, status: "idle", ...extra };
}

function evidence(extra: Partial<Evidence> = {}): Evidence {
  return { listeners: new Map(), environment: new Map(), vmInstances: new Map(), cwds: new Map(), simulatorNames: new Map(), ...extra };
}

/** One look: the forest, what the ledger wants, then the sample with `found` answering it. */
function look(
  ledger: ResourceLedger,
  table: ProcessRow[],
  sessions: LedgerSession[],
  now: number,
  found: { listeners?: Map<number, number[]>; env?: Map<number, SessionEnvironment>; vm?: Map<number, string>; names?: Map<string, string>; complete?: boolean; own?: Set<number> } = {},
) {
  const forest = new ProcessForest(table, sessions, found.own ?? new Set(), UID);
  const wanted = ledger.wanted(forest);
  const environment = new Map<number, SessionEnvironment>();
  for (const pid of wanted.environment) environment.set(pid, found.env?.get(pid) ?? {});
  ledger.observe(forest, evidence({
    listeners: found.listeners ?? new Map(),
    environment,
    vmInstances: new Map([...(found.vm ?? new Map())].filter(([pid]) => wanted.vmFiles.includes(pid))),
    simulatorNames: found.names ?? new Map(),
  }), now, found.complete ?? true);
  return wanted;
}

describe("reading the Mac", () => {
  test("ps rows keep the command's own spacing, and the start time is local", () => {
    const rows = parsePsTable([
      "  501 40123     1   0.0  34464 Thu Nov  5 19:07:11 2026     node /tmp/app/node_modules/.bin/vite --port 5100",
      "    0     1     0   4.5  27264 Thu Nov  5 19:07:11 2026     /sbin/launchd",
      "garbage",
    ].join("\n"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ uid: 501, pid: 40123, ppid: 1, rss: 34464 * 1024, args: "node /tmp/app/node_modules/.bin/vite --port 5100" });
    expect(rows[0]!.startedAt).toBe(new Date(2026, 10, 5, 19, 7, 11).getTime());
  });

  test("listeners, folders and VM files from lsof's field output", () => {
    expect(parseListenerPorts("p100\nn*:5100\nn[::1]:5100\nn127.0.0.1:5101\np200\nn*:9000\n")).toEqual(new Map([[100, [5100, 5101]], [200, [9000]]]));
    expect(parseCwds("p100\nfcwd\nn/tmp/app\n")).toEqual(new Map([[100, "/tmp/app"]]));
    expect(parseLimaInstances("p300\nn/Users/dev/.colima/_lima/colima-ci/disk\nn/Users/dev/.colima/_lima/_disks/colima-ci/datadisk\n"))
      .toEqual(new Map([[300, "colima-ci"]]));
  });

  test("an environment gives up its session keys and nothing else", () => {
    const parsed = parseSessionEnvironments(
      "  41 node vite --x CLAUDE_PID=1 SECRET_TOKEN=abc CLAUDE_CODE_SESSION_ID=aaaaaaaa-0000-4000-8000-000000000001 CLAUDE_PID=900\n"
      + "  42 python3 serve.py CODEX_THREAD_ID=019a0000-thread-1 HOME=/Users/dev\n  43 sleep 5\n",
    );
    expect(parsed.get(41)).toEqual({ claudeSessionId: "aaaaaaaa-0000-4000-8000-000000000001", claudePid: 900 });
    expect(parsed.get(42)).toEqual({ codexThreadId: "019a0000-thread-1" });
    expect(parsed.get(43)).toEqual({});
    expect(JSON.stringify([...parsed])).not.toContain("SECRET");
  });
});

describe("what a process is", () => {
  test("servers by the framework the command names", () => {
    expect(classifyProcess({ args: "next-server (v16.1.6)" }, [3000])).toEqual({ kind: "server", title: "next :3000" });
    expect(classifyProcess({ args: "node /tmp/app/node_modules/.bin/../vite/bin/vite.js --port 5100" }, [5100])?.title).toBe("vite :5100");
    expect(serverName("/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3 -m http.server 8000")).toBe("python http.server");
    expect(serverName("bun run server.ts")).toBe("bun run");
    expect(serverName("node dist/server.js --port 1")).toBe("node server.js");
    expect(classifyProcess({ args: "node dist/server.js" })).toBeNull();
  });

  test("VMs, simulators, driven browsers, containers, tmux and watchers", () => {
    expect(classifyProcess({ args: "/opt/homebrew/bin/limactl hostagent --pidfile /Users/dev/.colima/_lima/colima-ci/ha.pid colima-ci" }))
      .toEqual({ kind: "vm", title: "colima ci" });
    expect(classifyProcess({ args: "/opt/homebrew/bin/limactl hostagent --pidfile /Users/dev/.colima/_lima/colima/ha.pid colima" })?.title).toBe("colima default");
    expect(classifyProcess({ args: `launchd_sim /Users/dev/Library/Developer/CoreSimulator/Devices/${UDID}/data/var/run/launchd_bootstrap.plist` })?.kind).toBe("simulator");
    expect(classifyProcess({ args: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/p about:blank" }))
      .toEqual({ kind: "browser", title: "headless Chrome :9222" });
    expect(classifyProcess({ args: "/Applications/Google Chrome.app/Contents/Frameworks/Helpers/Google Chrome Helper --type=renderer --remote-debugging-port=9222" })).toBeNull();
    expect(classifyProcess({ args: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" })).toBeNull();
    expect(classifyProcess({ args: "docker compose up" })?.kind).toBe("container");
    expect(classifyProcess({ args: "docker compose up -d" })).toBeNull();
    expect(classifyProcess({ args: "tmux -L work new-session -d" })).toEqual({ kind: "tmux", title: "tmux work" });
    expect(classifyProcess({ args: "node node_modules/.bin/tsc -w -p ." })?.kind).toBe("watcher");
    expect(classifyProcess({ args: "bun --watch src/index.ts" })?.kind).toBe("watcher");
    expect(classifyProcess({ args: "tail -f /tmp/log" })?.kind).toBe("watcher");
  });

  test("apps and system services are never a session's, a tool inside Xcode is", () => {
    expect(isSystemOrApp("/Users/dev/Library/Application Support/Tool/Agent.app/Contents/MacOS/agent --flag")).toBe(true);
    expect(isSystemOrApp("/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter")).toBe(true);
    expect(isSystemOrApp("/usr/libexec/rapportd")).toBe(true);
    expect(isSystemOrApp("/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python -m http.server")).toBe(false);
    expect(isSystemOrApp("node vite")).toBe(false);
  });

  test("a Bash tool shell's title is the command it ran", () => {
    expect(shellCommand(SNAPSHOT)).toBe("npm run dev");
    expect(shellCommand("/bin/sh -c sleep 600")).toBe("sleep 600");
  });
});

describe("lifetimes", () => {
  test("turn, session-end, keep, durations and dates", () => {
    expect(parseLifetime("turn", T0)).toEqual({ kind: "turn" });
    expect(parseLifetime("session-end", T0)).toEqual({ kind: "session" });
    expect(parseLifetime("keep", T0)).toEqual({ kind: "keep" });
    expect(parseLifetime("2h", T0)).toEqual({ kind: "until", until: T0 + 120 * MIN });
    expect(parseLifetime("30m", T0)).toEqual({ kind: "until", until: T0 + 30 * MIN });
    expect(parseLifetime("2026-11-02T09:00:00Z", T0)).toEqual({ kind: "until", until: Date.parse("2026-11-02T09:00:00Z") });
    expect("error" in parseLifetime("soonish", T0)).toBe(true);
    expect("error" in parseLifetime("2020-01-01", T0)).toBe(true);
  });
});

describe("whose it is", () => {
  test("a dev server under a session's shell is that session's; when the session ends, conch asks", () => {
    const ledger = new ResourceLedger();
    const claude = proc("claude --resume", 1);
    const shell = proc(SNAPSHOT, claude.pid);
    const npm = proc("npm run dev", shell.pid);
    const vite = proc("node node_modules/.bin/vite", npm.pid);
    const mcp = proc("node /opt/mcp/server.js", claude.pid);
    const mcpListener = proc("node /opt/mcp/http.js", claude.pid);
    const live = [session("aaaa1111-live", claude.pid, { label: "site work" })];
    const listeners = new Map([[vite.pid, [5100]], [mcpListener.pid, [7777]]]);
    const table = [claude, shell, npm, vite, mcp, mcpListener];

    look(ledger, table, live, T0, { listeners });
    // One look is a command running, not a loose end yet.
    expect(ledger.published(T0).items).toHaveLength(0);
    look(ledger, table, live, T0 + MIN, { listeners });
    const [item] = ledger.published(T0 + MIN).items;
    expect(ledger.published(T0 + MIN).items).toHaveLength(1);
    expect(item).toMatchObject({ id: `p${vite.pid}`, kind: "server", title: "vite :5100", state: "running", owner: { label: "site work", live: true, how: "tree" }, lifetime: { kind: "session", inferred: true } });
    expect(ledger.rowCounts(T0 + MIN)).toEqual(new Map([["aaaa1111-live", 1]]));

    // The session exits: its shell is gone and npm belongs to launchd, ancestry and all.
    const orphaned = [{ ...npm, ppid: 1 }, vite];
    look(ledger, orphaned, [], T0 + 2 * MIN, { listeners });
    expect(ledger.published(T0 + 2 * MIN).items[0]?.state).toBe("running"); // one whole read without it: maybe a resume
    look(ledger, orphaned, [], T0 + 3 * MIN, { listeners });
    look(ledger, orphaned, [], T0 + 4 * MIN, { listeners });
    const asking = ledger.published(T0 + 4 * MIN).items[0]!;
    expect(asking).toMatchObject({ state: "asking", reason: "its session ended", owner: { label: "site work", live: false, how: "tree" } });
    expect(asking.owner?.endedAt).toBe(T0 + MIN);
    expect(ledger.rowCounts(T0 + 4 * MIN).size).toBe(0);
  });

  test("a reused pid is not the process conch remembered", () => {
    const ledger = new ResourceLedger();
    const claude = proc("claude", 1);
    const shell = proc(SNAPSHOT, claude.pid);
    const server = proc("python3 -m http.server 8000", shell.pid);
    const live = [session("bbbb2222", claude.pid)];
    const listeners = new Map([[server.pid, [8000]]]);
    look(ledger, [claude, shell, server], live, T0, { listeners });
    look(ledger, [claude, shell, server], live, T0 + MIN, { listeners });
    // Later, the same pid is a different process, started by nobody conch knows.
    const reused = { ...server, ppid: 1, startedAt: T0 + 30 * MIN };
    look(ledger, [reused], [], T0 + 31 * MIN, { listeners });
    look(ledger, [reused], [], T0 + 32 * MIN, { listeners });
    const [item] = ledger.published(T0 + 32 * MIN).items;
    expect(item?.owner).toBeUndefined();
    expect(item?.state).toBe("unowned");
  });

  test("an orphan names its session in its environment: the shell says nothing, its server does", () => {
    const ledger = new ResourceLedger({ labelFor: (id) => (id === "cccc3333-0000-4000-8000-000000000003" ? "old prototype" : undefined) });
    const shell = proc(SNAPSHOT, 1);
    const pnpm = proc("node /opt/pnpm/bin/pnpm dev", shell.pid);
    const vite = proc("node node_modules/.bin/vite", pnpm.pid);
    const table = [shell, pnpm, vite];
    const listeners = new Map([[vite.pid, [5200]]]);
    const env = new Map<number, SessionEnvironment>([[vite.pid, { claudeSessionId: "cccc3333-0000-4000-8000-000000000003", claudePid: 777 }]]);
    // Nothing on the first look: a process is read only once it has lived through one.
    expect(look(ledger, table, [], T0, { listeners, env }).environment).toEqual([]);
    const first = look(ledger, table, [], T0 + MIN, { listeners, env });
    expect(first.environment).toEqual([shell.pid]); // the top of the group first
    const second = look(ledger, table, [], T0 + 2 * MIN, { listeners, env });
    expect(second.environment).toContain(vite.pid); // the shell said nothing: what in it is a resource
    look(ledger, table, [], T0 + 3 * MIN, { listeners, env });
    look(ledger, table, [], T0 + 4 * MIN, { listeners, env });
    const [item] = ledger.published(T0 + 4 * MIN).items;
    expect(item).toMatchObject({ title: "vite :5200", owner: { label: "old prototype", how: "environment", live: false }, state: "asking" });
    // Read once in its life: never asked for again.
    expect(look(ledger, table, [], T0 + 5 * MIN, { listeners, env }).environment).toEqual([]);
  });

  test("a Codex that Claude started: its processes are the Codex's, though they carry both ids", () => {
    const ledger = new ResourceLedger();
    const claude = proc("claude", 1);
    const codex = proc("codex", 1);
    const server = proc("node serve.js", 1);
    const sessions = [
      session("dddd4444-0000-4000-8000-000000000004", claude.pid, { label: "planner" }),
      session("019a-thread-codex-1", codex.pid, { label: "builder", startedBySessionId: "dddd4444-0000-4000-8000-000000000004" }),
    ];
    const env = new Map<number, SessionEnvironment>([[server.pid, { claudeSessionId: "dddd4444-0000-4000-8000-000000000004", codexThreadId: "019a-thread-codex-1" }]]);
    const listeners = new Map([[server.pid, [4000]]]);
    look(ledger, [claude, codex, server], sessions, T0, { listeners, env });
    look(ledger, [claude, codex, server], sessions, T0 + MIN, { listeners, env });
    expect(ledger.published(T0 + MIN).items[0]?.owner?.label).toBe("builder");
  });

  test("what a person runs in a terminal, an app's own port and conch itself are never listed", () => {
    const ledger = new ResourceLedger();
    const terminal = proc("/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", 1);
    const login = proc("login -pf dev", terminal.pid, { uid: 0 });
    const zsh = proc("-zsh", login.pid);
    const mine = proc("node node_modules/.bin/vite", zsh.pid);
    const app = proc("/Users/dev/Library/Application Support/Tool/Agent.app/Contents/MacOS/agent", 1);
    const daemon = proc("bun src/cli.ts daemon", 1);
    const whisper = proc("whisper-server --port 9100", daemon.pid);
    const table = [terminal, login, zsh, mine, app, daemon, whisper];
    const listeners = new Map([[mine.pid, [5300]], [app.pid, [4400]], [whisper.pid, [9100]]]);
    for (const at of [T0, T0 + MIN]) look(ledger, table, [], at, { listeners, own: new Set([daemon.pid]) });
    expect(ledger.published(T0 + MIN).items).toEqual([]);
  });

  test("unowned: a server or headless browser nothing ties to a session; a bare orphan of no one's is not listed", () => {
    const ledger = new ResourceLedger();
    const server = proc("next-server (v16.1.6)", 1, { startedAt: T0 - 60 * MIN });
    const chrome = proc("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9333 about:blank", 1);
    const helper = proc("/Applications/Google Chrome.app/Contents/Frameworks/Helper --type=renderer", chrome.pid, { rss: 300 * 1024 ** 2 });
    const stray = proc("sleep 99999", 1);
    const table = [server, chrome, helper, stray];
    const listeners = new Map([[server.pid, [3001]], [chrome.pid, [9333]]]);
    for (const at of [T0, T0 + MIN]) look(ledger, table, [], at, { listeners });
    const items = ledger.published(T0 + MIN).items;
    expect(items.map((item) => [item.title, item.state, item.preexisting ?? false])).toEqual([
      ["next :3001", "unowned", true],
      ["headless Chrome :9333", "unowned", false],
    ]);
    expect(items[1]!.memory).toBe(310 * 1024 ** 2); // the browser and its helpers
  });

  test("a session conch can't read whole doesn't end anyone", () => {
    const ledger = new ResourceLedger();
    const claude = proc("claude", 1);
    const shell = proc(SNAPSHOT, claude.pid);
    const vite = proc("node vite", shell.pid);
    const listeners = new Map([[vite.pid, [5100]]]);
    const live = [session("eeee5555", claude.pid)];
    look(ledger, [claude, shell, vite], live, T0, { listeners });
    look(ledger, [claude, shell, vite], live, T0 + MIN, { listeners });
    for (let at = 2; at < 6; at += 1) look(ledger, [{ ...vite, ppid: 1 }], [], T0 + at * MIN, { listeners, complete: false });
    expect(ledger.published(T0 + 6 * MIN).items[0]?.state).toBe("running");
  });
});

describe("VMs and simulators", () => {
  test("a colima VM is its hostagent, its ssh mux and macOS's Virtualization process, and its owner is in the environment", () => {
    const ledger = new ResourceLedger();
    const agent = proc("/opt/homebrew/bin/limactl hostagent --pidfile /Users/dev/.colima/_lima/colima-ci/ha.pid colima-ci", 1, { rss: 100 * 1024 ** 2 });
    const mux = proc("ssh: /Users/dev/.colima/_lima/colima-ci/ssh.sock [mux]", 1, { rss: 5 * 1024 ** 2 });
    const machine = proc("/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine", 1, { rss: 6 * 1024 ** 3, cpu: 40 });
    const usernet = proc("/opt/homebrew/bin/limactl usernet -p /Users/dev/.colima/_lima/_networks/user-v2/usernet.pid", 1);
    const table = [agent, mux, machine, usernet];
    const env = new Map<number, SessionEnvironment>([[agent.pid, { claudeSessionId: "ffff6666-0000-4000-8000-000000000006" }]]);
    const live = [session("ffff6666-0000-4000-8000-000000000006", 999_999, { label: "infra" })];
    const wanted = look(ledger, table, live, T0, { env, vm: new Map([[machine.pid, "colima-ci"]]) });
    expect(wanted.vmFiles).toEqual([machine.pid]);
    look(ledger, table, live, T0 + MIN, { env });
    const items = ledger.published(T0 + MIN).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "vm-ci", kind: "vm", title: "colima ci", cpu: 40, owner: { label: "infra", how: "environment", live: true } });
    expect(items[0]!.memory).toBe(6 * 1024 ** 3 + 105 * 1024 ** 2);
  });

  test("a simulator is its owner's when a command under the session named it no later than it booted", () => {
    const ledger = new ResourceLedger();
    const sim = proc(`launchd_sim /Users/dev/Library/Developer/CoreSimulator/Devices/${UDID}/data/var/run/launchd_bootstrap.plist`, 1, { startedAt: T0 + 5_000 });
    const simApp = proc("/Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/usr/libexec/backboardd", sim.pid, { rss: 200 * 1024 ** 2 });
    const claude = proc("claude", 1);
    const shell = proc(SNAPSHOT, claude.pid);
    const build = proc(`xcodebuild test -scheme App -destination id=${UDID}`, shell.pid, { startedAt: T0 });
    const live = [session("abab7777", claude.pid, { label: "ios work" })];
    const names = new Map([[UDID, "Test Phone"]]);
    const first = look(ledger, [sim, simApp, claude, shell, build], live, T0 + MIN, { names });
    expect(first.simulators).toEqual([UDID]);
    look(ledger, [sim, simApp, claude, shell, build], live, T0 + 2 * MIN, { names });
    const [item] = ledger.published(T0 + 2 * MIN).items;
    expect(item).toMatchObject({ id: "sim-11111111", title: "Test Phone simulator", owner: { label: "ios work", how: "command" }, state: "running" });
    expect(item!.memory).toBe(210 * 1024 ** 2);
  });

  test("a session that only used a booted simulator is a user, not its owner", () => {
    const ledger = new ResourceLedger();
    const sim = proc(`launchd_sim /Users/dev/Library/Developer/CoreSimulator/Devices/${UDID}/data/x.plist`, 1, { startedAt: T0 - 60 * MIN });
    const claude = proc("claude", 1);
    const shell = proc(SNAPSHOT, claude.pid);
    const shot = proc("xcrun simctl io booted screenshot /tmp/a.png", shell.pid, { startedAt: T0 });
    const names = new Map([[UDID, "Test Phone"]]);
    const live = [session("cdcd8888", claude.pid, { label: "ios work" })];
    look(ledger, [sim, claude, shell, { ...shot, args: `xcrun simctl io ${UDID} screenshot /tmp/a.png` }], live, T0, { names });
    look(ledger, [sim, claude, shell], live, T0 + MIN, { names });
    const [item] = ledger.published(T0 + MIN).items;
    expect(item?.state).toBe("unowned");
    expect(item?.users).toEqual(["ios work"]);
  });
});

describe("declared lifetimes and Tyler's word", () => {
  function declaredSetup() {
    const ledger = new ResourceLedger();
    const claude = proc("claude", 1);
    const shell = proc(SNAPSHOT, claude.pid);
    const worker = proc("python3 worker.py", shell.pid);
    const table = [claude, shell, worker];
    const owner = { agentSessionId: "1234abcd", sessionId: "1234abcd", label: "data job", how: "declared" as const };
    return { ledger, claude, worker, table, owner };
  }

  test("for this turn: running while it works, asking once the turn is over", () => {
    const { ledger, claude, worker, table, owner } = declaredSetup();
    ledger.declare(processKey(worker.pid, worker.startedAt), { owner, lifetime: { kind: "turn" }, why: "crunch the export", at: T0 });
    look(ledger, table, [session("1234abcd", claude.pid, { label: "data job", status: "busy", statusUpdatedAt: T0 - MIN })], T0);
    expect(ledger.published(T0).items[0]).toMatchObject({ title: "python worker.py", state: "running", why: "crunch the export", lifetime: { kind: "turn" } });
    look(ledger, table, [session("1234abcd", claude.pid, { label: "data job", status: "idle", statusUpdatedAt: T0 + 2 * MIN })], T0 + 3 * MIN);
    expect(ledger.published(T0 + 3 * MIN).items[0]).toMatchObject({ state: "asking", reason: "its turn is over" });
  });

  test("a duration runs out; keep and ask later are remembered", () => {
    const { ledger, claude, worker, table, owner } = declaredSetup();
    const live = [session("1234abcd", claude.pid, { label: "data job" })];
    ledger.declare(processKey(worker.pid, worker.startedAt), { owner, lifetime: { kind: "until", until: T0 + 60 * MIN }, at: T0 });
    look(ledger, table, live, T0);
    expect(ledger.published(T0).items[0]?.state).toBe("running");
    look(ledger, table, live, T0 + 61 * MIN);
    expect(ledger.published(T0 + 61 * MIN).items[0]?.state).toBe("asking");
    const id = ledger.published(T0 + 61 * MIN).items[0]!.id;
    ledger.decide(id, "later", T0 + 61 * MIN);
    expect(ledger.published(T0 + 62 * MIN).items[0]).toMatchObject({ state: "later", asksAgainAt: T0 + 61 * MIN + 4 * 60 * MIN });
    expect(ledger.published(T0 + 61 * MIN + 4 * 60 * MIN + 1).items[0]?.state).toBe("asking");
    ledger.decide(id, "keep", T0 + 70 * MIN);
    expect(ledger.published(T0 + 999 * MIN).items[0]?.state).toBe("kept");
  });

  test("what conch learned survives a restart: the tree's owner of a resource, its decision", () => {
    const ledger = new ResourceLedger();
    const claude = proc("claude", 1);
    const shell = proc(SNAPSHOT, claude.pid);
    const vite = proc("node vite", shell.pid);
    const listeners = new Map([[vite.pid, [5100]]]);
    const live = [session("9999aaaa", claude.pid, { label: "landing page" })];
    look(ledger, [claude, shell, vite], live, T0, { listeners });
    look(ledger, [claude, shell, vite], live, T0 + MIN, { listeners });
    ledger.decide(`p${vite.pid}`, "keep", T0 + MIN);
    const saved = JSON.parse(JSON.stringify(ledger.memory));
    expect(Object.keys(saved.owners)).toContain(processKey(vite.pid, vite.startedAt));
    // Not every command the agent ran: only the resource's own processes.
    expect(Object.keys(saved.owners)).not.toContain(processKey(claude.pid, claude.startedAt));

    const restarted = new ResourceLedger({ memory: decodeLedgerMemory(saved) });
    const orphan = [{ ...vite, ppid: 1 }];
    for (let at = 2; at < 6; at += 1) look(restarted, orphan, [], T0 + at * MIN, { listeners });
    expect(restarted.published(T0 + 6 * MIN).items[0]).toMatchObject({ owner: { label: "landing page", how: "tree" }, state: "kept" });
    expect(decodeLedgerMemory({ v: 2 })).toEqual(decodeLedgerMemory(undefined));
  });
});

describe("the published state", () => {
  test("each live row's count, and none where there is none", () => {
    const state = { rows: [{ id: "a" }, { id: "b", stillRunning: 2 }, { id: "c" }] };
    expect(withStillRunning(state, new Map([["a", 3]])).rows).toEqual([{ id: "a", stillRunning: 3 }, { id: "b" }, { id: "c" }]);
    expect(withStillRunning({ rows: [{ id: "a" }] }, new Map())).toEqual({ rows: [{ id: "a" }] });
  });
});

describe("the socket's requests", () => {
  test("decoded strictly", () => {
    expect(decodeResourceRequest({ kind: "resources" })).toEqual({ kind: "resources" });
    expect(decodeResourceRequest({ kind: "resource-decide", id: "p4242", action: "stop" })).toEqual({ kind: "resource-decide", id: "p4242", action: "stop" });
    expect(decodeResourceRequest({ kind: "resource-decide", id: "p4242", action: "nuke" })).toHaveProperty("error");
    expect(decodeResourceRequest({ kind: "resource-decide", id: "../x y", action: "keep" })).toHaveProperty("error");
    expect(decodeResourceRequest({ kind: "resource-add", target: { pid: 4242 }, until: "2h", callerPid: 99 }))
      .toEqual({ kind: "resource-add", target: { pid: 4242 }, until: "2h", callerPid: 99 });
    expect(decodeResourceRequest({ kind: "resource-add", target: { pid: 4242 }, until: "2h" })).toHaveProperty("error");
    expect(decodeResourceRequest({ kind: "resource-add", target: {}, until: "2h", callerPid: 99 })).toHaveProperty("error");
    expect(decodeResourceRequest({ kind: "resource-add", target: { port: 5100 }, until: "", callerPid: 99 })).toHaveProperty("error");
    expect(decodeResourceRequest({ kind: "something-else" })).toBeNull();
  });

  test("the phone can't list them or stop one", () => {
    expect(isMacAppOnlyRequest({ kind: "resources" })).toBe(true);
    expect(isMacAppOnlyRequest({ kind: "resource-decide", id: "p1", action: "stop" })).toBe(true);
    expect(isMacAppOnlyRequest({ kind: "control-envelope", body: { kind: "resource-decide", id: "p1", action: "stop" } })).toBe(true);
  });
});
