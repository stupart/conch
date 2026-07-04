import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();

// Whisper engine defaults point at a seashell checkout — conch reuses its
// whisper.cpp build and models rather than shipping its own.
const SEASHELL_ROOT = process.env.CONCH_SEASHELL_ROOT ?? join(HOME, "whisper-cli");

export interface Config {
  whisperCli: string;
  whisperModel: string;
  vadModel: string;
  /** TTS voice for `say`; empty string = system default */
  voice: string;
  speakSentences: number;
  speakMaxChars: number;
  bell: boolean;
  bellSound: string;
  speak: boolean;
  /** hard cap on how long a listening window stays open, seconds */
  listenWindowSecs: number;
  /** seconds of trailing silence that end an utterance */
  endSilenceSecs: number;
  /** sox amplitude thresholds (percent) for speech start/end detection */
  startThresholdPct: number;
  endThresholdPct: number;
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
    whisperModel: env.CONCH_WHISPER_MODEL ?? join(SEASHELL_ROOT, "models/ggml-large-v3-turbo-q5_0.bin"),
    vadModel: env.CONCH_VAD_MODEL ?? join(SEASHELL_ROOT, "whisper.cpp/models/ggml-silero-v6.2.0.bin"),
    voice: env.CONCH_VOICE ?? "",
    speakSentences: num(env.CONCH_SPEAK_SENTENCES, 2),
    speakMaxChars: num(env.CONCH_SPEAK_MAX_CHARS, 350),
    bell: flag(env.CONCH_BELL, true),
    bellSound: env.CONCH_BELL_SOUND ?? "/System/Library/Sounds/Glass.aiff",
    speak: flag(env.CONCH_SPEAK, true),
    listenWindowSecs: num(env.CONCH_LISTEN_WINDOW_SECS, 30),
    endSilenceSecs: num(env.CONCH_END_SILENCE_SECS, 2.5),
    startThresholdPct: num(env.CONCH_START_THRESHOLD_PCT, 2),
    endThresholdPct: num(env.CONCH_END_THRESHOLD_PCT, 2),
    autoSubmit: flag(env.CONCH_AUTO_SUBMIT, true),
    keystrokeFallback: flag(env.CONCH_KEYSTROKE_FALLBACK, false),
    socketPath: env.CONCH_SOCKET ?? "/tmp/conch.sock",
    claudeDir: env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"),
  };
}
