import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPhoneBridgeApplication } from "../src/phone-bridge.ts";
import {
  MacRelayPeer,
  RELAY_RESPONSE_CACHE_LIMIT,
  RelayResponseCache,
  createPhoneRelay,
  ensureRelayPairing,
  readRelayPairing,
  relayPairingCode,
  type RelayPairing,
} from "../src/phone-relay.ts";
import {
  RelaySessionCipher,
  decodeBase64URL,
  deriveRelaySessionKeys,
  encodeBase64URL,
  isRelayDataFrame,
  openRelayHello,
  sealRelayHello,
  type OpenedRelayFrame,
} from "../src/relay-protocol.ts";

/// Wait for a condition with a DEADLINE, not an open-ended spin.
///
/// These were `while (!cond) await new Promise(r => setTimeout(r, 0))`, which
/// under a loaded parallel suite starves the producer and blows bun's 5s test
/// limit — a random failure that says nothing about what went wrong. A real
/// yield plus a deadline turns a flake into either a pass or a sentence.
async function settle(check: () => boolean, what: string, budgetMs = 10_000): Promise<void> {
  const started = Bun.nanoseconds();
  while (!check()) {
    if ((Bun.nanoseconds() - started) / 1e6 > budgetMs) {
      throw new Error(`timed out after ${budgetMs}ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) {
    try { Bun.spawnSync(["rm", "-rf", path]); } catch {}
  }
});

function pairing(): RelayPairing {
  return {
    version: 1,
    endpoint: "wss://relay.example.test",
    roomId: encodeBase64URL(Uint8Array.from({ length: 24 }, (_, index) => index + 10)),
    secret: encodeBase64URL(Uint8Array.from({ length: 32 }, (_, index) => index + 70)),
    createdAt: 1,
  };
}

function requestBody(path: string, secret: string, body = "", authorized = true): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    path,
    headers: [["authorization", `Bearer ${authorized ? secret : "wrong"}`]],
    body: encodeBase64URL(new TextEncoder().encode(body)),
  }));
}

async function connectedHarness(options: {
  state?: () => unknown;
  forward?: (line: string) => Promise<string>;
  cache?: RelayResponseCache;
  send?: (wire: string, sent: string[]) => Promise<void>;
  onProtocolFailure?: () => void;
} = {}) {
  const relay = pairing();
  const sent: string[] = [];
  let phoneOutbound: RelaySessionCipher | null = null;
  let phoneInspector: RelaySessionCipher | null = null;
  let peer!: MacRelayPeer;
  let clients = 0;
  const application = createPhoneBridgeApplication({
    getState: options.state ?? (() => ({ v: 1, rows: [] })),
    forwardControl: options.forward ?? (async () => ""),
    replyFor: async () => "reply",
    acceptUpload: async () => ({ received: 1, total: 1 }),
    onClientsChanged: (count) => { clients = count; },
    log() {},
  }, { token: "legacy-lan-token" });
  peer = new MacRelayPeer(
    application,
    relay,
    options.cache ?? new RelayResponseCache(),
    async (wire) => {
      if (options.send) await options.send(wire, sent);
      else sent.push(wire);
      if (!phoneOutbound || !phoneInspector) return;
      const value = JSON.parse(wire) as unknown;
      if (!isRelayDataFrame(value)) throw new Error("bad response frame");
      try {
        await openRelayHello(value, "mac", relay.roomId, relay.secret);
        return;
      } catch {
        // Not a root-key handshake frame; open it with the active session below.
      }
      const opened = await phoneInspector.open(value);
      if (opened.header.kind === "response-chunk") {
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, BigInt(opened.header.sequence), false);
        const ack = await phoneOutbound.seal(
          { id: opened.header.id, method: opened.header.method, kind: "chunk-ack" },
          bytes,
        );
        await peer.receive(JSON.stringify(ack));
      }
    },
    () => {},
    undefined,
    options.onProtocolFailure,
  );
  const macHelloWire = await peer.hello();
  const macHello = JSON.parse(macHelloWire) as unknown;
  if (!isRelayDataFrame(macHello)) throw new Error("bad mac hello");
  const macChallenge = await openRelayHello(macHello, "mac", relay.roomId, relay.secret);
  const phoneChallenge = Uint8Array.from({ length: 32 }, (_, index) => index + 100);
  const phoneHello = await sealRelayHello("phone", relay.roomId, relay.secret, phoneChallenge);
  await peer.receive(JSON.stringify(phoneHello));
  // A valid late-arriving phone hello always receives the Mac hello directly;
  // no blind idle retry loop is needed. Application tests start after it.
  sent.splice(0);
  const keys = await deriveRelaySessionKeys(
    relay.secret,
    relay.roomId,
    macChallenge,
    phoneChallenge,
  );
  phoneOutbound = RelaySessionCipher.phone(keys);
  phoneInspector = RelaySessionCipher.phone(keys);
  const rekey = async (challenge: Uint8Array) => {
    const nextKeys = await deriveRelaySessionKeys(
      relay.secret,
      relay.roomId,
      macChallenge,
      challenge,
    );
    phoneOutbound = RelaySessionCipher.phone(nextKeys);
    phoneInspector = RelaySessionCipher.phone(nextKeys);
    return phoneOutbound;
  };
  return {
    relay,
    peer,
    phone: phoneOutbound,
    phoneHello,
    sent,
    application,
    clients: () => clients,
    macChallenge,
    rekey,
  };
}

async function openSent(
  phone: RelaySessionCipher,
  sent: string[],
): Promise<OpenedRelayFrame[]> {
  const result: OpenedRelayFrame[] = [];
  for (const wire of sent.splice(0)) {
    const value = JSON.parse(wire) as unknown;
    if (!isRelayDataFrame(value)) throw new Error("bad response frame");
    result.push(await phone.open(value));
  }
  return result;
}

function responseStatus(frames: OpenedRelayFrame[]): number {
  const head = frames.find((frame) => frame.header.kind === "response-head");
  if (!head) throw new Error("missing response head");
  return (JSON.parse(new TextDecoder().decode(head.body)) as { status: number }).status;
}

function responseBody(frames: OpenedRelayFrame[], id: string): Uint8Array {
  const chunks = frames
    .filter((frame) => frame.header.id === id && frame.header.kind === "response-chunk")
    .map((frame) => frame.body);
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

describe("Mac phone relay adapter", () => {
  test("does not use a blind idle handshake retry loop", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "phone-relay.ts"), "utf8");
    expect(source).not.toContain("helloTimer");
    expect(source).toContain("await this.sendWire(await this.hello())");
  });

  test("does not recreate session keys for a repeated same-challenge hello", () => {
    const mac = readFileSync(join(import.meta.dir, "..", "src", "phone-relay.ts"), "utf8");
    const phone = readFileSync(
      join(import.meta.dir, "..", "mobile", "conch-ios", "conch-ios", "RelayTransport.swift"),
      "utf8",
    );
    expect(mac).toContain("if (challengeId === this.#currentPhoneChallenge)");
    expect(mac).toContain("Never recreate a cipher for the same challenges");
    expect(phone).toContain("while !Task.isCancelled, generation == socketGeneration, !sessionAuthenticated");
    expect(phone).toContain("if challenge == currentPeerChallenge");
    expect(phone).not.toContain("if !sessionAuthenticated {\n                try await establishSession");
    const establish = phone.slice(
      phone.indexOf("private func establishSession"),
      phone.indexOf("private func sendStateSubscription"),
    );
    expect(establish).not.toContain("helloTask?.cancel()");
  });

  test("relay pairing is high entropy, atomic, mode 0600, stable, and pasteable", () => {
    const root = mkdtempSync(join(tmpdir(), "conch-relay-pairing-"));
    temporary.push(root);
    const path = join(root, "nested", "relay.json");
    const first = ensureRelayPairing("https://example.workers.dev/", path);
    expect(first.endpoint).toBe("wss://example.workers.dev");
    expect(decodeBase64URL(first.roomId)).toHaveLength(24);
    expect(decodeBase64URL(first.secret)).toHaveLength(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const second = ensureRelayPairing("wss://other.example.test", path);
    expect(second.roomId).toBe(first.roomId);
    expect(second.secret).toBe(first.secret);
    expect(second.endpoint).toBe("wss://other.example.test");
    expect(readRelayPairing(path)).toEqual(second);
    expect(relayPairingCode(second)).toStartWith("conch-relay-v1:");
    expect(readFileSync(path, "utf8")).not.toContain("legacy-lan-token");
  });

  test("encrypted requests pass through the common auth gate and mutations execute once", async () => {
    let forwarded = 0;
    const cache = new RelayResponseCache();
    const first = await connectedHarness({
      cache,
      forward: async (line) => {
        forwarded += 1;
        return JSON.stringify({ accepted: line });
      },
    });
    const bad = await first.phone.seal(
      { id: "wrong-auth-request", method: "POST", kind: "request" },
      requestBody("/control", first.relay.secret, "{}", false),
    );
    await first.peer.receive(JSON.stringify(bad));
    expect(responseStatus(await openSent(first.phone, first.sent))).toBe(401);
    expect(forwarded).toBe(0);

    const id = "retry-safe-inject";
    const logicalBody = requestBody("/control", first.relay.secret, "{\"type\":\"inject\"}");
    const request = await first.phone.seal({ id, method: "POST", kind: "request" }, logicalBody);
    await first.peer.receive(JSON.stringify(request));
    expect(responseStatus(await openSent(first.phone, first.sent))).toBe(200);
    expect(forwarded).toBe(1);
    await expect(first.peer.receive(JSON.stringify(request))).rejects.toThrow("replayed");
    expect(forwarded).toBe(1);
    // Replaying the authenticated hello must not reset the application replay
    // window and make the old request frame valid again.
    await first.peer.receive(JSON.stringify(first.phoneHello));
    await expect(first.peer.receive(JSON.stringify(request))).rejects.toThrow("replayed");
    expect(forwarded).toBe(1);

    // A socket drop after execution loses the ciphertext response. The phone
    // resends the same logical ID under fresh keys; the Mac returns its cached
    // result without executing /control again.
    first.peer.close();
    const second = await connectedHarness({ cache, forward: async () => {
      forwarded += 1;
      return "";
    } });
    const retried = await second.phone.seal({ id, method: "POST", kind: "request" }, logicalBody);
    await second.peer.receive(JSON.stringify(retried));
    expect(responseStatus(await openSent(second.phone, second.sent))).toBe(200);
    expect(forwarded).toBe(1);
  });

  // The phone turns the Mac's reason into the sentence it shows, so the relay has to carry
  // the answer through byte for byte. A reason dropped here is a cause invented there.
  test("a delivery failure crosses the relay with its reason intact", async () => {
    const receipt = { kind: "inject-done", delivered: false, reason: "system-dialog-blocking", onClipboard: true };
    const h = await connectedHarness({ forward: async () => JSON.stringify(receipt) });
    const id = "blocked-inject";
    const request = await h.phone.seal(
      { id, method: "POST", kind: "request" },
      requestBody("/control", h.relay.secret, JSON.stringify({ type: "inject", awaitDelivery: true })),
    );
    await h.peer.receive(JSON.stringify(request));
    const frames = await openSent(h.phone, h.sent);
    expect(responseStatus(frames)).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(responseBody(frames, id)))).toEqual(receipt);
  });

  test("/file is authorized against the current review link at dispatch time and streams 64 KiB chunks", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-relay-file-"));
    temporary.push(root);
    const deliverable = join(root, "review.bin");
    writeFileSync(deliverable, Buffer.alloc(150_000, 7));
    chmodSync(deliverable, 0o600);
    let current = deliverable;
    const harness = await connectedHarness({
      state: () => ({ rows: current ? [{ review: { link: current } }] : [] }),
    });
    const path = `/file?path=${encodeURIComponent(deliverable)}`;
    const allowed = await harness.phone.seal(
      { id: "current-review-file", method: "GET", kind: "request" },
      requestBody(path, harness.relay.secret),
    );
    await harness.peer.receive(JSON.stringify(allowed));
    const frames = await openSent(harness.phone, harness.sent);
    expect(responseStatus(frames)).toBe(200);
    const chunks = frames.filter((frame) => frame.header.kind === "response-chunk");
    expect(chunks.map((frame) => frame.body.byteLength)).toEqual([65_536, 65_536, 18_928]);
    expect(frames.at(-1)?.header.kind).toBe("response-end");

    current = "";
    const stale = await harness.phone.seal(
      { id: "stale-review-file", method: "GET", kind: "request" },
      requestBody(path, harness.relay.secret),
    );
    await harness.peer.receive(JSON.stringify(stale));
    expect(responseStatus(await openSent(harness.phone, harness.sent))).toBe(403);
  });

  test("logical /ws uses the same auth route and contributes to aggregate audio presence", async () => {
    // The state moves between the subscribe and the publish: an identical frame
    // is deliberately not resent, so a fixed state would make the publish here
    // a no-op and test nothing about the relay's delivery path.
    let rows: Array<{ id: string }> = [];
    const harness = await connectedHarness({ state: () => ({ v: 7, rows }) });
    const subscribe = await harness.phone.seal(
      { id: "state-subscription", method: "GET", kind: "request" },
      requestBody("/ws", harness.relay.secret),
    );
    await harness.peer.receive(JSON.stringify(subscribe));
    await settle(() => harness.sent.length >= 3, "3 relay frames");
    const initial = await openSent(harness.phone, harness.sent);
    expect(initial.map((frame) => frame.header.kind)).toEqual([
      "response-head",
      "response-chunk",
      "response-end",
    ]);
    expect(JSON.parse(new TextDecoder().decode(responseBody(initial, "state-subscription"))).v).toBe(7);
    expect(harness.clients()).toBe(1);
    rows = [{ id: "appeared" }];
    harness.application.publish();
    await settle(() => harness.sent.length >= 3, "3 relay frames");
    expect((await openSent(harness.phone, harness.sent))[0]?.header.kind).toBe("response-head");
    harness.peer.close();
    expect(harness.clients()).toBe(0);
  });

  test("large state snapshots are coalesced into bounded authenticated chunks", async () => {
    const state = { v: 8, rows: [{ transcript: "s".repeat(150_000) }] };
    const harness = await connectedHarness({ state: () => state });
    const subscribe = await harness.phone.seal(
      { id: "large-state-subscription", method: "GET", kind: "request" },
      requestBody("/ws", harness.relay.secret),
    );
    await harness.peer.receive(JSON.stringify(subscribe));
    await settle(() => harness.sent.length >= 5, "5 relay frames");
    const frames = await openSent(harness.phone, harness.sent);
    const chunks = frames.filter((frame) => frame.header.kind === "response-chunk");
    expect(chunks.map((frame) => frame.body.byteLength)).toEqual([65_536, 65_536, 18_962]);
    expect(JSON.parse(
      new TextDecoder().decode(responseBody(frames, "large-state-subscription")),
    )).toEqual(state);
  });

  test("serializes hello acceptance before immediately following application frames", async () => {
    const relay = pairing();
    let calls = 0;
    const application = createPhoneBridgeApplication({
      getState: () => ({ v: 1, rows: [] }),
      forwardControl: async () => {
        calls += 1;
        return "";
      },
      replyFor: async () => "",
      acceptUpload: async () => ({ received: 1, total: 1 }),
      log() {},
    }, { token: "lan-token" });
    const sent: string[] = [];
    const peer = new MacRelayPeer(
      application,
      relay,
      new RelayResponseCache(),
      async (wire) => { sent.push(wire); },
      () => {},
    );
    const macHello = JSON.parse(await peer.hello()) as unknown;
    if (!isRelayDataFrame(macHello)) throw new Error("bad mac hello");
    const macChallenge = await openRelayHello(macHello, "mac", relay.roomId, relay.secret);
    const phoneChallenge = Uint8Array.from({ length: 32 }, (_, index) => index + 111);
    const phoneHello = await sealRelayHello("phone", relay.roomId, relay.secret, phoneChallenge);
    const keys = await deriveRelaySessionKeys(
      relay.secret,
      relay.roomId,
      macChallenge,
      phoneChallenge,
    );
    const phone = RelaySessionCipher.phone(keys);
    const request = await phone.seal(
      { id: "first-immediate-request", method: "POST", kind: "request" },
      requestBody("/control", relay.secret, "{}"),
    );

    await Promise.all([
      peer.receive(JSON.stringify(phoneHello)),
      peer.receive(JSON.stringify(request)),
    ]);
    const replyHello = sent.shift();
    expect(replyHello).toBeDefined();
    const replyValue = JSON.parse(replyHello!) as unknown;
    if (!isRelayDataFrame(replyValue)) throw new Error("bad mac reply hello");
    expect(await openRelayHello(replyValue, "mac", relay.roomId, relay.secret)).toEqual(macChallenge);
    expect(calls).toBe(1);
    expect(responseStatus(await openSent(phone, sent))).toBe(200);
  });

  test("buffers authenticated reordering and starts requests in phone sequence", async () => {
    const order: string[] = [];
    const harness = await connectedHarness({
      forward: async (line) => {
        order.push(JSON.parse(line).ordinal);
        return "";
      },
    });
    const subscribe = await harness.phone.seal(
      { id: "ordered-state-subscription", method: "GET", kind: "request" },
      requestBody("/ws", harness.relay.secret),
    );
    const ping = await harness.phone.seal(
      { id: "ordered-phone-ping", method: "PING", kind: "ping" },
      new Uint8Array(),
    );
    const control = await harness.phone.seal(
      { id: "ordered-control", method: "POST", kind: "request" },
      requestBody("/control", harness.relay.secret, JSON.stringify({ ordinal: "third" })),
    );

    await harness.peer.receive(JSON.stringify(control));
    expect(order).toEqual([]);
    expect(harness.clients()).toBe(0);
    await harness.peer.receive(JSON.stringify(subscribe));
    expect(harness.clients()).toBe(1);
    await harness.peer.receive(JSON.stringify(ping));
    expect(order).toEqual(["third"]);
  });

  test("a stale blocked state drain cannot clear the subscription from a new session", async () => {
    let releaseOldChunk!: () => void;
    const oldChunkGate = new Promise<void>((resolve) => { releaseOldChunk = resolve; });
    let blocked = false;
    let version = 1;
    const harness = await connectedHarness({
      state: () => ({ v: version, rows: [] }),
      send: async (wire, sent) => {
        sent.push(wire);
        if (!blocked && sent.length === 2) {
          blocked = true;
          await oldChunkGate;
        }
      },
    });
    const oldSubscribe = await harness.phone.seal(
      { id: "old-state-subscription", method: "GET", kind: "request" },
      requestBody("/ws", harness.relay.secret),
    );
    await harness.peer.receive(JSON.stringify(oldSubscribe));
    while (!blocked) await new Promise((resolve) => setTimeout(resolve, 0));

    version = 2;
    const nextChallenge = Uint8Array.from({ length: 32 }, (_, index) => 220 - index);
    const nextHello = await sealRelayHello(
      "phone",
      harness.relay.roomId,
      harness.relay.secret,
      nextChallenge,
    );
    await harness.peer.receive(JSON.stringify(nextHello));
    const nextPhone = await harness.rekey(nextChallenge);
    harness.sent.splice(0);
    const nextSubscribe = await nextPhone.seal(
      { id: "new-state-subscription", method: "GET", kind: "request" },
      requestBody("/ws", harness.relay.secret),
    );
    await harness.peer.receive(JSON.stringify(nextSubscribe));
    releaseOldChunk();
    await settle(() => harness.sent.length >= 3, "3 relay frames");

    const frames = await openSent(nextPhone, harness.sent);
    expect(JSON.parse(
      new TextDecoder().decode(responseBody(frames, "new-state-subscription")),
    ).v).toBe(2);
    expect(harness.clients()).toBe(1);
  });

  test("only the current session emits a cached response after an in-flight reconnect", async () => {
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    let calls = 0;
    const harness = await connectedHarness({
      forward: async () => {
        calls += 1;
        await mutationGate;
        return "";
      },
    });
    const id = "inflight-reconnect-mutation";
    const body = requestBody("/control", harness.relay.secret, "{}");
    const oldRequest = await harness.phone.seal(
      { id, method: "POST", kind: "request" },
      body,
    );
    const oldDelivery = harness.peer.receive(JSON.stringify(oldRequest));
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 0));

    const nextChallenge = Uint8Array.from({ length: 32 }, (_, index) => index + 17);
    const nextHello = await sealRelayHello(
      "phone",
      harness.relay.roomId,
      harness.relay.secret,
      nextChallenge,
    );
    await harness.peer.receive(JSON.stringify(nextHello));
    const nextPhone = await harness.rekey(nextChallenge);
    harness.sent.splice(0);
    const retried = await nextPhone.seal({ id, method: "POST", kind: "request" }, body);
    const retryDelivery = harness.peer.receive(JSON.stringify(retried));
    releaseMutation();
    await Promise.all([oldDelivery, retryDelivery]);

    expect(calls).toBe(1);
    const frames = await openSent(nextPhone, harness.sent);
    expect(frames.map((frame) => frame.header.kind)).toEqual([
      "response-head",
      "response-end",
    ]);
  });

  test("one bulk chunk cannot stall an interactive control response", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-relay-fairness-"));
    temporary.push(root);
    const deliverable = join(root, "large.bin");
    writeFileSync(deliverable, Buffer.alloc(220_000, 3));
    let releaseFirstChunk!: () => void;
    const firstChunkGate = new Promise<void>((resolve) => { releaseFirstChunk = resolve; });
    let blocked = false;
    const harness = await connectedHarness({
      state: () => ({ rows: [{ review: { link: deliverable } }] }),
      forward: async () => "{\"accepted\":true}",
      send: async (wire, sent) => {
        sent.push(wire);
        // Response head is frame 1, first file chunk is frame 2. Hold that
        // chunk in the simulated socket while an interactive request arrives.
        if (!blocked && sent.length === 2) {
          blocked = true;
          await firstChunkGate;
        }
      },
    });
    const fileId = "fairness-file-request";
    const file = await harness.phone.seal(
      { id: fileId, method: "GET", kind: "request" },
      requestBody(`/file?path=${encodeURIComponent(deliverable)}`, harness.relay.secret),
    );
    const fileDelivery = harness.peer.receive(JSON.stringify(file));
    await settle(() => harness.sent.length >= 2, "2 relay frames");

    const controlId = "fairness-control-request";
    const control = await harness.phone.seal(
      { id: controlId, method: "POST", kind: "request" },
      requestBody("/control", harness.relay.secret, "{}"),
    );
    const controlDelivery = harness.peer.receive(JSON.stringify(control));
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirstChunk();
    await Promise.all([fileDelivery, controlDelivery]);

    const opened = await openSent(harness.phone, harness.sent);
    const controlHead = opened.findIndex(
      (frame) => frame.header.id === controlId && frame.header.kind === "response-head",
    );
    const fileChunks = opened
      .map((frame, index) => ({ frame, index }))
      .filter(({ frame }) => frame.header.id === fileId && frame.header.kind === "response-chunk");
    expect(fileChunks.length).toBeGreaterThan(2);
    expect(controlHead).toBeGreaterThan(fileChunks[0]!.index);
    expect(controlHead).toBeLessThan(fileChunks[1]!.index);
  });
});

// Review finding 18: the cache kept every POST reply for the daemon's lifetime,
// telemetry included, and refused all sends once it held 4,096.
describe("the relay retry cache over a long-lived daemon", () => {
  test("history POSTs read fresh responses without reserving mutation retry entries", async () => {
    const cache = new RelayResponseCache();
    let forwarded = 0;
    const harness = await connectedHarness({ cache, forward: async () => {
      forwarded++;
      return JSON.stringify({ kind: "history-off", error: "history is off" });
    } });
    const reads = [
      ["/history/page", { session: "archived" }],
      ["/history/item", { session: "archived", item: "item" }],
      ["/control", { kind: "history-page", session: "archived" }],
      ["/control", { kind: "control-envelope", ownerDeviceId: "owner", body: { kind: "history-item", session: "archived", item: "item" } }],
    ] as const;
    for (const [path, body] of reads) {
      for (let retry = 0; retry < 2; retry++) {
        const frame = await harness.phone.seal({ id: "history-retry", method: "POST", kind: "request" },
          requestBody(path, harness.relay.secret, JSON.stringify(body)));
        await harness.peer.receive(JSON.stringify(frame));
        expect(responseStatus(await openSent(harness.phone, harness.sent))).toBe(200);
      }
    }
    expect(forwarded).toBe(8);
    expect(cache.size).toBe(0);
    const mutation = await harness.phone.seal({ id: "mutation", method: "POST", kind: "request" },
      requestBody("/control", harness.relay.secret, JSON.stringify({ type: "interrupt", sessionId: "s" })));
    await harness.peer.receive(JSON.stringify(mutation));
    expect(responseStatus(await openSent(harness.phone, harness.sent))).toBe(200);
    expect(cache.size).toBe(1);
    harness.peer.close();
  });

  async function post(
    harness: Awaited<ReturnType<typeof connectedHarness>>,
    phone: RelaySessionCipher,
    id: string,
    body: string,
  ): Promise<OpenedRelayFrame[]> {
    const frame = await phone.seal(
      { id, method: "POST", kind: "request" },
      requestBody("/control", harness.relay.secret, body),
    );
    await harness.peer.receive(JSON.stringify(frame));
    return openSent(phone, harness.sent);
  }

  test("4,200 requests with telemetry every fourth keep working, and telemetry holds no slot", async () => {
    const cache = new RelayResponseCache();
    let forwarded = 0;
    let rekeys = 0;
    const harness = await connectedHarness({
      cache,
      forward: async () => { forwarded += 1; return "{}"; },
      onProtocolFailure: () => { rekeys += 1; },
    });
    const total = RELAY_RESPONSE_CACHE_LIMIT + 104;
    let controls = 0;
    for (let index = 0; index < total; index += 1) {
      const telemetry = index % 4 === 0;
      if (!telemetry) controls += 1;
      const body = telemetry
        ? `{"kind":"phone-device","footprintMB":${index}}`
        : `{"type":"interrupt","sessionId":"s${index}"}`;
      expect(responseStatus(await post(harness, harness.phone, `load-request-${index}`, body))).toBe(200);
    }
    expect(forwarded).toBe(total);
    expect(cache.size).toBe(controls);
    expect(rekeys).toBe(0);
  }, 120_000);

  test("a session that outgrows the cache rekeys instead of refusing, and its last request still runs once", async () => {
    const cache = new RelayResponseCache();
    let forwarded = 0;
    let rekeys = 0;
    const forward = async () => { forwarded += 1; return "{}"; };
    const first = await connectedHarness({
      cache,
      forward,
      onProtocolFailure: () => { rekeys += 1; first.peer.close(); },
    });
    for (let index = 0; index < RELAY_RESPONSE_CACHE_LIMIT; index += 1) {
      expect(responseStatus(await post(first, first.phone, `full-request-${index}`, `{"n":${index}}`))).toBe(200);
    }
    expect(rekeys).toBe(0);
    const lastId = "full-request-overflow";
    const lastBody = `{"n":"overflow"}`;
    // One past the limit: the Mac rekeys rather than answering 503. The reply
    // is lost with the old keys, but the mutation itself ran.
    expect(await post(first, first.phone, lastId, lastBody)).toEqual([]);
    expect(rekeys).toBe(1);
    expect(forwarded).toBe(RELAY_RESPONSE_CACHE_LIMIT + 1);

    // The phone resends what is still pending before anything new.
    const second = await connectedHarness({ cache, forward });
    expect(responseStatus(await post(second, second.phone, lastId, lastBody))).toBe(200);
    expect(forwarded).toBe(RELAY_RESPONSE_CACHE_LIMIT + 1);
    expect(responseStatus(await post(second, second.phone, "after-rekey-request", "{}"))).toBe(200);
    expect(forwarded).toBe(RELAY_RESPONSE_CACHE_LIMIT + 2);
    expect(cache.size).toBe(2);
  }, 120_000);

  test("a request the phone may still resend stays deduplicated across reconnects; finished ones retire", async () => {
    const cache = new RelayResponseCache();
    let forwarded = 0;
    const forward = async () => { forwarded += 1; return "{}"; };
    const pendingId = "pending-inject-request";
    const pendingBody = `{"type":"inject","text":"ship it"}`;

    // Session 1: the inject runs, its reply is lost; another request finishes.
    const first = await connectedHarness({ cache, forward });
    await post(first, first.phone, pendingId, pendingBody);
    await post(first, first.phone, "finished-request-one", "{}");
    expect(forwarded).toBe(2);
    first.peer.close();

    // Session 2 (socket reconnect): the pending inject is resent first and
    // replayed, then something new arrives. The finished request was not
    // resent, so the phone is done with it and it retires.
    const second = await connectedHarness({ cache, forward });
    expect(responseStatus(await post(second, second.phone, pendingId, pendingBody))).toBe(200);
    expect(forwarded).toBe(2);
    expect(responseStatus(await post(second, second.phone, "new-request-two", "{}"))).toBe(200);
    expect(forwarded).toBe(3);

    // Session 3 (the phone rekeys on the same Mac socket): that reply was lost
    // too. However late the resend arrives, it must not run the inject again.
    const challenge = Uint8Array.from({ length: 32 }, (_, index) => index + 40);
    await second.peer.receive(JSON.stringify(await sealRelayHello(
      "phone",
      second.relay.roomId,
      second.relay.secret,
      challenge,
    )));
    const third = await second.rekey(challenge);
    second.sent.splice(0);
    expect(responseStatus(await post(second, third, pendingId, pendingBody))).toBe(200);
    expect(responseStatus(await post(second, third, "new-request-two", "{}"))).toBe(200);
    expect(forwarded).toBe(3);
    // Only the two requests still in play remain; the finished one retired.
    expect(cache.size).toBe(2);
  });
});

describe("a phone inject waiting on its keystrokes", () => {
  // The phone's inject now holds its request open until the typing is done
  // (awaitDelivery, up to control-server's bound). Relay mutations finish in
  // sequence, so without a head start a Stop or an audio claim sent meanwhile
  // would sit behind seconds of keystrokes.
  async function race(options: { awaitDelivery: boolean }) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const forwarded: string[] = [];
    const h = await connectedHarness({
      forward: async (line) => {
        const value = JSON.parse(line) as { type?: string; kind?: string };
        forwarded.push(value.type ?? value.kind ?? "");
        if (value.type !== "inject") return '{"kind":"audio-sink-ack","sink":"phone"}';
        await gate;
        return '{"kind":"inject-done","delivered":true}';
      },
    });
    const inject = await h.phone.seal(
      { id: "slow-inject", method: "POST", kind: "request" },
      requestBody("/control", h.relay.secret, JSON.stringify({
        type: "inject", ...(options.awaitDelivery ? { awaitDelivery: true } : {}),
      })),
    );
    const claim = await h.phone.seal(
      { id: "audio-claim", method: "POST", kind: "request" },
      requestBody("/control", h.relay.secret, JSON.stringify({ kind: "audio-sink", sink: "phone" })),
    );
    const injected = h.peer.receive(JSON.stringify(inject));
    let claimAnswered = false;
    const claimed = h.peer.receive(JSON.stringify(claim)).then(() => { claimAnswered = true; });
    return { h, forwarded, release, injected, claimed, claimAnswered: () => claimAnswered };
  }

  test("does not hold a later control behind it, and still starts first", async () => {
    const run = await race({ awaitDelivery: true });
    await settle(run.claimAnswered, "the audio claim's answer", 2_000);
    expect(run.forwarded).toEqual(["inject", "audio-sink"]);
    const early = await openSent(run.h.phone, run.h.sent);
    expect(early.some((frame) => frame.header.id === "audio-claim" && frame.header.kind === "response-end")).toBe(true);
    expect(early.some((frame) => frame.header.id === "slow-inject")).toBe(false);
    run.release();
    await run.injected;
    const late = await openSent(run.h.phone, run.h.sent);
    expect(late.some((frame) => frame.header.id === "slow-inject" && frame.header.kind === "response-end")).toBe(true);
  });

  test("any other slow mutation still finishes before the next one runs", async () => {
    const run = await race({ awaitDelivery: false });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(run.claimAnswered()).toBe(false);
    expect(run.forwarded).toEqual(["inject"]);
    run.release();
    await Promise.all([run.injected, run.claimed]);
    expect(run.forwarded).toEqual(["inject", "audio-sink"]);
  });
});

describe("a Mac that has lost its session says so", () => {
  test("an application frame with no cipher closes instead of vanishing", async () => {
    // After the Mac's relay socket reconnects it holds no cipher, but the phone
    // still has a session and keeps sending frames encrypted under it. Those
    // cannot open as a hello and have nothing to open under, so they were
    // logged and DROPPED — leaving the phone encrypting into a void while every
    // send failed as "daemon reply timed out". Measured on a real phone as
    // paired 12:19:24, rejected 12:22:27, silent throughout.
    const harness = await connectedHarness({});
    // A well-formed frame that is not a hello and does not match the session.
    const notAHello = JSON.stringify({
      v: 1,
      id: "x",
      kind: "request",
      method: "POST",
      seq: 9_999,
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    await expect(harness.peer.receive(notAHello)).rejects.toThrow();
  });
});

/// A5. The relay dropped with a 1006 at exactly 6010 s after open, three
/// times in one night, and never lived longer: Cloudflare closes a socket idle
/// in both directions (documented, figure unpublished; measured as 10 s to
/// hibernate the room + 100 min), and with no phone paired nothing follows
/// the Mac's hello. Two things were conch's: the Mac sent no keepalive, and a
/// drop after a long healthy life waited out a backoff that only a phone
/// handshake reset — up to 30 s — while the relay accepted every re-dial at
/// once. Bun's client fires only `close(1006)` for that drop (probed), and
/// `error -> close(1006)` for a dial that never opens.
describe("a settled relay socket that drops", () => {
  class FakeSocket {
    static OPEN = 1;
    static instances: FakeSocket[] = [];
    readyState = 0;
    bufferedAmount = 0;
    sent: string[] = [];
    pings = 0;
    #listeners = new Map<string, Array<(event: unknown) => void>>();
    constructor(public url: string) { FakeSocket.instances.push(this); }
    addEventListener(type: string, listener: (event: unknown) => void) {
      this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
    }
    send(wire: string) { this.sent.push(wire); }
    ping() { this.pings += 1; }
    close() { this.readyState = 3; }
    emit(type: string, event: object = {}) {
      for (const listener of this.#listeners.get(type) ?? []) listener(event);
    }
    open() { this.readyState = 1; this.emit("open"); }
  }
  const T0 = new Date("2026-09-11T04:07:06Z");

  async function dialled(tickMs?: number) {
    const real = globalThis.WebSocket;
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    FakeSocket.instances.splice(0);
    setSystemTime(T0);
    const logs: string[] = [];
    const application = createPhoneBridgeApplication({
      getState: () => ({ v: 1, rows: [] }),
      forwardControl: async () => "",
      replyFor: async () => "reply",
      acceptUpload: async () => ({ received: 1, total: 1 }),
      onClientsChanged() {},
      log() {},
    }, { token: "legacy-lan-token" });
    const handle = createPhoneRelay(application, pairing(), { log: (m) => logs.push(m), tickMs });
    const first = FakeSocket.instances[0]!;
    first.open();
    await settle(() => first.sent.length === 1, "the Mac hello");
    return {
      first,
      logs,
      dials: () => FakeSocket.instances.length,
      done() { handle.stop(); globalThis.WebSocket = real; setSystemTime(); },
    };
  }

  test("is re-dialled at once, and the close line carries its age", async () => {
    const link = await dialled();
    try {
      setSystemTime(new Date(T0.getTime() + 6_010_000));
      link.first.emit("close", { code: 1006 });
      expect(link.dials()).toBe(2);
      expect(link.logs.at(-1)).toBe(
        "phone relay disconnected (1006) — open 6010s, last frame 6010s ago, last ping 6010s ago",
      );
    } finally { link.done(); }
  });

  test("a socket that died young keeps the backoff", async () => {
    const link = await dialled();
    try {
      setSystemTime(new Date(T0.getTime() + 5_000));
      link.first.emit("close", { code: 1006 });
      expect(link.dials()).toBe(1);
      expect(link.logs.at(-1)).toStartWith("phone relay disconnected (1006) — open 5s");
    } finally { link.done(); }
    // A newer daemon took the room: no re-dial at all, however old the socket.
    const evicted = await dialled();
    try {
      setSystemTime(new Date(T0.getTime() + 6_010_000));
      evicted.first.emit("close", { code: 4001 });
      expect(evicted.dials()).toBe(1);
    } finally { evicted.done(); }
  });

  test("is pinged once idle, before Cloudflare's idle timer can fire", async () => {
    const link = await dialled(5);
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(link.first.pings).toBe(0);
      setSystemTime(new Date(T0.getTime() + 45_000));
      await settle(() => link.first.pings === 1, "a keepalive ping", 1_000);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(link.first.pings).toBe(1);
    } finally { link.done(); }
  });
});
