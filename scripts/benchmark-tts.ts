#!/usr/bin/env bun
/**
 * Reproducible Conch TTS benchmark.
 *
 * Runs the production ManagedTtsWorker and an owned legacy mlx_audio.server
 * against the same texts without playing audio.  Defaults:
 *
 *   6 fixed texts x 5 rounds = 30 measured requests per backend
 *   50 additional worker-only soak requests
 *
 * Optional environment overrides:
 *
 *   CONCH_TTS_MODEL
 *   CONCH_TTS_SERVER
 *   CONCH_TTS_WORKER_PYTHON
 *   CONCH_TTS_BENCH_VOICE
 *   CONCH_TTS_BENCH_SPEED
 *   CONCH_TTS_BENCH_ROUNDS
 *   CONCH_TTS_BENCH_SOAK
 *   CONCH_TTS_BENCH_COMPACT_ONLY=1
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManagedTtsWorker,
  TtsWorkerInferenceError,
  resolveMlxAudioPython,
  type TtsWorkerProcess,
  type TtsWorkerSnapshot,
} from "../src/tts-worker.ts";

const MODEL = process.env.CONCH_TTS_MODEL ?? "mlx-community/Kokoro-82M-bf16";
const SERVER_NAME = process.env.CONCH_TTS_SERVER ?? "mlx_audio.server";
const VOICE = process.env.CONCH_TTS_BENCH_VOICE ?? "af_heart";
const SPEED = finiteNumber(process.env.CONCH_TTS_BENCH_SPEED, 1.35);
const ROUNDS = positiveInteger(process.env.CONCH_TTS_BENCH_ROUNDS, 5);
const SOAK_REQUESTS = nonNegativeInteger(process.env.CONCH_TTS_BENCH_SOAK, 50);
const COMPACT_ONLY = process.env.CONCH_TTS_BENCH_COMPACT_ONLY === "1";
const REQUEST_TIMEOUT_MS = 20_000;
const STARTUP_TIMEOUT_MS = 180_000;
const DEFAULT_TTS_PORT = 8880;
const SHAPE_ERROR = /(?:broadcast|shape|sinegen|inference|value\s*error)/i;
const VOICES = [
  "af_heart",
  "am_michael",
  "bf_emma",
  "am_adam",
  "af_nova",
  "bm_george",
  "af_bella",
  "af_sky",
] as const;

const TEXTS = [
  "Done.",
  "The build is complete and all checks passed.",
  "I found the issue. The worker will restart automatically if synthesis times out.",
  "Your background task finished successfully; the report is ready for review.",
  "One more thing: the microphone loop remains active while speech is synthesized.",
  "The long-running process stayed responsive, and the audio fallback remained available.",
] as const;

type Backend = "worker" | "server";
type Phase = "warmup" | "paired" | "soak";

interface OwnedProcess {
  label: string;
  pid: number;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
  done: boolean;
}

interface AttemptRecord {
  speed: number;
  elapsedMs: number;
  ok: boolean;
  error?: string;
  inferenceFailure?: boolean;
}

interface SampleRecord {
  phase: Phase;
  backend: Backend;
  sequence: number;
  round?: number;
  textIndex: number;
  textChars: number;
  voice: string;
  requestedSpeed: number;
  effectiveSpeed?: number;
  elapsedMs?: number;
  successfulAttemptMs?: number;
  workerInternalMs?: number;
  wavBytes?: number;
  samples?: number;
  sampleRate?: number;
  attempts: AttemptRecord[];
  perturbationRetries: number;
  ok: boolean;
  error?: string;
  pidBefore?: number | null;
  pidAfter?: number | null;
  generationBefore?: number;
  generationAfter?: number;
}

interface BackendSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  perturbationRetries: number;
  minMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  meanMs: number | null;
  standardDeviationMs: number | null;
}

interface ProcessMemory {
  pid: number;
  rootRssMiB: number | null;
  treeRssMiB: number | null;
  treePids: number[];
  physicalFootprintMiB: number | null;
  peakPhysicalFootprintMiB: number | null;
  error?: string;
}

interface MemoryCheckpoint {
  label: string;
  worker: ProcessMemory | null;
  server: ProcessMemory | null;
}

class InferenceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferenceFailure";
  }
}

class SampleFailure extends Error {
  constructor(
    message: string,
    readonly attempts: AttemptRecord[],
  ) {
    super(message);
    this.name = "SampleFailure";
  }
}

function finiteNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function quantile(values: number[], probability: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
}

function summarize(records: SampleRecord[]): BackendSummary {
  const successful = records.filter((record) => record.ok && record.elapsedMs !== undefined);
  const values = successful.map((record) => record.elapsedMs!);
  const mean = values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
  const variance = mean === null
    ? null
    : values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return {
    attempted: records.length,
    succeeded: successful.length,
    failed: records.length - successful.length,
    perturbationRetries: records.reduce((total, record) => total + record.perturbationRetries, 0),
    minMs: values.length ? round(Math.min(...values)) : null,
    p50Ms: nullableRound(quantile(values, 0.5)),
    p95Ms: nullableRound(quantile(values, 0.95)),
    maxMs: values.length ? round(Math.max(...values)) : null,
    meanMs: nullableRound(mean),
    standardDeviationMs: variance === null ? null : round(Math.sqrt(variance)),
  };
}

function nullableRound(value: number | null): number | null {
  return value === null ? null : round(value);
}

function validateWav(path: string): number {
  const bytes = readFileSync(path);
  if (
    bytes.byteLength <= 44
    || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new InferenceFailure(`invalid or empty WAV at ${path}`);
  }
  return bytes.byteLength;
}

function unlinkQuietly(path: string): void {
  if (!path) return;
  try { unlinkSync(path); } catch {}
}

function commandOutput(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`${command.join(" ")} failed (${result.exitCode}): ${detail}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function optionalCommandOutput(command: string[]): string | null {
  try {
    return commandOutput(command);
  } catch {
    return null;
  }
}

function toMiB(value: number, unit: string): number {
  switch (unit.toUpperCase()) {
    case "KB": return value / 1024;
    case "MB": return value;
    case "GB": return value * 1024;
    default: return value / (1024 * 1024);
  }
}

function processMemory(pid: number): ProcessMemory {
  const result: ProcessMemory = {
    pid,
    rootRssMiB: null,
    treeRssMiB: null,
    treePids: [],
    physicalFootprintMiB: null,
    peakPhysicalFootprintMiB: null,
  };
  const errors: string[] = [];
  try {
    const rows = commandOutput(["/bin/ps", "-axo", "pid=,ppid=,rss="])
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((row): row is [number, number, number] => (
        row.length === 3 && row.every(Number.isFinite)
      ));
    const tree = new Set([pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [childPid, parentPid] of rows) {
        if (tree.has(parentPid) && !tree.has(childPid)) {
          tree.add(childPid);
          changed = true;
        }
      }
    }
    result.treePids = [...tree].sort((a, b) => a - b);
    const root = rows.find(([rowPid]) => rowPid === pid);
    if (root) result.rootRssMiB = round(root[2] / 1024);
    result.treeRssMiB = round(
      rows
        .filter(([rowPid]) => tree.has(rowPid))
        .reduce((total, row) => total + row[2], 0)
        / 1024,
    );
  } catch (error) {
    errors.push(errorText(error));
  }
  try {
    const output = commandOutput(["/usr/bin/footprint", "-p", String(pid)]);
    const current = output.match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/i);
    const peak = output.match(/phys_footprint_peak:\s*([\d.]+)\s*(KB|MB|GB)/i);
    if (current) result.physicalFootprintMiB = round(toMiB(Number(current[1]), current[2]!));
    if (peak) result.peakPhysicalFootprintMiB = round(toMiB(Number(peak[1]), peak[2]!));
  } catch (error) {
    errors.push(errorText(error));
  }
  if (errors.length) result.error = errors.join("; ");
  return result;
}

async function reserveFreeAlternatePort(avoid: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("reserved"),
    });
    const port = reservation.port;
    await reservation.stop(true);
    if (port === undefined) continue;
    if (avoid.has(port)) continue;

    // Re-bind once to verify that the selected alternate port is free.
    const confirmation = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => new Response("confirmed"),
    });
    await confirmation.stop(true);
    return port;
  }
  throw new Error("could not reserve a free alternate TTS port");
}

async function waitForServer(
  baseUrl: string,
  processRecord: OwnedProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let lastError = "";
  while (performance.now() < deadline) {
    if (processRecord.done) {
      throw new Error(`legacy server exited before readiness: ${lastError}`);
    }
    try {
      const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = errorText(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(`legacy server did not listen within ${timeoutMs}ms: ${lastError}`);
}

async function packageVersions(python: string): Promise<Record<string, string>> {
  const script = [
    "import importlib.metadata as m, json",
    "names=['mlx-audio','mlx','mlx-lm','numpy','miniaudio','misaki','spacy','fastapi','uvicorn']",
    "print(json.dumps({n:m.version(n) for n in names}))",
  ].join("; ");
  return JSON.parse(commandOutput([python, "-c", script]));
}

function trackOwned(
  owned: OwnedProcess[],
  label: string,
  child: {
    pid: number;
    exited: Promise<number>;
    kill(signal?: number | NodeJS.Signals): void;
  },
): OwnedProcess {
  const record: OwnedProcess = {
    label,
    pid: child.pid,
    exited: child.exited,
    kill: (signal) => child.kill(signal),
    done: false,
  };
  void child.exited.finally(() => {
    record.done = true;
  });
  owned.push(record);
  return record;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "conch-tts-benchmark-"));
  const owned: OwnedProcess[] = [];
  let worker: ManagedTtsWorker | null = null;
  let cleanupStarted = false;
  let legacy: OwnedProcess | null = null;
  let sequence = 0;
  let serverOutputCounter = 0;
  const workerLogs: string[] = [];

  const cleanup = async (): Promise<void> => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    worker?.close();
    for (const processRecord of owned) {
      if (!processRecord.done) {
        try { processRecord.kill("SIGKILL"); } catch {}
      }
    }
    await Promise.allSettled(owned.map((processRecord) => processRecord.exited));
    rmSync(root, { recursive: true, force: true });
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    console.error(`received ${signal}; cleaning only benchmark-owned processes`);
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  const onSigint = (): void => onSignal("SIGINT");
  const onSigterm = (): void => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    const serverBin = SERVER_NAME.includes("/") ? SERVER_NAME : Bun.which(SERVER_NAME);
    if (!serverBin || !existsSync(serverBin)) {
      throw new Error(`legacy server executable not found: ${SERVER_NAME}`);
    }
    const python = resolveMlxAudioPython(
      process.env.CONCH_TTS_WORKER_PYTHON ?? "",
      serverBin,
    );
    if (!python) throw new Error(`could not resolve mlx_audio Python from ${serverBin}`);

    const port = await reserveFreeAlternatePort(new Set([DEFAULT_TTS_PORT]));
    const baseUrl = `http://127.0.0.1:${port}`;
    const legacyStdout = join(root, "legacy-server.stdout.log");
    const legacyStderr = join(root, "legacy-server.stderr.log");
    const legacySpawnedAt = performance.now();
    const legacyChild = Bun.spawn(
      [serverBin, "--host", "127.0.0.1", "--port", String(port)],
      {
        stdin: "ignore",
        stdout: Bun.file(legacyStdout),
        stderr: Bun.file(legacyStderr),
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      },
    );
    legacy = trackOwned(owned, "legacy-server", legacyChild);

    const workerStderr = join(root, "worker.stderr.log");
    worker = new ManagedTtsWorker({
      enabled: true,
      model: MODEL,
      voices: [...VOICES],
      speed: SPEED,
      python,
      outputDir: root,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      retryDelaysMs: [0],
      periodicRetryMs: 30_000,
      log: (message) => {
        workerLogs.push(message);
        console.error(`[worker] ${message}`);
      },
      spawn: (command): TtsWorkerProcess => {
        const child = Bun.spawn(command, {
          stdin: "pipe",
          stdout: "pipe",
          stderr: Bun.file(workerStderr),
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
        });
        trackOwned(owned, "worker", child);
        return child as unknown as TtsWorkerProcess;
      },
    });

    console.error(`benchmark temp root: ${root}`);
    console.error(`resolved Python: ${python}`);
    console.error(`owned legacy server: pid ${legacy.pid}, ${baseUrl}`);
    console.error("warming worker and legacy server...");

    const workerStartupStarted = performance.now();
    let workerStartToReadyMs = 0;
    let serverSpawnToListenMs = 0;
    const workerStartup = worker.start().then((started) => {
      workerStartToReadyMs = performance.now() - workerStartupStarted;
      return started;
    });
    const serverStartup = waitForServer(baseUrl, legacy, STARTUP_TIMEOUT_MS).then(() => {
      serverSpawnToListenMs = performance.now() - legacySpawnedAt;
    });
    const [workerStarted] = await Promise.all([workerStartup, serverStartup]);
    if (!workerStarted || !worker.isReady()) {
      throw new Error(`worker failed to become ready: ${JSON.stringify(worker.snapshot())}`);
    }

    const attemptWorker = async (
      text: string,
      voice: string,
      speed: number,
    ): Promise<{
      elapsedMs: number;
      internalMs: number;
      wavBytes: number;
      samples: number;
      sampleRate: number;
    }> => {
      const started = performance.now();
      let path = "";
      try {
        const result = await worker!.synthesize({
          text,
          voice,
          speed,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        path = result.path;
        const elapsedMs = performance.now() - started;
        const wavBytes = validateWav(path);
        return {
          elapsedMs,
          internalMs: result.latencyMs,
          wavBytes,
          samples: result.samples,
          sampleRate: result.sampleRate,
        };
      } catch (error) {
        if (error instanceof TtsWorkerInferenceError) {
          throw new InferenceFailure(error.message);
        }
        throw error;
      } finally {
        unlinkQuietly(path);
      }
    };

    const attemptServer = async (
      text: string,
      voice: string,
      speed: number,
    ): Promise<{
      elapsedMs: number;
      wavBytes: number;
    }> => {
      const output = join(root, `legacy-${process.pid}-${++serverOutputCounter}.wav`);
      const started = performance.now();
      try {
        const response = await fetch(`${baseUrl}/v1/audio/speech`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: MODEL,
            input: text,
            voice,
            speed,
            lang_code: "a",
            response_format: "wav",
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = new Uint8Array(await response.arrayBuffer());
        if (!response.ok) {
          const detail = new TextDecoder().decode(body).slice(0, 1_000);
          if (response.status >= 500 || SHAPE_ERROR.test(detail)) {
            throw new InferenceFailure(`HTTP ${response.status}: ${detail}`);
          }
          throw new Error(`HTTP ${response.status}: ${detail}`);
        }
        await Bun.write(output, body);
        const elapsedMs = performance.now() - started;
        const wavBytes = validateWav(output);
        return { elapsedMs, wavBytes };
      } catch (error) {
        if (error instanceof InferenceFailure) throw error;
        const detail = errorText(error);
        if (SHAPE_ERROR.test(detail)) throw new InferenceFailure(detail);
        throw error;
      } finally {
        unlinkQuietly(output);
      }
    };

    const runSample = async (
      phase: Phase,
      backend: Backend,
      text: string,
      textIndex: number,
      voice: string,
      roundIndex?: number,
    ): Promise<SampleRecord> => {
      const record: SampleRecord = {
        phase,
        backend,
        sequence: ++sequence,
        round: roundIndex,
        textIndex,
        textChars: text.length,
        voice,
        requestedSpeed: SPEED,
        attempts: [],
        perturbationRetries: 0,
        ok: false,
      };
      const overallStarted = performance.now();
      const speeds = [SPEED, SPEED * 1.003];
      for (let attemptIndex = 0; attemptIndex < speeds.length; attemptIndex++) {
        const speed = speeds[attemptIndex]!;
        const pidBefore = backend === "worker" ? worker!.snapshot().pid : legacy!.pid;
        const generationBefore = backend === "worker" ? worker!.snapshot().generation : undefined;
        const attemptStarted = performance.now();
        try {
          if (backend === "worker") {
            const result = await attemptWorker(text, voice, speed);
            record.workerInternalMs = round(result.internalMs);
            record.wavBytes = result.wavBytes;
            record.samples = result.samples;
            record.sampleRate = result.sampleRate;
            record.successfulAttemptMs = round(result.elapsedMs);
          } else {
            const result = await attemptServer(text, voice, speed);
            record.wavBytes = result.wavBytes;
            record.successfulAttemptMs = round(result.elapsedMs);
          }
          const attemptElapsed = performance.now() - attemptStarted;
          record.attempts.push({
            speed: round(speed, 6),
            elapsedMs: round(attemptElapsed),
            ok: true,
          });
          record.effectiveSpeed = round(speed, 6);
          record.elapsedMs = round(performance.now() - overallStarted);
          record.ok = true;
          record.pidBefore = pidBefore;
          record.pidAfter = backend === "worker" ? worker!.snapshot().pid : legacy!.pid;
          record.generationBefore = generationBefore;
          record.generationAfter = backend === "worker" ? worker!.snapshot().generation : undefined;
          return record;
        } catch (error) {
          const inferenceFailure = error instanceof InferenceFailure;
          record.attempts.push({
            speed: round(speed, 6),
            elapsedMs: round(performance.now() - attemptStarted),
            ok: false,
            error: errorText(error),
            inferenceFailure,
          });
          if (!inferenceFailure || attemptIndex === speeds.length - 1) {
            record.elapsedMs = round(performance.now() - overallStarted);
            record.error = errorText(error);
            record.pidBefore = pidBefore;
            record.pidAfter = backend === "worker" ? worker!.snapshot().pid : legacy!.pid;
            record.generationBefore = generationBefore;
            record.generationAfter = backend === "worker" ? worker!.snapshot().generation : undefined;
            return record;
          }
          record.perturbationRetries++;
        }
      }
      throw new SampleFailure("unreachable sample state", record.attempts);
    };

    // ManagedTtsWorker performs an internal warmup before ready. Exercise its
    // actual path protocol once too, and perform the equivalent server warmup.
    const workerWarmup = await runSample("warmup", "worker", "Ready.", -1, VOICE);
    const serverWarmup = await runSample("warmup", "server", "Ready.", -1, VOICE);
    if (!workerWarmup.ok || !serverWarmup.ok) {
      throw new Error(
        `warmup failed: worker=${workerWarmup.error ?? "ok"} server=${serverWarmup.error ?? "ok"}`,
      );
    }
    const readyLog = workerLogs.find((message) => message.includes("warm and synthesis-ready")) ?? "";
    const readyTiming = readyLog.match(/load\s+(\d+)ms,\s+warmup\s+(\d+)ms/);
    const startupTiming = {
      workerStartToReadyMs: round(workerStartToReadyMs),
      workerReportedModelLoadMs: readyTiming ? Number(readyTiming[1]) : null,
      workerReportedMetalG2pWarmupMs: readyTiming ? Number(readyTiming[2]) : null,
      workerFirstPathWarmupMs: workerWarmup.elapsedMs ?? null,
      serverSpawnToListenMs: round(serverSpawnToListenMs),
      serverFirstModelLoadAndWarmupWavMs: serverWarmup.elapsedMs ?? null,
    };

    const memory: MemoryCheckpoint[] = [];
    const captureMemory = (label: string): void => {
      const snapshot = worker!.snapshot();
      memory.push({
        label,
        worker: snapshot.pid === null ? null : processMemory(snapshot.pid),
        server: legacy!.done ? null : processMemory(legacy!.pid),
      });
    };
    captureMemory("post-warmup");

    const paired: SampleRecord[] = [];
    console.error(`running ${ROUNDS * TEXTS.length} paired samples per backend...`);
    for (let roundIndex = 0; roundIndex < ROUNDS; roundIndex++) {
      for (let textIndex = 0; textIndex < TEXTS.length; textIndex++) {
        const text = TEXTS[textIndex]!;
        const ordinal = roundIndex * TEXTS.length + textIndex;
        const order: Backend[] = ordinal % 2 === 0
          ? ["worker", "server"]
          : ["server", "worker"];
        for (const backend of order) {
          const record = await runSample(
            "paired",
            backend,
            text,
            textIndex,
            VOICE,
            roundIndex,
          );
          paired.push(record);
          if (!record.ok) console.error(`${backend} paired sample failed: ${record.error}`);
        }
        if ((ordinal + 1) % 5 === 0 || ordinal + 1 === ROUNDS * TEXTS.length) {
          console.error(`paired progress: ${ordinal + 1}/${ROUNDS * TEXTS.length}`);
        }
      }
    }
    captureMemory("post-paired");

    const soak: SampleRecord[] = [];
    const soakStart = worker.snapshot();
    console.error(`running ${SOAK_REQUESTS} additional worker soak samples...`);
    for (let index = 0; index < SOAK_REQUESTS; index++) {
      if (!worker.isReady()) await worker.settled();
      const textIndex = index % TEXTS.length;
      const voice = VOICES[index % VOICES.length]!;
      const record = await runSample("soak", "worker", TEXTS[textIndex]!, textIndex, voice);
      soak.push(record);
      if (!record.ok) {
        console.error(`worker soak sample ${index + 1} failed: ${record.error}`);
        await worker.settled();
      }
      if ((index + 1) % 10 === 0 || index + 1 === SOAK_REQUESTS) {
        console.error(`soak progress: ${index + 1}/${SOAK_REQUESTS}`);
      }
    }
    const soakEnd = worker.snapshot();
    captureMemory("post-soak");

    const pairedWorker = paired.filter((record) => record.backend === "worker");
    const pairedServer = paired.filter((record) => record.backend === "server");
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      methodology: {
        model: MODEL,
        fixedTexts: TEXTS,
        voice: VOICE,
        speed: SPEED,
        perturbationSpeed: round(SPEED * 1.003, 6),
        rounds: ROUNDS,
        pairedRequestsPerBackend: ROUNDS * TEXTS.length,
        soakRequests: SOAK_REQUESTS,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        ordering: "alternating backend order for each paired text",
        latencyBoundary: {
          worker: "ManagedTtsWorker.synthesize call through completed WAV path",
          server: "HTTP POST, complete response body, and completed Bun.write WAV path",
        },
        percentile: "linear interpolation at (n - 1) * p (R/NumPy type 7)",
      },
      environment: {
        platform: `${process.platform}/${process.arch}`,
        osVersion: optionalCommandOutput(["/usr/bin/sw_vers", "-productVersion"]),
        kernel: optionalCommandOutput(["/usr/bin/uname", "-a"]),
        hardwareBytes: Number(optionalCommandOutput(["/usr/sbin/sysctl", "-n", "hw.memsize"])),
        python,
        serverBin,
        packageVersions: await packageVersions(python),
        benchmarkRootWas: root,
        preExistingDefaultPortListener: optionalCommandOutput([
          "/usr/sbin/lsof",
          "-nP",
          `-iTCP:${DEFAULT_TTS_PORT}`,
          "-sTCP:LISTEN",
        ]),
      },
      ownedProcesses: {
        legacyServer: { pid: legacy.pid, port, command: [serverBin, "--host", "127.0.0.1", "--port", String(port)] },
        workerPids: owned.filter((processRecord) => processRecord.label === "worker").map((processRecord) => processRecord.pid),
      },
      warmup: {
        startupTiming,
        worker: workerWarmup,
        server: serverWarmup,
      },
      summary: {
        pairedWorker: summarize(pairedWorker),
        pairedServer: summarize(pairedServer),
        workerSoak: summarize(soak),
      },
      workerLifecycle: {
        beforeSoak: soakStart,
        afterSoak: soakEnd,
        hardRestartsDuringSoak: soakEnd.hardRestarts - soakStart.hardRestarts,
        spawnAttemptsDuringSoak: soakEnd.spawnAttempts - soakStart.spawnAttempts,
        pidChangesDuringSoak: soak.filter((record) => record.pidBefore !== record.pidAfter).length,
      },
      memory,
      raw: {
        paired,
        soak,
      },
      diagnosticLogs: {
        worker: readFileSync(workerStderr, "utf8").slice(-4_000),
        legacyStdout: readFileSync(legacyStdout, "utf8").slice(-4_000),
        legacyStderr: readFileSync(legacyStderr, "utf8").slice(-4_000),
      },
    };

    const compact = {
      generatedAt: result.generatedAt,
      ownedProcesses: result.ownedProcesses,
      startupTiming,
      summary: result.summary,
      workerLifecycle: result.workerLifecycle,
      memory,
      rawSeriesMs: {
        pairedWorker: pairedWorker.map((record) => record.elapsedMs ?? null),
        pairedServer: pairedServer.map((record) => record.elapsedMs ?? null),
        workerSoak: soak.map((record) => record.elapsedMs ?? null),
      },
      failures: [...paired, ...soak]
        .filter((record) => !record.ok)
        .map((record) => ({
          phase: record.phase,
          backend: record.backend,
          sequence: record.sequence,
          textIndex: record.textIndex,
          voice: record.voice,
          attempts: record.attempts,
          error: record.error,
        })),
    };
    console.log("TTS_BENCHMARK_COMPACT_JSON_BEGIN");
    console.log(JSON.stringify(compact, null, 2));
    console.log("TTS_BENCHMARK_COMPACT_JSON_END");
    if (COMPACT_ONLY) return;

    console.log("TTS_BENCHMARK_JSON_BEGIN");
    console.log(JSON.stringify(result, null, 2));
    console.log("TTS_BENCHMARK_JSON_END");
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await cleanup();
  }
}

await main();
