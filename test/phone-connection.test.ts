import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INJECT_DELIVERY_WAIT_MS } from "../src/control-server.ts";

/**
 * The phone's connection, its sends and its pairing, as Tyler meets them on a
 * real iPhone: "the iphone app loses connection a lot and its not clear if the
 * messsage sends". The iOS app has no test target, so these read the Swift the
 * way the other ios-*.test.ts files do; the daemon half is executed in
 * control-server.test.ts, voice-loop.test.ts and phone-relay.test.ts. Every
 * marker is asserted present before anything is sliced, ordered or absent.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const ios = (name: string): string => read(join("mobile/conch-ios/conch-ios", name));

/** From `start` to the first `end` after it, both required to exist. */
function between(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  expect(at).toBeGreaterThan(-1);
  const stop = source.indexOf(end, at + start.length);
  expect(stop).toBeGreaterThan(at);
  return source.slice(at, stop);
}

/** Each marker present, in this order. */
function inOrder(source: string, markers: string[]): void {
  let last = -1;
  for (const marker of markers) {
    const at = source.indexOf(marker, last + 1);
    expect(at).toBeGreaterThan(last);
    last = at;
  }
}

const app = ios("ConchApp.swift");
const bridge = ios("BridgeClient.swift");
const relay = ios("RelayTransport.swift");
const lan = ios("DirectHTTPTransport.swift");
const talk = ios("TalkController.swift");
const receipt = ios("InjectReceipt.swift");
const session = ios("SessionView.swift");
const ledger = ios("LedgerView.swift");
const settings = ios("SettingsView.swift");

describe("coming back to the app keeps a link that is still good", () => {
  test("the scene phases go through the bridge's lifecycle, not a blanket re-dial or stop", () => {
    const phases = between(app, ".onChange(of: scenePhase)", "private func bridgeClient(");
    const active = between(phases, "case .active:", "case .background:");
    inOrder(active, ["bridge.enterForeground()", "Task { await bridge.claimAudio(true) }"]);
    expect(active).not.toContain("reconnectNow()");
    const background = between(phases, "case .background:", "case .inactive:");
    inOrder(background, [
      "talk.closeMic()",
      "bridge.enterBackground()",
      "await bridge.claimAudio(false)",
      "bridge.suspendIfStillAway()",
    ]);
    expect(background).not.toContain("bridge.stop()");
  });

  test("the stop after the hand-back is skipped once the app is back, and a return re-dials only a dead link", () => {
    const suspend = between(bridge, "func suspendIfStillAway() {", "\n    }\n");
    inOrder(suspend, ["guard backgroundedAt != nil, !suspended else { return }", "transport.stop()"]);
    const foreground = between(bridge, "func enterForeground() {", "\n    }\n");
    inOrder(foreground, [
      "guard let away = backgroundedAt else { return }",
      "backgroundedAt = nil",
      "guard suspended || away.duration(to: .now) > .seconds(20) else { return }",
      "transport.reconnectNow()",
    ]);
    // Under the Mac's 30 s expiry of a silent phone (RELAY_LIVENESS_MS).
    expect(read("src/phone-relay.ts")).toContain("const RELAY_LIVENESS_MS = 30_000;");
  });
});

describe("a short blip is invisible", () => {
  test("disconnected is shown only after the grace, and only if the link is still down", () => {
    expect(bridge).toContain("private static let outageGrace = Duration.seconds(6)");
    const changed = between(bridge, "private func linkChanged(connected: Bool, error: String?) {", "\n    }\n");
    inOrder(changed, ["guard connected else {", "if !suspended { beginOutageGrace() }", "return"]);
    const grace = between(bridge, "private func beginOutageGrace() {", "\n    }\n");
    inOrder(grace, ["try? await Task.sleep(for: Self.outageGrace)", "if !self.linkUp { self.isConnected = false }"]);
    // The only other place the screen is told "disconnected" is an explicit stop.
    expect(bridge.match(/^\s*isConnected = false$/gm)?.length).toBe(1);
    expect(bridge.split("self.isConnected = false").length - 1).toBe(1);
    expect(between(bridge, "    func stop() {", "\n    }\n")).toContain("isConnected = false");
  });

  test("every new link re-claims the audio, including one the grace hid", () => {
    const changed = between(bridge, "private func linkChanged(connected: Bool, error: String?) {", "\n    }\n");
    inOrder(changed, ["let relinked = connected && !linkUp", "linkUp = connected", "if relinked { onConnected?() }"]);
    // A Mac that re-dialled the relay starts a new session on the same socket.
    const establish = between(relay, "private func establishSession(", "private func sendStateSubscription(");
    inOrder(establish, [
      "if reportedConnected {",
      "reportedConnected = false",
      'callbacks.publishConnection(false, error: "Reconnecting to your Mac.")',
      "sessionGeneration += 1",
    ]);
    const lanReconnect = between(lan, "func reconnectNow() {", "\n    }\n");
    inOrder(lanReconnect, ["current?.cancel(with: .goingAway, reason: nil)", "if current != nil { publishConnection(false, nil) }", "connect()"]);
  });

  test("a new route re-dials at once; losing one, or being in the background, does not", () => {
    expect(bridge).toContain("import Network");
    expect(bridge).toContain("private let pathMonitor = NWPathMonitor()");
    expect(bridge).toContain('pathMonitor.start(queue: DispatchQueue(label: "conch.bridge.route"))');
    const route = between(bridge, "private func routeChanged(to next: String) {", "\n    }\n");
    inOrder(route, [
      'guard !previous.isEmpty, next != previous, next != "offline",',
      "backgroundedAt == nil, !suspended else { return }",
      "transport.reconnectNow()",
    ]);
    // An unpaired client must not be revived by the next network change.
    inOrder(between(bridge, "    func stop() {", "\n    }\n"), ["pathMonitor.cancel()", "transport.stop()"]);
  });
});

describe("a message shows what became of it", () => {
  test("every request ends, and the inject waits past the Mac's bound on both transports", () => {
    const perform = between(bridge, "private func perform(", "\n    }\n");
    inOrder(perform, [
      "withThrowingTaskGroup(of: BridgeResponse.self)",
      "try await transport.request(request)",
      "try await Task.sleep(for: limit)",
      "throw URLError(.timedOut)",
      "defer { group.cancelAll() }",
    ]);
    expect(bridge.split("transport.request(").length - 1).toBe(1);
    const within = /within: \.seconds\((\d+)\)/.exec(between(bridge, "private func deliveryOutcome(", "\n    }\n"));
    expect(within).not.toBeNull();
    expect(Number(within![1]) * 1000).toBeGreaterThan(INJECT_DELIVERY_WAIT_MS + 10_000);
    const lanTimeout = /request\.path == "\/control" \? (\d+) : 10/.exec(lan);
    expect(lanTimeout).not.toBeNull();
    expect(Number(lanTimeout![1]) * 1000).toBeGreaterThan(INJECT_DELIVERY_WAIT_MS);
  });

  test("the phone requests delivery and delegates to the behavior-tested receipt parser", () => {
    const inject = between(bridge, "    func inject(\n        sessionId: String,", "\n    }\n");
    inOrder(inject, ['"type": "inject",', '"awaitDelivery": true,', 'payload["opId"] = opId', "await deliveryOutcome(body)"]);
    const outcome = between(bridge, "private func deliveryOutcome(", "\n    }\n");
    expect(outcome).toContain("InjectOutcome.decode(status: response.status, body: response.body)");
    expect(outcome).not.toContain("return .accepted");
  });

  test("the bubble appears before the wait and settles after it, on both send paths", () => {
    for (const [start, end] of [
      ["    func send(session: String, deliver:", "\n    }\n"],
      ["    private func finish(deliver:", "\n    }\n"],
    ] as const) {
      inOrder(between(talk, start, end), [
        "beginOutgoing(text, session:",
        // The send carries its own id out, so the outcome can find it on the way back.
        "let delivered = await deliver(text, message)",
        "settleOutgoing(message, delivered)",
        // Only PROOF clears the draft. Acceptance is not proof and never was.
        "if delivered.confirmed {",
      ]);
    }
  });

  test("a message's words stay in the persisted draft until confirmed; the field only stops showing them", () => {
    const begin = between(talk, "private func beginOutgoing(", "\n    }\n");
    expect(begin).toContain("outbox.begin(");
    expect(begin).not.toContain("committed");
    expect(begin).not.toContain("parked");
    const draft = between(talk, "func draft(for session: String) -> String {", "\n    }\n");
    expect(draft).toContain("unconfirmed(session, in: stored)");
    const unconfirmed = between(talk, "private func unconfirmed(", "\n    }\n");
    expect(unconfirmed).toContain("outbox.unsettled(for: session)");
    // The rule that broke: accepted counted as confirmed, so the words were cleared for a
    // delivery still running. Only a delivered receipt lets them go now.
    expect(receipt).toContain("var confirmed: Bool { self == .delivered }");
    expect(receipt).not.toContain("self == .delivered || self == .accepted");
  });

  /**
   * The outcome outlives the request. `inject-accepted` is answered twenty seconds in and the
   * socket closes; whatever the send becomes is published against its id, and the phone — which
   * may have reconnected, or been killed and reopened since — matches it there.
   */
  test("a send that settles after its request closed is resolved from the published state", () => {
    const apply = between(talk, "func apply(_ deliveries: [PublishedState.Delivery]) {", "\n    }\n");
    inOrder(apply, [
      "outbox.entries.first(where: { $0.id == delivery.opId })",
      "!entry.state.isTerminal",
      "outbox.settle(delivery.opId, delivery.receipt.deliveryState)",
      "if delivery.receipt.confirmed { dropFromDraft(entry) }",
    ]);
    // It arrives on the state channel, not through a view: a phone that is not looking at
    // that session still has to resolve what it is holding.
    expect(bridge).toContain("if !decoded.deliveries.isEmpty { self.onDeliveries?(decoded.deliveries) }");
    expect(app).toContain("created.onDeliveries = { [weak talk] deliveries in talk?.apply(deliveries) }");
    // And it survives the app dying mid-flight.
    expect(talk).toContain("ConchOutbox.decode(UserDefaults.standard.data(forKey: conchOutboxKey))");
    expect(talk).toContain("didSet { UserDefaults.standard.set(outbox.encoded(), forKey: conchOutboxKey) }");
  });

  test("the transcript's own copy replaces the bubble instead of duplicating it", () => {
    const reconcile = between(talk, "func reconcile(session: String, items: [ConversationItem]) {", "\n    }\n");
    inOrder(reconcile, [
      "seenUserItems[session] = Set(users.map(\\.id))",
      "!message.earlierUserItems.contains($0.id) && Self.sameMessage($0.text, message.text)",
      "outbox.remove(message.id)",
    ]);
    const begin = between(talk, "private func beginOutgoing(", "\n    }\n");
    expect(begin).toContain("earlierUserItems: seenUserItems[session] ?? []");
    expect(between(session, ".onChange(of: conversationRevision)", "scrollToBottom(scroller, animated: true)"))
      .toContain("talk.reconcile(session: sessionId, items: conversationItems)");
    expect(session).toContain('"\\(items.count)-\\(items.last?.id ?? "")-\\(items.last?.rev ?? 0)-\\(talk.outgoing.count)"');
  });

  test("the conversation draws each state, with Retry on a failure", () => {
    inOrder(session, [
      "ForEach(talk.outgoing.filter { $0.session == sessionId }) { message in",
      "YourTurnBubble(",
      "onRetry: sendWords,",
      "onDiscard: { talk.discardOutgoing(message.id) }",
    ]);
    const bubble = between(session, "private struct YourTurnBubble: View {", "\nprivate struct ReviewCard");
    // Sent the moment you send it, a quiet mark once it is proven, and the reason if it
    // never arrived. "Sent" is deliberately the same word in both of the first two: Tyler
    // asked for "a confirmed icon but still show as sent", so nothing jumps when it lands.
    for (const marker of ['case .sent:', 'Text("Sent")', 'case .confirmed:',
      'Label("Sent", systemImage: "checkmark")',
      // The whole sentence comes from the receipt (ConchSendFailure), including the
      // "Not delivered" it opens with, so an unnamed cause is not dressed up as one.
      'Text(reason)', 'Button("Retry", action: onRetry)']) {
      expect(bubble).toContain(marker);
    }
    // Retry is the ordinary send: an unconfirmed message's words head the draft.
    expect(between(session, "private func sendWords() {", "\n    }\n")).toContain("talk.send(session: sessionId) { text, opId in");
  });
});

describe("typing while dictation streams does not garble the draft", () => {
  test("the field holds typed and banked words; the live partial has its own line above it", () => {
    const draft = between(talk, "func draft(for session: String) -> String {", "\n    }\n");
    expect(draft).toContain("committed");
    expect(draft).not.toContain("transcript");
    expect(draft).not.toContain("partial");
    expect(between(session, "private var draftBinding: Binding<String> {", "\n    }\n"))
      .toContain("get: { talk.draft(for: sessionId) },");
    const composer = between(session, "VStack(spacing: 10) {", ".submitLabel(.return)");
    inOrder(composer, [
      "if isTalkingHere, !talk.livePartial.text.isEmpty {",
      "Text(talk.livePartial.text)",
      'TextField(row?.noTerminal ?? "Type or talk…", text: draftBinding, axis: .vertical)',
    ]);
    // Words still being heard still count toward Send.
    expect(between(talk, "func hasWords(for session: String) -> Bool {", "\n    }\n")).toContain("!partial.trimmingCharacters");
    expect(session).toContain("!attachments.isEmpty || talk.hasWords(for: sessionId)");
  });
});

describe("a phone the Mac no longer knows is told so", () => {
  test("a refused credential is recognised on both LAN routes", () => {
    const fail = between(lan, "private func fail(", "\n    }\n");
    inOrder(fail, [
      "let refused = (expected.response as? HTTPURLResponse)?.statusCode == 401",
      "refused ? BridgeTransportError.unauthorized.localizedDescription : error.localizedDescription",
    ]);
    expect(relay).toContain('case .unauthorized: "This Mac no longer knows this phone."');
    expect(between(bridge, "private func perform(", "\n    }\n")).toContain("if response.status == 401 { pairingRejected = true }");
    expect(between(bridge, "private func linkChanged(", "\n    }\n"))
      .toContain("if error == BridgeTransportError.unauthorized.localizedDescription { pairingRejected = true }");
  });

  test("the ledger and settings say it plainly and offer one way on", () => {
    const card = between(ledger, "struct PairingRejectedCard: View {", "\n}\n");
    expect(card).toContain('Text("This Mac no longer knows this phone")');
    expect(card).toContain('Button("Pair again", action: onPairAgain)');
    expect(card.split("Button(").length - 1).toBe(1);
    expect(ledger.split("PairingRejectedCard(onPairAgain: onUnpair)").length - 1).toBe(2);
    const empty = between(ledger, "private var emptyState: some View {", "\n    }\n");
    inOrder(empty, ["if bridge.pairingRejected {", "PairingRejectedCard(onPairAgain: onUnpair)", "DisconnectedCard("]);
    inOrder(settings, ["if bridge.pairingRejected {", "PairingRejectedCard(onPairAgain: onPairAgain)", "} else if loading {"]);
    inOrder(between(settings, "private func load() async {", "\n    }\n"), ["guard bridge.isConnected else {", "bridge.fetchSettings()"]);
  });

  test("the Mac's pairing pane always shows a current code", () => {
    const pane = read("mac-app/conch-mac/PairingView.swift");
    inOrder(between(pane, "func open(force: Bool = false) async {", "\n    }\n"), [
      "if let pairing, !force, pairing.expiresAt / 1000 - Date().timeIntervalSince1970 > 5 { return }",
      "socketClient.request(ConchOpenPairingRequest())",
    ]);
    inOrder(between(pane, ".task {", "\n    }\n"), [
      "while !Task.isCancelled {",
      "await store.open()",
      "try? await Task.sleep(for: .seconds(store.pairing == nil ? 10 : max(1, left - 4)))",
    ]);
    expect(pane).toContain("TimelineView(.periodic(from: .now, by: 15)) { _ in");
  });
});
