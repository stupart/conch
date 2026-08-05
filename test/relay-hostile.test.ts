/// Written as an INDEPENDENT probe of Codex's relay crypto, kept because it
/// asks the only question that matters: what can the middle actually do?
/// The BASELINE test is load-bearing — without it every rejection below
/// could pass for the wrong reason. The first draft of this file did
/// exactly that: a malformed header made every open() throw, and three
/// "attacks were blocked" results were worth nothing.
import { expect, test } from "bun:test";
import {
  RelaySessionCipher, deriveRelaySessionKeys, mintRelaySecret, mintRelayRoomId, relayChallenge,
} from "../src/relay-protocol.ts";

const keys = () =>
  deriveRelaySessionKeys(mintRelaySecret(), mintRelayRoomId(), relayChallenge(), relayChallenge());
const hdr = (id: string, method: string) => ({ id, method, kind: "request" }) as any;
const bytes = (s: string) => new TextEncoder().encode(s);

test("BASELINE: an untampered frame opens (so rejections below mean something)", async () => {
  const k = await keys();
  const frame = await RelaySessionCipher.phone(k).seal(hdr("req-00001", "GET"), bytes("hello"));
  const opened = await RelaySessionCipher.mac(k).open(frame);
  expect(new TextDecoder().decode(opened.body)).toBe("hello");
  expect(opened.header.method).toBe("GET");
});

test("HOSTILE RELAY: cannot splice a header onto another frame's body", async () => {
  const k = await keys();
  const phone = RelaySessionCipher.phone(k);
  const a = await phone.seal(hdr("req-00001", "GET"), bytes("read only"));
  const b = await phone.seal(hdr("req-00002", "POST"), bytes("mutating"));
  const spliced = { ...a, headerCiphertext: b.headerCiphertext, headerNonce: b.headerNonce };
  await expect(RelaySessionCipher.mac(k).open(spliced as any)).rejects.toThrow();
});

test("HOSTILE RELAY: cannot replay a delivered frame", async () => {
  const k = await keys();
  const frame = await RelaySessionCipher.phone(k).seal(hdr("req-00001", "POST"), bytes("inject"));
  const mac = RelaySessionCipher.mac(k);
  expect(new TextDecoder().decode((await mac.open(frame)).body)).toBe("inject");
  await expect(mac.open(frame)).rejects.toThrow();
});

test("HOSTILE RELAY: cannot flip a single ciphertext bit undetected", async () => {
  const k = await keys();
  const frame = await RelaySessionCipher.phone(k).seal(hdr("req-00001", "POST"), bytes("inject"));
  const flipped = { ...frame, bodyCiphertext: frame.bodyCiphertext.slice(0, -1)
    + (frame.bodyCiphertext.slice(-1) === "A" ? "B" : "A") };
  await expect(RelaySessionCipher.mac(k).open(flipped as any)).rejects.toThrow();
});

test("HOSTILE RELAY: sees no plaintext on the wire", async () => {
  const k = await keys();
  const secret = "delete the production database";
  const frame = await RelaySessionCipher.phone(k).seal(hdr("req-00001", "POST"), bytes(secret));
  const wire = JSON.stringify(frame);
  expect(wire).not.toContain(secret);
  expect(wire).not.toContain("POST");
});

test("HOSTILE RELAY: a different secret opens nothing", async () => {
  const frame = await RelaySessionCipher.phone(await keys()).seal(hdr("req-00001", "GET"), bytes("x"));
  await expect(RelaySessionCipher.mac(await keys()).open(frame)).rejects.toThrow();
});
