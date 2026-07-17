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

  async transcribeWarm(cfg: Config, wav: Uint8Array, timeoutMs = 60_000): Promise<WarmTranscriptionResult> {
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
          form.append("response_format", "json");
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

  const warm = await whisperServerClient.transcribeWarm(cfg, wav);
  if (warm.status === "ok") {
    onEngine?.("warm");
    return { text: cleanTranscript(warm.body.text) };
  }
  if (options.coldFallback === false) return { text: "" };

  const tmp = `/tmp/conch-cli-${process.pid}-${Date.now()}.wav`;
  onEngine?.("cold");
  await Bun.write(tmp, wav as unknown as Uint8Array<ArrayBuffer>);
  try {
    return await transcribeWavCli(cfg, tmp);
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
