import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tyler (09-25): "it will also need other materials sent to it if there's not an equivalent on the phone". The phone's
 * side of a snapshot (review-preview.test.ts has the Mac's): what gets one, how it is asked for, and what it says. The
 * iOS app has no test target, so the model decode runs under `swift` and the rest is read.
 */
const root = join(import.meta.dir, "..");
const ios = (name: string): string => readFileSync(join(root, "mobile/conch-ios/conch-ios", name), "utf8");
const sheet = ios("DeliverableSheet.swift");
const bridge = ios("BridgeClient.swift");
const models = ios("Models.swift");
const swift = Bun.which("swift");

function between(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  expect(at, `missing: ${start}`).toBeGreaterThan(-1);
  const stop = source.indexOf(end, at + start.length);
  expect(stop, `missing after ${start}: ${end}`).toBeGreaterThan(at);
  return source.slice(at, stop);
}

describe("what gets a snapshot", () => {
  test("a linkless app window, Simulator, design or terminal; a document the phone couldn't fetch or draw", () => {
    expect(sheet).toContain('static let standInKinds: Set<String> = ["app", "simulator", "design", "terminal"]');
    expect(sheet).toContain("if review.link == nil, let typed = review.kind, Self.standInKinds.contains(typed) { return .standIn }");
    expect(between(sheet, "private var routed: some View {", "case let .web(url):")).toContain(
      "StandInView(bridge: bridge, review: review, sessionId: sessionId)",
    );
    expect(sheet).toContain('if review.kind == "document" { documentStandIn = true; return }');
    expect(between(sheet, "case .unsupported:", "/// Back, Reload, and Safari")).toContain('} else if review.kind == "document" {');
  });

  test.skipIf(!swift)("the review decodes its snapshot, and a review without one, or an unreadable one, still decodes", () => {
    const start = models.indexOf("        struct Review: Decodable, Equatable {");
    const review = models.slice(start, models.indexOf("\n        }\n", start) + 10);
    const mark = models.slice(models.indexOf("struct AgentMark: Decodable"), models.indexOf("\n}\n", models.indexOf("struct AgentMark: Decodable")) + 3);
    const dir = mkdtempSync(join(tmpdir(), "conch-ios-standin-"));
    const file = join(dir, "main.swift");
    writeFileSync(file, ["import Foundation", "import CoreGraphics", review, mark,
      "func show(_ json: String) {",
      "  let r = try! JSONDecoder().decode(Review.self, from: Data(json.utf8))",
      '  print(r.preview.map { "\\($0.path)@\\(Int($0.capturedAt))" } ?? "none")',
      "}",
      'show(#"{"summary":"sim","kind":"simulator","preview":{"path":"/tmp/conch-previews/a.png","kind":"image","capturedAt":1727000000000}}"#)',
      'show(#"{"summary":"sim","kind":"simulator"}"#)',
      'show(#"{"summary":"sim","preview":{"path":42}}"#)',
    ].join("\n"));
    try {
      const run = Bun.spawnSync([swift!, file], { stdout: "pipe", stderr: "pipe" });
      if (run.exitCode !== 0) throw new Error(run.stderr.toString());
      expect(run.stdout.toString().trim().split("\n")).toEqual(["/tmp/conch-previews/a.png@1727000000000", "none", "none"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("asked for, fetched, and said", () => {
  const view = between(sheet, "struct StandInView: View {", "\n}\n");

  test("the first look asks once, Refresh again; the Mac's words when it didn't take one", () => {
    expect(view).toContain(".task(id: review.id) { if review.preview == nil { await refresh() } }");
    expect(view).toContain('Button(review.preview == nil ? "Take a snapshot" : "Refresh") { Task { await refresh() } }');
    expect(view).toContain("failure = await bridge.requestPreview(sessionId: sessionId, review: id)");
    expect(view).toContain(".disabled(asking)");
    const ask = between(bridge, "func requestPreview(sessionId: String, review: String) async -> String? {", "\n    }\n");
    expect(ask).toContain('perform(authorizedRequest(method: "POST", path: "/preview", body: body), within: .seconds(30))');
    expect(ask).toContain('return said?["error"] as? String');
    expect(ios("DirectHTTPTransport.swift")).toContain('request.path == "/control" || request.path == "/preview" ? 30 : 10');
  });

  test("the snapshot comes through /file like any Mac file, and says when it was taken", () => {
    expect(view).toContain("let file = try await bridge.fetchFile(path: path)");
    expect(view).toContain(".task(id: review.preview?.path) { await load() }");
    expect(view).toContain('"Snapshot from your Mac, \\(Date(timeIntervalSince1970: capturedAt / 1000).formatted(date: .omitted, time: .shortened))"');
    expect(view).toContain("Text(review.preview.map { Self.caption(capturedAt: $0.capturedAt) } ?? what)");
  });
});
