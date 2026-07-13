import type { Config } from "./config.ts";

export interface CancellableSpeech {
  done: Promise<void>;
  cancel: () => void;
}

export interface ManagedSpeech extends CancellableSpeech {
  /** Resolves when this utterance owns the audio lane (it may still be starting synthesis). */
  started: Promise<void>;
}

export interface SpeechBackend {
  speakCancellable: (cfg: Config, text: string, label?: string) => CancellableSpeech;
  /** Legacy/global safety net used to stop anything the backend still owns. */
  stopSpeaking: () => void;
}

interface LaneTask<T> {
  kind: "speech" | "cue" | "probe" | "microphone";
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

/**
 * The daemon's single owner for anything that uses the speaker or microphone.
 *
 * Utterances, audible cues, readiness canaries and ordinary listen sessions all
 * use one FIFO lane. That makes `quiescent()` meaningful and, more importantly,
 * prevents a background recovery canary from starting after the daemon has
 * checked for silence and opened the regular dictation mic.
 */
export class SpeechManager {
  private readonly queue: LaneTask<unknown>[] = [];
  private current: LaneTask<unknown> | null = null;
  private pumping = false;
  private idleWaiters = new Set<() => void>();

  constructor(private readonly backend: SpeechBackend) {}

  speak(cfg: Config, text: string, label = ""): Promise<void> {
    return this.speakCancellable(cfg, text, label).done;
  }

  speakCancellable(cfg: Config, text: string, label = ""): ManagedSpeech {
    let active: CancellableSpeech | null = null;
    const managed = this.enqueue<void>(
      async () => {
        active = this.backend.speakCancellable(cfg, text, label);
        await active.done;
      },
      () => active?.cancel(),
      "speech",
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
          active = this.backend.speakCancellable(cfg, text, label);
          return active;
        }),
      () => active?.cancel(),
      "speech",
    ).done;
  }

  /** Serialize a full-body TTS readiness/capability probe with all audio and mic work. */
  runProbe<T>(probe: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController();
    return this.enqueue<T>(() => probe(abort.signal), () => abort.abort(), "probe").done;
  }

  /**
   * Run a regular microphone capture while holding the lane. New speech,
   * cues, and recovery probes cannot begin until the capture is finished.
   */
  withMicrophone<T>(listen: () => Promise<T>, cancelActive: () => void): Promise<T> {
    return this.enqueue<T>(listen, cancelActive, "microphone").done;
  }

  /** Play an afplay cue under the same ownership/cancellation rules as speech. */
  playCue(path: string): Promise<void> {
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    return this.enqueue<void>(
      async () => {
        proc = Bun.spawn(["afplay", path], { stdout: "ignore", stderr: "ignore" });
        await proc.exited;
      },
      () => proc?.kill(),
      "cue",
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

  /** Cancel speech/cues already queued behind a probe; future work is unaffected. */
  cancelPendingAudio(): void {
    for (const task of this.queue) {
      if (task.kind === "speech" || task.kind === "cue") task.cancelled = true;
    }
  }

  /** Resolve only when no queued/current speech, cue, probe, or mic lease remains. */
  async quiescent(): Promise<void> {
    while (this.current || this.queue.length || this.pumping) {
      await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    }
  }

  private enqueue<T>(
    start: () => Promise<T>,
    cancelActive: () => void = () => {},
    kind: LaneTask<T>["kind"] = "probe",
  ): Enqueued<T> {
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
          else task.resolve(await task.start());
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
