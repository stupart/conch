import { describe, expect, test } from "bun:test";
import {
  dispatchControlMessage,
  dispatchSessionControlMessage,
  dispatchSocketTurnEvent,
  enrichTargetedAudioCommand,
  isLightweightTargetedAudioCommand,
  restoreDismissedSessionState,
  validateSocketTurnEvent,
  type SessionCommandDispatchOptions,
  type ConfigController,
  type SocketTurnEventCallbacks,
} from "../src/daemon.ts";
import type { TurnEvent } from "../src/hook.ts";
import type { InstantAudioCommand } from "../src/instant-controls.ts";
import {
  invokeSessionAction,
  type SessionActionMutation,
  type SessionActionsController,
  type SessionActionsTarget,
} from "../src/session-actions-overlay.ts";
import type { SessionControlMessage } from "../src/settings.ts";
import {
  SettingsPauseLifecycle,
  SilentPauseCoordinator,
} from "../src/pause-controller.ts";

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
  const instant: InstantAudioCommand[] = [];
  const queued: TurnEvent[] = [];
  const callbacks: SocketTurnEventCallbacks = {
    busy: () => options.busy === true,
    stopSpacebar: () => stopCalls++,
    setSessionPaused: (sessionId, next) => paused.push([sessionId, next]),
    isDismissedSession: () => false,
    enrichAudioCommand: (event) => ({ ...event, cwd: "/enriched" }),
    enqueueInstant: (event) => instant.push(event),
    enqueue: (event) => queued.push(event),
  };
  return {
    callbacks,
    paused,
    instant,
    queued,
    get stopCalls() {
      return stopCalls;
    },
  };
}

function sessionCommandHarness(options: { throwOn?: SessionControlMessage["command"] } = {}) {
  const calls: unknown[] = [];
  let prioritized = false;
  const controller: SessionActionsController = {
    voiceCandidates: () => ["af_heart"],
    effectiveVoice: () => "af_heart",
    previewVoice: () => {},
    setVoice: (target, voice) => {
      calls.push(["set-voice", { ...target }, voice]);
      if (options.throwOn === "set-voice") throw new Error("set-voice failed");
      return true;
    },
    resetVoice: (target) => {
      calls.push(["reset-voice", { ...target }]);
      if (options.throwOn === "reset-voice") throw new Error("reset-voice failed");
      return true;
    },
    isPrioritized: () => prioritized,
    setPrioritized: (sessionId, value) => {
      calls.push(["prioritize", sessionId, value]);
      if (options.throwOn === "prioritize") throw new Error("prioritize failed");
      const changed = prioritized !== value;
      prioritized = value;
      return changed;
    },
    rename: (target, label) => {
      calls.push(["rename", { ...target }, label]);
      if (options.throwOn === "rename") throw new Error("rename failed");
      return label;
    },
    dismiss: (target) => {
      calls.push(["dismiss", { ...target }]);
      if (options.throwOn === "dismiss") throw new Error("dismiss failed");
      return true;
    },
    restore: (sessionId) => {
      calls.push(["restore", sessionId]);
      if (options.throwOn === "restore") throw new Error("restore failed");
      return true;
    },
  };
  const target: SessionActionsTarget = { sessionId: "session-a", label: "Alpha" };
  const lifecycle: string[] = [];
  const dispatchOptions: SessionCommandDispatchOptions = {
    controller,
    pause: {
      open: () => lifecycle.push("open"),
      close: () => lifecycle.push("close"),
    },
    targetForSessionId: (sessionId) => sessionId === target.sessionId
      ? { ...target }
      : null,
  };
  return { calls, controller, dispatchOptions, lifecycle, target };
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

  test("mode targets are scoped and legacy verbs normalize without forgetting", () => {
    const h = harness();
    dispatchSocketTurnEvent(turn({ type: "pause" }), h.callbacks);
    dispatchSocketTurnEvent(turn({ type: "resume" }), h.callbacks);
    dispatchSocketTurnEvent(turn({ type: "mute" }), h.callbacks);
    dispatchSocketTurnEvent(turn({ type: "unmute" }), h.callbacks);
    expect(h.paused).toEqual([
      ["session-a", true],
      ["session-a", false],
      ["session-a", true],
      ["session-a", false],
    ]);
    expect(h.queued).toEqual([]);

    const globalPause = turn({ type: "pause", sessionId: "", label: "" });
    const globalMute = turn({ type: "mute", sessionId: "", label: "" });
    dispatchSocketTurnEvent(globalPause, h.callbacks);
    dispatchSocketTurnEvent(globalMute, h.callbacks);
    expect(h.queued).toEqual([globalPause, { ...globalMute, type: "pause" }]);
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

  test("dismissed sessions are not audio or mode targets", () => {
    const h = harness();
    h.callbacks.isDismissedSession = (id) => id === "session-a";
    for (const type of ["wake", "recite", "pause"] as const) {
      dispatchSocketTurnEvent(turn({ type }), h.callbacks);
    }
    expect(h.instant).toEqual([]);
    expect(h.paused).toEqual([]);
    expect(h.queued).toEqual([]);
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

describe("session command dispatch", () => {
  const routes: Array<{
    message: SessionControlMessage;
    mutation: SessionActionMutation;
  }> = [
    {
      message: { kind: "session-command", sessionId: "session-a", command: "rename", label: "Beta" },
      mutation: { command: "rename", label: "Beta" },
    },
    {
      message: { kind: "session-command", sessionId: "session-a", command: "set-voice", voice: "af_heart" },
      mutation: { command: "set-voice", voice: "af_heart" },
    },
    {
      message: { kind: "session-command", sessionId: "session-a", command: "reset-voice" },
      mutation: { command: "reset-voice" },
    },
    {
      message: { kind: "session-command", sessionId: "session-a", command: "prioritize", value: true },
      mutation: { command: "prioritize", value: true },
    },
    {
      message: { kind: "session-command", sessionId: "session-a", command: "dismiss" },
      mutation: { command: "dismiss" },
    },
    {
      message: { kind: "session-command", sessionId: "session-a", command: "restore" },
      mutation: { command: "restore" },
    },
  ];

  test.each(routes)(
    "overlay adapter and socket use the identical controller call for $message.command",
    ({ message, mutation }) => {
      const overlay = sessionCommandHarness();
      invokeSessionAction(overlay.controller, overlay.target, mutation);

      const socket = sessionCommandHarness();
      const response = dispatchSessionControlMessage(message, socket.dispatchOptions);

      expect(response.kind).toBe("session-ack");
      expect(socket.calls).toEqual(overlay.calls);
      expect(socket.lifecycle).toEqual(["open", "close"]);
    },
  );

  test("every hostile input becomes a session-error without throwing or mutating", () => {
    const hostile: unknown[] = [
      null,
      {},
      { kind: "session-command", sessionId: "__proto__", command: "dismiss" },
      {
        kind: "session-command",
        sessionId: "session-a",
        command: "rename",
        label: "x".repeat(10_000_000),
      },
      {
        kind: "session-command",
        sessionId: "session-a",
        command: "rename",
        label: "bad\u0000label",
      },
      { kind: "session-command", sessionId: "session-a", command: "constructor" },
      {
        kind: "session-command",
        sessionId: "session-a",
        command: "set-voice",
        voice: "../../garbage voice",
      },
    ];
    const h = sessionCommandHarness();

    for (const value of hostile) {
      let response: ReturnType<typeof dispatchSessionControlMessage> | undefined;
      expect(() => {
        response = dispatchSessionControlMessage(value, h.dispatchOptions);
      }).not.toThrow();
      expect(response?.kind).toBe("session-error");
    }
    expect(h.calls).toEqual([]);
    expect(h.lifecycle).toEqual([]);
  });

  test("the control-family candidate gate returns a session error instead of falling into TurnEvent validation", () => {
    const configController: ConfigController = {
      handle: () => {
        throw new Error("config controller must not receive a session command");
      },
    };
    const dispatched = dispatchControlMessage(
      {
        kind: "session-command",
        sessionId: "session-a",
        command: "unknown",
      },
      configController,
      sessionCommandHarness().dispatchOptions,
    );

    expect(dispatched).toEqual({
      handled: true,
      response: {
        kind: "session-error",
        error: 'unknown session command "unknown"',
      },
    });
  });

  test.each(["prioritize", "dismiss"] as const)(
    "an already-pruned %s target is acknowledged as unchanged without mutation",
    (command) => {
      const h = sessionCommandHarness();
      h.dispatchOptions.targetForSessionId = () => null;
      const message: SessionControlMessage = command === "prioritize"
        ? {
          kind: "session-command",
          sessionId: "pruned-session",
          command,
          value: true,
        }
        : {
          kind: "session-command",
          sessionId: "pruned-session",
          command,
        };

      expect(dispatchSessionControlMessage(message, h.dispatchOptions)).toEqual({
        kind: "session-ack",
        sessionId: "pruned-session",
        command,
        changed: false,
      });
      expect(h.calls).toEqual([]);
      expect(h.lifecycle).toEqual(["open", "close"]);
    },
  );

  test("a throwing mutation still releases its silent pause and restores prior state", () => {
    let paused = false;
    const transitions: boolean[] = [];
    const coordinator = new SilentPauseCoordinator({
      get paused() {
        return paused;
      },
      setPaused(next) {
        paused = next;
        transitions.push(next);
      },
    });
    const lifecycle = new SettingsPauseLifecycle(coordinator);
    const h = sessionCommandHarness({ throwOn: "rename" });
    const response = dispatchSessionControlMessage(
      {
        kind: "session-command",
        sessionId: "session-a",
        command: "rename",
        label: "Beta",
      },
      { ...h.dispatchOptions, pause: lifecycle },
    );

    expect(response).toEqual({ kind: "session-error", error: "rename failed" });
    expect(transitions).toEqual([true, false]);
    expect(paused).toBeFalse();
  });

  test("restore changes visibility without coupling another mode", () => {
    const dismissed = new Set(["session-a"]);

    expect(restoreDismissedSessionState("session-a", dismissed)).toBeTrue();
    expect(dismissed).toEqual(new Set());
    expect(restoreDismissedSessionState("session-a", dismissed)).toBeFalse();
  });
});

test("inject events carry a session, a label, and the text to deliver", () => {
  // The phone's voice path. Full-shape on purpose: an inject with no text or
  // no target is not a request the daemon can honour safely.
  const good = validateSocketTurnEvent({
    type: "inject",
    sessionId: "abc",
    label: "dayloop",
    announce: "run the tests and report",
  });
  expect(good.ok).toBe(true);

  for (const missing of ["sessionId", "label", "announce"] as const) {
    const event: Record<string, unknown> = {
      type: "inject",
      sessionId: "abc",
      label: "dayloop",
      announce: "text",
    };
    delete event[missing];
    const result = validateSocketTurnEvent(event);
    expect(result.ok).toBe(false);
  }

  for (const empty of ["sessionId", "label", "announce"] as const) {
    const event: Record<string, unknown> = {
      type: "inject",
      sessionId: "abc",
      label: "dayloop",
      announce: "text",
      [empty]: "   ",
    };
    expect(validateSocketTurnEvent(event).ok).toBe(false);
  }
});
