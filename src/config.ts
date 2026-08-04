import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { DEFAULT_CONCH_CONFIG_DIR, loadSettingResolutions, settingsPathFor, type HandoffOrder } from "./settings.ts";

const HOME = homedir();

// The whisper engine can come from three places, probed in this order so that
// each existing setup keeps working AND a fresh `brew install whisper-cpp`
// + `conch setup` works with zero env vars:
//   1. a seashell checkout (the original: ~/whisper-cli)
//   2. a Homebrew whisper-cpp install (/opt/homebrew or /usr/local)
//   3. models downloaded by `conch setup` into ~/.cache/conch
export const CONCH_DATA = join(HOME, ".cache", "conch"); // `conch setup` writes models here
export const CONCH_CONFIG_DIR = process.env.CONCH_CONFIG_DIR ?? DEFAULT_CONCH_CONFIG_DIR;
const BREW = existsSync("/opt/homebrew/bin") ? "/opt/homebrew/bin" : "/usr/local/bin";
const WHISPER_MODEL_FILE = "ggml-large-v3-turbo-q5_0.bin";
const VAD_MODEL_FILE = "ggml-silero-v6.2.0.bin";

/** First path that exists, else the last candidate (so doctor reports a sensible expected path). */
function firstExisting(...candidates: string[]): string {
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1]!;
}

export interface Config {
  whisperCli: string;
  whisperServerBin: string;
  /** port for the warm whisper-server the daemon manages; 0 disables it */
  whisperPort: number;
  whisperModel: string;
  vadModel: string;
  /** TTS voice for `say`; empty string = system default */
  voice: string;
  /** speech rate for `say`, words per minute; 0 = system default (~175) */
  sayRate: number;
  /** `say` playback volume (0-1) via [[volm]]; matches the quieter Kokoro voices (say is ~3x louder raw) */
  sayVolume: number;
  speakSentences: number;
  speakMaxChars: number;
  bell: boolean;
  bellSound: string;
  speak: boolean;
  /** how long the mic waits for you to START talking, seconds */
  listenWindowSecs: number;
  /** hard cap on a single utterance once you're talking, seconds */
  maxUtteranceSecs: number;
  /** seconds of trailing silence that end an utterance */
  endSilenceSecs: number;
  /** software gain applied to mic capture by sox, in dB; 0 disables */
  micGainDb: number;
  /** sox amplitude thresholds (percent) for speech start/end detection */
  startThresholdPct: number;
  endThresholdPct: number;
  /**
   * OPT-IN: keyboard/mouse idle time after which conch stays silent, seconds.
   * Off by default — HID idle doesn't count VOICE activity, so any default
   * would silence a hands-free session mid-conversation. Use `conch mute`.
   */
  awayAfterSecs: number;
  /**
   * Typing gate: if you touched the keyboard/mouse within this many seconds, a
   * finished turn stays visual (panel + bell) — no voice, no mic. Keeps your
   * typing from triggering phantom words or cutting a recitation; `0` disables.
   * A wake (space / `conch wake`) is always explicit and ignores this.
   */
  typingGraceSecs: number;
  /** read the whole final message aloud by default; say "stop" between chunks to cut it short */
  readFull: boolean;
  /** stop a response read/listen exchange when that session receives a human text reply */
  interruptOnManualReply: boolean;
  /** ordering policy for queued session handoffs */
  handoffOrder: HandoffOrder;
  /** interjection gap between read-aloud chunks, seconds — a breath, not an ending; the tink means it's your turn */
  gapSecs: number;
  /**
   * barge-in: mic level (sox %) that interrupts read-aloud mid-chunk.
   * Must sit above speaker-bleed (the mic hearing the Mac's own voice) and
   * below voice-at-desk. 0 disables barge-in (gaps only).
   */
  bargeThresholdPct: number;
  /** sentences per read-aloud / "continue" chunk */
  continueSentences: number;
  /** audible tink/blip when the mic opens/closes */
  micCues: boolean;
  /** press Enter after injecting the transcript */
  autoSubmit: boolean;
  /**
   * Hold submit: inject each dictated segment WITHOUT pressing Enter and keep
   * the mic open, so a natural pause segments your dictation instead of
   * sending it. Submit on "send"/"go" or after holdSubmitSecs of silence.
   */
  holdSubmit: boolean;
  /** silence (seconds) after which held dictation auto-submits */
  holdSubmitSecs: number;
  /** suppress a "needs you" for a session conch drove within this window (ms) */
  recentInjectSuppressMs: number;
  /** allow blind osascript keystroke injection when no tmux pane is found */
  keystrokeFallback: boolean;
  /** Reveal a session's window (raise-without-focus-steal) when conch starts talking to it. */
  revealOnTurn: boolean;
  /** suppress a window raise if keys/mouse were touched within this many seconds (0 = always raise) */
  revealTypingGraceSecs: number;
  /** Bell, announce, and listen when a stopped turn still has live background work. */
  workingMic: boolean;
  /** answer conch-prefixed questions from the current session without injecting them */
  voiceQa: boolean;
  /** on resume, speak one composed briefing instead of replaying each held turn */
  resumeDigest: boolean;
  /** summarize long replies in one spoken sentence for hook announcements */
  announceSummary: boolean;
  /** seconds the fast model (Haiku) may run before a voice feature falls back */
  haikuTimeoutSecs: number;
  /** Silently pause while another app is using the default microphone. */
  meetingAutopause: boolean;
  socketPath: string;
  claudeDir: string;
  /** TTS engine: owned stdin/stdout worker (default) | legacy HTTP server | say */
  ttsEngine: "worker" | "server" | "say";
  /** warm Kokoro server port (legacy server mode only); 0 disables that mode */
  ttsPort: number;
  ttsModel: string;
  /** binary used by server mode and to locate mlx-audio's isolated Python */
  ttsServerBin: string;
  /** optional Python override for worker mode; empty derives it from ttsServerBin's shebang */
  ttsWorkerPython: string;
  /** voice ring — sessions are hashed onto it so each speaks consistently */
  ttsVoices: string[];
  ttsSpeed: number;
  /** coalesce later short sentences up to this many chars; 0 disables */
  ttsBatchChars: number;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// For non-registry knobs whose off-switch is literally "0" (a disabled port
// or no gap). Curated zeroable values are parsed by the settings registry.
function zeroable(v: string | undefined, fallback: number): number {
  return v === "0" ? 0 : num(v, fallback);
}

function flag(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v !== "0" && v.toLowerCase() !== "false";
}

export interface LoadConfigOptions {
  env?: Readonly<Record<string, string | undefined>>;
  settingsPath?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const seashellRoot = env.CONCH_SEASHELL_ROOT ?? join(HOME, "whisper-cli");
  const settings = loadSettingResolutions({
    env,
    settingsPath: options.settingsPath ?? settingsPathFor(env),
  });
  return {
    whisperCli: env.CONCH_WHISPER_CLI ?? firstExisting(join(seashellRoot, "whisper.cpp/build/bin/whisper-cli"), join(BREW, "whisper-cli")),
    whisperServerBin: env.CONCH_WHISPER_SERVER ?? firstExisting(join(seashellRoot, "whisper.cpp/build/bin/whisper-server"), join(BREW, "whisper-server")),
    whisperPort: zeroable(env.CONCH_WHISPER_PORT, 8642),
    whisperModel: env.CONCH_WHISPER_MODEL ?? firstExisting(join(seashellRoot, "models", WHISPER_MODEL_FILE), join(CONCH_DATA, "models", WHISPER_MODEL_FILE)),
    vadModel: env.CONCH_VAD_MODEL ?? firstExisting(join(seashellRoot, "whisper.cpp/models", VAD_MODEL_FILE), join(CONCH_DATA, "models", VAD_MODEL_FILE)),
    voice: env.CONCH_VOICE ?? "",
    sayRate: settings["say-rate"].value as number,
    sayVolume: num(env.CONCH_SAY_VOLUME, 0.4), // measured: [[volm 0.4]] ≈ Kokoro loudness (say raw is ~3.4x louder)
    speakSentences: settings["announce-sentences"].value as number,
    speakMaxChars: settings["announce-max-chars"].value as number,
    bell: flag(env.CONCH_BELL, true),
    bellSound: env.CONCH_BELL_SOUND ?? "/System/Library/Sounds/Glass.aiff",
    speak: flag(env.CONCH_SPEAK, true),
    listenWindowSecs: settings["listen-window"].value as number,
    maxUtteranceSecs: num(env.CONCH_MAX_UTTERANCE_SECS, 120),
    endSilenceSecs: settings["end-silence"].value as number, // 2.5 clipped natural mid-thought pauses (live)
    micGainDb: settings["mic-gain"].value as number,
    startThresholdPct: num(env.CONCH_START_THRESHOLD_PCT, 2),
    endThresholdPct: num(env.CONCH_END_THRESHOLD_PCT, 2),
    awayAfterSecs: num(env.CONCH_AWAY_AFTER_SECS, 0),
    typingGraceSecs: settings["typing-grace"].value as number, // touched keys/mouse within 2s ⇒ working; 0 disables the gate
    readFull: settings["read-full"].value as boolean,
    interruptOnManualReply: settings["interrupt-on-manual-reply"].value as boolean,
    handoffOrder: settings["handoff-order"].value as HandoffOrder,
    // 0 = no gap at all: barge-in + spacebar cover interrupts, chunks flow
    // back-to-back (when barging is off, a 0.6s floor re-appears in the loop)
    gapSecs: zeroable(env.CONCH_GAP_SECS, 0),
    bargeThresholdPct: settings["barge-threshold"].value as number, // 0 disables; tune above speaker bleed to opt in

    continueSentences: num(env.CONCH_CONTINUE_SENTENCES, 6), // bigger chunks = fewer inter-chunk pauses
    micCues: flag(env.CONCH_MIC_CUES, true),
    autoSubmit: flag(env.CONCH_AUTO_SUBMIT, true),
    holdSubmit: flag(env.CONCH_HOLD_SUBMIT, true),
    holdSubmitSecs: settings["hold-submit-delay"].value as number,
    recentInjectSuppressMs: num(env.CONCH_INJECT_SUPPRESS_MS, 30_000),
    keystrokeFallback: settings["keystroke-fallback"].value as boolean,
    revealOnTurn: settings["reveal-on-turn"].value as boolean,
    revealTypingGraceSecs: settings["reveal-typing-grace"].value as number,
    workingMic: settings["working-mic"].value as boolean,
    voiceQa: settings["voice-qa"].value as boolean,
    resumeDigest: settings["resume-digest"].value as boolean,
    announceSummary: settings["announce-summary"].value as boolean,
    haikuTimeoutSecs: settings["haiku-timeout"].value as number,
    meetingAutopause: settings["meeting-autopause"].value as boolean,
    socketPath: env.CONCH_SOCKET ?? "/tmp/conch.sock",
    claudeDir: env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"),
    ttsEngine: parseTtsEngine(env.CONCH_TTS),
    ttsPort: zeroable(env.CONCH_TTS_PORT, 8880),
    ttsModel: env.CONCH_TTS_MODEL ?? "mlx-community/Kokoro-82M-bf16",
    ttsServerBin: env.CONCH_TTS_SERVER ?? "mlx_audio.server",
    ttsWorkerPython: env.CONCH_TTS_WORKER_PYTHON ?? "",
    ttsVoices: (env.CONCH_TTS_VOICES ?? "af_heart,am_michael,bf_emma,am_adam,af_nova,bm_george,af_bella,af_sky")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    ttsSpeed: settings["voice-speed"].value as number, // brisker voice synthesis; CONCH_TTS_SPEED to taste
    ttsBatchChars: zeroable(env.CONCH_TTS_BATCH_CHARS, 240),
  };
}

function parseTtsEngine(v: string | undefined): "worker" | "server" | "say" {
  // `auto` was the old default. Preserve it as a compatibility alias for the
  // new self-owned path rather than reviving HTTP adoption semantics.
  return v === "server" || v === "say" ? v : "worker";
}
