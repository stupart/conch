import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tyler, 09-25: "Phone will need viewing of dev server ones". A page a session published at its
 * Mac's localhost opens on the phone as `conch-dev://<id>/…`, each request read through `/dev`
 * (phone-dev-proxy.test.ts has the Mac's rules). The iOS app has no test target, so the Foundation
 * pieces run under `swift` and the WebKit wiring is read the way the other ios-*.test.ts do.
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
  const dir = mkdtempSync(join(tmpdir(), "conch-ios-dev-"));
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

const devPath = between(sheet, "enum DevPagePath {", "\n}\n") + "\n}\n";

describe("conch-dev:// addresses", () => {
  test.skipIf(!swift)("a Mac page keeps its path and query; only its own page's requests map, exactly as written", () => {
    const out = runSwift([
      devPath,
      'let page = URL(string: "http://localhost:5173/app/index.html?tab=2&x=a%20b#top")!',
      'let entry = DevPagePath.entry(host: "h", for: page)!',
      "print(entry.absoluteString)",
      'print(DevPagePath.entry(host: "h", for: URL(string: "http://127.0.0.1:3000")!)!.absoluteString)',
      'for address in ["conch-dev://h/app/index.html?tab=2&x=a%20b#top", "conch-dev://h/src/main.tsx", "conch-dev://h/a%2F..%2Fb", "conch-dev://other/x", "conch-page://h/x"] {',
      '  print(DevPagePath.request(for: URL(string: address)!, host: "h") ?? "nil")',
      "}",
      'let origin = URL(string: "http://localhost:5173/")!',
      'for link in ["http://localhost:5173/next", "http://LOCALHOST:5173/x", "http://localhost:5174/", "https://localhost:5173/", "http://127.0.0.1:5173/"] {',
      "  print(DevPagePath.sameServer(URL(string: link)!, origin))",
      "}",
      'print(DevPagePath.sameServer(URL(string: "http://localhost/")!, URL(string: "http://localhost:80/")!))',
    ]);
    expect(out).toEqual([
      "conch-dev://h/app/index.html?tab=2&x=a%20b#top",
      "conch-dev://h/",
      "/app/index.html?tab=2&x=a%20b",
      "/src/main.tsx",
      // Passed on as written: the Mac resolves it, and refuses anything off the server.
      "/a%2F..%2Fb",
      "nil",
      "nil",
      "true", "true", "false", "false", "false",
      "true",
    ]);
  }, 60_000);

  test.skipIf(!swift)("a route's query values arrive whole at the Mac: & = ? + and spaces included", () => {
    const route = between(bridge, "nonisolated static func route(_ path: String, _ items: KeyValuePairs<String, String>) -> String {", "\n    }\n") + "\n    }\n";
    const out = runSwift([
      `enum Probe { ${route.replace("nonisolated ", "")} }`,
      'print(Probe.route("/dev", ["review": "rev-1", "path": "/app?tab=2&x=1 +é#h"]))',
      'print(Probe.route("/file", ["path": "/Users/t/Q&A = notes+1?.md"]))',
    ]);
    const dev = new URL(`https://mac.invalid${out[0]}`).searchParams;
    expect([dev.get("review"), dev.get("path")]).toEqual(["rev-1", "/app?tab=2&x=1 +é#h"]);
    expect(new URL(`https://mac.invalid${out[1]}`).searchParams.get("path")).toBe("/Users/t/Q&A = notes+1?.md");
  }, 60_000);
});

describe("the sheet opens a published dev page through conch", () => {
  test("a Mac-local page with a held review opens as conch-dev, before the explanation", () => {
    const route = between(sheet, "case let .macLocal(url):\n            if let lanPage {", "case let .local(localKind):");
    const dev = route.indexOf("} else if let dev = devPage(url) {");
    expect(dev).toBeGreaterThan(-1);
    expect(route.indexOf("macLocalView(url)")).toBeGreaterThan(dev);
    expect(route).toContain("handler: .dev(review: dev.review, entry: dev.entry, bridge: bridge),");
    expect(route).toContain("devServer: url,");
    // This review's id when its link is that server; else one held for the same server.
    const find = between(sheet, "private func devPage(_ url: URL) -> (review: String, entry: URL)? {", "\n    }\n");
    expect(find).toContain("DevPagePath.sameServer(link, url)");
    expect(find).toContain(".first { one in one.id != nil && one.link.flatMap(URL.init(string:)).map { DevPagePath.sameServer($0, url) } == true }?");
    const handler = between(sheet, "static func dev(review: String, entry: URL, bridge: BridgeClient) -> ConchPageSchemeHandler {", "\n    }\n");
    expect(handler).toContain("ConchPageSchemeHandler(entry: entry, describe: BridgeClient.devFailure) { url in");
    expect(handler).toContain("let download = try await bridge.fetchDev(review: review, path: path)");
    expect(handler).toContain('return (download.file, download.header(named: "content-type"))');
  });

  test("a localhost link in the page stays on the review's server; another port is refused where it was tapped", () => {
    const policy = between(sheet, "decidePolicyFor navigationAction: WKNavigationAction,", "\n    }\n");
    expect(policy).toContain("guard let devServer, let url = navigationAction.request.url, MacLocalPage.isLoopback(url) else {");
    const cancel = policy.indexOf("decisionHandler(.cancel)");
    expect(cancel).toBeGreaterThan(-1);
    expect(policy.indexOf("if DevPagePath.sameServer(url, devServer.origin), let kept = DevPagePath.entry(host: devServer.host, for: url) {")).toBeGreaterThan(cancel);
    expect(policy).toContain("webView.load(URLRequest(url: kept))");
    expect(policy).toContain("onRefusedLink(");
    const page = between(sheet, "private struct LocalPageView", "private final class PageLoadFailure");
    expect(page).toContain('context.coordinator.devServer = devServer.map { ($0, url.host ?? "") }');
    expect(page).toContain("context.coordinator.onRefusedLink = onRefusedLink");
  });

  test("no line says a dev server's page can't reach the phone", () => {
    expect(sheet).not.toContain("conch doesn't carry a dev server's pages through the relay yet");
    const view = between(sheet, "private func macLocalView(_ url: URL) -> some View {", "/// Said in the sheet");
    expect(view).toContain("Ask the session to publish the page, and it opens here.");
    const failure = between(bridge, "nonisolated static func devFailure(_ error: Error) -> String {", "\n    }\n");
    for (const status of [403, 503, 502, 404]) expect(failure).toContain(`case BridgeTransportError.httpStatus(${status}):`);
  });
});
