import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { forwardOpaqueMessage, installRoleSocket, isRelayRole, type OpaqueRelaySocket, type RelayRole } from "../relay/src/room.ts";
import {
  createPhoneBridgeApplication,
  createPhoneBridgeServer,
  mintPairingCode,
  type PhoneBridgeApplication,
} from "../src/phone-bridge.ts";
import { createPhoneRelay, relayPairingCode, type RelayPairing } from "../src/phone-relay.ts";
import { PhoneSetup, type PublishedPhone } from "../src/phone-setup.ts";
import {
  RelaySessionCipher,
  deriveRelaySessionKeys,
  encodeBase64URL,
  isRelayDataFrame,
  mintRelayRoomId,
  mintRelaySecret,
  openRelayHello,
  relayChallenge,
  sealRelayHello,
  type OpenedRelayFrame,
} from "../src/relay-protocol.ts";

/**
 * The phone's setup reaching the Mac end to end, over the real transports in one process: the LAN bridge on a real
 * port, and the encrypted relay through a real WebSocket room (the Worker's own forwarding code, served locally).
 * A fake phone does what the app does: pairs (the six-digit code, or the scanned relay code's key exchange), then
 * reports each stage. The Mac side is the daemon's own wiring: a PhoneSetup in a temp home publishing `phone` onto
 * the state every phone and the Mac app read.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { cleanup(); } catch {}
  }
});

async function until<T>(what: string, probe: () => T | undefined | null | false, budgetMs = 5_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await Bun.sleep(2);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The daemon's side: its setup store in a temp home, and the published state the bridge serves, patched as the daemon patches it. */
function mac(home: string) {
  const logs: string[] = [];
  let state: { v: number; ts: number; rows: never[]; phone?: PublishedPhone } = { v: 1, ts: 0, rows: [] };
  let application: PhoneBridgeApplication | null = null;
  const setup = new PhoneSetup({
    path: join(home, ".config", "conch", "phone-setup.json"),
    log: (line) => logs.push(line),
    onChange: () => {
      state = { ...state, ts: Date.now(), phone: setup.published(true) };
      application?.publish();
    },
  });
  state.phone = setup.published(true);
  const token = "lan-token-".padEnd(32, "0");
  application = createPhoneBridgeApplication({
    getState: () => state,
    forwardControl: async () => JSON.stringify({ kind: "ack" }),
    replyFor: async () => "",
    acceptUpload: async () => ({ error: "no uploads here" }),
    setup: {
      report: (report) => setup.report(report),
      exchange: (event) => setup.exchange(event),
      macName: () => "Tyler's MacBook Pro",
    },
    log: (line) => logs.push(line),
  }, { token });
  return { setup, application, token, logs, published: () => state.phone! };
}

describe("over the LAN bridge", () => {
  test("the six-digit code pairs, each stage reaches the Mac's published state, and a restart keeps it", async () => {
    const home = mkdtempSync(join(tmpdir(), "conch-setup-e2e-"));
    const m = mac(home);
    const server = createPhoneBridgeServer(m.application, { log() {} }, { port: 0, hostname: "127.0.0.1" });
    cleanups.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;
    expect(m.published()).toEqual({ enabled: true, paired: false, device: null, setup: { stage: "waiting", declined: [] } });

    const code = mintPairingCode();
    server.offerPairingCode(code);
    const paired = await fetch(`${base}/pair`, { method: "POST", body: JSON.stringify({ code: code.code }) });
    const { token } = await paired.json() as { token: string };
    expect(token).toBe(m.token);
    expect(m.published()).toMatchObject({ paired: true, setup: { stage: "paired" } });

    // The phone's state stream: every change reaches it, as it reaches the Mac app.
    const frames: PublishedPhone[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${token}`);
    cleanups.push(() => socket.close());
    socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)).phone);
    await until("the first state frame", () => frames.length === 1);

    const send = async (stage: string, declined: string[] = []) => {
      const response = await fetch(`${base}/setup-stage`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "setup-stage", stage, declined, device: "Tyler's iPhone" }),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    expect(await send("paired")).toEqual({ status: 200, body: { kind: "setup-stage-ack", stage: "paired", moved: true, mac: "Tyler's MacBook Pro" } });
    await send("microphone");
    await send("tour", ["microphone"]);
    // A late report from a slow link: answered, and ignored.
    expect((await send("microphone")).body).toMatchObject({ stage: "tour", moved: false });
    await until("the tour frame", () => frames.at(-1)?.setup.stage === "tour");
    expect(frames.at(-1)).toEqual({ enabled: true, paired: true, device: "Tyler's iPhone", setup: { stage: "tour", declined: ["microphone"] } });
    expect(frames.map((phone) => phone.setup.stage)).not.toContain("connecting");

    await send("finished", ["microphone"]);
    await until("the finished frame", () => frames.at(-1)?.setup.stage === "finished");

    // The daemon restarts: the same home, a new process's store.
    const again = mac(home);
    expect(again.published()).toEqual({ enabled: true, paired: true, device: "Tyler's iPhone", setup: { stage: "finished", declined: ["microphone"] } });

    // Nothing that opens this Mac is published or kept with it.
    const kept = readFileSync(join(home, ".config", "conch", "phone-setup.json"), "utf8");
    for (const secret of [token, code.code]) {
      expect(JSON.stringify(frames)).not.toContain(secret);
      expect(kept).not.toContain(secret);
    }
    expect(m.logs).toContain("phone setup: Tyler's iPhone → finished (declined microphone)");
  });
});

/** The relay Worker's room, served locally: its own forwarding and role rules, over real WebSockets. */
function localRelay() {
  const sockets = new Map<ServerWebSocket<{ role: RelayRole }>, OpaqueRelaySocket & { tags: string[] }>();
  const room = {
    getWebSockets: (tag?: string) => [...sockets.values()].filter((socket) => !tag || socket.tags.includes(tag)),
    acceptWebSocket: (socket: OpaqueRelaySocket, tags: string[] = []) => { (socket as OpaqueRelaySocket & { tags: string[] }).tags = tags; },
  };
  const server = Bun.serve<{ role: RelayRole }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      const role = url.searchParams.get("role");
      if (!/^\/v1\/room\/[A-Za-z0-9_-]+$/.test(url.pathname) || !isRelayRole(role)) return new Response("no", { status: 400 });
      return srv.upgrade(req, { data: { role } }) ? undefined : new Response("upgrade", { status: 426 });
    },
    websocket: {
      open(ws) {
        let attachment: unknown;
        const wrapped = {
          tags: [] as string[],
          get readyState() { return ws.readyState; },
          send: (message: string | ArrayBuffer) => void ws.send(message),
          close: (code?: number, reason?: string) => ws.close(code, reason),
          serializeAttachment: (value: unknown) => { attachment = value; },
          deserializeAttachment: () => attachment,
        };
        sockets.set(ws, wrapped);
        installRoleSocket(room, wrapped, ws.data.role);
      },
      message(ws, message) {
        const sender = sockets.get(ws);
        if (sender) forwardOpaqueMessage(room, sender, typeof message === "string" ? message : new Uint8Array(message).buffer as ArrayBuffer);
      },
      close(ws) { sockets.delete(ws); },
    },
  });
  return server;
}

/** A phone as the app is one: the scanned code's room and secret, a hello, then requests sealed under the session keys. */
async function relayPhone(port: number, pairing: RelayPairing) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/room/${pairing.roomId}?role=phone`);
  const inbox: string[] = [];
  socket.onmessage = (event) => inbox.push(String(event.data));
  await until("the phone's relay socket", () => socket.readyState === WebSocket.OPEN);
  const challenge = relayChallenge();
  socket.send(JSON.stringify(await sealRelayHello("phone", pairing.roomId, pairing.secret, challenge)));
  const macHello = await until("the Mac's hello", () => inbox.shift());
  const frame = JSON.parse(macHello) as unknown;
  if (!isRelayDataFrame(frame)) throw new Error("not a relay frame");
  const macChallenge = await openRelayHello(frame, "mac", pairing.roomId, pairing.secret);
  const keys = await deriveRelaySessionKeys(pairing.secret, pairing.roomId, macChallenge, challenge);
  const outbound = RelaySessionCipher.phone(keys);
  const inbound = RelaySessionCipher.phone(keys);
  const responses = new Map<string, { status?: number; body: Uint8Array[]; done: boolean }>();
  const states: PublishedPhone[] = [];
  let pump = Promise.resolve();
  const drain = () => {
    pump = pump.then(async () => {
      while (inbox.length) {
        const value = JSON.parse(inbox.shift()!) as unknown;
        if (!isRelayDataFrame(value)) continue;
        let opened: OpenedRelayFrame;
        try { opened = await inbound.open(value); } catch { continue; }
        const entry = responses.get(opened.header.id) ?? { body: [], done: false };
        responses.set(opened.header.id, entry);
        if (opened.header.kind === "response-head") entry.status = (JSON.parse(new TextDecoder().decode(opened.body)) as { status: number }).status;
        if (opened.header.kind === "response-chunk") {
          entry.body.push(opened.body);
          const ack = new Uint8Array(8);
          new DataView(ack.buffer).setBigUint64(0, BigInt(opened.header.sequence), false);
          socket.send(JSON.stringify(await outbound.seal({ id: opened.header.id, method: opened.header.method, kind: "chunk-ack" }, ack)));
        }
        if (opened.header.kind === "response-end") {
          if (opened.header.id === "state-stream") {
            states.push(JSON.parse(new TextDecoder().decode(Buffer.concat(entry.body))).phone);
            entry.body = [];
          } else entry.done = true;
        }
      }
    });
  };
  socket.onmessage = (event) => { inbox.push(String(event.data)); drain(); };
  // Unique, as the app's are: the Mac runs each request id once, across reconnects too.
  const request = async (method: string, path: string, body = "", id = `request-${crypto.randomUUID()}`) => {
    socket.send(JSON.stringify(await outbound.seal({ id, method, kind: "request" }, new TextEncoder().encode(JSON.stringify({
      path,
      headers: [["authorization", `Bearer ${pairing.secret}`], ["content-type", "application/json"]],
      body: encodeBase64URL(new TextEncoder().encode(body)),
    })))));
    return id;
  };
  const answer = async (id: string) => {
    const entry = await until(`the answer to ${id}`, () => responses.get(id)?.done && responses.get(id));
    return { status: entry.status, body: JSON.parse(new TextDecoder().decode(Buffer.concat(entry.body))) as Record<string, unknown> };
  };
  const report = async (stage: string, declined: string[] = []) =>
    answer(await request("POST", "/setup-stage", JSON.stringify({ kind: "setup-stage", stage, declined, device: "Tyler's iPhone" })));
  return { socket, request, answer, report, states, close: () => socket.close() };
}

describe("over the encrypted relay", () => {
  test("the scanned code's key exchange shows as connecting, then paired; each stage lands; nothing secret is published", async () => {
    const home = mkdtempSync(join(tmpdir(), "conch-setup-e2e-"));
    const m = mac(home);
    const relayServer = localRelay();
    cleanups.push(() => relayServer.stop(true));
    // The daemon dials wss; the local room speaks plain ws. Only the hop changes: every frame is the real sealed one.
    const RealWebSocket = globalThis.WebSocket;
    class LocalHop extends RealWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) { super(String(url).replace(/^wss:/, "ws:"), protocols); }
    }
    globalThis.WebSocket = LocalHop as typeof WebSocket;
    cleanups.push(() => { globalThis.WebSocket = RealWebSocket; });
    const pairing: RelayPairing = {
      version: 1, endpoint: `wss://127.0.0.1:${relayServer.port}`, roomId: mintRelayRoomId(), secret: mintRelaySecret(), createdAt: Date.now(),
    };
    const relay = createPhoneRelay(m.application, pairing, { log: (line) => m.logs.push(line) });
    cleanups.push(() => relay.stop());
    await until("the Mac in the room", () => m.logs.includes("phone relay connected"));
    expect(m.published().setup.stage).toBe("waiting");

    const phone = await relayPhone(relayServer.port!, pairing);
    cleanups.push(() => phone.close());
    // The Mac has accepted the phone's hello and answered it; no frame under the new keys yet: in flight.
    expect(m.published()).toEqual({ enabled: true, paired: false, device: null, setup: { stage: "connecting", declined: [] } });

    // The app's first frame is its state stream; opening it completes the exchange.
    await phone.request("GET", "/ws", "", "state-stream");
    await until("paired", () => m.published().paired);
    await until("a state frame on the phone", () => phone.states.at(-1)?.paired);
    expect(phone.states.at(-1)).toEqual({ enabled: true, paired: true, device: null, setup: { stage: "paired", declined: [] } });

    expect(await phone.report("paired")).toEqual({ status: 200, body: { kind: "setup-stage-ack", stage: "paired", moved: true, mac: "Tyler's MacBook Pro" } });
    await phone.report("microphone");
    expect((await phone.report("tour", ["microphone"])).body).toMatchObject({ stage: "tour", moved: true });
    await until("the tour on the phone's own stream", () => phone.states.at(-1)?.setup.stage === "tour");
    expect(phone.states.at(-1)).toEqual({ enabled: true, paired: true, device: "Tyler's iPhone", setup: { stage: "tour", declined: ["microphone"] } });

    // Refused over the relay just as on the LAN, and nothing moves.
    const refused = await phone.report("connecting");
    expect(refused).toEqual({ status: 400, body: { kind: "setup-stage-error", error: "connecting is the Mac's to say, not the phone's" } });
    expect(m.published().setup.stage).toBe("tour");

    // The link drops mid-setup and comes back: a new key exchange, which changes nothing now it's paired, and the
    // phone resends where it is.
    phone.close();
    const back = await relayPhone(relayServer.port!, pairing);
    cleanups.push(() => back.close());
    expect(m.published()).toMatchObject({ paired: true, setup: { stage: "tour" } });
    await back.request("GET", "/ws", "", "state-stream");
    expect((await back.report("tour", ["microphone"])).body).toMatchObject({ stage: "tour", moved: false });
    expect((await back.report("finished", ["microphone"])).body).toMatchObject({ stage: "finished", moved: true });
    await until("finished on the stream", () => back.states.at(-1)?.setup.stage === "finished");

    const published = JSON.stringify([...phone.states, ...back.states, m.published()]);
    const kept = readFileSync(join(home, ".config", "conch", "phone-setup.json"), "utf8");
    for (const secret of [pairing.secret, pairing.roomId, relayPairingCode(pairing), m.token]) {
      expect(published).not.toContain(secret);
      expect(kept).not.toContain(secret);
    }
    expect(mac(home).published()).toEqual({ enabled: true, paired: true, device: "Tyler's iPhone", setup: { stage: "finished", declined: ["microphone"] } });
  });

  test("an exchange that never completes goes back to waiting", async () => {
    const home = mkdtempSync(join(tmpdir(), "conch-setup-e2e-"));
    const m = mac(home);
    const relayServer = localRelay();
    cleanups.push(() => relayServer.stop(true));
    const RealWebSocket = globalThis.WebSocket;
    class LocalHop extends RealWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) { super(String(url).replace(/^wss:/, "ws:"), protocols); }
    }
    globalThis.WebSocket = LocalHop as typeof WebSocket;
    cleanups.push(() => { globalThis.WebSocket = RealWebSocket; });
    const pairing: RelayPairing = {
      version: 1, endpoint: `wss://127.0.0.1:${relayServer.port}`, roomId: mintRelayRoomId(), secret: mintRelaySecret(), createdAt: Date.now(),
    };
    const relay = createPhoneRelay(m.application, pairing, { log: (line) => m.logs.push(line) });
    await until("the Mac in the room", () => m.logs.includes("phone relay connected"));
    const phone = await relayPhone(relayServer.port!, pairing);
    cleanups.push(() => phone.close());
    expect(m.published().setup.stage).toBe("connecting");
    // The daemon stops before the phone's first frame: that exchange is over, and it never paired.
    relay.stop();
    expect(m.published()).toEqual({ enabled: true, paired: false, device: null, setup: { stage: "waiting", declined: [] } });
    expect(mac(home).published().setup.stage).toBe("waiting");
  });
});
