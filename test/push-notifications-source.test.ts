import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Push notices' secrets, held by the apps' source since that wiring can't run in a test (the shared logic is
// ConchDesign's PushNoticesTests): the phone's Apple device token is never logged, and the APNs key typed into the Mac's
// Settings is sent once and never kept or logged.

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const between = (text: string, start: string, end: string) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThan(-1);
  expect(to, end).toBeGreaterThan(from);
  return text.slice(from, to);
};

test("the phone never prints or logs its push token", () => {
  expect(read("mobile/conch-ios/conch-ios/PushNotifications.swift")).not.toMatch(/print\(|NSLog\(|os_log|Logger\(/);
});

test("the Mac's APNs key is cleared from the field once sent, and never stored or logged", () => {
  const settings = read("mac-app/conch-mac/PushSettingsView.swift");
  expect(between(settings, "private func save() {", "private func close() {")).toMatch(/let given = key\s*key = ""/);
  expect(settings).toContain('.onDisappear { key = "" }');
  expect(settings).not.toMatch(/UserDefaults\.|@AppStorage|print\(|NSLog\(/);
});
