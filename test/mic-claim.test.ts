import { describe, expect, test } from "bun:test";
import { MicClaimPoller, MicClaimWatcher } from "../src/mic-claim.ts";
import { SettingsPauseLifecycle } from "../src/pause-controller.ts";

interface FakeInterval {
  callback: () => void;
  ms: number;
  cleared: boolean;
}

class FakeClock {
  readonly intervals: FakeInterval[] = [];
  readonly cleared: unknown[] = [];

  setInterval(callback: () => void, ms: number): unknown {
    const interval = { callback, ms, cleared: false };
    this.intervals.push(interval);
    return interval;
  }

  clearInterval(handle: unknown): void {
    this.cleared.push(handle);
    (handle as FakeInterval).cleared = true;
  }
}

describe("MicClaimWatcher", () => {
  test("claims on the second consecutive busy tick and releases on the third free tick", () => {
    let inUse = true;
    const transitions: string[] = [];
    const watcher = new MicClaimWatcher({
      inUse: () => inUse,
      selfOwned: () => false,
      onClaim: () => transitions.push("claim"),
      onRelease: () => transitions.push("release"),
    });

    watcher.tick();
    expect(watcher.claimed).toBeFalse();
    expect(transitions).toEqual([]);

    watcher.tick();
    expect(watcher.claimed).toBeTrue();
    expect(transitions).toEqual(["claim"]);

    watcher.tick();
    expect(transitions).toEqual(["claim"]);

    inUse = false;
    watcher.tick();
    watcher.tick();
    expect(watcher.claimed).toBeTrue();
    expect(transitions).toEqual(["claim"]);

    watcher.tick();
    expect(watcher.claimed).toBeFalse();
    expect(transitions).toEqual(["claim", "release"]);

    watcher.tick();
    expect(transitions).toEqual(["claim", "release"]);
  });

  test("opposite observations reset partial claim and release runs", () => {
    let inUse = true;
    const transitions: string[] = [];
    const watcher = new MicClaimWatcher({
      inUse: () => inUse,
      selfOwned: () => false,
      onClaim: () => transitions.push("claim"),
      onRelease: () => transitions.push("release"),
      claimTicks: 2,
      releaseTicks: 3,
    });

    watcher.tick();
    inUse = false;
    watcher.tick();
    inUse = true;
    watcher.tick();
    expect(watcher.claimed).toBeFalse();
    watcher.tick();
    expect(watcher.claimed).toBeTrue();

    inUse = false;
    watcher.tick();
    inUse = true;
    watcher.tick();
    inUse = false;
    watcher.tick();
    watcher.tick();
    expect(watcher.claimed).toBeTrue();
    watcher.tick();

    expect(watcher.claimed).toBeFalse();
    expect(transitions).toEqual(["claim", "release"]);
  });

  test("self-owned ticks skip the detector and freeze both debounce counters", () => {
    let inUse = true;
    let selfOwned = false;
    let detectorCalls = 0;
    const transitions: string[] = [];
    const watcher = new MicClaimWatcher({
      inUse() {
        detectorCalls++;
        return inUse;
      },
      selfOwned: () => selfOwned,
      onClaim: () => transitions.push("claim"),
      onRelease: () => transitions.push("release"),
      claimTicks: 2,
      releaseTicks: 3,
    });

    watcher.tick();
    expect(detectorCalls).toBe(1);
    selfOwned = true;
    watcher.tick();
    watcher.tick();
    expect(detectorCalls).toBe(1);
    expect(watcher.claimed).toBeFalse();

    selfOwned = false;
    watcher.tick();
    expect(detectorCalls).toBe(2);
    expect(watcher.claimed).toBeTrue();

    inUse = false;
    watcher.tick();
    selfOwned = true;
    watcher.tick();
    expect(detectorCalls).toBe(3);
    selfOwned = false;
    watcher.tick();
    expect(watcher.claimed).toBeTrue();
    watcher.tick();

    expect(watcher.claimed).toBeFalse();
    expect(transitions).toEqual(["claim", "release"]);
    expect(detectorCalls).toBe(5);
  });

  test("unknown detector reads preserve both debounce counters", () => {
    let inUse: boolean | null = true;
    const transitions: string[] = [];
    const watcher = new MicClaimWatcher({
      inUse: () => inUse,
      selfOwned: () => false,
      onClaim: () => transitions.push("claim"),
      onRelease: () => transitions.push("release"),
      claimTicks: 2,
      releaseTicks: 3,
    });

    watcher.tick();
    inUse = null;
    watcher.tick();
    watcher.tick();
    inUse = true;
    watcher.tick();
    expect(watcher.claimed).toBeTrue();

    inUse = false;
    watcher.tick();
    inUse = null;
    watcher.tick();
    inUse = false;
    watcher.tick();
    expect(watcher.claimed).toBeTrue();
    watcher.tick();

    expect(watcher.claimed).toBeFalse();
    expect(transitions).toEqual(["claim", "release"]);
  });

  test("close restores a claimed owner once and permanently stops polling", () => {
    let detectorCalls = 0;
    const transitions: string[] = [];
    const watcher = new MicClaimWatcher({
      inUse() {
        detectorCalls++;
        return true;
      },
      selfOwned: () => false,
      onClaim: () => transitions.push("claim"),
      onRelease: () => transitions.push("release"),
      claimTicks: 1,
    });

    watcher.tick();
    expect(watcher.claimed).toBeTrue();

    watcher.close();
    watcher.close();
    watcher.tick();

    expect(watcher.claimed).toBeFalse();
    expect(transitions).toEqual(["claim", "release"]);
    expect(detectorCalls).toBe(1);
  });

  test("claim and release drive the pause lifecycle without announcements", () => {
    let inUse = true;
    let paused = false;
    const transitions: Array<{ paused: boolean; announce: boolean; interrupt: boolean }> = [];
    const pause = new SettingsPauseLifecycle({
      get paused() {
        return paused;
      },
      setPaused(next, options = {}) {
        transitions.push({
          paused: next,
          announce: options.announce ?? true,
          interrupt: options.interrupt ?? false,
        });
        paused = next;
      },
    });
    const watcher = new MicClaimWatcher({
      inUse: () => inUse,
      selfOwned: () => false,
      onClaim: () => pause.open(),
      onRelease: () => pause.close(),
      claimTicks: 1,
      releaseTicks: 1,
    });

    watcher.tick();
    expect(paused).toBeTrue();
    inUse = false;
    watcher.tick();

    expect(paused).toBeFalse();
    expect(transitions).toEqual([
      { paused: true, announce: false, interrupt: true },
      { paused: false, announce: false, interrupt: false },
    ]);
  });
});

describe("MicClaimPoller", () => {
  test("the disabled gate creates neither a detector nor a timer", () => {
    const clock = new FakeClock();
    let factoryCalls = 0;
    const poller = new MicClaimPoller({
      enabled: false,
      clock,
      createWatcher() {
        factoryCalls++;
        return new MicClaimWatcher({
          inUse: () => {
            throw new Error("disabled poller touched the detector");
          },
          selfOwned: () => false,
          onClaim() {},
          onRelease() {},
        });
      },
    });

    poller.tick();

    expect(poller.claimed).toBeFalse();
    expect(factoryCalls).toBe(0);
    expect(clock.intervals).toEqual([]);
    expect(clock.cleared).toEqual([]);
  });

  test("live enable starts polling and disable clears the timer and restores pause", () => {
    const clock = new FakeClock();
    const transitions: string[] = [];
    let factoryCalls = 0;
    const poller = new MicClaimPoller({
      enabled: false,
      intervalMs: 17,
      clock,
      createWatcher() {
        factoryCalls++;
        return new MicClaimWatcher({
          inUse: () => true,
          selfOwned: () => false,
          onClaim: () => transitions.push("claim"),
          onRelease: () => transitions.push("release"),
          claimTicks: 2,
        });
      },
    });

    poller.setEnabled(true);
    expect(factoryCalls).toBe(1);
    expect(clock.intervals).toHaveLength(1);
    expect(clock.intervals[0]?.ms).toBe(17);

    clock.intervals[0]?.callback();
    expect(poller.claimed).toBeFalse();
    clock.intervals[0]?.callback();
    expect(poller.claimed).toBeTrue();
    expect(transitions).toEqual(["claim"]);

    poller.setEnabled(false);
    poller.setEnabled(false);
    expect(poller.claimed).toBeFalse();
    expect(transitions).toEqual(["claim", "release"]);
    expect(clock.cleared).toEqual([clock.intervals[0]]);
    expect(clock.intervals[0]?.cleared).toBeTrue();

    poller.setEnabled(true);
    expect(factoryCalls).toBe(2);
    expect(clock.intervals).toHaveLength(2);
    poller.close();
    poller.close();
    expect(clock.cleared).toEqual([clock.intervals[0], clock.intervals[1]]);
  });
});
