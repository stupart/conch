import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The iOS app has no test target, so these read its source: they are the only guard of the
// phone's half of the relay's replay protection and of where its secrets are kept.
const root = join(import.meta.dir, "..", "mobile", "conch-ios", "conch-ios");
const bridge = readFileSync(join(root, "BridgeClient.swift"), "utf8");
const relay = readFileSync(join(root, "RelayTransport.swift"), "utf8");
const protocol = readFileSync(join(root, "RelayProtocol.swift"), "utf8");

describe("iOS relay transport guarantees", () => {
  test("hostile replay, reordering, and stale state are rejected", () => {
    expect(protocol).toContain("let accepted = replay.accept(header.sequence)");
    expect(relay).toContain("opened.header.sequence <= previous");
    expect(relay).toContain("opened.header.sequence <= newestStateSequence");
    expect(relay).toContain("seenPeerChallenges.contains(challenge)");
    expect(relay).toContain("Data(stateHash.finalize()) == expected");
  });

  test("relay secrets remain in Keychain", () => {
    expect(bridge).toContain("kSecClassGenericPassword");
    expect(bridge).not.toContain("UserDefaults.standard");
  });
});
