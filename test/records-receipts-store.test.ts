import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecordOperation, createRecordReceiptObserver, reviewPublicationObservation } from "../src/records-receipts.ts";
import { RecordStore } from "../src/records-store.ts";

test("receipt producers persist each outcome once and a re-index cannot erase them", async () => {
  const root = mkdtempSync(join(tmpdir(), "conch-receipt-producers-"));
  const store = new RecordStore({ configDir: root });
  try {
    const session = { id: "session", ownerDeviceId: "device", provider: "claude" as const, nativeId: "native" };
    const writes: Promise<boolean>[] = [];
    const observer = createRecordReceiptObserver({
      ownerDeviceId: session.ownerDeviceId, resolveSession: () => session,
      appendReceipt: (receipt) => {
        const write = Promise.resolve(store.appendReceipt(receipt));
        writes.push(write);
        return write;
      },
    });
    const delivery = createRecordOperation(observer, { sessionId: "route", actionId: "delivery" }, "delivery", 12, () => 1);
    delivery.emit("accepted"); delivery.emit("accepted");
    delivery.emit("staged"); delivery.emit("staged"); delivery.emit("failed");
    const speech = createRecordOperation(observer, { sessionId: "route", actionId: "speech" }, "speech", 12, () => 2);
    speech.emit("queued"); speech.emit("started"); speech.emit("interrupted"); speech.emit("unknown");
    const publication = reviewPublicationObservation({ sessionId: "route" }, { summary: "fixture", at: 3 });
    observer(publication); observer(publication);
    expect(await Promise.all(writes)).toEqual([true, true, true, true, true, true, false]);
    expect(store.receipts("delivery").map((receipt) => receipt.state).sort()).toEqual(["accepted", "staged"]);
    expect(store.counts().receipts).toBe(6);
    store.reindex(session.id);
    expect(store.counts().receipts).toBe(6);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
