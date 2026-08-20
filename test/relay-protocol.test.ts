import { describe, expect, test } from "bun:test";
import {
  RelaySessionCipher,
  decodeBase64URL,
  deriveRelayHandshakeKeys,
  deriveRelaySessionKeys,
  encodeRelayFrame,
  encodeBase64URL,
  openRelayHello,
  relayRequestFingerprint,
  sealRelayHello,
  type RelayDataFrame,
} from "../src/relay-protocol.ts";

const secret = encodeBase64URL(Uint8Array.from({ length: 32 }, (_, index) => index));
const roomId = encodeBase64URL(Uint8Array.from({ length: 24 }, (_, index) => 100 + index));
const macChallenge = Uint8Array.from({ length: 32 }, (_, index) => 32 + index);
const phoneChallenge = Uint8Array.from({ length: 32 }, (_, index) => 64 + index);
const headerNonce = Uint8Array.from({ length: 12 }, (_, index) => 80 + index);
const bodyNonce = Uint8Array.from({ length: 12 }, (_, index) => 96 + index);

function mutate(value: string): string {
  const bytes = decodeBase64URL(value);
  bytes[Math.floor(bytes.length / 2)]! ^= 0x01;
  return encodeBase64URL(bytes);
}

describe("relay E2E protocol", () => {
  test("hello authenticates the role, room, secret, and fresh challenge", async () => {
    const nonce = Uint8Array.from({ length: 12 }, (_, index) => index + 1);
    const hello = await sealRelayHello("phone", roomId, secret, phoneChallenge, {
      header: nonce,
      body: Uint8Array.from(nonce, (value) => value + 16),
    });
    expect(await openRelayHello(hello, "phone", roomId, secret)).toEqual(phoneChallenge);
    await expect(openRelayHello(hello, "mac", roomId, secret)).rejects.toThrow();
    await expect(openRelayHello(hello, "phone", `${roomId}x`, secret)).rejects.toThrow();
    const wrongSecret = encodeBase64URL(Uint8Array.from({ length: 32 }, () => 9));
    await expect(openRelayHello(hello, "phone", roomId, wrongSecret)).rejects.toThrow();
    await expect(openRelayHello({ ...hello, bodyCiphertext: mutate(hello.bodyCiphertext) }, "phone", roomId, secret))
      .rejects.toThrow();
  });

  test("repeated hellos share a nonce-tracking sender under the long-lived handshake key", async () => {
    const channel = RelaySessionCipher.phone(await deriveRelayHandshakeKeys(secret, roomId));
    const first = await sealRelayHello(
      "phone",
      roomId,
      secret,
      phoneChallenge,
      undefined,
      channel,
    );
    const second = await sealRelayHello(
      "phone",
      roomId,
      secret,
      phoneChallenge,
      undefined,
      channel,
    );
    expect(first.headerNonce).not.toBe(second.headerNonce);
    expect(first.bodyNonce).not.toBe(second.bodyNonce);
    expect(await openRelayHello(first, "phone", roomId, secret)).toEqual(phoneChallenge);
    expect(await openRelayHello(second, "phone", roomId, secret)).toEqual(phoneChallenge);
  });

  test("opaque header and body round-trip with ID and method bound into body AAD", async () => {
    const keys = await deriveRelaySessionKeys(secret, roomId, macChallenge, phoneChallenge);
    const phone = RelaySessionCipher.phone(keys);
    const mac = RelaySessionCipher.mac(keys);
    const body = new TextEncoder().encode(JSON.stringify({
      path: "/control",
      headers: [["authorization", "Bearer should-never-be-visible"]],
      body: "c2VjcmV0IHByb21wdA",
    }));
    const frame = await phone.seal(
      { id: "5f101785-b9fb-414a-89f7-4cd2b694eb4a", method: "POST", kind: "request" },
      body,
      { header: headerNonce, body: bodyNonce },
    );

    const wire = JSON.stringify(frame);
    expect(wire).not.toContain("POST");
    expect(wire).not.toContain("control");
    expect(wire).not.toContain("5f101785");
    expect(wire).not.toContain("Bearer");

    const opened = await mac.open(frame);
    expect(opened.header).toEqual({
      version: 1,
      id: "5f101785-b9fb-414a-89f7-4cd2b694eb4a",
      method: "POST",
      sequence: 0,
      direction: "phone-to-mac",
      kind: "request",
    });
    expect(opened.body).toEqual(body);
  });

  test("ciphertext mutation, wrong direction, replay, and stale-session replay fail closed", async () => {
    const keys = await deriveRelaySessionKeys(secret, roomId, macChallenge, phoneChallenge);
    const makeFrame = async () => RelaySessionCipher.phone(keys).seal(
      { id: "8a4e8b96-b009-4248-bf75-7ca0258363f1", method: "GET", kind: "request" },
      new TextEncoder().encode("request"),
      { header: headerNonce, body: bodyNonce },
    );

    const headerMutated = await makeFrame();
    headerMutated.headerCiphertext = mutate(headerMutated.headerCiphertext);
    await expect(RelaySessionCipher.mac(keys).open(headerMutated)).rejects.toThrow();

    const bodyMutated = await makeFrame();
    bodyMutated.bodyCiphertext = mutate(bodyMutated.bodyCiphertext);
    await expect(RelaySessionCipher.mac(keys).open(bodyMutated)).rejects.toThrow();

    const frame = await makeFrame();
    await expect(RelaySessionCipher.phone(keys).open(frame)).rejects.toThrow();
    const mac = RelaySessionCipher.mac(keys);
    await mac.open(frame);
    await expect(mac.open(frame)).rejects.toThrow("replayed");

    const freshPhone = Uint8Array.from(phoneChallenge);
    freshPhone[0]! ^= 0x80;
    const freshKeys = await deriveRelaySessionKeys(secret, roomId, macChallenge, freshPhone);
    await expect(RelaySessionCipher.mac(freshKeys).open(frame)).rejects.toThrow();
  });

  test("a forged unauthenticated high sequence cannot poison the replay window", async () => {
    const keys = await deriveRelaySessionKeys(secret, roomId, macChallenge, phoneChallenge);
    const phone = RelaySessionCipher.phone(keys);
    const mac = RelaySessionCipher.mac(keys);
    const first = await phone.seal(
      { id: "9788d877-d081-4468-961e-16789ca9d3e4", method: "GET", kind: "request" },
      new Uint8Array([1]),
    );
    const forged = structuredClone(first) as RelayDataFrame;
    forged.bodyCiphertext = mutate(forged.bodyCiphertext);
    await expect(mac.open(forged)).rejects.toThrow();
    expect((await mac.open(first)).body).toEqual(new Uint8Array([1]));
  });

  test("request fingerprints bind method, route, headers, and body", () => {
    const headers = [["authorization", "Bearer token"]] as const;
    const body = new TextEncoder().encode("hello");
    const value = relayRequestFingerprint("POST", "/control", headers, body);
    expect(relayRequestFingerprint("POST", "/control", headers, body)).toBe(value);
    expect(relayRequestFingerprint("GET", "/control", headers, body)).not.toBe(value);
    expect(relayRequestFingerprint("POST", "/state", headers, body)).not.toBe(value);
    expect(relayRequestFingerprint("POST", "/control", [["authorization", "Bearer other"]], body))
      .not.toBe(value);
    expect(relayRequestFingerprint("POST", "/control", headers, new TextEncoder().encode("bye")))
      .not.toBe(value);
  });

  test("matches the CryptoKit/WebCrypto fixed ciphertext vector", async () => {
    const vectorSecret = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const vectorRoom = "ICEiIyQlJicoKSorLC0uLw";
    const vectorPhone = decodeBase64URL("QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8");
    const vectorMac = decodeBase64URL("YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8");
    const keys = await deriveRelaySessionKeys(vectorSecret, vectorRoom, vectorMac, vectorPhone);
    const cipher = RelaySessionCipher.phone(keys, 7);
    const frame = await cipher.seal(
      { id: "vector-00000001", method: "POST", kind: "request" },
      new TextEncoder().encode("{\"path\":\"/state\"}"),
      {
        header: decodeBase64URL("oKGio6Slpqeoqaqr"),
        body: decodeBase64URL("sLGys7S1tre4ubq7"),
      },
    );
    expect(encodeRelayFrame(frame)).toBe(
      "{\"bodyCiphertext\":\"oaYwB6ppag25-if4bxIpkrqL88iNgRlvwZs0-vfp6OrF\",\"bodyNonce\":\"sLGys7S1tre4ubq7\",\"headerCiphertext\":\"wlqsTUh-8xW_dhomEex9JX-kCocgjMpuk-TiHLSrelas-piXleO6XZc6ujzHrxifojmXn9RPQYFop-IO3Z0-ODVgOAwLtmm1G2FJmtYfNNxm_4moJ8zS_5OXeNjVWcMQQ9bGdAE--QrW9YkBcLf6x3AB-hTXoRBORdQDQO0\",\"headerNonce\":\"oKGio6Slpqeoqaqr\",\"version\":1}",
    );
  });
});
