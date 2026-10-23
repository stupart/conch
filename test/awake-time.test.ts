import { describe, expect, test } from "bun:test";
import { awaitWithWatchdog } from "../src/audio-watchdog.ts";
import { SUSPENDED_SLACK_MS, awakeTimeout, wasSuspended } from "../src/awake-time.ts";

/**
 * A Mac asleep, for a test: wall-clock that leaps a quarter of an hour on every look while `asleep` is set, the way a
 * timer armed before a sleep sees it when it fires on the wake.
 */
function sleepyClock() {
  let offset = 0;
  const clock = {
    asleep: false,
    now: () => {
      if (clock.asleep) offset += 15 * 60_000;
      return Date.now() + offset;
    },
  };
  return clock;
}

describe("time awake (awake-time.ts)", () => {
  test("a tick late by more than the slack was not running; one on time, or a little late, was", () => {
    expect(wasSuspended(1_000, 1_000)).toBeFalse();
    expect(wasSuspended(1_000 + SUSPENDED_SLACK_MS, 1_000)).toBeFalse();
    expect(wasSuspended(1_001 + SUSPENDED_SLACK_MS, 1_000)).toBeTrue();
    // The overnight log's wake: a 60 s tick that came back after 974 s.
    expect(wasSuspended(974_000, 60_000)).toBeTrue();
    // A wall-clock set back is not sleep.
    expect(wasSuspended(-30_000, 1_000)).toBeFalse();
  });

  test("awake, it fires after its time, like setTimeout", async () => {
    const started = performance.now();
    await new Promise<void>((resolve) => awakeTimeout(resolve, 60, { tickMs: 20 }));
    expect(performance.now() - started).toBeGreaterThanOrEqual(55);
  });

  test("time the Mac slept is not counted: the work gets its whole budget awake after the wake", async () => {
    const clock = sleepyClock();
    let fired = 0;
    const clear = awakeTimeout(() => { fired++; }, 60, { tickMs: 20, now: clock.now });
    clock.asleep = true;
    await Bun.sleep(200);
    // A plain setTimeout(60) would have fired at 60 ms, in the sleep.
    expect(fired).toBe(0);
    // Awake again: still at least two ticks of its budget to go.
    clock.asleep = false;
    await Bun.sleep(10);
    expect(fired).toBe(0);
    await Bun.sleep(150);
    expect(fired).toBe(1);
    clear();
  });

  test("cleared, it never fires", async () => {
    let fired = 0;
    const clear = awakeTimeout(() => { fired++; }, 30, { tickMs: 10 });
    await Bun.sleep(15);
    clear();
    await Bun.sleep(60);
    expect(fired).toBe(0);
  });

  test("awaitWithWatchdog arms its deadline through the seam, and keeps its warning", async () => {
    const clock = sleepyClock();
    const warnings: string[] = [];
    clock.asleep = true;
    let release!: (value: string) => void;
    const work = new Promise<string>((resolve) => { release = resolve; });
    const outcome = awaitWithWatchdog(work, {
      operation: "kokoro worker startup",
      timeoutMs: 40,
      timeoutAction: "killed",
      warn: (message) => warnings.push(message),
      deadline: (fire, ms) => awakeTimeout(fire, ms, { tickMs: 10, now: clock.now }),
    });
    await Bun.sleep(120);
    release("ready");
    expect(await outcome).toEqual({ status: "completed", value: "ready" });
    expect(warnings).toEqual([]);

    clock.asleep = false;
    const hung = await awaitWithWatchdog(new Promise<string>(() => {}), {
      operation: "kokoro worker startup",
      timeoutMs: 40,
      timeoutAction: "killed",
      warn: (message) => warnings.push(message),
      deadline: (fire, ms) => awakeTimeout(fire, ms, { tickMs: 10, now: clock.now }),
    });
    expect(hung).toEqual({ status: "timed-out" });
    expect(warnings).toEqual(["⚠ kokoro worker startup timed out after 40ms — killed, moving on"]);
  });
});
