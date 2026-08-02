import type { Config } from "./config.ts";
import { speakCancellable } from "./speak.ts";
import type { AudioSpawner, WatchdogProcess } from "./audio-watchdog.ts";

export const MICROPHONE_PROBE_DURATION_MS = 300;
export const TTS_PROBE_WORD = "Ready.";

const MICROPHONE_PROBE_TIMEOUT_MS = 3_000;
const TTS_PROBE_TIMEOUT_MS = 5_000;

export interface DoctorProbeResult {
  /** Live probes are advisory: callers should display this, not use it as the doctor's exit status. */
  ok: boolean;
  label: "microphone" | "TTS";
  message: string;
  action?: string;
}

export interface MicrophoneCapture {
  pcm: Uint8Array;
}

export type MicrophoneCaptureRunner = (
  durationMs: number,
) => Promise<MicrophoneCapture>;

export interface MicrophoneProbeOptions {
  capture?: MicrophoneCaptureRunner;
  durationMs?: number;
}

export type TtsProbeRunner = (
  cfg: Config,
  word: string,
  timeoutMs: number,
) => Promise<void>;

export interface TtsProbeOptions {
  speak?: TtsProbeRunner;
  word?: string;
  timeoutMs?: number;
}

const MICROPHONE_PERMISSION_ACTION =
  "Grant access in System Settings › Privacy & Security › Microphone, then run `conch doctor` again.";

const TTS_FAILURE_ACTION =
  "Check the selected sound output and volume, run `conch setup`, then run `conch doctor` again.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The exact finite SoX recording used by the live doctor probe. */
export function microphoneProbeCommand(durationMs = MICROPHONE_PROBE_DURATION_MS): string[] {
  const seconds = Math.max(1, durationMs) / 1_000;
  return [
    "sox", "-d", "-q",
    "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw",
    "-",
    "trim", "0", String(seconds),
  ];
}

/** Raw capture is mono signed 16-bit PCM. Ignore an impossible trailing partial sample. */
export function pcm16HasNonZeroSample(pcm: Uint8Array): boolean {
  for (let offset = 0; offset + 1 < pcm.byteLength; offset += 2) {
    if (pcm[offset] !== 0 || pcm[offset + 1] !== 0) return true;
  }
  return false;
}

async function captureMicrophoneWithSox(durationMs: number): Promise<MicrophoneCapture> {
  const process = Bun.spawn(microphoneProbeCommand(durationMs), {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try { process.kill("SIGKILL"); } catch {}
    try { process.unref(); } catch {}
  }, Math.max(MICROPHONE_PROBE_TIMEOUT_MS, durationMs + 1_000));

  try {
    const [exitCode, pcmBuffer, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).arrayBuffer(),
      new Response(process.stderr).text(),
    ]);
    if (timedOut) throw new Error("SoX microphone capture timed out");
    if (exitCode !== 0) {
      const detail = stderr.trim();
      throw new Error(`SoX exited with code ${exitCode}${detail ? `: ${detail}` : ""}`);
    }
    return { pcm: new Uint8Array(pcmBuffer) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Record just long enough to distinguish a real input stream from the all-zero
 * stream seen when microphone access is unavailable. A quiet room still has a
 * nonzero hardware noise floor; this deliberately does not impose a loudness
 * threshold.
 */
export async function checkMicrophone(
  options: MicrophoneProbeOptions = {},
): Promise<DoctorProbeResult> {
  const durationMs = options.durationMs ?? MICROPHONE_PROBE_DURATION_MS;
  try {
    const { pcm } = await (options.capture ?? captureMicrophoneWithSox)(durationMs);
    if (!pcm16HasNonZeroSample(pcm)) {
      return {
        ok: false,
        label: "microphone",
        message: "microphone capture was all zeros — likely a microphone-permission problem.",
        action: MICROPHONE_PERMISSION_ACTION,
      };
    }
    return {
      ok: true,
      label: "microphone",
      message: `microphone captured non-zero audio (${durationMs}ms)`,
    };
  } catch (error) {
    return {
      ok: false,
      label: "microphone",
      message: `microphone live check failed: ${errorMessage(error)}`,
      action: MICROPHONE_PERMISSION_ACTION,
    };
  }
}

function checkedAudioSpawner(): AudioSpawner {
  return (command: string[]): WatchdogProcess => {
    const process = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
    const exited = Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]).then(([exitCode, stderr]) => {
      if (exitCode !== 0) {
        const detail = stderr.trim();
        throw new Error(`${command[0] ?? "audio command"} exited with code ${exitCode}${detail ? `: ${detail}` : ""}`);
      }
      return exitCode;
    });
    return {
      exited,
      kill: (signal) => process.kill(signal),
      unref: () => process.unref(),
    };
  };
}

async function speakThroughConfiguredPath(cfg: Config, word: string, timeoutMs: number): Promise<void> {
  const warnings: string[] = [];
  const utterance = speakCancellable(
    { ...cfg, speak: true },
    word,
    "doctor",
    {
      spawnAudio: checkedAudioSpawner(),
      timeoutForText: () => timeoutMs,
      warn: (warning) => warnings.push(warning),
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    utterance.done.then(
      () => ({ kind: "done" as const }),
      (error: unknown) => ({ kind: "error" as const, error }),
    ),
    new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (outcome.kind === "timeout") {
    utterance.cancel();
    throw new Error(`configured TTS path timed out after ${timeoutMs}ms`);
  }
  if (outcome.kind === "error") throw outcome.error;
  if (warnings.length > 0) throw new Error(warnings.join("; "));
}

/** Speak one word through the same configured path used by conch at runtime. */
export async function checkTts(
  cfg: Config,
  options: TtsProbeOptions = {},
): Promise<DoctorProbeResult> {
  const word = options.word ?? TTS_PROBE_WORD;
  const timeoutMs = options.timeoutMs ?? TTS_PROBE_TIMEOUT_MS;
  try {
    await (options.speak ?? speakThroughConfiguredPath)(cfg, word, timeoutMs);
    return {
      ok: true,
      label: "TTS",
      message: `TTS spoke “${word}”`,
    };
  } catch (error) {
    return {
      ok: false,
      label: "TTS",
      message: `TTS live check failed: ${errorMessage(error)}`,
      action: TTS_FAILURE_ACTION,
    };
  }
}

/** One ready-to-print advisory line; intentionally uses a warning, never a fatal cross. */
export function formatDoctorProbe(result: DoctorProbeResult): string {
  return `${result.ok ? "✅" : "⚠️"} ${result.message}${result.action ? ` ${result.action}` : ""}`;
}
