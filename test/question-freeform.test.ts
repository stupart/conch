import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mac = readFileSync(
  join(import.meta.dir, "../mac-app/conch-mac/ConversationStackView.swift"), "utf8");
const phone = readFileSync(
  join(import.meta.dir, "../mobile/conch-ios/conch-ios/ConversationStack.swift"), "utf8");

test("a question offers a way out of its own options, on both apps", () => {
  // Claude Code's question UI always offers an "Other" row; conch showed only
  // the options the tool listed, so the way out was knowing the composer
  // already worked. Tyler: "it was missing the 4th option where i coudl just
  // write something and also the like ignore and just chat about it option".
  for (const source of [mac, phone]) {
    expect(source).toContain("Something else…");
    expect(source).toContain("onFreeform");
    // Points at the composer rather than growing a second text field inside
    // the question — which is what Tyler guessed himself: "maybe i could have
    // just used the nromal input bar for that?"
    expect(source).toContain("square.and.pencil");
  }
});

test("it only appears while the question can still be answered", () => {
  // A completed tool is not a valid destination; offering an escape hatch on a
  // dead question invites answering an old prompt.
  const macRow = mac.slice(mac.indexOf("private func questionRow"));
  expect(macRow.indexOf("if answerable {")).toBeLessThan(macRow.indexOf("Something else…"));
  const phoneRow = phone.slice(phone.indexOf("asked.options.enumerated"));
  expect(phoneRow.indexOf("if isActive {")).toBeLessThan(phoneRow.indexOf("Something else…"));
});

test("both apps route it to their own composer's focus", () => {
  const dash = readFileSync(
    join(import.meta.dir, "../mac-app/conch-mac/DashboardView.swift"), "utf8");
  expect(dash).toContain("onFreeform: { composerFocusRequest += 1 }");
  expect(dash).toContain("focusRequest: composerFocusRequest");
  const session = readFileSync(
    join(import.meta.dir, "../mobile/conch-ios/conch-ios/SessionView.swift"), "utf8");
  expect(session).toContain("onFreeform: { typing = true }");
});
