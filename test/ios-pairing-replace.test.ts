import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "mobile", "conch-ios", "conch-ios");
const bridge = readFileSync(join(root, "BridgeClient.swift"), "utf8");
const pairing = readFileSync(join(root, "PairingView.swift"), "utf8");

// Path 3, step 3 of docs/install-journeys.md: the phone keeps ONE pairing and
// `PairingStore.save` overwrites it in silence. The pairing screen must say so
// before letting a different Mac in, and must not nag when it is the same Mac.
describe("iPhone pairing asks before replacing a different Mac", () => {
  test("the confirmation gates the save", () => {
    // Presence first: the markers the ordering checks below slice on.
    expect(pairing).toContain("private func commit(_ candidate: BridgeClient.Pairing)");
    expect(pairing).toContain("private func connect()");
    expect(pairing).toContain("private func field(");
    expect(pairing).toContain("PairingStore.load()");
    expect(pairing).toContain('Button("Replace", role: .destructive)');
    expect(pairing).toContain('Button("Keep current", role: .cancel)');
    // Names what it is replacing, shortened the way the connection popover
    // already shortens it (`Relay · host`, or the LAN host).
    expect(pairing).toContain("pending.current.displayHost");
    expect(pairing).toContain("replacement?.current.displayHost");
    expect(bridge).toContain("var displayHost: String");

    // Every route out of connect() goes through commit(); none of them may
    // hand the pairing to onPaired directly, because that is the save.
    const connect = pairing.slice(
      pairing.indexOf("private func connect()"),
      pairing.indexOf("private func field("),
    );
    expect(connect).toContain("commit(.relay(relay))");
    expect(connect).toContain("commit(.lan(host: trimmedHost, token: token))");
    expect(connect).toContain("commit(candidate)");
    expect(connect).not.toContain("onPaired(");

    // Inside commit: a stored pairing for a different Mac is HELD, and the
    // save happens only in the else branch or from the Replace button.
    const commit = pairing.slice(
      pairing.indexOf("private func commit("),
      pairing.indexOf("private func connect()"),
    );
    expect(commit).toMatch(
      /if let current = PairingStore\.load\(\), current\.identity != candidate\.identity \{\s*replacement = \(current, candidate\)\s*\} else \{\s*onPaired\(candidate\)/,
    );
    expect(pairing).toMatch(
      /confirmationDialog\([\s\S]*presenting: replacement[\s\S]*Button\("Replace", role: \.destructive\) \{ onPaired\(pending\.candidate\) \}/,
    );
  });

  test("the same Mac with a fresh code skips the prompt", () => {
    // Identity is the Mac, not the credential: `conch pair` rotates the LAN
    // token and a re-scanned QR carries the same endpoint and room.
    expect(bridge).toContain("var identity: String");
    const identity = bridge.slice(
      bridge.indexOf("var identity: String"),
      bridge.indexOf("init(pairing: Pairing)"),
    );
    expect(identity).toContain('case let .lan(host, _): "lan \\(host)"');
    expect(identity).toContain(
      'case let .relay(payload): "relay \\(payload.endpoint) \\(payload.roomId)"',
    );
    expect(identity).not.toContain("token");
    expect(identity).not.toContain("secret");
    // And commit compares identity, not the whole Equatable pairing.
    expect(pairing).toContain("current.identity != candidate.identity");
    expect(pairing).not.toContain("current != candidate");

    // The store says out loud that it keeps one, and who asks first.
    expect(bridge).toContain("One pairing per phone: this replaces whatever is stored.");
  });
});
