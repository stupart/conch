import { describe, expect, test } from "bun:test";
import type { WatchdogProcess } from "../src/audio-watchdog.ts";
import {
  requireUncancelledProbe,
  TtsSupervisor,
  type TtsSupervisorOptions,
  type TtsTimer,
} from "../src/tts-supervisor.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeChild extends WatchdogProcess {
  kills: Array<number | NodeJS.Signals | undefined>;
  exit: ReturnType<typeof deferred<number>>;
}

function fakeChild(): FakeChild {
  const exit = deferred<number>();
  const kills: Array<number | NodeJS.Signals | undefined> = [];
  return {
    exited: exit.promise,
    exit,
    kills,
    kill: (signal) => kills.push(signal),
  };
}

type ProbeValue = boolean | Promise<boolean> | Error;

function harness(overrides: Partial<TtsSupervisorOptions> = {}) {
  const presence: ProbeValue[] = [];
  const readiness: ProbeValue[] = [];
  const children: FakeChild[] = [];
  const sleeps: number[] = [];
  const terminated: FakeChild[] = [];
  const resets: number[] = [];
  const logs: string[] = [];
  const timers: Array<{ callback: () => void; ms: number; cancelled: boolean }> = [];
  const probe = async (values: ProbeValue[], kind: string): Promise<boolean> => {
    const value = values.shift();
    if (value === undefined) throw new Error(`unexpected ${kind} probe`);
    if (value instanceof Error) throw value;
    return await value;
  };
  const schedule = (callback: () => void, ms: number): TtsTimer => {
    const item = { callback, ms, cancelled: false };
    timers.push(item);
    return { cancel: () => { item.cancelled = true; } };
  };
  const options: TtsSupervisorOptions = {
    enabled: true,
    probePresence: () => probe(presence, "presence"),
    probeReady: () => probe(readiness, "readiness"),
    spawn: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    resetReadiness: () => { resets.push(1); },
    log: (message) => logs.push(message),
    retryDelaysMs: [500, 1_000, 2_000],
    periodicProbeMs: 30_000,
    deferredProbeMs: 500,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      return !signal.aborted;
    },
    schedule,
    terminate: async (child) => { terminated.push(child as FakeChild); },
    ...overrides,
  };
  return {
    supervisor: new TtsSupervisor(options),
    presence,
    readiness,
    children,
    sleeps,
    terminated,
    resets,
    logs,
    timers,
  };
}

describe("Kokoro supervisor", () => {
  test("shutdown during a pending startup presence probe cannot spawn afterward", async () => {
    const h = harness();
    const presence = deferred<boolean>();
    h.presence.push(presence.promise);
    const starting = h.supervisor.start();

    h.supervisor.close();
    presence.resolve(false);

    expect(await starting).toBeFalse();
    expect(h.children).toHaveLength(0);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "stopped", ownership: "none" });
  });

  test("bounds replacement attempts, backs off, then leaves the last child for periodic healing", async () => {
    const h = harness();
    // startup absent; recovery/each kill-boundary still present; each
    // post-termination check absent so the next owned child may spawn.
    h.presence.push(false, true, true, false, true, false, true, false);
    h.readiness.push(false, false, false, false, false, false, false, false);

    expect(await h.supervisor.start()).toBeFalse();
    await h.supervisor.settled();

    expect(h.sleeps).toEqual([500, 1_000, 2_000]);
    expect(h.children).toHaveLength(4); // initial child + three replacements
    expect(h.terminated).toHaveLength(3);
    expect(h.resets).toHaveLength(3);
    expect(h.supervisor.snapshot()).toEqual({
      status: "fallback",
      ownership: "owned",
      replacementAttempts: 3,
      recovering: false,
      periodicArmed: true,
    });
    expect(h.timers.at(-1)?.ms).toBe(30_000);

    h.presence.push(true);
    h.readiness.push(false);
    h.timers.findLast((item) => !item.cancelled)!.callback();
    await h.supervisor.settled();
    expect(h.children).toHaveLength(4); // periodic canaries do not start an unbounded respawn loop
    expect(h.terminated).toHaveLength(3);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "fallback", periodicArmed: true });
  });

  test("a synth timeout re-probes in the background and concurrent triggers coalesce", async () => {
    const h = harness();
    h.presence.push(false);
    h.readiness.push(true);
    expect(await h.supervisor.start()).toBeTrue();

    const nextPresence = deferred<boolean>();
    h.presence.push(nextPresence.promise);
    h.readiness.push(true);
    h.supervisor.requestRecovery("synth-timeout");
    h.supervisor.requestRecovery("readiness-failed");

    expect(h.supervisor.snapshot()).toMatchObject({ status: "recovering", recovering: true });
    nextPresence.resolve(true);
    await h.supervisor.settled();
    expect(h.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "owned", recovering: false });
    expect(h.children).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  test("replacement waits for audio exclusivity before terminating the active server", async () => {
    const gate = deferred<void>();
    let exclusiveEntries = 0;
    const h = harness({
      retryDelaysMs: [0],
      exclusive: async (task, signal) => {
        exclusiveEntries++;
        // Initial presence, initial child canary, and recovery inspection are
        // read-only. Hold only the fresh recheck + termination boundary.
        if (exclusiveEntries === 4) await gate.promise;
        return task(signal);
      },
    });
    h.presence.push(false, true, true, false);
    h.readiness.push(false, false, false, true);

    expect(await h.supervisor.start()).toBeFalse();
    await Bun.sleep(0);
    expect(exclusiveEntries).toBe(4);
    expect(h.terminated).toHaveLength(0);

    gate.resolve();
    await h.supervisor.settled();
    expect(h.terminated).toHaveLength(1);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "owned" });
  });

  test("a server that heals during backoff is rechecked and not killed", async () => {
    const backoff = deferred<boolean>();
    const h = harness({
      retryDelaysMs: [0],
      sleep: async () => backoff.promise,
    });
    h.presence.push(false, true);
    h.readiness.push(false, false);

    expect(await h.supervisor.start()).toBeFalse();
    await Bun.sleep(0); // recovery is now waiting in the injected backoff
    h.presence.push(true);
    h.readiness.push(true);
    backoff.resolve(true);
    await h.supervisor.settled();

    expect(h.terminated).toHaveLength(0);
    expect(h.children).toHaveLength(1);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "owned" });
  });

  test("an adopted server is never killed or respawned and a periodic canary can heal it", async () => {
    const h = harness();
    h.presence.push(true);
    h.readiness.push(false);
    expect(await h.supervisor.start()).toBeFalse();
    expect(h.supervisor.snapshot()).toMatchObject({ status: "fallback", ownership: "adopted" });
    expect(h.children).toHaveLength(0);
    expect(h.terminated).toHaveLength(0);

    h.supervisor.requestRecovery("synth-timeout"); // fallback latch: periodic only
    expect(h.children).toHaveLength(0);
    h.presence.push(true);
    h.readiness.push(true);
    const timer = h.timers.findLast((item) => !item.cancelled)!;
    timer.callback();
    await Bun.sleep(0);

    expect(h.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "adopted" });
    expect(h.children).toHaveLength(0);
    expect(h.terminated).toHaveLength(0);
  });

  test("a successful replacement ignores the stale old child's eventual exit", async () => {
    const h = harness();
    h.presence.push(false, true, true, false);
    h.readiness.push(false, false, false, true);
    expect(await h.supervisor.start()).toBeFalse();
    await h.supervisor.settled();
    expect(h.children).toHaveLength(2);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "owned" });

    h.children[0]!.exit.resolve(137);
    await Bun.sleep(0);
    expect(h.children).toHaveLength(2);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "owned" });
  });

  test("a lingering owned port is not misclassified as adopted and heals after it clears", async () => {
    const h = harness({ retryDelaysMs: [0] });
    h.presence.push(false, true, true, true);
    h.readiness.push(false, false, false, false);
    expect(await h.supervisor.start()).toBeFalse();
    await h.supervisor.settled();

    expect(h.children).toHaveLength(1);
    expect(h.terminated).toHaveLength(1);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "fallback", ownership: "owned" });

    h.presence.push(false, false, false);
    h.readiness.push(true);
    h.timers.findLast((item) => !item.cancelled)!.callback();
    await h.supervisor.settled();
    expect(h.children).toHaveLength(2);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "owned" });
  });

  test("shutdown still force-kills a retiring child whose port never cleared", async () => {
    const h = harness({ retryDelaysMs: [0] });
    h.presence.push(false, true, true, true);
    h.readiness.push(false, false, false, false);
    expect(await h.supervisor.start()).toBeFalse();
    await h.supervisor.settled();

    expect(h.supervisor.snapshot()).toMatchObject({ status: "fallback", ownership: "owned" });
    h.supervisor.close();
    expect(h.children[0]!.kills).toContain("SIGKILL");
    expect(h.supervisor.snapshot()).toMatchObject({ status: "stopped", ownership: "none" });
  });

  test("the last child exiting after exhaustion stays latched until the periodic probe", async () => {
    const h = harness({ retryDelaysMs: [0] });
    h.presence.push(false, true, true, false);
    h.readiness.push(false, false, false, false);
    expect(await h.supervisor.start()).toBeFalse();
    await h.supervisor.settled();
    expect(h.children).toHaveLength(2);

    h.children[1]!.exit.resolve(1);
    await Bun.sleep(0);
    expect(h.children).toHaveLength(2);
    expect(h.sleeps).toEqual([0]);
    expect(h.supervisor.snapshot()).toMatchObject({
      status: "fallback",
      ownership: "none",
      recovering: false,
      periodicArmed: true,
    });
  });

  test("an owned child exit during recovery is absorbed by that bounded replacement burst", async () => {
    const h = harness();
    h.presence.push(false);
    h.readiness.push(true);
    expect(await h.supervisor.start()).toBeTrue();

    const inFlightPresence = deferred<boolean>();
    h.presence.push(inFlightPresence.promise, false, false);
    h.readiness.push(true);
    h.supervisor.requestRecovery("synth-timeout");
    h.children[0]!.exit.resolve(1);
    await Promise.resolve();
    inFlightPresence.resolve(false);
    await h.supervisor.settled();

    expect(h.children).toHaveLength(2);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "owned", recovering: false });
    expect(h.logs.filter((line) => line.includes("recovery requested: child-exit"))).toHaveLength(0);
  });

  test("a deferred gate probe consumes no replacement attempt", async () => {
    const h = harness();
    h.presence.push(false);
    h.readiness.push(true);
    expect(await h.supervisor.start()).toBeTrue();
    h.presence.push(new Error("audio gate violation: mic open"));

    h.supervisor.requestRecovery("synth-timeout");
    await h.supervisor.settled();

    expect(h.supervisor.snapshot()).toMatchObject({ status: "recovering", replacementAttempts: 0 });
    expect(h.sleeps).toEqual([]);
    expect(h.terminated).toEqual([]);
    expect(h.timers.findLast((item) => !item.cancelled)?.ms).toBe(500);
  });

  test("shutdown kills an owned child but never an adopted one", async () => {
    const owned = harness();
    owned.presence.push(false);
    owned.readiness.push(true);
    await owned.supervisor.start();
    owned.supervisor.close();
    expect(owned.children[0]!.kills).toEqual(["SIGKILL"]);
    expect(owned.supervisor.snapshot().status).toBe("stopped");

    const adopted = harness();
    adopted.presence.push(true);
    adopted.readiness.push(true);
    await adopted.supervisor.start();
    adopted.supervisor.close();
    expect(adopted.children).toHaveLength(0);
    expect(adopted.terminated).toHaveLength(0);
  });

  test("shutdown aborts a recovery backoff before it can terminate or respawn", async () => {
    const sleepStarted = deferred<void>();
    const h = harness({
      sleep: async (_ms, signal) => {
        sleepStarted.resolve();
        if (signal.aborted) return false;
        return new Promise<boolean>((resolve) => {
          signal.addEventListener("abort", () => resolve(false), { once: true });
        });
      },
    });
    h.presence.push(false, true);
    h.readiness.push(false, false);
    expect(await h.supervisor.start()).toBeFalse();
    await sleepStarted.promise;

    h.supervisor.close();
    await h.supervisor.settled();
    expect(h.children).toHaveLength(1);
    expect(h.terminated).toHaveLength(0);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "stopped", recovering: false });
  });

  test("shutdown cancels a periodic probe timer and stale callbacks cannot rearm it", async () => {
    const h = harness();
    h.presence.push(true);
    h.readiness.push(false);
    expect(await h.supervisor.start()).toBeFalse();
    const timer = h.timers.findLast((item) => !item.cancelled)!;

    h.supervisor.close();
    expect(timer.cancelled).toBeTrue();
    timer.callback();
    await Bun.sleep(0);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "stopped", periodicArmed: false });
    expect(h.children).toHaveLength(0);
  });

  test("default bounded termination force-kills a child whose exit never settles", async () => {
    const kills: Array<number | NodeJS.Signals | undefined> = [];
    let spawns = 0;
    const presence = [false, true, true, false];
    const readiness = [false, false, false, true];
    const supervisor = new TtsSupervisor({
      enabled: true,
      probePresence: async () => presence.shift()!,
      probeReady: async () => readiness.shift()!,
      spawn: () => {
        spawns++;
        return {
          exited: new Promise<number>(() => {}),
          kill: (signal) => { if (spawns === 1) kills.push(signal); },
        };
      },
      resetReadiness() {},
      log() {},
      retryDelaysMs: [0],
      terminateGraceMs: 5,
      sleep: async () => true,
    });

    expect(await supervisor.start()).toBeFalse();
    await supervisor.settled();
    expect(kills).toEqual([undefined, "SIGKILL"]); // TERM, then bounded escalation
    expect(supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "owned" });
    supervisor.close();
  });

  test("an abort-as-false probe result is converted into deferral", async () => {
    const controller = new AbortController();
    const work = Promise.resolve(false);
    controller.abort(new DOMException("lane cancelled", "AbortError"));
    await expect(requireUncancelledProbe(work, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
