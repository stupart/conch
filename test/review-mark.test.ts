import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/**
 * One fleet, one mark for "there is work to look at".
 *
 * #302 moved seven sites in the Mac and iOS apps from a star to a green check, after Tyler:
 * "review ready already has big green check i dont think we also need to bold it." The two
 * terminal surfaces were not part of that slice, so for a week the same session showed a
 * star in tmux and a check in both apps.
 *
 * Green because that is what the apps draw: `ConchColor.ready` is #30B35A, and the lab's
 * `--ready` is the same. `\x1b[32m` is the terminal's green; the star's `\x1b[33m` was yellow.
 */
test("the terminal marks a review with a green check, not a star", () => {
  for (const path of ["src/status.ts", "src/panel.ts"]) {
    expect(read(path), path).not.toContain("⭐");
  }
  expect(read("src/status.ts")).toContain('review: "\\x1b[32m✓\\x1b[39m"');
  expect(read("src/status.ts")).toContain('"\\x1b[32m✓ needs review\\x1b[39m"');
  expect(read("src/panel.ts")).toContain('const REVIEW_GLYPH = "\\x1b[32m✓ needs review\\x1b[0m"');
});

/** The deliverable line above a reply carries the same mark as the row that announced it. */
test("the inline deliverable uses the same mark", () => {
  expect(read("src/status.ts")).toContain("? [`✓ ${review.summary}`,");
});

/**
 * Both apps still say it too — this is a cross-surface agreement, and asserting only the
 * terminal half would let the apps drift back without anything noticing.
 */
test("both apps still draw the check they settled on", () => {
  expect(read("mac-app/conch-mac/DashboardView.swift")).toContain('return "checkmark.circle.fill"');
  expect(read("mac-app/conch-mac/ConversationStackView.swift")).toContain(
    'Label(item.text, systemImage: "checkmark.circle.fill")',
  );
  expect(read("mobile/conch-ios/conch-ios/Models.swift")).toContain(
    'case .review: "checkmark.circle.fill"',
  );
});

/**
 * Speech must not read the glyph aloud. `✓` is U+2713, inside the `☀-➿` block that
 * snippet.ts strips before a line is spoken — the same reason the star was safe.
 */
test("the mark is stripped before anything is spoken", async () => {
  // Measured, not inferred: a range can be present and still not cover the glyph, and the
  // failure mode here is audible — conch reading "check needs review" into your ear.
  const { speakable } = await import(join(root, "src", "snippet.ts"));
  expect(speakable("✓ needs review")).toBe("needs review");
  expect(speakable("✓ Hero v3 render")).toBe("Hero v3 render");
  // U+2713 sits in the misc-symbols block snippet.ts drops, the same block that held the star.
  expect("✓".codePointAt(0)).toBe(0x2713);
  expect(read("src/snippet.ts")).toContain("u2600-");
});
