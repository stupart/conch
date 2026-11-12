import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { conchHome } from "./home.ts";
import { whisperThreads } from "./whisper-args.ts";

/**
 * While seashell records a meeting, conch's transcription stays small and
 * runs behind it.
 *
 * 2026-11-11, Tyler: "if it and seashell are running at the same time can it
 * just use seashell recording / audio to share and not overload the machine …
 * so i don't end up running two of the same recording processes at the same
 * time clogging up my machine." What competes is the work, not the memory:
 * seashell's live drafts run whisper on every 10s of the meeting, both of its
 * tracks, on a private whisper-server, while the call itself has the camera,
 * the screen and the GPU. Sharing that server would only queue conch's work
 * behind (and in front of) seashell's: it binds a loopback port it picks at
 * start and publishes nowhere, serves one request at a time (whisper.cpp's
 * server holds one mutex across every inference), and stops after a minute
 * without drafts (seashell src/local-asr-scheduler.ts OwnedWhisperServer,
 * src/background-live-transcript.ts). Its live stream is not shareable
 * either: its recorder's PCM goes down a pipe into its own process and comes
 * out as durable 10s chunks, seconds behind, where conch's turn-taking works
 * in 20ms frames. Two
 * native recorders on one microphone is cheap: each is one CoreAudio client
 * at the device's own rate, and neither sets anything on the device.
 *
 * So conch yields instead, while seashell's background watcher says it is
 * recording (`.background-watch.json` in seashell's library, phase
 * "recording", from a live process, refreshed within 30s, as seashell's own
 * reader requires: seashell src/background-watch-status.ts):
 *
 * - No live previews. A preview re-decodes the newest piece of the capture
 *   every 0.7s for as long as someone speaks; it is the only repeated whisper
 *   work conch does. The final transcription still runs, once per capture.
 * - A cold whisper-cli run (only when conch's warm server is not up yet) gets
 *   half the threads and a lower CPU priority (`nice`), so it waits for the
 *   meeting rather than the meeting for it.
 * - conch's warm server is kept, not stopped: one final on it measured 128ms
 *   median for 0–3s of audio and 142ms for 3–8s (conch's own stt.transcribe
 *   telemetry, 54 runs), where a cold run reloads the 574MB model for every
 *   capture: more work for the GPU and the disk, not less.
 *
 * The seam for later: a shared socket seashell could publish, with a priority
 * lane for short replies. It would be one more `route` here, chosen ahead of
 * the warm server while seashell records, and transcribe.ts would send finals
 * to it.
 */

export type TranscriptionRoute = "own";

export interface TranscriptionPolicy {
  /** Where finals go. Only conch's own engine today; see the seam above. */
  route: TranscriptionRoute;
  /** Live previews while someone speaks. */
  partials: boolean;
  /** Threads for a cold whisper-cli run. */
  coldThreads: number;
  /** `nice` increment for a cold whisper-cli run; 0 runs it as before. */
  coldNice: number;
  /** Seashell is recording a meeting. */
  yielding: boolean;
}

/** Seashell's library: SEASHELL_LIBRARY_DIR, its config's libraryDir, or ~/Documents/Sea Shell/Transcripts (seashell src/config.ts). */
export function seashellLibraryDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = conchHome(),
): string {
  const expand = (path: string): string => {
    const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
    return isAbsolute(expanded) ? expanded : resolve(expanded);
  };
  const explicit = env.SEASHELL_LIBRARY_DIR?.trim();
  if (explicit) return expand(explicit);
  try {
    const configPath = env.SEASHELL_CONFIG?.trim() || join(home, "Library", "Application Support", "Sea Shell", "config.json");
    const configured = (JSON.parse(readFileSync(configPath, "utf8")) as { libraryDir?: unknown }).libraryDir;
    if (typeof configured === "string" && configured.trim()) return expand(configured.trim());
  } catch {}
  return join(home, "Documents", "Sea Shell", "Transcripts");
}

/** How stale seashell's own reader lets a status be before it calls it "unavailable". */
const STATUS_FRESH_MS = 30_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether this `.background-watch.json` says seashell is recording now. Read-only; anything unexpected is "no". */
export function seashellStatusRecording(
  text: string,
  now = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  try {
    const status = JSON.parse(text) as { schemaVersion?: unknown; phase?: unknown; pid?: unknown; updatedAtUnixMs?: unknown };
    if (status.schemaVersion !== 1 || status.phase !== "recording") return false;
    if (!Number.isSafeInteger(status.pid) || (status.pid as number) < 1) return false;
    if (!Number.isSafeInteger(status.updatedAtUnixMs)) return false;
    const updated = status.updatedAtUnixMs as number;
    if (now < updated || now - updated > STATUS_FRESH_MS) return false;
    return alive(status.pid as number);
  } catch {
    return false;
  }
}

export interface SeashellActivityOptions {
  statusPath?: () => string;
  read?: (path: string) => string | null;
  now?: () => number;
  alive?: (pid: number) => boolean;
  log?: (line: string) => void;
  /** How long one look at the status file is trusted: captures ask every 100ms. */
  cacheMs?: number;
}

const readStatusFile = (path: string): string | null => {
  try {
    if (statSync(path).size > 8_192) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

export class SeashellActivity {
  #statusPath: () => string;
  #read: (path: string) => string | null;
  #now: () => number;
  #alive: (pid: number) => boolean;
  #log: (line: string) => void;
  #cacheMs: number;
  #lookedAt = Number.NEGATIVE_INFINITY;
  #recording = false;

  constructor(options: SeashellActivityOptions = {}) {
    let path: string | undefined;
    this.#statusPath = options.statusPath ?? (() => (path ??= join(seashellLibraryDir(), ".background-watch.json")));
    this.#read = options.read ?? readStatusFile;
    this.#now = options.now ?? Date.now;
    this.#alive = options.alive ?? pidAlive;
    this.#log = options.log ?? (() => {});
    this.#cacheMs = options.cacheMs ?? 2_000;
  }

  setLog(log: (line: string) => void): void {
    this.#log = log;
  }

  recording(): boolean {
    const now = this.#now();
    if (now - this.#lookedAt < this.#cacheMs) return this.#recording;
    this.#lookedAt = now;
    const text = this.#read(this.#statusPath());
    const recording = text !== null && seashellStatusRecording(text, now, this.#alive);
    if (recording !== this.#recording) {
      this.#log(recording
        ? "seashell is recording a meeting — conch's live previews pause and a cold transcription runs at low priority until it stops"
        : "seashell stopped recording — conch's live previews are back");
    }
    this.#recording = recording;
    return recording;
  }

  policy(): TranscriptionPolicy {
    const yielding = this.recording();
    const threads = whisperThreads();
    return {
      route: "own",
      partials: !yielding,
      coldThreads: yielding ? Math.max(2, Math.floor(threads / 2)) : threads,
      coldNice: yielding ? 10 : 0,
      yielding,
    };
  }
}

export const seashellActivity = new SeashellActivity();
