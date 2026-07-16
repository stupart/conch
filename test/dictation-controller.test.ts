import { expect, test } from "bun:test";
import {
  DictationController,
  type CaptureContext,
  type CapturedAudio,
  type DictationCaptureBackend,
  type DictationClock,
  type DictationEvent,
  type DictationTranscriber,
  type RecorderHandle,
} from "../src/dictation-controller.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ManualRecorder implements RecorderHandle {
  readonly completion = deferred<CapturedAudio>();
  readonly finished = this.completion.promise;
  readonly stopReasons: string[] = [];
  attachedCount = 0;

  constructor(readonly context: CaptureContext) {}

  stop(reason: string): void {
    this.stopReasons.push(reason);
  }

  attached(): void {
    this.attachedCount++;
  }

  finish(rawPath: string, finalBytes = 32_000, extra: Partial<CapturedAudio> = {}): void {
    this.completion.resolve({ rawPath, finalBytes, ...extra });
  }
}

class ManualBackend implements DictationCaptureBackend {
  readonly recorders: ManualRecorder[] = [];
  readonly reads: string[] = [];

  open(context: CaptureContext): ManualRecorder {
    const recorder = new ManualRecorder(context);
    this.recorders.push(recorder);
    return recorder;
  }

  read(capture: CapturedAudio): Uint8Array {
    this.reads.push(capture.rawPath);
    return new TextEncoder().encode(capture.rawPath);
  }
}

class ManualTranscriber implements DictationTranscriber {
  readonly calls: string[] = [];
  readonly blockers = new Map<string, Deferred<void>>();

  async transcribe(_pcm: Uint8Array, context: CaptureContext & CapturedAudio) {
    this.calls.push(context.rawPath);
    const blocker = this.blockers.get(context.rawPath);
    if (blocker) await blocker.promise;
    return { text: context.rawPath, engine: "warm" as const };
  }
}

function fixture(options: {
  minimumBytes?: number;
  transcriber?: ManualTranscriber;
  deleteRaw?: (capture: CapturedAudio) => void | Promise<void>;
  clock?: DictationClock;
  onPartial?: (text: string, context: CaptureContext) => void;
} = {}) {
  const backend = new ManualBackend();
  const transcriber = options.transcriber ?? new ManualTranscriber();
  const deleted: string[] = [];
  const controller = new DictationController({
    backend,
    transcriber,
    minimumBytes: options.minimumBytes ?? 16_000,
    deleteRaw: options.deleteRaw ?? ((capture) => {
      deleted.push(capture.rawPath);
    }),
    clock: options.clock,
    onPartial: options.onPartial,
  });
  return { backend, transcriber, deleted, controller };
}

async function turns(count = 4): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

async function next(controller: DictationController): Promise<DictationEvent> {
  return controller.nextEvent();
}

test("0025/0026/0027 are all retained while 0025 transcription is blocked", async () => {
  const transcriber = new ManualTranscriber();
  const blocked = deferred<void>();
  transcriber.blockers.set("rec-0025", blocked);
  const { backend, controller } = fixture({ transcriber });

  controller.start();
  backend.recorders[0]!.finish("rec-0025", 187_426);
  await turns();
  expect(backend.recorders).toHaveLength(2);
  expect(transcriber.calls).toEqual(["rec-0025"]);
  expect(controller.finalWorkerIdle).toBe(false);

  backend.recorders[1]!.finish("rec-0026", 209_280);
  await turns();
  expect(backend.recorders).toHaveLength(3);
  expect(transcriber.calls).toEqual(["rec-0025"]);

  const barrier = controller.requestBarrier("submit");
  expect(controller.micOpen).toBe(true);
  expect(backend.recorders[2]!.stopReasons).toEqual(["submit"]);
  backend.recorders[2]!.finish("rec-0027", 96_000);
  blocked.resolve();

  const events = [await next(controller), await next(controller), await next(controller), await next(controller)];
  expect(events.map((event) => event.kind)).toEqual(["transcript", "transcript", "transcript", "barrier"]);
  expect(events.slice(0, 3).map((event) => event.kind === "transcript" && event.text)).toEqual([
    "rec-0025",
    "rec-0026",
    "rec-0027",
  ]);
  expect(transcriber.calls).toEqual(["rec-0025", "rec-0026", "rec-0027"]);
  expect(controller.micOpen).toBe(false);

  let completed = false;
  void barrier.done.then(() => {
    completed = true;
  });
  await turns();
  expect(completed).toBe(false);
  controller.acknowledge(events[3]!);
  await barrier.done;
  expect(controller.state).toBe("idle");
  expect(controller.finalWorkerIdle).toBe(true);
});

test("serial worker preserves sequence despite later captures completing during a slow transcript", async () => {
  const transcriber = new ManualTranscriber();
  const first = deferred<void>();
  transcriber.blockers.set("one", first);
  const { backend, controller } = fixture({ transcriber });

  controller.start();
  backend.recorders[0]!.finish("one");
  await turns();
  backend.recorders[1]!.finish("two");
  await turns();
  const ticket = controller.requestBarrier("ordered");
  backend.recorders[2]!.finish("three");
  await turns();
  expect(transcriber.calls).toEqual(["one"]);

  first.resolve();
  const events = [await next(controller), await next(controller), await next(controller), await next(controller)];
  expect(events.slice(0, 3).map((event) => event.kind === "transcript" && event.sequence)).toEqual([1, 2, 3]);
  controller.acknowledge(events[3]!);
  await ticket.done;
});

test("every recorder rearms before its predecessor enters the serial worker", async () => {
  const transcriber = new ManualTranscriber();
  const first = deferred<void>();
  transcriber.blockers.set("first", first);
  const { backend, controller } = fixture({ transcriber });

  controller.start();
  backend.recorders[0]!.finish("first");
  await turns();
  expect(backend.recorders[1]!.context.sequence).toBe(2);
  expect(transcriber.calls).toEqual(["first"]);

  backend.recorders[1]!.finish("second");
  await turns();
  expect(backend.recorders[2]!.context.sequence).toBe(3);
  expect(transcriber.calls).toEqual(["first"]);

  const ticket = controller.requestBarrier("done");
  backend.recorders[2]!.finish("short", 0);
  first.resolve();
  const events = [await next(controller), await next(controller), await next(controller), await next(controller)];
  expect(events.map((event) => event.kind)).toEqual(["transcript", "transcript", "short", "barrier"]);
  controller.acknowledge(events[3]!);
  await ticket.done;
});

test("barrier-first race gates rearm before stop and finalizes exactly once", async () => {
  const { backend, transcriber, controller } = fixture();
  controller.start();
  const recorder = backend.recorders[0]!;

  const ticket = controller.requestBarrier("spacebar");
  expect(recorder.stopReasons).toEqual(["spacebar"]);
  controller.acknowledge({ kind: "barrier", id: ticket.id, reason: ticket.reason });
  let completedEarly = false;
  void ticket.done.then(() => {
    completedEarly = true;
  });
  await turns();
  expect(completedEarly).toBe(false);
  recorder.finish("tail");
  recorder.finish("duplicate");

  const transcript = await next(controller);
  const barrier = await next(controller);
  expect(transcript).toMatchObject({ kind: "transcript", text: "tail", sequence: 1 });
  expect(backend.recorders).toHaveLength(1);
  expect(transcriber.calls).toEqual(["tail"]);
  controller.acknowledge(barrier);
  await ticket.done;
});

test("short captures rescue abrupt user tails but drop natural and timeout tails", async () => {
  const cases = [
    { label: "real spacebar/snooze", cause: "dictation-spacebar", expectedKind: "transcript" },
    { label: "real pause", cause: "dictation-pause", expectedKind: "transcript" },
    { label: "real mute", cause: "dictation-mute", expectedKind: "transcript" },
    { label: "mock user stop", cause: "abort", expectedKind: "transcript" },
    { label: "natural end", cause: undefined, expectedKind: "short" },
    { label: "real timeout", cause: "timeout", expectedKind: "short" },
    { label: "mock timeout", cause: "window", expectedKind: "short" },
    { label: "shutdown", cause: "shutdown", expectedKind: "short" },
  ] as const;
  for (const { label, cause, expectedKind } of cases) {
    const { backend, transcriber, controller } = fixture();
    controller.start();
    const ticket = controller.requestBarrier("test-drain");
    backend.recorders[0]!.finish(label, 8_000, cause ? { cause } : {});

    const audio = await next(controller);
    const barrier = await next(controller);
    const expectedCalls = expectedKind === "transcript" ? [label] : [];
    expect({
      label,
      kind: audio.kind,
      reads: backend.reads,
      transcriptions: transcriber.calls,
    }).toEqual({
      label,
      kind: expectedKind,
      reads: expectedCalls,
      transcriptions: expectedCalls,
    });
    expect(barrier.kind).toBe("barrier");
    controller.acknowledge(barrier);
    await ticket.done;
  }
});

test("exit-first race makes barrier stop the already-armed successor without double enqueue", async () => {
  const { backend, transcriber, controller } = fixture();
  controller.start();
  backend.recorders[0]!.finish("before");
  await turns();
  expect(backend.recorders).toHaveLength(2);

  const ticket = controller.requestBarrier("tts");
  expect(backend.recorders[1]!.stopReasons).toEqual(["tts"]);
  backend.recorders[1]!.finish("after");

  const events = [await next(controller), await next(controller), await next(controller)];
  expect(events.slice(0, 2).map((event) => event.kind === "transcript" && event.text)).toEqual(["before", "after"]);
  expect(transcriber.calls).toEqual(["before", "after"]);
  expect(backend.recorders).toHaveLength(2);
  controller.acknowledge(events[2]!);
  await ticket.done;
});

test("only captures at or above MIN are transcribed, and two barriers stop once", async () => {
  const { backend, transcriber, controller } = fixture({ minimumBytes: 100 });
  controller.start();
  backend.recorders[0]!.finish("accepted", 100);
  await turns();
  const first = controller.requestBarrier("pause");
  const second = controller.requestBarrier("mute");
  backend.recorders[1]!.finish("short", 99);

  const events = [await next(controller), await next(controller), await next(controller), await next(controller)];
  expect(events.map((event) => event.kind)).toEqual(["transcript", "short", "barrier", "barrier"]);
  expect(transcriber.calls).toEqual(["accepted"]);
  expect(backend.recorders[1]!.stopReasons).toEqual(["pause"]);
  controller.acknowledge(events[2]!);
  controller.acknowledge(events[3]!);
  await Promise.all([first.done, second.done]);
});

test("timeout is a FIFO sentinel behind all slow prior audio", async () => {
  const transcriber = new ManualTranscriber();
  const blocked = deferred<void>();
  transcriber.blockers.set("speech", blocked);
  const { backend, controller } = fixture({ transcriber });
  controller.start();
  backend.recorders[0]!.finish("speech");
  await turns();

  const timeout = controller.requestTimeout(42);
  backend.recorders[1]!.finish("quiet", 0, { cause: "window" });
  blocked.resolve();
  const events = [await next(controller), await next(controller), await next(controller), await next(controller)];
  expect(events.map((event) => event.kind)).toEqual(["transcript", "short", "timeout", "barrier"]);
  expect(events[2]).toEqual({ kind: "timeout", epoch: 42 });
  controller.acknowledge(events[3]!);
  await timeout.done;
});

test("raw deletion happens only after the serial worker has consumed the capture", async () => {
  const deleted = new Set<string>();
  let observedDuringTranscription = false;
  const backend = new ManualBackend();
  const controller = new DictationController({
    backend,
    minimumBytes: 1,
    transcriber: {
      async transcribe(_pcm, context) {
        observedDuringTranscription = deleted.has(context.rawPath);
        return { text: "kept until consumed" };
      },
    },
    deleteRaw(capture) {
      deleted.add(capture.rawPath);
    },
  });
  controller.start();
  const ticket = controller.requestBarrier("done");
  backend.recorders[0]!.finish("raw-path", 1);

  const transcript = await next(controller);
  const barrier = await next(controller);
  expect(observedDuringTranscription).toBe(false);
  expect(deleted.has("raw-path")).toBe(true);
  expect(transcript.kind).toBe("transcript");
  controller.acknowledge(barrier);
  await ticket.done;
});

test("stale partials from an exited recorder or old generation are rejected", async () => {
  const partials: string[] = [];
  const { backend, controller } = fixture({ onPartial: (text) => partials.push(text) });
  controller.start();
  const generation = controller.generation;
  expect(controller.publishPartial({ generation, sequence: 1, text: "current" })).toBe(true);

  backend.recorders[0]!.finish("one");
  await turns();
  expect(controller.publishPartial({ generation, sequence: 1, text: "stale recorder" })).toBe(false);
  expect(controller.publishPartial({ generation: generation - 1, sequence: 2, text: "stale generation" })).toBe(false);
  expect(controller.publishPartial({ generation, sequence: 2, text: "new current" })).toBe(true);
  expect(partials).toEqual(["current", "new current"]);

  const ticket = controller.requestBarrier("done");
  backend.recorders[1]!.finish("two");
  const events = [await next(controller), await next(controller), await next(controller)];
  controller.acknowledge(events[2]!);
  await ticket.done;
});

test("injected clock timeout drains the active recorder before its FIFO sentinels", async () => {
  let scheduled: (() => void) | undefined;
  let cleared = false;
  const clock: DictationClock = {
    setTimeout(callback) {
      scheduled = callback;
      return 7;
    },
    clearTimeout(handle) {
      expect(handle).toBe(7);
      cleared = true;
    },
  };
  const { backend, controller } = fixture({ clock });
  controller.start();
  controller.scheduleTimeout(1_000);
  expect(scheduled).toBeDefined();
  scheduled!();
  expect(backend.recorders[0]!.stopReasons).toEqual(["timeout"]);
  expect(cleared).toBe(false); // fired timers are not redundantly cleared

  backend.recorders[0]!.finish("idle", 0, { cause: "window" });
  const events = [await next(controller), await next(controller), await next(controller)];
  expect(events.map((event) => event.kind)).toEqual(["short", "timeout", "barrier"]);
  controller.acknowledge(events[2]!);
  expect(controller.state).toBe("idle");
});

test("adopted barge capture gets a sequence and opens its normal successor before transcription", async () => {
  const transcriber = new ManualTranscriber();
  const blocked = deferred<void>();
  transcriber.blockers.set("barge", blocked);
  const { backend, controller } = fixture({ transcriber });
  const adopted = new ManualRecorder({ sequence: -1, generation: -1 });

  controller.start(adopted);
  expect(adopted.attachedCount).toBe(1);
  expect(controller.activeSequence).toBe(1);
  expect(backend.recorders).toHaveLength(0);
  adopted.finish("barge", 5_000, { minimumBytes: 5_000 });
  await turns();
  expect(backend.recorders[0]!.context).toEqual({ sequence: 2, generation: 1 });
  expect(transcriber.calls).toEqual(["barge"]);

  const ticket = controller.requestBarrier("barge-handoff-test");
  backend.recorders[0]!.finish("successor", 0);
  blocked.resolve();
  const events = [await next(controller), await next(controller), await next(controller)];
  expect(events.map((event) => event.kind)).toEqual(["transcript", "short", "barrier"]);
  controller.acknowledge(events[2]!);
  await ticket.done;
});
