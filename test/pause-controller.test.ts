import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import type { DictationControllerState, DictationEvent } from "../src/dictation-controller.ts";
import type { TurnEvent } from "../src/hook.ts";
import {
  PauseController,
  SilentPauseCoordinator,
  SettingsPauseLifecycle,
  type PauseControllerOptions,
  type PauseSession,
} from "../src/pause-controller.ts";
import { SpeechManager } from "../src/speech-manager.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function turn(overrides: Partial<TurnEvent> = {}): TurnEvent {
  return {
    type: "turn-end",
    sessionId: "session-a",
    label: "alpha",
    announce: "alpha: finished response",
    transcriptPath: "/tmp/alpha.jsonl",
    mark: 4,
    eventAt: 1_000,
    ...overrides,
  };
}

interface HarnessOptions {
  initialPaused?: boolean;
  currentTurn?: TurnEvent | null | (() => TurnEvent | null);
  currentTurnGeneration?: number | null | (() => number | null);
  activeSession?: PauseSession | null;
  cancelCurrentSpeech?: () => void;
  cancelPendingAudio?: () => void;
  liveSessionIds?: PauseControllerOptions["liveSessionIds"];
  userRespondedSince?: PauseControllerOptions["userRespondedSince"];
}

function harness(options: HarnessOptions = {}) {
  const pending = new Map<string, TurnEvent>();
  const enqueued: TurnEvent[] = [];
  const spoken: string[] = [];
  const persisted: boolean[] = [];
  const modeStates: boolean[] = [];
  const logs: string[] = [];
  const held: TurnEvent[] = [];
  const errors: unknown[] = [];
  let cancelCurrentCalls = 0;
  let cancelPendingCalls = 0;

  const controller = new PauseController({
    initialPaused: options.initialPaused ?? false,
    pending,
    currentTurn: () => typeof options.currentTurn === "function"
      ? options.currentTurn()
      : options.currentTurn ?? null,
    currentTurnGeneration: options.currentTurnGeneration === undefined
      ? undefined
      : () => typeof options.currentTurnGeneration === "function"
        ? options.currentTurnGeneration()
        : options.currentTurnGeneration ?? null,
    activeSession: () => options.activeSession ?? null,
    cancelCurrentSpeech() {
      cancelCurrentCalls++;
      options.cancelCurrentSpeech?.();
    },
    cancelPendingAudio() {
      cancelPendingCalls++;
      options.cancelPendingAudio?.();
    },
    persist(paused) {
      persisted.push(paused);
    },
    render() {},
    setModeState(paused) {
      modeStates.push(paused);
    },
    log(message) {
      logs.push(message);
    },
    async speak(text) {
      spoken.push(text);
    },
    liveSessionIds: options.liveSessionIds ?? (async () => null),
    userRespondedSince: options.userRespondedSince ?? (async () => false),
    enqueue(event) {
      enqueued.push(event);
    },
    onHold(event) {
      held.push(event);
    },
    onInterruptError(error) {
      errors.push(error);
    },
  });

  return {
    controller,
    pending,
    enqueued,
    spoken,
    persisted,
    modeStates,
    logs,
    held,
    errors,
    get cancelCurrentCalls() {
      return cancelCurrentCalls;
    },
    get cancelPendingCalls() {
      return cancelPendingCalls;
    },
  };
}

describe("PauseController", () => {
  test("drop-and-hold cancels active reading speech synchronously", async () => {
    const original = turn();
    const started = deferred<void>();
    let playbackCancels = 0;
    const speech = new SpeechManager({
      speakCancellable() {
        started.resolve();
        return {
          done: new Promise<void>(() => {}),
          cancel() {
            playbackCancels++;
          },
        };
      },
      stopSpeaking() {},
    }, async (_operation, task) => task());
    const speaking = speech.speak(
      loadConfig({
        env: {},
        settingsPath: `/tmp/conch-pause-controller-test-${process.pid}/settings.json`,
      }),
      "the unfinished second half of this sentence must never play",
    );
    await started.promise;
    const h = harness({
      currentTurn: original,
      cancelCurrentSpeech: () => speech.cancelCurrent(),
      cancelPendingAudio: () => speech.cancelPendingAudio(),
    });
    const generation = h.controller.capture();

    expect(h.controller.beginPause()).toBeTrue();

    expect(playbackCancels).toBe(1);
    expect(h.cancelCurrentCalls).toBe(1);
    expect(h.cancelPendingCalls).toBe(1);
    expect(h.controller.paused).toBeTrue();
    expect(h.controller.interrupted(generation)).toBeTrue();
    expect(h.pending.get(original.sessionId)).toBe(original);
    await speaking;
    await speech.quiescent();
  });

  test("drop-and-hold synchronously aborts an active session so its in-flight capture cannot inject", async () => {
    const original = turn();
    const abortDone = deferred<void>();
    const transcription = deferred<string>();
    const injected: string[] = [];
    let aborted = false;
    let abortCalls = 0;
    const session: PauseSession = {
      abort() {
        abortCalls++;
        aborted = true;
        return abortDone.promise;
      },
    };
    void transcription.promise.then((text) => {
      if (!aborted) injected.push(text);
    });
    const h = harness({ currentTurn: original, activeSession: session });
    const generation = h.controller.capture();

    h.controller.beginPause();

    expect(abortCalls).toBe(1);
    expect(aborted).toBeTrue();
    transcription.resolve("partial words that must be dropped");
    await transcription.promise;
    await Promise.resolve();
    expect(injected).toEqual([]);

    let state: DictationControllerState = "draining";
    const acknowledged: DictationEvent[] = [];
    const eventSession = {
      get state() {
        return state;
      },
      acknowledge(event: DictationEvent) {
        acknowledged.push(event);
        state = "idle";
      },
    };
    const inFlightTranscript: DictationEvent = {
      kind: "transcript",
      sequence: 1,
      generation: 1,
      rawPath: "/tmp/in-flight.raw",
      finalBytes: 32_000,
      text: "older transcription completed after pause",
    };
    const transcriptDisposition = h.controller.interceptDictationEvent(
      generation,
      inFlightTranscript,
      eventSession,
    );
    if (!transcriptDisposition.intercepted) injected.push(inFlightTranscript.text);
    expect(transcriptDisposition).toEqual({ intercepted: true, terminal: false });
    expect(injected).toEqual([]);

    const barrier: DictationEvent = { kind: "barrier", id: 1, reason: "manual-reply" };
    expect(h.controller.interceptDictationEvent(generation, barrier, eventSession)).toEqual({
      intercepted: true,
      terminal: true,
    });
    expect(acknowledged).toEqual([barrier]);

    abortDone.resolve();
    await abortDone.promise;
    expect(h.errors).toEqual([]);
  });

  test("a dropped event from an already-idle aborted session terminates the exchange", () => {
    const h = harness();
    const generation = h.controller.capture();
    h.controller.beginPause();
    const dropped: DictationEvent = {
      kind: "error",
      sequence: 1,
      generation: 1,
      stage: "open",
      error: "recorder failed while pause arrived",
    };

    expect(h.controller.interceptDictationEvent(generation, dropped, {
      state: "idle",
      acknowledge() {},
    })).toEqual({ intercepted: true, terminal: true });
  });

  test("holds the exact original event and silent quick-resume keeps its old generation interrupted", async () => {
    const original = turn();
    const live = deferred<ReadonlySet<string> | null>();
    const h = harness({
      currentTurn: original,
      liveSessionIds: () => live.promise,
    });
    const activeGeneration = h.controller.capture();

    await h.controller.setPaused(true, { announce: false });
    expect(h.pending.get(original.sessionId)).toBe(original);
    expect(h.held).toEqual([original]);

    const resume = h.controller.setPaused(false, { announce: false });
    expect(h.controller.paused).toBeFalse();
    expect(h.controller.interrupted(activeGeneration)).toBeTrue();
    expect(h.pending.size).toBe(0);

    live.resolve(new Set([original.sessionId]));
    await resume;

    expect(h.controller.interrupted(activeGeneration)).toBeTrue();
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toBe(original);
    expect(h.spoken).toEqual([]);
  });

  test("a newer same-session hold supersedes the interrupted turn before replay", async () => {
    const original = turn();
    const newer = turn({
      announce: "alpha: newer response",
      mark: 5,
      eventAt: 2_000,
    });
    const h = harness({
      currentTurn: original,
      liveSessionIds: async () => new Set([original.sessionId]),
    });

    await h.controller.setPaused(true, { announce: false });
    h.pending.set(newer.sessionId, newer);
    await h.controller.setPaused(false, { announce: false });

    expect(h.enqueued).toEqual([newer]);
    expect(h.enqueued[0]).toBe(newer);
  });

  test("a newer pause cancels an in-flight resume before it can replay or announce", async () => {
    const original = turn();
    const live = deferred<ReadonlySet<string> | null>();
    let currentTurn: TurnEvent | null = original;
    const h = harness({
      currentTurn: () => currentTurn,
      liveSessionIds: () => live.promise,
    });

    await h.controller.setPaused(true, { announce: false });
    currentTurn = null;
    const staleResume = h.controller.setPaused(false);
    expect(h.pending.size).toBe(0);

    h.controller.beginPause();
    expect(h.controller.paused).toBeTrue();
    expect(h.pending.get(original.sessionId)).toBe(original);

    live.resolve(new Set([original.sessionId]));
    await staleResume;

    expect(h.enqueued).toEqual([]);
    expect(h.spoken).toEqual([]);
    expect(h.modeStates.at(-1)).toBeTrue();
  });

  test("a stale interrupted turn cannot overwrite a newer hold restored from a cancelled resume", async () => {
    const stale = turn({ announce: "older turn", mark: 4, eventAt: 1_000 });
    const newer = turn({ announce: "newer turn", mark: 5, eventAt: 2_000 });
    const live = deferred<ReadonlySet<string> | null>();
    let turnGeneration = 0;
    const h = harness({
      currentTurn: stale,
      currentTurnGeneration: () => turnGeneration,
      liveSessionIds: () => live.promise,
    });

    h.controller.beginPause();
    h.pending.set(newer.sessionId, newer);
    const staleResume = h.controller.setPaused(false, { announce: false });
    // The old exchange is still unwinding with generation zero while active
    // mode has moved to generation one.
    turnGeneration = 0;
    h.controller.beginPause();

    expect(h.pending.get(newer.sessionId)).toBe(newer);
    live.resolve(new Set([newer.sessionId]));
    await staleResume;
    expect(h.enqueued).toEqual([]);
  });

  test("settings lifecycle pauses immediately and restores active mode without speaking", async () => {
    const original = turn();
    let abortCalls = 0;
    const h = harness({
      currentTurn: original,
      activeSession: { abort: () => void abortCalls++ },
      liveSessionIds: async () => new Set([original.sessionId]),
    });
    const settings = new SettingsPauseLifecycle(h.controller);

    settings.open();
    expect(h.controller.paused).toBeTrue();
    expect(h.cancelCurrentCalls).toBe(1);
    expect(abortCalls).toBe(1);
    expect(h.pending.get(original.sessionId)).toBe(original);

    settings.close();
    await Bun.sleep(0);

    expect(h.controller.paused).toBeFalse();
    expect(h.enqueued).toEqual([original]);
    expect(h.spoken).toEqual([]);
    expect(h.persisted).toEqual([true, false]);
    expect(h.modeStates).toEqual([true, false]);
  });

  test("settings opened while already paused force-interrupts but closing leaves it paused", async () => {
    let abortCalls = 0;
    const h = harness({
      initialPaused: true,
      activeSession: { abort: () => void abortCalls++ },
    });
    const settings = new SettingsPauseLifecycle(h.controller);

    settings.open();
    settings.open();
    expect(h.cancelCurrentCalls).toBe(1);
    expect(abortCalls).toBe(1);
    settings.close();
    settings.close();
    await Bun.sleep(0);

    expect(h.controller.paused).toBeTrue();
    expect(h.persisted).toEqual([]);
    expect(h.enqueued).toEqual([]);
    expect(h.spoken).toEqual([]);
  });

  test("settings force-pause preserves a newer turn already held for the same session", async () => {
    const latest = turn({ announce: "latest completed turn", mark: 8, eventAt: 3_000 });
    const interruptedWake = turn({
      type: "wake",
      announce: "",
      mark: undefined,
      eventAt: undefined,
    });
    const h = harness({
      initialPaused: true,
      currentTurn: interruptedWake,
      liveSessionIds: async () => new Set([latest.sessionId]),
    });
    h.pending.set(latest.sessionId, latest);
    const settings = new SettingsPauseLifecycle(h.controller);

    settings.open();
    settings.close();
    expect(h.pending.get(latest.sessionId)).toBe(latest);
    expect(h.held).toEqual([]);

    await h.controller.setPaused(false, { announce: false });
    expect(h.enqueued).toEqual([latest]);
    expect(h.enqueued[0]).toBe(latest);
  });

  test("overlapping silent pause owners restore only after the final owner closes", async () => {
    const h = harness();
    const coordinator = new SilentPauseCoordinator(h.controller);
    const settings = new SettingsPauseLifecycle(coordinator);
    const meeting = new SettingsPauseLifecycle(coordinator);

    settings.open();
    meeting.open();
    expect(h.controller.paused).toBeTrue();
    expect(h.cancelCurrentCalls).toBe(2);

    settings.close();
    await Bun.sleep(0);
    expect(h.controller.paused).toBeTrue();
    expect(h.persisted).toEqual([true]);

    meeting.close();
    await Bun.sleep(0);
    expect(h.controller.paused).toBeFalse();
    expect(h.persisted).toEqual([true, false]);
    expect(h.spoken).toEqual([]);
  });

  test("explicit pause and resume become the state restored after a silent owner", async () => {
    const initiallyActive = harness();
    const activeCoordinator = new SilentPauseCoordinator(initiallyActive.controller);
    const activeMeeting = new SettingsPauseLifecycle(activeCoordinator);
    activeMeeting.open();
    activeCoordinator.recordManualState(true);
    await initiallyActive.controller.setPaused(true, { announce: false });
    activeMeeting.close();
    await Bun.sleep(0);
    expect(initiallyActive.controller.paused).toBeTrue();
    expect(initiallyActive.persisted).toEqual([true]);

    const initiallyPaused = harness({ initialPaused: true });
    const pausedCoordinator = new SilentPauseCoordinator(initiallyPaused.controller);
    const pausedMeeting = new SettingsPauseLifecycle(pausedCoordinator);
    pausedMeeting.open();
    pausedCoordinator.recordManualState(false);
    await initiallyPaused.controller.setPaused(false, { announce: false });
    pausedMeeting.close();
    await Bun.sleep(0);
    expect(initiallyPaused.controller.paused).toBeFalse();
    expect(initiallyPaused.persisted).toEqual([false]);
  });

  test("manual pause and resume retain their spoken acknowledgements", async () => {
    const original = turn();
    const h = harness({
      currentTurn: original,
      liveSessionIds: async () => new Set([original.sessionId]),
    });

    await h.controller.setPaused(true);
    await h.controller.setPaused(false);

    expect(h.spoken).toEqual([
      "Paused. I'll hold your queue.",
      "Back. 1 session finished while you were away.",
    ]);
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toBe(original);
  });
});
