import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRuntimeControlMessage, createControlServer, type RuntimeControlDispatchOptions } from "../src/control-server.ts";
import { createPhoneBridgeApplication, forwardToDaemonSocket, isPhoneHistoryRead } from "../src/phone-bridge.ts";
import { sendControlMessage, validateControlMessage, validateControlResponse } from "../src/settings.ts";
import { CONTROL_FRAME_MAX_BYTES } from "../src/control-framing.ts";
import type { HistoryResponse } from "../src/history.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const off: HistoryResponse = { kind: "history-off", error: "history is off" };
const page = { kind: "history-page" as const, session: "archived" };
const item = { kind: "history-item" as const, session: "archived", item: "item-1" };
const runtimeOptions = (extra: Partial<RuntimeControlDispatchOptions> = {}): RuntimeControlDispatchOptions => ({
  listResumable: () => ({ sessions: [], complete: true }), start() {}, close() {}, report() {}, ...extra,
});
async function socket(response: HistoryResponse = off) {
  const root = mkdtempSync(join(tmpdir(), "conch-history-transport-"));
  const path = join(root, "control.sock");
  const received: unknown[] = [];
  let resolved = 0;
  const server = createControlServer({ socketPath: path, ownerDeviceId: "owner", log() {},
    sessions: { resolve: () => { resolved++; throw new Error("history must not resolve a live row"); }, current: () => ({ published: false }) },
    application: {
      configuration: () => ({ kind: "config-error", error: "unused" }), session: () => ({ kind: "session-error", error: "unused" }),
      runtime: (request) => { received.push(request); return response; }, turn() {}, device: () => ({ kind: "ack" }),
    },
  });
  cleanups.push(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });
  expect(await server.start()).toBe(true);
  return { path, received, resolved: () => resolved };
}
function phone(forward: (body: string) => Promise<string>) {
  return createPhoneBridgeApplication({ getState: () => ({ rows: [] }), forwardControl: forward,
    replyFor: async () => "", acceptUpload: async () => ({ received: 1, total: 1 }), log() {} }, { token: "fixture-token" });
}
function request(path: string, body: string, token = "fixture-token", method = "POST") {
  return new Request(`http://fixture${path}`, { method, headers: { authorization: `Bearer ${token}` },
    ...(method === "GET" ? {} : { body }) });
}

test("history requests validate their exact shape and round-trip off responses", async () => {
  expect(validateControlMessage(page)).toEqual({ ok: true, value: page });
  expect(validateControlMessage(item)).toEqual({ ok: true, value: item });
  for (const bad of [{ ...page, limit: 101 }, { ...page, after: "unsupported" }, { ...item, item: "" }, { ...page, session: "🐚".repeat(1025) }]) {
    expect(validateControlMessage(bad).ok).toBe(false);
  }
  expect(validateControlResponse(off)).toEqual({ ok: true, value: off });
  expect(await applyRuntimeControlMessage(page, runtimeOptions())).toEqual(off);
  expect(await applyRuntimeControlMessage(item, runtimeOptions())).toEqual(off);
});

test("runtime history callbacks receive only their validated request fields", async () => {
  const seen: unknown[] = [];
  const options = runtimeOptions({ historyPage: (value) => { seen.push(value); return off; }, historyItem: (value) => { seen.push(value); return off; } });
  await applyRuntimeControlMessage({ ...page, branch: "branch", before: "cursor", limit: 5 }, options);
  await applyRuntimeControlMessage({ ...item, bodyCursor: "body" }, options);
  expect(seen).toEqual([{ session: "archived", branch: "branch", before: "cursor", limit: 5 }, { session: "archived", item: "item-1", bodyCursor: "body" }]);
  expect(await applyRuntimeControlMessage(page, runtimeOptions({ historyPage() { throw new Error("private path"); } })))
    .toEqual({ kind: "history-error", code: "unavailable", error: "history is unavailable" });
});

test("socket history bypasses live session resolution and rejects foreign owners before service", async () => {
  const f = await socket();
  expect(await sendControlMessage(f.path, page)).toEqual({ ok: true, response: off });
  expect(await sendControlMessage(f.path, item)).toEqual({ ok: true, response: off });
  const foreign = await forwardToDaemonSocket(f.path, JSON.stringify({ kind: "control-envelope", ownerDeviceId: "elsewhere", body: page }));
  expect(JSON.parse(foreign)).toMatchObject({ kind: "routing-error", code: "foreign-owner" });
  expect(f.received).toEqual([page, item]);
  expect(f.resolved()).toBe(0);
  const invalid = await forwardToDaemonSocket(f.path, JSON.stringify({ ...page, limit: 0 }));
  expect(JSON.parse(invalid)).toMatchObject({ kind: "history-error", code: "invalid-request" });
  expect(f.received).toHaveLength(2);
});

test("socket history request and response limits include the trailing newline", async () => {
  const f = await socket();
  const raw = JSON.stringify(page);
  const exact = raw + " ".repeat(CONTROL_FRAME_MAX_BYTES - Buffer.byteLength(raw) - 1) + "\n";
  expect(JSON.parse(await forwardToDaemonSocket(f.path, exact))).toEqual(off);
  await expect(forwardToDaemonSocket(f.path, exact + " ")).rejects.toThrow();
  expect(f.received).toHaveLength(1);
  const huge = await socket({ kind: "history-error", code: "unavailable", error: "🐚".repeat(17_000) });
  expect(JSON.parse(await forwardToDaemonSocket(huge.path, JSON.stringify(page))))
    .toMatchObject({ kind: "history-error", code: "response-too-large" });
});

test("a near-limit foreign owner is refused with a bounded reply before local history access", async () => {
  const f = await socket();
  const envelope = { kind: "control-envelope", ownerDeviceId: "", body: page };
  envelope.ownerDeviceId = "x".repeat(CONTROL_FRAME_MAX_BYTES - Buffer.byteLength(JSON.stringify(envelope)) - 1);
  const frame = JSON.stringify(envelope) + "\n";
  expect(Buffer.byteLength(frame)).toBe(CONTROL_FRAME_MAX_BYTES);
  const response = await forwardToDaemonSocket(f.path, frame);
  expect(Buffer.byteLength(response) + 1).toBeLessThanOrEqual(CONTROL_FRAME_MAX_BYTES);
  expect(JSON.parse(response)).toEqual({ kind: "routing-error", code: "foreign-owner", error: "this daemon cannot route to a foreign owner" });
  expect(f.received).toEqual([]);
  expect(f.resolved()).toBe(0);
});

test("phone history routes require bearer auth and do not require published session rows", async () => {
  const f = await socket();
  const app = phone((body) => forwardToDaemonSocket(f.path, body));
  for (const [path, body] of [["/history/page", { session: "archived" }], ["/history/item", { session: "archived", item: "item-1" }]] as const) {
    expect((await app.handle(request(path, JSON.stringify(body), "wrong")))!.status).toBe(401);
    const query = new Request(`http://fixture${path}?token=fixture-token`, { method: "POST", body: JSON.stringify(body) });
    expect((await app.handle(query))!.status).toBe(401);
    expect(await (await app.handle(request(path, JSON.stringify(body))))!.json()).toEqual(off);
    expect((await app.handle(request(path, "", "fixture-token", "GET")))!.status).toBe(404);
  }
  expect(f.received).toEqual([page, item]);
  expect(f.resolved()).toBe(0);
});

test("phone history rejects route confusion and oversized requests or responses", async () => {
  const seen: string[] = [];
  const app = phone(async (body) => { seen.push(body); return JSON.stringify(off); });
  expect((await app.handle(request("/history/page", JSON.stringify(item))))!.status).toBe(400);
  expect((await app.handle(request("/history/item", JSON.stringify(page))))!.status).toBe(400);
  expect((await app.handle(request("/history/page", JSON.stringify({ ...page, session: "🐚".repeat(17_000) }))))!.status).toBe(413);
  expect(seen).toEqual([]);
  const huge = phone(async () => JSON.stringify({ kind: "history-error", error: "🐚".repeat(17_000) }));
  for (const path of ["/history/page", "/control"]) {
    const response = (await huge.handle(request(path, JSON.stringify(page))))!;
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ kind: "history-error" });
  }
});

test("relay read classification follows the actual route and validated body", () => {
  const read = (path: string, body: unknown) => isPhoneHistoryRead(path, Buffer.from(JSON.stringify(body)));
  expect(read("/history/page", { session: "archived" })).toBe(true);
  expect(read("/history/item", item)).toBe(true);
  expect(read("/control?source=phone", page)).toBe(true);
  expect(read("/control", { kind: "control-envelope", ownerDeviceId: "elsewhere", body: item })).toBe(true);
  for (const [path, body] of [["/control", { type: "inject", sessionId: "s" }], ["/image", page], ["/history/page", item], ["/control", { ...page, type: "inject" }], ["/control", { kind: "history-page", session: "" }]] as const) {
    expect(read(path, body)).toBe(false);
  }
});
