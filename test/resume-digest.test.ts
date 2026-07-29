import { describe, expect, test } from "bun:test";
import type { TurnEvent } from "../src/hook.ts";
import {
  composeResumeBriefing,
  fallbackResumeBriefing,
  findResumeDigestChoice,
  ResumeDigestEscrow,
  runResumeDigest,
  shouldUseResumeDigest,
} from "../src/resume-digest.ts";

function turn(
  sessionId: string,
  label: string,
  announce = `${label}: finished its work`,
): TurnEvent {
  return {
    type: "turn-end",
    sessionId,
    label,
    announce,
    transcriptPath: `/tmp/${sessionId}.jsonl`,
    pid: sessionId.length,
  };
}

const alpha = turn("a", "alpha", "alpha: shipped the queue fix");
const dayLoop = turn("b", "day loop", "day loop: all tests passed");

describe("resume digest escrow", () => {
  test("only an accepted transition may restore its prepared events", () => {
    const rejectedOwner = {};
    const rejected = new ResumeDigestEscrow<object>();
    rejected.prepare(rejectedOwner, [alpha, dayLoop], "briefing", 1);
    rejected.settle(rejectedOwner, false);
    expect(rejected.restore()).toEqual([]);

    const acceptedOwner = {};
    const accepted = new ResumeDigestEscrow<object>();
    accepted.prepare(acceptedOwner, [alpha, dayLoop], "briefing", 1);
    accepted.settle(acceptedOwner, true);
    const restored = accepted.restore();
    expect(restored).toEqual([alpha, dayLoop]);
    expect(restored[0]).toBe(alpha);
    expect(restored[1]).toBe(dayLoop);
  });

  test("scoped forget permanently invalidates a prepared briefing and keeps survivors", () => {
    const owner = {};
    const escrow = new ResumeDigestEscrow<object>();
    escrow.prepare(owner, [alpha, dayLoop], "mentions both sessions", 2);
    escrow.settle(owner, true);

    expect(escrow.forget(dayLoop.sessionId)).toEqual({
      changed: true,
      consuming: false,
    });
    const plan = escrow.begin(owner);
    expect(plan?.invalidated).toBeTrue();
    expect(plan?.events).toEqual([alpha]);
    expect(plan?.events[0]).toBe(alpha);
  });

  test("forget during consumption mutates the owned array used by fallback", () => {
    const owner = {};
    const escrow = new ResumeDigestEscrow<object>();
    escrow.prepare(owner, [alpha, dayLoop], "mentions both sessions", 3);
    escrow.settle(owner, true);
    const plan = escrow.begin(owner)!;
    const digestEvents = plan.events;

    expect(escrow.forget(dayLoop.sessionId)).toEqual({
      changed: true,
      consuming: true,
    });
    expect(digestEvents).toEqual([alpha]);
    expect(plan.invalidated).toBeTrue();
  });

  test("scoped pause invalidates a consuming briefing without forgetting its event", () => {
    const owner = {};
    const escrow = new ResumeDigestEscrow<object>();
    escrow.prepare(owner, [alpha, dayLoop], "mentions both sessions", 3);
    escrow.settle(owner, true);
    const plan = escrow.begin(owner)!;

    expect(escrow.invalidate(alpha.sessionId)).toEqual({
      changed: true,
      consuming: true,
    });
    expect(plan.invalidated).toBeTrue();
    expect(plan.events).toEqual([alpha, dayLoop]);
  });

  test("restoring a consuming plan cancels its stale handler and transfers ownership once", () => {
    const owner = {};
    const escrow = new ResumeDigestEscrow<object>();
    escrow.prepare(owner, [alpha, dayLoop], "briefing", 3);
    escrow.settle(owner, true);
    const plan = escrow.begin(owner)!;

    expect(escrow.restore()).toEqual([alpha, dayLoop]);
    expect(plan.cancelled).toBeTrue();
    expect(escrow.restore()).toEqual([]);
    expect(escrow.begin(owner)).toBeNull();
  });

  test("a stale resume owner cannot consume a newer accepted plan", () => {
    const oldOwner = {};
    const newOwner = {};
    const escrow = new ResumeDigestEscrow<object>();
    escrow.prepare(newOwner, [alpha, dayLoop], "new briefing", 4);
    escrow.settle(oldOwner, true);

    expect(escrow.begin(oldOwner)).toBeNull();
    expect(escrow.begin(newOwner)).toBeNull();
    escrow.settle(newOwner, true);
    expect(escrow.begin(newOwner)?.briefing).toBe("new briefing");
  });
});

describe("resume digest planning", () => {
  test("the opt-in gate requires at least two held turns", () => {
    expect(shouldUseResumeDigest(false, [alpha, dayLoop])).toBeFalse();
    expect(shouldUseResumeDigest(true, [])).toBeFalse();
    expect(shouldUseResumeDigest(true, [alpha])).toBeFalse();
    expect(shouldUseResumeDigest(true, [alpha, dayLoop])).toBeTrue();
    expect(shouldUseResumeDigest(
      true,
      [alpha, dayLoop],
      new Set([alpha.sessionId]),
    )).toBeFalse();
  });

  test("the offline briefing is deterministic", () => {
    expect(fallbackResumeBriefing([alpha, dayLoop]))
      .toBe("2 finished while you were away: alpha, day loop.");
  });

  test("composition sends only numbered announcement facts to the fast model", async () => {
    let prompt = "";
    let options: unknown;
    const briefing = await composeResumeBriefing([alpha, dayLoop], async (next, opts) => {
      prompt = next;
      options = opts;
      return "Alpha shipped the fix, and day loop passed every test.";
    });

    expect(briefing).toBe("Alpha shipped the fix, and day loop passed every test.");
    expect(prompt).toContain("1. alpha: shipped the queue fix");
    expect(prompt).toContain("2. day loop: all tests passed");
    expect(options).toEqual({ maxChars: 400 });
  });

  test.each(["null", "throw"] as const)(
    "model %s uses the deterministic offline briefing",
    async (failure) => {
      const briefing = await composeResumeBriefing([alpha, dayLoop], async () => {
        if (failure === "throw") throw new Error("offline");
        return null;
      });
      expect(briefing).toBe("2 finished while you were away: alpha, day loop.");
    },
  );

  test("who-first matching accepts fillers and collapsed spoken labels", () => {
    expect(findResumeDigestChoice([alpha, dayLoop], "let's start with day loop"))
      .toBe(dayLoop);
    expect(findResumeDigestChoice([alpha, dayLoop], "Dayloop first"))
      .toBe(dayLoop);
    expect(findResumeDigestChoice([alpha, dayLoop], "please alpha"))
      .toBe(alpha);
    expect(findResumeDigestChoice([alpha, dayLoop], "the other one"))
      .toBeNull();
    expect(findResumeDigestChoice([turn("c", "app"), dayLoop], "happy"))
      .toBeNull();
  });
});

describe("resume digest execution", () => {
  test("a matched choice queues a wake first in handling order and never falls back", async () => {
    const spoken: string[] = [];
    const enqueued: TurnEvent[] = [];
    const fallback: TurnEvent[][] = [];

    expect(await runResumeDigest([alpha, dayLoop], "Two things finished.", {
      async speak(text) {
        spoken.push(text);
      },
      async listen() {
        return { text: "day loop" };
      },
      enqueue(event) {
        enqueued.push(event);
      },
      fallback(events) {
        fallback.push([...events]);
      },
      interrupted: () => false,
    })).toBeTrue();

    expect(spoken).toEqual(["Two things finished. Who first?"]);
    expect(fallback).toEqual([]);
    expect(enqueued[0]).toBe(alpha);
    expect(enqueued[1]).toMatchObject({
      type: "wake",
      sessionId: dayLoop.sessionId,
      label: dayLoop.label,
      announce: "",
    });
    expect(enqueued[1]).not.toBe(dayLoop);
  });

  test.each([
    ["silence", { text: "" }],
    ["no match", { text: "the unknown session" }],
    ["listen error", { text: "", error: "transcription failed" }],
  ] as const)("%s falls back to every exact held turn", async (_name, listenResult) => {
    const enqueued: TurnEvent[] = [];

    expect(await runResumeDigest([alpha, dayLoop], "Two things finished.", {
      async speak() {},
      async listen() {
        return listenResult;
      },
      enqueue(event) {
        enqueued.push(event);
      },
      fallback(events) {
        for (const event of events) enqueued.push(event);
      },
      interrupted: () => false,
    })).toBeFalse();

    expect(enqueued).toEqual([alpha, dayLoop]);
    expect(enqueued[0]).toBe(alpha);
    expect(enqueued[1]).toBe(dayLoop);
  });

  test("an interruption raised by briefing cancellation never opens the listen", async () => {
    const enqueued: TurnEvent[] = [];
    let interrupted = false;
    let listens = 0;

    expect(await runResumeDigest([alpha, dayLoop], "Two things finished.", {
      async speak() {
        interrupted = true;
      },
      async listen() {
        listens++;
        return { text: "alpha" };
      },
      enqueue(event) {
        enqueued.push(event);
      },
      fallback(events) {
        for (const event of events) enqueued.push(event);
      },
      interrupted: () => interrupted,
    })).toBeFalse();

    expect(listens).toBe(0);
    expect(enqueued).toEqual([alpha, dayLoop]);
  });

  test("speech failure and re-pause both take the full replay fallback", async () => {
    for (const fail of ["speech", "interrupted"] as const) {
      const enqueued: TurnEvent[] = [];
      let interrupted = fail === "interrupted";
      expect(await runResumeDigest([alpha, dayLoop], "Two things finished.", {
        async speak() {
          if (fail === "speech") throw new Error("TTS unavailable");
          interrupted = true;
        },
        async listen() {
          throw new Error("must not listen");
        },
        enqueue(event) {
          enqueued.push(event);
        },
        fallback(events) {
          for (const event of events) enqueued.push(event);
        },
        interrupted: () => interrupted,
      })).toBeFalse();
      expect(enqueued).toEqual([alpha, dayLoop]);
    }
  });
});
