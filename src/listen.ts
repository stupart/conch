import { statSync, unlinkSync, readFileSync } from "node:fs";
import type { Config } from "./config.ts";
import { transcribePcm, serverUp } from "./transcribe.ts";

// Anything smaller than this is silence (raw 16kHz 16-bit mono = 32KB/s).
const MIN_PCM_BYTES = 16_000; // ~0.5s

export interface ListenHooks {
  /** armed = mic open & waiting; capturing = speech detected; transcribing = whisper running */
  onState?: (state: "armed" | "capturing" | "transcribing") => void;
  /** near-real-time partial transcript while you're still talking (warm server only) */
  onPartial?: (text: string) => void;
}

interface Recorder {
  raw: string;
  proc: ReturnType<typeof Bun.spawn>;
  watchdog: ReturnType<typeof setInterval>;
}

/**
 * Capture one utterance and transcribe it.
 *
 * sox's `silence` effect does the endpointing, but its trigger is jumpy —
 * the mic-cue tail or a keyboard clack "starts" a recording that closes on
 * the quiet that follows. Defenses, all born from live testing:
 *
 * 1. Re-arm on false starts: a near-empty capture or empty transcript
 *    re-opens the mic until the start window is genuinely spent.
 * 2. No dead zones: transcription runs with the NEXT recorder already
 *    armed, so words spoken during a noise-blip transcription land in the
 *    next capture instead of vanishing.
 * 3. Capture is headerless raw PCM, so the growing file can be read
 *    mid-recording for live partials (a wav header's size fields would be
 *    stale until sox closes the file).
 */
export async function listenOnce(cfg: Config, hooks: ListenHooks = {}): Promise<{ text: string; error?: string }> {
  const opened = Date.now();
  const windowSpent = () => (Date.now() - opened) / 1000 >= cfg.listenWindowSecs;

  let rec = armRecorder(cfg, opened, hooks);

  while (true) {
    await rec.proc.exited;
    clearInterval(rec.watchdog);

    const pcm = readPcm(rec.raw);
    discard(rec.raw);

    if (pcm.length < MIN_PCM_BYTES) {
      if (windowSpent()) return { text: "" }; // window over (or the timeout kill)
      rec = armRecorder(cfg, opened, hooks); // false start — re-arm
      continue;
    }

    const next = windowSpent() ? null : armRecorder(cfg, opened, hooks);
    hooks.onState?.("transcribing");
    const result = await transcribePcm(cfg, pcm);

    if (result.error || result.text) {
      if (next) await disarm(next);
      return result;
    }
    if (!next) return { text: "" }; // noise transcribed to nothing, window over
    rec = next; // keep whatever the hot mic caught in the meantime
  }
}

/**
 * Brief interjection window between read-aloud chunks: wait up to
 * `maxWaitSecs` for speech to START; if nothing, return immediately-ish so
 * reading continues. If the user does start talking, capture the full
 * utterance (endpointed as usual) and transcribe it.
 */
export async function listenGap(cfg: Config, maxWaitSecs: number): Promise<{ text: string }> {
  const raw = `/tmp/conch-gap-${process.pid}-${Date.now()}.raw`;
  const proc = Bun.spawn(
    [
      "sox", "-d", "-q",
      "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw",
      raw,
      "silence",
      "1", "0.15", `${cfg.startThresholdPct}%`,
      "1", `${cfg.endSilenceSecs}`, `${cfg.endThresholdPct}%`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  const opened = Date.now();
  let speechStarted = false;
  const watchdog = setInterval(() => {
    if (!speechStarted && fileSize(raw) >= MIN_PCM_BYTES) speechStarted = true;
    const t = (Date.now() - opened) / 1000;
    if (!speechStarted && t >= maxWaitSecs) proc.kill();
    if (speechStarted && t >= cfg.maxUtteranceSecs) proc.kill();
  }, 200);

  await proc.exited;
  clearInterval(watchdog);

  const pcm = readPcm(raw);
  discard(raw);
  if (pcm.length < MIN_PCM_BYTES) return { text: "" };
  const { text } = await transcribePcm(cfg, pcm);
  return { text };
}

function armRecorder(cfg: Config, opened: number, hooks: ListenHooks): Recorder {
  const raw = `/tmp/conch-utt-${process.pid}-${Date.now()}.raw`;
  const proc = Bun.spawn(
    [
      "sox", "-d", "-q",
      "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw",
      raw,
      "silence",
      "1", "0.15", `${cfg.startThresholdPct}%`,
      "1", `${cfg.endSilenceSecs}`, `${cfg.endThresholdPct}%`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  hooks.onState?.("armed");

  let speechStarted = false;
  let partialBusy = false;
  const watchdog = setInterval(() => {
    const size = fileSize(raw);
    if (!speechStarted && size >= MIN_PCM_BYTES) {
      speechStarted = true;
      hooks.onState?.("capturing");
    }
    const t = (Date.now() - opened) / 1000;
    if (!speechStarted && t >= cfg.listenWindowSecs) proc.kill();
    if (speechStarted && t >= cfg.listenWindowSecs + cfg.maxUtteranceSecs) proc.kill();

    // Live partial: transcribe the prefix captured so far. Warm server only
    // (the cold path's model reload could never keep up); one in flight.
    if (speechStarted && hooks.onPartial && serverUp() && !partialBusy) {
      partialBusy = true;
      transcribePcm(cfg, readPcm(raw))
        .then((r) => {
          if (r.text) hooks.onPartial!(r.text);
        })
        .finally(() => {
          partialBusy = false;
        });
    }
  }, 700);

  return { raw, proc, watchdog };
}

async function disarm(rec: Recorder): Promise<void> {
  rec.proc.kill();
  clearInterval(rec.watchdog);
  await rec.proc.exited;
  discard(rec.raw);
}

function readPcm(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    return new Uint8Array(0);
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}
