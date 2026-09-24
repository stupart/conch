import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Tyler (2026-09-24): "some deliverable images aren't showing in the app like as html site
// images are missing but they work when u click to see them outside". The brand session's
// characters page loads 6 of its 52 images from `../scenes/`, outside its own folder, which a
// read scope of the page's folder blocked. conch-mac has no XCTest target, so this reads source.
test("a local page may read what it links to anywhere, as a browser opening it would", () => {
  const web = readFileSync(`${import.meta.dir}/../mac-app/conch-mac/WebView.swift`, "utf8");
  expect(web).toContain('allowingReadAccessTo: URL(fileURLWithPath: "/", isDirectory: true)');
  expect(web).not.toContain("allowingReadAccessTo: url.deletingLastPathComponent()");
});
