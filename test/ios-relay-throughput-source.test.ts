import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The phone's half of relay throughput (the Mac's is in phone-relay.test.ts and
 * phone-bridge.test.ts). The live log, 9/25 01:24: "phone relay rejected a frame: Error: relay
 * chunk acknowledgement timed out" — the app went to the background mid-download and its socket
 * just closed. It now says goodbye first; and a file it has read before comes back as a 304, text
 * gzipped. The iOS app has no test target, so the Foundation pieces run under `swift` and the
 * rest is read the way the other ios-*.test.ts do.
 */
const root = join(import.meta.dir, "..");
const ios = (name: string): string => readFileSync(join(root, "mobile/conch-ios/conch-ios", name), "utf8");
const swift = Bun.which("swift");
const relay = ios("RelayTransport.swift");
const bridge = ios("BridgeClient.swift");

function between(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  expect(at, `missing: ${start}`).toBeGreaterThan(-1);
  const stop = source.indexOf(end, at + start.length);
  expect(stop, `missing after ${start}: ${end}`).toBeGreaterThan(at);
  return source.slice(at, stop);
}

function runSwift(lines: string[], setup?: (dir: string) => void): string[] {
  const dir = mkdtempSync(join(tmpdir(), "conch-ios-throughput-"));
  setup?.(dir);
  const file = join(dir, "main.swift");
  writeFileSync(file, lines.join("\n"));
  try {
    const run = Bun.spawnSync([swift!, file], { stdout: "pipe", stderr: "pipe", cwd: dir });
    if (run.exitCode !== 0) throw new Error(`swift exited ${run.exitCode}: ${run.stderr.toString()}`);
    return run.stdout.toString().trim().split("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("going to the background mid-download", () => {
  test("the phone cancels what it was downloading before its socket goes, and a reconnect meanwhile wins", () => {
    const stop = between(relay, "    func stop() async {", "\n    }\n");
    const cancel = stop.indexOf("try? await sendCancellation(");
    const guarded = stop.indexOf("guard stopped else { return }");
    const retire = stop.indexOf("retireSocket()");
    expect(cancel).toBeGreaterThan(-1);
    expect(stop).toContain("where request.sentSessionGeneration == sessionGeneration");
    expect(stop).toContain('(request.request.method == "GET" || request.request.method == "HEAD")');
    expect(guarded).toBeGreaterThan(cancel);
    expect(retire).toBeGreaterThan(guarded);
  });
});

describe("a file read twice is a 304; text crosses gzipped", () => {
  test.skipIf(!swift)("Gzip.inflate undoes Bun's gzip, empty included, and refuses what isn't gzip", () => {
    const gzip = relay.slice(relay.indexOf("enum Gzip {"));
    const css = "body { color: red }\n".repeat(200);
    const out = runSwift([
      "import Foundation",
      gzip,
      'for name in ["css.gz", "empty.gz"] {',
      "  let out = Gzip.inflate(try! Data(contentsOf: URL(fileURLWithPath: name)))",
      '  print(out.map { String(decoding: $0, as: UTF8.self) == (name == "css.gz" ? CSS : "") ? "same" : "differs" } ?? "nil")',
      "}",
      'print(Gzip.inflate(Data("not gzip, but long enough".utf8)) == nil ? "nil" : "decoded")',
      "print(Gzip.inflate(try! Data(contentsOf: URL(fileURLWithPath: \"css.gz\")).dropLast(9)) == nil ? \"nil\" : \"decoded\")",
    ].map((line) => line.replace("CSS", JSON.stringify(css))), (dir) => {
      writeFileSync(join(dir, "css.gz"), Bun.gzipSync(new TextEncoder().encode(css)));
      writeFileSync(join(dir, "empty.gz"), Bun.gzipSync(new Uint8Array()));
    });
    expect(out).toEqual(["same", "same", "nil", "nil"]);
  }, 60_000);

  test.skipIf(!swift)("FileCache keeps a version, hands out copies, skips what is too big, and forgets with the pairing", () => {
    const cache = between(bridge, "enum FileCache {", "\n}\n") + "\n}\n";
    const out = runSwift([
      "import CryptoKit",
      "import Foundation",
      cache,
      'FileCache.folder = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("cache")',
      'let source = URL(fileURLWithPath: "page.css")',
      'try! "body{}".write(to: source, atomically: true, encoding: .utf8)',
      'print(FileCache.version(of: "/Mac/site/page.css") ?? "none")',
      'FileCache.keep(source, version: "W/\\"v1\\"", for: "/Mac/site/page.css")',
      'print(FileCache.version(of: "/Mac/site/page.css") ?? "none")',
      'let copy = try! FileCache.copy(of: "/Mac/site/page.css")',
      'print(copy.pathExtension, try! String(contentsOf: copy, encoding: .utf8))',
      'try! FileManager.default.removeItem(at: copy)',
      'print((try? FileCache.copy(of: "/Mac/site/page.css")) != nil)',
      'let big = URL(fileURLWithPath: "big.bin")',
      "try! Data(count: FileCache.maxBytes + 1).write(to: big)",
      'FileCache.keep(big, version: "W/\\"v2\\"", for: "/Mac/big.bin")',
      'print(FileCache.version(of: "/Mac/big.bin") ?? "none")',
      "FileCache.forget()",
      'print(FileCache.version(of: "/Mac/site/page.css") ?? "none")',
    ]);
    expect(out).toEqual(["none", 'W/"v1"', "css body{}", "true", "none", "none"]);
  }, 60_000);

  test("fetchFile sends the version it holds, keeps what comes back, and answers a 304 from the copy", () => {
    const fetch = between(bridge, "func fetchFile(path: String) async throws -> URL {", "\n    }\n");
    expect(fetch).toContain("let held = FileCache.version(of: path)");
    expect(fetch).toContain('headers: authorized.headers + [["if-none-match", $0]]');
    expect(fetch).toContain('if let version = download.header(named: "etag") { FileCache.keep(download.file, version: version, for: path) }');
    expect(fetch).toContain("} catch BridgeTransportError.httpStatus(304) where held != nil {");
    expect(fetch).toContain("return try FileCache.copy(of: path)");
    expect((fetch.match(/await Self\.fileReads\.leave\(\)/g) ?? []).length).toBe(3);
    // Another Mac's files are never this one's.
    expect(between(ios("ConchApp.swift"), "static func forget(file: URL", "\n    }\n")).toContain("FileCache.forget()");
  });

  test("the relay asks for gzip and undoes it; the LAN leaves both to URLSession", () => {
    const download = between(relay, "    func download(_ request: BridgeRequest) async throws -> BridgeDownload {\n        try Task.checkCancellation()", "\n    }\n");
    expect(download).toContain('headers: request.headers + [["accept-encoding", "gzip"]]');
    const finish = between(relay, "    private func finish(_ request: RelayPendingRequest, status: Int) {", "\n    }\n");
    expect(finish).toContain('$0[0].lowercased() == "content-encoding" && $0[1].lowercased() == "gzip"');
    expect(finish).toContain("guard let inflated = Gzip.inflate(try Data(contentsOf: temporary)) else {");
    expect(ios("DirectHTTPTransport.swift")).not.toContain("accept-encoding");
  });
});
