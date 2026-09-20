import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The deliverable pane browses the web.
 *
 * It used to refuse: a top-level navigation off the surfaced origin was handed to Safari, and
 * anything but http/https/the one published file was blocked outright. Tyler asked for it to
 * browse instead (2026-09-20), so the boundary moved from ENFORCED to DISCLOSED — anywhere on
 * the web is reachable, and the bar always says where you actually are.
 *
 * That trade only holds while the bar is honest, which is what most of this file pins. None of
 * it existed before: the old lock had no test at all, so nothing would have caught its removal.
 * These are the guards that replace it.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const swift = (path: string) => source(path).replace(/^\s*\/\/.*$/gm, "");
const web = swift("mac-app/conch-mac/WebView.swift");
const review = swift("mac-app/conch-mac/ReviewView.swift");

describe("the pane browses, and says where it is", () => {
  test("the web is reachable, and nothing is bounced to Safari any more", () => {
    // Whitespace-tolerant on purpose: `swift()` strips line comments but leaves the blank
    // lines behind, so pinning the exact gap between the case and its return pins a
    // comment-stripper's output rather than the code. The association is what matters.
    expect(web).toMatch(/case "http", "https":\s*return \.allow/);
    // The bounce and its case are gone rather than left unreachable — a dead branch named
    // after a boundary reads as though the boundary is still there.
    expect(web).not.toContain("openExternally");
    expect(web).not.toContain("offerExternalNavigation");
    expect(web).not.toContain("surfacedOrigin");
  });

  /**
   * The whole trade rests on this. With navigation free, a bar derived from the FILED link
   * would confidently name the wrong origin the moment you moved — the exact confusion the
   * boundary existed to prevent, now wearing a badge that says it is fine.
   */
  test("the address is read from where the view actually is", () => {
    expect(web).toContain("@Binding var currentLink: String?");
    expect(web).toContain("urlObservation = webView.observe(\\.url, options: [.initial, .new])");
    expect(web).toContain("context.coordinator.observeCurrentURL(of: webView)");
    // Invalidated with its sibling, or the observation outlives the view.
    const stop = web.slice(web.indexOf("func stopObservingLoadingState()"));
    expect(stop.slice(0, 400)).toContain("urlObservation?.invalidate()");

    expect(review).toContain("private var addressText: String { liveLink ?? shownLink }");
    expect(review).toContain("URL(string: addressText)");
    expect(review).toContain("currentLink: $liveLink");
  });

  /**
   * Free navigation was asked for so the pane can BROWSE. Reading arbitrary local files is a
   * different power that nobody asked for, and the published file is still the only one this
   * pane was ever handed.
   */
  test("local files stay locked to the one that was published", () => {
    expect(web).toContain("Local file navigation is limited to the exact file published for review.");
    expect(web).toContain("destination.standardizedFileURL.path");
    // And a scheme that is neither http, https nor file is still refused outright.
    expect(web).toContain("URL scheme is not allowed in the review.");
  });

  /**
   * `DeliverableLink.url(for:)` turns a schemeless string into a FILE path, so routing typed
   * text through it would have read "github.com" as a file on this Mac.
   */
  test("a typed address is a web address, never a file path", () => {
    // Searched FORWARD from the start, not by a marker hoped to be unique. `originText` sits
    // above this function and `@Binding var isWebLoading` appears twice in the file, so both
    // of my first two end markers resolved to a position BEFORE the start and sliced nothing.
    // An offset search cannot invert.
    const start = review.indexOf("static func webDestination(from typed: String) -> String? {");
    expect(start).toBeGreaterThan(-1);
    const parse = review.slice(start, review.indexOf("@Binding var isWebLoading", start));
    expect(parse.length).toBeGreaterThan(100);
    expect(parse).toContain('return (scheme == "http" || scheme == "https") ? trimmed : nil');
    expect(parse).toContain('return "https://" + trimmed');
    expect(parse).not.toContain("DeliverableLink");
  });

  test("a typed destination wins over the filed link, without losing it", () => {
    expect(review).toContain("private var shownLink: String { destination ?? link }");
    expect(review).toContain("link: shownLink,");
  });
});
