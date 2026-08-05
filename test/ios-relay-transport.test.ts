import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "mobile", "conch-ios", "conch-ios");
const bridge = readFileSync(join(root, "BridgeClient.swift"), "utf8");
const relay = readFileSync(join(root, "RelayTransport.swift"), "utf8");
const protocol = readFileSync(join(root, "RelayProtocol.swift"), "utf8");
const pairing = readFileSync(join(root, "PairingView.swift"), "utf8");
const deliverable = readFileSync(join(root, "DeliverableSheet.swift"), "utf8");

describe("iOS relay transport guarantees", () => {
  test("a stored pairing selects one transport with no fallback ladder", () => {
    expect(bridge).toContain("case lan(host: String, token: String)");
    expect(bridge).toContain("case relay(RelayPairingPayload)");
    expect(bridge).toContain("transport = DirectHTTPTransport(host: host, token: token)");
    expect(bridge).toContain("transport = RelayTransport(pairing: payload)");
    expect(bridge).not.toContain("fallback");
    expect(bridge).toContain("return .lan(host: account, token: token)");
  });

  test("request IDs and continuations survive reconnect but fail once on replacement", () => {
    expect(relay).toContain("let id: String");
    expect(relay).toContain("request.sentSessionGeneration != session");
    expect(relay).toContain("session == sessionGeneration");
    expect(relay).toContain("try request.resetForRetry()");
    expect(relay).toContain("request.lastProgressAt.duration(to: .now) > Self.requestProgressTimeout");
    expect(relay).toContain("request.continuation.resume(throwing: BridgeTransportError.replaced)");
    expect(relay).toContain("reconnectDelay = min(30, reconnectDelay * 2)");
    expect(relay).toContain("Double.random(in: 0.8...1.2)");
  });

  test("hostile replay, reordering, and stale state are rejected", () => {
    expect(protocol).toContain("case replayedFrame");
    expect(protocol).toContain("RelayCanonical.bodyAAD(header: header)");
    expect(protocol).toContain("let accepted = replay.accept(header.sequence)");
    expect(relay).toContain("opened.header.sequence <= previous");
    expect(relay).toContain("opened.header.sequence <= newestStateSequence");
    expect(relay).toContain("seenPeerChallenges.contains(challenge)");
  });

  test("large files are streamed to disk in bounded authenticated chunks", () => {
    expect(relay).toContain("case file(temporary: URL, final: URL, handle: FileHandle)");
    expect(relay).toContain("chunk.count <= 64 * 1024");
    expect(relay).toContain("try handle.write(contentsOf: chunk)");
    expect(relay).toContain("actual == expected");
    expect(relay).toContain("kind: .chunkAck");
    expect(relay).toContain("kind: .cancel");
    expect(relay).toContain("withTaskCancellationHandler");
    expect(relay).toContain("await self.cancelRequest(id)");
    expect(deliverable).toContain("await bridge.downloadFile(path: link)");
    expect(bridge).not.toContain("fileURL(for path:");
  });

  test("state is a bounded authenticated stream, not one oversized websocket frame", () => {
    expect(relay).toContain("maximumStateBytes = 2 * 1024 * 1024");
    expect(relay).toContain("consumeStateResponse(opened)");
    expect(relay).toContain("stateHash.update(data: opened.body)");
    expect(relay).toContain("Data(stateHash.finalize()) == expected");
    expect(relay).toContain("lastStateProgressAt.duration(to: .now) > Self.stateProgressTimeout");
  });

  test("relay secrets enter through an in-app QR scanner and remain in Keychain", () => {
    expect(pairing).toContain("RelayQRScanner");
    expect(pairing).toContain("RelayPairingPayload.decodePairingCode");
    expect(bridge).toContain("kSecClassGenericPassword");
    expect(bridge).not.toContain("UserDefaults.standard");
  });
});
