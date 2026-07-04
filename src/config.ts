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
  /** keyboard/mouse idle time after which conch stays silent (auto-away), seconds; 0 disables */
  awayAfterSecs: number;
  /** sentences per "continue" chunk when reading the rest of a reply */
  continueSentences: number;
  /** audible tink/blip when the mic opens/closes */
  micCues: boolean;
  /** press Enter after injecting the transcript */
  autoSubmit: boolean;
  /** allow blind osascript keystroke injection when no tmux pane is found */
  keystrokeFallback: boolean;
  socketPath: string;
  claudeDir: string;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
    whisperPort: env.CONCH_WHISPER_PORT === "0" ? 0 : num(env.CONCH_WHISPER_PORT, 8642),
    whisperModel: env.CONCH_WHISPER_MODEL ?? join(SEASHELL_ROOT, "models/ggml-large-v3-turbo-q5_0.bin"),
    vadModel: env.CONCH_VAD_MODEL ?? join(SEASHELL_ROOT, "whisper.cpp/models/ggml-silero-v6.2.0.bin"),
    voice: env.CONCH_VOICE ?? "",
    speakSentences: num(env.CONCH_SPEAK_SENTENCES, 2),
    speakMaxChars: num(env.CONCH_SPEAK_MAX_CHARS, 350),
    bell: flag(env.CONCH_BELL, true),
    bellSound: env.CONCH_BELL_SOUND ?? "/System/Library/Sounds/Glass.aiff",
    speak: flag(env.CONCH_SPEAK, true),
    listenWindowSecs: num(env.CONCH_LISTEN_WINDOW_SECS, 30),
    maxUtteranceSecs: num(env.CONCH_MAX_UTTERANCE_SECS, 120),
    endSilenceSecs: num(env.CONCH_END_SILENCE_SECS, 2.5),
    startThresholdPct: num(env.CONCH_START_THRESHOLD_PCT, 2),
    endThresholdPct: num(env.CONCH_END_THRESHOLD_PCT, 2),
    awayAfterSecs: env.CONCH_AWAY_AFTER_SECS === "0" ? 0 : num(env.CONCH_AWAY_AFTER_SECS, 300),
    continueSentences: num(env.CONCH_CONTINUE_SENTENCES, 4),
    micCues: flag(env.CONCH_MIC_CUES, true),
    autoSubmit: flag(env.CONCH_AUTO_SUBMIT, true),
    keystrokeFallback: flag(env.CONCH_KEYSTROKE_FALLBACK, false),
    socketPath: env.CONCH_SOCKET ?? "/tmp/conch.sock",
    claudeDir: env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"),
  };
}
