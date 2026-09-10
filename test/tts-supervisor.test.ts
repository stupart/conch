import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

describe("Kokoro by mode (D1)", () => {
  const GRACE_MS = 60_000;
  const WHY = "unloaded — manual mode; reloads in auto mode";
  /** Fire-and-forget work (an unload, a prewarm's start) settles in a few microtask turns. */
  async function until(condition: () => boolean): Promise<void> {
    for (let tick = 0; tick < 50 && !condition(); tick++) await Bun.sleep(0);
    expect(condition()).toBeTrue();
  }
  const live = (h: ReturnType<typeof harness>) => h.timers.filter((timer) => !timer.cancelled);
  /** The fake clock does not retire a fired one-shot by itself. */
  const fire = (timer: { callback: () => void; cancelled: boolean }) => {
    timer.callback();
    timer.cancelled = true;
  };

  test("manual mode unloads an owned server after the grace, a quick p/p does not, and auto mode reloads it", async () => {
    const h = harness();
    h.presence.push(false);
    h.readiness.push(true);
    expect(await h.supervisor.start()).toBeTrue();

    // p then p again inside the grace: the pending unload is cancelled, nothing is killed.
    h.supervisor.unloadAfter(GRACE_MS, WHY);
    expect(live(h).map((timer) => timer.ms)).toEqual([GRACE_MS]);
    h.supervisor.prewarm("auto mode");
    expect(live(h)).toHaveLength(0);
    expect(h.terminated).toHaveLength(0);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "owned" });

    // The grace elapses: terminated inside the lane, readiness reset, one log line.
    h.supervisor.unloadAfter(GRACE_MS, WHY);
    fire(live(h)[0]!);
    await until(() => h.terminated.length === 1);
    expect(h.terminated).toEqual([h.children[0]!]);
    expect(h.resets.length).toBeGreaterThanOrEqual(1);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "unloaded", periodicArmed: false });
    expect(h.logs.filter((line) => line === `kokoro ${WHY}`)).toHaveLength(1);

    // Unloaded on purpose: the retired child's exit, a speech's recovery request and a
    // boot start() do not bring it back.
    h.children[0]!.exit.resolve(0);
    await Bun.sleep(0);
    h.supervisor.requestRecovery("synth-timeout");
    await h.supervisor.settled();
    expect(await h.supervisor.start()).toBeFalse();
    expect(h.children).toHaveLength(1);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "unloaded", ownership: "none" });

    // Auto mode: reload with the bounded start; a second signal while warming is no second spawn.
    h.presence.push(false);
    h.readiness.push(true);
    h.supervisor.prewarm("auto mode");
    h.supervisor.prewarm("auto mode");
    await until(() => h.supervisor.snapshot().status === "ready");
    expect(h.children).toHaveLength(2);
    expect(h.logs.filter((line) => line === "kokoro reloading — auto mode")).toHaveLength(1);
    h.supervisor.close();
  });

  test("booting in manual mode never starts it, a grace landing mid-boot waits, and an adopted server is never unloaded", async () => {
    // Boot in manual mode: unload before start(), so start() is a no-op and no probe runs.
    const cold = harness();
    cold.supervisor.unloadAfter(0, WHY);
    expect(cold.supervisor.snapshot()).toMatchObject({ status: "unloaded", ownership: "none" });
    expect(await cold.supervisor.start()).toBeFalse();
    expect(cold.children).toHaveLength(0);
    expect(cold.logs.filter((line) => line === `kokoro ${WHY}`)).toHaveLength(1);
    cold.presence.push(false);
    cold.readiness.push(true);
    cold.supervisor.prewarm("auto mode");
    await until(() => cold.supervisor.snapshot().status === "ready");
    expect(cold.children).toHaveLength(1);
    cold.supervisor.close();

    // A boot in flight is not unloadable yet: the grace re-arms and lands once it is ready.
    const booting = harness();
    const presence = deferred<boolean>();
    booting.presence.push(presence.promise);
    booting.readiness.push(true);
    const starting = booting.supervisor.start();
    booting.supervisor.unloadAfter(GRACE_MS, WHY);
    fire(live(booting)[0]!);
    expect(booting.supervisor.snapshot().status).toBe("starting");
    expect(live(booting).map((timer) => timer.ms)).toEqual([GRACE_MS]);
    presence.resolve(false);
    expect(await starting).toBeTrue();
    fire(live(booting)[0]!);
    await until(() => booting.terminated.length === 1);
    expect(booting.supervisor.snapshot().status).toBe("unloaded");
    booting.supervisor.close();

    // Someone else's process is never unloaded, in any mode: only the D3 poll runs.
    const adopted = harness();
    adopted.presence.push(true);
    adopted.readiness.push(true);
    expect(await adopted.supervisor.start()).toBeTrue();
    adopted.supervisor.unloadAfter(GRACE_MS, WHY);
    expect(live(adopted).map((timer) => timer.ms)).toEqual([30_000]);
    expect(adopted.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "adopted" });
    adopted.supervisor.close();
  });
});

describe("D1 wiring inside runDaemon", () => {
  // runDaemon runs in no test; its wiring is pinned by source, the way D2's is.
  const daemonSource = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");

  function between(startMarker: string, endMarker: string): string {
    const start = daemonSource.indexOf(startMarker);
    expect(start).toBeGreaterThan(-1);
    const end = daemonSource.indexOf(endMarker, start);
    expect(end).toBeGreaterThan(start);
    return daemonSource.slice(start, end);
  }

  test("a mode change unloads after the grace or prewarms, whichever engine is live", () => {
    expect(daemonSource).toContain("const KOKORO_MANUAL_GRACE_MS = 60_000");
    const helper = between("const kokoroByMode = (paused: boolean", "pause = new PauseController({");
    expect(helper).toContain("for (const engine of [ttsWorker, ttsSupervisor])");
    expect(helper).toContain('if (paused) engine?.unloadAfter(graceMs, "unloaded — manual mode; reloads in auto mode")');
    expect(helper).toContain('else engine?.prewarm("auto mode")');
    // Both markers must EXIST before their order means anything.
    const mode = between("setModeState: (paused) => {", "speak: (text) => speak(cfg, text)");
    const state = mode.indexOf('setState(paused ? "paused" : "idle")');
    const kokoro = mode.indexOf("kokoroByMode(paused)");
    expect(state).toBeGreaterThan(-1);
    expect(kokoro).toBeGreaterThan(state);
  });

  test("a daemon booting in manual mode unloads before either engine starts", () => {
    const boot = between("ttsSupervisor = new TtsSupervisor({", "const whisperBinaryAvailable");
    const unload = boot.indexOf("if (pause.paused) kokoroByMode(true, 0)");
    const worker = boot.indexOf("void ttsWorker.start()");
    const server = boot.indexOf("ttsStartup = ttsSupervisor.start()");
    expect(unload).toBeGreaterThan(-1);
    expect(worker).toBeGreaterThan(unload);
    expect(server).toBeGreaterThan(unload);
  });
});
