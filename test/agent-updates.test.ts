import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentAdapter } from "../src/agent-adapter.ts";
import { dispatchRuntimeControlMessage, type RuntimeControlDispatchOptions } from "../src/control-server.ts";
import { validateControlResponse } from "../src/settings.ts";
import {
  AgentUpdater,
  backoffMs,
  brewUpgradeEnvironment,
  BREW_TAIL_CHARS,
  CHECK_EVERY_MS,
  CHECK_FIRST_JITTER_MS,
  CHECK_FIRST_MIN_MS,
  CHECK_JITTER_MS,
  cloneFolder,
  agentUpdaterDeps,
  detectAgentInstall,
  fetchLatestCaskVersion,
  placeBack,
  readAgentUpdatesState,
  runBrewUpgrade,
  versionFromExecutable,
  type AgentUpdaterDeps,
  type BrewResult,
  type InstallProbe,
} from "../src/agent-updates.ts";

const OLD = "2.1.309";
const NEW = "2.1.319";
const CASK = "claude-code@latest";

interface FakeWorld {
  root: string;
  prefix: string;
  caskroom: string;
  staged: string;
  stateDir: string;
  keptRoot: string;
  statePath: string;
  binary(version?: string): string;
}

function makeRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "agent-updates-")));
}

/** A Homebrew-shaped prefix with one cask installed at OLD: only ever a folder under this test's temp dir. */
function makeWorld(token = CASK, version = OLD): FakeWorld {
  const root = makeRoot();
  const prefix = join(root, "homebrew");
  const caskroom = join(prefix, "Caskroom", token);
  const staged = join(caskroom, version);
  mkdirSync(join(staged, "bin"), { recursive: true });
  writeFileSync(join(staged, "claude"), `binary ${version}`, { mode: 0o755 });
  mkdirSync(join(caskroom, ".metadata", version, "20261023190728.100", "Casks"), { recursive: true });
  writeFileSync(join(caskroom, ".metadata", version, "20261023190728.100", "Casks", `${token}.json`), "{}");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(join(prefix, "bin", "brew"), "#!/bin/sh\n", { mode: 0o755 });
  symlinkSync(join(staged, "claude"), join(prefix, "bin", "claude"));
  const stateDir = join(root, "config");
  mkdirSync(stateDir, { recursive: true });
  return {
    root, prefix, caskroom, staged, stateDir,
    keptRoot: join(stateDir, "agent-updates", "kept"),
    statePath: join(stateDir, "agent-updates.json"),
    binary: (v = version) => join(caskroom, v, "claude"),
  };
}

function fakeAdapter(executable = "claude", backend = "claude"): AgentAdapter {
  return {
    backend, displayName: "Claude Code", executable,
    ownInstallerRoots: (home: string) => [join(home, ".local/share/claude/versions")],
  } as unknown as AgentAdapter;
}

function probeFor(world: FakeWorld, overrides: Partial<InstallProbe> = {}): InstallProbe {
  return {
    which: (name) => join(world.prefix, "bin", name),
    realpath: realpathSync,
    exists: existsSync,
    home: join(world.root, "home"),
    env: { HOME: join(world.root, "home") },
    ...overrides,
  };
}

/** Exactly what `brew upgrade --cask` does to the folders (cask/installer.rb), minus the download. */
async function homebrewUpgrades(world: FakeWorld, from: string, to: string, holdMs = 40): Promise<void> {
  const staged = join(world.caskroom, from);
  const metadata = join(world.caskroom, ".metadata", from);
  renameSync(staged, `${staged}.upgrading`);
  renameSync(metadata, `${metadata}.upgrading`);
  await Bun.sleep(holdMs); // the seconds Homebrew spends unpacking the new one
  mkdirSync(join(world.caskroom, to), { recursive: true });
  writeFileSync(join(world.caskroom, to, "claude"), `binary ${to}`, { mode: 0o755 });
  rmSync(join(world.prefix, "bin", "claude"));
  symlinkSync(join(world.caskroom, to, "claude"), join(world.prefix, "bin", "claude"));
  mkdirSync(join(world.caskroom, ".metadata", to, "20261109000000.000", "Casks"), { recursive: true });
  rmSync(`${staged}.upgrading`, { recursive: true, force: true }); // finalize_upgrade: purge_backed_up_versioned_files
  rmSync(`${metadata}.upgrading`, { recursive: true, force: true });
}

function makeDeps(world: FakeWorld, overrides: Partial<AgentUpdaterDeps> & { brewCalls?: Array<[string, string]> } = {}): AgentUpdaterDeps & { logs: string[] } {
  const logs: string[] = [];
  const brewCalls = overrides.brewCalls ?? [];
  const { brewCalls: _ignored, ...rest } = overrides;
  return {
    statePath: world.statePath,
    keptRoot: world.keptRoot,
    refused: () => null,
    enabled: () => true,
    now: () => Date.UTC(2026, 10, 9, 12),
    random: () => 0.5,
    log: (line) => { logs.push(line); },
    adapters: () => [fakeAdapter()],
    probe: probeFor(world),
    readVersion: async () => "9.9.9",
    latestCaskVersion: async () => ({ version: NEW }),
    clone: cloneFolder,
    upgrade: async (brew, cask) => {
      brewCalls.push([brew, cask]);
      await homebrewUpgrades(world, OLD, NEW);
      return { ok: true, code: 0, timedOut: false, tail: "" };
    },
    runningExecutables: async () => [],
    sessions: () => [],
    setTimer: () => 0,
    holdPollMs: 5,
    ...rest,
    logs,
  };
}

async function waitFor(condition: () => boolean, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(5);
  }
}

describe("how an agent CLI is installed, from where its binary really lives", () => {
  const adapter = fakeAdapter();

  test("a Homebrew cask conch can name, through the bin symlink", () => {
    const world = makeWorld();
    const install = detectAgentInstall(adapter, probeFor(world));
    expect(install).toMatchObject({ channel: "homebrew-cask", cask: CASK, version: OLD, prefix: world.prefix, stagedPath: world.staged });
  });

  test("a Caskroom path with no Homebrew metadata is not one conch can name", () => {
    const world = makeWorld();
    rmSync(join(world.caskroom, ".metadata"), { recursive: true });
    expect(detectAgentInstall(adapter, probeFor(world)).channel).toBe("not-managed");
  });

  test("a Caskroom path whose Homebrew has no brew is not managed", () => {
    const world = makeWorld();
    rmSync(join(world.prefix, "bin", "brew"));
    expect(detectAgentInstall(adapter, probeFor(world)).channel).toBe("not-managed");
  });

  test("a version folder mid-upgrade (.upgrading) isn't treated as installed", () => {
    const world = makeWorld();
    const moved = `${world.staged}.upgrading`;
    renameSync(world.staged, moved);
    const probe = probeFor(world, { which: () => join(moved, "claude"), realpath: (p) => p });
    expect(detectAgentInstall(adapter, probe).channel).toBe("not-managed");
  });

  test("its own installer updates itself and is left alone", () => {
    const world = makeWorld();
    const home = join(world.root, "home");
    const path = join(home, ".local/share/claude/versions/2.1.320");
    const install = detectAgentInstall(adapter, probeFor(world, { which: () => "x", realpath: () => path, home }));
    expect(install.channel).toBe("updates-itself");
    expect(install.source).toContain("updates itself");
    expect(install.cask).toBeUndefined();
  });

  test("a desktop app bundle updates with its app", () => {
    const world = makeWorld();
    const path = "/Applications/ChatGPT.app/Contents/MacOS/codex";
    expect(detectAgentInstall(adapter, probeFor(world, { which: () => path, realpath: (p) => p })).channel).toBe("updates-itself");
  });

  test("npm, a version manager, or nothing recognisable is left alone", () => {
    const world = makeWorld();
    for (const [real, expected] of [
      ["/opt/node/lib/node_modules/@anthropic-ai/claude-code/cli.js", "npm, not managed by conch"],
      ["/Users/t/.volta/tools/image/claude", "Not managed by conch"],
    ] as const) {
      const install = detectAgentInstall(adapter, probeFor(world, { which: () => real, realpath: (p) => p }));
      expect(install.channel).toBe("not-managed");
      expect(install.source).toBe(expected);
    }
  });

  test("not on PATH says missing", () => {
    const world = makeWorld();
    expect(detectAgentInstall(adapter, probeFor(world, { which: () => null })).channel).toBe("missing");
    expect(detectAgentInstall(adapter, probeFor(world, { realpath: () => { throw new Error("gone"); } })).channel).toBe("missing");
  });

  test("the version check reads the cask's own version, and only a real one", async () => {
    const fetchFor = (body: unknown, status = 200): typeof fetch => (async (url: string) => {
      expect(url).toBe("https://formulae.brew.sh/api/cask/claude-code@latest.json");
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    expect(await fetchLatestCaskVersion(CASK, fetchFor({ version: "2.1.319" }))).toEqual({ version: "2.1.319" });
    expect(await fetchLatestCaskVersion(CASK, fetchFor({ version: "2.1.319,build5" }))).toEqual({ version: "2.1.319" });
    expect("error" in await fetchLatestCaskVersion(CASK, fetchFor({ version: "latest" }))).toBe(true);
    expect("error" in await fetchLatestCaskVersion(CASK, fetchFor({}, 500))).toBe(true);
    expect("error" in await fetchLatestCaskVersion("../evil", fetchFor({ version: "1.0.0" }))).toBe(true);
    expect("error" in await fetchLatestCaskVersion(CASK, (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBe(true);
  });
});

describe("the schedule", () => {
  test("the first look is minutes after start, then every few hours, each jittered", () => {
    const world = makeWorld();
    const delays: number[] = [];
    const deps = makeDeps(world, {
      setTimer: (_run, ms) => { delays.push(ms); return delays.length; },
      random: () => 0.75,
    });
    const updater = new AgentUpdater(deps);
    // The sandbox refuses a real start; the schedule itself is what's under test.
    (updater as unknown as { scheduleCheck(first: boolean): void }).scheduleCheck(true);
    expect(delays[0]).toBe(CHECK_FIRST_MIN_MS + 0.75 * CHECK_FIRST_JITTER_MS);
    expect(delays[0]!).toBeGreaterThanOrEqual(CHECK_FIRST_MIN_MS);
    expect(delays[0]!).toBeLessThan(CHECK_FIRST_MIN_MS + CHECK_FIRST_JITTER_MS);
    (updater as unknown as { scheduleCheck(first: boolean): void }).scheduleCheck(false);
    expect(delays[1]!).toBeGreaterThanOrEqual(CHECK_EVERY_MS);
    expect(delays[1]!).toBeLessThan(CHECK_EVERY_MS + CHECK_JITTER_MS);
  });

  test("never starts in the test sandbox, and never runs brew there", async () => {
    const world = makeWorld();
    let timers = 0;
    // The real seam, as the daemon builds it: this conch is running its tests.
    const real = agentUpdaterDeps({ configDir: world.stateDir, enabled: () => true, log: () => {}, sessions: () => [] });
    expect(real.refused()).toContain("conch is running its tests");
    new AgentUpdater({ ...real, setTimer: () => { timers += 1; return timers; }, runningExecutables: async () => [] }).start();
    expect(timers).toBe(0);
    // And a pass never reaches the check or brew, even asked for directly.
    const calls: Array<[string, string]> = [];
    let asked = 0;
    await new AgentUpdater(makeDeps(world, {
      refused: () => "conch is running its tests", brewCalls: calls,
      latestCaskVersion: async () => { asked += 1; return { version: NEW }; },
    })).updateNow("claude");
    expect(asked).toBe(0);
    expect(calls).toEqual([]);
    // And the real runner refuses without spawning anything, exactly as setup's installer does.
    const result = await runBrewUpgrade("/opt/homebrew/bin/brew", CASK);
    expect(result.ok).toBe(false);
    expect(result.tail).toContain("conch is running its tests");
  });

  test("scheduled passes and Update now go one at a time", async () => {
    const world = makeWorld();
    let looking = 0;
    let most = 0;
    const brewCalls: Array<[string, string]> = [];
    const deps = makeDeps(world, {
      brewCalls,
      // Every pass and "Update now" goes through this; in parallel they'd overlap here.
      latestCaskVersion: async () => {
        looking += 1;
        most = Math.max(most, looking);
        await Bun.sleep(15);
        looking -= 1;
        return { version: NEW };
      },
    });
    const updater = new AgentUpdater(deps);
    const serialize = (updater as unknown as { serialize<T>(work: () => Promise<T>): Promise<T> }).serialize.bind(updater);
    await Promise.all([
      serialize(() => updater.checkAll()),
      updater.updateNow("claude"),
      serialize(() => updater.checkAll()),
    ]);
    expect(most).toBe(1);
    // After the first upgrade the other two find it current: one brew, not three.
    expect(brewCalls).toHaveLength(1);
  });
});

describe("backing off after a failure", () => {
  const failing = (world: FakeWorld, calls: Array<[string, string]>): Partial<AgentUpdaterDeps> => ({
    upgrade: async (brew, cask) => {
      calls.push([brew, cask]);
      return { ok: false, code: 1, timedOut: false, tail: "Error: network\nmore" };
    },
    clone: async (from, to) => { await cloneFolder(from, to); void world; },
  });

  test("each failure waits longer, capped", () => {
    expect([1, 2, 3, 4, 5, 99].map(backoffMs)).toEqual([6, 24, 72, 168, 168, 168].map((hours) => hours * 3_600_000));
  });

  test("a failure is reported once and not retried until the backoff passes, across restarts", async () => {
    const world = makeWorld();
    const calls: Array<[string, string]> = [];
    const clock = { now: Date.UTC(2026, 10, 9, 12) };
    const deps = makeDeps(world, { ...failing(world, calls), now: () => clock.now });
    let updater = new AgentUpdater(deps);
    await updater.checkAll();
    expect(calls).toHaveLength(1);
    const state = readAgentUpdatesState(world.statePath);
    expect(state.agents.claude?.failures).toBe(1);
    expect(state.agents.claude?.nextAttemptAt).toBe(clock.now + backoffMs(1));
    expect(deps.logs.filter((line) => line.includes("failed"))).toHaveLength(1);

    // A later pass inside the backoff, and a restarted daemon, both leave it alone.
    clock.now += backoffMs(1) - 60_000;
    await updater.checkAll();
    updater = new AgentUpdater(deps);
    await updater.checkAll();
    expect(calls).toHaveLength(1);

    clock.now += 120_000;
    await updater.checkAll();
    expect(calls).toHaveLength(2);
    expect(readAgentUpdatesState(world.statePath).agents.claude?.failures).toBe(2);
    expect(readAgentUpdatesState(world.statePath).agents.claude?.nextAttemptAt).toBe(clock.now + backoffMs(2));
  });

  test("Update now goes past the backoff, and a success clears the record", async () => {
    const world = makeWorld();
    const calls: Array<[string, string]> = [];
    let succeed = false;
    const deps = makeDeps(world, {
      upgrade: async (brew, cask) => {
        calls.push([brew, cask]);
        if (!succeed) return { ok: false, code: 1, timedOut: false, tail: "nope" };
        await homebrewUpgrades(world, OLD, NEW, 5);
        return { ok: true, code: 0, timedOut: false, tail: "" };
      },
    });
    const updater = new AgentUpdater(deps);
    await updater.checkAll();
    expect(calls).toHaveLength(1);
    succeed = true;
    await updater.updateNow("claude");
    expect(calls).toHaveLength(2);
    const record = readAgentUpdatesState(world.statePath).agents.claude!;
    expect(record.failures).toBeUndefined();
    expect(record.nextAttemptAt).toBeUndefined();
    expect(record.failure).toBeUndefined();
    expect(record.updatedFrom).toBe(OLD);
    expect(record.updatedTo).toBe(NEW);
  });
});

describe("only the named cask", () => {
  test("brew is told exactly `upgrade --cask <cask>`, by the Homebrew that owns the cask", async () => {
    const world = makeWorld();
    const calls: Array<[string, string]> = [];
    await new AgentUpdater(makeDeps(world, { brewCalls: calls })).checkAll();
    expect(calls).toEqual([[join(world.prefix, "bin", "brew"), CASK]]);
  });

  test("the real runner, against a stand-in brew on disk, runs exactly that and nothing else", async () => {
    const world = makeWorld();
    const home = join(world.root, "home");
    mkdirSync(home, { recursive: true });
    const argvLog = join(world.root, "brew-argv");
    const envLog = join(world.root, "brew-env");
    const brew = join(world.prefix, "bin", "brew");
    writeFileSync(brew, [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${argvLog}`,
      `env | grep -E '^(HOMEBREW_|NONINTERACTIVE|NO_COLOR)' | sort > ${envLog}`,
      "echo all done",
      "exit 0",
    ].join("\n"), { mode: 0o755 });
    chmodSync(brew, 0o755);
    const result = await runBrewUpgrade(brew, CASK, { env: { HOME: home, PATH: process.env.PATH }, accountHome: () => home, timeoutMs: 5_000 });
    expect(result).toMatchObject({ ok: true, code: 0, timedOut: false });
    expect(result.tail).toContain("all done");
    expect(readFileSync(argvLog, "utf8").trim().split("\n")).toEqual(["upgrade", "--cask", CASK]);
    expect(readFileSync(envLog, "utf8")).toContain("HOMEBREW_NO_AUTO_UPDATE=1");
    expect(readFileSync(envLog, "utf8")).toContain("HOMEBREW_FORCE_API_AUTO_UPDATE=1");
    expect(readFileSync(envLog, "utf8")).toContain("HOMEBREW_API_AUTO_UPDATE_SECS=0");
  });

  test("the real runner bounds a brew that hangs, and reports it", async () => {
    const world = makeWorld();
    const home = join(world.root, "home");
    mkdirSync(home, { recursive: true });
    const brew = join(world.prefix, "bin", "brew");
    writeFileSync(brew, "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
    chmodSync(brew, 0o755);
    const result = await runBrewUpgrade(brew, CASK, { env: { HOME: home, PATH: process.env.PATH }, accountHome: () => home, timeoutMs: 80 });
    expect(result).toMatchObject({ ok: false, timedOut: true });
  });

  test("a non-cask channel is never given to brew, scheduled or by hand", async () => {
    const world = makeWorld();
    const calls: Array<[string, string]> = [];
    const deps = makeDeps(world, {
      brewCalls: calls,
      probe: probeFor(world, { which: () => "/opt/node/lib/node_modules/@anthropic-ai/claude-code/cli.js", realpath: (p) => p }),
      latestCaskVersion: async () => { throw new Error("never asked"); },
    });
    const updater = new AgentUpdater(deps);
    await updater.checkAll();
    await updater.updateNow("claude");
    expect(calls).toEqual([]);
  });

  test("the HOMEBREW_NO_AUTO_UPDATE trio is set exactly and nothing else is claimed", () => {
    const env = brewUpgradeEnvironment({ HOMEBREW_NO_AUTO_UPDATE: "", PATH: "/usr/bin", HOMEBREW_CASK_OPTS: "--appdir=/Applications" });
    expect(env.HOMEBREW_NO_AUTO_UPDATE).toBe("1");
    expect(env.HOMEBREW_FORCE_API_AUTO_UPDATE).toBe("1");
    expect(env.HOMEBREW_API_AUTO_UPDATE_SECS).toBe("0");
    expect(env.HOMEBREW_NO_INSTALL_CLEANUP).toBe("1");
    expect(env.HOMEBREW_CASK_OPTS).toBe("--appdir=/Applications"); // a person's own Homebrew setting, unchanged
  });

  test("already current means brew isn't run at all", async () => {
    const world = makeWorld();
    const calls: Array<[string, string]> = [];
    const deps = makeDeps(world, { brewCalls: calls, latestCaskVersion: async () => ({ version: OLD }) });
    await new AgentUpdater(deps).checkAll();
    expect(calls).toEqual([]);
    expect(readAgentUpdatesState(world.statePath).agents.claude?.newest).toBe(OLD);
  });
});

describe("the off switch", () => {
  test("off: no check, no clone, no brew, no write of a new version", async () => {
    const world = makeWorld();
    const calls: Array<[string, string]> = [];
    let asked = 0;
    const deps = makeDeps(world, {
      enabled: () => false,
      brewCalls: calls,
      latestCaskVersion: async () => { asked += 1; return { version: NEW }; },
      clone: async () => { throw new Error("no clone while off"); },
    });
    await new AgentUpdater(deps).checkAll();
    expect(asked).toBe(0);
    expect(calls).toEqual([]);
    expect(existsSync(world.keptRoot)).toBe(false);
  });

  test("off during the version check stops the upgrade", async () => {
    const world = makeWorld();
    const calls: Array<[string, string]> = [];
    let on = true;
    const deps = makeDeps(world, {
      enabled: () => on,
      brewCalls: calls,
      latestCaskVersion: async () => { on = false; return { version: NEW }; },
    });
    await new AgentUpdater(deps).checkAll();
    expect(calls).toEqual([]);
    expect(existsSync(world.keptRoot)).toBe(false);
  });

  test("Update now still works while off: it's the explicit ask", async () => {
    const world = makeWorld();
    const calls: Array<[string, string]> = [];
    const deps = makeDeps(world, { enabled: () => false, brewCalls: calls });
    await new AgentUpdater(deps).updateNow("claude");
    expect(calls).toEqual([[join(world.prefix, "bin", "brew"), CASK]]);
  });
});

describe("failures are said, plainly", () => {
  test("a failed brew: what happened, its tail in the record, one log line with no brew output", async () => {
    const world = makeWorld();
    const tail = "==> Error: curl failed\nCaused by: tls handshake";
    const deps = makeDeps(world, { upgrade: async () => ({ ok: false, code: 1, timedOut: false, tail }) });
    const updater = new AgentUpdater(deps);
    await updater.checkAll();
    const failure = updater.status().agents[0]!.failure!;
    expect(failure).toMatchObject({ phase: "update" });
    expect(failure.message).toContain(`brew upgrade --cask ${CASK} failed`);
    expect(failure.output).toBe(tail);
    expect(deps.logs).toHaveLength(1);
    expect(deps.logs[0]).toContain("failed");
    expect(deps.logs[0]).not.toContain("tls handshake");
  });

  test("a timeout says so", async () => {
    const world = makeWorld();
    const deps = makeDeps(world, { upgrade: async () => ({ ok: false, code: null, timedOut: true, tail: "" }) });
    const updater = new AgentUpdater(deps);
    await updater.checkAll();
    expect(updater.status().agents[0]!.failure!.message).toContain("was stopped");
  });

  test("brew exiting 0 without a newer version is still a failure, and the copy is let go", async () => {
    const world = makeWorld();
    const deps = makeDeps(world, { upgrade: async () => ({ ok: true, code: 0, timedOut: false, tail: "Warning: already installed" }) });
    const updater = new AgentUpdater(deps);
    await updater.checkAll();
    const failure = updater.status().agents[0]!.failure!;
    expect(failure.message).toContain(`is still ${OLD}`);
    expect(failure.output).toContain("already installed");
    expect(readAgentUpdatesState(world.statePath).kept).toEqual([]);
    expect(existsSync(join(world.keptRoot, CASK, OLD))).toBe(false);
    expect(lstatSync(world.staged).isDirectory()).toBe(true);
  });

  test("a brew killed partway, CLI gone: says how to fix it, and old sessions keep their folder", async () => {
    const world = makeWorld();
    const deps = makeDeps(world, {
      runningExecutables: async () => [world.binary(OLD)],
      upgrade: async () => {
        renameSync(world.staged, `${world.staged}.upgrading`);
        rmSync(join(world.prefix, "bin", "claude"));
        await Bun.sleep(20);
        return { ok: false, code: null, timedOut: true, tail: "" };
      },
    });
    const updater = new AgentUpdater(deps);
    await updater.checkAll();
    expect(updater.status().agents[0]!.failure!.message).toContain("brew reinstall --cask");
    expect(lstatSync(world.staged).isSymbolicLink()).toBe(true);
    expect(readFileSync(world.binary(OLD), "utf8")).toBe(`binary ${OLD}`);
    expect(readAgentUpdatesState(world.statePath).kept).toHaveLength(1);
  });

  test("no copy, no upgrade: a failed clone is reported and brew is never run", async () => {
    const world = makeWorld();
    const calls: Array<[string, string]> = [];
    const deps = makeDeps(world, { brewCalls: calls, clone: async () => { throw new Error("disk full"); } });
    const updater = new AgentUpdater(deps);
    await updater.checkAll();
    expect(calls).toEqual([]);
    const failure = updater.status().agents[0]!.failure!;
    expect(failure.message).toContain("disk full");
    expect(failure.message).toContain("didn't upgrade");
    expect(lstatSync(world.staged).isDirectory()).toBe(true);
    expect(readFileSync(join(world.staged, "claude"), "utf8")).toBe(`binary ${OLD}`);
  });

  test("a failed version check is quiet, and the next good one clears it", async () => {
    const world = makeWorld();
    let good = false;
    const deps = makeDeps(world, {
      latestCaskVersion: async () => (good ? { version: OLD } : { error: "couldn't reach formulae.brew.sh: offline" }),
    });
    const updater = new AgentUpdater(deps);
    await updater.checkAll();
    expect(updater.status().agents[0]!.failure).toMatchObject({ phase: "check" });
    expect(readAgentUpdatesState(world.statePath).agents.claude?.failures).toBeUndefined();
    good = true;
    await updater.checkAll();
    expect(updater.status().agents[0]!.failure).toBeUndefined();
  });

  test("a brew tail is bounded for the record", () => {
    expect(BREW_TAIL_CHARS).toBeLessThanOrEqual(2_000);
  });
});

describe("keeping the old version reachable for sessions already running", () => {
  /** A process's `/proc/<pid>/exe` as `proc_pidpath` says it. */
  const asProcess = (path: string) => path;

  test("mid-upgrade: Homebrew renames the folder away, and the old binary is back at its old path before it's done", async () => {
    const world = makeWorld();
    let midway = "";
    const deps = makeDeps(world, {
      runningExecutables: async () => [world.binary(OLD)],
      upgrade: async () => {
        renameSync(world.staged, `${world.staged}.upgrading`);
        await waitFor(() => { try { return lstatSync(world.staged).isSymbolicLink(); } catch { return false; } });
        midway = readFileSync(join(world.staged, "claude"), "utf8");
        await Bun.sleep(10);
        rmSync(`${world.staged}.upgrading`, { recursive: true, force: true });
        rmSync(join(world.caskroom, ".metadata", OLD), { recursive: true, force: true });
        mkdirSync(join(world.caskroom, NEW), { recursive: true });
        writeFileSync(join(world.caskroom, NEW, "claude"), `binary ${NEW}`, { mode: 0o755 });
        rmSync(join(world.prefix, "bin", "claude"));
        symlinkSync(join(world.caskroom, NEW, "claude"), join(world.prefix, "bin", "claude"));
        return { ok: true, code: 0, timedOut: false, tail: "" };
      },
    });
    await new AgentUpdater(deps).checkAll();
    expect(midway).toBe(`binary ${OLD}`);
    expect(lstatSync(world.staged).isSymbolicLink()).toBe(true);
    expect(readFileSync(world.binary(OLD), "utf8")).toBe(`binary ${OLD}`);
  });

  test("the new version is what's installed, and the old one is only a link to conch's copy", async () => {
    const world = makeWorld();
    const updater = new AgentUpdater(makeDeps(world, { runningExecutables: async () => [asProcess(world.binary(OLD))] }));
    await updater.checkAll();
    expect(readFileSync(join(world.prefix, "bin", "claude"), "utf8")).toBe(`binary ${NEW}`);
    const link = lstatSync(world.staged);
    expect(link.isSymbolicLink()).toBe(true);
    expect(realpathSync(world.staged)).toBe(join(world.keptRoot, CASK, OLD));
    expect(readAgentUpdatesState(world.statePath).kept).toHaveLength(1);
    // Homebrew's own idea of the install is only .metadata: the new version, untouched by what conch does at the old path.
    expect(existsSync(join(world.caskroom, ".metadata", NEW))).toBe(true);
    expect(existsSync(join(world.caskroom, ".metadata", OLD))).toBe(false);
  });

  test("while any process runs from it, it stays: by its old path, Homebrew's name for it, or conch's copy", async () => {
    const world = makeWorld();
    const running: { list: string[] | null } = { list: [] };
    const deps = makeDeps(world, { runningExecutables: async () => running.list });
    const updater = new AgentUpdater(deps);
    running.list = [world.binary(OLD)];
    await updater.checkAll();
    expect(lstatSync(world.staged).isSymbolicLink()).toBe(true);

    for (const executable of [
      world.binary(OLD),
      join(`${world.staged}.upgrading`, "claude"),
      join(world.keptRoot, CASK, OLD, "claude"),
    ]) {
      running.list = [executable];
      await updater.sweep();
      expect(lstatSync(world.staged).isSymbolicLink()).toBe(true);
      expect(existsSync(join(world.keptRoot, CASK, OLD, "claude"))).toBe(true);
    }

    // Can't tell which processes are running: stays.
    running.list = null;
    await updater.sweep();
    expect(lstatSync(world.staged).isSymbolicLink()).toBe(true);
    expect(existsSync(join(world.keptRoot, CASK, OLD))).toBe(true);
  });

  test("a session on it, seen only by the daemon, also holds it", async () => {
    const world = makeWorld();
    const sessions = { list: [{ backend: "claude" as const, executable: world.binary(OLD) }] };
    const deps = makeDeps(world, { sessions: () => sessions.list });
    const updater = new AgentUpdater(deps);
    await updater.checkAll();
    expect(lstatSync(world.staged).isSymbolicLink()).toBe(true);
    sessions.list = [];
    await updater.sweep();
    expect(existsSync(world.staged)).toBe(false);
    expect(existsSync(join(world.keptRoot, CASK, OLD))).toBe(false);
    expect(readAgentUpdatesState(world.statePath).kept).toEqual([]);
  });

  test("when the last process has gone: the link and the copy go, and Homebrew's own folders are left alone", async () => {
    const world = makeWorld();
    const running: { list: string[] | null } = { list: [world.binary(OLD)] };
    const deps = makeDeps(world, { runningExecutables: async () => running.list });
    const updater = new AgentUpdater(deps);
    await updater.checkAll();
    running.list = [];
    await updater.sweep();
    expect(existsSync(world.staged)).toBe(false);
    expect(existsSync(join(world.keptRoot, CASK, OLD))).toBe(false);
    expect(readFileSync(world.binary(NEW), "utf8")).toBe(`binary ${NEW}`);
    expect(existsSync(join(world.caskroom, ".metadata"))).toBe(true);
    expect(readAgentUpdatesState(world.statePath).kept).toEqual([]);
    expect(deps.logs.some((line) => line.includes("removed its kept copy"))).toBe(true);
  });

  test("a process still running keeps it across a daemon restart, and a sweep after finishes the job", async () => {
    const world = makeWorld();
    const running: { list: string[] | null } = { list: [world.binary(OLD)] };
    const deps = makeDeps(world, { runningExecutables: async () => running.list });
    await new AgentUpdater(deps).checkAll();
    expect(lstatSync(world.staged).isSymbolicLink()).toBe(true);
    const restarted = new AgentUpdater(deps);
    await restarted.sweep();
    expect(lstatSync(world.staged).isSymbolicLink()).toBe(true);
    running.list = [];
    await restarted.sweep();
    expect(existsSync(world.staged)).toBe(false);
  });

  test("a daemon that died mid-upgrade: the next sweep puts the old path back for whoever is still on it", async () => {
    const world = makeWorld();
    const running: { list: string[] | null } = { list: [world.binary(OLD)] };
    const deps = makeDeps(world, { runningExecutables: async () => running.list });
    await new AgentUpdater(deps).checkAll();
    expect(lstatSync(world.staged).isSymbolicLink()).toBe(true);
    rmSync(world.staged); // the link never got planted, or something removed it
    await new AgentUpdater(deps).sweep();
    expect(lstatSync(world.staged).isSymbolicLink()).toBe(true);
    expect(readFileSync(world.binary(OLD), "utf8")).toBe(`binary ${OLD}`);
  });

  test("sweep never removes a real folder at the old path", async () => {
    const world = makeWorld();
    // A kept entry whose old path is now a real folder: Homebrew put it back, or reinstalled it there.
    const deps = makeDeps(world, { runningExecutables: async () => [] });
    const updater = new AgentUpdater(deps);
    const internals = updater as unknown as { state: { kept: unknown[] }; save(): void };
    const keptPath = join(world.keptRoot, CASK, "2.1.200");
    await cloneFolder(world.staged, keptPath);
    const staged = join(world.caskroom, "2.1.200");
    await cloneFolder(world.staged, staged);
    internals.state.kept.push({ cask: CASK, version: "2.1.200", prefix: world.prefix, stagedPath: staged, keptPath, at: 1 });
    await updater.sweep();
    expect(existsSync(join(staged, "claude"))).toBe(true);
    expect(lstatSync(staged).isSymbolicLink()).toBe(false);
    expect(existsSync(keptPath)).toBe(false); // conch's copy goes; Homebrew's folder doesn't
  });

  test("a version Homebrew has put back as installed is not swept", async () => {
    const world = makeWorld();
    const running: { list: string[] | null } = { list: [world.binary(OLD)] };
    const deps = makeDeps(world, { runningExecutables: async () => running.list });
    const updater = new AgentUpdater(deps);
    await updater.checkAll();
    // Nothing runs it now, but Homebrew has reinstalled that version: its metadata says so, and it's Homebrew's again.
    mkdirSync(join(world.caskroom, ".metadata", OLD, "20261110000000.000", "Casks"), { recursive: true });
    running.list = [];
    await updater.sweep();
    expect(lstatSync(world.staged).isSymbolicLink()).toBe(true);
    expect(existsSync(join(world.keptRoot, CASK, OLD))).toBe(true);
  });

  test("a Homebrew rollback leaves the original folder as it was, and the copy goes", async () => {
    const world = makeWorld();
    const deps = makeDeps(world, {
      upgrade: async () => {
        // Homebrew moves the folder, conch links it back, the new install fails, Homebrew rolls back.
        const backup = `${world.staged}.upgrading`;
        renameSync(world.staged, backup);
        await waitFor(() => { try { return lstatSync(world.staged).isSymbolicLink(); } catch { return false; } });
        rmSync(world.staged, { recursive: true, force: true }); // FileUtils.rm_r: the link, not its target
        renameSync(backup, world.staged);
        return { ok: false, code: 1, timedOut: false, tail: "Error" };
      },
    });
    const updater = new AgentUpdater(deps);
    await updater.checkAll();
    const stat = lstatSync(world.staged);
    expect(stat.isDirectory() && !stat.isSymbolicLink()).toBe(true);
    expect(readFileSync(join(world.staged, "claude"), "utf8")).toBe(`binary ${OLD}`);
    expect(readAgentUpdatesState(world.statePath).kept).toEqual([]);
    expect(existsSync(join(world.keptRoot, CASK, OLD))).toBe(false);
  });

  test("placeBack is once and never overwrites anything already there", () => {
    const root = makeRoot();
    const staged = join(root, "2.1.309");
    const kept = join(root, "kept");
    mkdirSync(staged, { recursive: true });
    mkdirSync(kept, { recursive: true });
    expect(placeBack(staged, kept)).toBe(false); // Homebrew hasn't moved it yet
    expect(lstatSync(staged).isDirectory()).toBe(true);
    rmSync(staged, { recursive: true });
    expect(placeBack(staged, kept)).toBe(true);
    expect(readlinkSync(staged)).toBe(kept);
    expect(placeBack(staged, kept)).toBe(false); // it's there now: nothing to do
    expect(readlinkSync(staged)).toBe(kept);
  });

  test("the clone is a real copy: not a link back to the folder Homebrew deletes", async () => {
    const world = makeWorld();
    const to = join(world.root, "copy");
    await cloneFolder(world.staged, to);
    rmSync(world.staged, { recursive: true });
    expect(readFileSync(join(to, "claude"), "utf8")).toBe(`binary ${OLD}`);
  });

  test("versionFromExecutable reads Caskroom, mid-upgrade and conch's copy", () => {
    expect(versionFromExecutable("/opt/homebrew/Caskroom/codex/0.164.0/bin/codex")).toBe("0.164.0");
    expect(versionFromExecutable("/opt/homebrew/Caskroom/codex/0.155.1.upgrading/bin/codex")).toBe("0.155.1");
    expect(versionFromExecutable("/h/.config/conch/agent-updates/kept/claude-code@latest/2.1.309/claude")).toBe("2.1.309");
    expect(versionFromExecutable("/Applications/ChatGPT.app/Contents/MacOS/codex")).toBeNull();
  });
});

describe("a stand-in brew on disk, end to end", () => {
  test("the real runner, a real child renaming the folder, and the old path back before it's done", async () => {
    const world = makeWorld();
    const home = join(world.root, "home");
    mkdirSync(home, { recursive: true });
    const midway = join(world.root, "midway");
    const brew = join(world.prefix, "bin", "brew");
    // What Homebrew does on disk: moves the old version and its metadata aside, unpacks the new one, relinks, purges.
    writeFileSync(brew, [
      "#!/bin/sh",
      'set -e',
      `cd ${world.caskroom}`,
      `mv ${OLD} ${OLD}.upgrading`,
      `mv .metadata/${OLD} .metadata/${OLD}.upgrading`,
      // A running session's Grep arrives here, while Homebrew is still unpacking.
      `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do if [ -e ${OLD}/claude ]; then cat ${OLD}/claude > ${midway}; break; fi; sleep 0.05; done`,
      `mkdir ${NEW}`,
      `printf 'binary ${NEW}' > ${NEW}/claude`,
      `chmod +x ${NEW}/claude`,
      `mkdir -p .metadata/${NEW}/20261109000000.000/Casks`,
      `rm -f ${join(world.prefix, "bin", "claude")}`,
      `ln -s ${join(world.caskroom, NEW, "claude")} ${join(world.prefix, "bin", "claude")}`,
      `rm -rf ${OLD}.upgrading .metadata/${OLD}.upgrading`,
    ].join("\n"), { mode: 0o755 });
    chmodSync(brew, 0o755);
    const deps = makeDeps(world, {
      runningExecutables: async () => [world.binary(OLD)],
      upgrade: (brewPath, cask) => runBrewUpgrade(brewPath, cask, { env: { HOME: home, PATH: process.env.PATH }, accountHome: () => home, timeoutMs: 10_000 }),
    });
    const updater = new AgentUpdater(deps);
    await updater.checkAll();
    expect(readFileSync(midway, "utf8")).toBe(`binary ${OLD}`);
    expect(updater.status().agents[0]!).toMatchObject({ installed: NEW, updatedFrom: OLD, updatedTo: NEW });
    expect(lstatSync(world.staged).isSymbolicLink()).toBe(true);
    expect(readFileSync(world.binary(OLD), "utf8")).toBe(`binary ${OLD}`);
    expect(readFileSync(join(world.prefix, "bin", "claude"), "utf8")).toBe(`binary ${NEW}`);
  });
});

describe("new version, old sessions: only ever said", () => {
  test("live sessions on an older version are counted, per agent, for the note", () => {
    const world = makeWorld();
    const installedPath = world.binary(OLD);
    const updater = new AgentUpdater(makeDeps(world, {
      sessions: () => [
        { backend: "claude", executable: "/opt/homebrew/Caskroom/claude-code@latest/2.1.280/claude" },
        { backend: undefined, executable: "/opt/homebrew/Caskroom/claude-code@latest/2.1.300.upgrading/claude" },
        { backend: "claude", executable: "/opt/homebrew/Caskroom/claude-code@latest/2.1.309/claude" }, // current
        { backend: "claude", executable: installedPath }, // current, by the real path
        { backend: "codex", executable: "/opt/homebrew/Caskroom/codex/0.100.0/bin/codex" },
      ],
    }));
    expect(updater.status().agents[0]!.olderSessions).toEqual({ count: 2, versions: ["2.1.300", "2.1.280"] });
  });

  test("nothing in the updater can reach a session: its only seam for them is a read", () => {
    const source = readFileSync(join(dirname(import.meta.path), "../src/agent-updates.ts"), "utf8");
    for (const forbidden of ["closeTerminalSession", "restartSession", "session-close", "sendControlMessage", "tmux", "kill-session", "dispatchRuntime"]) {
      expect(source).not.toContain(forbidden);
    }
    // No code path spawns or signals anything but `brew` and `cp` and `ps`.
    expect([...source.matchAll(/Bun\.spawn\(\[([^,\]]+)/g)].map((match) => match[1]).sort()).toEqual(['"/bin/cp"', '"/bin/ps"']);
    expect(source.match(/spawnInstaller\)?\(\s*\n?\s*\[([^\]]+)\]/)?.[1]).toContain("upgrade");
  });

  test("the daemon wires sessions in as a read-only list", () => {
    const daemon = readFileSync(join(dirname(import.meta.path), "../src/daemon.ts"), "utf8");
    const block = daemon.slice(daemon.indexOf("new AgentUpdater("), daemon.indexOf("new AgentUpdater(") + 800);
    expect(block).toContain("sessions: () => [...panelSessions.values()]");
    expect(block).not.toContain("restart");
    expect(block).not.toContain("close");
  });

  test("a third agent is one adapter row: nothing here names one", async () => {
    const source = readFileSync(join(dirname(import.meta.path), "../src/agent-updates.ts"), "utf8");
    expect(source).not.toMatch(/backend (===|!==) "(claude|codex)"/);
    const world = makeWorld();
    const calls: Array<[string, string]> = [];
    const third = { ...fakeAdapter("claude", "fable"), displayName: "Fable" } as AgentAdapter;
    const deps = makeDeps(world, { brewCalls: calls, adapters: () => [third] });
    await new AgentUpdater(deps).checkAll();
    expect(calls).toEqual([[join(world.prefix, "bin", "brew"), CASK]]);
    expect(new AgentUpdater(deps).status().agents[0]!.backend as string).toBe("fable");
  });
});

describe("the wire", () => {
  test("a status or an Update now reaches the updater, and a malformed one is refused before it", async () => {
    const asked: unknown[] = [];
    const reply = { kind: "agent-updates" as const, auto: true, agents: [] };
    const options = { agentUpdates: (message: unknown) => { asked.push(message); return reply; } } as unknown as RuntimeControlDispatchOptions;
    expect(await dispatchRuntimeControlMessage({ kind: "agent-updates", action: "status" }, options)).toEqual({ handled: true, response: reply });
    expect(await dispatchRuntimeControlMessage({ kind: "agent-updates", action: "update-now", backend: "codex" }, options)).toEqual({ handled: true, response: reply });
    expect(asked).toEqual([{ kind: "agent-updates", action: "status" }, { kind: "agent-updates", action: "update-now", backend: "codex" }]);
    asked.length = 0;
    for (const bad of [{ action: "upgrade-everything" }, { action: "update-now" }, { action: "update-now", backend: 3 }]) {
      const result = await dispatchRuntimeControlMessage({ kind: "agent-updates", ...bad }, options);
      expect(result).toMatchObject({ handled: true, response: { kind: "session-error" } });
    }
    expect(asked).toEqual([]);
  });

  test("the reply validator takes the updater's shape and refuses others", () => {
    expect(validateControlResponse({ kind: "agent-updates", auto: false, agents: [{ backend: "claude" }] }).ok).toBe(true);
    expect(validateControlResponse({ kind: "agent-updates", auto: "yes", agents: [] }).ok).toBe(false);
    expect(validateControlResponse({ kind: "agent-updates", auto: true }).ok).toBe(false);
  });
});

describe("the reply the app reads", () => {
  test("status names the agent, how it's installed and what conch did", async () => {
    const world = makeWorld();
    const updater = new AgentUpdater(makeDeps(world));
    await updater.checkAll();
    const row = updater.status().agents[0]!;
    expect(row).toMatchObject({ backend: "claude", displayName: "Claude Code", channel: "homebrew-cask", cask: CASK, installed: NEW, newest: NEW, updatedFrom: OLD, updatedTo: NEW, canUpdate: true, updating: false });
    expect(row.source).toBe(`Homebrew cask ${CASK}`);
    expect(updater.status().auto).toBe(true);
  });

  test("a CLI conch leaves alone still shows its version, read once, and can't be updated", async () => {
    const world = makeWorld();
    const deps = makeDeps(world, {
      probe: probeFor(world, { which: () => "/h/.local/share/claude/versions/2.1.320", realpath: (p) => p, home: "/h" }),
      readVersion: async () => "2.1.320",
    });
    const updater = new AgentUpdater(deps);
    await updater.checkAll();
    expect(updater.status().agents[0]).toMatchObject({ channel: "updates-itself", installed: "2.1.320", canUpdate: false, newest: null });
  });
});

// `BrewResult`'s shape is what a failure line is built from.
const _typecheck: BrewResult = { ok: true, code: 0, timedOut: false, tail: "" };
void _typecheck;
