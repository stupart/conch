import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Messages between agent sessions (2026-11-12), pinned in both apps' source: drawn as `PeerMessageRow` from the live
// conversation and from the record store, never as Tyler's bubble, never folded away, and opening the other session.
// Line comments are stripped, so a comment can't satisfy an assertion.
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  expect(a, `missing: ${start}`).toBeGreaterThan(-1);
  const b = text.indexOf(end, a + start.length);
  expect(b, `missing: ${end}`).toBeGreaterThan(a);
  return text.slice(a, b);
}

const mac = {
  models: source("mac-app/conch-mac/Models.swift"),
  stack: source("mac-app/conch-mac/ConversationStackView.swift"),
  dashboard: source("mac-app/conch-mac/DashboardView.swift"),
  history: source("mac-app/conch-mac/HistoryStore.swift"),
};
const phone = {
  models: source("mobile/conch-ios/conch-ios/Models.swift"),
  stack: source("mobile/conch-ios/conch-ios/ConversationStack.swift"),
  session: source("mobile/conch-ios/conch-ios/SessionView.swift"),
  history: source("mobile/conch-ios/conch-ios/HistoryStore.swift"),
};
const row = source("design/ConchDesign/Sources/ConchDesign/PeerMessage.swift");

describe("both apps read the daemon's peer field", () => {
  test("decoded on the item, tolerant of an older daemon", () => {
    for (const models of [mac.models, phone.models]) {
      expect(models).toContain("peer = try? c.decodeIfPresent(ConchPeerMessage.self, forKey: .peer)");
      expect(models).toMatch(/case id, rev, kind, text, at, tool, plan, change, question, questions, material, receipt, peer\n/);
    }
  });
});

describe("a peer row is drawn as one, on both sides of a message", () => {
  test("Mac: a received one in place of the material row, a sent one in place of the tool row", () => {
    const material = between(mac.stack, "        case .material:\n", "        case .tool:\n");
    expect(material).toContain("if let peer = item.peer {\n                peerRow(item, peer)");
    const tool = between(mac.stack, "        case .tool:\n", "            } else if let asked = item.question");
    expect(tool).toContain("if let peer = item.peer {\n                peerRow(item, peer)");
    const peer = between(mac.stack, "private func peerRow(", "\n    }\n");
    expect(peer).toContain("PeerMessageRow(");
    expect(peer).toContain("open: live == nil ? nil : { peer.session.map(onOpenSession) }");
  });

  test("iPhone: the same", () => {
    const material = between(phone.stack, "        case \"material\":\n", "        default:");
    expect(material).toContain("if let peer = item.peer {\n                peerRow(item, peer)");
    const tool = between(phone.stack, "        case \"tool\":\n", "            else if let asked = item.question");
    expect(tool).toContain("if let peer = item.peer {\n                peerRow(item, peer)");
    expect(between(phone.stack, "private func peerRow(", "\n    }\n")).toContain("PeerMessageRow(");
  });

  test("never folded into a run of steps, and it settles a question as Tyler's words do", () => {
    for (const stack of [mac.stack, phone.stack]) {
      expect(between(stack, "private func foldable(", "\n    }\n")).toContain("if item.peer != nil { return false }");
      expect(stack).toContain("$0.peer?.direction == .received && $0.peer?.queued == false");
    }
  });

  test("the row is outlined on the conversation's ground, never filled as Tyler's bubble", () => {
    const view = between(row, "public struct PeerMessageRow: View {", "private var heading: some View {");
    expect(view).not.toContain(".background(");
    expect(view).toContain(".strokeBorder(ConchColor.hairlineStrong");
    expect(view).not.toContain("Spacer(minLength");
  });
});

describe("a click opens the other session", () => {
  test("Mac: the session's row, in this same pane", () => {
    const wiring = between(mac.dashboard, "onOpenSession: { id in", "sessionLabel:");
    expect(wiring).toContain("if let target = state?.rows.first(where: { $0.id == id }) ?? subagentRow(id: id) {");
    expect(wiring).toContain("onSelectSession(target)");
    expect(mac.dashboard).toContain("sessionLabel: { id in state?.rows.first(where: { $0.id == id })?.label },");
  });

  test("iPhone: pushed over the session it was opened from", () => {
    expect(phone.session).toContain("onOpenSession: { peerSession = $0 },");
    expect(phone.session).toContain("sessionLabel: { id in bridge.state?.rows.first { $0.id == id }?.label },");
    expect(phone.session).toContain(".navigationDestination(item: $peerSession) { id in\n            SessionView(bridge: bridge, speech: speech, talk: talk, sessionId: id)");
  });
});

describe("a recorded one is the same row as a live one", () => {
  test("both apps read an inter_agent record's tag back into a peer row, and leave any other as it was", () => {
    for (const history of [mac.history, phone.history]) {
      expect(history).toContain("if recorded.kind == \"inter_agent\", let read = ConchPeerMessage.recorded(text) {");
    }
    expect(between(mac.history, "if recorded.kind == \"inter_agent\"", "return\n")).toContain("peer: read.peer");
    expect(between(phone.history, "if recorded.kind == \"inter_agent\"", "return\n")).toContain("\"peer\": peer,");
  });
});
