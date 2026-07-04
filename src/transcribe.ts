import { existsSync } from "node:fs";
import type { Config } from "./config.ts";

/**
 * Transcribe a wav with whisper.cpp + Silero VAD.
 * Same invocation seashell uses (large-v3-turbo, Metal, no timestamps).
 */
export async function transcribeWav(cfg: Config, wavPath: string): Promise<{ text: string; error?: string }> {
  if (!existsSync(wavPath)) return { text: "", error: `File not found: ${wavPath}` };

  const proc = Bun.spawn(
    [
      cfg.whisperCli,
      "-m", cfg.whisperModel,
      "-vm", cfg.vadModel,
      "--vad",
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

  const text = output
    .replace(/\[.*?\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (code !== 0 && !text) return { text: "", error: "Transcription failed" };
  return { text };
}
