import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Seeing and reviewing work on the iPhone: the last state drawn on a cold
 * launch, Next through the ready reviews, a review's scene decoded, and a
 * Mac-local page said for what it is. The iOS app has no test target, so the
 * Foundation-only pieces are lifted out of its source and run under `swift`.
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

describe("Next walks the ready reviews by the Mac pill's rule", () => {
  test.skipIf(!swift)(
    "ready means a review on a session that isn't working; oldest filed first, unopened first, never the one on screen",
    () => {
      const scene = declaration(read("design/ConchDesign/Sources/ConchDesign/Components.swift"), "public enum ReviewScene: Equatable {");
      const identity = declaration(
        read("design/ConchDesign/Sources/ConchDesign/ReviewIdentity.swift"),
        "public enum ReviewIdentity {",
      );
      // ReviewScene reads a Figma file by its link (2026-11-11).
      const figma = declaration(read("design/ConchDesign/Sources/ConchDesign/Workspace.swift"), "public enum FigmaLink {");
      const queue = declaration(sheet, "enum ReviewQueue {");
      const out = runSwift([
        scene,
        figma,
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
        // A live page's login-wall check is read with ConchDesign's own type (`access`).
        read("design/ConchDesign/Sources/ConchDesign/PageAccess.swift").replace(/^import Foundation\n/m, ""),
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
        '  "https://example.com", "http://mac.local:5173",',
        "] { print(MacLocalPage.isLoopback(URL(string: link)!)) }",
        'let page = URL(string: "http://localhost:5173/onboarding?step=2#top")!',
        'print(MacLocalPage.onLAN(page, pairedHost: "192.168.1.20:8674", isRelay: false)?.absoluteString ?? "nil")',
        'print(MacLocalPage.onLAN(page, pairedHost: "mac.local", isRelay: false)?.absoluteString ?? "nil")',
        // A relay pairing never rewrites, even given a host it could parse.
        'print(MacLocalPage.onLAN(page, pairedHost: "192.168.1.20:8674", isRelay: true)?.absoluteString ?? "nil")',
      ]);
      expect(out).toEqual([
        "true", "true", "true", "true", "true", "true",
        "false", "false", "false", "false",
        "http://192.168.1.20:5173/onboarding?step=2#top",
        "http://mac.local:5173/onboarding?step=2#top",
        "nil",
      ]);
    },
    60_000,
  );
});
