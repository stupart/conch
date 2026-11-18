import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A page a session published at its Mac's localhost opens on the phone as `conch-dev://<id>/…`, each request read
 * through `/dev` (phone-dev-proxy.test.ts has the Mac's rules). The iOS app has no test target, so these Foundation
 * pieces run under `swift`.
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
