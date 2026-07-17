import type { Config } from "./config.ts";
import {
  audioTimeoutMs,
  awaitProcessWithWatchdog,
  awaitWithWatchdog,
  type AudioSpawner,
  type WatchdogWarning,
} from "./audio-watchdog.ts";

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
    },
  ) => CancellableSpeech;
  /** Legacy/global safety net used to stop anything the backend still owns. */
  stopSpeaking: () => void;
}

interface LaneTask<T> {
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
  spawnAudio?: AudioSpawner;
  timeoutForText?: (text: string) => number;
  warn?: WatchdogWarning;
  onKokoroFailure?: (reason: "readiness-failed" | "synth-timeout") => void;
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

  constructor(
    private readonly backend: SpeechBackend,
    private readonly audioGate: SpeechAudioGate,
    options: SpeechManagerOptions = {},
  ) {
    this.spawnAudio = options.spawnAudio ?? defaultSpawnAudio;
    this.timeoutForText = options.timeoutForText ?? audioTimeoutMs;
    this.warn = options.warn ?? console.warn;
    this.onKokoroFailure = options.onKokoroFailure ?? (() => {});
  }

  speak(cfg: Config, text: string, label = ""): Promise<void> {
    return this.speakCancellable(cfg, text, label).done;
  }

  speakCancellable(cfg: Config, text: string, label = ""): ManagedSpeech {
    let active: CancellableSpeech | null = null;
    const managed = this.enqueue<void>(
      async () => {
        active = this.watchSpeech(this.backend.speakCancellable(cfg, text, label, {
          warn: this.warn,
          onKokoroFailure: this.onKokoroFailure,
        }), text, "TTS");
        await active.done;
      },
      () => active?.cancel(),
      "speech",
      "TTS",
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
  ): Promise<T | undefined> {
    let active: CancellableSpeech | null = null;
    return this.enqueue<T>(
      () =>
        interaction(() => {
          if (active) throw new Error("interruptible speech already started");
          active = this.watchSpeech(
            this.backend.speakCancellable(cfg, text, label, {
              warn: this.warn,
              onKokoroFailure: this.onKokoroFailure,
            }),
            text,
            "barge-in TTS",
          );
          return active;
        }),
      () => active?.cancel(),
      "speech",
      "barge-in TTS",
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
    this.current?.cancelActive();
    // Also cover a backend process that predates the manager or failed before
    // handing its cancel handle back. The backend owns no concurrent speech.
    this.backend.stopSpeaking();
  }

  cancelAll(): void {
    this.cancelCurrent();
    for (const task of this.queue) task.cancelled = true;
  }

  /** Permanently skip future work while synchronously cancelling current/queued work. */
  close(): void {
    this.closed = true;
    this.cancelAll();
  }

  /** Cancel speech/cues already queued behind a probe; future work is unaffected. */
  cancelPendingAudio(): void {
    for (const task of this.queue) {
      if (task.kind === "speech" || task.kind === "cue") task.cancelled = true;
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
  private watchSpeech(active: CancellableSpeech, text: string, operation: string): CancellableSpeech {
    const abort = new AbortController();
    const done = (async () => {
      await awaitWithWatchdog(active.done, {
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
    })();
    return { done, cancel: () => abort.abort() };
  }

  private enqueue<T>(
    start: () => Promise<T>,
    cancelActive: () => void = () => {},
    kind: LaneTask<T>["kind"] = "probe",
    operation = "audio task",
  ): Enqueued<T> {
    if (this.closed) {
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
          else task.resolve(await this.audioGate(task.operation, task.start));
        } catch (error) {
          task.reject(error);
        } finally {
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
