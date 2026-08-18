import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const relay = readFileSync(
  join(import.meta.dir, "../mobile/conch-ios/conch-ios/RelayTransport.swift"),
  "utf8",
);

test("an idle connection is not mistaken for a stalled one", () => {
  // `lastStateProgressAt` is stamped when a snapshot COMPLETES, so reading it
  // as evidence of a stall meant a healthy idle connection killed itself 30s
  // after its last update — and the Mac deliberately does not resend unchanged
  // state, so idle is exactly when that happened. Tyler saw it as "mobile app
  // cant connect right now".
  const check = relay.indexOf("if stateStatus != nil,");
  expect(check).toBeGreaterThan(-1);
  const guarded = relay.slice(check, check + 220);
  expect(guarded).toContain("lastStateProgressAt.duration(to: .now) > Self.stateProgressTimeout");
  expect(guarded).toContain("connectionFailed(URLError(.timedOut)");
});

test("waiting for the FIRST state still times out", () => {
  // The other two timeouts are the ones that catch a genuinely dead socket:
  // a subscription that never produced anything, and a snapshot that stopped
  // partway. Gating the idle case must not disarm them.
  expect(relay).toContain("stateSubscriptionStartedAt.duration(to: .now) > Self.stateProgressTimeout");
  expect(relay).toContain("lastStateProgressAt == nil");
});
