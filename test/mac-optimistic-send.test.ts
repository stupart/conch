import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Tyler: "im not seeing mesages i send show in the mac app - just the same ux thing as teh
 * phone where we want instant response on send and confirm iwth checkmark". The daemon reads
 * transcripts on a poll, so a message sent from the Mac said nothing at all for seconds — it
 * left the composer and did not arrive anywhere.
 *
 * The Mac now keeps the PHONE'S outbox, not a second one of its own: the bubble appears at the
 * press, a published receipt settles it, and the transcript's own copy retires it. The Mac app
 * has no test target, so these read the Swift the way the other mac source tests do. Line
 * comments are stripped first, so a description of a site can never satisfy a guard.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const swift = (file: string) => source(`mac-app/conch-mac/${file}`).replace(/^\s*\/\/.*$/gm, "");
const store = swift("StateStore.swift");
const stack = swift("ConversationStackView.swift");
const outbox = source("design/ConchDesign/Sources/ConchDesign/DeliveryOutbox.swift");
const phone = source("mobile/conch-ios/conch-ios/TalkController.swift");

function at(text: string, marker: string, from = 0): number {
  const index = text.indexOf(marker, from);
  expect(index, `missing: ${marker}`).toBeGreaterThan(-1);
  return index;
}
function section(text: string, start: string, end: string): string {
  const a = at(text, start);
  const b = at(text, end, a);
  return text.slice(a, b);
}
function ordered(text: string, ...markers: string[]): void {
  let position = 0;
  for (const marker of markers) position = at(text, marker, position) + marker.length;
}

describe("a message sent from the Mac appears the moment it is sent", () => {
  test("it is the phone's outbox, and it survives a relaunch", () => {
    expect(store).toContain('private let conchMacOutboxKey = "conch.mac.outbox"');
    expect(store).toContain("ConchOutbox.decode(UserDefaults.standard.data(forKey: conchMacOutboxKey))");
    expect(store).toContain("didSet { UserDefaults.standard.set(outbox.encoded(), forKey: conchMacOutboxKey) }");
    // The shared type. Two devices cannot come to disagree about what "sent" means.
    expect(outbox).toContain("public struct ConchOutbox");
    expect(outbox).toContain("public enum ConchDeliveryState");
  });

  /**
   * The composer is NOT the only sender — the conversation fog types into a session too. Every
   * inject routes through `send`, so beginning the entry there is what makes the two agree.
   */
  test("every inject gets a bubble, because every sender routes through send()", () => {
    const send = section(store, "func send(_ event: ConchDaemonEvent) -> Task<Bool, Never> {", "private static func awaitDelivery(");
    ordered(
      send,
      "if event.type == .inject, let opId = event.opId, let session = event.sessionId,",
      "outbox.begin(ConchOutboxEntry(",
      "id: opId,",
      "earlierUserItems: seenUserItems[session] ?? []",
    );
    expect(swift("ComposerView.swift")).not.toContain("outbox.begin(");
    // The id it is filed under is the one the event already mints, which is what a late
    // outcome comes back against.
    expect(swift("ConchSocketClient.swift")).toContain("self.opId = opId ?? (type == .inject ? UUID().uuidString : nil)");
  });

  /**
   * The bubbles outlive the launch that sent them, so after a relaunch the receipt an entry is
   * waiting for arrives in the FIRST snapshot — exactly when `lastDeliveryAt` is nil and the
   * failure-reporting guard returns early. Settling under that guard would leave those entries
   * reading "Sent" forever.
   */
  test("a receipt settles a bubble even in the first snapshot after a relaunch", () => {
    const apply = section(store, "private func applyDeliveryOutcomes(", "private static func deliveryState(");
    ordered(
      apply,
      "outbox.entries.first(where: { $0.id == outcome.opId })",
      "!entry.state.isTerminal",
      "outbox.settle(outcome.opId, Self.deliveryState(of: outcome))",
      "guard let seen = lastDeliveryAt else { return }",
    );
  });

  test("staged, confirmed and failed are read the same way the phone reads them", () => {
    const map = section(store, "private static func deliveryState(of outcome:", "private func reconcileOutbox(");
    ordered(
      map,
      "if outcome.staged == true, !outcome.delivered { return .staged }",
      "if outcome.delivered { return .confirmed }",
      "return .failed(ConchSendFailure.sentence(",
    );
    // Staged is not a failure: the text is placed and waiting for a Return.
    expect(source("mobile/conch-ios/conch-ios/InjectReceipt.swift")).toContain("case .staged: .staged");
  });

  test("the transcript's own copy retires the bubble instead of duplicating it", () => {
    const reconcile = section(store, "private func reconcileOutbox(with snapshot:", "static func sameMessage(");
    ordered(
      reconcile,
      "seenUserItems[session] = Set(users.map(\\.id))",
      "!message.earlierUserItems.contains($0.id) && Self.sameMessage($0.text, message.text)",
      "outbox.remove(message.id)",
      "outbox.prune(confirmedBefore:",
    );
    // An older daemon puts the selected session in `conversation`, not in `conversations`.
    expect(reconcile).toContain("conversations[one.sessionId] = one");
    expect(store).toContain("reconcileOutbox(with: snapshot)");
  });

  test("the Mac and the phone match a message against the transcript by one rule", () => {
    const rule = "return !words.isEmpty && (seen == words || seen.hasSuffix(words))";
    expect(section(store, "static func sameMessage(", "private func reconcilePresentationOverlays(")).toContain(rule);
    expect(phone).toContain(rule);
  });

  test("the bubble is the user row exactly, so nothing moves when the transcript catches up", () => {
    ordered(
      stack,
      "ForEach(conversation.items) { item in",
      "ForEach(store.outbox.entries(for: conversation.sessionId)) { pending in",
      "PendingMessage(entry: pending)",
    );
    const pending = section(stack, "private struct PendingMessage: View {", "private struct ArtifactPreview: View {");
    expect(pending).toContain(".background(ConchPalette.fill, in: RoundedRectangle(cornerRadius: ConchRadius.large))");
    expect(pending).toContain(".font(ConchType.readingBody)");
    // "a confirmed icon but still show as sent" — the word does not change, the mark appears
    // beside it, so nothing jumps when it lands. And no state claims a delivery conch has not
    // been told about.
    ordered(
      pending,
      "case .sent:",
      'Text("Sent")',
      "case .confirmed:",
      'Label("Sent", systemImage: "checkmark")',
      "case .staged:",
      "case let .unknown(reason):",
      "case let .failed(reason):",
    );
  });
});
