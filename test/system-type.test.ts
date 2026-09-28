import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * conch sets type in SF, the system face, everywhere it draws.
 *
 * The Mac window used to set its own face (`ConchTypography`) while the conversation panel, the
 * canvas and the phone spoke SF. Asked to unify on one, Tyler: "Let's try SF for type." These read
 * the source, since CI builds neither app.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** Every Swift, HTML and CSS source under `dir`, skipping build products. */
function sources(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    if (name === "node_modules" || name === ".build" || name === "build" || name.endsWith(".xcassets")) continue;
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) found.push(...sources(path));
    else if ([".swift", ".html", ".htm", ".css"].includes(extname(name))) found.push(path);
  }
  return found;
}

describe("no source names a face other than the system's", () => {
  const trees = ["mac-app", "mobile", "design/ConchDesign/Sources"];

  test("the trees hold what this walks", () => {
    // A guard over an empty list passes forever. Each tree has to yield its known files.
    const all = trees.flatMap(sources);
    expect(all).toContain("mac-app/conch-mac/Palette.swift");
    expect(all).toContain("mobile/conch-ios/conch-ios/Theme.swift");
    expect(all).toContain("design/ConchDesign/Sources/ConchDesign/Canvas.swift");
    expect(all).toContain("design/ConchDesign/Sources/conch-design-gallery/main.swift");
    expect(all.length).toBeGreaterThan(100);
  });

  for (const tree of trees) {
    test(`${tree}: no Swift, HTML or CSS names Helvetica`, () => {
      expect(sources(tree).filter((path) => /helvetica/i.test(read(path)))).toEqual([]);
    });
  }

  test("the pages conch writes itself ask for the system face", () => {
    // The welcome card (`conch practice`) is HTML that conch renders into its own review pane.
    const practice = read("src/practice.ts");
    expect(practice).not.toMatch(/helvetica/i);
    expect(practice).toContain("font: 15px/1.5 -apple-system, system-ui, sans-serif;");
    expect(practice).toContain("kbd { font: 600 12px/1 -apple-system, system-ui, sans-serif;");
  });
});

describe("the Mac window's type is SF", () => {
  const palette = read("mac-app/conch-mac/Palette.swift");
  const typography = palette.slice(palette.indexOf("enum ConchTypography {"));
  const body = typography.slice(0, typography.indexOf("\n}\n"));

  test("ConchTypography asks the system for its face, by size and weight", () => {
    expect(body.startsWith("enum ConchTypography {")).toBe(true);
    expect(body).toContain(".system(size: size, weight: weight)");
    expect(body).toContain(".systemFont(ofSize: size, weight: weight)");
    // A named face is what the window used to be; the system face has no public name to ask for.
    expect(body).not.toContain(".custom(");
    expect(body).not.toContain("NSFont(name:");
    expect(body).not.toContain("family");
  });

  test("the tightening the old face needed is gone", () => {
    // SF tracks itself per size. The -0.3 on the dashboard's root was inherited by every piece of
    // text in the window, the panel's SF included.
    const dashboard = read("mac-app/conch-mac/DashboardView.swift");
    expect(dashboard).not.toContain(".tracking(-0.3)");
    const windowRoot = dashboard.indexOf(".background(ConchPalette.bg)\n        // No app-wide tracking.");
    expect(windowRoot).toBeGreaterThan(-1);
    const rootModifiers = dashboard.slice(windowRoot);
    expect(rootModifiers.slice(0, rootModifiers.indexOf("\n    }\n"))).not.toContain(".tracking(");
    const fallback = read("mac-app/conch-mac/TranscriptFallback.swift");
    const attributesAt = fallback.indexOf("static func attributes(color: NSColor)");
    expect(attributesAt).toBeGreaterThan(-1);
    const attributes = fallback.slice(attributesAt);
    expect(attributes.slice(0, attributes.indexOf("\n    }\n"))).toContain(".font: ConchTypography.nsFont(size: 16)");
    expect(attributes.slice(0, attributes.indexOf("\n    }\n"))).not.toContain(".kern");
    // The session title's -.01em is the lab's own (`#hdr .ttl`), set against SF, and stays.
    expect(dashboard).toContain(".tracking(-0.14)");
  });
});

test("type drawn with Core Text is SF, through one helper", () => {
  const tokens = read("design/ConchDesign/Sources/ConchDesign/Tokens.swift");
  expect(tokens).toContain("static func coreText(size: CGFloat, bold: Bool = false) -> CTFont {");
  expect(tokens).toContain("CTFontCreateUIFontForLanguage(bold ? .emphasizedSystem : .system, size, nil)");
  const canvas = read("design/ConchDesign/Sources/ConchDesign/Canvas.swift");
  expect(canvas).toContain("let font = ConchType.coreText(size: size)");
  expect(canvas).toContain("let font = ConchType.coreText(size: size, bold: true)");
  const storyboard = read("design/ConchDesign/Sources/ConchDesign/VideoStoryboard.swift");
  expect(storyboard).toContain("let font = ConchType.coreText(size: stampPoints)");
  // A face asked for by name is how a fallback lands somewhere other than SF.
  for (const path of sources("design/ConchDesign/Sources")) {
    expect(`${path}: ${read(path).includes("CTFontCreateWithName(")}`).toBe(`${path}: false`);
  }
});
