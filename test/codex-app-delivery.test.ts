import { afterEach, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateCodexSocket, probeCodexAppThreads, readCodexAppThreads, sendCodexAppMessage } from "../src/codex-app-delivery.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });
async function bridge(handler: (request: any) => any, discovery = (_request: any): any => ({ result: { supportsUntrustedAppInput: true } })) {
  const home = mkdtempSync(join(tmpdir(), "conch-ipc-"));
  mkdirSync(join(home, "ipc"), { mode: 0o700 });
  const path = join(home, "ipc", "ipc.sock"), calls: any[] = [], sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (buffer.length >= 4) {
        const n = buffer.readUInt32LE(); if (buffer.length < n + 4) return;
        const request = JSON.parse(buffer.subarray(4, n + 4).toString()); buffer = buffer.subarray(n + 4);
        calls.push(request);
        const answer = request.method === "initialize" ? { result: { clientId: "conch-client" } }
          : request.method === "thread-owner-discovery" ? discovery(request)
          : handler(request);
        if (answer === null) continue;
        const bytes = Buffer.from(JSON.stringify({ type: "response", requestId: request.requestId, method: request.method, handledByClientId: "owner", resultType: "success", ...answer }));
        const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
        // Fragmented frames exercise the actual stream reader.
        socket.write(header.subarray(0, 2)); socket.write(Buffer.concat([header.subarray(2), bytes]));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve)); chmodSync(path, 0o600);
  cleanup.push(() => { for (const s of sockets) s.destroy(); server.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, path, calls, send: (extra = {}) => sendCodexAppMessage({ codexHome: home, threadId: "native", text: "hello", timeoutMs: 200, ...extra }) };
}
test("steers the exact owner as Conch, accepts a provider turn ID, and never starts another turn", async () => {
  const b = await bridge(() => ({ result: { result: { turnId: "turn-1" } } }));
  expect(await b.send()).toEqual({ delivered: true, turnId: "turn-1", mode: "steered" });
  expect(b.calls.map(c => c.method)).toEqual(["initialize", "thread-owner-discovery", "thread-follower-steer-turn"]);
  expect(b.calls[0].params.clientType).toBe("conch");
  expect(b.calls[2]).toMatchObject({ targetClientId: "owner", version: 1, params: { conversationId: "native", input: [{ type: "text", text: "hello" }] } });
});
test("listing proves each desktop owner without sending input, and caches repeated polls", async () => {
  const b = await bridge(() => { throw Error("no input during discovery"); }, r => r.params.conversationId === "desktop"
    ? { result: { supportsUntrustedAppInput: true } }
    : { resultType: "error", error: "no-client-found", handledByClientId: undefined });
  expect([...await readCodexAppThreads(b.home, ["terminal", "desktop"])]).toEqual(["desktop"]);
  const count = b.calls.length;
  expect([...await readCodexAppThreads(b.home, ["desktop", "terminal"])]).toEqual(["desktop"]);
  expect(b.calls.length).toBe(count);
  expect(b.calls.map(c => c.method)).toEqual(["initialize", "thread-owner-discovery", "thread-owner-discovery"]);
  chmodSync(b.path, 0o666);
  expect((await readCodexAppThreads(b.home, ["desktop", "terminal"])).size).toBe(0);
});
test("missing owner acknowledgement or a discovery timeout never advertises app delivery", async () => {
  for (const answer of [{ handledByClientId: undefined }, null]) {
    const b = await bridge(() => null, () => answer);
    expect((await probeCodexAppThreads(b.home, ["unknown"], 25)).size).toBe(0);
  }
});
test("only an explicit inactive rejection starts a new turn, inheriting settings", async () => {
  const b = await bridge(r => r.method.endsWith("steer-turn")
    ? { resultType: "error", error: "Cannot steer conversation native because its active turn already ended" }
    : { result: { result: { turn: { id: "next-turn" } } } });
  expect(await b.send({ messageId: "operation-id" })).toEqual({ delivered: true, turnId: "next-turn", mode: "started" });
  expect(b.calls.at(-1)).toMatchObject({ method: "thread-follower-start-turn", version: 2, targetClientId: "owner", params: { conversationId: "native", turnStart: { request: { threadId: "native", clientUserMessageId: "operation-id" }, context: { inheritThreadSettings: true } } } });
  expect(b.calls.at(-1).params.turnStart.request.permissions).toBeUndefined();
});
for (const [name, answer] of [
  ["timeout", null], ["missing provider acknowledgement", { result: {} }],
  ["unknown owner error", { resultType: "error", error: "network went away" }],
] as const) test(`${name} preserves uncertainty and does not retry`, async () => {
  const b = await bridge(() => answer);
  expect(await b.send()).toEqual({ delivered: false, reason: "hosted-delivery-unconfirmed", uncertain: true });
  expect(b.calls.filter(c => c.method.startsWith("thread-follower-")).length).toBe(1);
});
test("version mismatch is actionable and never falls back to another transport", async () => {
  const b = await bridge(() => ({ resultType: "error", error: "request-version-mismatch" }));
  expect(await b.send()).toEqual({ delivered: false, reason: "hosted-protocol-incompatible" });
  expect(b.calls.length).toBe(3);
});
test("a cancellation after discovery sends no text", async () => {
  const b = await bridge(() => { throw Error("must not send"); });
  expect(await b.send({ beforeSend: () => false })).toEqual({ delivered: false, reason: "delivery-interrupted" });
  expect(b.calls.length).toBe(2);
});
test("untrusted socket permissions and symlinks are refused before connection", async () => {
  const b = await bridge(() => null);
  chmodSync(b.path, 0o666); expect(privateCodexSocket(b.path)).toBe(false);
  expect(await b.send()).toEqual({ delivered: false, reason: "hosted-app-unavailable" });
  expect(b.calls).toEqual([]);
  chmodSync(b.path, 0o600); expect(privateCodexSocket(b.path)).toBe(true);
  const link = join(b.home, "ipc", "link.sock"); symlinkSync(b.path, link);
  expect(privateCodexSocket(link)).toBe(false);
});
