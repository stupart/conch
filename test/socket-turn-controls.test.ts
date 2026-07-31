import { describe, expect, test } from "bun:test";
import {
  dispatchSocketTurnEvent,
  enrichTargetedAudioCommand,
  isLightweightTargetedAudioCommand,
  validateSocketTurnEvent,
  type SocketTurnEventCallbacks,
} from "../src/daemon.ts";
import type { TurnEvent } from "../src/hook.ts";
import type { InstantAudioCommand } from "../src/instant-controls.ts";

function turn(overrides: Partial<TurnEvent> = {}): TurnEvent {
  return {
    type: "wake",
    sessionId: "session-a",
    label: "alpha",
    announce: "",
    ...overrides,
  };
}

function harness(options: { busy?: boolean } = {}) {
  let stopCalls = 0;
  const paused: Array<[string, boolean]> = [];
  const muted: Array<[string, boolean]> = [];
  const instant: InstantAudioCommand[] = [];
  const queued: TurnEvent[] = [];
  const callbacks: SocketTurnEventCallbacks = {
    busy: () => options.busy === true,
    stopSpacebar: () => stopCalls++,
    setSessionPaused: (sessionId, next) => paused.push([sessionId, next]),
    setSessionMuted: (sessionId, next) => muted.push([sessionId, next]),
    enrichAudioCommand: (event) => ({ ...event, cwd: "/enriched" }),
    enqueueInstant: (event) => instant.push(event),
    enqueue: (event) => queued.push(event),
  };
  return {
    callbacks,
    paused,
    muted,
    instant,
    queued,
    get stopCalls() {
      return stopCalls;
    },
  };
}

describe("dispatchSocketTurnEvent", () => {
  test("spacebar uses the live stop edge only while an exchange is busy", () => {
    const busy = harness({ busy: true });
    dispatchSocketTurnEvent(turn({ type: "spacebar", sessionId: "" }), busy.callbacks);
    expect(busy.stopCalls).toBe(1);
    expect(busy.queued).toEqual([]);

    const idle = harness();
    dispatchSocketTurnEvent(turn({ type: "spacebar", sessionId: "" }), idle.callbacks);
    expect(idle.stopCalls).toBe(0);
    expect(idle.queued).toEqual([]);
  });

  test("nonempty mode targets are session-scoped and empty targets remain global", () => {
    const h = harness();
    dispatchSocketTurnEvent(turn({ type: "pause" }), h.callbacks);
    dispatchSocketTurnEvent(turn({ type: "resume" }), h.callbacks);
    dispatchSocketTurnEvent(turn({ type: "mute" }), h.callbacks);
    dispatchSocketTurnEvent(turn({ type: "unmute" }), h.callbacks);
    expect(h.paused).toEqual([["session-a", true], ["session-a", false]]);
    expect(h.muted).toEqual([["session-a", true], ["session-a", false]]);
    expect(h.queued).toEqual([]);

    const globalPause = turn({ type: "pause", sessionId: "", label: "" });
    const globalMute = turn({ type: "mute", sessionId: "", label: "" });
    dispatchSocketTurnEvent(globalPause, h.callbacks);
    dispatchSocketTurnEvent(globalMute, h.callbacks);
    expect(h.queued).toEqual([globalPause, globalMute]);
  });

  test("lightweight targeted wake and recite are enriched instant takeovers", () => {
    const h = harness();
    dispatchSocketTurnEvent(turn({ type: "wake" }), h.callbacks);
    dispatchSocketTurnEvent(turn({ type: "recite" }), h.callbacks);
    expect(h.instant.map((event) => [event.type, event.cwd])).toEqual([
      ["wake", "/enriched"],
      ["recite", "/enriched"],
    ]);
    expect(h.queued).toEqual([]);

    const unnamed = turn({ type: "wake", sessionId: "", label: "" });
    dispatchSocketTurnEvent(unnamed, h.callbacks);
    expect(h.queued).toEqual([unnamed]);
  });

  test("fully routed CLI/MCP wake and recite keep ordinary queue semantics", () => {
    const h = harness();
    const wake = turn({
      type: "wake",
      cwd: "/cli",
      pid: 42,
      transcriptPath: "/cli/transcript.jsonl",
    });
    const recite = turn({
      type: "recite",
      cwd: "/mcp",
      pid: 43,
      transcriptPath: "/mcp/transcript.jsonl",
      mark: 9,
    });

    expect(isLightweightTargetedAudioCommand(wake as InstantAudioCommand)).toBeFalse();
    expect(isLightweightTargetedAudioCommand(recite as InstantAudioCommand)).toBeFalse();
    dispatchSocketTurnEvent(wake, h.callbacks);
    dispatchSocketTurnEvent(recite, h.callbacks);

    expect(h.instant).toEqual([]);
    expect(h.queued).toEqual([wake, recite]);
  });
});

describe("validateSocketTurnEvent", () => {
  test("normalizes intentionally sparse dashboard controls", () => {
    expect(validateSocketTurnEvent({ type: "pause" })).toEqual({
      ok: true,
      value: { type: "pause", sessionId: "", label: "", announce: "" },
    });
    expect(validateSocketTurnEvent({ type: "spacebar" })).toEqual({
      ok: true,
      value: { type: "spacebar", sessionId: "", label: "", announce: "" },
    });
    expect(validateSocketTurnEvent({
      type: "recite",
      sessionId: "session-a",
      label: "alpha",
    })).toEqual({
      ok: true,
      value: {
        type: "recite",
        sessionId: "session-a",
        label: "alpha",
        announce: "",
      },
    });
  });

  test("preserves complete hook traffic after validating optional fields", () => {
    const event: TurnEvent = {
      type: "turn-end",
      sessionId: "session-a",
      label: "alpha",
      announce: "alpha finished",
      cwd: "/work",
      pid: 42,
      transcriptPath: "/work/transcript.jsonl",
      mark: 7,
      eventAt: 123.5,
      review: { summary: "ready", link: "file:///tmp/review.html" },
    };

    expect(validateSocketTurnEvent(event)).toEqual({ ok: true, value: event });
  });

  test("rejects unknown, incomplete, and wrong-shaped JSON before dispatch", () => {
    const invalid: unknown[] = [
      null,
      [],
      {},
      { type: "bogus", sessionId: "session-a", label: "alpha", announce: "" },
      { type: "turn-end", sessionId: "session-a", label: "alpha" },
      { type: "wake", sessionId: 42, label: "alpha" },
      { type: "pause", sessionId: null },
      { type: "speak", sessionId: "", label: "", announce: 42 },
      { type: "working", sessionId: "session-a", label: "alpha", announce: "", pid: "42" },
      { type: "turn-end", sessionId: "session-a", label: "alpha", announce: "", backgroundWork: false },
      { type: "turn-end", sessionId: "session-a", label: "alpha", announce: "", review: { summary: 42 } },
    ];

    for (const value of invalid) expect(validateSocketTurnEvent(value).ok).toBeFalse();
  });
});

describe("enrichTargetedAudioCommand", () => {
  const known = turn({
    type: "turn-end",
    label: "known label",
    cwd: "/known",
    pid: 10,
    transcriptPath: "/known/transcript.jsonl",
    mark: 7,
  });

  test("fills routing metadata while preserving explicit client fields", () => {
    const enriched = enrichTargetedAudioCommand(
      turn({ type: "wake", label: "client label", cwd: undefined, pid: undefined }) as InstantAudioCommand,
      {
        known,
        session: { cwd: "/session", pid: 20 },
        label: "panel label",
        transcriptPath: "/found/transcript.jsonl",
      },
    );
    expect(enriched).toMatchObject({
      type: "wake",
      sessionId: "session-a",
      label: "client label",
      announce: "",
      cwd: "/session",
      pid: 20,
      transcriptPath: "/known/transcript.jsonl",
    });
  });

  test("a minimal recite gains a transcript and refreshes its mark", () => {
    const event = turn({ type: "recite", label: "" }) as InstantAudioCommand;
    const enriched = enrichTargetedAudioCommand(event, { known });
    expect(enriched.label).toBe("known label");
    expect(enriched.transcriptPath).toBe("/known/transcript.jsonl");
    expect(enriched.mark).toBeUndefined();
  });
});
