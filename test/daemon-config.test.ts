import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  createConfigController,
  daemonStateFromUnknown,
  downgradeTurnWithLiveBackgroundWork,
  dispatchControlMessage,
  insertQueuedEvent,
  listenHooks,
  resolveWakeTarget,
  shouldHandleTurnAudibly,
  startsConversationByListening,
  takeNextQueuedEvent,
  TurnEventOrder,
  withoutDismissedSessions,
  pruneSessionCommandSets,
} from "../src/daemon.ts";
import { DictationReducer } from "../src/dictation-reducer.ts";
import type { TurnEvent } from "../src/hook.ts";
import { unsetSetting, writeSetting } from "../src/settings.ts";

const roots: string[] = [];

function fixture(settings: Record<string, unknown> = {}): { path: string } {
  const root = mkdtempSync(join(tmpdir(), "conch-daemon-config-test-"));
  roots.push(root);
  const path = join(root, "settings.json");
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return { path };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("legacy persisted quiet state migrates into lossless manual mode", () => {
  expect(daemonStateFromUnknown({ muted: true, paused: false })).toEqual({ paused: true });
  expect(daemonStateFromUnknown({ muted: false, paused: true })).toEqual({ paused: true });
  expect(daemonStateFromUnknown({ muted: false, paused: false })).toEqual({ paused: false });
  expect(daemonStateFromUnknown(null)).toEqual({ paused: false });
});

describe("daemon listen status hooks", () => {
  test("live transcript hooks join only reducer-kept segments with the current partial", () => {
    const reducer = new DictationReducer({ holdSubmit: true });
    reducer.consume({ type: "transcript", sequence: 1, text: "first kept segment" });
    reducer.consume({ type: "transcript", sequence: 2, text: "second kept segment" });
    reducer.consume({ type: "transcript", sequence: 3, text: "repeat" });

    let prefix = "stale prior turn";
    let partial = "";
    const calls: string[] = [];
    const hooks = listenHooks(
      "alpha",
      () => reducer.snapshot.buffer.map((segment) => segment.text).join(" "),
      {
        setState(state, label, text = "") {
          calls.push(`state:${state}:${label}:${text}`);
          partial = text;
        },
        setTranscriptPrefix(text) {
          calls.push(`prefix:${text}`);
          prefix = text;
        },
      },
    );

    hooks.onState?.("capturing");
    hooks.onPartial?.("current live words");

    expect(`${prefix ? `${prefix} ` : ""}${partial}`).toBe(
      "first kept segment second kept segment current live words",
    );
    expect(prefix).not.toContain("repeat");
    expect(calls).toEqual([
      "prefix:first kept segment second kept segment",
      "prefix:first kept segment second kept segment",
      "state:recording:alpha:",
      "state:recording:alpha:current live words",
      "prefix:first kept segment second kept segment",
    ]);
  });

  test("discard commands and empty final transcripts never enter the live prefix", () => {
    const reducer = new DictationReducer({ holdSubmit: true });
    reducer.consume({ type: "transcript", sequence: 1, text: "discarded draft" });
    reducer.consume({ type: "transcript", sequence: 2, text: "cancel" });
    reducer.consume({ type: "transcript", sequence: 3, text: "" });

    let prefix = "stale prior turn";
    let partial = "";
    const hooks = listenHooks(
      "alpha",
      () => reducer.snapshot.buffer.map((segment) => segment.text).join(" "),
      {
        setState(_state, _label, text = "") {
          partial = text;
        },
        setTranscriptPrefix(text) {
          prefix = text;
        },
      },
    );

    hooks.onPartial?.("replacement words");

    expect(`${prefix ? `${prefix} ` : ""}${partial}`).toBe("replacement words");
    expect(prefix).not.toContain("discarded draft");
    expect(prefix).not.toContain("cancel");
  });

  test("between captures the words just said stay on screen until their transcript joins the prefix", () => {
    // 2026-11-11: the next recorder arms before the last one is transcribed;
    // clearing its partial there made the sentence vanish mid-dictation.
    const reducer = new DictationReducer({ holdSubmit: true });
    let prefix = "";
    let state = "";
    let partial = "";
    const hooks = listenHooks(
      "alpha",
      () => reducer.snapshot.buffer.map((segment) => segment.text).join(" "),
      {
        setState(next, _label, text = "") {
          state = next;
          partial = text;
        },
        setTranscriptPrefix(text) {
          prefix = text;
        },
      },
    );
    const screen = (): string => [prefix, partial].filter(Boolean).join(" ");

    hooks.onState?.("armed");
    hooks.onState?.("capturing");
    hooks.onPartial?.("the first thought");
    // The capture ends at a pause; its successor arms while it is transcribed.
    hooks.onState?.("armed");
    expect(state).toBe("listening");
    expect(screen()).toBe("the first thought");
    // Its transcript is held: the prefix carries it and the stand-in goes, in one step.
    reducer.consume({ type: "transcript", sequence: 1, text: "The first thought." });
    hooks.settle();
    expect(screen()).toBe("The first thought.");
    expect(partial).toBe("");
    // The next capture's partial joins after it, and the final drain keeps both.
    hooks.onState?.("capturing");
    hooks.onPartial?.("and the second");
    expect(screen()).toBe("The first thought. and the second");
    hooks.onState?.("transcribing");
    expect(state).toBe("transcribing");
    expect(screen()).toBe("The first thought. and the second");
    reducer.consume({ type: "transcript", sequence: 2, text: "And the second." });
    hooks.settle();
    expect(screen()).toBe("The first thought. And the second.");
  });

  test("footer listen hooks never call the theater-only prefix sink", () => {
    const calls: string[] = [];
    const hooks = listenHooks("permission", undefined, {
      setState(state, label, partial = "") {
        calls.push(`state:${state}:${label}:${partial}`);
      },
      setTranscriptPrefix(prefix) {
        calls.push(`prefix:${prefix}`);
      },
    });

    hooks.onState?.("armed");
    hooks.onPartial?.("yes");

    expect(calls).toEqual([
      "state:listening:permission:",
      "state:recording:permission:yes",
    ]);
  });

});

describe("daemon config controller", () => {
  test("an untargeted wake after turn-end starts by listening without re-reading", () => {
    const wake: TurnEvent = { type: "wake", sessionId: "", label: "", announce: "" };
    const turnEnd: TurnEvent = {
      type: "turn-end",
      sessionId: "session-a",
      label: "alpha",
      announce: "alpha: finished response",
      transcriptPath: "/tmp/alpha.jsonl",
      mark: 3,
    };

    const resolved = resolveWakeTarget(wake, turnEnd);

    expect(resolved).toEqual({ ...turnEnd, type: "wake" });
    expect(resolved).not.toBe(turnEnd);
    expect(startsConversationByListening(resolved!)).toBe(true);
    expect(startsConversationByListening(turnEnd)).toBe(false);
  });

  test("an explicitly targeted wake wins over lastTurn and an empty wake stays empty", () => {
    const targeted: TurnEvent = {
      type: "wake",
      sessionId: "session-b",
      label: "beta",
      announce: "",
      transcriptPath: "/tmp/beta.jsonl",
    };
    const lastTurn: TurnEvent = {
      type: "turn-end",
      sessionId: "session-a",
      label: "alpha",
      announce: "alpha: done",
    };

    expect(resolveWakeTarget(targeted, lastTurn)).toEqual(targeted);
    expect(resolveWakeTarget({ ...targeted, sessionId: "", label: "" }, null)).toBeNull();
  });

  test("handoff-order picks newest, oldest, and urgency from a mixed session queue", () => {
    const waiting: TurnEvent = { type: "turn-end", sessionId: "waiting", label: "waiting", announce: "" };
    const needs: TurnEvent = { type: "needs-you", sessionId: "needs", label: "needs", announce: "" };
    const working: TurnEvent = { type: "working", sessionId: "working", label: "working", announce: "" };
    const drained = (order: "newest" | "oldest" | "urgency"): string[] => {
      const queue = [waiting, needs, working];
      const picked = [
        takeNextQueuedEvent(queue, order),
        takeNextQueuedEvent(queue, order),
        takeNextQueuedEvent(queue, order),
      ];
      expect(queue).toHaveLength(0);
      return picked.map((event) => event!.sessionId);
    };

    expect(drained("newest")).toEqual(["working", "needs", "waiting"]);
    expect(drained("oldest")).toEqual(["waiting", "needs", "working"]);
    expect(drained("urgency")).toEqual(["needs", "waiting", "working"]);
  });

  test("urgency breaks equal-status ties by recency and keeps imperative events as barriers", () => {
    const olderNeeds: TurnEvent = { type: "needs-you", sessionId: "needs-a", label: "a", announce: "" };
    const newerNeeds: TurnEvent = { type: "needs-you", sessionId: "needs-b", label: "b", announce: "" };
    const wake: TurnEvent = { type: "wake", sessionId: "target", label: "target", announce: "" };

    expect(takeNextQueuedEvent([olderNeeds, newerNeeds], "urgency")).toBe(newerNeeds);
    expect(takeNextQueuedEvent([olderNeeds, wake], "oldest")).toBe(wake);
    expect(takeNextQueuedEvent([olderNeeds, wake], "urgency")).toBe(wake);
  });

  test("distinct queued phone injects are append-only and never coalesced", () => {
    const first: TurnEvent = {
      type: "inject",
      sessionId: "target",
      label: "target",
      announce: "first dictated prompt",
    };
    const second: TurnEvent = {
      ...first,
      announce: "second dictated prompt",
    };
    const queue: TurnEvent[] = [];

    expect(insertQueuedEvent(queue, first)).toBeTrue();
    expect(insertQueuedEvent(queue, second)).toBeTrue();
    expect(queue).toEqual([first, second]);
  });

  test("oldest and urgency reorder only the state cohort newer than the latest command", () => {
    const olderWaiting: TurnEvent = { type: "turn-end", sessionId: "old", label: "old", announce: "" };
    const wake: TurnEvent = { type: "wake", sessionId: "target", label: "target", announce: "" };
    const newerWorking: TurnEvent = { type: "working", sessionId: "work", label: "work", announce: "" };
    const newestNeeds: TurnEvent = { type: "needs-you", sessionId: "need", label: "need", announce: "" };
    const drained = (order: "oldest" | "urgency"): string[] => {
      const queue = [olderWaiting, wake, newerWorking, newestNeeds];
      const ids: string[] = [];
      while (queue.length) ids.push(takeNextQueuedEvent(queue, order)!.sessionId);
      return ids;
    };

    expect(drained("oldest")).toEqual(["work", "need", "target", "old"]);
    expect(drained("urgency")).toEqual(["need", "work", "target", "old"]);
  });

  test("newest fast path honors priority inside the eligible state cohort", () => {
    const priorityOlder: TurnEvent = {
      type: "turn-end",
      sessionId: "priority",
      label: "priority",
      announce: "",
    };
    const normalNewest: TurnEvent = {
      type: "needs-you",
      sessionId: "normal",
      label: "normal",
      announce: "",
    };
    const queue = [priorityOlder, normalNewest];

    expect(takeNextQueuedEvent(queue, "newest", new Set(["priority"]))).toBe(priorityOlder);
    expect(queue).toEqual([normalNewest]);
  });

  test("dismiss filtering and transient-set pruning use complete registry truth", () => {
    const sessions = [
      { sessionId: "visible", name: "visible" },
      { sessionId: "hidden", name: "hidden" },
    ];
    const prioritized = new Set(["visible", "gone"]);
    const dismissed = new Set(["hidden", "gone"]);

    expect(withoutDismissedSessions(sessions, dismissed).map((session) => session.sessionId))
      .toEqual(["visible"]);

    pruneSessionCommandSets({
      complete: false,
      liveIds: new Set(["visible"]),
    }, prioritized, dismissed);
    expect(prioritized).toEqual(new Set(["visible", "gone"]));
    expect(dismissed).toEqual(new Set(["hidden", "gone"]));

    pruneSessionCommandSets({
      complete: true,
      liveIds: new Set(["visible", "hidden"]),
    }, prioritized, dismissed);
    expect(prioritized).toEqual(new Set(["visible"]));
    expect(dismissed).toEqual(new Set(["hidden"]));
  });

  test("working-mic only makes Stop-reclassified working events audible", () => {
    const turnEnd = { type: "turn-end" as const };
    const submitted = { type: "working" as const };
    const background = { type: "working" as const, backgroundWork: true as const };

    expect(shouldHandleTurnAudibly(turnEnd, false)).toBe(true);
    expect(shouldHandleTurnAudibly(background, false)).toBe(false);
    expect(shouldHandleTurnAudibly(background, true)).toBe(true);
    expect(shouldHandleTurnAudibly(submitted, true)).toBe(false);
  });

  test("live background work downgrades a turn end by mutating the same event", () => {
    const event: TurnEvent = {
      type: "turn-end",
      sessionId: "session-a",
      label: "alpha",
      announce: "alpha: finished response",
      transcriptPath: "/tmp/alpha.jsonl",
      mark: 3,
      eventAt: 2_000,
    };

    const downgraded = downgradeTurnWithLiveBackgroundWork(event, true);

    expect(downgraded).toBe(event);
    expect(event).toEqual({
      type: "working",
      sessionId: "session-a",
      label: "alpha",
      announce: "alpha: finished response",
      transcriptPath: "/tmp/alpha.jsonl",
      mark: 3,
      eventAt: 2_000,
      backgroundWork: true,
    });
  });

  test("review turns bypass the live-work downgrade while ordinary turns still mutate", () => {
    const review: TurnEvent = {
      type: "turn-end",
      sessionId: "session-review",
      label: "review",
      announce: "review has work ready for your review: inspect the result",
      review: {
        summary: "inspect the result",
        link: "https://example.com/review",
      },
    };
    const ordinary: TurnEvent = {
      type: "turn-end",
      sessionId: "session-ordinary",
      label: "ordinary",
      announce: "ordinary: finished response",
    };

    expect(downgradeTurnWithLiveBackgroundWork(review, true)).toBe(review);
    expect(review.type).toBe("turn-end");
    expect(review.backgroundWork).toBeUndefined();

    expect(downgradeTurnWithLiveBackgroundWork(ordinary, true)).toBe(ordinary);
    expect(ordinary.type).toBe("working");
    expect(ordinary.backgroundWork).toBe(true);
  });

  test("a turn end with no live background work remains untouched", () => {
    const event: TurnEvent = {
      type: "turn-end",
      sessionId: "session-a",
      label: "alpha",
      announce: "alpha: done",
      eventAt: 2_000,
    };
    const before = { ...event };

    const unchanged = downgradeTurnWithLiveBackgroundWork(event, false);

    expect(unchanged).toBe(event);
    expect(event).toEqual(before);
    expect(event.backgroundWork).toBeUndefined();
  });

  test("wake, needs-you, and working events remain unchanged regardless of live-work detection", () => {
    const events: TurnEvent[] = [
      { type: "wake", sessionId: "session-a", label: "alpha", announce: "" },
      { type: "needs-you", sessionId: "session-a", label: "alpha", announce: "", ntype: "idle_prompt" },
      { type: "working", sessionId: "session-a", label: "alpha", announce: "" },
    ];

    for (const event of events) {
      const before = { ...event };
      expect(downgradeTurnWithLiveBackgroundWork(event, false)).toBe(event);
      expect(event).toEqual(before);
      expect(downgradeTurnWithLiveBackgroundWork(event, true)).toBe(event);
      expect(event).toEqual(before);
    }
  });

  test("working-mic composes with a daemon-time live-work downgrade", () => {
    const event: TurnEvent = {
      type: "turn-end",
      sessionId: "session-a",
      label: "alpha",
      announce: "alpha: done",
    };

    const downgraded = downgradeTurnWithLiveBackgroundWork(event, true);

    expect(shouldHandleTurnAudibly(downgraded, false)).toBe(false);
    expect(shouldHandleTurnAudibly(downgraded, true)).toBe(true);
  });

  test("event-time arbitration suppresses stale state and working-mic audio before LIFO handling", () => {
    const order = new TurnEventOrder();
    const newerTurnEnd = { type: "turn-end" as const, sessionId: "session", eventAt: 2_000 };
    const olderWorking = { type: "working" as const, sessionId: "session", eventAt: 1_000 };

    expect(order.accept(newerTurnEnd)).toBe(true);
    expect(order.accept(olderWorking)).toBe(false);
    expect(order.isCurrent(newerTurnEnd)).toBe(true);
    expect(order.isCurrent(olderWorking) && shouldHandleTurnAudibly({ ...olderWorking, backgroundWork: true }, true))
      .toBe(false);
  });

  test("a newer same-type event invalidates its older queued predecessor", () => {
    const order = new TurnEventOrder();
    const older = { type: "working" as const, sessionId: "session", eventAt: 1_000 };
    const newer = { type: "working" as const, sessionId: "session", eventAt: 2_000 };

    expect(order.accept(older)).toBe(true);
    expect(order.accept(newer)).toBe(true);
    expect(order.isCurrent(older)).toBe(false);
    expect(order.isCurrent(newer)).toBe(true);
    expect(order.accept({ ...older })).toBe(false); // delayed older hook cannot evict newer
  });

  test("an untimestamped legacy state cannot supersede timestamped truth", () => {
    const order = new TurnEventOrder();
    const timestamped = { type: "turn-end" as const, sessionId: "session", eventAt: 2_000 };
    expect(order.accept(timestamped)).toBe(true);
    expect(order.accept({ type: "working", sessionId: "session" })).toBe(false);
  });

  test("event ordering prunes closed sessions while preserving live sessions", () => {
    const order = new TurnEventOrder();
    const live = { type: "turn-end" as const, sessionId: "live", eventAt: 2_000 };
    const closed = { type: "turn-end" as const, sessionId: "closed", eventAt: 2_000 };

    expect(order.accept(live)).toBe(true);
    expect(order.accept(closed)).toBe(true);
    order.prune(new Set(["live"]));

    expect(order.isCurrent(live)).toBe(true);
    expect(order.isCurrent(closed)).toBe(false);
    expect(order.accept({ ...closed, eventAt: 1_000 })).toBe(true);
  });

  test("applies a live set by mutating the shared Config object in place", () => {
    const { path } = fixture();
    const env = {};
    const cfg = loadConfig({ env, settingsPath: path });
    const shared = cfg;
    const controller = createConfigController(cfg, { env, settingsPath: path });
    writeSetting(path, "end-silence", 5.25);

    const reply = controller.handle({
      kind: "set-config",
      key: "end-silence",
      value: 5.25,
    });

    expect(cfg).toBe(shared);
    expect(cfg.endSilenceSecs).toBe(5.25);
    expect(reply).toMatchObject({
      kind: "config-ack",
      key: "end-silence",
      action: "set",
      status: "applied",
      effective: 5.25,
      source: "file",
    });
  });

  test("applies and unsets meeting-autopause live and reports the effective boolean", () => {
    const { path } = fixture();
    const env = {};
    const cfg = loadConfig({ env, settingsPath: path });
    const changes: Array<{ key: string; value: unknown }> = [];
    const controller = createConfigController(cfg, {
      env,
      settingsPath: path,
      onLiveChange(key, value) {
        changes.push({ key, value });
      },
    });
    expect(cfg.meetingAutopause).toBe(false);

    writeSetting(path, "meeting-autopause", true);
    const setReply = controller.handle({
      kind: "set-config",
      key: "meeting-autopause",
      value: true,
    });

    expect(cfg.meetingAutopause).toBe(true);
    expect(setReply).toMatchObject({
      kind: "config-ack",
      key: "meeting-autopause",
      status: "applied",
      effective: true,
      source: "file",
    });

    unsetSetting(path, "meeting-autopause");
    const unsetReply = controller.handle({
      kind: "unset-config",
      key: "meeting-autopause",
    });

    expect(cfg.meetingAutopause).toBe(false);
    expect(unsetReply).toMatchObject({
      kind: "config-ack",
      key: "meeting-autopause",
      action: "unset",
      status: "applied",
      effective: false,
      source: "default",
    });
    expect(changes).toEqual([
      { key: "meeting-autopause", value: true },
      { key: "meeting-autopause", value: false },
    ]);
  });

  test("reports an env-masked set and retains the daemon's env value", () => {
    const { path } = fixture();
    const env = { CONCH_END_SILENCE_SECS: "7" };
    const cfg = loadConfig({ env, settingsPath: path });
    const controller = createConfigController(cfg, { env, settingsPath: path });
    writeSetting(path, "end-silence", 5.25);

    const reply = controller.handle({
      kind: "set-config",
      key: "end-silence",
      value: 5.25,
    });

    expect(cfg.endSilenceSecs).toBe(7);
    expect(reply).toMatchObject({
      kind: "config-ack",
      status: "masked",
      effective: 7,
      source: "env",
      env: "CONCH_END_SILENCE_SECS",
    });
  });

  test("skips an invalid daemon env and applies the valid saved value with a diagnostic", () => {
    const { path } = fixture();
    const env = { CONCH_END_SILENCE_SECS: "not-a-number" };
    const cfg = loadConfig({ env, settingsPath: path });
    const controller = createConfigController(cfg, { env, settingsPath: path });
    writeSetting(path, "end-silence", 5.25);

    const reply = controller.handle({
      kind: "set-config",
      key: "end-silence",
      value: 5.25,
    });

    expect(cfg.endSilenceSecs).toBe(5.25);
    expect(reply).toMatchObject({
      kind: "config-ack",
      status: "applied",
      effective: 5.25,
      source: "file",
    });
    expect(reply.diagnostic).toContain("CONCH_END_SILENCE_SECS");
  });

  test("does not mutate hook-only fields and labels them for the next hook", () => {
    const { path } = fixture();
    const env = {};
    const cfg = loadConfig({ env, settingsPath: path });
    expect(cfg.speakSentences).toBe(2);
    const controller = createConfigController(cfg, { env, settingsPath: path });
    writeSetting(path, "announce-sentences", 5);

    const reply = controller.handle({
      kind: "set-config",
      key: "announce-sentences",
      value: 5,
    });

    expect(cfg.speakSentences).toBe(2);
    expect(reply).toMatchObject({
      kind: "config-ack",
      status: "hook-next",
      effective: 5,
      source: "file",
    });
    expect(reply.diagnostic).toContain("next hook");
  });

  test("snapshot uses daemon truth for live keys and file truth with a caveat for hook keys", () => {
    const { path } = fixture({
      "end-silence": 5.25,
      "announce-sentences": 4,
    });
    const env = { CONCH_SPEAK_SENTENCES: "9" };
    const cfg = loadConfig({ env, settingsPath: path });
    cfg.endSilenceSecs = 6.5; // prove live snapshot comes from current memory

    const reply = createConfigController(cfg, { env, settingsPath: path }).handle({ kind: "get-config" });
    expect(reply.kind).toBe("config-snapshot");
    if (reply.kind !== "config-snapshot") throw new Error("expected config snapshot");
    expect(reply.snapshot["end-silence"]).toMatchObject({ value: 6.5 });
    expect(reply.snapshot["announce-sentences"]).toMatchObject({ value: 4, source: "file" });
    expect(reply.snapshot["announce-sentences"].diagnostic).toContain("next hook");
    expect(reply.snapshot["announce-sentences"].diagnostic).toContain("CONCH_SPEAK_SENTENCES");
  });

  test("socket-boundary dispatch handles control candidates before TurnEvent traffic", () => {
    const { path } = fixture();
    const cfg = loadConfig({ env: {}, settingsPath: path });
    const controller = createConfigController(cfg, { env: {}, settingsPath: path });

    expect(dispatchControlMessage({
      type: "mute",
      sessionId: "",
      label: "",
      announce: "",
    }, controller)).toEqual({ handled: false });
    expect(dispatchControlMessage({
      kind: "set-config",
      key: "barge-threshold",
      value: 101,
    }, controller)).toMatchObject({
      handled: true,
      response: { kind: "config-error" },
    });
  });

  test("socket-boundary config mutations persist set and unset before applying live", () => {
    const { path } = fixture({ "end-silence": 4 });
    const cfg = loadConfig({ env: {}, settingsPath: path });
    const controller = createConfigController(cfg, { env: {}, settingsPath: path });
    const persistence = {
      settingsPath: path,
      set: writeSetting,
      unset: unsetSetting,
    };

    expect(dispatchControlMessage({
      kind: "set-config",
      key: "end-silence",
      value: 5.25,
    }, controller, undefined, persistence)).toMatchObject({
      handled: true,
      response: {
        kind: "config-ack",
        action: "set",
        status: "applied",
        effective: 5.25,
        source: "file",
      },
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      "end-silence": 5.25,
    });
    expect(cfg.endSilenceSecs).toBe(5.25);

    expect(dispatchControlMessage({
      kind: "unset-config",
      key: "end-silence",
    }, controller, undefined, persistence)).toMatchObject({
      handled: true,
      response: {
        kind: "config-ack",
        action: "unset",
        status: "applied",
        effective: 3.5,
        source: "default",
      },
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("end-silence");
    expect(cfg.endSilenceSecs).toBe(3.5);
  });

  test("socket-boundary persistence failure returns an error without changing live config", () => {
    const { path } = fixture({ "end-silence": 4 });
    const cfg = loadConfig({ env: {}, settingsPath: path });
    const controller = createConfigController(cfg, { env: {}, settingsPath: path });
    const response = dispatchControlMessage({
      kind: "set-config",
      key: "end-silence",
      value: 6,
    }, controller, undefined, {
      settingsPath: path,
      set: () => {
        throw new Error("disk is read-only");
      },
      unset: unsetSetting,
    });

    expect(response).toEqual({
      handled: true,
      response: {
        kind: "config-error",
        error: "not saved: disk is read-only",
      },
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      "end-silence": 4,
    });
    expect(cfg.endSilenceSecs).toBe(4);
  });
});
