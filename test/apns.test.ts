import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import {
  APNS_ORIGINS,
  ApnsTokenCache,
  apnsJwt,
  apnsPayload,
  apnsVerdict,
  NOTICE_LINK_CATEGORY,
  parseApnsKey,
  sendApns,
  type ApnsCredentials,
} from "../src/apns.ts";
import { mockApns } from "./apns-mock.ts";

// APNs from the Mac daemon (2026-11-10): the provider token, the request Apple is sent, and what each answer means,
// against a throwaway P-256 key made here and a local HTTP/2 server standing in for Apple. Nothing reaches Apple.

function throwawayKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { privateKey, publicKey, pem };
}

const fromBase64url = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("the .p8 key", () => {
  test("its PEM, its base64 alone, or either wrapped and indented, parses to the same one-line body", () => {
    const { pem } = throwawayKey();
    const parsed = parseApnsKey(pem);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.body).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(parsed.key.asymmetricKeyType).toBe("ec");
    const bare = parseApnsKey(parsed.body);
    expect("body" in bare && bare.body).toBe(parsed.body);
    const indented = parseApnsKey(pem.split("\n").map((line) => `   ${line}\r`).join("\n"));
    expect("body" in indented && indented.body).toBe(parsed.body);
  });

  test("anything but a P-256 private key is refused, in words that never repeat it", () => {
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const publicOnly = throwawayKey().publicKey.export({ format: "pem", type: "spki" }).toString();
    for (const bad of [p384, rsa, publicOnly, "", "hello", "x".repeat(5_000), 42, null, "-----BEGIN PRIVATE KEY-----\nnot base64 at all!\n-----END PRIVATE KEY-----"]) {
      const result = parseApnsKey(bad);
      expect("error" in result, String(bad).slice(0, 40)).toBe(true);
      if ("error" in result && typeof bad === "string" && bad.length > 20) {
        expect(result.error).not.toContain(bad.slice(30, 60));
      }
    }
  });
});

describe("the provider token", () => {
  test("ES256: header {alg, kid}, claims {iss, iat}, a 64-byte r‖s signature the key's public half verifies", () => {
    const { privateKey, publicKey } = throwawayKey();
    const credentials: ApnsCredentials = { teamId: "TEAM123456", keyId: "KEY1234567", key: privateKey };
    const token = apnsJwt(credentials, 1_800_000_000.9);
    const [header, claims, signature] = token.split(".");
    expect(fromBase64url(header!)).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(fromBase64url(claims!)).toEqual({ iss: "TEAM123456", iat: 1_800_000_000 });
    const raw = Buffer.from(signature!, "base64url");
    expect(raw.byteLength).toBe(64);
    expect(verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, raw)).toBe(true);
  });

  test("reused for 50 minutes, made again after, or when the key changes, or when it's forgotten", () => {
    const { privateKey } = throwawayKey();
    const credentials: ApnsCredentials = { teamId: "TEAM123456", keyId: "KEY1234567", key: privateKey };
    const cache = new ApnsTokenCache();
    const first = cache.token(credentials, 1_000_000);
    expect(cache.token(credentials, 1_000_000 + 49 * 60_000)).toBe(first);
    const later = cache.token(credentials, 1_000_000 + 50 * 60_000);
    expect(later).not.toBe(first);
    const other = cache.token({ ...credentials, keyId: "KEY7654321" }, 1_000_000 + 50 * 60_000 + 1);
    expect(fromBase64url(other.split(".")[0]!).kid).toBe("KEY7654321");
    cache.forget();
    expect(cache.token({ ...credentials, keyId: "KEY7654321" }, 1_000_000 + 50 * 60_000 + 2)).not.toBe(other);
  });
});

describe("the payload", () => {
  test("an alert with sound; the session, the notice and a link under conch, and the link's category", () => {
    expect(apnsPayload({ id: "n1", title: "Deploy", body: "It's live.", sessionId: "s1", link: "https://example.com/pr/1" })).toEqual({
      aps: { alert: { title: "Deploy", body: "It's live." }, sound: "default", "thread-id": "session:s1", category: NOTICE_LINK_CATEGORY },
      conch: { notice: "n1", session: "s1", link: "https://example.com/pr/1" },
    });
    expect(apnsPayload({ id: "n2", title: "conch", body: "A test.", target: "providers" })).toEqual({
      aps: { alert: { title: "conch", body: "A test." }, sound: "default", "thread-id": "conch" },
      conch: { notice: "n2", target: "providers" },
    });
  });
});

describe("what Apple's answers mean", () => {
  test("sent, gone, the key, later, refused", () => {
    expect(apnsVerdict({ status: 200 })).toBe("sent");
    expect(apnsVerdict({ status: 410, reason: "Unregistered" })).toBe("gone");
    expect(apnsVerdict({ status: 400, reason: "BadDeviceToken" })).toBe("gone");
    expect(apnsVerdict({ status: 403, reason: "InvalidProviderToken" })).toBe("key");
    expect(apnsVerdict({ status: 403, reason: "ExpiredProviderToken" })).toBe("key");
    expect(apnsVerdict({ status: 403, reason: "TooManyProviderTokenUpdates" })).toBe("later");
    expect(apnsVerdict({ status: 429, reason: "TooManyRequests" })).toBe("later");
    expect(apnsVerdict({ status: 503, reason: "ServiceUnavailable" })).toBe("later");
    expect(apnsVerdict({ status: 400, reason: "DeviceTokenNotForTopic" })).toBe("refused");
    expect(apnsVerdict({ status: 413, reason: "PayloadTooLarge" })).toBe("refused");
  });

  test("Apple's own hosts", () => {
    expect(APNS_ORIGINS).toEqual({ production: "https://api.push.apple.com", development: "https://api.sandbox.push.apple.com" });
  });
});

describe("one POST to Apple", () => {
  const servers: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  const TOKEN = "ab".repeat(32);

  test("the path, the headers APNs reads, and the payload as the body", async () => {
    const apple = await mockApns(() => ({ status: 200 }));
    servers.push(apple);
    const payload = apnsPayload({ id: "n1", title: "Deploy", body: "It's live.", sessionId: "s1" });
    const response = await sendApns({ origin: apple.origin, deviceToken: TOKEN, topic: "com.example.conch", jwt: "a.b.c", payload, expiration: 1_800_000_000 });
    expect(response).toEqual({ status: 200, apnsId: "11111111-2222-3333-4444-555555555555" });
    expect(apple.seen).toHaveLength(1);
    const { headers, body } = apple.seen[0]!;
    expect(headers[":method"]).toBe("POST");
    expect(headers[":path"]).toBe(`/3/device/${TOKEN}`);
    expect(headers.authorization).toBe("bearer a.b.c");
    expect(headers["apns-topic"]).toBe("com.example.conch");
    expect(headers["apns-push-type"]).toBe("alert");
    expect(headers["apns-priority"]).toBe("10");
    expect(headers["apns-expiration"]).toBe("1800000000");
    expect(String(headers["apns-id"])).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(body)).toEqual(payload);
  });

  test("a refusal comes back with Apple's reason, and nothing else from the body", async () => {
    const apple = await mockApns((headers) => headers[":path"]!.endsWith("gone")
      ? { status: 410, body: { reason: "Unregistered", timestamp: 1 } }
      : { status: 400, body: { reason: "BadDeviceToken; rm -rf /" } });
    servers.push(apple);
    const base = { origin: apple.origin, topic: "com.example.conch", jwt: "a.b.c", payload: {}, expiration: 0 };
    expect(await sendApns({ ...base, deviceToken: "gone" })).toMatchObject({ status: 410, reason: "Unregistered" });
    const odd = await sendApns({ ...base, deviceToken: "odd" });
    expect(odd.status).toBe(400);
    expect(odd.reason).toBeUndefined();
  });

  test("no answer in time, nobody listening, or a payload over 4 KB: it rejects", async () => {
    const apple = await mockApns(() => ({ status: 200, delayMs: 2_000 }));
    servers.push(apple);
    const base = { deviceToken: TOKEN, topic: "com.example.conch", jwt: "a.b.c", payload: {}, expiration: 0 };
    await expect(sendApns({ ...base, origin: apple.origin, timeoutMs: 100 })).rejects.toThrow("didn't answer in time");
    await expect(sendApns({ ...base, origin: "http://127.0.0.1:9", timeoutMs: 2_000 })).rejects.toThrow();
    await expect(sendApns({ ...base, origin: apple.origin, payload: { big: "x".repeat(5_000) } })).rejects.toThrow("larger than APNs takes");
  });
});
