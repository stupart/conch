import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { collectContinuousResult, createDictationSession, type DictationRuntime, type RuntimeDictationSession } from "../src/listen.ts";
import type { CapturedAudio } from "../src/dictation-controller.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeClock {
  time = 0;
  #next = 0;
  #timers = new Map<number, { at: number; callback(): void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, ms: number): number => {
    const id = ++this.#next;
    this.#timers.set(id, { at: this.time + ms, callback });
    return id;
  };
  clearTimeout = (handle: unknown): void => { this.#timers.delete(handle as number); };
  advance(ms: number): void {
    const until = this.time + ms;
    while (true) {
      const due = [...this.#timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due || due[1].at > until) break;
      this.time = due[1].at;
      this.#timers.delete(due[0]);
      due[1].callback();
    }
    this.time = until;
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function gapRuntime() {
  const clock = new FakeClock();
  const firstTranscript = deferred<void>();
  const contents = new Map<string, string>();
  const captures: Array<{ speak(text: string): void; finish(): void; stopped: string[] }> = [];
  let transcriptions = 0;
  let session!: RuntimeDictationSession;
  const runtime: DictationRuntime = {
    clock,
    armRecorder(_cfg, _tag, _pct, _minimum, _parent, _diagnostic, context, _hooks, _partial, speechStarted) {
      const end = deferred<CapturedAudio>();
      const rawPath = `synthetic-${context.sequence}`;
      const stopped: string[] = [];
      let started = false;
      captures.push({
        stopped,
        speak(text) { contents.set(rawPath, text); started = true; speechStarted(); },
        finish() { end.resolve({ rawPath, finalBytes: 32_000, finalizedAt: clock.now() }); },
      });
      return {
        finished: end.promise,
        hasSpeechStarted: () => started,
        stop(reason) {
          stopped.push(reason);
          end.resolve({ rawPath, finalBytes: started ? 6_000 : 0, finalizedAt: clock.now(), cause: reason });
        },
      };
    },
    readCapture: (capture) => new TextEncoder().encode(contents.get(capture.rawPath) ?? ""),
    async transcribe(_cfg, pcm) {
      if (++transcriptions === 1) await firstTranscript.promise;
      return { text: new TextDecoder().decode(pcm) };
    },
    discard() {},
  };
  const cfg = { ...loadConfig({ env: {}, settingsPath: "/tmp/conch-runtime-deadline-test/settings.json" }), listenWindowSecs: 0.6, holdSubmitSecs: 8 };
  const result = collectContinuousResult(cfg, {}, undefined, {
    handoff: true,
    sessionFactory: (settings, hooks, options) => session = createDictationSession(settings, hooks, options, runtime),
  });
  return { clock, firstTranscript, captures, result, session, transcriptions: () => transcriptions };
}

test("FIX8 final review: initial empty reading gap keeps its 600ms deadline", async () => {
  const audio = gapRuntime();
  await flushMicrotasks();
  audio.clock.advance(599);
  expect(audio.session.state).toBe("running");
  audio.clock.advance(1);
  const result = await audio.result;
  expect(result.text).toBe("");
  expect(result.activeSession).toBeUndefined();
  expect(audio.captures[0]!.stopped).toEqual(["timeout"]);
  expect(audio.transcriptions()).toBe(0);
  expect(audio.session.state).toBe("idle");
});

test("FIX8 final review: gap successor survives its short deadline while first STT is deferred", async () => {
  const audio = gapRuntime();
  await flushMicrotasks();
  audio.clock.advance(200);
  audio.captures[0]!.speak("first phrase");
  audio.clock.advance(100);
  audio.captures[0]!.finish();
  await flushMicrotasks();
  expect(audio.transcriptions()).toBe(1);
  expect(audio.captures).toHaveLength(2);
  audio.clock.advance(601);
  const stateBeforeTranscript = audio.session.state;
  const stoppedBeforeTranscript = [...audio.captures[1]!.stopped];
  // A continuation starts after the old gap deadline; its speech cancels the
  // replacement hold deadline even while the first result is still pending.
  if (audio.session.state === "running") audio.captures[1]!.speak("trailing words");
  audio.clock.advance(8_000);
  audio.firstTranscript.resolve();
  const result = await audio.result;
  const tail: string[] = [];
  if (result.activeSession) {
    const ticket = audio.session.requestBarrier("dictation-spacebar");
    while (true) {
      const event = await audio.session.nextEvent();
      if (event.kind === "transcript") tail.push(event.text);
      if (event.kind === "barrier") {
        audio.session.acknowledge(event);
        if (event.id === ticket.id) break;
      }
    }
    await ticket.done;
  }
  expect(stateBeforeTranscript).toBe("running");
  expect(stoppedBeforeTranscript).toEqual([]);
  expect(result.activeSession).toBe(audio.session);
  expect(result.text).toBe("first phrase");
  expect(tail).toEqual(["trailing words"]);
  expect(audio.session.state).toBe("idle");
});

test("FIX8 final review: quiet successor still expires at the finite hold deadline during STT", async () => {
  const audio = gapRuntime();
  await flushMicrotasks();
  audio.clock.advance(200);
  audio.captures[0]!.speak("first phrase");
  audio.clock.advance(100);
  audio.captures[0]!.finish();
  await flushMicrotasks();
  audio.clock.advance(7_999);
  const beforeHoldDeadline = audio.session.state;
  audio.clock.advance(1);
  const atHoldDeadline = audio.session.state;
  audio.firstTranscript.resolve();
  const result = await audio.result;
  expect(beforeHoldDeadline).toBe("running");
  expect(atHoldDeadline).toBe("draining");
  expect(audio.captures[1]!.stopped).toEqual(["timeout"]);
  expect(result.text).toBe("first phrase");
  expect(audio.session.state).toBe("idle");
});

test("FIX8 final review: later dictation timing survives subsequent speech starts", async () => {
  const audio = gapRuntime();
  await flushMicrotasks();
  audio.captures[0]!.speak("first phrase");
  audio.clock.advance(300);
  audio.captures[0]!.finish();
  await flushMicrotasks();
  audio.firstTranscript.resolve();
  await audio.result;
  audio.session.setIdleWindowSecs(12);
  audio.captures[1]!.speak("next phrase");
  audio.clock.advance(100);
  audio.captures[1]!.finish();
  await flushMicrotasks();
  audio.clock.advance(8_001);
  const stateAfterOriginalHoldWindow = audio.session.state;
  const ticket = audio.session.requestBarrier("test-cleanup");
  while (true) {
    const event = await audio.session.nextEvent();
    if (event.kind === "barrier") {
      audio.session.acknowledge(event);
      if (event.id === ticket.id) break;
    }
  }
  await ticket.done;
  expect(stateAfterOriginalHoldWindow).toBe("running");
  expect(audio.session.state).toBe("idle");
});
