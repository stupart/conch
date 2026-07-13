import { chmodSync, statSync, unlinkSync, readFileSync } from "node:fs";
import type { Config } from "./config.ts";
import { transcribePcm, serverUp } from "./transcribe.ts";
import {
  classifyRecorderExit,
  createRecorderParent,
  emitRecorderTrace,
  formatDiagnosticError,
  startRecorderTrace,
  updateRecorderTrace,
  type RecorderKillCause,
  type RecorderTrace,
  type TranscriptionEngine,
} from "./diagnostics.ts";

// Anything smaller than this is silence (raw 16kHz 16-bit mono = 32KB/s).
const MIN_PCM_BYTES = 16_000; // ~0.5s
// Barge-in trigger: a bare "stop!" is ~0.3s of audio — the normal 0.5s bar
// silently discarded interruptions (took the user 10 tries, live).
const BARGE_MIN_PCM_BYTES = 5_000; // ~0.16s

export interface ListenHooks {
  /** armed = mic open & waiting; capturing = speech detected; transcribing = whisper running */
  onState?: (state: "armed" | "capturing" | "transcribing") => void;
  /** near-real-time partial transcript while you're still talking (warm server only) */
  onPartial?: (text: string) => void;
}

export interface ListenResult {
  text: string;
  error?: string;
  /** true when the mic was closed mid-listen by spacebar (abortListening) */
  aborted?: boolean;
  /** Present only when CONCH_KEEP_RAW=1; used to enrich the single recorder row. */
  diagnosticId?: string;
}

interface Capture {
  raw: string;
  proc: ReturnType<typeof Bun.spawn>;
  trace?: RecorderTrace;
  minimumBytes: number;
  killCause: RecorderKillCause;
  sizeAtKill: number | null;
}

interface Recorder extends Capture {
  watchdog: ReturnType<typeof setInterval>;
}

// Every capture path runs the identical sox recipe — headerless 16kHz mono PCM,
// endpointed by sox's `silence` effect. Only the START threshold differs
// (barge-in sits above speaker bleed). `-l` keeps the trailing below-threshold
// audio: voices trail off at the end of sentences, and without it sox trimmed
// the last words as "silence" (observed live: final couple words missing).
const activeRecorders = new Set<ReturnType<typeof Bun.spawn>>();
const tracedRecorders = new Map<ReturnType<typeof Bun.spawn>, Capture>();

function spawnCapture(
  cfg: Config,
  tag: string,
  startPct: number,
  minimumBytes: number,
  parent?: string,
  sequence = 1,
): Capture {
  const trace = startRecorderTrace(tag, parent, sequence);
  const raw = trace?.rawPath ?? `/tmp/conch-${tag}-${process.pid}-${Date.now()}.raw`;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      [
        "sox", "-d", "-q",
        "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw",
        raw,
        "silence", "-l",
        "1", "0.15", `${startPct}%`,
        "1", `${cfg.endSilenceSecs}`, `${cfg.endThresholdPct}%`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
  } catch (e) {
    if (trace) {
      const finalBytes = finalFileSize(raw).size;
      emitRecorderTrace(trace, {
        exitedAt: new Date().toISOString(),
        exitReason: "error",
        finalBytesAfterExit: finalBytes,
        error: formatDiagnosticError(e),
        intent: "spawn-error",
        bufferCountAfterReduction: 0,
      });
    }
    throw e;
  }
  const capture: Capture = { raw, proc, trace, minimumBytes, killCause: null, sizeAtKill: null };
  activeRecorders.add(proc);
  if (trace) tracedRecorders.set(proc, capture);
  void proc.exited.then(() => {
    activeRecorders.delete(proc);
    tracedRecorders.delete(proc);
  });
  return capture;
}

/** Kill any in-flight sox capture — daemon shutdown must not leave the mic hot. */
export function killActiveRecorders(): Promise<void> | undefined {
  const diagnosticExits: Promise<void>[] = [];
  for (const proc of activeRecorders) {
    const capture = tracedRecorders.get(proc);
    if (capture) {
      markKill(capture, "shutdown");
      diagnosticExits.push(
        proc.exited.then((code) => {
          finalizeCaptureTrace(capture, code);
          emitRecorderTrace(capture.trace, { intent: "shutdown", bufferCountAfterReduction: null });
        }),
      );
    }
    proc.kill();
  }
  activeRecorders.clear();
  return diagnosticExits.length ? Promise.all(diagnosticExits).then(() => {}) : undefined;
}

// Set when the user closes the mic (spacebar) mid-listen: kills the live
// recorder AND tells listenOnce to bail cleanly instead of re-arming or
// transcribing the truncated clip. Reset at the top of each listenOnce.
let listenAborted = false;

/** Close an in-flight listenOnce immediately — spacebar while the mic is open. */
export function abortListening(): void {
  listenAborted = true;
  killActiveRecorders();
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
export async function listenOnce(cfg: Config, hooks: ListenHooks = {}): Promise<ListenResult> {
  listenAborted = false; // a stale abort from a past listen must not close this one
  const opened = Date.now();
  const windowSpent = () => (Date.now() - opened) / 1000 >= cfg.listenWindowSecs;
  const parent = createRecorderParent("listen");
  let sequence = 0;

  let rec = armRecorder(cfg, opened, hooks, parent, ++sequence);

  while (true) {
    const exitCode = await rec.proc.exited;
    clearInterval(rec.watchdog);

    if (listenAborted) {
      discard(rec.raw);
      return withDiagnostic({ text: "", aborted: true }, rec.trace); // spacebar closed the mic mid-listen
    }

    const pcm = completedPcm(rec, exitCode);
    // Diagnostics-only shutdown waits for SoX to flush before process exit.
    // Do not let that extra wait turn the killed recorder into a false-start
    // re-arm or a hot-next recorder; the ordinary (diagnostics-off) path exits
    // synchronously before this continuation can run, exactly as before.
    if (rec.killCause === "shutdown") {
      emitRecorderTrace(rec.trace, { intent: "shutdown", bufferCountAfterReduction: null });
      return withDiagnostic({ text: "" }, rec.trace);
    }

    if (pcm.length < MIN_PCM_BYTES) {
      if (windowSpent()) return withDiagnostic({ text: "" }, rec.trace); // window over (or the timeout kill)
      emitRecorderTrace(rec.trace, { intent: "false-start", bufferCountAfterReduction: 0 });
      rec = armRecorder(cfg, opened, hooks, parent, ++sequence); // false start — re-arm
      continue;
    }

    let next: Recorder | null;
    try {
      next = windowSpent() ? null : armRecorder(cfg, opened, hooks, parent, ++sequence);
    } catch (e) {
      updateRecorderTrace(rec.trace, {
        exitReason: "error",
        error: `hot-next recorder: ${formatDiagnosticError(e)}`,
      });
      emitRecorderTrace(rec.trace, { intent: "hot-next-error", bufferCountAfterReduction: 0 });
      throw e;
    }
    hooks.onState?.("transcribing");
    let result: { text: string; error?: string };
    try {
      result = await transcribePcm(cfg, pcm, engineReporter(rec.trace));
    } catch (e) {
      // The ordinary path historically leaves the hot-next recorder alone on
      // a thrown transcription. Diagnostics must still close and account for
      // it, without changing the default-off lifecycle.
      if (next?.trace) {
        try {
          await disarm(next);
        } catch (disarmError) {
          emitRecorderTrace(next.trace, {
            exitReason: "error",
            error: `failed to disarm after transcription error: ${formatDiagnosticError(disarmError)}`,
            intent: "disarm-error",
            bufferCountAfterReduction: 0,
          });
        }
      }
      updateRecorderTrace(rec.trace, { exitReason: "error", error: formatDiagnosticError(e) });
      emitRecorderTrace(rec.trace, { intent: "transcription-error", bufferCountAfterReduction: 0 });
      throw e;
    }
    updateTranscriptionTrace(rec.trace, result);

    if (listenAborted) {
      if (next) await disarm(next);
      return withDiagnostic({ text: "", aborted: true }, rec.trace);
    }
    if (result.error || result.text) {
      if (next) await disarm(next);
      return withDiagnostic(result, rec.trace);
    }
    if (!next) return withDiagnostic({ text: "" }, rec.trace); // noise transcribed to nothing, window over
    emitRecorderTrace(rec.trace, { intent: "empty-transcript", bufferCountAfterReduction: 0 });
    rec = next; // keep whatever the hot mic caught in the meantime
  }
}

/**
 * Barge-in recorder: armed WHILE the daemon is speaking a chunk, with a
 * higher start threshold than normal listening so speaker-bleed (the mic
 * hearing the Mac's own voice) doesn't trip it but voice-at-desk does.
 * The caller polls `triggered()` to kill playback the moment you start
 * talking, then `finish()` endpoints and transcribes your utterance.
 */
export function armBargeRecorder(cfg: Config): {
  triggered: () => boolean;
  finish: () => Promise<ListenResult>;
  abort: () => Promise<void>;
} {
  const parent = createRecorderParent("barge");
  const capture = spawnCapture(cfg, "barge", cfg.bargeThresholdPct, BARGE_MIN_PCM_BYTES, parent, 1);
  const { raw, proc } = capture;
  const hardStop = setTimeout(() => {
    markKill(capture, "max");
    proc.kill();
  }, cfg.maxUtteranceSecs * 1000);
  return {
    triggered: () => fileSize(raw) >= BARGE_MIN_PCM_BYTES,
    async finish() {
      const exitCode = await proc.exited;
      clearTimeout(hardStop);
      const pcm = completedPcm(capture, exitCode);
      if (pcm.length < BARGE_MIN_PCM_BYTES) return withDiagnostic({ text: "" }, capture.trace);
      try {
        const result = await transcribePcm(cfg, pcm, engineReporter(capture.trace));
        updateTranscriptionTrace(capture.trace, result);
        return withDiagnostic(result, capture.trace);
      } catch (e) {
        updateRecorderTrace(capture.trace, { exitReason: "error", error: formatDiagnosticError(e) });
        emitRecorderTrace(capture.trace, { intent: "transcription-error", bufferCountAfterReduction: 0 });
        throw e;
      }
    },
    async abort() {
      markKill(capture, "abort");
      proc.kill();
      clearTimeout(hardStop);
      const exitCode = await proc.exited;
      if (capture.trace) completedPcm(capture, exitCode);
      else discard(raw);
      emitRecorderTrace(capture.trace, { intent: "barge-abort", bufferCountAfterReduction: 0 });
    },
  };
}

/**
 * Brief interjection window between read-aloud chunks: wait up to
 * `maxWaitSecs` for speech to START; if nothing, return immediately-ish so
 * reading continues. If the user does start talking, capture the full
 * utterance (endpointed as usual) and transcribe it.
 */
export async function listenGap(cfg: Config, maxWaitSecs: number): Promise<ListenResult> {
  const parent = createRecorderParent("gap");
  const capture = spawnCapture(cfg, "gap", cfg.startThresholdPct, MIN_PCM_BYTES, parent, 1);
  const { raw, proc } = capture;

  const opened = Date.now();
  let speechStarted = false;
  const watchdog = setInterval(() => {
    if (!speechStarted && fileSize(raw) >= MIN_PCM_BYTES) speechStarted = true;
    const t = (Date.now() - opened) / 1000;
    if (!speechStarted && t >= maxWaitSecs) {
      markKill(capture, "window");
      proc.kill();
    }
    if (speechStarted && t >= cfg.maxUtteranceSecs) {
      markKill(capture, "max");
      proc.kill();
    }
  }, 200);

  const exitCode = await proc.exited;
  clearInterval(watchdog);

  const pcm = completedPcm(capture, exitCode);
  if (pcm.length < MIN_PCM_BYTES) return withDiagnostic({ text: "" }, capture.trace);
  try {
    const result = await transcribePcm(cfg, pcm, engineReporter(capture.trace));
    updateTranscriptionTrace(capture.trace, result);
    return withDiagnostic(result, capture.trace);
  } catch (e) {
    updateRecorderTrace(capture.trace, { exitReason: "error", error: formatDiagnosticError(e) });
    emitRecorderTrace(capture.trace, { intent: "transcription-error", bufferCountAfterReduction: 0 });
    throw e;
  }
}

function armRecorder(
  cfg: Config,
  opened: number,
  hooks: ListenHooks,
  parent?: string,
  sequence = 1,
): Recorder {
  const capture = spawnCapture(cfg, "utt", cfg.startThresholdPct, MIN_PCM_BYTES, parent, sequence);
  const { raw, proc } = capture;
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
    if (!speechStarted && t >= cfg.listenWindowSecs) {
      markKill(capture, "window");
      proc.kill();
    }
    if (speechStarted && t >= cfg.listenWindowSecs + cfg.maxUtteranceSecs) {
      markKill(capture, "max");
      proc.kill();
    }

    // Live partial: transcribe the prefix captured so far. Warm server only
    // (the cold path's model reload could never keep up); one in flight.
    if (speechStarted && hooks.onPartial && serverUp() && !partialBusy) {
      partialBusy = true;
      transcribePcm(cfg, readPcm(raw))
        .then((r) => {
          if (r.text) hooks.onPartial!(r.text);
        })
        .catch(() => {}) // a failed partial must not become an unhandled rejection
        .finally(() => {
          partialBusy = false;
        });
    }
  }, 700);

  return { ...capture, watchdog };
}

async function disarm(rec: Recorder): Promise<void> {
  markKill(rec, "disarmed-next");
  rec.proc.kill();
  clearInterval(rec.watchdog);
  const exitCode = await rec.proc.exited;
  if (rec.trace) completedPcm(rec, exitCode);
  else discard(rec.raw);
  emitRecorderTrace(rec.trace, { intent: "disarmed-next", bufferCountAfterReduction: 0 });
}

function markKill(capture: Capture, cause: Exclude<RecorderKillCause, null>): void {
  if (!capture.trace || capture.killCause) return;
  capture.killCause = cause;
  capture.sizeAtKill = fileSize(capture.raw);
  updateRecorderTrace(capture.trace, { killCause: cause, sizeAtKill: capture.sizeAtKill });
}

function completedPcm(capture: Capture, exitCode: number): Uint8Array {
  if (!capture.trace) {
    const pcm = readPcm(capture.raw);
    discard(capture.raw);
    return pcm;
  }

  const final = finalFileSize(capture.raw);
  let pcm = new Uint8Array(0);
  let readError = final.error;
  if (!readError) {
    try {
      pcm = new Uint8Array(readFileSync(capture.raw));
      chmodSync(capture.raw, 0o600);
    } catch (e) {
      readError = formatDiagnosticError(e);
    }
  }
  finalizeCaptureTrace(capture, exitCode, final.size, readError);
  return pcm;
}

function finalizeCaptureTrace(
  capture: Capture,
  exitCode: number,
  knownFinalBytes?: number,
  knownError?: string | null,
): void {
  if (!capture.trace) return;
  const final = knownFinalBytes === undefined ? finalFileSize(capture.raw) : { size: knownFinalBytes, error: null };
  const unexpectedExit = !capture.killCause && exitCode !== 0 ? `sox exited with code ${exitCode}` : null;
  const error = knownError ?? final.error ?? unexpectedExit;
  if (!final.error) {
    try {
      chmodSync(capture.raw, 0o600);
    } catch {}
  }
  updateRecorderTrace(capture.trace, {
    exitedAt: new Date().toISOString(),
    exitReason: classifyRecorderExit({
      killCause: capture.killCause,
      finalBytesAfterExit: final.size,
      minimumBytes: capture.minimumBytes,
      error,
    }),
    killCause: capture.killCause,
    sizeAtKill: capture.sizeAtKill,
    finalBytesAfterExit: final.size,
    error,
  });
}

function finalFileSize(path: string): { size: number; error: string | null } {
  try {
    return { size: statSync(path).size, error: null };
  } catch (e) {
    return { size: 0, error: formatDiagnosticError(e) };
  }
}

function engineReporter(trace: RecorderTrace | undefined): ((engine: TranscriptionEngine) => void) | undefined {
  return trace ? (engine) => updateRecorderTrace(trace, { engine }) : undefined;
}

function updateTranscriptionTrace(
  trace: RecorderTrace | undefined,
  result: { text: string; error?: string },
): void {
  updateRecorderTrace(
    trace,
    result.error
      ? { transcript: result.text, error: result.error, exitReason: "error" }
      : { transcript: result.text },
  );
}

function withDiagnostic(result: { text: string; error?: string; aborted?: boolean }, trace: RecorderTrace | undefined): ListenResult {
  return trace ? { ...result, diagnosticId: trace.id } : result;
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
