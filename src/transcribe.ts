import { existsSync, unlinkSync } from "node:fs";
import type { Config } from "./config.ts";

/**
 * Two transcription paths:
 *  - warm: whisper-server (model stays loaded; ~1-2s for short clips) —
 *    the daemon spawns and owns it; this module just talks to it
 *  - cold: whisper-cli (reloads the model every call; seconds slower) —
 *    the fallback when no server is up
 */

let serverHealthy = false;

export function serverUp(): boolean {
  return serverHealthy;
}

/** Poll the server until it answers (model load takes a few seconds) or the timeout passes. */
export async function probeServer(cfg: Config, timeoutMs: number): Promise<boolean> {
  if (!cfg.whisperPort) return (serverHealthy = false);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.whisperPort}/`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.status < 500) return (serverHealthy = true);
    } catch {}
    await Bun.sleep(400);
  }
  return (serverHealthy = false);
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

export async function transcribePcm(cfg: Config, pcm: Uint8Array): Promise<{ text: string; error?: string }> {
  const wav = wavFromRawPcm(pcm);

  if (cfg.whisperPort && serverHealthy) {
    try {
      const form = new FormData();
      form.append("file", new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }), "audio.wav");
      form.append("response_format", "json");
      const res = await fetch(`http://127.0.0.1:${cfg.whisperPort}/inference`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { text?: string };
        return { text: cleanTranscript(body.text ?? "") };
      }
    } catch {
      // server hiccup or wedge — latch down so we don't pay the (up to 60s)
      // timeout on every subsequent utterance; the cold cli path takes over.
      // (Recovers warm on the next daemon restart, which re-probes.)
      serverHealthy = false;
    }
  }

  const tmp = `/tmp/conch-cli-${process.pid}-${Date.now()}.wav`;
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
