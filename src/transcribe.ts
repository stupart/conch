import { existsSync, unlinkSync } from "node:fs";
import { awaitWithAbort } from "./audio-watchdog.ts";
import type { Config } from "./config.ts";
import type { TranscriptionEngine } from "./diagnostics.ts";

/**
 * Two transcription paths:
 *  - warm: whisper-server (model stays loaded; ~1-2s for short clips) —
 *    the daemon spawns and owns it; this module just talks to it
 *  - cold: whisper-cli (reloads the model every call; seconds slower) —
 *    the fallback when no server is up
 */

export type WhisperRecoveryReason = "request-failed";

export interface WhisperResponseBody {
  text: string;
  segments?: unknown;
}

export type WarmTranscriptionResult =
  | { status: "ok"; body: WhisperResponseBody }
  | { status: "unavailable" }
  | { status: "failed" };

export interface WhisperServerClientOptions {
  request?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
}

const HALLUCINATION_BLOCKLIST = new Set([
  "bye",
  "thank you",
  "thank you for watching",
  "thanks for watching",
  "you",
]);
const PROTECTED_SHORT_REPLIES = new Set([
  "cancel",
  "continue",
  "go",
  "mute",
  "no",
  "pause",
  "send",
  "stop",
  "yes",
]);
const MAX_HALLUCINATION_CAPTURE_BYTES = 8 * 16_000 * 2;
const LOW_ENERGY_WINDOW_RMS = 0.012;
const HIGH_NO_SPEECH_PROBABILITY = 0.8;
const VERY_LOW_AVG_LOGPROB = -1.5;

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Whisper operation cancelled", "AbortError");
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(true);
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function responseBody(value: unknown): WhisperResponseBody {
  if (!value || typeof value !== "object" || typeof (value as { text?: unknown }).text !== "string") {
    throw new Error("whisper-server returned malformed JSON");
  }
  const body = value as { text: string; segments?: unknown };
  return { text: body.text, ...(body.segments === undefined ? {} : { segments: body.segments }) };
}

function normalizeTranscriptForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Highest 100ms-window RMS, normalized to full-scale signed 16-bit PCM. */
function peakWindowRms(pcm: Uint8Array): number {
  const byteLength = pcm.byteLength - (pcm.byteLength % 2);
  if (!byteLength) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, byteLength);
  const frameSamples = 1_600;
  let peak = 0;
  for (let first = 0; first < byteLength / 2; first += frameSamples) {
    const last = Math.min(byteLength / 2, first + frameSamples);
    let sumSquares = 0;
    for (let sample = first; sample < last; sample++) {
      const normalized = view.getInt16(sample * 2, true) / 32_768;
      sumSquares += normalized * normalized;
    }
    peak = Math.max(peak, Math.sqrt(sumSquares / (last - first)));
  }
  return peak;
}

function hasLowConfidence(segments: unknown): boolean {
  if (!Array.isArray(segments) || segments.length === 0) return false;
  const records = segments.filter(
    (segment): segment is Record<string, unknown> => Boolean(segment) && typeof segment === "object",
  );
  if (records.length !== segments.length) return false;
  const highNoSpeech = records.every((segment) => (
    typeof segment.no_speech_prob === "number"
    && Number.isFinite(segment.no_speech_prob)
    && segment.no_speech_prob >= HIGH_NO_SPEECH_PROBABILITY
  ));
  const veryLowLogprob = records.every((segment) => (
    typeof segment.avg_logprob === "number"
    && Number.isFinite(segment.avg_logprob)
    && segment.avg_logprob <= VERY_LOW_AVG_LOGPROB
  ));
  return highNoSpeech || veryLowLogprob;
}

/**
 * Conservative whole-result hallucination filter. A known phantom phrase is
 * discarded only for a short capture with strong energy/confidence evidence.
 * Missing server metadata fails open, and command words are protected even if
 * a future blocklist edit accidentally adds one.
 */
export function isLikelyWhisperHallucination(
  text: string,
  pcm: Uint8Array,
  segments?: unknown,
): boolean {
  const normalized = normalizeTranscriptForMatch(text);
  if (!HALLUCINATION_BLOCKLIST.has(normalized) || PROTECTED_SHORT_REPLIES.has(normalized)) return false;
  if (pcm.byteLength > MAX_HALLUCINATION_CAPTURE_BYTES) return false;
  return peakWindowRms(pcm) <= LOW_ENERGY_WINDOW_RMS || hasLowConfidence(segments);
}

export function filterWhisperTranscript(raw: string, pcm: Uint8Array, segments?: unknown): string {
  const text = cleanTranscript(raw);
  return isLikelyWhisperHallucination(text, pcm, segments) ? "" : text;
}

/**
 * One exclusion lane and health epoch for every warm Whisper request. The
 * supervisor enters this same lane for its final re-probe + owned-child
 * retirement boundary, so a live inference can never be killed underneath it.
 */
export class WhisperServerClient {
  private healthy = false;
  private tail: Promise<void> = Promise.resolve();
  private warmRequests = new Set<AbortController>();
  private recovery: (reason: WhisperRecoveryReason) => void = () => {};
  private readonly request: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<boolean>;

  constructor(options: WhisperServerClientOptions = {}) {
    this.request = options.request ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? defaultSleep;
  }

  serverUp(): boolean {
    return this.healthy;
  }

  setRecoveryHandler(handler?: (reason: WhisperRecoveryReason) => void): void {
    this.recovery = handler ?? (() => {});
  }

  resetHealth(): void {
    this.healthy = false;
  }

  /** Synchronously fail closed and release live/queued inference on shutdown. */
  cancelWarmRequests(): void {
    this.resetHealth();
    const requests = [...this.warmRequests];
    this.warmRequests.clear();
    for (const request of requests) {
      try { request.abort(new DOMException("Whisper client shutting down", "AbortError")); } catch {}
    }
  }

  /** Serialize warm inference with supervisor probes/retirement. */
  runExclusive<T>(task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const laneSignal = signal ?? new AbortController().signal;
    const queued = this.tail.then(
      async () => {
        if (laneSignal.aborted) throw abortError(laneSignal);
        return task(laneSignal);
      },
      async () => {
        if (laneSignal.aborted) throw abortError(laneSignal);
        return task(laneSignal);
      },
    );
    this.tail = queued.then(() => {}, () => {});
    return signal ? awaitWithAbort(queued, signal) : queued;
  }

  /** Any completed HTTP response proves that the configured port is owned. */
  async probePresenceUnlocked(cfg: Config, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (!cfg.whisperPort || signal?.aborted) return false;
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (!signal?.aborted && Date.now() < deadline) {
      try {
        const remaining = deadline - Date.now();
        const requestSignal = combinedSignal(signal, Math.min(1_500, remaining));
        const response = await awaitWithAbort(
          this.request(`http://127.0.0.1:${cfg.whisperPort}/`, { signal: requestSignal }),
          requestSignal,
        );
        await awaitWithAbort(response.arrayBuffer(), requestSignal);
        return true;
      } catch {
        if (signal?.aborted) return false;
      }
      if (!(await this.sleep(Math.min(400, Math.max(0, deadline - Date.now())), signal))) return false;
    }
    return false;
  }

  /**
   * Wait for the listener, then run a tiny silent inference canary. `/` alone
   * only proves port ownership; the canary proves the model path is usable.
   */
  async probeReadyUnlocked(cfg: Config, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (!cfg.whisperPort || signal?.aborted) return false;
    const deadline = Date.now() + Math.max(1, timeoutMs);
    let rootReady = false;
    while (!signal?.aborted && Date.now() < deadline) {
      try {
        const remaining = deadline - Date.now();
        const requestSignal = combinedSignal(signal, Math.min(1_500, remaining));
        const response = await awaitWithAbort(
          this.request(`http://127.0.0.1:${cfg.whisperPort}/`, { signal: requestSignal }),
          requestSignal,
        );
        await awaitWithAbort(response.arrayBuffer(), requestSignal);
        rootReady = response.status < 500;
        break;
      } catch {
        if (signal?.aborted) return false;
      }
      if (!(await this.sleep(Math.min(400, Math.max(0, deadline - Date.now())), signal))) return false;
    }
    if (!rootReady || signal?.aborted) {
      this.resetHealth();
      return false;
    }

    try {
      const remaining = Math.max(1, deadline - Date.now());
      const requestSignal = combinedSignal(signal, Math.min(5_000, remaining));
      const form = new FormData();
      const wav = wavFromRawPcm(new Uint8Array(8_000)); // 250ms silence; VAD returns immediately
      form.append("file", new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }), "canary.wav");
      form.append("response_format", "json");
      const response = await awaitWithAbort(this.request(
        `http://127.0.0.1:${cfg.whisperPort}/inference`,
        { method: "POST", body: form, signal: requestSignal },
      ), requestSignal);
      if (!response.ok) {
        this.resetHealth();
        return false;
      }
      responseBody(await awaitWithAbort(response.json(), requestSignal));
      this.healthy = true;
      return true;
    } catch {
      this.resetHealth();
      return false;
    }
  }

  async transcribeWarm(
    cfg: Config,
    wav: Uint8Array,
    timeoutMs = 60_000,
    includeConfidence = true,
  ): Promise<WarmTranscriptionResult> {
    if (!cfg.whisperPort || !this.healthy) return { status: "unavailable" };
    const request = new AbortController();
    this.warmRequests.add(request);
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), request.signal]);
    try {
      return await this.runExclusive(async (laneSignal) => {
        // Health may have changed while this request waited behind another.
        if (!this.healthy) return { status: "unavailable" } as const;
        try {
          const form = new FormData();
          form.append("file", new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }), "audio.wav");
          form.append("response_format", includeConfidence ? "verbose_json" : "json");
          if (includeConfidence) {
            // verbose_json is the only whisper.cpp format that exposes segment
            // confidence. Skip timestamps/language probabilities to avoid their
            // otherwise unnecessary token and language-detection work.
            form.append("no_timestamps", "true");
            form.append("no_language_probabilities", "true");
          }
          const response = await awaitWithAbort(this.request(
            `http://127.0.0.1:${cfg.whisperPort}/inference`,
            { method: "POST", body: form, signal: laneSignal },
          ), laneSignal);
          if (!response.ok) throw new Error(`whisper-server returned HTTP ${response.status}`);
          return {
            status: "ok" as const,
            body: responseBody(await awaitWithAbort(response.json(), laneSignal)),
          };
        } catch (error) {
          // Fail closed before this exclusive task settles. Otherwise the lane
          // could advance a queued request while the outer catch still sees a
          // stale healthy epoch, buying another full warm timeout.
          this.resetHealth();
          throw error;
        }
      }, signal);
    } catch {
      this.resetHealth();
      // The daemon installs ServerSupervisor.requestRecovery here. It only
      // enqueues/coalesces background work and is never awaited by this path.
      try { this.recovery("request-failed"); } catch {}
      return { status: "failed" };
    } finally {
      this.warmRequests.delete(request);
    }
  }
}

export const whisperServerClient = new WhisperServerClient();

export function serverUp(): boolean {
  return whisperServerClient.serverUp();
}

/** Poll the server until it answers (model load takes a few seconds) or the timeout passes. */
export function probeServer(cfg: Config, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return whisperServerClient.runExclusive(
    (laneSignal) => whisperServerClient.probeReadyUnlocked(cfg, timeoutMs, laneSignal),
    signal,
  );
}

/** Wrap headerless 16kHz 16-bit mono PCM in a WAV container. */
export function wavFromRawPcm(pcm: Uint8Array, sampleRate = 16000): Uint8Array {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const str = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  str(36, "data");
  v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

export async function transcribePcm(
  cfg: Config,
  pcm: Uint8Array,
  onEngine?: (engine: TranscriptionEngine) => void,
  options: { coldFallback?: boolean } = {},
): Promise<{ text: string; error?: string }> {
  const wav = wavFromRawPcm(pcm);

  const warm = await whisperServerClient.transcribeWarm(
    cfg,
    wav,
    60_000,
    options.coldFallback !== false,
  );
  if (warm.status === "ok") {
    onEngine?.("warm");
    return { text: filterWhisperTranscript(warm.body.text, pcm, warm.body.segments) };
  }
  if (options.coldFallback === false) return { text: "" };

  const tmp = `/tmp/conch-cli-${process.pid}-${Date.now()}.wav`;
  onEngine?.("cold");
  await Bun.write(tmp, wav as unknown as Uint8Array<ArrayBuffer>);
  try {
    const result = await transcribeWavCli(cfg, tmp);
    return { ...result, text: filterWhisperTranscript(result.text, pcm) };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

/** Cold path: whisper-cli on a wav file. Same invocation seashell uses. */
async function transcribeWavCli(cfg: Config, wavPath: string): Promise<{ text: string; error?: string }> {
  if (!existsSync(wavPath)) return { text: "", error: `File not found: ${wavPath}` };

  const proc = Bun.spawn(
    [
      cfg.whisperCli,
      "-m", cfg.whisperModel,
      "-vm", cfg.vadModel,
      "--vad",
      "--vad-speech-pad-ms", "300",
      "-f", wavPath,
      "-l", "en",
      "-t", "6",
      "-nt",
      "-np",
      "-mc", "0",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );

  const output = await new Response(proc.stdout).text();
  const code = await proc.exited;

  const text = cleanTranscript(output);
  if (code !== 0 && !text) return { text: "", error: "Transcription failed" };
  return { text };
}

function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[.*?\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
