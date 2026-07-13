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
// The utterance in flight. stopSpeaking() cancels THIS (the whole multi-sentence
// read on the server engine), not just the one process currently playing —
// killing `current` alone only ended a single sentence and the loop played on.
let activeCtl: CancelControl | null = null;

/**
 * True if we should synthesize via the server. Crucially, if ttsUp latched
 * false on a transient blip, this RE-PROBES and recovers — one hiccup used
 * to downgrade the whole session (both sessions dropped to system voice mid
 * use, live). A fast probe only runs when we're currently down.
 */
async function serverReady(cfg: Config): Promise<boolean> {
  if (cfg.ttsEngine === "say" || !cfg.ttsPort) return false;
  if (ttsUp) return true;
  return probeTtsServer(cfg, 1200);
}

/** Kill any in-flight speech — daemon shutdown/spacebar must not leave audio playing. */
export function stopSpeaking(): void {
  if (activeCtl) {
    // Cancel the whole utterance: stop the producer, abort the in-flight synth
    // fetch, and kill the process currently playing. Without this, a Kokoro read
    // (one afplay per sentence) just advanced to the next sentence after a kill.
    activeCtl.cancelled = true;
    activeCtl.abort.abort();
    activeCtl.kill();
    activeCtl = null;
  }
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
  // say is ~3.4x louder than the Kokoro voices (measured RMS 0.112 vs 0.033),
  // which is jarring on fallback. [[volm]] matches it. Strip any [[ ]] already
  // in the content first so wiki-links / stray brackets can't be parsed as say
  // commands (say interprets [[...]] as embedded speech commands).
  const safe = `[[volm ${cfg.sayVolume}]] ${text.replace(/\[\[|\]\]/g, "")}`;
  const proc = Bun.spawn(["say", ...sayFlags(cfg), "--", safe], { stdout: "ignore", stderr: "ignore" });
  proc.unref();
  current = proc;
  return proc;
}

/**
 * Speak text aloud, in the session's voice when the server is up.
 * Resolves when playback FINISHES — the daemon's mic-stays-closed-while-
 * speaking invariant depends on that. Now just the un-cancelled case of
 * speakCancellable, so a plain `speak()` (announcements, "Okay.", "continue"
 * chunks) is stoppable by spacebar/shutdown too.
 */
export async function speak(cfg: Config, text: string, label = ""): Promise<void> {
  await speakCancellable(cfg, text, label).done;
}

interface CancelControl {
  cancelled: boolean;
  abort: AbortController;
  kill: () => void;
}

/** Speak with a kill switch — barge-in / spacebar cancel playback mid-word, on either engine. */
export function speakCancellable(cfg: Config, text: string, label = ""): { done: Promise<void>; cancel: () => void } {
  if (!cfg.speak || !text) return { done: Promise.resolve(), cancel() {} };

  const ctl: CancelControl = { cancelled: false, abort: new AbortController(), kill() {} };
  const cancel = () => {
    ctl.cancelled = true;
    ctl.abort.abort();
    ctl.kill();
  };
  activeCtl = ctl; // stopSpeaking() cancels the active utterance through this

  const done = (async () => {
    try {
      if (cfg.ttsEngine !== "say" && cfg.ttsPort && (await serverReady(cfg))) {
        const result = await speakViaServer(cfg, text, label, ctl);
        if (result === "unreachable") ttsUp = false;
        // both non-ok results mean nothing played (a partial read returns "ok")
        if (result !== "ok" && !ctl.cancelled) {
          const proc = spawnSay(cfg, text); // say the whole thing, cancellable
          ctl.kill = () => proc.kill();
          await proc.exited;
        }
      } else if (!ctl.cancelled) {
        const proc = spawnSay(cfg, text);
        ctl.kill = () => proc.kill();
        await proc.exited;
      }
    } finally {
      if (activeCtl === ctl) activeCtl = null;
    }
  })();

  return { done, cancel };
}

// A ready-to-play tmp file (written during prefetch) or a say-fragment.
type Playable = { file: string } | { say: string };

// Synthesize this many sentences AHEAD of playback. Trimming made clips
// shorter than their synth time (esp. with perturbation retries), so a
// 1-ahead buffer underran and the read stuttered. A deeper buffer lets the
// warm server run continuously and absorb slow sentences. SEQUENTIAL though:
// the server serializes concurrent requests anyway (measured: 3 at once =
// 3.3s each vs 1s alone) and concurrency + retries made a mess.
const PREFETCH_DEPTH = 3;

interface SynthState {
  unreachable: boolean;
}

async function speakViaServer(
  cfg: Config,
  text: string,
  label: string,
  ctl: CancelControl | null,
): Promise<"ok" | "synth-failed" | "unreachable"> {
  const voice = voiceFor(cfg, label);
  const sentences = splitSentences(text);
  if (sentences.length === 0) sentences.push(text);
  const state: SynthState = { unreachable: false };

  // Producer: synthesize sentences ONE AT A TIME (no concurrency), staying at
  // most PREFETCH_DEPTH ahead of playback. Consumer plays as each is ready.
  const out: (Playable[] | undefined)[] = new Array(sentences.length);
  let playIndex = 0;
  let producerDone = false;
  const producer = (async () => {
    for (let i = 0; i < sentences.length; i++) {
      while (i - playIndex >= PREFETCH_DEPTH && !ctl?.cancelled) await Bun.sleep(15);
      if (ctl?.cancelled) break;
      out[i] = await synthSentence(cfg, sentences[i]!, voice, ctl, state);
    }
    producerDone = true;
  })();

  let playedAny = false;
  for (; playIndex < sentences.length; playIndex++) {
    while (out[playIndex] === undefined && !producerDone && !ctl?.cancelled) await Bun.sleep(15);
    if (ctl?.cancelled) break;
    const result = out[playIndex];
    if (!result) break; // producer stopped (cancelled)
    for (const p of result) {
      if (ctl?.cancelled) break;
      if ("say" in p) {
        const proc = spawnSay(cfg, p.say);
        if (ctl) ctl.kill = () => proc.kill();
        await proc.exited;
      } else {
        await playFile(p.file, ctl); // file written during synth — spawn only
      }
      playedAny = true;
    }
  }
  await producer;

  // On cancel (barge-in / spacebar), prefetched-but-unplayed clips would never
  // reach playFile's unlink — sweep them so /tmp doesn't accumulate wavs.
  if (ctl?.cancelled) {
    for (let i = playIndex; i < out.length; i++) {
      for (const p of out[i] ?? []) if ("file" in p) { try { unlinkSync(p.file); } catch {} }
    }
  }

  // A server blip flips ttsUp so the NEXT message re-probes; this read already
  // spoke failed sentences via say (per-sentence), so it never stopped early.
  if (state.unreachable) ttsUp = false;
  if (ctl?.cancelled) return "ok";
  return playedAny ? "ok" : state.unreachable ? "unreachable" : "synth-failed";
}

// mlx's SineGen bug is deterministic per exact input, so re-synthesizing the
// SAME sentence with a tiny length change (trailing spaces/period — inaudible)
// usually dodges it while keeping the sentence whole and in the Kokoro voice.
const SYNTH_PERTURBATIONS = ["", " ", "  ", ".", " .", "   "];

/** One synth request. Returns audio bytes, null (shape bug), or "unreachable". */
async function trySynth(
  cfg: Config,
  input: string,
  voice: string,
  ctl: CancelControl | null,
): Promise<Uint8Array | null | "unreachable"> {
  try {
    const signal = ctl
      ? AbortSignal.any([ctl.abort.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    const res = await fetch(`http://127.0.0.1:${cfg.ttsPort}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.ttsModel, input, voice, speed: cfg.ttsSpeed }),
      signal,
    });
    if (!res.ok) return null; // the shape bug (500)
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length >= 100 ? bytes : null;
  } catch {
    if (ctl?.cancelled) return null;
    return "unreachable";
  }
}

/**
 * Synthesize one sentence into playable pieces: perturb-retry the shape bug,
 * then bisect, then say. A server blip degrades THIS sentence to say and sets
 * state.unreachable — the read continues rather than stopping/flipping voices
 * mid-message (both were "just a mess", live).
 */
async function synthSentence(
  cfg: Config,
  piece: string,
  voice: string,
  ctl: CancelControl | null,
  state: SynthState,
): Promise<Playable[]> {
  if (!piece.trim() || ctl?.cancelled) return [];

  let audio: Uint8Array | null = null;
  for (const suffix of SYNTH_PERTURBATIONS) {
    if (ctl?.cancelled) return [];
    let r = await trySynth(cfg, piece + suffix, voice, ctl);
    if (r === "unreachable") {
      // A transient blip (common on the FIRST synth after idle — the cause of
      // "starts in system voice, then switches"). Re-probe and retry once
      // before conceding this sentence to say.
      if (!ctl?.cancelled && (await probeTtsServer(cfg, 1500))) r = await trySynth(cfg, piece + suffix, voice, ctl);
    }
    if (r === "unreachable") {
      state.unreachable = true;
      return [{ say: piece }]; // this sentence via say; keep reading the rest
    }
    if (r) {
      audio = r;
      break;
    }
  }
  if (ctl?.cancelled) return [];
  if (audio) {
    // mlx-audio pads every clip with ~0.85s of trailing silence — THE
    // between-sentence gap (measured live: 2.59s clip vs 1.70s speech). Trim
    // both ends here (during the overlapped synth), leaving a wav that plays
    // tight against the next. Falls back to the raw mp3 if the trim misfires.
    const file = `/tmp/conch-tts-${process.pid}-${tmpCounter++}.wav`;
    const trimmed = await writeTrimmed(audio, file);
    if (trimmed) return [{ file }];
    const raw = `/tmp/conch-tts-${process.pid}-${tmpCounter++}.audio`;
    await Bun.write(raw, audio);
    return [{ file: raw }];
  }

  // the shape bug survived every perturbation — bisect and retry each half at
  // a different length; if too short to split, hand back a say-fragment
  const halves = bisect(piece);
  if (!halves) return [{ say: piece }];
  const left = await synthSentence(cfg, halves[0]!, voice, ctl, state);
  const right = await synthSentence(cfg, halves[1]!, voice, ctl, state);
  return [...left, ...right];
}

let tmpCounter = 0;

/**
 * Trim leading/trailing silence from an mlx mp3 into a wav. A tiny 0.06s tail
 * is kept so sentences don't run together. Returns false if sox is missing or
 * the result is empty (all-silence clip), so the caller keeps the raw audio.
 */
async function writeTrimmed(mp3: Uint8Array, file: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      ["sox", "-t", "mp3", "-", "-t", "wav", file,
       "silence", "1", "0.02", "0.3%", "reverse",
       "silence", "1", "0.06", "0.3%", "reverse"],
      { stdin: "pipe", stdout: "ignore", stderr: "ignore" },
    );
    proc.stdin.write(mp3);
    await proc.stdin.end();
    const code = await proc.exited;
    if (code !== 0) return false;
    return Bun.file(file).size > 1000; // header-only = trimmed to nothing
  } catch {
    return false;
  }
}

async function playFile(file: string, ctl: CancelControl | null): Promise<void> {
  const proc = Bun.spawn(["afplay", file], { stdout: "ignore", stderr: "ignore" });
  current = proc;
  if (ctl) ctl.kill = () => proc.kill();
  try {
    await proc.exited;
  } finally {
    try {
      unlinkSync(file);
    } catch {}
  }
}
