import { describe, expect, test } from "bun:test";
import { EventQueue, type EventQueueOptions } from "../src/event-queue.ts";
import type { TurnEvent } from "../src/hook.ts";
import type { HandoffOrder } from "../src/settings.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function event(sessionId: string, type: TurnEvent["type"] = "turn-end"): TurnEvent {
  return { type, sessionId, label: sessionId, announce: `${sessionId}: finished` };
}

function harness(overrides: Partial<EventQueueOptions> = {}) {
  const state = {
    order: "oldest" as HandoffOrder,
    prioritized: new Set<string>(),
    shuttingDown: false,
    stop: false,
    stopCalls: 0,
    idleBusy: [] as boolean[],
    errors: [] as Array<{ event: TurnEvent; error: unknown }>,
    logs: [] as string[],
    traces: [] as string[],
  };
  const queue = new EventQueue({
    handle: overrides.handle ?? (async () => {}),
    handoffOrder: overrides.handoffOrder ?? (() => state.order),
    prioritized: overrides.prioritized ?? state.prioritized,
    shuttingDown: overrides.shuttingDown ?? (() => state.shuttingDown),
    consumeStopKey: overrides.consumeStopKey ?? (() => {
      state.stopCalls += 1;
      const stopped = state.stop;
      state.stop = false;
      return stopped;
    }),
    onError(current, error) {
      state.errors.push({ event: current, error });
      overrides.onError?.(current, error);
    },
    onIdle() {
      state.idleBusy.push(queue.busy());
      overrides.onIdle?.();
    },
    log(message) {
      state.logs.push(message);
      overrides.log?.(message);
    },
    trace(message) {
      state.traces.push(message);
      overrides.trace?.(message);
    },
  });
  return { queue, state };
}

describe("EventQueue", () => {
  test("single drainer serializes all submitted handlers", async () => {
    const gate = deferred();
    const first = event("first");
    const second = event("second");
    const third = event("third");
    const handled: TurnEvent[] = [];
    let active = 0;
    let maximumActive = 0;
    const { queue } = harness({
      async handle(current) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        handled.push(current);
        if (current === first) await gate.promise;
        active -= 1;
      },
    });

    const drain = queue.submit(first);
    const submissions = [queue.submit(second), queue.submit(third)];
    expect(queue.busy()).toBe(true);
    expect(handled).toEqual([first]);
    expect(queue.pending).toEqual([second, third]);
    await Promise.all(submissions);
    gate.resolve();
    await drain;
    expect(handled).toEqual([first, second, third]);
    expect(maximumActive).toBe(1);
    expect(queue.pending).toHaveLength(0);
    expect(queue.busy()).toBe(false);
  });

  test("enqueue during an await joins the active drain without waiting for it", async () => {
    const gate = deferred();
    const first = event("first");
    const second = event("second");
    const handled: TurnEvent[] = [];
    let firstFinished = false;
    const { queue } = harness({
      async handle(current) {
        handled.push(current);
        if (current === first) {
          await gate.promise;
          firstFinished = true;
        }
      },
    });

    const drain = queue.submit(first);
    await queue.submit(second);
    expect(firstFinished).toBe(false);
    expect(handled).toEqual([first]);
    gate.resolve();
    await drain;
    expect(firstFinished).toBe(true);
    expect(handled).toEqual([first, second]);
  });

  test("handler errors invoke failure cleanup and continue with pending work", async () => {
    const gate = deferred();
    const bad = event("bad");
    const good = event("good");
    const failure = new Error("handler failed");
    const handled: TurnEvent[] = [];
    const { queue, state } = harness({
      async handle(current) {
        handled.push(current);
        if (current === bad) {
          await gate.promise;
          throw failure;
        }
      },
    });
    const drain = queue.submit(bad);
    await queue.submit(good);
    gate.resolve();
    await drain;
    expect(state.errors).toEqual([{ event: bad, error: failure }]);
    expect(handled).toEqual([bad, good]);
    expect(queue.busy()).toBe(false);
    expect(state.idleBusy).toEqual([false]);
  });

  test("finally releases busy even when failure cleanup itself throws", async () => {
    const gate = deferred();
    const bad = event("bad");
    const survivor = event("survivor");
    const later = event("later");
    const cleanupFailure = new Error("cleanup failed");
    const handled: TurnEvent[] = [];
    const { queue, state } = harness({
      async handle(current) {
        handled.push(current);
        if (current === bad) await gate.promise;
      },
      onError() { throw cleanupFailure; },
    });
    const drain = queue.submit(bad);
    await queue.submit(survivor);
    gate.reject(new Error("handler failed"));
    await expect(drain).rejects.toBe(cleanupFailure);
    expect(queue.busy()).toBe(false);
    expect(state.idleBusy).toEqual([false]);
    expect(queue.pending).toEqual([survivor]);
    await queue.submit(later);
    expect(handled).toEqual([bad, survivor, later]);
    expect(state.idleBusy).toEqual([false, false]);
  });

  test("audition exclusion acquires busy synchronously and drains after release", async () => {
    const gate = deferred();
    const drained = deferred();
    const queued = event("queued");
    const handled: TurnEvent[] = [];
    let auditionCalls = 0;
    let idleCalls = 0;
    const { queue, state } = harness({
      async handle(current) { handled.push(current); },
      onIdle() { if (++idleCalls === 2) drained.resolve(); },
    });
    const audition = queue.exclusive(async () => {
      auditionCalls += 1;
      expect(queue.busy()).toBe(true);
      await gate.promise;
    });
    expect(queue.busy()).toBe(true);
    await queue.submit(queued);
    expect(handled).toEqual([]);
    expect(await queue.exclusive(async () => { auditionCalls += 1; })).toBe(false);
    expect(auditionCalls).toBe(1);
    gate.resolve();
    expect(await audition).toBe(true);
    expect(handled).toEqual([queued]);
    await drained.promise;
    expect(queue.busy()).toBe(false);
    expect(state.idleBusy).toEqual([false, false]);
  });

  test("a queued handler excludes auditions until its drain finishes", async () => {
    const gate = deferred();
    let auditionCalls = 0;
    const { queue } = harness({ handle: () => gate.promise });
    const drain = queue.submit(event("queued"));
    expect(await queue.exclusive(async () => { auditionCalls += 1; })).toBe(false);
    expect(auditionCalls).toBe(0);
    gate.resolve();
    await drain;
    expect(await queue.exclusive(async () => { auditionCalls += 1; })).toBe(true);
    expect(auditionCalls).toBe(1);
  });

  test("a failed audition releases busy and restarts queued work", async () => {
    const gate = deferred();
    const drained = deferred();
    const failure = new Error("audition failed");
    const queued = event("queued");
    const handled: TurnEvent[] = [];
    let idleCalls = 0;
    const { queue, state } = harness({
      async handle(current) { handled.push(current); },
      onIdle() { if (++idleCalls === 2) drained.resolve(); },
    });
    const audition = queue.exclusive(() => gate.promise);
    await queue.submit(queued);
    gate.reject(failure);
    await expect(audition).rejects.toBe(failure);
    expect(handled).toEqual([queued]);
    await drained.promise;
    expect(queue.busy()).toBe(false);
    expect(state.idleBusy).toEqual([false, false]);
  });

  test("cancelled commands retain barriers and cancellation follows object identity", async () => {
    const gate = deferred();
    const first = event("first");
    const old = event("old", "needs-you");
    const wake = event("wake", "wake");
    const recent = event("recent", "working");
    const visited: TurnEvent[] = [];
    const audible: TurnEvent[] = [];
    const { queue, state } = harness({
      async handle(current) {
        visited.push(current);
        // Keep cancellation at the daemon's handler boundary: the scheduler
        // must still dequeue this command before considering the older cohort.
        if (queue.consumeCancellation(current)) return;
        audible.push(current);
        if (current === first) await gate.promise;
      },
    });
    const drain = queue.submit(first);
    await queue.submit(old);
    await queue.submit(wake);
    await queue.submit(recent);
    state.prioritized.add(old.sessionId);
    queue.cancel(wake);
    expect(queue.pending).toEqual([old, wake, recent]);
    expect(queue.pending[1]).toBe(wake);
    expect(queue.consumeCancellation({ ...wake })).toBe(false);
    gate.resolve();
    await drain;
    expect(visited).toEqual([first, recent, wake, old]);
    expect(visited[2]).toBe(wake);
    expect(audible).toEqual([first, recent, old]);
    expect(queue.consumeCancellation(wake)).toBe(false);
  });

  test("targeted removal removes speech while targeted cancellation retains commands", async () => {
    const gate = deferred();
    const first = event("first");
    const speech = event("dismissed", "speak");
    const wake = event("dismissed", "wake");
    const recite = event("dismissed", "recite");
    const other = event("other", "speak");
    const visited: TurnEvent[] = [];
    const audible: TurnEvent[] = [];
    const { queue } = harness({
      async handle(current) {
        visited.push(current);
        if (queue.consumeCancellation(current)) return;
        audible.push(current);
        if (current === first) await gate.promise;
      },
    });
    const drain = queue.submit(first);
    for (const current of [speech, wake, recite, other]) await queue.submit(current);
    queue.removePending((current) => current.sessionId === "dismissed" && current.type === "speak");
    for (const current of queue.pending) {
      if (current.sessionId === "dismissed") queue.cancel(current);
    }
    expect(queue.pending).toEqual([wake, recite, other]);
    gate.resolve();
    await drain;
    expect(visited).toEqual([first, other, recite, wake]);
    expect(audible).toEqual([first, other]);
  });

  test("cancelling an instant command revokes protection against replacement", async () => {
    const gate = deferred();
    const first = event("first");
    const instant = event("session", "wake");
    const ordinary = event("session", "wake");
    const replacement = event("session", "wake");
    const visited: TurnEvent[] = [];
    const { queue } = harness({
      async handle(current) {
        visited.push(current);
        if (current === first) await gate.promise;
      },
    });
    const drain = queue.submit(first);
    queue.markInstantQueued(instant);
    await queue.submit(instant);
    await queue.submit(ordinary);
    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0]).toBe(instant);
    queue.cancel(instant);
    expect(queue.pending[0]).toBe(instant);
    await queue.submit(replacement);
    expect(queue.pending[0]).toBe(replacement);
    expect(queue.consumeCancellation(replacement)).toBe(false);
    expect(queue.consumeCancellation(instant)).toBe(true);
    gate.resolve();
    await drain;
    expect(visited[1]).toBe(replacement);
  });

  test("pending iteration renames the original event delivered to the handler", async () => {
    const gate = deferred();
    const first = event("first");
    const renamed = event("renamed");
    const transition = new WeakMap<TurnEvent, string>([[renamed, "transition"]]);
    const handled: TurnEvent[] = [];
    const { queue } = harness({
      async handle(current) {
        handled.push(current);
        if (current === first) await gate.promise;
      },
    });
    const drain = queue.submit(first);
    await queue.submit(renamed);
    expect(queue.pending[0]).toBe(renamed);
    for (const current of queue.pending) current.label = "new label";
    expect(renamed.label).toBe("new label");
    gate.resolve();
    await drain;
    expect(handled[1]).toBe(renamed);
    expect(handled[1]!.label).toBe("new label");
    expect(transition.get(handled[1]!)).toBe("transition");
  });

  test("handoff order is read live on every dequeue", async () => {
    const gate = deferred();
    const first = event("first");
    const a = event("a");
    const b = event("b");
    const c = event("c");
    const handled: TurnEvent[] = [];
    const { queue, state } = harness({
      async handle(current) {
        handled.push(current);
        if (current === first) await gate.promise;
        if (current === c) state.order = "oldest";
      },
    });
    const drain = queue.submit(first);
    for (const current of [a, b, c]) await queue.submit(current);
    state.order = "newest";
    gate.resolve();
    await drain;
    expect(handled).toEqual([first, c, a, b]);
  });

  test("the referenced priority set is consulted on every dequeue", async () => {
    const gate = deferred();
    const first = event("first");
    const a = event("a");
    const b = event("b");
    const c = event("c");
    const d = event("d");
    const handled: TurnEvent[] = [];
    const { queue, state } = harness({
      async handle(current) {
        handled.push(current);
        if (current === first) await gate.promise;
        if (current === c || current === b) {
          state.prioritized.clear();
          state.prioritized.add(current === c ? b.sessionId : d.sessionId);
        }
      },
    });
    const drain = queue.submit(first);
    for (const current of [a, b, c, d]) await queue.submit(current);
    state.prioritized.add(c.sessionId);
    gate.resolve();
    await drain;
    expect(handled).toEqual([first, c, b, d, a]);
  });

  test("command barriers bound priority and urgency selection to the newest cohort", async () => {
    const gate = deferred();
    const first = event("first");
    const oldUrgent = event("old-urgent", "needs-you");
    const oldWorking = event("old-working", "working");
    const wake = event("wake", "wake");
    const middle = event("middle", "needs-you");
    const recite = event("recite", "recite");
    const recentWorking = event("recent-working", "working");
    const recentTurn = event("recent-turn");
    const handled: TurnEvent[] = [];
    const { queue, state } = harness({
      async handle(current) {
        handled.push(current);
        if (current === first) await gate.promise;
      },
    });
    const drain = queue.submit(first);
    for (const current of [oldUrgent, oldWorking, wake, middle, recite, recentWorking, recentTurn]) {
      await queue.submit(current);
    }
    state.order = "urgency";
    state.prioritized.add(oldUrgent.sessionId);
    gate.resolve();
    await drain;
    expect(handled).toEqual([first, recentTurn, recentWorking, recite, middle, wake, oldUrgent, oldWorking]);
  });

  test("instant commands and mode acknowledgements retain insertion barriers", async () => {
    const gate = deferred();
    const first = event("first");
    const pause = event("pause", "pause");
    const instant = event("instant", "wake");
    const ordinary = event("ordinary");
    const handled: TurnEvent[] = [];
    const { queue } = harness({
      async handle(current) {
        handled.push(current);
        if (current === first) await gate.promise;
      },
    });
    const drain = queue.submit(first);
    await queue.submit(pause);
    queue.markInstantQueued(instant);
    await queue.submit(instant);
    await queue.submit(ordinary);
    expect(queue.pending).toEqual([ordinary, instant, pause]);
    gate.resolve();
    await drain;
    expect(handled).toEqual([first, pause, instant, ordinary]);
  });

  test("stop hook runs only at drain entry with pending work", async () => {
    const gate = deferred();
    const first = event("first");
    const second = event("second");
    const skipped = event("skipped");
    const handled: TurnEvent[] = [];
    const { queue, state } = harness({
      async handle(current) {
        handled.push(current);
        if (current === first) await gate.promise;
      },
    });
    state.stop = true;
    await queue.exclusive(async () => {});
    expect(state.stopCalls).toBe(0);
    expect(state.stop).toBe(true);
    state.stop = false;
    const drain = queue.submit(first);
    expect(state.stopCalls).toBe(1);
    state.stop = true;
    await queue.submit(second);
    expect(state.stopCalls).toBe(1);
    gate.resolve();
    await drain;
    expect(handled).toEqual([first, second]);
    expect(state.stopCalls).toBe(1);
    expect(state.stop).toBe(true);
    await queue.submit(skipped);
    expect(state.stopCalls).toBe(2);
    expect(state.stop).toBe(false);
    expect(handled).toEqual([first, second]);
    expect(state.logs).toEqual([
      '⏹ spacebar — skipped queued turn-end for "skipped" during TTS startup',
    ]);
  });

  test("shutdown clearing removes all pending work synchronously during an await", async () => {
    const gate = deferred();
    const first = event("first");
    const handled: TurnEvent[] = [];
    const { queue, state } = harness({
      async handle(current) {
        handled.push(current);
        await gate.promise;
      },
    });
    const drain = queue.submit(first);
    await queue.submit(event("second"));
    await queue.submit(event("wake", "wake"));
    expect(queue.pending).toHaveLength(2);
    state.shuttingDown = true;
    queue.clear();
    expect(queue.pending).toHaveLength(0);
    expect(queue.busy()).toBe(true);
    gate.resolve();
    await drain;
    expect(handled).toEqual([first]);
    expect(queue.busy()).toBe(false);
    expect(state.idleBusy).toEqual([false]);
  });

  test("shutdown at drain entry prevents handling and leaves clearing to the caller", async () => {
    const handled: TurnEvent[] = [];
    const queued = event("queued");
    const { queue, state } = harness({
      async handle(current) { handled.push(current); },
    });
    state.shuttingDown = true;
    state.stop = true;
    await queue.submit(queued);
    expect(handled).toEqual([]);
    expect(queue.pending[0]).toBe(queued);
    expect(queue.busy()).toBe(false);
    expect(state.stopCalls).toBe(0);
    expect(state.stop).toBe(true);
    queue.clear();
    expect(queue.pending).toHaveLength(0);
  });
});
