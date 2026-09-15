import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordsRuntime, type RecordsRuntimeClient } from "../src/records-runtime.ts";
import type { RecordsIngestionOptions, RecordsPriorityHints } from "../src/records-client.ts";
import type { RecordReceipt } from "../src/records-types.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const receipt = (id: string): RecordReceipt => ({ id, sessionId: "session", actionId: id, kind: "delivery", state: "delivered", observedAt: 1 });
const hints = (nativeId: string): RecordsPriorityHints => ({ selected: { provider: "claude", nativeId }, live: [{ provider: "claude", nativeId }] });

class FakeClient implements RecordsRuntimeClient {
  events: string[] = [];
  hints: RecordsPriorityHints[] = [];
  receipts: RecordReceipt[] = [];
  starts: RecordsIngestionOptions[] = [];
  onHint?: (hints: RecordsPriorityHints) => Promise<void>;
  onReceipt?: (receipt: RecordReceipt) => Promise<boolean>;
  onClose?: () => Promise<void>;
  onStart?: () => Promise<void>;
  async startIngestion(options: RecordsIngestionOptions) { this.events.push("start"); this.starts.push(options); await this.onStart?.(); }
  async prioritize(value: RecordsPriorityHints) { this.hints.push(value); await this.onHint?.(value); }
  async appendReceipt(value: RecordReceipt) {
    this.events.push(`receipt:${value.id}`);
    this.receipts.push(value);
    return this.onReceipt ? this.onReceipt(value) : true;
  }
  async close() { this.events.push("close"); await this.onClose?.(); }
  async terminate() { this.events.push("terminate"); }
}

describe("records runtime", () => {
  test("off runtime creates no directory with the real worker factory", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-records-off-"));
    const configDir = join(root, "absent");
    const runtime = new RecordsRuntime({ configDir, ownerDeviceId: "device",
      claudeHome: join(root, "claude"), codexHome: join(root, "codex") });
    try {
      await runtime.setEnabled(false);
      runtime.prioritize(hints("session"));
      expect(await runtime.appendReceipt(receipt("off"))).toBe(false);
      await runtime.close();
      expect(existsSync(configDir)).toBe(false);
    } finally {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("off startup is passive and keeps only a detached metadata hint for later enable", async () => {
    const client = new FakeClient();
    let opens = 0;
    const runtime = new RecordsRuntime({ configDir: "/fixture/never-opened", ownerDeviceId: "device", open: async () => { opens++; return client; } });
    const selection = hints("original");
    runtime.prioritize(selection);
    selection.live[0]!.nativeId = "mutated";
    await runtime.setEnabled(false);
    expect(await runtime.appendReceipt(receipt("off"))).toBe(false);
    expect(opens).toBe(0);
    await runtime.setEnabled(true);
    await settle();
    expect(opens).toBe(1);
    expect(client.hints.at(-1)?.live[0]?.nativeId).toBe("original");
    expect(client.starts).toEqual([{ ownerDeviceId: "device" }]);
    await runtime.close();
  });

  test("a startup resolving after disable is closed without starting ingestion", async () => {
    const pending = deferred<RecordsRuntimeClient>();
    const client = new FakeClient();
    let signal: AbortSignal | undefined;
    const runtime = new RecordsRuntime({ configDir: "/fixture", ownerDeviceId: "device", open: ({ signal: value }) => { signal = value; return pending.promise; } });
    const enabling = runtime.setEnabled(true);
    await settle();
    const disabling = runtime.setEnabled(false);
    expect(signal?.aborted).toBe(true);
    pending.resolve(client);
    await Promise.all([enabling, disabling]);
    expect(client.events).toEqual(["close"]);
    await runtime.close();
  });

  test("disable drains receipts accepted while startup was pending", async () => {
    const pending = deferred<RecordsRuntimeClient>();
    const client = new FakeClient();
    let signal: AbortSignal | undefined;
    const runtime = new RecordsRuntime({ configDir: "/fixture", ownerDeviceId: "device", open: ({ signal: value }) => { signal = value; return pending.promise; } });
    const enabling = runtime.setEnabled(true);
    await settle();
    const write = runtime.appendReceipt(receipt("accepted"));
    const disabling = runtime.setEnabled(false);
    expect(signal?.aborted).toBe(false);
    pending.resolve(client);
    expect(await write).toBe(true);
    await Promise.all([enabling, disabling]);
    expect(client.events).toEqual(["receipt:accepted", "close"]);
    await runtime.close();
  });

  test("disable has a deadline during hung startup and a later enable can use a replacement", async () => {
    const pending = deferred<RecordsRuntimeClient>();
    const first = new FakeClient();
    const next = new FakeClient();
    let opens = 0;
    let signal: AbortSignal | undefined;
    const runtime = new RecordsRuntime({ configDir: "/fixture", ownerDeviceId: "device", closeTimeoutMs: 20, open: (options) => {
      if (++opens === 1) { signal = options.signal; return pending.promise; }
      return Promise.resolve(next);
    } });
    const enabling = runtime.setEnabled(true);
    await settle();
    const accepted = runtime.appendReceipt(receipt("accepted"));
    await runtime.setEnabled(false);
    expect(signal?.aborted).toBe(true);
    expect(await accepted).toBe(false);
    await enabling;
    await runtime.setEnabled(true);
    expect(next.events).toEqual(["start"]);
    pending.resolve(first);
    await settle();
    expect(first.events).toEqual(["close"]);
    expect(await runtime.appendReceipt(receipt("replacement"))).toBe(true);
    await runtime.close();
  });

  test("the selected source survives the live hint bound", async () => {
    const client = new FakeClient();
    const runtime = new RecordsRuntime({ configDir: "/fixture", ownerDeviceId: "device", open: async () => client });
    runtime.prioritize({ selected: { provider: "claude", nativeId: "299" },
      live: Array.from({ length: 300 }, (_, index) => ({ provider: "claude", nativeId: String(index) })) });
    await runtime.setEnabled(true);
    expect(client.hints[0]?.live).toHaveLength(256);
    expect(client.hints[0]?.live[0]?.nativeId).toBe("299");
    await runtime.close();
  });

  test("a late ingestion-start failure cannot close a replacement worker", async () => {
    const pending = deferred<void>();
    const first = new FakeClient();
    const next = new FakeClient();
    first.onStart = () => pending.promise;
    let opens = 0;
    const runtime = new RecordsRuntime({ configDir: "/fixture", ownerDeviceId: "device", closeTimeoutMs: 20,
      open: async () => ++opens === 1 ? first : next });
    const enabling = runtime.setEnabled(true);
    await settle();
    await runtime.setEnabled(false);
    await runtime.setEnabled(true);
    pending.reject(new Error("old start failed"));
    await enabling;
    expect(next.events).toEqual(["start"]);
    expect(await runtime.appendReceipt(receipt("replacement"))).toBe(true);
    await runtime.close();
  });

  test("priority updates coalesce to the newest hint with one RPC in flight", async () => {
    const first = deferred<void>();
    const client = new FakeClient();
    let active = 0;
    let maximum = 0;
    client.onHint = async () => {
      maximum = Math.max(maximum, ++active);
      if (client.hints.length === 1) await first.promise;
      active--;
    };
    const runtime = new RecordsRuntime({ configDir: "/fixture", ownerDeviceId: "device", open: async () => client });
    await runtime.setEnabled(true);
    for (let i = 0; i < 100; i++) runtime.prioritize(hints(String(i)));
    expect(client.hints).toHaveLength(1);
    first.resolve();
    await settle();
    expect(client.hints).toHaveLength(2);
    expect(client.hints[1]?.selected?.nativeId).toBe("99");
    expect(maximum).toBe(1);
    await runtime.close();
  });

  test("receipt queue is bounded and close drains the accepted writes in order", async () => {
    const first = deferred<boolean>();
    const client = new FakeClient();
    client.onReceipt = (value) => value.id === "one" ? first.promise : Promise.resolve(true);
    const errors: string[] = [];
    const runtime = new RecordsRuntime({ configDir: "/fixture", ownerDeviceId: "device", receiptLimit: 2, open: async () => client, onError: (message) => errors.push(message) });
    await runtime.setEnabled(true);
    const one = runtime.appendReceipt(receipt("one"));
    const two = runtime.appendReceipt(receipt("two"));
    expect(await runtime.appendReceipt(receipt("overflow"))).toBe(false);
    expect(client.receipts).toHaveLength(1);
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    expect(client.events).not.toContain("close");
    expect(await runtime.appendReceipt(receipt("late"))).toBe(false);
    first.resolve(true);
    expect(await one).toBe(true);
    expect(await two).toBe(true);
    await closing;
    expect(client.events).toEqual(["start", "receipt:one", "receipt:two", "close"]);
    expect(errors).toEqual(["record receipt queue is full; receipt was not queued"]);
  });

  test("startup failures do not retry until enabled state changes and never report raw errors", async () => {
    const errors: string[] = [];
    let opens = 0;
    const client = new FakeClient();
    const runtime = new RecordsRuntime({ configDir: "/fixture", ownerDeviceId: "device", onError: (message) => errors.push(message), open: async () => {
      if (++opens === 1) throw new Error("RAW_PRIVATE_PATH_AND_CONTENT");
      return client;
    } });
    await runtime.setEnabled(true);
    expect(await runtime.appendReceipt(receipt("unavailable"))).toBe(false);
    await runtime.setEnabled(true);
    await settle();
    expect(opens).toBe(1);
    expect(errors.join()).not.toContain("RAW_PRIVATE");
    await runtime.setEnabled(false);
    await runtime.setEnabled(true);
    expect(opens).toBe(2);
    await runtime.close();
  });

  test("a receipt queued by the preceding receipt's completion cannot get stranded", async () => {
    const client = new FakeClient();
    const runtime = new RecordsRuntime({ configDir: "/fixture", ownerDeviceId: "device", open: async () => client });
    await runtime.setEnabled(true);
    await runtime.appendReceipt(receipt("first")).then(() => runtime.appendReceipt(receipt("next")));
    expect(client.receipts.map((value) => value.id)).toEqual(["first", "next"]);
    await runtime.close();
  });

  test("shutdown terminates a hung client and resolves pending receipt outcomes within the deadline", async () => {
    const never = deferred<boolean>();
    const client = new FakeClient();
    client.onReceipt = () => never.promise;
    const errors: string[] = [];
    const runtime = new RecordsRuntime({ configDir: "/fixture", ownerDeviceId: "device", closeTimeoutMs: 20, open: async () => client, onError: (message) => errors.push(message) });
    await runtime.setEnabled(true);
    const write = runtime.appendReceipt(receipt("pending"));
    await runtime.close();
    expect(await write).toBe(false);
    expect(client.events.filter((event) => event === "terminate")).toHaveLength(1);
    expect(errors.some((message) => message.includes("timed out"))).toBe(true);
    never.resolve(false);
    await settle();
  });

  test("a late failure from a terminated client cannot discard a replacement client's receipts", async () => {
    const oldWrite = deferred<boolean>();
    const nextWrite = deferred<boolean>();
    const first = new FakeClient();
    const next = new FakeClient();
    first.onReceipt = () => oldWrite.promise;
    next.onReceipt = () => nextWrite.promise;
    let opens = 0;
    const runtime = new RecordsRuntime({ configDir: "/fixture", ownerDeviceId: "device", closeTimeoutMs: 20, open: async () => ++opens === 1 ? first : next });
    await runtime.setEnabled(true);
    const oldResult = runtime.appendReceipt(receipt("old"));
    await runtime.setEnabled(false);
    expect(await oldResult).toBe(false);
    await runtime.setEnabled(true);
    let outcome: boolean | undefined;
    const nextResult = runtime.appendReceipt(receipt("next")).then((value) => { outcome = value; return value; });
    oldWrite.reject(new Error("old worker failure"));
    await settle();
    expect(outcome).toBeUndefined();
    nextWrite.resolve(true);
    expect(await nextResult).toBe(true);
    await runtime.close();
  });

  test("a startup arriving after shutdown's deadline is immediately disposed", async () => {
    const pending = deferred<RecordsRuntimeClient>();
    const client = new FakeClient();
    const runtime = new RecordsRuntime({ configDir: "/fixture", ownerDeviceId: "device", closeTimeoutMs: 20, open: () => pending.promise });
    const enabling = runtime.setEnabled(true);
    await settle();
    await runtime.close();
    pending.resolve(client);
    await enabling;
    expect(client.events).toEqual(["close"]);
  });

  test("close during pending startup still drains already accepted receipts", async () => {
    const pending = deferred<RecordsRuntimeClient>();
    const client = new FakeClient();
    const runtime = new RecordsRuntime({ configDir: "/fixture", ownerDeviceId: "device", open: () => pending.promise });
    const enabling = runtime.setEnabled(true);
    await settle();
    const write = runtime.appendReceipt(receipt("accepted"));
    const closing = runtime.close();
    pending.resolve(client);
    expect(await write).toBe(true);
    await Promise.all([enabling, closing]);
    expect(client.events).toEqual(["receipt:accepted", "close"]);
  });
});
