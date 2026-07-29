import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  createConfigController,
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
const daemonSource = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");

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

  test("an instant recite stays next while a later state event arrives during cleanup", () => {
    const recite: TurnEvent = {
      type: "recite",
      sessionId: "target",
      label: "target",
      announce: "",
    };
    const laterTurn: TurnEvent = {
      type: "turn-end",
      sessionId: "later",
      label: "later",
      announce: "later: finished",
    };
    const instantBarriers = new WeakSet<TurnEvent>([recite]);
    const queue: TurnEvent[] = [];

    insertQueuedEvent(queue, recite, instantBarriers);
    insertQueuedEvent(queue, laterTurn, instantBarriers);

    expect(queue).toEqual([laterTurn, recite]);
    expect(takeNextQueuedEvent(queue, "newest")).toBe(recite);
    expect(takeNextQueuedEvent(queue, "newest")).toBe(laterTurn);
  });

  test("mode acknowledgements retain priority over a protected instant takeover", () => {
    const recite: TurnEvent = {
      type: "recite",
      sessionId: "target",
      label: "target",
      announce: "",
    };
    const pause: TurnEvent = {
      type: "pause",
      sessionId: "",
      label: "",
      announce: "",
    };
    const laterTurn: TurnEvent = {
      type: "turn-end",
      sessionId: "later",
      label: "later",
      announce: "later: finished",
    };
    const instantBarriers = new WeakSet<TurnEvent>([recite]);
    const queue: TurnEvent[] = [];

    insertQueuedEvent(queue, recite, instantBarriers);
    insertQueuedEvent(queue, pause, instantBarriers);
    insertQueuedEvent(queue, laterTurn, instantBarriers);

    expect(queue).toEqual([laterTurn, recite, pause]);
    expect(takeNextQueuedEvent(queue, "newest")).toBe(pause);
    expect(takeNextQueuedEvent(queue, "newest")).toBe(recite);
    expect(takeNextQueuedEvent(queue, "newest")).toBe(laterTurn);
  });

  test("an ordinary duplicate cannot dislodge a protected instant takeover", () => {
    const protectedRecite: TurnEvent = {
      type: "recite",
      sessionId: "target",
      label: "target",
      announce: "",
    };
    const ordinaryDuplicate: TurnEvent = {
      ...protectedRecite,
      announce: "ordinary socket duplicate",
    };
    const laterWake: TurnEvent = {
      type: "wake",
      sessionId: "other",
      label: "other",
      announce: "",
    };
    const instantBarriers = new WeakSet<TurnEvent>([protectedRecite]);
    const queue: TurnEvent[] = [];

    expect(insertQueuedEvent(queue, protectedRecite, instantBarriers)).toBeTrue();
    expect(insertQueuedEvent(queue, ordinaryDuplicate, instantBarriers)).toBeFalse();
    expect(insertQueuedEvent(queue, laterWake, instantBarriers)).toBeTrue();

    expect(queue).toEqual([laterWake, protectedRecite]);
    expect(takeNextQueuedEvent(queue, "newest")).toBe(protectedRecite);
    expect(takeNextQueuedEvent(queue, "newest")).toBe(laterWake);
  });

  test("a cancelled takeover may be superseded by a later ordinary duplicate", () => {
    const cancelledRecite: TurnEvent = {
      type: "recite",
      sessionId: "target",
      label: "target",
      announce: "",
    };
    const laterRecite: TurnEvent = {
      ...cancelledRecite,
      announce: "later explicit command",
    };
    const instantBarriers = new WeakSet<TurnEvent>([cancelledRecite]);
    const queue: TurnEvent[] = [];

    insertQueuedEvent(queue, cancelledRecite, instantBarriers);
    instantBarriers.delete(cancelledRecite);
    expect(insertQueuedEvent(queue, laterRecite, instantBarriers)).toBeTrue();

    expect(queue).toEqual([laterRecite]);
    expect(takeNextQueuedEvent(queue, "newest")).toBe(laterRecite);
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

  test("LIFO barrier holds under priority", () => {
    const prioritizedOld: TurnEvent = {
      type: "turn-end",
      sessionId: "priority",
      label: "priority",
      announce: "",
    };
    const wake: TurnEvent = {
      type: "wake",
      sessionId: "target",
      label: "target",
      announce: "",
    };
    const normalNew: TurnEvent = {
      type: "working",
      sessionId: "normal",
      label: "normal",
      announce: "",
    };
    const queue = [prioritizedOld, wake, normalNew];
    const priority = new Set(["priority"]);

    expect(takeNextQueuedEvent(queue, "newest", priority)).toBe(normalNew);
    expect(takeNextQueuedEvent(queue, "newest", priority)).toBe(wake);
    expect(takeNextQueuedEvent(queue, "newest", priority)).toBe(prioritizedOld);
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

    const render = daemonSource.slice(
      daemonSource.indexOf("async function renderSessionPanel"),
      daemonSource.indexOf("function setSessionState"),
    );
    const completePrune = render.slice(
      render.indexOf("if (snap?.complete)"),
      render.indexOf("const live ="),
    );
    const closedCleanup = daemonSource.slice(
      daemonSource.indexOf("&& sessionGoneFromSnapshot("),
      daemonSource.indexOf("if (shuttingDown || interruptedByPause()"),
    );
    const dismiss = daemonSource.slice(
      daemonSource.indexOf("dismiss: (target)"),
      daemonSource.indexOf("onOpen:", daemonSource.indexOf("dismiss: (target)")),
    );
    expect(render).toContain(
      "withoutDismissedSessions(registryLive, dismissedSessionIds)",
    );
    expect(render).toContain("...prioritizedSessionIds");
    expect(render).toContain("...dismissedSessionIds");
    expect(completePrune).toContain("...pending.keys()");
    expect(completePrune).toContain("pending.delete(id)");
    expect(completePrune).toContain("eventOrder.prune(liveIds)");
    expect(closedCleanup).toContain("pending.delete(event.sessionId)");
    expect(dismiss.indexOf("dismissedSessionIds.add(target.sessionId)")).toBeLessThan(
      dismiss.indexOf("instantControls.setSessionMuted(target.sessionId, true)"),
    );
    expect(daemonSource).toContain("dismissedSessionIds.delete(event.sessionId)");
  });

  test("recite routes through the existing reader without a bell or responded guard", () => {
    const branch = daemonSource.slice(
      daemonSource.indexOf('if (event.type === "recite")'),
      daemonSource.indexOf('if (event.type === "wake")', daemonSource.indexOf('if (event.type === "recite")')),
    );

    expect(branch).toContain("lastAssistantText(target.transcriptPath)");
    expect(branch).toContain("await speak(cfg, `${target.label}:`, target.label)");
    expect(branch).toContain("await conversationLoop(");
    expect(branch).toContain("false,\n          pauseGeneration");
    expect(branch).not.toContain("ringBell");
    expect(branch).not.toContain("userRespondedSince");

    const conversation = daemonSource.slice(
      daemonSource.indexOf("async function conversationLoop"),
      daemonSource.indexOf("async function permissionLoop"),
    );
    expect(conversation).toContain('const reciteOnly = event.type === "recite"');
    expect(conversation).toContain("&& (cfg.readFull || reciteOnly)");
    expect(conversation).toContain("const gapSecs = reciteOnly");
    expect(conversation.indexOf("if (reciteOnly) return")).toBeLessThan(
      conversation.indexOf("const reducer = new DictationReducer"),
    );
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

    const handleTurn = daemonSource.slice(
      daemonSource.indexOf("async function handleTurn"),
      daemonSource.indexOf("/**\n   * Speak with the barge-in recorder"),
    );
    const refreshAt = handleTurn.indexOf("sessionHasLiveBackgroundWork(event.transcriptPath)");
    const audibleAt = handleTurn.indexOf("const audibleTurn = shouldHandleTurnAudibly");
    expect(refreshAt).toBeGreaterThan(-1);
    expect(audibleAt).toBeGreaterThan(refreshAt);
    expect(handleTurn).toContain("downgradeTurnWithLiveBackgroundWork(event, true)");
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

    const wakeBranch = daemonSource.slice(
      daemonSource.indexOf('if (event.type === "wake")'),
      daemonSource.indexOf("recitingEvent = event;"),
    );
    expect(wakeBranch).toContain("const targetGone = sessionGoneFromSnapshot(");
    expect(wakeBranch).toContain("target.sessionId");
    expect(wakeBranch).toContain("if (consumeStopKey()) return");
    expect(wakeBranch).toContain("if (targetGone)");

    const handleEntry = daemonSource.slice(
      daemonSource.indexOf("async function handleTurn"),
      daemonSource.indexOf('if (event.type === "wake")'),
    );
    const audibleAt = handleEntry.indexOf("const audibleTurn = shouldHandleTurnAudibly");
    const closedAt = handleEntry.indexOf("&& sessionGoneFromSnapshot(");
    const statusAt = handleEntry.indexOf("// Dashboard status");
    expect(closedAt).toBeGreaterThan(audibleAt);
    expect(statusAt).toBeGreaterThan(closedAt);
    expect(handleEntry).toContain("event.sessionId");
    expect(handleEntry).toContain("if (shuttingDown || interruptedByPause() || consumeStopKey()) return");

    const micGate = daemonSource.slice(
      daemonSource.indexOf("// Mic gate (auto turns only)"),
      daemonSource.indexOf("if (!initialDictationCapture && !deferredInitialExternal)"),
    );
    expect(micGate).toContain("const gone = sessionGoneFromSnapshot(");
    expect(micGate).toContain("event.sessionId");
    expect(micGate).toContain("activelyTyping || responded || gone");
  });

  test("live-work downgrade preserves WeakSet identity", () => {
    const event: TurnEvent = {
      type: "turn-end",
      sessionId: "session-a",
      label: "alpha",
      announce: "alpha: done",
    };
    const forgotten = new WeakSet<TurnEvent>([event]);

    const downgraded = downgradeTurnWithLiveBackgroundWork(event, true);

    expect(forgotten.has(downgraded)).toBeTrue();
    expect(forgotten.delete(downgraded)).toBeTrue();
    expect(forgotten.has(event)).toBeFalse();
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

  test("socket data stops buffering after the first message is handled", () => {
    const dataHandler = daemonSource.slice(
      daemonSource.indexOf('sock.on("data", (data) => {'),
      daemonSource.indexOf('sock.on("end", () => {'),
    );

    expect(dataHandler).toContain("if (handled) return;");
    expect(dataHandler.indexOf("if (handled) return;")).toBeLessThan(
      dataHandler.indexOf("buf += data.toString();"),
    );
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

  test("applies and unsets working-mic live", () => {
    const { path } = fixture();
    const env = {};
    const cfg = loadConfig({ env, settingsPath: path });
    const controller = createConfigController(cfg, { env, settingsPath: path });
    expect(cfg.workingMic).toBe(false);

    writeSetting(path, "working-mic", true);
    const setReply = controller.handle({
      kind: "set-config",
      key: "working-mic",
      value: true,
    });

    expect(cfg.workingMic).toBe(true);
    expect(setReply).toMatchObject({
      kind: "config-ack",
      key: "working-mic",
      status: "applied",
      effective: true,
      source: "file",
    });

    unsetSetting(path, "working-mic");
    const unsetReply = controller.handle({ kind: "unset-config", key: "working-mic" });

    expect(cfg.workingMic).toBe(false);
    expect(unsetReply).toMatchObject({
      kind: "config-ack",
      key: "working-mic",
      action: "unset",
      status: "applied",
      effective: false,
      source: "default",
    });
  });

  test("applies and unsets interrupt-on-manual-reply live", () => {
    const { path } = fixture();
    const env = {};
    const cfg = loadConfig({ env, settingsPath: path });
    const controller = createConfigController(cfg, { env, settingsPath: path });
    expect(cfg.interruptOnManualReply).toBe(true);

    writeSetting(path, "interrupt-on-manual-reply", false);
    const setReply = controller.handle({
      kind: "set-config",
      key: "interrupt-on-manual-reply",
      value: false,
    });

    expect(cfg.interruptOnManualReply).toBe(false);
    expect(setReply).toMatchObject({
      kind: "config-ack",
      key: "interrupt-on-manual-reply",
      status: "applied",
      effective: false,
      source: "file",
    });

    unsetSetting(path, "interrupt-on-manual-reply");
    const unsetReply = controller.handle({ kind: "unset-config", key: "interrupt-on-manual-reply" });

    expect(cfg.interruptOnManualReply).toBe(true);
    expect(unsetReply).toMatchObject({
      kind: "config-ack",
      key: "interrupt-on-manual-reply",
      action: "unset",
      status: "applied",
      effective: true,
      source: "default",
    });
  });

  test("applies and unsets handoff-order live", () => {
    const { path } = fixture();
    const env = {};
    const cfg = loadConfig({ env, settingsPath: path });
    const controller = createConfigController(cfg, { env, settingsPath: path });
    expect(cfg.handoffOrder).toBe("oldest");

    writeSetting(path, "handoff-order", "urgency");
    const setReply = controller.handle({
      kind: "set-config",
      key: "handoff-order",
      value: "urgency",
    });

    expect(cfg.handoffOrder).toBe("urgency");
    expect(takeNextQueuedEvent([
      { type: "turn-end", sessionId: "waiting", label: "waiting", announce: "" },
      { type: "needs-you", sessionId: "needs", label: "needs", announce: "" },
      { type: "working", sessionId: "working", label: "working", announce: "" },
    ], cfg.handoffOrder)?.sessionId).toBe("needs");
    expect(setReply).toMatchObject({
      kind: "config-ack",
      key: "handoff-order",
      status: "applied",
      effective: "urgency",
      source: "file",
    });

    unsetSetting(path, "handoff-order");
    const unsetReply = controller.handle({ kind: "unset-config", key: "handoff-order" });

    expect(cfg.handoffOrder).toBe("oldest");
    expect(takeNextQueuedEvent([
      { type: "turn-end", sessionId: "waiting", label: "waiting", announce: "" },
      { type: "working", sessionId: "working", label: "working", announce: "" },
    ], cfg.handoffOrder)?.sessionId).toBe("waiting");
    expect(unsetReply).toMatchObject({
      kind: "config-ack",
      key: "handoff-order",
      action: "unset",
      status: "applied",
      effective: "oldest",
      source: "default",
    });
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

  test("unset re-resolves a live field to env or default", () => {
    const { path } = fixture({ "end-silence": 5.25 });
    const env = {};
    const cfg = loadConfig({ env, settingsPath: path });
    expect(cfg.endSilenceSecs).toBe(5.25);
    const controller = createConfigController(cfg, { env, settingsPath: path });
    unsetSetting(path, "end-silence");

    const reply = controller.handle({
      kind: "unset-config",
      key: "end-silence",
    });

    expect(cfg.endSilenceSecs).toBe(3.5);
    expect(reply).toMatchObject({
      kind: "config-ack",
      action: "unset",
      status: "applied",
      effective: 3.5,
      source: "default",
    });
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
});
