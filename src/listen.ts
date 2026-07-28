import { chmodSync, statSync, unlinkSync, readFileSync } from "node:fs";
import type { Config } from "./config.ts";
import { transcribePcm, serverUp } from "./transcribe.ts";
import {
  DictationController,
  type BarrierTicket,
  type CapturedAudio,
  type DictationEvent,
  type RecorderHandle,
} from "./dictation-controller.ts";
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
import { TranscriptionGate } from "./transcription-gate.ts";

// Anything smaller than this is silence (raw 16kHz 16-bit mono = 32KB/s).
export const MIN_PCM_BYTES = 16_000; // ~0.5s
// Barge-in trigger: a bare "stop!" is ~0.3s of audio — the normal 0.5s bar
// silently discarded interruptions (took the user 10 tries, live).
export const BARGE_MIN_PCM_BYTES = 5_000; // ~0.16s

export interface ListenHooks {
  /** armed = mic open & waiting; capturing = speech detected; transcribing = whisper running */
  onState?: (state: "armed" | "capturing" | "transcribing") => void;
  /** near-real-time partial transcript while you're still talking (warm server only) */
  onPartial?: (text: string) => void;
}

export interface ListenResult {
  text: string;
  error?: string;
  /** Present only when CONCH_KEEP_RAW=1; used to enrich the single recorder row. */
  diagnosticId?: string;
  /** All ordered recorder rows contributing to this result. */
  diagnosticIds?: string[];
}

export interface RuntimeDictationSession {
  readonly controller: DictationController;
  readonly micOpen: boolean;
  readonly state: DictationController["state"];
  start(initialCapture?: RecorderHandle): void;
  resume(initialCapture?: RecorderHandle): void;
  nextEvent(): Promise<DictationEvent>;
  acknowledge(event: DictationEvent): void;
  requestBarrier(reason: string): BarrierTicket;
  requestTimeout(): BarrierTicket;
  setIdleWindowSecs(seconds: number): void;
  /** Stop this scoped exchange without submitting its captured tail. */
  abort(): Promise<void>;
}

interface Capture {
  raw: string;
  proc: ReturnType<typeof Bun.spawn>;
  trace?: RecorderTrace;
  minimumBytes: number;
  killCause: RecorderKillCause;
  sizeAtKill: number | null;
  controllerOwned?: boolean;
}

// Every capture path runs the identical sox recipe — headerless 16kHz mono PCM,
// endpointed by sox's `silence` effect. Only the START threshold differs
// (barge-in sits above speaker bleed). `-l` keeps the trailing below-threshold
// audio: voices trail off at the end of sentences, and without it sox trimmed
// the last words as "silence" (observed live: final couple words missing).
const activeRecorders = new Set<ReturnType<typeof Bun.spawn>>();
const tracedRecorders = new Map<ReturnType<typeof Bun.spawn>, Capture>();
const activeControllers = new Set<DictationController>();
const activeBargeShutdowns = new Map<ReturnType<typeof Bun.spawn>, () => Promise<void>>();

export function soxCaptureArgs(
  cfg: Pick<Config, "micGainDb" | "endSilenceSecs" | "endThresholdPct">,
  raw: string,
  startPct: number,
): string[] {
  return [
    "sox", "-d", "-q",
    "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw",
    raw,
    ...(cfg.micGainDb ? ["gain", String(cfg.micGainDb)] : []),
    "silence", "-l",
    "1", "0.15", `${startPct}%`,
    "1", `${cfg.endSilenceSecs}`, `${cfg.endThresholdPct}%`,
  ];
}

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
      soxCaptureArgs(cfg, raw, startPct),
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

/** True for every Conch-owned SoX child, including pre-adoption barge capture. */
export function hasActiveRecorders(): boolean {
  return activeRecorders.size > 0;
}

/** Kill any in-flight sox capture — daemon shutdown must not leave the mic hot. */
export function killActiveRecorders(): Promise<void> | undefined {
  const diagnosticExits: Promise<void>[] = [];
  // Claim an intentional during-TTS recorder before the generic process sweep.
  // It has no controller yet, so its own single owner must drain/transcribe it.
  for (const shutdown of activeBargeShutdowns.values()) diagnosticExits.push(shutdown());
  for (const controller of activeControllers) {
    if (controller.state === "running" || controller.state === "draining") {
      diagnosticExits.push(controller.requestBarrier("shutdown").done);
    }
  }
  for (const proc of activeRecorders) {
    const capture = tracedRecorders.get(proc);
    if (capture) {
      markKill(capture, "shutdown");
      if (!capture.controllerOwned) diagnosticExits.push(
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

/**
 * Conversation-scoped continuous capture. The backend owns SoX processes;
 * DictationController owns rearming, FIFO work, barriers, and final ordering.
 */
export function createDictationSession(
  cfg: Config,
  hooks: ListenHooks = {},
  options: {
    tag?: string;
    startPct?: number;
    minimumBytes?: number;
    idleWindowSecs?: number;
    parent?: string;
    traceSequence?: () => number;
  } = {},
): RuntimeDictationSession {
  const tag = options.tag ?? "utt";
  const startPct = options.startPct ?? cfg.startThresholdPct;
  const minimumBytes = options.minimumBytes ?? MIN_PCM_BYTES;
  const parent = options.parent ?? createRecorderParent(tag === "utt" ? "listen" : tag);
  let idleWindowSecs = options.idleWindowSecs ?? cfg.listenWindowSecs;
  let idleDeadline = Date.now() + idleWindowSecs * 1000;
  let nextOpenBeginsNewWindow = false;
  let controller!: DictationController;
  let abortDone: Promise<void> | null = null;
  const transcriptionGate = new TranscriptionGate(() => controller.finalWorkerIdle);

  const backend = {
    open(context: { sequence: number; generation: number }): RecorderHandle {
      const handle = armContinuousRecorder(
        cfg,
        tag,
        startPct,
        minimumBytes,
        parent,
        options.traceSequence?.() ?? context.sequence,
        context,
        hooks,
        (pcm) => transcriptionGate.tryRunPartial(() => transcribePcm(cfg, pcm, undefined, { coldFallback: false })),
        () => {
          nextOpenBeginsNewWindow = true;
          controller.cancelTimeout();
        },
        (text) => controller.publishPartial({ ...context, text }),
      );
      queueMicrotask(() => {
        if (controller.state === "running" && controller.activeSequence === context.sequence) {
          if (nextOpenBeginsNewWindow) {
            idleDeadline = Date.now() + idleWindowSecs * 1000;
            nextOpenBeginsNewWindow = false;
          }
          controller.scheduleTimeout(Math.max(0, idleDeadline - Date.now()));
        }
      });
      return handle;
    },
    read(capture: CapturedAudio): Uint8Array {
      return new Uint8Array(readFileSync(capture.rawPath));
    },
  };

  controller = new DictationController({
    backend,
    minimumBytes,
    transcriber: {
      async transcribe(pcm, context) {
        hooks.onState?.("transcribing");
        const trace = context.diagnosticId
          ? { id: context.diagnosticId, rawPath: context.rawPath }
          : undefined;
        try {
          const result = await transcriptionGate.runFinal(
            () => transcribePcm(
              cfg,
              pcm,
              context.diagnosticId
                ? (engine) => updateRecorderTrace(context.diagnosticId, { engine })
                : undefined,
            ),
          );
          updateTranscriptionTrace(trace, result);
          return result;
        } catch (error) {
          updateRecorderTrace(trace, { exitReason: "error", error: formatDiagnosticError(error) });
          throw error;
        }
      },
    },
    deleteRaw(capture) {
      if (!capture.diagnosticId) discard(capture.rawPath);
    },
    onPartial: hooks.onPartial ? (text) => hooks.onPartial!(text) : undefined,
  });

  return {
    controller,
    get micOpen() {
      return controller.micOpen;
    },
    get state() {
      return controller.state;
    },
    start(initialCapture) {
      idleDeadline = Date.now() + idleWindowSecs * 1000;
      nextOpenBeginsNewWindow = false;
      controller.start(initialCapture);
      activeControllers.add(controller);
    },
    resume(initialCapture) {
      idleDeadline = Date.now() + idleWindowSecs * 1000;
      nextOpenBeginsNewWindow = false;
      controller.resume(initialCapture);
      activeControllers.add(controller);
    },
    nextEvent: () => controller.nextEvent(),
    acknowledge(event) {
      controller.acknowledge(event);
      if (controller.state === "idle" || controller.state === "closed") activeControllers.delete(controller);
    },
    requestBarrier: (reason) => controller.requestBarrier(reason),
    requestTimeout: () => controller.requestTimeout(),
    abort() {
      if (abortDone) return abortDone;
      if (controller.state === "closed" || controller.state === "idle") {
        abortDone = Promise.resolve();
      } else {
        abortDone = controller.requestBarrier("manual-reply").done;
      }
      return abortDone;
    },
    setIdleWindowSecs(seconds) {
      idleWindowSecs = seconds;
      idleDeadline = Date.now() + seconds * 1000;
      if (controller.micOpen) controller.scheduleTimeout(seconds * 1000);
    },
  };
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
  return collectContinuousResult(cfg, hooks);
}

/** Adopt a live barge capture, rearm behind it, and drain all ordered speech. */
export async function listenFromCapture(
  cfg: Config,
  initialCapture: RecorderHandle,
  hooks: ListenHooks = {},
  options: { parent?: string } = {},
): Promise<ListenResult> {
  return collectContinuousResult(cfg, hooks, initialCapture, options);
}

async function collectContinuousResult(
  cfg: Config,
  hooks: ListenHooks,
  initialCapture?: RecorderHandle,
  options: {
    parent?: string;
    traceSequence?: () => number;
    tag?: string;
    onSessionStarted?: (session: RuntimeDictationSession) => void;
  } = {},
): Promise<ListenResult> {
  const session = createDictationSession(cfg, hooks, options);
  const texts: string[] = [];
  const diagnosticIds: string[] = [];
  let error: string | undefined;
  let closing = false;
  session.start(initialCapture);
  options.onSessionStarted?.(session);
  while (true) {
    const event = await session.nextEvent();
    if (event.kind === "transcript") {
      if (event.diagnosticId) diagnosticIds.push(event.diagnosticId);
      if (event.text) {
        texts.push(event.text);
        if (!closing) {
          closing = true;
          session.requestBarrier("listen-result");
        }
      } else {
        emitRecorderTrace(event.diagnosticId, { intent: "empty-transcript", bufferCountAfterReduction: 0 });
      }
      continue;
    }
    if (event.kind === "short") {
      emitRecorderTrace(event.diagnosticId, {
        intent: event.cause === "timeout" ? "timeout-close" : "false-start",
        bufferCountAfterReduction: 0,
      });
      continue;
    }
    if (event.kind === "error") {
      error ??= event.error;
      emitRecorderTrace(event.diagnosticId, { intent: `${event.stage}-error`, bufferCountAfterReduction: 0 });
      if (!closing) {
        closing = true;
        session.requestBarrier("listen-error");
      }
      continue;
    }
    if (event.kind === "timeout") {
      closing = true;
      continue;
    }
    session.acknowledge(event);
    if (session.state === "draining") continue; // another FIFO barrier is still pending
    const result: ListenResult = {
      text: texts.join(" "),
      ...(error ? { error } : {}),
      ...(diagnosticIds[0] ? { diagnosticId: diagnosticIds[0], diagnosticIds } : {}),
    };
    return result;
  }
}

/**
 * Barge-in recorder: armed WHILE the daemon is speaking a chunk, with a
 * higher start threshold than normal listening so speaker-bleed (the mic
 * hearing the Mac's own voice) doesn't trip it but voice-at-desk does.
 * The caller polls `triggered()` to kill playback the moment you start
 * talking, then `finish()` endpoints and transcribes your utterance.
 */
export function armBargeRecorder(cfg: Config, traceParent?: string, traceSequence = 1): {
  triggered: () => boolean;
  finish: () => Promise<ListenResult>;
  abort: () => Promise<void>;
  /** Transfer the still-live capture to a continuous controller. */
  adopt: () => RecorderHandle | undefined;
  parent?: string;
} {
  const parent = traceParent ?? createRecorderParent("barge");
  const capture = spawnCapture(cfg, "barge", cfg.bargeThresholdPct, BARGE_MIN_PCM_BYTES, parent, traceSequence);
  // Until adoption, the barge registry is its finalization owner. This prevents
  // shutdown from treating a >=MIN intentional capture as an untranscribed
  // legacy recorder.
  capture.controllerOwned = true;
  const { raw, proc } = capture;
  let stopReason: string | undefined;
  let owner: "barge" | "adopted" | "attached" | "standalone" | "abort" | "shutdown" = "barge";
  let shutdownDrain: Promise<void> | undefined;
  let standaloneDrain: Promise<ListenResult> | undefined;
  let abortDrain: Promise<void> | undefined;
  const stopCapture = (reason: string): void => {
    if (stopReason) return;
    stopReason = reason;
    const cause: Exclude<RecorderKillCause, null> = reason === "max"
      ? "max"
      : reason === "shutdown"
        ? "shutdown"
        : "abort";
    markKill(capture, cause);
    proc.kill();
  };
  const hardStop = setTimeout(() => stopCapture("max"), cfg.maxUtteranceSecs * 1000);
  const finished = proc.exited.then((exitCode): CapturedAudio => {
    clearTimeout(hardStop);
    const final = finalFileSize(raw);
    const error = final.error ?? (!capture.killCause && exitCode !== 0 ? `sox exited with code ${exitCode}` : null);
    finalizeCaptureTrace(capture, exitCode, final.size, error);
    return {
      rawPath: raw,
      finalBytes: final.size,
      minimumBytes: BARGE_MIN_PCM_BYTES,
      ...(capture.trace ? { diagnosticId: capture.trace.id } : {}),
      ...(stopReason ? { cause: stopReason } : {}),
      ...(error ? { error } : {}),
    };
  });
  const handle: RecorderHandle = {
    finished,
    stop: stopCapture,
    attached() {
      if (owner !== "adopted") return;
      owner = "attached";
      activeBargeShutdowns.delete(proc);
    },
  };
  const shutdown = (): Promise<void> => {
    if (shutdownDrain) return shutdownDrain;
    if (owner === "abort") return abortDrain ?? Promise.resolve();
    if (owner === "standalone") return standaloneDrain?.then(() => {}) ?? Promise.resolve();
    if (owner !== "barge" && owner !== "adopted") return Promise.resolve();
    owner = "shutdown";
    activeBargeShutdowns.delete(proc);
    stopCapture("shutdown");
    shutdownDrain = (async () => {
      const captured = await finished;
      if (captured.error) {
        updateRecorderTrace(capture.trace, { error: captured.error });
      } else if (captured.finalBytes >= BARGE_MIN_PCM_BYTES) {
        try {
          const pcm = readPcm(raw);
          const result = await transcribePcm(cfg, pcm, engineReporter(capture.trace));
          updateRecorderTrace(capture.trace, result.error
            ? { transcript: result.text, error: result.error }
            : { transcript: result.text });
        } catch (error) {
          updateRecorderTrace(capture.trace, { error: formatDiagnosticError(error) });
        }
      }
      if (!capture.trace) discard(raw);
      emitRecorderTrace(capture.trace, { intent: "shutdown", bufferCountAfterReduction: null });
    })();
    return shutdownDrain;
  };
  activeBargeShutdowns.set(proc, shutdown);
  return {
    triggered: () => fileSize(raw) >= BARGE_MIN_PCM_BYTES,
    finish() {
      if (owner === "shutdown") {
        return shutdown().then(() => withDiagnostic({ text: "" }, capture.trace));
      }
      if (owner !== "barge") return Promise.reject(new Error("barge capture already disposed"));
      owner = "standalone";
      standaloneDrain = (async () => {
        try {
          const captured = await finished;
          if (captured.error) return withDiagnostic({ text: "", error: captured.error }, capture.trace);
          const pcm = readPcm(raw);
          if (!capture.trace) discard(raw);
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
        } finally {
          activeBargeShutdowns.delete(proc);
        }
      })();
      return standaloneDrain;
    },
    abort() {
      if (owner === "shutdown") return shutdown();
      if (owner === "abort") return abortDrain ?? Promise.resolve();
      if (owner !== "barge") return Promise.resolve();
      owner = "abort";
      stopCapture("abort");
      abortDrain = (async () => {
        try {
          await finished;
          if (!capture.trace) discard(raw);
          emitRecorderTrace(capture.trace, { intent: "barge-abort", bufferCountAfterReduction: 0 });
        } finally {
          activeBargeShutdowns.delete(proc);
        }
      })();
      return abortDrain;
    },
    adopt() {
      if (owner === "shutdown") return undefined;
      if (owner !== "barge") throw new Error("barge capture already disposed");
      owner = "adopted";
      return handle;
    },
    parent,
  };
}

/**
 * Brief interjection window between read-aloud chunks: wait up to
 * `maxWaitSecs` for speech to START; if nothing, return immediately-ish so
 * reading continues. If the user does start talking, capture the full
 * utterance (endpointed as usual) and transcribe it.
 */
export async function listenGap(
  cfg: Config,
  maxWaitSecs: number,
  options: {
    parent?: string;
    traceSequence?: () => number;
    onSessionStarted?: (session: RuntimeDictationSession) => void;
  } = {},
): Promise<ListenResult> {
  return collectContinuousResult(
    { ...cfg, listenWindowSecs: maxWaitSecs },
    {},
    undefined,
    { ...options, tag: "gap" },
  );
}

function armContinuousRecorder(
  cfg: Config,
  tag: string,
  startPct: number,
  minimumBytes: number,
  parent: string | undefined,
  diagnosticSequence: number,
  context: { sequence: number; generation: number },
  hooks: ListenHooks,
  transcribePartial: (pcm: Uint8Array) => Promise<{ text: string }> | undefined,
  onSpeechStarted: () => void,
  onPartial: (text: string) => void,
): RecorderHandle {
  const capture = spawnCapture(cfg, tag, startPct, minimumBytes, parent, diagnosticSequence);
  capture.controllerOwned = true;
  const { raw, proc } = capture;
  const opened = Date.now();
  let speechStartedAt: number | null = null;
  let partialBusy = false;
  let stopReason: string | undefined;
  hooks.onState?.("armed");

  const watchdog = setInterval(() => {
    const size = fileSize(raw);
    if (speechStartedAt === null && size >= minimumBytes) {
      speechStartedAt = Date.now();
      onSpeechStarted();
      hooks.onState?.("capturing");
    }
    if (speechStartedAt !== null && (Date.now() - speechStartedAt) / 1000 >= cfg.maxUtteranceSecs) {
      stopReason = "max";
      markKill(capture, "max");
      proc.kill();
    }

    if (speechStartedAt !== null && hooks.onPartial && serverUp() && !partialBusy) {
      const partial = transcribePartial(readPcm(raw));
      if (!partial) return;
      partialBusy = true;
      partial
        .then((result) => {
          if (result.text) onPartial(result.text);
        })
        .catch(() => {})
        .finally(() => {
          partialBusy = false;
        });
    }
  }, 700);

  const finished = proc.exited.then((exitCode): CapturedAudio => {
    clearInterval(watchdog);
    const final = finalFileSize(raw);
    const error = final.error ?? (!capture.killCause && exitCode !== 0 ? `sox exited with code ${exitCode}` : null);
    finalizeCaptureTrace(capture, exitCode, final.size, error);
    return {
      rawPath: raw,
      finalBytes: final.size,
      minimumBytes,
      ...(capture.trace ? { diagnosticId: capture.trace.id } : {}),
      ...(stopReason ? { cause: stopReason } : {}),
      ...(error ? { error } : {}),
    };
  });

  return {
    finished,
    stop(reason) {
      if (stopReason) return;
      stopReason = reason;
      const cause: Exclude<RecorderKillCause, null> = reason === "timeout"
        ? "window"
        : reason === "shutdown"
          ? "shutdown"
          : "abort";
      markKill(capture, cause);
      proc.kill();
    },
  };
}

function markKill(capture: Capture, cause: Exclude<RecorderKillCause, null>): void {
  if (capture.killCause) {
    // A shutdown sweep is the terminal owner even if a user-action barrier
    // initiated the same process stop a moment earlier.
    if (cause === "shutdown" && capture.killCause === "abort") {
      capture.killCause = "shutdown";
      updateRecorderTrace(capture.trace, { killCause: "shutdown" });
    }
    return;
  }
  capture.killCause = cause;
  if (!capture.trace) return;
  capture.sizeAtKill = fileSize(capture.raw);
  updateRecorderTrace(capture.trace, { killCause: cause, sizeAtKill: capture.sizeAtKill });
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

function withDiagnostic(result: { text: string; error?: string }, trace: RecorderTrace | undefined): ListenResult {
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
