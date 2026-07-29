import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithWatchdog, type WatchdogWarning } from "./audio-watchdog.ts";
import workerSource from "./tts-worker.py" with { type: "text" };

export const TTS_WORKER_PROTOCOL_VERSION = 1;
export const TTS_WORKER_STARTUP_TIMEOUT_MS = 120_000;
export const TTS_WORKER_RETRY_DELAYS_MS = [0, 500, 1_500, 3_000] as const;
export const TTS_WORKER_PERIODIC_RETRY_MS = 30_000;

const MAX_PROTOCOL_BUFFER = 64 * 1024;
const VOICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type TtsWorkerStatus =
  | "disabled"
  | "starting"
  | "ready"
  | "restarting"
  | "down"
  | "stopped";

export interface TtsWorkerSnapshot {
  status: TtsWorkerStatus;
  pid: number | null;
  generation: number;
  spawnAttempts: number;
  hardRestarts: number;
  requests: number;
  voices: string[];
  lastError: string | null;
  recovering: boolean;
}

export interface TtsWorkerSynthesisRequest {
  text: string;
  voice: string;
  speed: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface TtsWorkerSynthesisResult {
  path: string;
  sampleRate: number;
  samples: number;
  latencyMs: number;
}

/** Minimal synthesis surface injected into speak.ts and simple to fake in tests. */
export interface TtsWorkerBackend {
  isReady(): boolean;
  availableVoices(): readonly string[];
  synthesize(request: TtsWorkerSynthesisRequest): Promise<TtsWorkerSynthesisResult>;
  requestRecovery?(reason: string): void;
}

export class TtsWorkerUnavailableError extends Error {
  constructor(message = "Kokoro worker is not ready") {
    super(message);
    this.name = "TtsWorkerUnavailableError";
  }
}

export class TtsWorkerTimeoutError extends Error {
  constructor(message = "Kokoro worker synthesis timed out") {
    super(message);
    this.name = "TtsWorkerTimeoutError";
  }
}

export class TtsWorkerInferenceError extends Error {
  constructor(
    message: string,
    readonly kind: "request" | "inference" = "inference",
  ) {
    super(message);
    this.name = "TtsWorkerInferenceError";
  }
}

interface TtsWorkerInput {
  write(data: string | Uint8Array): number;
  flush(): number | Promise<number>;
  end?(): void;
}

export interface TtsWorkerProcess {
  pid?: number;
  stdin: TtsWorkerInput;
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
  unref?(): void;
}

interface ReadyFrame {
  type: "ready";
  protocol: number;
  model: string;
  voices: string[];
  sample_rate: number;
  pid?: number;
  load_ms?: number;
  warmup_ms?: number;
}

interface ResultFrame {
  type: "result";
  id: string | null;
  ok: boolean;
  path?: string;
  sample_rate?: number;
  samples?: number;
  latency_ms?: number;
  kind?: "request" | "inference";
  error?: string;
}

interface FatalFrame {
  type: "fatal";
  protocol: number;
  error: string;
}

interface ReadyWaiter {
  generation: number;
  promise: Promise<ReadyFrame>;
  resolve: (frame: ReadyFrame) => void;
  reject: (error: unknown) => void;
}

interface PendingRequest {
  id: string;
  generation: number;
  output: string;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort: () => void;
  resolve: (result: TtsWorkerSynthesisResult) => void;
  reject: (error: unknown) => void;
}

export interface ManagedTtsWorkerOptions {
  enabled: boolean;
  model: string;
  voices: string[];
  speed: number;
  /** Interpreter from the mlx_audio.server shebang, or an explicit override. */
  python?: string | null;
  /** Complete command test seam; the production command is assembled when omitted. */
  command?: string[];
  spawn?: (command: string[]) => TtsWorkerProcess;
  startupTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
  periodicRetryMs?: number;
  outputDir?: string;
  log?: WatchdogWarning;
}

function deferredReady(generation: number): ReadyWaiter {
  let resolve!: (frame: ReadyFrame) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ReadyFrame>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { generation, promise, resolve, reject };
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isOptionalFiniteNonNegative(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNonNegative(value);
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || isPositiveInteger(value);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Embed the audited Python source in compiled Bun releases, then materialize it privately. */
export function materializeTtsWorkerScript(): string {
  const digest = createHash("sha256").update(workerSource).digest("hex").slice(0, 16);
  const runtimeDir = join(homedir(), ".cache", "conch", "runtime");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir, 0o700);
  const path = join(runtimeDir, `tts-worker-${digest}.py`);
  try {
    if (readFileSync(path, "utf8") === workerSource) {
      chmodSync(path, 0o700);
      return path;
    }
  } catch {}

  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, workerSource, { mode: 0o700 });
  try {
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    if (!existsSync(path)) throw error;
  }
  chmodSync(path, 0o700);
  return path;
}

/**
 * Resolve the interpreter belonging to the installed mlx_audio.server tool.
 * uv console scripts use an absolute shebang into their isolated environment.
 */
export function resolveMlxAudioPython(explicit: string, serverBin: string): string | null {
  const requested = explicit.trim();
  if (requested) {
    const resolved = requested.includes("/") ? requested : Bun.which(requested);
    return resolved && existsSync(resolved) ? resolved : null;
  }

  const launcher = serverBin.includes("/") ? serverBin : Bun.which(serverBin);
  if (!launcher || !existsSync(launcher)) return null;
  try {
    const firstLine = readFileSync(launcher, "utf8").split(/\r?\n/, 1)[0] ?? "";
    if (!firstLine.startsWith("#!")) return null;
    const shebang = firstLine.slice(2).trim().split(/\s+/);
    if (!shebang.length) return null;
    if (shebang[0] === "/usr/bin/env") {
      const resolved = shebang[1] ? Bun.which(shebang[1]) : null;
      return resolved && existsSync(resolved) ? resolved : null;
    }
    return existsSync(shebang[0]!) ? shebang[0]! : null;
  } catch {
    return null;
  }
}

function defaultSpawn(command: string[]): TtsWorkerProcess {
  return Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    // Never pipe diagnostics without a reader: a full stderr pipe can wedge Python.
    stderr: Bun.file("/tmp/conch-kokoro-worker.err.log"),
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  }) as unknown as TtsWorkerProcess;
}

/**
 * Always-owned warm-worker lifecycle.
 *
 * There is deliberately no adoption path: any request timeout invalidates the
 * generation, SIGKILLs the exact child, and starts a replacement in background.
 */
export class ManagedTtsWorker implements TtsWorkerBackend {
  private status: TtsWorkerStatus;
  private child: TtsWorkerProcess | null = null;
  private generation = 0;
  private spawnAttempts = 0;
  private hardRestarts = 0;
  private requests = 0;
  private voices: string[] = [];
  private lastError: string | null = null;
  private readyWaiter: ReadyWaiter | null = null;
  private pending: PendingRequest | null = null;
  private recovery: Promise<boolean> | null = null;
  private periodicTimer: ReturnType<typeof setTimeout> | null = null;
  private requestCounter = 0;
  private readonly outputFiles = new Set<string>();
  private readonly lifecycle = new AbortController();
  private readonly log: WatchdogWarning;

  constructor(private readonly options: ManagedTtsWorkerOptions) {
    this.status = options.enabled ? "starting" : "disabled";
    const logger = options.log ?? console.warn;
    this.log = (message) => {
      try { logger(message); } catch {}
    };
  }

  snapshot(): TtsWorkerSnapshot {
    return {
      status: this.status,
      pid: this.child?.pid ?? null,
      generation: this.generation,
      spawnAttempts: this.spawnAttempts,
      hardRestarts: this.hardRestarts,
      requests: this.requests,
      voices: [...this.voices],
      lastError: this.lastError,
      recovering: this.recovery !== null,
    };
  }

  isReady(): boolean {
    return this.status === "ready" && this.child !== null;
  }

  availableVoices(): readonly string[] {
    return this.voices;
  }

  start(): Promise<boolean> {
    if (!this.options.enabled || this.stopped()) return Promise.resolve(false);
    if (this.isReady()) return Promise.resolve(true);
    return this.beginRecovery("startup");
  }

  requestRecovery(reason: string): void {
    if (!this.options.enabled || this.stopped()) return;
    if (this.isReady()) return;
    void this.beginRecovery(reason);
  }

  async synthesize(request: TtsWorkerSynthesisRequest): Promise<TtsWorkerSynthesisResult> {
    if (!this.isReady() || !this.child) {
      this.requestRecovery("request while unavailable");
      throw new TtsWorkerUnavailableError();
    }
    if (this.pending) throw new TtsWorkerUnavailableError("Kokoro worker is busy");
    if (request.signal?.aborted) {
      throw request.signal.reason ?? new DOMException("Kokoro worker request cancelled", "AbortError");
    }

    const child = this.child;
    const generation = this.generation;
    const id = `${generation}-${++this.requestCounter}`;
    const output = join(
      this.options.outputDir ?? tmpdir(),
      `conch-tts-worker-${process.pid}-${id}.wav`,
    );
    this.outputFiles.add(output);
    this.requests++;

    let resolve!: (result: TtsWorkerSynthesisResult) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<TtsWorkerSynthesisResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const abort = () => {
      if (this.pending?.id !== id) return;
      const error = request.signal?.reason ?? new DOMException("Kokoro worker request cancelled", "AbortError");
      this.failPending(error);
      this.hardRestart("cancelled synthesis");
    };
    const timer = setTimeout(() => {
      if (this.pending?.id !== id) return;
      this.failPending(new TtsWorkerTimeoutError());
      this.hardRestart("synthesis timeout");
    }, Math.max(1, Math.ceil(request.timeoutMs)));
    this.pending = {
      id,
      generation,
      output,
      timer,
      signal: request.signal,
      abort,
      resolve,
      reject,
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) {
      abort();
      return result;
    }

    try {
      child.stdin.write(JSON.stringify({
        id,
        op: "synthesize",
        text: request.text,
        voice: request.voice,
        speed: request.speed,
        output,
      }) + "\n");
      // Do not await backpressure here. If the pipe itself wedges, the request
      // watchdog must still reject the caller and drive the say fallback.
      const flushed = child.stdin.flush();
      if (flushed instanceof Promise) {
        void flushed.catch((error) => {
          if (
            this.pending?.id !== id
            || this.child !== child
            || this.generation !== generation
          ) return;
          this.failPending(error);
          this.hardRestart("protocol write failure");
        });
      }
    } catch (error) {
      if (this.pending?.id === id) this.failPending(error);
      this.hardRestart("protocol write failure");
    }
    return result;
  }

  close(): void {
    if (this.stopped()) return;
    this.status = "stopped";
    this.lifecycle.abort();
    this.clearPeriodic();
    this.readyWaiter?.reject(new TtsWorkerUnavailableError("Kokoro worker stopped"));
    this.readyWaiter = null;
    this.failPending(new TtsWorkerUnavailableError("Kokoro worker stopped"));
    this.retireCurrent(false);
    for (const path of this.outputFiles) {
      try { unlinkSync(path); } catch {}
    }
    this.outputFiles.clear();
  }

  /** Test/diagnostic barrier for the current startup/recovery burst. */
  async settled(): Promise<void> {
    while (this.recovery) await this.recovery;
  }

  private stopped(): boolean {
    return this.status === "stopped" || this.lifecycle.signal.aborted;
  }

  private beginRecovery(reason: string): Promise<boolean> {
    if (this.recovery) return this.recovery;
    this.clearPeriodic();
    this.status = reason === "startup" ? "starting" : "restarting";
    const work = this.recover(reason);
    let tracked!: Promise<boolean>;
    tracked = work.catch((error) => {
      if (!this.stopped()) {
        this.lastError = errorText(error);
        this.log(`kokoro worker recovery failed: ${this.lastError}`);
        this.status = "down";
        this.armPeriodic();
      }
      return false;
    }).finally(() => {
      if (this.recovery === tracked) this.recovery = null;
    });
    this.recovery = tracked;
    return tracked;
  }

  private async recover(reason: string): Promise<boolean> {
    const delays = this.options.retryDelaysMs ?? TTS_WORKER_RETRY_DELAYS_MS;
    this.log(`kokoro worker ${reason === "startup" ? "starting" : `recovery requested: ${reason}`}`);
    for (const delay of delays) {
      if (!(await abortableSleep(delay, this.lifecycle.signal)) || this.stopped()) return false;
      try {
        const frame = await this.spawnOnce();
        if (this.stopped()) return false;
        this.status = "ready";
        this.lastError = null;
        this.voices = frame.voices.filter((voice) => VOICE_NAME.test(voice));
        this.log(
          `kokoro worker warm and synthesis-ready (pid ${this.child?.pid ?? frame.pid ?? "?"}, `
          + `load ${Math.round(frame.load_ms ?? 0)}ms, warmup ${Math.round(frame.warmup_ms ?? 0)}ms)`,
        );
        return true;
      } catch (error) {
        if (this.stopped()) return false;
        this.lastError = errorText(error);
        this.log(`kokoro worker start attempt failed: ${this.lastError}`);
        this.retireCurrent(true);
      }
    }
    if (!this.stopped()) {
      this.status = "down";
      this.log("kokoro worker remains down after bounded restart attempts; using say and retrying periodically");
      this.armPeriodic();
    }
    return false;
  }

  private async spawnOnce(): Promise<ReadyFrame> {
    const command = this.workerCommand();
    const child = (this.options.spawn ?? defaultSpawn)(command);
    const generation = ++this.generation;
    this.spawnAttempts++;
    this.child = child;
    this.voices = [];
    const ready = deferredReady(generation);
    this.readyWaiter = ready;
    void this.consumeStdout(child, generation);
    void child.exited.then(
      (code) => this.childExited(child, generation, `exit ${code}`),
      (error) => this.childExited(child, generation, errorText(error)),
    );

    const timeoutMs = this.options.startupTimeoutMs ?? TTS_WORKER_STARTUP_TIMEOUT_MS;
    const outcome = await awaitWithWatchdog(ready.promise, {
      operation: "kokoro worker startup",
      timeoutMs,
      signal: this.lifecycle.signal,
      timeoutAction: "killed",
      onTimeout: () => this.retireIfCurrent(child, generation, true),
      warn: this.log,
    });
    if (outcome.status === "cancelled") {
      throw this.lifecycle.signal.reason ?? new TtsWorkerUnavailableError("Kokoro worker startup cancelled");
    }
    if (outcome.status === "timed-out") throw new TtsWorkerTimeoutError("Kokoro worker startup timed out");
    if (this.child !== child || this.generation !== generation) {
      throw new TtsWorkerUnavailableError("Kokoro worker exited during startup");
    }
    if (this.readyWaiter === ready) this.readyWaiter = null;
    return outcome.value;
  }

  private workerCommand(): string[] {
    if (this.options.command?.length) return [...this.options.command];
    if (!this.options.python) {
      throw new TtsWorkerUnavailableError(
        "mlx_audio Python not found; install mlx-audio or set CONCH_TTS_WORKER_PYTHON",
      );
    }
    const voices = this.options.voices.filter((voice) => VOICE_NAME.test(voice));
    const warmupVoice = voices[0] ?? "af_heart";
    return [
      this.options.python,
      "-u",
      materializeTtsWorkerScript(),
      "--model", this.options.model,
      "--voices", JSON.stringify(voices),
      "--warmup-voice", warmupVoice,
      "--warmup-speed", String(this.options.speed),
    ];
  }

  private async consumeStdout(child: TtsWorkerProcess, generation: number): Promise<void> {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!this.stopped()) {
        const item = await reader.read();
        if (item.done) break;
        buffer += decoder.decode(item.value, { stream: true });
        if (buffer.length > MAX_PROTOCOL_BUFFER) {
          throw new Error("worker protocol line exceeded 64 KiB");
        }
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.handleLine(line, child, generation);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) this.handleLine(buffer.trim(), child, generation);
      if (!this.stopped() && this.child === child && this.generation === generation) {
        throw new Error("worker protocol stdout closed");
      }
    } catch (error) {
      if (!this.stopped() && this.child === child && this.generation === generation) {
        this.lastError = errorText(error);
        this.log(`kokoro worker protocol failed: ${this.lastError}`);
        this.readyWaiter?.reject(error);
        this.failPending(error);
        this.hardRestart("protocol failure");
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  private handleLine(line: string, child: TtsWorkerProcess, generation: number): void {
    if (this.child !== child || this.generation !== generation) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`worker emitted non-JSON stdout: ${line.slice(0, 160)}`);
    }
    if (!value || typeof value !== "object" || !("type" in value)) {
      throw new Error("worker emitted an invalid protocol frame");
    }

    if (value.type === "ready") {
      const frame = value as Partial<ReadyFrame>;
      if (
        frame.protocol !== TTS_WORKER_PROTOCOL_VERSION
        || frame.model !== this.options.model
        || !Array.isArray(frame.voices)
        || frame.voices.length === 0
        || !frame.voices.every((voice): voice is string => (
          typeof voice === "string" && VOICE_NAME.test(voice)
        ))
        || !isPositiveInteger(frame.sample_rate)
        || !isOptionalPositiveInteger(frame.pid)
        || !isOptionalFiniteNonNegative(frame.load_ms)
        || !isOptionalFiniteNonNegative(frame.warmup_ms)
      ) {
        throw new Error("worker ready handshake did not match configuration");
      }
      this.readyWaiter?.resolve(frame as ReadyFrame);
      return;
    }

    if (value.type === "fatal") {
      const frame = value as Partial<FatalFrame>;
      if (
        frame.protocol !== TTS_WORKER_PROTOCOL_VERSION
        || typeof frame.error !== "string"
        || !frame.error.trim()
      ) {
        throw new Error("worker emitted an invalid fatal frame");
      }
      const error = new Error(frame.error);
      this.readyWaiter?.reject(error);
      return;
    }

    if (value.type !== "result") throw new Error("worker emitted an unknown protocol frame");
    const frame = value as Partial<ResultFrame>;
    const pending = this.pending;
    if (
      !pending
      || pending.generation !== generation
      || frame.id !== pending.id
      || typeof frame.ok !== "boolean"
    ) {
      throw new Error("worker result did not match the active request");
    }
    if (!frame.ok) {
      if (
        (frame.kind !== "request" && frame.kind !== "inference")
        || typeof frame.error !== "string"
        || !frame.error.trim()
      ) {
        throw new Error("worker returned an invalid synthesis error");
      }
      this.failPending(new TtsWorkerInferenceError(
        frame.error,
        frame.kind,
      ));
      return;
    }
    if (
      frame.path !== pending.output
      || !isPositiveInteger(frame.sample_rate)
      || !isFiniteNonNegative(frame.samples)
      || !Number.isInteger(frame.samples)
      || !isFiniteNonNegative(frame.latency_ms)
      || !existsSync(pending.output)
    ) {
      throw new Error("worker returned an invalid synthesis result");
    }
    this.completePending({
      path: pending.output,
      sampleRate: frame.sample_rate,
      samples: frame.samples,
      latencyMs: frame.latency_ms,
    });
  }

  private childExited(
    child: TtsWorkerProcess,
    generation: number,
    detail: string,
  ): void {
    if (this.stopped() || this.child !== child || this.generation !== generation) return;
    this.child = null;
    const error = new TtsWorkerUnavailableError(`Kokoro worker exited (${detail})`);
    this.lastError = error.message;
    this.readyWaiter?.reject(error);
    this.readyWaiter = null;
    this.failPending(error);
    this.status = "restarting";
    this.log(`owned kokoro worker exited (${detail})`);
    void this.beginRecovery("child exit");
  }

  private hardRestart(reason: string): void {
    if (this.stopped()) return;
    this.hardRestarts++;
    this.status = "restarting";
    this.lastError = reason;
    this.log(`kokoro worker hard restart: ${reason}`);
    this.retireCurrent(true);
    void this.beginRecovery(reason);
  }

  private retireIfCurrent(
    child: TtsWorkerProcess,
    generation: number,
    countRestart: boolean,
  ): void {
    if (this.child !== child || this.generation !== generation) return;
    this.retireCurrent(countRestart);
  }

  private retireCurrent(countRestart: boolean): void {
    const child = this.child;
    this.child = null;
    this.readyWaiter?.reject(new TtsWorkerUnavailableError("Kokoro worker retired"));
    this.readyWaiter = null;
    if (countRestart && child) this.lastError ??= "Kokoro worker retired";
    if (!child) return;
    try { child.stdin.end?.(); } catch {}
    try { child.kill("SIGKILL"); } catch {}
    try { child.unref?.(); } catch {}
  }

  private completePending(result: TtsWorkerSynthesisResult): void {
    const pending = this.takePending();
    if (!pending) return;
    this.outputFiles.delete(pending.output); // ownership transfers to speak.ts
    pending.resolve(result);
  }

  private failPending(error: unknown): void {
    const pending = this.takePending();
    if (!pending) return;
    try { unlinkSync(pending.output); } catch {}
    this.outputFiles.delete(pending.output);
    pending.reject(error);
  }

  private takePending(): PendingRequest | null {
    const pending = this.pending;
    if (!pending) return null;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.abort);
    return pending;
  }

  private armPeriodic(): void {
    if (this.periodicTimer || this.stopped()) return;
    const delay = this.options.periodicRetryMs ?? TTS_WORKER_PERIODIC_RETRY_MS;
    this.periodicTimer = setTimeout(() => {
      this.periodicTimer = null;
      if (!this.stopped()) void this.beginRecovery("periodic retry");
    }, delay);
    this.periodicTimer.unref?.();
  }

  private clearPeriodic(): void {
    if (this.periodicTimer) clearTimeout(this.periodicTimer);
    this.periodicTimer = null;
  }
}
