import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { WatchdogProcess } from "../src/audio-watchdog.ts";
import type { Config } from "../src/config.ts";
import {
  ServerSupervisor,
  type ServerSupervisorOptions,
  type ServerTimer,
} from "../src/server-supervisor.ts";
import { WhisperServerClient } from "../src/transcribe.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

interface FakeChild extends WatchdogProcess {
  kills: Array<number | NodeJS.Signals | undefined>;
  exit: ReturnType<typeof deferred<number>>;
}

function fakeChild(): FakeChild {
  const exit = deferred<number>();
  const kills: Array<number | NodeJS.Signals | undefined> = [];
  return { exited: exit.promise, exit, kills, kill: (signal) => kills.push(signal) };
}

type ProbeValue = boolean | Promise<boolean> | Error;

function harness(overrides: Partial<ServerSupervisorOptions> = {}) {
  const presence: ProbeValue[] = [];
  const readiness: ProbeValue[] = [];
  const children: FakeChild[] = [];
  const sleeps: number[] = [];
  const terminated: FakeChild[] = [];
  const resets: number[] = [];
  const timers: Array<{ callback: () => void; ms: number; cancelled: boolean }> = [];
  const probe = async (values: ProbeValue[], kind: string): Promise<boolean> => {
    const value = values.shift();
    if (value === undefined) throw new Error(`unexpected ${kind} probe`);
    if (value instanceof Error) throw value;
    return await value;
  };
  const schedule = (callback: () => void, ms: number): ServerTimer => {
    const timer = { callback, ms, cancelled: false };
    timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  };
  const options: ServerSupervisorOptions = {
    enabled: true,
    language: {
      service: "whisper-server",
      readiness: "transcription-ready",
      fallback: "using the cold cli",
    },
    probePresence: () => probe(presence, "presence"),
    probeReady: () => probe(readiness, "readiness"),
    spawn: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    resetReadiness: () => { resets.push(1); },
    retryDelaysMs: [500, 1_000, 2_000],
    periodicProbeMs: 30_000,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      return !signal.aborted;
    },
    schedule,
    terminate: async (child) => { terminated.push(child as FakeChild); },
    log() {},
    ...overrides,
  };
  return {
    supervisor: new ServerSupervisor<"request-failed">(options),
    presence,
    readiness,
    children,
    sleeps,
    terminated,
    resets,
    timers,
  };
}

describe("whisper-server supervision", () => {
  test("bounds owned replacements with backoff, then only a periodic canary reopens recovery", async () => {
    const h = harness();
    h.presence.push(false, true, true, false, true, false, true, false);
    h.readiness.push(false, false, false, false, false, false, false, false);

    expect(await h.supervisor.start()).toBeFalse();
    await h.supervisor.settled();

    expect(h.sleeps).toEqual([500, 1_000, 2_000]);
    expect(h.children).toHaveLength(4);
    expect(h.terminated).toHaveLength(3);
    expect(h.supervisor.snapshot()).toMatchObject({
      status: "fallback",
      ownership: "owned",
      replacementAttempts: 3,
      periodicArmed: true,
    });

    h.supervisor.requestRecovery("request-failed");
    expect(h.children).toHaveLength(4);
    h.presence.push(true);
    h.readiness.push(false);
    h.timers.findLast((timer) => !timer.cancelled)!.callback();
    await h.supervisor.settled();
    expect(h.children).toHaveLength(4);
    expect(h.terminated).toHaveLength(3);
    h.supervisor.close();
  });

  test("never kills or respawns an adopted server, and a periodic recanary can heal it", async () => {
    const h = harness();
    h.presence.push(true);
    h.readiness.push(false);
    expect(await h.supervisor.start()).toBeFalse();
    expect(h.supervisor.snapshot()).toMatchObject({ status: "fallback", ownership: "adopted" });

    h.supervisor.requestRecovery("request-failed");
    expect(h.children).toHaveLength(0);
    expect(h.terminated).toHaveLength(0);

    h.presence.push(true);
    h.readiness.push(true);
    h.timers.findLast((timer) => !timer.cancelled)!.callback();
    await h.supervisor.settled();
    expect(h.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "adopted" });
    expect(h.children).toHaveLength(0);
    expect(h.terminated).toHaveLength(0);
    h.supervisor.close();
  });

  test("an owned replacement waits for the live warm-request lane", async () => {
    const client = new WhisperServerClient();
    const liveStarted = deferred<void>();
    const releaseLive = deferred<void>();
    const h = harness({
      retryDelaysMs: [0],
      exclusive: (task, signal) => client.runExclusive(task, signal),
    });
    h.presence.push(false);
    h.readiness.push(true);
    expect(await h.supervisor.start()).toBeTrue();

    const live = client.runExclusive(async () => {
      liveStarted.resolve();
      await releaseLive.promise;
    });
    await liveStarted.promise;
    h.presence.push(true, true, false);
    h.readiness.push(false, false, true);
    h.supervisor.requestRecovery("request-failed");
    await Bun.sleep(0);
    expect(h.terminated).toHaveLength(0);

    releaseLive.resolve();
    await live;
    await h.supervisor.settled();
    expect(h.terminated).toHaveLength(1);
    expect(h.children).toHaveLength(2);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "owned" });
    h.supervisor.close();
  });

  test("uses an inference canary and reports warm failure without awaiting recovery", async () => {
    const responses = [
      new Response("root", { status: 200 }),
      Response.json({ text: "" }),
      new Response("down", { status: 503 }),
    ];
    const client = new WhisperServerClient({
      request: async () => responses.shift() ?? new Response("unexpected", { status: 500 }),
    });
    const cfg = { whisperPort: 8642 } as Config;
    expect(await client.probeReadyUnlocked(cfg, 1_000)).toBeTrue();
    expect(client.serverUp()).toBeTrue();

    const recoveryNeverSettles = deferred<void>();
    let recoveries = 0;
    client.setRecoveryHandler(async (reason) => {
      expect(reason).toBe("request-failed");
      recoveries++;
      await recoveryNeverSettles.promise;
    });

    const result = await client.transcribeWarm(cfg, new Uint8Array(44), 1_000);
    expect(result.status).toBe("failed");
    expect(recoveries).toBe(1);
    expect(client.serverUp()).toBeFalse();
  });

  test("clears health before the request lane advances after a warm failure", async () => {
    const firstWarm = deferred<Response>();
    let requests = 0;
    const client = new WhisperServerClient({
      request: async () => {
        requests++;
        if (requests === 1) return new Response("root", { status: 200 });
        if (requests === 2) return Response.json({ text: "" });
        if (requests === 3) return firstWarm.promise;
        return Response.json({ text: "should not run" });
      },
    });
    const cfg = { whisperPort: 8642 } as Config;
    expect(await client.probeReadyUnlocked(cfg, 1_000)).toBeTrue();

    const first = client.transcribeWarm(cfg, new Uint8Array(44), 1_000);
    const queued = client.transcribeWarm(cfg, new Uint8Array(44), 1_000);
    firstWarm.resolve(new Response("down", { status: 503 }));

    expect((await first).status).toBe("failed");
    expect((await queued).status).toBe("unavailable");
    expect(requests).toBe(3);
  });

  test("shutdown cancellation fails closed and releases a warm request that ignores abort", async () => {
    const warmStarted = deferred<void>();
    const never = deferred<Response>();
    let requests = 0;
    const client = new WhisperServerClient({
      request: async () => {
        requests++;
        if (requests === 1) return new Response("root", { status: 200 });
        if (requests === 2) return Response.json({ text: "" });
        warmStarted.resolve();
        return never.promise;
      },
    });
    const cfg = { whisperPort: 8642 } as Config;
    expect(await client.probeReadyUnlocked(cfg, 1_000)).toBeTrue();
    const warm = client.transcribeWarm(cfg, new Uint8Array(44), 60_000);
    await warmStarted.promise;

    client.cancelWarmRequests();
    expect((await warm).status).toBe("failed");
    expect(client.serverUp()).toBeFalse();
  });

  test("an adopted server is polled while ready, quietly, and replaced by our own when it stops answering", async () => {
    // An adopted server is someone else's process: no exit promise fires when
    // it dies. Before D3 a ready adopted server was never re-probed, so its
    // death cost one lost utterance to notice, and only the request path could.
    const logs: string[] = [];
    const h = harness({ log: (message) => { logs.push(message); } });
    h.presence.push(true);
    h.readiness.push(true);
    expect(await h.supervisor.start()).toBeTrue();
    expect(h.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "adopted", periodicArmed: true });
    expect(h.timers.at(-1)!.ms).toBe(30_000);

    // Still answering: no log line, status never flickers, the poll re-arms.
    const quiet = logs.length;
    h.presence.push(true);
    h.readiness.push(true);
    h.timers.findLast((timer) => !timer.cancelled)!.callback();
    await h.supervisor.settled();
    expect(logs).toHaveLength(quiet);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "adopted", periodicArmed: true });

    // Gone: the poll notices, says so, and starts our own — never killing anything.
    h.presence.push(false, false, false);
    h.readiness.push(true);
    h.timers.findLast((timer) => !timer.cancelled)!.callback();
    await h.supervisor.settled();
    expect(logs.slice(quiet)).toEqual([
      "adopted whisper-server stopped answering (absent)",
      "whisper-server recovered after 1 replacement attempt(s)",
    ]);
    expect(h.terminated).toHaveLength(0);
    expect(h.children).toHaveLength(1);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "owned", periodicArmed: false });
    h.supervisor.close();
  });

  test("owned shutdown invalidates readiness before killing the child", async () => {
    const h = harness();
    h.presence.push(false);
    h.readiness.push(true);
    expect(await h.supervisor.start()).toBeTrue();

    h.supervisor.close();
    expect(h.resets).toHaveLength(1);
    expect(h.children[0]!.kills).toEqual(["SIGKILL"]);
  });
});

describe("idle unload and prewarm (D2)", () => {
  const IDLE_MS = 20 * 60_000;
  const POLL_MS = 30_000;
  /** Fire-and-forget work (an unload, a prewarm's start) settles in a few microtask turns. */
  async function until(condition: () => boolean): Promise<void> {
    for (let tick = 0; tick < 50 && !condition(); tick++) await Bun.sleep(0);
    expect(condition()).toBeTrue();
  }

  test("an owned server idle for the window is stopped once, and the mic signal reloads it", async () => {
    // The warm server held ~628MB for the daemon's whole life; before D2 the
    // only stop was shutdown. The fake clock is the harness's timer list.
    const logs: string[] = [];
    const h = harness({ idleUnloadMs: () => IDLE_MS, log: (message) => { logs.push(message); } });
    h.presence.push(false);
    h.readiness.push(true);
    expect(await h.supervisor.start()).toBeTrue();
    const idleTimers = () => h.timers.filter((timer) => !timer.cancelled && timer.ms === IDLE_MS);
    expect(idleTimers()).toHaveLength(1);

    // A served transcription restarts the clock rather than adding a second one.
    const first = idleTimers()[0]!;
    h.supervisor.armIdleUnload();
    expect(first.cancelled).toBeTrue();
    expect(idleTimers()).toHaveLength(1);

    // The window elapses: the owned child is terminated inside the request
    // lane, readiness is invalidated, and the log says so exactly once.
    const spent = idleTimers()[0]!;
    spent.callback();
    spent.cancelled = true; // a fired one-shot is spent; the fake clock does not retire it by itself
    await until(() => h.terminated.length === 1);
    expect(h.terminated).toEqual([h.children[0]!]);
    expect(h.resets.length).toBeGreaterThanOrEqual(1);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "unloaded", periodicArmed: false });
    expect(logs.filter((line) => line.includes("idle for 20 min — unloaded"))).toHaveLength(1);

    // The retired child's exit must not restart it: that is what "unloaded" means.
    h.children[0]!.exit.resolve(0);
    await Bun.sleep(0);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "unloaded", ownership: "none" });
    h.supervisor.requestRecovery("request-failed");
    await h.supervisor.settled();
    expect(h.children).toHaveLength(1);

    // A mic is about to open: reload with the same bounded start as boot. A
    // second signal while it is still warming is a no-op, not a second spawn.
    h.presence.push(false);
    h.readiness.push(true);
    h.supervisor.prewarm();
    h.supervisor.prewarm();
    await until(() => h.supervisor.snapshot().status === "ready");
    expect(h.children).toHaveLength(2);
    expect(h.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "owned" });
    expect(logs.filter((line) => line === "whisper-server reloading — a mic is about to open")).toHaveLength(1);
    expect(idleTimers()).toHaveLength(1); // and the clock is running again
    h.supervisor.close();
    expect(idleTimers()).toHaveLength(0);
  });

  test("a warm server treats the mic signal as activity, and an adopted one is never unloaded", async () => {
    const h = harness({ idleUnloadMs: () => IDLE_MS });
    h.presence.push(false);
    h.readiness.push(true);
    expect(await h.supervisor.start()).toBeTrue();
    const idle = h.timers.findLast((timer) => !timer.cancelled)!;
    h.supervisor.prewarm();
    expect(idle.cancelled).toBeTrue();
    expect(h.children).toHaveLength(1);
    expect(h.timers.filter((timer) => !timer.cancelled).map((timer) => timer.ms)).toEqual([IDLE_MS]);
    h.supervisor.close();

    // Someone else's process: only the D3 poll runs, never an idle clock.
    const adopted = harness({ idleUnloadMs: () => IDLE_MS });
    adopted.presence.push(true);
    adopted.readiness.push(true);
    expect(await adopted.supervisor.start()).toBeTrue();
    expect(adopted.supervisor.snapshot()).toMatchObject({ status: "ready", ownership: "adopted" });
    adopted.supervisor.armIdleUnload();
    expect(adopted.timers.filter((timer) => !timer.cancelled).map((timer) => timer.ms)).toEqual([POLL_MS]);
    adopted.supervisor.close();
  });

  test("the window is read live: 0 disarms, a new value re-arms at the next transcription", async () => {
    let minutes = 20;
    const h = harness({ idleUnloadMs: () => minutes * 60_000 });
    h.presence.push(false);
    h.readiness.push(true);
    expect(await h.supervisor.start()).toBeTrue();
    const armed = () => h.timers.filter((timer) => !timer.cancelled).map((timer) => timer.ms);
    expect(armed()).toEqual([20 * 60_000]);
    minutes = 0;
    h.supervisor.armIdleUnload();
    expect(armed()).toEqual([]);
    minutes = 5;
    h.supervisor.armIdleUnload();
    expect(armed()).toEqual([5 * 60_000]);
    h.supervisor.close();
  });

  test("the client reports each served warm transcription and nothing for a canary or a failure", async () => {
    const responses = [
      new Response("root", { status: 200 }),
      Response.json({ text: "" }),
      Response.json({ text: "hello" }),
      new Response("down", { status: 503 }),
    ];
    const client = new WhisperServerClient({
      request: async () => responses.shift() ?? new Response("unexpected", { status: 500 }),
    });
    const cfg = { whisperPort: 8642 } as Config;
    let served = 0;
    client.setServedHandler(() => { served++; });
    expect(await client.probeReadyUnlocked(cfg, 1_000)).toBeTrue();
    expect(served).toBe(0);
    expect((await client.transcribeWarm(cfg, new Uint8Array(44), 1_000)).status).toBe("ok");
    expect(served).toBe(1);
    expect((await client.transcribeWarm(cfg, new Uint8Array(44), 1_000)).status).toBe("failed");
    expect(served).toBe(1);
  });
});

describe("D2 wiring inside runDaemon", () => {
  // runDaemon runs in no test; its wiring is pinned by source, the way the
  // audio-lease and control-server seams are.
  const daemonSource = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");

  function between(startMarker: string, endMarker: string): string {
    const start = daemonSource.indexOf(startMarker);
    expect(start).toBeGreaterThan(-1);
    const end = daemonSource.indexOf(endMarker, start);
    expect(end).toBeGreaterThan(start);
    return daemonSource.slice(start, end);
  }

  test("served transcriptions re-arm the clock, the window is read live, and a setting change re-arms", () => {
    expect(daemonSource).toContain("whisperServerClient.setServedHandler(() => whisperSupervisor?.armIdleUnload())");
    const construction = between(
      "whisperSupervisor = new ServerSupervisor<WhisperRecoveryReason>({",
      "resetReadiness: () => whisperServerClient.resetHealth()",
    );
    expect(construction).toContain("idleUnloadMs: () => cfg.whisperIdleUnloadMins * 60_000");
    expect(daemonSource).toContain('if (key === "whisper-idle-unload") whisperSupervisor?.armIdleUnload()');
  });

  // The order — a wake prewarms before its courtesy line, a finished turn
  // before the bell — is executed in voice-loop.test.ts. What stays here is
  // the daemon handing the loop this supervisor's prewarm.
  test("the voice loop's prewarm is the whisper supervisor's", () => {
    expect(daemonSource).toContain("prewarmEar: () => whisperSupervisor?.prewarm(),");
  });
});
