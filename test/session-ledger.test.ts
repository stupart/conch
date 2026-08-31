import { describe, expect, test } from "bun:test";
import type { TurnEvent } from "../src/hook.ts";
import { SessionLedger } from "../src/session-ledger.ts";

type SessionCollection = Map<string, unknown> | Set<string>;

const KNOWN_COLLECTIONS = [
  "injectedAt",
  "pending",
  "sessionStates",
  "pausedSessionIds",
  "resumedSessionIds",
  "prioritizedSessionIds",
  "dismissedSessionIds",
  "sessionHeldTurns",
  "dismissedHeldTurns",
  "latestTurnBySession",
];

const FORGET_EXEMPT_COLLECTIONS = new Set([
  "injectedAt",
]);

function event(sessionId: string, eventAt = 1_000): TurnEvent {
  return {
    type: "turn-end",
    sessionId,
    label: sessionId,
    announce: `${sessionId}: done`,
    eventAt,
  };
}

function collectionEntries(ledger: SessionLedger): Array<[string, SessionCollection]> {
  const entries = Object.entries(ledger)
    .filter((entry): entry is [string, SessionCollection] =>
      entry[1] instanceof Map || entry[1] instanceof Set
    );
  expect(entries.map(([name]) => name).sort()).toEqual([...KNOWN_COLLECTIONS].sort());
  return entries;
}

function valueFor(name: string, id: string, turn: TurnEvent): unknown {
  if (name === "injectedAt") return 123;
  if (name === "sessionStates") return { label: id, status: "waiting", at: 123 };
  return turn;
}

function seed(collection: SessionCollection, id: string, value: unknown): void {
  if (collection instanceof Map) collection.set(id, value);
  else collection.add(id);
}

describe("SessionLedger", () => {
  test("forget clears every cleanup-owned collection and event-order entry", () => {
    const ledger = new SessionLedger();
    const gone = event("gone", 2_000);
    const live = event("live", 2_000);

    for (const [name, collection] of collectionEntries(ledger)) {
      seed(collection, gone.sessionId, valueFor(name, gone.sessionId, gone));
      seed(collection, live.sessionId, valueFor(name, live.sessionId, live));
    }
    expect(ledger.eventOrder.accept(gone)).toBe(true);
    expect(ledger.eventOrder.accept(live)).toBe(true);

    ledger.forget(gone.sessionId);

    for (const [name, collection] of collectionEntries(ledger)) {
      expect(collection.has(live.sessionId)).toBe(true);
      expect(collection.has(gone.sessionId)).toBe(FORGET_EXEMPT_COLLECTIONS.has(name));
    }
    expect(ledger.eventOrder.isCurrent(gone)).toBe(false);
    expect(ledger.eventOrder.isCurrent(live)).toBe(true);
    expect(ledger.isKnown(gone.sessionId)).toBe(false);
    expect(ledger.isKnown(live.sessionId)).toBe(true);
  });

  test("forgetGone uses today's tracked-id set and then prunes event order", () => {
    const ledger = new SessionLedger();
    const gone = event("gone", 2_000);
    const live = event("live", 2_000);
    const orderOnly = event("order-only", 2_000);

    for (const [name, collection] of collectionEntries(ledger)) {
      seed(collection, live.sessionId, valueFor(name, live.sessionId, live));
      if (name !== "injectedAt") {
        seed(collection, gone.sessionId, valueFor(name, gone.sessionId, gone));
      }
    }
    ledger.injectedAt.set("injected-only", 456);
    ledger.resumedSessionIds.add("resumed-only");
    expect(ledger.eventOrder.accept(gone)).toBe(true);
    expect(ledger.eventOrder.accept(live)).toBe(true);
    expect(ledger.eventOrder.accept(orderOnly)).toBe(true);

    ledger.forgetGone(new Set([live.sessionId]));

    for (const [name, collection] of collectionEntries(ledger)) {
      expect(collection.has(live.sessionId)).toBe(true);
      if (name !== "injectedAt") expect(collection.has(gone.sessionId)).toBe(false);
    }
    expect(ledger.injectedAt.has("injected-only")).toBe(true);
    expect(ledger.resumedSessionIds.has("resumed-only")).toBe(true);
    expect(ledger.eventOrder.isCurrent(gone)).toBe(false);
    expect(ledger.eventOrder.isCurrent(live)).toBe(true);
    expect(ledger.eventOrder.isCurrent(orderOnly)).toBe(false);
  });
});
