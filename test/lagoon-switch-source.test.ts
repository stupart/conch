import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The lagoon switch (2026-10-11): a switch in the Mac window's title bar, right of "conch", in place of Debug ▸ Show
 * Lagoon. Off (the default) shows the sessions, on shows the lagoon; ⌘0 still flips it; the choice is remembered as the
 * window's page (`conch.page`); and it is there only in a build that carries the lagoon (`Contents/Resources/Lagoon`).
 * The art is the brand repo's v2 "turned" set, in the app's asset catalog; the motion is turned.js's, ported in
 * ConchDesign and tested there against turned.js's own numbers (LagoonSwitchMotionTests).
 *
 * The Mac app has no test target, so these read its Swift.
 */
const root = join(import.meta.dir, "..");
const source = (path: string): string => readFileSync(join(root, path), "utf8");
// Line comments stripped, so prose describing a rule can never satisfy a guard.
const swift = (path: string): string => source(path).replace(/^\s*\/\/.*$/gm, "");

const header = swift("mac-app/conch-mac/DashboardView.swift");
const content = swift("mac-app/conch-mac/ContentView.swift");
const app = swift("mac-app/conch-mac/ConchMacApp.swift");
const pane = swift("mac-app/conch-mac/LagoonPane.swift");
const lagoon = swift("design/ConchDesign/Sources/ConchDesign/Lagoon.swift");
const view = swift("design/ConchDesign/Sources/ConchDesign/LagoonSwitch.swift");
const motion = swift("design/ConchDesign/Sources/ConchDesign/LagoonSwitchMotion.swift");
const macSwift = readdirSync(join(root, "mac-app/conch-mac"))
  .filter((name) => name.endsWith(".swift"))
  .map((name) => swift(`mac-app/conch-mac/${name}`))
  .join("\n");

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing: ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe("in the title bar, right of the title", () => {
  test("the title's row is the sidebar glyph, \"conch\", then the switch, only in a build with the lagoon", () => {
    const row = between(header, "private struct DashboardHeader: View {", "Spacer(minLength: 12)");
    const title = row.indexOf('Text("conch")');
    const toggle = row.indexOf("LagoonSwitch(isOn: page == .lagoon) {");
    expect(title).toBeGreaterThan(-1);
    expect(toggle).toBeGreaterThan(title);
    expect(row.slice(title, toggle)).toContain("if lagoonAvailable {");
    // The row's own 5 pt spacing and 4.5 more: the switch starts at x = 156, as in the design's title-bar shot.
    expect(row).toContain("HStack(spacing: 5) {");
    expect(row.slice(toggle)).toContain(".padding(.leading, 4.5)");
    // A click asks for what ⌘0 asks for, so the two are one path, and the switch moves when ⌘0 is pressed.
    expect(row.slice(toggle)).toContain("NotificationCenter.default.post(name: .showLagoon, object: nil)");
  });

  test("it replaces the shell button among the controls", () => {
    expect(header).not.toContain("fossil.shell");
    expect(header).not.toContain("Back to the conversation (⌘0)");
    expect(header.split("LagoonSwitch(").length - 1).toBe(1);
  });
});

describe("what it says", () => {
  test("a switch labelled Lagoon, on or off, with ⌘0 in its tooltip and no Experimental tag", () => {
    const body = between(view, "public struct LagoonSwitch: View {", "private struct Unstyled");
    expect(body).toContain('.help("Lagoon (⌘0)")');
    expect(body).toContain('.accessibilityLabel("Lagoon")');
    expect(body).toContain('.accessibilityValue(isOn ? "on" : "off")');
    expect(body).toContain(".accessibilityAddTraits(.isToggle)");
    expect(view.toLowerCase()).not.toContain("experimental");
    // The art says nothing to VoiceOver of its own.
    expect(between(view, "public struct LagoonSwitchArtwork: View {", "private static let track")).toContain(".accessibilityHidden(true)");
  });
});

describe("how it moves", () => {
  test("one clock, only while a change plays out and the window can be seen, drawing turned.js's frame", () => {
    const body = between(view, "public struct LagoonSwitch: View {", "private struct Unstyled");
    expect(body).toContain("TimelineView(.animation(minimumInterval: nil, paused: !moving || hidden))");
    expect(body).toContain("@Environment(\\.conchHidden) private var hidden");
    expect(body).toContain("playhead.pose(at: moving ? timeline.date : .distantFuture, reduceMotion: reduceMotion)");
    // Any change of page plays it, whoever asked: the switch, ⌘0, the menu, a deliverable opened from the lagoon.
    expect(body).toContain(".onChange(of: isOn) { _, on in");
    expect(body).toContain("playhead.flip(toOn: on, at: Date(), reduceMotion: reduceMotion)");
    expect(body).toContain("@Environment(\\.accessibilityReduceMotion) private var reduceMotion");
    expect(view).toContain("Motion.frame(direction, at: t)");
  });

  test("turned.js's timing: a 400 ms slide of 17.82 pt, the OG 70 ms after landing, a 1.5 s timeline, a 200 ms crossfade", () => {
    expect(motion).toContain("public static let travel = 17.82");
    expect(motion).toContain("public static let slide = 400.0");
    expect(motion).toContain("public static let eyesUp = slide + 70");
    expect(motion).toContain("public static let end = 1500.0");
    expect(motion).toContain("public static let crossfade = 200.0");
    expect(motion).toContain("CubicBezier(0.45, 0, 0.4, 0.86)");
    expect(motion).toContain("f.turn = max(0.06, abs(cos(Double.pi * e)))");
  });
});

describe("when it is there, and what it remembers", () => {
  test("in any build that carries the lagoon, and no other: no hidden setting in front of it", () => {
    expect(pane).toContain("static var available: Bool { bundleRoot != nil }");
    expect(pane).toContain("available ? stored : .sessions");
    expect(lagoon).not.toContain("enabledKey");
    expect(macSwift).not.toContain("Lagoon.enabledKey");
    expect(macSwift).not.toContain("conch.lagoon.enabled");
    expect(content).toContain("lagoonAvailable: LagoonFeature.available,");
  });

  test("the choice is the window's page, conch.page, off (the sessions) by default", () => {
    expect(lagoon).toContain('public static let pageKey = "conch.page"');
    expect(content).toContain("@AppStorage(Lagoon.pageKey) private var storedPage: Lagoon.Page = .sessions");
    expect(content).toContain("LagoonFeature.page(storedPage)");
    const flip = between(content, ".onReceive(NotificationCenter.default.publisher(for: .showLagoon)) { _ in", "\n        }\n");
    expect(flip).toContain("guard LagoonFeature.available else { return }");
    expect(flip).toContain("storedPage = page == .lagoon && !settings.state.isShown ? .sessions : .lagoon");
  });

  test("⌘0 still flips it, from Session ▸ Lagoon; Debug ▸ Show Lagoon is gone", () => {
    const session = between(app, 'CommandMenu("Session") {', 'CommandMenu("Debug") {');
    expect(session).toContain("LagoonMenuItem()");
    const item = between(pane, "struct LagoonMenuItem: View {", "\n}\n");
    expect(item).toContain("if LagoonFeature.available {");
    expect(item).toContain('.keyboardShortcut("0", modifiers: .command)');
    expect(item).toContain("NotificationCenter.default.post(name: .showLagoon, object: nil)");
    const debug = between(app, 'CommandMenu("Debug") {', "CommandGroup(after: .help) {");
    expect(debug).not.toContain("Lagoon");
    expect(macSwift).not.toContain("LagoonMenuToggle");
    expect(macSwift).not.toContain("Show Lagoon");
  });
});

describe("the art", () => {
  const catalog = "mac-app/conch-mac/Assets.xcassets/LagoonSwitch";
  const pieces = ["track-off", "track-on", "track-on-rim", "foam-collar", "knob-closed-c", "knob-closed-a", "knob-crab", "knob-lids"];
  /** A PNG's size from its IHDR. */
  const size = (path: string): [number, number] => {
    const png = readFileSync(join(root, path));
    return [png.readUInt32BE(16), png.readUInt32BE(20)];
  };
  // @2x and @3x pixels: for the track's 40 × 22 pt, the foam's 13 × 22 and the shell's 21.5 × 19 (v2.css).
  const pixels: Record<string, [[number, number], [number, number]]> = {
    "track-off": [[80, 44], [120, 66]], "track-on": [[80, 44], [120, 66]], "track-on-rim": [[80, 44], [120, 66]],
    "foam-collar": [[26, 44], [39, 66]], "knob-closed-c": [[43, 38], [64, 57]], "knob-closed-a": [[43, 38], [64, 57]],
    "knob-crab": [[43, 38], [64, 57]], "knob-lids": [[43, 38], [64, 57]],
  };

  test("exactly the eight pictures the switch draws, @2x and @3x, in their own namespace", () => {
    expect(JSON.parse(source(`${catalog}/Contents.json`)).properties["provides-namespace"]).toBe(true);
    expect(readdirSync(join(root, catalog)).filter((name) => name.endsWith(".imageset")).sort())
      .toEqual(pieces.map((name) => `${name}.imageset`).sort());
    for (const name of pieces) {
      const set = JSON.parse(source(`${catalog}/${name}.imageset/Contents.json`));
      // The appearance-neutral pictures; the two with dark variants are pinned below.
      const files = Object.fromEntries(set.images.filter((image: { filename?: string; appearances?: unknown }) => image.filename && !image.appearances)
        .map((image: { scale: string; filename: string }) => [image.scale, image.filename]));
      expect(files, name).toEqual({ "2x": `${name}@2x.png`, "3x": `${name}@3x.png` });
      const darkened = ["track-off", "track-on-rim"].includes(name) ? [`${name}-dark@2x.png`, `${name}-dark@3x.png`] : [];
      expect(readdirSync(join(root, `${catalog}/${name}.imageset`)).sort()).toEqual(["Contents.json", `${name}@2x.png`, `${name}@3x.png`, ...darkened].sort());
      expect(size(`${catalog}/${name}.imageset/${name}@2x.png`), name).toEqual(pixels[name]![0]);
      expect(size(`${catalog}/${name}.imageset/${name}@3x.png`), name).toEqual(pixels[name]![1]);
    }
  });

  test("drawn by those names, from the app's catalog", () => {
    for (const name of pieces) expect(view).toContain(`"${name}"`);
    expect(view).toContain('Image("LagoonSwitch/\\($0.rawValue)", bundle: bundle)');
    expect(view).toContain("@Entry public var lagoonSwitchArt: LagoonSwitchArt = .catalog");
  });
});

// 2026-10-13, Tyler: in dark appearance the light grey pill popped too hard against the dark title bar. The off track and
// the rim that crossfades in for on have dark variants; AppKit picks them for a dark window and follows a live change,
// and the wet sand, tinted from the off track, darkens with it.
test("the off track and the on rim have dark-appearance variants", () => {
  for (const name of ["track-off", "track-on-rim"]) {
    const folder = join(import.meta.dir, "..", "mac-app", "conch-mac", "Assets.xcassets", "LagoonSwitch", `${name}.imageset`);
    const images = JSON.parse(readFileSync(join(folder, "Contents.json"), "utf8")).images as Array<Record<string, unknown>>;
    const dark = images.filter((image) => JSON.stringify(image.appearances ?? []).includes('"dark"'));
    expect(dark.map((image) => image.filename).filter(Boolean)).toEqual([`${name}-dark@2x.png`, `${name}-dark@3x.png`]);
    for (const image of dark) if (image.filename) expect(existsSync(join(folder, String(image.filename)))).toBe(true);
  }
});
