import { describe, expect, test } from "bun:test";
import {
  DictationReducer,
  classifyPermissionDecision,
  type DictationActionReadyEffect,
  type DictationReducerEffect,
  type RequestBarrierEffect,
} from "../src/dictation-reducer.ts";

const transcript = (sequence: number, text: string, diagnosticId = `rec-${sequence}`) => ({
  type: "transcript" as const,
  sequence,
  text,
  diagnosticId,
});

const barrier = (sequence: number, request: RequestBarrierEffect) => ({
  type: "barrier" as const,
  sequence,
  id: `barrier-${sequence}`,
  requestId: request.requestId,
  reason: request.reason,
});

function requested(effects: DictationReducerEffect[]): RequestBarrierEffect {
  const effect = effects.find((item): item is RequestBarrierEffect => item.type === "request-barrier");
  if (!effect) throw new Error("expected request-barrier effect");
  return effect;
}

function ready(effects: DictationReducerEffect[]): DictationActionReadyEffect {
  const effect = effects.find((item): item is DictationActionReadyEffect => item.type === "action-ready");
  if (!effect) throw new Error("expected action-ready effect");
  return effect;
}

describe("ordered dictation reducer", () => {
  test("rec-0025/0026/0027 survive and submit in recorder order", () => {
    const reducer = new DictationReducer({ holdSubmit: true });
    reducer.consume(transcript(25, "first section", "rec-0025"));
    reducer.consume(transcript(26, "the six second continuation", "rec-0026"));
    reducer.consume(transcript(27, "final section", "rec-0027"));

    const request = requested(reducer.requestExternalAction("spacebar"));
    const action = ready(reducer.consume(barrier(28, request)));

    expect(action.payload).toBe("first section the six second continuation final section");
    expect(action.payloadDiagnosticIds).toEqual(["rec-0025", "rec-0026", "rec-0027"]);
    expect(action.finalSubmittedDiagnosticIds).toEqual(["rec-0025", "rec-0026", "rec-0027"]);
  });

  test("send waits for its barrier and includes prompt-like hot tail", () => {
    const reducer = new DictationReducer({ holdSubmit: true });
    reducer.consume(transcript(1, "fix the cache", "prompt-before"));
    const request = requested(reducer.consume(transcript(2, "send it", "send-command")));
    expect(reducer.snapshot.pendingAction).toBe("send");

    reducer.consume(transcript(3, "and update the docs", "hot-tail"));
    const action = ready(reducer.consume(barrier(4, request)));

    expect(action.action).toBe("send");
    expect(action.payload).toBe("fix the cache and update the docs");
    expect(action.payloadDiagnosticIds).toEqual(["prompt-before", "hot-tail"]);
    expect(action.finalSubmittedDiagnosticIds).toEqual(["prompt-before", "send-command", "hot-tail"]);
    expect(action.retainedBuffer).toEqual([]);
  });

  test.each(["repeat", "continue"] as const)("%s retains prompt tail after its barrier", (command) => {
    const reducer = new DictationReducer({ holdSubmit: true });
    reducer.consume(transcript(1, "held before", "before"));
    const request = requested(reducer.consume(transcript(2, command, "command")));
    reducer.consume(transcript(3, "new thought", "tail"));

    const action = ready(reducer.consume(barrier(4, request)));
    expect(action.action).toBe(command);
    expect(action.payload).toBeNull();
    expect(action.retainedBuffer.map(({ text }) => text)).toEqual(["held before", "new thought"]);
    expect(action.shouldResume).toBe(true);
    expect(reducer.snapshot.buffer.map(({ text }) => text)).toEqual(["held before", "new thought"]);
  });

  test("discard removes only pre-command content and keeps a hot post-command tail", () => {
    const reducer = new DictationReducer({ holdSubmit: true });
    reducer.consume(transcript(1, "wrong approach", "before"));
    const request = requested(reducer.consume(transcript(2, "never mind", "discard-command")));
    reducer.consume(transcript(3, "use the queue instead", "after"));

    const action = ready(reducer.consume(barrier(4, request)));
    expect(action.action).toBe("discard");
    expect(action.discardedDiagnosticIds).toEqual(["before"]);
    expect(action.retainedBuffer.map(({ text }) => text)).toEqual(["use the queue instead"]);
    expect(action.shouldResume).toBe(true);
    expect(reducer.snapshot.buffer.map(({ text }) => text)).toEqual(["use the queue instead"]);
  });

  test("timeout is a FIFO action and cannot submit ahead of later queued tail", () => {
    const reducer = new DictationReducer({ holdSubmit: true });
    reducer.consume(transcript(1, "one", "one"));
    const request = requested(reducer.consume({ type: "timeout", sequence: 2, diagnosticId: "timeout" }));
    reducer.consume(transcript(3, "two", "two"));

    const action = ready(reducer.consume(barrier(4, request)));
    expect(action.action).toBe("timeout");
    expect(action.payload).toBe("one two");
    expect(action.finalSubmittedDiagnosticIds).toEqual(["one", "timeout", "two"]);
  });

  test.each(["spacebar", "pause", "mute"] as const)("external %s drains held text at its barrier", (actionName) => {
    const reducer = new DictationReducer({ holdSubmit: true });
    reducer.consume(transcript(1, "preserve me", "held"));
    const request = requested(reducer.requestExternalAction(actionName));
    reducer.consume(transcript(2, "and me", "active-tail"));

    const action = ready(reducer.consume(barrier(3, request)));
    expect(action.action).toBe(actionName);
    expect(action.payload).toBe("preserve me and me");
    expect(action.payloadDiagnosticIds).toEqual(["held", "active-tail"]);
    expect(action.shouldResume).toBe(false);
  });

  test("an unrelated correlated barrier does not release a pending action", () => {
    const reducer = new DictationReducer({ holdSubmit: true });
    reducer.consume(transcript(1, "held"));
    const request = requested(reducer.requestExternalAction("spacebar"));
    const effects = reducer.consume({
      type: "barrier",
      sequence: 2,
      id: "other",
      requestId: request.requestId + 1,
      reason: "other",
    });

    expect(effects).toEqual([{ type: "barrier-reached", barrierId: "other", reason: "other" }]);
    expect(reducer.snapshot.pendingAction).toBe("spacebar");
    const action = ready(reducer.consume({
      type: "barrier",
      sequence: 3,
      id: "ours",
      requestId: request.requestId,
      reason: request.reason,
    }));
    expect(action.payload).toBe("held");
  });

  test("non-hold prompt requests a barrier and preserves its hot continuation", () => {
    const reducer = new DictationReducer({ holdSubmit: false });
    const request = requested(reducer.consume(transcript(1, "first half", "first")));
    reducer.consume(transcript(2, "second half", "second"));

    const action = ready(reducer.consume(barrier(3, request)));
    expect(action.payload).toBe("first half second half");
    expect(action.finalSubmittedDiagnosticIds).toEqual(["first", "second"]);
  });

  test("rejects duplicate or completion-order input", () => {
    const reducer = new DictationReducer({ holdSubmit: true });
    reducer.consume(transcript(2, "later"));
    expect(() => reducer.consume(transcript(1, "earlier"))).toThrow("out of order");
    expect(() => reducer.consume(transcript(2, "duplicate"))).toThrow("out of order");
  });
});

describe("permission decision", () => {
  test("accepts repeated agreement but rejects conflict or any free text", () => {
    expect(classifyPermissionDecision(["Yes.", "go ahead"])).toBe("approve");
    expect(classifyPermissionDecision(["No.", "deny"])).toBe("deny");
    expect(classifyPermissionDecision(["Yes.", "No."])).toBeNull();
    expect(classifyPermissionDecision(["Yes.", "but use the other branch"])).toBeNull();
    expect(classifyPermissionDecision(["", "  "])).toBeNull();
  });
});
