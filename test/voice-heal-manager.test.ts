import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedTtsWorker, ttsWorkerStderrPath, type TtsWorkerProcess } from "../src/tts-worker.ts";
import {
  acquireSetupLock,
  buildVoiceEnv,
  macosVersion,
  readSetupFailures,
  recordModelPrefetched,
  VOICE_LOCK,
  VoiceEnvManager,
  voiceEnvPaths,
  voiceFreeBytes,
  type NaturalVoicesStatus,
  type VoiceEnvPaths,
  type VoiceFingerprint,
} from "../src/voice-env.ts";
import type { ModelCacheCheck } from "../src/voice-model-cache.ts";

/**
 * The natural voices heal themselves (voice-env.ts running voice-heal.ts's rules): each way they could end up on `say`
 * for good, driven through the manager with its seams, and each asserted to reach "ready" with no Try again — or, for a
 * limit of this Mac, to say so once and stop. No network, no uv, no Python: every edge is injected.
 */

const PYTHON = Bun.which("python3");
const MOCK_WORKER = join(import.meta.dir, "fixtures", "mock-tts-worker.py");
const roots: string[] = [];
const closers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const closer of closers.splice(0)) closer.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "conch-voice-heal-test-"));
  roots.push(root);
  return root;
}

function goodReport() {
  const versions: Record<string, string> = {};
  for (const pin of VOICE_LOCK.pins.values()) versions[pin.name] = pin.version;
  return { python: `${VOICE_LOCK.python}.14`, versions, import_error: null };
}

async function until(what: string, check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}

interface World {
  own: "missing" | "good" | "broken";
  online: boolean;
  free: number | null;
  clock: number;
  /** What each build does: throw to fail it. */
  build: (world: World, paths: VoiceEnvPaths) => Promise<void>;
  prefetch: (world: World) => Promise<void>;
  model: ModelCacheCheck;
  fingerprint: VoiceFingerprint;
  conch: string;
  unpacked: number;
}

function heal(overrides: Partial<World> & { root?: string; legacy?: string | null } = {}) {
  const paths = voiceEnvPaths(overrides.root ?? tempRoot());
  const world: World = {
    own: "missing",
    online: true,
    free: 50_000_000_000,
    clock: 1_000_000,
    build: async (self) => { self.own = "good"; },
    prefetch: async () => {},
    model: { ok: true, absent: false, files: 3, broken: [], removed: [] },
    fingerprint: { macos: macosVersion(), uv: "/app/uv:1:2", python: "/py:1:2" },
    conch: "1.0.0",
    unpacked: 0,
    ...overrides,
  };
  const statuses: NaturalVoicesStatus[] = [];
  const used: Array<[string | null, string | null]> = [];
  const logs: string[] = [];
  let builds = 0;
  let prefetches = 0;
  const manager = new VoiceEnvManager({
    engine: "worker", explicitPython: "", serverBin: "mlx_audio.server", model: "mock/Kokoro", voices: ["af_heart"], speed: 1.35,
    usePython: (python, source) => { used.push([python, source]); },
    log: (line) => { logs.push(line); },
    onStatus: (status) => { statuses.push(status); },
    paths,
    appleSilicon: () => true,
    findUv: () => ({ path: "/app/Contents/Helpers/uv", source: "CONCH_UV" }),
    resolveLegacy: () => overrides.legacy ?? null,
    probe: async (python) => {
      if (python !== paths.python) return { report: goodReport() };
      if (world.own === "good") return { report: goodReport() };
      if (world.own === "broken") return { report: { ...goodReport(), import_error: "ImportError: dlopen(core.so): Library not loaded: @rpath/libmlx.dylib" } };
      return { error: "is not set up yet" };
    },
    build: async (_uv, progress) => {
      builds++;
      progress("installing Kokoro and its packages (3/4)", { step: 3, steps: 4 });
      await world.build(world, paths);
    },
    prefetch: async () => {
      prefetches++;
      await world.prefetch(world);
      world.model = { ok: true, absent: false, files: 3, broken: [], removed: [] };
    },
    verifyModel: async () => world.model,
    modelBytes: () => 0,
    packagesUnpacked: () => world.unpacked,
    probeNetwork: async () => world.online,
    freeBytes: () => world.free,
    fingerprint: () => world.fingerprint,
    conchVersion: world.conch,
    sleep: async () => true,
    now: () => world.clock,
    watchMs: 3,
  });
  closers.push(manager);
  return {
    manager, paths, world, statuses, used, logs,
    builds: () => builds,
    prefetches: () => prefetches,
    last: () => manager.snapshot(),
  };
}

const uvOffline = "installing Python 3.12 failed: exit 2 — error: Failed to download `https://github.com/astral-sh/python-build-standalone/…` | Caused by: error sending request for url | Caused by: client error (Connect) | Caused by: dns error: failed to lookup address information: nodename nor servname provided, or not known";

describe("a first run offline, or on a connection that drops", () => {
  test("waits for the network, says so quietly, and finishes by itself when it's back — never counted", async () => {
    const h = heal({ online: false, build: async (world) => { if (!world.online) throw new Error(uvOffline); world.own = "good"; } });
    await h.manager.start();
    expect(h.last()).toMatchObject({ state: "setting-up", healing: "first-run", waiting: "network", problem: "offline" });
    expect(h.builds()).toBe(1);
    expect(readSetupFailures(h.paths)).toBeNull();
    // A long time offline changes nothing: it is waiting, not failing.
    h.world.clock += 24 * 60 * 60_000;
    await Bun.sleep(20);
    expect(h.last().state).toBe("setting-up");
    expect(h.builds()).toBe(1);

    h.world.online = true;
    await until("ready", () => h.last().state === "ready");
    expect(h.builds()).toBe(2);
    expect(h.logs).toContain("natural voices: the network is back — carrying on");
    expect(h.used.at(-1)).toEqual([h.paths.python, "conch"]);
  });

  test("an unknown failure while the network is down is the network's", async () => {
    const h = heal({ online: false, build: async (world) => { if (!world.online) throw new Error("exit 2 — something odd"); world.own = "good"; } });
    await h.manager.start();
    expect(h.last()).toMatchObject({ waiting: "network" });
    expect(readSetupFailures(h.paths)).toBeNull();
  });

  test("the voices' own download waits for the network the same way", async () => {
    const h = heal({
      own: "good",
      online: false,
      model: { ok: false, absent: true, files: 0, broken: [], removed: [] },
      prefetch: async (world) => { if (!world.online) throw new Error("Error: requests.exceptions.ConnectionError: Max retries exceeded"); },
    });
    await h.manager.start();
    expect(h.last()).toMatchObject({ state: "setting-up", waiting: "network", stage: "prefetch" });
    h.world.online = true;
    await until("ready", () => h.last().state === "ready");
    expect(h.prefetches()).toBe(2);
  });

  test("an attempt that got further than the last (a slow connection) is not counted", async () => {
    let attempts = 0;
    const h = heal({
      build: async (world) => {
        attempts++;
        world.unpacked += 20;
        if (attempts < 3) throw new Error("installing Kokoro and its packages failed: exit 2 — stream ended unexpectedly");
        world.own = "good";
      },
    });
    await h.manager.start();
    expect(h.last().state).toBe("ready");
    expect(h.builds()).toBe(3);
    expect(h.logs.filter((line) => line.includes("failed (interrupted)"))).toHaveLength(2);
  });
});

describe("a half-finished build", () => {
  test("killed mid-install: noticed, cleaned up, built again — never counted", async () => {
    const root = tempRoot();
    const paths = voiceEnvPaths(root);
    mkdirSync(join(paths.staging, "lib"), { recursive: true });
    mkdirSync(`${paths.env}.old-4242`, { recursive: true });
    const h = heal({ root });
    await h.manager.start();
    expect(h.logs.some((line) => line.startsWith("natural voices: a setup was interrupted (env.building, env.old-4242 left behind)"))).toBeTrue();
    expect(h.last().state).toBe("ready");
    expect(readSetupFailures(h.paths)).toBeNull();
  });

  test("an environment set aside mid-swap is removed even when nothing needs building", async () => {
    const root = tempRoot();
    const paths = voiceEnvPaths(root);
    mkdirSync(join(`${paths.env}.old-4242`, "lib"), { recursive: true });
    const h = heal({ root, own: "good" });
    await h.manager.start();
    expect(h.builds()).toBe(0);
    expect(h.last().state).toBe("ready");
    expect(existsSync(`${paths.env}.old-4242`)).toBeFalse();
  });

  test("the build itself clears what an interrupted one left, and leaves nothing half built when a step fails", async () => {
    const paths = voiceEnvPaths(tempRoot());
    mkdirSync(join(paths.staging, "bin"), { recursive: true });
    mkdirSync(`${paths.env}.old-99`, { recursive: true });
    const run = async (argv: string[]) => {
      if (argv[1] === "venv") mkdirSync(join(argv[2]!, "bin"), { recursive: true });
      if (argv[2] === "sync") return { code: 2, stdout: "", stderr: "error: No space left on device (os error 28)", timedOut: false };
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    await expect(buildVoiceEnv({ paths, uv: "/fake/uv", run })).rejects.toThrow(/No space left on device/);
    expect(existsSync(`${paths.env}.old-99`)).toBeFalse();
    expect(existsSync(paths.staging)).toBeFalse(); // its room back at once
    expect(readFileSync(paths.log, "utf8")).toContain("cleaned up after an interrupted build");
  });

  test("disk full part way: says so, waits for room, and carries on by itself when there is some — never counted", async () => {
    const h = heal({
      free: 2_000_000_000,
      build: async (world, paths) => {
        mkdirSync(paths.staging, { recursive: true });
        if (world.free! < 3_000_000_000) throw new Error("installing Kokoro and its packages failed: exit 2 — No space left on device (os error 28)");
        world.own = "good";
      },
    });
    await h.manager.start();
    expect(h.last()).toMatchObject({ state: "setting-up", waiting: "space", problem: "no-space" });
    expect(existsSync(h.paths.staging)).toBeFalse();
    expect(readSetupFailures(h.paths)).toBeNull();
    // The same room as before: it keeps waiting rather than failing the same way again.
    await Bun.sleep(20);
    expect(h.builds()).toBe(1);
    h.world.free = 3_500_000_000;
    await until("ready", () => h.last().state === "ready");
    expect(h.builds()).toBe(2);
  });
});

describe("the count of attempts, and when it starts over", () => {
  const failing = async (world: World) => {
    if ((world as World & { fixed?: boolean }).fixed) {
      world.own = "good";
      return;
    }
    throw new Error("installing Kokoro and its packages failed: exit 2 — hash mismatch for torch");
  };

  test("after three failed attempts it says so, then tries again by itself after the cool-down", async () => {
    const h = heal({ build: failing });
    await h.manager.start();
    expect(h.builds()).toBe(3);
    const off = h.last();
    expect(off).toMatchObject({ state: "off", off: "failed", reason: "setup failed" });
    expect(h.used.at(-1)?.[0] ?? null).toBeNull();
    // Whatever broke is fixed meanwhile (a server hiccup); the hour passes.
    (h.world as World & { fixed?: boolean }).fixed = true;
    h.world.clock = off.retryAt! + 1;
    await until("ready", () => h.last().state === "ready");
    expect(h.builds()).toBe(4);
    expect(readSetupFailures(h.paths)).toBeNull();
  });

  test("voices that come back by any road clear the count: here the model's download, failed once, then fetched", async () => {
    let fetches = 0;
    const h = heal({
      own: "good",
      model: { ok: false, absent: true, files: 0, broken: [], removed: [] },
      prefetch: async () => { if (++fetches === 1) throw new Error("Error: RuntimeError: something unexpected in the voice worker"); },
    });
    await h.manager.start();
    expect(h.prefetches()).toBe(2);
    expect(h.last().state).toBe("ready");
    expect(readSetupFailures(h.paths)).toBeNull();
  });

  test("an update starts the count over: a restart on a new conch builds at once", async () => {
    const root = tempRoot();
    const first = heal({ root, build: failing });
    await first.manager.start();
    expect(first.last().state).toBe("off");
    first.manager.close();
    const updated = heal({ root, conch: "1.0.1", build: async (world) => { world.own = "good"; } });
    await updated.manager.start();
    expect(updated.builds()).toBe(1);
    expect(updated.last().state).toBe("ready");
    expect(updated.logs).toContain("natural voices: the count of failed attempts starts over — conch, its uv or macOS changed");
  });

  test("the disk freeing up starts it over, by itself — when it was tight", async () => {
    const h = heal({ build: failing, free: 2_000_000_000 });
    await h.manager.start();
    expect(h.last().state).toBe("off");
    (h.world as World & { fixed?: boolean }).fixed = true;
    h.world.free = h.world.free! + 2_000_000_000;
    await until("ready", () => h.last().state === "ready");
    expect(h.logs).toContain("natural voices: the count of failed attempts starts over — the disk has more room");
  });

  test("the network coming back starts it over, by itself", async () => {
    const h = heal({ build: failing });
    await h.manager.start();
    expect(h.last().state).toBe("off");
    (h.world as World & { fixed?: boolean }).fixed = true;
    h.world.online = false;
    await Bun.sleep(80); // long enough for the cool-down's watch to look at the network and find it gone
    h.world.online = true;
    await until("ready", () => h.last().state === "ready");
    expect(h.logs).toContain("natural voices: the count of failed attempts starts over — the network came back");
  });

  test("Try again starts it over now, from any wait; not while ready", async () => {
    const h = heal({ build: failing });
    await h.manager.start();
    (h.world as World & { fixed?: boolean }).fixed = true;
    expect(h.manager.retry()).toBeTrue();
    await h.manager.settled();
    expect(h.last().state).toBe("ready");
    expect(h.manager.retry()).toBeFalse();
  });
});

describe("the worker, at start and later", () => {
  test("GPU failures: retried by the worker, the environment rebuilt once, then set aside and tried again on the count's clock", async () => {
    const h = heal({ own: "good" });
    await h.manager.start();
    expect(h.last().state).toBe("ready");
    const metal = "Error: RuntimeError: [METAL] Command buffer execution failed: Insufficient Memory";
    h.manager.workerStartFailed(metal);
    await h.manager.settled();
    expect(h.last()).toMatchObject({ state: "setting-up", healing: "repair", problem: "gpu" });
    expect(h.builds()).toBe(0);
    h.manager.workerStartFailed(metal);
    h.manager.workerStartFailed(metal);
    await h.manager.settled();
    expect(h.builds()).toBe(1); // three bursts: rebuilt once
    expect(h.used).toEqual([[h.paths.python, "conch"], [null, null], [h.paths.python, "conch"]]);

    for (let i = 0; i < 3; i++) h.manager.workerStartFailed(metal);
    await h.manager.settled();
    // Still failing on a fresh environment: set aside (counted), then given its interpreter back after the quick delay.
    expect(h.builds()).toBe(1);
    expect(h.logs.some((line) => line.includes("kept failing after a rebuild"))).toBeTrue();
    expect(h.used.slice(-2)).toEqual([[null, null], [h.paths.python, "conch"]]);
    expect(readSetupFailures(h.paths)).toMatchObject({ count: 1, kind: "gpu" });

    // It comes up warm: ready, and the count is cleared.
    h.manager.workerReady();
    expect(h.last()).toMatchObject({ state: "ready", source: "conch" });
    expect(readSetupFailures(h.paths)).toBeNull();
  });

  test("macOS changed under the environment: one failed burst rebuilds it", async () => {
    const root = tempRoot();
    const paths = voiceEnvPaths(root);
    mkdirSync(paths.env, { recursive: true });
    writeFileSync(paths.record, JSON.stringify({ lock: VOICE_LOCK.id, python: "3.12.14", uv: "/app/Contents/Helpers/uv", fingerprint: { macos: "darwin 24.0.0", uv: "/app/uv:1:2", python: "/py:1:2" } }));
    const h = heal({ root, own: "good" });
    await h.manager.start();
    expect(h.logs).toContain("natural voices: macos changed since the environment was built — a failing worker rebuilds it at once");
    h.manager.workerStartFailed("Error: RuntimeError: [metal::Device] Unable to build metal library");
    await h.manager.settled();
    expect(h.builds()).toBe(1);
  });

  test("a library that no longer loads (a macOS or Python update): rebuilt at once", async () => {
    const h = heal({ own: "good" });
    await h.manager.start();
    h.world.own = "broken";
    h.manager.workerStartFailed("Error: ImportError: dlopen(core.so): Library not loaded: @rpath/libmlx.dylib");
    await h.manager.settled();
    expect(h.builds()).toBe(1);
  });

  test("a limit of this Mac (no Metal device) is said once, the worker stopped, never looped", async () => {
    const h = heal({ own: "good" });
    await h.manager.start();
    h.manager.workerStartFailed("Error: RuntimeError: [metal::Device] Failed to load device");
    await h.manager.settled();
    expect(h.last()).toMatchObject({ state: "off", off: "unsupported", reason: "no Metal GPU" });
    expect(h.used.at(-1)).toEqual([null, null]);
    await Bun.sleep(20);
    expect(h.builds()).toBe(0);
  });

  test("damaged model files: found at start, only those fetched again", async () => {
    const root = tempRoot();
    const paths = voiceEnvPaths(root);
    mkdirSync(root, { recursive: true });
    recordModelPrefetched(paths, "mock/Kokoro", ["af_heart"]);
    const h = heal({ root, own: "good", model: { ok: false, absent: false, files: 3, broken: ["kokoro-v1_0.safetensors"], removed: ["x", "y"] } });
    await h.manager.start();
    expect(h.logs.some((line) => line.includes("1 of Kokoro's files were damaged or missing (kokoro-v1_0.safetensors)"))).toBeTrue();
    expect(h.prefetches()).toBe(1);
    expect(h.last().state).toBe("ready");
  });

  test("a worker that fails on the model later gets it checked — forced, since it failed on it — and re-fetched", async () => {
    const h = heal({ own: "good" });
    const forced: boolean[] = [];
    const verify = (h.manager as unknown as { options: { verifyModel: (repair: boolean, signal: AbortSignal, force?: boolean) => Promise<ModelCacheCheck> } }).options;
    const original = verify.verifyModel;
    verify.verifyModel = (repair, signal, force) => { forced.push(Boolean(force)); return original(repair, signal, force); };
    await h.manager.start();
    h.world.model = { ok: false, absent: false, files: 3, broken: ["voices/af_heart.safetensors"], removed: ["a"] };
    h.manager.workerStartFailed("Error: safetensors_rust.SafetensorError: Error while deserializing header: HeaderTooLarge");
    await h.manager.settled();
    // Once at start (never fetched on this Mac), once more for the damaged voice.
    expect(h.prefetches()).toBe(2);
    expect(forced).toEqual([false, true]);
  });

  test("the app moved or was updated (its uv changed): relinked, nothing rebuilt", async () => {
    const root = tempRoot();
    const paths = voiceEnvPaths(root);
    mkdirSync(paths.env, { recursive: true });
    writeFileSync(paths.record, JSON.stringify({ lock: VOICE_LOCK.id, python: "3.12.14", uv: "/old/conch.app/Contents/Helpers/uv", fingerprint: { macos: macosVersion(), uv: "/old/uv:1:2", python: "/py:1:2" } }));
    const h = heal({ root, own: "good" });
    await h.manager.start();
    expect(h.builds()).toBe(0);
    expect(h.last().state).toBe("ready");
    expect(h.logs.some((line) => line.includes("conch's uv moved or changed (/old/conch.app/Contents/Helpers/uv → /app/Contents/Helpers/uv) — relinked"))).toBeTrue();
    expect(JSON.parse(readFileSync(paths.record, "utf8"))).toMatchObject({ uv: "/app/Contents/Helpers/uv", fingerprint: { uv: "/app/uv:1:2" } });
  });
});

describe("one provisioner at a time, without waiting forever", () => {
  test("a lock its holder stopped touching is taken over, even when its pid is alive (reused)", () => {
    const paths = voiceEnvPaths(tempRoot());
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.lock, String(process.ppid));
    expect(acquireSetupLock(paths)).toEqual({ heldBy: process.ppid });
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(paths.lock, old, old);
    const taken = acquireSetupLock(paths);
    expect("release" in taken).toBeTrue();
    if ("release" in taken) taken.release();
    expect(existsSync(paths.lock)).toBeFalse();
  });
});

describe("the end-to-end test's hooks are inert unless it sets them", () => {
  test("free space comes from the disk unless CONCH_TEST_HOOKS names a folder with a figure in it", () => {
    const hooks = tempRoot();
    const real = voiceFreeBytes(hooks, {});
    expect(real).toBeGreaterThan(0);
    // The switch alone, with no figure in the folder, is still the disk.
    expect(voiceFreeBytes(hooks, { CONCH_TEST_HOOKS: hooks })).toBeGreaterThan(123456);
    writeFileSync(join(hooks, "free-bytes"), "123456\n");
    expect(voiceFreeBytes(hooks, { CONCH_TEST_HOOKS: hooks })).toBe(123456);
    expect(voiceFreeBytes(hooks, {})).not.toBe(123456);
  });

  test("the real worker fakes a Metal failure only when told to, and counts it down", () => {
    if (!PYTHON) throw new Error("python3 is required");
    const hooks = tempRoot();
    const worker = join(import.meta.dir, "..", "src", "tts-worker.py");
    const run = (env: Record<string, string>) => {
      const out = Bun.spawnSync([PYTHON, "-B", worker, "--model", "mock/Kokoro"], { env: { PATH: "/usr/bin:/bin", ...env }, stdin: "ignore" });
      return JSON.parse(out.stdout.toString().trim().split("\n").at(-1)!) as { type: string; error: string };
    };
    // Unset: nothing faked — this Python simply has no mlx_audio.
    expect(run({}).error).toContain("mlx_audio");
    writeFileSync(join(hooks, "worker-fault"), "1 [metal::Device] Unable to build metal library from source\n");
    expect(run({ CONCH_TEST_HOOKS: hooks })).toEqual({ type: "fatal", protocol: 1, error: "RuntimeError: [metal::Device] Unable to build metal library from source" } as never);
    expect(readFileSync(join(hooks, "worker-fault"), "utf8").trim()).toStartWith("0 ");
    expect(run({ CONCH_TEST_HOOKS: hooks }).error).toContain("mlx_audio");
  });
});

describe("the worker checks its own health, continuously", () => {
  const spawnMock = (flags: string[], spawned: string[][]) => (command: string[]) => {
    spawned.push(command);
    return Bun.spawn([PYTHON!, "-u", MOCK_WORKER, "--model", "mock/Kokoro", "--record", join(tempRoot(), "r.jsonl"), ...flags], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
    }) as unknown as TtsWorkerProcess;
  };

  test("an idle warm worker is asked for one tiny line, which is deleted unplayed; a start reports ready", async () => {
    if (!PYTHON) throw new Error("python3 is required");
    const spawned: string[][] = [];
    let ready = 0;
    const outputDir = tempRoot();
    const worker = new ManagedTtsWorker({
      enabled: true, model: "mock/Kokoro", voices: ["af_heart"], speed: 1.35, python: "/voice/env/bin/python",
      spawn: spawnMock([], spawned), onReady: () => { ready++; },
      healthCheckMs: 40, startupTimeoutMs: 2_000, retryDelaysMs: [0], periodicRetryMs: 60_000, outputDir, log: () => {},
    });
    closers.push(worker);
    expect(await worker.start()).toBeTrue();
    expect(ready).toBe(1);
    await until("a health check", () => worker.snapshot().requests >= 1);
    await Bun.sleep(30);
    expect(worker.isReady()).toBeTrue();
    expect(spawned).toHaveLength(1);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(outputDir).filter((name) => name.endsWith(".wav"))).toEqual([]);
  });

  test("a worker that started and then broke is found by its health check and restarted", async () => {
    if (!PYTHON) throw new Error("python3 is required");
    const spawned: string[][] = [];
    const logs: string[] = [];
    const worker = new ManagedTtsWorker({
      enabled: true, model: "mock/Kokoro", voices: ["af_heart"], speed: 1.35, python: "/voice/env/bin/python",
      spawn: spawnMock(["--fail-synth"], spawned),
      healthCheckMs: 40, startupTimeoutMs: 2_000, retryDelaysMs: [0], periodicRetryMs: 60_000, outputDir: tempRoot(), log: (line) => logs.push(line),
    });
    closers.push(worker);
    expect(await worker.start()).toBeTrue();
    await until("a restart", () => spawned.length >= 2);
    expect(logs.some((line) => line.includes("hard restart: health check failed: RuntimeError: [METAL] Command buffer execution failed"))).toBeTrue();
  });

  test("a turn's line waits out a health check rather than being refused as busy", async () => {
    if (!PYTHON) throw new Error("python3 is required");
    // Each line takes 200 ms, so the turn's line surely arrives while the health check's is still running.
    const worker = new ManagedTtsWorker({
      enabled: true, model: "mock/Kokoro", voices: ["af_heart"], speed: 1.35, python: "/voice/env/bin/python",
      spawn: spawnMock(["--slow-ms", "200"], []), healthCheckMs: 20, startupTimeoutMs: 2_000, retryDelaysMs: [0], periodicRetryMs: 60_000, outputDir: tempRoot(), log: () => {},
    });
    closers.push(worker);
    expect(await worker.start()).toBeTrue();
    await until("the health check to be under way", () => worker.snapshot().requests >= 1);
    const result = await worker.synthesize({ text: "a turn finished", voice: "af_heart", speed: 1.35, timeoutMs: 2_000 });
    expect(result.samples).toBeGreaterThan(0);
    expect(worker.snapshot().requests).toBe(2);
    rmSync(result.path, { force: true });
  });

  test("its stderr goes beside the daemon's log, so a daemon run elsewhere never writes the live one's", () => {
    expect(ttsWorkerStderrPath({})).toBe("/tmp/conch-kokoro-worker.err.log");
    expect(ttsWorkerStderrPath({ CONCH_LOG_FILE: "/tmp/e2e-x/daemon.log" })).toBe("/tmp/e2e-x/conch-kokoro-worker.err.log");
  });
});
