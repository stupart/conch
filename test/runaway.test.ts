import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendCapped,
  Breaker,
  CHILD_CEILING,
  childCeilingFrom,
  ChildCeilingError,
  duration,
  installChildCeiling,
  LogDamper,
  logShape,
  RESTART_POLICY,
  RunawayGuards,
} from "../src/runaway.ts";

const MIN = 60_000;

function clock(start = 1_000_000) {
  const state = { now: start };
  return { state, now: () => state.now, advance: (ms: number) => { state.now += ms; } };
}

describe("Breaker", () => {
  test("allows `limit` events in its window, refuses the next, and says why", () => {
    const time = clock();
    const breaker = new Breaker({ name: "whisper-server", what: "restarting whisper-server", now: time.now });
    for (let i = 1; i < RESTART_POLICY.limit; i++) {
      expect(breaker.allows()).toBe(true);
      expect(breaker.record(`exit ${i}`)).toBe(true);
      time.advance(10_000);
    }
    expect(breaker.allows()).toBe(true);
    expect(breaker.record("exit 5")).toBe(false); // the fifth happened, and tripped it
    expect(breaker.allows()).toBe(false);
    expect(breaker.waitMs()).toBe(5 * MIN);
    expect(breaker.trip()).toMatchObject({
      name: "whisper-server",
      why: "failed 5 times in 10 min",
      detail: "exit 5",
      trips: 1,
      retryAt: time.now() + 5 * MIN,
    });
  });

  test("events older than the window are forgotten: a slow trickle never trips", () => {
    const time = clock();
    const breaker = new Breaker({ name: "w", what: "w", now: time.now });
    for (let i = 0; i < 50; i++) {
      expect(breaker.record()).toBe(true);
      time.advance(2.5 * MIN); // four a window, never five
    }
    expect(breaker.trip()).toBeNull();
  });

  test("cool-downs grow while it keeps tripping, and start over after a calm spell", () => {
    const time = clock();
    const breaker = new Breaker({ name: "w", what: "w", now: time.now });
    const tripOnce = () => {
      for (let i = 0; i < RESTART_POLICY.limit; i++) breaker.record();
      return breaker.waitMs();
    };
    expect(tripOnce()).toBe(5 * MIN);
    time.advance(5 * MIN);
    expect(breaker.allows()).toBe(true); // a fresh allowance after the cool-down
    expect(tripOnce()).toBe(15 * MIN);
    time.advance(15 * MIN);
    expect(tripOnce()).toBe(60 * MIN);
    time.advance(60 * MIN);
    expect(tripOnce()).toBe(60 * MIN); // the last cool-down repeats
    expect(breaker.trip()?.why).toBe("kept failing: 5 times in 10 min");
    time.advance(RESTART_POLICY.calmMs + 60 * MIN);
    expect(tripOnce()).toBe(5 * MIN);
  });

  test("an event while open is not counted toward the next trip", () => {
    const time = clock();
    const breaker = new Breaker({ name: "w", what: "w", now: time.now });
    for (let i = 0; i < RESTART_POLICY.limit; i++) breaker.record();
    for (let i = 0; i < 20; i++) expect(breaker.record()).toBe(false);
    time.advance(5 * MIN);
    for (let i = 1; i < RESTART_POLICY.limit; i++) expect(breaker.record()).toBe(true);
  });

  test("reset closes it at once", () => {
    const changes: boolean[] = [];
    const breaker = new Breaker({ name: "w", what: "w", changed: (_, tripped) => changes.push(tripped) });
    for (let i = 0; i < RESTART_POLICY.limit; i++) breaker.record();
    breaker.reset();
    expect(breaker.allows()).toBe(true);
    expect(changes).toEqual([true, false]);
  });
});

describe("RunawayGuards", () => {
  test("a trip is logged once, published, and republished when it is over", () => {
    const time = clock();
    const lines: string[] = [];
    let changes = 0;
    const guards = new RunawayGuards({ now: time.now, log: (line) => lines.push(line), changed: () => { changes++; } });
    const breaker = guards.breaker("kokoro", "restarting the natural voices (Kokoro)");
    expect(guards.breaker("kokoro", "ignored")).toBe(breaker);
    for (let i = 0; i < 12; i++) breaker.record("Kokoro worker exited (exit 134)");
    expect(lines).toEqual([
      "runaway guard: stopped restarting the natural voices (Kokoro) — it failed 5 times in 10 min "
        + "(last: Kokoro worker exited (exit 134)); tries again in 5 min",
    ]);
    expect(changes).toBe(1);
    expect(guards.published().map((trip) => trip.name)).toEqual(["kokoro"]);
    time.advance(5 * MIN);
    expect(guards.published()).toEqual([]);
  });

  test("a note shows for its while, logged once however often it is noted", () => {
    const time = clock();
    const lines: string[] = [];
    const guards = new RunawayGuards({ now: time.now, log: (line) => lines.push(line) });
    for (let i = 0; i < 100; i++) {
      guards.note({ name: "processes", what: "starting more processes", why: "had 64 running at once", forMs: 10 * MIN });
      time.advance(1_000);
    }
    expect(lines).toEqual(["runaway guard: stopped starting more processes — it had 64 running at once"]);
    expect(guards.published()).toHaveLength(1);
    expect(guards.published()[0]!.retryAt).toBeUndefined(); // not a cool-down: spawns go through once under it
    expect(guards.published()[0]!.trippedAt).toBe(1_000_000);
    time.advance(11 * MIN);
    expect(guards.published()).toEqual([]);
    guards.note({ name: "processes", what: "starting more processes", why: "had 64 running at once", forMs: 10 * MIN });
    expect(lines).toHaveLength(2);
    expect(guards.published()[0]!.trips).toBe(2);
  });
});

describe("installChildCeiling", () => {
  function fakeTarget() {
    const children: Array<{ exited: Promise<number>; exit: (code: number) => void; argv: unknown }> = [];
    const target = {
      spawn(argv: unknown) {
        let exit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => { exit = resolve; });
        const child = { exited, exit, argv };
        children.push(child);
        return child;
      },
    };
    return { target, children };
  }

  test("refuses past the ceiling, names the pile, and lets a spawn through once one exits", async () => {
    const { target, children } = fakeTarget();
    const refusals: Array<{ live: number; program: string; by: Array<[string, number]> }> = [];
    const ceiling = installChildCeiling({
      limit: 3,
      target: target as never,
      onRefused: (live, program, by) => refusals.push({ live, program, by }),
    });
    target.spawn(["/usr/bin/osascript", "-e", "x"]);
    target.spawn({ cmd: ["/usr/bin/osascript"] } as never);
    target.spawn(["ps"]);
    expect(ceiling.live()).toBe(3);
    expect(() => target.spawn(["tmux", "list-panes"])).toThrow(ChildCeilingError);
    expect(refusals).toEqual([{ live: 3, program: "tmux", by: [["osascript", 2], ["ps", 1]] }]);
    expect(ceiling.refused()).toBe(1);
    children[0]!.exit(0);
    await Bun.sleep(0);
    expect(ceiling.live()).toBe(2);
    expect(() => target.spawn(["tmux"])).not.toThrow();
    ceiling.uninstall();
    target.spawn(["anything"]);
    target.spawn(["anything"]);
    expect(ceiling.live()).toBe(3); // no longer counting
  });

  test("the e2e's knob, and nothing else, moves the ceiling", () => {
    expect(childCeilingFrom({})).toBe(CHILD_CEILING);
    expect(childCeilingFrom({ CONCH_CHILD_CEILING: "0" })).toBe(0);
    expect(childCeilingFrom({ CONCH_CHILD_CEILING: "-3" })).toBe(CHILD_CEILING);
    expect(childCeilingFrom({ CONCH_CHILD_CEILING: "lots" })).toBe(CHILD_CEILING);
  });

  test("wraps the real Bun.spawn and counts a real child until it exits", async () => {
    const original = Bun.spawn;
    const ceiling = installChildCeiling({ limit: 1 });
    try {
      const child = Bun.spawn(["/bin/sleep", "5"]);
      expect(ceiling.live()).toBe(1);
      expect(() => Bun.spawn(["/usr/bin/true"])).toThrow("conch already has 1 child processes running");
      child.kill("SIGKILL");
      await child.exited;
      await Bun.sleep(0);
      expect(ceiling.live()).toBe(0);
      const ok = Bun.spawn(["/usr/bin/true"]);
      expect(await ok.exited).toBe(0);
    } finally {
      ceiling.uninstall();
    }
    expect(Bun.spawn).toBe(original);
  });
});

describe("LogDamper", () => {
  test("lets a burst of one shape through, holds the rest, and counts them when the window closes", () => {
    const time = clock();
    const damper = new LogDamper({ burst: 3, windowMs: MIN, now: time.now });
    const written: string[] = [];
    for (let i = 0; i < 1_000; i++) {
      written.push(...damper.admit(`[conch 10/28 19:${String(i % 60).padStart(2, "0")}:00] phone relay disconnected (1006) — before open`));
      time.advance(10);
    }
    expect(written).toHaveLength(3);
    written.push(...damper.admit("[conch 10/28 19:12:00] phone relay connected"));
    expect(written).toHaveLength(4); // another shape is not held
    time.advance(MIN);
    const next = damper.admit("[conch 10/28 19:13:00] phone relay disconnected (1006) — before open");
    expect(next[0]).toStartWith("(997 more like this in 1 min, last: [conch 10/28 19:39:00] phone relay disconnected");
    expect(next[1]).toBe("[conch 10/28 19:13:00] phone relay disconnected (1006) — before open");
  });

  test("forgets the least recently used shape past its memory", () => {
    const damper = new LogDamper({ burst: 1, shapes: 2, now: () => 0 });
    expect(damper.admit("a one")).toEqual(["a one"]);
    expect(damper.admit("b one")).toEqual(["b one"]);
    expect(damper.admit("c one")).toEqual(["c one"]);
    expect(damper.admit("a one")).toEqual(["a one"]); // forgotten, so a fresh burst
  });

  test("a shape ignores numbers, ids and quoted names", () => {
    expect(logShape("injected into \"Agent one\" via tmux — 12 chars, pid 4411"))
      .toBe(logShape("injected into \"Other\" via tmux — 9 chars, pid 77"));
    expect(logShape("brought back \"5e6c2a1b-0f1e-4a2b-9c3d-1e2f3a4b5c6d\""))
      .toBe(logShape("brought back \"a1b2c3d4-0f1e-4a2b-9c3d-1e2f3a4b5c6d\""));
    expect(logShape("kokoro worker starting")).not.toBe(logShape("kokoro worker stopping"));
  });
});

describe("appendCapped", () => {
  test("rolls over to one previous file past its cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-runaway-"));
    const path = join(dir, "debug.log");
    writeFileSync(path, "x".repeat(100));
    appendCapped(path, "next\n", 64);
    expect(readFileSync(path, "utf8")).toBe("next\n");
    expect(statSync(`${path}.1`).size).toBe(100);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

test("duration says windows and cool-downs the way a person would", () => {
  expect(duration(10 * MIN)).toBe("10 min");
  expect(duration(60 * MIN)).toBe("1 h");
  expect(duration(90 * MIN)).toBe("90 min");
  expect(duration(45_000)).toBe("45 s");
});
