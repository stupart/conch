import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { speakCancellable } from "../src/speak.ts";
import { ManagedTtsWorker, type TtsWorkerProcess } from "../src/tts-worker.ts";
import {
  findConchUv,
  judgeVoiceProbe,
  parseVoiceLock,
  readSetupFailures,
  VOICE_LOCK,
  VOICE_LOCK_TEXT,
  VOICE_PYTHON_FLOOR,
  VoiceEnvManager,
  voiceEnvPaths,
  type NaturalVoicesStatus,
  type VoiceEnvPaths,
  type VoiceProbeOutcome,
  type VoiceProbeReport,
} from "../src/voice-env.ts";

/**
 * conch's natural voices, set up by conch (voice-env.ts). Tyler, 2026-09-27:
 * "the voices are all default Mac — what happened there?" The environment the
 * README had people build by hand ran on Python 3.9 without loguru, and the
 * worker's DLPack conversion then failed on the GPU; the daemon said "using
 * say" 53 times. These pin the rules that make that impossible to repeat
 * silently: which Python wins, that a broken environment is noticed and
 * rebuilt, that rebuilding stops, and that `say` speaks meanwhile.
 */

const repo = (path: string) => join(import.meta.dir, "..", path);
const PYTHON = Bun.which("python3");
const MOCK_WORKER = join(import.meta.dir, "fixtures", "mock-tts-worker.py");
const roots: string[] = [];
const managers: VoiceEnvManager[] = [];
const workers: ManagedTtsWorker[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const worker of workers.splice(0)) worker.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix = "conch-voice-env-test-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A report exactly matching the lock: what a good conch environment prints. */
function goodReport(overrides: Partial<VoiceProbeReport> = {}): VoiceProbeReport {
  const versions: Record<string, string> = {};
  for (const pin of VOICE_LOCK.pins.values()) versions[pin.name] = pin.version;
  return { python: `${VOICE_LOCK.python}.14`, versions, import_error: null, ...overrides };
}

/** The old laptop's tool: Python 3.9, no loguru, Kokoro unimportable. */
function laptopReport(): VoiceProbeReport {
  const report = goodReport({
    python: "3.9.6",
    import_error: "ValueError: Model type kokoro not supported",
  });
  delete report.versions.loguru;
  return report;
}

interface Harness {
  manager: VoiceEnvManager;
  paths: VoiceEnvPaths;
  used: Array<[string | null, string | null]>;
  statuses: NaturalVoicesStatus[];
  probes: string[];
  builds: number;
  sleeps: number[];
  logs: string[];
  setOwn(state: "missing" | "broken" | "good"): void;
}

function harness(options: {
  own?: "missing" | "broken" | "good";
  explicit?: string;
  legacy?: string | null;
  legacyOutcome?: VoiceProbeOutcome;
  build?: (h: Harness) => Promise<void>;
  root?: string;
  now?: () => number;
} = {}): Harness {
  const paths = voiceEnvPaths(options.root ?? tempRoot());
  let own = options.own ?? "missing";
  const h: Harness = {
    manager: null as unknown as VoiceEnvManager,
    paths,
    used: [],
    statuses: [],
    probes: [],
    builds: 0,
    sleeps: [],
    logs: [],
    setOwn: (state) => { own = state; },
  };
  h.manager = new VoiceEnvManager({
    engine: "worker",
    explicitPython: options.explicit ?? "",
    serverBin: "mlx_audio.server",
    model: "mock/Kokoro",
    voices: ["af_heart", "am_adam"],
    speed: 1.35,
    usePython: (python, source) => { h.used.push([python, source]); },
    log: (line) => { h.logs.push(line); },
    onStatus: (status) => { h.statuses.push(status); },
    paths,
    appleSilicon: () => true,
    findUv: () => ({ path: "/fake/Contents/Helpers/uv", source: "CONCH_UV" }),
    resolveExplicit: (value) => value,
    resolveLegacy: () => options.legacy ?? null,
    probe: async (python) => {
      h.probes.push(python);
      if (python === paths.python) {
        if (own === "good") return { report: goodReport() };
        if (own === "broken") return { report: laptopReport() };
        return { error: "is not set up yet" };
      }
      return options.legacyOutcome ?? { report: goodReport({ python: "3.12.14" }) };
    },
    build: async (_uv, progress) => {
      h.builds++;
      progress("installing Kokoro and its packages (3/4)");
      if (options.build) return options.build(h);
      own = "good";
    },
    prefetch: async () => {},
    // Online, unless a test says otherwise: never a real request from a unit test.
    probeNetwork: async () => true,
    sleep: async (ms) => {
      h.sleeps.push(ms);
      return true;
    },
    ...(options.now ? { now: options.now } : {}),
  });
  managers.push(h.manager);
  return h;
}

describe("the lock", () => {
  const lock = parseVoiceLock(readFileSync(repo("src/voice-requirements.txt"), "utf8"));

  test("pins loguru, the spaCy English wheel by URL, mlx-audio 0.2.9, and Python >= 3.10, all hashed", () => {
    const [major, minor] = lock.python.split(".").map(Number);
    expect(major! > VOICE_PYTHON_FLOOR[0] || (major === VOICE_PYTHON_FLOOR[0] && minor! >= VOICE_PYTHON_FLOOR[1])).toBeTrue();
    expect(VOICE_PYTHON_FLOOR).toEqual([3, 10]);
    expect(lock.pins.get("loguru")?.version).toBe("0.7.3");
    expect(lock.pins.get("mlx-audio")?.version).toBe("0.2.9");
    expect(lock.pins.get("en-core-web-sm")).toMatchObject({
      version: "3.8.0",
      url: "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl",
    });
    // The environment proven working on 2026-09-27 was 95 packages; the lock is that set.
    expect(lock.pins.size).toBe(95);
    for (const pin of lock.pins.values()) expect(pin.hashes).toBeGreaterThan(0);
    // What the daemon embeds is this file, and it parses the same.
    expect(VOICE_LOCK_TEXT).toBe(readFileSync(repo("src/voice-requirements.txt"), "utf8"));
    expect(VOICE_LOCK.python).toBe(lock.python);
  });

  test("the lock's Python is the one the lock script resolves for, and the input names loguru", () => {
    const script = readFileSync(repo("scripts/lock-voice-env.sh"), "utf8");
    expect(script).toContain(`VOICE_PYTHON=${lock.python}\n`);
    expect(script).toContain("--generate-hashes");
    const input = readFileSync(repo("src/voice-requirements.in"), "utf8");
    expect(input).toMatch(/^loguru==/m);
  });

  test("a lock without its Python line is refused rather than guessed", () => {
    expect(() => parseVoiceLock("loguru==0.7.3 \\\n    --hash=sha256:" + "a".repeat(64) + "\n")).toThrow(/conch-voice-python/);
  });
});

describe("the worker converts MLX audio in host memory", () => {
  const worker = readFileSync(repo("src/tts-worker.py"), "utf8");

  test("np.array, never np.from_dlpack, for every synthesized chunk", () => {
    // MLX arrays live on the GPU; DLPack refuses them ("Unsupported device in DLTensor").
    expect(worker).not.toMatch(/from_dlpack\s*\(/);
    expect(worker.split("np.array(chunk, dtype=np.float32)").length - 1).toBe(1);
    const synth = worker.slice(worker.indexOf("def synthesize("), worker.indexOf("def run("));
    expect(synth.length).toBeGreaterThan(200);
    expect(synth).toContain("arrays = [host_audio(chunk) for chunk in chunks]");
  });

  test("the conversion guards the shape the WAV writer relies on", () => {
    const helper = worker.slice(worker.indexOf("def host_audio("), worker.indexOf("def synthesize("));
    expect(helper.length).toBeGreaterThan(200);
    expect(helper).toContain("samples.reshape(-1)");
    expect(helper).toContain('raise RuntimeError("Kokoro returned an empty audio chunk")');
    expect(helper).toContain('raise RuntimeError("Kokoro returned non-finite audio samples")');
  });
});

describe("the probe verdict", () => {
  test("conch's own environment passes only as the lock built it", () => {
    expect(judgeVoiceProbe({ report: goodReport() }, "exact")).toEqual({ ok: true, python: `${VOICE_LOCK.python}.14` });

    const noLoguru = goodReport();
    delete noLoguru.versions.loguru;
    expect(judgeVoiceProbe({ report: noLoguru }, "exact")).toEqual({ ok: false, reason: "is off the lock (loguru missing)" });

    const oldNumpy = goodReport();
    oldNumpy.versions.numpy = "2.4.0";
    const numpyVerdict = judgeVoiceProbe({ report: oldNumpy }, "exact");
    expect(numpyVerdict.ok).toBeFalse();
    expect(!numpyVerdict.ok && numpyVerdict.reason).toContain(`numpy 2.4.0 ≠ ${VOICE_LOCK.pins.get("numpy")!.version}`);

    // Distribution names are compared PEP 503-normalised: en_core_web_sm is en-core-web-sm.
    const underscored = goodReport();
    underscored.versions.en_core_web_sm = underscored.versions["en-core-web-sm"]!;
    delete underscored.versions["en-core-web-sm"];
    expect(judgeVoiceProbe({ report: underscored }, "exact").ok).toBeTrue();

    expect(judgeVoiceProbe({ report: goodReport({ python: "3.13.1" }) }, "exact")).toEqual({
      ok: false,
      reason: `runs Python 3.13.1; conch's lock is for ${VOICE_LOCK.python}`,
    });
    expect(judgeVoiceProbe({ report: goodReport({ import_error: "ImportError: no mlx" }) }, "exact")).toEqual({
      ok: false,
      reason: "cannot import Kokoro (ImportError: no mlx)",
    });
    expect(judgeVoiceProbe({ error: "is not set up yet" }, "exact")).toEqual({ ok: false, reason: "is not set up yet" });
  });

  test("the old laptop's environment fails both ways, and says it is the Python", () => {
    for (const mode of ["exact", "usable"] as const) {
      expect(judgeVoiceProbe({ report: laptopReport() }, mode)).toEqual({
        ok: false,
        reason: "runs Python 3.9.6; Kokoro needs 3.10+",
      });
    }
  });

  test("someone else's environment needs only to import Kokoro on 3.10+", () => {
    const theirs = goodReport({ python: "3.11.9" });
    theirs.versions.numpy = "1.26.4";
    delete theirs.versions.fastapi;
    expect(judgeVoiceProbe({ report: theirs }, "usable")).toEqual({ ok: true, python: "3.11.9" });
    expect(judgeVoiceProbe({ report: { ...theirs, import_error: "ModuleNotFoundError: loguru" } }, "usable").ok).toBeFalse();
  });
});

describe("which Python the worker gets", () => {
  test("an explicit CONCH_TTS_WORKER_PYTHON wins over conch's environment and the legacy tool", async () => {
    const h = harness({ explicit: "/custom/bin/python3", own: "good", legacy: "/legacy/bin/python" });
    await h.manager.start();
    expect(h.used).toEqual([["/custom/bin/python3", "explicit"]]);
    expect(h.probes).toEqual([]); // never second-guessed
    expect(h.builds).toBe(0);
    expect(h.manager.snapshot()).toMatchObject({ state: "ready", source: "explicit" });
  });

  test("conch's own environment wins over the legacy tool when it checks out", async () => {
    const h = harness({ own: "good", legacy: "/legacy/bin/python" });
    await h.manager.start();
    expect(h.used).toEqual([[h.paths.python, "conch"]]);
    expect(h.probes).toEqual([h.paths.python]); // the legacy tool was never even probed
    expect(h.builds).toBe(0);
    expect(h.manager.snapshot()).toEqual({
      state: "ready",
      detail: `conch's own environment (Python ${VOICE_LOCK.python}.14)`,
      source: "conch",
    });
  });

  test("the legacy tool speaks while conch builds its own, then conch's takes over", async () => {
    const h = harness({ own: "missing", legacy: "/legacy/bin/python" });
    await h.manager.start();
    expect(h.used).toEqual([["/legacy/bin/python", "legacy"], [h.paths.python, "conch"]]);
    expect(h.builds).toBe(1);
    // What the app shows meanwhile names the step and who is speaking.
    expect(h.statuses).toContainEqual(expect.objectContaining({
      state: "setting-up",
      healing: "first-run",
      detail: "installing Kokoro and its packages (3/4) — using your mlx-audio install until it is ready",
    }));
    expect(h.manager.snapshot()).toMatchObject({ state: "ready", source: "conch" });
  });

  test("a legacy tool that cannot import Kokoro is not used: say speaks until conch's is built", async () => {
    let usedDuringBuild: Array<[string | null, string | null]> = [];
    const h = harness({
      own: "missing",
      legacy: "/old-laptop/bin/python3.9",
      legacyOutcome: { report: laptopReport() },
      build: async (self) => {
        usedDuringBuild = [...self.used];
        self.setOwn("good");
      },
    });
    await h.manager.start();
    expect(usedDuringBuild).toEqual([]); // no interpreter at all while building: say
    expect(h.statuses).toContainEqual(expect.objectContaining({
      state: "setting-up",
      detail: "installing Kokoro and its packages (3/4) — speaking with macOS say until it is ready",
    }));
    expect(h.used).toEqual([[h.paths.python, "conch"]]);
    expect(h.logs.some((line) => line.includes("runs Python 3.9.6; Kokoro needs 3.10+ — not using it"))).toBeTrue();
  });
});

describe("the self-check and self-repair", () => {
  test("a broken environment is noticed at start and rebuilt in the background", async () => {
    const h = harness({ own: "broken" });
    await h.manager.start();
    expect(h.logs).toContain("natural voices: conch's environment runs Python 3.9.6; Kokoro needs 3.10+");
    expect(h.builds).toBe(1);
    expect(h.used).toEqual([[h.paths.python, "conch"]]);
    expect(h.manager.snapshot().state).toBe("ready");
  });

  test("a worker that cannot start on conch's environment gets it re-checked, and a broken one rebuilt", async () => {
    let clock = 0;
    const h = harness({ own: "good", now: () => clock });
    await h.manager.start();
    expect(h.builds).toBe(0);

    h.setOwn("broken");
    h.manager.workerStartFailed("Error: ValueError: Model type kokoro not supported");
    // A second burst failure right away is not a second check: bounded, not a loop.
    h.manager.workerStartFailed("Error: again");
    await h.manager.settled();
    expect(h.used).toEqual([[h.paths.python, "conch"], [null, null], [h.paths.python, "conch"]]);
    expect(h.builds).toBe(1);
    expect(h.probes.filter((python) => python === h.paths.python)).toHaveLength(3); // start, recheck, after build

    // Healthy environment, worker still failing (a GPU fault, say): checked, not rebuilt — the worker retries by
    // itself, and the status says the voices are coming back rather than ready.
    clock += 11 * 60_000;
    h.manager.workerStartFailed("Error: Metal device lost");
    await h.manager.settled();
    expect(h.builds).toBe(1);
    expect(h.logs).toContain("natural voices: the voice worker failed to start (gpu, 1 in a row): Error: Metal device lost");
    expect(h.manager.snapshot()).toMatchObject({ state: "setting-up", healing: "repair", problem: "gpu" });
  });

  test("rebuilding is bounded: three quick attempts, then off with the reason and when it tries again — and a restart waits for that", async () => {
    const root = tempRoot();
    const failing = async () => {
      throw new Error("installing Kokoro and its packages failed: exit 2 — hash mismatch for torch");
    };
    const clock = () => 1_000_000;
    const first = harness({ root, own: "missing", build: failing, now: clock });
    await first.manager.start();
    expect(first.builds).toBe(3);
    expect(first.sleeps).toEqual([60_000, 300_000]);
    expect(first.used).toEqual([]);
    const off = first.manager.snapshot();
    expect(off).toMatchObject({ state: "off", off: "failed", reason: "setup failed", problem: "other" });
    expect(off.detail).toContain("hash mismatch for torch");
    expect(off.detail).toContain("tries again by itself at");
    expect(off.detail).toContain("conch voices setup");
    // Never "until tomorrow": the next try is an hour away.
    expect(off.retryAt! - readSetupFailures(first.paths)!.at).toBe(60 * 60_000);
    expect(readSetupFailures(first.paths)?.count).toBe(3);
    // Published for `conch doctor` in another process.
    expect(JSON.parse(readFileSync(first.paths.status, "utf8"))).toMatchObject({ state: "off", reason: "setup failed", pid: process.pid });

    const restarted = harness({ root, own: "missing", build: failing, now: clock });
    await restarted.manager.start();
    expect(restarted.builds).toBe(0);
    expect(restarted.manager.snapshot()).toMatchObject({ state: "off", reason: "setup failed" });
  });

  test("bounded even when the failure record cannot be written: three builds in one run, then off", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "setup-failures.json")); // a directory: every write of the record fails
    const h = harness({
      root,
      own: "missing",
      build: async () => { throw new Error("installing Kokoro and its packages failed: exit 2 — hash mismatch for torch"); },
      now: () => 1_000_000,
    });
    await h.manager.start();
    expect(readSetupFailures(h.paths)).toBeNull();
    expect(h.builds).toBe(3);
    expect(h.sleeps).toEqual([60_000, 300_000]);
    expect(h.manager.snapshot()).toMatchObject({ state: "off", reason: "setup failed" });
    expect(h.manager.snapshot().detail).toContain("hash mismatch for torch");
  });

  test("with a legacy tool, a failed setup keeps the legacy voices and says why conch's failed", async () => {
    const h = harness({
      own: "missing",
      legacy: "/legacy/bin/python",
      build: async () => { throw new Error("creating the environment failed: exit 1 — hash mismatch for numpy"); },
    });
    await h.manager.start();
    expect(h.used).toEqual([["/legacy/bin/python", "legacy"]]);
    expect(h.manager.snapshot()).toMatchObject({ state: "ready", source: "legacy" });
    expect(h.manager.snapshot().detail).toContain("hash mismatch for numpy");
  });

  test("no uv means off with a reason, not a crash or a loop", async () => {
    const paths = voiceEnvPaths(tempRoot());
    const statuses: NaturalVoicesStatus[] = [];
    const manager = new VoiceEnvManager({
      engine: "worker", explicitPython: "", serverBin: "mlx_audio.server", model: "m", voices: ["af_heart"], speed: 1,
      usePython: () => {}, log: () => {}, onStatus: (status) => statuses.push(status),
      paths, appleSilicon: () => true, findUv: () => null, resolveLegacy: () => null,
      probe: async () => ({ error: "is not set up yet" }),
      build: async () => { throw new Error("must not build without uv"); },
    });
    managers.push(manager);
    await manager.start();
    expect(manager.snapshot()).toMatchObject({ state: "off", off: "failed", reason: "no uv" });
  });

  test("CONCH_TTS=say sets nothing up and says so", async () => {
    const paths = voiceEnvPaths(tempRoot());
    const manager = new VoiceEnvManager({
      engine: "say", explicitPython: "", serverBin: "mlx_audio.server", model: "m", voices: ["af_heart"], speed: 1,
      usePython: () => {}, log: () => {}, paths,
      probe: async () => { throw new Error("must not probe"); },
      build: async () => { throw new Error("must not build"); },
    });
    managers.push(manager);
    await manager.start();
    expect(manager.snapshot()).toMatchObject({ state: "off", off: "choice", reason: "CONCH_TTS=say" });
  });
});

describe("say speaks meanwhile", () => {
  test("while conch's environment builds, speech goes to say and the worker spawns nothing; then the worker gets conch's Python", async () => {
    if (!PYTHON) throw new Error("python3 is required for the worker handover test");
    const spawned: string[][] = [];
    const worker = new ManagedTtsWorker({
      enabled: true,
      model: "mock/Kokoro",
      voices: ["af_heart", "am_adam"],
      speed: 1.35,
      python: null,
      spawn: (command) => {
        spawned.push(command);
        // Stand in for conch's env with the stdlib mock peer; the command it was given is what matters.
        const child = Bun.spawn([PYTHON, "-u", MOCK_WORKER, "--model", "mock/Kokoro", "--record", join(tempRoot(), "r.jsonl")], {
          stdin: "pipe", stdout: "pipe", stderr: "ignore",
        });
        return child as unknown as TtsWorkerProcess;
      },
      startupTimeoutMs: 2_000,
      retryDelaysMs: [0],
      periodicRetryMs: 60_000,
      outputDir: tempRoot(),
      log: () => {},
    });
    workers.push(worker);

    let finishBuild!: () => void;
    const building = new Promise<void>((resolve) => { finishBuild = resolve; });
    let buildStarted!: () => void;
    const started = new Promise<void>((resolve) => { buildStarted = resolve; });
    const h = harness({
      own: "missing",
      build: async (self) => {
        buildStarted();
        await building;
        self.setOwn("good");
      },
    });
    // The daemon's wiring: the manager hands the worker its interpreter.
    const manager = new VoiceEnvManager({
      ...(h.manager as unknown as { options: ConstructorParameters<typeof VoiceEnvManager>[0] }).options,
      usePython: (python) => worker.setPython(python),
    });
    managers.push(manager);
    expect(await worker.start()).toBeFalse(); // the daemon's boot start: nothing to run yet
    const done = manager.start();
    await started;

    const cfg = loadConfig();
    cfg.ttsEngine = "worker";
    const commands: string[][] = [];
    const failures: string[] = [];
    await speakCancellable(cfg, "a turn finished while the voices were setting up", "", {
      worker,
      spawnAudio: (command) => {
        commands.push(command);
        return { exited: Promise.resolve(0), kill() {} };
      },
      onKokoroFailure: (reason) => { failures.push(reason); worker.requestRecovery(reason); },
      warn: () => {},
    }).done;
    expect(commands).toHaveLength(1);
    expect(commands[0]?.[0]).toBe("say");
    expect(failures).toEqual(["readiness-failed"]);
    await worker.settled();
    expect(spawned).toEqual([]); // no retry loop against nothing
    expect(worker.snapshot()).toMatchObject({ status: "down", lastError: "no voice environment yet" });

    finishBuild();
    await done;
    await worker.settled();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.[0]).toBe(h.paths.python);
    expect(worker.isReady()).toBeTrue();
  });

  test("a worker handed no interpreter stays quiet in manual mode and starts on the next prewarm once it has one", async () => {
    const spawned: string[][] = [];
    const worker = new ManagedTtsWorker({
      enabled: true, model: "mock/Kokoro", voices: ["af_heart"], speed: 1.35, python: null,
      spawn: (command) => {
        spawned.push(command);
        return Bun.spawn([PYTHON!, "-u", MOCK_WORKER, "--model", "mock/Kokoro", "--record", join(tempRoot(), "r.jsonl")], {
          stdin: "pipe", stdout: "pipe", stderr: "ignore",
        }) as unknown as TtsWorkerProcess;
      },
      startupTimeoutMs: 2_000, retryDelaysMs: [0], periodicRetryMs: 60_000, outputDir: tempRoot(), log: () => {},
    });
    workers.push(worker);
    worker.unloadAfter(0, "unloaded — manual mode; reloads in auto mode");
    worker.setPython("/voice/env/bin/python");
    await worker.settled();
    expect(spawned).toEqual([]); // D1: manual mode never loads it
    worker.prewarm("auto mode");
    await worker.settled();
    expect(spawned.map((command) => command[0])).toEqual(["/voice/env/bin/python"]);
  });
});

describe("the worker reports a failed start", () => {
  test("a start burst that ends down calls onStartFailed once, with why", async () => {
    if (!PYTHON) throw new Error("python3 is required for the worker start-failure test");
    const failures: string[] = [];
    const worker = new ManagedTtsWorker({
      enabled: true, model: "mock/Kokoro", voices: ["af_heart"], speed: 1.35, python: "/voice/env/bin/python",
      // A handshake that does not match: what an interpreter that cannot load Kokoro amounts to.
      spawn: () => Bun.spawn([PYTHON, "-u", MOCK_WORKER, "--model", "mock/Kokoro", "--record", join(tempRoot(), "r.jsonl"), "--malformed-ready"], {
        stdin: "pipe", stdout: "pipe", stderr: "ignore",
      }) as unknown as TtsWorkerProcess,
      onStartFailed: (error) => failures.push(error),
      startupTimeoutMs: 2_000, retryDelaysMs: [0, 0], periodicRetryMs: 60_000, outputDir: tempRoot(), log: () => {},
    });
    workers.push(worker);
    expect(await worker.start()).toBeFalse();
    expect(failures).toHaveLength(1); // once per burst, not once per attempt
    expect(failures[0]).toContain("ready handshake did not match");
  });
});

describe("finding the uv to build with", () => {
  const executableIn = (set: Set<string>) => (path: string) => set.has(path);

  test("CONCH_UV (what the app hands its daemon) wins while it is there; gone (the app moved), the search goes on", () => {
    const app = "/Applications/conch.app/Contents/Helpers/uv";
    expect(findConchUv({
      env: { CONCH_UV: "/bundle/Contents/Helpers/uv" },
      executable: executableIn(new Set(["/bundle/Contents/Helpers/uv", app])),
      which: () => "/opt/homebrew/bin/uv",
    })).toEqual({ path: "/bundle/Contents/Helpers/uv", source: "CONCH_UV" });
    // Moved to /Applications while this daemon ran: found there, never "no uv".
    expect(findConchUv({
      env: { CONCH_UV: "/missing/uv" },
      executable: executableIn(new Set([app])),
      which: () => "/opt/homebrew/bin/uv",
    })).toEqual({ path: app, source: "conch.app" });
    // Nowhere the app lives: the uv the environment was built with, before one on PATH.
    expect(findConchUv({
      env: { CONCH_UV: "/missing/uv" },
      home: "/Users/someone",
      execPath: "/Users/someone/.bun/bin/bun",
      remembered: "/Volumes/Apps/conch.app/Contents/Helpers/uv",
      executable: executableIn(new Set(["/Volumes/Apps/conch.app/Contents/Helpers/uv", "/opt/homebrew/bin/uv"])),
      which: () => "/opt/homebrew/bin/uv",
    })).toEqual({ path: "/Volumes/Apps/conch.app/Contents/Helpers/uv", source: "record" });
    expect(findConchUv({
      env: { CONCH_UV: "/missing/uv" },
      home: "/Users/someone",
      execPath: "/Users/someone/.bun/bin/bun",
      executable: executableIn(new Set()),
      which: () => null,
    })).toBeNull();
  });

  test("then the installed app's helper, then one beside a compiled conch, then PATH", () => {
    const home = "/Users/someone";
    const app = "/Applications/conch.app/Contents/Helpers/uv";
    const brew = "/opt/homebrew/Cellar/conch/1.0/conch.app/Contents/Helpers/uv";
    const base = { env: {}, home, execPath: "/opt/homebrew/Cellar/conch/1.0/bin/conch", which: () => "/opt/homebrew/bin/uv" };
    expect(findConchUv({ ...base, executable: executableIn(new Set([app, brew, "/opt/homebrew/bin/uv"])) }))
      .toEqual({ path: app, source: "conch.app" });
    expect(findConchUv({ ...base, executable: executableIn(new Set([brew, "/opt/homebrew/bin/uv"])) }))
      .toEqual({ path: brew, source: "conch.app" });
    expect(findConchUv({ ...base, executable: executableIn(new Set(["/opt/homebrew/bin/uv"])) }))
      .toEqual({ path: "/opt/homebrew/bin/uv", source: "PATH" });
    expect(findConchUv({ ...base, executable: executableIn(new Set()) })).toBeNull();
  });
});

describe("the environment conch builds is its own", () => {
  test("uv runs with conch's directories and only uv-managed Python, whatever the shell exported", async () => {
    const { uvEnvironment } = await import("../src/voice-env.ts");
    const paths = voiceEnvPaths("/Users/someone/.cache/conch/voice");
    const env = uvEnvironment(paths, {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy:8080",
      UV_PYTHON_INSTALL_DIR: "/Users/someone/.local/share/uv/python",
      UV_CACHE_DIR: "/Users/someone/.cache/uv",
      UV_TOOL_DIR: "/Users/someone/.local/share/uv/tools",
      VIRTUAL_ENV: "/Users/someone/project/.venv",
      PYTHONPATH: "/Users/someone/lib",
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy:8080",
      UV_PYTHON_INSTALL_DIR: "/Users/someone/.cache/conch/voice/python",
      UV_PYTHON_BIN_DIR: "/Users/someone/.cache/conch/voice/python/bin",
      UV_CACHE_DIR: "/Users/someone/.cache/conch/voice/uv-cache",
      UV_TOOL_DIR: "/Users/someone/.cache/conch/voice/tools",
      UV_MANAGED_PYTHON: "1",
      UV_NO_CONFIG: "1",
    });
    // uv refuses --managed-python beside UV_PYTHON_PREFERENCE: one switch only, inherited or not.
    expect(uvEnvironment(paths, { UV_PYTHON_PREFERENCE: "system" }).UV_PYTHON_PREFERENCE).toBeUndefined();
    expect(env.VIRTUAL_ENV).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
  });

  test("the build runs the pinned steps with the lock, and swaps the environment in whole", async () => {
    const { buildVoiceEnv } = await import("../src/voice-env.ts");
    const paths = voiceEnvPaths(tempRoot());
    const calls: string[][] = [];
    const run = async (argv: string[]) => {
      calls.push(argv);
      if (argv[1] === "venv") {
        mkdirSync(join(argv[2]!, "bin"), { recursive: true });
        writeFileSync(join(argv[2]!, "bin", "python"), "");
      }
      if (argv.includes("-c")) {
        return { code: 0, stdout: JSON.stringify(goodReport()) + "\n", stderr: "", timedOut: false };
      }
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const steps: string[] = [];
    await buildVoiceEnv({ paths, uv: "/fake/uv", run, progress: (step) => steps.push(step) });
    expect(calls.map((argv) => argv.slice(0, 3).join(" "))).toEqual([
      `/fake/uv python install`,
      `/fake/uv venv ${paths.staging}`,
      `/fake/uv pip sync`,
      `${paths.python} -B -I`,
    ]);
    expect(calls[0]).toEqual(["/fake/uv", "python", "install", VOICE_LOCK.python, "--no-bin"]);
    expect(calls[1]).toEqual(["/fake/uv", "venv", paths.staging, "--python", VOICE_LOCK.python, "--relocatable", "--no-project"]);
    expect(calls[2]).toEqual(expect.arrayContaining(["--require-hashes", "--compile-bytecode", paths.requirements]));
    expect(readFileSync(paths.requirements, "utf8")).toBe(VOICE_LOCK_TEXT);
    expect(JSON.parse(readFileSync(paths.record, "utf8"))).toMatchObject({ lock: VOICE_LOCK.id });
    expect(steps.map((step) => step.slice(-5))).toEqual(["(1/4)", "(2/4)", "(3/4)", "(4/4)"]);
  });
});

describe("the daemon wiring", () => {
  test("the published state carries where the natural voices stand, for the app's Settings", async () => {
    const { buildPanelModel, buildPublishedState } = await import("../src/panel.ts");
    const model = buildPanelModel({
      sessions: [],
      sessionStates: new Map(),
      pausedSessionIds: new Set(),
      live: { state: "idle", label: "", partial: "" },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
      now: 10_000,
    });
    const naturalVoices: NaturalVoicesStatus = {
      state: "setting-up",
      detail: "installing Kokoro and its packages (3/4) — speaking with macOS say until it is ready",
    };
    expect(buildPublishedState("device", model, new Map(), new Set(), 10_000, { naturalVoices }).naturalVoices).toEqual(naturalVoices);
    expect("naturalVoices" in buildPublishedState("device", model, new Map(), new Set(), 10_000)).toBeFalse();
  });

  test("the daemon starts its worker with no interpreter and lets voiceEnv hand one over", () => {
    const daemon = readFileSync(repo("src/daemon.ts"), "utf8").replace(/\s+/g, " ");
    expect(daemon).toContain("const ttsWorker = new ManagedTtsWorker({ enabled: cfg.ttsEngine === \"worker\", model: cfg.ttsModel, voices: cfg.ttsVoices, speed: cfg.ttsSpeed, python: null, onStartFailed: (error) => voiceEnv?.workerStartFailed(error), onReady: () => voiceEnv?.workerReady(), healthCheckMs: TTS_WORKER_HEALTH_CHECK_MS, // Null (the default, 30 s) unless scripts/voice-heal-e2e.ts set CONCH_TEST_HOOKS. periodicRetryMs: voiceTestFigure(\"worker-retry-ms\") ?? undefined, log, });");
    // Kokoro's files proved against their own hashes at start, and the download's progress, from the real cache.
    expect(daemon).toContain("verifyModel: (repair, signal, force) => verifyModelCache({ hub: hubCacheDir(), model: cfg.ttsModel, repair, force, signal }),");
    expect(daemon).toContain("modelBytes: () => modelCacheBytes(hubCacheDir(), cfg.ttsModel),");
    expect(daemon).toContain("conchVersion: CONCH_VERSION,");
    expect(daemon).toContain("usePython: (python) => ttsWorker.setPython(python),");
    expect(daemon).toContain("onStatus: (status) => { naturalVoices = status; void renderSessionPanel(); },");
    expect(daemon).toContain("void voiceEnv?.start().catch(");
    expect(daemon).not.toContain("resolveMlxAudioPython(cfg.ttsWorkerPython");
    // Published on every document the panel builds.
    expect(daemon).toContain("screen.showing(), windowPreviews.requests(), naturalVoices, speechEngineStatus, publishedSessionSettingsFor(), );");
  });
});

describe("conch voices setup (the foreground build)", () => {
  test("says why it does nothing: opted out, your own Python, no uv, or a setup already running", async () => {
    const { setUpVoicesNow } = await import("../src/voice-env.ts");
    const paths = voiceEnvPaths(tempRoot());
    const base = {
      engine: "worker" as const, explicitPython: "", model: "m", voices: ["af_heart"], speed: 1, paths,
      appleSilicon: () => true, findUv: () => ({ path: "/fake/uv", source: "CONCH_UV" as const }),
    };
    const run = async (overrides: Partial<Parameters<typeof setUpVoicesNow>[0]>) => {
      const lines: string[] = [];
      const ok = await setUpVoicesNow({ ...base, ...overrides, print: (line) => lines.push(line) });
      return { ok, text: lines.join("\n") };
    };

    expect(await run({ engine: "say" })).toEqual({ ok: false, text: "Natural voices are off (CONCH_TTS=say) — nothing to set up." });
    expect(await run({ explicitPython: "/custom/python" })).toEqual({
      ok: true,
      text: "CONCH_TTS_WORKER_PYTHON is set (/custom/python) — conch uses that Python and builds nothing.",
    });
    expect((await run({ findUv: () => null })).text).toContain("No uv to build with");
    expect((await run({ appleSilicon: () => false })).text).toContain("needs Apple silicon");

    // The daemon (a live pid) holds the setup lock: the foreground build waits its turn rather than racing it.
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.lock, String(process.ppid));
    expect(await run({})).toEqual({
      ok: false,
      text: `conch (pid ${process.ppid}) is setting up the natural voices right now — \`conch doctor\` shows how far it got.`,
    });
  });
});
