import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Agent ink on the phone: an agent's marks (`scene.marks`) land only on the review's own image or page. The iOS app has
 * no test target, so `InkSurface` runs under `swift`.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const ink = read("mobile/conch-ios/conch-ios/AgentInkView.swift");
const swift = Bun.which("swift");

function between(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  expect(at, `missing: ${start}`).toBeGreaterThan(-1);
  const stop = source.indexOf(end, at + start.length);
  expect(stop, `missing after ${start}: ${end}`).toBeGreaterThan(at);
  return source.slice(at, stop);
}

describe("which marks land where", () => {
  test.skipIf(!swift)("an image mark only on the review's own image, a page mark only on the review's own page", () => {
    const surface = between(ink, "enum InkSurface {", "\n}\n") + "\n}\n";
    const dir = mkdtempSync(join(tmpdir(), "conch-ios-ink-"));
    const file = join(dir, "main.swift");
    writeFileSync(file, ["import Foundation", surface,
      'print(InkSurface.sameFile("/Users/t/p/shots/a.png", "/Users/t/p/shots/./a.png"))',
      'print(InkSurface.sameFile("/Users/t/p/shots/a.png", "/Users/t/p/other/../shots/a.png"))',
      'print(InkSurface.sameFile("/Users/t/p/shots/a.png", "/Users/t/p/shots/b.png"))',
      'let entry = URL(string: "conch-page://h/index.html")!',
      'print(InkSurface.isReviewPage(URL(string: "conch-page://h/index.html#faq"), entry: entry))',
      'print(InkSurface.isReviewPage(URL(string: "conch-page://h/other.html"), entry: entry))',
      'print(InkSurface.isReviewPage(URL(string: "https://example.com/"), entry: entry))',
      "print(InkSurface.isReviewPage(nil, entry: entry))",
      // WebKit reports the page it loaded in its own spelling: a path where the link had none, the host in lower case,
      // no default port. Each is the same page as the link an agent wrote.
      'print(InkSurface.isReviewPage(URL(string: "http://127.0.0.1:5173/"), entry: URL(string: "http://127.0.0.1:5173")!))',
      'print(InkSurface.isReviewPage(URL(string: "http://localhost:5173/app?tab=2"), entry: URL(string: "http://LocalHost:5173/app?tab=2")!))',
      'print(InkSurface.isReviewPage(URL(string: "https://example.com/a#b"), entry: URL(string: "https://example.com:443/a")!))',
      'print(InkSurface.isReviewPage(URL(string: "http://example.com/"), entry: URL(string: "http://example.com:80")!))',
      // Still another page: another port, path or query.
      'print(InkSurface.isReviewPage(URL(string: "http://example.com:8080/"), entry: URL(string: "http://example.com/")!))',
      'print(InkSurface.isReviewPage(URL(string: "http://example.com/b"), entry: URL(string: "http://example.com/a")!))',
      'print(InkSurface.isReviewPage(URL(string: "http://example.com/a?x=2"), entry: URL(string: "http://example.com/a?x=1")!))',
    ].join("\n"));
    try {
      const run = Bun.spawnSync([swift!, file], { stdout: "pipe", stderr: "pipe" });
      if (run.exitCode !== 0) throw new Error(run.stderr.toString());
      expect(run.stdout.toString().trim().split("\n")).toEqual(["true", "true", "false", "true", "false", "false", "false", "true", "true", "true", "true", "false", "false", "false"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
