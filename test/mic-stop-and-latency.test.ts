import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchSocketTurnEvent } from "../src/daemon.ts";
import type { TurnEvent } from "../src/hook.ts";

const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");

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

test("the physical key asks the same question as the socket", () => {
  // Both paths decide whether space stops or opens. They must not disagree:
  // when they did, space fell through and opened a SECOND wake on a live mic.
  expect(daemon).toContain('if (busy || normalMicOpen()) stopReciting("spacebar");');
  expect(daemon).toContain("capturing: () => normalMicOpen(),");
});

/**
 * Nothing that reads the transcript may sit in front of the microphone.
 *
 * The manual-reply baseline calls `countUserPrompts`, which on a cold cache
 * reads the whole file — 3.8s measured on a 189MB session. The log shows the
 * outside view: click at 23:18:44, `listening` at 23:18:56. Twelve seconds.
 * The reader is incremental for appends, so only the first scan is expensive;
 * the bug was that the first scan sat between arming the recorder and saying
 * anything about it. It is needed to build the manual-reply guard, which
 * happens after listening starts, so that is where it is awaited.
 */
test("the transcript baseline is not awaited before the mic opens", () => {
  const loop = daemon.slice(daemon.indexOf("async function conversationLoop"));
  const beforeListening = loop.slice(0, loop.indexOf('log(`listening → '));

  // Started before the mic, so the scan overlaps the open instead of blocking it...
  expect(beforeListening).toContain("const manualReplyBaseline:");
  // ...but never awaited there.
  expect(beforeListening).not.toContain("await manualReplyListenBaseline(");
  expect(beforeListening).not.toContain("await manualReplyBaseline");

  // ...and it IS awaited where the guard that needs it is built.
  const afterListening = loop.slice(loop.indexOf('log(`listening → '));
  const guard = afterListening.indexOf("createManualReplyListenGuard(");
  expect(guard).toBeGreaterThan(-1);
  expect(afterListening.slice(0, guard)).toContain("manualReplyEvent = await manualReplyBaseline;");

  // A failure must degrade, not become an unhandled rejection while it waits.
  expect(beforeListening).toContain("transcript baseline failed");
});
