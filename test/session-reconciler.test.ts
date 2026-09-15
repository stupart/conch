import { describe, expect, test } from "bun:test";
import { SessionReconciler } from "../src/session-reconciler.ts";
import { SessionLedger } from "../src/session-ledger.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("discovery reconciliation", () => {
  test("a deferred scan cannot delete newer hook state, even before rendering", async () => {
    const ledger = new SessionLedger();
    const oldScan = deferred<Set<string>>();
    const newScan = deferred<Set<string>>();
    let reads = 0;
    const published: string[][] = [];
    const refresh = new SessionReconciler({
      read: () => ++reads === 1 ? oldScan.promise : newScan.promise,
      reconcile: (ids) => ledger.forgetGone(ids),
      render: async (ids, current) => { if (current()) published.push([...ids]); },
      onError: (error) => { throw error; },
    });
    const first = refresh.request();
    await tick();
    const event = { type: "needs-you", sessionId: "new", eventAt: 3 } as const;
    expect(refresh.accept(ledger.eventOrder, event)).toBe(true);
    ledger.sessionStates.set("new", { label: "new", status: "needs", at: 3 });
    ledger.pausedSessionIds.add("new");
    oldScan.resolve(new Set());
    await tick();
    expect(ledger.sessionStates.has("new")).toBe(true);
    expect(ledger.pausedSessionIds.has("new")).toBe(true);
    expect(ledger.eventOrder.isCurrent(event)).toBe(true);
    expect(published).toEqual([]);
    newScan.resolve(new Set(["new"]));
    await first;
    expect(published).toEqual([["new"]]);
  });

  test("a rejected older hook neither changes event order nor invalidates discovery", async () => {
    const ledger = new SessionLedger();
    const newest = { type: "needs-you", sessionId: "same", eventAt: 3 } as const;
    ledger.eventOrder.accept(newest);
    const scan = deferred<number>();
    let reads = 0;
    const published: number[] = [];
    const refresh = new SessionReconciler({
      read: () => { reads++; return scan.promise; },
      reconcile: () => {},
      render: async (snapshot, current) => { if (current()) published.push(snapshot); },
      onError: (error) => { throw error; },
    });
    const done = refresh.request();
    await tick();
    expect(refresh.accept(ledger.eventOrder, { ...newest, eventAt: 2 })).toBe(false);
    expect(ledger.eventOrder.isCurrent(newest)).toBe(true);
    scan.resolve(1);
    await done;
    expect(reads).toBe(1);
    expect(published).toEqual([1]);
  });

  test("a burst has one active scan and one trailing refresh", async () => {
    const firstScan = deferred<Set<string>>();
    let reads = 0;
    const refresh = new SessionReconciler({
      read: () => { reads++; return reads === 1 ? firstScan.promise : Promise.resolve(new Set<string>()); },
      reconcile: () => {}, render: async () => {}, onError: (error) => { throw error; },
    });
    const first = refresh.request();
    await tick();
    const pending = [first, ...Array.from({ length: 39 }, () => refresh.request())];
    expect(reads).toBe(1);
    firstScan.resolve(new Set());
    await Promise.all(pending);
    expect(reads).toBe(2);
  });

  test("a refresh requested while rendering prevents stale publication", async () => {
    const detail = deferred<void>();
    let reads = 0;
    const published: number[] = [];
    const refresh = new SessionReconciler({
      read: async () => ++reads,
      reconcile: () => {},
      render: async (id, current) => {
        if (id === 1) await detail.promise;
        if (current()) published.push(id);
      },
      onError: (error) => { throw error; },
    });
    const first = refresh.request();
    await tick();
    const second = refresh.request();
    detail.resolve();
    await Promise.all([first, second]);
    expect(published).toEqual([2]);
  });
});


test("shutdown closes an in-flight reconciliation before any ledger mutation", async () => {
  const scan = deferred<number>();
  let mutations = 0;
  const refresh = new SessionReconciler({
    read: () => scan.promise,
    reconcile: () => { mutations++; },
    render: async () => { mutations++; },
    onError: (error) => { throw error; },
  });
  const done = refresh.request();
  await tick();
  refresh.close();
  scan.resolve(1);
  await done;
  expect(mutations).toBe(0);
  await refresh.request();
  expect(mutations).toBe(0);
});
