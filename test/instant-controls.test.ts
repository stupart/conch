import { describe, expect, test } from "bun:test";
import type { TurnEvent } from "../src/hook.ts";
import {
  gateTurnForControls,
  InstantControls,
  markQueuedTurnsForMute,
  markQueuedWakesForControl,
  muteAcknowledgement,
  shouldForgetMutedArrival,
} from "../src/instant-controls.ts";
import {
  PauseController,
  type PauseControllerOptions,
  type PauseSession,
} from "../src/pause-controller.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

function harness(options: {
  current?: TurnEvent | null;
  holdableTurn?: PauseControllerOptions["holdableTurn"];
  latestTurns?: Map<string, TurnEvent>;
  liveSessionIds?: PauseControllerOptions["liveSessionIds"];
} = {}) {
  let current: TurnEvent | null = options.current === undefined ? turn() : options.current;
  let muted = false;
  let abortCalls = 0;
  let cancelCurrentCalls = 0;
  let cancelPendingCalls = 0;
  const abortDone = deferred<void>();
  const session: PauseSession = {
    abort() {
      abortCalls++;
      return abortDone.promise;
    },
  };
  const globalHeldTurns = new Map<string, TurnEvent>();
  const pausedSessionIds = new Set<string>();
  const mutedSessionIds = new Set<string>();
  const sessionHeldTurns = new Map<string, TurnEvent>();
  const latestTurns = options.latestTurns ?? new Map<string, TurnEvent>();
  const enqueued: TurnEvent[] = [];
  const logs: string[] = [];
  const forgottenQueuedScopes: Array<string | undefined> = [];
  const cancelledWakeScopes: Array<string | undefined> = [];
  let renders = 0;

  const pause = new PauseController({
    initialPaused: false,
    pending: globalHeldTurns,
    currentTurn: () => current,
    holdableTurn: options.holdableTurn,
    activeSession: () => session,
    cancelCurrentSpeech: () => void cancelCurrentCalls++,
    cancelPendingAudio: () => void cancelPendingCalls++,
    persist() {},
    render: () => void renders++,
    setModeState() {},
    log: (message) => logs.push(message),
    speak: async () => {},
    liveSessionIds: options.liveSessionIds ?? (async () => new Set(["session-a"])),
    userRespondedSince: async () => false,
    enqueue: (event) => enqueued.push(event),
  });
  const controls = new InstantControls({
    pause,
    globalHeldTurns,
    pausedSessionIds,
    mutedSessionIds,
    sessionHeldTurns,
    setMuted: (next) => {
      muted = next;
    },
    enqueue: (event) => enqueued.push(event),
    forgetQueued: (sessionId) => forgottenQueuedScopes.push(sessionId),
    forgetLatest: (sessionId) => {
      if (sessionId === undefined) latestTurns.clear();
      else latestTurns.delete(sessionId);
    },
    cancelQueuedWakes: (sessionId) => cancelledWakeScopes.push(sessionId),
    labelFor: (id) => id === "session-a" ? "alpha" : "beta",
    log: (message) => logs.push(message),
    render: () => void renders++,
  });

  return {
    pause,
    controls,
    globalHeldTurns,
    pausedSessionIds,
    mutedSessionIds,
    sessionHeldTurns,
    latestTurns,
    enqueued,
    logs,
    forgottenQueuedScopes,
    cancelledWakeScopes,
    abortDone,
    setCurrent(next: TurnEvent | null) {
      current = next;
    },
    get muted() {
      return muted;
    },
    get abortCalls() {
      return abortCalls;
    },
    get cancelCurrentCalls() {
      return cancelCurrentCalls;
    },
    get cancelPendingCalls() {
      return cancelPendingCalls;
    },
    get renders() {
      return renders;
    },
  };
}

describe("InstantControls", () => {
  test("global pause and resume apply before abort or replay filtering can finish", async () => {
    const live = deferred<ReadonlySet<string> | null>();
    const original = turn();
    const h = harness({ current: original, liveSessionIds: () => live.promise });
    const beforePause = h.pause.capture();

    expect(h.controls.applyGlobal("pause")).toBeNull();

    expect(h.pause.paused).toBeTrue();
    expect(h.pause.interrupted(beforePause)).toBeTrue();
    expect(h.globalHeldTurns.get(original.sessionId)).toBe(original);
    expect(h.cancelCurrentCalls).toBe(1);
    expect(h.cancelPendingCalls).toBe(1);
    expect(h.abortCalls).toBe(1);

    h.setCurrent(turn({ type: "wake", announce: "" }));
    const beforeResume = h.pause.capture();
    const resume = h.controls.applyGlobal("resume");

    expect(resume).not.toBeNull();
    expect(h.pause.paused).toBeFalse();
    expect(h.pause.interrupted(beforeResume)).toBeTrue();
    expect(h.cancelCurrentCalls).toBe(2);
    expect(h.abortCalls).toBe(2);
    expect(h.enqueued).toEqual([]);

    live.resolve(new Set(["session-a"]));
    expect(await resume!).toEqual({ replayed: 1, dropped: 0, cancelled: false });
    expect(h.enqueued).toEqual([original]);
  });

  test("an explicit pause while already paused still interrupts an active wake", () => {
    const original = turn();
    const wake = turn({ type: "wake", announce: "", mark: undefined });
    const h = harness({ current: original });
    h.controls.applyGlobal("pause");
    expect(h.globalHeldTurns.get("session-a")).toBe(original);

    h.setCurrent(wake);
    const wakeGeneration = h.pause.capture();
    h.controls.applyGlobal("pause");

    expect(h.pause.paused).toBeTrue();
    expect(h.pause.interrupted(wakeGeneration)).toBeTrue();
    expect(h.cancelCurrentCalls).toBe(2);
    expect(h.cancelPendingCalls).toBe(2);
    expect(h.abortCalls).toBe(2);
    expect(h.globalHeldTurns.get("session-a")).toBe(original);
  });

  test("session pause interrupts only its owner and resumes the held turn from the top", () => {
    const original = turn();
    const h = harness({ current: original });
    const globalGeneration = h.pause.capture();

    h.controls.setSessionPaused("session-a", true);

    expect(h.pause.paused).toBeFalse();
    expect(h.pausedSessionIds).toEqual(new Set(["session-a"]));
    expect(h.sessionHeldTurns.get("session-a")).toBe(original);
    expect(h.pause.interrupted(globalGeneration)).toBeTrue();
    expect(h.cancelCurrentCalls).toBe(1);
    expect(h.abortCalls).toBe(1);

    h.setCurrent(null);
    h.controls.setSessionPaused("session-a", false);

    expect(h.pausedSessionIds).toEqual(new Set());
    expect(h.sessionHeldTurns.size).toBe(0);
    expect(h.enqueued).toEqual([original]);
    expect(h.enqueued[0]).toBe(original);
  });

  test("session unpause cancels an active wake and replays the older held turn, not the wake", () => {
    const latest = turn({ announce: "alpha: latest complete response", mark: 8 });
    const wake = turn({ type: "wake", announce: "", mark: undefined });
    const h = harness({ current: latest });
    h.controls.setSessionPaused("session-a", true);
    const cancelsBeforeResume = h.cancelCurrentCalls;
    const abortsBeforeResume = h.abortCalls;

    h.setCurrent(wake);
    const wakeGeneration = h.pause.capture();
    h.controls.setSessionPaused("session-a", false);

    expect(h.pause.interrupted(wakeGeneration)).toBeTrue();
    expect(h.cancelCurrentCalls).toBe(cancelsBeforeResume + 1);
    expect(h.cancelPendingCalls).toBe(2);
    expect(h.abortCalls).toBe(abortsBeforeResume + 1);
    expect(h.enqueued).toEqual([latest]);
    expect(h.enqueued[0]!.type).toBe("turn-end");
  });

  test("pause normalizes an active wake to the latest completed turn", () => {
    const latest = turn({ announce: "alpha: replay this from the top", mark: 9 });
    const wake = turn({ type: "wake", announce: "", mark: undefined });
    const h = harness({
      current: wake,
      holdableTurn: () => latest,
    });

    h.controls.setSessionPaused("session-a", true);

    expect(h.sessionHeldTurns.get("session-a")).toBe(latest);
    expect(h.sessionHeldTurns.get("session-a")!.type).toBe("turn-end");
  });

  test("a parked inactive session changes mode without killing another session", () => {
    const h = harness({ current: turn({ sessionId: "session-a" }) });
    const generation = h.pause.capture();

    h.controls.setSessionPaused("session-b", true);

    expect(h.pausedSessionIds).toEqual(new Set(["session-b"]));
    expect(h.pause.interrupted(generation)).toBeFalse();
    expect(h.cancelCurrentCalls).toBe(0);
    expect(h.cancelPendingCalls).toBe(0);
    expect(h.abortCalls).toBe(0);
    expect(h.sessionHeldTurns.size).toBe(0);
  });

  test("muting a parked inactive session does not interrupt another session", () => {
    const h = harness({ current: turn({ sessionId: "session-a" }) });
    const generation = h.pause.capture();

    h.controls.setSessionMuted("session-b", true);

    expect(h.mutedSessionIds).toEqual(new Set(["session-b"]));
    expect(h.pause.interrupted(generation)).toBeFalse();
    expect(h.cancelCurrentCalls).toBe(0);
    expect(h.cancelPendingCalls).toBe(0);
    expect(h.abortCalls).toBe(0);
    expect(h.forgottenQueuedScopes).toEqual(["session-b"]);
  });

  test("global and per-session mute/unmute are instant and always forget", () => {
    const original = turn();
    const h = harness({ current: original });
    const beforeGlobalMute = h.pause.capture();
    h.globalHeldTurns.set("session-a", original);
    h.sessionHeldTurns.set("session-a", original);
    h.latestTurns.set("session-a", original);

    h.controls.applyGlobal("mute");

    expect(h.muted).toBeTrue();
    expect(h.pause.interrupted(beforeGlobalMute)).toBeTrue();
    expect(h.cancelCurrentCalls).toBe(1);
    expect(h.abortCalls).toBe(1);
    expect(h.globalHeldTurns.size).toBe(0);
    expect(h.sessionHeldTurns.size).toBe(0);
    expect(h.latestTurns.size).toBe(0);
    expect(h.forgottenQueuedScopes).toEqual([undefined]);

    h.setCurrent(turn({ type: "wake", announce: "" }));
    h.controls.applyGlobal("unmute");
    expect(h.muted).toBeFalse();
    expect(h.cancelCurrentCalls).toBe(2);
    expect(h.abortCalls).toBe(2);
    expect(h.enqueued).toEqual([]);

    h.setCurrent(original);
    h.globalHeldTurns.set("session-a", original);
    h.sessionHeldTurns.set("session-a", original);
    h.latestTurns.set("session-a", original);
    h.controls.setSessionMuted("session-a", true);
    expect(h.mutedSessionIds).toEqual(new Set(["session-a"]));
    expect(h.globalHeldTurns.size).toBe(0);
    expect(h.sessionHeldTurns.size).toBe(0);
    expect(h.latestTurns.size).toBe(0);
    h.controls.setSessionMuted("session-a", false);
    expect(h.mutedSessionIds).toEqual(new Set());
    expect(h.sessionHeldTurns.size).toBe(0);
    expect(h.enqueued).toEqual([]);
    expect(h.cancelCurrentCalls).toBe(4);
    expect(h.abortCalls).toBe(4);
    expect(h.forgottenQueuedScopes).toEqual([undefined, "session-a"]);
  });

  test("global mute permanently cancels a blocked resume snapshot", async () => {
    const live = deferred<ReadonlySet<string> | null>();
    const original = turn();
    const h = harness({ current: original, liveSessionIds: () => live.promise });
    h.controls.applyGlobal("pause");
    h.setCurrent(null);
    const resume = h.controls.applyGlobal("resume");
    expect(resume).not.toBeNull();

    h.controls.applyGlobal("mute");
    h.controls.applyGlobal("unmute");
    live.resolve(new Set(["session-a"]));

    expect(await resume!).toEqual({ replayed: 0, dropped: 0, cancelled: true });
    expect(h.enqueued).toEqual([]);
  });

  test("a muted turn cannot be resurrected by pausing during a later wake", () => {
    const dropped = turn({ announce: "alpha: muted and forgotten" });
    const wake = turn({ type: "wake", announce: "", mark: undefined });
    const latestTurns = new Map<string, TurnEvent>();
    const h = harness({
      current: wake,
      latestTurns,
      holdableTurn: (current) => current.type === "wake"
        ? latestTurns.get(current.sessionId) ?? null
        : current,
    });
    h.latestTurns.set("session-a", dropped);

    h.setCurrent(null);
    h.controls.applyGlobal("mute");
    h.controls.applyGlobal("unmute");
    h.setCurrent(wake);
    h.controls.setSessionPaused("session-a", true);
    h.setCurrent(null);
    h.controls.setSessionPaused("session-a", false);

    expect(h.latestTurns.size).toBe(0);
    expect(h.sessionHeldTurns.size).toBe(0);
    expect(h.enqueued).toEqual([]);
  });

  test("session mute excludes only that session from a blocked global resume", async () => {
    const live = deferred<ReadonlySet<string> | null>();
    const alpha = turn();
    const beta = turn({
      sessionId: "session-b",
      label: "beta",
      announce: "beta: finished response",
      transcriptPath: "/tmp/beta.jsonl",
    });
    const h = harness({ current: alpha, liveSessionIds: () => live.promise });
    h.controls.applyGlobal("pause");
    h.globalHeldTurns.set("session-b", beta);
    h.setCurrent(null);
    const resume = h.controls.applyGlobal("resume");
    expect(resume).not.toBeNull();

    h.controls.setSessionMuted("session-a", true);
    h.controls.setSessionMuted("session-a", false);
    live.resolve(new Set(["session-a", "session-b"]));

    expect(await resume!).toEqual({ replayed: 1, dropped: 1, cancelled: false });
    expect(h.enqueued).toEqual([beta]);
  });

  test("every global and scoped mode edge cancels wakes queued before it", () => {
    const h = harness({ current: null });

    for (const command of ["pause", "resume", "mute", "unmute"] as const) {
      h.controls.applyGlobal(command);
    }
    h.controls.setSessionPaused("session-a", true);
    h.controls.setSessionPaused("session-a", false);
    h.controls.setSessionMuted("session-a", true);
    h.controls.setSessionMuted("session-a", false);

    expect(h.cancelledWakeScopes).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      "session-a",
      "session-a",
      "session-a",
      "session-a",
    ]);
  });
});

describe("future-turn control gates", () => {
  test("global pause holds only the latest future turn and resume replays it", async () => {
    const first = turn({ announce: "alpha: first", mark: 4 });
    const latest = turn({ announce: "alpha: latest", mark: 5, eventAt: 2_000 });
    const h = harness({ current: null });
    h.controls.applyGlobal("pause");
    const gateOptions = {
      globalMuted: false,
      globalPaused: h.pause.paused,
      settingsOpen: false,
      globalHeldTurns: h.globalHeldTurns,
      pausedSessionIds: h.pausedSessionIds,
      mutedSessionIds: h.mutedSessionIds,
      sessionHeldTurns: h.sessionHeldTurns,
    };

    expect(gateTurnForControls(first, true, gateOptions)).toBe("global-paused");
    expect(gateTurnForControls(latest, true, gateOptions)).toBe("global-paused");
    expect(h.globalHeldTurns.get("session-a")).toBe(latest);

    const resume = h.controls.applyGlobal("resume");
    expect(resume).not.toBeNull();
    expect(await resume!).toEqual({ replayed: 1, dropped: 0, cancelled: false });
    expect(h.enqueued).toEqual([latest]);
  });

  test("global mute forgets future turns and wins over simultaneous pause", () => {
    const future = turn({ announce: "alpha: globally forgotten" });
    const globalHeldTurns = new Map<string, TurnEvent>();
    const sessionHeldTurns = new Map<string, TurnEvent>([["session-a", future]]);

    expect(gateTurnForControls(future, true, {
      globalMuted: true,
      globalPaused: true,
      settingsOpen: false,
      globalHeldTurns,
      pausedSessionIds: new Set(["session-a"]),
      mutedSessionIds: new Set(),
      sessionHeldTurns,
    })).toBe("global-muted");
    expect(globalHeldTurns.size).toBe(0);
  });

  test("session pause keeps only the latest future turn, then p replays it", () => {
    const first = turn({ announce: "alpha: first", mark: 4 });
    const latest = turn({ announce: "alpha: latest", mark: 5, eventAt: 2_000 });
    const h = harness({ current: null });
    h.controls.setSessionPaused("session-a", true);
    const gateOptions = {
      globalMuted: false,
      globalPaused: false,
      settingsOpen: false,
      globalHeldTurns: h.globalHeldTurns,
      pausedSessionIds: h.pausedSessionIds,
      mutedSessionIds: h.mutedSessionIds,
      sessionHeldTurns: h.sessionHeldTurns,
    };

    expect(gateTurnForControls(first, true, gateOptions)).toBe("session-paused");
    expect(gateTurnForControls(latest, true, gateOptions)).toBe("session-paused");
    expect(h.sessionHeldTurns.get("session-a")).toBe(latest);

    h.controls.setSessionPaused("session-a", false);
    expect(h.enqueued).toEqual([latest]);
  });

  test("session mute forgets future turns and unmute never replays them", () => {
    const future = turn({ announce: "alpha: must be forgotten" });
    const h = harness({ current: null });
    h.controls.setSessionMuted("session-a", true);
    h.sessionHeldTurns.set("session-a", future);

    expect(gateTurnForControls(future, true, {
      globalMuted: false,
      globalPaused: false,
      settingsOpen: false,
      globalHeldTurns: h.globalHeldTurns,
      pausedSessionIds: h.pausedSessionIds,
      mutedSessionIds: h.mutedSessionIds,
      sessionHeldTurns: h.sessionHeldTurns,
    })).toBe("session-muted");
    expect(h.sessionHeldTurns.has("session-a")).toBeFalse();

    h.controls.setSessionMuted("session-a", false);
    expect(h.enqueued).toEqual([]);
  });

  test("mute stamps ordinary arrivals but explicit post-mute wake stays available", () => {
    expect(shouldForgetMutedArrival(turn(), true, false)).toBeTrue();
    expect(shouldForgetMutedArrival(turn(), false, true)).toBeTrue();
    expect(shouldForgetMutedArrival(turn({ type: "wake" }), true, true)).toBeFalse();
    expect(shouldForgetMutedArrival(turn({ type: "unmute" }), true, false)).toBeFalse();
  });

  test("queue stamping respects global versus selected-session scope", () => {
    const alphaTurn = turn();
    const betaTurn = turn({ sessionId: "session-b", label: "beta" });
    const alphaWake = turn({ type: "wake", announce: "" });
    const betaWake = turn({ type: "wake", sessionId: "session-b", label: "beta", announce: "" });
    const unnamedWake = turn({ type: "wake", sessionId: "", label: "", announce: "" });
    const control = turn({ type: "pause", sessionId: "", announce: "" });
    const explicitSpeech = turn({ type: "speak", sessionId: "", announce: "test" });
    const queue = [alphaTurn, betaTurn, alphaWake, betaWake, unnamedWake, control, explicitSpeech];
    const globallyForgotten: TurnEvent[] = [];
    const scopedForgotten: TurnEvent[] = [];
    const globalWakes: TurnEvent[] = [];
    const scopedWakes: TurnEvent[] = [];

    markQueuedTurnsForMute(queue, (event) => globallyForgotten.push(event));
    markQueuedTurnsForMute(queue, (event) => scopedForgotten.push(event), "session-a");
    markQueuedWakesForControl(queue, (event) => globalWakes.push(event));
    markQueuedWakesForControl(
      queue,
      (event) => scopedWakes.push(event),
      "session-b",
    );

    expect(globallyForgotten).toEqual([alphaTurn, betaTurn, alphaWake, betaWake, unnamedWake]);
    expect(scopedForgotten).toEqual([alphaTurn, alphaWake]);
    expect(globalWakes).toEqual([alphaWake, betaWake, unnamedWake]);
    expect(scopedWakes).toEqual([betaWake, unnamedWake]);
  });

  test("manual global mute and unmute keep their spoken acknowledgements", () => {
    expect(muteAcknowledgement(true)).toBe("Muted.");
    expect(muteAcknowledgement(false)).toBe("Back on.");
  });
});
