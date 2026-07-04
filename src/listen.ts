import { existsSync, statSync, unlinkSync } from "node:fs";
import type { Config } from "./config.ts";
import { transcribeWav } from "./transcribe.ts";

// Anything smaller than this is silence / sox header only.
const MIN_WAV_BYTES = 16_000; // ~0.5s of 16kHz 16-bit mono

/**
 * Capture one utterance and transcribe it.
 *
 * sox's `silence` effect does the endpointing: recording starts when the mic
 * crosses the start threshold and stops after `endSilenceSecs` of quiet, so a
 * listening window "just works" — start talking, pause, and it wraps up.
 * A hard timeout closes the window if nothing (or too much) comes in.
 */
export async function listenOnce(cfg: Config): Promise<{ text: string; error?: string }> {
  const wav = `/tmp/conch-utterance-${process.pid}-${Date.now()}.wav`;

  const rec = Bun.spawn(
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

  // Two clocks: listenWindowSecs to START talking, maxUtteranceSecs once
  // you have. Speech-start is detected by the wav growing past header size
  // (sox's silence effect writes nothing until the threshold trips).
  const startedAt = Date.now();
  let speechStarted = false;
  const watchdog = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    let size = 0;
    try {
      size = statSync(wav).size;
    } catch {}
    if (!speechStarted && size >= MIN_WAV_BYTES) speechStarted = true;
    if (!speechStarted && elapsed >= cfg.listenWindowSecs) rec.kill();
    if (speechStarted && elapsed >= cfg.maxUtteranceSecs) rec.kill();
  }, 500);

  await rec.exited;
  clearInterval(watchdog);

  try {
    if (!existsSync(wav) || statSync(wav).size < MIN_WAV_BYTES) {
      return { text: "" }; // window closed with no speech
    }
    return await transcribeWav(cfg, wav);
  } finally {
    try {
      unlinkSync(wav);
    } catch {}
  }
}
