import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/**
 * The app is called conch. It does not wear a shell.
 *
 * Tyler: "probably time to remove the emoji from the app names too."
 *
 * Both bundles were already plain — `CFBundleDisplayName` is `conch` on the Mac and the
 * phone, and iOS had already swapped its 🐚 for the real icon ("The real icon, not the 🐚
 * emoji it replaced", PairingView). The terminal was the last surface still wearing one, in
 * the dashboard header, the CLI banner, the setup banner and the README title.
 */
test("no surface names the app with an emoji", () => {
  for (const path of ["src/panel.ts", "src/cli.ts", "src/install.ts", "README.md"]) {
    expect(read(path), path).not.toContain("🐚");
  }
});

/**
 * The same shell, spelled as an escape.
 *
 * #309 removed the literal 🐚 and missed `Text("\u{1F41A}")` in both apps' headers, because
 * the sweep looked for the character and the source wrote the code point. Tyler circled the
 * survivor on his phone. A sweep for one spelling of a glyph is not a sweep for the glyph.
 */
test("nor with the same emoji written as a code point", () => {
  const surfaces = [
    "mac-app/conch-mac/DashboardView.swift",
    "mobile/conch-ios/conch-ios/LedgerView.swift",
    "mac-app/conch-mac/SettingsView.swift",
    "mobile/conch-ios/conch-ios/PairingView.swift",
  ];
  // No source writes the code point in prose, so this sweep is safe everywhere — and it is the
  // spelling that survived #309 and shipped to both headers.
  for (const path of surfaces) {
    expect(read(path), path).not.toContain("1F41A");
  }
  // The literal character appears in exactly one comment, which explains why the pairing
  // screen replaced the emoji with the real mark. Deleting that would delete the reason.
  for (const path of surfaces.filter((p) => !p.endsWith("PairingView.swift"))) {
    expect(read(path), path).not.toContain("🐚");
  }
  const pairing = read("mobile/conch-ios/conch-ios/PairingView.swift");
  expect(pairing).toContain("The real icon, not the 🐚 emoji it replaced");
  expect(pairing.match(/🐚/g) ?? []).toHaveLength(1);
});

/**
 * What stays: the drawn mark. `PairingView` shows `Image("ConchMark")` and the menu bar draws
 * `ConchMark.statusImage` — those ARE the icon, and the pairing screen's own comment records
 * why it replaced the emoji in the first place.
 */
test("the real mark is untouched", () => {
  expect(read("mobile/conch-ios/conch-ios/PairingView.swift")).toContain('Image("ConchMark")');
  expect(read("mac-app/conch-mac/StatusItem.swift")).toContain("ConchMark.statusImage(for: voice, side: 18)");
});

/** The bundles were already clean; this keeps them that way. */
test("both bundles are plainly named", () => {
  for (const plist of ["mac-app/conch-mac/Info.plist", "mobile/conch-ios/conch-ios/Info.plist"]) {
    const text = read(plist);
    expect(text, plist).toContain("<string>conch</string>");
    expect(text, plist).not.toContain("🐚");
  }
});

/**
 * The dashboard still names itself — the emoji went, the word stayed. Asserted because
 * deleting the glyph by hand is one keystroke away from deleting the header with it.
 */
test("the terminal dashboard still says conch", () => {
  expect(read("src/panel.ts")).toContain('"  \\x1b[1mconch\\x1b[0m"');
  expect(read("src/cli.ts")).toContain('console.log("conch dashboard');
  expect(read("src/install.ts")).toContain('console.log("conch setup');
});

/**
 * NOT touched, deliberately: several tests carry a 🐚 as fixture data because it is a
 * four-byte character, and they exist to prove a frame split mid-character still decodes.
 * Removing those would quietly delete the thing under test.
 */
test("the multi-byte fixtures keep their shell", () => {
  for (const path of [
    "test/records-store.test.ts",
    "test/control-framing.test.ts",
    "test/mcp.test.ts",
    "test/tts-worker.test.ts",
  ]) {
    expect(read(path), path).toContain("🐚");
  }
});
