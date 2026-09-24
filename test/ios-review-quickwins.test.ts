import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Seeing and reviewing work on the iPhone (mobile-parity.md, first iOS PR):
 * the last state drawn on a cold launch, Next through the ready reviews, a
 * Mac-local page said for what it is, and a reply from the review itself.
 * The iOS app has no test target, so the Foundation-only pieces run under
 * `swift` and the SwiftUI wiring is read the way the other ios-*.test.ts do.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const ios = (name: string): string => read(join("mobile/conch-ios/conch-ios", name));
const swift = Bun.which("swift");

/** A top-level Swift declaration, from its first line to its closing brace. */
function declaration(source: string, start: string): string {
  const at = source.indexOf(start);
  expect(at, `missing: ${start}`).toBeGreaterThan(-1);
  return source.slice(at, source.indexOf("\n}\n", at) + 3);
}

/** From `start` to the first `end` after it, both required. */
function between(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  expect(at, `missing: ${start}`).toBeGreaterThan(-1);
  const stop = source.indexOf(end, at + start.length);
  expect(stop, `missing after ${start}: ${end}`).toBeGreaterThan(at);
  return source.slice(at, stop);
}

function runSwift(lines: string[], args: string[] = []): string[] {
  const dir = mkdtempSync(join(tmpdir(), "conch-ios-review-"));
  const file = join(dir, "main.swift");
  writeFileSync(file, ["import Foundation", ...lines].join("\n"));
  try {
    const run = Bun.spawnSync([swift!, file, ...args.map((arg) => arg.replace("$DIR", dir))], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (run.exitCode !== 0) throw new Error(`swift exited ${run.exitCode}: ${run.stderr.toString()}`);
    return run.stdout.toString().trim().split("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const app = ios("ConchApp.swift");
const sheet = ios("DeliverableSheet.swift");
const session = ios("SessionView.swift");
const ledger = ios("LedgerView.swift");

describe("Next walks the ready reviews by the Mac pill's rule", () => {
  test.skipIf(!swift)(
    "ready means a review on a session that isn't working; oldest filed first, unopened first, never the one on screen",
    () => {
      const scene = declaration(read("design/ConchDesign/Sources/ConchDesign/Components.swift"), "public enum ReviewScene: Equatable {");
      const identity = declaration(
        read("design/ConchDesign/Sources/ConchDesign/ReviewIdentity.swift"),
        "public enum ReviewIdentity {",
      );
      const queue = declaration(sheet, "enum ReviewQueue {");
      const out = runSwift([
        scene,
        identity,
        queue,
        // published is nil throughout: these are an older daemon's rows, and the whole point
        // of the fallback is that they key exactly as they always did.
        "let rows: [(id: String, status: String, hasReview: Bool, filedAt: Double?, published: String?)] = [",
        '  ("b", "waiting", true, 2000, nil), ("w", "working", true, 500, nil), ("a", "waiting", true, 1000, nil),',
        '  ("n", "needs", false, nil, nil), ("c", "needs", true, 3000, nil), ("z", "waiting", true, 1000, nil),',
        "]",
        "let ready = ReviewQueue.ready(rows)",
        "func k(_ id: String) -> String { ReviewQueue.key(sessionId: id, filedAt: rows.first { $0.id == id }!.filedAt) }",
        'print(ready.map(\\.sessionId).sorted().joined(separator: ","))',
        'print(ReviewQueue.next(after: nil, in: ready, opened: []) ?? "nil")',
        'print(ReviewQueue.next(after: k("a"), in: ready, opened: []) ?? "nil")',
        'print(ReviewQueue.next(after: k("z"), in: ready, opened: [k("a")]) ?? "nil")',
        'print(ReviewQueue.next(after: k("b"), in: ready, opened: [k("a")]) ?? "nil")',
        'print(ReviewQueue.next(after: k("c"), in: ready, opened: [k("a"), k("z"), k("b")]) ?? "nil")',
        'print(ReviewQueue.next(after: k("a"), in: ReviewQueue.ready([rows[2]]), opened: []) ?? "nil")',
        'print(ReviewQueue.next(after: k("w"), in: ready, opened: []) ?? "nil")',
        'print(ReviewQueue.key(sessionId: "a", filedAt: nil))',
      ]);
      expect(out).toEqual([
        // Working and review-less rows are not waiting on you.
        "a,b,c,z",
        // Oldest filed first; a tie by version, so the order never shuffles.
        "a",
        "z",
        "b",
        // The unopened come before the ones already seen, wherever you are.
        "c",
        // All seen: round again from the oldest, skipping the one on screen.
        "a",
        // The only ready review has no Next.
        "nil",
        // A review that went back to work starts the queue over.
        "a",
        "a\u{1F}undated",
      ]);
    },
    60_000,
  );

  test("the review screen asks the queue, counts the rest, and keys versions as the Mac does", () => {
    // One rule, in ConchDesign. Both surfaces call it, and it is what keeps the fallback
    // byte-identical to the key each of them used to compute for itself.
    expect(read("mac-app/conch-mac/ReviewView.swift")).toContain(
      "id = ReviewIdentity.key(published: review.id, sessionId: row.id, filedAt: review.at)",
    );
    expect(read("design/ConchDesign/Sources/ConchDesign/ReviewIdentity.swift"))
      .toContain('[sessionId, stamp].joined(separator: "\\u{1F}")');
    expect(sheet).toContain("ReviewIdentity.key(published: published, sessionId: sessionId, filedAt: filedAt)");
    expect(sheet).toContain("import ConchDesign");
    expect(sheet).toContain("ReviewScene.next(after: current, in: ready.map { (key: $0.key, at: $0.at) }, opened: seen)");
    const body = between(sheet, "struct ReviewSheet: View {", "enum ReviewQueue {");
    expect(body).toContain("let next = ReviewQueue.next(after: currentKey, in: ready, opened: opened.union(viewedKeys))");
    // The phone reads the same record the Mac writes, and falls back to its own set alone
    // when the daemon is too old to have one.
    expect(sheet).toContain("guard bridge.state?.features?.viewedState != nil else { return [] }");
    expect(body).toContain("let more = ready.filter { $0.key != currentKey }.count");
    expect(body).toContain('Text("\\(more) more")');
    // Marked opened, then moved on — the order is the claim, not whether it is one line.
    expect(body).toMatch(/if let currentKey \{[\s\S]*?opened\.insert\(currentKey\)[\s\S]*?\}\s*sessionId = next/);
    expect(body).toContain("bridge.send(sessionCommand: .reviewViewed, sessionId: sessionId, review: currentKey)");
    // A different review is a fresh viewer, not the last one's download, an earlier one picked
    // from the menu included.
    expect(body).toContain(".id(key(review))");
    expect(session).toContain("ReviewSheet(bridge: bridge, talk: talk, sessionId: sessionId)");
  });
});

describe("a review's scene on the iPhone", () => {
  test.skipIf(!swift)(
    "inspect and marks decode when sent, and a missing or unreadable scene or mark never fails the review",
    () => {
      const models = ios("Models.swift");
      const start = models.indexOf("        struct Review: Decodable, Equatable {");
      expect(start).toBeGreaterThan(-1);
      const review = models.slice(start, models.indexOf("\n        }\n", start) + 10);
      const out = runSwift([
        "import CoreGraphics",
        review,
        declaration(models, "struct AgentMark: Decodable"),
        "func show(_ json: String) {",
        "  let r = try! JSONDecoder().decode(Review.self, from: Data(json.utf8))",
        '  print("\\(r.summary)|\\(r.link ?? "-")|\\(r.inspect ?? "-")|\\(r.marks.map(\\.id))")',
        "}",
        'show(#"{"summary":"page","link":"https://x.test","scene":{"v":1,"target":{"kind":"conversation"},"inspect":"Check Save"}}"#)',
        'show(#"{"summary":"page"}"#)',
        'show(#"{"summary":"page","scene":{"inspect":42}}"#)',
        'show(#"{"summary":"page","scene":"conversation"}"#)',
        // A mark from a newer daemon is skipped, and marks that are not a list are none: the inspect beside them stays.
        'show(#"{"summary":"page","scene":{"inspect":"Check","marks":[{"id":"a","kind":"box","frame":{"selector":".x"}},{"id":"b","kind":"lasso","frame":{"canvas":"c"}}]}}"#)',
        'show(#"{"summary":"page","scene":{"inspect":"Check","marks":"box"}}"#)',
      ]);
      expect(out).toEqual([
        "page|https://x.test|Check Save|[]", "page|-|-|[]", "page|-|-|[]", "page|-|-|[]",
        'page|-|Check|["a"]', "page|-|Check|[]",
      ]);
    },
    60_000,
  );

  test("the review screen and the ledger row show it on one line", () => {
    expect(between(sheet, "if let inspect = shown?.inspect {", "if let next {")).toContain(".lineLimit(1)");
    expect(between(ledger, "if let inspect = row.review?.inspect {", "Spacer(minLength: 8)")).toContain(".lineLimit(1)");
  });
});

describe("a cold launch draws the last state the Mac sent", () => {
  test.skipIf(!swift)(
    "publishes pass straight through, the newest lands on disk, and the next launch draws it once, before dialling",
    () => {
      const relay = ios("RelayTransport.swift");
      const wire = relay.slice(relay.indexOf("struct BridgeRequest"), relay.indexOf("enum BridgeTransportError"));
      const out = runSwift(
        [
          wire,
          // macOS refuses iOS data-protection classes outside an app container;
          // the pin below keeps the class in the app itself.
          declaration(app, "final class LastStateTransport: BridgeTransport, @unchecked Sendable {")
            .replace("[.atomic, .completeFileProtection]", "[.atomic]"),
          "final class Fake: BridgeTransport, @unchecked Sendable {",
          "  var onStateData: ((Data) -> Void)?",
          "  var onConnectionChange: ((Bool, String?) -> Void)?",
          "  var started = 0",
          "  func start() { started += 1 }",
          "  func stop() {}",
          "  func reconnectNow() {}",
          "  func request(_ request: BridgeRequest) async throws -> BridgeResponse { BridgeResponse(status: 200, headers: [], body: Data()) }",
          '  func download(_ request: BridgeRequest) async throws -> BridgeDownload { BridgeDownload(file: URL(fileURLWithPath: "/"), headers: []) }',
          "}",
          // The file cache is forgotten with the pairing too; it has its own test.
          "enum FileCache { static func forget() {} }",
          "let file = URL(fileURLWithPath: CommandLine.arguments[1])",
          "func text(_ data: Data) -> String { String(decoding: data, as: UTF8.self) }",
          "var seen: [String] = []",
          "let first = Fake()",
          "let a = LastStateTransport(first, file: file)",
          "a.onStateData = { seen.append(text($0)) }",
          "a.start()",
          'print("cold", seen.joined(separator: ","), first.started)',
          'first.onStateData?(Data("one".utf8))',
          'first.onStateData?(Data("two".utf8))',
          "a.stop()",
          "Thread.sleep(forTimeInterval: 0.5)",
          'print("saved", (try? text(Data(contentsOf: file))) ?? "nothing", seen.joined(separator: ","))',
          'print("backup", (try? file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup) ?? nil ?? false)',
          "seen = []",
          "let second = Fake()",
          "var startedWhenDrawn = -1",
          "let b = LastStateTransport(second, file: file)",
          "b.onStateData = { seen.append(text($0)); startedWhenDrawn = second.started }",
          "b.start()",
          "b.start()",
          'print("restored", seen.joined(separator: ","), startedWhenDrawn, second.started)',
          "LastStateTransport.forget(file: file)",
          "Thread.sleep(forTimeInterval: 0.3)",
          'print("forgotten", !FileManager.default.fileExists(atPath: file.path))',
        ],
        ["$DIR/last-state.json"],
      );
      expect(out).toEqual([
        "cold  1",
        "saved two one,two",
        "backup true",
        "restored two 0 2",
        "forgotten true",
      ]);
    },
    60_000,
  );

  test("every pairing's transport is wrapped, and the saved state goes with the pairing", () => {
    expect(app).toContain("let created = BridgeClient(pairing: pairing, transport: LastStateTransport(Self.transport(for: pairing)))");
    expect(app).toContain("LastStateTransport(fixture ?? Self.transport(for: pairing))");
    const transport = between(app, "private static func transport(for pairing: BridgeClient.Pairing)", "\n    }\n");
    expect(transport).toContain("case let .lan(host, token): DirectHTTPTransport(host: host, token: token)");
    expect(transport).toContain("case let .relay(payload): RelayTransport(pairing: payload)");
    expect(between(app, "private func unpair() {", "\n    }\n")).toContain("LastStateTransport.forget()");
    expect(between(app, "PairingView { newPairing in", "PairingStore.save(newPairing)")).toContain("LastStateTransport.forget()");
    // Transcripts: never backed up, unreadable while locked.
    expect(app).toContain("[.atomic, .completeFileProtection]");
    // The ledger draws a saved state as stale, with its age.
    const stale = between(ledger, "private func staleLine(_ state: PublishedState) -> String {", "\n    }\n");
    expect(stale).toContain("relativeAge(epochMilliseconds: state.ts)");
    expect(stale).toContain('"Looking for your Mac — showing what it last sent\\(age)."');
    expect(ledger).toContain("Text(staleLine(state))");
    expect(read("scripts/ui-snapshot.sh")).toContain("shoot ledger-stale.png -conchFixtureOffline YES");
  });
});

describe("a page on the Mac's localhost is said, not loaded", () => {
  test.skipIf(!swift)(
    "loopback names are recognised, and the Mac's LAN address replaces them only on a LAN pairing",
    () => {
      const out = runSwift([
        declaration(sheet, "enum MacLocalPage {"),
        "for link in [",
        '  "http://localhost:5173/", "http://127.0.0.1:3000", "http://[::1]:8080/x", "http://0.0.0.0:4000",',
        '  "http://app.localhost:5173", "http://LOCALHOST", "http://127.example.com", "http://192.168.1.20:5173",',
        '  "https://example.com", "http://tylers-mac.local:5173",',
        "] { print(MacLocalPage.isLoopback(URL(string: link)!)) }",
        'let page = URL(string: "http://localhost:5173/onboarding?step=2#top")!',
        'print(MacLocalPage.onLAN(page, pairedHost: "192.168.1.20:8674", isRelay: false)?.absoluteString ?? "nil")',
        'print(MacLocalPage.onLAN(page, pairedHost: "tylers-mac.local", isRelay: false)?.absoluteString ?? "nil")',
        // A relay pairing never rewrites, even given a host it could parse.
        'print(MacLocalPage.onLAN(page, pairedHost: "192.168.1.20:8674", isRelay: true)?.absoluteString ?? "nil")',
      ]);
      expect(out).toEqual([
        "true", "true", "true", "true", "true", "true",
        "false", "false", "false", "false",
        "http://192.168.1.20:5173/onboarding?step=2#top",
        "http://tylers-mac.local:5173/onboarding?step=2#top",
        "nil",
      ]);
    },
    60_000,
  );

  test("the router sends loopback to the explanation, which offers the LAN page", () => {
    expect(sheet).toContain("return MacLocalPage.isLoopback(url) ? .macLocal(url) : .web(url)");
    const view = between(sheet, "private func macLocalView(_ url: URL) -> some View {", "/// Said in the sheet");
    expect(view).toContain("MacLocalPage.onLAN(url, pairedHost: bridge.pairedHost, isRelay: bridge.isRelayPaired)");
    expect(view).toContain("Button { lanPage = lan }");
    expect(view).toContain("through the relay");
    expect(between(sheet, "case let .macLocal(url):", "case let .local(localKind):")).toContain(
      "BridgedWebView(url: lanPage, page: page, onFailure: fail)",
    );
  });
});

describe("the review screen replies through the composer's own path", () => {
  const bar = between(session, "struct ReviewReplyBar: View {", "\n}\n");

  test("the session's draft, talk.send, and inject to that session", () => {
    expect(bar).toContain("get: { talk.draft(for: sessionId) },");
    expect(bar).toContain("set: { talk.setDraft($0, for: sessionId) }");
    expect(bar).toMatch(
      /talk\.send\(session: sessionId\) \{ text, opId in\s*await bridge\.inject\(sessionId: sessionId, label: label, text: text, opId: opId\)\s*\}/,
    );
    // Sent, Delivered and Not delivered with Retry: the conversation's own bubble.
    expect(bar).toContain("talk.outgoing.last(where: { $0.session == sessionId })");
    expect(bar).toMatch(/YourTurnBubble\(\s*message: latest,\s*onRetry: send,\s*onDiscard: \{ talk\.discardOutgoing\(latest\.id\) \}/);
    expect(bar).toContain(".disabled(isSending || row?.noTerminal != nil)");
    expect(sheet).toContain("ReviewReplyBar(bridge: bridge, talk: talk, sessionId: sessionId)");
  });
});

describe("the viewers", () => {
  test("a link asking for a new window opens in the page; the page has Back, Reload and Safari", () => {
    const delegate = between(sheet, "private final class PageLoadFailure", "struct LinkFailureLine");
    expect(delegate).toContain("WKUIDelegate");
    expect(delegate).toMatch(/createWebViewWith[\s\S]*if navigationAction\.targetFrame == nil \{ webView\.load\(navigationAction\.request\) \}[\s\S]*return nil/);
    const controls = between(sheet, "private func webControls(_ url: URL) -> some View {", "/// What a Mac-local page is");
    expect(controls).toContain("page.view?.goBack()");
    expect(controls).toContain(".disabled(!page.canGoBack)");
    expect(controls).toContain("page.reload(url)");
    expect(controls).toContain("bridge.openLink(page.view?.url ?? url, sessionId: sessionId) { linkFailure = $0 }");
    expect(controls).toContain('Label("Open in Safari", systemImage: "safari")');
  });

  test("transcript and document text can be selected and copied", () => {
    expect(between(ios("ConversationStack.swift"), "LinkFailureLine(message: $linkFailure)", ".environment(\\.openURL")).toContain(
      ".textSelection(.enabled)",
    );
    expect(between(sheet, "private struct RemoteDocumentView", "private struct BridgedWebView")).toContain(".textSelection(.enabled)");
    expect(between(session, "} else if let replyText {", "} else if loadingReply {")).toContain(".textSelection(.enabled)");
  });

  test("the session header: name over state, nothing clipped in the trailing capsule, context in the menu", () => {
    const principal = between(session, "ToolbarItem(placement: .principal) {", "// Read it to me.");
    expect(principal).toContain(".truncationMode(.tail)");
    expect(principal).toContain("statusLine(mark)");
    expect(between(session, "private func statusLine(_ mark: StatusMark) -> some View {", "// MARK: - Talk")).toContain(".lineLimit(1)");
    expect(session).not.toMatch(/ToolbarItem\(placement: \.topBarTrailing\) \{\s*HStack\(spacing: 6\)/);
    const scroll = between(session, "ScrollViewReader { scroller in", "ConversationStack(");
    expect(scroll).not.toContain("context");
    // A blocked session says what it is asking, above the conversation.
    const pinned = between(session, "var body: some View {\n        VStack(spacing: 0) {", "ScrollViewReader { scroller in");
    expect(pinned).toContain('if row?.status == "needs", let detail = row?.detail, !detail.isEmpty {');
  });
});

describe("the showcase fixture has a review of every kind the phone opens", () => {
  test("web, localhost, image, PDF, video, markdown, code, diff, an unpreviewable file, and a permission ask", () => {
    const state = JSON.parse(read("mobile/conch-ios/fixtures/showcase.json"));
    const links: string[] = state.rows.flatMap((row: any) => (row.review?.link ? [row.review.link] : []));
    for (const pattern of [/^https:\/\//, /^http:\/\/localhost:/, /\.png$/, /\.pdf$/, /\.mp4$/, /\.md$/, /\.swift$/, /\.diff$/, /\.zip$/]) {
      expect(links.some((link) => pattern.test(link)), String(pattern)).toBe(true);
    }
    for (const link of links.filter((link) => !/^https?:/.test(link))) expect(existsSync(join(root, link)), link).toBe(true);
    expect(state.rows.some((row: any) => row.status === "needs" && row.detail?.startsWith("permission: "))).toBe(true);
  });
});
