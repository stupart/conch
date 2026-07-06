import { unlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "./config.ts";
import { splitSentences } from "./snippet.ts";

// mlx-audio's Kokoro vocoder throws a broadcast-shape ValueError on long
// inputs (~20s+ of audio). Synthesizing one sentence at a time keeps every
// request well under that ceiling; a stray over-long sentence is split too.
const MAX_SYNTH_CHARS = 300;

function synthPieces(text: string): string[] {
  const pieces: string[] = [];
  for (const sentence of splitSentences(text)) {
    if (sentence.length <= MAX_SYNTH_CHARS) {
      pieces.push(sentence);
      continue;
    }
    for (let i = 0; i < sentence.length; i += MAX_SYNTH_CHARS) {
      pieces.push(sentence.slice(i, i + MAX_SYNTH_CHARS));
    }
  }
  return pieces.length ? pieces : [text];
}

/**
 * Two TTS engines:
 *  - "server": a warm local Kokoro server (mlx-audio, OpenAI-compatible
 *    /v1/audio/speech) — dramatically more natural than `say`, ~0.3-1s to
 *    synthesize a short utterance on Apple Silicon, 50+ voices — which buys
 *    the fun part: every session speaks in its own voice.
 *  - "say": macOS built-in — zero setup, always available, the fallback.
 *
 * The daemon spawns and owns the server (same pattern as whisper-server).
 * Standalone hook runs (daemon down) use `say` unless a server is already up.
 */

let ttsUp = false;
let current: ReturnType<typeof Bun.spawn> | null = null;

export function ttsServerUp(): boolean {
  return ttsUp;
}

/** Kill any in-flight speech — daemon shutdown/spacebar must not leave audio playing. */
export function stopSpeaking(): void {
  current?.kill();
  current = null;
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

// --- per-session voices -----------------------------------------------

const VOICES_FILE = join(homedir(), ".config/conch/voices.json");

function voiceOverrides(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(VOICES_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Pin a session's voice (persisted; survives restarts). */
export function setVoiceOverride(label: string, voice: string): void {
  const map = voiceOverrides();
  map[label.toLowerCase().trim()] = voice;
  mkdirSync(join(homedir(), ".config/conch"), { recursive: true });
  writeFileSync(VOICES_FILE, JSON.stringify(map, null, 2) + "\n");
}

/**
 * Stable voice per session label: explicit override first, else the label
 * hashes onto the voice ring — same session, same voice, every time.
 */
export function voiceFor(cfg: Config, label: string): string {
  const override = voiceOverrides()[label.toLowerCase().trim()];
  if (override) return override;
  const voices = cfg.ttsVoices;
  if (!label || voices.length === 0) return voices[0] ?? "af_heart";
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return voices[hash % voices.length]!;
}

// --- speaking -----------------------------------------------------------

/** Play the attention bell without blocking. */
export function bell(cfg: Config): void {
  if (!cfg.bell) return;
  const proc = Bun.spawn(["afplay", cfg.bellSound], { stdout: "ignore", stderr: "ignore" });
  proc.unref();
}

function sayFlags(cfg: Config): string[] {
  return [...(cfg.voice ? ["-v", cfg.voice] : []), ...(cfg.sayRate > 0 ? ["-r", String(cfg.sayRate)] : [])];
}

function spawnSay(cfg: Config, text: string): ReturnType<typeof Bun.spawn> {
  const proc = Bun.spawn(["say", ...sayFlags(cfg), "--", text], { stdout: "ignore", stderr: "ignore" });
  proc.unref();
  current = proc;
  return proc;
}

/**
 * Speak text aloud, in the session's voice when the server is up.
 * Resolves when playback FINISHES — the daemon's mic-stays-closed-while-
 * speaking invariant depends on that.
 */
export async function speak(cfg: Config, text: string, label = ""): Promise<void> {
  if (!cfg.speak || !text) return;
  if (ttsUp && cfg.ttsEngine !== "say") {
    const result = await speakViaServer(cfg, text, label, null);
    if (result === "ok") return;
    // "synth-failed" = server alive but this sentence tripped it (mlx-audio
    // has a known shape bug on certain lengths) — fall back for THIS
    // utterance only. "unreachable" = server gone; degrade for the session.
    if (result === "unreachable") ttsUp = false;
  }
  await spawnSay(cfg, text).exited;
}

interface CancelControl {
  cancelled: boolean;
  abort: AbortController;
  kill: () => void;
}

/** Speak with a kill switch — barge-in / spacebar cancel playback mid-word, on either engine. */
export function speakCancellable(cfg: Config, text: string, label = ""): { done: Promise<void>; cancel: () => void } {
  if (!cfg.speak || !text) return { done: Promise.resolve(), cancel() {} };

  if (ttsUp && cfg.ttsEngine !== "say") {
    const ctl: CancelControl = { cancelled: false, abort: new AbortController(), kill() {} };
    const done = (async () => {
      const result = await speakViaServer(cfg, text, label, ctl);
      if (result === "unreachable") ttsUp = false;
      if (result !== "ok" && !ctl.cancelled) {
        const proc = spawnSay(cfg, text); // per-utterance fallback stays cancellable
        ctl.kill = () => proc.kill();
        await proc.exited;
      }
    })();
    return {
      done,
      cancel: () => {
        ctl.cancelled = true;
        ctl.abort.abort();
        ctl.kill();
      },
    };
  }

  const proc = spawnSay(cfg, text);
  return { done: proc.exited.then(() => {}), cancel: () => proc.kill() };
}

async function speakViaServer(
  cfg: Config,
  text: string,
  label: string,
  ctl: CancelControl | null,
): Promise<"ok" | "synth-failed" | "unreachable"> {
  const voice = voiceFor(cfg, label);
  const pieces = synthPieces(text);
  let playedAny = false;

  for (const piece of pieces) {
    if (ctl?.cancelled) return "ok";
    let audio: Uint8Array;
    try {
      const signal = ctl
        ? AbortSignal.any([ctl.abort.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000);
      const res = await fetch(`http://127.0.0.1:${cfg.ttsPort}/v1/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: cfg.ttsModel, input: piece, voice, speed: cfg.ttsSpeed }),
        signal,
      });
      if (!res.ok) return playedAny ? "ok" : "synth-failed"; // salvage a partial read; say-repeat would double-speak
      audio = new Uint8Array(await res.arrayBuffer());
    } catch {
      if (ctl?.cancelled) return "ok"; // cancelled mid-synth = nothing left to do
      return playedAny ? "ok" : "unreachable";
    }
    if (ctl?.cancelled) return "ok";
    if (audio.length < 100) return playedAny ? "ok" : "synth-failed";

    // mlx-audio returns mp3 regardless of response_format; afplay sniffs content
    const tmp = `/tmp/conch-tts-${process.pid}-${Date.now()}.audio`;
    await Bun.write(tmp, audio);
    const proc = Bun.spawn(["afplay", tmp], { stdout: "ignore", stderr: "ignore" });
    current = proc;
    if (ctl) ctl.kill = () => proc.kill();
    try {
      await proc.exited;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
    playedAny = true;
  }
  return "ok";
}
