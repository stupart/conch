import { describe, expect, test } from "bun:test";
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
