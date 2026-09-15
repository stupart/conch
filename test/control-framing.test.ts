import { afterEach, expect, test } from "bun:test";
import { connect, createServer, type Socket, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createControlServer, type ControlServer } from "../src/control-server.ts";
import { sendControlMessage } from "../src/settings.ts";
import { createPhoneBridgeApplication, forwardToDaemonSocket } from "../src/phone-bridge.ts";

const MAX = 64 * 1024;
const roots: string[] = [], clients: Socket[] = [], controls: ControlServer[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const c of controls.splice(0)) await c.close();
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function path(): string { const root = mkdtempSync("/tmp/conch-frame-"); roots.push(root); return join(root, "c.sock"); }
function within<T>(work: Promise<T>, ms = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("test deadline")), ms); })])
    .finally(() => clearTimeout(timer));
}
async function control(outcome: unknown = undefined) {
  const socketPath = path(), received: unknown[] = [];
  const server = createControlServer({ socketPath, ownerDeviceId: "fixture", log() {},
    sessions: { resolve: (value) => { received.push(value); return value; }, current: () => ({ published: true, label: "fixture" }) },
    application: { configuration: () => ({ kind: "config-error", error: "fixture" }), session: () => ({ kind: "session-error", error: "fixture" }),
      runtime: () => ({ kind: "app-error-ack" }), device: () => ({ kind: "ack" }), turn: () => Promise.resolve(outcome) },
  }); controls.push(server); expect(await server.start()).toBe(true); return { socketPath, received };
}
async function request(socketPath: string, chunks: Uint8Array[], eof = false): Promise<string> {
  const sock = connect({ path: socketPath, allowHalfOpen: true }); clients.push(sock);
  const done = new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    sock.on("data", (data) => chunks.push(Buffer.from(data)));
    sock.on("end", () => { sock.end(); resolve(Buffer.concat(chunks).toString()); });
    sock.on("error", reject); sock.on("close", () => resolve(Buffer.concat(chunks).toString()));
  });
  await new Promise<void>((resolve) => sock.once("connect", resolve));
  for (const chunk of chunks) { sock.write(chunk); await Bun.sleep(5); }
  if (eof) sock.end();
  return within(done);
}
async function responder(action: (sock: Socket) => void) {
  const socketPath = path(); const server = createServer((sock) => { clients.push(sock); sock.on("error", () => {}); sock.once("data", () => action(sock)); });
  servers.push(server); await new Promise<void>((resolve) => server.listen(socketPath, resolve)); return socketPath;
}

test("the exact 64 KiB byte limit includes its newline on socket and phone bridge", async () => {
  const f = await control();
  const base = JSON.stringify({ kind: "get-config", key: "猫🐚" });
  const frame = base + " ".repeat(MAX - Buffer.byteLength(base) - 1) + "\n";
  expect(Buffer.byteLength(frame)).toBe(MAX);
  expect(JSON.parse(await request(f.socketPath, [Buffer.from(frame)])).kind).toBe("config-error");
  expect(f.received).toHaveLength(1);
  const app = createPhoneBridgeApplication({ getState: () => ({}), forwardControl: (line) => forwardToDaemonSocket(f.socketPath, line),
    replyFor: async () => "", acceptUpload: async () => ({ received: 1, total: 1 }), log() {} }, { token: "fixture" });
  const reply = await app.handle(new Request("http://fixture/control", { method: "POST", headers: { authorization: "Bearer fixture" }, body: frame }));
  expect(reply!.status).toBe(200);
  expect(JSON.parse(await reply!.text()).kind).toBe("config-error");
});

test("multibyte over-limit requests fail before dispatch", async () => {
  const f = await control();
  const reply = await request(f.socketPath, [Buffer.from(JSON.stringify({ kind: "get-config", key: "猫".repeat(24_000) }) + "\n")]);
  expect(JSON.parse(reply).kind).toBe("protocol-error"); expect(f.received).toEqual([]);
});

test("UTF-8 code points split across socket reads survive unchanged", async () => {
  const f = await control(); const frame = Buffer.from('{"kind":"get-config","key":"猫🐚"}\n');
  const split = frame.indexOf(Buffer.from("猫")) + 1;
  await request(f.socketPath, [frame.subarray(0, split), frame.subarray(split, split + 4), frame.subarray(split + 4)]);
  expect(f.received).toEqual([{ kind: "get-config", key: "猫🐚" }]);
});

test.each([Buffer.alloc(0), Buffer.from('{"kind":"get-config"}'), Buffer.from('{bad}\n'), Buffer.from([123,34,120,34,58,34,255,34,125,10])])
  ("empty, truncated, malformed JSON and invalid UTF-8 produce explicit errors", async (frame) => {
    const f = await control(); const reply = await request(f.socketPath, [frame], true);
    expect(JSON.parse(reply).kind).toBe("protocol-error"); expect(f.received).toEqual([]);
  });

test("forwarding refuses an empty EOF rather than accepting delivery", async () => {
  const socketPath = await responder((sock) => sock.end());
  await expect(forwardToDaemonSocket(socketPath, '{"kind":"get-config"}')).rejects.toThrow();
});

test("forwarding assembles split UTF-8 replies", async () => {
  const reply = Buffer.from('{"kind":"session-error","error":"猫🐚"}\n'); const split = reply.indexOf(Buffer.from("猫")) + 1;
  const socketPath = await responder((sock) => { sock.write(reply.subarray(0, split)); setTimeout(() => sock.end(reply.subarray(split)), 10); });
  expect(JSON.parse(await forwardToDaemonSocket(socketPath, '{"kind":"get-config"}')).error).toBe("猫🐚");
});

test("a forward timeout closes its daemon socket", async () => {
  let closed!: () => void; const didClose = new Promise<void>((resolve) => { closed = resolve; });
  const socketPath = await responder((sock) => { sock.once("close", closed); });
  await expect(forwardToDaemonSocket(socketPath, '{"kind":"get-config"}', 15)).rejects.toThrow("timed out");
  await within(didClose, 100);
});

test.each(["staged", undefined])("staged and unknown outcomes never imply delivery: %j", async (outcome) => {
  const f = await control(outcome);
  const frame = JSON.stringify({ type: "inject", sessionId: "s", label: "fixture", announce: "fixture words", awaitDelivery: true }) + "\n";
  expect(JSON.parse(await request(f.socketPath, [Buffer.from(frame)]))).toMatchObject({ kind: "inject-done", delivered: false, ...(outcome === "staged" ? { staged: true } : {}) });
});


test.each([Buffer.from('{"kind":"ack"}'), Buffer.from('{bad}\n'), Buffer.from([255,10]), Buffer.from('"' + '猫'.repeat(24_000) + '"\n')])
  ("forwarding rejects truncated, malformed, invalid UTF-8 and oversized replies", async (reply) => {
    const socketPath = await responder((sock) => sock.end(reply));
    await expect(forwardToDaemonSocket(socketPath, '{"kind":"get-config"}')).rejects.toThrow();
  });

test("HTTP uses the byte limit with the required delimiter and validates before forwarding", async () => {
  const forwarded: string[] = [];
  const app = createPhoneBridgeApplication({ getState: () => ({}), forwardControl: async (line) => { forwarded.push(line); return '{"kind":"ack"}'; },
    replyFor: async () => "", acceptUpload: async () => ({ received: 1, total: 1 }), log() {} }, { token: "fixture" });
  for (const [body, status] of [
    [JSON.stringify({ key: "猫".repeat(24_000) }), 413],
    ['"' + 'x'.repeat(MAX - 2) + '"', 413],
    ['{bad}', 400],
    [new Uint8Array([255]), 400],
  ] as const) {
    const reply = await app.handle(new Request("http://fixture/control", { method: "POST", headers: { authorization: "Bearer fixture" }, body }));
    expect(reply!.status).toBe(status);
  }
  expect(forwarded).toEqual([]);
});


test("settings client preserves split UTF-8 replies", async () => {
  const reply = Buffer.from('{"kind":"config-error","error":"猫🐚"}\n');
  const split = reply.indexOf(Buffer.from("猫")) + 1;
  const socketPath = await responder((sock) => { sock.write(reply.subarray(0, split)); setTimeout(() => sock.end(reply.subarray(split)), 10); });
  expect(await sendControlMessage(socketPath, { kind: "get-config" })).toEqual({ ok: true, response: { kind: "config-error", error: "猫🐚" } });
});

test.each([Buffer.from('{"kind":"config-error","error":"fixture"}'), Buffer.from('{"kind":"config-error","error":"' + "x".repeat(MAX) + '"}\n')])
  ("settings client rejects truncated or oversized replies", async (reply) => {
    const socketPath = await responder((sock) => sock.end(reply));
    expect(await sendControlMessage(socketPath, { kind: "get-config" })).toMatchObject({ ok: false, reason: "ack-unknown" });
  });


test("settings client rejects oversized outgoing UTF-8 before connecting", async () => {
  let reached = false;
  const socketPath = await responder((sock) => { reached = true; sock.end('{"kind":"config-error","error":"fixture"}\n'); });
  expect(await sendControlMessage(socketPath, { kind: "session-command", sessionId: "fixture", command: "rename", label: "猫".repeat(24_000) })).toMatchObject({ ok: false, reason: "ack-unknown" });
  expect(reached).toBe(false);
});
