import { describe, expect, test } from "bun:test";
import {
  AUDIO_TIMEOUT_CEILING_MS,
  AUDIO_TIMEOUT_FLOOR_MS,
  audioTimeoutMs,
  awaitProcessWithWatchdog,
  awaitWithAbort,
  type WatchdogProcess,
} from "../src/audio-watchdog.ts";

function never(): Promise<number> {
  return new Promise(() => {});
}

describe("audio watchdog budget", () => {
  test("scales from an 8s floor to a 120s hard ceiling", () => {
    expect(audioTimeoutMs(0)).toBe(AUDIO_TIMEOUT_FLOOR_MS);
    expect(audioTimeoutMs(80)).toBe(8_000);
    expect(audioTimeoutMs(81)).toBe(9_000);
    expect(audioTimeoutMs(350)).toBe(35_000);
    expect(audioTimeoutMs(50_000)).toBe(AUDIO_TIMEOUT_CEILING_MS);
  });
});

test("a never-exiting child is force-killed and the watchdog still resolves", async () => {
  const kills: Array<number | NodeJS.Signals | undefined> = [];
  let unrefs = 0;
  const warnings: string[] = [];
  const child: WatchdogProcess = {
    exited: never(),
    kill: (signal) => kills.push(signal),
    unref: () => unrefs++,
  };

  const result = await awaitProcessWithWatchdog(child, {
    operation: "say",
    timeoutMs: 5,
    warn: (message) => warnings.push(message),
  });

  expect(result.status).toBe("timed-out");
  expect(kills).toEqual(["SIGKILL"]);
  expect(unrefs).toBe(1);
  expect(warnings).toEqual(["⚠ say timed out after 5ms — killed, moving on"]);
});

test("normal completion is neither killed nor warned", async () => {
  const kills: unknown[] = [];
  const warnings: string[] = [];
  const result = await awaitProcessWithWatchdog({
    exited: Promise.resolve(0),
    kill: (signal) => kills.push(signal),
  }, {
    operation: "afplay speech",
    timeoutMs: 25,
    warn: (message) => warnings.push(message),
  });

  expect(result).toEqual({ status: "completed", value: 0 });
  expect(kills).toEqual([]);
  expect(warnings).toEqual([]);
});

test("explicit cancellation force-kills and resolves without a timeout warning", async () => {
  const controller = new AbortController();
  const kills: Array<number | NodeJS.Signals | undefined> = [];
  const warnings: string[] = [];
  const waiting = awaitProcessWithWatchdog({
    exited: never(),
    kill: (signal) => kills.push(signal),
  }, {
    operation: "say",
    timeoutMs: 100,
    signal: controller.signal,
    warn: (message) => warnings.push(message),
  });

  controller.abort();
  expect((await waiting).status).toBe("cancelled");
  expect(kills).toEqual(["SIGKILL"]);
  expect(warnings).toEqual([]);
});

test("a throwing logger cannot keep a timed-out operation pending", async () => {
  const result = await awaitProcessWithWatchdog({
    exited: never(),
    kill() {},
  }, {
    operation: "say",
    timeoutMs: 5,
    warn: () => { throw new Error("logger unavailable"); },
  });

  expect(result.status).toBe("timed-out");
});

test("an AbortSignal settles work that ignores cancellation", async () => {
  const controller = new AbortController();
  const waiting = awaitWithAbort(new Promise<string>(() => {}), controller.signal);
  controller.abort(new DOMException("test abort", "AbortError"));
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
});
