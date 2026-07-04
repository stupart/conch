import { unlinkSync } from "node:fs";
import type { Config } from "./config.ts";

/**
 * Two TTS engines:
 *  - "server": a warm local Kokoro server (mlx-audio, OpenAI-compatible
 *    /v1/audio/speech) — dramatically more natural than `say`, ~0.3-1s to
 *    synthesize a short utterance on Apple Silicon, and 50+ voices, which
 *    buys the fun part: every session speaks in its own voice.
 *  - "say": macOS built-in — zero setup, always available, the fallback.
 *
 * The daemon spawns and owns the server (same pattern as whisper-server);
 * this module just talks to it. Standalone hook runs (daemon down) use
 * `say` unless the server happens to be up from elsewhere.
 */

let ttsUp = false;

export function ttsServerUp(): boolean {
  return ttsUp;
}

/** Poll the TTS server until it answers or the timeout passes. */
export async function probeTtsServer(cfg: Config, timeoutMs: number): Promise<boolean> {
  if (cfg.ttsEngine === "say" || !cfg.ttsPort) return (ttsUp = false);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.ttsPort}/docs`, { signal: AbortSignal.timeout(1500) });
      if (res.status < 500) return (ttsUp = true);
    } catch {}
    await Bun.sleep(400);
  }
  return (ttsUp = false);
}

/**
 * Stable voice per session label — the same session always sounds like the
 * same person, different sessions sound different.
 */
export function voiceFor(cfg: Config, label: string): string {
  const voices = cfg.ttsVoices;
  if (!label || voices.length === 0) return voices[0] ?? "af_heart";
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return voices[hash % voices.length]!;
}

/** Play the attention bell without blocking. */
export function bell(cfg: Config): void {
  if (!cfg.bell) return;
  const proc = Bun.spawn(["afplay", cfg.bellSound], { stdout: "ignore", stderr: "ignore" });
  proc.unref();
}

/**
 * Speak text aloud, in the session's voice when the server is up.
 * Resolves when playback FINISHES — the daemon's mic-stays-closed-while-
 * speaking invariant depends on that.
 */
export async function speak(cfg: Config, text: string, label = ""): Promise<void> {
  if (!cfg.speak || !text) return;

  if (ttsUp && cfg.ttsEngine !== "say") {
    const result = await speakViaServer(cfg, text, label);
    if (result === "ok") return;
    // "synth-failed" = server alive but this sentence tripped it (mlx-audio
    // has a known shape bug on certain lengths) — fall back for THIS
    // utterance only. "unreachable" = server gone; degrade for the session.
    if (result === "unreachable") ttsUp = false;
  }

  const args = ["say", ...(cfg.voice ? ["-v", cfg.voice] : []), "--", text];
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  proc.unref();
  await proc.exited;
}

async function speakViaServer(cfg: Config, text: string, label: string): Promise<"ok" | "synth-failed" | "unreachable"> {
  let audio: Uint8Array;
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.ttsPort}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.ttsModel,
        input: text,
        voice: voiceFor(cfg, label),
        speed: cfg.ttsSpeed,
      }),
      // synthesis is ~real-time-factor 0.2; long read-aloud chunks need headroom
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return "synth-failed";
    audio = new Uint8Array(await res.arrayBuffer());
  } catch {
    return "unreachable";
  }
  if (audio.length < 100) return "synth-failed";

  // mlx-audio returns mp3 regardless of response_format; afplay sniffs content
  const tmp = `/tmp/conch-tts-${process.pid}-${Date.now()}.audio`;
  await Bun.write(tmp, audio);
  try {
    await Bun.spawn(["afplay", tmp], { stdout: "ignore", stderr: "ignore" }).exited;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
  return "ok";
}
