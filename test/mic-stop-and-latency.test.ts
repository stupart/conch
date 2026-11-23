import { expect, test } from "bun:test";
import { dispatchSocketTurnEvent } from "../src/control-server.ts";
import type { TurnEvent } from "../src/hook.ts";

const stop = { type: "spacebar", sessionId: "", label: "", announce: "" } as TurnEvent;

function callbacks(over: Partial<Parameters<typeof dispatchSocketTurnEvent>[1]>) {
  const calls: string[] = [];
  const base = {
    busy: () => false,
    capturing: () => false,
    stopSpacebar: () => void calls.push("stop"),
    droppedStop: () => void calls.push("dropped"),
    enqueue: () => {},
    enqueueInstant: () => {},
    enrichAudioCommand: (c: never) => c,
    setSessionPaused: () => {},
  } as unknown as Parameters<typeof dispatchSocketTurnEvent>[1];
  return { cb: { ...base, ...over }, calls };
}

/**
 * An open mic must be closable, whoever is asking.
 *
 * `busy` is the DRAIN LOOP's flag, and a lightweight targeted wake takes the
 * instant path, which never sets it. So the stop asked "is the queue working?"
 * when the only question that matters is "is the microphone open?" — and threw
 * the stop away while conch was audibly listening. Tyler pressed it six times:
 * "stop arrived with nothing running — ignored" six times in the log, which is
 * the only reason we found it rather than guessing again.
 */
test("a stop closes an open mic even when the queue is idle", () => {
  const { cb, calls } = callbacks({ busy: () => false, capturing: () => true });
  dispatchSocketTurnEvent(stop, cb);
  expect(calls).toEqual(["stop"]);
});

test("a stop still works while the queue is busy with no mic", () => {
  const { cb, calls } = callbacks({ busy: () => true, capturing: () => false });
  dispatchSocketTurnEvent(stop, cb);
  expect(calls).toEqual(["stop"]);
});

test("a stop with nothing running at all is reported, not swallowed", () => {
  const { cb, calls } = callbacks({ busy: () => false, capturing: () => false });
  dispatchSocketTurnEvent(stop, cb);
  expect(calls).toEqual(["dropped"]);
});
