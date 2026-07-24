import { describe, expect, test } from "bun:test";
import {
  DictationController,
  type CapturedAudio,
  type CaptureContext,
  type DictationCaptureBackend,
  type DictationEvent,
  type RecorderHandle,
} from "../src/dictation-controller.ts";
import {
  DictationReducer,
  classifyPermissionDecision,
  type DictationActionReadyEffect,
  type DictationReducerEffect,
  type ExternalDictationAction,
  type RequestBarrierEffect,
} from "../src/dictation-reducer.ts";
import { withNormalMicClosed } from "../src/audio-gate.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeRecorder implements RecorderHandle {
  readonly result = deferred<CapturedAudio>();
  readonly finished = this.result.promise;
  readonly stopReasons: string[] = [];

  constructor(readonly context: CaptureContext) {}

  stop(reason: string): void {
    this.stopReasons.push(reason);
  }

  finish(text: string, finalBytes = 32_000, diagnosticId = `diag-${text}`): void {
    const cause = this.stopReasons[0];
    this.result.resolve({
      rawPath: text,
      finalBytes,
      ...(diagnosticId ? { diagnosticId } : {}),
      ...(cause ? { cause } : {}),
    });
  }
}

class FakeBackend implements DictationCaptureBackend {
  readonly recorders: FakeRecorder[] = [];

  open(context: CaptureContext): RecorderHandle {
    const recorder = new FakeRecorder(context);
    this.recorders.push(recorder);
    return recorder;
  }

  read(capture: CapturedAudio): Uint8Array {
    return new TextEncoder().encode(capture.rawPath);
  }
}

function flow(initialCapture?: FakeRecorder) {
  const backend = new FakeBackend();
  const deleted: string[] = [];
  const transcribed: string[] = [];
  const controller = new DictationController({
    backend,
    minimumBytes: 16_000,
    transcriber: {
      async transcribe(pcm) {
        const text = new TextDecoder().decode(pcm);
        transcribed.push(text);
        return { text, engine: "warm" };
      },
    },
    deleteRaw(capture) {
      deleted.push(capture.rawPath);
    },
  });
  controller.start(initialCapture);
  return { backend, controller, deleted, transcribed };
}

function requestEffect(effects: DictationReducerEffect[]): RequestBarrierEffect {
  const effect = effects.find((candidate): candidate is RequestBarrierEffect => candidate.type === "request-barrier");
  if (!effect) throw new Error("expected request-barrier effect");
  return effect;
}

function readyEffect(effects: DictationReducerEffect[]): DictationActionReadyEffect {
  const effect = effects.find((candidate): candidate is DictationActionReadyEffect => candidate.type === "action-ready");
  if (!effect) throw new Error("expected action-ready effect");
  return effect;
}

function consumeTranscript(reducer: DictationReducer, event: DictationEvent, sequence: number): DictationReducerEffect[] {
  if (event.kind !== "transcript") throw new Error(`expected transcript, got ${event.kind}`);
  return reducer.consume({
    type: "transcript",
    sequence,
    text: event.text,
    ...(event.diagnosticId ? { diagnosticId: event.diagnosticId } : {}),
  });
}

function consumeBarrier(
  reducer: DictationReducer,
  event: DictationEvent,
  sequence: number,
  request: RequestBarrierEffect,
): DictationActionReadyEffect {
  if (event.kind !== "barrier") throw new Error(`expected barrier, got ${event.kind}`);
  return readyEffect(reducer.consume({
    type: "barrier",
    sequence,
    id: String(event.id),
    requestId: request.requestId,
    reason: event.reason,
  }));
}

async function turns(count = 4): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve();
}

describe("controller/reducer integration contracts", () => {
  test("no cue or injection is authorized before the active tail and reducer barrier drain", async () => {
    const { backend, controller } = flow();
    const reducer = new DictationReducer({ holdSubmit: true });
    backend.recorders[0]!.finish("first half");
    const first = await controller.nextEvent();
    consumeTranscript(reducer, first, 1);

    const request = requestEffect(reducer.requestExternalAction("spacebar"));
    const ticket = controller.requestBarrier(request.reason);
    expect(backend.recorders[1]!.stopReasons).toEqual([request.reason]);
    await expect(withNormalMicClosed(() => controller.micOpen, "sent cue", async () => {})).rejects.toThrow(
      "audio gate violation",
    );

    backend.recorders[1]!.finish("hot tail", 8_000);
    const tail = await controller.nextEvent();
    expect(tail).toMatchObject({ kind: "transcript", cause: request.reason });
    consumeTranscript(reducer, tail, 2);
    const barrier = await controller.nextEvent();
    const action = consumeBarrier(reducer, barrier, 3, request);
    controller.acknowledge(barrier);
    await ticket.done;

    const outputs: string[] = [];
    await withNormalMicClosed(() => controller.micOpen, "sent cue", async () => outputs.push("cue"));
    outputs.push(`inject:${action.payload}`);
    expect(outputs).toEqual(["cue", "inject:first half hot tail"]);
  });

  for (const external of ["pause", "mute"] as const) {
    test(`${external} drains captured text before its acknowledgement can play`, async () => {
      const { backend, controller } = flow();
      const reducer = new DictationReducer({ holdSubmit: true });
      const request = requestEffect(reducer.requestExternalAction(external));
      const ticket = controller.requestBarrier(request.reason);
      backend.recorders[0]!.finish(`${external} tail`);

      const transcript = await controller.nextEvent();
      consumeTranscript(reducer, transcript, 1);
      const barrier = await controller.nextEvent();
      const action = consumeBarrier(reducer, barrier, 2, request);
      controller.acknowledge(barrier);
      await ticket.done;

      expect(action.action).toBe(external);
      expect(action.payload).toBe(`${external} tail`);
      expect(controller.micOpen).toBe(false);
      await withNormalMicClosed(() => controller.micOpen, `${external} acknowledgement`, async () => {});
    });
  }

  test("a spacebar arriving with an adopted barge drains that capture without opening a successor", async () => {
    const initial = new FakeRecorder({ sequence: 0, generation: 0 });
    const { backend, controller } = flow(initial);
    const reducer = new DictationReducer({ holdSubmit: true });
    const request = requestEffect(reducer.requestExternalAction("spacebar"));
    const ticket = controller.requestBarrier(request.reason);
    expect(initial.stopReasons).toEqual([request.reason]);
    initial.finish("barge tail", 20_000, "rec-barge");

    const transcript = await controller.nextEvent();
    consumeTranscript(reducer, transcript, 1);
    const barrier = await controller.nextEvent();
    const action = consumeBarrier(reducer, barrier, 2, request);
    controller.acknowledge(barrier);
    await ticket.done;

    expect(action.payload).toBe("barge tail");
    expect(backend.recorders).toHaveLength(0);
  });

  test("a manual-reply abort discards even a transcribable active tail", async () => {
    const { backend, controller, transcribed } = flow();
    const ticket = controller.requestBarrier("manual-reply");
    expect(backend.recorders[0]!.stopReasons).toEqual(["manual-reply"]);
    backend.recorders[0]!.finish("voice that must not be submitted", 32_000, "manual-tail");

    const discarded = await controller.nextEvent();
    expect(discarded).toMatchObject({
      kind: "short",
      cause: "manual-reply",
      finalBytes: 32_000,
      diagnosticId: "manual-tail",
    });
    expect(transcribed).toEqual([]);

    const barrier = await controller.nextEvent();
    expect(barrier).toMatchObject({ kind: "barrier", reason: "manual-reply" });
    controller.acknowledge(barrier);
    await ticket.done;
    expect(controller.micOpen).toBe(false);
  });

  test("a non-hold seeded fragment starts a generation before requesting its send barrier", async () => {
    const { backend, controller } = flow();
    const reducer = new DictationReducer({ holdSubmit: false });
    const request = requestEffect(reducer.consume({
      type: "transcript",
      sequence: 1,
      text: "seed words",
      diagnosticId: "seed-and-tail",
    }));
    const ticket = controller.requestBarrier(request.reason);
    expect(backend.recorders[0]!.stopReasons).toEqual([request.reason]);
    backend.recorders[0]!.finish("", 0, "");

    const short = await controller.nextEvent();
    expect(short.kind).toBe("short");
    const barrier = await controller.nextEvent();
    const action = consumeBarrier(reducer, barrier, 2, request);
    controller.acknowledge(barrier);
    await ticket.done;
    expect(action.payload).toBe("seed words");
  });

  test("permission is classified and injected only after its active recorder is drained", async () => {
    const { backend, controller } = flow();
    backend.recorders[0]!.finish("yes");
    await turns();
    const ticket = controller.requestBarrier("permission-decision");
    backend.recorders[1]!.finish("", 0, "");

    const texts: string[] = [];
    let reachedBarrier = false;
    while (!reachedBarrier) {
      const event = await controller.nextEvent();
      if (event.kind === "transcript") texts.push(event.text);
      if (event.kind === "barrier") {
        reachedBarrier = true;
        controller.acknowledge(event);
      }
    }
    await ticket.done;
    expect(classifyPermissionDecision(texts)).toBe("approve");
    expect(controller.micOpen).toBe(false);
  });

  test("diagnostic contributors remain in recorder order through command and hot tail", async () => {
    const { backend, controller, deleted } = flow();
    const reducer = new DictationReducer({ holdSubmit: true });
    backend.recorders[0]!.finish("alpha", 32_000, "rec-0025");
    consumeTranscript(reducer, await controller.nextEvent(), 1);

    backend.recorders[1]!.finish("send it", 32_000, "rec-0026");
    const command = await controller.nextEvent();
    const request = requestEffect(consumeTranscript(reducer, command, 2));
    const ticket = controller.requestBarrier(request.reason);
    backend.recorders[2]!.finish("omega", 32_000, "rec-0027");
    consumeTranscript(reducer, await controller.nextEvent(), 3);
    const barrier = await controller.nextEvent();
    const action = consumeBarrier(reducer, barrier, 4, request);
    controller.acknowledge(barrier);
    await ticket.done;

    expect(action.payload).toBe("alpha omega");
    expect(action.finalSubmittedDiagnosticIds).toEqual(["rec-0025", "rec-0026", "rec-0027"]);
    expect(deleted).toEqual(["alpha", "send it", "omega"]);
  });

  test("an external action arriving behind an existing command remains a distinct FIFO stop", () => {
    const reducer = new DictationReducer({ holdSubmit: true });
    reducer.consume({ type: "transcript", sequence: 1, text: "held" });
    const repeat = requestEffect(reducer.consume({ type: "transcript", sequence: 2, text: "repeat" }));
    expect(reducer.requestExternalAction("pause")).toEqual([]);
    const action = consumeBarrier(
      reducer,
      { kind: "barrier", id: 1, reason: repeat.reason } as DictationEvent,
      3,
      repeat,
    );
    expect(action.action).toBe("repeat");
    expect(action.shouldResume).toBe(true);
    expect(requestEffect(reducer.requestExternalAction("pause")).action).toBe("pause");
  });
});
