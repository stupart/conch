import { describe, expect, test } from "bun:test";
import { parseProcessParents, sameProcessParents, SharedLook } from "../src/process-look.ts";

function look(answers: Array<number | null>, clock: { now: number }) {
  let reads = 0;
  const shared = new SharedLook<number>({
    read: async () => answers[Math.min(reads++, answers.length - 1)] ?? null,
    same: (a, b) => a === b,
    minIntervalMs: 1_000,
    maxIntervalMs: 8_000,
    now: () => clock.now,
  });
  return { shared, reads: () => reads };
}

describe("SharedLook", () => {
  test("one look answers everyone who asks within the interval, and those who ask at once share it", async () => {
    const clock = { now: 0 };
    const { shared, reads } = look([1, 2], clock);
    expect(await Promise.all([shared.get(), shared.get(), shared.get()])).toEqual([1, 1, 1]);
    expect(reads()).toBe(1);
    clock.now = 999;
    expect(await shared.get()).toBe(1);
    expect(reads()).toBe(1);
    clock.now = 1_000;
    expect(await shared.get()).toBe(2);
    expect(reads()).toBe(2);
  });

  test("backs off while nothing changes, and a nudge brings it back", async () => {
    const clock = { now: 0 };
    const { shared } = look([5], clock);
    await shared.get();
    expect(shared.interval()).toBe(1_000);
    for (const expected of [2_000, 4_000, 8_000, 8_000]) {
      clock.now += shared.interval();
      await shared.get();
      expect(shared.interval()).toBe(expected);
    }
    shared.nudge();
    expect(shared.interval()).toBe(1_000);
  });

  test("invalidate: the next ask looks again at once, and a look begun before it doesn't answer after it", async () => {
    const clock = { now: 0 };
    let release!: () => void;
    let reads = 0;
    const shared = new SharedLook<number>({
      read: () => {
        reads += 1;
        const n = reads;
        return n === 2 ? new Promise((done) => { release = () => done(n); }) : Promise.resolve(n);
      },
      same: () => false,
      minIntervalMs: 1_000,
      maxIntervalMs: 8_000,
      now: () => clock.now,
    });
    expect(await shared.get()).toBe(1);
    shared.invalidate();
    const slow = shared.get(); // look 2, under way
    shared.invalidate(); // something moved while it ran
    expect(await shared.get()).toBe(3);
    release();
    expect(await slow).toBe(2);
    // Look 2 answered its own asker and kept nothing: 3 stands.
    expect(await shared.get()).toBe(3);
    expect(shared.peek()?.value).toBe(3);
  });

  test("maxAgeMs 0 looks now; a failed look keeps nothing", async () => {
    const clock = { now: 0 };
    const { shared, reads } = look([1, null, 3], clock);
    await shared.get();
    expect(await shared.get({ maxAgeMs: 0 })).toBeNull();
    expect(shared.peek()?.value).toBe(1);
    expect(await shared.get({ maxAgeMs: 0 })).toBe(3);
    expect(reads()).toBe(3);
  });
});

describe("the process table", () => {
  test("parses ps's two columns and compares tables", () => {
    const table = parseProcessParents("    1     0\n  412     1\n 9001   412\n\ngarbage\n");
    expect([...table]).toEqual([[1, 0], [412, 1], [9001, 412]]);
    expect(sameProcessParents(table, new Map([[1, 0], [412, 1], [9001, 412]]))).toBe(true);
    expect(sameProcessParents(table, new Map([[1, 0], [412, 1], [9001, 1]]))).toBe(false);
    expect(sameProcessParents(table, new Map([[1, 0], [412, 1]]))).toBe(false);
  });
});

describe("processParentTableWith", () => {
  test("a process younger than the shared look is placed by a look taken now; a gone one asks for nothing", async () => {
    const { processParentTable, processParentTableWith } = await import("../src/window-key.ts");
    const { processLook } = await import("../src/process-look.ts");
    processLook.invalidate();
    const first = await processParentTable();
    expect(first?.has(process.pid)).toBe(true);
    const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      // The shared look is still fresh, and doesn't know the child.
      expect(await processParentTable()).toBe(first);
      const placed = await processParentTableWith([child.pid]);
      expect(placed?.get(child.pid)).toBe(process.pid);
      // A pid that isn't alive doesn't send it to `ps` again.
      expect(await processParentTableWith([2_147_000_000])).toBe(placed);
    } finally {
      child.kill();
    }
  });
});
