import { describe, expect, test } from "bun:test";
import {
  isMacAppPing,
  isReviewSurfaces,
  MacAppPresence,
  MAC_APP_SEEN_MS,
  phoneSurface,
} from "../src/surfaces.ts";

/**
 * Where a publication can be seen, as the daemon knows it: agents told the user "it's on your screen" about results
 * filed while the Mac app was shut and no phone was connected (2026-10-03). Each state is something observed.
 */

describe("the Mac app, by what the daemon last heard from it", () => {
  test("not running until it is heard from, running while its pings keep coming, and not running once they stop", () => {
    const presence = new MacAppPresence();
    expect(presence.surface(1_000, undefined)).toBe("not-running");
    presence.seen(10_000);
    expect(presence.lastSeen()).toBe(10_000);
    expect(presence.surface(10_000, undefined)).toBe("running");
    expect(presence.surface(10_000 + MAC_APP_SEEN_MS, "app")).toBe("running");
    expect(presence.surface(10_000 + MAC_APP_SEEN_MS + 1, "app")).toBe("not-running");
  });

  test("showing only while it runs and conch's own window was the last thing seen in front", () => {
    const presence = new MacAppPresence();
    expect(presence.surface(0, "conch")).toBe("not-running");
    presence.seen(1_000);
    expect(presence.surface(2_000, "conch")).toBe("showing");
    for (const elsewhere of ["file", "url", "terminal", "app", "unknown", undefined]) {
      expect(presence.surface(2_000, elsewhere)).toBe("running");
    }
    // A stale report of conch's window from an app that has since gone quiet says nothing about now.
    expect(presence.surface(1_000 + MAC_APP_SEEN_MS + 1, "conch")).toBe("not-running");
  });

  test("a ping is the app's when it says so, or says nothing as every app before 2026-10-03 did, and no one else's", () => {
    expect(isMacAppPing({ kind: "ping", from: "mac-app" })).toBe(true);
    expect(isMacAppPing({ kind: "ping" })).toBe(true);
    expect(isMacAppPing({ kind: "ping", from: "probe" })).toBe(false);
    expect(isMacAppPing({ kind: "ping", from: 1 })).toBe(false);
    expect(isMacAppPing({ kind: "pong" })).toBe(false);
  });
});

describe("the phone, by the setting, the bridge's live clients and whether one ever paired", () => {
  test("off, unpaired, paired but not connected, and connected", () => {
    expect(phoneSurface({ enabled: false, clients: 3, paired: true })).toBe("off");
    expect(phoneSurface({ enabled: true, clients: 0, paired: false })).toBe("unpaired");
    expect(phoneSurface({ enabled: true, clients: 0, paired: true })).toBe("paired-not-connected");
    expect(phoneSurface({ enabled: true, clients: 1, paired: true })).toBe("connected");
    // A client is a client, paired file or not (a relay phone mid-handshake is counted by the bridge, not the file).
    expect(phoneSurface({ enabled: true, clients: 1, paired: false })).toBe("connected");
  });
});

describe("surfaces off the socket", () => {
  test("are only believed in the states this conch knows", () => {
    expect(isReviewSurfaces({ mac: "showing", phone: "connected", audio: "phone" })).toBe(true);
    expect(isReviewSurfaces({ mac: "running", phone: "off", audio: "other-mac" })).toBe(true);
    expect(isReviewSurfaces({ mac: "not-running", phone: "unpaired", audio: "manual" })).toBe(true);
    expect(isReviewSurfaces({ mac: "on", phone: "off", audio: "mac" })).toBe(false);
    expect(isReviewSurfaces({ mac: "running", phone: "off" })).toBe(false);
    expect(isReviewSurfaces(["running"])).toBe(false);
  });
});
