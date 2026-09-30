import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Text files in a deliverable are shown as text, decided by `DeliverableText` in ConchDesign (its own tests are
 * DeliverableTextTests.swift): Tyler clicked `starter-prompts.ts` in a published folder and got "Couldn't load
 * deliverable — Frame load interrupted", because the Mac handed every name it didn't know to WebKit, which took `.ts` for
 * an MPEG transport stream. conch-mac has no XCTest target, so this pins the routers that call it.
 */
const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

describe("the viewers route text by DeliverableText, not by WebKit's guess", () => {
  test("the Mac shows text as text and sends only the rest to the web view", () => {
    const review = read("mac-app/conch-mac/ReviewView.swift");
    const router = review.slice(review.indexOf("enum DeliverableSource"), review.indexOf("private static func localFileURL"));
    expect(router).toContain("self = DeliverableText.isText(path: localURL.path) ? .text(localURL) : .web");
    // Its own short list is gone: one list, shared with the phone.
    expect(router).not.toContain("textExtensions");
    // Images, PDFs, video, markdown and the unpreviewable keep their own routes, ahead of it.
    const text = router.indexOf("DeliverableText.isText");
    for (const route of ["self = .image(localURL)", "self = .pdf(localURL)", "self = .video(localURL)", "self = .markdown(localURL)", "self = .unsupported(localURL)"]) {
      expect(router.indexOf(route)).toBeGreaterThan(-1);
      expect(router.indexOf(route)).toBeLessThan(text);
    }
    // Text is the monospaced document view, capped at 2MB, which a folder's picked file goes through too.
    expect(review).toContain("DeliverableDocumentView(url: url, renderMarkdown: false");
    expect(review).toContain("private static let maxBytes = 2 * 1024 * 1024");
    expect(review.slice(review.indexOf("struct WorkspaceFilesView"))).toContain("ReviewContent(\n                        link: selected,");
  });

  test("the phone decides by the same names, keeping a .ts as text as it did", () => {
    const sheet = read("mobile/conch-ios/conch-ios/DeliverableSheet.swift");
    expect(sheet).toContain("return (DeliverableText.byName(link) ?? DeliverableText.ambiguous.contains(ext)) ? .local(.text) : .local(.unsupported)");
    expect(sheet).toContain('case "html", "htm", "svgz":\n            return .local(.page)');
  });
});
