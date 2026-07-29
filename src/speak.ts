import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  audioTimeoutMs,
  awaitProcessWithWatchdog,
  awaitWithAbort,
  awaitWithWatchdog,
  type AudioSpawner,
  type WatchdogProcess,
  type WatchdogWarning,
} from "./audio-watchdog.ts";
import type { Config } from "./config.ts";
import { splitSentences } from "./snippet.ts";
import { TtsHealthMachine, type TtsHealthSnapshot } from "./tts-health.ts";
import {
  TtsWorkerInferenceError,
  TtsWorkerTimeoutError,
  TtsWorkerUnavailableError,
  type TtsWorkerBackend,
} from "./tts-worker.ts";
import { parseWav, trimWav } from "./tts-wav.ts";

const MIN_BISECT_CHARS = 24;
const PREFETCH_DEPTH = 3;
export const SYNTH_ATTEMPT_TIMEOUT_MS = 4_000;
export const SYNTH_SENTENCE_BUDGET_MS = 8_500;
export const SYNTH_TIMEOUT_LIMIT = 2;
const OVERLOAD_STATUSES = new Set([429, 502, 503, 504]);
const INFERENCE_ERROR = /(?:broadcast|shape|sinegen|inference|value\s*error)/i;
const VOICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VOICES_FILE = join(homedir(), ".config/conch/voices.json");

export interface VoiceOverrideOptions {
  /** Injectable so tests and alternate front-ends never need to touch the real home directory. */
  voicesPath?: string;
}

type AudioProcess = WatchdogProcess;

interface CancelControl {
  cancelled: boolean;
  abort: AbortController;
  processes: Set<AudioProcess>;
  tempFiles: Set<string>;
  runtime: ResolvedSpeakRuntimeOptions;
  kokoroFailureReported: boolean;
  cancel(): void;
}

export type TrySynthOutcome =
  | { kind: "audio"; audio: Uint8Array }
  | { kind: "cancelled" }
  | { kind: "transport-failure"; error: string; timedOut: boolean }
  | { kind: "http-config-failure"; status: number; retryable: boolean; detail: string }
  | { kind: "post-header-timeout"; status: number; detail: string }
  | { kind: "post-header-inference-failure"; status: number; detail: string };

export type TtsFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TrySynthOptions {
  fetcher?: TtsFetch;
  health?: TtsHealthMachine;
  signal?: AbortSignal;
  timeoutMs?: number;
  speed?: number;
  warn?: WatchdogWarning;
}

export interface SpeakRuntimeOptions {
  spawnAudio?: AudioSpawner;
  timeoutForText?: (text: string) => number;
  warn?: WatchdogWarning;
  onKokoroFailure?: (reason: "readiness-failed" | "synth-timeout") => void;
  /** Present only inside the daemon that owns the warm Python child. */
  worker?: TtsWorkerBackend | null;
}

const spawnAudio: AudioSpawner = (command) => Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });

interface ResolvedSpeakRuntimeOptions {
  spawnAudio: AudioSpawner;
  timeoutForText: (text: string) => number;
  warn: WatchdogWarning;
  onKokoroFailure: (reason: "readiness-failed" | "synth-timeout") => void;
  worker: TtsWorkerBackend | null;
}

function runtimeOptions(options: SpeakRuntimeOptions): ResolvedSpeakRuntimeOptions {
  return {
    spawnAudio: options.spawnAudio ?? spawnAudio,
    timeoutForText: options.timeoutForText ?? audioTimeoutMs,
    warn: options.warn ?? console.warn,
    onKokoroFailure: options.onKokoroFailure ?? (() => {}),
    worker: options.worker ?? null,
  };
}

const ttsHealth = new TtsHealthMachine();
const activeControls = new Set<CancelControl>();
const activeAudioProcesses = new Set<AudioProcess>();
let readinessPromise: Promise<boolean> | null = null;
let readinessController: AbortController | null = null;
let readinessKey = "";
let voiceCacheKey = "";
let availableVoices: Set<string> | null = null;
let knownGoodVoice = "";
let tmpCounter = 0;

export function getTtsHealth(): TtsHealthSnapshot {
  return ttsHealth.snapshot();
}

function bisect(text: string): [string, string] | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_BISECT_CHARS) return null;
  const mid = Math.floor(trimmed.length / 2);
  let split = trimmed.lastIndexOf(" ", mid);
  if (split <= 0) split = trimmed.indexOf(" ", mid);
  if (split <= 0) return null;
  return [trimmed.slice(0, split).trim(), trimmed.slice(split).trim()];
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function combinedSignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  return present.length ? AbortSignal.any(present) : new AbortController().signal;
}

function wasCancelled(control: CancelControl | null, signal?: AbortSignal): boolean {
  return Boolean(control?.cancelled || signal?.aborted);
}

/**
 * One fully-consumed OpenAI-compatible WAV synthesis request. A throw after
 * response headers is inference/input evidence, not a transport outage.
 */
export async function trySynth(
  cfg: Config,
  input: string,
  voice: string,
  control: CancelControl | null = null,
  options: TrySynthOptions = {},
): Promise<TrySynthOutcome> {
  const health = options.health ?? ttsHealth;
  const token = health.beginAttempt();
  const timeoutMs = options.timeoutMs ?? audioTimeoutMs(input);
  const cancellationSignal = combinedSignal([control?.abort.signal, options.signal]);
  const timeoutController = new AbortController();
  const signal = combinedSignal([cancellationSignal, timeoutController.signal]);
  const deadline = performance.now() + timeoutMs;
  const guarded = <T>(work: PromiseLike<T>) => awaitWithWatchdog(work, {
    operation: "kokoro synth request",
    timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
    warningTimeoutMs: timeoutMs,
    signal: cancellationSignal,
    timeoutAction: "aborted",
    onTimeout: () => timeoutController.abort(new DOMException("Kokoro synthesis timed out", "TimeoutError")),
    warn: options.warn,
  });
  let response: Response;
  try {
    const result = await guarded((options.fetcher ?? fetch)(`http://127.0.0.1:${cfg.ttsPort}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.ttsModel,
        input,
        voice,
        speed: options.speed ?? cfg.ttsSpeed,
        response_format: "wav",
      }),
      signal,
    }));
    if (result.status === "cancelled") return { kind: "cancelled" };
    if (result.status === "timed-out") {
      health.recordTransportFailure(token);
      return { kind: "transport-failure", error: "Kokoro synthesis timed out", timedOut: true };
    }
    response = result.value;
  } catch (error) {
    if (wasCancelled(control, options.signal)) return { kind: "cancelled" };
    health.recordTransportFailure(token);
    return { kind: "transport-failure", error: errorText(error), timedOut: timeoutController.signal.aborted };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const result = await guarded(response.text());
      if (result.status === "cancelled") return { kind: "cancelled" };
      if (result.status === "timed-out") {
        health.recordDegraded(token);
        return { kind: "post-header-timeout", status: response.status, detail: "Kokoro response body timed out" };
      }
      detail = result.value;
    } catch (error) {
      if (wasCancelled(control, options.signal)) return { kind: "cancelled" };
      detail = errorText(error);
      if (timeoutController.signal.aborted) {
        health.recordDegraded(token);
        return { kind: "post-header-timeout", status: response.status, detail };
      }
    }
    health.recordReachable(token);
    // The known mlx shape failures sometimes arrive as an ordinary 500 and
    // sometimes throw after the endpoint already sent 200 streaming headers.
    if (response.status === 500 && INFERENCE_ERROR.test(detail)) {
      return { kind: "post-header-inference-failure", status: response.status, detail };
    }
    return {
      kind: "http-config-failure",
      status: response.status,
      retryable: OVERLOAD_STATUSES.has(response.status),
      detail,
    };
  }

  try {
    const result = await guarded(response.arrayBuffer());
    if (result.status === "cancelled") return { kind: "cancelled" };
    if (result.status === "timed-out") {
      health.recordDegraded(token);
      return { kind: "post-header-timeout", status: response.status, detail: "Kokoro response body timed out" };
    }
    const audio = new Uint8Array(result.value);
    if (!parseWav(audio)) {
      health.recordReachable(token);
      return { kind: "post-header-inference-failure", status: response.status, detail: "invalid or empty WAV body" };
    }
    health.recordSuccess(token);
    return { kind: "audio", audio };
  } catch (error) {
    if (wasCancelled(control, options.signal)) return { kind: "cancelled" };
    const detail = errorText(error);
    if (timeoutController.signal.aborted) {
      health.recordDegraded(token);
      return { kind: "post-header-timeout", status: response.status, detail };
    }
    health.recordReachable(token);
    return { kind: "post-header-inference-failure", status: response.status, detail };
  }
}

/** One path-based synthesis request to the daemon-owned Python worker. */
async function tryWorkerSynth(
  cfg: Config,
  input: string,
  voice: string,
  control: CancelControl | null,
  worker: TtsWorkerBackend,
  options: TrySynthOptions = {},
): Promise<TrySynthOutcome> {
  const cancellationSignal = combinedSignal([control?.abort.signal, options.signal]);
  if (wasCancelled(control, options.signal)) return { kind: "cancelled" };
  if (!worker.isReady()) {
    return { kind: "transport-failure", error: "Kokoro worker is not ready", timedOut: false };
  }

  let path = "";
  try {
    const result = await worker.synthesize({
      text: input,
      voice,
      speed: options.speed ?? cfg.ttsSpeed,
      timeoutMs: options.timeoutMs ?? audioTimeoutMs(input),
      signal: cancellationSignal,
    });
    path = result.path;
    const audio = new Uint8Array(readFileSync(path));
    if (!parseWav(audio)) {
      return {
        kind: "post-header-inference-failure",
        status: 500,
        detail: "worker returned an invalid or empty WAV",
      };
    }
    knownGoodVoice = voice;
    return { kind: "audio", audio };
  } catch (error) {
    if (wasCancelled(control, options.signal)) return { kind: "cancelled" };
    if (error instanceof TtsWorkerTimeoutError) {
      return { kind: "transport-failure", error: error.message, timedOut: true };
    }
    if (error instanceof TtsWorkerInferenceError) {
      if (error.kind === "request") {
        return {
          kind: "http-config-failure",
          status: 422,
          retryable: false,
          detail: error.message,
        };
      }
      return {
        kind: "post-header-inference-failure",
        status: 500,
        detail: error.message,
      };
    }
    return {
      kind: "transport-failure",
      error: errorText(error),
      timedOut: error instanceof TtsWorkerUnavailableError ? false : /timed?\s*out/i.test(errorText(error)),
    };
  } finally {
    if (path) {
      try { unlinkSync(path); } catch {}
    }
  }
}

// --- readiness + voices -------------------------------------------------

function voiceOverridePath(options: VoiceOverrideOptions): string {
  return options.voicesPath ?? VOICES_FILE;
}

/** Read the tiny label-keyed override file afresh so short-lived CLI/hooks see changes. */
export function voiceOverrides(options: VoiceOverrideOptions = {}): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(voiceOverridePath(options), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function writeVoiceOverrides(
  overrides: Readonly<Record<string, string>>,
  options: VoiceOverrideOptions,
): void {
  const path = voiceOverridePath(options);
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(
    dirname(path),
    `.voices.json.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(overrides, null, 2) + "\n", "utf8");
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {}
  }
}

function voiceOverrideKey(label: string): string {
  return label.toLowerCase().trim();
}

export function isValidVoiceName(voice: string): boolean {
  return VOICE_NAME.test(voice.trim());
}

/** Filter malformed, duplicate, or server-unknown voices and retain a usable fallback. */
export function validateVoiceRing(configured: string[], available?: Iterable<string> | null): string[] {
  const serverVoices = available ? new Set(Array.from(available, (voice) => voice.trim()).filter(isValidVoiceName)) : null;
  const ring = Array.from(new Set(configured.map((voice) => voice.trim()).filter((voice) => {
    return isValidVoiceName(voice) && (!serverVoices || serverVoices.has(voice));
  })));
  if (ring.length) return ring;
  if (serverVoices?.has("af_heart")) return ["af_heart"];
  if (serverVoices?.size) return [serverVoices.values().next().value!];
  return ["af_heart"];
}

/**
 * The same usable ring voiceFor selects from. The optional availability input
 * is a test seam; normal callers use the matching server-discovery cache.
 */
export function availableVoiceRing(
  cfg: Config,
  available?: Iterable<string> | null,
): string[] {
  const cacheMatches = voiceCacheKey === voiceConfigKey(cfg);
  const serverVoices = available === undefined
    ? (cacheMatches ? availableVoices : null)
    : available;
  return validateVoiceRing(cfg.ttsVoices, serverVoices);
}

function hashLabel(label: string): number {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return hash;
}

/** Pure voice selection used by voiceFor and unit tests. */
export function selectVoice(
  configured: string[],
  label: string,
  override = "",
  available?: Iterable<string> | null,
  fallback = "af_heart",
): string {
  const allowed = available ? new Set(available) : null;
  const ring = validateVoiceRing(configured, allowed);
  const wanted = override.trim();
  if (isValidVoiceName(wanted) && (!allowed || allowed.has(wanted))) return wanted;
  if (!label) return ring[0] ?? fallback;
  return ring[hashLabel(label) % ring.length] ?? fallback;
}

/** Pin a syntactically valid session voice. Server availability is checked before use. */
export function setVoiceOverride(
  label: string,
  voice: string,
  options: VoiceOverrideOptions = {},
): void {
  const clean = voice.trim();
  if (!isValidVoiceName(clean)) throw new Error(`Invalid TTS voice: ${voice}`);
  const key = voiceOverrideKey(label);
  if (!key) throw new Error("Voice override label cannot be empty");
  const map = new Map(Object.entries(voiceOverrides(options)));
  map.set(key, clean);
  writeVoiceOverrides(Object.fromEntries(map), options);
}

/** Remove a voice pin so the label returns to stable hash-based selection. */
export function clearVoiceOverride(
  label: string,
  options: VoiceOverrideOptions = {},
): boolean {
  const key = voiceOverrideKey(label);
  const map = voiceOverrides(options);
  if (!key || !Object.hasOwn(map, key)) return false;
  delete map[key];
  writeVoiceOverrides(map, options);
  return true;
}

export interface VoiceOverrideMapMigration {
  overrides: Record<string, string>;
  migrated: boolean;
  voice?: string;
}

/**
 * Move an old normalized label key to a new one. The old pin wins a collision:
 * it represents the session being renamed, while the destination pin belonged
 * to some other label and must not silently change this session's voice.
 */
export function migrateVoiceOverrideMap(
  overrides: Readonly<Record<string, string>>,
  oldLabel: string,
  newLabel: string,
): VoiceOverrideMapMigration {
  const oldKey = voiceOverrideKey(oldLabel);
  const newKey = voiceOverrideKey(newLabel);
  const next = new Map(Object.entries(overrides));
  if (!oldKey || !newKey || oldKey === newKey || !next.has(oldKey)) {
    return { overrides: Object.fromEntries(next), migrated: false };
  }
  const voice = next.get(oldKey)!;
  next.delete(oldKey);
  next.set(newKey, voice);
  return { overrides: Object.fromEntries(next), migrated: true, voice };
}

/** Persist the label-key migration used by session rename. */
export function migrateVoiceOverride(
  oldLabel: string,
  newLabel: string,
  options: VoiceOverrideOptions = {},
): boolean {
  const migration = migrateVoiceOverrideMap(voiceOverrides(options), oldLabel, newLabel);
  if (!migration.migrated) return false;
  writeVoiceOverrides(migration.overrides, options);
  return true;
}

/** Stable per-session voice; a stale/invalid override falls back within the valid ring. */
export function voiceFor(
  cfg: Config,
  label: string,
  options: VoiceOverrideOptions = {},
): string {
  const map = voiceOverrides(options);
  const key = voiceOverrideKey(label);
  const override = Object.hasOwn(map, key) ? map[key]! : "";
  const cacheMatches = voiceCacheKey === voiceConfigKey(cfg);
  return selectVoice(cfg.ttsVoices, label, override, cacheMatches ? availableVoices : null, knownGoodVoice || "af_heart");
}

async function queryAvailableVoices(cfg: Config, signal: AbortSignal): Promise<Set<string> | null> {
  try {
    const url = new URL(`http://127.0.0.1:${cfg.ttsPort}/v1/audio/voices`);
    url.searchParams.set("model", cfg.ttsModel);
    const response = await awaitWithAbort(fetch(url, { signal }), signal);
    if (!response.ok) {
      await awaitWithAbort(response.arrayBuffer(), signal);
      return null;
    }
    const body: unknown = await awaitWithAbort(response.json(), signal);
    if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) return null;
    const voices = new Set<string>();
    for (const item of body.data) {
      if (item && typeof item === "object" && "id" in item && typeof item.id === "string" && isValidVoiceName(item.id)) {
        voices.add(item.id);
      }
    }
    return voices.size ? voices : null;
  } catch {
    return null;
  }
}

function readinessConfigKey(cfg: Config): string {
  return `${cfg.ttsPort}|${cfg.ttsModel}|${cfg.ttsSpeed}`;
}

function voiceConfigKey(cfg: Config): string {
  return `${cfg.ttsEngine}|${cfg.ttsPort}|${cfg.ttsModel}`;
}

function cacheWorkerVoices(cfg: Config, worker: TtsWorkerBackend): void {
  const discovered = new Set(worker.availableVoices().filter(isValidVoiceName));
  // The worker handshake echoes the configured ring rather than performing
  // HTTP-style model discovery. Do not let one daemon/test instance globally
  // filter persisted pins for a later config instance.
  availableVoices = null;
  voiceCacheKey = voiceConfigKey(cfg);
  knownGoodVoice = discovered.values().next().value ?? "af_heart";
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    await Bun.sleep(ms);
    return true;
  }
  if (signal.aborted) return false;
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

/**
 * Shared synthesis-readiness canary. It requests WAV, consumes the entire body,
 * validates RIFF/PCM, and only then transitions health to ready.
 */
export async function ensureTtsReady(
  cfg: Config,
  timeoutMs = 30_000,
  signal?: AbortSignal,
  warn?: WatchdogWarning,
): Promise<boolean> {
  if (cfg.ttsEngine !== "server" || !cfg.ttsPort || signal?.aborted) return false;
  const key = readinessConfigKey(cfg);
  if (readinessKey === key && ttsHealth.snapshot().status === "ready") return true;
  if (readinessPromise && readinessKey === key) return readinessPromise;

  if (readinessKey && readinessKey !== key) resetTtsReadiness();
  readinessKey = key;
  const controller = new AbortController();
  readinessController = controller;
  const canarySignal = combinedSignal([controller.signal, signal]);
  const deadline = performance.now() + timeoutMs;

  const promise = (async () => {
    const discovered = await queryAvailableVoices(
      cfg,
      combinedSignal([canarySignal, AbortSignal.timeout(Math.max(250, Math.min(5000, timeoutMs)))]),
    );
    if (canarySignal.aborted) return false;
    const ring = validateVoiceRing(cfg.ttsVoices, discovered);
    const voice = ring[0]!;
    let overloadRetries = 0;
    let inferenceRetries = 0;
    while (!canarySignal.aborted && performance.now() < deadline) {
      const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
      const outcome = await trySynth(cfg, "Ready.", voice, null, {
        signal: canarySignal,
        timeoutMs: Math.min(30_000, remaining),
        speed: cfg.ttsSpeed * (inferenceRetries ? 1.003 : 1),
        warn,
      });
      if (outcome.kind === "audio") {
        if (readinessKey !== key || readinessController !== controller) return false;
        availableVoices = discovered;
        voiceCacheKey = voiceConfigKey(cfg);
        knownGoodVoice = voice;
        return true;
      }
      if (outcome.kind === "cancelled") return false;
      if (outcome.kind === "http-config-failure" && !outcome.retryable) return false;
      if (outcome.kind === "http-config-failure" && outcome.retryable && overloadRetries++ >= 2) return false;
      if (outcome.kind === "post-header-inference-failure" && inferenceRetries++ >= 1) return false;
      if (!(await abortableSleep(outcome.kind === "http-config-failure" ? 300 * overloadRetries : 400, canarySignal))) {
        return false;
      }
    }
    return false;
  })();

  readinessPromise = promise;
  try {
    return await promise;
  } finally {
    if (readinessPromise === promise) readinessPromise = null;
    if (readinessController === controller) readinessController = null;
  }
}

/** Backwards-compatible name; now an actual fully-consumed synthesis probe. */
export function probeTtsServer(
  cfg: Config,
  timeoutMs: number,
  signal?: AbortSignal,
  warn?: WatchdogWarning,
): Promise<boolean> {
  return ensureTtsReady(cfg, timeoutMs, signal, warn);
}

/**
 * Cheap ownership/adoption check. Unlike synthesis readiness, any completed
 * HTTP response proves another process owns the configured port.
 */
export async function probeTtsServerPresence(cfg: Config, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (cfg.ttsEngine !== "server" || !cfg.ttsPort || signal?.aborted) return false;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = combinedSignal([signal, timeout]);
    const response = await awaitWithAbort(fetch(`http://127.0.0.1:${cfg.ttsPort}/`, {
      signal: requestSignal,
    }), requestSignal);
    await awaitWithAbort(response.arrayBuffer(), requestSignal);
    return true;
  } catch {
    return false;
  }
}

/** Invalidate old child results and abort its readiness work before respawn. */
export function resetTtsReadiness(): void {
  readinessController?.abort();
  readinessController = null;
  readinessPromise = null;
  readinessKey = "";
  voiceCacheKey = "";
  availableVoices = null;
  knownGoodVoice = "";
  ttsHealth.reset();
}

// --- playback -----------------------------------------------------------

function trackProcess(process: AudioProcess, control?: CancelControl): AudioProcess {
  activeAudioProcesses.add(process);
  control?.processes.add(process);
  void process.exited.then(
    () => {
      activeAudioProcesses.delete(process);
      control?.processes.delete(process);
    },
    () => {
      activeAudioProcesses.delete(process);
      control?.processes.delete(process);
    },
  );
  return process;
}

function untrackProcess(process: AudioProcess, control?: CancelControl): void {
  activeAudioProcesses.delete(process);
  control?.processes.delete(process);
}

async function awaitAudioProcess(
  process: AudioProcess,
  operation: string,
  timeoutMs: number,
  warn: WatchdogWarning,
  control?: CancelControl,
): Promise<void> {
  let result: Awaited<ReturnType<typeof awaitProcessWithWatchdog>>;
  try {
    result = await awaitProcessWithWatchdog(process, {
      operation,
      timeoutMs,
      signal: control?.abort.signal,
      warn,
    });
  } finally {
    // A fake/broken child may never settle `exited`, even after SIGKILL. Do not
    // retain it in the global cancellation sets after releasing the await.
    untrackProcess(process, control);
  }
  // Stop the rest of a prefetched utterance after a playback timeout. Moving
  // on means releasing this utterance, not spawning its remaining children.
  if (result.status === "timed-out") control?.cancel();
}

/** Awaitable attention bell; callers can include it in their quiescence barrier. */
export async function bell(cfg: Config, options: SpeakRuntimeOptions = {}): Promise<void> {
  if (!cfg.bell) return;
  const runtime = runtimeOptions(options);
  const process = trackProcess(runtime.spawnAudio(["afplay", cfg.bellSound]));
  await awaitAudioProcess(process, "afplay attention bell", runtime.timeoutForText(""), runtime.warn);
}

function sayFlags(cfg: Config): string[] {
  return [...(cfg.voice ? ["-v", cfg.voice] : []), ...(cfg.sayRate > 0 ? ["-r", String(cfg.sayRate)] : [])];
}

function spawnSay(cfg: Config, text: string, control: CancelControl): AudioProcess {
  // Keep the measured volume match. Strip embedded [[...]] commands first.
  const safe = `[[volm ${cfg.sayVolume}]] ${text.replace(/\[\[|\]\]/g, "")}`;
  return trackProcess(
    control.runtime.spawnAudio(["say", ...sayFlags(cfg), "--", safe]),
    control,
  );
}

function reportKokoroFailure(
  control: CancelControl,
  reason: "readiness-failed" | "synth-timeout",
): void {
  if (control.cancelled || control.kokoroFailureReported) return;
  control.kokoroFailureReported = true;
  try { control.runtime.onKokoroFailure(reason); } catch {}
}

function newControl(options: SpeakRuntimeOptions = {}): CancelControl {
  const control: CancelControl = {
    cancelled: false,
    abort: new AbortController(),
    processes: new Set(),
    tempFiles: new Set(),
    runtime: runtimeOptions(options),
    kokoroFailureReported: false,
    cancel() {
      if (control.cancelled) return;
      control.cancelled = true;
      control.abort.abort();
      for (const process of control.processes) {
        try { process.kill("SIGKILL"); } catch {}
        try { process.unref?.(); } catch {}
      }
    },
  };
  return control;
}

/** Cancel all active utterances/processes; no singleton can hide an older owner. */
export function stopSpeaking(): void {
  for (const control of activeControls) control.cancel();
  for (const process of activeAudioProcesses) {
    try { process.kill("SIGKILL"); } catch {}
    try { process.unref?.(); } catch {}
  }
}

export async function speak(cfg: Config, text: string, label = "", options: SpeakRuntimeOptions = {}): Promise<void> {
  await speakCancellable(cfg, text, label, options).done;
}

export function speakCancellable(
  cfg: Config,
  text: string,
  label = "",
  options: SpeakRuntimeOptions = {},
): { done: Promise<void>; cancel: () => void } {
  if (!cfg.speak || !text) return { done: Promise.resolve(), cancel() {} };
  const control = newControl(options);
  activeControls.add(control);

  const done = (async () => {
    try {
      if (cfg.ttsEngine === "worker") {
        // Only the daemon injects its owned worker. Standalone hook/CLI calls
        // have no child to control and therefore fall back to say immediately.
        const worker = control.runtime.worker;
        if (worker?.isReady()) {
          cacheWorkerVoices(cfg, worker);
          const attempt: typeof trySynth = (attemptCfg, input, voice, attemptControl, attemptOptions) =>
            tryWorkerSynth(attemptCfg, input, voice, attemptControl ?? null, worker, attemptOptions);
          const result = await speakViaSynth(cfg, text, label, control, attempt);
          if (result !== "ok" && !control.cancelled) {
            const process = spawnSay(cfg, text, control);
            await awaitAudioProcess(process, "say", control.runtime.timeoutForText(text), control.runtime.warn, control);
          }
        } else if (!control.cancelled) {
          worker?.requestRecovery?.("speech requested while unavailable");
          reportKokoroFailure(control, "readiness-failed");
          const process = spawnSay(cfg, text, control);
          await awaitAudioProcess(process, "say", control.runtime.timeoutForText(text), control.runtime.warn, control);
        }
        return;
      }

      if (cfg.ttsEngine === "server" && cfg.ttsPort) {
        // Ordinary/standalone calls recover quickly, then use legitimate say.
        // Daemon server-mode supervision owns the longer startup canary.
        const kokoroReady = await ensureTtsReady(cfg, 1500, control.abort.signal, control.runtime.warn);
        if (kokoroReady) {
          const result = await speakViaSynth(cfg, text, label, control, trySynth);
          if (result !== "ok" && !control.cancelled) {
            const process = spawnSay(cfg, text, control);
            await awaitAudioProcess(process, "say", control.runtime.timeoutForText(text), control.runtime.warn, control);
          }
        } else if (!control.cancelled) {
          reportKokoroFailure(control, "readiness-failed");
          const process = spawnSay(cfg, text, control);
          await awaitAudioProcess(process, "say", control.runtime.timeoutForText(text), control.runtime.warn, control);
        }
        return;
      }

      if (!control.cancelled) {
        const process = spawnSay(cfg, text, control);
        await awaitAudioProcess(process, "say", control.runtime.timeoutForText(text), control.runtime.warn, control);
      }
    } finally {
      control.cancel();
      for (const file of control.tempFiles) {
        try { unlinkSync(file); } catch {}
      }
      control.tempFiles.clear();
      activeControls.delete(control);
    }
  })();

  return { done, cancel: () => control.cancel() };
}

type Playable = { file: string; text: string } | { say: string };
type SpeakSynthResult = "ok" | "synth-failed";
type SynthAttempt = typeof trySynth;

interface SynthBatch {
  text: string;
  originals: string[];
}

/** Sentence one remains isolated; only later short sentences are coalesced. */
export function makeSynthBatches(sentences: string[], cap: number): SynthBatch[] {
  if (!sentences.length) return [];
  if (cap <= 0) return sentences.map((text) => ({ text, originals: [text] }));
  const batches: SynthBatch[] = [{ text: sentences[0]!, originals: [sentences[0]!] }];
  for (const sentence of sentences.slice(1)) {
    const previous = batches[batches.length - 1]!;
    const combined = `${previous.text} ${sentence}`;
    if (previous !== batches[0] && combined.length <= cap) {
      previous.text = combined;
      previous.originals.push(sentence);
    } else {
      batches.push({ text: sentence, originals: [sentence] });
    }
  }
  return batches;
}

class AsyncQueue<T> {
  private values: T[] = [];
  private readers: Array<(value: T | undefined) => void> = [];
  private writers: Array<() => void> = [];
  private closed = false;

  constructor(private readonly capacity: number) {}

  async push(value: T): Promise<boolean> {
    while (!this.closed && this.values.length >= this.capacity) {
      await new Promise<void>((resolve) => this.writers.push(resolve));
    }
    if (this.closed) return false;
    const reader = this.readers.shift();
    if (reader) reader(value);
    else this.values.push(value);
    return true;
  }

  async shift(): Promise<T | undefined> {
    const value = this.values.shift();
    if (value !== undefined) {
      this.writers.shift()?.();
      return value;
    }
    if (this.closed) return undefined;
    return new Promise((resolve) => this.readers.push(resolve));
  }

  close(): void {
    this.closed = true;
    for (const reader of this.readers.splice(0)) reader(undefined);
    for (const writer of this.writers.splice(0)) writer();
  }
}

async function speakViaSynth(
  cfg: Config,
  text: string,
  label: string,
  control: CancelControl,
  attempt: SynthAttempt,
): Promise<SpeakSynthResult> {
  const selectedVoice = voiceFor(cfg, label);
  const sentences = splitSentences(text);
  if (!sentences.length) sentences.push(text);
  const batches = makeSynthBatches(sentences, cfg.ttsBatchChars);
  const queue = new AsyncQueue<Playable[]>(PREFETCH_DEPTH);
  let producerError: unknown = null;

  const producer = (async () => {
    try {
      for (const batch of batches) {
        if (control.cancelled) break;
        if (!(await queue.push(await synthBatch(cfg, batch, selectedVoice, control, attempt)))) break;
      }
    } catch (error) {
      producerError = error;
    } finally {
      queue.close();
    }
  })();

  let playedAny = false;
  try {
    while (!control.cancelled) {
      const playables = await queue.shift();
      if (!playables) break;
      for (const playable of playables) {
        if (control.cancelled) break;
        if ("say" in playable) {
          const process = spawnSay(cfg, playable.say, control);
          await awaitAudioProcess(
            process,
            "say",
            control.runtime.timeoutForText(playable.say),
            control.runtime.warn,
            control,
          );
        } else {
          await playFile(playable.file, playable.text, control);
        }
        playedAny = true;
      }
    }
  } catch (error) {
    control.cancel();
    throw error;
  } finally {
    queue.close();
    await producer;
    // Includes prefetched, current-bisect, and producer-exception files.
    for (const file of control.tempFiles) {
      try { unlinkSync(file); } catch {}
    }
    control.tempFiles.clear();
  }

  if (control.cancelled) return "ok";
  if (producerError && !playedAny) return "synth-failed";
  return playedAny ? "ok" : "synth-failed";
}

async function synthBatch(
  cfg: Config,
  batch: SynthBatch,
  voice: string,
  control: CancelControl,
  attempt: SynthAttempt,
): Promise<Playable[]> {
  const result = await synthPiece(
    cfg,
    batch.text,
    voice,
    control,
    batch.originals.length === 1,
    newSentenceSynthBudget(attempt),
  );
  if (result.kind !== "inference-failure" || batch.originals.length === 1) return result.playables;
  // A coalesced shape failure first returns to original sentence boundaries.
  const split: Playable[] = [];
  for (const original of batch.originals) {
    const item = await synthPiece(
      cfg,
      original,
      voice,
      control,
      true,
      newSentenceSynthBudget(attempt),
    );
    split.push(...item.playables);
  }
  return split;
}

type PieceResult = { kind: "done" | "inference-failure"; playables: Playable[] };

interface SentenceSynthBudget {
  deadline: number;
  timeoutCount: number;
  attempt: typeof trySynth;
}

function newSentenceSynthBudget(attempt: typeof trySynth = trySynth): SentenceSynthBudget {
  return { deadline: performance.now() + SYNTH_SENTENCE_BUDGET_MS, timeoutCount: 0, attempt };
}

function timedOut(outcome: TrySynthOutcome): boolean {
  return outcome.kind === "post-header-timeout"
    || (outcome.kind === "transport-failure" && outcome.timedOut);
}

async function synthPiece(
  cfg: Config,
  piece: string,
  voice: string,
  control: CancelControl,
  allowBisect = true,
  budget = newSentenceSynthBudget(),
): Promise<PieceResult> {
  if (!piece.trim() || control.cancelled) return { kind: "done", playables: [] };
  if (budget.timeoutCount >= SYNTH_TIMEOUT_LIMIT || performance.now() >= budget.deadline) {
    return { kind: "done", playables: [{ say: piece }] };
  }
  let effectiveVoice = voice;
  const speeds = [cfg.ttsSpeed, cfg.ttsSpeed * 1.003];
  let last: TrySynthOutcome = { kind: "post-header-inference-failure", status: 500, detail: "not attempted" };

  for (const speed of speeds) {
    let overloadRetries = 0;
    let transportRetries = 0;
    while (!control.cancelled) {
      const remaining = Math.max(1, Math.ceil(budget.deadline - performance.now()));
      if (remaining <= 1 || budget.timeoutCount >= SYNTH_TIMEOUT_LIMIT) {
        return { kind: "done", playables: [{ say: piece }] };
      }
      last = await budget.attempt(cfg, piece, effectiveVoice, control, {
        speed,
        timeoutMs: Math.min(SYNTH_ATTEMPT_TIMEOUT_MS, remaining),
        warn: control.runtime.warn,
      });
      if (last.kind === "audio") {
        const file = `/tmp/conch-tts-${process.pid}-${tmpCounter++}.wav`;
        const trimmed = trimWav(last.audio) ?? last.audio;
        control.tempFiles.add(file);
        await Bun.write(file, trimmed);
        return { kind: "done", playables: [{ file, text: piece }] };
      }
      if (last.kind === "cancelled") return { kind: "done", playables: [] };
      if (timedOut(last)) {
        reportKokoroFailure(control, "synth-timeout");
        budget.timeoutCount++;
        if (budget.timeoutCount >= SYNTH_TIMEOUT_LIMIT || performance.now() >= budget.deadline) {
          return { kind: "done", playables: [{ say: piece }] };
        }
        if (!(await abortableSleep(100, control.abort.signal))) return { kind: "done", playables: [] };
        continue;
      }
      if (last.kind === "post-header-inference-failure") break; // duration perturbation, then split
      if (last.kind === "transport-failure" && transportRetries++ < 1) {
        if (!(await abortableSleep(200, control.abort.signal))) return { kind: "done", playables: [] };
        continue;
      }
      if (last.kind === "http-config-failure" && last.retryable && overloadRetries++ < 2) {
        if (!(await abortableSleep(150 * overloadRetries, control.abort.signal))) return { kind: "done", playables: [] };
        continue;
      }
      // If a persisted/ring voice was rejected, retain Kokoro by using the
      // canary-proven voice. Model/config errors still stop here without split.
      if (
        last.kind === "http-config-failure" &&
        last.status >= 400 && last.status < 500 && last.status !== 429 &&
        knownGoodVoice && effectiveVoice !== knownGoodVoice
      ) {
        effectiveVoice = knownGoodVoice;
        overloadRetries = 0;
        transportRetries = 0;
        continue;
      }
      return { kind: "done", playables: [{ say: piece }] };
    }
    if (last.kind !== "post-header-inference-failure") break;
  }

  if (control.cancelled) return { kind: "done", playables: [] };
  if (last.kind !== "post-header-inference-failure") return { kind: "done", playables: [{ say: piece }] };
  if (!allowBisect) return { kind: "inference-failure", playables: [] };
  const halves = bisect(piece);
  if (!halves) return { kind: "inference-failure", playables: [{ say: piece }] };
  const left = await synthPiece(cfg, halves[0], effectiveVoice, control, true, budget);
  const right = await synthPiece(cfg, halves[1], effectiveVoice, control, true, budget);
  return { kind: "inference-failure", playables: [...left.playables, ...right.playables] };
}

/** Deterministic ladder seam: verifies retry/bisection policy without spawning playback. */
export async function runSynthLadderForTest(
  cfg: Config,
  piece: string,
  outcomes: TrySynthOutcome[],
  onKokoroFailure: SpeakRuntimeOptions["onKokoroFailure"] = () => {},
): Promise<{ attempts: number; sayFallbacks: string[] }> {
  if (!outcomes.length) throw new Error("at least one synth outcome is required");
  let attempts = 0;
  const attempt: typeof trySynth = async () => outcomes[Math.min(attempts++, outcomes.length - 1)]!;
  const control = newControl({ warn: () => {}, onKokoroFailure });
  try {
    const result = await synthPiece(cfg, piece, "af_heart", control, true, newSentenceSynthBudget(attempt));
    return {
      attempts,
      sayFallbacks: result.playables.flatMap((playable) => "say" in playable ? [playable.say] : []),
    };
  } finally {
    control.cancel();
  }
}

async function playFile(file: string, text: string, control: CancelControl): Promise<void> {
  const process = trackProcess(control.runtime.spawnAudio(["afplay", file]), control);
  try {
    await awaitAudioProcess(
      process,
      "afplay speech",
      control.runtime.timeoutForText(text),
      control.runtime.warn,
      control,
    );
  } finally {
    try { unlinkSync(file); } catch {}
    control.tempFiles.delete(file);
  }
}
