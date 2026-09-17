import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const talk = read("mobile/conch-ios/conch-ios/TalkController.swift");
const session = read("mobile/conch-ios/conch-ios/SessionView.swift");

/**
 * Typing shows the send button. Pressing the microphone is not a prerequisite.
 *
 * Tyler, from the phone: "where did the send button on the mobile app go? Lol I have to press
 * the audio button for it to show."
 *
 * The composer builds send only `if canSend || isSending`, and `canSend` calls
 * `hasWords(for:)`, which reads `committed` for the mic's current target and `parked` for every
 * other session. `committed` was `@Published`; `parked` was a plain dictionary. So on a session
 * that had never held the mic, a keystroke mutated `parked` and SwiftUI was never told —
 * `canSend` stayed stale and the button was never built.
 *
 * Tapping the mic ran `switchTarget`, assigning the published `targetSessionId` and copying
 * those same words into the published `committed`. That is why the *audio* button specifically
 * made it appear.
 */
test("every store the composer reads publishes its changes", () => {
  expect(talk).toContain("@Published private var parked: [String: String] = [:]");
  expect(talk).toContain("@Published private(set) var committed");
  expect(talk).toContain("@Published private(set) var targetSessionId: String?");
  // The plain form is what shipped the bug.
  expect(talk).not.toContain("    private var parked: [String: String] = [:]");
});

/** `canSend` reads both halves, so both have to be observable for it to be true in time. */
test("canSend reads the published drafts", () => {
  expect(session).toContain("!attachments.isEmpty || talk.hasWords(for: sessionId)");
  const hasWords = talk.slice(talk.indexOf("func hasWords(for session: String) -> Bool"));
  const body = hasWords.slice(0, hasWords.indexOf("\n    }"));
  expect(body).toContain("draft(for: session)");
  const draft = talk.slice(talk.indexOf("func draft(for session: String) -> String"));
  expect(draft.slice(0, draft.indexOf("\n    }"))).toContain("parked[session]");
});

/**
 * Publishing is only worth anything if the view observes the object. It does — and the reply
 * bar, which reads the same store, observes it too.
 */
test("the composer observes the controller", () => {
  expect(session).toContain("@ObservedObject var talk: TalkController");
  const bar = session.slice(session.indexOf("struct ReviewReplyBar: View {"));
  expect(bar.slice(0, bar.indexOf("var body"))).toContain("@ObservedObject var talk: TalkController");
});

/**
 * One write per keystroke. `committed` persists through its own `didSet`; the parked path
 * persists explicitly inside `setDraft`. A `didSet` on `parked` as well would write
 * UserDefaults twice for every character typed.
 */
test("the drafts are persisted once, not twice", () => {
  expect(talk.match(/didSet \{ persistDrafts\(\) \}/g) ?? []).toHaveLength(1);
  const setDraft = talk.slice(talk.indexOf("func setDraft(_ text: String, for session: String)"));
  expect(setDraft.slice(0, setDraft.indexOf("\n    }"))).toContain("persistDrafts()");
});

/**
 * The stop button shares send's slot and keeps its own rules: mid-turn, nothing written, and a
 * row that actually has a terminal. Both were stale together; neither should change shape now.
 */
test("stop keeps its slot rules while send keeps its own", () => {
  expect(session).toContain("if isWorking, !canSend, !isSending, row?.noTerminal == nil {");
  expect(session).toContain("if canSend || isSending {");
  const send = session.indexOf("Button(action: sendDraft) {");
  const label = session.indexOf('.accessibilityLabel("Send")', send);
  expect(label).toBeGreaterThan(send);
  expect(session.slice(send, label)).toContain(".disabled(isSending || row?.noTerminal != nil)");
});
