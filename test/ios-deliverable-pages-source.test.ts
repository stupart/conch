import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tyler: "a huge improvement would be having all content viewable and interative on phone app -
 * currently it just says to go to desktop which kinda defeats a lot of the purpose of having it."
 *
 * A local page on the phone is served from `conch-page://<id>/…`, each request one `/file` read
 * over whichever transport is live; a markdown document's pictures come the same way. The iOS app
 * has no test target, so the Foundation-only pieces run under `swift` and the WebKit wiring is read
 * the way the other ios-*.test.ts do. The Mac's own rule is in phone-bridge.test.ts.
 */
const root = join(import.meta.dir, "..");
const ios = (name: string): string => readFileSync(join(root, "mobile/conch-ios/conch-ios", name), "utf8");
const swift = Bun.which("swift");
const sheet = ios("DeliverableSheet.swift");
const bridge = ios("BridgeClient.swift");

function between(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  expect(at, `missing: ${start}`).toBeGreaterThan(-1);
  const stop = source.indexOf(end, at + start.length);
  expect(stop, `missing after ${start}: ${end}`).toBeGreaterThan(at);
  return source.slice(at, stop);
}

function runSwift(lines: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "conch-ios-pages-"));
  const file = join(dir, "main.swift");
  writeFileSync(file, ["import Foundation", ...lines].join("\n"));
  try {
    const run = Bun.spawnSync([swift!, file], { stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) throw new Error(`swift exited ${run.exitCode}: ${run.stderr.toString()}`);
    return run.stdout.toString().trim().split("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pagePath = between(sheet, "enum ConchPagePath {", "\n}\n") + "\n}\n";
const handler = between(sheet, "final class ConchPageSchemeHandler", "\n}\n");

describe("conch-page:// addresses", () => {
  test.skipIf(!swift)(
    "a request maps into the page's folder; another page's id, or a climb however it is spelled, maps nowhere",
    () => {
      const out = runSwift([
        pagePath,
        'let folder = "/Users/t/proj/site"',
        "for address in [",
        '  "conch-page://h/style.css",',
        '  "conch-page://h/img/a%20b.png",',
        '  "conch-page://h/assets/app.js?v=3#x",',
        '  "conch-page://h/%2e%2e/secret.css",',
        '  "conch-page://h/../secret.css",',
        '  "conch-page://h/a/..%2F..%2Fsecret.css",',
        '  "conch-page://h/a%2F..%2F..%2Fsecret.css",',
        '  "conch-page://h/./style.css",',
        '  "conch-page://other/style.css",',
        '  "https://h/style.css",',
        '  "conch-page://h/",',
        '] { print(ConchPagePath.macPath(for: URL(string: address)!, host: "h", folder: folder) ?? "nil") }',
        'let entry = ConchPagePath.entry(host: "h", page: "/Users/t/proj/site/the page#1.html")!',
        "print(entry.absoluteString)",
        'print(ConchPagePath.macPath(for: entry, host: "h", folder: folder) ?? "nil")',
      ]);
      expect(out).toEqual([
        "/Users/t/proj/site/style.css",
        "/Users/t/proj/site/img/a b.png",
        "/Users/t/proj/site/assets/app.js",
        "nil",
        "nil",
        "nil",
        "nil",
        "nil",
        "nil",
        "nil",
        "nil",
        "conch-page://h/the%20page%231.html",
        "/Users/t/proj/site/the page#1.html",
      ]);
    },
    60_000,
  );

  test.skipIf(!swift)(
    "a markdown picture resolves against the document's folder on the Mac, a web one stays on the web",
    () => {
      const out = runSwift([
        pagePath,
        'let doc = "/Users/t/proj/notes/review.md"',
        "for source in [",
        '  "shots/a.png", "./shots/b.png", "my%20shot.png", "../up.png", "/abs/c.png",',
        '  "file:///abs/d.png", "https://example.com/e.png", "data:image/png;base64,AAAA", "mailto:x@y.z",',
        "] {",
        "  guard let url = ConchPagePath.markdownImage(source, document: doc) else { print(\"nil\"); continue }",
        "  print(url.isFileURL ? url.path : url.absoluteString)",
        "}",
      ]);
      expect(out).toEqual([
        "/Users/t/proj/notes/shots/a.png",
        "/Users/t/proj/notes/shots/b.png",
        "/Users/t/proj/notes/my shot.png",
        // Resolved as written; the Mac refuses it, since it is outside the document's folder.
        "/Users/t/proj/up.png",
        "/abs/c.png",
        "/abs/d.png",
        "https://example.com/e.png",
        "nil",
        "nil",
      ]);
    },
    60_000,
  );
});

describe("the page reads through the bridge, and never sees the token", () => {
  test("every conch-page request is one fetchFile, which attaches the token as a header", () => {
    expect(handler).toContain("try await bridge.fetchFile(path: path)");
    expect(handler).not.toMatch(/token|bearer/i);
    const fetch = between(bridge, "func fetchFile(path: String) async throws -> URL {", "\n    }\n");
    expect(fetch).toContain('let authorized = authorizedRequest(method: "GET", path: Self.route("/file", ["path": path]))');
    expect(fetch).toContain("let download = try await gatedDownload(request)");
    expect(fetch).not.toMatch(/token/i);
    const dev = between(bridge, "func fetchDev(review: String, path: String) async throws -> BridgeDownload {", "\n    }\n");
    expect(dev).toContain('try await gatedDownload(authorizedRequest(method: "GET", path: Self.route("/dev", ["review": review, "path": path])))');
    expect(dev).not.toMatch(/token/i);
    expect(between(bridge, "private func authorizedRequest(", "\n    }\n")).toContain(
      'headers: ["authorization": "Bearer \\(pairing.bearer)"]',
    );
    // The one query-string token on the phone is the LAN websocket's, which WebKit never sees.
    const queryTokens = ["BridgeClient.swift", "DeliverableSheet.swift", "DirectHTTPTransport.swift", "RelayTransport.swift"]
      .map((name) => (ios(name).match(/URLQueryItem\(name: "token"/g) ?? []).length);
    expect(queryTokens).toEqual([0, 0, 1, 0]);
    expect(between(ios("DirectHTTPTransport.swift"), "private func connect() {", "\n    }\n")).toContain(
      'URLQueryItem(name: "token", value: token)',
    );
    // What the page gets back is a response this handler built, never the Mac's headers.
    expect(handler).toContain('headerFields: ["Content-Type": read.type ?? Self.contentType(url.pathExtension), "Content-Length": String(data.count)]');
  });

  test("a stopped request is never answered, and a failed page says why", () => {
    expect(handler).toContain("@MainActor");
    expect(handler).toContain("guard let self, self.reads.removeValue(forKey: key) != nil else {");
    expect(between(handler, "func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {", "}")).toContain(
      "reads.removeValue(forKey: ObjectIdentifier(task))?.cancel()",
    );
    expect(handler).toContain("let isPage = url == entry || task.request.mainDocumentURL == url");
    expect(handler).toContain("userInfo: [NSLocalizedDescriptionKey: describe(failure)]");
    expect(handler).toContain("init(entry: URL, describe: @escaping (Error) -> String = BridgeClient.fileFailure, read: @escaping Read)");
  });

  test("the page is served, not downloaded alone into an empty folder", () => {
    expect(sheet).not.toContain("loadFileURL");
    expect(sheet).not.toContain("allowingReadAccessTo");
    expect(sheet).toContain("guard case let .local(localKind) = kind, localKind != .page, let link = review.link else { return }");
    const page = between(sheet, "private struct LocalPageView", "private final class PageLoadFailure");
    expect(page).toContain("configuration.setURLSchemeHandler(handler, forURLScheme: url.scheme ?? ConchPagePath.scheme)");
    expect(sheet).toContain('LocalPageView(handler: .page(review.link ?? "", entry: url, bridge: bridge), url: url, page: page, onFailure: fail, ink: ink)');
    // A conch-page address is not something Safari or Share can use.
    expect(between(sheet, "private func webControls(_ url: URL) -> some View {", "/// What a Mac-local page is")).toContain(
      'if url.scheme == "http" || url.scheme == "https" {',
    );
    expect(sheet).toContain('if let shared = localURL ?? pageURL, ["file", "http", "https"].contains(shared.scheme), failure == nil {');
  });

  test("a markdown document's pictures come through the same read", () => {
    const document = between(sheet, "private struct RemoteDocumentView", "private struct BridgedWebView");
    expect(document).toContain("MarkdownView(text: content, image: images)");
    expect(document).toContain("AnyView(MarkdownImage(bridge: bridge, source: source, alt: alt, document: document))");
    const picture = between(sheet, "private struct MarkdownImage: View {", "\n}\n");
    expect(picture).toContain("ConchPagePath.markdownImage(source, document: document)");
    expect(picture).toContain("try await bridge.fetchFile(path: target.path)");
    expect(picture).toContain("failure = BridgeClient.fileFailure(error)");
  });
});

describe("a page with more pictures than the relay holds", () => {
  test.skipIf(!swift)(
    "file reads queue on the phone, six at a time, and every one of them finishes",
    () => {
      const gate = between(bridge, "actor FileReadGate {", "\n}\n") + "\n}\n";
      const out = runSwift([
        gate,
        "actor Meter { var now = 0; var peak = 0; var done = 0",
        "  func up() { now += 1; peak = max(peak, now) }",
        "  func down() { now -= 1; done += 1 } }",
        "let gate = FileReadGate(slots: 6)",
        "let meter = Meter()",
        "let finished = DispatchSemaphore(value: 0)",
        "Task {",
        "  await withTaskGroup(of: Void.self) { group in",
        "    for _ in 0..<300 {",
        "      group.addTask {",
        "        await gate.enter()",
        "        await meter.up()",
        "        try? await Task.sleep(for: .milliseconds(1))",
        "        await meter.down()",
        "        await gate.leave()",
        "      }",
        "    }",
        "  }",
        "  print(await meter.peak, await meter.done)",
        "  finished.signal()",
        "}",
        "finished.wait()",
      ]);
      expect(out).toEqual(["6 300"]);
    },
    60_000,
  );

  test("every /file read goes through the gate, and leaves it on failure too", () => {
    expect(bridge).toContain("private static let fileReads = FileReadGate(slots: 6)");
    const gated = between(bridge, "private func gatedDownload(_ request: BridgeRequest) async throws -> BridgeDownload {", "\n    }\n");
    expect(gated).toContain("await Self.fileReads.enter()");
    // Once for a read, once for a failure.
    expect((gated.match(/await Self\.fileReads\.leave\(\)/g) ?? []).length).toBe(2);
    expect((bridge.match(/transport\.download\(/g) ?? []).length).toBe(1);
    expect(between(bridge, "func downloadFile(path: String) async -> URL? {", "\n    }\n")).toContain(
      "return try await fetchFile(path: path)",
    );
  });
});

describe("what the phone can't show, it says, and offers what it can", () => {
  test("no line sends him to the desktop for something the phone now shows", () => {
    expect(sheet).not.toContain("it's on the Mac at");
    expect(sheet).not.toContain("Open the page on the Mac");
    expect(bridge).not.toContain("conch isn't publishing that file.");
    expect(bridge).not.toContain("conch doesn't open a Mac file from here.");
    // An unpreviewable file is on the phone already, and Share hands it on.
    expect(between(sheet, "case .unsupported:", "/// Back, Reload, and Safari")).toContain(
      "It's on this phone now: Share sends it to an app that opens it, or to Files.",
    );
  });
});
