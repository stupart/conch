import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  ManagedTtsWorker,
  resolveMlxAudioPython,
  TtsWorkerTimeoutError,
  TtsWorkerUnavailableError,
  type TtsWorkerProcess,
} from "../src/tts-worker.ts";
import { parseWav } from "../src/tts-wav.ts";

const MODEL = "mock/Kokoro";
const MOCK_WORKER = join(import.meta.dir, "fixtures", "mock-tts-worker.py");
const PYTHON = Bun.which("python3");
const roots: string[] = [];
const harnesses: WorkerHarness[] = [];

interface WorkerHarness {
  worker: ManagedTtsWorker;
  root: string;
  recordPath: string;
  pids: number[];
  exits: Promise<number>[];
  kills: Array<{ pid: number; signal: number | NodeJS.Signals | undefined }>;
}

function makeHarness(options: {
  wedgeFlush?: boolean;
  malformedReady?: boolean;
} = {}): WorkerHarness {
  if (!PYTHON) throw new Error("python3 is required for the TTS worker protocol test");
  const root = mkdtempSync(join(tmpdir(), "conch-tts-worker-test-"));
  roots.push(root);
  const recordPath = join(root, "requests.jsonl");
  const pids: number[] = [];
  const exits: Promise<number>[] = [];
  const kills: WorkerHarness["kills"] = [];
  const spawn = (command: string[]): TtsWorkerProcess => {
    const child = Bun.spawn(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    pids.push(child.pid);
    exits.push(child.exited);
    return {
      pid: child.pid,
      stdin: {
        write(data) {
          const written = child.stdin.write(data);
          return typeof written === "number" ? written : 0;
        },
        flush: () => {
          const flushed = child.stdin.flush();
          if (!options.wedgeFlush) return flushed;
          void Promise.resolve(flushed).catch(() => {});
          return new Promise<number>(() => {});
        },
        end: () => child.stdin.end(),
      },
      stdout: child.stdout,
      exited: child.exited,
      kill(signal) {
        kills.push({ pid: child.pid, signal });
        child.kill(signal);
      },
      unref() {
        child.unref();
      },
    };
  };
  const command = [PYTHON, "-u", MOCK_WORKER, "--model", MODEL, "--record", recordPath];
  if (options.malformedReady) command.push("--malformed-ready");
  const worker = new ManagedTtsWorker({
    enabled: true,
    model: MODEL,
    voices: ["af_heart", "am_adam"],
    speed: 1.35,
    command,
    spawn,
    startupTimeoutMs: 2_000,
    retryDelaysMs: [0],
    periodicRetryMs: 1_000,
    outputDir: root,
    log() {},
  });
  const harness = { worker, root, recordPath, pids, exits, kills };
  harnesses.push(harness);
  return harness;
}

async function closeHarness(harness: WorkerHarness): Promise<void> {
  harness.worker.close();
  await Promise.allSettled(harness.exits);
}

function request(
  worker: ManagedTtsWorker,
  text: string,
  timeoutMs = 1_000,
) {
  return worker.synthesize({
    text,
    voice: "af_heart",
    speed: 1.35,
    timeoutMs,
  });
}

function protocolRecords(path: string): Array<{
  mock_pid: number;
  request: Record<string, unknown>;
}> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("condition did not become true before timeout");
    await Bun.sleep(5);
  }
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await closeHarness(harness);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("managed TTS worker JSONL protocol", () => {
  test("round-trips Unicode, newlines, and quotes across two requests on one warm Python PID", async () => {
    const harness = makeHarness();
    const text = "Hello, 海 🐚.\nShe said \"warm worker\" and used \\\\ safely.";
    let firstPath = "";
    let secondPath = "";
    try {
      expect(await harness.worker.start()).toBeTrue();
      const warmPid = harness.worker.snapshot().pid;
      if (warmPid === null) throw new Error("mock worker did not expose a PID");
      expect(harness.worker.availableVoices()).toEqual(["af_heart", "am_adam"]);

      const first = await request(harness.worker, text);
      const second = await request(harness.worker, "Second request, same model.");
      firstPath = first.path;
      secondPath = second.path;

      expect(harness.worker.snapshot()).toMatchObject({
        status: "ready",
        pid: warmPid,
        requests: 2,
        spawnAttempts: 1,
      });
      expect(harness.pids).toEqual([warmPid]);
      expect(first).toMatchObject({ sampleRate: 16_000, samples: 160, latencyMs: 1 });
      expect(second).toMatchObject({ sampleRate: 16_000, samples: 160, latencyMs: 1 });
      for (const path of [first.path, second.path]) {
        const parsed = parseWav(new Uint8Array(readFileSync(path)));
        expect(parsed).toMatchObject({
          format: 1,
          channels: 1,
          sampleRate: 16_000,
          bitsPerSample: 16,
        });
        expect(parsed?.data.byteLength).toBe(320);
      }

      const records = protocolRecords(harness.recordPath);
      expect(records).toHaveLength(2);
      expect(records.map((record) => record.mock_pid)).toEqual([warmPid, warmPid]);
      expect(records[0]?.request).toMatchObject({
        op: "synthesize",
        text,
        voice: "af_heart",
        speed: 1.35,
      });
      expect(records[1]?.request).toMatchObject({
        op: "synthesize",
        text: "Second request, same model.",
      });
    } finally {
      for (const path of [firstPath, secondPath]) {
        if (path) {
          try { unlinkSync(path); } catch {}
        }
      }
      await closeHarness(harness);
    }
  });

  test("a hung request is SIGKILLed, replaced, and the next request succeeds", async () => {
    const harness = makeHarness();
    let recoveredPath = "";
    try {
      expect(await harness.worker.start()).toBeTrue();
      const firstPid = harness.worker.snapshot().pid!;
      const firstGeneration = harness.worker.snapshot().generation;

      await expect(request(harness.worker, "__hang__", 40))
        .rejects.toBeInstanceOf(TtsWorkerTimeoutError);
      await harness.worker.settled();

      expect(harness.kills).toContainEqual({ pid: firstPid, signal: "SIGKILL" });
      expect(harness.pids).toHaveLength(2);
      expect(harness.worker.snapshot()).toMatchObject({
        status: "ready",
        hardRestarts: 1,
        spawnAttempts: 2,
      });
      expect(harness.worker.snapshot().generation).toBeGreaterThan(firstGeneration);

      const recovered = await request(harness.worker, "healthy after timeout");
      recoveredPath = recovered.path;
      expect(parseWav(new Uint8Array(readFileSync(recovered.path)))).not.toBeNull();
      expect(protocolRecords(harness.recordPath).map((record) => record.request.text))
        .toEqual(["__hang__", "healthy after timeout"]);
    } finally {
      if (recoveredPath) {
        try { unlinkSync(recoveredPath); } catch {}
      }
      await closeHarness(harness);
    }
  });

  test("a wedged stdin flush cannot hide the request timeout from the caller", async () => {
    const harness = makeHarness({ wedgeFlush: true });
    try {
      expect(await harness.worker.start()).toBeTrue();
      const firstPid = harness.worker.snapshot().pid!;

      await expect(request(harness.worker, "__hang__", 40))
        .rejects.toBeInstanceOf(TtsWorkerTimeoutError);
      await harness.worker.settled();

      expect(harness.kills).toContainEqual({ pid: firstPid, signal: "SIGKILL" });
      expect(harness.worker.snapshot()).toMatchObject({
        status: "ready",
        hardRestarts: 1,
        spawnAttempts: 2,
      });
    } finally {
      await closeHarness(harness);
    }
  });

  test("a child crash fails the active request and starts a usable replacement", async () => {
    const harness = makeHarness();
    let recoveredPath = "";
    try {
      expect(await harness.worker.start()).toBeTrue();
      const firstGeneration = harness.worker.snapshot().generation;

      await expect(request(harness.worker, "__crash__"))
        .rejects.toThrow(/worker protocol stdout closed|Kokoro worker exited/);
      await harness.worker.settled();

      expect(harness.pids).toHaveLength(2);
      expect(harness.worker.snapshot()).toMatchObject({
        status: "ready",
        spawnAttempts: 2,
      });
      expect(harness.worker.snapshot().generation).toBeGreaterThan(firstGeneration);

      const recovered = await request(harness.worker, "healthy after crash");
      recoveredPath = recovered.path;
      expect(parseWav(new Uint8Array(readFileSync(recovered.path)))).not.toBeNull();
    } finally {
      if (recoveredPath) {
        try { unlinkSync(recoveredPath); } catch {}
      }
      await closeHarness(harness);
    }
  });

  test("a malformed ready handshake is SIGKILLed and never poisons the voice cache", async () => {
    const harness = makeHarness({ malformedReady: true });
    try {
      expect(await harness.worker.start()).toBeFalse();
      await harness.worker.settled();

      expect(harness.worker.isReady()).toBeFalse();
      expect(harness.worker.availableVoices()).toEqual([]);
      expect(harness.worker.snapshot()).toMatchObject({
        status: "down",
        hardRestarts: 1,
        spawnAttempts: 1,
      });
      expect(harness.kills).toContainEqual({
        pid: harness.pids[0]!,
        signal: "SIGKILL",
      });
    } finally {
      await closeHarness(harness);
    }
  });

  test("a malformed success result fails the request, hard-restarts, and leaves a usable replacement", async () => {
    const harness = makeHarness();
    let recoveredPath = "";
    try {
      expect(await harness.worker.start()).toBeTrue();
      const firstPid = harness.worker.snapshot().pid!;

      await expect(request(harness.worker, "__malformed_result__"))
        .rejects.toThrow("worker returned an invalid synthesis result");
      await harness.worker.settled();

      expect(harness.kills).toContainEqual({ pid: firstPid, signal: "SIGKILL" });
      expect(harness.worker.snapshot()).toMatchObject({
        status: "ready",
        hardRestarts: 1,
        spawnAttempts: 2,
      });

      const recovered = await request(harness.worker, "healthy after malformed result");
      recoveredPath = recovered.path;
      expect(parseWav(new Uint8Array(readFileSync(recovered.path)))).not.toBeNull();
    } finally {
      if (recoveredPath) {
        try { unlinkSync(recoveredPath); } catch {}
      }
      await closeHarness(harness);
    }
  });

  test("close rejects pending work, removes its WAV, and SIGKILLs the owned child", async () => {
    const harness = makeHarness();
    expect(await harness.worker.start()).toBeTrue();
    const pid = harness.worker.snapshot().pid!;
    const pending = request(harness.worker, "__write_then_hang__", 5_000);
    await waitUntil(() => readdirSync(harness.root).some((name) => name.endsWith(".wav")));

    harness.worker.close();
    await expect(pending).rejects.toBeInstanceOf(TtsWorkerUnavailableError);
    await Promise.allSettled(harness.exits);

    expect(harness.worker.snapshot()).toMatchObject({ status: "stopped", pid: null });
    expect(harness.worker.isReady()).toBeFalse();
    expect(await harness.worker.start()).toBeFalse();
    expect(harness.kills).toContainEqual({ pid, signal: "SIGKILL" });
    expect(readdirSync(harness.root).filter((name) => name.endsWith(".wav"))).toEqual([]);
  });
});

describe("TTS worker config", () => {
  function config(env: Record<string, string | undefined> = {}) {
    const root = mkdtempSync(join(tmpdir(), "conch-tts-worker-config-"));
    roots.push(root);
    return loadConfig({ env, settingsPath: join(root, "settings.json") });
  }

  test("defaults to worker and accepts worker, server, say, and legacy auto", () => {
    expect(config().ttsEngine).toBe("worker");
    expect(config({ CONCH_TTS: "worker" }).ttsEngine).toBe("worker");
    expect(config({ CONCH_TTS: "server" }).ttsEngine).toBe("server");
    expect(config({ CONCH_TTS: "say" }).ttsEngine).toBe("say");
    expect(config({ CONCH_TTS: "auto" }).ttsEngine).toBe("worker");
  });

  test("port zero remains a server-only switch and does not disable worker mode", () => {
    const cfg = config({
      CONCH_TTS: "worker",
      CONCH_TTS_PORT: "0",
      CONCH_TTS_WORKER_PYTHON: "/custom/python",
    });
    expect(cfg).toMatchObject({
      ttsEngine: "worker",
      ttsPort: 0,
      ttsWorkerPython: "/custom/python",
    });
  });

  test("resolves the worker interpreter from the mlx_audio launcher shebang", () => {
    if (!PYTHON) throw new Error("python3 is required for the TTS worker config test");
    const root = mkdtempSync(join(tmpdir(), "conch-tts-worker-shebang-"));
    roots.push(root);
    const launcher = join(root, "mlx_audio.server");
    writeFileSync(launcher, `#!${PYTHON}\n`);

    expect(resolveMlxAudioPython("", launcher)).toBe(PYTHON);
    expect(resolveMlxAudioPython(PYTHON, "/missing/launcher")).toBe(PYTHON);
    expect(resolveMlxAudioPython("", join(root, "missing"))).toBeNull();
  });
});
