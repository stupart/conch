import { statSync, unlinkSync } from "node:fs";
import type { Config } from "./config.ts";
import { transcribeWav } from "./transcribe.ts";

// Anything smaller than this is silence / sox header only.
const MIN_WAV_BYTES = 16_000; // ~0.5s of 16kHz 16-bit mono

interface Recorder {
  wav: string;
  proc: ReturnType<typeof Bun.spawn>;
  watchdog: ReturnType<typeof setInterval>;
}

/**
 * Capture one utterance and transcribe it.
 *
 * sox's `silence` effect does the endpointing, but its trigger is jumpy —
 * the mic-cue tail or a keyboard clack "starts" a recording that closes on
 * the quiet that follows. Two defenses, both born from live testing:
 *
 * 1. Re-arm on false starts: a near-empty capture or empty transcript
 *    re-opens the mic until the start window is genuinely spent.
 * 2. No dead zones: transcription (whisper reloads its model every call —
 *    seconds) runs with the NEXT recorder already armed, so words spoken
 *    while a noise blip is being transcribed land in the next capture
 *    instead of vanishing.
 */
export async function listenOnce(cfg: Config): Promise<{ text: string; error?: string }> {
  const opened = Date.now();
  const windowSpent = () => (Date.now() - opened) / 1000 >= cfg.listenWindowSecs;

  let rec = armRecorder(cfg, opened);

  while (true) {
    await rec.proc.exited;
    clearInterval(rec.watchdog);

    if (fileSize(rec.wav) < MIN_WAV_BYTES) {
      discard(rec.wav); // false start (or the window-timeout kill)
      if (windowSpent()) return { text: "" };
      rec = armRecorder(cfg, opened);
      continue;
    }

    const next = windowSpent() ? null : armRecorder(cfg, opened);
    const result = await transcribeWav(cfg, rec.wav);
    discard(rec.wav);

    if (result.error || result.text) {
      if (next) await disarm(next);
      return result;
    }
    if (!next) return { text: "" }; // noise transcribed to nothing, window over
    rec = next; // keep whatever the hot mic caught in the meantime
  }
}

function armRecorder(cfg: Config, opened: number): Recorder {
  const wav = `/tmp/conch-utterance-${process.pid}-${Date.now()}.wav`;
  const proc = Bun.spawn(
    [
      "sox", "-d", "-q",
      "-r", "16000", "-c", "1", "-b", "16",
      wav,
      "silence",
      "1", "0.15", `${cfg.startThresholdPct}%`,
      "1", `${cfg.endSilenceSecs}`, `${cfg.endThresholdPct}%`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  let speechStarted = false;
  const watchdog = setInterval(() => {
    if (!speechStarted && fileSize(wav) >= MIN_WAV_BYTES) speechStarted = true;
    const t = (Date.now() - opened) / 1000;
    if (!speechStarted && t >= cfg.listenWindowSecs) proc.kill();
    if (speechStarted && t >= cfg.listenWindowSecs + cfg.maxUtteranceSecs) proc.kill();
  }, 500);

  return { wav, proc, watchdog };
}

async function disarm(rec: Recorder): Promise<void> {
  rec.proc.kill();
  clearInterval(rec.watchdog);
  await rec.proc.exited;
  discard(rec.wav);
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}
