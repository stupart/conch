import { expect, test } from "bun:test";
import {
  createRecordOperation, createRecordReceiptObserver, recordReceipt, reviewPublicationObservation,
  type RecordObservation,
} from "../src/records-receipts.ts";
import type { RecordReceipt, RecordSession } from "../src/records-types.ts";

const session = (id = "indexed-a"): RecordSession => ({ id, ownerDeviceId: "mac-a", provider: "codex", nativeId: id });
const observation = (over: Partial<RecordObservation> = {}): RecordObservation => ({
  sessionId: "window:1", actionId: "send-1", kind: "delivery", state: "accepted", observedAt: 1, ...over,
});

test("receipt identity is retry-stable, scoped by owner, operation, attempt and outcome", () => {
  const fact = observation({ state: "delivered", code: "transport-submitted", characterCount: 12 });
  const a = recordReceipt(session(), fact);
  expect(recordReceipt(session(), { ...fact })).toEqual(a);
  expect(recordReceipt(session(), { ...fact, state: "unknown" }).id).not.toBe(a.id);
  expect(recordReceipt(session(), { ...fact, attemptId: "retry-2" }).id).not.toBe(a.id);
  expect(recordReceipt({ ...session(), ownerDeviceId: "mac-b" }, fact).id).not.toBe(a.id);
  expect(a.details).toEqual({ code: "transport-submitted", characterCount: 12 });
  expect(recordReceipt(session(), observation({ code: "secret words or URL", characterCount: -1 })).details).toBeUndefined();
});

test("each operation emits its admission and only one final outcome, with one captured identity", () => {
  const events: RecordObservation[] = [];
  let time = 10;
  const scope = { sessionId: "route", nativeId: "original" };
  const operation = createRecordOperation((event) => events.push(event), scope, "speech", 4, () => time++);
  scope.nativeId = "replacement";
  operation.emit("queued"); operation.emit("queued"); operation.emit("started");
  operation.emit("interrupted"); operation.emit("unknown"); operation.emit("interrupted");
  expect(events.map(({ state }) => state)).toEqual(["queued", "started", "interrupted"]);
  expect(new Set(events.map(({ actionId }) => actionId)).size).toBe(1);
  expect(events.map(({ nativeId }) => nativeId)).toEqual(["original", "original", "original"]);
  expect(events.map(({ observedAt }) => observedAt)).toEqual([10, 11, 12]);
  expect(() => createRecordOperation(() => { throw Error("journal down"); }, scope, "delivery").emit("accepted")).not.toThrow();
});

test("publication identity is replay-stable without storing summary or link content", () => {
  const review = { summary: "private wording", link: "https://example.test/?token=private", at: 123 };
  const fact = reviewPublicationObservation({ sessionId: "route" }, review);
  expect(reviewPublicationObservation({ sessionId: "route" }, { ...review })).toEqual(fact);
  expect(reviewPublicationObservation({ sessionId: "route" }, { ...review, summary: "different" }).actionId).not.toBe(fact.actionId);
  expect(JSON.stringify(recordReceipt(session(), fact))).not.toContain("private");
});

test("late outcomes retain admission ownership after a window is reused", async () => {
  const receipts: RecordReceipt[] = [];
  let current = session();
  let resolutions = 0;
  const observer = createRecordReceiptObserver({
    ownerDeviceId: "mac-a", resolveSession: () => { resolutions++; return current; },
    appendReceipt: async (receipt) => { receipts.push(receipt); },
  });
  observer(observation());
  current.id = "mutated-in-place";
  current = session("replacement");
  observer(observation({ state: "delivered", observedAt: 2 }));
  observer(observation({ state: "failed", observedAt: 3 })); // terminal replay without admission is dropped
  expect(receipts.map(({ sessionId }) => sessionId)).toEqual(["indexed-a", "indexed-a"]);
  expect(resolutions).toBe(1);
});

test("bounded admissions never retarget missing/overflowed operations and release at settlement", () => {
  const receipts: RecordReceipt[] = [];
  const errors: unknown[] = [];
  const observer = createRecordReceiptObserver({
    ownerDeviceId: "mac-a", maxActiveScopes: 1, resolveSession: () => session(),
    appendReceipt: async (receipt) => { receipts.push(receipt); }, onError: (error) => errors.push(error),
  });
  observer(observation());
  observer(observation({ actionId: "send-2" }));
  observer(observation({ actionId: "send-2", state: "delivered" }));
  observer(observation({ state: "staged" }));
  observer(observation({ actionId: "send-3" }));
  observer(observation({ actionId: "send-3", state: "failed" }));
  expect(receipts.map(({ actionId }) => actionId)).toEqual(["send-1", "send-1", "send-3", "send-3"]);
  expect(errors).toHaveLength(1);
});

test("one-shot reviews resolve independently and journal failures never change the producer", async () => {
  const errors: unknown[] = [];
  const observer = createRecordReceiptObserver({
    ownerDeviceId: "mac-a", resolveSession: () => session(), appendReceipt: async () => { throw Error("write failed"); },
    onError: (error) => errors.push(error),
  });
  expect(() => observer(reviewPublicationObservation({ sessionId: "route" }, { summary: "done", at: 1 }))).not.toThrow();
  await Promise.resolve();
  expect(errors).toHaveLength(1);
});
