import { unlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "./config.ts";
import { splitSentences } from "./snippet.ts";

// mlx-audio's Kokoro vocoder throws a broadcast-shape ValueError at specific
// (deterministic, length-dependent) input sizes — not just long ones; an
// 11s sentence tripped it live. So we synthesize sentence-by-sentence AND,
// when a piece still fails, bisect it and retry: a different length almost
// always clears the bug. Below this length a failure is genuinely stuck.
const MIN_BISECT_CHARS = 24;

/** Split near the middle on a word boundary, so bisected retries don't cut mid-word. */
function bisect(text: string): [string, string] | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_BISECT_CHARS) return null;
  const mid = Math.floor(trimmed.length / 2);
  let split = trimmed.lastIndexOf(" ", mid);
  if (split <= 0) split = trimmed.indexOf(" ", mid);
  if (split <= 0) return null;
  return [trimmed.slice(0, split).trim(), trimmed.slice(split).trim()];
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
  const state = { playedAny: false, unreachable: false };

  for (const sentence of splitSentences(text)) {
    if (ctl?.cancelled) return "ok";
    await speakPiece(cfg, sentence, voice, ctl, state);
    if (state.unreachable) return state.playedAny ? "ok" : "unreachable";
    if (ctl?.cancelled) return "ok";
  }
  if (splitSentences(text).length === 0) await speakPiece(cfg, text, voice, ctl, state);
  return state.playedAny ? "ok" : "synth-failed";
}

/** Synthesize + play one piece; on the mlx shape bug, bisect and retry each half. */
async function speakPiece(
  cfg: Config,
  piece: string,
  voice: string,
  ctl: CancelControl | null,
  state: { playedAny: boolean; unreachable: boolean },
): Promise<void> {
  if (!piece.trim() || ctl?.cancelled || state.unreachable) return;

  let audio: Uint8Array | null = null;
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
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length >= 100) audio = bytes;
    }
  } catch {
    if (ctl?.cancelled) return;
    state.unreachable = true; // network/connection error = server gone
    return;
  }
  if (ctl?.cancelled) return;

  if (!audio) {
    // the shape bug — retry each half at a different length; if too short to
    // split, speak just this fragment via say (never drop content silently)
    const halves = bisect(piece);
    if (halves) {
      await speakPiece(cfg, halves[0], voice, ctl, state);
      await speakPiece(cfg, halves[1], voice, ctl, state);
    } else if (!ctl?.cancelled) {
      await spawnSay(cfg, piece).exited;
      state.playedAny = true;
    }
    return;
  }

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
  state.playedAny = true;
}
