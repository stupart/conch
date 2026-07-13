import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();

// Whisper engine defaults point at a seashell checkout — conch reuses its
// whisper.cpp build and models rather than shipping its own.
const SEASHELL_ROOT = process.env.CONCH_SEASHELL_ROOT ?? join(HOME, "whisper-cli");

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
  /** sox amplitude thresholds (percent) for speech start/end detection */
  startThresholdPct: number;
  endThresholdPct: number;
  /**
   * OPT-IN: keyboard/mouse idle time after which conch stays silent, seconds.
   * Off by default — HID idle doesn't count VOICE activity, so any default
   * would silence a hands-free session mid-conversation. Use `conch mute`.
   */
  awayAfterSecs: number;
  /** read the whole final message aloud by default; say "stop" between chunks to cut it short */
  readFull: boolean;
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
  socketPath: string;
  claudeDir: string;
  /** TTS engine: auto (server if available, say otherwise) | server | say */
  ttsEngine: "auto" | "server" | "say";
  /** warm Kokoro server port (mlx-audio); 0 disables the server engine */
  ttsPort: number;
  ttsModel: string;
  /** binary the daemon spawns for the warm TTS server */
  ttsServerBin: string;
  /** voice ring — sessions are hashed onto it so each speaks consistently */
  ttsVoices: string[];
  ttsSpeed: number;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// For knobs whose off-switch is literally "0" (a disabled port, no gap, no
// barge-in). num() alone maps "0" to the fallback, so 0 could never disable
// them — CONCH_BARGE_THRESHOLD_PCT=0 silently kept barge-in on before this.
function zeroable(v: string | undefined, fallback: number): number {
  return v === "0" ? 0 : num(v, fallback);
}

function flag(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v !== "0" && v.toLowerCase() !== "false";
}

export function loadConfig(): Config {
  const env = process.env;
  return {
    whisperCli: env.CONCH_WHISPER_CLI ?? join(SEASHELL_ROOT, "whisper.cpp/build/bin/whisper-cli"),
    whisperServerBin: env.CONCH_WHISPER_SERVER ?? join(SEASHELL_ROOT, "whisper.cpp/build/bin/whisper-server"),
    whisperPort: zeroable(env.CONCH_WHISPER_PORT, 8642),
    whisperModel: env.CONCH_WHISPER_MODEL ?? join(SEASHELL_ROOT, "models/ggml-large-v3-turbo-q5_0.bin"),
    vadModel: env.CONCH_VAD_MODEL ?? join(SEASHELL_ROOT, "whisper.cpp/models/ggml-silero-v6.2.0.bin"),
    voice: env.CONCH_VOICE ?? "",
    sayRate: num(env.CONCH_SAY_RATE, 210),
    sayVolume: num(env.CONCH_SAY_VOLUME, 0.4), // measured: [[volm 0.4]] ≈ Kokoro loudness (say raw is ~3.4x louder)
    speakSentences: num(env.CONCH_SPEAK_SENTENCES, 2),
    speakMaxChars: num(env.CONCH_SPEAK_MAX_CHARS, 350),
    bell: flag(env.CONCH_BELL, true),
    bellSound: env.CONCH_BELL_SOUND ?? "/System/Library/Sounds/Glass.aiff",
    speak: flag(env.CONCH_SPEAK, true),
    listenWindowSecs: num(env.CONCH_LISTEN_WINDOW_SECS, 30),
    maxUtteranceSecs: num(env.CONCH_MAX_UTTERANCE_SECS, 120),
    endSilenceSecs: num(env.CONCH_END_SILENCE_SECS, 3.5), // 2.5 clipped natural mid-thought pauses (live)
    startThresholdPct: num(env.CONCH_START_THRESHOLD_PCT, 2),
    endThresholdPct: num(env.CONCH_END_THRESHOLD_PCT, 2),
    awayAfterSecs: num(env.CONCH_AWAY_AFTER_SECS, 0),
    readFull: flag(env.CONCH_READ_FULL, true),
    // 0 = no gap at all: barge-in + spacebar cover interrupts, chunks flow
    // back-to-back (when barging is off, a 0.6s floor re-appears in the loop)
    gapSecs: zeroable(env.CONCH_GAP_SECS, 0),
    bargeThresholdPct: zeroable(env.CONCH_BARGE_THRESHOLD_PCT, 8), // measured: speaker bleed peaks ~4.7%, ambient ~1%; 0 disables

    continueSentences: num(env.CONCH_CONTINUE_SENTENCES, 6), // bigger chunks = fewer inter-chunk pauses
    micCues: flag(env.CONCH_MIC_CUES, true),
    autoSubmit: flag(env.CONCH_AUTO_SUBMIT, true),
    holdSubmit: flag(env.CONCH_HOLD_SUBMIT, true),
    holdSubmitSecs: num(env.CONCH_HOLD_SUBMIT_SECS, 8),
    recentInjectSuppressMs: num(env.CONCH_INJECT_SUPPRESS_MS, 30_000),
    keystrokeFallback: flag(env.CONCH_KEYSTROKE_FALLBACK, false),
    socketPath: env.CONCH_SOCKET ?? "/tmp/conch.sock",
    claudeDir: env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"),
    ttsEngine: parseTtsEngine(env.CONCH_TTS),
    ttsPort: zeroable(env.CONCH_TTS_PORT, 8880),
    ttsModel: env.CONCH_TTS_MODEL ?? "mlx-community/Kokoro-82M-bf16",
    ttsServerBin: env.CONCH_TTS_SERVER ?? "mlx_audio.server",
    ttsVoices: (env.CONCH_TTS_VOICES ?? "af_heart,am_michael,bf_emma,am_adam,af_nova,bm_george,af_bella,af_sky")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    ttsSpeed: num(env.CONCH_TTS_SPEED, 1.35), // brisker Kokoro; CONCH_TTS_SPEED to taste
  };
}

function parseTtsEngine(v: string | undefined): "auto" | "server" | "say" {
  return v === "server" || v === "say" ? v : "auto";
}
