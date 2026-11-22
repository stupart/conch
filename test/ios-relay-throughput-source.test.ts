import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The phone's half of relay throughput (the Mac's is in phone-relay.test.ts and phone-bridge.test.ts): text crosses the
 * relay gzipped, and a file read before comes back as a 304 from the phone's cache. The iOS app has no test target, so
 * these Foundation pieces run under `swift`.
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

  test.skipIf(!swift)("FileCache stays under its total: the files kept or used longest ago go first, their versions with them", () => {
    const cache = between(bridge, "enum FileCache {", "\n}\n") + "\n}\n";
    const out = runSwift([
      "import CryptoKit",
      "import Foundation",
      cache,
      'FileCache.folder = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("cache")',
      "FileCache.totalBytes = 10_000",
      "func keep(_ name: String, _ bytes: Int) {",
      '    let source = URL(fileURLWithPath: name)',
      "    try! Data(count: bytes).write(to: source)",
      '    FileCache.keep(source, version: "v-\\(name)", for: "/Mac/\\(name)")',
      "    Thread.sleep(forTimeInterval: 0.02)",
      "}",
      'keep("a.png", 4_000); keep("b.png", 4_000)',
      // Used again (a 304 answered from it): it is the newest now.
      '_ = try! FileCache.copy(of: "/Mac/a.png")',
      "Thread.sleep(forTimeInterval: 0.02)",
      'keep("c.png", 4_000)',
      'print(["a.png", "b.png", "c.png"].map { FileCache.version(of: "/Mac/\\($0)") ?? "gone" }.joined(separator: " "))',
      'print((try? FileCache.copy(of: "/Mac/b.png")) == nil)',
      'keep("d.png", 9_000)',
      'print(["a.png", "c.png", "d.png"].map { FileCache.version(of: "/Mac/\\($0)") ?? "gone" }.joined(separator: " "))',
      'let left = try! FileManager.default.contentsOfDirectory(atPath: FileCache.folder.path).filter { !$0.hasSuffix(".etag") }',
      "print(left.count)",
    ]);
    expect(out).toEqual(["v-a.png gone v-c.png", "true", "gone gone v-d.png", "1"]);
  }, 60_000);
});
