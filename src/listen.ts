import { existsSync, statSync, unlinkSync } from "node:fs";
import type { Config } from "./config.ts";
import { transcribeWav } from "./transcribe.ts";

// Anything smaller than this is silence / sox header only.
const MIN_WAV_BYTES = 16_000; // ~0.5s of 16kHz 16-bit mono

/**
 * Capture one utterance and transcribe it.
 *
 * sox's `silence` effect does the endpointing: recording starts when the mic
 * crosses the start threshold and stops after `endSilenceSecs` of quiet.
 * But that trigger is jumpy — the tail of the mic-open cue, a keyboard
 * clack, a chair creak can "start" a recording that then closes on silence
 * long before the user speaks (observed live: a 30s window dead after 8s).
 * So sox runs in a re-arm loop: a near-empty capture or an empty transcript
 * is a false start, and the mic re-opens until the start window is truly
 * spent. Once real speech is flowing, the utterance gets its own budget.
 */
export async function listenOnce(cfg: Config): Promise<{ text: string; error?: string }> {
  const opened = Date.now();
  const secondsOpen = () => (Date.now() - opened) / 1000;

  while (secondsOpen() < cfg.listenWindowSecs) {
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

    let speechStarted = false;
    const watchdog = setInterval(() => {
      let size = 0;
      try {
        size = statSync(wav).size;
      } catch {}
      if (!speechStarted && size >= MIN_WAV_BYTES) speechStarted = true;
      if (!speechStarted && secondsOpen() >= cfg.listenWindowSecs) rec.kill();
      if (speechStarted && secondsOpen() >= cfg.listenWindowSecs + cfg.maxUtteranceSecs) rec.kill();
    }, 500);

    await rec.exited;
    clearInterval(watchdog);

    try {
      if (existsSync(wav) && statSync(wav).size >= MIN_WAV_BYTES) {
        const result = await transcribeWav(cfg, wav);
        if (result.error) return result;
        if (result.text) return result;
        // transcribed to nothing — a noise blip, not speech; re-arm
      }
    } finally {
      try {
        unlinkSync(wav);
      } catch {}
    }
  }

  return { text: "" }; // window spent with no real speech
}
