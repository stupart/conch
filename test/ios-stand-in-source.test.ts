import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The phone's side of a snapshot (review-preview.test.ts has the Mac's): the review decodes its snapshot, and one
 * without a readable one still decodes. The iOS app has no test target, so the model decode runs under `swift`.
 */
const root = join(import.meta.dir, "..");
const ios = (name: string): string => readFileSync(join(root, "mobile/conch-ios/conch-ios", name), "utf8");
const models = ios("Models.swift");
const swift = Bun.which("swift");

describe("a review's snapshot", () => {
  test.skipIf(!swift)("the review decodes its snapshot and a live page's, and a review without one, or an unreadable one, still decodes", () => {
    const start = models.indexOf("        struct Review: Decodable, Equatable {");
    const review = models.slice(start, models.indexOf("\n        }\n", start) + 10);
    const mark = models.slice(models.indexOf("struct AgentMark: Decodable"), models.indexOf("\n}\n", models.indexOf("struct AgentMark: Decodable")) + 3);
    const dir = mkdtempSync(join(tmpdir(), "conch-ios-standin-"));
    const file = join(dir, "main.swift");
    // A live page's login-wall check (src/page-access.ts) is read with ConchDesign's own type.
    const access = readFileSync(join(root, "design/ConchDesign/Sources/ConchDesign/PageAccess.swift"), "utf8").replace(/^import Foundation\n/m, "");
    writeFileSync(file, ["import Foundation", "import CoreGraphics", review, mark, access,
      "func show(_ json: String) {",
      "  let r = try! JSONDecoder().decode(Review.self, from: Data(json.utf8))",
      '  print(r.preview.map { "\\($0.path)@\\(Int($0.capturedAt))" } ?? "none")',
      "}",
      "func live(_ json: String) {",
      "  let r = try! JSONDecoder().decode(Review.self, from: Data(json.utf8))",
      '  print("\\(r.snapshot.map { "\\($0.path)@\\(Int($0.capturedAt))" } ?? "none")|\\(r.access.map { "\\($0.mac.rawValue)/\\($0.anonymous.rawValue)" } ?? "none")")',
      "}",
      'show(#"{"summary":"sim","kind":"simulator","preview":{"path":"/tmp/conch-previews/a.png","kind":"image","capturedAt":1727000000000}}"#)',
      'show(#"{"summary":"sim","kind":"simulator"}"#)',
      'show(#"{"summary":"sim","preview":{"path":42}}"#)',
      // A live page as the Mac drew it, and what each look found; a newer state reads unchecked; junk is none.
      'live(#"{"summary":"dash","kind":"url","link":"https://x.test","snapshot":{"path":"/c/a.png","capturedAt":1790000000000},"access":{"mac":"page","anonymous":"sign-in"}}"#)',
      'live(#"{"summary":"dash","kind":"url","access":{"mac":"captcha","anonymous":"page"}}"#)',
      'live(#"{"summary":"dash","snapshot":{"path":7},"access":"yes"}"#)',
    ].join("\n"));
    try {
      const run = Bun.spawnSync([swift!, file], { stdout: "pipe", stderr: "pipe" });
      if (run.exitCode !== 0) throw new Error(run.stderr.toString());
      expect(run.stdout.toString().trim().split("\n")).toEqual([
        "/tmp/conch-previews/a.png@1727000000000", "none", "none",
        "/c/a.png@1790000000000|page/sign-in", "none|unchecked/page", "none|none",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
