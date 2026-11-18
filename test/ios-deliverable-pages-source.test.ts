import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A local page on the phone is served from `conch-page://<id>/…`, each request one `/file` read over whichever
 * transport is live; a markdown document's pictures come the same way. The iOS app has no test target, so the
 * Foundation-only pieces run under `swift`. The Mac's own rule is in phone-bridge.test.ts.
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

describe("the page never sees the pairing's token", () => {
  test("the scheme handler names no token, and the only query-string token is the LAN websocket's, which WebKit never sees", () => {
    expect(handler).not.toMatch(/token|bearer/i);
    const queryTokens = ["BridgeClient.swift", "DeliverableSheet.swift", "DirectHTTPTransport.swift", "RelayTransport.swift"]
      .map((name) => (ios(name).match(/URLQueryItem\(name: "token"/g) ?? []).length);
    expect(queryTokens).toEqual([0, 0, 1, 0]);
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
});
