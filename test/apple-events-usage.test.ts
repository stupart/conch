import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const plist = readFileSync(join(import.meta.dir, "..", "mac-app", "conch-mac", "Info.plist"), "utf8");

/**
 * The daemon types into Terminal and raises its windows with AppleScript,
 * and macOS attributes those Apple Events to conch.app as the responsible
 * process. The Automation prompt shows the app's NSAppleEventsUsageDescription;
 * without one the request can be refused with no prompt at all (A17's audit,
 * 2026-09-11). The string must exist and say why.
 */
test("the app explains its Apple Events to the Automation prompt", () => {
  const at = plist.indexOf("<key>NSAppleEventsUsageDescription</key>");
  expect(at).toBeGreaterThan(-1);
  const value = plist.slice(at).match(/<string>([^<]+)<\/string>/)?.[1] ?? "";
  expect(value).toContain("Terminal");
  expect(value.length).toBeGreaterThan(40);
});
