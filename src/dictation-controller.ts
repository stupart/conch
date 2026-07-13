/**
 * Continuous dictation capture with one serial, ordered transcription worker.
 *
 * The capture backend is deliberately synchronous at its `open`/`stop` edges:
 * that lets the controller close its re-arm gate before a barrier can yield and
 * lets a completed recorder arm its successor before transcription begins.
 */

export type DictationControllerState = "closed" | "running" | "draining" | "idle";

export interface CaptureContext {
  sequence: number;
  generation: number;
}

export interface CapturedAudio {
  rawPath: string;
  finalBytes: number;
  /** Optional per-capture eligibility override (for example the 5KB barge floor). */
  minimumBytes?: number;
  diagnosticId?: string;
  /** Capture-side disposition; the backend retains its more precise vocabulary. */
  cause?: string;
  error?: string;
}

export interface RecorderHandle {
  /** Resolves only after the recorder has exited and its output has flushed. */
  finished: Promise<CapturedAudio>;
  /** Must synchronously initiate stop; completion is reported by `finished`. */
  stop(reason: string): void;
}

export interface DictationCaptureBackend {
  /** Open a recorder synchronously. */
  open(context: CaptureContext): RecorderHandle;
  /** Read a finalized recorder. This is called only by the serial worker. */
  read(capture: CapturedAudio): Uint8Array | Promise<Uint8Array>;
}

export interface DictationTranscript {
  text: string;
  error?: string;
  engine?: "warm" | "cold";
}

export interface DictationTranscriber {
  transcribe(pcm: Uint8Array, context: CaptureContext & CapturedAudio): Promise<DictationTranscript>;
}

export interface DictationClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DictationControllerOptions {
  backend: DictationCaptureBackend;
  transcriber: DictationTranscriber;
  /** The capture is eligible for final transcription at or above this size. */
  minimumBytes: number;
  /** Runtime chooses unlink (normal mode) or no-op (retained diagnostics). */
  deleteRaw: (capture: CapturedAudio) => void | Promise<void>;
  clock?: DictationClock;
  onPartial?: (text: string, context: CaptureContext) => void;
}

interface EventBase extends CaptureContext {
  diagnosticId?: string;
}

export interface TranscriptEvent extends EventBase {
  kind: "transcript";
  rawPath: string;
  finalBytes: number;
  cause?: string;
  text: string;
  engine?: "warm" | "cold";
}

export interface ShortEvent extends EventBase {
  kind: "short";
  rawPath: string;
  finalBytes: number;
  cause?: string;
}

export interface ErrorEvent extends Partial<EventBase> {
  kind: "error";
  stage: "open" | "capture" | "read" | "transcribe" | "delete";
  error: string;
  rawPath?: string;
  finalBytes?: number;
}

export interface TimeoutEvent {
  kind: "timeout";
  epoch: number;
}

export interface BarrierEvent {
  kind: "barrier";
  id: number;
  reason: string;
}

export type DictationEvent = TranscriptEvent | ShortEvent | ErrorEvent | TimeoutEvent | BarrierEvent;

export interface BarrierTicket {
  id: number;
  reason: string;
  /** Resolves only after the reducer acknowledges the matching barrier event. */
  done: Promise<void>;
}

interface RecorderSlot extends CaptureContext {
  handle: RecorderHandle;
  finalized?: Promise<void>;
  stopRequested: boolean;
}

type WorkItem =
  | { kind: "audio"; slot: CaptureContext; capture: CapturedAudio }
  | { kind: "error"; event: ErrorEvent }
  | { kind: "timeout"; epoch: number }
  | { kind: "barrier"; id: number; reason: string };

interface BarrierCompletion {
  resolve: () => void;
  emitted: boolean;
  acknowledged: boolean;
}

const systemClock: DictationClock = {
  setTimeout(callback, ms) {
    return setTimeout(callback, ms);
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class DictationController {
  private readonly backend: DictationCaptureBackend;
  private readonly transcriber: DictationTranscriber;
  private readonly minimumBytes: number;
  private readonly deleteRaw: (capture: CapturedAudio) => void | Promise<void>;
  private readonly clock: DictationClock;
  private readonly onPartial?: (text: string, context: CaptureContext) => void;

  private currentState: DictationControllerState = "closed";
  private currentGeneration = 0;
  private nextSequence = 0;
  private acceptingRearm = false;
  private active: RecorderSlot | null = null;
  private drain: Promise<void> | null = null;
  private permanentlyClosed = false;

  private work: WorkItem[] = [];
  private workerRunning = false;
  private events: DictationEvent[] = [];
  private eventWaiters: Array<(event: DictationEvent) => void> = [];

  private nextBarrierId = 0;
  private barrierCompletions = new Map<number, BarrierCompletion>();
  private pendingBarrierAcks = 0;
  private timeoutHandle: unknown;

  constructor(options: DictationControllerOptions) {
    if (!Number.isFinite(options.minimumBytes) || options.minimumBytes < 0) {
      throw new Error("minimumBytes must be a non-negative finite number");
    }
    this.backend = options.backend;
    this.transcriber = options.transcriber;
    this.minimumBytes = options.minimumBytes;
    this.deleteRaw = options.deleteRaw;
    this.clock = options.clock ?? systemClock;
    this.onPartial = options.onPartial;
  }

  get state(): DictationControllerState {
    return this.currentState;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get activeSequence(): number | null {
    return this.active?.sequence ?? null;
  }

  get micOpen(): boolean {
    return this.active !== null;
  }

  /** Start a new generation, optionally adopting an already-open barge capture. */
  start(initialCapture?: RecorderHandle): void {
    if (this.permanentlyClosed) throw new Error("dictation controller is shut down");
    if (this.currentState === "running" || this.currentState === "draining") {
      throw new Error(`cannot start while controller is ${this.currentState}`);
    }
    if (this.pendingBarrierAcks) throw new Error("cannot start before the pending barrier is acknowledged");

    this.cancelTimeout();
    this.currentGeneration++;
    this.acceptingRearm = true;
    this.currentState = "running";
    if (initialCapture) this.attach(initialCapture);
    else this.armSuccessor();
  }

  resume(initialCapture?: RecorderHandle): void {
    this.start(initialCapture);
  }

  /**
   * Gate rearming synchronously, then stop and drain the active recorder.
   * The returned ticket completes at the reducer-level barrier acknowledgement.
   */
  requestBarrier(reason: string): BarrierTicket {
    return this.beginDrain(reason, false, this.currentGeneration);
  }

  /** Drain current capture, then place timeout and barrier sentinels in FIFO order. */
  requestTimeout(epoch = this.currentGeneration): BarrierTicket {
    return this.beginDrain("timeout", true, epoch);
  }

  /** Schedule an idle timeout for this generation using the injected clock. */
  scheduleTimeout(ms: number): void {
    this.cancelTimeout();
    const epoch = this.currentGeneration;
    this.timeoutHandle = this.clock.setTimeout(() => {
      this.timeoutHandle = undefined;
      if (this.currentState === "running" && this.currentGeneration === epoch) {
        this.requestTimeout(epoch);
      }
    }, ms);
  }

  cancelTimeout(): void {
    if (this.timeoutHandle === undefined) return;
    this.clock.clearTimeout(this.timeoutHandle);
    this.timeoutHandle = undefined;
  }

  /** A final partial is accepted only while its exact recorder remains active. */
  publishPartial(partial: CaptureContext & { text: string }): boolean {
    if (
      !partial.text ||
      this.currentState !== "running" ||
      !this.acceptingRearm ||
      partial.generation !== this.currentGeneration ||
      partial.sequence !== this.active?.sequence
    ) {
      return false;
    }
    this.onPartial?.(partial.text, { sequence: partial.sequence, generation: partial.generation });
    return true;
  }

  /** Events are delivered in capture/work FIFO order. Consume them serially. */
  nextEvent(): Promise<DictationEvent> {
    const event = this.events.shift();
    if (event) return Promise.resolve(event);
    return new Promise((resolve) => this.eventWaiters.push(resolve));
  }

  /** Barrier tickets complete only after the reducer has applied the event. */
  acknowledge(event: DictationEvent): void {
    if (event.kind !== "barrier") return;
    const completion = this.barrierCompletions.get(event.id);
    // A fabricated/early acknowledgement must never let audio output cross a
    // barrier that the ordered worker has not actually reached.
    if (!completion || !completion.emitted || completion.acknowledged) return;
    completion.acknowledged = true;
    this.barrierCompletions.delete(event.id);
    this.pendingBarrierAcks--;
    if (!this.pendingBarrierAcks && this.currentState === "draining") {
      this.currentState = this.permanentlyClosed ? "closed" : "idle";
    }
    completion.resolve();
  }

  shutdown(): BarrierTicket {
    this.permanentlyClosed = true;
    return this.beginDrain("shutdown", false, this.currentGeneration);
  }

  private beginDrain(reason: string, includeTimeout: boolean, epoch: number): BarrierTicket {
    // Highest-risk ordering rule: no await or promise callback precedes this gate.
    this.acceptingRearm = false;
    this.cancelTimeout();
    if (this.currentState === "running") this.currentState = "draining";

    const id = ++this.nextBarrierId;
    let resolve!: () => void;
    const done = new Promise<void>((doneResolve) => {
      resolve = doneResolve;
    });
    this.barrierCompletions.set(id, { resolve, emitted: false, acknowledged: false });
    this.pendingBarrierAcks++;

    const active = this.active;
    if (active && !active.stopRequested) {
      active.stopRequested = true;
      try {
        active.handle.stop(reason);
      } catch (error) {
        this.enqueue({
          kind: "error",
          event: this.errorEvent("capture", error, active),
        });
      }
    }

    const drain = active ? this.finalize(active) : this.drain ?? Promise.resolve();
    this.drain = drain;
    void drain.finally(() => {
      if (includeTimeout) this.enqueue({ kind: "timeout", epoch });
      this.enqueue({ kind: "barrier", id, reason });
      if (this.drain === drain) this.drain = null;
    });

    return { id, reason, done };
  }

  private armSuccessor(): void {
    if (!this.acceptingRearm || this.currentState !== "running") return;
    const context = this.allocateContext();
    try {
      this.attach(this.backend.open(context), context);
    } catch (error) {
      this.acceptingRearm = false;
      this.currentState = "idle";
      this.enqueue({ kind: "error", event: this.errorEvent("open", error, context) });
    }
  }

  private attach(handle: RecorderHandle, supplied?: CaptureContext): void {
    const context = supplied ?? this.allocateContext();
    const slot: RecorderSlot = { ...context, handle, stopRequested: false };
    this.active = slot;
    // Register the single finalization owner immediately. Barrier/natural paths
    // both retrieve this same promise and therefore cannot enqueue twice.
    void this.finalize(slot);
  }

  private allocateContext(): CaptureContext {
    return { sequence: ++this.nextSequence, generation: this.currentGeneration };
  }

  private finalize(slot: RecorderSlot): Promise<void> {
    if (slot.finalized) return slot.finalized;
    slot.finalized = slot.handle.finished.then(
      (capture) => this.captureFinished(slot, capture),
      (error) => this.captureFailed(slot, error),
    );
    return slot.finalized;
  }

  private captureFinished(slot: RecorderSlot, capture: CapturedAudio): void {
    if (this.active === slot) this.active = null;

    let openError: unknown;
    if (this.acceptingRearm && this.currentState === "running" && slot.generation === this.currentGeneration) {
      try {
        // Do this before queueing current audio: transcription latency can never
        // become a capture gap, even if the worker begins immediately.
        const context = this.allocateContext();
        this.attach(this.backend.open(context), context);
      } catch (error) {
        this.acceptingRearm = false;
        this.currentState = "idle";
        openError = error;
      }
    }

    this.enqueue({ kind: "audio", slot, capture });
    if (openError !== undefined) {
      this.enqueue({ kind: "error", event: this.errorEvent("open", openError) });
    }
  }

  private captureFailed(slot: RecorderSlot, error: unknown): void {
    if (this.active === slot) this.active = null;
    if (this.acceptingRearm && this.currentState === "running" && slot.generation === this.currentGeneration) {
      this.armSuccessor();
    }
    this.enqueue({ kind: "error", event: this.errorEvent("capture", error, slot) });
  }

  private enqueue(item: WorkItem): void {
    this.work.push(item);
    void this.pumpWorker();
  }

  private async pumpWorker(): Promise<void> {
    if (this.workerRunning) return;
    this.workerRunning = true;
    try {
      while (this.work.length) {
        const item = this.work.shift()!;
        switch (item.kind) {
          case "audio":
            await this.processAudio(item.slot, item.capture);
            break;
          case "error":
            this.emitEvent(item.event);
            break;
          case "timeout":
            this.emitEvent({ kind: "timeout", epoch: item.epoch });
            break;
          case "barrier":
            this.barrierCompletions.get(item.id)!.emitted = true;
            this.emitEvent({ kind: "barrier", id: item.id, reason: item.reason });
            break;
        }
      }
    } finally {
      this.workerRunning = false;
      // An enqueue can land after the loop condition but before the finally.
      if (this.work.length) void this.pumpWorker();
    }
  }

  private async processAudio(context: CaptureContext, capture: CapturedAudio): Promise<void> {
    let result: DictationEvent;
    let deleteError: unknown;
    if (capture.error) {
      result = this.errorEvent("capture", capture.error, context, capture);
    } else if (capture.finalBytes < (capture.minimumBytes ?? this.minimumBytes)) {
      result = {
        kind: "short",
        ...context,
        diagnosticId: capture.diagnosticId,
        rawPath: capture.rawPath,
        finalBytes: capture.finalBytes,
        cause: capture.cause,
      };
    } else {
      try {
        const pcm = await this.backend.read(capture);
        try {
          const transcript = await this.transcriber.transcribe(pcm, { ...context, ...capture });
          result = transcript.error
            ? this.errorEvent("transcribe", transcript.error, context, capture)
            : {
                kind: "transcript",
                ...context,
                diagnosticId: capture.diagnosticId,
                rawPath: capture.rawPath,
                finalBytes: capture.finalBytes,
                cause: capture.cause,
                text: transcript.text,
                engine: transcript.engine,
              };
        } catch (error) {
          result = this.errorEvent("transcribe", error, context, capture);
        }
      } catch (error) {
        result = this.errorEvent("read", error, context, capture);
      }
    }

    try {
      await this.deleteRaw(capture);
    } catch (error) {
      deleteError = error;
    }
    this.emitEvent(result);
    if (deleteError !== undefined) {
      this.emitEvent(this.errorEvent("delete", deleteError, context, capture));
    }
  }

  private emitEvent(event: DictationEvent): void {
    const waiter = this.eventWaiters.shift();
    if (waiter) waiter(event);
    else this.events.push(event);
  }

  private errorEvent(
    stage: ErrorEvent["stage"],
    error: unknown,
    context?: Partial<CaptureContext>,
    capture?: Partial<CapturedAudio>,
  ): ErrorEvent {
    return {
      kind: "error",
      stage,
      error: error instanceof Error ? error.message : String(error),
      ...context,
      diagnosticId: capture?.diagnosticId,
      rawPath: capture?.rawPath,
      finalBytes: capture?.finalBytes,
    };
  }
}
