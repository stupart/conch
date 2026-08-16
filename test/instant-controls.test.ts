import { describe, expect, test } from "bun:test";
import type { TurnEvent } from "../src/hook.ts";
import {
  gateTurnForControls,
  InstantControls,
  markQueuedWakesForControl,
  normalizeLegacyModeControl,
} from "../src/instant-controls.ts";
import { PauseController } from "../src/pause-controller.ts";

function turn(overrides: Partial<TurnEvent> = {}): TurnEvent {
  return {
    type: "turn-end",
    sessionId: "session-a",
    label: "alpha",
    announce: "alpha: finished",
    transcriptPath: "/tmp/alpha.jsonl",
    mark: 4,
    ...overrides,
  };
}

function harness() {
  let current: TurnEvent | null = null;
  const globalHeldTurns = new Map<string, TurnEvent>();
  const sessionHeldTurns = new Map<string, TurnEvent>();
  const pausedSessionIds = new Set<string>();
  const resumedSessionIds = new Set<string>();
  const enqueued: TurnEvent[] = [];
  const cancelled: Array<string | undefined> = [];
  let cancelCurrentCalls = 0;
  let cancelPendingCalls = 0;
  const pause = new PauseController({
    initialPaused: false,
    pending: globalHeldTurns,
    currentTurn: () => current,
    activeSession: () => null,
    cancelCurrentSpeech() { cancelCurrentCalls += 1; },
    cancelPendingAudio() { cancelPendingCalls += 1; },
    persist() {},
    render() {},
    setModeState() {},
    log() {},
    speak: async () => {},
    liveSessionIds: async () => new Set(["session-a", "session-b"]),
    userRespondedSince: async () => false,
    enqueue: (event) => enqueued.push(event),
  });
  const controls = new InstantControls({
    pause,
    globalHeldTurns,
    pausedSessionIds,
    resumedSessionIds,
    sessionHeldTurns,
    enqueue: (event) => enqueued.push(event),
    markInstantQueued() {},
    cancelQueuedWakes: (sessionId) => cancelled.push(sessionId),
    labelFor: (id) => id,
    log() {},
    render() {},
  });
  return {
    pause,
    controls,
    globalHeldTurns,
    sessionHeldTurns,
    pausedSessionIds,
    resumedSessionIds,
    enqueued,
    cancelled,
    cancelCurrent: () => cancelCurrentCalls,
    cancelPending: () => cancelPendingCalls,
    setCurrent(value: TurnEvent | null) { current = value; },
  };
}

describe("InstantControls", () => {
  test("legacy verbs normalize to the lossless mode at the boundary", () => {
    expect(normalizeLegacyModeControl("mute")).toBe("pause");
    expect(normalizeLegacyModeControl("unmute")).toBe("resume");
    expect(normalizeLegacyModeControl("pause")).toBe("pause");
  });

  test("global pause holds the latest future turn and resume replays it", async () => {
    const h = harness();
    h.controls.applyGlobal("pause");
    const first = turn({ announce: "first" });
    const latest = turn({ announce: "latest" });
    expect(gateTurnForControls(first, true, {
      globalPaused: h.pause.paused,
      settingsOpen: false,
      globalHeldTurns: h.globalHeldTurns,
      pausedSessionIds: h.pausedSessionIds,
      sessionHeldTurns: h.sessionHeldTurns,
      resumedSessionIds: h.resumedSessionIds,
    })).toBe("global-paused");
    gateTurnForControls(latest, true, {
      globalPaused: h.pause.paused,
      settingsOpen: false,
      globalHeldTurns: h.globalHeldTurns,
      pausedSessionIds: h.pausedSessionIds,
      sessionHeldTurns: h.sessionHeldTurns,
      resumedSessionIds: h.resumedSessionIds,
    });
    await h.controls.applyGlobal("resume");
    expect(h.enqueued).toEqual([latest]);
  });

  test("session manual mode is scoped and replays its latest turn", () => {
    const h = harness();
    h.controls.setSessionPaused("session-a", true);
    const latest = turn();
    expect(gateTurnForControls(latest, true, {
      globalPaused: false,
      settingsOpen: false,
      globalHeldTurns: h.globalHeldTurns,
      pausedSessionIds: h.pausedSessionIds,
      sessionHeldTurns: h.sessionHeldTurns,
    })).toBe("session-paused");
    h.controls.setSessionPaused("session-a", false);
    expect(h.enqueued).toEqual([latest]);
  });

  test("dismissal holds a lossless latest turn separately from manual mode", () => {
    const h = harness();
    const dismissed = new Set(["session-a"]);
    const held = new Map<string, TurnEvent>();
    const first = turn({ announce: "first" });
    const latest = turn({ announce: "latest" });
    for (const event of [first, latest]) {
      expect(gateTurnForControls(event, true, {
        globalPaused: false,
        settingsOpen: false,
        globalHeldTurns: h.globalHeldTurns,
        pausedSessionIds: h.pausedSessionIds,
        sessionHeldTurns: h.sessionHeldTurns,
        dismissedSessionIds: dismissed,
        dismissedHeldTurns: held,
      })).toBe("session-dismissed");
    }
    expect(held.get("session-a")).toBe(latest);
    expect(h.sessionHeldTurns.size).toBe(0);
  });

  test("explicit recite cuts through manual mode but not dismissal", () => {
    const h = harness();
    const recite = turn({ type: "recite", announce: "" });
    expect(gateTurnForControls(recite, true, {
      globalPaused: true,
      settingsOpen: false,
      globalHeldTurns: h.globalHeldTurns,
      pausedSessionIds: new Set(["session-a"]),
      sessionHeldTurns: h.sessionHeldTurns,
    })).toBeNull();
    expect(gateTurnForControls(recite, true, {
      globalPaused: false,
      settingsOpen: false,
      globalHeldTurns: h.globalHeldTurns,
      pausedSessionIds: new Set(),
      sessionHeldTurns: h.sessionHeldTurns,
      dismissedSessionIds: new Set(["session-a"]),
      dismissedHeldTurns: new Map(),
    })).toBe("session-dismissed");
  });

  test("mode edges cancel only queued explicit audio commands", () => {
    const events = [
      turn(),
      turn({ type: "wake" }),
      turn({ type: "recite" }),
    ];
    const marked: TurnEvent[] = [];
    markQueuedWakesForControl(events, (event) => marked.push(event));
    expect(marked).toEqual(events.slice(1));
  });
});

/**
 * Behaviour that survived mute's retirement and lost its tests with it.
 *
 * Retiring mute deleted twenty of these, several of which were about pause,
 * wake and recite rather than forgetting — they only mentioned mute in passing.
 * These are the load-bearing ones, rewritten against the auto/manual model.
 * The reason they matter is that every failure here is SILENT: conch keeps
 * talking over you, or a control does nothing, and nothing errors.
 */
describe("instant takeover, which mute's retirement took the tests for", () => {
  test("a recite cuts an active read rather than queueing behind it", () => {
    const h = harness();
    h.setCurrent(turn());
    const generation = h.pause.capture();

    h.controls.enqueueInstant({ ...turn(), type: "recite", announce: "" });

    // Cutting in is the whole point of an instant control: pressing recite
    // while conch is mid-sentence must stop that sentence, not append to it.
    expect(h.cancelCurrent()).toBe(1);
    expect(h.cancelPending()).toBe(1);
    expect(h.pause.interrupted(generation)).toBeTrue();
    expect(h.enqueued.length).toBe(1);
  });

  test("a queued wake for the same session is dropped when one takes over", () => {
    const h = harness();
    h.setCurrent(turn());

    h.controls.enqueueInstant({ ...turn(), type: "wake", announce: "" });

    // Otherwise the mic opens twice: once for the wake being handled and again
    // for the one still sitting in the queue behind it.
    expect(h.cancelled.length).toBe(1);
  });

  test("switching a single session's mode leaves the others alone", () => {
    const h = harness();
    h.setCurrent(turn({ sessionId: "session-b", label: "beta" }));

    h.controls.setSessionPaused("session-a", true);

    // A per-session control that interrupts whatever happens to be speaking
    // would make manual-ing one agent silence another mid-sentence.
    expect(h.pausedSessionIds.has("session-a")).toBeTrue();
    expect(h.pausedSessionIds.has("session-b")).toBeFalse();
    expect(h.cancelCurrent()).toBe(0);
  });

  test("going manual while already manual still cuts an active read", () => {
    const h = harness();
    h.controls.enqueueInstant({ ...turn(), type: "pause", sessionId: "" });
    h.setCurrent(turn());
    const generation = h.pause.capture();

    h.controls.enqueueInstant({ ...turn(), type: "pause", sessionId: "" });

    // Pressing it twice is what a person does when the first press appeared to
    // do nothing — which is exactly when something IS still talking.
    expect(h.pause.interrupted(generation)).toBeTrue();
    expect(h.cancelCurrent()).toBeGreaterThan(0);
  });
});
