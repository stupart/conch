import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { openRecordsIfEnabled, RecordsClient } from "../src/records-client.ts";
import type { RecordReceipt } from "../src/records-types.ts";

const roots: string[] = [];
const clients: RecordsClient[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "conch-record-worker-"));
  roots.push(path);
  return path;
}
async function open(configDir: string): Promise<RecordsClient> {
  const client = await RecordsClient.open({ configDir });
  clients.push(client);
  return client;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const receipt: RecordReceipt = {
  id: "receipt-1", sessionId: "session-1", actionId: "action-1",
  kind: "delivery", state: "accepted", observedAt: 10,
};

describe("record worker", () => {
  test("disabled construction creates no directory or worker", async () => {
    const configDir = join(directory(), "absent");
    expect(await openRecordsIfEnabled({ recordsEnabled: false }, { configDir })).toBeNull();
    expect(existsSync(configDir)).toBe(false);
  });

  test("cancelled startup creates no directory or worker", async () => {
    const configDir = join(directory(), "absent");
    const controller = new AbortController();
    controller.abort();
    await expect(RecordsClient.open({ configDir, signal: controller.signal })).rejects.toThrow("startup cancelled");
    expect(existsSync(configDir)).toBe(false);
  });

  test("ingestion starts explicitly, accepts priorities, and closes after earlier receipts", async () => {
    const configDir = directory();
    const client = await open(configDir);
    expect(await client.ingestionStatus()).toBeUndefined();
    const options = {
      ownerDeviceId: "fixture-device", claudeHome: join(configDir, "claude"), codexHome: join(configDir, "codex"),
    };
    await client.startIngestion(options);
    await client.prioritize({ selected: { provider: "claude", nativeId: "fixture-session" }, live: [] });
    expect(await client.ingestionStatus()).toMatchObject({ running: true });
    const duplicate = await client.startIngestion(options).catch((error: unknown) => error);
    expect(duplicate).toBeInstanceOf(Error);
    expect((duplicate as Error).message).toContain("already started");
    const accepted = client.appendReceipt(receipt);
    await client.close();
    expect(await accepted).toBe(true);
    const reopened = await open(configDir);
    expect(await reopened.ingestionStatus()).toBeUndefined();
    expect(await reopened.receipts(receipt.actionId)).toEqual([receipt]);
  });

  test("enabled construction persists receipts and returns typed operations", async () => {
    const configDir = directory();
    const client = await openRecordsIfEnabled({ recordsEnabled: true }, { configDir });
    expect(client).not.toBeNull();
    clients.push(client!);
    expect(await client!.source("missing")).toBeUndefined();
    expect(await client!.appendReceipt(receipt)).toBe(true);
    expect(await client!.appendReceipt(receipt)).toBe(false);
    expect(await client!.receipts(receipt.actionId)).toEqual([receipt]);
    await client!.reindex(receipt.sessionId);
    expect((await client!.counts()).receipts).toBe(1);
    await client!.close();
    const reopened = await open(configDir);
    expect(await reopened.receipts(receipt.actionId)).toEqual([receipt]);
  });

  test("ingests complete provider bytes and checkpoints on the worker", async () => {
    const configDir = directory();
    const client = await open(configDir);
    const bytes = Buffer.from([
      { type: "user", uuid: "u1", message: { role: "user", content: "Read this 🐚" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: "Read it" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const input = {
      session: { id: "session-1", ownerDeviceId: "device-1", provider: "claude" as const, nativeId: "native-1" },
      source: {
        id: "source-1", path: join(configDir, "fixture.jsonl"), device: "1", inode: "1",
        size: bytes.length, modifiedMs: 1, prefix: bytes.subarray(0, 256),
        checkpoint: new Uint8Array(), from: 0, bytes, expected: null,
      },
    };
    const first = await client.ingest(input);
    expect(first.lines).toBe(2);
    expect(first.source.offset).toBe(bytes.length);
    expect(await client.source("source-1")).toEqual(first.source);
    expect((await client.ingest(input)).lines).toBe(0);
    expect(await client.counts()).toMatchObject({ sessions: 1, sources: 1, turns: 1, items: 2, item_sources: 2 });
  });

  test("operation errors reject their request without poisoning the worker", async () => {
    const client = await open(directory());
    await client.appendReceipt(receipt);
    const error = await client.appendReceipt({ ...receipt, state: "failed" }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("receipt identity already has different content");
    expect(await client.receipts(receipt.actionId)).toEqual([receipt]);
    expect((await client.counts()).receipts).toBe(1);
  });

  test("close drains preceding requests, is idempotent, and rejects new work", async () => {
    const configDir = directory();
    const client = await open(configDir);
    const write = client.appendReceipt(receipt);
    const closing = client.close();
    expect(client.close()).toBe(closing);
    await expect(client.counts()).rejects.toThrow();
    expect(await write).toBe(true);
    await closing;
    const reopened = await open(configDir);
    expect(await reopened.receipts(receipt.actionId)).toEqual([receipt]);
  });

  test("startup failure rejects instead of leaving an open worker", async () => {
    const path = join(directory(), "file");
    writeFileSync(path, "not a directory");
    await expect(RecordsClient.open({ configDir: path })).rejects.toThrow();
  });

  test("unexpected worker exit rejects future requests and close", async () => {
    const client = await open(directory());
    const worker = (client as unknown as { worker: Worker }).worker;
    await worker.terminate();
    await expect(client.counts()).rejects.toThrow("record worker exited");
    await expect(client.close()).rejects.toThrow("record worker exited");
  });
});
