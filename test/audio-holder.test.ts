import { describe, expect, test } from "bun:test";
import {
  AUDIO_LEASE_MAX_MS,
  AUDIO_LEASE_MIN_MS,
  AUDIO_OUTBOX_MAX,
  AudioHolder,
  AudioOutbox,
  PresentedItems,
  presentedTo,
  speechAllowedHere,
} from "../src/audio-holder.ts";

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("the one acceptance rule (F8)", () => {
  test("starts local at revision zero, today's behaviour", () => {
    const holder = new AudioHolder(clock().now);
    expect(holder.record).toEqual({ holder: "local", revision: 0, expiresAt: null });
    expect(holder.isLocal()).toBe(true);
  });

  test("a higher revision wins: new holder, lease from now, grant verdict", () => {
    const c = clock();
    const holder = new AudioHolder(c.now);
    expect(holder.assess("mac-a", 1)).toBe("grant");
    expect(holder.yield("mac-a", 1, 90_000)).toEqual({
      kind: "grant",
      record: { holder: "mac-a", revision: 1, expiresAt: 91_000 },
    });
    expect(holder.isLocal()).toBe(false);
    // Another device with a higher revision takes it over.
    expect(holder.yield("mac-c", 2, 90_000)).toMatchObject({ kind: "grant", record: { holder: "mac-c", revision: 2 } });
  });

  test("equal revision from the same holder only extends the lease", () => {
    const c = clock();
    const holder = new AudioHolder(c.now);
    holder.yield("mac-a", 1, 90_000);
    c.advance(30_000);
    expect(holder.assess("mac-a", 1)).toBe("renew");
    expect(holder.yield("mac-a", 1, 90_000)).toEqual({
      kind: "renew",
      record: { holder: "mac-a", revision: 1, expiresAt: 121_000 },
    });
  });

  test("equal revision after expiry is a re-yield: fresh lease, grant verdict, no bump", () => {
    const c = clock();
    const holder = new AudioHolder(c.now);
    holder.yield("mac-a", 1, 90_000);
    c.advance(90_000);
    expect(holder.record).toEqual({ holder: "local", revision: 1, expiresAt: null });
    expect(holder.assess("mac-a", 1)).toBe("grant");
    expect(holder.yield("mac-a", 1, 90_000)).toEqual({
      kind: "grant",
      record: { holder: "mac-a", revision: 1, expiresAt: 181_000 },
    });
  });

  test("a lower revision, another holder at the same revision, or a yield to local is refused with the current revision", () => {
    const holder = new AudioHolder(clock().now);
    holder.yield("mac-a", 3, 90_000);
    expect(holder.yield("mac-a", 2, 90_000)).toEqual({ kind: "stale", revision: 3 });
    expect(holder.yield("mac-c", 3, 90_000)).toEqual({ kind: "stale", revision: 3 });
    expect(holder.yield("local", 4, 90_000)).toEqual({ kind: "stale", revision: 3 });
    expect(holder.yield("", 4, 90_000)).toEqual({ kind: "stale", revision: 3 });
    // A refusal is side-effect free.
    expect(holder.record).toMatchObject({ holder: "mac-a", revision: 3 });
  });

  test("take and release each bump the revision and return to local", () => {
    const holder = new AudioHolder(clock().now);
    holder.yield("mac-a", 1, 90_000);
    expect(holder.take()).toEqual({ holder: "local", revision: 2, expiresAt: null });
    holder.yield("mac-a", 3, 90_000);
    expect(holder.release()).toEqual({ holder: "local", revision: 4, expiresAt: null });
    // A stale claim from before the take loses.
    expect(holder.yield("mac-a", 3, 90_000)).toEqual({ kind: "stale", revision: 4 });
  });

  test("expiry returns to local without bumping, so the holder's re-yield still lands", () => {
    const c = clock();
    const holder = new AudioHolder(c.now);
    holder.yield("mac-a", 5, 2_000);
    c.advance(1_999);
    expect(holder.holder).toBe("mac-a");
    c.advance(1);
    expect(holder.isLocal()).toBe(true);
    expect(holder.record.revision).toBe(5);
    expect(holder.record.expiresAt).toBeNull();
  });

  test("the lease is clamped to a sane window", () => {
    const c = clock(0);
    const holder = new AudioHolder(c.now);
    expect(holder.yield("mac-a", 1, 1)).toMatchObject({ record: { expiresAt: AUDIO_LEASE_MIN_MS } });
    expect(holder.yield("mac-a", 1, Number.MAX_SAFE_INTEGER)).toMatchObject({ record: { expiresAt: AUDIO_LEASE_MAX_MS } });
  });
});

describe("the speech gate and the presentation target", () => {
  test("local → allowed; yielded → refused; phone holds → refused", () => {
    expect(speechAllowedHere("local", "mac")).toBe(true);
    expect(speechAllowedHere("mac-a", "mac")).toBe(false);
    expect(speechAllowedHere("local", "phone")).toBe(false);
    expect(speechAllowedHere("mac-a", "phone")).toBe(false);
  });

  test("announcements go to the holder, except on a daemon the phone has claimed (F2)", () => {
    expect(presentedTo("local", "mac")).toBeNull();
    expect(presentedTo("mac-a", "mac")).toBe("mac-a");
    expect(presentedTo("mac-a", "phone")).toBeNull();
    expect(presentedTo("local", "phone")).toBeNull();
  });
});

describe("the outbox (F6, F9)", () => {
  test("sequences continue from the seed and the oldest of twenty-one drops", () => {
    const outbox = new AudioOutbox(500);
    const first = outbox.push({ text: "one", voice: "af_heart", label: "conch", session: { ownerDeviceId: "b", localSessionKey: "k#1" } }, 7);
    expect(first).toEqual({ seq: 501, text: "one", voice: "af_heart", label: "conch", session: { ownerDeviceId: "b", localSessionKey: "k#1" }, at: 7 });
    for (let i = 0; i < AUDIO_OUTBOX_MAX; i += 1) {
      outbox.push({ text: `more ${i}`, voice: "", label: "x", session: { ownerDeviceId: "b", localSessionKey: "k" } }, 8);
    }
    const items = outbox.items;
    expect(items).toHaveLength(AUDIO_OUTBOX_MAX);
    expect(items[0]!.seq).toBe(502);
    expect(items.at(-1)!.seq).toBe(521);
    // Restart with a later seed never re-issues 502..521.
    expect(new AudioOutbox(Date.now()).push({ text: "", voice: "", label: "", session: { ownerDeviceId: "b", localSessionKey: "k" } }).seq).toBeGreaterThan(521);
  });
});

describe("presented items are admitted at most once (F4, F12)", () => {
  test("admits once: recorded only when the daemon says so", () => {
    const presented = new PresentedItems(1_000);
    expect(presented.check("b", 7, 2_000)).toBe("admit");
    // Not recorded yet — a held item is asked again.
    expect(presented.check("b", 7, 2_000)).toBe("admit");
    presented.record("b", 7);
    expect(presented.check("b", 7, 2_000)).toBe("seen");
    expect(presented.check("b", 8, 2_000)).toBe("admit");
    expect(presented.check("c", 7, 2_000)).toBe("admit");
  });

  test("no replay after restart: anything older than this daemon's start is dropped", () => {
    const presented = new PresentedItems(5_000);
    expect(presented.check("b", 1, 4_999)).toBe("stale");
    expect(presented.check("b", 1, 5_000)).toBe("admit");
  });
});
