import { afterEach, describe, expect, test } from "bun:test";
import {
  refreshPublishedConversationState,
  type PublishedState,
} from "../src/panel.ts";
import { createPublishThrottle } from "../src/publish-throttle.ts";
import {
  clearReadingProgress,
  getLiveState,
  onLiveDataChange,
  setReadingProgress,
  setState,
  setTranscriptPrefix,
} from "../src/status.ts";

class FakeClock {
  time = 0;
  #nextId = 1;
  #timers = new Map<number, { at: number; callback: () => void }>();

  setTimer = (callback: () => void, delayMs: number): number => {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.time + delayMs, callback });
    return id;
  };

  clearTimer = (timer: unknown): void => {
    this.#timers.delete(timer as number);
  };

  advance(ms: number): void {
    const target = this.time + ms;
    while (true) {
      const next = [...this.#timers]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.#timers.delete(id);
      this.time = timer.at;
      timer.callback();
    }
    this.time = target;
  }
}

function basePublishedState(): PublishedState {
  return {
    v: 1,
    ts: 0,
    mode: { muted: false, paused: false, holding: 0 },
    live: { state: "idle", label: "" },
    rows: [{
      id: "session",
      label: "Session",
      status: "waiting",
      needsResponse: false,
      paused: false,
      muted: false,
      live: null,
      active: false,
    }],
    dismissed: [],
  };
}

function throttleOptions(clock: FakeClock) {
  return {
    intervalMs: 100,
    now: () => clock.time,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };
}

afterEach(() => {
  onLiveDataChange(null);
  setTranscriptPrefix("");
  clearReadingProgress();
  setState("idle");
});

describe("published-state throttle", () => {
  test("coalesces a rapid burst to 10 Hz and writes the final value", () => {
    const clock = new FakeClock();
    let latest = "leading";
    const writes: Array<{ at: number; value: string }> = [];
    const throttle = createPublishThrottle(() => {
      writes.push({ at: clock.time, value: latest });
    }, throttleOptions(clock));

    throttle.request();
    for (const value of ["one", "two", "final"]) {
      clock.advance(20);
      latest = value;
      throttle.request();
    }

    expect(writes).toEqual([{ at: 0, value: "leading" }]);
    expect(throttle.pending()).toBe(true);
    clock.advance(39);
    expect(writes).toHaveLength(1);
    clock.advance(1);

    expect(writes).toEqual([
      { at: 0, value: "leading" },
      { at: 100, value: "final" },
    ]);
    expect(throttle.pending()).toBe(false);
  });

  test("continuous updates never write less than 100 ms apart", () => {
    const clock = new FakeClock();
    let latest = 0;
    const writes: Array<{ at: number; value: number }> = [];
    const throttle = createPublishThrottle(() => {
      writes.push({ at: clock.time, value: latest });
    }, throttleOptions(clock));

    throttle.request();
    for (let index = 1; index <= 12; index++) {
      clock.advance(25);
      latest = index;
      throttle.request();
    }
    clock.advance(100);

    expect(writes.at(-1)?.value).toBe(12);
    expect(writes.length).toBeLessThan(12);
    for (let index = 1; index < writes.length; index++) {
      expect(writes[index]!.at - writes[index - 1]!.at).toBeGreaterThanOrEqual(100);
    }
  });

  test("a full-model replacement wins over an older pending live patch", () => {
    const clock = new FakeClock();
    let latest = { ledger: "old", partial: "leading" };
    const writes: Array<typeof latest> = [];
    const throttle = createPublishThrottle(() => {
      writes.push({ ...latest });
    }, throttleOptions(clock));

    throttle.request();
    clock.advance(20);
    latest = { ...latest, partial: "cheap live patch" };
    throttle.request();
    clock.advance(20);
    latest = { ledger: "new full model", partial: "final live state" };
    throttle.request();
    clock.advance(60);

    expect(writes).toEqual([
      { ledger: "old", partial: "leading" },
      { ledger: "new full model", partial: "final live state" },
    ]);
  });

  test("state, same-state dictation partial, prefix, and reading setters all publish", () => {
    onLiveDataChange(null);
    setTranscriptPrefix("");
    clearReadingProgress();
    setState("idle");

    const clock = new FakeClock();
    let retained = basePublishedState();
    const writes: PublishedState[] = [];
    const throttle = createPublishThrottle(() => {
      writes.push(structuredClone(retained));
    }, throttleOptions(clock));
    onLiveDataChange(() => {
      retained = refreshPublishedConversationState(
        retained,
        getLiveState(),
        "session",
        clock.time,
      );
      throttle.request();
    });

    setState("recording", "Session", "first partial");
    expect(writes.at(-1)?.live.partial).toBe("first partial");

    setState("recording", "Session", "final partial");
    clock.advance(100);
    expect(writes.at(-1)?.live.partial).toBe("final partial");

    setTranscriptPrefix("committed words");
    clock.advance(100);
    expect(writes.at(-1)?.live.transcriptPrefix).toBe("committed words");

    setReadingProgress("Assistant reply", 9);
    clock.advance(100);
    expect(writes.at(-1)?.live.reading).toEqual({
      text: "Assistant reply",
      spokenChars: 9,
    });
    expect(writes.at(-1)?.reply).toEqual({
      sessionId: "session",
      text: "Assistant reply",
      spokenChars: 9,
    });
  });

  test("flush writes the last pending state before shutdown", () => {
    const clock = new FakeClock();
    let latest = "first";
    const writes: string[] = [];
    const throttle = createPublishThrottle(() => writes.push(latest), throttleOptions(clock));

    throttle.request();
    clock.advance(10);
    latest = "shutdown-final";
    throttle.request();

    expect(throttle.flush()).toBe(true);
    expect(writes).toEqual(["first", "shutdown-final"]);
    clock.advance(1_000);
    expect(writes).toEqual(["first", "shutdown-final"]);
  });

  test("a request made reentrantly by the writer waits for the next interval", () => {
    const clock = new FakeClock();
    const writes: number[] = [];
    let throttle!: ReturnType<typeof createPublishThrottle>;
    throttle = createPublishThrottle(() => {
      writes.push(clock.time);
      if (writes.length === 1) throttle.request();
    }, throttleOptions(clock));

    throttle.request();
    expect(writes).toEqual([0]);
    expect(throttle.pending()).toBe(true);
    clock.advance(99);
    expect(writes).toEqual([0]);
    clock.advance(1);
    expect(writes).toEqual([0, 100]);
  });

  test("cancel drops a trailing write and the throttle remains reusable", () => {
    const clock = new FakeClock();
    let latest = "leading";
    const writes: string[] = [];
    const throttle = createPublishThrottle(() => writes.push(latest), throttleOptions(clock));

    throttle.request();
    clock.advance(10);
    latest = "cancelled";
    throttle.request();
    throttle.cancel();
    clock.advance(190);
    expect(writes).toEqual(["leading"]);

    latest = "reused";
    throttle.request();
    expect(writes).toEqual(["leading", "reused"]);
  });
});
