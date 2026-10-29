import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Atlas pages' wiki links, in the Mac app. Tyler, 2026-10-28: "looks like the '← Back to [[projects/index|Projects]]'
 * button doesn't work. How are we showing the Atlas pages in conch and what is the proper way?"
 *
 * `atlas_show` saves the page's Markdown as the agent read it to ~/Documents/conch-notes/atlas/<path> and files it as a
 * markdown deliverable; the pane rendered it, and a wiki link, which CommonMark doesn't have, was its brackets as text.
 * Now the shared renderer makes each one a link to `atlas:<path>` (ConchDesign's AtlasLink, tested in
 * AtlasLinkTests.swift), and a click opens conch's saved copy of the page in the pane, or says it isn't saved and offers
 * to ask the session that showed it. conch never reads Atlas itself. conch-mac has no XCTest target, so this pins the
 * wiring; the views were checked by picture in a sandboxed harness built from these sources.
 */
const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const review = read("mac-app/conch-mac/ReviewView.swift");
const slice = (text: string, start: string, end: string) => {
  expect(text).toContain(start);
  const from = text.indexOf(start);
  expect(text.indexOf(end, from)).toBeGreaterThan(from);
  return text.slice(from, text.indexOf(end, from));
};

describe("a link in a rendered document goes where it means", () => {
  const document = slice(review, "private struct DeliverableDocumentView", "private struct DeliverableImageView");

  test("a heading in the document is scrolled to, an Atlas page goes to the pane, and the rest to the door", () => {
    const click = slice(document, "func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool", "func makeCoordinator()");
    const anchor = click.indexOf("MarkdownAnchor.target(of: link)");
    const atlas = click.indexOf("AtlasLink.page(of: LinkTarget.text(of: link))");
    const door = click.indexOf("onOpenLink(LinkTarget.text(of: link))");
    expect(anchor).toBeGreaterThan(-1);
    expect(atlas).toBeGreaterThan(anchor);
    expect(door).toBeGreaterThan(atlas);
    expect(click).toContain("textView.scrollToMarkdownAnchor(anchor)");
    // A link to the page already shown moves only to its heading.
    expect(click).toContain("page.copy().standardizedFileURL == loadedURL?.standardizedFileURL");
    // With the link's words, to name the page by, and where the document was, for Back to return to.
    expect(click).toContain("onOpenAtlas(AtlasFollow(page: page, words: said.isEmpty ? nil : said, offset: textView.enclosingScrollView?.contentView.bounds.minY ?? 0))");
  });

  test("a page a link led to opens at its top, or at the heading the link named", () => {
    expect(document).toContain("scrollView.contentView.scroll(to: .zero)");
    expect(document).toContain("DispatchQueue.main.async { textView.scrollToMarkdownAnchor(anchor) }");
    // Headings carry their anchors from the typesetter both AppKit views share.
    expect(review).toContain("storage.enumerateAttribute(MarkdownTypesetter.anchorKey");
    expect(read("design/ConchDesign/Sources/ConchDesign/Markdown.swift")).toContain("output.addAttribute(anchorKey");
    // The conversation's AppKit renderer scrolls to one too.
    expect(read("mac-app/conch-mac/TranscriptFallback.swift")).toContain("textView.scrollToMarkdownAnchor(anchor)");
  });
});

describe("the pane follows a wiki link to conch's copy, or says it has none", () => {
  const content = slice(review, "private struct ReviewContent: View {", "private func retryNavigation()");

  test("the filed document, or the page the last link led to; a page with no copy says so", () => {
    expect(content).toContain("let url = atlasTrail.last?.copy ?? filed");
    expect(content).toContain("if let stop = atlasTrail.last, stop.copy == nil {");
    expect(content).toContain("AtlasPageUnsavedView(");
    expect(content).toContain("followAtlas(followed, from: url)");
    // Back returns to where the page was left; the page a link led to opens at its top or its heading.
    expect(review).toContain("returnOffset = left.fromOffset");
    expect(content).toContain("offset: returnOffset");
    // Back, and the pane's own controls on the line while it is up, instead of the corner's circles over it.
    expect(content).toContain("AtlasTrailLine(page: stop.page, back: stop.back, onBack: atlasBack) {");
    expect(content).toContain(".onChange(of: atlasTrail.isEmpty) { _, empty in onTrail(!empty) }");
    // Only the way out goes on the line, and only to a copy: Compare is the filed deliverable's.
    expect(content).toContain("ForEach(stop.copy == nil ? [] : lineControls.filter { !$0.comparesVersions }) { control in");
    expect(review).toContain("if !opensFromAddressLine, !controlsOnTrail {");
    expect(review).toContain('.keyboardShortcut("[", modifiers: .command)');
  });

  test("a copy is looked for where atlas_show saves it, and the way out opens the copy on screen", () => {
    const follow = slice(review, "private func followAtlas(", "private static func markdownTitle(");
    expect(follow).toContain("let copy = page.copy()");
    expect(follow).toContain("FileManager.default.fileExists(atPath: copy.path)");
    expect(follow).toContain("liveAddress = saved ? copy.path : nil");
    const folder = read("design/ConchDesign/Sources/ConchDesign/AtlasLink.swift");
    expect(folder).toContain('environment["CONCH_ATLAS_COPIES"]');
    expect(folder).toContain('.appendingPathComponent("conch-notes", isDirectory: true)');
    expect(read("src/atlas-copies.ts")).toContain('export const ATLAS_COPIES_PARTS = ["Documents", "conch-notes", "atlas"] as const;');
  });

  test("an unsaved page is asked of the session that showed it, only when Tyler presses it, through the inject path", () => {
    const ask = slice(review, "private func askForAtlasPage(", "static func atlasPagePrompt(");
    expect(ask).toContain("store.send(.inject(sessionId: row.id, label: row.label, text: Self.atlasPagePrompt(page, from: source)))");
    // Asked once; a send that fails puts the button back.
    expect(ask).toContain("Task { if !(await delivery.value) { askedForPages.remove(page.name) } }");
    const prompt = slice(review, "static func atlasPagePrompt(", "\n    }\n");
    expect(prompt).toContain("read it with your Atlas tools and show it to me with atlas_show");
    const view = slice(review, "private struct AtlasPageUnsavedView: View {", "\n}\n");
    expect(view).toContain("isn\\u{2019}t saved in conch yet");
    expect(view).toContain("conch can\\u{2019}t read Atlas itself.");
    expect(view).toContain('Button("Ask \\(session) for it", action: onAsk)');
    expect(view).toContain(".disabled(asked)");
  });
});

describe("the one door: an Atlas page or a heading never reaches Finder", () => {
  const store = read("mac-app/conch-mac/StateStore.swift");
  const door = slice(store, "func openLink(", "private var errorStateSnapshot");

  test("a heading link opens nothing, and an Atlas link opens its copy or says why it can't", () => {
    expect(door.indexOf('if link.hasPrefix("#") { return }')).toBeLessThan(door.indexOf("LinkTarget.url(for: link, cwd: cwd)"));
    expect(door).toContain("let atlasPage = AtlasLink.page(of: link)");
    expect(door).toContain("isn\\u{2019}t saved in conch yet. conch can\\u{2019}t read Atlas itself: ask the session to show you the page.");
    expect(door).toContain("var url = atlasPage?.copy() ?? LinkTarget.url(for: link, cwd: cwd)");
    // conch has no Atlas credential and asks for none: nothing here talks to Atlas.
    expect(review + store).not.toMatch(/atlas-loop-kernel|ai\.atlas\.|find-generic-password/);
  });
});
