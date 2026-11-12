import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Agent ink's shared pieces in ConchDesign (AgentInk.swift): the script that finds a selector or a quote in a page, run by
// the Mac's page capture and annotation and by the phone's ink alike, and the placement that refuses rather than guesses.
// 2026-11-11: these were canvas-source's; the canvas and the marks it drew over other apps went with the old overlays, and
// what they shared with the rest of conch is guarded here.

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const placing = read("design/ConchDesign/Sources/ConchDesign/AgentInk.swift");

test("the script that finds a selector or a quote only reads the page", () => {
  const start = placing.indexOf('public static let finder = """');
  const finder = placing.slice(start, placing.indexOf('"""\n', start + 30));
  expect(finder.length).toBeGreaterThan(400);
  // Nothing that changes the DOM, styles, the selection, the scroll, or leaves anything behind.
  for (const writes of [
    "appendChild", "insertBefore", "removeChild", ".remove(", "replaceWith", "innerHTML", "outerHTML", "insertAdjacent",
    "setAttribute", "removeAttribute", "classList", ".style", "textContent =", ".data =", "document.write",
    "getSelection", "addRange", "window.find", "execCommand", "scrollTo", "scrollBy", "scrollIntoView", "focus(",
    "click(", "dispatchEvent", "addEventListener", "localStorage", "fetch(",
  ]) {
    expect(finder, writes).not.toContain(writes);
  }
  // The one global it reads, and only these reads.
  expect(finder.match(/window\.[a-zA-Z]+/g)?.sort()).toEqual(["window.innerWidth", "window.visualViewport"]);
  expect(finder).toContain("document.querySelector(what)");
  expect(finder).toContain("const range = document.createRange();");
  // Nothing is spliced into the source: the strings go as arguments.
  expect(finder).not.toContain("\\(");
});

test("a mark is drawn only where it was found: the placement refuses rather than guesses", () => {
  expect(placing).toContain("guard let at, let to else { return nil }");
  expect(placing).toContain("guard size.width > 0, size.height > 0, element.width > 0, element.height > 0 else { return nil }");
  // The agent's kinds are the daemon's, one for one, on the Mac as in the shared package.
  const kinds = (source: string) => source.match(/case arrow, box, ellipse, highlight, text, pin, stroke\n/g)?.length;
  expect(kinds(placing)).toBe(1);
  expect(kinds(read("mac-app/conch-mac/Models.swift"))).toBe(1);
});
