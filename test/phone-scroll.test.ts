import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const session = readFileSync(
  join(import.meta.dir, "../mobile/conch-ios/conch-ios/SessionView.swift"), "utf8");

test("opening a session lands at the end of the conversation", () => {
  // The bug Tyler reported: "when I open it up I often have to scroll back
  // down to the bottom again". A ScrollViewReader was already there and its
  // proxy was never used ONCE — `scroller` appeared only at its own
  // declaration — so a session opened at the top of its history.
  expect(session).toContain("ScrollViewReader { scroller in");
  expect(session).toContain("scrollToBottom(scroller, animated: false)");
  expect(session).toContain('.id(Self.bottomAnchor)');

  // The proxy has to be USED, not merely declared. Counting is the point:
  // one occurrence means it is decorative again.
  const uses = session.split("scroller").length - 1;
  expect(uses).toBeGreaterThan(1);
});

test("a new reply does not yank you out of history", () => {
  // The rule the Mac settled on: follow growth only while already at the end.
  // The anchor's own visibility is how iOS answers what NSScrollView answers
  // on the Mac.
  expect(session).toContain(".onAppear { pinnedToBottom = true }");
  expect(session).toContain(".onDisappear { pinnedToBottom = false }");
  const onGrowth = session.slice(session.indexOf(".onChange(of: conversationRevision)"));
  expect(onGrowth.slice(0, 400)).toContain("guard pinnedToBottom else { return }");
});

test("switching sessions re-arms the follow", () => {
  // A different session is a different conversation: start at its end.
  const onSwitch = session.slice(session.indexOf(".onChange(of: sessionId)"));
  expect(onSwitch.slice(0, 300)).toContain("pinnedToBottom = true");
  expect(onSwitch.slice(0, 300)).toContain("scrollToBottom(scroller, animated: false)");
});
