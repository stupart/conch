import type { Config } from "./config.ts";
import {
  audioTimeoutMs,
  awaitProcessWithWatchdog,
  awaitWithWatchdog,
  type AudioSpawner,
  type WatchdogWarning,
} from "./audio-watchdog.ts";
import type { TtsWorkerBackend } from "./tts-worker.ts";
import { createRecordOperation, type RecordObservationScope, type RecordObserver } from "./records-receipts.ts";

export type SpeechRecordContext = Omit<RecordObservationScope, "actionId"> & { actionId?: string };
type SpeechRecordOperation = ReturnType<typeof createRecordOperation>;

export interface CancellableSpeech {
  done: Promise<void>;
  cancel: () => void;
}

export interface ManagedSpeech extends CancellableSpeech {
  /** Resolves when this utterance owns the audio lane (it may still be starting synthesis). */
  started: Promise<void>;
}

export interface SpeechBackend {
  speakCancellable: (
    cfg: Config,
    text: string,
    label?: string,
    options?: {
      warn?: WatchdogWarning;
      onKokoroFailure?: (reason: "readiness-failed" | "synth-timeout") => void;
      worker?: TtsWorkerBackend | null;
    },
  ) => CancellableSpeech;
  /** Legacy/global safety net used to stop anything the backend still owns. */
  stopSpeaking: () => void;
}

interface LaneTask<T> {
  receipt?: SpeechRecordOperation;
  kind: "speech" | "cue" | "probe";
  operation: string;
  cancelled: boolean;
  started: boolean;
  start: () => Promise<T>;
  cancelActive: () => void;
  resolveStarted: () => void;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface Enqueued<T> {
  started: Promise<void>;
  done: Promise<T>;
  cancel: () => void;
}

/** The controller-owned guard that every queued audio/probe task enters at actual start time. */
export type SpeechAudioGate = <T>(operation: string, task: () => Promise<T>) => Promise<T>;

export interface SpeechManagerOptions {
  observeRecords?: RecordObserver;
  spawnAudio?: AudioSpawner;
  timeoutForText?: (text: string) => number;
  warn?: WatchdogWarning;
  onKokoroFailure?: (reason: "readiness-failed" | "synth-timeout") => void;
  worker?: TtsWorkerBackend | null;
}

const defaultSpawnAudio: AudioSpawner = (command) => Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });

/**
 * The daemon's single queued owner for speech, cues, and TTS probes.
 *
 * Microphone ownership stays exclusively with DictationController. Every task
 * enters its throw-on-violation audio gate when the task actually reaches the
 * front of this FIFO, so a task queued while the mic was closed cannot begin
 * later after the controller has opened it.
 */
export class SpeechManager {
  private readonly queue: LaneTask<unknown>[] = [];
  private current: LaneTask<unknown> | null = null;
  private pumping = false;
  private closed = false;
  private idleWaiters = new Set<() => void>();
  private readonly spawnAudio: AudioSpawner;
  private readonly timeoutForText: (text: string) => number;
  private readonly warn: WatchdogWarning;
  private readonly onKokoroFailure: (reason: "readiness-failed" | "synth-timeout") => void;
  private readonly worker: TtsWorkerBackend | null;
  private readonly observeRecords?: RecordObserver;

  constructor(
    private readonly backend: SpeechBackend,
    private readonly audioGate: SpeechAudioGate,
    options: SpeechManagerOptions = {},
  ) {
    this.spawnAudio = options.spawnAudio ?? defaultSpawnAudio;
    this.timeoutForText = options.timeoutForText ?? audioTimeoutMs;
    this.warn = options.warn ?? console.warn;
    this.onKokoroFailure = options.onKokoroFailure ?? (() => {});
    this.worker = options.worker ?? null;
    this.observeRecords = options.observeRecords;
  }

  speak(cfg: Config, text: string, label = "", context?: SpeechRecordContext): Promise<void> {
    return this.speakCancellable(cfg, text, label, context).done;
  }

  speakCancellable(cfg: Config, text: string, label = "", context?: SpeechRecordContext): ManagedSpeech {
    let active: CancellableSpeech | null = null;
    const receipt = context && createRecordOperation(this.observeRecords, context, "speech", text.length);
    const managed = this.enqueue<void>(
      async () => {
        receipt?.emit(cfg.speak && text ? "started" : "unknown", cfg.speak && text ? "backend-invoked" : "speech-disabled");
        active = this.watchSpeech(this.backend.speakCancellable(cfg, text, label, {
          warn: this.warn,
          onKokoroFailure: this.onKokoroFailure,
          worker: this.worker,
        }), text, "TTS", receipt);
        await active.done;
      },
      () => active?.cancel(),
      "speech",
      "TTS",
      receipt,
    );
    return managed;
  }

  /**
   * Hold the lane for an entire barge-in interaction, including recorder
   * finish/transcription after playback stops. `startSpeech` may be called
   * once, after the caller has armed its high-threshold recorder.
   */
  runInterruptible<T>(
    cfg: Config,
    text: string,
    label: string,
    interaction: (startSpeech: () => CancellableSpeech) => Promise<T>,
    context?: SpeechRecordContext,
  ): Promise<T | undefined> {
    let active: CancellableSpeech | null = null;
    const receipt = context && createRecordOperation(this.observeRecords, context, "speech", text.length);
    return this.enqueue<T>(
      () =>
        interaction(() => {
          if (active) throw new Error("interruptible speech already started");
          receipt?.emit(cfg.speak && text ? "started" : "unknown", cfg.speak && text ? "backend-invoked" : "speech-disabled");
          active = this.watchSpeech(
            this.backend.speakCancellable(cfg, text, label, {
              warn: this.warn,
              onKokoroFailure: this.onKokoroFailure,
              worker: this.worker,
            }),
            text,
            "barge-in TTS",
            receipt,
          );
          return active;
        }),
      () => active?.cancel(),
      "speech",
      "barge-in TTS",
      receipt,
    ).done;
  }

  /** Serialize a full-body readiness probe and gate it against controller mic ownership. */
  runProbe<T>(probe: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController();
    return this.enqueue<T>(
      () => probe(abort.signal),
      () => abort.abort(),
      "probe",
      "TTS readiness probe",
    ).done;
  }

  /** Play an afplay cue under the same ownership/cancellation rules as speech. */
  playCue(path: string, operation = "audio cue"): Promise<void> {
    let abort: AbortController | null = null;
    return this.enqueue<void>(
      async () => {
        abort = new AbortController();
        const proc = this.spawnAudio(["afplay", path]);
        await awaitProcessWithWatchdog(proc, {
          operation: `afplay ${operation}`,
          timeoutMs: this.timeoutForText(""),
          signal: abort.signal,
          warn: this.warn,
        });
      },
      () => abort?.abort(),
      "cue",
      operation,
    ).done;
  }

  cancelCurrent(): void {
    if (this.current) {
      this.current.cancelled = true;
      this.current.receipt?.emit("interrupted", "speech-cancelled");
      this.current.cancelActive();
    }
    // Also cover a backend process that predates the manager or failed before
    // handing its cancel handle back. The backend owns no concurrent speech.
    this.backend.stopSpeaking();
  }

  cancelAll(): void {
    this.cancelCurrent();
    for (const task of this.queue) {
      task.cancelled = true;
      task.receipt?.emit("interrupted", "speech-cancelled");
    }
  }

  /** Permanently skip future work while synchronously cancelling current/queued work. */
  close(): void {
    this.closed = true;
    this.cancelAll();
  }

  /** Cancel speech/cues already queued behind a probe; future work is unaffected. */
  cancelPendingAudio(): void {
    for (const task of this.queue) {
      if (task.kind === "speech" || task.kind === "cue") {
        task.cancelled = true;
        task.receipt?.emit("interrupted", "speech-cancelled");
      }
    }
  }

  /** Resolve only when no queued/current speech, cue, or probe remains. */
  async quiescent(): Promise<void> {
    while (this.current || this.queue.length || this.pumping) {
      await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    }
  }

  /**
   * Contain a backend that ignores its own cancel contract. The wrapper settles
   * independently, so pump() reaches finally and releases the lane on timeout.
   */
  private watchSpeech(active: CancellableSpeech, text: string, operation: string, receipt?: SpeechRecordOperation): CancellableSpeech {
    const abort = new AbortController();
    const done = (async () => {
      try {
        const result = await awaitWithWatchdog(active.done, {
          operation,
          timeoutMs: this.timeoutForText(text),
          signal: abort.signal,
          onCancel: () => active.cancel(),
          onTimeout: () => {
            try { active.cancel(); } catch {}
            try { this.backend.stopSpeaking(); } catch {}
          },
          timeoutAction: "cancelled",
          warn: this.warn,
        });
        // The legacy backend's void promise also resolves after internal failures.
        // Only cancellation/timeout is observable here; return is not proof of playback.
        if (result.status === "completed") receipt?.emit("unknown", "backend-returned");
        else if (result.status === "timed-out") receipt?.emit("failed", "speech-timeout");
        else receipt?.emit("interrupted", "speech-cancelled");
      } catch (error) {
        receipt?.emit("failed", "speech-backend-failed");
        throw error;
      }
    })();
    return { done, cancel: () => { receipt?.emit("interrupted", "speech-cancelled"); abort.abort(); } };
  }

  private enqueue<T>(
    start: () => Promise<T>,
    cancelActive: () => void = () => {},
    kind: LaneTask<T>["kind"] = "probe",
    operation = "audio task",
    receipt?: SpeechRecordOperation,
  ): Enqueued<T> {
    receipt?.emit("queued", "speech-queued");
    if (this.closed) {
      receipt?.emit("unknown", "speech-manager-closed");
      return {
        started: Promise.resolve(),
        done: Promise.resolve(undefined as T),
        cancel() {},
      };
    }
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => (resolveStarted = resolve));
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const done = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const task: LaneTask<T> = {
      receipt,
      kind,
      operation,
      cancelled: false,
      started: false,
      start,
      cancelActive,
      resolveStarted,
      resolve,
      reject,
    };
    this.queue.push(task as LaneTask<unknown>);
    void this.pump();

    return {
      started,
      done,
      cancel: () => {
        task.cancelled = true;
        task.receipt?.emit("interrupted", "speech-cancelled");
        if (task.started) task.cancelActive();
      },
    };
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const task = this.queue.shift()!;
        this.current = task;
        task.started = true;
        task.resolveStarted();
        try {
          if (task.cancelled) task.resolve(undefined);
          else {
            task.resolve(await this.audioGate(
              task.operation,
              () => task.cancelled ? Promise.resolve(undefined) : task.start(),
            ));
          }
        } catch (error) {
          task.receipt?.emit("failed", "speech-operation-failed");
          task.reject(error);
        } finally {
          task.receipt?.emit("unknown", "speech-operation-returned");
          this.current = null;
        }
      }
    } finally {
      this.pumping = false;
      if (!this.current && !this.queue.length) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }
}
