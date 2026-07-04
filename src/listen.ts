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

  const timeout = setTimeout(() => rec.kill(), cfg.listenWindowSecs * 1000);
  await rec.exited;
  clearTimeout(timeout);

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
