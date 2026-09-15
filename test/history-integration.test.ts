import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordStore } from "../src/records-store.ts";
import { RecordsRuntime } from "../src/records-runtime.ts";
import { recordKey } from "../src/records-types.ts";
import { applyRuntimeControlMessage, createControlServer } from "../src/control-server.ts";
import { createPhoneBridgeApplication, forwardToDaemonSocket } from "../src/phone-bridge.ts";
import type { HistoryItem, HistoryPage } from "../src/history.ts";

test("authenticated phone history reads an indexed inactive session through socket and worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "conch-history-end-to-end-"));
  const configDir = join(root, "config");
  const claudeHome = join(root, "claude");
  const nativeId = "00000000-0000-4000-8000-000000000001";
  const session = { id: recordKey("local", "claude", nativeId), ownerDeviceId: "local", provider: "claude" as const, nativeId };
  const path = join(claudeHome, "projects", "fixture", `${nativeId}.jsonl`);
  const text = 'fixture 🐚\\"\n'.repeat(12_000);
  const bytes = Buffer.from(JSON.stringify({ type: "assistant", uuid: "answer", timestamp: "2026-09-16T01:00:00Z",
    message: { role: "assistant", content: text } }) + "\n");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  const stat = statSync(path);
  const store = new RecordStore({ configDir });
  store.ingest({ session, source: { id: recordKey(session.id, "source", String(stat.dev), String(stat.ino)),
    expected: null, path, device: String(stat.dev), inode: String(stat.ino), size: bytes.length, modifiedMs: stat.mtimeMs,
    prefix: bytes.subarray(0, 256), checkpoint: new Uint8Array(), from: 0, bytes } });
  store.close();
  const runtime = new RecordsRuntime({ configDir, ownerDeviceId: "local", claudeHome, codexHome: join(root, "codex") });
  const socketPath = join(root, "control.sock");
  let liveResolutions = 0;
  const server = createControlServer({ socketPath, ownerDeviceId: "local", log() {},
    sessions: { resolve() { liveResolutions++; throw Error("history must use the index"); }, current: () => ({ published: false }) },
    application: {
      configuration: () => ({ kind: "config-error", error: "unused" }), session: () => ({ kind: "session-error", error: "unused" }),
      runtime: (request) => applyRuntimeControlMessage(request, {
        historyPage: (query) => runtime.historyPage(query), historyItem: (query) => runtime.historyItem(query),
        listResumable: () => ({ sessions: [], complete: true }), start() {}, close() {}, report() {},
      }), turn() { throw Error("history is not a turn"); }, device: () => ({ kind: "ack" }),
    },
  });
  const app = createPhoneBridgeApplication({ getState: () => ({ rows: [] }),
    forwardControl: (line) => forwardToDaemonSocket(socketPath, line), replyFor: async () => { throw Error("legacy reader must not run"); },
    acceptUpload: async () => ({ received: 1, total: 1 }), log() {},
  }, { token: "fixture-token" });
  const request = (route: string, value: unknown) => app.handle(new Request(`http://fixture${route}`, {
    method: "POST", headers: { authorization: "Bearer fixture-token" }, body: JSON.stringify(value),
  }));
  try {
    expect(await server.start()).toBe(true);
    expect(await (await request("/history/page", { session: nativeId }))!.json()).toMatchObject({ kind: "history-off" });
    await runtime.setEnabled(true);
    const page = await (await request("/history/page", { session: nativeId }))!.json() as HistoryPage;
    expect(page.kind).toBe("history-page");
    expect(page.session).toBe(session.id);
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!.id;
    const chunks: string[] = [];
    let bodyCursor: string | undefined;
    for (let count = 0; count < 40; count++) {
      const response = (await request("/history/item", { session: page.session, item, ...(bodyCursor ? { bodyCursor } : {}) }))!;
      const wire = await response.text();
      expect(Buffer.byteLength(wire) + 1).toBeLessThanOrEqual(64 * 1024);
      const body = JSON.parse(wire) as HistoryItem;
      expect(body.kind).toBe("history-item");
      expect(body.revision).toBe(page.items[0]!.revision);
      chunks.push(body.content);
      bodyCursor = body.nextBodyCursor ?? undefined;
      if (!bodyCursor) break;
    }
    expect(bodyCursor).toBeUndefined();
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(digest(chunks.join(""))).toBe(digest(text));
    expect(liveResolutions).toBe(0);
    const foreign = await request("/control", { kind: "control-envelope", ownerDeviceId: "remote",
      body: { kind: "history-item", session: page.session, item } });
    expect(await foreign!.json()).toMatchObject({ kind: "routing-error", code: "foreign-owner" });
  } finally {
    await server.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
